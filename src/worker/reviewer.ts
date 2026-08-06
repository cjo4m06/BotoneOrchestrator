import { query } from '@anthropic-ai/claude-agent-sdk';
import { DOCS_TOOLS, createDocsServer, type DocsSource } from './docs-server.js';
import { createGitInspectServer } from './git-inspect.js';
import { browserServerConfig, scratchDirFor, scratchRule } from './agent-runtime.js';
import { serversFor, toolsFor } from './capabilities.js';
import { execa } from 'execa';
import { createHash } from 'node:crypto';
import type { Logger } from '../observability/logger.js';
import type { CheckResult, GateReport, TaskDetail } from '../types.js';
import type { LoadedDoc } from './agent-runtime.js';
import { collectDiffSince } from '../git/status.js';
import { createPreToolUseGuard, READONLY_BROWSER_TOOLS } from './agent-runtime.js';
import { recordAgentUsage, type UsageSink } from '../core/agent-usage.js';
import { createToolAuditor, type ToolCallSink } from './tool-audit.js';

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

/**
 * 「這次有沒有去看畫面」。**放行書的必填欄位，空白不合法。**
 *
 * 為什麼必填：先前「有沒有驗畫面」是程式用卡片類別決定的（`category === 'design'`），
 * 而跳過時報告上一個字都沒有——一張把畫面改破版的卡，其他關卡全綠就一路開 PR。
 * 現在改成由審查者拿**實際 diff** 自己決定，但它必須說出來：
 * 「看了 /profile 與 /settings，375 與 1440」或「沒看：這次只改 API 序列化」，
 * 兩者都合法，**空白不合法**。
 */
export interface UiChecked {
  /** true = 有去看；false = 沒看（那也要說為什麼）。 */
  looked: boolean;
  /** 看了哪幾條路由／哪些寬度，或沒看的理由。不可為空。 */
  detail: string;
}

export type ReviewVerdict =
  | { status: 'pass'; notes: string[]; uiChecked?: UiChecked }
  | { status: 'fail'; violations: ReviewViolation[]; uiChecked?: UiChecked }
  /**
   * **這不是實作的錯，是規格的問題。**
   *
   * ── 為什麼需要第三種判決 ──
   *
   * 先前只有 pass / fail / skipped。撞到「規格自相矛盾」「這幾條 DoD 無法同時成立」
   * 「要求改的東西 agent 碰不到」時，reviewer 只能判 fail——而 fail 的語意是
   * 「coder，去修」。coder 修不動，於是下一輪再送一次、再被退一次。
   *
   * 實跑（zZb5MGTMdQRZ，2026-08-04）：reviewer 每一輪都正確地發現不符，
   * 每一輪都只能說 fail，每一輪都把它送回一個解不了的地方。四輪、$36.64，
   * 最後那個 PR 帶著一條沒滿足的 DoD 被人按核准合併。
   *
   * 這條判決**不回灌給 coder**，直接開交接單給人——因為要動的是規格，不是程式碼。
   */
  | { status: 'spec_problem'; problem: string; conflicting: string[]; uiChecked?: UiChecked }
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
  /** 工具呼叫的稽核出口。未注入 → 不記（測試與無 ledger 的情境）。 */
  toolAudit?: ToolCallSink;
  log: Logger;
  /** 模型別名（opus / sonnet / haiku）。未給 → SDK 預設。 */
  model?: string;
  queryFn?: ReviewQueryFn;
  collectDiff?: (cwd: string, baseRef: string) => Promise<string>;
  /** 是否具備 Claude 認證。預設看環境變數。 */
  hasAuth?: () => boolean;
  /**
   * 瀏覽器暫存／截圖的根目錄。**未注入 → 審查者沒有瀏覽器**。
   *
   * 一定要在 worktree 之外：它的截圖若寫進 worktree 會被算進 git diff，
   * 既污染 PR 也讓「diff 非空」的 DoD 判定失真。
   * key 用 `review-<taskId>`：多群同時審查時各自一個暫存區，不會互相覆蓋。
   */
  browserOutputRoot?: string;
}

const DEFAULT_MAX_DIFF_CHARS = 60_000;
/** reviewer 只讀不寫：限制工具集，避免它「順手把問題改掉」而失去審查意義。 */
// Bash 一定要留：審查者要跑 `git diff`、`grep -rn`、`find` 才查得動「這個實作有沒有符合規格」。
// 它跑在 readonly policy 底下（見 agent-runtime 的 evaluateReadonlyCommand），
// 只能執行查詢類指令——邊界劃在「指令」而不是「工具」。
//
// 先前這份清單只交給 SDK 的 allowedTools，而那個對工具不具強制力，所以少列 Bash 沒有後果；
// 改成由 PreToolUse hook 強制之後，少列就等於**默默拿掉它一直在用的能力**（實跑撞到）。
const REVIEWER_TOOLS = toolsFor('reviewer', { readonly: READONLY_BROWSER_TOOLS });

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
    if (opts.baseRef === undefined) {
      // 取不到基準就不要審。退回 'HEAD' 是錯的——agent 自行 commit 後那是空的，
      // 會把做完的成果判成「沒有實作」再回灌給它（實跑害了兩輪）。
      return toReviewOutcome({ status: 'skipped', reason: '取不到比較基準（cwd 不是 git 工作區），無法審查' });
    }

    // **程式不預先算 diff。**
    //
    // 先前這裡先跑一次完整 diff、再砍成「前 30KB ＋ 後 30KB」貼進 prompt。
    // 兩個壞處：改動一大就有整批檔案完全沒被審（審查者只知道「省略了 N 字元」，
    // 不知道省略的是哪幾個檔），以及那份快照是一次性的——它想換個角度再看
    //（只看某個檔、看 git_log 的脈絡）時，程式給的那份仍然壓在 prompt 最前面當錨。
    //
    // 它手上本來就有 git_changed_files / git_diff / git_log 與 Bash，
    // 而且與這裡用的是同一枚 baseRef。要看幾次、看多細，由它決定。

    const prompt = buildReviewPrompt(
      task,
      docs,
      opts.baseRef,
      opts.decisions ?? [],
      // 審查者也會截圖（實跑：review-1440-assistant.png 進了 main）。它跑在 coder
      // 的工作區裡，掉在那裡的檔案一樣會被下一次提交掃進 PR。
      scratchDirFor(this.deps.browserOutputRoot, `review-${task.id}`),
    );
    let text: string;
    try {
      text = await this.runQuery(prompt, cwd, {
        taskId: task.id,
        repo: task.repo,
        ...(opts.groupId ? { groupId: opts.groupId } : {}),
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
        // 唯讀 git 要有基準才分得出「這次弄的」與「本來就有的」。
        // 上面已經擋掉 undefined 的情況（取不到基準就不審），所以這裡一定有值。
        ...(opts.baseRef ? { baseRef: opts.baseRef } : {}),
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
    ctx?: { taskId?: string; repo?: string; groupId?: string; resume?: string; baseRef?: string },
  ): Promise<string> {
    // 這個角色自己去查規格。程式**不預抓內容**——docRef 字串對不上、
    // 或規格在任務進行中被更新，預抓的那份都會靜靜地是錯的。
    const docsSource = ctx?.repo ? this.deps.docs?.(ctx?.repo) : undefined;
    const docsServer = docsSource ? createDocsServer(docsSource, this.deps.log) : undefined;
    // ── 這兩個 server 先前**從來沒被掛上** ──
    //
    // REVIEWER_TOOLS 一直列著 `mcp__git__*` 與唯讀瀏覽器工具，但 runQuery 只掛 docs。
    // 於是「審查者自己開瀏覽器看畫面」（第 12 片）在清單上成立、實際叫不動——
    // 而放行書的 uiChecked 填「沒看：沒有瀏覽器工具」完全合法，閘門照樣綠燈。
    // 這正是 capabilities.ts 那份清單要擋的第六次。
    // baseRef 一定有：check() 在取不到基準時就 skip 了，走不到這裡。
    const gitServer = ctx?.baseRef
      ? createGitInspectServer({ cwd, baseRef: ctx.baseRef, log: this.deps.log })
      : undefined;
    const browserServer = this.deps.browserOutputRoot
      ? browserServerConfig(this.deps.browserOutputRoot, `review-${ctx?.taskId ?? 'unknown'}`)
      : undefined;
    const { servers, missing } = serversFor('reviewer', {
      ...(docsServer ? { docs: () => docsServer } : {}),
      ...(gitServer ? { git: () => gitServer } : {}),
      ...(browserServer ? { browser: () => browserServer } : {}),
    });
    if (missing.length > 0) {
      this.deps.log.warn({ role: 'reviewer', missing }, '⚠️ 審查者宣告了能力但沒接上材料——它會拿到工具名卻叫不動');
    }
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
            ...(Object.keys(servers).length > 0 ? { mcpServers: servers as never } : {}),
            allowedTools: REVIEWER_TOOLS,
            systemPrompt: REVIEWER_SYSTEM_PROMPT,
            // **邊界由這裡守，不是 allowedTools。** SDK 的 allowedTools 對工具不具強制力
            // （實跑證實規劃 agent 用了 9 次沒列進去的 Bash）。reviewer只判斷、不動手，
            // 而它的 cwd 是實際的工作區——沒有這道 hook，唯一擋著它的只有提示詞。
            // 稽核尤其重要：它跑在 coder 的工作區裡，掉在那裡的東西與清掉的東西
            // 都會算到 coder 頭上（實跑：工作區被清空兩次，查不出是誰）。
            hooks: {
              PreToolUse: [{
                hooks: [createPreToolUseGuard(
                  this.deps.log,
                  { mode: 'readonly', allowTools: REVIEWER_TOOLS },
                  createToolAuditor(this.deps.log, 'reviewer', {
                    ...(ctx?.taskId ? { taskId: ctx.taskId } : {}),
                    ...(ctx?.groupId ? { groupId: ctx.groupId } : {}),
                  }, this.deps.toolAudit),
                )],
              }],
            },
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
  '寬鬆放行比錯殺更糟；但也不要挑規格沒要求的風格問題。\n' +
  '**畫面也是你的職責。** 先看這次的 diff：動到 .vue / .tsx / CSS / 模板，就自己開瀏覽器導頁去看；' +
  '只動 server 端邏輯或設定就不必。看的時候用人眼看得出來的標準——讀不讀得下去、字級與對比夠不夠、' +
  '版面有沒有破、可點的東西看起來像不像可點；不要挑「我覺得可以更好看」這種偏好。\n' +
  '**放行時一定要填 uiChecked**：看了就寫看了哪幾條路由與哪些寬度，沒看就寫沒看與為什麼。' +
  '兩者都合法，空白不合法——空白會被退回。\n' +
  '只輸出要求的 JSON。';

/** 是否具備 Claude 認證（無認證時 reviewer 直接 skip 而非炸掉）。 */
export function hasClaudeAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);
}

/** 組裝 reviewer prompt：規格逐段列出 ＋ 比較基準 ＋ 嚴格的 JSON 輸出格式（**不含 diff 內容**）。 */
export function buildReviewPrompt(
  task: TaskDetail,
  docs: LoadedDoc[],
  /** 比較基準。**不給 diff 內容**——審查者用唯讀 git 自己查（見 check 裡的說明）。 */
  baseRef: string,
  decisions: { question: string; answer: string }[] = [],
  /** 暫存檔的去處（worktree 外）。未給就不提——沒有瀏覽器時它也不會產出檔案。 */
  scratchDir?: string,
): string {
  const p: string[] = [];
  p.push(`# 審查任務 ${task.id}：${task.title}`);
  p.push(`類別：${task.category}｜repo：${task.repo}`);
  p.push(`\n## 任務描述\n${task.description}`);

  if (scratchDir) p.push(scratchRule(scratchDir));

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

  p.push(
    '\n## 這次改了什麼——**自己查**',
    '',
    `比較基準：\`${baseRef}\``,
    '',
    '用 `git_changed_files` 先看動了哪些檔案縮範圍，再對要看的檔案用 `git_diff`。',
    '要看幾次、看多細由你決定；需要脈絡就 `git_log`、`git_blame`，要讀現況就 Read/Grep。',
    '**不要一次把整份 diff 讀進來**——先縮範圍。',
  );

  p.push(
    `\n## 你要做的事\n` +
      `1. 把上述規格拆成一條條可檢核的要求。\n` +
      `2. 對每條要求，自己查 diff 與工作區現況，判斷有沒有被滿足。\n` +
      `3. 只列「規格有要求但實作沒做到或做錯」的項目；規格沒提到的偏好不算違規。\n`,
  );
  p.push(
    `\n## 輸出格式（只輸出一個 JSON 程式碼區塊，不要其他文字）\n` +
      '```json\n' +
      `{"status":"pass"|"fail"|"spec_problem","notes":["..."],` +
      `"uiChecked":{"looked":true|false,"detail":"看了 /profile 與 /settings（375 與 1440）"｜"沒看：這次只改 API 序列化"},` +
      `"violations":[{"docRef":"檔名#段落","requirement":"規格要求","problem":"實作哪裡不符","suggestion":"建議修法"}]}\n` +
      // 必填的理由（「沒驗畫面」與「驗過沒問題」先前長得一模一樣）是給改這段的人看的，
      // 不是給審查者看的——它只要知道空白會被退回。
      'uiChecked 在 status=pass 時**必填**，空白會被退回。\n' +
      '```\n' +
      `status=pass 時 violations 必須為空陣列。\n\n` +
      '**status=spec_problem**：規格本身有問題，不是實作的錯。用在：\n' +
      '· 幾條要求**無法同時成立**（例如「熱區至少 44×44」＋「不改變視覺外觀」＋「相鄰不重疊」，' +
      '而兩顆鍵中心距只有 28px——三條在幾何上湊不出來）\n' +
      '· 規格自相矛盾，或已被後續設計覆寫，與這張卡的 DoD 直接打架\n' +
      '· 要求改的東西**不在 coder 碰得到的範圍**（例如要它更新 repo 外的 spec 檔案）\n\n' +
      '這條路**不會回灌給 coder**，會直接交給人裁決——所以要填：\n' +
      '`"problem":"一句話說清楚衝突在哪"`、`"conflicting":["要求A","要求B",...]`（至少兩條，指名道姓）。\n' +
      '**指不出是哪幾條就不要用它**，改用 fail。\n' +
      '判斷基準是「再退回幾次也不會變好嗎」——如果 coder 有辦法自己解決，那就是 fail 不是 spec_problem。',
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
  const uiChecked = toUiChecked(parsed.uiChecked);

  if (status === 'spec_problem') {
    // **說「規格有問題」就一定要指得出是哪幾條。** 指不出來的話人無從裁決，
    // 而這條路是不回灌給 coder 的——講不清楚就等於把任務停在一句空話上。
    // 退回成 fail 讓 coder 再跑一輪，總比停下來卻沒人知道要決定什麼好。
    const conflicting = Array.isArray(parsed.conflicting)
      ? parsed.conflicting.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
      : [];
    const problem = typeof parsed.problem === 'string' ? parsed.problem.trim() : '';
    if (problem !== '' && conflicting.length > 0) {
      return { status: 'spec_problem', problem, conflicting, ...(uiChecked ? { uiChecked } : {}) };
    }
    return {
      status: 'fail',
      violations: violations.length > 0
        ? violations
        : [{ requirement: '符合規格', problem: 'reviewer 說規格有問題，但沒指出是哪幾條互相衝突' }],
      ...(uiChecked ? { uiChecked } : {}),
    };
  }
  if (status === 'fail') {
    // 說 fail 卻沒給理由 → 補一條泛用理由，否則回灌時 coder 不知道要改什麼
    return {
      status: 'fail',
      violations: violations.length > 0 ? violations : [{ requirement: '符合規格', problem: 'reviewer 判定不合格但未提供具體理由' }],
      ...(uiChecked ? { uiChecked } : {}),
    };
  }
  if (status === 'pass') {
    // **放行書沒說有沒有看畫面 → 不算放行。**
    //
    // 空白不合法是刻意的：先前「沒驗畫面」在報告上一個字都沒有，
    // 於是它與「驗過而且沒問題」長得一模一樣。改成退回讓它補講——
    // 回一句「沒看：這次只改 API 序列化」也完全合法，就是不能不講。
    if (!uiChecked) {
      return {
        status: 'fail',
        violations: [{
          requirement: '放行書必須說明有沒有看畫面',
          problem: 'uiChecked 欄位空白。請補上「看了哪幾條路由／哪些寬度」，'
            + '或「沒看：<為什麼這次不需要>」——兩者都可以，但不能不講。',
        }],
      };
    }
    // 說 pass 卻列了違規 → 以違規為準（寧可多改一輪，也不要放行沒做完的實作）
    return violations.length > 0
      ? { status: 'fail', violations, uiChecked }
      : { status: 'pass', notes, uiChecked };
  }
  if (status === 'skipped' || status === 'skip') {
    return { status: 'skipped', reason: notes[0] ?? 'reviewer 自述無法判定' };
  }
  return null;
}

/** 解析 uiChecked。**空白（缺欄位／空字串）一律回 undefined**——呼叫端據此退回。 */
function toUiChecked(v: unknown): UiChecked | undefined {
  if (!isRecord(v)) return undefined;
  const detail = typeof v.detail === 'string' ? v.detail.trim() : '';
  if (detail === '') return undefined;
  return { looked: v.looked === true, detail };
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
    return { green: false, checks };
  }

  if (verdict.status === 'spec_problem') {
    // 這份報告不會被回灌給 coder（Worker 走交人那條路），但**絕不可以是綠的**——
    // 它會被寫進 PR 內文與事件表，印成綠燈就是在說謊。
    return {
      green: false,
      checks: [{
        name: 'reviewer',
        ok: false,
        detail: `規格本身有問題，不是實作的錯：${verdict.problem}\n互相衝突的要求：\n`
          + verdict.conflicting.map((c, i) => `${i + 1}. ${c}`).join('\n'),
      }],
    };
  }

  const detail = verdict.status === 'pass' ? verdict.notes.join('；') || 'ok' : `略過：${verdict.reason}`;
  const checks: CheckResult[] = [{ name: 'reviewer', ok: true, detail }];
  return { green: true, checks };
}

/** 包裝成 Worker 期望的形狀（ok + asGateReport）。 */
export function toReviewOutcome(verdict: ReviewVerdict): ReviewOutcome {
  return {
    // spec_problem 一樣不放行（規格沒解決就不該 complete_task），
    // 但它走的是**交人**那條路，不是回灌給 coder——見 Worker.review。
    ok: verdict.status !== 'fail' && verdict.status !== 'spec_problem',
    verdict,
    asGateReport: () => reviewGateReport(verdict),
  };
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
