import { taskActivityAt } from '../core/quiet-period.js';
import type { CostSummary, RepoCost, TaskCost } from '../store/ledger.js';
import type { Group, GroupState, Task, TaskState } from '../types.js';

/**
 * CLI 的兩個唯讀報表：`status`（現在在做什麼）與 `cost`（花了多少）。
 *
 * 為什麼要有：Slack 訊息會被洗掉，而「系統現在到底在幹嘛」是最常問的問題。
 * 全部是純函式（吃資料、吐字串），所以每一行輸出都測得到——
 * 報表最糟的失敗是「數字看起來很合理但其實算錯」，那種錯不會有人發現。
 */

export const TASK_STATES: TaskState[] = ['discovered', 'queued', 'blocked', 'in_progress', 'verifying', 'done'];
export const GROUP_STATES: GroupState[] = [
  'forming', 'ready', 'pr_open', 'in_review', 'changes_requested', 'merge_guard', 'merged', 'failed', 'closed',
];

/**
 * 以**顯示寬度**補齊（中日韓字元佔 2 欄）。
 * 用 String.padEnd 會照 code unit 數補，中文標籤長度不一時整欄就會歪掉——
 * 終端機報表歪掉不是美觀問題，是「兩欄數字對不起來、看錯行」。
 */
export function padDisplay(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function displayWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += isWide(ch) ? 2 : 1;
  return n;
}

function isWide(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x1100 && c <= 0x115f) // 韓文字母
    || (c >= 0x2e80 && c <= 0xa4cf) // CJK 部首～注音
    || (c >= 0xac00 && c <= 0xd7a3) // 韓文音節
    || (c >= 0xf900 && c <= 0xfaff) // CJK 相容表意文字
    || (c >= 0xfe30 && c <= 0xfe6f) // CJK 相容形式
    || (c >= 0xff00 && c <= 0xff60) // 全形
    || (c >= 0xffe0 && c <= 0xffe6)
    || (c >= 0x1f300 && c <= 0x1f64f) // emoji
    || (c >= 0x1f900 && c <= 0x1f9ff)
  );
}

const TASK_LABEL: Record<TaskState, string> = {
  discovered: '已發現（等分群）',
  queued: '已排隊',
  blocked: '受阻',
  in_progress: '執行中',
  verifying: '驗證中',
  done: '完成',
};

const GROUP_LABEL: Record<GroupState, string> = {
  forming: '組建中',
  ready: '待派工',
  pr_open: 'PR 已開',
  in_review: '審查中',
  changes_requested: '等人／要求修改',
  merge_guard: '合併檢查中',
  merged: '已合併',
  failed: '失敗',
  closed: '已結案（無交付）',
};

export interface StatusInput {
  tasksByState: Record<TaskState, Task[]>;
  groupsByState: Record<GroupState, Group[]>;
  /** 每個專案的靜置分鐘數（判斷 discovered 還要等多久）。 */
  quietMinutesOf: (repo: string) => number;
  /** 已設定的專案（沒有任務的也要列，否則分不清「很閒」與「沒載入」）。 */
  projects?: { repo: string; label?: string }[];
  /** 今日花費依專案拆分。 */
  costToday?: RepoCost[];
  now: number;
}

export function formatStatus(input: StatusInput): string {
  const { tasksByState, groupsByState } = input;
  const lines: string[] = [];

  lines.push('📊 目前狀態');
  lines.push('');

  const activeTasks = TASK_STATES.filter((s) => s !== 'done').reduce((n, s) => n + tasksByState[s].length, 0);
  if (activeTasks === 0 && GROUP_STATES.filter((s) => s !== 'merged').every((s) => groupsByState[s].length === 0)) {
    lines.push('  ✅ 沒有進行中的工作（任務板空著，或全部都已合併）。');
  }

  lines.push('任務');
  for (const s of TASK_STATES) {
    const n = tasksByState[s].length;
    if (n === 0) continue;
    lines.push(`  ${padDisplay(TASK_LABEL[s], 18)} ${String(n).padStart(3)}`);
  }

  // 沒有群組就整段不印：空標題比沒有標題更容易讓人以為是壞掉了
  if (GROUP_STATES.some((s) => groupsByState[s].length > 0)) {
    lines.push('');
    lines.push('群組');
  }
  for (const s of GROUP_STATES) {
    const n = groupsByState[s].length;
    if (n === 0) continue;
    const ids = groupsByState[s].slice(0, 4).map((g) => g.id).join(', ');
    const more = groupsByState[s].length > 4 ? ` …+${groupsByState[s].length - 4}` : '';
    lines.push(`  ${padDisplay(GROUP_LABEL[s], 18)} ${String(n).padStart(3)}  ${ids}${more}`);
  }

  lines.push(...projectLines(input));

  return lines.join('\n');
}

/**
 * 依專案逐段列出。整體統計看得到「有多少事」，但看不到「是哪個專案的事」——
 * 一個 daemon 顧多個 MCP 任務板時，後者才是能拿來做決定的資訊。
 */
function projectLines(input: StatusInput): string[] {
  const { tasksByState, groupsByState } = input;
  const waitOf = new Map(quietWaits(input).map((w) => [w.repo, w]));
  const costOf = new Map((input.costToday ?? []).map((c) => [c.repo, c.costUsd]));

  const repos = new Set<string>((input.projects ?? []).map((p) => p.repo));
  for (const s of TASK_STATES) for (const t of tasksByState[s]) repos.add(t.repo);
  for (const s of GROUP_STATES) for (const g of groupsByState[s]) repos.add(g.repo);
  if (repos.size === 0) return [];

  const of = <T extends { repo: string }>(list: T[], repo: string): T[] => list.filter((x) => x.repo === repo);
  const lines: string[] = ['', '專案'];

  for (const repo of [...repos].sort()) {
    const running = [...of(tasksByState.in_progress, repo), ...of(tasksByState.verifying, repo)];
    const blocked = of(tasksByState.blocked, repo);
    const queued = of(tasksByState.queued, repo).length + of(tasksByState.discovered, repo).length;
    const cost = costOf.get(repo);

    lines.push(`  ${repo}`);
    lines.push(
      `    執行中 ${running.length}　排隊 ${queued}　受阻 ${blocked.length}　完成 ${of(tasksByState.done, repo).length}`
      + (cost !== undefined ? `　今天 ${money(cost)}` : ''),
    );

    for (const t of running) lines.push(`    🔧 ${t.id}  ${t.title}`);
    for (const t of blocked) lines.push(`    ⛔ ${t.id}  ${t.title}　←　${t.block?.reason ?? '未知原因'}`);

    const w = waitOf.get(repo);
    if (w) lines.push(`    ⏳ 等靜置期：${w.count} 個任務，還要約 ${Math.ceil(w.waitMs / 60_000)} 分鐘`);
  }

  if ([...repos].some((r) => of(tasksByState.blocked, r).length > 0)) {
    lines.push('');
    lines.push('（受阻的項目用 `npm run ask` 看能不能處理）');
  }
  return lines;
}

interface QuietWait {
  repo: string;
  count: number;
  waitMs: number;
}

/** discovered 任務按專案彙總「還要等多久」（已經等滿的不列）。 */
export function quietWaits(input: Pick<StatusInput, 'tasksByState' | 'quietMinutesOf' | 'now'>): QuietWait[] {
  const byRepo = new Map<string, Task[]>();
  for (const t of input.tasksByState.discovered) {
    const list = byRepo.get(t.repo);
    if (list) list.push(t);
    else byRepo.set(t.repo, [t]);
  }
  const out: QuietWait[] = [];
  for (const [repo, list] of byRepo) {
    const windowMs = Math.max(0, input.quietMinutesOf(repo)) * 60_000;
    const idleMs = Math.max(0, input.now - Math.max(...list.map(taskActivityAt)));
    if (idleMs >= windowMs) continue;
    out.push({ repo, count: list.length, waitMs: windowMs - idleMs });
  }
  return out.sort((a, b) => a.waitMs - b.waitMs);
}

export interface CostInput {
  total: CostSummary;
  today: CostSummary;
  last7d: CostSummary;
  topTasks: TaskCost[];
  /** 花費上限的目前用量（沒設上限就給空陣列）。 */
  budget?: { label: string; spentUsd: number; limitUsd: number; ratio: number }[];
  /** 任務標題（查得到才顯示，查不到就只有 id）。 */
  titleOf: (taskId: string) => string | undefined;
}

export function formatCost(input: CostInput): string {
  const lines: string[] = ['💰 成本', ''];

  if (input.total.sessions === 0) {
    lines.push('  尚無任何 agent 執行紀錄。');
    lines.push('  （只有 daemon 實跑過 agent 才會有數字；純 dry-run 不會產生成本）');
    return lines.join('\n');
  }

  const row = (label: string, c: CostSummary): string =>
    `  ${padDisplay(label, 10)}${padDisplay(money(c.costUsd), 12)}${c.sessions} 個 session／${c.rounds} 輪`;
  lines.push(row('今天', input.today));
  lines.push(row('近 7 天', input.last7d));
  lines.push(row('全部', input.total));
  lines.push(`  ${padDisplay('token', 10)}輸入 ${compact(input.total.inputTokens)}／輸出 ${compact(input.total.outputTokens)}`);

  if (input.budget && input.budget.length > 0) {
    lines.push('');
    lines.push('上限');
    for (const b of input.budget) {
      const pct = Math.round(b.ratio * 100);
      const mark = b.ratio >= 1 ? '  ← 已達上限，暫停派新工作' : b.ratio >= 0.8 ? '  ← 接近上限' : '';
      lines.push(`  ${padDisplay(b.label, 10)}${padDisplay(`${money(b.spentUsd)} / ${money(b.limitUsd)}`, 20)}${String(pct).padStart(3)}%${mark}`);
    }
  }

  if (input.topTasks.length > 0) {
    lines.push('');
    lines.push('花最多的任務');
    for (const t of input.topTasks) {
      const title = input.titleOf(t.taskId);
      lines.push(`  ${padDisplay(money(t.costUsd), 12)}${t.taskId}${title ? `  ${title}` : ''}  (${t.rounds} 輪)`);
    }
  }

  return lines.join('\n');
}

/** 金額：小額也要看得出來，所以不固定 2 位（$0.004 顯示成 $0.00 等於沒說）。 */
export function money(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** token 數：上百萬時完整數字沒人讀得出量級。 */
export function compact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** 今天 00:00 的 epoch（本地時區——人問「今天花多少」問的是自己的今天）。 */
export function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
