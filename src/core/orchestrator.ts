
import { ReviewFeedbackStore } from '../pr/review-watcher.js';
import {
  DISPATCHABLE_GROUP_STATE,
  GROUP_DEPS_BLOCKED_EVENT,
  GROUP_PARKED_EVENT,
  PARKED_GROUP_STATE,
  shouldRequeueGroup,
} from './group-runner.js';
import { DEFAULT_QUIET_MINUTES, splitByQuietPeriod } from './quiet-period.js';
import { MERGE_CREDENTIAL_EVENT, MERGE_CREDENTIAL_CLEARED_EVENT } from './merge-credential.js';
import { collectPending, type PendingItem } from './pending.js';

/** 待處理事項提醒的節流事件（寫在 ledger ⇒ 重啟不會每次啟動都吵一次）。 */
const PENDING_REMINDER_EVENT = 'pending_reminder';
import { describeUsage, periodKey, type BudgetVerdict, type PeriodUsage } from './budget.js';
import { tryWithRepoLock } from './repo-lock.js';
import type { Poller } from './poller.js';
import type { Planner } from './planner.js';
import type { Ledger } from '../store/ledger.js';
import type { Logger } from '../observability/logger.js';
import type { Notifier } from '../contracts.js';
import type { VerifierConfig } from '../worker/verifier.js';
import type { DiffStat, Group, GroupState, LifecycleEvent, MergeVerdict, Task, TaskDetail, PlannedGroup } from '../types.js';

/**
 * ── 群組狀態語意：誰寫、誰讀（本檔是「調度器消費哪些狀態」的權威定義） ──────────
 *
 * DESIGN §11 只列了 GroupState 的名字，沒說誰負責推進。實務上 `merge_guard` 被兩處
 * 寫入且語意不同，接上排程器前必須先分清楚，否則會把「正在跑守衛」的群當成
 * 「人已核准待合併」而**重複合併**（合併是不可逆的外部動作）。
 *
 * 「誰負責推進」每個非終態都必須有答案，沒有答案的狀態就是**黑洞**（群組永遠不會再被
 * 碰到 ⇒ 群內任務等同遺失）。下表是 GroupState 全集的逐項盤點，改狀態機時請一併維護：
 *
 *   forming            GroupRunner 正在跑群內任務（暫態；寫入者持有 dispatcher slot）
 *                      推進者：GroupRunner。崩潰殘留由 Reconciler（開機）＋ requeue 規則 B
 *                      （群內出現 queued/discovered 任務）撿回。
 *   ready              可派工 —— Dispatcher 的唯一輸入（推進者：本檔 tick 步驟 4）
 *   pr_open/in_review  等 GitHub 審查 —— 推進者：ReviewWatcher（本檔 tick 步驟 5 消費它的
 *                      事件）。**ReviewWatcher 未注入時這兩個狀態沒有推進者**：這是刻意的
 *                      降級（沒有 gh／不開 PR 的使用者不該被強迫接線），但會 warnOnce 點名
 *                      卡住的群，避免「靜默遺失」被誤認為正常。人工核准仍可救（見下）。
 *   changes_requested  **三種語意共用同一個狀態**（見 group-runner 的 PARKED_GROUP_STATE）：
 *                        (a) 審查／守衛／人工退回要求修改 → 帶 feedback 回灌重新派工
 *                        (b) park：等人回答澄清或解除 needs_human（群內有 blocked 任務）
 *                        (c) park：等上游依賴完成（group-runner 認領被 MCP 以 signal 擋下）
 *                      推進者都是 requeue 規則 A：(a) 看 feedback，(b) 看 shouldRequeueGroup
 *                      （人回覆後任務被 clearBlock 回 queued ⇒ 可以續做），
 *                      (c) 看 group_deps_blocked 事件 + 指數退避（等的是任務不是人，
 *                      沒有人會來回覆，必須由本檔自動推進——但絕不能每輪推）。
 *   merge_guard        **兩種語意，靠 dispatcher.isRunning 區分**：
 *                        (a) 暫態：GroupRunner 就地跑 Merge Guard（群仍在 running）
 *                            → 本檔**絕不碰**，那是別人正在跑的中間狀態
 *                        (b) 待合併：已取得核准，等調度器把關後合併（群不在 running）
 *                            → 由 processMergeQueue 消費
 *   merged             終態
 *   failed             終態，但**可由人救回**：requeue 規則 B 會在群內出現被明確要求重跑的
 *                      任務（retry 指令／澄清答覆／對帳重排）時把它轉回 ready。
 *
 * 而且 (b) 還不夠：「狀態是 merge_guard」**不等於**「有人核准過」——daemon 在 (a) 中途
 * 崩潰也會留下 merge_guard。真正的核准憑證是本檔的 `approvals`（由 GitHub approved 事件
 * 或 Slack 明確裁決寫入）。**沒有憑證一律不合併**，只會再問一次人。
 */

/** ReviewWatcher 回報的事件（結構相容 types.ts 的 ReviewEvent，另可帶核准者）。 */
export type ReviewSignal =
  | { type: 'approved'; group: string; approvedBy?: string; prNumber?: number }
  | { type: 'changes_requested'; group: string; comments: string[] };

/** ReviewWatcher 的最小介面（可選能力，未注入就不監看 PR 審查）。 */
export interface ReviewWatcherLike {
  poll(): Promise<ReviewSignal[]>;
}

/** Dispatcher 的最小介面。`isRunning` 是 merge_guard 兩種語意的判別依據，不可省。 */
export interface DispatcherLike {
  dispatch(ready: Group[], signal?: AbortSignal): number;
  isRunning(id: string): boolean;
}

// ── 合併管線（預設不接線 ⇒ 預設不會有任何合併動作） ─────────────────────

/** Merge Guard 的最小介面（DESIGN §9a-b）。 */
export interface MergeGuardLike {
  attempt(input: {
    repoPath: string;
    branch: string;
    base: string;
    verifierConfig: VerifierConfig;
    taskTitles?: string[];
    /** 任務資訊（含 baseRef）。少了它，這一關的介面判斷者沒有 git 可查。 */
    task?: { id?: string; category?: string; title?: string; description?: string; baseRef?: string };
  }): Promise<MergeVerdict>;
}

/** 依階段序號分組，並保證階段由小到大（建群順序決定 afterGroups 的正確性）。 */
export function groupByStage(groups: PlannedGroup[]): [number, PlannedGroup[]][] {
  const byStage = new Map<number, PlannedGroup[]>();
  for (const g of groups) byStage.set(g.stageIndex, [...(byStage.get(g.stageIndex) ?? []), g]);
  return [...byStage.entries()].sort((a, b) => a[0] - b[0]);
}

/** PR 合併的最小介面（PrManager 結構上即滿足）。 */
export interface PrMergeLike {
  merge(input: {
    repo: string;
    prNumber: number;
    approvedBy: string;
    deleteBranch?: boolean;
    cwd?: string;
  }): Promise<{ ok: boolean; detail: string }>;
}

/** 合併時需要的專案資訊（GroupRunner 的 ProjectRuntime 結構上即滿足）。 */
export interface MergeProject {
  /** 執行守衛與讀 diff 的工作目錄。**注意會 checkout 群組分支**，建議指向專用 worktree。 */
  repoPath: string;
  baseBranch: string;
  verifierConfig: VerifierConfig;
  /** 取最新 base 的 remote 名稱。未給 → 'origin'。 */
  remote?: string;
}

/**
 * 合併管線的相依。**整包是可選的**——沒注入就完全不會發生合併（安全預設關閉），
 * 已核准的群組只會被記錄與通知，不會有任何外部副作用。
 */
export interface MergePipelineDeps {
  resolveProject(repo: string): MergeProject | undefined;
  guard: MergeGuardLike;
  pr: PrMergeLike;
  /**
   * 合併前把最新 base 抓下來。**強烈建議提供**：不抓最新 base 的話，守衛驗的是
   * 過期的 base，等於沒驗到「這段時間別人合進去的東西」造成的語意飄移。
   */
  fetchBase?: (repoPath: string, base: string) => Promise<void>;
  /**
   * 把合併工作區切回 base，釋放群組分支。未注入就不做——
   * 代價是那條分支被占住，群組要重做時建不了 worktree（見 releaseMergeWorktree）。
   */
  releaseBranch?: (repoPath: string, base: string) => Promise<void>;
  /**
   * 讀 remote 上 base 現在的 commit。用來在合併前確認「守衛驗的那個 base」還是現在這個。
   * 未注入就不做這個比對（同 repo 的鎖仍然保證我們自己不會插隊）。
   */
  currentBaseSha?: (repoPath: string, base: string, remote: string) => Promise<string | undefined>;
}

/** Slack 合併閘門（HumanGateway 結構上即滿足）。 */
export interface MergeApprovalGateway {
  askMergeApproval(
    threadTs: string | undefined,
    group: { groupId: string; branch: string; repo: string; taskTitles: string[]; prUrl?: string; reasons?: string[] },
  ): Promise<void>;
  /** 有的話就訂閱：人在 Slack 的核准/退回會成為本檔認可的合併憑證。 */
  onMergeDecision?(cb: (d: { groupId: string; approved: boolean; threadTs?: string; userId?: string }) => void): void;
}

/** 核准憑證。approvedBy 會原封不動傳進 PrManager.merge —— 它是稽核的唯一依據。 */
interface MergeApproval {
  approvedBy: string; // 'reviewer:<login>' | 'human:<userId>'
  source: 'github_review' | 'human';
}

export interface OrchestratorDeps {
  poller: Poller;
  planner: Planner;
  dispatcher: DispatcherLike;
  ledger: Ledger;
  log: Logger;
  /** 監看 GitHub PR 審查結果（DESIGN §3 步驟 7）。可選：未注入則跳過該階段。 */
  reviewWatcher?: ReviewWatcherLike;
  /**
   * 共用的審查意見暫存區。**必須與 GroupRunner 共用同一個實例**，
   * 否則 changes_requested 的群組不會被重新派工（見 requeue 階段的說明）。
   */
  feedback?: ReviewFeedbackStore;
  /** 合併管線。未注入 ⇒ 不會有任何合併動作（預設關閉）。 */
  merge?: MergePipelineDeps;
  /** Slack 合併閘門：政策要求人工核准時發問、並接收人的裁決。 */
  gateway?: MergeApprovalGateway;
  /** 群層生命週期通知（掛在群內第一個任務的 thread）。 */
  notifier?: Notifier;
  /**
   * 同一個群組最多被 requeue 幾次（**跨重啟**，計數落在 ledger 的 requeued 事件上）。
   * 防止「派回去 → 立刻失敗 → 再派回去」的空轉；達上限會交人處理（見 handOffToHuman）。預設 3。
   */
  maxRequeuePerGroup?: number;
  /**
   * 「等上游依賴」專用的重派上限。**刻意與 maxRequeuePerGroup 分開**：
   * 等上游是完全合法的長等待（上游可能正在等人回答澄清），拿「失敗重試」的小額度去砍它
   * 就是 D18 的誤殺——群組會在依賴其實還會完成的情況下被丟給人。預設 20，
   * 搭配指數退避（見 depsBackoff）約等於數小時後才驚動人。
   */
  maxDepsRequeuePerGroup?: number;
  /**
   * 等上游時的指數退避（跨 tick 生效）。第 1 次不等（維持原本「下一輪就重試」的手感），
   * 之後 baseMs × 2^(n-2)，上限 maxMs。未設 → baseMs 取一個輪詢週期、maxMs 15 分鐘。
   */
  depsBackoff?: { baseMs?: number; maxMs?: number };
  /**
   * 每個專案（repo）的靜置分鐘數：任務板要這麼久沒動作才開始分群。
   * 未注入或查不到 → DEFAULT_QUIET_MINUTES（15）。回 0 → 該專案關閉靜置期。
   */
  quietMinutesOf?: (repo: string) => number;
  /**
   * 每輪 tick 之前的同步點（把 DB 裡的設定套用到執行中的專案集合）。
   *
   * 為什麼不用「控制台改完直接回呼」：控制台可以是獨立行程（`npm run console`），
   * 那時它根本碰不到 daemon 的記憶體。每輪從 DB 對齊一次則兩種情形都成立，
   * 而且會自我修復——中間漏掉一次也只是晚一輪生效。
   * 沒變的專案在 registry 裡是 no-op，所以每輪跑的成本可以忽略。
   */
  beforeTick?: () => Promise<void>;
  /**
   * 花費上限檢查。回傳 ok=false 就不派新工作（進行中的不動——那些錢已經花了，
   * 砍掉只是把錢丟掉還留下半成品）。未注入 = 不限制。
   */
  budget?: () => BudgetVerdict;
  /**
   * 這個 repo 的專案現在可不可用（在 registry 裡）。
   * 停用中／編輯中／MCP 連不上時回 false → 該專案的群組暫不派工，狀態完全不動。
   */
  isProjectAvailable?: (repo: string) => boolean;
  /**
   * 待處理事項的提醒間隔（毫秒）。0／未給 = 不提醒。
   * 沒有它，錯過的那一則通知就等於那件事永遠沒有人會再提起。
   */
  pendingReminderMs?: number;
}

/**
 * 可被 AbortSignal 中止的 sleep。
 *
 * 為什麼不能用單純的 setTimeout：run() 每輪結束都要睡 intervalSec（預設 30 秒，使用者可調到
 * 幾百秒）。若 sleep 不理會 abort，收到 SIGTERM 後最久要等滿一整個週期才會退出，launchd
 * 等不到就補 SIGKILL——那會讓進行中的 worktree／PR 留下殘骸（比慢關機嚴重得多）。
 *
 * 兩邊都要清乾淨：timer 不清會讓程序在 abort 後仍被吊著；listener 不清會在同一個 signal 上
 * 每輪累積一個，長跑幾百輪就會噴 MaxListenersExceededWarning（也是貨真價實的記憶體洩漏）。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

const branchFor = (repo: string, groupId: string) => `orch/${repo.split('/').pop() ?? repo}/${groupId}`;

/** 這些狀態代表「工作被中斷」，群內若出現重新排隊的任務就該重新派工。 */
const REVIVABLE_GROUP_STATES: GroupState[] = ['forming', 'failed'];
/** 等 GitHub 審查的狀態：唯一的推進者是 ReviewWatcher，沒接就是黑洞（見檔頭語意表）。 */
const AWAITING_REVIEW_STATES: GroupState[] = ['pr_open', 'in_review'];
/** 任務處於這些狀態＝有人明確要求重跑（澄清已答覆 / retry 指令 / 對帳重排）。 */
const REVIVABLE_TASK_STATES = new Set<Task['state']>(['queued', 'discovered']);

// ── requeue 的計數與退避（都以 ledger 事件為準，daemon 重啟不歸零） ──

/** 每一次成功重派都寫這個事件；它同時是**跨重啟的計數器**（數事件筆數就是用掉幾次）。 */
const REQUEUE_EVENT = 'requeued';
/** 人明確要求重跑 → 重置預算的分界點（只數這個事件之後的 requeued）。 */
const REQUEUE_RESET_EVENT = 'requeue_budget_reset';

/** 撞到花費上限後，日誌每隔多久重述一次「還在上限，所以沒在動」。 */
const BUDGET_LOG_INTERVAL_MS = 30 * 60_000;
/** 撞到上限、已交人工處理（實跑證實：以前只有一行 warn，人完全不知道有東西卡住）。 */
const REQUEUE_EXHAUSTED_EVENT = 'requeue_exhausted';
/** 退避計時的稽核（人可以從 ledger 看出「為什麼這一輪沒派它」）。 */
const DEPS_BACKOFF_EVENT = 'deps_backoff';
/** requeued 事件的 deps 標記：兩種預算共用一個 kind，靠 detail 前綴分辨。 */
const DEPS_TAG = '[deps] ';

/** requeue 的來源分類：不同來源用不同預算（理由見 maxDepsRequeuePerGroup）。 */
type RequeueKind = 'deps' | 'general';

/**
 * 「人明確要求重跑」的任務事件（InboundRouter 寫入）。撞到上限之後，**只有這種訊號**
 * 能讓預算重新開始——否則人在 Slack 按了 retry 也不會有任何反應（等於靜默遺棄）。
 */
const HUMAN_RETRY_EVENTS = ['clarification_answer', 'control:retry'];



const DEFAULT_MAX_REQUEUE = 3;
const DEFAULT_MAX_DEPS_REQUEUE = 20;
const DEFAULT_DEPS_BACKOFF_MAX_MS = 15 * 60_000;

/** 等上游的退避狀態（記憶體；重啟後從第 1 次重來，但 ledger 的預算計數不會歸零）。 */
interface DepsWait {
  attempts: number;
  /** 已經算過退避的那一則 group_deps_blocked 事件（用來偵測「又被擋了一次」）。 */
  lastBlockedEventId: number;
  nextEligibleAt: number;
}

/**
 * 主控迴圈（DESIGN §3）。一輪 tick 依序：
 *   1. poll     → 新任務落地 discovered
 *   2. requeue  → 把「已被標記為可重新派工」的群組/任務轉回 ready（否則離開 ready 就是死路）
 *   3. plan     → discovered 分群建群
 *   4. dispatch → 派出 ready 群
 *   5. reviews  → 消費 GitHub 審查事件（approved / changes_requested）
 *   6. merge    → 已核准的群組：重跑 Merge Guard → 政策閘門 → 合併
 *
 * 順序有意義：requeue 在 dispatch 之前，重新派工的群同一輪就能被派出；
 * merge 在 reviews 之後，本輪剛核准的群同一輪就能進合併管線。
 */
export class Orchestrator {
  private readonly feedback: ReviewFeedbackStore;
  /** feedback 是否為外部共用實例——沒共用就不能把 changes_requested 派回去（沒人讀得到意見）。 */
  private readonly sharedFeedback: boolean;
  /** 群組 → 核准憑證。**合併的唯一依據**，只由 GitHub approved 事件或人工裁決寫入。 */
  private readonly approvals = new Map<string, MergeApproval>();
  /** 已經問過人的群組（避免每輪都往 Slack 貼同一則核准請求）。 */
  private readonly askedApproval = new Set<string>();
  /** 群組 → 已 requeue 次數（防空轉）。**只是 ledger 的快取**，首次使用時從事件回讀。 */
  private readonly requeueUsed = new Map<string, Record<RequeueKind, number>>();
  /** 群組 → 等上游的退避狀態（跨 tick 生效：退避期間連派都不派，不會重建 worktree）。 */
  private readonly depsWait = new Map<string, DepsWait>();
  /** 已警告過的 key（狀態機每輪都會掃到同一個群組，不節流會洗版）。 */
  private readonly warnedOnce = new Set<string>();

  /**
   * 「花費已達上限」這件事，每個週期只記一次事件、日誌隔一段時間才重述一次。
   *
   * 原本是每輪輪詢都寫一筆 budget_blocked ＋ 一行 WARN。15 秒一輪的話，
   * 撞到上限後的剩餘時間就是約 5760 筆一模一樣的紀錄——事件表是待辦清單與
   * 摩擦彙總在讀的地方，日誌是人判斷「它現在正不正常」的地方，
   * 兩邊被同一句話灌爆，等於把真正要看的東西藏起來。
   *
   * 但也不能只講一次就沉默：撞到上限之後系統本來就不會有任何動靜，
   * 日誌裡沒有理由的話，看起來就跟當掉一樣。所以事件記一次（可稽核的事實），
   * 日誌則每隔一段時間重述（讓 tail 的人隨時看得到「為什麼沒在動」）。
   */
  private readonly budgetBlockedPeriods = new Set<string>();

  private budgetLogAtMs = 0;

  constructor(private deps: OrchestratorDeps, private intervalSec: number | (() => number)) {
    this.feedback = deps.feedback ?? new ReviewFeedbackStore(deps.ledger);
    this.sharedFeedback = deps.feedback !== undefined;
    // 人在 Slack 的裁決是合法的核准來源；訂閱它，合併路徑才有憑證可用。
    deps.gateway?.onMergeDecision?.((d) => this.onMergeDecision(d));
  }

  /**
   * @param signal 中止訊號。一路傳到 agent 與 DoD 指令——
   *   先前只用來停主迴圈，正在跑的工作完全收不到（見 run 的說明）。
   */
  async tick(signal?: AbortSignal): Promise<void> {
    const { poller, planner, dispatcher, ledger, log } = this.deps;

    // 0) 設定同步（控制台改的東西在這裡生效）。失敗不能讓整輪停擺——
    //    同步不了頂多是沿用上一輪的專案清單，比整個 daemon 停下來好得多。
    if (this.deps.beforeTick) {
      try {
        await this.deps.beforeTick();
      } catch (e) {
        log.error({ err: e instanceof Error ? e.message : String(e) }, '設定同步失敗（沿用上一輪的專案清單）');
      }
    }

    // 1) Poll → 落地 discovered（去重）
    const fresh = await poller.pollOnce();
    if (fresh.length) log.info({ count: fresh.length }, 'tick：新任務');

    // 2) Requeue：把可重新派工的群組/任務轉回 ready（必須在 plan/dispatch 之前）
    this.requeue();

    // 3) Plan：把 discovered 任務分群 → 建群（ready）+ 任務轉 queued
    //    先過靜置期閘門：任務板還在被編輯的專案，這輪一律不分群（避免半套任務→半成品 PR）。
    const discovered = this.quietGate(ledger.listTasksByState('discovered'));
    if (discovered.length) {
      const plan = await planner.plan(discovered);
      // 依階段順序建群：階段 k 的群要等階段 k-1 全部結束（afterGroups）。
      // 只連相鄰階段就夠——k-1 自己也在等 k-2，遞移關係成立。
      //
      // **階段順序必須按 repo 各自算。** 規劃是每個 repo 分開做的，階段編號只在該 repo
      // 內部有意義；跨 repo 共用一份 previousStage 的話，A 專案的群會去等 B 專案的群。
      // 實跑撞到：demo2 的第二階段群組 afterGroups 裡混進了一個 Baolu 的群組 id——
      // 一個專案卡住就會拖死另一個，而且「只認 merged」之後那會是永久的。
      const previousStageOf = new Map<string, string[]>();
      for (const [stage, inStage] of groupByStage(plan.groups)) {
        const createdOf = new Map<string, string[]>();
        for (const pg of inStage) {
          const g = ledger.createGroup({
            repo: pg.repo,
            branch: '',
            taskIds: pg.taskIds,
            footprint: pg.footprint,
            // 同專案的前一階段 ＋ 跨批次要等的既有群組
            afterGroups: [...new Set([...(previousStageOf.get(pg.repo) ?? []), ...(pg.afterExisting ?? [])])],
          });
          if (!g.branch) ledger.upsertGroup({ ...g, branch: branchFor(pg.repo, g.id) }); // 補分支名（需 id）
          for (const tid of pg.taskIds) ledger.updateTaskState(tid, 'queued', { groupId: g.id });
          createdOf.set(pg.repo, [...(createdOf.get(pg.repo) ?? []), g.id]);
          log.info(
            { group: g.id, stage, tasks: pg.taskIds.length, files: pg.footprint.slice(0, 8), rationale: pg.rationale },
            '建群',
          );
        }
        // 這一階段沒有該 repo 的群時，維持上一次的值——階段編號可能跳號
        // （例如 repo A 有 stage 0/1/2，repo B 只有 stage 0/2），
        // 直接覆寫成空的話 B 的 stage 2 就不會等 B 的 stage 0。
        for (const [repo, ids] of createdOf) previousStageOf.set(repo, ids);
      }
    }

    // 4) Dispatch：派出 ready 群（併發 + 足跡序列化由 Dispatcher 控管）
    //    先看花費上限。超了就不派新的——但已經在跑的不動，那些錢已經花掉了。
    const ready = ledger
      .listGroupsByState(DISPATCHABLE_GROUP_STATE)
      .filter((g) => this.projectAvailable(g))
      .filter((g) => this.depsInBase(g));
    if (ready.length) {
      if (this.withinBudget(ready.length)) dispatcher.dispatch(ready, signal);
    }

    // 5) 監看 PR 審查結果並消費事件（DESIGN §3 步驟 7）
    await this.pollReviews();

    // 6) 已核准的群組 → Merge Guard → 政策閘門 → 合併（DESIGN §3 步驟 8）
    await this.processMergeQueue();

    // 7) 待處理事項的定期提醒（錯過的那一則通知不該讓事情永遠卡住）
    this.remindPending();
  }

  /**
   * 定期提醒「有事在等你」。
   *
   * 核准請求與澄清問題都是**發生當下推一次**。那一則沒被看到——Slack 剛好斷線、
   * daemon 在那一秒重啟、人當下沒注意——就再也沒有人會提起，群組安靜地卡在原地。
   * 實跑就撞到：政策要求人工核准的訊息在 Slack 尚未啟用時發出，之後群組停在
   * in_review 超過一小時，沒有任何地方會再講一次。
   *
   * 用**摘要**而不是逐項推播：一次一則、講清楚有幾件事，人才不會學會忽略它。
   * 間隔狀態寫在 ledger，所以重啟不會變成「每次啟動都吵一次」。
   */
  private remindPending(): void {
    const everyMs = this.deps.pendingReminderMs ?? 0;
    if (everyMs <= 0) return;

    const { ledger, notifier, log } = this.deps;
    if (!notifier) return;

    let items: PendingItem[];
    try {
      items = collectPending(ledger);
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, '待處理事項提醒：清單讀取失敗，本輪略過');
      return;
    }
    if (items.length === 0) return;

    const last = ledger.latestEvent('system', null, PENDING_REMINDER_EVENT);
    if (last && Date.now() - last.createdAt < everyMs) return;

    const lines = items.slice(0, 8).map((it) => `· ${it.id}　${it.title}（${it.kind}）`);
    if (items.length > lines.length) lines.push(`…另有 ${items.length - lines.length} 項`);
    const text = `有 ${items.length} 件事在等你處理：\n${lines.join('\n')}\n用 \`npm run ask\` 或控制台處理。`;

    ledger.logEvent('system', null, PENDING_REMINDER_EVENT, `${items.length} 項`);
    // 用系統層 API，不要硬塞一個假的 TaskDetail 給 event()——那會在 task.id 炸掉，
    // 而且 event 是 async，同步 try/catch 接不到，會變成 unhandled rejection 殺掉 daemon。
    void this.notify(() => notifier.notice?.(text), '待處理事項提醒');
    log.info({ count: items.length }, '已送出待處理事項提醒');
  }

  /**
   * 花費上限閘門。除了擋下派工，還負責兩種通知：
   *   · 越過警戒線 → 提早喊一聲（同一週期同一門檻只喊一次，否則每輪都吵）
   *   · 超過上限   → 明確告訴人「停了、什麼時候會自己恢復」
   * 去重鍵寫在 ledger events，所以**跨重啟**也不會重複通知。
   */
  /**
   * 這個群組的專案現在可不可用。
   *
   * 專案被停用、正在編輯、或它的 MCP 一時連不上時，registry 裡就沒有它。
   * 這時**不要派工**——派下去 GroupRunner 也只能立刻退回來，白跑一趟還洗版。
   * 每一種原因都會自己好，所以只是不派，群組狀態完全不動。
   *
   * 未注入 isProjectAvailable 就一律視為可用（測試與舊呼叫端不受影響）。
   */
  private projectAvailable(group: Group): boolean {
    const check = this.deps.isProjectAvailable;
    if (!check || check(group.repo)) return true;
    this.warnOnce(
      `noproj:${group.repo}`,
      { group: group.id, repo: group.repo },
      '專案目前不可用（停用中／編輯中／MCP 連不上），暫不派工——恢復後會自動繼續',
    );
    return false;
  }

  /**
   * 任務宣告的前置任務，成果是不是真的在 base 裡了。
   *
   * 為什麼不能只靠 MCP 的認領閘門：MCP 認定一個任務 done 的時機是 agent 呼叫
   * complete_task——那時 PR 才剛開、還沒合併。中間這段（等你審查的時間，可能好幾小時）
   * 前置任務在任務板上已經是「完成」，但它的程式碼**不在 main 裡**。
   * 這時放行下游，它就會在一個沒有前置成果的 base 上開工，做出建立在假設上的東西——
   * 而且它自己的 build/test 會全綠，沒有任何一道關卡擋得住。
   *
   * 這是 afterExisting（規劃 agent 判斷）之外的第二道防線：規劃時沒看出來的、
   * 或任務板事後才補上的依賴宣告，都由這裡接住。
   */
  private depsInBase(group: Group): boolean {
    const { ledger, log } = this.deps;
    const waiting: string[] = [];
    for (const taskId of group.taskIds) {
      for (const dep of ledger.getTask(taskId)?.dependencies ?? []) {
        // 同一群內部的先後由 GroupRunner 負責（同一個工作區依序做，成果直接看得到）
        if (group.taskIds.includes(dep)) continue;
        const depTask = ledger.getTask(dep);
        // 不在本調度器範圍內的前置任務：這裡判斷不了，交給 MCP 的認領閘門
        // （它會擋，擋久了會升級成 needs_human，見 worker 的 handleDepsBlocked）
        if (!depTask) continue;
        const depGroup = depTask.groupId ? ledger.getGroup(depTask.groupId) : undefined;
        if (depGroup?.state !== 'merged') waiting.push(dep);
      }
    }
    if (waiting.length === 0) return true;
    this.warnOnce(
      `depswait:${group.id}:${waiting.join(',')}`,
      { group: group.id, waitingFor: [...new Set(waiting)] },
      '前置任務的成果還沒進 base（PR 可能還開著等審查），這一群先不派',
    );
    return false;
  }

  private withinBudget(readyCount: number): boolean {
    const { ledger, log } = this.deps;
    if (!this.deps.budget) return true;

    let v: BudgetVerdict;
    try {
      v = this.deps.budget();
    } catch (e) {
      // 算不出預算不該讓整個系統停擺——那等於「監控壞掉就停產」
      log.warn({ err: e instanceof Error ? e.message : String(e) }, '花費上限計算失敗，本輪不擋');
      return true;
    }

    const now = Date.now();
    for (const u of v.warning) this.notifyBudgetOnce(`warn:${periodKey(u.period, now)}`, 'warn', u);
    for (const u of v.exceeded) this.notifyBudgetOnce(`stop:${periodKey(u.period, now)}`, 'stop', u);

    if (v.ok) return true;

    const key = v.exceeded.map((u) => periodKey(u.period, now)).join('|');
    if (!this.budgetBlockedPeriods.has(key)) {
      this.budgetBlockedPeriods.add(key);
      ledger.logEvent('system', null, 'budget_blocked', v.exceeded.map(describeUsage).join('；'));
    }
    if (now - this.budgetLogAtMs >= BUDGET_LOG_INTERVAL_MS) {
      this.budgetLogAtMs = now;
      log.warn(
        { ready: readyCount, exceeded: v.exceeded.map(describeUsage) },
        '花費已達上限，暫停派出新群組（進行中的不受影響，下個週期自動恢復）',
      );
    }
    return false;
  }

  /**
   * 送出通知，並吞掉所有失敗（同步擲錯與非同步 rejection 都要）。
   *
   * 通知管道壞掉絕不能讓 daemon 停擺——實跑就撞過：一個沒接住的 rejection
   * 讓整個行程掛掉，而它只是「提醒訊息沒送出去」這種等級的問題。
   */
  private async notify(send: () => Promise<void> | void, what: string): Promise<void> {
    try {
      await send();
    } catch (e) {
      this.deps.log.warn({ err: e instanceof Error ? e.message : String(e) }, `${what}發送失敗（已忽略）`);
    }
  }

  /** 同一個週期的同一種通知只發一次（去重鍵存在 ledger，跨重啟有效）。 */
  private notifyBudgetOnce(key: string, kind: 'warn' | 'stop', u: PeriodUsage): void {
    const { ledger, notifier } = this.deps;
    if (ledger.hasEvent('system', null, 'budget_notified', key)) return;
    ledger.logEvent('system', null, 'budget_notified', key);

    const text = kind === 'stop'
      ? `花費已達上限，已暫停派出新群組：${describeUsage(u)}。進行中的工作不受影響，下個週期會自動恢復。`
      : `花費接近上限：${describeUsage(u)}`;
    this.deps.log.warn({ key, usage: describeUsage(u) }, text);
    void this.notify(() => notifier?.notice?.(text), '花費通知');
  }

  /**
   * 靜置期閘門：只放行「任務板已經安靜夠久」的專案的任務。
   *
   * 被擋下的任務**留在 discovered**，不改狀態、不記失敗——下一輪再判一次即可。
   * 這是刻意的：靜置期不是錯誤，是等待；任何狀態變更都會讓它看起來像出問題。
   */
  private quietGate(tasks: Task[]): Task[] {
    if (tasks.length === 0) return tasks;
    const { log } = this.deps;
    const minutesOf = this.deps.quietMinutesOf ?? ((): number => DEFAULT_QUIET_MINUTES);
    const { ready, waiting, decisions } = splitByQuietPeriod(tasks, minutesOf, Date.now());
    if (waiting.length > 0) {
      for (const d of decisions.filter((x) => !x.quiet)) {
        log.info(
          { repo: d.repo, tasks: d.taskCount, waitSec: Math.ceil(d.waitMs / 1000), quietMinutes: d.quietMinutes },
          '靜置期未到，本輪不分群',
        );
      }
    }
    return ready;
  }

  // ── 2) Requeue ────────────────────────────────────────────────────────

  /**
   * 讓「離開 ready 之後」的群組還有回到派工的路徑。沒有這一段，澄清已答覆、
   * retry 指令、changes_requested 的群組全部永久卡死（tick 只看 discovered 與 ready）。
   *
   * 三條規則，都要求**有明確的重跑訊號**（不是看到非終態就重派，那會變成無限重試）：
   *   A. PARKED_GROUP_STATE（= changes_requested）的群，三條互補的復活路徑：
   *      A1 park 等人 → 人已回覆（群內沒有 blocked 任務、還有沒做完的任務）→ ready
   *         判定一律走 group-runner 匯出的 shouldRequeueGroup，契約只有一份。
   *      A0 park 等上游（deps）→ 指數退避到期才 ready（見 requeueDepsBlocked）。
   *         等上游不是等人，人不會來回覆，所以必須由這裡自動推進；但也不能每輪推，
   *         那正是實跑量到的「每 30 秒重建一次 worktree、永不停止」的緊迴圈。
   *      A2 要求修改 → 有可回灌的審查意見（任務都做完了，靠意見驅動下一輪）→ ready
   *   B. forming/failed 群組 + 群內有 queued/discovered 任務 → ready
   *      （queued 只會由 InboundRouter 的澄清答覆/retry 或 Reconciler 寫入 ⇒ 是明確訊號）
   *   C. 沒有群組（或群組已不存在）的 queued 任務 → 退回 discovered，讓 planner 重新分群
   *
   * 一律跳過 dispatcher 正在跑的群：它的狀態是別人手上的暫態，不可搶。
   */
  private requeue(): void {
    const { ledger, dispatcher, log } = this.deps;

    this.forgetStaleDepsWaits();

    // A) park／要求修改的群 → 回到可派工
    for (const g of ledger.listGroupsByState(PARKED_GROUP_STATE)) {
      if (dispatcher.isRunning(g.id)) continue;
      const tasks = g.taskIds.map((id) => ledger.getTask(id)).filter((t): t is Task => t !== undefined);
      const hasFeedback = this.feedback.has(g.id);

      // 安全互鎖：意見存在本地實例裡，GroupRunner 讀不到。派回去只會讓 agent 盲改，
      // 寧可停著等人接線（見 ReviewFeedbackStore 的接線契約）。放在最前面：只要有意見沒人
      // 讀得到，就算走的是 park 復活路徑也不該派（agent 會漏掉那些意見）。
      if (hasFeedback && !this.sharedFeedback) {
        this.warnOnce(`noshare:${g.id}`, { group: g.id }, '有審查意見但未注入共用的 ReviewFeedbackStore（GroupRunner 讀不到），不重新派工');
        continue;
      }

      // A1) park 等人：契約由 group-runner 定義（人回覆 → 任務 clearBlock 回 queued）。
      //     還有 blocked 任務就是還在等人 —— 這是正常狀態，不警告（會每輪洗版）。
      if (shouldRequeueGroup(g, tasks)) {
        this.toReady(g, '人已回覆（群內已無等待中的任務），park 的群恢復派工');
        continue;
      }

      // A0) park 等上游：等的是別的任務完成，不是人。由退避計時決定何時再派。
      if (this.isDepsPark(g)) {
        this.requeueDepsBlocked(g);
        continue;
      }
      if (tasks.some((t) => t.state === 'blocked')) continue; // 仍在等人，靜靜等著

      // A2) 任務都做完了。此時 PARKED_GROUP_STATE 有兩種來源，處置完全不同：
      if (!hasFeedback) {
        // (i) 從未開過 PR ⇒ 這是「park 等人」的群，人把最後一張卡結案了
        //     （典型：confirm_no_change 確認整群都不用做）。收尾工作還沒做——PR 沒開、
        //     Merge Guard 沒跑、worktree 沒清。不重派的話它會永遠停在非終態且沒人再碰
        //     （e2e 實測：群組卡死 + worktree 永久殘留）。GroupRunner 會跳過已 done 的任務
        //     直接進收尾流程，所以重派是安全的，也不會再叫 agent 跑任何東西。
        if (g.prNumber === undefined) {
          this.toReady(g, '群內任務都已結案但尚未收尾（未開 PR）→ 重新派工做收尾');
          continue;
        }
        // (ii) 已經開過 PR ⇒ 這是審查要求修改，但意見不見了（多半是 daemon 重啟）。
        //     沒有意見就重派只會讓 agent 盲改，寧可停著等人。
        this.warnOnce(
          `nofb:${g.id}`,
          { group: g.id, pr: g.prNumber },
          'changes_requested 群組沒有可回灌的審查意見、也沒有待跑任務（可能 daemon 重啟過），暫不重新派工',
        );
        continue;
      }
      this.toReady(g, '審查要求修改：帶著 reviewer 意見重新派工');
    }

    // B) 中斷後被明確要求重跑的群組
    for (const state of REVIVABLE_GROUP_STATES) {
      for (const g of ledger.listGroupsByState(state)) {
        if (dispatcher.isRunning(g.id)) continue;
        const revivable = g.taskIds
          .map((id) => ledger.getTask(id))
          .filter((t): t is Task => t !== undefined && REVIVABLE_TASK_STATES.has(t.state));
        if (revivable.length === 0) continue;
        this.toReady(g, `${state} 群組有 ${revivable.length} 個任務被要求重跑（澄清已答覆／retry／對帳重排）`);
      }
    }

    // C) 沒有群組可依附的 queued 任務 → 回 discovered 讓 planner 重新分群
    for (const t of ledger.listTasksByState('queued')) {
      if (t.groupId && ledger.getGroup(t.groupId)) continue;
      ledger.updateTaskState(t.id, 'discovered');
      ledger.logEvent('task', t.id, 'requeued', 'queued 但沒有對應群組 → 退回 discovered 重新分群');
      log.warn({ taskId: t.id, groupId: t.groupId }, '任務沒有對應群組，退回 discovered 重新分群');
    }
  }

  /**
   * **唯一**的「群組回到可派工」通道。所有復活路徑（含 group-runner 的 deps 受阻）都必須走這裡，
   * 否則計數與退避都形同虛設（實跑抓到的緊迴圈就是 group-runner 自己寫 ready 造成的）。
   *
   * 超過上限不再只是 warnOnce 就算了 —— 那會讓群組永遠停在非終態、人也不知道（見 handOffToHuman）。
   */
  private toReady(group: Group, reason: string, kind: RequeueKind = 'general'): boolean {
    const { ledger, log } = this.deps;
    const max = kind === 'deps'
      ? (this.deps.maxDepsRequeuePerGroup ?? DEFAULT_MAX_DEPS_REQUEUE)
      : (this.deps.maxRequeuePerGroup ?? DEFAULT_MAX_REQUEUE);
    const used = this.usedRequeues(group.id);
    if (used[kind] >= max && !this.resetBudgetOnHumanSignal(group)) {
      this.handOffToHuman(group, kind, max);
      return false;
    }
    const now = this.usedRequeues(group.id);
    now[kind] += 1;
    ledger.updateGroupState(group.id, DISPATCHABLE_GROUP_STATE);
    ledger.logEvent('group', group.id, REQUEUE_EVENT, `${kind === 'deps' ? DEPS_TAG : ''}${reason}（第 ${now[kind]} 次）`);
    log.info({ group: group.id, attempt: now[kind], kind, from: group.state }, `♻️ 群組重新派工：${reason}`);
    return true;
  }

  /**
   * 這個群組已經用掉幾次重派。**以 ledger 事件為準**：requeueCount 原本只活在記憶體裡，
   * daemon 一重啟就歸零 ⇒ 上限形同虛設，被擋下的迴圈重啟後又從頭跑一次。
   */
  private usedRequeues(groupId: string): Record<RequeueKind, number> {
    const cached = this.requeueUsed.get(groupId);
    if (cached) return cached;
    const { ledger } = this.deps;
    const resetAt = ledger.latestEvent('group', groupId, REQUEUE_RESET_EVENT)?.id ?? 0;
    const used: Record<RequeueKind, number> = { deps: 0, general: 0 };
    for (const e of ledger.listEvents({ scope: 'group', refId: groupId, kind: REQUEUE_EVENT, limit: 500 })) {
      if (e.id <= resetAt) continue; // 重置之前的不算
      if ((e.detail ?? '').startsWith(DEPS_TAG)) used.deps += 1;
      else used.general += 1;
    }
    this.requeueUsed.set(groupId, used);
    return used;
  }

  /**
   * 撞到上限：**不可以只留一行 warn 就閉嘴**（實跑證實那會讓群組永久停在非終態、
   * worktree 永久殘留，而人完全不知道）。三件事一起做：稽核事件、通知人、
   * 推到一個明確的「等人」狀態（park 是非終態、worktree 保留、人一回覆就能復活）。
   */
  private handOffToHuman(group: Group, kind: RequeueKind, max: number): void {
    const { ledger, log } = this.deps;
    const key = `exhausted:${group.id}:${kind}`;
    if (this.warnedOnce.has(key)) return; // 每輪都會再掃到，事件與通知只發一次
    this.warnedOnce.add(key);

    const detail = kind === 'deps'
      ? `群組等上游依賴已重試 ${max} 次仍無法開工，請確認依賴的任務是否真的會完成`
      : `群組重新派工已達上限（${max} 次），停手交人處理`;
    ledger.logEvent('group', group.id, REQUEUE_EXHAUSTED_EVENT, `${detail}｜停在 ${group.state}`);
    log.error({ group: group.id, kind, max, state: group.state }, `⛔ ${detail}`);
    this.notifyGroup(group.id, {
      type: 'problem',
      detail: `${detail}（群組 ${group.id}）。在 Slack 對群內任務下 retry／回覆澄清即可重新開始。`,
    });
    // 停在 forming/ready 會被誤認成「還在跑」；park 才明確代表「等人」，且是可恢復的非終態
    if (group.state !== PARKED_GROUP_STATE) ledger.updateGroupState(group.id, PARKED_GROUP_STATE);
  }

  /**
   * 人明確要求重跑（Slack 澄清答覆／retry 指令）＝**新的訊號**，重新給預算。
   *
   * 沒有這個出口，撞上限之後就算人按了 retry 也不會有任何反應——上限本身變成新的黑洞（D18）。
   * 判定用事件 id 比大小：只有「比最後一次重派還新」的人為訊號才算數，
   * 否則同一則舊答覆會被反覆當成新訊號，上限就等於不存在。
   */
  private resetBudgetOnHumanSignal(group: Group): boolean {
    const { ledger, log } = this.deps;
    const since = ledger.latestEvent('group', group.id, REQUEUE_EVENT)?.id ?? 0;
    const fresh = group.taskIds.some((taskId) =>
      HUMAN_RETRY_EVENTS.some((kind) => (ledger.latestEvent('task', taskId, kind)?.id ?? 0) > since),
    );
    if (!fresh) return false;

    ledger.logEvent('group', group.id, REQUEUE_RESET_EVENT, '人明確要求重跑，重派預算重新計算');
    this.requeueUsed.set(group.id, { deps: 0, general: 0 });
    this.depsWait.delete(group.id);
    this.warnedOnce.delete(`exhausted:${group.id}:deps`);
    this.warnedOnce.delete(`exhausted:${group.id}:general`);
    log.info({ group: group.id }, '🧑 人要求重跑，重派預算已重置');
    return true;
  }

  // ── A0) 等上游依賴的退避 ───────────────────────────────────────────────

  /**
   * 這次 park 是不是「等上游」。兩種 park 都停在 changes_requested，狀態本身分不出來，
   * 所以比事件新舊：deps 事件比 park 事件新 ⇒ 目前等的是上游而不是人。
   */
  private isDepsPark(group: Group): boolean {
    const { ledger } = this.deps;
    const blocked = ledger.latestEvent('group', group.id, GROUP_DEPS_BLOCKED_EVENT);
    if (!blocked) return false;
    return blocked.id > (ledger.latestEvent('group', group.id, GROUP_PARKED_EVENT)?.id ?? 0);
  }

  /**
   * 等上游的指數退避。每被擋一次就多一格（第 1 次不等，維持「下一輪就重試」的手感），
   * 退避期間**連派都不派** —— 這是關鍵：不派工就不會有 worktree add／node_modules 複製，
   * 受阻期間的成本趨近於零（相對於實測的「每輪一次完整建置」）。
   */
  private requeueDepsBlocked(group: Group): void {
    const { ledger, log } = this.deps;
    const blockedId = ledger.latestEvent('group', group.id, GROUP_DEPS_BLOCKED_EVENT)?.id ?? 0;
    const prev = this.depsWait.get(group.id);
    const now = Date.now();

    let state = prev;
    if (!state || blockedId > state.lastBlockedEventId) {
      // 又被擋了一次（或重啟後第一次看到）→ 退避加一格
      const attempts = (state?.attempts ?? 0) + 1;
      const waitMs = this.depsWaitMs(attempts);
      state = { attempts, lastBlockedEventId: blockedId, nextEligibleAt: now + waitMs };
      this.depsWait.set(group.id, state);
      if (waitMs > 0) {
        ledger.logEvent('group', group.id, DEPS_BACKOFF_EVENT, `第 ${attempts} 次等上游，${Math.round(waitMs / 1000)} 秒後才重派`);
        log.info({ group: group.id, attempts, waitMs }, '⏳ 依賴未完成，退避後再重新派工');
      }
    }
    if (now < state.nextEligibleAt) return; // 退避中：本輪不派（不會重建 worktree）

    this.toReady(group, `依賴未完成，退避後重新嘗試（第 ${state.attempts} 次等待）`, 'deps');
  }

  /** 第 1 次不等，之後 base × 2^(n-2)，上限 maxMs。base 未設 → 一個輪詢週期。 */
  private depsWaitMs(attempts: number): number {
    if (attempts <= 1) return 0;
    const cfg = this.deps.depsBackoff ?? {};
    const base = cfg.baseMs ?? Math.max(1_000, this.currentInterval() * 1000);
    const max = cfg.maxMs ?? DEFAULT_DEPS_BACKOFF_MAX_MS;
    return Math.min(base * 2 ** (attempts - 2), max);
  }

  /**
   * 清掉「已經不是在等上游」的退避狀態。
   * 只在群組真的往前走了（離開 park／ready／forming）才清：留在 ready/forming 時清掉
   * 會讓 attempts 每輪歸零，退避退化成固定間隔的迴圈（等於沒退避）。
   */
  private forgetStaleDepsWaits(): void {
    const alive: GroupState[] = [PARKED_GROUP_STATE, DISPATCHABLE_GROUP_STATE, 'forming'];
    for (const id of [...this.depsWait.keys()]) {
      const g = this.deps.ledger.getGroup(id);
      if (!g || !alive.includes(g.state)) this.depsWait.delete(id);
    }
  }

  // ── 5) 審查事件 ───────────────────────────────────────────────────────

  /** 審查監看失敗不可影響主流程（PR 審查是旁路，不是任務推進的必要條件）。 */
  private async pollReviews(): Promise<void> {
    const { reviewWatcher, ledger, log } = this.deps;
    if (!reviewWatcher) {
      this.warnStuckWithoutWatcher();
      return;
    }
    let events: ReviewSignal[];
    try {
      events = await reviewWatcher.poll();
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Review Watcher 失敗（略過本輪）');
      return;
    }
    for (const e of events) {
      log.info({ group: e.group, type: e.type }, '收到 PR 審查事件');
      ledger.logEvent('group', e.group, `review_${e.type}`, JSON.stringify(e));
      // 單一事件處理失敗不可讓其餘事件跟著掉（審查事件不會重播——已被去重標記過）
      try {
        if (e.type === 'approved') this.onApproved(e);
        else this.onChangesRequested(e);
      } catch (err) {
        log.error({ group: e.group, err: err instanceof Error ? err.message : String(err) }, '處理審查事件失敗');
      }
    }
  }

  /**
   * 未接 ReviewWatcher 時點名「卡在等審查」的群組（檔頭語意表：這兩個狀態失去唯一的推進者）。
   *
   * 為什麼不是直接推進：沒有 gh／不開 PR 的使用者本來就不該被強迫接線，自動放行等於
   * 繞過審查（合併不可逆）。但**卡住必須看得見**——靜默不動與「正常運作」長得一模一樣，
   * 使用者會以為任務還在跑。點名之後人還有救回的路：Slack 核准或 recordMergeApproval。
   * 每個群只講一次（每輪都掃得到同一批群，不節流會洗版）。
   */
  private warnStuckWithoutWatcher(): void {
    const { ledger, dispatcher } = this.deps;
    for (const state of AWAITING_REVIEW_STATES) {
      for (const g of ledger.listGroupsByState(state)) {
        if (dispatcher.isRunning(g.id)) continue; // GroupRunner 正在開 PR ⇒ 暫態，不是卡住
        if (this.approvalOf(g.id)) continue; // 已有憑證，合併佇列會接手（不算沒有推進者）
        this.warnOnce(
          `nowatcher:${g.id}`,
          { group: g.id, state },
          '群組在等 PR 審查但未接 ReviewWatcher，沒有推進者：需人工核准（Slack／recordMergeApproval）才會前進',
        );
      }
    }
  }

  /**
   * 審查通過：記下**核准憑證**並把群組移到待合併。
   * 這裡不直接合併——合併統一走 processMergeQueue，保證每條合併路徑都經過
   * 「重跑 Merge Guard → 政策閘門」的同一道關卡。
   */
  private onApproved(e: Extract<ReviewSignal, { type: 'approved' }>): void {
    const { ledger, log } = this.deps;
    const group = ledger.getGroup(e.group);
    if (!group) {
      log.warn({ group: e.group }, '收到 approved 事件但 ledger 沒有這個群組（忽略）');
      return;
    }
    // 核准取代了先前的修改要求
    this.feedback.clear(group.id);
    this.recordApproval(group.id, {
      approvedBy: `reviewer:${e.approvedBy ?? 'unknown'}`,
      source: 'github_review',
    });
    // 群組正在跑時不搶它的狀態（那是 GroupRunner 手上的暫態）；憑證已記下，之後照樣生效
    if (group.state !== 'merge_guard' && !this.deps.dispatcher.isRunning(group.id)) {
      ledger.updateGroupState(group.id, 'merge_guard');
    }
    log.info({ group: group.id, by: e.approvedBy }, '✅ 審查通過 → 進入合併把關佇列');
  }

  /** 審查要求修改：把意見存成可回灌的 feedback（下一次 requeue 就會重新派工）。 */
  private onChangesRequested(e: Extract<ReviewSignal, { type: 'changes_requested' }>): void {
    const { ledger, log } = this.deps;
    // 之前的核准已失效——改完必須重新取得核准才可能合併
    this.clearApproval(e.group, 'changes_requested');
    this.askedApproval.delete(e.group);
    this.feedback.save({ groupId: e.group, comments: e.comments, source: 'github_review' });
    this.notifyGroup(e.group, { type: 'changes_requested', count: e.comments.length });
    if (!this.sharedFeedback) {
      log.warn({ group: e.group }, '審查意見已存入本地暫存，但未與 GroupRunner 共用實例 → 不會自動重新派工');
    }
    ledger.logEvent('group', e.group, 'feedback_ready', `${e.comments.length} 則審查意見待回灌`);
  }

  // ── 人工裁決（Slack 合併閘門） ────────────────────────────────────────

  /**
   * 人在 Slack 按了核准/退回。**這是本檔認可的第二種核准來源**（第一種是 GitHub approved）。
   * 註：InboundRouter 也訂閱同一個事件並負責寫群組狀態；這裡只負責記憑證，兩者不衝突。
   */
  private onMergeDecision(d: { groupId: string; approved: boolean; userId?: string }): void {
    const { ledger, log } = this.deps;
    try {
      const group = ledger.getGroup(d.groupId);
      if (!group) {
        log.warn({ group: d.groupId }, '收到合併裁決但 ledger 沒有這個群組（忽略）');
        return;
      }
      if (d.approved) {
        this.recordApproval(d.groupId, { approvedBy: `human:${d.userId ?? 'unknown'}`, source: 'human' });
        // 只在「等審查/等合併」的狀態才改狀態；群組正在跑時不可搶它的狀態
        if (group.state === 'in_review' || group.state === 'pr_open') ledger.updateGroupState(d.groupId, 'merge_guard');
        log.info({ group: d.groupId, by: d.userId }, '🔐 已記錄人工核准憑證');
        return;
      }
      this.clearApproval(d.groupId, 'rejected');
      this.askedApproval.delete(d.groupId);
      this.feedback.save({
        groupId: d.groupId,
        comments: [`人工在 Slack 退回了這次合併（操作者 ${d.userId ?? '未知'}），請依 PR 上的意見修正後重新送審。`],
        source: 'human_reject',
      });
    } catch (err) {
      // Slack 回呼裡丟錯只會污染 log，不該影響 daemon
      this.deps.log.error({ err: err instanceof Error ? err.message : String(err) }, '處理合併裁決失敗（已吞下）');
    }
  }

  /**
   * 外部（如 InboundRouter 或 CLI）明確記錄一筆核准憑證。
   * approvedBy 由呼叫端負責填真實來源——它會原封不動出現在合併稽核紀錄裡。
   */
  recordMergeApproval(groupId: string, approvedBy: string, source: 'github_review' | 'human' = 'human'): void {
    const who = approvedBy.trim();
    if (!who) {
      this.deps.log.error({ group: groupId }, '拒絕記錄核准：未指明核准來源（approvedBy）');
      return;
    }
    this.recordApproval(groupId, { approvedBy: who, source });
  }

  /**
   * 記錄核准憑證。**寫進 ledger 而不是只放記憶體**。
   *
   * 只放記憶體的話有三條路是壞的，而且壞得很安靜（人以為核准了）：
   *   · CLI 核准（`npm run ask -- g_x approve`）是另一個行程 ⇒ 憑證進不到 daemon
   *   · 控制台獨立執行時同理
   *   · daemon 重啟 ⇒ 重啟前的核准全部消失，群組退回「沒有推進者」
   * D17（狀態不等於核准）仍然成立：憑證是**明確寫下的一筆事件**，
   * 不是從 merge_guard 狀態推論出來的。
   */
  private recordApproval(groupId: string, approval: MergeApproval): void {
    this.approvals.set(groupId, approval);
    // 新的核准 ⇒ 允許在必要時（例如上次合併失敗）再問一次人
    this.askedApproval.delete(groupId);
    this.deps.ledger.logEvent('group', groupId, MERGE_CREDENTIAL_EVENT, JSON.stringify(approval));
    this.deps.ledger.logEvent('group', groupId, 'merge_approval', `${approval.source}｜${approval.approvedBy}`);
  }

  /**
   * 取核准憑證：記憶體優先，沒有就回 ledger 找（跨行程／跨重啟）。
   *
   * 憑證會被「作廢」事件抵銷——合併完成、被退回、或政策否決之後，
   * 舊憑證不可以在下一輪又被撿起來用（那等於一次核准可以合併兩次）。
   */
  private approvalOf(groupId: string): MergeApproval | undefined {
    const inMemory = this.approvals.get(groupId);
    if (inMemory) return inMemory;

    const { ledger, log } = this.deps;
    const cred = ledger.latestEvent('group', groupId, MERGE_CREDENTIAL_EVENT);
    if (!cred) return undefined;
    const cleared = ledger.latestEvent('group', groupId, MERGE_CREDENTIAL_CLEARED_EVENT);
    if (cleared && cleared.id > cred.id) return undefined; // 已作廢

    try {
      const parsed = JSON.parse(cred.detail ?? '{}') as MergeApproval;
      if (!parsed.approvedBy) return undefined;
      this.approvals.set(groupId, parsed); // 補回記憶體快取
      log.info({ group: groupId, by: parsed.approvedBy, source: parsed.source }, '從 ledger 取回核准憑證');
      return parsed;
    } catch {
      // 壞掉的憑證等同沒有憑證：合併不可逆，寧可再問一次人
      log.warn({ group: groupId }, '核准憑證無法解析，視為未核准');
      return undefined;
    }
  }

  /** 作廢憑證（合併完成／退回／否決後）。記憶體與 ledger 都要清，否則會被重複使用。 */
  /**
   * 把合併工作區切回 base，釋放群組分支。切不回去只留 warn——
   * 它不該讓一個已經跑完的合併判決失效，但下一次要用那條分支時會失敗，所以要留痕。
   */
  private async releaseMergeWorktree(proj: MergeProject, branch: string): Promise<void> {
    const release = this.deps.merge?.releaseBranch;
    if (!release) return;
    try {
      await release(proj.repoPath, proj.baseBranch);
    } catch (e) {
      this.deps.log.warn(
        { repoPath: proj.repoPath, err: e instanceof Error ? e.message : String(e) },
        '合併工作區收尾擲錯（忽略）',
      );
    }
  }

  private clearApproval(groupId: string, why: string): void {
    const had = this.approvals.delete(groupId);
    const inLedger = this.deps.ledger.latestEvent('group', groupId, MERGE_CREDENTIAL_EVENT) !== undefined;
    if (had || inLedger) this.deps.ledger.logEvent('group', groupId, MERGE_CREDENTIAL_CLEARED_EVENT, why);
  }

  // ── 6) 合併佇列 ───────────────────────────────────────────────────────

  /**
   * 消費 merge_guard 群組（狀態語意見檔頭）。
   * 兩道硬性把關：**正在跑的群不碰**、**沒有核准憑證不合併**。
   */
  private async processMergeQueue(): Promise<void> {
    const { ledger, dispatcher } = this.deps;
    for (const group of ledger.listGroupsByState('merge_guard')) {
      if (dispatcher.isRunning(group.id)) continue; // GroupRunner 就地跑守衛中 = 暫態，不是待合併
      const approval = this.approvalOf(group.id);
      if (!approval) {
        // 可能是 daemon 在 GroupRunner 跑守衛時崩潰留下的殘跡，也可能是別的程序寫的。
        // 無法證明有人核准 ⇒ 一律不合併，改成問人（只問一次）。
        this.askForApproval(group, ['本機沒有這個群組的核准紀錄（可能是 daemon 重啟或流程中斷），需人工確認']);
        continue;
      }
      try {
        // 同一個 repo 的合併必須序列（見 repo-lock.ts）。這裡用 try-lock 而不是排隊：
        // 這個迴圈是在主迴圈裡 await 的，排隊等一個正在跑 Merge Guard 的 worker
        // 會把輪詢、規劃、派工、提醒整個卡住好幾分鐘。下一輪（15 秒後）再試就好。
        const proj = this.deps.merge?.resolveProject(group.repo);
        const key = proj?.repoPath ?? group.repo;
        const done = await tryWithRepoLock(key, async () => {
          await this.mergeApprovedGroup(group, approval);
          return true;
        });
        if (done === undefined) {
          this.deps.log.debug({ group: group.id, repo: group.repo }, '同 repo 正在合併，本輪跳過（下一輪再試）');
        }
      } catch (err) {
        this.deps.log.error(
          { group: group.id, err: err instanceof Error ? err.message : String(err) },
          '合併把關流程發生例外（本輪略過，不影響其餘群組）',
        );
      }
    }
  }

  /** 已核准的群組：fetch 最新 base → 重跑 Merge Guard → 政策閘門 → 合併。 */
  private async mergeApprovedGroup(group: Group, approval: MergeApproval): Promise<void> {
    const { ledger, log } = this.deps;
    const m = this.deps.merge;
    // ── 人已經核准，但沒有任何路可以走 ──
    //
    // 原本這兩條只 warnOnce 就 return。實跑撞到：多專案測試裡一個本地專案
    // （當時還有 openPr 開關，已移除）被人核准後，群組永遠停在 merge_guard——不在待辦清單、
    // 沒合併、沒失敗，而依賴它的下一群就一直等下去。**人按了核准，系統靜默地
    // 什麼都不做**，這是這個系統最危險的失敗模式。
    //
    // 標成 failed 不是說這批工作壞掉（它通過了所有關卡），而是「這條路走不下去、
    // 需要人決定」——failed 是唯一會進待辦清單、且有 retry 動作的狀態。
    // 原因寫清楚，人才知道該去開設定還是自己合併。
    if (!m) {
      const why =
        '已核准，但合併管線沒接線（orchestrator 設定的 allowLocalMerge=false）。'
        + '這批工作已通過所有關卡，分支還在——把設定打開後 retry，或自己合併該分支。';
      log.error({ group: group.id, by: approval.approvedBy }, '群組已核准但沒有合併管線，標記 failed 交人處理');
      ledger.logEvent('group', group.id, 'merge_blocked', why);
      this.failGroup(group, why);
      return;
    }
    if (!group.prNumber) {
      // 開 PR 是必經之路，所以正常情況一定有編號。沒有代表 ledger 的紀錄不完整
      // （例如開 PR 時崩潰），這時不能假裝合併過——交人看。
      const why =
        '已核准，但 ledger 裡沒有這個群組的 PR 編號。開 PR 是必經之路，'
        + '沒有編號代表紀錄不完整（例如開 PR 途中崩潰）。'
        + '這批工作已通過所有關卡、分支還在——請確認 GitHub 上的 PR 狀態後再決定。';
      log.error({ group: group.id, branch: group.branch }, '群組已核准但沒有 PR 編號，標記 failed 交人處理');
      ledger.logEvent('group', group.id, 'merge_blocked', why);
      this.failGroup(group, why);
      return;
    }
    const proj = m.resolveProject(group.repo);
    if (!proj) {
      log.error({ group: group.id, repo: group.repo }, '合併前找不到專案 runtime，群組標記 failed');
      ledger.logEvent('group', group.id, 'merge_blocked', `找不到專案 runtime：${group.repo}`);
      this.failGroup(group, `找不到專案 runtime：${group.repo}`);
      return;
    }

    // (b) 合併前**一定**重跑 Merge Guard，而且要先抓最新 base：
    //     GitHub 的 mergeable 只看有沒有文字衝突，抓不到語意飄移（依賴的 API 被別的 PR 改掉），
    //     而 §D9 明講正確性是由這道守衛兜底的。
    if (m.fetchBase) {
      try {
        await m.fetchBase(proj.repoPath, proj.baseBranch);
      } catch (e) {
        // 抓不到最新 base 就只能驗舊的 base——會漏掉飄移，所以要吵，但不阻擋（守衛照跑）
        log.warn({ group: group.id, err: e instanceof Error ? e.message : String(e) }, '抓取最新 base 失敗，守衛驗的可能是過期的 base');
      }
    } else {
      log.warn({ group: group.id }, '未提供 fetchBase，Merge Guard 驗的是本機現有的 base（可能過期）');
    }

    const tasksOfGroup = group.taskIds.map((id) => ledger.getTask(id)).filter((t): t is Task => t !== undefined);
    const head = tasksOfGroup[0];
    const verdict = await m.guard.attempt({
      repoPath: proj.repoPath,
      branch: group.branch,
      base: proj.baseBranch,
      verifierConfig: proj.verifierConfig,
      taskTitles: tasksOfGroup.map((t) => t.title),
      // **這是第二個 Merge Guard 呼叫點**（核准後的那次）。任務資訊同樣不能漏——
      // 少了 baseRef，這一關的介面判斷者就沒有唯讀 git，分不出「這次弄的」與
      // 「本來就有的」，會把既有瑕疵算到這次頭上而擋掉一個已經核准的合併。
      // 先前只修了 group-runner 那個呼叫點，這個漏掉（實跑撞到）。
      ...(head
        ? {
            task: {
              id: head.id,
              category: head.category,
              title: head.title,
              description: head.description,
              baseRef: `${proj.remote ?? 'origin'}/${proj.baseBranch}`,
            },
          }
        : {}),
    });
    // **合併工作區用完要把分支放開。**
    //
    // git 不允許同一條分支同時被兩個 worktree 檢出。守衛會把這個工作區檢出到群組分支，
    // 停在上面就等於占住那條分支——接著群組若要重做，任務 worktree 就建不起來
    // （`is already used by worktree at .../merge-worktrees/live`），整組 failed。
    // 實跑撞到：核准 → 守衛擋下 → 要重做 → 建 worktree 失敗 → failed。
    //
    // 只在這裡做、不放進 MergeGuard：group-runner 是在**任務 worktree** 裡跑守衛，
    // 那裡切回 base 會讓後續的 commit / 開 PR 跑在 base 上，是更嚴重的錯誤。
    // 誰擁有工作區，誰負責收尾。
    await this.releaseMergeWorktree(proj, group.branch);

    if (!verdict.ok) {
      // 核准是對「當時那份程式碼」的核准；守衛擋下代表狀況已改變 → 憑證作廢
      this.clearApproval(group.id, `merge_guard:${verdict.reason}`);
      ledger.logEvent('group', group.id, 'merge_guard_blocked', `${verdict.reason}: ${verdict.detail}`);
      if (verdict.reason === 'precondition_failed') {
        // 「根本沒驗到」不可當成「要修」——沒有具體意見可以回灌，只能交人
        log.error({ group: group.id, detail: verdict.detail }, 'Merge Guard 前置條件不成立，群組標記 failed');
        this.failGroup(group, `Merge Guard 前置條件不成立：${verdict.detail}`);
        return;
      }
      // 其餘（衝突／語意飄移／測試紅）都是可修的 → 存成 feedback 退回實作（DESIGN §9b）
      this.feedback.save({
        groupId: group.id,
        comments: [`[${verdict.reason}] ${verdict.detail}`],
        source: 'merge_guard',
      });
      ledger.updateGroupState(group.id, 'changes_requested');
      this.notifyGroup(group.id, { type: 'problem', detail: `Merge Guard 擋下（${verdict.reason}），退回修正` });
      log.warn({ group: group.id, reason: verdict.reason }, 'Merge Guard 擋下 → 退回 changes_requested');
      return;
    }

    // 合併前再確認一次 base 沒被動過。同 repo 的合併由 repo 鎖序列化，所以我們自己
    // 不會製造這種情況——這一項擋的是**鎖看不到的合併**：人在 GitHub 上自己按合併、
    // 或別的工具動了 base。變了就代表守衛剛剛驗的那個世界已經不存在。
    if (verdict.ok && verdict.baseSha && m.currentBaseSha) {
      const now = await m.currentBaseSha(proj.repoPath, proj.baseBranch, proj.remote ?? 'origin');
      if (now && now !== verdict.baseSha) {
        // 不作廢憑證：人的核准仍然有效，只是要對著新的 base 重驗一次。下一輪會重跑守衛。
        ledger.logEvent('group', group.id, 'base_moved', `守衛驗的是 ${verdict.baseSha.slice(0, 8)}，現在是 ${now.slice(0, 8)}`);
        log.warn(
          { group: group.id, verified: verdict.baseSha.slice(0, 8), current: now.slice(0, 8) },
          'base 在守衛通過後被外部動過 → 本輪不合併，下一輪重跑守衛',
        );
        return;
      }
    }

    // 這裡不再有政策閘門。
    //
    // 走到這一步代表：有人（Slack/CLI 按核准，或 GitHub 上 approve）已經明確點頭，
    // 而且 Merge Guard 剛剛才在最新的 base 上重跑並通過。再拿一組寫死的檔案路徑規則
    // 去否決一個人已經看過並同意的改動，只是把「誰能決定」從人手上搶回程式手上。
    //
    // 原本那組規則（**/migrations/**、.github/workflows/** …）本質上是在猜別人的 repo
    // 長什麼樣：換一個把 migration 放在 db/schema/ 的專案就同時做錯兩件事——
    // 該擋的沒擋、不該擋的亂擋。要判「這個改動可不可逆」得看得懂那個 repo，
    // 所以那個判斷移到 GroupRunner 的合併風險判斷者（agent，看得到實際內容），
    // 而且只在「自動合併」開著、根本沒有人要看的時候才需要。
    const res = await m.pr.merge({
      repo: group.repo,
      prNumber: group.prNumber,
      approvedBy: approval.approvedBy, // 安全機制：原封不動傳遞，絕不由此處編造
      // 合併後刪掉來源分支。群組分支名是 sha1(repo|任務清單) 決定的，同一組任務永遠同名；
      // 留著已合併的舊分支，下次同組任務再跑就會 push 被拒（實跑撞過）。
      // 只刪自己開的 orch/* 分支，且此時內容已進 base，刪除不會失去任何東西。
      deleteBranch: true,
      cwd: proj.repoPath,
    });
    if (!res.ok) {
      // 合併失敗（權限、分支保護、競態…）：憑證作廢，下一輪會重新問人，不會靜默重試
      this.clearApproval(group.id, 'merge_failed');
      ledger.logEvent('group', group.id, 'merge_failed', res.detail);
      this.notifyGroup(group.id, { type: 'failed', detail: `合併 PR 失敗：${res.detail}` });
      log.error({ group: group.id, pr: group.prNumber, detail: res.detail }, '合併 PR 失敗');
      return;
    }

    this.clearApproval(group.id, 'merged');
    // 卡片收尾：合併完成後不該還掛著任何按鈕
    for (const taskId of group.taskIds) {
      void Promise.resolve(this.deps.notifier?.updateTaskCard?.(taskId, 'merged')).catch(() => {});
    }
    this.askedApproval.delete(group.id);
    ledger.updateGroupState(group.id, 'merged');
    ledger.logEvent('group', group.id, 'merged', `PR #${group.prNumber}｜核准者 ${approval.approvedBy}`);
    this.notifyGroup(group.id, { type: 'merged' });
    log.info({ group: group.id, pr: group.prNumber, approvedBy: approval.approvedBy }, '🔀 PR 已合併');
  }

  /** 請人核准（每個群組只問一次，直到出現新的核准憑證為止）。 */
  private askForApproval(group: Group, reasons: string[]): void {
    const { gateway, ledger, log } = this.deps;
    if (this.askedApproval.has(group.id)) return;
    this.askedApproval.add(group.id);
    ledger.logEvent('group', group.id, 'merge_needs_human', reasons.join('\n'));
    log.warn({ group: group.id, reasons }, '🔐 合併需人工核准，不自動合併');
    if (!gateway) return;
    const titles = group.taskIds.map((id) => ledger.getTask(id)?.title ?? id);
    void Promise.resolve(
      gateway.askMergeApproval(this.threadTsOf(group), {
        groupId: group.id,
        branch: group.branch,
        repo: group.repo,
        taskTitles: titles,
        ...(group.prUrl ? { prUrl: group.prUrl } : {}),
        reasons,
      }),
    ).catch((e) => log.warn({ err: e instanceof Error ? e.message : String(e) }, '發送合併核准請求失敗（忽略）'));
  }

  private failGroup(group: Group, detail: string): void {
    this.clearApproval(group.id, 'failed');
    this.deps.ledger.updateGroupState(group.id, 'failed');
    this.notifyGroup(group.id, { type: 'failed', detail });
  }

  // ── 小工具 ────────────────────────────────────────────────────────────

  private threadTsOf(group: Group): string | undefined {
    for (const id of group.taskIds) {
      const t = this.deps.ledger.getTask(id);
      if (t?.slackThreadTs) return t.slackThreadTs;
    }
    return undefined;
  }

  /** 群層事件掛在群內第一個任務的 thread（一任務一 thread）。通知失敗絕不影響流程。 */
  private notifyGroup(groupId: string, event: LifecycleEvent): void {
    const { notifier, ledger, log } = this.deps;
    if (!notifier) return;
    const group = ledger.getGroup(groupId);
    const head = group?.taskIds.map((id) => ledger.getTask(id)).find((t): t is Task => t !== undefined);
    if (!head) return;
    const detail: TaskDetail = {
      id: head.id, title: head.title, status: 'done', repo: head.repo,
      category: head.category, description: head.description, dependencies: head.dependencies, docRefs: head.docRefs,
    };
    void Promise.resolve(notifier.event(head.slackThreadTs, event, detail)).catch((e) =>
      log.warn({ err: e instanceof Error ? e.message : String(e) }, '通知失敗（忽略）'),
    );
  }

  /** 同一個 key 只警告一次（狀態機每輪都會掃到同一個群組，不節流會洗版）。 */
  private warnOnce(key: string, fields: Record<string, unknown>, msg: string): void {
    if (this.warnedOnce.has(key)) return;
    this.warnedOnce.add(key);
    this.deps.log.warn(fields, msg);
  }

  /** 常駐循環。傳入 AbortSignal 可優雅停止（睡眠中收到 abort 會立刻醒來，不等滿一個週期）。 */
  /**
   * @param signal 收到 SIGTERM 時 abort。**它會一路傳到正在跑的 agent 與 DoD 指令**，
   *   讓它們停下來並收掉自己的子行程。
   *
   *   先前這個 signal 只用來停這個迴圈——「不再排新工作」而已。正在寫程式的 agent
   *   完全不知情，會一直做到收尾寬限逾時，然後整個行程被強制結束；
   *   它用 Bash 起的 dev server／watch 就跳出 process group 變成孤兒。
   *   實跑撞到：三個埠被佔了一個多小時，而沒有任何地方看得到。
   */
  async run(signal?: AbortSignal): Promise<void> {
    this.deps.log.info({ intervalSec: this.currentInterval() }, '主控迴圈啟動');
    while (!signal?.aborted) {
      try {
        await this.tick(signal);
      } catch (e) {
        this.deps.log.error({ err: e instanceof Error ? e.message : String(e) }, 'tick 發生錯誤（續下一輪）');
      }
      // 每輪重新取間隔：控制台改了輪詢週期，下一輪就生效（不必重啟）
      await sleep(this.currentInterval() * 1000, signal);
    }
    this.deps.log.info('主控迴圈停止');
  }

  /** 目前的輪詢間隔（秒）。傳函式進來就是「每輪現拿」，傳數字則固定。 */
  private currentInterval(): number {
    const v = typeof this.intervalSec === 'function' ? this.intervalSec() : this.intervalSec;
    return Number.isFinite(v) && v > 0 ? v : 30;
  }
}
