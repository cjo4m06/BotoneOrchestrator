import { ACTION_IDS, encodeActionValue, type ButtonElement, type KnownBlock } from './blocks.js';
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
  /** 停用專案（會清掉本機任務／群組／worktree／分支，故一律附二次確認）。 */
  projectDisable: 'home_project_disable',
  /** 啟用專案（可逆，不必確認）。 */
  projectEnable: 'home_project_enable',
  /** 卡住的群組重新派工。 */
  groupRetry: 'home_group_retry',
} as const;

export interface HomeInput {
  pending: PendingItem[];
  tasksByState: Record<TaskState, Task[]>;
  groupsByState: Record<GroupState, Group[]>;
  cost: { today: CostSummary; total: CostSummary };
  /** 今日花費依專案拆分（多專案時「誰在燒錢」）。 */
  costToday: RepoCost[];
  /** 已設定的專案清單（即使目前完全沒有任務也要列出來，否則看不出它存在）。 */
  projects: { repo: string; label?: string; id?: string; enabled?: boolean }[];
  /** 每個專案還要等多久才靜置（毫秒）；已靜置的不要放進來。 */
  quietWaits: { repo: string; count: number; waitMs: number }[];
  /** 產生這頁的時間（顯示「更新於」）。 */
  now: number;
  /**
   * 現在正在進行的事。**這是這一頁最重要的一區**——沒有它的時候，
   * 規劃／審查／合併那幾分鐘畫面完全靜止，人只能猜平台是不是掛了。
   */
  activities?: { kind: string; title: string; repo?: string; detail?: string; startedAt: number; stale: boolean }[];
  /** 最近一次整輪失敗。持續失敗時每輪都會更新，所以它會一直亮著——那正是要的效果。 */
  lastFailure?: { at: number; detail: string } | undefined;
  /** 剛剛那個按鈕做了什麼（成功或失敗）。按了沒有任何回饋的話，人會一直重按。 */
  note?: string;
}

/** 單一專案在面板上要顯示的一切。 */
interface ProjectSlice {
  repo: string;
  label?: string;
  /** 設定裡的專案 id（快捷操作要用）；ledger 殘留的孤兒 repo 沒有。 */
  configId?: string;
  enabled?: boolean;
  running: Task[];
  queued: number;
  blocked: number;
  done: number;
  openPrs: Group[];
  inReview: number;
  costToday: number;
  waitMs?: number;
}

/**
 * 分類標籤。
 *
 * **這一頁沒有任何 emoji。** 先前每一列開頭都掛一個黃臉表情當視覺分隔，
 * 結果是整頁看起來像聊天訊息而不是儀表板，而且 emoji 在不同平台長得不一樣、
 * 寬度也不一致，欄位根本對不齊。改用 Block Kit 本來就有的排版元素做層次：
 * `header` 大標、粗體小標、`context` 小灰字、`divider` 分隔線、
 * `fields` 兩欄對齊。這些是 Slack 自己的字級與間距，永遠對得齊。
 */
const KIND_LABEL: Record<PendingItem['kind'], string> = {
  clarification: '待澄清',
  no_change: '待確認不用做',
  reclaim_blocked: '認領不回來（要先去任務板改）',
  needs_human: '待人工處理',
  merge_approval: '待核准合併',
  stuck_group: '群組卡住',
};

/** 進行中的工作種類 → 給人看的詞。內部 kind（review_poll）對使用者沒有意義。 */
const ACT_LABEL: Record<string, string> = {
  plan: '分群規劃',
  poll: '輪詢任務板',
  code: '開發中',
  review_poll: '檢查審查結果',
  merge: '合併處理',
};

/** Slack 一個 view 最多 100 個 block；待辦多時要收斂，否則整頁會被 API 退回。 */
const MAX_PENDING_SHOWN = 8;
const MAX_ACTIVITY_SHOWN = 8;

export function homeViewBlocks(input: HomeInput): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  blocks.push({ type: 'header', text: { type: 'plain_text', text: '開發調度器', emoji: false } });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `更新於 ${timeLabel(input.now)}　·　**這是當下的快照**，停在這一頁不會自己更新；重開分頁或按下面的重新整理` }],
  });

  // 剛按下去的那個動作的結果，擺在最上面——按鈕沒有回饋的話人會一直重按
  if (input.note) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*${escape(oneLine(input.note, 200))}*` }] });
  }
  // 失敗要擺在最上面。持續失敗與「閒著沒事」在畫面上長得一模一樣，不明講沒人看得出來
  if (input.lastFailure) blocks.push(...failureSection(input.lastFailure));

  blocks.push({ type: 'divider' });
  blocks.push(...pendingSection(input.pending));
  blocks.push({ type: 'divider' });
  blocks.push(...activitySection(input.activities ?? [], input.now));
  blocks.push({ type: 'divider' });
  blocks.push(...projectsSection(input));
  blocks.push({ type: 'divider' });
  blocks.push(...costSection(input.cost));

  blocks.push({
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: '重新整理', emoji: false },
      action_id: HOME_ACTION_IDS.refresh,
      value: encodeActionValue({}),
    }],
  });

  return blocks;
}

function failureSection(f: NonNullable<HomeInput['lastFailure']>): KnownBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*上一輪執行失敗*　${timeLabel(f.at)}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: escape(oneLine(f.detail, 300)) }] },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '下一輪會自動再試。持續出現代表要有人處理。' }] },
  ];
}

function pendingSection(pending: PendingItem[]): KnownBlock[] {
  const blocks: KnownBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*等你處理*　${pending.length}` } },
  ];

  if (pending.length === 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '目前沒有需要你決定的事。' }] });
    return blocks;
  }

  for (const it of pending.slice(0, MAX_PENDING_SHOWN)) {
    const cat = it.category ? `${NO_CHANGE_CATEGORY_LABEL[it.category]} · ` : '';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${KIND_LABEL[it.kind]}*　\`${escape(it.id)}\`　${escape(oneLine(it.title, 80))}` },
    });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${escape(shortRepo(it.repo))}　·　${cat}${escape(oneLine(it.detail))}` }],
    });
    const acts = pendingActions(it);
    if (acts) blocks.push(acts);
  }

  if (pending.length > MAX_PENDING_SHOWN) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `另有 ${pending.length - MAX_PENDING_SHOWN} 項（用 \`npm run ask\` 看完整清單）` }],
    });
  }
  return blocks;
}

/**
 * 每一列的動作鈕。
 *
 * **不可逆的操作不放在這裡。** App Home 是隨手滑過去的頁面，誤觸成本太高——
 * 確認「這張卡不用做」會呼叫 complete_task（沒有反向工具），核准合併會動到 base 分支。
 * 那兩個留在任務卡與 CLI（都有二次確認）。這裡只放「做錯了改回來就好」的那些。
 */
function pendingActions(it: PendingItem): KnownBlock | undefined {
  if (it.kind === 'merge_approval') {
    // 合併會動到 base 分支，是這整條鏈上唯一真正不可逆的動作。放在這裡的前提是
    // **一定附二次確認**——那是「隨手滑過去誤觸」的解法，不是把動作藏起來。
    // 藏起來的代價是人要為了按一個鈕去頻道裡翻幾小時前的訊息卡。
    return {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '核准合併', emoji: false },
          style: 'primary',
          action_id: ACTION_IDS.mergeApprove,
          value: encodeActionValue({ groupId: it.id }),
          confirm: {
            title: { type: 'plain_text', text: '核准這個合併？', emoji: false },
            text: {
              type: 'mrkdwn',
              text: `*${escape(oneLine(it.title, 80))}*\n${escape(oneLine(it.detail, 150))}\n\n`
                + '合併會動到 base 分支。它仍要通過 Merge Guard 與風險判斷者才會真的合下去。',
            },
            confirm: { type: 'plain_text', text: '核准', emoji: false },
            deny: { type: 'plain_text', text: '取消', emoji: false },
          },
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '退回', emoji: false },
          style: 'danger',
          action_id: ACTION_IDS.mergeReject,
          value: encodeActionValue({ groupId: it.id }),
        },
      ],
    };
  }
  if (it.kind === 'needs_human') {
    return {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '重試', emoji: false },
        action_id: ACTION_IDS.taskRetry,
        value: encodeActionValue({ taskId: it.id }),
      }],
    };
  }
  if (it.kind === 'clarification' || it.kind === 'no_change') {
    // 這兩個都要先讀完 agent 的提問／查證依據才能判斷，而那些內容在任務卡的 thread 裡。
    // App Home 放不下也不該放——但一定要講清楚去哪裡處理，否則人只會盯著這一列發呆。
    return {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `到 ${'`#'}coding-agent\` 的任務卡回覆，或在終端機執行 \`npm run ask\`` }],
    };
  }
  if (it.kind === 'stuck_group') {
    // **要看 actions**：後端算得出「這一項沒有可按的動作」（群組停在 forming／ready，
    // 而 reviveGroup 只認 changes_requested/failed/merge_guard）。照 kind 硬畫的話，
    // 按下去只會拿到「群組不在停手狀態，不需要復活」——那正是這一整串在修的
    //「按了什麼都不會發生」（控制台端 2026-08-17 已修，這裡是同一個病的另一半）。
    if (!(it.actions ?? []).includes('retry')) {
      return {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '這一項現在沒有可按的動作——詳情見控制台或 `npm run ask`' }],
      };
    }
    return {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '重新派工', emoji: false },
        action_id: HOME_ACTION_IDS.groupRetry,
        value: encodeActionValue({ groupId: it.id }),
      }],
    };
  }
  return undefined;
}

/**
 * 現在正在進行的事。
 *
 * 這一區是這一頁存在的主要理由。花時間最久的幾段——規劃 agent 讀完整個 repo 再分群
 * （實測單次 6 分鐘）、reviewer 審查、合併把關——期間任務狀態與群組狀態都不會變，
 * 只看那些數字的話，跟平台掛掉完全無法分辨。
 */
function activitySection(acts: HomeInput['activities'] & object, now: number): KnownBlock[] {
  const blocks: KnownBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*現在在做什麼*　${acts.length}` } },
  ];
  if (acts.length === 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '閒著（沒有任何工作在進行）。' }] });
    return blocks;
  }

  for (const a of acts.slice(0, MAX_ACTIVITY_SHOWN)) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${escape(ACT_LABEL[a.kind] ?? a.kind)}*　${escape(oneLine(a.title, 90))}` },
    });
    const meta = [
      ...(a.repo ? [escape(shortRepo(a.repo))] : []),
      ...(a.detail ? [escape(oneLine(a.detail, 100))] : []),
      // **絕對時間，不是「已 6 分 12 秒」。**
      // 這一頁只在你打開或按重新整理時更新——停在上面不動它就凍住了。
      // 凍住的相對時間會騙人（顯示 6 分，其實已經 40 分），
      // 凍住的絕對時間永遠是對的：讀的人自己會算現在幾點。
      `${timeLabel(a.startedAt)} 起（已 ${elapsed(now - a.startedAt)}）`,
      // 心跳停了就是 daemon 不在了，那與「跑很久」是完全不同的兩件事
      ...(a.stale ? ['*沒有心跳，daemon 可能已經不在了*'] : []),
    ].join('　·　');
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: meta }] });
  }

  if (acts.length > MAX_ACTIVITY_SHOWN) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `另有 ${acts.length - MAX_ACTIVITY_SHOWN} 項進行中` }],
    });
  }
  return blocks;
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
    { type: 'section', text: { type: 'mrkdwn', text: `*專案*　${slices.length}` } },
  ];

  if (slices.length === 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '沒有載入任何專案 — 檢查設定與 MCP 連線。' }],
    });
    return blocks;
  }

  for (const p of slices) {
    const short = shortRepo(p.repo);
    const title = `*${escape(short)}*`
      // 標籤與短名一樣時印兩次只是雜訊（實際設定多半就是同一個字）
      + (p.label && p.label !== short ? `　${escape(p.label)}` : '')
      + (p.enabled === false ? '　（已停用）' : '');

    // fields 是 Block Kit 唯一能做出對齊兩欄的東西。用純文字排的話，
    // 中英文與數字寬度不同，每一列都會歪掉
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: title },
      fields: [
        { type: 'mrkdwn', text: `執行中　*${p.running.length}*` },
        { type: 'mrkdwn', text: `排隊　*${p.queued}*` },
        { type: 'mrkdwn', text: `受阻　*${p.blocked}*` },
        { type: 'mrkdwn', text: `今日　*${money(p.costToday)}*` },
      ],
      ...(projectToggle(p) ?? {}),
    });

    const notes: string[] = [];
    notes.push([
      `完成 ${p.done}`,
      ...(p.openPrs.length > 0 ? [`PR ${p.openPrs.length}`] : []),
      ...(p.inReview > 0 ? [`審查中 ${p.inReview}`] : []),
    ].join('　·　'));
    if (p.running.length > 0) {
      notes.push(p.running.slice(0, 3).map((x) => `\`${escape(x.id)}\` ${escape(oneLine(x.title, 40))}`).join('　'));
    }
    // 靜置期倒數：任務卡著不動時，這是「系統沒壞、在等你把任務建完」的唯一說明
    if (p.waitMs !== undefined) {
      notes.push(`等靜置期，約 ${Math.ceil(p.waitMs / 60_000)} 分後自動開工`);
    }
    if (notes.length > 0) {
      blocks.push({ type: 'context', elements: notes.map((text) => ({ type: 'mrkdwn' as const, text })) });
    }
  }

  return blocks;
}

/**
 * 專案的停用／啟用鈕。
 *
 * **停用附二次確認，啟用不必。** 不對稱是刻意的：停用會清掉這個專案在本機的
 * 任務、群組、worktree 與分支（見 core/project-purge.ts），在隨手滑過的頁面上
 * 誤觸的代價太高；啟用只是把旗標打開，下一輪重新從任務板撈，做錯了再按回去就好。
 *
 * 設定裡沒有的 repo（ledger 殘留的孤兒）不給按鈕——沒有東西可以切。
 */
function projectToggle(p: ProjectSlice): { accessory: ButtonElement } | undefined {
  if (!p.configId || p.enabled === undefined) return undefined;
  if (p.enabled) {
    return {
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '停用', emoji: false },
        style: 'danger',
        action_id: HOME_ACTION_IDS.projectDisable,
        value: encodeActionValue({ projectId: p.configId }),
        confirm: {
          title: { type: 'plain_text', text: '停用這個專案？', emoji: false },
          text: {
            type: 'mrkdwn',
            text: `停用會清掉 *${escape(shortRepo(p.repo))}* 在本機的任務、群組、worktree 與分支。\n`
              + '下次啟用時會重新從任務板撈一次（拿到的是最新狀態）。',
          },
          confirm: { type: 'plain_text', text: '停用', emoji: false },
          deny: { type: 'plain_text', text: '取消', emoji: false },
          style: 'danger',
        },
      },
    };
  }
  return {
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: '啟用', emoji: false },
      action_id: HOME_ACTION_IDS.projectEnable,
      value: encodeActionValue({ projectId: p.configId }),
    },
  };
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
  const cfgOf = new Map(input.projects.map((p) => [p.repo, p]));
  const byRepo = <T extends { repo: string }>(list: T[], repo: string): T[] => list.filter((x) => x.repo === repo);

  return [...repos]
    .map((repo): ProjectSlice => {
      const label = labelOf.get(repo);
      const cfg = cfgOf.get(repo);
      return {
        repo,
        ...(label ? { label } : {}),
        ...(cfg?.id ? { configId: cfg.id } : {}),
        ...(cfg?.enabled !== undefined ? { enabled: cfg.enabled } : {}),
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
    text: { type: 'mrkdwn', text: '*花費*' },
    fields: [
      { type: 'mrkdwn', text: `今天　*${money(cost.today.costUsd)}*\n${cost.today.rounds} 輪` },
      { type: 'mrkdwn', text: `累計　*${money(cost.total.costUsd)}*\n${cost.total.sessions} 個 session` },
      { type: 'mrkdwn', text: `輸入 token　${compact(cost.total.inputTokens)}` },
      { type: 'mrkdwn', text: `輸出 token　${compact(cost.total.outputTokens)}` },
    ],
  }];
}

/** 給人看的經過時間。「6 分 12 秒」比「372000ms」或一個時間戳好懂太多。 */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 時 ${m % 60} 分`;
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
