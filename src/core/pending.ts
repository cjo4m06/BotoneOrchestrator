import { NO_CHANGE_BLOCK_PREFIX, RECLAIM_BLOCK_PREFIX } from '../notify/notifier.js';
import type { NoChangeCategory } from '../worker/agent-runtime.js';
import type { Group, Task } from '../types.js';
import type { HandoffRow } from '../store/ledger.js';
import { HANDOFF_ACTIONS } from './handoff.js';

/**
 * 「有哪些事在等人」的唯一定義。
 *
 * 從 CLI 抽出來的理由：CLI、控制台、Slack 的定期提醒、以及 Orchestrator 都要問
 * 同一個問題。分成好幾份實作的話，這些介面會慢慢給出不一樣的清單——
 * 而「控制台說沒事、Slack 卻在催」這種不一致查起來特別花時間。
 */

/** 一筆待人處理的事項。 */
export type PendingKind =
  | 'clarification'
  | 'no_change'
  | 'needs_human'
  /**
   * 認領不回來——**解法不在這個系統裡**。任務板上那張卡還停在「進行中」，
   * 而 MCP 沒有取消認領的工具。人必須去任務板改回「待辦」，
   * 在這邊按重試永遠沒用（實跑：使用者按了 4 次，每次 3 分鐘後同樣失敗）。
   * 所以要跟一般的 needs_human 分開，介面才講得出「去哪裡做什麼」。
   */
  | 'reclaim_blocked'
  | 'merge_approval'
  | 'stuck_group';

/**
 * 群組「停手交人」時可能停在哪些狀態（failed 以外的）。
 *
 * 為什麼要列這些而不是掃全部：merged 已經結束了，ready/forming 還在排隊，
 * in_review 由上面的 merge_approval 負責。剩下這幾個才是「跑到一半停住、
 * 而且系統不會自己再動它」的形狀。
 */
const HANDOFF_STATES = ['changes_requested', 'pr_open', 'merge_guard'] as const;

/**
 * 代表「這一群需要人介入」的事件。
 *
 * 判準放在事件而不是狀態：狀態是系統的內部分類（停在哪一步就是哪個狀態），
 * 事件才是「有人得來處理」這件事實本身。
 */
const HANDOFF_EVENTS = ['requeue_exhausted', 'reconcile_needs_human'] as const;

export interface PendingItem {
  kind: PendingKind;
  /** 任務或群組 id。 */
  id: string;
  title: string;
  /** 所屬專案（owner/name）。多專案時不標出來，人根本不知道這件事是哪個專案的。 */
  repo: string;
  /** 給人看的說明（問題內容／宣告理由／政策原因）。 */
  detail: string;
  /** agent 建議的預設答案（澄清用）。 */
  suggestion?: string;
  /** no_change 的分類。 */
  category?: NoChangeCategory;
  /** agent 的查證依據。 */
  evidence?: string;
  /** 可用的動作。 */
  actions: string[];
}

export interface AskLedger {
  /** 「等人」的唯一來源：`to_role='human' AND consumed_at IS NULL`。 */
  listHandoffs(q: { toRole?: string; kind?: string; groupId?: string; taskId?: string; unconsumedOnly?: boolean; limit?: number }): HandoffRow[];
  listGroupsByState(state: Group['state']): Group[];
  getTask?(id: string): Task | undefined;
  getGroup?(id: string): Group | undefined;
  latestEvent?(scope: 'task' | 'group' | 'system', refId: string | null, kind: string): { detail?: string } | undefined;
}

/**
 * 誰在等人——**一條查詢，不是一串推論**。
 *
 * ── 為什麼換掉推論 ──
 *
 * 先前這個函式從「任務 block 狀態 ＋ 群組狀態 ＋ 事件」反推出待處理清單。
 * 推論綁在寫死的狀態清單上，漏一項就是一次靜默：實跑撞到兩個群耗盡重試停在
 * `changes_requested`（不是 `failed`），16 個任務堵著，而控制台顯示
 * 「沒有需要你處理的事項」。修過一次（把 changes_requested 加進清單），
 * 但那只是把同一個錯往後推——下一個新狀態還是會漏。
 *
 * 現在「等人」是資料：`to_role='human' AND consumed_at IS NULL`。
 * 開單與停手是同一個寫入動作（見 ledger.setBlock），收單與解除受阻也是（clearBlock）。
 *
 * ── 正向自檢 ──
 *
 * 光有查詢還不夠：萬一某條路徑忘了開單，症狀一樣是「清單上沒有」。
 * 所以再加一道**反向**檢查——群組停在非終態、卻沒有任何未結案交接單，就代寫一張。
 * 這一道刻意不精準（它說的是「我說不出這一群在等什麼」），但它保證
 * **不會有東西悄悄消失**。
 */
export function collectPending(ledger: AskLedger): PendingItem[] {
  const items: PendingItem[] = [];

  for (const h of ledger.listHandoffs({ toRole: 'human', unconsumedOnly: true })) {
    const meta = h.taskId ? ledger.getTask?.(h.taskId) : undefined;
    const group = h.groupId ? ledger.getGroup?.(h.groupId) : undefined;
    items.push({
      kind: h.kind as PendingKind,
      // 任務單掛任務、群組單掛群組——UI 的動作要打到對的東西上
      id: h.taskId ?? h.groupId ?? h.id,
      title: h.title,
      repo: meta?.repo ?? group?.repo ?? '',
      // body 是 agent／程式自己寫的文字，**程式不解析它**
      detail: h.ifIgnored ? `${h.body}\n    ⛓ ${h.ifIgnored}` : h.body,
      ...(h.options?.length ? { actions: h.options } : { actions: HANDOFF_ACTIONS[h.kind] ?? [] }),
      ...(h.evidence?.length ? { evidence: h.evidence.join(' ') } : {}),
      // ── 細節補強 ──
      //
      // 這與被換掉的「推論」是不同的事：那邊推的是**誰在等人**（會漏），
      // 這邊只是替一個**已經確定在清單上**的項目補齊 UI 要用的欄位。
      // 補不到就沒有，不影響它出不出現。
      ...(h.kind === 'clarification' && parseSuggestion(h.body) ? { suggestion: parseSuggestion(h.body)! } : {}),
      ...(h.kind === 'no_change' ? noChangeExtras(ledger, h.taskId) : {}),
    });
  }

  // 正向自檢：停在非終態、又沒有任何未結案交接單的群組。
  // 這一道抓的是「某條路徑忘了開單」——症狀與「真的沒事」完全一樣，
  // 所以必須由程式主動找出來，而不是等人發現。
  const seen = new Set(items.map((i) => i.id));
  for (const st of SELF_CHECK_STATES) {
    for (const g of ledger.listGroupsByState(st)) {
      if (seen.has(g.id)) continue;
      if (ledger.listHandoffs({ groupId: g.id, unconsumedOnly: true, limit: 1 }).length > 0) continue;
      if (!hasStopSignal(ledger, g.id)) continue;
      items.push({
        kind: 'stuck_group',
        id: g.id,
        title: `群組 ${g.id}`,
        repo: g.repo,
        detail:
          `這一群停在 ${g.state} 而且沒有在跑，但系統說不出它在等什麼——` +
          '這代表某條停手路徑忘了開交接單。成果保留著，請看 log 或按重試。',
        actions: ['retry'],
      });
    }
  }

  return items;
}

/**
 * 「無需改動」的分類與查證依據。
 *
 * agent 用 `report_no_change` 交件時是結構化的（category／reason／evidence），
 * 但 block detail 只塞得下一句話。人要判斷「agent 有沒有誤判」需要看它查證了什麼，
 * 所以從事件把結構化那份取回來。
 */
function noChangeExtras(ledger: AskLedger, taskId: string | undefined): Partial<PendingItem> {
  if (!taskId) return {};
  const raw = ledger.latestEvent?.('task', taskId, 'no_change_reported')?.detail;
  if (!raw) return {};
  try {
    const r = JSON.parse(raw) as { category?: NoChangeCategory; reason?: string; evidence?: string };
    return {
      ...(r.category ? { category: r.category } : {}),
      ...(r.reason ? { detail: r.reason } : {}),
      ...(r.evidence ? { evidence: r.evidence } : {}),
    };
  } catch {
    // 格式壞掉不該讓這一項從清單上消失——它還是要出現，只是少了分類
    return {};
  }
}

/** 自檢要看的狀態：跑到一半停住、而且系統不會自己再動它的那些。 */
const SELF_CHECK_STATES: Group['state'][] = ['changes_requested', 'failed', 'merge_guard'];

/** 這一群留下過「停手交人」的痕跡嗎（事件層，與交接單獨立）。 */
function hasStopSignal(ledger: AskLedger, groupId: string): boolean {
  return ['requeue_exhausted', 'reconcile_needs_human', 'group_failed', 'merge_guard_blocked'].some(
    (k) => ledger.latestEvent?.('group', groupId, k),
  );
}

/** 後面還有幾群等著它進 base。空的就完全不提，不要多出一句沒資訊的話。 */
function waitingSuffix(waiting: string[] | undefined): string {
  if (!waiting || waiting.length === 0) return '';
  return `\n    ⛓ 還有 ${waiting.length} 群在等它進 base：${waiting.join('、')}`;
}

/** 失敗原因常常是好幾行的 git／指令輸出；清單上只放第一行，細節去看事件。 */
function firstLine(s: string | undefined): string {
  return (s ?? '').split('\n')[0]?.trim().slice(0, 200) ?? '';
}

/** 從澄清問題的文字中撈出 agent 標註的建議預設（格式由 Worker 寫入，抓不到就沒有）。 */
function parseSuggestion(detail: string): string | undefined {
  const m = /建議[：:]\s*(.+?)(?:\n|$)/.exec(detail);
  return m?.[1]?.trim();
}

function parseNoChangeEvent(
  ledger: AskLedger,
  taskId: string,
): { category?: NoChangeCategory; reason?: string; evidence?: string } | undefined {
  const raw = ledger.latestEvent?.('task', taskId, 'no_change_reported')?.detail;
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(typeof o.category === 'string' ? { category: o.category as NoChangeCategory } : {}),
      ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
      ...(typeof o.evidence === 'string' ? { evidence: o.evidence } : {}),
    };
  } catch {
    return undefined; // 事件格式壞掉不該讓整個列表爆掉
  }
}

/** 把待辦列表印成人看得懂的形式。 */
