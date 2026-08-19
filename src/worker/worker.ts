import { computeBackoffDelay, realSleep, type BackoffOptions } from '../core/retry.js';
import { changedSince, gitHeadRef } from './verifier.js';
import { commitExists, currentBranch } from '../git/status.js';
import { markHumanReplyConsumed, pendingHumanReply, settledDecisions, standingDecisions, type HumanReply } from './human-reply.js';
import { cardStatusOf } from '../core/card-status.js';
import { RECLAIM_BLOCK_PREFIX } from '../notify/notifier.js';
import type { Ledger } from '../store/ledger.js';
import type { Logger } from '../observability/logger.js';
import type { AgentLike, McpTaskClient, Notifier, ReviewerLike, TaskCardProgress, VerifierLike } from '../contracts.js';
import { formatGateFeedback } from './agent-runtime.js';
import { detectStuck, type RepeatedObstacle } from './stuck-detect.js';
import type { AgentErrorKind, ClarificationCapture, IterateResult, LoadedDoc, NoChangeCapture, NoChangeCategory, SdkErrorCode } from './agent-runtime.js';
import type { ReviewOutcome } from './reviewer.js';
import type { VerifierConfig } from './verifier.js';
import type { BlockReason, GateReport, TaskDetail } from '../types.js';

/**
 * 單一任務最多接受幾次 reviewer 否決回灌（防活鎖）。
 * reviewer 是 LLM 判斷，可能對同一份實作反覆挑出（甚至前後矛盾的）意見；沒有上限
 * 任務就永遠跑不完 —— 而此時 DoD 已綠燈，代表 typecheck/lint/test/build 這些
 * **機器可判定**的關卡全過了。撞上限時採「記錄警告 + 放行，交 PR review 由人把關」，
 * 比無限空轉燒 token 更符合 §D9（判錯由下游人工兜底）與 §D10（不因武斷數字放棄任務）。
 */
const DEFAULT_MAX_REVIEW_REJECTIONS = 3;

/**
 * agent 連續執行錯誤（API 5xx／額度用盡／SDK 崩潰）時的退避預設。
 * 沒有退避的話這裡是**無節制的熱迴圈**：連續錯誤會以最快速度重打 API 燒 token，
 * 而且 worker slot 永遠不釋放。
 *
 * 刻意**不設次數上限**（§D10：不因撞到武斷數字就放棄任務）——改成「退避 + 連續 N 次發通知」，
 * 與無進展偵測（§D11）同一套哲學：只通知，不中止。
 */
const DEFAULT_ERROR_BACKOFF: Required<Pick<BackoffOptions, 'baseDelayMs' | 'maxDelayMs'>> & { notifyEvery: number } = {
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  notifyEvery: 3,
};

/**
 * 監督迴圈的兜底輪數上限（缺陷 2）。
 *
 * **與 §D10 的張力**：D10 說「不設 turn 上限，agent 跑到 DoD 綠燈為止」，那是為了避免
 * 「撞到武斷數字就放棄任務」。但沒有任何出口的 `while(true)` 是另一個極端——搭配不穩定的
 * 關卡（例如視覺 failingId 每輪都變）就是**無聲的無限迴圈**：持續燒 token、永久佔住
 * 一個 worker slot、群組永遠不開 PR、Slack 一則通知都沒有。
 *
 * 所以這個兜底刻意設計成「不是放棄」：
 *   1. 門檻夠寬鬆（預設 20 輪，可用 maxRounds 調整或設 0 停用），正常任務碰不到；
 *   2. 撞到時是 **park 交人**（blocked:needs_human，群組走可恢復路徑、worktree 保留），
 *      不是 failed 這種終態——人解掉之後重新派工會從 round=1 重新開始；
 *   3. 一定發 Slack 通知說明「跑了 N 輪還沒綠，可能是系統問題而非程式碼問題」。
 * 換句話說 D10 的精神是「不武斷放棄」，不是「允許無聲的無限迴圈」。
 */
const DEFAULT_MAX_ROUNDS = 20;

/**
 * 同一任務**連續**因依賴受阻幾次後交人（缺陷 3），以及「至少要卡多久」才算數。
 *
 * 為什麼還要看時間（§D18 誤殺）：依賴未完成是**完全合法**的狀態——上游任務可能正被
 * 另一個群組認真做著，需要幾十分鐘。orchestrator 每輪都會重派，光看次數的話幾分鐘內
 * 就會累積到門檻，把「正常的等待」誤判成「卡死」而 park 掉，反而更拖垮自動化。
 * 因此必須**次數與持續時間同時成立**才交人：那才是「等再久也不會好」的形狀。
 */
const DEFAULT_MAX_DEPS_BLOCKS = 10;
const DEFAULT_MIN_DEPS_BLOCKED_MS = 30 * 60_000;

/** 重試無用的錯誤 → 給人的具體修法提示（光說「失敗」等於沒說）。 */
const UNRETRYABLE_HINT: Partial<Record<SdkErrorCode, string>> = {
  authentication_failed: 'Claude 認證失效，請檢查 .env 的 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 是否過期',
  oauth_org_not_allowed: '此帳號所屬組織無權使用該模型或端點，請確認 ANTHROPIC_BASE_URL 與帳號權限',
  billing_error: '帳務問題（額度用盡或付款失敗），請至帳號後台確認',
  invalid_request: '請求參數不合法，多半是 orchestrator 送出的設定有誤（模型名稱、工具定義），請看 log 詳情',
  model_not_found: '找不到指定的模型，請檢查設定的 model 名稱是否正確',
  max_output_tokens: '單輪輸出超過模型上限，請把任務拆小，或調整任務描述避免一次產出過多內容',
};

/** 連續受阻計數用的稽核事件：deps_blocked 累加、task_claimed 歸零。 */
const DEPS_BLOCK_EVENT = 'deps_blocked';
const CLAIM_EVENT = 'task_claimed';
/** 本任務**首次認領**時的 HEAD（DoD「diff 非空」關卡的基準）。見 storedDiffBase 的說明。 */
const DIFF_BASE_EVENT = 'diff_base';

/** agent 連續錯誤的退避設定（時間來源可注入，測試不必真的等）。 */
export interface ErrorBackoffOptions extends BackoffOptions {
  /** 連續錯誤達幾次（及其倍數）發一次升級通知。預設 3。 */
  notifyEvery?: number;
}

/**
 * 「無需改動」宣告的處置政策。
 * ask = park 等人確認（預設，安全）；auto_complete = 直接 complete_task。
 *
 * 預設全 ask 的理由：complete_task 不可逆，而且「這任務不用做」通常意味著任務板上有
 * 重複/過時/寫錯的卡——那是人該看到的訊號，不該被自動吞掉。
 * 任務板很吵、不想每張都確認時，可把低風險的 already_satisfied 調成 auto_complete。
 */
export type NoChangeDisposition = 'ask' | 'auto_complete';
export type NoChangePolicy = Partial<Record<NoChangeCategory, NoChangeDisposition>>;

/** 通知與稽核用的中文標籤。 */
const NO_CHANGE_LABEL: Record<NoChangeCategory, string> = {
  already_satisfied: '現況已符合需求',
  not_applicable: '任務描述與現況不符',
  blocked_externally: '缺外部依賴無法進行',
  spec_unclear: '規格不足以判斷',
};

export interface WorkerDeps {
  mcp: McpTaskClient;
  agent: AgentLike;
  verifier: VerifierLike;
  ledger: Ledger;
  notifier: Notifier;
  /**
   * 獨立 reviewer（DESIGN §5）。**可選**：未注入 → DoD 綠燈即 complete_task（M1/M2 行為）。
   * 注入後 reviewer 自身也會優雅降級（無金鑰/呼叫失敗 → skipped，不阻擋）。
   */
  reviewer?: ReviewerLike;
  /** 最多接受幾次 reviewer 否決回灌，超過就放行交人工把關。預設 3。 */
  maxReviewRejections?: number;
  /** bug 類完成時產生修復報告（complete_task 的 summary）。 */
  buildFixReport?: (task: TaskDetail, resultText: string) => string;
  /**
   * 取「本任務開始時的 HEAD」，當作 DoD「diff 非空」關卡的比較基準。
   * 預設 verifier.gitHeadRef；回 undefined（不是 git 工作區）→ 停用該關卡並警告（優雅降級）。
   */
  headRef?: (cwd: string) => Promise<string | undefined>;
  /** agent 連續錯誤的退避設定。 */
  errorBackoff?: ErrorBackoffOptions;
  /** 「無需改動」宣告的處置政策。未設 → 一律 ask（park 等人確認）。 */
  noChangePolicy?: NoChangePolicy;
  /** 判定相對 baseRef 是否有變更（驗證 no_change 宣告用）。預設 verifier.changedSince。 */
  changedSince?: (cwd: string, baseRef: string) => Promise<{ ok: true; files: string[] } | { ok: false; detail: string }>;
  /** 存下來的 diff 基準還在不在（跨輪沿用前的檢查）。預設 git/status.commitExists。 */
  commitExists?: (cwd: string, sha: string) => Promise<boolean>;
  /** 目前簽出的分支（判斷存下來的基準是不是同一條分支的）。預設 git/status.currentBranch。 */
  currentBranch?: (cwd: string) => Promise<string | undefined>;
  /** 退避用的等待函式（測試注入，避免真的睡）。 */
  sleep?: (ms: number) => Promise<void>;
  /**
   * 監督迴圈的兜底輪數上限；撞到就 park 交人（可恢復，不是 failed）。預設 20。
   * 設 0（或負數）→ 停用兜底，回到純 §D10 的無上限行為（合法出口，供刻意長跑的專案使用）。
   */
  maxRounds?: number;
  /**
   * 同一任務連續因依賴受阻幾次後交人。預設 10；設 0（或負數）→ 停用（永遠只回 blocked:deps）。
   * 必須與 minDepsBlockedMs **同時**成立才交人，避免把「正常的等待」誤判成卡死。
   */
  maxDepsBlocks?: number;
  /** 連續受阻至少持續多久才算「等再久也不會好」。預設 30 分鐘。 */
  minDepsBlockedMs?: number;
  /** 時間來源（測試注入）。預設 Date.now。 */
  now?: () => number;
  log: Logger;
}

export interface RunTaskInput {
  task: TaskDetail;
  cwd: string; // 群組 worktree 路徑
  verifierConfig: VerifierConfig;
  /**
   * 中止訊號（daemon 收到 SIGTERM 時一路傳下來）。
   * 傳給 agent 與 DoD 指令，讓它們真的停下來並收掉子行程——
   * 沒有它的話 stop 只是「不再排新工作」，正在跑的完全不知情。
   */
  signal?: AbortSignal;
  threadTs?: string;
  /** 所屬群組（session 紀錄用，方便按群彙總成本）。 */
  groupId?: string;
  /**
   * 比較基準（例如 'origin/main'）。傳給介面判斷者，讓它查得出
   * 「這次改了什麼」——沒有它，畫面上所有毛病都會被當成這次弄的。
   */
  baseRef?: string;
  /** 規劃階段的線索（群層級）。由 GroupRunner 從 group 帶下來。 */
  planHint?: { rationale: string; files: string[] };
  /**
   * 回報現在在做哪一步（寫程式／跑驗收／審查中）給控制台。
   *
   * 任務狀態只有 in_progress / verifying 兩格，看不出「agent 在改第 3 輪」還是
   * 「在跑 npm test」還是「reviewer 在審」——而這三件事的等待時間差很多。
   */
  onPhase?: (detail: string) => void;
}

/**
 * 單任務結果。與 GroupRunner 的契約（缺陷 3）——**用 reason 區分「該重試」與「該交人」**：
 *   - `blocked:deps`         → 暫時受阻，群組回 ready 等下一輪重派（可重試）；
 *   - `blocked:needs_human`  → 反覆受阻／撞到輪數上限／宣告無需改動 → park 交人（可恢復、保留 worktree）；
 *   - `parked`               → 等人回答澄清；
 *   - `error`                → 重試無用的錯誤（認領 permanent、complete_task 失敗），停下來讓人看到。
 */
export type TaskOutcome =
  | { status: 'done' }
  | { status: 'blocked'; reason: BlockReason; detail?: string }
  | { status: 'parked'; clarification: ClarificationCapture }
  | { status: 'error'; detail: string };

/**
 * 單任務監督迴圈（DESIGN.md §5）。核心原則：完成 = 調度器實跑 DoD 綠燈，
 * 不信任 agent 自稱；未綠就把具體失敗回灌下一輪，直到綠燈 / 澄清 / 錯誤。
 * DoD 綠燈後還要過獨立 reviewer（全新 context 對 docRefs 規格審查）才 complete_task；
 * reviewer 為可選依賴，未注入或不可用時直接放行（優雅降級）。
 * 不設 turn/token 上限（§D10）；只在無進展時通知（§D11）。
 */
export class Worker {
  constructor(private deps: WorkerDeps) {}

  async runTask(input: RunTaskInput): Promise<TaskOutcome> {
    const { task, cwd, verifierConfig, threadTs } = input;
    const { mcp, agent, verifier, ledger, notifier, log } = this.deps;

    // 1) 認領（MCP 檢查依賴/指派；signal=依賴未到 → 標 blocked）
    let detail: TaskDetail;
    const claim = await mcp.startTask(task.id);
    if (!claim.ok) {
      if (claim.kind === 'signal') return this.handleDepsBlocked(task, claim.detail, threadTs);
      // permanent/transient：重試無用或已重試耗盡。留下稽核軌跡，讓人查得到「為什麼這群停在這」
      ledger.logEvent('task', task.id, 'claim_failed', `${claim.kind}：${claim.detail}`);
      
      // **認領不到的最常見原因是「這張卡本來就是我們自己認領的」。**
      //
      // daemon 重啟時對帳會把 in_progress 任務推回 queued 重跑，但任務板那一側
      // 還停在「進行中」——而 MCP 只讓「待辦」被認領，也沒有取消認領的工具。
      // 於是重新認領必定失敗，而人按重試也永遠是同樣的結果
      //（實跑：使用者對同一個群按了 4 次，每次 3 分鐘後同樣失敗）。
      //
      // 我們手上有本機證據（CLAIM_EVENT）與 get_task 可以查任務板現況，
      // 兩邊都確認「還是我們的」就直接續做，不必再認領一次。
      // **只有我們認領過的才走續認領那條路。** 沒有本機認領紀錄時，認領失敗就是
      // 一般的永久性錯誤（任務不存在、設定錯、指派給別人）——那些要維持原本的
      // 「交由群組停下來」，而不是給人一句誤導的「請到任務板改回待辦」。
      if (!ledger.latestEvent('task', task.id, CLAIM_EVENT)) {
        log.error({ taskId: task.id, kind: claim.kind, detail: claim.detail }, '認領失敗且非依賴問題，交由群組停下來處理');
        return { status: 'error', detail: claim.detail };
      }

      const resumed = await this.tryResumeClaim(task);
      if (resumed.v === 'resume') {
        log.info({ taskId: task.id }, '這張卡本來就是我們認領的（重啟前），直接續做，不重新認領');
        detail = resumed.detail;
      } else {
        return this.parkUnreclaimable(task, claim.detail, resumed, threadTs);
      }
    } else {
      detail = claim.value;
    }
    // ── 重新認領成功 ⇒ 上一次的 complete_task 已經不算數了 ──
    //
    // `complete_task` 有一把永久的冪等鍵（`complete:<id>`），用來擋「daemon 崩在
    // MCP 已送出、ledger 還沒寫之間，重啟後對帳重放」——那個保護是必要的：
    // 任務板拒絕一張已結案的卡，而那個拒絕看起來與「卡不存在」一樣，會讓整群被判 failed。
    //
    // 但它假設了「卡片一旦完成就不會再變回來」，而**人可以手動把它改回待辦**。
    // 實跑（2026-08-19，maFet_gXpQVJ）：第一輪已 complete → 卡片變完成 → 群組因別的原因
    // 重跑 → 認領被拒 → 使用者把卡改回待辦 → 重新認領成功、程式碼跑完也合併了，
    // 但收尾時 claimIrreversible 回 false（鍵還在），於是走「重放」分支、**沒有再呼叫
    // complete_task** ⇒ 卡片永遠停在「進行中」，而且再也沒有人會去改它。
    //
    // 走到這裡代表任務板剛剛讓我們認領成功（或確認這張卡還在我們手上），
    // 兩者都證明它不是「已結案」的狀態 ⇒ 舊的完成憑據作廢。
    ledger.releaseIrreversible(`complete:${task.id}`);
    // 認領成功 = 依賴已滿足 → 之前累積的「連續受阻」歸零（見 depsBlockStreak）
    ledger.logEvent('task', task.id, CLAIM_EVENT, detail.title);
    // 用 clearBlock 而非 updateTaskState：先前受阻留下的 block:deps 不會自己消失，
    // 任務會帶著過期的封鎖標記一路走到 done（e2e 探針 ㉔ 抓到的殘留），
    // 讓對帳、dashboard 與「該不該重派」的判斷全被誤導。
    ledger.clearBlock(task.id, 'in_progress');
    this.say(threadTs, { type: 'claimed' }, detail);

    // 2) 強制讀 docRefs（未讀不准寫 code）
    const docs = await mcp.loadDocs(detail.docRefs);
    this.say(threadTs, { type: 'docs_read', refs: detail.docRefs }, detail);

    // 2b) 記下「本任務開始時的 HEAD」當 DoD「diff 非空」的基準。
    //     群內多個任務共用同一 worktree、前面的任務已被 commitAll 提交，
    //     所以基準必須是**這個任務**開始的那一刻，不能用群分支起點。
    const gateConfig = await this.withDiffGate(verifierConfig, cwd, task.id);

    // 3) 監督迴圈
    //    人回覆過就接回原 session 並注入答案；沒有回覆則是全新一輪（session 從頭開始）。
    const pending = this.pendingReply(task.id);
    // **不只等人回覆時才續接。**
    //
    // 先前只有 pending（有待注入的人工答覆）才撈 session，其餘一律開新的。
    // 於是 daemon 重啟後、或群組被重新派工時，agent 完全不記得自己上一輪做過什麼——
    // 它會從零重新理解任務，先前試過又放棄的方向可能再試一次。
    //
    // session 存在 Claude Code engine 的磁碟上，不是我們行程的記憶體，重啟後照樣接得回來；
    // 真的過期了 iterate 會自己降級開新的（shouldRetryWithoutResume），不會讓這一輪報銷。
    // **群內共用一條寫程式的 session**（使用者裁決）：先找同一群同一角色最近用的，
    // 沒有才退回這個任務自己的（單獨派工、或還沒有群的情況）。
    //
    // 為什麼：群裡第二個任務先前是全新 context——它不知道第一個任務為什麼那樣寫、
    // 試過什麼、放棄了什麼，那些 diff 裡看不到。於是「一起做」的意義只剩下
    // 「檔案在同一個資料夾」，而不是連貫的理解。
    let session =
      (input.groupId ? this.deps.ledger.latestGroupSession(input.groupId, 'worker')?.sessionId : undefined) ??
      this.deps.ledger.latestAgentSession(task.id)?.sessionId;
    let answer = pending ? { question: pending.question, answer: pending.answer } : undefined;
    if (pending) {
      log.info(
        { taskId: task.id, kind: pending.kind, resume: session ?? '(無可續接的 session → 重跑)' },
        '帶著人的回覆續跑',
      );
    }
    let feedback: GateReport | undefined;
    let round = 0;
    // 開工時間：卡片上的「已跑 N 分鐘」靠它。沒有這個數字，人分不出
    // 「正在跑第三輪」和「三分鐘前就死了」——實跑時這兩者在畫面上一模一樣。
    const startedAt = Date.now();
    /** 上一輪的結果摘要，顯示在卡片上。 */
    let lastOutcome: string | undefined;
    // agent 連續執行錯誤次數（成功一輪就歸零）；用來算退避與升級通知
    let consecutiveErrors = 0;
    // 本任務累計被 reviewer 否決次數。刻意「不重置」：若中途 DoD 轉紅就歸零，
    // 「綠→否決→紅→綠→否決…」的交替就能無限延長迴圈，等於沒有上限。
    let reviewRejections = 0;

    const maxRounds = this.deps.maxRounds ?? DEFAULT_MAX_ROUNDS;

    // 這個 repo 上人已經拍板、而且說了「以後都這樣」的決定。
    // 取一次就好：它不會在任務執行中改變，而每輪重查只是白花 DB。
    // 讀失敗不擋任務——少了它最多是 agent 重問一次，擲錯會讓整張卡跑不動。
    let standing: { question: string; answer: string }[] = [];
    try {
      standing = standingDecisions(ledger, task.repo);
      if (standing.length > 0) log.info({ taskId: task.id, repo: task.repo, n: standing.length }, '帶上這個專案已拍板的決定');
    } catch (e) {
      log.warn({ taskId: task.id, err: e instanceof Error ? e.message : String(e) }, '讀常設決定失敗（略過）');
    }

    while (true) {
      round += 1;
      this.syncCard(detail, {
        round,
        elapsedMs: Date.now() - startedAt,
        ...(lastOutcome ? { lastOutcome } : {}),
      });
      // 兜底出口：跑太多輪仍未綠 → park 交人。**不是放棄**（可恢復、保留 worktree、重派時重新計數），
      // 而是不允許「無聲的無限迴圈」持續燒 token 又永久佔住 worker slot（見 DEFAULT_MAX_ROUNDS）。
      // agent 執行錯誤的那幾輪也計入：連續 20 輪 API 出錯同樣是「卡在系統問題」，人該知道。
      if (maxRounds > 0 && round > maxRounds) return this.parkRoundLimit(detail, maxRounds, feedback, threadTs);

      // 兜底出口之二：**同一個障礙第二次擋住它**（見 stuck-detect.ts）。
      //
      // 輪數上限（20）擋的是「無聲的無限迴圈」，但撞到它以前已經燒掉二十輪。
      // 真正該停的時機早得多——實跑的 zZb5MGTMdQRZ 在第 1 次退回之後 13 分鐘就已經
      // 講出了確切的阻礙（「spec 寫不進去」），卻又跑了三輪、多花 27 美元，
      // 而最後那個 PR 帶著一條沒滿足的 DoD 被人按核准合併。
      //
      // 這裡數的是**呼叫端看得到的事實**（同一個 friction kind 第二次／同一份規格
      // 被退回第二次），不讀內容、不判斷語意。
      const stuck = detectStuck(ledger.listEvents({ scope: 'task', refId: task.id, limit: 200 }));
      if (stuck) return this.parkStuck(detail, stuck, threadTs);

      this.say(threadTs, { type: 'iterating', round }, detail);

      input.onPhase?.(`第 ${round} 輪：agent 寫程式中`);
      // 同一群前面幾個任務的交付說明。從 DB 讀而不是靠 session 記得——
      // 群內共用 session 的 context 會被自動壓縮，壓縮壓不掉 DB。
      const priorDeliveries = input.groupId ? this.priorDeliveries(input.groupId, task.id) : [];
      const r = await agent.iterate({ cwd, task: detail, docs, feedback, resumeSessionId: session, ...(input.planHint ? { planHint: input.planHint } : {}), ...(priorDeliveries.length ? { priorDeliveries } : {}), ...(standing.length ? { standingDecisions: standing } : {}), ...(gateConfig.diff ? { baseRef: gateConfig.diff.baseRef } : {}), ...(input.signal ? { signal: input.signal } : {}), ...(answer ? { answer } : {}) });
      session = r.sessionId ?? session;
      if (pending && answer) {
        // 只注入一次：不標消費的話，之後每一輪都會再貼一次同樣的答覆，
        // agent 會以為人又回了一次，把處理過的問題重做一遍。
        markHumanReplyConsumed(ledger, task.id, pending);
        answer = undefined;
      }
      // **每一輪都記**（不只互動用的）：session_id ↔ task_id 的對照是事後看 log 的唯一線索，
      // 成本也只有在這裡拿得到實際數字（SDK 的 result 給的，不是估算）。
      this.recordSession(detail, session, r, input.groupId);
      // 工具計數累加到任務層級（不是每輪）——agent 會 resume session，
      // 第 1 輪讀了規格第 3 輪不會再讀，按輪算會讓協定一致性檢查誤報。
      //
      // 沒有 `?? {}` 退路是刻意的：test/ 現在也在 typecheck 裡了（4b 片），
      // 漏傳 toolCalls 會是**編譯錯誤**而不是靜默的 undefined。
      ledger.addTaskToolCalls(task.id, r.toolCalls);

      // 3a) agent 提出不可逆歧義 → park（M4 接 Slack 等答覆）
      if (r.askedClarification) {
        // 卡片要立刻標成「等你回覆」——否則人看不出這張卡在等自己
        void Promise.resolve(notifier.updateTaskCard?.(task.id, 'awaiting_reply')).catch(() => {});
        ledger.setBlock(task.id, 'needs_clarification', r.askedClarification.question);
        // 問題也寫成事件：人回覆後 clearBlock 會抹掉 block_detail，
        // 少了這筆，續跑時就只剩答案、沒有問題，agent 讀到的會是沒頭沒尾的一句話。
        //
        // **整包寫進去，不要只留問題文字。** agent 已經把 rationale 與 options 結構化
        // 交出來了，先前這裡只取 question、其餘當場蒸發——然後 pending.ts 再用
        // `/建議[：:]/` 從問題正文裡把「建議預設」猜回來。猜錯的那一次會直接被
        // 當成**人的答覆**送給 agent，而稽核紀錄上看起來完全像是人自己打的。
        // threadTs 一起寫：那是「哪一則答覆回答哪一則提問」的關聯鍵
        //（見 settledDecisions——先前靠陣列位置配對，一則沒被回答就整串位移）。
        ledger.logEvent(
          'task', task.id, 'clarification_asked',
          JSON.stringify({ ...r.askedClarification, ...(threadTs ? { threadTs } : {}) }),
        );
        this.say(threadTs, { type: 'problem', detail: `需澄清：${r.askedClarification.question}` }, detail);
        return { status: 'parked', clarification: r.askedClarification };
      }

      // 3a-2) agent 宣告「本任務無需改動」。合法的零 diff 確實存在（功能已存在／描述與現況
      //       不符／缺外部依賴），沒有這個出口 agent 只會為了讓 diff 關卡變綠而亂改程式。
      //       但宣告**不代表**可以結案：complete_task 不可逆，而且「這任務不用做」本身
      //       通常是任務板有問題的訊號，預設要讓人看到。
      if (r.reportedNoChange) {
        const settled = await this.handleNoChange(detail, r.reportedNoChange, gateConfig, cwd, threadTs);
        if (settled) return settled;
        // 實際上有變更 → 宣告作廢（它終究做了事），照常走下面的 DoD 驗證
      }

      // 3b) agent 執行錯誤 → 指數退避後續跑。
      //     不設次數上限（§D10），但一定要退避：連續 API 錯誤若立刻重打，就是無節制的
      //     熱迴圈燒 token，而且 worker slot 永遠不釋放。連續達門檻改發升級通知（只通知、不中止）。
      if (r.isError) {
        // 先看 SDK 給的錯誤語意再決定退不退避：認證失敗、餘額不足、參數錯誤、模型不存在
        // 這些**重試一萬次也不會好**，繼續退避只是安靜地燒時間，而人完全不知道要去修設定。
        // 'capacity'（撞到輸出長度/預算/turn 上限）同理——那要調設定或拆任務，不是等它自己好。
        if (r.errorKind === 'permanent' || r.errorKind === 'capacity') {
          return this.parkUnretryableError(detail, r, threadTs);
        }
        consecutiveErrors += 1;
        await this.backoffAfterAgentError(consecutiveErrors, detail, threadTs, r.resultText, r);
        continue;
      }
      consecutiveErrors = 0;

      // 3c) DoD 關卡（實跑專案指令 + diff 非空）
      ledger.updateTaskState(task.id, 'verifying');
      input.onPhase?.(`第 ${round} 輪：跑驗收關卡`);
      const gate = await verifier.check({
        cwd,
        config: gateConfig,
        ...(input.signal ? { signal: input.signal } : {}),
        // **安靜太久要寫回人在看的那一列。** 不終止（見 VerifierDeps.onStall：
        // 合法的等待與死掉的等待從外面分不出來），但先前唯一的症狀是畫面顯示
        // 「跑驗收關卡」而心跳照跳，看不出它已經一小時沒動（實跑 PR #150）。
        onStall: (i) => input.onPhase?.(
          `第 ${round} 輪：跑驗收關卡（${i.check} 已 ${Math.round(i.elapsedMs / 60_000)} 分鐘`
          + `，其中 ${Math.round(i.quietMs / 60_000)} 分鐘沒有輸出）`,
        ),
      });

      // 3d) DoD 綠燈才輪到獨立 reviewer 對規格審查（§5）。
      //     結果覆寫成「本輪有效關卡報告」：reviewer 否決 → 本輪其實不算綠。
      let effective = gate;
      if (gate.green) {
        input.onPhase?.(`第 ${round} 輪：關卡綠燈，reviewer 對規格審查中`);
        // baseRef 一定要傳，而且**不要 `?? 'HEAD'`**——讓 undefined 一路傳到 reviewer，
        // 由它決定「沒有基準就不審」。退回 HEAD 正是這個 bug 的源頭。
        const review = await this.review(detail, docs, cwd, threadTs, reviewRejections, gateConfig.diff?.baseRef, input.groupId);
        // **規格問題直接停手交人**，不進回灌迴圈。
        //
        // 實跑（zZb5MGTMdQRZ）：reviewer 每一輪都正確地發現不符，每一輪都只能說 fail，
        // 每一輪都把它送回一個 coder 解不了的地方——四輪、$36.64，最後那個 PR
        // 帶著一條沒滿足的 DoD 被人按核准合併。
        if ('specProblem' in review) return this.parkSpecProblem(detail, review.specProblem, threadTs);
        if (review.rejected) {
          reviewRejections += 1;
          effective = review.report;
        }
      }

      // 這一輪的結論寫進卡片：綠燈就說綠燈，紅燈就列出是哪些關卡不過。
      // 沒有這行，人只看得到狀態在「執行中／驗證中」之間跳，看不出它到底在修什麼。
      lastOutcome = effective.green
        ? '所有關卡通過'
        : effective.checks.filter((c) => !c.ok).map((c) => c.name).join('、') || '未通過';

      // ── 這裡原本有「無進展偵測」，已下線（第 14 片） ──
      //
      // 它的判準是「連續 N 輪的結果簽章一模一樣」，而簽章＝失敗關卡名 ＋
      // 從輸出用正則撈到的失敗測試名。撈那一步只認得 TAP／node:test／jest 三種格式，
      // 其他工具鏈一律回空陣列——於是簽章退化成「哪幾條關卡是紅的」。
      // 結果是：agent 每一輪都在修不同的東西、輸出完全不同，只要 `test` 這條還沒轉綠，
      // 簽章就一模一樣，它會被判定成「卡在同一處」並通知人。那是個誤報製造機。
      //
      // 取代它的是**輪數上限**（maxRounds → parkRoundLimit 交人）：那是一個數得清楚、
      // 不需要猜語意的界線，而且撞到時保留全部現場給人看。

      if (effective.green) {
        // 4) 完成 → complete_task（bug 帶 summary，其餘不帶）
        const summary =
          detail.category === 'bug'
            ? (this.deps.buildFixReport ?? defaultFixReport)(detail, r.resultText)
            : undefined;
        // **冪等鍵**：`complete_task` 在任務板上不可逆，而重放會發生
        // （daemon 崩在「MCP 已送出、ledger 還沒寫」之間，重啟後對帳會再走一次）。
        // 做第二次的後果與第一次不同：任務板拒絕一張已結案的卡，而那個拒絕在這裡
        // 看起來與「這張卡不存在」一模一樣——於是整群被判 failed。
        const doneKey = `complete:${task.id}`;
        if (!ledger.claimIrreversible(doneKey, 'complete_task', task.id)) {
          log.warn({ taskId: task.id }, 'complete_task 已經送出過了，直接視為完成（重放）');
          ledger.updateTaskState(task.id, 'done');
          return { status: 'done' };
        }
        const done = await mcp.completeTask(task.id, summary ? { summary } : undefined);
        if (!done.ok) {
          // 確定沒生效才放掉鍵——不放的話這張卡再也結不了案
          ledger.releaseIrreversible(doneKey);
          ledger.updateTaskState(task.id, 'verifying', { lastError: `complete_task 失敗：${done.detail}` });
          return { status: 'error', detail: `complete_task 失敗：${done.detail}` };
        }
        ledger.updateTaskState(task.id, 'done');
        log.info({ taskId: task.id, rounds: round }, '✅ 任務完成（DoD 綠燈）');
        return { status: 'done' };
      }

      // 5) 未綠 → 具體失敗回灌下一輪。
      //    只有真的有失敗關卡才回灌：空的失敗清單會讓 prompt 出現「上一輪未通過」卻列不出任何項目，
      //    等於要 agent 猜謎（也可能讓它為了「修」而亂改）。
      feedback = actionableFeedback(effective);

      // **把「agent 這一輪收到了什麼」原樣記下來。**
      //
      // 回灌是靜默失效的高風險區：接線斷掉時 typecheck 全綠、測試全綠、log 也不會有錯誤，
      // 只有 agent 開始盲改——而那要好幾輪之後才看得出來，看出來時已經燒掉一整群的預算。
      // 記的是 buildAgentPrompt **實際會輸出的那段文字**（同一個函式），不是另外拼一份摘要，
      // 否則這筆紀錄本身就會跟事實脫節。
      const sent = formatGateFeedback(feedback);
      ledger.logEvent(
        'task', task.id, 'feedback_to_agent',
        sent ?? '（這一輪沒有可回灌的失敗明細——agent 下一輪不會收到「上一輪未通過」那一段）',
      );
    }
  }

  /**
   * 撞到輪數上限時的出口（缺陷 2）：park 交人，保留一切現場。
   *
   * 用 `needs_human` 而非 failed，是因為 failed 是終態、沒有任何路徑會再派工（等於任務遺失）；
   * needs_human 走的是 GroupRunner 的可恢復路徑（群組 park、worktree 保留），
   * 人排除障礙後由 requeue 階段轉回 ready 續做。
   */
  /**
   * 同一個障礙擋了第二次 → park 交人。
   *
   * **這是 park 不是 failed**：worktree、已 commit 的成果、session 全部保留，
   * 人排除障礙之後 requeue 就續做。
   *
   * 誤判的代價刻意設成不對稱的：誤停一次 ＝ 人按一下重試；漏掉一次 ＝ 實跑那 36 美元，
   * 外加一條沒滿足的 DoD 被人按核准合併、而「這是刻意的特例」沒有留在任何地方。
   * 所以偏向多停。
   */
  /**
   * reviewer 判定「規格本身有問題」→ park 交人裁決。
   *
   * 與 parkStuck 的差別：那個是**數出來的**（同一個障礙第二次），這個是
   * **審查者讀完規格與 diff 之後說的**。兩條路都通向同一個地方——人——
   * 但這條通常更早、而且帶著「是哪幾條在打架」的具體清單。
   */
  private parkSpecProblem(
    detail: TaskDetail,
    sp: { problem: string; conflicting: string[] },
    threadTs: string | undefined,
  ): TaskOutcome {
    const { ledger, log } = this.deps;
    const why =
      `審查者判定**這不是實作的錯，是規格的問題**，需要你裁決。\n\n` +
      `${sp.problem}\n\n` +
      `互相衝突的要求：\n${sp.conflicting.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n` +
      '請決定哪一條讓步（或補一條特例），然後按重試——它會接著原本的 session 續做。\n' +
      '**這條路沒有回灌給 agent**：再退回幾次也不會變好，成因不在它手上。';

    ledger.setBlock(detail.id, 'needs_human', truncate(why, 1200));
    ledger.logEvent('task', detail.id, 'spec_problem_parked', `${sp.problem}\n${sp.conflicting.join(' / ')}`);
    this.say(threadTs, { type: 'problem', detail: why }, detail);
    log.error({ taskId: detail.id, conflicting: sp.conflicting }, '⚠️ 規格問題，park 交人裁決（可恢復）');
    return { status: 'blocked', reason: 'needs_human', detail: why };
  }

  private parkStuck(detail: TaskDetail, stuck: RepeatedObstacle, threadTs: string | undefined): TaskOutcome {
    const { ledger, log } = this.deps;
    const why =
      `同一個障礙第 ${stuck.count} 次擋住這個任務，agent 沒有主動求救 → 停下來交人。\n\n` +
      `${stuck.body}\n\n` +
      '**如果這幾條要求真的無法同時成立，需要你決定誰讓步**——' +
      'agent 每次滿足其中一邊都會被另一邊退回，再跑幾輪也一樣。\n' +
      '排除障礙（或給出裁決）之後按重試，它會接著原本的 session 續做，成果都還在。';

    ledger.setBlock(detail.id, 'needs_human', truncate(why, 1200));
    ledger.logEvent('task', detail.id, 'stuck_parked', `${stuck.kind} ×${stuck.count}`);
    this.say(threadTs, { type: 'problem', detail: why }, detail);
    log.error(
      { taskId: detail.id, kind: stuck.kind, count: stuck.count },
      '⚠️ 同一個障礙重複出現，park 交人（可恢復）',
    );
    return { status: 'blocked', reason: 'needs_human', detail: why };
  }

  private parkRoundLimit(
    detail: TaskDetail,
    maxRounds: number,
    lastFeedback: GateReport | undefined,
    threadTs: string | undefined,
  ): TaskOutcome {
    const { ledger, notifier, log } = this.deps;
    const failing = (lastFeedback?.checks ?? [])
      .filter((c) => !c.ok)
      .map((c) => `${c.name}：${c.detail}`)
      .join('\n');
    const why =
      `已跑 ${maxRounds} 輪仍未通過 DoD，交人接手（成果與 worktree 都保留，解除後可續做）。\n` +
      '跑到這個輪數通常代表卡在**系統問題**（關卡不穩定、環境缺件、規格與現況矛盾）而非程式碼問題，' +
      '請先看最後未通過的關卡是不是每輪都在變。' +
      (failing ? `\n最後未通過的關卡：\n${failing}` : '');

    ledger.setBlock(detail.id, 'needs_human', truncate(why, 500));
    ledger.logEvent('task', detail.id, 'round_limit_parked', `${maxRounds} 輪未綠`);
    this.say(threadTs, { type: 'problem', detail: why }, detail);
    log.error({ taskId: detail.id, maxRounds }, '⚠️ 監督迴圈撞到輪數上限，park 交人（可恢復）');
    return { status: 'blocked', reason: 'needs_human', detail: why };
  }

  /**
   * 認領被拒時，判斷「這張卡是不是本來就是我們認領的」。
   *
   * 兩層證據都要對得上才續做——**只信本機會很危險**：ledger 說我們認領過，
   * 但那張卡可能已經被轉給別人、或被人改回待辦又指派出去。
   * 只憑本機紀錄就跳過認領，等於去做別人正在做的任務。
   *
   *   ① 本機：有沒有 CLAIM_EVENT（我們確實認領過）
   *   ② 任務板：get_task 回來的狀態還是不是「進行中」、repo 對不對
   *
   * 任何一層對不上就不續做——寧可停下來問人，也不要兩個人做同一張卡。
   */
  private async tryResumeClaim(
    task: TaskDetail,
  ): Promise<{ v: 'resume'; detail: TaskDetail } | { v: 'not_mine'; why: string } | { v: 'unknown'; why: string }> {
    const { mcp, ledger } = this.deps;

    // ① 本機證據（呼叫端已經先擋過一次，這裡是防禦性的第二道）
    if (!ledger.latestEvent('task', task.id, CLAIM_EVENT)) {
      return { v: 'not_mine', why: '本機沒有這張卡的認領紀錄' };
    }

    // ② 任務板現況。查不到就不猜——「查不到」與「還是我的」是兩件事
    let board: TaskDetail;
    try {
      board = await mcp.getTask(task.id);
    } catch (e) {
      return { v: 'unknown', why: `查不到任務板現況：${e instanceof Error ? e.message : String(e)}` };
    }
    if (board.repo !== task.repo) return { v: 'not_mine', why: `任務板說它屬於 ${board.repo}` };
    if (board.status === 'done') return { v: 'not_mine', why: '這張卡在任務板上已經結案' };
    if (board.status !== 'in_progress') return { v: 'not_mine', why: `任務板狀態是「${board.status}」` };

    return { v: 'resume', detail: board };
  }

  /**
   * 認領不回來 → park 交人，並**明講要去哪裡做什麼**。
   *
   * 這一類的解法不在這個系統裡：任務板上那張卡還停在「進行中」，而 MCP 沒有
   * 取消認領的工具。所以這裡刻意不回 `error`（那會讓群組進 failed 終態，
   * 而人看到的只有一顆按了沒用的重試鈕），改成 blocked:needs_human 並帶上
   * RECLAIM_BLOCK_PREFIX——待處理清單會把它單獨列成一類，寫清楚要去任務板改回待辦。
   */
  private parkUnreclaimable(
    task: TaskDetail,
    claimDetail: string,
    reason: { v: 'not_mine' | 'unknown'; why: string },
    threadTs: string | undefined,
  ): TaskOutcome {
    const { ledger, log } = this.deps;
    const detail =
      `${RECLAIM_BLOCK_PREFIX}：${task.id} 認領被拒（${claimDetail}）。${reason.why}。`
      + '**請到任務板把這張卡改回「待辦」**，改完就會自己接回去（下一輪輪詢，最多幾分鐘），'
      + '不需要回來按任何按鈕。\n'
      // 先前這裡寫「改完再按重試」，而這種單的動作是空的（解法不在這個系統裡，
      // 卡片還停在「進行中」時按重試確實沒用）——於是人做完唯一能做的事之後，
      // 畫面上找不到那顆被指定要按的按鈕，任務就停在這裡（實跑 2026-08-19，maFet_gXpQVJ）。
      + '（這裡沒有可按的動作是刻意的：任務板沒有取消認領的工具，解法只在任務板那一邊。）';

    ledger.setBlock(task.id, 'needs_human', detail);
    ledger.logEvent('task', task.id, 'reclaim_blocked', detail);
    log.error({ taskId: task.id, why: reason.why }, '認領不回來，交人處理（要去任務板改狀態）');
    this.say(threadTs, { type: 'problem', detail }, task);
    return { status: 'blocked', reason: 'needs_human', detail };
  }


  /**
   * 認領被依賴擋下時的處置（缺陷 3）。
   *
   * 預設回 `blocked:deps`（＝「還沒輪到」，群組回 ready 等重派）；只有**連續受阻次數**與
   * **持續時間**同時超標，才升級成 `blocked:needs_human` 交人——因為「依賴未完成」本身
   * 完全合法（上游正在被做），單看次數會在幾分鐘內誤殺正常的等待（§D18）。
   */
  private handleDepsBlocked(task: TaskDetail, blockDetail: string, threadTs: string | undefined): TaskOutcome {
    const { ledger, notifier, log } = this.deps;
    const maxBlocks = this.deps.maxDepsBlocks ?? DEFAULT_MAX_DEPS_BLOCKS;
    const minElapsed = this.deps.minDepsBlockedMs ?? DEFAULT_MIN_DEPS_BLOCKED_MS;

    ledger.logEvent('task', task.id, DEPS_BLOCK_EVENT, blockDetail);
    const streak = this.depsBlockStreak(task.id);
    const elapsed = streak.firstAt === undefined ? 0 : (this.deps.now ?? Date.now)() - streak.firstAt;

    if (maxBlocks > 0 && streak.count >= maxBlocks && elapsed >= minElapsed) {
      const mins = Math.round(elapsed / 60_000);
      const why =
        `依賴長期未滿足：連續 ${streak.count} 次認領受阻、已持續約 ${mins} 分鐘，交人確認。\n` +
        '常見原因是上游任務不在本調度器的任務範圍內（永遠不會被完成），或依賴宣告有誤。\n' +
        `MCP 最後的訊息：${blockDetail}`;
      ledger.setBlock(task.id, 'needs_human', truncate(why, 500));
      ledger.logEvent('task', task.id, 'deps_blocked_escalated', `${streak.count} 次／${mins} 分鐘`);
      this.say(threadTs, { type: 'problem', detail: why }, task);
      log.error({ taskId: task.id, count: streak.count, mins }, '⚠️ 依賴反覆受阻，park 交人（可恢復）');
      return { status: 'blocked', reason: 'needs_human', detail: why };
    }

    ledger.setBlock(task.id, 'deps', blockDetail);
    log.info({ taskId: task.id, count: streak.count, detail: blockDetail }, '認領受阻（依賴未滿足），標 blocked 等重派');
    return { status: 'blocked', reason: 'deps', detail: blockDetail };
  }

  /**
   * 目前這一串「連續」受阻的次數與起始時間。
   * 從新到舊掃稽核事件，遇到 CLAIM_EVENT（認領成功）就停——中途成功過就不算連續，
   * 否則久遠以前的受阻會一路累積，讓一個偶爾被擋的任務莫名其妙被交人。
   */
  private depsBlockStreak(taskId: string): { count: number; firstAt?: number } {
    const events = this.deps.ledger.listEvents({ scope: 'task', refId: taskId, limit: 200 });
    let count = 0;
    let firstAt: number | undefined;
    for (const e of events) {
      if (e.kind === CLAIM_EVENT) break;
      if (e.kind !== DEPS_BLOCK_EVENT) continue;
      count += 1;
      firstAt = e.createdAt; // 由新到舊，最後看到的那筆就是這串的起點
    }
    return firstAt === undefined ? { count } : { count, firstAt };
  }

  /**
   * 在專案的驗證設定上補「diff 非空」關卡（DESIGN §5 DoD）。
   *
   * 這道閘門就擋在 complete_task 的路徑上：agent 一行都沒改也可能自認完成，
   * 而 DoD 綠燈 → reviewer（無 docRefs 時 skipped）→ completeTask，MCP 的 done **不可逆**，
   * 還會解鎖下游任務並開出空 diff 的 PR。
   *
   * 取不到 HEAD（cwd 不是 git 工作區）→ 停用此關卡並警告：安全檢查不該讓正常流程直接癱瘓，
   * 但要吵到看得見（log.error + Slack 通知），不能靜靜地把把關拿掉。
   */
  /**
   * 同一群裡**這個任務之前**的交付說明。
   *
   * 排除自己：重跑時把自己上一輪的交付說明再貼一次，只會讓 agent 以為那是別人做的。
   */
  private priorDeliveries(groupId: string, taskId: string): { taskId: string; text: string }[] {
    return this.deps.ledger
      .listHandoffs({ groupId, kind: 'delivery' })
      .filter((h) => h.taskId && h.taskId !== taskId)
      .map((h) => ({ taskId: h.taskId!, text: h.body }));
  }

  private async withDiffGate(config: VerifierConfig, cwd: string, taskId: string): Promise<VerifierConfig> {
    const { log, ledger } = this.deps;
    const head = this.deps.headRef ?? gitHeadRef;
    const exists = this.deps.commitExists ?? commitExists;
    const branchOf = this.deps.currentBranch ?? currentBranch;

    const branch = await branchOf(cwd).catch(() => undefined);
    let baseRef = await this.storedDiffBase(taskId, cwd, branch, exists);
    let reused = baseRef !== undefined;

    if (!reused) {
      try {
        baseRef = await head(cwd);
      } catch (e) {
        log.warn({ cwd, err: e instanceof Error ? e.message : String(e) }, '取 HEAD 失敗');
      }
      if (baseRef) {
        // **欄位是新家，事件只留當稽核軌跡。** 欄位的 first-write-wins 在 SQL 裡，
        // 所以「已經有值就不覆寫」是原子的——不像事件要靠讀出來再自己判斷。
        //
        // 先判斷格式再寫：欄位只收 40 位 sha（寫 ref 名字進去會擲錯，見 ledger 的
        // assertCommitSha）。gitHeadRef 正常會回 sha 或空樹 sha，但它也可能因為
        // 環境異常回別的東西——那時記帳失敗不該讓整個任務倒，退回只寫事件。
        if (/^[0-9a-f]{40}$/.test(baseRef)) ledger.setTaskStartSha(taskId, baseRef, branch);
        ledger.logEvent('task', taskId, DIFF_BASE_EVENT, JSON.stringify({ sha: baseRef, branch: branch ?? null }));
      }
    }

    if (!baseRef) {
      log.error(
        { taskId, cwd },
        '⚠️ 無法取得工作區 HEAD → 本任務停用「diff 非空」關卡（agent 沒改東西也可能被判完成）；'
          + 'reviewer 會 skip（沒有基準不審），Stop hook 退回 porcelain（agent 自行 commit 後會被誤判成沒做事）',
      );
      return config;
    }
    log.debug(
      { taskId, baseRef, reused },
      reused ? 'diff 非空關卡基準 = 首次認領時的 HEAD（沿用）' : 'diff 非空關卡基準 = 任務開始時的 HEAD',
    );
    return { ...config, diff: { baseRef } };
  }

  /**
   * 讀出這個任務**首次認領**時記下的 diff 基準，沒有／不能用就回 undefined（呼叫端重抓）。
   *
   * ── 為什麼基準不能每輪重抓 ──
   *
   * 一個任務會被重跑：retry、澄清答覆後續做、daemon 重啟後對帳重排。而 agent 上一輪
   * 很可能**已經自己 commit 了**。每輪重抓 HEAD 的話，第二輪的基準就是「含它自己上一輪
   * 產出的那個 commit」，於是 diff 為空 → DoD 判「本輪無變更」→ 回灌「尚未實作」。
   *
   * 實跑撞到（正式 log）：agent 自己說「本任務的實作已完整存在於本分支 HEAD
   * （commit b0ddf9d，為本任務前一輪產出），工作區乾淨、DoD 已逐條經瀏覽器驗證。
   * 但 no-changes 關卡以『本輪起始 HEAD』為基準，因此判定本輪無變更。」
   * ——它做完了，而且知道自己做完了，卻沒有辦法讓關卡承認。
   *
   * ── 為什麼要驗分支與 sha 還在不在 ──
   *
   * 存下來的 sha 會變成孤兒：worktree 被砍掉重建、群分支刪掉重開、任務被搬到別群。
   * 那時沿用舊 sha 有兩種壞法——解不開就擲錯（整道關卡靜靜停用），
   * 或解得開但太舊（diff 含別的任務的成果，關卡就變成橡皮圖章）。
   * 分支不同或 sha 不在 → 重抓，寧可回到「這一輪」的基準也不要拿一個錯的。
   *
   * 注意基準**刻意不是群分支起點**：群內多個任務共用同一 worktree，前面的任務已被
   * commitAll 提交，用群起點會讓每個任務都繼承前面任務的 diff。
   */
  private async storedDiffBase(
    taskId: string,
    cwd: string,
    branch: string | undefined,
    exists: (cwd: string, sha: string) => Promise<boolean>,
  ): Promise<string | undefined> {
    const { log, ledger } = this.deps;

    // **先讀欄位（新家），讀不到才退回事件。**
    // 既有的 in-flight 任務只有事件，那一輪會走舊路徑，然後呼叫端把欄位補上；
    // 部署後第一輪的 log 裡會看到這條退路被走到，那是預期的。
    const row = ledger.getTask(taskId);
    let sha = row?.taskStartSha;
    // 欄位有 sha 就一定也有分支的記錄（同一次寫入），沒有記到就是 null（detached）
    let storedBranch: string | null | undefined = sha ? (row?.taskStartBranch ?? null) : undefined;

    if (!sha) {
      const raw = ledger.latestEvent('task', taskId, DIFF_BASE_EVENT)?.detail;
      if (!raw) return undefined;
      try {
        const parsed = JSON.parse(raw) as { sha?: unknown; branch?: unknown };
        if (typeof parsed.sha === 'string') sha = parsed.sha;
        if (typeof parsed.branch === 'string' || parsed.branch === null) storedBranch = parsed.branch;
      } catch {
        // 更舊的格式（純 sha 字串）也接受——升級時不要讓既有任務全部退回重抓
        sha = raw.trim() || undefined;
      }
      if (!sha) return undefined;
    }

    // 這兩道驗證對「欄位」與「事件」都要跑：存下來的 sha 會變成孤兒
    // （worktree 砍掉重建、群分支刪掉重開、任務被搬到別群）。
    // 沿用一個孤兒 sha 有兩種壞法——解不開就擲錯（整道關卡靜靜停用），
    // 或解得開但太舊（diff 含別的任務的成果，關卡變成橡皮圖章）。
    if (storedBranch !== undefined && storedBranch !== (branch ?? null)) {
      log.info({ taskId, storedBranch, branch }, 'diff 基準記錄的分支已不同 → 重抓基準');
      return undefined;
    }
    if (!(await exists(cwd, sha).catch(() => false))) {
      log.info({ taskId, sha }, 'diff 基準的 commit 已不在這個工作區 → 重抓基準');
      return undefined;
    }
    return sha;
  }

  /**
   * 處理 agent 的「本任務無需改動」宣告。
   *
   * 回傳 undefined = 宣告作廢（實際有變更），呼叫端照常走 DoD 驗證。
   * 回傳 TaskOutcome = 已處置（park 等人確認，或依政策直接結案）。
   *
   * 為什麼預設要人確認而不是自動結案：complete_task 不可逆，而且「這任務不用做」
   * 本身通常代表任務板有重複/過時/寫錯的卡——自動標 done 會把這個訊號吞掉。
   */
  private async handleNoChange(
    detail: TaskDetail,
    report: NoChangeCapture,
    gateConfig: VerifierConfig,
    cwd: string,
    threadTs: string | undefined,
  ): Promise<TaskOutcome | undefined> {
    const { ledger, notifier, log, mcp } = this.deps;
    const changed = this.deps.changedSince ?? changedSince;

    // 1) 說了「不用改」卻真的改了東西 → 以事實為準，宣告作廢
    const baseRef = gateConfig.diff?.baseRef;
    if (baseRef) {
      const changes = await changed(cwd, baseRef);
      if (changes.ok && changes.files.length > 0) {
        log.info(
          { taskId: detail.id, files: changes.files.length },
          'agent 宣告無需改動，但工作區確實有變更 → 宣告作廢，照常驗證',
        );
        ledger.logEvent('task', detail.id, 'no_change_overridden', `實際變更 ${changes.files.length} 個檔案`);
        return undefined;
      }
    }

    const summary = `${NO_CHANGE_LABEL[report.category]}：${report.reason}`;
    ledger.logEvent('task', detail.id, 'no_change_reported', JSON.stringify(report));

    // 2) 依政策處置。預設全部 'ask'——寧可多問一次，也不要把不可逆的 done 交給 LLM 判斷。
    const policy = this.deps.noChangePolicy?.[report.category] ?? 'ask';
    if (policy === 'auto_complete') {
      const done = await mcp.completeTask(
        detail.id,
        detail.category === 'bug' ? { summary: `${summary}\n\n${report.evidence ?? ''}`.trim() } : undefined,
      );
      if (!done.ok) {
        ledger.updateTaskState(detail.id, 'verifying', { lastError: `complete_task 失敗：${done.detail}` });
        return { status: 'error', detail: `complete_task 失敗：${done.detail}` };
      }
      ledger.updateTaskState(detail.id, 'done');
      log.warn({ taskId: detail.id, category: report.category }, '依政策自動結案「無需改動」的任務');
      this.say(threadTs, { type: 'problem', detail: `已自動結案（無需改動）— ${summary}` }, detail);
      return { status: 'done' };
    }

    // 3) 預設：park 等人確認。用 needs_human 讓 GroupRunner 走「可恢復 + 保留 worktree」路徑。
    const detailText = report.evidence ? `${summary}\n依據：${report.evidence}` : summary;
    ledger.setBlock(detail.id, 'needs_human', `無需改動：${detailText}`);
    this.say(threadTs, { type: 'problem', detail: `agent 判定無需改動，待確認 — ${detailText}` }, detail);
    log.warn({ taskId: detail.id, category: report.category }, '任務被宣告無需改動，park 等人確認');
    return { status: 'blocked', reason: 'needs_human', detail: detailText };
  }

  /**
   * 發 thread 事件，並**同步把卡片更新成 ledger 當下的真實狀態**。
   *
   * 分開手動維護的話一定會漏（稽核時發現 worker 裡有八個事件點沒動卡片：
   * 無需改動、無進展、等前置任務、重試無用交人處理…）。卡片停著不動，
   * 在人眼裡跟系統卡住是一樣的。
   */
  private say(threadTs: string | undefined, event: Parameters<Notifier['event']>[1], task: TaskDetail): void {
    const { notifier, log } = this.deps;
    void Promise.resolve(notifier.event(threadTs, event, task)).catch((e) =>
      log.warn({ err: e instanceof Error ? e.message : String(e) }, '通知失敗（忽略）'),
    );
    // 卡片同步整段包住：介面更新失敗絕不該影響任務流程
    try {
      this.syncCard(task);
    } catch (e) {
      log.warn({ taskId: task.id, err: e instanceof Error ? e.message : String(e) }, '任務卡同步失敗（忽略）');
    }
  }

  private syncCard(task: TaskDetail, progress?: TaskCardProgress): void {
    const { notifier, ledger, log } = this.deps;
    const update = notifier.updateTaskCard;
    if (!update) return;
    const t = ledger.getTask(task.id);
    if (!t) return;
    const group = t.groupId ? ledger.getGroup(t.groupId) : undefined;
    const status = cardStatusOf({
      taskState: t.state,
      ...(t.block?.reason ? { blockReason: t.block.reason } : {}),
      ...(group ? { groupState: group.state } : {}),
    ...(t.block?.detail ? { blockDetail: t.block.detail } : {}),
      });
    void Promise.resolve(update.call(notifier, task.id, status, {
      ...(t.groupId ? { groupId: t.groupId } : {}),
      ...(t.block?.detail ? { prompt: t.block.detail } : {}),
      ...(progress ? { progress } : {}),
    })).catch((e) =>
      log.warn({ taskId: task.id, err: e instanceof Error ? e.message : String(e) }, '任務卡更新失敗（忽略）'),
    );
  }

  /**
   * 讀出「人已回覆、但還沒送進 agent」的內容。
   * 讀失敗不能讓任務跑不動——退回「沒有回覆」＝照舊重跑一輪（會慢，但不會壞）。
   */
  /** 這個任務上人已經裁決過的問題。讀失敗不該讓審查跑不動 → 退回空陣列。 */
  private settledDecisions(taskId: string): { question: string; answer: string }[] {
    try {
      return settledDecisions(this.deps.ledger, taskId);
    } catch (e) {
      this.deps.log.warn({ taskId, err: e instanceof Error ? e.message : String(e) }, '讀取已裁決問題失敗（忽略）');
      return [];
    }
  }

  private pendingReply(taskId: string): HumanReply | undefined {
    try {
      return pendingHumanReply(this.deps.ledger, taskId);
    } catch (e) {
      this.deps.log.warn({ taskId, err: e instanceof Error ? e.message : String(e) }, '讀取人類回覆失敗，改為重跑一輪');
      return undefined;
    }
  }

  /**
   * 記錄本輪的 session 與用量。
   *
   * 為什麼連「沒有互動」的 session 也要記：事後查「這個任務當時到底做了什麼」時，
   * 唯一能把 ledger 與 SDK 的 session log 對起來的鍵就是 session_id；
   * 成本歸屬（哪個任務花最多）也靠這張表。缺一次就是一段查不到的空白。
   */
  private recordSession(
    detail: TaskDetail,
    sessionId: string | undefined,
    r: Pick<IterateResult, 'usage' | 'isError' | 'askedClarification' | 'reportedNoChange'>,
    groupId?: string,
  ): void {
    if (!sessionId) return; // SDK 沒回 session（極少見）→ 沒有可對照的鍵，記了也沒用
    try {
      this.deps.ledger.recordAgentSession({
        kind: 'worker',
        taskId: detail.id,
        repo: detail.repo,
        sessionId,
        ...(groupId ? { groupId } : {}),
        ...(r.usage
          ? {
              costUsd: r.usage.costUsd,
              inputTokens: r.usage.inputTokens,
              outputTokens: r.usage.outputTokens,
              cacheReadTokens: r.usage.cacheReadTokens,
              models: r.usage.models,
            }
          : {}),
        status: r.isError ? 'error' : r.askedClarification || r.reportedNoChange ? 'parked' : 'active',
      });
    } catch (e) {
      // 記錄失敗不該影響任務本身（這是觀測資料，不是流程的一部分）
      this.deps.log.warn({ taskId: detail.id, err: e instanceof Error ? e.message : String(e) }, 'session 紀錄寫入失敗');
    }
  }

  /**
   * 重試無用的 agent 錯誤（認證/帳務/參數/模型不存在，或撞到輸出長度/預算/turn 上限）。
   *
   * 這類錯誤 SDK 已經告訴我們語意了（SDKAssistantMessageError），繼續退避重試只是
   * 安靜地燒時間——而問題其實在**設定或任務本身**，非得有人去改不可。所以直接 park 交人
   * （可恢復、保留 worktree），並把 SDK 給的錯誤碼與 HTTP 狀態一起寫進 block detail，
   * 人一眼就知道要修什麼（是 token 過期？餘額用完？還是任務太大？）。
   */
  private parkUnretryableError(
    detail: TaskDetail,
    r: Pick<IterateResult, 'errorKind' | 'sdkError' | 'httpStatus' | 'resultText'>,
    threadTs: string | undefined,
  ): TaskOutcome {
    const { ledger, notifier, log } = this.deps;
    const label = r.errorKind === 'capacity' ? '容量/上限問題' : '設定或授權問題';
    const hint = UNRETRYABLE_HINT[r.sdkError ?? 'unknown'] ?? '請查看 log 與設定';
    const why = [
      r.sdkError ? `sdk=${r.sdkError}` : '',
      r.httpStatus !== undefined ? `status=${r.httpStatus}` : '',
    ].filter(Boolean).join(' ');
    const text = `${label}${why ? `（${why}）` : ''}：${hint}`;

    ledger.setBlock(detail.id, 'needs_human', text);
    ledger.logEvent('task', detail.id, 'agent_error_unretryable', `${text}｜${truncate(r.resultText ?? '', 300)}`);
    log.error({ taskId: detail.id, kind: r.errorKind, sdkError: r.sdkError, status: r.httpStatus }, `❌ ${text}（重試無用，交人處理）`);
    this.say(threadTs, { type: 'problem', detail: `${text}（重試無用，已交人處理）` }, detail);
    return { status: 'blocked', reason: 'needs_human', detail: text };
  }

  /**
   * agent 執行錯誤後的退避（缺陷 2）。
   * 退避時間指數成長並夾在上限內；連續次數達 notifyEvery 的倍數時改發升級通知，
   * 讓人知道「這個任務正在持續失敗」——但**不中止**任務（§D10/§D11）。
   */
  private async backoffAfterAgentError(
    consecutive: number,
    detail: TaskDetail,
    threadTs: string | undefined,
    lastText: string,
    r?: Partial<Pick<IterateResult, 'errorKind' | 'sdkError' | 'httpStatus' | 'sdkRetries'>>,
  ): Promise<void> {
    const { ledger, notifier, log } = this.deps;
    const opts = this.deps.errorBackoff ?? {};
    const delayMs = computeBackoffDelay(consecutive, {
      baseDelayMs: DEFAULT_ERROR_BACKOFF.baseDelayMs,
      maxDelayMs: DEFAULT_ERROR_BACKOFF.maxDelayMs,
      ...opts,
    });
    const notifyEvery = Math.max(1, opts.notifyEvery ?? DEFAULT_ERROR_BACKOFF.notifyEvery);

    // lastError 會進 ledger 供診斷；agent 的錯誤訊息可能很長，截短避免灌爆 DB 欄位
    // SDK 給的語意碼與 HTTP 狀態碼一併留痕：人看 ledger 就知道是 429 限流還是 529 過載，
    // 不必回頭翻 log（先前只留一句「agent 執行錯誤」，等於什麼都沒說）
    const why = [
      r?.sdkError ? `sdk=${r.sdkError}` : '',
      r?.httpStatus !== undefined ? `status=${r.httpStatus}` : '',
      r?.sdkRetries ? `sdk已重試${r.sdkRetries}次` : '',
    ].filter(Boolean).join(' ');
    ledger.updateTaskState(detail.id, 'in_progress', {
      lastError: `agent 執行錯誤${why ? `（${why}）` : ''}：${truncate(lastText, 300) || '（無訊息）'}`,
      incAttempts: true,
    });

    // 每輪只發一則事件：未達門檻是例行提示，達門檻（含倍數）換成升級措辭並 @ 得到人。
    const escalate = consecutive % notifyEvery === 0;
    const text = escalate
      ? `agent 執行錯誤：已連續 ${consecutive} 次失敗，${delayMs}ms 後仍會重試（不中止、不設次數上限）。` +
        `\n若持續發生，請檢查 Claude 認證/額度或 SDK 狀態。\n最後訊息：${lastText || '（無）'}`
      : `agent 執行錯誤，${delayMs}ms 後重試（連續第 ${consecutive} 次）`;
    this.say(threadTs, { type: 'problem', detail: text }, detail);
    log[escalate ? 'error' : 'warn']({ taskId: detail.id, consecutive, delayMs }, 'agent 執行錯誤，退避後重試');

    await (this.deps.sleep ?? realSleep)(delayMs);
  }

  /**
   * 獨立 reviewer 審查（DESIGN §5）。三個不阻塞流程的出口：
   * 未注入 reviewer / reviewer 自身回 skipped（無金鑰、diff 取不到、回應無法解析）/ 呼叫直接拋錯。
   * 只有明確 fail 才算否決；且累計否決達上限時放行，交 PR review 由人把關（防活鎖）。
   */
  private async review(
    detail: TaskDetail,
    docs: LoadedDoc[],
    cwd: string,
    threadTs: string | undefined,
    rejectionsSoFar: number,
    /** 與 DoD diff 關卡同一枚基準（任務開始時的 HEAD sha）。undefined ＝ 取不到，reviewer 會 skip。 */
    baseRef: string | undefined,
    /** 所屬群組——審查 session 要以群為單位共用。 */
    groupId: string | undefined,
  ): Promise<
    | { rejected: false }
    | { rejected: true; report: GateReport }
    /** 規格本身有問題 → **不回灌給 coder**，交人裁決（見 ReviewVerdict 的 spec_problem）。 */
    | { specProblem: { problem: string; conflicting: string[] }; report: GateReport }
  > {
    const { reviewer, notifier, log } = this.deps;
    if (!reviewer) return { rejected: false };

    let outcome: ReviewOutcome;
    try {
      // 審查也可能跑好幾分鐘，同樣要讓卡片看得出來
      void Promise.resolve(this.deps.notifier.updateTaskCard?.(detail.id, 'reviewing')).catch(() => {});
      // 把人已經拍板的決定一起給 reviewer。少了它，規格寫「沒有定論」的地方
      // 會被重新提出來退回——而那個問題明明已經有答案了（實跑撞到，白費一輪）。
      // 群內共用一條**審查**的 session（與寫程式那條完全隔離）。
      // 沒有它，審查者審第二個任務時根本不知道第一個任務存在——
      // 第二個破壞了第一個時它不可能發現。
      const reviewResume = groupId ? this.deps.ledger.latestGroupSession(groupId, 'reviewer')?.sessionId : undefined;
      outcome = await reviewer.check(detail, docs, cwd, {
        baseRef,
        decisions: this.settledDecisions(detail.id),
        ...(reviewResume ? { resumeSessionId: reviewResume } : {}),
        ...(groupId ? { groupId } : {}),
      });
    } catch (e) {
      // reviewer 掛掉不能拖垮任務：DoD 已綠，退化成「沒有 reviewer」的既有行為
      log.warn({ taskId: detail.id, err: e instanceof Error ? e.message : String(e) }, 'reviewer 呼叫失敗，略過審查');
      return { rejected: false };
    }
    if (outcome.ok) return { rejected: false };

    const max = this.deps.maxReviewRejections ?? DEFAULT_MAX_REVIEW_REJECTIONS;
    const report = outcome.asGateReport();
    if (rejectionsSoFar >= max) {
      // 已經回灌 max 次仍被否決 → 上限。DoD 這些機器可判定的關卡都綠了，reviewer 卻還在挑 ——
      // 可能是它挑不完、也可能是 coder 真的補不上。無論哪種都看不到收斂跡象，改交人審。
      const why = report.checks.find((c) => !c.ok)?.detail ?? '（未提供理由）';
      log.warn({ taskId: detail.id, rejections: rejectionsSoFar, max }, 'reviewer 否決達上限，放行交 PR review 人工把關');
      notifier.event(
        threadTs,
        { type: 'problem', detail: `reviewer 已否決 ${max} 次仍未收斂，放行交人工 review 把關：\n${why}` },
        detail,
      );
      return { rejected: false };
    }

    // **規格問題不回灌。** 它的成因不在 coder 手上（幾條要求互斥、規格被覆寫、
    // 要改的檔案它碰不到），退回去只會讓它再送一次、再被退一次——實跑那四輪就是這樣。
    if (outcome.verdict.status === 'spec_problem') {
      const v = outcome.verdict;
      log.warn({ taskId: detail.id, conflicting: v.conflicting }, 'reviewer 判定「規格本身有問題」→ 交人裁決，不回灌');
      return { specProblem: { problem: v.problem, conflicting: v.conflicting }, report };
    }

    // 理由要留得下來：先前只記了「rejections: 1」這個數字，退回原因**哪裡都沒有**——
    // log 沒有、task_iterations 沒有、events 也沒有。事後想知道 agent 為什麼被退回、
    // 或判斷它是在合理迭代還是鬼打牆，完全無從查起。
    const why = report.checks.filter((c) => !c.ok).map((c) => c.detail).join('\n');
    log.info(
      { taskId: detail.id, rejections: rejectionsSoFar + 1, why: why.slice(0, 400) },
      'reviewer 判定不合格，回灌具體理由續做',
    );
    this.deps.ledger.logEvent('task', detail.id, 'review_rejected', `第 ${rejectionsSoFar + 1} 次退回：\n${why}`);
    this.say(threadTs, { type: 'problem', detail: `reviewer 第 ${rejectionsSoFar + 1} 次退回：\n${why}` }, detail);
    return { rejected: true, report };
  }
}

/** 有失敗關卡才值得回灌；否則回 undefined（不要餵一份沒有內容的「失敗」給 agent）。 */
function actionableFeedback(report: GateReport): GateReport | undefined {
  return report.checks.some((c) => !c.ok) ? report : undefined;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

function defaultFixReport(task: TaskDetail, resultText: string): string {
  return [
    `## 修復報告：${task.title}`,
    '',
    resultText || '（agent 未提供總結）',
  ].join('\n');
}
