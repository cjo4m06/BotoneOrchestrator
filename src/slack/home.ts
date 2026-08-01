import { ACTION_IDS, encodeActionValue, type KnownBlock } from './blocks.js';
import { NO_CHANGE_CATEGORY_LABEL } from '../notify/notifier.js';
import { money, compact } from '../cli/report.js';
import type { PendingItem } from '../cli/ask.js';
import type { CostSummary, RepoCost } from '../store/ledger.js';
import type { Group, GroupState, Task, TaskState } from '../types.js';

/**
 * Slack App Home：常駐的「現在怎麼樣」面板。
 *
 * 為什麼需要：任務卡是貼在頻道裡的訊息，幾小時後就被洗到看不到；
 * 而「有哪些事在等我」「現在跑到哪」「花了多少」是每天都要看的東西，
 * 靠翻歷史訊息找等於沒有。App Home 是每個人自己的一頁，重開就是最新狀態。
 *
 * 純函式：吃資料、吐 Block Kit。與 CLI 的 status/cost 共用同一批取數與格式化函式，
 * 兩個介面才不會給出不一樣的數字（那種不一致查起來特別花時間）。
 */

/** App Home 的動作 id（與訊息卡共用 ACTION_IDS，另加自己的重新整理鈕）。 */
export const HOME_ACTION_IDS = {
  refresh: 'home_refresh',
} as const;

export interface HomeInput {
  pending: PendingItem[];
  tasksByState: Record<TaskState, Task[]>;
  groupsByState: Record<GroupState, Group[]>;
  cost: { today: CostSummary; total: CostSummary };
  /** 今日花費依專案拆分（多專案時「誰在燒錢」）。 */
  costToday: RepoCost[];
  /** 已設定的專案清單（即使目前完全沒有任務也要列出來，否則看不出它存在）。 */
  projects: { repo: string; label?: string }[];
  /** 每個專案還要等多久才靜置（毫秒）；已靜置的不要放進來。 */
  quietWaits: { repo: string; count: number; waitMs: number }[];
  /** 產生這頁的時間（顯示「更新於」）。 */
  now: number;
}

/** 單一專案在面板上要顯示的一切。 */
interface ProjectSlice {
  repo: string;
  label?: string;
  running: Task[];
  queued: number;
  blocked: number;
  done: number;
  openPrs: Group[];
  inReview: number;
  costToday: number;
  waitMs?: number;
}

const KIND_ICON: Record<PendingItem['kind'], string> = {
  clarification: '❓',
  no_change: '🟰',
  needs_human: '🚧',
  merge_approval: '🔀',
  stuck_group: '⚠️',
};

const KIND_LABEL: Record<PendingItem['kind'], string> = {
  clarification: '待澄清',
  no_change: '待確認「不用做」',
  needs_human: '待人工處理',
  merge_approval: '待核准合併',
  stuck_group: '群組卡住',
};

/** Slack 一個 view 最多 100 個 block；待辦多時要收斂，否則整頁會被 API 退回。 */
const MAX_PENDING_SHOWN = 12;

export function homeViewBlocks(input: HomeInput): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '🤖 開發調度器', emoji: true },
  });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `更新於 ${timeLabel(input.now)}　·　點右上重新整理取得最新狀態` }],
  });

  blocks.push(...pendingSection(input.pending));
  blocks.push({ type: 'divider' });
  blocks.push(...projectsSection(input));
  blocks.push({ type: 'divider' });
  blocks.push(...costSection(input.cost));

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '🔄 重新整理', emoji: true },
        action_id: HOME_ACTION_IDS.refresh,
        value: encodeActionValue({}),
      },
    ],
  });

  return blocks;
}

function pendingSection(pending: PendingItem[]): KnownBlock[] {
  const blocks: KnownBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*等你處理　${pending.length}*` } },
  ];

  if (pending.length === 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '✅ 目前沒有需要你決定的事。' }],
    });
    return blocks;
  }

  for (const it of pending.slice(0, MAX_PENDING_SHOWN)) {
    const cat = it.category ? `${NO_CHANGE_CATEGORY_LABEL[it.category]} — ` : '';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${KIND_ICON[it.kind]} *${KIND_LABEL[it.kind]}*　\`${it.id}\`　${escape(it.title)}\n`
          + `_${escape(shortRepo(it.repo))}_　${cat}${escape(oneLine(it.detail))}`,
      },
      ...(actionAccessory(it) ?? {}),
    });
  }

  if (pending.length > MAX_PENDING_SHOWN) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `…另有 ${pending.length - MAX_PENDING_SHOWN} 項（用 \`npm run ask\` 看完整清單）` }],
    });
  }
  return blocks;
}

/**
 * 每一列右側的主要動作鈕。
 *
 * 刻意**只放安全的那一個**：不可逆的操作（確認「不用做」會呼叫 complete_task）
 * 不放在這裡——App Home 是隨手滑過去的頁面，誤觸成本太高。
 * 那些操作留在任務卡的按鈕與 CLI（兩者都有二次確認）。
 */
function actionAccessory(it: PendingItem): { accessory: KnownBlock extends { accessory?: infer A } ? A : never } | undefined {
  if (it.kind === 'needs_human' || it.kind === 'stuck_group') {
    return {
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '重試', emoji: true },
        action_id: ACTION_IDS.taskRetry,
        value: encodeActionValue({ taskId: it.id }),
      },
    } as ReturnType<typeof actionAccessory>;
  }
  return undefined;
}

/**
 * 依**專案**列出進度。
 *
 * 先前這一段把所有專案的數字加在一起，多專案時等於沒說：看到「執行中 3」
 * 卻不知道是哪個專案在跑、哪個卡住、哪個在燒錢。這正是這個系統的核心形態
 * （一個 daemon 顧多個 MCP 任務板），面板不分開就失去意義。
 *
 * 沒有任何任務的專案也要列出來：看不到它，人無法分辨「這個專案很閒」
 * 還是「這個專案根本沒被載入」（設定寫錯、MCP 連不上都會長這樣）。
 */
function projectsSection(input: HomeInput): KnownBlock[] {
  const slices = sliceByProject(input);
  const blocks: KnownBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*專案　${slices.length}*` } },
  ];

  if (slices.length === 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '⚠️ 沒有載入任何專案 — 檢查設定與 MCP 連線。' }],
    });
    return blocks;
  }

  for (const p of slices) {
    const stats = [
      `執行中 *${p.running.length}*`,
      `排隊 *${p.queued}*`,
      ...(p.blocked > 0 ? [`受阻 *${p.blocked}*`] : []),
      `完成 *${p.done}*`,
      `今天 *${money(p.costToday)}*`,
    ].join('　·　');

    const pr = [
      ...(p.openPrs.length > 0 ? [`PR ${p.openPrs.length}`] : []),
      ...(p.inReview > 0 ? [`審查中 ${p.inReview}`] : []),
    ].join('　·　');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📁 *${escape(shortRepo(p.repo))}*${p.label ? `　_${escape(p.label)}_` : ''}\n${stats}${pr ? `\n${pr}` : ''}`,
      },
    });

    const notes: string[] = [];
    if (p.running.length > 0) {
      notes.push(`🔧 ${p.running.slice(0, 3).map((x) => `\`${x.id}\` ${escape(x.title)}`).join('　')}`);
    }
    // 靜置期倒數：任務卡著不動時，這是「系統沒壞、在等你把任務建完」的唯一說明
    if (p.waitMs !== undefined) {
      notes.push(`⏳ 等靜置期，約 ${Math.ceil(p.waitMs / 60_000)} 分後自動開工`);
    }
    if (notes.length > 0) {
      blocks.push({ type: 'context', elements: notes.map((text) => ({ type: 'mrkdwn' as const, text })) });
    }
  }

  return blocks;
}

/**
 * 把各狀態的清單重新按 repo 切開。
 *
 * 專案清單以 input.projects 為準再union 資料裡出現過的 repo：
 * 設定裡沒有、但 ledger 有任務的 repo（專案被移除但殘留任務）也要看得到，
 * 否則那些任務會變成沒有人知道的孤兒。
 */
function sliceByProject(input: HomeInput): ProjectSlice[] {
  const t = input.tasksByState;
  const g = input.groupsByState;
  const costOf = new Map(input.costToday.map((c) => [c.repo, c.costUsd]));
  const waitOf = new Map(input.quietWaits.map((w) => [w.repo, w.waitMs]));

  const repos = new Set<string>(input.projects.map((p) => p.repo));
  for (const list of [t.in_progress, t.verifying, t.queued, t.discovered, t.blocked, t.done]) {
    for (const x of list) repos.add(x.repo);
  }
  for (const list of [g.pr_open, g.in_review]) for (const x of list) repos.add(x.repo);

  const labelOf = new Map(input.projects.map((p) => [p.repo, p.label]));
  const byRepo = <T extends { repo: string }>(list: T[], repo: string): T[] => list.filter((x) => x.repo === repo);

  return [...repos]
    .map((repo): ProjectSlice => {
      const label = labelOf.get(repo);
      return {
        repo,
        ...(label ? { label } : {}),
        running: [...byRepo(t.in_progress, repo), ...byRepo(t.verifying, repo)],
        queued: byRepo(t.queued, repo).length + byRepo(t.discovered, repo).length,
        blocked: byRepo(t.blocked, repo).length,
        done: byRepo(t.done, repo).length,
        openPrs: byRepo(g.pr_open, repo),
        inReview: byRepo(g.in_review, repo).length,
        costToday: costOf.get(repo) ?? 0,
        ...(waitOf.has(repo) ? { waitMs: waitOf.get(repo)! } : {}),
      };
    })
    // 忙的排前面：正在跑 > 有人在等 > 花得多。閒的專案沉到下面，但仍然看得到。
    .sort((a, b) =>
      b.running.length - a.running.length
      || b.blocked - a.blocked
      || b.costToday - a.costToday
      || a.repo.localeCompare(b.repo));
}

function costSection(cost: HomeInput['cost']): KnownBlock[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*成本*\n今天 *${money(cost.today.costUsd)}*（${cost.today.rounds} 輪）　·　`
        + `累計 *${money(cost.total.costUsd)}*（${cost.total.sessions} 個 session）\n`
        + `token 輸入 ${compact(cost.total.inputTokens)}／輸出 ${compact(cost.total.outputTokens)}`,
    },
  }];
}

// ── slash command ──

export interface SlashResult {
  /** 回給 Slack 的純文字（ephemeral，只有下指令的人看得到）。 */
  text: string;
}

/**
 * `/orch <子指令>` 的解析與回覆。
 *
 * 用 ephemeral 純文字而不是貼卡片：slash command 是「我現在想知道」，
 * 貼到頻道會變成別人的雜訊，而且 3 秒內要回應，簡單文字最不會逾時。
 */
export function handleSlashCommand(
  text: string,
  render: { status(): string; cost(): string; pending(): string },
): SlashResult {
  const sub = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  switch (sub) {
    case '':
    case 'pending':
    case 'ask':
      return { text: render.pending() };
    case 'status':
      return { text: render.status() };
    case 'cost':
      return { text: render.cost() };
    case 'help':
      return { text: SLASH_HELP };
    default:
      return { text: `不認得的指令：\`${sub}\`\n\n${SLASH_HELP}` };
  }
}

export const SLASH_HELP = [
  '*可用指令*',
  '`/orch` 或 `/orch pending` — 列出等你處理的事項',
  '`/orch status` — 現在在做什麼（任務／群組／靜置期倒數）',
  '`/orch cost` — 今天與累計花費',
  '',
  '要做決定（回答澄清、核准合併）請用任務卡上的按鈕，或在終端機執行 `npm run ask`。',
].join('\n');

// ── 小工具 ──

function oneLine(s: string, max = 180): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Slack mrkdwn 的三個保留字元；任務標題來自外部，不逃逸會讓版面錯亂。 */
function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `owner/name` 只留 name：面板寬度有限，owner 通常都一樣，留著只是佔位。 */
function shortRepo(repo: string): string {
  const i = repo.lastIndexOf('/');
  return i >= 0 ? repo.slice(i + 1) : repo;
}

function timeLabel(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
