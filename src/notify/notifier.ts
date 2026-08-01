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
import type { FeedbackSource } from '../pr/review-watcher.js';

/** 事件轉為簡短中文摘要（Slack 與 console 共用文案）。 */
export function summarizeEvent(e: LifecycleEvent): string {
  switch (e.type) {
    case 'claimed': return '🟡 已認領';
    case 'docs_read': return `📖 已讀規格：${e.refs.join(', ') || '（無）'}`;
    case 'iterating': return `🔧 實作中（第 ${e.round} 輪）`;
    case 'stalled': return `⚠️ 卡在同一處（結果簽章多輪未改善）`;
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
  async reviveGroup(input: { groupId: string; userId?: string }): Promise<boolean> {
    const { ledger, log } = this.deps;
    const g = ledger.getGroup?.(input.groupId);
    if (!g) {
      log.warn({ groupId: input.groupId }, '要復活的群組不存在');
      return false;
    }
    if (g.state !== 'failed') {
      log.info({ groupId: input.groupId, state: g.state }, '群組不是 failed，不需要復活');
      return false;
    }
    ledger.updateGroupState(input.groupId, 'ready');
    ledger.logEvent('group', input.groupId, 'group_revived', `由 ${input.userId ?? 'unknown'} 手動復活`);
    log.info({ groupId: input.groupId, userId: input.userId }, '♻️ 群組已復活，回到待派工');
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

      const next: GroupState = d.approved ? 'merge_guard' : 'changes_requested';
      ledger.updateGroupState(d.groupId, next);
      ledger.logEvent('group', d.groupId, d.approved ? 'merge_approved' : 'merge_rejected', d.userId ?? '');

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
          // 沒有意見的退回是合法的（「先停下來」），但要講清楚後果
          log.warn({ groupId: d.groupId }, '↩️ 已退回但沒有附意見：agent 不會知道要改什麼，重派後很可能原樣再送一次');
          ledger.logEvent('group', d.groupId, 'review_rejected_no_reason', d.userId ?? '');
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
