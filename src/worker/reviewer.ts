import { query } from '@anthropic-ai/claude-agent-sdk';
import { DOCS_TOOLS, createDocsServer, type DocsSource } from './docs-server.js';
import { execa } from 'execa';
import { createHash } from 'node:crypto';
import type { Logger } from '../observability/logger.js';
import type { CheckResult, GateReport, TaskDetail } from '../types.js';
import type { LoadedDoc } from './agent-runtime.js';
import { collectDiffSince } from '../git/status.js';
import { createPreToolUseGuard } from './agent-runtime.js';
import { recordAgentUsage, type UsageSink } from '../core/agent-usage.js';

/**
 * 獨立 reviewer agent（DESIGN.md §5）。DoD 綠燈只證明「build/test 過」，證明不了
 * 「有沒有照規格做」——所以另開一個**全新 context** 的 agent（不 resume coder 的 session，
 * 避免它替自己背書），拿 docRefs 規格 + 實際 diff 逐段核對。
 *
 * 兩個設計要點：
 * 1. 無金鑰/呼叫失敗 → 回 `skipped`（ok=true），絕不讓 review 成為單點故障卡死整條流水線。
 * 2. prompt 組裝與回應解析是純函式，可在沒有 API 的環境完整單元測試。
 */

export interface ReviewViolation {
  /** 對應的規格出處（docRef 或段落標題）。 */
  docRef?: string;
  /** 規格要求了什麼。 */
  requirement: string;
  /** 實作哪裡不符。 */
  problem: string;
  /** 建議修法（回灌給 coder agent 用）。 */
  suggestion?: string;
}

export type ReviewVerdict =
  | { status: 'pass'; notes: string[] }
  | { status: 'fail'; violations: ReviewViolation[] }
  | { status: 'skipped'; reason: string };

export interface ReviewOutcome {
  /** 可否放行 complete_task。skipped 視為放行（不阻斷）。 */
  ok: boolean;
  verdict: ReviewVerdict;
  /** 轉成 GateReport，讓 Worker 用既有回灌路徑把意見送回 coder agent。 */
  asGateReport(): GateReport;
}

export interface ReviewOptions {
  /**
   * 這個任務上**人已經拍板的問題**。
   *
   * 沒有它，reviewer 只看得到規格與 diff：規格寫「沒有定論」的地方，就算人已經
   * 透過 ask_human 決定了，reviewer 也不知道——它會把一個已經解決的問題重新提出來、
   * 退回 agent，白費一輪。實跑撞到：規格明寫「主題要不要一併重設沒有定論」，
   * 人回答了「不要」，agent 照做，reviewer 卻退回說「你不該自行決定」。
   */
  decisions?: { question: string; answer: string }[];
  /** 直接指定要審的 diff（測試/已算好時用）；未給則由 collectDiff 取。 */
  diff?: string;
  /**
   * 續接同一群的審查 session。
   *
   * **群內同階段共用一條 session**（使用者裁決）：審查者審第二個任務時要記得
   * 第一個任務改了什麼、自己當時放行的理由——先前它**根本不知道第一個任務存在**，
   * 所以第二個任務破壞了第一個時它不可能發現。
   *
   * 注意這與 REVIEWER_SYSTEM_PROMPT 上面那句「不 resume coder 的 session」不衝突：
   * 那句講的是**不能繼承寫程式的人的想法**（否則審不出東西），
   * 這裡續接的是**審查者自己**先前的審查，兩條線始終隔離。
   */
  resumeSessionId?: string;
  /** 所屬群組（記帳與 session 歸屬用）。 */
  groupId?: string;
  /**
   * 比較基準＝**本任務開始時的 HEAD sha**，與 DoD「diff 非空」關卡同一枚
   * （worker 的 gateConfig.diff.baseRef）。
   *
   * `undefined` ＝ 連基準都取不到（cwd 不是 git 工作區）→ 回 skipped，不要亂猜。
   *
   * **不可以用會動的 ref。** 先前預設 `'HEAD'`，於是 agent 自行 commit 之後
   * `git diff HEAD` 就是空的，一份正確的實作被判成「看不到任何實作」（實跑撞到）。
   * 必填鍵而非 optional：optional 的話漏傳照樣編得過，等於什麼都沒鎖。
   */
  baseRef: string | undefined;
  /** diff 過長時截斷長度（字元）。 */
  maxDiffChars?: number;
}

/** SDK query 的最小結構介面，供注入假件。 */
export type ReviewQueryFn = (args: { prompt: string; cwd: string; resume?: string }) => AsyncIterable<Record<string, unknown>>;

export interface ReviewerDeps {
  /**
   * 任務板的文件來源。**未注入 → 這個角色查不到規格**（只能用提示詞裡程式先讀好的那份）。
   *
   * 為什麼每個角色都要有：程式預抓規格有兩個無聲的失效模式，兩個都實際發生過——
   * (1) docRef 字串對不上（實跑：docType 單複數不一致）→ 整份讀不到，只留一行 warn，
   *     而 build/test 全綠看起來完全正常；
   * (2) **規格在任務進行中被更新** → 手上是開工那一刻的快照，而且不知道自己拿的是舊的。
   *
   * commit e2820a9 已經做過一次，但**只接給寫程式的 agent**——審查者的工作就是
   * 「規格逐條 vs diff」，卻不能搜規格。
   */
  docs?: (repo: string) => DocsSource | undefined;
  /**
   * 記帳出口。未注入 → 不記（測試與無 ledger 的情境）。
   * 先前這個角色的花費完全沒被記，而預算閘門用的是同一份數字。
   */
  usage?: UsageSink;
  log: Logger;
  /** 模型別名（opus / sonnet / haiku）。未給 → SDK 預設。 */
  model?: string;
  queryFn?: ReviewQueryFn;
  collectDiff?: (cwd: string, baseRef: string) => Promise<string>;
  /** 是否具備 Claude 認證。預設看環境變數。 */
  hasAuth?: () => boolean;
}

const DEFAULT_MAX_DIFF_CHARS = 60_000;
/** reviewer 只讀不寫：限制工具集，避免它「順手把問題改掉」而失去審查意義。 */
// Bash 一定要留：審查者要跑 `git diff`、`grep -rn`、`find` 才查得動「這個實作有沒有符合規格」。
// 它跑在 readonly policy 底下（見 agent-runtime 的 evaluateReadonlyCommand），
// 只能執行查詢類指令——邊界劃在「指令」而不是「工具」。
//
// 先前這份清單只交給 SDK 的 allowedTools，而那個對工具不具強制力，所以少列 Bash 沒有後果；
// 改成由 PreToolUse hook 強制之後，少列就等於**默默拿掉它一直在用的能力**（實跑撞到）。
const REVIEWER_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', ...DOCS_TOOLS];

export class Reviewer {
  constructor(private deps: ReviewerDeps) {}

  /** 對映 DESIGN §13 的 `reviewer.check(task, docs, ctx.worktree)`。 */
  async check(task: TaskDetail, docs: LoadedDoc[], cwd: string, opts: ReviewOptions): Promise<ReviewOutcome> {
    const hasAuth = this.deps.hasAuth ?? hasClaudeAuth;
    if (!hasAuth()) {
      this.deps.log.warn({ taskId: task.id }, 'reviewer 略過：未設定 Claude 認證');
      return toReviewOutcome({ status: 'skipped', reason: '未設定 Claude 認證（ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY）' });
    }
    if (docs.length === 0) {
      // 沒有規格可對照時，reviewer 沒有判準；交給 DoD 與人工 review
      return toReviewOutcome({ status: 'skipped', reason: '任務沒有 docRefs 規格可對照' });
    }

    const collect = this.deps.collectDiff ?? collectGitDiff;
    let diff = opts.diff;
    if (diff === undefined) {
      if (opts.baseRef === undefined) {
        // 取不到基準就不要審。退回 'HEAD' 是錯的——agent 自行 commit 後那是空的，
        // 會把做完的成果判成「沒有實作」再回灌給它（實跑害了兩輪）。
        return toReviewOutcome({ status: 'skipped', reason: '取不到比較基準（cwd 不是 git 工作區），無法審查' });
      }
      try {
        diff = await collect(cwd, opts.baseRef);
      } catch (e) {
        return toReviewOutcome({ status: 'skipped', reason: `無法取得 diff：${msg(e)}` });
      }
    }
    if (!diff.trim()) {
      return toReviewOutcome({
        status: 'fail',
        violations: [{ requirement: '實作需產生實際變更', problem: 'diff 為空，看不到任何實作' }],
      });
    }

    const prompt = buildReviewPrompt(
      task,
      docs,
      truncateDiff(diff, opts.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS),
      opts.decisions ?? [],
    );
    let text: string;
    try {
      text = await this.runQuery(prompt, cwd, {
        taskId: task.id,
        repo: task.repo,
        ...(opts.groupId ? { groupId: opts.groupId } : {}),
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
      });
    } catch (e) {
      this.deps.log.warn({ taskId: task.id, err: msg(e) }, 'reviewer 呼叫失敗，略過（不阻斷流程）');
      return toReviewOutcome({ status: 'skipped', reason: `reviewer 呼叫失敗：${msg(e)}` });
    }

    const verdict = parseReviewResponse(text);
    if (!verdict) {
      // 解析不出結構化判定就當「無結論」。硬判 fail 會讓監督迴圈永遠跑不完。
      this.deps.log.warn({ taskId: task.id, preview: text.slice(0, 200) }, 'reviewer 回應無法解析為判定，視為略過');
      return toReviewOutcome({ status: 'skipped', reason: 'reviewer 回應無法解析' });
    }
    this.deps.log.info(
      { taskId: task.id, status: verdict.status, violations: verdict.status === 'fail' ? verdict.violations.length : 0 },
      'reviewer 判定',
    );
    return toReviewOutcome(verdict);
  }

  private async runQuery(
    prompt: string,
    cwd: string,
    ctx?: { taskId?: string; repo?: string; groupId?: string; resume?: string },
  ): Promise<string> {
    // 這個角色自己去查規格。程式**不預抓內容**——docRef 字串對不上、
    // 或規格在任務進行中被更新，預抓的那份都會靜靜地是錯的。
    const docsSource = ctx?.repo ? this.deps.docs?.(ctx?.repo) : undefined;
    const docsServer = docsSource ? createDocsServer(docsSource, this.deps.log) : undefined;
    const q: ReviewQueryFn =
      this.deps.queryFn ??
      ((args) =>
        query({
          prompt: args.prompt,
          options: {
            ...(this.deps.model ? { model: this.deps.model } : {}),
            cwd: args.cwd,
            ...(args.resume ? { resume: args.resume } : {}),
            permissionMode: 'acceptEdits', // 工具已限制為唯讀，此處只為避免非互動環境卡在權限詢問
            ...(docsServer ? { mcpServers: { docs: docsServer } as never } : {}),
            allowedTools: REVIEWER_TOOLS,
            systemPrompt: REVIEWER_SYSTEM_PROMPT,
            // **邊界由這裡守，不是 allowedTools。** SDK 的 allowedTools 對工具不具強制力
            // （實跑證實規劃 agent 用了 9 次沒列進去的 Bash）。reviewer只判斷、不動手，
            // 而它的 cwd 是實際的工作區——沒有這道 hook，唯一擋著它的只有提示詞。
            hooks: { PreToolUse: [{ hooks: [createPreToolUseGuard(this.deps.log, { mode: 'readonly', allowTools: REVIEWER_TOOLS })] }] },
          },
        }) as AsyncIterable<Record<string, unknown>>);

    let out = '';
    for await (const raw of q({ prompt, cwd, ...(ctx?.resume ? { resume: ctx.resume } : {}) })) {
      const m = raw as { type?: string; subtype?: string; result?: string };
      if (m.type === 'result') {
        recordAgentUsage(this.deps.usage, this.deps.log, { kind: 'reviewer', ...(ctx ?? {}) }, raw);
        if (m.subtype === 'success') out = m.result ?? '';
        else throw new Error(`reviewer 回傳錯誤結果：${m.subtype ?? 'unknown'}`);
      }
    }
    return out;
  }
}

// ── 純函式（可無金鑰單元驗證） ──

const REVIEWER_SYSTEM_PROMPT =
  '你是獨立的程式碼審查者。你沒有參與實作，也不負責修好它——你的唯一職責是判斷「實作是否符合規格的每一段」。' +
  '寬鬆放行比錯殺更糟；但也不要挑規格沒要求的風格問題。只輸出要求的 JSON。';

/** 是否具備 Claude 認證（無認證時 reviewer 直接 skip 而非炸掉）。 */
export function hasClaudeAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);
}

/** 組裝 reviewer prompt：規格逐段列出 + diff + 嚴格的 JSON 輸出格式。 */
export function buildReviewPrompt(
  task: TaskDetail,
  docs: LoadedDoc[],
  diff: string,
  decisions: { question: string; answer: string }[] = [],
): string {
  const p: string[] = [];
  p.push(`# 審查任務 ${task.id}：${task.title}`);
  p.push(`類別：${task.category}｜repo：${task.repo}`);
  p.push(`\n## 任務描述\n${task.description}`);

  p.push(`\n## 規格（逐段核對，共 ${docs.length} 份）`);
  for (const d of docs) p.push(`\n### ${d.ref}\n${d.content}`);

  if (decisions.length > 0) {
    p.push(
      `\n## 已經拍板的決定（共 ${decisions.length} 項）\n` +
        `規格上懸而未決、或需要人判斷的地方，**下面這些已經由需求方決定了**。\n` +
        `照這些決定實作是正確的——不要因為「規格沒寫」或「規格說沒定論」而回報違規。`,
    );
    for (const d of decisions) p.push(`\n**問**：${d.question}\n**答**：${d.answer}`);
  }

  p.push(`\n## 實作 diff\n\`\`\`diff\n${diff}\n\`\`\``);

  p.push(
    `\n## 你要做的事\n` +
      `1. 把上述規格拆成一條條可檢核的要求。\n` +
      `2. 對每條要求，用 diff（必要時用 Read/Grep 讀工作區現況）判斷有沒有被滿足。\n` +
      `3. 只列「規格有要求但實作沒做到或做錯」的項目；規格沒提到的偏好不算違規。\n`,
  );
  p.push(
    `\n## 輸出格式（只輸出一個 JSON 程式碼區塊，不要其他文字）\n` +
      '```json\n' +
      `{"status":"pass"|"fail","notes":["..."],"violations":[{"docRef":"檔名#段落","requirement":"規格要求","problem":"實作哪裡不符","suggestion":"建議修法"}]}\n` +
      '```\n' +
      `status=pass 時 violations 必須為空陣列。`,
  );
  return p.join('\n');
}

/**
 * 解析 reviewer 回應。容忍：純 JSON、```json 圍欄、前後夾雜說明文字。
 * 解析不出來回 null（呼叫端轉成 skipped，避免無結論造成無限迴圈）。
 */
export function parseReviewResponse(text: string): ReviewVerdict | null {
  const raw = extractJsonObject(text);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const status = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
  const violations = Array.isArray(parsed.violations) ? parsed.violations.flatMap(toViolation) : [];
  const notes = Array.isArray(parsed.notes) ? parsed.notes.filter((n): n is string => typeof n === 'string') : [];

  if (status === 'fail') {
    // 說 fail 卻沒給理由 → 補一條泛用理由，否則回灌時 coder 不知道要改什麼
    return {
      status: 'fail',
      violations: violations.length > 0 ? violations : [{ requirement: '符合規格', problem: 'reviewer 判定不合格但未提供具體理由' }],
    };
  }
  if (status === 'pass') {
    // 說 pass 卻列了違規 → 以違規為準（寧可多改一輪，也不要放行沒做完的實作）
    return violations.length > 0 ? { status: 'fail', violations } : { status: 'pass', notes };
  }
  if (status === 'skipped' || status === 'skip') {
    return { status: 'skipped', reason: notes[0] ?? 'reviewer 自述無法判定' };
  }
  return null;
}

/** ReviewVerdict → GateReport，讓 Worker 沿用既有的「失敗回灌」路徑。 */
export function reviewGateReport(verdict: ReviewVerdict): GateReport {
  if (verdict.status === 'fail') {
    const checks: CheckResult[] = [
      {
        name: 'reviewer',
        ok: false,
        detail: verdict.violations
          .map((v, i) => `${i + 1}. ${v.docRef ? `[${v.docRef}] ` : ''}規格要求：${v.requirement}\n   不符：${v.problem}${v.suggestion ? `\n   建議：${v.suggestion}` : ''}`)
          .join('\n'),
        failingIds: verdict.violations.map((v) => v.requirement),
      },
    ];
    return { green: false, checks, signature: reviewSignature(verdict.violations) };
  }

  const detail = verdict.status === 'pass' ? verdict.notes.join('；') || 'ok' : `略過：${verdict.reason}`;
  const checks: CheckResult[] = [{ name: 'reviewer', ok: true, detail }];
  return { green: true, checks, signature: reviewSignature([]) };
}

/** 包裝成 Worker 期望的形狀（ok + asGateReport）。 */
export function toReviewOutcome(verdict: ReviewVerdict): ReviewOutcome {
  return {
    ok: verdict.status !== 'fail',
    verdict,
    asGateReport: () => reviewGateReport(verdict),
  };
}

/** diff 過長時保留頭尾（頭有檔案清單脈絡、尾常是新加的東西）。 */
export function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  const half = Math.floor(maxChars / 2);
  return `${diff.slice(0, half)}\n\n…（diff 過長，中間 ${diff.length - maxChars} 字元已省略）…\n\n${diff.slice(-half)}`;
}

/** 違規簽章：與 Verifier 一致的用途——同一批問題重複出現時簽章不變，供無進展偵測。 */
function reviewSignature(violations: ReviewViolation[]): string {
  const key = violations.map((v) => `${v.docRef ?? ''}:${v.requirement}`).sort().join('|');
  return createHash('sha1').update(`reviewer|${key}`).digest('hex').slice(0, 16);
}

/** 從文字中抓出第一個完整的 JSON 物件（優先 ```json 圍欄，其次括號配對）。 */
function extractJsonObject(text: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fence?.[1]?.trim();
  if (body?.startsWith('{')) return body;

  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function toViolation(v: unknown): ReviewViolation[] {
  if (typeof v === 'string') return [{ requirement: v, problem: v }];
  if (!isRecord(v)) return [];
  const requirement = str(v.requirement) ?? str(v.spec) ?? str(v.rule);
  const problem = str(v.problem) ?? str(v.detail) ?? str(v.issue);
  if (!requirement && !problem) return [];
  return [
    {
      ...(str(v.docRef) ? { docRef: str(v.docRef)! } : {}),
      requirement: requirement ?? '（未指明規格條目）',
      problem: problem ?? '（未指明問題）',
      ...(str(v.suggestion) ? { suggestion: str(v.suggestion)! } : {}),
    },
  ];
}

// git 失敗要擲錯而不是回空字串——空字串在上面等於「你沒有實作」，
// 那是把量測端的故障翻譯成對 agent 的指控。實作見 src/git/status.ts。
const collectGitDiff = (cwd: string, baseRef: string): Promise<string> => collectDiffSince(cwd, baseRef);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
