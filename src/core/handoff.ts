import { NO_CHANGE_BLOCK_PREFIX, RECLAIM_BLOCK_PREFIX } from '../notify/notifier.js';
import type { HandoffInput, HandoffKind, HandoffRole } from '../store/ledger.js';
import type { BlockReason } from '../types.js';
import type { Logger } from '../observability/logger.js';

/**
 * 停手交人時開一張交接單。
 *
 * ── 為什麼要有這個模組 ──
 *
 * **停手與說話必須是同一個寫入動作。** 先前那是兩件要「記得同步」的事：
 * 一邊 `setBlock` 把任務標成受阻，另一邊靠 `collectPending` 從「狀態 + 事件」
 * **推論**出「誰在等人」。推論綁在一張寫死的清單上，漏一項就是一次靜默——
 * 實跑撞到：兩個群耗盡重試停在 `changes_requested`、16 個任務堵著，
 * 而控制台顯示「沒有需要你處理的事項」。
 *
 * 換成交接單之後，「等人」是一條 `to_role='human' AND consumed_at IS NULL` 的查詢。
 * 推論會漏，查詢不會。
 *
 * ── 這個模組刻意只做映射 ──
 *
 * 它決定的是**這張單要畫哪一組按鈕**（`kind` 路由碼），不是「這件事為什麼發生」。
 * 成因、判斷內容、該怎麼辦一律在 `body` 裡，程式不讀也不解析。
 */

/** 開單需要的 ledger 子集（只宣告真正用到的，方便測試注入）。 */
export interface HandoffLedger {
  openHandoff(input: HandoffInput): string;
}

/**
 * 一個受阻的任務要開哪一種交接單。`undefined` ＝ **不開**。
 *
 * `deps` 回 undefined 是關鍵：那是**自動等待**（上游任務還沒做完），不是要人處理的事。
 * 把它寫成單會讓待處理清單被灌爆，人就再也分不出哪幾件真的需要自己動手。
 */
export function handoffKindOfBlock(reason: BlockReason | undefined, detail: string): HandoffKind | undefined {
  if (reason === 'needs_clarification') return 'clarification';
  if (reason !== 'needs_human') return undefined; // 含 'deps'：自動等待，不是交人
  // 這兩個前綴是既有的約定（見 notifier）。它們的按鈕組完全不同：
  // no_change 是「確認／退回」，reclaim_blocked 是「去任務板改狀態」（按重試永遠沒用）。
  if (detail.startsWith(NO_CHANGE_BLOCK_PREFIX)) return 'no_change';
  if (detail.startsWith(RECLAIM_BLOCK_PREFIX)) return 'reclaim_blocked';
  return 'needs_human';
}

/** 各 kind 對應的動作組（UI 靠 kind 路由，這裡是唯一的定義）。 */
export const HANDOFF_ACTIONS: Record<HandoffKind, string[]> = {
  clarification: ['<你的答案>', '--default', 'abort'],
  no_change: ['confirm', 'reject'],
  needs_human: ['retry', 'abort'],
  // 解法**不在這個系統裡**：任務板上那張卡還停在「進行中」，而 MCP 沒有取消認領的工具。
  // 人必須去任務板改回「待辦」，在這邊按重試永遠沒用（實跑：使用者按了 4 次）。
  reclaim_blocked: [],
  merge_approval: ['approve', 'deny'],
  stuck_group: ['retry'],
  review_feedback: [],
  delivery: [],
};

export interface BlockHandoffInput {
  taskId: string;
  groupId?: string;
  title: string;
  reason: BlockReason | undefined;
  detail: string;
  fromRole?: HandoffRole;
  /** 不處理會怎樣（給人判斷優先序）。 */
  ifIgnored?: string;
}

/**
 * 任務受阻 → 開一張給人的交接單。回傳單號；不需要開單時回 undefined。
 *
 * **絕不往外冒。** 開單失敗（例如說明是空的）不該讓 `setBlock` 之後的流程倒——
 * 但一定留 warn：靜默失敗會讓「清單上沒有」看起來像「沒事發生」，
 * 而那正是這整套要修掉的病。
 */
export function openBlockHandoff(
  ledger: HandoffLedger,
  log: Logger,
  input: BlockHandoffInput,
): string | undefined {
  const kind = handoffKindOfBlock(input.reason, input.detail);
  if (!kind) return undefined;
  try {
    return ledger.openHandoff({
      taskId: input.taskId,
      ...(input.groupId ? { groupId: input.groupId } : {}),
      fromRole: input.fromRole ?? 'coder',
      toRole: 'human',
      kind,
      title: input.title,
      // body 不可為空（ledger 會擲錯）。detail 空的時候用 title 兜底——
      // 開不出單比「開一張沒有說明的單」更糟：前者是靜默，後者至少看得見。
      body: input.detail.trim() || input.title,
      options: HANDOFF_ACTIONS[kind],
      ...(input.ifIgnored ? { ifIgnored: input.ifIgnored } : {}),
    });
  } catch (e) {
    log.warn(
      { taskId: input.taskId, kind, err: e instanceof Error ? e.message : String(e) },
      '開交接單失敗（任務照樣受阻，但清單上會看不到）',
    );
    return undefined;
  }
}

/**
 * 群組等人核准合併 → 開一張單。
 *
 * **這一條先前完全不掛任何事件**——`merge_approval` 是從群組狀態 `in_review` 推出來的，
 * 而它是三個介面上唯一的核准入口。換成查詢式清單時漏掉這個產生端，
 * 所有需要核准的群會永遠停在 in_review，沒有錯誤、沒有 log。
 */
export function openMergeApprovalHandoff(
  ledger: HandoffLedger,
  log: Logger,
  input: { groupId: string; title: string; why: string; taskIds: string[]; prUrl?: string },
): string | undefined {
  try {
    return ledger.openHandoff({
      groupId: input.groupId,
      fromRole: 'merger',
      toRole: 'human',
      kind: 'merge_approval',
      title: input.title,
      body: input.why.trim() || '等待人工核准合併',
      options: HANDOFF_ACTIONS.merge_approval,
      ifIgnored: `這一群的 ${input.taskIds.length} 個任務會停在這裡，下游等它進 base 的群也不會開工。`,
      ...(input.prUrl ? { evidence: [input.prUrl] } : {}),
    });
  } catch (e) {
    log.warn(
      { groupId: input.groupId, err: e instanceof Error ? e.message : String(e) },
      '開合併核准交接單失敗（群組照樣停著，但清單上會看不到）',
    );
    return undefined;
  }
}

/**
 * 群組停手交人（重試用完／沒有自動路徑／執行失敗）→ 開一張單。
 *
 * `blockedCount` 是「還有幾群在等它進 base」——那個數字直接代表修好這一群能解開多少
 * 後續工作。沒有它，人看到的只是一則孤立的失敗，不知道背後還有一整條鏈停在那裡。
 */
export function openStuckGroupHandoff(
  ledger: HandoffLedger,
  log: Logger,
  input: { groupId: string; repo: string; why: string; waitingGroups?: string[] },
): string | undefined {
  const waiting = input.waitingGroups ?? [];
  try {
    return ledger.openHandoff({
      groupId: input.groupId,
      fromRole: 'program',
      toRole: 'human',
      kind: 'stuck_group',
      title: `群組 ${input.groupId} 停手，需要你決定`,
      body: input.why.trim() || '（沒有留下原因，請看 log）',
      options: HANDOFF_ACTIONS.stuck_group,
      ...(waiting.length
        ? { ifIgnored: `還有 ${waiting.length} 群在等它進 base：${waiting.join('、')}` }
        : {}),
    });
  } catch (e) {
    log.warn(
      { groupId: input.groupId, err: e instanceof Error ? e.message : String(e) },
      '開停手交接單失敗（群組照樣停著，但清單上會看不到）',
    );
    return undefined;
  }
}
