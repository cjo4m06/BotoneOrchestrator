import { NO_CHANGE_BLOCK_PREFIX, RECLAIM_BLOCK_PREFIX } from '../notify/notifier.js';
import type { NoChangeCategory } from '../worker/agent-runtime.js';
import type { Group, Task } from '../types.js';
import type { HandoffRow } from '../store/ledger.js';
import { STUCK_GROUP_STATES, HANDOFF_ACTIONS, isStuckGroupState } from './handoff.js';

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
  /** 有哪些群組的 afterGroups 指向這一群（＝在等它進 base）。未實作 → 退化成不列。 */
  listGroupsBlockedBy?(groupId: string): string[];
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
export function collectPending(ledger: AskLedger, now: number = Date.now()): PendingItem[] {
  const items: PendingItem[] = [];

  for (const h of ledger.listHandoffs({ toRole: 'human', unconsumedOnly: true })) {
    const meta = h.taskId ? ledger.getTask?.(h.taskId) : undefined;
    const group = h.groupId ? ledger.getGroup?.(h.groupId) : undefined;

    // **核准單只有在群組真的還在等核准時才算數。**
    //
    // 寫入端（Ledger.updateGroupState）現在會在群組離開 in_review／merge_guard 時消化它，
    // 但那只對**之後**的狀態變化有效——已經卡在庫裡的舊單需要這一道讀取端才會消失。
    //
    // 實跑（2026-08-05，g_da31b3e8c2ac）：群組早就被守衛退回 changes_requested，
    // 13:40 那張核准單還掛著。人按下去換來「這個群組正在等人回覆，不是等合併核准」，
    // 而真正該處理的 stuck_group 單就排在它旁邊——兩張長得一樣，人分不出該點哪一個。
    if (h.kind === 'merge_approval' && group && group.state !== 'in_review' && group.state !== 'merge_guard') {
      continue;
    }
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
      // 建議預設**讀欄位，不從正文撈**。
      //
      // 先前用 `/建議[：:]/` 掃問題正文，而那個值不只是顯示——CLI 的 `--default`
      // 會把它當成人的答案送出去。agent 用英文寫、寫成條列、或正文裡剛好有一行
      //「建議：先不要動某檔」當作說明脈絡，都會出事。
      // 現在 clarification_asked 存的是整包 ClarificationCapture，讀 options 就好。
      ...(h.kind === 'clarification' ? clarificationExtras(ledger, h.taskId) : {}),
      ...(h.kind === 'no_change' ? noChangeExtras(ledger, h.taskId) : {}),
    });
  }

  // ── 反向自檢：執行那條不變式 ──
  //
  // **不變式**：一個群組只要不是終態，系統就還欠它一個結果。所以它這一輪要嘛有推進，
  // 要嘛在 ledger 留下一張未消化的 `toRole:'human'` 單。log.warn／warnOnce／logEvent／
  // Slack 一次性推播**一律不算數**——那些人在畫面上看不到。
  //
  // ── 這一道先前形同虛設（2026-08-17 稽核，23 條無聲死路）──
  //
  // 三重收窄，任何一個都足以讓它永遠不觸發：
  //
  // ① `listHandoffs` **沒有 toRole 條件**。每個任務交出非空總結都會替群組開一張
  //    `kind:'delivery'`、`toRole:'coder'` 的單（group-runner 的交付說明），
  //    而全 repo 沒有任何地方消化 delivery。⇒ **只要這一群跑過一個任務，這道網就永遠 continue。**
  //    已知實例：g_86224a8df710 停了 53 小時，有 requeue_exhausted 事件、照設計該被撈回來，
  //    卻被自己的交付說明擋在門外。
  //
  // ② 事件白名單只認四種 kind。group_parked／base_moved／merge_deferred／
  //    merge_needs_human／group_nothing_to_deliver 全部不算「停手」。
  //
  // ③ 狀態白名單只有三個（＝重試鈕認得的那三個）。forming／ready／pr_open 一律不掃，
  //    而那三個正好是「看起來像在跑、其實沒人會再碰它」的狀態。
  //
  // 現在三個都拿掉，改成不變式本身：**非終態 ＋ 沒有未消化的 human 單 ＋ 一段時間沒有任何動靜**。
  // 「沒有動靜」用群組與其任務的 updatedAt 取最大值判斷——那是機械事實，不是猜測：
  // 真的在跑的群，任務狀態每幾分鐘就會變一次（claimed → in_progress → verifying → done）。
  const seen = new Set(items.map((i) => i.id));
  for (const st of SELF_CHECK_STATES) {
    for (const g of ledger.listGroupsByState(st)) {
      if (seen.has(g.id)) continue;
      // **一定要限定 toRole='human'**：非人的單（delivery／review_feedback 給 coder 的那些）
      // 不代表人看得到東西，拿它們當「已經有人在處理」是這道網先前失效的直接原因。
      if (ledger.listHandoffs({ groupId: g.id, toRole: 'human', unconsumedOnly: true, limit: 1 }).length > 0) continue;
      const idleMs = now - lastTouchedAt(ledger, g);
      if (idleMs < SELF_CHECK_STALE_MS) continue; // 還在動，不要吵
      // **在等前面的群 ＝ 正常排隊，不是卡住。**
      //
      // 這種群組沒有任何事情要人做：前面動了它就動。列出來只會多一顆按不動的鈕
      // ——而且方向是反的，壞掉的是上游，處理下游一百次也等不到。
      // 所以有未完成上游的一律跳過；真正該被看見的是**上游自己**（它會以自己的名義出現）。
      if (unfinishedUpstream(ledger, g).length > 0) continue;

      const canRetry = isStuckGroupState(g.state);
      items.push({
        kind: 'stuck_group',
        id: g.id,
        title: `群組 ${g.id}`,
        repo: g.repo,
        detail:
          `這一群停在 ${g.state}、已經 ${Math.round(idleMs / 60_000)} 分鐘沒有任何動靜，`
          + '而且沒有在等任何人——系統說不出它在等什麼，這代表某條停手路徑忘了開交接單。'
          + (canRetry ? '成果保留著，可以按重試。' : `（${g.state} 按不了重試，重試只對停手中的群組有效。）`),
        ...(canRetry ? { actions: ['retry'] } : { actions: [] }),
      });
    }
  }

  // ── 擋住別人的死上游：以**上游自己**的名義出現一次 ──
  //
  // `closed`（沒有東西要交付）是終態，永遠不會變 merged，而 Dispatcher 的「已結束」只認 merged
  // ⇒ 等它的群組會永遠排下去。這件事必須以上游的名義講出來，因為要處理的是它：
  // 要嘛解除那幾群的依賴，要嘛承認那條線就到這裡為止。
  // （`failed` 不用在這裡處理——它自己就會開 stuck_group 單。）
  for (const g of ledger.listGroupsByState('closed')) {
    if (seen.has(g.id)) continue;
    const blocked = ledger.listGroupsBlockedBy?.(g.id) ?? [];
    if (blocked.length === 0) continue; // 沒擋到人就沒事，不要多一則沒資訊的訊息
    if (ledger.listHandoffs({ groupId: g.id, toRole: 'human', unconsumedOnly: true, limit: 1 }).length > 0) continue;
    items.push({
      kind: 'stuck_group',
      id: g.id,
      title: `群組 ${g.id}（已結案，但擋著 ${blocked.length} 群）`,
      repo: g.repo,
      detail:
        `這一群沒有東西要交付（分支零 commit）所以結案了，但它永遠不會進 base，`
        + `而下面這 ${blocked.length} 群在等它：${blocked.join('、')}。`
        + '它們會一直排下去——請解除那幾群的依賴，或確認那條線就到這裡為止。',
      actions: [],
    });
  }

  return items;
}

/**
 * 這一群在等哪些還沒進 base 的上游。
 *
 * 「已結束」的判準與 Dispatcher 一致：**只有 merged 算進了 base**。
 * closed / failed 的上游雖然是終態，但它們永遠不會 merged ⇒ 對下游而言仍然是「還在等」，
 * 而那正是死等的來源（所以那種情況要以**上游**的名義開一則，不是在下游身上開）。
 */
function unfinishedUpstream(ledger: AskLedger, g: Group): string[] {
  return (g.afterGroups ?? []).filter((id) => ledger.getGroup?.(id)?.state !== 'merged');
}

/**
 * 這一群最後一次有動靜是什麼時候（群組本身與其任務的 updatedAt 取大者）。
 *
 * 為什麼不用事件時間：事件是「有人主動記了一筆」，而這道網要抓的正是**沒有人記**的情況。
 * updatedAt 是每次狀態寫入都會動的機械欄位，漏不掉。
 */
function lastTouchedAt(ledger: AskLedger, g: Group): number {
  let last = g.updatedAt;
  for (const id of g.taskIds) {
    const t = ledger.getTask?.(id);
    if (t && t.updatedAt > last) last = t.updatedAt;
  }
  return last;
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
/** 見 handoff.ts：這份清單與 reviveGroup 願意復活的狀態**必須是同一份**。 */
/**
 * 澄清單的補充欄位：**讀 agent 自己交的結構，不解析它的散文。**
 *
 * agent 呼叫 ask_human 時就交了 { question, rationale, options }；
 * 建議預設就是 options 裡標了推薦的那一個，沒有就是沒有——
 * 那時人自己打字，而不是讓程式從正文猜一句出來當他的答案。
 */
function clarificationExtras(ledger: AskLedger, taskId: string | undefined): { suggestion?: string } {
  if (!taskId) return {};
  const e = ledger.latestEvent?.('task', taskId, 'clarification_asked');
  if (!e?.detail) return {};
  try {
    const j = JSON.parse(e.detail) as { options?: unknown; recommendedDefault?: unknown };
    if (typeof j.recommendedDefault === 'string' && j.recommendedDefault.trim()) {
      return { suggestion: j.recommendedDefault };
    }
    if (Array.isArray(j.options) && typeof j.options[0] === 'string') return { suggestion: j.options[0] };
  } catch {
    // 舊資料是純文字的問題——沒有結構就沒有建議，照實不給
  }
  return {};
}

/**
 * 自檢要掃哪些狀態：**除了真的結束的以外，全部**。
 *
 * 先前是 `STUCK_GROUP_STATES`（重試鈕認得的那三個），而那份清單的用途是
 *「哪些狀態按得動重試」——拿它來當「哪些狀態可能卡住」是兩件事混用。
 * forming／ready／pr_open 都會卡（實跑各有實例），而它們一個都不在那份清單裡。
 *
 * `merged` / `closed` 是真的結束了（有產出／沒有東西要交付），不必再問人。
 * `failed` **要留著**：它是終態，但語意是「等人決定」，單被消化掉之後照樣得撈回來。
 */
const SELF_CHECK_STATES: readonly Group['state'][] = [
  'forming', 'ready', 'pr_open', 'in_review', 'changes_requested', 'merge_guard', 'failed',
];

/**
 * 多久沒有任何動靜就算「這一輪沒推進」。
 *
 * 30 分鐘：正常在跑的群每幾分鐘就有任務狀態變動；而最慢的單一步驟是
 * 合併守衛跑完整測試套件（實測 15-25 分鐘），所以門檻要蓋得過它，否則會把正在驗的群誤報成卡住。
 */
export const SELF_CHECK_STALE_MS = 30 * 60_000;


/** 後面還有幾群等著它進 base。空的就完全不提，不要多出一句沒資訊的話。 */
function waitingSuffix(waiting: string[] | undefined): string {
  if (!waiting || waiting.length === 0) return '';
  return `\n    ⛓ 還有 ${waiting.length} 群在等它進 base：${waiting.join('、')}`;
}

/** 失敗原因常常是好幾行的 git／指令輸出；清單上只放第一行，細節去看事件。 */
function firstLine(s: string | undefined): string {
  return (s ?? '').split('\n')[0]?.trim().slice(0, 200) ?? '';
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
