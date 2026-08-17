import type { Notifier } from '../contracts.js';
import type {
  BlockReason,
  ClarificationAnswer,
  ControlCommand,
  Group,
  GroupState,
  LifecycleEvent,
  McpOut,
  Task,
  TaskDetail,
  TaskState,
} from '../types.js';
import type { NoChangeCategory } from '../worker/agent-runtime.js';
import type { Logger } from '../observability/logger.js';
import { MERGE_CREDENTIAL_EVENT, MERGE_CREDENTIAL_CLEARED_EVENT } from '../core/merge-credential.js';
import { STANDING_DECISION } from '../worker/human-reply.js';
import { isStuckGroupState, openStuckGroupHandoff, type HandoffLedger } from '../core/handoff.js';
import { releaseDeps } from '../core/deps-release.js';

/** 心跳多新才算「正在跑」。 */
const LIVE_ACTIVITY_MS = 5 * 60_000;
import type { FeedbackSource } from '../pr/review-watcher.js';

/** 事件轉為簡短中文摘要（Slack 與 console 共用文案）。 */
export function summarizeEvent(e: LifecycleEvent): string {
  switch (e.type) {
    case 'claimed': return '🟡 已認領';
    case 'docs_read': return `📖 已讀規格：${e.refs.join(', ') || '（無）'}`;
    case 'iterating': return `🔧 實作中（第 ${e.round} 輪）`;
    case 'problem': return `⚠️ 遇到問題：${e.detail}`;
    case 'pr_open': return `🚀 PR 已開：${e.url}`;
    case 'in_review': return '👀 進入審查';
    case 'changes_requested': return `👀 要求修改（${e.count} 則）`;
    case 'merged': return '🔀 已合併';
    case 'failed': return `💀 失敗：${e.detail}`;
  }
}

/** M1–M3 的預設通知：輸出到 log。M4 由 SlackNotifier 取代。 */
export class ConsoleNotifier implements Notifier {
  constructor(private log: Logger) {}
  event(threadTs: string | undefined, event: LifecycleEvent, task: TaskDetail): void {
    this.log.info({ taskId: task.id, threadTs }, summarizeEvent(event));
  }
}

// ── 「無需改動」的人工確認出口（DESIGN §7b + D18） ──

/**
 * agent 宣告「本任務無需改動」時，Worker 用這個前綴寫進 block detail。
 * InboundRouter 靠它（外加 `no_change_reported` 事件）判斷這張卡真的宣告過，
 * 才允許執行**不可逆**的 complete_task。
 */
export const NO_CHANGE_BLOCK_PREFIX = '無需改動';

/**
 * 「認領不回來」的封鎖前綴。
 *
 * 這一類要跟一般的 needs_human 分開，因為**解法不在這個系統裡**：
 * 任務板上那張卡還停在「進行中」，而 MCP 沒有取消認領的工具。
 * 人必須去任務板把它改回「待辦」，按這邊的重試永遠沒用（實跑：使用者按了 4 次）。
 */
export const RECLAIM_BLOCK_PREFIX = '認領不回來';

/** 分類的中文標籤（Slack 版型與稽核共用；worker.ts 的同名表可改用這份，避免兩邊漂移）。 */
export const NO_CHANGE_CATEGORY_LABEL: Record<NoChangeCategory, string> = {
  already_satisfied: '現況已符合需求',
  not_applicable: '任務描述與現況不符',
  blocked_externally: '缺外部依賴無法進行',
  spec_unclear: '規格不足以判斷',
};

/** 「這張卡不用做」的確認請求內容——人要靠 reason/evidence 判斷 agent 有沒有誤判。 */
export interface NoChangeConfirmInput {
  taskId: string;
  title?: string;
  category: NoChangeCategory;
  reason: string;
  /** agent 查證了什麼（讀了哪些檔案、既有實作在哪、指令輸出）。 */
  evidence?: string;
}

/** 支援「無需改動確認」的人機介面（SlackGateway / ConsoleGateway 皆實作）。 */
export interface NoChangeConfirmer {
  askNoChangeConfirmation(threadTs: string | undefined, input: NoChangeConfirmInput): Promise<void>;
}

/** 執行期判斷 notifier 有沒有這個能力（Worker 拿到的是較窄的 Notifier 型別）。 */
export function supportsNoChangeConfirmation(n: unknown): n is NoChangeConfirmer {
  return typeof (n as Partial<NoChangeConfirmer> | null)?.askNoChangeConfirmation === 'function';
}

/**
 * 安全地請人確認「無需改動」。呼叫端（Worker）不必知道 notifier 的實作：
 * 支援 → 貼出附按鈕的訊息並回 true；不支援或丟錯 → 回 false，呼叫端可退回既有的 problem 事件。
 */
export async function requestNoChangeConfirmation(
  notifier: unknown,
  threadTs: string | undefined,
  input: NoChangeConfirmInput,
  log?: Logger,
): Promise<boolean> {
  if (!supportsNoChangeConfirmation(notifier)) return false;
  try {
    await notifier.askNoChangeConfirmation(threadTs, input);
    return true;
  } catch (err) {
    // 通知失敗不能反過來影響任務處置（任務照樣 park，只是人少收到一則訊息）
    log?.warn({ err: String(err), taskId: input.taskId }, '貼出「無需改動」確認訊息失敗（已忽略）');
    return false;
  }
}

/** complete_task 的注入點（結構對映 contracts.McpTaskClient.completeTask）。 */
export type CompleteTaskFn = (taskId: string, opts?: { summary?: string }) => Promise<McpOut<void>>;

/**
 * 控制指令的附加脈絡。types.ts（唯讀）的 ControlCommand 沒有這些欄位，故在此擴充：
 *   - `userId`：誰下的指令，稽核用。
 *   - `source`：指令情境。目前只有 `no_change_rejected`——「你誤判了，請去做」沿用 retry
 *     的語意（回 queued 重跑），但要能和一般 retry 區分，否則稽核與後續回灌都分不出來。
 */
export interface ControlCommandMeta {
  userId?: string;
  source?: ControlCommandSource;
}
export type ControlCommandSource = 'no_change_rejected';

/**
 * InboundRouter 收得下的控制指令 = types.ts 的四種 + `confirm_no_change`（人工確認這張卡不用做）。
 * 舊的 ControlCommand 仍可直接傳入，呼叫端不需要改。
 */
export type ExtendedControlCommand = (ControlCommand | { type: 'confirm_no_change'; taskId: string }) &
  ControlCommandMeta;

/**
 * park（等人回覆）的群組狀態。與 core/group-runner.ts 的 PARKED_GROUP_STATE 同值；
 * 這裡不 import 是為了避免 notify → core 的反向相依（會造成循環）。
 */
const PARKED_STATE: GroupState = 'changes_requested';

// ── 入站路由（Slack → ledger） ──

/**
 * InboundRouter 需要的 ledger 子集（store/ledger.ts 的 Ledger 結構上即滿足）。
 * 用結構介面而非直接相依 Ledger，測試才能塞假件。
 */
export interface InboundLedger {
  /**
   * 現在有什麼在跑（心跳）。**跨行程唯一的「還活著」證據**——
   * CLI 與獨立控制台都是別的行程，拿不到 dispatcher。未實作 → 退化成不檢查。
   */
  listActivities?(): { refId?: string | null; heartbeatAt: number }[];
  /**
   * 開交接單（停手與說話是同一個寫入動作）。
   * 可選：測試假件不必實作；缺了只是少一張單，會被 pending 的兜底自檢撈到。
   */
  openHandoff?(input: Parameters<HandoffLedger['openHandoff']>[0]): string;
  listHandoffs?(q: { groupId?: string; kind?: string; toRole?: string; unconsumedOnly?: boolean; limit?: number }): unknown[];
  /** 可選：有哪些群在等這一群進 base（放行下游時要講得出放行了誰）。 */
  listGroupsBlockedBy?(groupId: string): string[];
  getTask(id: string): Task | undefined;
  getGroup(id: string): Group | undefined;
  setBlock(id: string, reason: BlockReason, detail?: string): void;
  clearBlock(id: string, nextState: TaskState): void;
  updateGroupState(id: string, state: GroupState, extra?: { prUrl?: string; prNumber?: number }): void;
  logEvent(scope: 'task' | 'group' | 'system', refId: string | null, kind: string, detail?: string): void;
  /**
   * 可選：clarifications 表（schema 已存在，但 Ledger 目前尚未開放寫入 API）。
   * 之後補上同名方法就會自動被採用；在那之前只寫 events 稽核表。
   */
  recordClarificationAnswer?(taskId: string, threadTs: string, answer: string): void;
  /** 可選：查最近一則事件（用來取回 agent 的 no_change 宣告內容做稽核／摘要）。 */
  latestEvent?(scope: 'task' | 'group' | 'system', refId: string | null, kind: string): { detail?: string } | undefined;
  /**
   * 可選：把交接單標成已處理。
   *
   * **人按了按鈕就等於處理過了**——不標的話那張單會永遠掛在「等你處理」上，
   * 而人會一直看到自己剛剛才按過的東西，最後不再相信那份清單。
   */
  consumeHandoffsFor?(q: { groupId?: string; taskId?: string; kind?: string; toRole?: string }): number;
  /** 可選：記一次「知道這個紅、照樣落地」的放行（一次性，見 Ledger.takeKnownRedWaiver）。 */
  grantKnownRedWaiver?(groupId: string, note: string, by: string): number;
}

/** 合併核准裁決（結構對映 slack/gateway.ts 的 MergeDecision，避免反向相依 Slack 模組）。 */
export interface InboundMergeDecision {
  /** 退回時的修改意見。沒有它，agent 不知道哪裡錯（見 handleMergeDecision）。 */
  reason?: string;
  groupId: string;
  approved: boolean;
  threadTs?: string;
  userId?: string;
}

/** 人機介面的入站掛勾子集（HumanGateway 結構上即滿足）。 */
export interface InboundHooks {
  onAnswer(cb: (a: ClarificationAnswer) => void): void;
  onControl(cb: (c: ExtendedControlCommand) => void): void;
  onMergeDecision(cb: (d: InboundMergeDecision) => void): void;
}

export interface InboundRouterDeps {
  ledger: InboundLedger;
  log: Logger;
  /**
   * 可選：把任務標成 done 的 MCP 呼叫（`confirm_no_change` 用）。
   * 沒注入 → 降級成「只在本機收尾 + 大聲 warn」，任務板上的卡不會被關掉。
   * main.ts 接線：`completeTask: (id, opts) => mcp.completeTask(id, opts)`。
   */
  completeTask?: CompleteTaskFn;
  /**
   * 審查意見暫存區。**必須與 ReviewWatcher／GroupRunner 共用同一個實例**，
   * 否則人在 Slack／CLI 退回時附的意見寫進去也沒有人讀得到。
   */
  feedback?: { save(input: { groupId: string; comments: string[]; source: FeedbackSource }): unknown };
}

/**
 * 把 Slack 入站事件落到 ledger 狀態上（DESIGN §7 澄清決策樹、§8 控制指令、§10 合併閘門）。
 *
 * **目前的完成度**（其餘留待後續里程碑，見各方法註解）：
 *   - 答覆/控制指令 → 更新任務狀態 + 寫 events 稽核表，任務因此回到 queued，
 *     下一輪主控迴圈會重新派工。
 *   - **尚未實作**：把答案直接注入 agent session 並就地 resume（需 Worker 端支援
 *     帶著 pendingAnswer 續跑同一個 session），現在的做法是整個任務重跑一輪；
 *     以及中斷「進行中」的 worker（目前沒有取消權杖，指令只在下次派工時生效）。
 *
 * 所有處理都不擲例外：Slack 回呼裡丟錯只會污染 log，不該影響 daemon。
 */
export class InboundRouter {
  constructor(private deps: InboundRouterDeps) {}

  /** 掛上人機介面的三個入站回呼。 */
  attach(gateway: InboundHooks): void {
    gateway.onAnswer((a) => this.handleAnswer(a));
    // handleControl 因 confirm_no_change 需要 await MCP 而非同步；回呼不等待，錯誤由 guardAsync 吞下
    gateway.onControl((c) => void this.handleControl(c));
    gateway.onMergeDecision((d) => this.handleMergeDecision(d));
    this.deps.log.info('入站互動已接線（澄清答覆 / 控制指令 / 合併裁決）');
  }

  /** 澄清答覆：記錄答案並解除 blocked:needs_clarification，讓任務回到排隊。 */
  handleAnswer(a: ClarificationAnswer): void {
    this.guard('onAnswer', () => {
      const { ledger, log } = this.deps;
      const task = ledger.getTask(a.taskId);
      if (!task) {
        log.warn({ taskId: a.taskId, threadTs: a.threadTs }, '收到澄清答覆，但 ledger 沒有這個任務（忽略）');
        return;
      }
      const answer = a.optionId ?? a.freeText ?? '';
      ledger.logEvent('task', a.taskId, 'clarification_answer', JSON.stringify({ threadTs: a.threadTs, answer }));
      ledger.recordClarificationAnswer?.(a.taskId, a.threadTs, answer);

      // **「以後都這樣」的答覆掛到 repo 上，不是掛到這張卡上。**
      //
      // 實跑：`spec/ 寫不進去` 在 02:43 害了一個任務、17:44 又原封不動害了另一個
      // ——同一個 repo、同一個成因、相隔 14 小時。就算第一次有人回答了，
      // 那個答案也只存在於第一張卡的事件裡，第二張卡看不到，於是重問一次、重卡一次。
      if (a.scope === 'always') {
        const question = latestQuestion(ledger, a.taskId);
        ledger.logEvent('system', task.repo, STANDING_DECISION, JSON.stringify({ question, answer, fromTask: a.taskId }));
        log.warn({ repo: task.repo, taskId: a.taskId, answer }, '📌 這個答覆已設為常設決定，之後同一個 repo 的任務都會看到');
      }

      if (task.state === 'blocked' && task.block?.reason === 'needs_clarification') {
        // 回 queued 而不是就地續跑：worker slot 已經釋放，重新排隊才拿得到執行資源。
        // 真正的續跑在 Worker：它會讀出上面這筆 clarification_answer 事件、
        // 注入 prompt，並 resume 原本的 session（見 human-reply.ts）。
        ledger.clearBlock(a.taskId, 'queued');
        log.info({ taskId: a.taskId, answer }, '✅ 已收到澄清答覆 → 任務回到 queued，續跑時會接回原 session');
      } else {
        log.warn({ taskId: a.taskId, state: task.state }, '收到澄清答覆，但任務不在等待澄清狀態（只記錄）');
      }
    });
  }

  /**
   * 控制指令：pause/abort → park；retry/use_default → 回 queued 重排；
   * confirm_no_change → 人工確認「這張卡不用做」→ complete_task + 標 done。
   *
   * 非同步只為了 confirm_no_change 要 await MCP；其餘指令在第一個 await 之前就寫完 ledger，
   * 呼叫端不 await 也拿得到同步的效果（既有行為不變）。
   */
  async handleControl(c: ExtendedControlCommand): Promise<void> {
    await this.guardAsync('onControl', async () => {
      const { ledger, log } = this.deps;
      const task = ledger.getTask(c.taskId);
      if (!task) {
        log.warn({ taskId: c.taskId, type: c.type }, '收到控制指令，但 ledger 沒有這個任務（忽略）');
        return;
      }
      ledger.logEvent('task', c.taskId, `control:${c.type}`, `state=${task.state}${c.userId ? ` by=${c.userId}` : ''}`);
      if (task.state === 'done') {
        log.warn({ taskId: c.taskId, type: c.type }, '任務已完成，控制指令不生效');
        return;
      }

      switch (c.type) {
        case 'pause':
        case 'abort':
          // needs_human：不會被 reconciler 當成崩潰殘留自動重排，必須由人再下 retry
          ledger.setBlock(c.taskId, 'needs_human', c.type === 'pause' ? '使用者要求暫停' : '使用者要求中止');
          break;
        case 'confirm_no_change':
          await this.confirmNoChange(c, task);
          return; // 自帶結果 log，不走下面那行通用訊息
        case 'retry':
        case 'use_default':
          if (c.source === 'no_change_rejected') {
            // 「你誤判了，請去做」：狀態轉移與一般 retry 相同，但要留下可區分的稽核，
            // 之後才能回灌給 agent（否則它下一輪很可能再宣告一次 no_change）
            ledger.logEvent('task', c.taskId, 'no_change_rejected', JSON.stringify({ userId: c.userId ?? null }));
            log.info({ taskId: c.taskId, userId: c.userId }, '↩️ 人否決了「無需改動」宣告 → 任務回 queued 重做');
          }
          ledger.clearBlock(c.taskId, 'queued');
          break;
      }
      // 進行中的 worker 沒有取消權杖，指令要等這一輪跑完才會反映在派工上
      log.info({ taskId: c.taskId, type: c.type }, '🎛 控制指令已寫入 ledger（進行中的 worker 不會被即時中斷）');
    });
  }

  /**
   * 把一個 failed 的群組放回待派工。
   *
   * 為什麼需要一個群組層級的動作：`retry` 做的是 `clearBlock(taskId, 'queued')`，
   * 那對「任務都 done、只是收尾失敗」的群組完全無效——而那正是最常見的 failed 形態
   * （Merge Guard 擋下、開 PR 失敗、工作區不見）。實跑撞到：待處理清單提供 retry，
   * 按了什麼都沒發生，群組永遠躺在 failed。
   *
   * 復活＝把群組轉回 ready 讓 Dispatcher 重新派。任務維持 done，所以 agent 不會重跑，
   * 只會走收尾流程（開 PR / Merge Guard）——那正是失敗的地方。
   *
   * @returns 是否真的復活了（群組不存在或不是 failed 就不動，回 false）
   */
  /** 這一群現在有沒有東西在跑（心跳還新的活動列）。 */
  private liveNow(g: { id: string; taskIds: string[] }): boolean {
    const acts = this.deps.ledger.listActivities?.() ?? [];
    const now = Date.now();
    return acts.some((a) => now - a.heartbeatAt < LIVE_ACTIVITY_MS
      && (a.refId === g.id || g.taskIds.includes(a.refId ?? '')));
  }

  async reviveGroup(input: { groupId: string; userId?: string }): Promise<boolean> {
    const { ledger, log } = this.deps;
    const g = ledger.getGroup?.(input.groupId);
    if (!g) {
      log.warn({ groupId: input.groupId }, '要復活的群組不存在');
      return false;
    }
    // **能開單的狀態就要復活得了。** 先前這裡只認 `failed`，而清單對
    // changes_requested / merge_guard 也會給重試按鈕——按下去必定回
    // 「無法復活這個群組」，而群組好端端地在那裡（實跑：使用者連按數次）。
    if (!isStuckGroupState(g.state)) {
      log.info({ groupId: input.groupId, state: g.state }, '群組不在停手狀態，不需要復活');
      return false;
    }
    // **forming 有兩張臉**：真的在跑（agent 正在寫程式）／runner 死了。
    // 對「真的在跑」的群改狀態會把它從 dispatcher 手上搶走，已寫好但還沒 commit 的成果就沒了，
    // 而人只會看到「重試成功」。開機會清掉殘留的活動列，所以不會把死掉的誤判成活著。
    if (this.liveNow(g)) {
      log.warn({ groupId: g.id, state: g.state }, '這一群現在正在跑，不搶它的狀態（等它停下來再按）');
      return false;
    }
    ledger.updateGroupState(input.groupId, 'ready');
    ledger.logEvent('group', input.groupId, 'group_revived', `由 ${input.userId ?? 'unknown'} 手動復活`);
    // **按過的東西要從清單上消失。** landAnyway 有做這件事，這裡先前沒有——
    // 於是按了重試、群組確實回到待派工，但那張單還掛著，人會再按一次、再一次。
    ledger.consumeHandoffsFor?.({ groupId: input.groupId, toRole: 'human', kind: 'stuck_group' });
    log.info({ groupId: input.groupId, userId: input.userId }, '♻️ 群組已復活，回到待派工');
    return true;
  }

  /**
   * 「我知道這個紅，但它不是這一群造成的，照樣落地」（定案③）。
   *
   * ── 為什麼需要這顆按鈕 ──
   *
   * 系統**沒有修 base 的權力**。合併者做完實驗、裁定「這是 base 的測試本來就不穩」
   * 之後，這一群依然落不了地——會累積一批「已裁定非我方責任、但卡著」的群，
   * 堵住的張數與誤判時一模一樣，只是這次系統是對的。
   *
   * 這是**人的決定**（要不要帶著一個已知的紅上線）。系統的職責是把證據攤在面前、
   * 按完之後留下痕跡，不是替人決定、也不是無限期堵著等人自己想起來。
   *
   * 「留下痕跡」具體是：理由寫進 ledger（PR 內文會引用），
   * 而且**那張交接單被標成已處理**——否則它會永遠掛在「等你處理」上。
   */
  async landAnyway(input: { groupId: string; userId?: string; note: string }): Promise<boolean> {
    const { ledger, log } = this.deps;
    const g = ledger.getGroup?.(input.groupId);
    if (!g) {
      log.warn({ groupId: input.groupId }, '要落地的群組不存在');
      return false;
    }
    const note = input.note.trim();
    if (note === '') {
      log.warn({ groupId: input.groupId }, '「照樣落地」沒有附理由，拒絕');
      return false;
    }
    // 記在 ledger 的是**一次性放行**，不是永久豁免：守衛下一輪紅的時候會把它用掉，
    // 用掉之後這一群就恢復正常把關。詳見 Ledger.takeKnownRedWaiver 的說明。
    if (!ledger.grantKnownRedWaiver) {
      log.warn({ groupId: input.groupId }, '這個 ledger 沒有放行機制，「照樣落地」無效');
      return false;
    }
    ledger.grantKnownRedWaiver(input.groupId, note, input.userId ?? 'unknown');
    // 回到待派工：收尾流程（開 PR / 合併）會重跑，而人已經表態接受那個紅
    ledger.updateGroupState(input.groupId, 'ready');
    ledger.consumeHandoffsFor?.({ groupId: input.groupId, toRole: 'human', kind: 'stuck_group' });
    log.warn({ groupId: input.groupId, userId: input.userId, note }, '⚠️ 人已表態：帶著已知的紅落地（一次性，用掉就恢復把關）');
    return true;
  }

  /**
   * 人表態：**這個上游不會進 base 了，讓等它的群往前走。**
   *
   * `closed`（沒有東西要交付）是終態、永遠不會 merged，而兩個依賴判斷點都只認 merged
   * ⇒ 等它的群會永遠排下去，畫面上還長得跟正常排隊一樣。這顆按鈕是唯一的出口。
   *
   * 為什麼不自動放行：`closed` 的意思是「群內任務都判定不需要改動」——agent 判的是
   * **它自己那張卡**不用改，不是「下游的前提成立」。後者要看懂下游想做什麼再對照 base，
   * 那是判斷不是資料。自動放行 ＝ 讓下游在沒人確認過的前提上開工，而它的 DoD 會全綠。
   */
  async releaseDeps(input: { groupId: string; userId?: string; reason?: string }): Promise<boolean> {
    const { ledger, log } = this.deps;
    const g = ledger.getGroup?.(input.groupId);
    if (!g) {
      log.warn({ groupId: input.groupId }, '要放行的群組不存在');
      return false;
    }
    // merged 本來就通了；放行它只會讓事後查帳多一筆讀不懂的紀錄
    if (g.state === 'merged') {
      log.info({ groupId: input.groupId }, '這一群已經進 base，不需要放行');
      return false;
    }
    const blocked = ledger.listGroupsBlockedBy?.(input.groupId) ?? [];
    releaseDeps(ledger, {
      groupId: input.groupId,
      state: g.state,
      blocked,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
    // 按過的東西要從清單上消失，否則人會一直看到它、一直再按一次
    ledger.consumeHandoffsFor?.({ groupId: input.groupId, toRole: 'human', kind: 'stuck_group' });
    log.warn({ groupId: input.groupId, state: g.state, blocked, userId: input.userId }, '⚠️ 人已放行：下游不再等這個上游');
    return true;
  }

  /**
   * 人工確認「這張卡確實不用做」→ complete_task（**不可逆**）→ 標 done。
   *
   * D18（誤殺）在這裡是反過來的：真正危險的是「誤按」而不是「漏抓」，所以先驗證
   * 這張卡真的有 no_change 宣告、且正停在等人確認的狀態，才動不可逆的操作。
   * 同時也不能矯枉過正——卡片被 reconciler 重排回 queued 後仍要能確認，否則人又卡住。
   */
  private async confirmNoChange(c: ExtendedControlCommand, task: Task): Promise<void> {
    const { ledger, log } = this.deps;
    const report = this.readNoChangeReport(c.taskId);
    const declared = report !== undefined || (task.block?.detail?.startsWith(NO_CHANGE_BLOCK_PREFIX) ?? false);
    if (!declared) {
      log.warn(
        { taskId: c.taskId, state: task.state },
        '⚠️ 這張卡沒有「無需改動」的宣告紀錄 → 不執行不可逆的結案（如果真的要關掉它，請在任務板上處理）',
      );
      return;
    }
    // in_progress 代表 worker 正在跑：此時標 done 會和它的寫入打架，等它 park 完再確認
    if (task.state !== 'blocked' && task.state !== 'queued') {
      log.warn({ taskId: c.taskId, state: task.state }, '⚠️ 任務不在「等人確認」的狀態，暫不結案（避免蓋掉進行中的工作）');
      return;
    }

    const summary = report
      ? `${NO_CHANGE_CATEGORY_LABEL[report.category] ?? report.category}：${report.reason}`
      : (task.block?.detail ?? NO_CHANGE_BLOCK_PREFIX);
    const audit = JSON.stringify({
      userId: c.userId ?? null,
      category: report?.category ?? null,
      reason: report?.reason ?? null,
      confirmedAt: Date.now(),
    });

    const complete = this.deps.completeTask;
    if (!complete) {
      // 刻意**不**在本機標 done：ledger 說完成、任務板上卻還開著，會讓下游任務的
      // start_task 被 MCP 以「依賴未完成」擋下（D2/D3），變成無解的不一致——
      // 而且人會以為處理好了。維持 needs_human 並把狀況寫進 detail，比假裝完成安全。
      ledger.setBlock(
        c.taskId,
        'needs_human',
        `${NO_CHANGE_BLOCK_PREFIX}（已人工確認，但無法呼叫 complete_task：未接線 MCP）`,
      );
      ledger.logEvent('task', c.taskId, 'no_change_confirm_unwired', audit);
      log.error(
        { taskId: c.taskId, userId: c.userId },
        '❌ 已收到「確認無需改動」，但沒有可用的 MCP 連線 → 任務維持等待處理（不假裝完成）。' +
          '請確認 config/projects.yaml 的 MCP 設定可連線後再試一次，或自行到任務板關閉該卡。',
      );
      return;
    }

    const out = await complete(c.taskId, { summary: `人工確認無需改動 — ${summary}` });
    if (!out.ok) {
      // 失敗要留在 needs_human：不能假裝完成，也不能回 queued 讓 agent 又跑一輪 no_change
      ledger.setBlock(c.taskId, 'needs_human', `${NO_CHANGE_BLOCK_PREFIX}（已確認，但 complete_task 失敗：${out.detail}）`);
      ledger.logEvent('task', c.taskId, 'no_change_confirm_failed', out.detail);
      log.error({ taskId: c.taskId, detail: out.detail }, '❌ 確認「無需改動」後 complete_task 失敗 → 維持等人處理，可再按一次確認');
      return;
    }
    ledger.clearBlock(c.taskId, 'done');
    ledger.logEvent('task', c.taskId, 'no_change_confirmed', audit);
    log.info({ taskId: c.taskId, userId: c.userId, summary }, '✅ 人工確認「無需改動」→ 已 complete_task 並標 done（不可逆）');
  }

  /** 取回 agent 當初的 no_change 宣告（Worker 寫的 `no_change_reported` 事件）。 */
  private readNoChangeReport(taskId: string): { category: NoChangeCategory; reason: string; evidence?: string } | undefined {
    const detail = this.deps.ledger.latestEvent?.('task', taskId, 'no_change_reported')?.detail;
    if (!detail) return undefined;
    try {
      const parsed: unknown = JSON.parse(detail);
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const o = parsed as Record<string, unknown>;
      if (typeof o.category !== 'string' || typeof o.reason !== 'string') return undefined;
      return {
        category: o.category as NoChangeCategory,
        reason: o.reason,
        ...(typeof o.evidence === 'string' ? { evidence: o.evidence } : {}),
      };
    } catch {
      return undefined; // 事件格式壞掉不該擋住人工確認（後面還有 block detail 這個備援）
    }
  }

  /** 合併裁決：核准 → merge_guard；退回 → changes_requested。 */
  handleMergeDecision(d: InboundMergeDecision): void {
    this.guard('onMergeDecision', () => {
      const { ledger, log } = this.deps;
      const group = ledger.getGroup(d.groupId);
      if (!group) {
        log.warn({ groupId: d.groupId }, '收到合併裁決，但 ledger 沒有這個群組（忽略）');
        return;
      }
      // 誤按防護：park 中的群（等人回覆澄清／審查意見）**不是**在等合併核准。
      // 把它推到 merge_guard 會讓 shouldRequeueGroup 永遠不成立 ⇒ 那些未提交的成果
      // 再也無法恢復。核准是不可逆方向的操作，寧可拒絕也不要毀掉可恢復狀態。
      if (d.approved && group.state === PARKED_STATE) {
        log.warn(
          { groupId: d.groupId, state: group.state },
          '⚠️ 這個群組正在等人回覆（park），不是等合併核准 — 已忽略此次核准以免毀掉可恢復狀態',
        );
        ledger.logEvent('group', d.groupId, 'merge_approval_ignored_parked', d.userId ?? '');
        return;
      }

      // **退回也要守門。** approve 上面有守門、reject 先前完全沒有：
      // Slack 上一則舊訊息的「退回」會把**已經 merged** 的群拉回 changes_requested，
      // 而那是一個沒有出口的狀態（任務全 done、有 PR、無意見 → 每輪 warnOnce）。
      const REJECTABLE: GroupState[] = ['in_review', 'merge_guard', 'pr_open'];
      if (!d.approved && !REJECTABLE.includes(group.state)) {
        log.warn({ groupId: d.groupId, state: group.state }, '⚠️ 這個群組現在不在等審查／等合併，已忽略此次退回');
        ledger.logEvent('group', d.groupId, 'merge_reject_ignored_state', group.state);
        return;
      }

      const next: GroupState = d.approved ? 'merge_guard' : 'changes_requested';
      ledger.updateGroupState(d.groupId, next);
      ledger.logEvent('group', d.groupId, d.approved ? 'merge_approved' : 'merge_rejected', d.userId ?? '');

      // **人回答了，那張單當場結案**——不是等狀態變化。
      //
      // 核准會把群組推進 merge_guard，而 updateGroupState 的規則是「離開
      // in_review／merge_guard 才消化」——正好不涵蓋這一步。於是按完之後
      // 「待核准合併」還掛在清單上，按鈕也還在，人很自然會再按一次。
      //
      // 實跑（2026-08-05）：同一群被連按兩次 ×2 輪（13:42:16/20、14:37:17/30）。
      // 而真正動手要等下一輪 tick（預設 180 秒），期間畫面完全沒有變化——
      // 從人的角度就是「點了沒反應」。
      ledger.consumeHandoffsFor?.({ groupId: d.groupId, toRole: 'human', kind: 'merge_approval' });

      // 退回**必須帶意見**，否則 agent 只知道「被退回」卻不知道哪裡錯——
      // 下一輪多半原封不動再送一次，人再退一次，形成純燒錢的迴圈。
      // 意見寫進與 ReviewWatcher 共用的 ReviewFeedbackStore，GroupRunner 會把它交給 agent。
      if (!d.approved) {
        const reason = (d.reason ?? '').trim();
        if (reason !== '') {
          this.deps.feedback?.save({ groupId: d.groupId, comments: [reason], source: 'human_reject' });
          ledger.logEvent('group', d.groupId, 'review_feedback_human', reason);
          log.info({ groupId: d.groupId }, '↩️ 已退回並附上修改意見（下一輪會回灌給 agent）');
        } else {
          // ── 沒有意見的退回是合法的（「先停下來」），但它會掉進一個沒有出口的狀態 ──
          //
          // 任務全 done ＋ 有 PR ＋ 沒有可回灌的意見 ⇒ orchestrator 每一輪只會 warnOnce
          // 然後跳過，永遠不動。而控制台的退回鈕**結構上帶不了理由**（見 server.ts），
          // 所以每一次從控制台退回都必定走這一條。
          //
          // 不要「沒理由就存一則空意見叫 agent 盲改」——那是程式替人決定「沒說＝去盲改」，
          // 而盲改的下場已知：agent 多半一行不改，撞上「重做後零變更」再 park 一次。
          log.warn({ groupId: d.groupId }, '↩️ 已退回但沒有附意見：沒有人會自動動它，已列進「等你處理」');
          ledger.logEvent('group', d.groupId, 'review_rejected_no_reason', d.userId ?? '');
          // 假件 ledger 可能沒有 openHandoff（測試）；缺了只是少一張單，不擋流程
          if (ledger.openHandoff) openStuckGroupHandoff(ledger as HandoffLedger, log, {
            groupId: group.id,
            repo: group.repo,
            // **不給「照樣落地」**：這個情境沒有紅燈可放行，那顆鈕在這裡沒有意義
            options: ['retry'],
            why: '你退回了這一群，但沒有留下要改什麼。agent 不知道要改哪裡，'
              + '現在沒有任何人在動它（成果、分支、PR 都還在）。\n'
              + '· 按「重試」＝原樣送回合併流程（會重跑守衛與風險判斷）。\n'
              + '· 要 agent 動手改：請用附理由的退回。',
          });
        }
      }

      // **核准憑證要寫進 ledger**（D17：狀態不等於核准，但憑證必須是持久的）。
      // 只放在 Orchestrator 的記憶體裡的話，CLI 與獨立控制台是另一個行程，
      // 它們的核准永遠傳不到 daemon——人以為核准了，實際什麼都不會發生。
      if (d.approved) {
        ledger.logEvent('group', d.groupId, MERGE_CREDENTIAL_EVENT, JSON.stringify({
          approvedBy: `human:${d.userId ?? 'unknown'}`,
          source: 'human',
        }));
      } else {
        ledger.logEvent('group', d.groupId, MERGE_CREDENTIAL_CLEARED_EVENT, 'rejected');
      }
      // 尚未實作：目前 GroupRunner 在群跑完時就地執行 Merge Guard，
      // 還沒有「消費 merge_guard 狀態群組」的排程器，所以這裡只落狀態等後續里程碑接手。
      log.info({ groupId: d.groupId, approved: d.approved, next }, '🔐 合併裁決已寫入 ledger');
    });
  }

  private guard(name: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.deps.log.error({ err: String(err), handler: name }, '入站事件處理失敗（已吞下，不影響 daemon）');
    }
  }

  /** guard 的非同步版：MCP 呼叫 reject 也不能變成 unhandled rejection。 */
  private async guardAsync(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.deps.log.error({ err: String(err), handler: name }, '入站事件處理失敗（已吞下，不影響 daemon）');
    }
  }
}

/**
 * 取這個任務最後一次提問的內容（常設決定要連問題一起記，否則只剩一句沒有上下文的答案）。
 * 取不到就用佔位字串——有答案總比什麼都沒有好。
 */
function latestQuestion(
  ledger: { latestEvent?(scope: 'task', refId: string, kind: string): { detail?: string } | undefined },
  taskId: string,
): string {
  const e = ledger.latestEvent?.('task', taskId, 'clarification_asked');
  if (!e?.detail) return '（原問題已不可考）';
  try {
    const j = JSON.parse(e.detail) as { question?: unknown };
    return typeof j.question === 'string' ? j.question : e.detail;
  } catch {
    return e.detail;
  }
}
