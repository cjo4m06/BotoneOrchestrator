import type { Logger } from '../observability/logger.js';

/**
 * agent 工具呼叫的稽核記錄。
 *
 * ── 為什麼要有 ──
 *
 * 先前唯一的紀錄是 `tasks.tool_calls`：工具名 → 次數。那回答得了「它用過幾次 Bash」，
 * 回答不了「它跑了什麼」。
 *
 * 實跑（HIAzzBkS0x5a，2026-08-05）：工作區在任務進行中被清空兩次，未 commit 的實作
 * 全數消失，agent 必須整份重做。reflog 只留下 `e2a19d9 HEAD@{0}: reset: moving to HEAD`。
 * 調度器程式碼裡沒有任何 reset/clean，所以下手的是某個 agent——但 coder 與 reviewer
 * 共用同一個 worktree，而指令字串沒有任何地方留著，**事後完全無法歸因**。
 * 那筆回報躺在摩擦清單上兩天，除了「我不是我沒有」之外提不出任何東西。
 *
 * ── 邊界 ──
 *
 * 這裡只做記帳，**不做判斷**：不分類、不評分、不決定放不放行。
 * 放不放行是 evaluateToolPolicy 的事，這裡只是把它的結論一起記下來。
 */

/** 哪個角色下的手。與 AgentKind 分開：這裡要的是「誰動了這個目錄」。 */
export type ToolCallRole = 'coder' | 'reviewer' | 'planner' | 'drift_judge' | 'risk_judge';

export interface ToolCallRecord {
  at: number;
  role: ToolCallRole;
  taskId?: string;
  groupId?: string;
  /** 哪個工作區。問題永遠是「**這個目錄**被誰動了」，所以這是查詢的主軸之一。 */
  cwd?: string;
  tool: string;
  /** 參數 JSON（長字串已截斷）。 */
  input: string;
  /** 被紅線擋下的理由；未給 ＝ 放行。 */
  denied?: string;
}

/** 寫入端。Ledger 結構上即滿足。 */
export interface ToolCallSink {
  recordToolCall(r: ToolCallRecord): void;
}

/**
 * 單一字串值的上限。
 *
 * Bash 的 command 是這整套東西存在的理由，而它幾乎都遠在上限內；
 * Write/Edit 的整份檔案內容對「誰動了這個目錄」沒有價值，截掉。
 */
const MAX_VALUE_CHARS = 2000;
/** 整筆 JSON 的上限（多欄位相加的保險，例如 Edit 的 old/new 兩份字串）。 */
const MAX_RECORD_CHARS = 8000;

/**
 * 把工具參數序列化成可存的 JSON。
 *
 * **不挑欄位。** 挑欄位要維護一份「每個工具的哪些參數重要」的對照表，
 * 而新工具一加就會靜靜地漏記——那正是這個系統踩過好幾次的形狀。
 * 截斷是機械操作（照長度砍），不是判斷（照語意挑），所以可以放在程式裡。
 */
export function serializeToolInput(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(input, (_k, v: unknown) =>
      typeof v === 'string' && v.length > MAX_VALUE_CHARS
        ? `${v.slice(0, MAX_VALUE_CHARS)}…（截斷，原長 ${v.length}）`
        : v,
    ) ?? 'null';
  } catch {
    // 循環參照之類的怪東西：記不下來也絕不能影響工具呼叫
    json = '"（無法序列化）"';
  }
  return json.length > MAX_RECORD_CHARS
    ? `${json.slice(0, MAX_RECORD_CHARS)}…（整筆截斷，原長 ${json.length}）`
    : json;
}

/** 一次工具呼叫要記的東西（由 PreToolUse hook 提供）。 */
export interface ToolCallEvent {
  tool: string;
  input: unknown;
  cwd?: string;
  denied?: string;
}

/**
 * 造一個記錄器。
 *
 * `sink` 未給就只寫 debug log——**記帳失敗永遠不該影響工具呼叫**。
 * 但呼叫端仍必須明確傳入這個記錄器（見 createPreToolUseGuard 的必填參數）：
 * 「沒接線」要是編譯錯誤，不是執行時的靜默。
 */
export function createToolAuditor(
  log: Logger,
  role: ToolCallRole,
  ref: { taskId?: string; groupId?: string },
  sink?: ToolCallSink,
): (e: ToolCallEvent) => void {
  return (e) => {
    if (!sink) return;
    try {
      sink.recordToolCall({
        at: Date.now(),
        role,
        ...(ref.taskId ? { taskId: ref.taskId } : {}),
        ...(ref.groupId ? { groupId: ref.groupId } : {}),
        ...(e.cwd ? { cwd: e.cwd } : {}),
        tool: e.tool,
        input: serializeToolInput(e.input),
        ...(e.denied ? { denied: e.denied } : {}),
      });
    } catch (err) {
      log.debug({ tool: e.tool, err: err instanceof Error ? err.message : String(err) }, '工具稽核寫入失敗（忽略）');
    }
  };
}

/** 什麼都不記。給測試與「這個角色刻意不記」的地方用——**要寫出來**，不能靠省略參數。 */
export const NO_TOOL_AUDIT: (e: ToolCallEvent) => void = () => {};
