import { NO_CHANGE_BLOCK_PREFIX } from '../notify/notifier.js';
import type { NoChangeCategory } from '../worker/agent-runtime.js';
import type { Group, Task } from '../types.js';

/**
 * 「有哪些事在等人」的唯一定義。
 *
 * 從 CLI 抽出來的理由：CLI、控制台、Slack 的定期提醒、以及 Orchestrator 都要問
 * 同一個問題。分成好幾份實作的話，這些介面會慢慢給出不一樣的清單——
 * 而「控制台說沒事、Slack 卻在催」這種不一致查起來特別花時間。
 */

/** 一筆待人處理的事項。 */
export type PendingKind = 'clarification' | 'no_change' | 'needs_human' | 'merge_approval' | 'stuck_group';

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
  listTasksByState(state: 'blocked'): Task[];
  listGroupsByState(state: Group['state']): Group[];
  latestEvent?(scope: 'task' | 'group' | 'system', refId: string | null, kind: string): { detail?: string } | undefined;
}

/**
 * 掃出所有「等人處理」的事項。
 * 純函式（只讀 ledger），因此可以完整單元測試，也能被 dashboard 之類的其他前端重用。
 */
export function collectPending(ledger: AskLedger): PendingItem[] {
  const items: PendingItem[] = [];

  for (const t of ledger.listTasksByState('blocked')) {
    const reason = t.block?.reason;
    const detail = t.block?.detail ?? '';

    if (reason === 'needs_clarification') {
      items.push({
        kind: 'clarification',
        id: t.id,
        title: t.title,
        repo: t.repo,
        detail,
        ...(parseSuggestion(detail) ? { suggestion: parseSuggestion(detail)! } : {}),
        actions: ['<你的答案>', '--default', 'abort'],
      });
      continue;
    }

    if (reason === 'needs_human') {
      // 「無需改動」的宣告會以固定前綴寫進 block detail（見 notifier.NO_CHANGE_BLOCK_PREFIX），
      // 額外從 events 取回結構化的分類與依據，人才有足夠資訊判斷 agent 有沒有誤判。
      if (detail.startsWith(NO_CHANGE_BLOCK_PREFIX)) {
        const report = parseNoChangeEvent(ledger, t.id);
        items.push({
          kind: 'no_change',
          id: t.id,
          title: t.title,
          repo: t.repo,
          detail: report?.reason ?? detail,
          ...(report?.category ? { category: report.category } : {}),
          ...(report?.evidence ? { evidence: report.evidence } : {}),
          actions: ['confirm', 'reject'],
        });
      } else {
        items.push({ kind: 'needs_human', id: t.id, title: t.title, repo: t.repo, detail, actions: ['retry', 'abort'] });
      }
    }
  }

  // 等待合併核准：政策判定需人工的群組會停在 in_review（見 group-runner 的政策閘門）
  for (const g of ledger.listGroupsByState('in_review')) {
    const why = ledger.latestEvent?.('group', g.id, 'policy_needs_human')?.detail;
    items.push({
      kind: 'merge_approval',
      id: g.id,
      title: `群組 ${g.id}（${g.taskIds.length} 個任務）`,
      repo: g.repo,
      detail: why ?? '等待人工核准合併',
      actions: ['approve', 'deny'],
    });
  }

  // **任何 failed 的群組都要出現在這裡。**
  //
  // 先前只列「重新派工已達上限」那一種，其餘全部靜默：執行中擲出例外、前置條件不成立、
  // 合併工作區不見、建 worktree 失敗……群組停在 failed，控制台卻回報「沒有需要你處理的事項」。
  // 實跑撞到：一個群組 failed 了半小時，待處理清單是空的——那等於這個系統
  // 悄悄放棄了一批工作而沒有人知道。**沒人看得到的失敗，比失敗本身更糟。**
  // 「有幾群在等它」——afterGroups 只有真的有依賴才會有值，所以這個數字直接代表
  // 修好這一群能解開多少後續工作。沒有它的話，人看到的只是一則孤立的失敗，
  // 不知道背後還有一整條鏈停在那裡。
  const blockedBy = new Map<string, string[]>();
  for (const st of ['ready', 'forming'] as const) {
    for (const g of ledger.listGroupsByState(st)) {
      for (const dep of g.afterGroups) {
        const cur = blockedBy.get(dep);
        if (cur) cur.push(g.id);
        else blockedBy.set(dep, [g.id]);
      }
    }
  }

  for (const g of ledger.listGroupsByState('failed')) {
    const exhausted = ledger.latestEvent?.('group', g.id, 'requeue_exhausted')?.detail;
    // 最後一則失敗原因：優先用 requeue 耗盡的說明，否則找最近一次 blocked／失敗事件
    const lastReason =
      exhausted ??
      ledger.latestEvent?.('group', g.id, 'merge_guard_blocked')?.detail ??
      // 「已核准卻無路可走」也走這裡：它的原因寫在 merge_blocked
      ledger.latestEvent?.('group', g.id, 'merge_blocked')?.detail ??
      ledger.latestEvent?.('group', g.id, 'worktree_create_failed')?.detail ??
      ledger.latestEvent?.('group', g.id, 'group_failed')?.detail;
    items.push({
      kind: 'stuck_group',
      id: g.id,
      title: `群組 ${g.id}`,
      repo: g.repo,
      detail:
        (exhausted
          ? `重新派工已達上限：${exhausted}`
          : `群組失敗，需要你決定要不要重試：${firstLine(lastReason) || '（沒有留下原因，請看 log）'}`)
        + waitingSuffix(blockedBy.get(g.id)),
      actions: ['retry'],
    });
  }

  return items;
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
