// Slack 訊息版型（Block Kit）——**純函式、無副作用**，方便單元測試。
// 整合點：src/slack/gateway.ts 呼叫這些函式產生 blocks，再交給 chat.postMessage / files.uploadV2。
// 對映 DESIGN.md §8（一任務一 thread、澄清按鈕、合併核准閘門）。

import type { types as slack } from '@slack/bolt';
import { NO_CHANGE_CATEGORY_LABEL, summarizeEvent, type NoChangeConfirmInput } from '../notify/notifier.js';
import type { ClarificationRequest, LifecycleEvent } from '../types.js';
import type { TaskCardProgress, TaskCardStatus } from '../contracts.js';

/** Block Kit 型別轉出，讓 gateway/測試不必各自 import Slack 型別。 */
export type KnownBlock = slack.KnownBlock;
export type ButtonElement = slack.Button;

// ── Slack 硬性長度限制（超過會被 API 退回，故一律先截斷） ──
const LIMIT_HEADER = 150;
const LIMIT_SECTION = 2900; // 官方 3000，留餘裕給我們自己加的標記
const LIMIT_BUTTON = 75;
const LIMIT_VALUE = 2000;

/** 互動元件的 action_id。入站事件靠這些常數分派，故必須與 gateway 共用同一份。 */
export const ACTION_IDS = {
  clarifyOption: 'clarify_option',
  clarifyFreeText: 'clarify_free_text',
  mergeApprove: 'merge_approve',
  mergeReject: 'merge_reject',
  taskPause: 'task_pause',
  taskAbort: 'task_abort',
  taskRetry: 'task_retry',
  /** 「這張卡確實不用做」→ complete_task（不可逆，附二次確認）。 */
  noChangeConfirm: 'no_change_confirm',
  /** 「你誤判了，請去做」→ 回 queued 重跑。 */
  noChangeReject: 'no_change_reject',
  /** 收工後清掉這張卡（連同 thread）。只出現在終態，避免誤刪還在進行的東西。 */
  cardDismiss: 'card_dismiss',
} as const;

export type ActionId = (typeof ACTION_IDS)[keyof typeof ACTION_IDS];

/** 按鈕 value 內容。Slack 只回傳字串，故以 JSON 夾帶關聯 id（thread_ts 另從 body 取）。 */
export interface ActionValue {
  taskId?: string;
  groupId?: string;
  optionId?: string;
}

export function encodeActionValue(v: ActionValue): string {
  return truncate(JSON.stringify(v), LIMIT_VALUE, '');
}

/** 解析按鈕 value；非本系統送出的內容一律回 undefined（不信任入站字串）。 */
export function decodeActionValue(raw: string | undefined): ActionValue | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const o = parsed as Record<string, unknown>;
  const pick = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  return { taskId: pick('taskId'), groupId: pick('groupId'), optionId: pick('optionId') };
}

// ── 任務卡（thread root） ──

/** 任務卡所需欄位；Task（ledger）與 TaskDetail（MCP）皆結構相容，故不綁死其一。 */
export interface TaskCardInput {
  id: string;
  title: string;
  repo: string;
  category: string;
  description?: string;
  docRefs?: string[];
  dependencies?: string[];
}

/**
 * 任務卡的狀態。卡片會**隨狀態更新**（chat.update），而不是貼出去就不動。
 *
 * 為什麼一定要更新：卡片貼在認領那一刻，如果之後不動，任務早就做完了、PR 開了、
 * 甚至正在等人核准，卡片上還是「暫停／中止／重試」三顆按鈕，看不出任何狀態。
 * 人得滑到頻道別的地方找那張核准卡才知道有事要做——而它通常已經被洗上去了。
 * 「需要你回饋」如果不是一眼看得出來，這個介面就是壞的。
 */
export type { TaskCardStatus, TaskCardProgress };

interface StatusStyle {
  icon: string;
  label: string;
  /** 需要人動作 ⇒ 卡片要明顯，而且要講清楚在等什麼。 */
  waiting?: string;
}

const STATUS: Record<TaskCardStatus, StatusStyle> = {
  working: { icon: '🟡', label: '執行中' },
  verifying: { icon: '🔵', label: '驗證中（跑 build/test）' },
  reviewing: { icon: '🔎', label: '審查中（檢查有沒有照規格做）' },
  merge_checking: { icon: '🔍', label: '已核准，合併把關中' },
  reworking: { icon: '🔧', label: '依你的意見重做中' },
  awaiting_reply: { icon: '⏸️', label: '等你回覆', waiting: 'agent 提出了問題，請在這條 thread 回覆' },
  awaiting_human: { icon: '🚧', label: '等你處理', waiting: '需要你決定要不要繼續' },
  blocked_deps: { icon: '⛓️', label: '等前置任務完成（不需要你動手）' },
  awaiting_no_change: { icon: '🟰', label: '等你確認「這張卡不用做」', waiting: '按下方按鈕決定' },
  pr_open: { icon: '📤', label: 'PR 已開，等審查' },
  awaiting_merge: { icon: '🔐', label: '等你核准合併', waiting: '按下方按鈕核准或退回' },
  merged: { icon: '✅', label: '已合併' },
  done: { icon: '☑️', label: '任務完成，等群組其他任務' },
  failed: { icon: '❌', label: '失敗' },
};

/** 每個狀態下**真的能按**的按鈕。做完的任務不該還掛著「暫停」。 */
function actionsFor(
  status: TaskCardStatus,
  taskValue: string,
  groupValue?: string,
  options?: string[],
): KnownBlock | undefined {
  const els: ButtonElement[] = [];
  switch (status) {
    // 還在跑的三個狀態：可以喊停，但「重試」沒有意義（它正在跑）
    case 'working':
    case 'verifying':
    case 'reviewing':
      els.push(button('⏸ 暫停', ACTION_IDS.taskPause, taskValue), button('⏹ 中止', ACTION_IDS.taskAbort, taskValue, 'danger'));
      break;
    case 'awaiting_human':
    case 'failed':
      els.push(button('🔁 重試', ACTION_IDS.taskRetry, taskValue), button('⏹ 中止', ACTION_IDS.taskAbort, taskValue, 'danger'));
      break;
    case 'awaiting_reply':
      // 澄清的選項直接做成卡片上的按鈕：thread 是收合的，放在裡面等於沒有
      for (const o of (options ?? []).slice(0, 4)) {
        els.push(button(o, ACTION_IDS.clarifyOption, encodeActionValue({ ...decodeActionValue(taskValue), optionId: o })));
      }
      els.push(button('✏️ 我來打字', ACTION_IDS.clarifyFreeText, taskValue));
      break;
    case 'awaiting_no_change':
      // confirm 會呼叫 complete_task（不可逆），所以標成危險色並排在後面
      els.push(button('🔧 請去做', ACTION_IDS.noChangeReject, taskValue));
      els.push(button('✅ 確實不用做', ACTION_IDS.noChangeConfirm, taskValue, 'danger'));
      break;
    case 'awaiting_merge':
      // 核准鈕直接放在任務卡上：不必再去頻道別處翻那張核准卡
      if (groupValue) {
        els.push(button('✅ 核准合併', ACTION_IDS.mergeApprove, groupValue, 'primary'), button('↩️ 退回', ACTION_IDS.mergeReject, groupValue, 'danger'));
      }
      break;
    case 'merged':
    case 'done':
      // 終態才給清除鈕：這張卡已經沒有後續，留著只是佔頻道版面。
      // 進行中的卡片絕不提供這顆——誤刪等於把進度與 thread 裡的稽核軌跡一起丟掉。
      els.push(button('🗑 清除這張卡', ACTION_IDS.cardDismiss, taskValue));
      break;
    // awaiting_reply：答案走 thread 或澄清卡的按鈕，主卡不再重複
    // pr_open / merged / done：沒有當下該按的東西，不放按鈕
    // merge_checking / reworking：裁決已送出，按鈕必須消失——留著人會重複點，
    //   而重複核准會重複寫憑證、重複觸發合併把關
    default:
      break;
  }
  return els.length > 0 ? { type: 'actions', elements: els } : undefined;
}

/**
 * 進度摘要：`第 3 輪 · 已跑 17 分鐘 · 改了 7 個檔案`。
 *
 * 存在的理由是實跑時的一段體驗：一個任務跑了 17 分鐘，卡片只在「執行中／驗證中／
 * 審查中」之間跳，thread 一則訊息都沒有。那段時間裡「正在做事」與「已經死了」
 * 在畫面上長得一模一樣，人只能猜。
 */
export function progressLine(p: TaskCardProgress | undefined): string | undefined {
  if (!p) return undefined;
  const bits: string[] = [];
  if (p.round !== undefined) bits.push(`第 ${p.round} 輪`);
  if (p.elapsedMs !== undefined) bits.push(`已跑 ${humanDuration(p.elapsedMs)}`);
  if (p.changedFiles !== undefined) bits.push(`改了 ${p.changedFiles} 個檔案`);
  return bits.length > 0 ? bits.join(' · ') : undefined;
}

/** 給人看的時間長度。秒級精度在這裡沒有意義，反而讓卡片一直重畫。 */
export function humanDuration(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 1) return '不到 1 分鐘';
  if (min < 60) return `${min} 分鐘`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h} 小時` : `${h} 小時 ${rest} 分`;
}

export function taskCardBlocks(
  task: TaskCardInput,
  status: TaskCardStatus = 'working',
  extra: { groupId?: string; prompt?: string; options?: string[]; progress?: TaskCardProgress } = {},
): KnownBlock[] {
  const groupId = extra.groupId;
  const value = encodeActionValue({ taskId: task.id });
  const st = STATUS[status];
  const blocks: KnownBlock[] = [
    header(`${st.icon} ${task.title}`),
    {
      type: 'section',
      fields: [
        mrkdwn(`*任務*\n\`${task.id}\``),
        mrkdwn(`*專案*\n${task.repo}`),
        mrkdwn(`*類別*\n${task.category}`),
        mrkdwn(`*依賴*\n${listOrDash(task.dependencies)}`),
      ],
    },
  ];

  // 狀態列排在最前面：人第一眼要看到的是「現在怎樣」「要不要我做什麼」
  const head = st.waiting ? `*${st.label}* — ${st.waiting}` : `*${st.label}*`;
  // 問題／理由直接放在狀態列下面：人要在卡片上就看得懂在等他決定什麼
  blocks.splice(1, 0, section(extra.prompt ? `${head}\n>${truncate(extra.prompt, 600).replace(/\n/g, '\n>')}` : head));

  if (task.description?.trim()) {
    blocks.push(section(truncate(task.description, LIMIT_SECTION)));
  }
  const prog = progressLine(extra.progress);
  const last = extra.progress?.lastOutcome?.trim();
  if (prog || last) {
    // 進度放在描述之後、規格之前：它是「現在怎樣」的補充，不該擠掉狀態列
    blocks.push(context([prog, last ? `上一輪：${truncate(last, 300)}` : undefined].filter(Boolean).join('\n')));
  }
  blocks.push(context(`📖 規格：${listOrDash(task.docRefs)}`));

  // 群層按鈕（核准／退回合併）也帶上所屬任務：過期卡片的偵測要靠 taskId 才認得出
  // 這顆按鈕屬於哪張卡；只帶 groupId 的話，daemon 重啟後舊卡上的核准鈕會變成無主而擋不掉。
  const actions = actionsFor(
    status,
    value,
    groupId ? encodeActionValue({ groupId, taskId: task.id }) : undefined,
    extra.options,
  );
  if (actions) blocks.push(actions);
  return blocks;
}

/** 通知列 / 無法渲染 blocks 時的純文字備援（Slack 要求 text 欄位）。 */
export function taskCardText(task: TaskCardInput, status: TaskCardStatus = 'working'): string {
  const st = STATUS[status];
  return `${st.icon} [${task.id}] ${task.title}（${task.repo}）— ${st.label}`;
}

/** 這個狀態需不需要人動手？（通知列與排序用） */
export function needsHuman(status: TaskCardStatus): boolean {
  return STATUS[status].waiting !== undefined;
}

// ── 生命週期事件（threaded reply） ──

export interface EventBlockOptions {
  /** 需要 @ 的人（Slack user id）。依 DESIGN §8：只有提問與失敗才 @人。 */
  mentions?: string[];
}

export function eventBlocks(event: LifecycleEvent, opts: EventBlockOptions = {}): KnownBlock[] {
  const mention = shouldMention(event) ? mentionPrefix(opts.mentions) : '';
  const blocks: KnownBlock[] = [section(truncate(`${mention}${summarizeEvent(event)}`, LIMIT_SECTION))];

  // 只有需要人介入的事件才附細節，其餘保持一行，避免 thread 變長
  if (event.type === 'stalled') {
    const failed = event.gate.checks.filter((c) => !c.ok).map((c) => `• ${c.name}：${c.detail}`);
    if (failed.length > 0) blocks.push(context(truncate(failed.join('\n'), LIMIT_SECTION)));
    blocks.push(context(`結果簽章：\`${event.gate.signature}\``));
  }
  return blocks;
}

export function eventText(event: LifecycleEvent): string {
  return summarizeEvent(event);
}

/** 只有提問與失敗類事件才 @人（噪音控制）。 */
function shouldMention(event: LifecycleEvent): boolean {
  return event.type === 'failed' || event.type === 'problem' || event.type === 'stalled';
}

function mentionPrefix(users: string[] | undefined): string {
  if (!users || users.length === 0) return '';
  return `${users.map((u) => `<@${u}>`).join(' ')} `;
}

// ── 澄清（DESIGN §7：問題 + 選項 + 建議預設 + 理由） ──

export function clarificationBlocks(taskId: string, req: ClarificationRequest, opts: EventBlockOptions = {}): KnownBlock[] {
  const recommendedId = req.recommendedDefault ?? req.options.find((o) => o.recommended)?.id;
  const blocks: KnownBlock[] = [
    section(truncate(`${mentionPrefix(opts.mentions)}❓ *需要你的決定*\n${req.question}`, LIMIT_SECTION)),
    context(`理由：${truncate(req.rationale || '（未提供）', LIMIT_SECTION)}`),
  ];

  if (recommendedId) {
    const label = req.options.find((o) => o.id === recommendedId)?.label ?? recommendedId;
    blocks.push(context(`建議預設：*${label}*（逾時未回覆且風險低時採用）`));
  }

  // Slack actions block 上限 25 顆；選項過多時截斷，剩下的走「我來打字」
  const optionButtons = req.options.slice(0, 24).map((o) =>
    button(
      `${o.label}${o.id === recommendedId ? '（建議）' : ''}`,
      ACTION_IDS.clarifyOption,
      encodeActionValue({ taskId, optionId: o.id }),
      o.id === recommendedId ? 'primary' : undefined,
    ),
  );
  optionButtons.push(button('✏️ 我來打字', ACTION_IDS.clarifyFreeText, encodeActionValue({ taskId })));
  blocks.push({ type: 'actions', elements: optionButtons });
  return blocks;
}

export function clarificationText(req: ClarificationRequest): string {
  return `❓ 需要你的決定：${req.question}`;
}

// ── 「這張卡不用做」的人工確認（DESIGN §7b：零 diff 的合法出口） ──

/**
 * agent 宣告 no_change → park 等人確認時貼的訊息。
 *
 * 為什麼一定要按鈕：沒有出口的話人只能下 retry（agent 再宣告一次 no_change，或為了讓
 * diff 關卡變綠而亂改程式碼）或 abort（park 到天荒地老）——兩條都是死路。
 * 版型刻意把**分類 + 理由 + 查證依據**全攤開，因為「確認不用做」會呼叫不可逆的
 * complete_task，人必須有依據才按得下去（故另加二次確認對話框與不可逆警語）。
 */
export function noChangeBlocks(input: NoChangeConfirmInput, opts: EventBlockOptions = {}): KnownBlock[] {
  const value = encodeActionValue({ taskId: input.taskId });
  const label = NO_CHANGE_CATEGORY_LABEL[input.category] ?? input.category;
  const blocks: KnownBlock[] = [
    section(
      truncate(
        `${mentionPrefix(opts.mentions)}🤔 *agent 判定這張卡「不需要任何程式碼改動」*\n${input.title ?? input.taskId}`,
        LIMIT_SECTION,
      ),
    ),
    {
      type: 'section',
      fields: [mrkdwn(`*任務*\n\`${input.taskId}\``), mrkdwn(`*分類*\n${label}`)],
    },
    section(truncate(`*理由*\n${input.reason}`, LIMIT_SECTION)),
    context(`查證依據：${truncate(input.evidence || '（agent 未提供——這本身就是該懷疑的訊號）', LIMIT_SECTION)}`),
    context('⚠️ 「確認不用做」會呼叫 complete_task 把任務標成完成，*此操作不可逆*（沒有反向工具）。'),
    {
      type: 'actions',
      elements: [
        confirmButton(
          '✅ 確認不用做',
          ACTION_IDS.noChangeConfirm,
          value,
          {
            title: '確認這張卡不用做？',
            text: `將呼叫 complete_task 把 ${input.taskId} 標成完成。此操作不可逆。`,
            confirm: '確認完成',
            deny: '再想想',
          },
          'danger',
        ),
        button('🔧 請你去做', ACTION_IDS.noChangeReject, value, 'primary'),
      ],
    },
  ];
  return blocks;
}

export function noChangeText(input: NoChangeConfirmInput): string {
  return `🤔 需要你確認：[${input.taskId}] agent 判定不需要改動（${NO_CHANGE_CATEGORY_LABEL[input.category] ?? input.category}）`;
}

// ── 合併核准閘門（DESIGN §10：needs_human） ──

export interface MergeApprovalInput {
  groupId: string;
  branch: string;
  repo: string;
  taskTitles: string[];
  prUrl?: string;
  /** 觸發人工閘門的原因（migration / ci / deps / delete / secrets…）。 */
  reasons?: string[];
}

export function mergeApprovalBlocks(input: MergeApprovalInput, opts: EventBlockOptions = {}): KnownBlock[] {
  const value = encodeActionValue({ groupId: input.groupId });
  const blocks: KnownBlock[] = [
    section(truncate(`${mentionPrefix(opts.mentions)}🔐 *合併需要核准*\n${input.prUrl ?? `分支 \`${input.branch}\``}`, LIMIT_SECTION)),
    {
      type: 'section',
      fields: [mrkdwn(`*專案*\n${input.repo}`), mrkdwn(`*群組*\n\`${input.groupId}\``)],
    },
    context(`涵蓋任務：${listOrDash(input.taskTitles)}`),
  ];
  if (input.reasons && input.reasons.length > 0) {
    blocks.push(context(`人工閘門原因：${input.reasons.join('、')}`));
  }
  blocks.push({
    type: 'actions',
    elements: [
      button('✅ 核准合併', ACTION_IDS.mergeApprove, value, 'primary'),
      button('↩️ 退回', ACTION_IDS.mergeReject, value, 'danger'),
    ],
  });
  return blocks;
}

export function mergeApprovalText(input: MergeApprovalInput): string {
  return `🔐 合併需要核准：${input.repo} ${input.branch}`;
}

// ── 截圖 ──

/** files.uploadV2 的 initial_comment。截圖本體由 Slack 直接嵌在 thread 內。 */
export function screenshotComment(paths: string[]): string {
  return `📸 驗證截圖（${paths.length} 張）：${paths.map(baseName).join('、')}`;
}

/** 上傳失敗或檔案不存在時的降級訊息（至少讓人知道截圖在本機哪裡）。 */
export function screenshotFallbackBlocks(paths: string[]): KnownBlock[] {
  return [
    section('📸 截圖已產出，但上傳 Slack 失敗，請至本機路徑查看：'),
    context(truncate(paths.map((p) => `• \`${p}\``).join('\n'), LIMIT_SECTION)),
  ];
}

// ── 小工具 ──

function baseName(p: string): string {
  return p.split('/').pop() || p;
}

function header(text: string): KnownBlock {
  return { type: 'header', text: { type: 'plain_text', text: truncate(text, LIMIT_HEADER), emoji: true } };
}

function section(text: string): KnownBlock {
  return { type: 'section', text: mrkdwn(text) };
}

function context(text: string): KnownBlock {
  return { type: 'context', elements: [mrkdwn(text)] };
}

function mrkdwn(text: string): { type: 'mrkdwn'; text: string } {
  return { type: 'mrkdwn', text: text.trim() || '（無）' };
}

function button(text: string, actionId: ActionId, value: string, style?: 'primary' | 'danger'): ButtonElement {
  return {
    type: 'button',
    action_id: actionId,
    text: { type: 'plain_text', text: truncate(text, LIMIT_BUTTON), emoji: true },
    value,
    ...(style ? { style } : {}),
  };
}

/** 帶二次確認對話框的按鈕（Slack 原生 confirm，避免誤點觸發不可逆操作）。 */
function confirmButton(
  text: string,
  actionId: ActionId,
  value: string,
  confirm: { title: string; text: string; confirm: string; deny: string },
  style?: 'primary' | 'danger',
): ButtonElement {
  return {
    ...button(text, actionId, value, style),
    confirm: {
      title: { type: 'plain_text', text: truncate(confirm.title, LIMIT_HEADER), emoji: true },
      text: { type: 'mrkdwn', text: truncate(confirm.text, LIMIT_SECTION) },
      confirm: { type: 'plain_text', text: truncate(confirm.confirm, LIMIT_BUTTON), emoji: true },
      deny: { type: 'plain_text', text: truncate(confirm.deny, LIMIT_BUTTON), emoji: true },
      ...(style ? { style } : {}),
    },
  };
}

function listOrDash(items: string[] | undefined): string {
  if (!items || items.length === 0) return '（無）';
  return truncate(items.join('、'), LIMIT_SECTION);
}

function truncate(s: string, max: number, ellipsis = '…'): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max - ellipsis.length) + ellipsis;
}
