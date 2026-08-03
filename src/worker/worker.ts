import { computeBackoffDelay, realSleep, type BackoffOptions } from '../core/retry.js';
import { changedSince, gitHeadRef } from './verifier.js';
import { markHumanReplyConsumed, pendingHumanReply, settledDecisions, type HumanReply } from './human-reply.js';
import { cardStatusOf } from '../core/card-status.js';
import type { Ledger } from '../store/ledger.js';
import type { Logger } from '../observability/logger.js';
import type { AgentLike, McpTaskClient, Notifier, ReviewerLike, TaskCardProgress, VerifierLike } from '../contracts.js';
import type { AgentErrorKind, ClarificationCapture, IterateResult, LoadedDoc, NoChangeCapture, NoChangeCategory, SdkErrorCode } from './agent-runtime.js';
import type { ProgressMonitor } from './progress.js';
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
  progress: ProgressMonitor;
  ledger: Ledger;
  notifier: Notifier;
  /** 工作區變更指紋（無進展偵測用）。預設 git/status.gitDiffHash，可注入假件。 */
  diffHash: (cwd: string) => Promise<string>;
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
    const { mcp, agent, verifier, progress, ledger, notifier, diffHash, log } = this.deps;

    // 1) 認領（MCP 檢查依賴/指派；signal=依賴未到 → 標 blocked）
    const claim = await mcp.startTask(task.id);
    if (!claim.ok) {
      if (claim.kind === 'signal') return this.handleDepsBlocked(task, claim.detail, threadTs);
      // permanent/transient：重試無用或已重試耗盡。留下稽核軌跡，讓人查得到「為什麼這群停在這」
      ledger.logEvent('task', task.id, 'claim_failed', `${claim.kind}：${claim.detail}`);
      log.error({ taskId: task.id, kind: claim.kind, detail: claim.detail }, '認領失敗且非依賴問題，交由群組停下來處理');
      return { status: 'error', detail: claim.detail };
    }
    const detail = claim.value;
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
    // 真的過期了 iterate 會自己降級開新的（isResumeFailure），不會讓這一輪報銷。
    let session = this.deps.ledger.latestAgentSession(task.id)?.sessionId;
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
      this.say(threadTs, { type: 'iterating', round }, detail);

      input.onPhase?.(`第 ${round} 輪：agent 寫程式中`);
      const r = await agent.iterate({ cwd, task: detail, docs, feedback, resumeSessionId: session, ...(gateConfig.diff ? { baseRef: gateConfig.diff.baseRef } : {}), ...(input.signal ? { signal: input.signal } : {}), ...(answer ? { answer } : {}) });
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

      // 3a) agent 提出不可逆歧義 → park（M4 接 Slack 等答覆）
      if (r.askedClarification) {
        // 卡片要立刻標成「等你回覆」——否則人看不出這張卡在等自己
        void Promise.resolve(notifier.updateTaskCard?.(task.id, 'awaiting_reply')).catch(() => {});
        ledger.setBlock(task.id, 'needs_clarification', r.askedClarification.question);
        // 問題也寫成事件：人回覆後 clearBlock 會抹掉 block_detail，
        // 少了這筆，續跑時就只剩答案、沒有問題，agent 讀到的會是沒頭沒尾的一句話。
        ledger.logEvent('task', task.id, 'clarification_asked', r.askedClarification.question);
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
      // 帶 task 提示：視覺關卡據此判斷要不要驗（category）與截圖歸檔位置
      const gate = await verifier.check({
        cwd,
        config: gateConfig,
          ...(input.signal ? { signal: input.signal } : {}),
        task: {
          id: detail.id,
          category: detail.category,
          title: detail.title,
          description: detail.description,
          ...(input.baseRef ? { baseRef: input.baseRef } : {}),
        },
      });

      // 3d) DoD 綠燈才輪到獨立 reviewer 對規格審查（§5）。
      //     結果覆寫成「本輪有效關卡報告」：reviewer 否決 → 本輪其實不算綠。
      let effective = gate;
      if (gate.green) {
        input.onPhase?.(`第 ${round} 輪：關卡綠燈，reviewer 對規格審查中`);
        // baseRef 一定要傳，而且**不要 `?? 'HEAD'`**——讓 undefined 一路傳到 reviewer，
        // 由它決定「沒有基準就不審」。退回 HEAD 正是這個 bug 的源頭。
        const review = await this.review(detail, docs, cwd, threadTs, reviewRejections, gateConfig.diff?.baseRef);
        if (review.rejected) {
          reviewRejections += 1;
          effective = review.report;
        }
      }

      // 3e) 無進展偵測用「有效報告」的簽章：reviewer 反覆挑同一批問題時簽章相同，
      //     一樣會被判卡牆並通知（§D11），不會因為 DoD 綠燈就漏掉這種空轉。
      // 這一輪的結論寫進卡片：綠燈就說綠燈，紅燈就列出是哪些關卡不過。
      // 沒有這行，人只看得到狀態在「執行中／驗證中」之間跳，看不出它到底在修什麼。
      lastOutcome = effective.green
        ? '所有關卡通過'
        : effective.checks.filter((c) => !c.ok).map((c) => c.name).join('、') || '未通過';

      const stall = progress.record(task.id, round, effective, await diffHash(cwd));
      if (stall.stalled) this.say(threadTs, { type: 'stalled', gate: effective }, detail);

      if (effective.green) {
        // 4) 完成 → complete_task（bug 帶 summary，其餘不帶）
        const summary =
          detail.category === 'bug'
            ? (this.deps.buildFixReport ?? defaultFixReport)(detail, r.resultText)
            : undefined;
        const done = await mcp.completeTask(task.id, summary ? { summary } : undefined);
        if (!done.ok) {
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
    }
  }

  /**
   * 撞到輪數上限時的出口（缺陷 2）：park 交人，保留一切現場。
   *
   * 用 `needs_human` 而非 failed，是因為 failed 是終態、沒有任何路徑會再派工（等於任務遺失）；
   * needs_human 走的是 GroupRunner 的可恢復路徑（群組 park、worktree 保留），
   * 人排除障礙後由 requeue 階段轉回 ready 續做。
   */
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
  private async withDiffGate(config: VerifierConfig, cwd: string, taskId: string): Promise<VerifierConfig> {
    const { log } = this.deps;
    const head = this.deps.headRef ?? gitHeadRef;
    let baseRef: string | undefined;
    try {
      baseRef = await head(cwd);
    } catch (e) {
      log.warn({ cwd, err: e instanceof Error ? e.message : String(e) }, '取 HEAD 失敗');
    }

    if (!baseRef) {
      log.error(
        { taskId, cwd },
        '⚠️ 無法取得工作區 HEAD → 本任務停用「diff 非空」關卡（agent 沒改東西也可能被判完成）；'
          + 'reviewer 會 skip（沒有基準不審），Stop hook 退回 porcelain（agent 自行 commit 後會被誤判成沒做事）',
      );
      return config;
    }
    log.debug({ taskId, baseRef }, 'diff 非空關卡基準 = 任務開始時的 HEAD');
    return { ...config, diff: { baseRef } };
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
  ): Promise<{ rejected: false } | { rejected: true; report: GateReport }> {
    const { reviewer, notifier, log } = this.deps;
    if (!reviewer) return { rejected: false };

    let outcome: ReviewOutcome;
    try {
      // 審查也可能跑好幾分鐘，同樣要讓卡片看得出來
      void Promise.resolve(this.deps.notifier.updateTaskCard?.(detail.id, 'reviewing')).catch(() => {});
      // 把人已經拍板的決定一起給 reviewer。少了它，規格寫「沒有定論」的地方
      // 會被重新提出來退回——而那個問題明明已經有答案了（實跑撞到，白費一輪）。
      outcome = await reviewer.check(detail, docs, cwd, { baseRef, decisions: this.settledDecisions(detail.id) });
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
