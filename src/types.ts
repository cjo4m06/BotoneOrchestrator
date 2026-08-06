// 共用型別 — 對映 DESIGN.md §11/§12。此檔是契約來源，改行為前先改 DESIGN。

// ── 領域狀態 ──
export type TaskState =
  | 'discovered' | 'queued' | 'blocked'
  | 'in_progress' | 'verifying' | 'done';

export type GroupState =
  | 'forming' | 'ready' | 'pr_open' | 'in_review'
  | 'changes_requested' | 'merge_guard' | 'merged' | 'failed';

export type BlockReason = 'deps' | 'needs_clarification' | 'needs_human';

// 開放字串聯集：常見類別給提示，仍允許 MCP 傳其他值
export type TaskCategory = 'bug' | 'dev' | 'design' | 'improvement' | (string & {});

export type DocType = 'prd' | 'spec' | 'issue';

// ── 核心實體（ledger） ──
export interface Task {
  id: string;
  payloadHash: string;          // 去重 key = id + payloadHash
  repo: string;                 // "owner/name"
  category: TaskCategory;
  title: string;
  description: string;
  dependencies: string[];       // MCP 宣告 → 只當順序提示
  docRefs: string[];            // "path#section"
  state: TaskState;
  block?: { reason: BlockReason; detail?: string };
  groupId?: string;
  slackThreadTs?: string;
  attempts: number;
  lastError?: string;
  /**
   * 任務在 MCP 端最後一次有動作的時間（createdAt/updatedAt 取大者，毫秒）。
   * 靜置期（quiet period）用它判斷「這個專案的任務板還在被編輯嗎」；
   * MCP 沒給時間戳就是 undefined，退回用 ledger 的發現時間 createdAt。
   */
  sourceUpdatedAt?: number;
  /**
   * 本任務**首次認領**時的 HEAD——DoD「diff 非空」關卡的基準。
   *
   * **first-write-wins，永不重算。** 一個任務會被重跑（retry、澄清答覆後續做、
   * 重啟對帳重排），而 agent 上一輪很可能已經自己 commit 了；每輪重抓 HEAD 的話，
   * 第二輪的基準就是「含它自己上一輪產出的那個 commit」→ diff 為空 → 判「本輪無變更」。
   * 實跑撞到：agent 說「實作已完整存在於本分支 HEAD（為本任務前一輪產出），
   * 但 no-changes 關卡以『本輪起始 HEAD』為基準，因此判定本輪無變更」。
   */
  taskStartSha?: string;
  /** 基準是在哪條分支上抓的（沿用前要比對，見 task_start_branch 的說明）。 */
  taskStartBranch?: string;
  /**
   * 這個任務**累計**用過哪些工具幾次。協定一致性檢查唯一的資料源。
   * 累計而不是每輪——agent 會 resume session，按輪算會誤報。
   */
  toolCalls?: Record<string, number>;
  createdAt: number;
  updatedAt: number;
}

export interface Group {
  id: string;
  repo: string;
  branch: string;               // 一群 = 一分支 = 一 PR
  taskIds: string[];            // 已依真實排序排好
  footprint: string[];          // 檔案足跡（並行安全判斷）
  /**
   * 這個群要等哪些群結束才能開跑（規劃 agent 排出來的階段順序）。
   * 與 footprint 互補：足跡擋的是「同時動到同一個檔案」，這個擋的是
   * 「雖然檔案不同，但先後有意義」（依賴、或規劃者判斷很可能會撞）。
   */
  afterGroups: string[];
  /**
   * 這一群「從哪裡開工」的 base commit（40 位 sha）。**first-write-wins，永不重算。**
   *
   * 與 `check_runs.verified_base_sha` 語意**相反**，命名刻意分家：
   * 這個是「我們從哪裡分岔出來」，那個是「這次驗證對著哪一顆 base」（每次重算）。
   * 後者是唯一擋「人在 GitHub 上自己按合併之後 base 就變了」的防線——
   * 一旦有人把它寫進這個永不重算的欄位，那條防線就變成自己跟自己比。
   */
  baseSha?: string;
  /**
   * 規劃 agent 說明「為什麼這幾個任務是一組」。
   *
   * 先前只寫進 log 就丟掉了——而規劃是靠讀完整個 repo 得出這個判斷的（實測 13 分鐘）。
   * 存起來之後可以當寫程式 agent 的起手線索，讓那次調查被用兩次而不是一次。
   */
  rationale: string;
  state: GroupState;
  prUrl?: string;
  prNumber?: number;
  createdAt: number;
  updatedAt: number;
}


// ── MCP 契約（handler__* 的型別化包裝） ──
export interface RepoInfo { repo: string; owner: string; name: string; branch?: string; }
export interface TaskBrief {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  repo: string;
  assigneeId?: string;
  /** MCP 端的建立時間（毫秒）。用於靜置期判斷，MCP 沒給就沒有。 */
  createdAt?: number;
  /** MCP 端的最後更新時間（毫秒）。 */
  updatedAt?: number;
}
export interface TaskDetail extends TaskBrief {
  description: string;
  dependencies: string[];
  docRefs: string[];
  category: TaskCategory;
}
export interface DocHit { docType: DocType; fileName: string; section?: string; score: number; snippet: string; }
export type McpOut<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'transient' | 'permanent' | 'signal'; detail: string };

// ── Planner / Dispatcher ──
export interface PlannedGroup {
  repo: string;
  taskIds: string[];
  footprint: string[];
  rationale: string;
  /** 執行階段（0 起算）。同階段可並行，階段之間依序。未規劃時一律 0。 */
  stageIndex: number;
  /**
   * 要等哪些**已經存在**的群組進 base（真實群組 id）。
   * 跨批次依賴用：階段只排得了同一次規劃裡的群組，排不到上一批還沒合併的東西。
   */
  afterExisting?: string[];
}
export interface ScheduleEdge { fromGroup: string; toGroup: string; reason: 'dep' | 'file-overlap'; }
export interface PlanResult { groups: PlannedGroup[]; schedule: ScheduleEdge[]; }

// ── Worker / Verifier / Progress ──
export interface WorkerCtx { worktree: string; branch: string; threadTs?: string; }
export interface VerifyCtx { cwd: string; task: TaskDetail; }
export interface CheckResult {
  name: string;
  ok: boolean;
  /**
   * 給人／agent 看的一句話。
   *
   * **紅燈時這裡不放機器輸出。** 程式跑了指令、拿到非 0，它知道的就只有這兩件事；
   * 「哪裡壞了」要看輸出才知道，而看輸出是 agent 的事——它有 Bash、在同一個 cwd、
   * 想跑幾次、想只跑一個檔案都可以。程式把輸出貼進 prompt 只會做到三件壞事：
   * 灌爆 context、把真正的錯誤埋在進度條裡、而且截斷之後 agent 連「被砍掉什麼」都不知道。
   *
   * 全文照樣完整落在 check_runs（含 output_path），那是給人事後查的。
   */
  detail: string;
  /** 實際跑的指令字串。agent 要自己重跑就靠它。 */
  command?: string;
  /** 指令的結束碼。undefined ＝ 根本沒跑起來（與「跑了但失敗」是不同的事）。 */
  exitCode?: number;
  failingIds?: string[];
}
export interface GateReport {
  green: boolean;
  checks: CheckResult[];
  screenshots?: string[];
}
export interface GroupOutcome { groupId: string; ok: boolean; prUrl?: string; error?: string; }

// ── Clarification / Slack ──
export interface ClarificationOption { id: string; label: string; recommended?: boolean; }
export interface ClarificationRequest { question: string; options: ClarificationOption[]; recommendedDefault?: string; rationale: string; }
export interface ClarificationAnswer {
  taskId: string;
  threadTs: string;
  optionId?: string;
  freeText?: string;
  /**
   * 這個答覆適用到哪。`'always'` ＝ 以後這個 repo 的任務都適用（掛到 repo 上，不是這張卡）。
   * 省略 ＝ 只適用這張卡。
   *
   * 存在的理由：實跑撞到同一個成因在 14 小時內害了兩個任務——第一次的答案
   * 只存在於第一張卡的事件裡，第二張卡看不到，於是重問一次、重卡一次。
   */
  scope?: 'task' | 'always';
}
export type LifecycleEvent =
  | { type: 'claimed' }
  | { type: 'docs_read'; refs: string[] }
  | { type: 'iterating'; round: number }
  | { type: 'problem'; detail: string }
  | { type: 'pr_open'; url: string }
  | { type: 'in_review' }
  | { type: 'changes_requested'; count: number }
  | { type: 'merged' }
  | { type: 'failed'; detail: string };
export type ControlCommand =
  | { type: 'pause'; taskId: string }
  | { type: 'abort'; taskId: string }
  | { type: 'retry'; taskId: string }
  | { type: 'use_default'; taskId: string };

// ── PR / Review / Merge ──
export interface PullRequest { url: string; number: number; }
export interface DiffStat { files: string[]; additions: number; deletions: number; }
export type ReviewEvent =
  | { type: 'changes_requested'; group: string; comments: string[] }
  | { type: 'approved'; group: string };
export type MergeVerdict =
  | {
      ok: true;
      /**
       * 守衛實際驗證時，base 停在哪一個 commit。
       *
       * 合併之前要再讀一次比對：不一樣就代表 base 在守衛跑完之後被動過，
       * 那麼「rebase 到最新 base 重跑通過」這個保證對現在的 base 已經不成立。
       * 同 repo 的合併有鎖序列化，所以我們自己不會製造這種情況——
       * 這一項擋的是**鎖看不到的合併**：人在 GitHub 上自己按、或別的工具合併。
       * 取不到時為 undefined（例如沒有 remote 的本地 repo），呼叫端就不做這個比對。
       */
      baseSha?: string;
    }
  | {
      ok: false;
      // precondition_failed：守衛的前置條件不成立（如分支不存在、checkout 失敗）。
      // 必須與其他 reason 區分——它代表「這次根本沒驗到」，不可當成驗證通過。
      /**
       * 合併守衛的判決理由。
       *
       * **attempt() 只產得出前三個**；`post_merge_red` 只有 postMergeCheck 會回
       * （daemon 沒有接線，見 MergeGuardLike 的說明），`tests_red` 全庫沒有產生端。
       * 保留是為了不動既有的持久化資料，但**不要拿它們寫判斷式**——
       * group-runner 的人工放行就是這樣壞掉的：白名單只認這兩個，於是永遠不成立。
       */
      reason: 'precondition_failed' | 'code_conflict' | 'semantic_drift' | 'tests_red' | 'post_merge_red';
      detail: string;
      /**
       * 衝突檔案清單。**來自 `git diff --name-only --diff-filter=U`（機器格式）**，
       * 不是從 git 印給人看的訊息用正則撈的——那樣 12 個檔衝突時會掉 5 個，
       * 而下游還是用肯定句對 agent 說「衝突檔案：…」。
       */
      conflicts?: string[];
    };
