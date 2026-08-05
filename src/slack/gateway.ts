// Slack 人機介面層（DESIGN.md §8 / §12 SlackGateway、M4）。
// 一任務一 thread：認領時貼「任務卡」當 thread root，之後所有事件都 threaded reply。
//
// 整合點（協調者負責接線，本檔不改 main.ts / notifier.ts）：
//   1. main.ts：`const notifier = createNotifier(config.orchestrator, log); await notifier.start();`
//      把它傳進 GroupRunner 的 `notifier`（型別相容 contracts.Notifier）；程序結束前 `await notifier.stop()`。
//   2. GroupRunner/Worker 認領任務前呼叫 `postTaskCard(task)` 取得 thread_ts，
//      寫回 ledger（tasks.slack_thread_ts）後再往下傳，事件才會串在同一條 thread。
//   3. Worker park 在 needs_clarification 時呼叫 `askClarification(threadTs, req)`；
//      協調者用 `onAnswer` 把答案注入 agent 並 resume，用 `onControl` 處理暫停/中止/重試/用你的預設。
//   4. 政策引擎判定 needs_human 時呼叫 `askMergeApproval(threadTs, group)`，用 `onMergeDecision` 收核准/退回。
//   5. 反查 thread → task 建議注入 `resolveTaskByThread`（由 ledger 查），否則重啟後只認得本次程序貼過的 thread。
//
// 硬性原則：**Slack 沒設定或掛掉都不能拖垮 daemon**。未設定 → createNotifier 回傳 ConsoleGateway（委派 ConsoleNotifier）；
// 已設定但 API 出錯 → 記 log 後吞掉，絕不 throw 進呼叫端。

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { App, LogLevel, webApi, type Logger as BoltLogger } from '@slack/bolt';
import { ConsoleNotifier, NO_CHANGE_CATEGORY_LABEL } from '../notify/notifier.js';
import type { ExtendedControlCommand, NoChangeConfirmInput } from '../notify/notifier.js';
import type { Notifier } from '../contracts.js';
import type { Logger } from '../observability/logger.js';
import type { TaskCardExtra } from '../contracts.js';
import type {
  ClarificationAnswer,
  ClarificationRequest,
  ControlCommand,
  LifecycleEvent,
  TaskDetail,
} from '../types.js';
import {
  ACTION_IDS,
  clarificationBlocks,
  clarificationText,
  decodeActionValue,
  eventBlocks,
  eventText,
  mergeApprovalBlocks,
  mergeApprovalText,
  noChangeBlocks,
  noChangeText,
  screenshotComment,
  screenshotFallbackBlocks,
  taskCardBlocks,
  taskCardText,
  type KnownBlock,
  type MergeApprovalInput,
  type TaskCardInput,
  type TaskCardProgress,
  type TaskCardStatus,
} from './blocks.js';

// ── 對外契約 ──

/** 合併核准閘門的人工裁決。 */
export interface MergeDecision {
  groupId: string;
  approved: boolean;
  threadTs?: string;
  userId?: string;
  /** 退回時的修改意見；會回灌給 agent（沒有它，agent 不知道哪裡要改）。 */
  reason?: string;
}

/**
 * 人機介面（DESIGN §12 SlackGateway 的完整版），同時滿足 contracts.Notifier，
 * 因此可以直接餵給 GroupRunner/Worker。未設定 Slack 時由 ConsoleGateway 提供同一組 no-op。
 */
export interface HumanGateway extends Notifier {
  /** 貼任務卡當 thread root；回傳 thread_ts（降級模式回 undefined）。 */
  postTaskCard(task: TaskCardInput): Promise<string | undefined>;
  event(threadTs: string | undefined, event: LifecycleEvent, task: TaskDetail): Promise<void>;
  askClarification(threadTs: string | undefined, request: ClarificationRequest, taskId?: string): Promise<void>;
  askMergeApproval(threadTs: string | undefined, group: MergeApprovalInput): Promise<void>;
  /** agent 宣告「這張卡不用做」→ 請人裁決（[確認不用做] / [請你去做]）。 */
  askNoChangeConfirmation(threadTs: string | undefined, input: NoChangeConfirmInput): Promise<void>;
  postScreenshots(threadTs: string | undefined, paths: string[]): Promise<void>;
  onAnswer(cb: (a: ClarificationAnswer) => void): void;
  onControl(cb: (c: ExtendedControlCommand) => void): void;
  onMergeDecision(cb: (d: MergeDecision) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ── 注入用的最小 Slack 介面（測試可塞假件，不打真實 API） ──

export interface PostMessageArgs {
  channel: string;
  text: string;
  blocks?: KnownBlock[];
  thread_ts?: string;
}
export interface PostMessageResult {
  ts?: string;
  channel?: string;
}
export interface FileUploadArgs {
  channel_id: string;
  thread_ts?: string;
  initial_comment?: string;
  file_uploads: { file: string; filename: string }[];
}
export interface SlackWebLike {
  chat: {
    postMessage(args: PostMessageArgs): Promise<PostMessageResult>;
    /** 更新已貼出的訊息（任務卡的狀態要跟著變，不能貼完就不動）。 */
    update?(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<unknown>;
    /** 刪除自己貼的訊息（收工後清卡片用）。 */
    delete?(args: { channel: string; ts: string }): Promise<unknown>;
  };
  /** 讀 thread 回覆（清卡片時要先把回覆刪掉，否則會留下半截垃圾）。 */
  conversations?: { replies?(args: { channel: string; ts: string }): Promise<{ messages?: { ts?: string }[] }> };
  files: { uploadV2(args: FileUploadArgs): Promise<unknown> };
}

/** views.publish（App Home 用）。獨立成一個介面，Gateway 不必知道有這回事。 */
export interface SlackViewsLike {
  publish(args: { user_id: string; view: { type: 'home'; blocks: unknown[] } }): Promise<unknown>;
}

/** 入站：按鈕點擊。 */
export interface InboundAction {
  actionId: string;
  value?: string;
  threadTs?: string;
  channel?: string;
  userId?: string;
}
/** 入站：slash command（`/orch status` 之類）。 */
export interface InboundSlashCommand {
  /** 指令後面的文字（不含指令本身）。 */
  text: string;
  userId?: string;
  channel?: string;
}
/** 入站：thread 內的人類文字回覆。 */
export interface InboundMessage {
  text: string;
  threadTs?: string;
  channel?: string;
  userId?: string;
}
/** Socket Mode 連線的最小介面；正式用 BoltSocket，測試用假件。 */
export interface SlackSocketLike {
  onAction(handler: (a: InboundAction) => void | Promise<void>): void;
  onMessage(handler: (m: InboundMessage) => void | Promise<void>): void;
  /** App Home 被開啟（可選：Slack app 沒訂閱這個事件時就不會有）。 */
  onHomeOpened?(handler: (userId: string) => void | Promise<void>): void;
  /** slash command（可選：Slack app 沒註冊指令時就不會有）。回傳的字串會以 ephemeral 回覆。 */
  onSlashCommand?(handler: (c: InboundSlashCommand) => Promise<string>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ── 噪音控制（DESIGN §8：只推有意義的狀態轉移 + 提問 + 失敗） ──

export interface ThrottleOptions {
  /** 迭代事件每 N 輪才推一次（第 1 輪一定推）。 */
  iterateEvery: number;
  /** 兩則迭代事件的最小間隔（毫秒）。 */
  iterateMinIntervalMs: number;
  /** 相同內容的「遇到問題」冷卻（毫秒）。 */
  problemCooldownMs: number;
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  iterateEvery: 10,
  iterateMinIntervalMs: 5 * 60_000,
  problemCooldownMs: 5 * 60_000,
};

interface ThreadThrottleState {
  lastIterating: number;
  lastStalled: number;
  docsRead: boolean;
  lastProblem?: { detail: string; at: number };
}

/**
 * 逐 thread 的事件過濾器。原則：狀態轉移（認領/PR/審查/合併/失敗）一律推；
 * 例行迭代降頻；卡牆與重複問題冷卻。時間由 now 注入，測試可完全決定行為。
 */
export class EventThrottle {
  private states = new Map<string, ThreadThrottleState>();
  private opts: ThrottleOptions;

  constructor(opts: Partial<ThrottleOptions> = {}, private now: () => number = Date.now) {
    this.opts = { ...DEFAULT_THROTTLE, ...opts };
  }

  allow(key: string, event: LifecycleEvent): boolean {
    const s = this.state(key);
    const t = this.now();
    switch (event.type) {
      case 'iterating':
        if (event.round !== 1 && event.round % this.opts.iterateEvery !== 0) return false;
        if (t - s.lastIterating < this.opts.iterateMinIntervalMs) return false;
        s.lastIterating = t;
        return true;
      case 'docs_read':
        if (s.docsRead) return false;
        s.docsRead = true;
        return true;
      case 'problem': {
        const prev = s.lastProblem;
        if (prev && prev.detail === event.detail && t - prev.at < this.opts.problemCooldownMs) return false;
        s.lastProblem = { detail: event.detail, at: t };
        return true;
      }
      default:
        return true; // 有意義的狀態轉移不過濾
    }
  }

  private state(key: string): ThreadThrottleState {
    let s = this.states.get(key);
    if (!s) {
      // -Infinity：第一次一定通過間隔檢查
      s = { lastIterating: -Infinity, lastStalled: -Infinity, docsRead: false };
      this.states.set(key, s);
    }
    return s;
  }
}

// ── 入站 payload 解析（純函式，不信任外部字串） ──

function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === 'string' ? v : undefined;
}
function obj(o: Record<string, unknown>, k: string): Record<string, unknown> | undefined {
  const v = o[k];
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** 解析 block_actions payload → 0..n 個 InboundAction。 */
export function parseBlockActions(body: unknown): InboundAction[] {
  if (typeof body !== 'object' || body === null) return [];
  const b = body as Record<string, unknown>;
  const actions = Array.isArray(b.actions) ? b.actions : [];
  const message = obj(b, 'message');
  const container = obj(b, 'container');
  // 點在 thread 回覆上 → message.thread_ts；點在 root 任務卡上 → message.ts 本身就是 thread_ts
  const threadTs =
    (message && (str(message, 'thread_ts') ?? str(message, 'ts'))) ??
    (container && (str(container, 'thread_ts') ?? str(container, 'message_ts')));

  const out: InboundAction[] = [];
  for (const raw of actions) {
    if (typeof raw !== 'object' || raw === null) continue;
    const a = raw as Record<string, unknown>;
    const actionId = str(a, 'action_id');
    if (!actionId) continue;
    out.push({
      actionId,
      value: str(a, 'value'),
      threadTs,
      channel: obj(b, 'channel') ? str(obj(b, 'channel')!, 'id') : undefined,
      userId: obj(b, 'user') ? str(obj(b, 'user')!, 'id') : undefined,
    });
  }
  return out;
}

/**
 * 解析 message 事件 → InboundMessage。
 * 只認「人類在 thread 內的原始發言」：bot 自己的訊息、編輯/加入等 subtype、非 thread 訊息都忽略，
 * 否則 gateway 會把自己貼的通知當成使用者回覆。
 */
export function parseMessageEvent(event: unknown): InboundMessage | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const e = event as Record<string, unknown>;
  if (str(e, 'bot_id') || str(e, 'subtype')) return undefined;
  const text = str(e, 'text');
  const threadTs = str(e, 'thread_ts');
  if (!text || !threadTs) return undefined;
  return { text, threadTs, channel: str(e, 'channel'), userId: str(e, 'user') };
}

/**
 * 設定值看起來已經是頻道 ID 嗎（`C…` 公開／`G…` 私密／`D…` 私訊）。
 *
 * 名稱長成 `#dev-orchestrator` 或 `dev-orchestrator`，一定有小寫或 `#`，不會誤判。
 */
export function looksLikeChannelId(v: string | undefined): boolean {
  return typeof v === 'string' && /^[CGD][A-Z0-9]{6,}$/.test(v);
}

/** thread 內的控制指令（DESIGN §8）。純文字比對，認不出來就回 undefined（當成一般回覆）。 */
export function parseControlCommand(text: string, taskId: string): ExtendedControlCommand | undefined {
  const t = text.trim().toLowerCase();
  // 指令必須是開頭的完整詞（後面只能接空白或標點），避免「預設值應該是…」被誤判成指令
  const cmd = (words: string): RegExp => new RegExp(`^(?:${words})(?:$|[\\s，。,.!！?？:：])`);
  if (cmd('暫停|停一下|pause').test(t)) return { type: 'pause', taskId };
  if (cmd('中止|取消|停止|abort|cancel|stop').test(t)) return { type: 'abort', taskId };
  if (cmd('重試|再試一次|retry').test(t)) return { type: 'retry', taskId };
  if (cmd('用你的預設|你決定|用預設|預設|default|use default|use-default').test(t)) return { type: 'use_default', taskId };
  // 「無需改動」的兩個出口。確認會觸發不可逆的 complete_task，故只認完整明確的說法
  // （不收「確認」「不用做」這種容易在對話中誤觸的短詞）；真正的把關在 InboundRouter。
  if (cmd('確認不用做|確認不需改動|確認無需改動|確認不需要改|confirm no change|confirm-no-change').test(t)) {
    return { type: 'confirm_no_change', taskId };
  }
  if (cmd('請你去做|請去做|你誤判了|你誤判|還是要做|去做吧').test(t)) {
    return { type: 'retry', taskId, source: 'no_change_rejected' };
  }
  return undefined;
}

/** thread 文字指令的回執文案（確認不可逆操作時要講清楚後果）。 */
export function controlAck(c: ExtendedControlCommand, taskId: string): string {
  if (c.type === 'confirm_no_change') return `✅ 已確認「不用做」：${taskId} 將被標記完成（不可逆）`;
  if (c.source === 'no_change_rejected') return `🔧 已請 agent 重做 ${taskId}（不接受「無需改動」的判定）`;
  return `🎛 已收到控制指令：${c.type}`;
}

// ── SlackGateway ──

export interface SlackGatewayDeps {
  client: SlackWebLike;
  channel: string;
  log: Logger;
  /** 入站互動；缺席 = 只出站（沒有 app token 時的合法降級）。 */
  socket?: SlackSocketLike;
  /** views.publish（App Home 用）。Gateway 自己不用，只是持有以便對外提供。 */
  views?: SlackViewsLike;
  /** 提問/失敗時 @ 的人（Slack user id）。 */
  mentions?: string[];
  throttle?: Partial<ThrottleOptions>;
  now?: () => number;
  /** 跨重啟反查 thread → task（建議由 ledger 提供）。 */
  resolveTaskByThread?: (threadTs: string) => string | undefined;
  /**
   * 跨重啟重建任務卡：taskId → 卡片內容與訊息 ts（由 ledger 提供）。
   *
   * 沒有它的話，卡片狀態只活在記憶體裡——daemon 一重啟，之前貼出去的卡就再也
   * 更新不到，永遠停在重啟前的樣子。而重啟在這個系統裡是常態（改設定、修 bug）。
   */
  resolveCard?: (taskId: string) => { ts: string; card: TaskCardInput } | undefined;
  /** groupId → 該群的任務 id（由 ledger 提供，讓裁決後的卡片更新跨重啟也有效）。 */
  resolveGroupTasks?: (groupId: string) => string[];
}

export class SlackGateway implements HumanGateway {
  private throttle: EventThrottle;
  private answerCbs: ((a: ClarificationAnswer) => void)[] = [];
  private controlCbs: ((c: ExtendedControlCommand) => void)[] = [];
  private mergeCbs: ((d: MergeDecision) => void)[] = [];
  /** thread_ts → taskId（本程序貼過的任務卡）。 */
  private threadTask = new Map<string, string>();
  private taskThread = new Map<string, string>();
  /** 任務卡的原始內容與目前狀態；更新卡片時要重新渲染整張，所以得留著。 */
  private cardState = new Map<string, {
    card: TaskCardInput; status: TaskCardStatus; sent?: string;
    groupId?: string; prompt?: string; options?: string[]; progress?: TaskCardProgress;
  }>();
  /** 每張卡一條更新鏈：同一張卡的多次更新必須依序落地，否則會亂序互蓋。 */
  private cardQueue = new Map<string, Promise<void>>();
  /** 有未答覆澄清的 thread → taskId；決定 thread 文字要當答案還是控制指令。 */
  private pendingClarify = new Map<string, string>();
  /** 已按「退回」但還沒說明原因的 thread → groupId（下一則文字就是修改意見）。 */
  private pendingReject = new Map<string, string>();
  /** 首次 postMessage 回傳的 channel id；files.uploadV2 需要 id 而非 "#name"。 */
  /**
   * 這個頻道的真實 ID（`C…` / `G…`）。
   *
   * ── 為什麼不能直接用設定裡那個值 ──
   *
   * Slack 的 API 對「頻道名稱」的容忍度**不一致**：`chat.postMessage` 吃得下
   * `#dev-orchestrator`，但 `chat.update`／`chat.delete`／`conversations.replies`／
   * `files.uploadV2` 一律只吃 ID，拿名稱去打會回 `channel_not_found`。
   *
   * 實跑（2026-08-05）：`清除任務卡失敗 err: channel_not_found`，而同一時間所有
   * 通知訊息都正常——因為只有 postMessage 那條路吃得下名稱。錯誤訊息還會把人
   * 引去錯的方向：它說「找不到頻道」，實際是「我們還沒解析出這個頻道的 ID」。
   */
  private channelId?: string;
  private started = false;

  constructor(private deps: SlackGatewayDeps) {
    // 設定值本來就是 ID → 直接用，那四個需要 ID 的呼叫從第一秒就能動。
    if (looksLikeChannelId(this.deps.channel)) this.channelId = this.deps.channel;

    this.throttle = new EventThrottle(deps.throttle ?? {}, deps.now ?? Date.now);
  }

  /**
   * 把 socket 與 views 交出去，讓 App Home 能共用同一條 Socket Mode 連線。
   *
   * 為什麼不讓 App Home 自己開一條：Socket Mode 每條連線都是一個 WebSocket，
   * 開兩條會讓同一個事件送達兩次（Slack 會輪詢派送），按鈕就會被處理兩遍。
   */
  handles(): SlackRuntimeHandles {
    return {
      ...(this.deps.socket ? { socket: this.deps.socket } : {}),
      ...(this.deps.views ? { views: this.deps.views } : {}),
    };
  }

  // ── 出站 ──

  /**
   * 更新任務卡的狀態。
   *
   * 卡片貼出去就不動的話，任務早就做完、PR 開了、甚至在等人核准，卡片上還是
   * 「暫停／中止／重試」三顆按鈕——人根本看不出它在等自己。這個方法是這個介面
   * 「能不能用」的關鍵，不是裝飾。
   *
   * 更新失敗只留 warn：Slack 的訊息更新有時間與速率限制，失敗不該影響任務本身。
   */
  async updateTaskCard(taskId: string, status: TaskCardStatus, extra: TaskCardExtra = {}): Promise<void> {
    const groupId = extra.groupId;
    let ts = this.taskThread.get(taskId);
    let state = this.cardState.get(taskId);

    // 記憶體沒有 ⇒ 可能是重啟前貼的卡：從 ledger 重建，別讓它永遠停在舊狀態
    if (!ts || !state) {
      const restored = this.deps.resolveCard?.(taskId);
      if (!restored) return; // 真的沒貼過卡（Slack 當時未啟用）
      ts = restored.ts;
      state = { card: restored.card, status };
      this.taskThread.set(taskId, ts);
      this.threadTask.set(ts, taskId);
      this.cardState.set(taskId, state);
      this.deps.log.debug({ taskId }, '從 ledger 重建任務卡狀態（daemon 重啟過）');
    }

    // 先把「想要的狀態」記下來（同步），實際送出排進佇列。
    state.status = status;
    if (groupId) state.groupId = groupId;
    if (extra.prompt !== undefined) state.prompt = extra.prompt;
    if (extra.options !== undefined) state.options = extra.options;
    if (extra.progress !== undefined) state.progress = { ...state.progress, ...extra.progress };

    // **必須串成一條鏈**：兩次更新在幾毫秒內發出時，送出順序對、但 Slack 回來的順序
    // 沒有保證——較早的那次晚落地就會把較新的蓋掉。實跑撞到：卡片停在「PR 已開」，
    // 而真正的狀態是「等你核准」，於是核准按鈕永遠不會出現。
    const prev = this.cardQueue.get(taskId) ?? Promise.resolve();
    const next = prev.then(() => this.pushCard(taskId, ts));
    this.cardQueue.set(taskId, next);
    await next;
  }

  /**
   * 清掉一張已收工的卡（連同它的 thread）。
   *
   * 只刪 thread 回覆不刪主卡，或反過來，都會留下半截垃圾：Slack 的 `chat.delete`
   * 刪掉父訊息後，thread 回覆仍然存在（實測 3 則全都讀得到），只是從頻道上看不到——
   * 所以要**先刪回覆再刪父訊息**。
   *
   * 任何一步失敗都只留 warn：這是整理版面，不是流程的一部分。
   */
  private async dismissCard(taskId: string): Promise<void> {
    const ts = this.taskThread.get(taskId) ?? this.deps.resolveCard?.(taskId)?.ts;
    if (!ts) return;
    const channel = this.idChannel('清除任務卡');
    if (!channel) return;
    const del = this.deps.client.chat.delete;
    if (!del) return;

    try {
      // 先收 thread：replies 的第一則就是父訊息本身，要排除
      const replies = await this.deps.client.conversations?.replies?.({ channel, ts });
      for (const m of (replies?.messages ?? []).filter((x) => x.ts && x.ts !== ts)) {
        await del.call(this.deps.client.chat, { channel, ts: m.ts! }).catch(() => {});
      }
      await del.call(this.deps.client.chat, { channel, ts });
      this.taskThread.delete(taskId);
      this.threadTask.delete(ts);
      this.cardState.delete(taskId);
      this.cardQueue.delete(taskId);
      this.deps.log.info({ taskId }, '任務卡已清除（含 thread）');
    } catch (e) {
      this.deps.log.warn({ taskId, err: e instanceof Error ? e.message : String(e) }, '清除任務卡失敗（不影響流程）');
    }
  }

  /**
   * 更新某個群組底下所有任務卡的狀態。
   *
   * 人按下核准/退回之後必須**立刻**有回饋，否則他不知道有沒有按到，就會重複點。
   * 群組對任務的對應優先用記憶體裡的卡片狀態，查不到再問 ledger（重啟後仍然有效）。
   */
  private async updateGroupCards(groupId: string, status: TaskCardStatus): Promise<void> {
    const ids = new Set<string>();
    for (const [taskId, st] of this.cardState) if (st.groupId === groupId) ids.add(taskId);
    for (const id of this.deps.resolveGroupTasks?.(groupId) ?? []) ids.add(id);
    await Promise.all([...ids].map((id) => this.updateTaskCard(id, status, { groupId })));
  }

  /** 送出卡片的**當下最新**狀態。排隊期間狀態又變的話，前面那次直接跳過（合併寫入）。 */
  private async pushCard(taskId: string, ts: string): Promise<void> {
    const state = this.cardState.get(taskId);
    if (!state) return;
    // prompt/options/進度變了也要重畫（同一個狀態下，內容可能不同）。
    // 進度只取輪數／檔案數／上輪結果，**刻意不含經過時間**——時間每秒都在變，
    // 納入指紋等於每次同步都重打一次 Slack API，而人也看不出秒級差異。
    const pg = state.progress;
    const fingerprint = [
      state.status,
      state.prompt ?? '',
      (state.options ?? []).join(','),
      pg?.round ?? '',
      pg?.changedFiles ?? '',
      pg?.lastOutcome ?? '',
    ].join('|');
    if (state.sent === fingerprint) return; // 已經是最新的了，不必再打一次 API

    const update = this.deps.client.chat.update;
    if (!update) return;
    const status = state.status;
    try {
      const channel = this.idChannel('更新任務卡');
      if (!channel) return;
      await update.call(this.deps.client.chat, {
        channel,
        ts,
        text: taskCardText(state.card, status),
        blocks: taskCardBlocks(state.card, status, {
          ...(state.groupId ? { groupId: state.groupId } : {}),
          ...(state.prompt ? { prompt: state.prompt } : {}),
          ...(state.options ? { options: state.options } : {}),
          ...(state.progress ? { progress: state.progress } : {}),
        }),
      });
      state.sent = fingerprint;
      this.deps.log.info({ taskId, status }, '任務卡狀態已更新');
    } catch (e) {
      this.deps.log.warn({ taskId, status, err: e instanceof Error ? e.message : String(e) }, '任務卡更新失敗（不影響任務）');
    }
  }

  async postTaskCard(task: TaskCardInput): Promise<string | undefined> {
    const ts = await this.post({ text: taskCardText(task), blocks: taskCardBlocks(task) });
    if (ts) {
      this.threadTask.set(ts, task.id);
      this.taskThread.set(task.id, ts);
      this.cardState.set(task.id, { card: task, status: 'working' });
    }
    return ts;
  }

  async event(threadTs: string | undefined, event: LifecycleEvent, task: TaskDetail): Promise<void> {
    const thread = threadTs ?? this.taskThread.get(task.id);
    // 沒有 thread 也要能推（例如 PR 開在群組層），用 task id 當節流 key
    if (!this.throttle.allow(thread ?? task.id, event)) return;
    await this.post({
      text: eventText(event),
      blocks: eventBlocks(event, { mentions: this.deps.mentions }),
      thread_ts: thread,
    });
  }

  /** 系統層通知：直接貼到頻道（沒有 thread，因為它不屬於任何任務）。 */
  async notice(text: string): Promise<void> {
    await this.post({ text });
  }

  async askClarification(threadTs: string | undefined, request: ClarificationRequest, taskId?: string): Promise<void> {
    // **所有操作都在任務卡上**：thread 是收合的，把按鈕放在裡面等於人看不到。
    // 這裡只留一句指路的文字，真正能按的東西在主卡（見 actionsFor）。
    await this.post({ text: '❓ agent 提出了問題，請到上方的任務卡回答（選項按鈕或「我來打字」）。', thread_ts: threadTs });
  }

  async askMergeApproval(threadTs: string | undefined, group: MergeApprovalInput): Promise<void> {
    // **所有操作都在任務卡上**：thread 是收合的，把按鈕放在裡面等於人看不到。
    // 這裡只留一句指路的文字，真正能按的東西在主卡（見 actionsFor）。
    await this.post({ text: '🔐 這個群組需要人工核准才能合併，請到上方的任務卡按「核准合併」或「退回」。', thread_ts: threadTs });
  }

  async askNoChangeConfirmation(threadTs: string | undefined, input: NoChangeConfirmInput): Promise<void> {
    // **所有操作都在任務卡上**：thread 是收合的，把按鈕放在裡面等於人看不到。
    // 這裡只留一句指路的文字，真正能按的東西在主卡（見 actionsFor）。
    await this.post({ text: '🟰 agent 判定這張卡不需要改動，請到上方的任務卡確認。', thread_ts: threadTs });
  }

  async postScreenshots(threadTs: string | undefined, paths: string[]): Promise<void> {
    const files = paths.filter((p) => existsSync(p));
    if (files.length === 0) {
      this.deps.log.warn({ paths }, 'Slack：截圖檔案不存在，略過上傳');
      return;
    }
    const channel = this.idChannel('上傳截圖');
    if (!channel) {
      this.deps.log.warn({ paths }, 'Slack：略過截圖上傳（頻道 ID 未知），驗證流程不受影響');
      return;
    }
    try {
      await this.deps.client.files.uploadV2({
        channel_id: channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        initial_comment: screenshotComment(files),
        file_uploads: files.map((f) => ({ file: f, filename: basename(f) })),
      });
    } catch (err) {
      // 上傳失敗只降級成文字，不能讓驗證流程跟著失敗
      this.deps.log.warn({ err: String(err) }, 'Slack：截圖上傳失敗，改貼路徑');
      await this.post({ text: '📸 截圖上傳失敗', blocks: screenshotFallbackBlocks(files), thread_ts: threadTs });
    }
  }

  // ── 入站 ──

  onAnswer(cb: (a: ClarificationAnswer) => void): void {
    this.answerCbs.push(cb);
  }
  onControl(cb: (c: ExtendedControlCommand) => void): void {
    this.controlCbs.push(cb);
  }
  onMergeDecision(cb: (d: MergeDecision) => void): void {
    this.mergeCbs.push(cb);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const socket = this.deps.socket;
    if (!socket) {
      this.deps.log.warn('Slack：未提供 app token，入站互動停用（只出站）');
      return;
    }
    // **入站事件本來就帶著頻道 ID**，先前解析出來卻丟掉。
    // 記住它等於多一個免費的來源：只要有人在 Slack 上按過按鈕或回過話，
    // 那四個需要 ID 的呼叫就能動——不必等我們自己先發出一則訊息。
    socket.onAction((a) => { this.rememberChannel(a.channel); void this.handleAction(a); });
    socket.onMessage((m) => { this.rememberChannel(m.channel); void this.handleMessage(m); });
    try {
      await socket.start();
      this.deps.log.info({ channel: this.deps.channel }, 'Slack Socket Mode 已連線');
    } catch (err) {
      // 連不上 Slack 就退化成只出站；daemon 照跑
      this.deps.log.error({ err: String(err) }, 'Slack Socket Mode 連線失敗，入站互動停用');
    }
  }

  async stop(): Promise<void> {
    if (!this.deps.socket) return;
    try {
      await this.deps.socket.stop();
    } catch (err) {
      this.deps.log.warn({ err: String(err) }, 'Slack 關閉失敗（忽略）');
    }
  }

  /**
   * 這則互動是不是點在**過期的卡片**上。
   *
   * 頻道裡會累積前幾輪留下的舊卡，上面的按鈕看起來完全一樣還能按。
   * 而按鈕的 value 帶的是 taskId／groupId——同一個任務再跑一次時 id 相同，
   * 於是點到舊卡等於對「這一輪」下了指令，人卻以為自己在操作那一輪的東西。
   * 最嚴重的情況是核准合併：看著舊卡的內容，核准掉的是新的一份改動。
   *
   * 判準：ledger 裡這個任務當前的卡片 thread 不是這一則的 thread ⇒ 過期。
   * 認不出任務時一律放行——寧可漏擋，也不要把正常的操作擋掉。
   */
  private isStaleCard(taskId: string | undefined, threadTs: string | undefined): boolean {
    if (!taskId || !threadTs) return false;
    const current = this.taskThread.get(taskId) ?? this.deps.resolveCard?.(taskId)?.ts;
    return current !== undefined && current !== threadTs;
  }

  /** 按鈕點擊：澄清選項 / 我來打字 / 合併核准 / 任務控制。 */
  private handleAction(a: InboundAction): void {
    const v = decodeActionValue(a.value);
    const taskId = v?.taskId ?? (a.threadTs ? this.taskOfThread(a.threadTs) : undefined);

    if (this.isStaleCard(taskId, a.threadTs)) {
      this.deps.log.warn({ taskId, threadTs: a.threadTs, actionId: a.actionId }, '忽略過期任務卡上的操作');
      void this.post({
        text: '⚠️ 這是舊的任務卡，操作已忽略。請到這個任務**最新的那張卡**上操作。',
        thread_ts: a.threadTs,
      });
      return;
    }

    switch (a.actionId) {
      case ACTION_IDS.clarifyOption: {
        if (!taskId || !v?.optionId) return;
        if (a.threadTs) this.pendingClarify.delete(a.threadTs);
        this.emitAnswer({ taskId, threadTs: a.threadTs ?? this.taskThread.get(taskId) ?? '', optionId: v.optionId });
        void this.post({ text: `✅ 已採用選項：${v.optionId}`, thread_ts: a.threadTs });
        return;
      }
      case ACTION_IDS.clarifyFreeText: {
        if (!taskId) return;
        // 維持 pending：接下來這條 thread 的文字回覆會被當成答案
        if (a.threadTs) this.pendingClarify.set(a.threadTs, taskId);
        void this.post({ text: '✏️ 請直接在這條 thread 回覆你的答案。', thread_ts: a.threadTs });
        return;
      }
      case ACTION_IDS.mergeApprove: {
        const groupId = v?.groupId;
        if (!groupId) return;
        this.emitMerge({ groupId, approved: true, threadTs: a.threadTs, userId: a.userId });
        // **立刻改卡片並移除按鈕**：不這樣做的話人不知道有沒有按到，會重複點，
        // 而重複核准會重複寫憑證、重複觸發合併把關。
        void this.updateGroupCards(groupId, 'merge_checking');
        void this.post({ text: '✅ 已核准，進入合併守衛', thread_ts: a.threadTs });
        return;
      }
      case ACTION_IDS.mergeReject: {
        const groupId = v?.groupId;
        if (!groupId) return;
        // **先問原因再退回**：沒有意見的退回等於只跟 agent 說「不行」卻不說哪裡不行，
        // 它下一輪多半原封不動再送一次，人再退一次——純燒錢的迴圈。
        // 接下來這條 thread 的文字會被當成修改意見（見 handleMessage 的 pendingReject）。
        if (a.threadTs) this.pendingReject.set(a.threadTs, groupId);
        void this.post({
          text: '✏️ 請在這條 thread 回覆「要改什麼」，我會把它交給 agent。\n（若只是想先停下來，回覆「無」即可）',
          thread_ts: a.threadTs,
        });
        return;
      }
      case ACTION_IDS.cardDismiss: {
        if (!taskId) return;
        void this.dismissCard(taskId);
        return;
      }
      case ACTION_IDS.taskPause:
      case ACTION_IDS.taskAbort:
      case ACTION_IDS.taskRetry: {
        if (!taskId) return;
        const type = a.actionId === ACTION_IDS.taskPause ? 'pause' : a.actionId === ACTION_IDS.taskAbort ? 'abort' : 'retry';
        this.emitControl({ type, taskId, ...(a.userId ? { userId: a.userId } : {}) } as ExtendedControlCommand);
        void this.post({ text: `🎛 已收到控制指令：${type}`, thread_ts: a.threadTs });
        return;
      }
      case ACTION_IDS.noChangeConfirm: {
        // 按鈕本身已帶 Slack 原生二次確認對話框；能走到這裡代表人真的按了「確認完成」
        if (!taskId) return;
        this.emitControl({ type: 'confirm_no_change', taskId, ...(a.userId ? { userId: a.userId } : {}) });
        void this.post({
          text: `✅ 已確認「不用做」：${taskId} 將被標記完成（不可逆）${a.userId ? `　—　by <@${a.userId}>` : ''}`,
          thread_ts: a.threadTs,
        });
        return;
      }
      case ACTION_IDS.noChangeReject: {
        if (!taskId) return;
        // 沿用 retry 的狀態轉移（回 queued 重跑），但標記來源讓稽核與後續回灌分得出來
        this.emitControl({ type: 'retry', taskId, source: 'no_change_rejected', ...(a.userId ? { userId: a.userId } : {}) });
        void this.post({ text: `🔧 已請 agent 重做 ${taskId}（不接受「無需改動」的判定）`, thread_ts: a.threadTs });
        return;
      }
      default:
        this.deps.log.debug({ actionId: a.actionId }, 'Slack：未知 action，忽略');
    }
  }

  /** thread 文字：有待答澄清 → 當自由文字答案；否則試著解成控制指令。 */
  private handleMessage(m: InboundMessage): void {
    if (!m.threadTs) return;

    // 退回的原因優先處理：它不需要 thread 對得到任務（合併核准卡掛在群層）
    const rejectGroup = this.pendingReject.get(m.threadTs);
    if (rejectGroup) {
      this.pendingReject.delete(m.threadTs);
      const raw = m.text.trim();
      // 「無」「沒有」等於「只是先停下來」，不當成修改意見送給 agent
      const reason = /^(無|沒有|no|none|-)$/i.test(raw) ? '' : raw;
      this.emitMerge({
        groupId: rejectGroup, approved: false, threadTs: m.threadTs,
        ...(m.userId ? { userId: m.userId } : {}),
        ...(reason ? { reason } : {}),
      });
      void this.updateGroupCards(rejectGroup, 'reworking');
      void this.post({
        text: reason ? '↩️ 已退回，並把你的意見交給 agent 重做。' : '↩️ 已退回（未附意見，agent 只會知道被退回）。',
        thread_ts: m.threadTs,
      });
      return;
    }

    const taskId = this.taskOfThread(m.threadTs);
    if (!taskId) return;

    const control = parseControlCommand(m.text, taskId);
    if (control) {
      this.emitControl({ ...control, ...(m.userId ? { userId: m.userId } : {}) });
      void this.post({ text: controlAck(control, taskId), thread_ts: m.threadTs });
      return;
    }

    if (this.pendingClarify.get(m.threadTs)) {
      this.pendingClarify.delete(m.threadTs);
      this.emitAnswer({ taskId, threadTs: m.threadTs, freeText: m.text.trim() });
      void this.post({ text: '✅ 已收到你的答覆，繼續執行。', thread_ts: m.threadTs });
    }
  }

  private taskOfThread(threadTs: string): string | undefined {
    return this.threadTask.get(threadTs) ?? this.deps.resolveTaskByThread?.(threadTs);
  }

  // 回呼一律隔離：訂閱者丟例外不能中斷 Slack 事件迴圈
  private emitAnswer(a: ClarificationAnswer): void {
    this.safeEmit(this.answerCbs, a, 'onAnswer');
  }
  private emitControl(c: ExtendedControlCommand): void {
    this.safeEmit(this.controlCbs, c, 'onControl');
  }
  private emitMerge(d: MergeDecision): void {
    this.safeEmit(this.mergeCbs, d, 'onMergeDecision');
  }
  private safeEmit<T>(cbs: ((x: T) => void)[], payload: T, name: string): void {
    for (const cb of cbs) {
      try {
        cb(payload);
      } catch (err) {
        this.deps.log.error({ err: String(err), cb: name }, 'Slack 回呼丟出例外');
      }
    }
  }

  /**
   * 需要**頻道 ID**的呼叫（update／delete／replies／檔案上傳）用這個取。
   *
   * 拿不到就回 undefined，呼叫端要略過——**不可以退回設定裡的名稱**：
   * 那會回一個 `channel_not_found`，看起來像「頻道不存在」，實際是
   * 「我們還沒解析出 ID」，把查的人引去完全錯的方向（實跑撞到）。
   *
   * 通常只有「這個行程還沒發過任何訊息」的空窗期會拿不到——第一則訊息貼出去、
   * 或第一個人在 Slack 上按了按鈕，ID 就記住了。要完全避開這個空窗，
   * 在設定裡把頻道填成 ID（`C…`）而不是名稱。
   */
  /**
   * 從**權威來源**記住頻道 ID（postMessage 的回應、入站事件）。
   *
   * 這裡刻意**不驗格式**：Slack 自己告訴我們的就是 ID，再拿正則去審一次
   * 只會多一種「明明拿到了卻不認」的失敗（而且那種失敗是靜默的）。
   * 格式檢查只用在**設定值**上——那才需要分辨人填的是名稱還是 ID。
   */
  private rememberChannel(id: string | undefined): void {
    if (this.channelId || !id) return;
    this.channelId = id;
    this.deps.log.info({ channelId: id }, 'Slack：已解析出頻道 ID');
  }

  private idChannel(what: string): string | undefined {
    if (this.channelId) return this.channelId;
    this.deps.log.warn(
      { channel: this.deps.channel, what },
      'Slack：還沒解析出這個頻道的 ID，暫時略過（設定填頻道 ID 而不是名稱可完全避免）',
    );
    return undefined;
  }

  /** 所有出站訊息的唯一出口：吞掉 API 錯誤並記住 channel id。 */
  private async post(msg: { text: string; blocks?: KnownBlock[]; thread_ts?: string | undefined }): Promise<string | undefined> {
    try {
      const res = await this.deps.client.chat.postMessage({
        channel: this.channelId ?? this.deps.channel,
        text: msg.text,
        ...(msg.blocks ? { blocks: msg.blocks } : {}),
        ...(msg.thread_ts ? { thread_ts: msg.thread_ts } : {}),
      });
      this.rememberChannel(res.channel);
      return res.ts;
    } catch (err) {
      this.deps.log.error({ err: String(err), text: msg.text }, 'Slack 發送失敗（已忽略，不影響任務）');
      return undefined;
    }
  }
}

// ── 降級實作：沒設定 Slack 時的 no-op（委派 ConsoleNotifier） ──

export class ConsoleGateway implements HumanGateway {
  private inner: ConsoleNotifier;
  constructor(private log: Logger) {
    this.inner = new ConsoleNotifier(log);
  }
  /** Slack 未啟用：狀態只寫 log（人翻 log 仍看得到進展）。 */
  async updateTaskCard(taskId: string, status: TaskCardStatus): Promise<void> {
    this.log.info({ taskId, status }, '任務狀態變更（Slack 未啟用）');
  }

  async postTaskCard(task: TaskCardInput): Promise<string | undefined> {
    this.log.info({ taskId: task.id }, `🟡 任務卡（Slack 未啟用）：${task.title}`);
    return undefined;
  }
  async event(threadTs: string | undefined, event: LifecycleEvent, task: TaskDetail): Promise<void> {
    this.inner.event(threadTs, event, task);
  }
  /** 系統層通知：Slack 未啟用時只留 log（人看得到，但不會有推播）。 */
  async notice(text: string): Promise<void> {
    this.log.warn({ text }, '🔔 系統通知（Slack 未啟用）');
  }

  async askClarification(_threadTs: string | undefined, request: ClarificationRequest, taskId?: string): Promise<void> {
    // Slack 未啟用時無人可問：只留下痕跡，等待逾時政策（低風險採建議預設）處理
    this.log.warn({ taskId, options: request.options.map((o) => o.id) }, `❓ 需澄清（Slack 未啟用）：${request.question}`);
  }
  async askMergeApproval(_threadTs: string | undefined, group: MergeApprovalInput): Promise<void> {
    this.log.warn({ groupId: group.groupId, branch: group.branch }, '🔐 合併需人工核准（Slack 未啟用，等待人工處理）');
  }
  async askNoChangeConfirmation(_threadTs: string | undefined, input: NoChangeConfirmInput): Promise<void> {
    // 安全 no-op，但必須讓人知道「有一張卡卡在等確認」，否則它會無聲地 park 到天荒地老
    this.log.warn(
      {
        taskId: input.taskId,
        category: input.category,
        reason: input.reason,
        evidence: input.evidence,
      },
      `🤔 有一張卡等你確認「不用做」：${input.taskId}（${NO_CHANGE_CATEGORY_LABEL[input.category] ?? input.category}）。` +
        'Slack 未啟用，無法從 Slack 操作——任務會停在 blocked:needs_human，' +
        '請啟用 Slack 後按 [確認不用做] / [請你去做]，或直接在任務板上處理這張卡。',
    );
  }
  async postScreenshots(_threadTs: string | undefined, paths: string[]): Promise<void> {
    this.log.info({ paths }, '📸 截圖（Slack 未啟用，僅留本機路徑）');
  }
  // 無入站通道：收下 callback 但永不觸發（保持與 HumanGateway 相同簽名，呼叫端無需分支）
  onAnswer(_cb: (a: ClarificationAnswer) => void): void {}
  onControl(_cb: (c: ExtendedControlCommand) => void): void {}
  onMergeDecision(_cb: (d: MergeDecision) => void): void {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

// ── Bolt Socket Mode 轉接（把 Bolt 的型別限制在這一小塊） ──

/** pino → Bolt logger 轉接，讓 Slack SDK 的 log 也進同一條 pino 管線。 */
function toBoltLogger(log: Logger): BoltLogger {
  const fmt = (msg: unknown[]): string => msg.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ');
  return {
    debug: (...m) => log.debug(fmt(m)),
    info: (...m) => log.info(fmt(m)),
    warn: (...m) => log.warn(fmt(m)),
    error: (...m) => log.error(fmt(m)),
    setLevel: () => {},
    getLevel: () => LogLevel.INFO,
    setName: () => {},
  };
}

/** 用 @slack/bolt App（Socket Mode）實作 SlackSocketLike。 */
export class BoltSocket implements SlackSocketLike {
  /**
   * 所有 action 訂閱者。**必須自己扇出，不能各自向 Bolt 註冊**：
   * onAction 有兩個呼叫端（gateway 的任務卡、App Home 的面板），
   * 各自註冊 catch-all 就會有兩個 listener 收到同一則互動、各 ack 一次，
   * Bolt 於是每按一次按鈕就印一行「ack() has already been called」。
   * 第二次 ack 被忽略本身無害，但它是「同一則事件被處理兩遍」的徵兆——
   * 真正危險的是處理函式若有副作用（例如再次寫入裁決），就會重複執行。
   */
  private actionHandlers: ((a: InboundAction) => void | Promise<void>)[] = [];
  private actionBound = false;

  constructor(private app: App, private log: Logger) {}

  onAction(handler: (a: InboundAction) => void | Promise<void>): void {
    this.actionHandlers.push(handler);
    if (this.actionBound) return;
    this.actionBound = true;
    // 用 catch-all 正則接住所有 action_id，再由各訂閱者依 ACTION_IDS 自行分派
    this.app.action(/.*/, async ({ ack, body }) => {
      await ack(); // 整個行程只有這一處 ack action
      for (const a of parseBlockActions(body)) {
        for (const h of this.actionHandlers) {
          // 一個訂閱者出錯不該讓其餘訂閱者收不到（面板壞掉不能影響任務卡的裁決）
          try {
            await h(a);
          } catch (e) {
            this.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'Slack action 訂閱者擲錯（忽略）');
          }
        }
      }
    });
  }

  onMessage(handler: (m: InboundMessage) => void | Promise<void>): void {
    this.app.message(async ({ message }) => {
      const parsed = parseMessageEvent(message);
      if (parsed) await handler(parsed);
    });
  }

  onHomeOpened(handler: (userId: string) => void | Promise<void>): void {
    this.app.event('app_home_opened', async ({ event }) => {
      // tab 有 'home' 與 'messages' 兩種；只有 home 要重新發佈，否則使用者一開 DM 就會多打一次 API
      const e = event as { user?: string; tab?: string };
      if (e.tab && e.tab !== 'home') return;
      if (e.user) await handler(e.user);
    });
  }

  onSlashCommand(handler: (c: InboundSlashCommand) => Promise<string>): void {
    // 指令名固定為 /orch；Slack 那邊要先註冊同名指令，否則這個 listener 不會被觸發
    this.app.command('/orch', async ({ command, ack, respond }) => {
      await ack(); // 3 秒內必須 ack，否則使用者會看到 operation_timeout
      const text = await handler({ text: command.text ?? '', userId: command.user_id, channel: command.channel_id });
      await respond({ response_type: 'ephemeral', text });
    });
  }

  async start(): Promise<void> {
    this.app.error(async (err) => {
      // Bolt 的全域錯誤處理：不 rethrow，避免 socket 斷線連帶拖垮 daemon
      this.log.error({ err: String(err) }, 'Slack Bolt 事件處理錯誤');
    });
    await this.app.start();
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}

// ── Factory ──

export interface SlackSettings {
  enabled?: boolean;
  botToken?: string;
  appToken?: string;
  channel?: string;
}

export interface CreateNotifierOptions {
  /** 提問/失敗要 @ 的 Slack user id；預設讀 env SLACK_MENTION_USER_IDS（逗號分隔）。 */
  mentions?: string[];
  resolveTaskByThread?: (threadTs: string) => string | undefined;
  /** 跨重啟重建任務卡（見 SlackGatewayDeps.resolveCard）。 */
  resolveCard?: (taskId: string) => { ts: string; card: TaskCardInput } | undefined;
  /** groupId → 該群的任務 id（由 ledger 提供，讓裁決後的卡片更新跨重啟也有效）。 */
  resolveGroupTasks?: (groupId: string) => string[];
  throttle?: Partial<ThrottleOptions>;
}

/**
 * 依設定產生人機介面：Slack 可用 → SlackGateway；否則 → ConsoleGateway（委派既有 ConsoleNotifier）。
 * 缺 appToken 仍可只出站；建構 Slack client 失敗也退回 console，**永遠不 throw**。
 */
/** SlackGateway 對外提供的底層把手（App Home 用）。 */
export interface SlackRuntimeHandles {
  views?: SlackViewsLike;
  socket?: SlackSocketLike;
}

/** 從 HumanGateway 取出 Slack 把手；不是 SlackGateway（例如 console 降級）就回空物件。 */
export function slackHandlesOf(g: unknown): SlackRuntimeHandles {
  const h = (g as { handles?: () => SlackRuntimeHandles }).handles;
  return typeof h === 'function' ? h.call(g) : {};
}

export function createNotifier(
  config: { slack?: SlackSettings },
  log: Logger,
  opts: CreateNotifierOptions = {},
): HumanGateway {
  const s = config.slack;
  if (!s?.enabled) {
    log.info('Slack 未啟用（slack.enabled=false），使用 console 通知');
    return new ConsoleGateway(log);
  }
  if (!s.botToken) {
    log.warn('Slack 已啟用但缺 botToken（SLACK_BOT_TOKEN），降級為 console 通知');
    return new ConsoleGateway(log);
  }

  try {
    const client = new webApi.WebClient(s.botToken, { logger: toBoltLogger(log) });
    let socket: SlackSocketLike | undefined;
    if (s.appToken) {
      const app = new App({
        token: s.botToken,
        appToken: s.appToken,
        socketMode: true,
        logger: toBoltLogger(log),
        logLevel: LogLevel.WARN,
      });
      socket = new BoltSocket(app, log);
    } else {
      log.warn('Slack 缺 appToken（SLACK_APP_TOKEN），Socket Mode 入站停用，僅出站通知');
    }

    return new SlackGateway({
      // WebClient 的 chat/files 方法涵蓋 SlackWebLike 所需子集（參數為超集）
      client: client as unknown as SlackWebLike,
      channel: s.channel ?? '#dev-orchestrator',
      log,
      socket,
      views: client.views as unknown as SlackViewsLike,
      mentions: opts.mentions ?? parseMentionEnv(process.env.SLACK_MENTION_USER_IDS),
      ...(opts.resolveTaskByThread ? { resolveTaskByThread: opts.resolveTaskByThread } : {}),
      ...(opts.resolveCard ? { resolveCard: opts.resolveCard } : {}),
      ...(opts.resolveGroupTasks ? { resolveGroupTasks: opts.resolveGroupTasks } : {}),
      ...(opts.throttle ? { throttle: opts.throttle } : {}),
    });
  } catch (err) {
    log.error({ err: String(err) }, 'Slack 初始化失敗，降級為 console 通知');
    return new ConsoleGateway(log);
  }
}

function parseMentionEnv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}
