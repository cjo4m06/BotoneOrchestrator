import type { TaskCardStatus } from '../contracts.js';
import type { BlockReason, GroupState, TaskState } from '../types.js';
import { NO_CHANGE_BLOCK_PREFIX } from '../notify/notifier.js';

/**
 * ledger 狀態 → 任務卡狀態。
 *
 * 為什麼要集中推導，而不是在每個通知點手動呼叫更新：
 * 光是會寫進 thread 的事件點就有二十幾個，逐一手動接線的話漏掉一個就是一段
 * 靜默的空白——而「卡片停著不動」與「系統卡住了」在人眼裡是一樣的。
 * 實際稽核就發現十二個點只寫了 thread、卡片完全沒動，連 merged 都漏了。
 *
 * 集中推導之後，只要 ledger 的狀態是對的，卡片就一定是對的。
 */
export interface CardStatusInput {
  taskState: TaskState;
  blockReason?: BlockReason;
  groupState?: GroupState;
  /** block 的細節文字；用來分辨「無需改動待確認」與一般的等人處理。 */
  blockDetail?: string;
}


export function cardStatusOf(input: CardStatusInput): TaskCardStatus {
  const { taskState, blockReason, groupState } = input;

  // 群層的終態優先：任務個別完成了，但群組被擋下／失敗時，人要看到的是群組的狀況
  if (groupState === 'merged') return 'merged';
  if (groupState === 'failed') return 'failed';
  if (groupState === 'changes_requested') return 'reworking';
  if (groupState === 'merge_guard') return 'merge_checking';

  // 受阻：**要分得出在等誰**。等人和等上游任務是完全不同的兩件事，
  // 混在一起的話人會去看一個其實不需要他動手的卡片。
  if (taskState === 'blocked') {
    if (blockReason === 'needs_clarification') return 'awaiting_reply';
    if (blockReason === 'deps') return 'blocked_deps';
    // 「不用做」的確認與一般的等人處理，按鈕完全不同（前者會呼叫不可逆的 complete_task）
    if (input.blockDetail?.startsWith(NO_CHANGE_BLOCK_PREFIX)) return 'awaiting_no_change';
    return 'awaiting_human';
  }

  if (taskState === 'verifying') return 'verifying';

  if (taskState === 'done') {
    if (groupState === 'in_review') return 'awaiting_merge';
    if (groupState === 'pr_open') return 'pr_open';
    return 'done';
  }

  return 'working';
}

/** 推導卡片狀態所需的最小 ledger 介面（只讀，方便測試替身）。 */
export interface CardLedgerView {
  getTask(id: string): { state: TaskState; groupId?: string; block?: { reason: BlockReason; detail?: string } } | undefined;
  getGroup(id: string): { state: GroupState } | undefined;
}

export interface CardSyncTarget {
  updateTaskCard?: (taskId: string, status: TaskCardStatus, extra?: { groupId?: string; prompt?: string }) => unknown;
}

/**
 * 依 ledger 的真實狀態，把單一任務的卡片同步到位。
 *
 * 抽出來共用，是因為呼叫點有兩處且**不能只有一處**：群組流程的批次同步，
 * 以及 ledger 狀態變更時的即時同步。先前只有前者，於是像 `verifying` 這種
 * 「改了狀態就立刻去做耗時工作、中間不發任何事件」的狀態，卡片永遠來不及顯示——
 * 實跑時「🔵 驗證中」一次都沒出現過。
 *
 * 完全不擲錯：畫卡片失敗絕不該影響任何實際工作。
 */
export function syncTaskCard(
  ledger: CardLedgerView,
  target: CardSyncTarget,
  taskId: string,
  onError: (err: unknown) => void,
): void {
  try {
    const update = target.updateTaskCard;
    if (!update) return;
    const task = ledger.getTask(taskId);
    if (!task) return;
    const group = task.groupId ? ledger.getGroup(task.groupId) : undefined;
    const status = cardStatusOf({
      taskState: task.state,
      ...(task.block?.reason ? { blockReason: task.block.reason } : {}),
      ...(group ? { groupState: group.state } : {}),
      ...(task.block?.detail ? { blockDetail: task.block.detail } : {}),
    });
    void Promise.resolve(
      update.call(target, taskId, status, {
        ...(task.groupId ? { groupId: task.groupId } : {}),
        // 問題／理由要顯示在卡片上，人才不必去 thread 裡翻
        ...(task.block?.detail ? { prompt: task.block.detail } : {}),
      }),
    ).catch(onError);
  } catch (e) {
    onError(e);
  }
}
