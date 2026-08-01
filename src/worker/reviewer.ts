import { query } from '@anthropic-ai/claude-agent-sdk';
import { execa } from 'execa';
import { createHash } from 'node:crypto';
import type { Logger } from '../observability/logger.js';
import type { CheckResult, GateReport, TaskDetail } from '../types.js';
import type { LoadedDoc } from './agent-runtime.js';

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
  /** 取 diff 的比較基準，預設 HEAD（即工作區未 commit 的變更）。 */
  baseRef?: string;
  /** diff 過長時截斷長度（字元）。 */
  maxDiffChars?: number;
}

/** SDK query 的最小結構介面，供注入假件。 */
export type ReviewQueryFn = (args: { prompt: string; cwd: string }) => AsyncIterable<Record<string, unknown>>;

export interface ReviewerDeps {
  log: Logger;
  queryFn?: ReviewQueryFn;
  collectDiff?: (cwd: string, baseRef: string) => Promise<string>;
  /** 是否具備 Claude 認證。預設看環境變數。 */
  hasAuth?: () => boolean;
}

const DEFAULT_MAX_DIFF_CHARS = 60_000;
/** reviewer 只讀不寫：限制工具集，避免它「順手把問題改掉」而失去審查意義。 */
const REVIEWER_TOOLS = ['Read', 'Glob', 'Grep'];

export class Reviewer {
  constructor(private deps: ReviewerDeps) {}

  /** 對映 DESIGN §13 的 `reviewer.check(task, docs, ctx.worktree)`。 */
  async check(task: TaskDetail, docs: LoadedDoc[], cwd: string, opts: ReviewOptions = {}): Promise<ReviewOutcome> {
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
      try {
        diff = await collect(cwd, opts.baseRef ?? 'HEAD');
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
      text = await this.runQuery(prompt, cwd);
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

  private async runQuery(prompt: string, cwd: string): Promise<string> {
    const q: ReviewQueryFn =
      this.deps.queryFn ??
      ((args) =>
        query({
          prompt: args.prompt,
          options: {
            cwd: args.cwd,
            permissionMode: 'acceptEdits', // 工具已限制為唯讀，此處只為避免非互動環境卡在權限詢問
            allowedTools: REVIEWER_TOOLS,
            systemPrompt: REVIEWER_SYSTEM_PROMPT,
          },
        }) as AsyncIterable<Record<string, unknown>>);

    let out = '';
    for await (const raw of q({ prompt, cwd })) {
      const m = raw as { type?: string; subtype?: string; result?: string };
      if (m.type === 'result') {
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

async function collectGitDiff(cwd: string, baseRef: string): Promise<string> {
  const tracked = await execa('git', ['-C', cwd, 'diff', '--no-color', baseRef], { reject: false });
  const untracked = await execa('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard'], { reject: false });
  const extra = untracked.stdout.trim() ? `\n\n# 未追蹤的新檔案\n${untracked.stdout}` : '';
  return `${tracked.stdout}${extra}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
