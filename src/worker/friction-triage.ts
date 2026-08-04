import type { LedgerEvent } from '../store/ledger.js';

/**
 * 摩擦回報的分診：把「看得見」補成「處理得掉」。
 *
 * ── 為什麼需要 ──
 *
 * 控制台把 26 筆回報攤出來之後，人沒有任何辦法讓它們消失。一份**只會長不會消**的清單，
 * 三週後就是沒人點的紅點——而那正是這一整串在修的病（`blocked` 欄位、
 * 灌爆的待處理清單，形狀都一樣：講得出來，但講了沒有用）。
 *
 * ── 三個動作，對應實跑那 26 筆 ──
 *
 * · `resolved`  已經修好了。實跑的 `no-changes 基準` 那筆早就被 commit fccdd21 修掉，
 *               卻還掛在清單上——沒有這個動作，修好的東西永遠佔著版面。
 * · `wont_fix`  知道了，不打算處理（例如 `run_code_unsafe` 被擋，但 agent 找到替代路徑）。
 * · `to_task`   這要變成任務板上的一張卡（例如順手抓到的 5 處 keyset 分頁漏資料）。
 *               **MCP 沒有建立任務的工具**（只有 list/get/start/complete），
 *               所以程式開不了卡——按鈕做的是把文字整理好給人貼過去。
 *
 * ── 為什麼用事件而不是新表 ──
 *
 * 分診是「對某一筆回報做了什麼」，天生是稽核軌跡的形狀；而回報本身就是 events 的列。
 * 用 `scope='system'`、`ref_id` ＝ 那筆回報的事件 id，查詢就是一次 join，
 * 不必為了三個布林值長一張表出來（也不必再寫一次保留策略與級聯刪除）。
 */

export const FRICTION_TRIAGED = 'friction_triaged';

export type TriageAction = 'resolved' | 'wont_fix' | 'to_task';

export const TRIAGE_ACTIONS: readonly TriageAction[] = ['resolved', 'wont_fix', 'to_task'];

/** 給人看的說法（控制台與 CLI 共用同一份，免得兩邊講不一樣的話）。 */
export const TRIAGE_LABEL: Record<TriageAction, string> = {
  resolved: '已解決',
  wont_fix: '不處理',
  to_task: '已轉成任務',
};

export interface TriageRecord {
  action: TriageAction;
  /** 人補的一句話。`wont_fix` 特別需要——事後才看得出當時為什麼決定不處理。 */
  note?: string;
  by?: string;
  at?: number;
}

export function isTriageAction(x: unknown): x is TriageAction {
  return typeof x === 'string' && (TRIAGE_ACTIONS as readonly string[]).includes(x);
}

/**
 * 從事件表撈出「哪幾筆回報已經被分診過」。
 *
 * 同一筆被分診多次時**以最後一次為準**（人改變主意是正常的：先標不處理，
 * 後來發現真的要修）。事件 id 遞增，所以後寫的覆蓋先寫的。
 */
export function triagedMap(events: LedgerEvent[]): Map<number, TriageRecord> {
  const out = new Map<number, TriageRecord>();
  for (const e of events) {
    if (e.kind !== FRICTION_TRIAGED || !e.refId) continue;
    const id = Number(e.refId);
    if (!Number.isInteger(id)) continue;
    try {
      const j = JSON.parse(e.detail ?? '{}') as Partial<TriageRecord>;
      if (!isTriageAction(j.action)) continue;
      out.set(id, {
        action: j.action,
        ...(typeof j.note === 'string' && j.note.trim() ? { note: j.note } : {}),
        ...(typeof j.by === 'string' ? { by: j.by } : {}),
        at: e.createdAt,
      });
    } catch {
      // 壞掉的紀錄當成沒分診過——**寧可讓它再出現一次，也不要靜靜地藏起來**
    }
  }
  return out;
}

/**
 * 把一筆回報整理成可以貼到任務板的文字（`to_task` 用）。
 *
 * 程式只做搬運：原話、證據、建議、出處任務原樣帶過去，不改寫也不摘要。
 * 摘要會把「檔案與行號」這種唯一有價值的東西弄丟，而那正是這些回報之所以有用的原因。
 */
export function toTaskCardText(r: {
  kind?: string;
  what?: string;
  evidence?: string;
  suggestion?: string;
  taskId?: string;
}): string {
  const lines = [
    `# ${r.what ?? '（沒有說明）'}`,
    '',
    `類別：${r.kind ?? 'other'}`,
    `來源：agent 在任務 ${r.taskId ?? '（不明）'} 執行時回報`,
  ];
  if (r.evidence) lines.push('', '## 證據', r.evidence);
  if (r.suggestion) lines.push('', '## agent 的建議', r.suggestion);
  lines.push('', '---', '（由開發調度器的「agent 說你該知道」轉出；原文未經改寫）');
  return lines.join('\n');
}
