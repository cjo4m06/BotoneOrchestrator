// src/slack/gateway.ts 的單元測試：全部用假件（不打真實 Slack、不開 Socket Mode）。
// 執行：npx tsx --test test/slack-gateway.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import {
  BoltSocket,
  ConsoleGateway,
  EventThrottle,
  SlackGateway,
  createNotifier,
  parseBlockActions,
  parseControlCommand,
  parseMessageEvent,
  type FileUploadArgs,
  type InboundAction,
  type InboundMessage,
  type PostMessageArgs,
  type SlackSocketLike,
  type SlackWebLike,
} from '../src/slack/gateway.js';
import { ACTION_IDS, encodeActionValue } from '../src/slack/blocks.js';
import { createRecordingLogger, createTmpLedger, makeDiscoveredTask } from './helpers/index.js';
import { InboundRouter } from '../src/notify/notifier.js';
import type { Logger } from '../src/observability/logger.js';
import type { ExtendedControlCommand, NoChangeConfirmInput } from '../src/notify/notifier.js';
import type { ClarificationAnswer, ClarificationRequest, TaskDetail } from '../src/types.js';

const log = pino({ enabled: false }) as unknown as Logger;

/** 假 WebClient：記錄所有出站呼叫，可切換成失敗。 */
class FakeSlackWeb implements SlackWebLike {
  sent: PostMessageArgs[] = [];
  updates: { channel: string; ts: string; text: string; blocks?: unknown[] }[] = [];
  uploads: FileUploadArgs[] = [];
  postFails = false;
  uploadFails = false;
  updateFails = false;
  /** 每次 update 的延遲（毫秒），用來製造亂序落地。 */
  updateDelays: number[] = [];

  chat = {
    postMessage: async (args: PostMessageArgs) => {
      this.sent.push(args);
      if (this.postFails) throw new Error('slack down');
      return { ts: `ts-${this.sent.length}`, channel: 'C999' };
    },
    update: async (args: { channel: string; ts: string; text: string; blocks?: unknown[] }) => {
      // 可注入延遲：真實網路下先發的請求可能後到，這正是卡片互蓋的成因
      if (this.updateDelays.length > 0) {
        await new Promise((r) => setTimeout(r, this.updateDelays.shift()));
      }
      this.updates.push(args);
      if (this.updateFails) throw new Error('message_not_found');
      return {};
    },
  };
  files = {
    uploadV2: async (args: FileUploadArgs) => {
      this.uploads.push(args);
      if (this.uploadFails) throw new Error('upload failed');
      return {};
    },
  };
}

/** 假 Socket Mode：測試自己觸發入站事件。 */
class FakeSocket implements SlackSocketLike {
  started = false;
  private actionH?: (a: InboundAction) => void | Promise<void>;
  private messageH?: (m: InboundMessage) => void | Promise<void>;
  onAction(h: (a: InboundAction) => void | Promise<void>): void {
    this.actionH = h;
  }
  onMessage(h: (m: InboundMessage) => void | Promise<void>): void {
    this.messageH = h;
  }
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.started = false;
  }
  async click(a: InboundAction): Promise<void> {
    await this.actionH?.(a);
    await flush();
  }
  async say(m: InboundMessage): Promise<void> {
    await this.messageH?.(m);
    await flush();
  }
}

/** 等 gateway 內部 `void this.post(...)` 的 microtask 跑完。 */
function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

const task: TaskDetail = {
  id: 'T-1',
  title: '修 RWD',
  status: 'todo',
  repo: 'acme/web',
  category: 'bug',
  description: 'desc',
  dependencies: [],
  docRefs: ['spec.md#a'],
};

async function setup(opts: { socket?: FakeSocket; updateFails?: boolean; channel?: string; card?: { ts: string } } = {}) {
  const client = new FakeSlackWeb();
  client.updateFails = opts.updateFails === true;
  const gw = new SlackGateway({
    client,
    // **預設用頻道 ID 不是名稱。** update／delete／replies／檔案上傳只吃 ID，
    // 拿名稱去打會回 channel_not_found（實跑 2026-08-05 撞到）。
    // 假件先前填 '#dev' 卻照樣通過，是因為它自己不管參數長怎樣。
    // 想測「設定填名稱、ID 靠 API 學回來」那條路的，傳 opts.channel 進來。
    channel: opts.channel ?? 'C999DEV',
    log,
    // 模擬「daemon 重啟後從 ledger 重建卡片位置」——那正是還沒發過訊息就要動卡片的時機
    ...(opts.card ? { resolveCard: () => ({ ts: opts.card!.ts, card: { id: task.id, title: 't', repo: 'acme/web', category: 'dev' as const } }) } : {}),
    ...(opts.socket ? { socket: opts.socket } : {}),
    // 節流關掉時間因素，讓多數測試專注在行為
    throttle: { iterateMinIntervalMs: 0 },
  });
  if (opts.socket) await gw.start();
  return { client, gw };
}

// ── 出站 ──

test('postTaskCard：貼到頻道（非 thread）並回傳 thread_ts', async () => {
  const { client, gw } = await setup();
  const ts = await gw.postTaskCard(task);
  assert.equal(ts, 'ts-1');
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0]!.channel, 'C999DEV');
  assert.equal(client.sent[0]!.thread_ts, undefined);
  assert.ok(client.sent[0]!.blocks && client.sent[0]!.blocks.length > 0);
});

test('event：threaded 回覆掛在任務卡底下', async () => {
  const { client, gw } = await setup();
  const ts = await gw.postTaskCard(task);
  await gw.event(ts, { type: 'pr_open', url: 'https://gh/pr/1' }, task);
  assert.equal(client.sent[1]!.thread_ts, 'ts-1');
  assert.match(JSON.stringify(client.sent[1]!.blocks), /https:\/\/gh\/pr\/1/);
});

test('event：threadTs 未帶時自動回落到該任務的 thread', async () => {
  const { client, gw } = await setup();
  await gw.postTaskCard(task);
  await gw.event(undefined, { type: 'merged' }, task);
  assert.equal(client.sent[1]!.thread_ts, 'ts-1');
});

test('event：Slack API 失敗不 throw（daemon 不能被 Slack 拖垮）', async () => {
  const { client, gw } = await setup();
  client.postFails = true;
  await gw.event('ts-x', { type: 'failed', detail: 'boom' }, task);
  assert.equal(await gw.postTaskCard(task), undefined);
});

test('噪音控制：例行迭代降頻、docs_read 只推一次、狀態轉移照推', async () => {
  const { client, gw } = await setup();
  const ts = (await gw.postTaskCard(task))!;
  const before = client.sent.length;

  for (let round = 1; round <= 12; round++) {
    await gw.event(ts, { type: 'iterating', round }, task);
  }
  await gw.event(ts, { type: 'docs_read', refs: ['a'] }, task);
  await gw.event(ts, { type: 'docs_read', refs: ['a'] }, task);
  await gw.event(ts, { type: 'claimed' }, task);
  await gw.event(ts, { type: 'merged' }, task);

  const posted = client.sent.slice(before).map((s) => s.text);
  // 12 輪只推第 1、10 輪
  assert.deepEqual(posted.filter((t) => t.includes('實作中')), ['🔧 實作中（第 1 輪）', '🔧 實作中（第 10 輪）']);
  assert.equal(posted.filter((t) => t.includes('已讀規格')).length, 1);
  assert.equal(posted.filter((t) => t.includes('已認領')).length, 1);
  assert.equal(posted.filter((t) => t.includes('已合併')).length, 1);
});

test('EventThrottle：重複的「遇到問題」有冷卻，時間到就放行', () => {
  let now = 1_000_000;
  const th = new EventThrottle({ problemCooldownMs: 1000 }, () => now);

  assert.equal(th.allow('t1', { type: 'problem', detail: '429' }), true);
  assert.equal(th.allow('t1', { type: 'problem', detail: '429' }), false);
  assert.equal(th.allow('t1', { type: 'problem', detail: '500' }), true); // 不同問題照推
  now += 1001;
  assert.equal(th.allow('t1', { type: 'problem', detail: '429' }), true);
  // 節流狀態逐 thread 獨立
  assert.equal(th.allow('t2', { type: 'problem', detail: '429' }), true);
});


/**
 * 實跑（2026-08-05）：`清除任務卡失敗 err: channel_not_found`，而同一時間所有通知都正常。
 *
 * 成因：Slack 對「頻道名稱」的容忍度不一致——`chat.postMessage` 吃得下 `#dev`，
 * 但 `chat.update`／`chat.delete`／`conversations.replies`／`files.uploadV2` 只吃 ID。
 * 而程式對這四個都用同一段 `channelId ?? deps.channel` 退回名稱。
 *
 * 錯誤訊息還會把人引去錯的方向：它說「找不到頻道」，實際是「我們還沒解析出 ID」。
 */
test('頻道 ID 未知時，需要 ID 的呼叫要略過而不是拿名稱去打 API', async () => {
  // 設定填的是名稱，而且這個行程還沒發過任何訊息 —— 正是實跑出事的時機（重啟後）
  const { client, gw } = await setup({ channel: '#dev', card: { ts: '900.1' } });

  await gw.updateTaskCard(task.id, 'reviewing');

  assert.deepEqual(client.updates, [], '拿名稱去打 chat.update 會回 channel_not_found');
});

test('設定直接填頻道 ID → 第一秒就能更新卡片，不必等我們先發訊息', async () => {
  const { client, gw } = await setup({ channel: 'C0123456789', card: { ts: '900.1' } });

  await gw.updateTaskCard(task.id, 'reviewing');

  assert.equal(client.updates.length, 1);
  assert.equal(client.updates[0]!.channel, 'C0123456789');
});

test('設定填名稱、但發過訊息之後 → 用 API 學回來的 ID，不是名稱', async () => {
  const { client, gw } = await setup({ channel: '#dev' });
  await gw.postTaskCard(task);

  await gw.updateTaskCard(task.id, 'reviewing');

  assert.equal(client.updates.length, 1);
  assert.equal(client.updates[0]!.channel, 'C999', '退回 #dev 會 channel_not_found');
});

test('postScreenshots：uploadV2 帶 channel id、thread_ts 與檔名；不存在的檔案略過', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-shot-'));
  const png = join(dir, 'home-1280.png');
  writeFileSync(png, 'fake');

  // 設定填的是**名稱**，ID 要從 postMessage 的回應學回來——這條路正是實跑出事的地方。
  const { client, gw } = await setup({ channel: '#dev' });
  const ts = (await gw.postTaskCard(task))!; // 先讓 gateway 記住 channel id
  await gw.postScreenshots(ts, [png, join(dir, 'missing.png')]);

  assert.equal(client.uploads.length, 1);
  const up = client.uploads[0]!;
  assert.equal(up.channel_id, 'C999'); // 用 API 回傳的 id，而非 "#dev"
  assert.equal(up.thread_ts, ts);
  assert.deepEqual(up.file_uploads, [{ file: png, filename: 'home-1280.png' }]);
  assert.match(up.initial_comment!, /home-1280\.png/);
});

test('postScreenshots：全部檔案不存在 → 不呼叫上傳', async () => {
  const { client, gw } = await setup();
  await gw.postScreenshots('ts-1', ['/nope/a.png']);
  assert.equal(client.uploads.length, 0);
});

test('postScreenshots：上傳失敗 → 降級貼路徑，不 throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-shot-'));
  const png = join(dir, 'a.png');
  writeFileSync(png, 'x');
  const { client, gw } = await setup();
  client.uploadFails = true;
  await gw.postScreenshots('ts-9', [png]);
  assert.match(JSON.stringify(client.sent.at(-1)), /a\.png/);
  assert.equal(client.sent.at(-1)!.thread_ts, 'ts-9');
});

// ── 入站 ──

test('澄清按鈕：點選項 → onAnswer 帶 optionId，並在 thread 回覆確認', async () => {
  const socket = new FakeSocket();
  const { client, gw } = await setup({ socket });
  const ts = (await gw.postTaskCard(task))!;
  const answers: ClarificationAnswer[] = [];
  gw.onAnswer((a) => answers.push(a));

  const req: ClarificationRequest = {
    question: 'q?',
    options: [{ id: 'restock', label: '退庫存', recommended: true }],
    rationale: 'r',
  };
  await gw.askClarification(ts, req, task.id);

  await socket.click({
    actionId: ACTION_IDS.clarifyOption,
    value: encodeActionValue({ taskId: task.id, optionId: 'restock' }),
    threadTs: ts,
    userId: 'U1',
  });

  assert.deepEqual(answers, [{ taskId: 'T-1', threadTs: ts, optionId: 'restock' }]);
  assert.match(client.sent.at(-1)!.text, /已採用選項：restock/);
});

test('澄清自由文字：按「我來打字」後，thread 回覆成為答案', async () => {
  const socket = new FakeSocket();
  const { gw } = await setup({ socket });
  const ts = (await gw.postTaskCard(task))!;
  const answers: ClarificationAnswer[] = [];
  gw.onAnswer((a) => answers.push(a));

  await socket.click({ actionId: ACTION_IDS.clarifyFreeText, value: encodeActionValue({ taskId: task.id }), threadTs: ts });
  await socket.say({ text: '  用 soft delete  ', threadTs: ts, userId: 'U1' });

  assert.deepEqual(answers, [{ taskId: 'T-1', threadTs: ts, freeText: '用 soft delete' }]);

  // 已答覆後，同一條 thread 的閒聊不會再被當成答案
  await socket.say({ text: '順便說一下', threadTs: ts, userId: 'U1' });
  assert.equal(answers.length, 1);
});

test('沒有待答澄清時，thread 文字只有控制指令會被採用', async () => {
  const socket = new FakeSocket();
  const { gw } = await setup({ socket });
  const ts = (await gw.postTaskCard(task))!;
  const answers: ClarificationAnswer[] = [];
  const controls: ExtendedControlCommand[] = [];
  gw.onAnswer((a) => answers.push(a));
  gw.onControl((c) => controls.push(c));

  await socket.say({ text: '這段 code 看起來怪怪的', threadTs: ts });
  await socket.say({ text: '暫停', threadTs: ts });
  await socket.say({ text: '用你的預設', threadTs: ts });

  assert.equal(answers.length, 0);
  assert.deepEqual(controls, [
    { type: 'pause', taskId: 'T-1' },
    { type: 'use_default', taskId: 'T-1' },
  ]);
});

test('控制按鈕：任務卡上的暫停/中止/重試會派出 ControlCommand', async () => {
  const socket = new FakeSocket();
  const { gw } = await setup({ socket });
  const ts = (await gw.postTaskCard(task))!;
  const controls: ExtendedControlCommand[] = [];
  gw.onControl((c) => controls.push(c));

  const value = encodeActionValue({ taskId: task.id });
  await socket.click({ actionId: ACTION_IDS.taskPause, value, threadTs: ts });
  await socket.click({ actionId: ACTION_IDS.taskAbort, value, threadTs: ts });
  await socket.click({ actionId: ACTION_IDS.taskRetry, value, threadTs: ts });

  assert.deepEqual(controls, [
    { type: 'pause', taskId: 'T-1' },
    { type: 'abort', taskId: 'T-1' },
    { type: 'retry', taskId: 'T-1' },
  ]);
});

// ── 「這張卡不用做」的人工出口（DESIGN §7b） ──

const noChange: NoChangeConfirmInput = {
  taskId: 'T-1',
  title: '修 RWD',
  category: 'already_satisfied',
  reason: '這段 RWD 上個 sprint 已經修過',
  evidence: 'src/checkout.css:88 已有 media query',
};

/**
 * **所有操作都在任務卡上**：thread 是收合的，把按鈕放在裡面等於人看不到有事要處理。
 * 這裡只該留一句指路的文字。
 */
test('askNoChangeConfirmation：thread 只留指路文字，按鈕在主卡上', async () => {
  const { client, gw } = await setup({ socket: new FakeSocket() });
  await gw.askNoChangeConfirmation('ts-1', {
    taskId: 'T-1', title: 't', category: 'already_satisfied', reason: '早就做過了',
  });
  const last = client.sent.at(-1)!;
  assert.equal(last.thread_ts, 'ts-1');
  assert.match(last.text, /任務卡/);
  assert.equal((last.blocks ?? []).some((b: { type?: string }) => b.type === 'actions'), false, 'thread 不該有按鈕');
});

test('按 [確認不用做] → confirm_no_change（帶 userId），回執明講不可逆', async () => {
  const socket = new FakeSocket();
  const { client, gw } = await setup({ socket });
  const ts = (await gw.postTaskCard(task))!;
  const controls: ExtendedControlCommand[] = [];
  gw.onControl((c) => controls.push(c));

  await socket.click({
    actionId: ACTION_IDS.noChangeConfirm,
    value: encodeActionValue({ taskId: task.id }),
    threadTs: ts,
    userId: 'U9',
  });

  assert.deepEqual(controls, [{ type: 'confirm_no_change', taskId: 'T-1', userId: 'U9' }]);
  assert.match(client.sent.at(-1)!.text, /不可逆/);
});

test('按 [請你去做] → retry 但標記 source，稽核分得出來不是一般 retry', async () => {
  const socket = new FakeSocket();
  const { client, gw } = await setup({ socket });
  const ts = (await gw.postTaskCard(task))!;
  const controls: ExtendedControlCommand[] = [];
  gw.onControl((c) => controls.push(c));

  await socket.click({
    actionId: ACTION_IDS.noChangeReject,
    value: encodeActionValue({ taskId: task.id }),
    threadTs: ts,
    userId: 'U9',
  });

  assert.deepEqual(controls, [{ type: 'retry', taskId: 'T-1', source: 'no_change_rejected', userId: 'U9' }]);
  assert.match(client.sent.at(-1)!.text, /重做/);
});

test('thread 文字也能裁決：「確認不用做」/「請你去做」', async () => {
  const socket = new FakeSocket();
  const { gw } = await setup({ socket });
  const ts = (await gw.postTaskCard(task))!;
  const controls: ExtendedControlCommand[] = [];
  gw.onControl((c) => controls.push(c));

  await socket.say({ text: '確認不用做', threadTs: ts, userId: 'U9' });
  await socket.say({ text: '請你去做', threadTs: ts, userId: 'U9' });

  assert.deepEqual(controls, [
    { type: 'confirm_no_change', taskId: 'T-1', userId: 'U9' },
    { type: 'retry', taskId: 'T-1', source: 'no_change_rejected', userId: 'U9' },
  ]);
});

test('端到端：worker park → Slack 按鈕 → InboundRouter → complete_task + 標 done', async () => {
  const socket = new FakeSocket();
  const { client, gw } = await setup({ socket });
  const tmp = createTmpLedger();
  try {
    const completed: string[] = [];
    new InboundRouter({
      ledger: tmp.ledger,
      log,
      completeTask: async (id) => {
        completed.push(id);
        return { ok: true, value: undefined };
      },
    }).attach(gw);

    // 1) worker 判定無需改動 → park 等人確認（和 Worker.handleNoChange 落的痕跡一致）
    tmp.ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-1' }));
    tmp.ledger.logEvent(
      'task',
      'T-1',
      'no_change_reported',
      JSON.stringify({ category: 'already_satisfied', reason: '上個 sprint 修過了' }),
    );
    tmp.ledger.setBlock('T-1', 'needs_human', '無需改動：現況已符合需求：上個 sprint 修過了');

    // 2) 貼出附按鈕的確認訊息
    const ts = (await gw.postTaskCard(task))!;
    await gw.askNoChangeConfirmation(ts, noChange);
    // 按鈕已移到主卡；thread 只留一句指路的文字
  assert.match(client.sent.at(-1)!.text, /任務卡/);

    // 3) 人按下「確認不用做」
    await socket.click({
      actionId: ACTION_IDS.noChangeConfirm,
      value: encodeActionValue({ taskId: 'T-1' }),
      threadTs: ts,
      userId: 'U9',
    });
    await new Promise((r) => setImmediate(r)); // InboundRouter 的非同步 MCP 呼叫

    assert.deepEqual(completed, ['T-1'], '這就是原本缺席的出口：確認 → complete_task');
    assert.equal(tmp.ledger.getTask('T-1')?.state, 'done');
    assert.ok(tmp.ledger.latestEvent('task', 'T-1', 'no_change_confirmed'), '要留稽核');
  } finally {
    tmp.cleanup();
  }
});

test('端到端：按 [請你去做] → 任務回 queued 重跑，且不會碰 complete_task', async () => {
  const socket = new FakeSocket();
  const { gw } = await setup({ socket });
  const tmp = createTmpLedger();
  try {
    const completed: string[] = [];
    new InboundRouter({
      ledger: tmp.ledger,
      log,
      completeTask: async (id) => {
        completed.push(id);
        return { ok: true, value: undefined };
      },
    }).attach(gw);

    tmp.ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-1' }));
    tmp.ledger.logEvent('task', 'T-1', 'no_change_reported', JSON.stringify({ category: 'spec_unclear', reason: 'r' }));
    tmp.ledger.setBlock('T-1', 'needs_human', '無需改動：規格不足以判斷：r');
    const ts = (await gw.postTaskCard(task))!;

    await socket.click({
      actionId: ACTION_IDS.noChangeReject,
      value: encodeActionValue({ taskId: 'T-1' }),
      threadTs: ts,
      userId: 'U9',
    });
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(completed, []);
    assert.equal(tmp.ledger.getTask('T-1')?.state, 'queued');
    assert.ok(tmp.ledger.latestEvent('task', 'T-1', 'no_change_rejected'));
  } finally {
    tmp.cleanup();
  }
});

test('合併核准閘門：核准立刻生效，退回則先問原因', async () => {
  const socket = new FakeSocket();
  const { client, gw } = await setup({ socket });
  const decisions: { groupId: string; approved: boolean; reason?: string }[] = [];
  gw.onMergeDecision((d) => decisions.push({ groupId: d.groupId, approved: d.approved, ...(d.reason ? { reason: d.reason } : {}) }));

  await gw.askMergeApproval('ts-root', { groupId: 'g1', branch: 'orch/g1', repo: 'acme/web', taskTitles: ['a'] });
  assert.equal(client.sent.at(-1)!.thread_ts, 'ts-root');

  const value = encodeActionValue({ groupId: 'g1' });
  await socket.click({ actionId: ACTION_IDS.mergeApprove, value, threadTs: 'ts-root', userId: 'U1' });
  assert.deepEqual(decisions, [{ groupId: 'g1', approved: true }], '核准不需要多問一步');

  // 退回：先問「要改什麼」，此時還不該送出裁決
  await socket.click({ actionId: ACTION_IDS.mergeReject, value, threadTs: 'ts-root', userId: 'U1' });
  assert.equal(decisions.length, 1, '還沒說明原因前不該送出退回');
  assert.match(client.sent.at(-1)!.text, /要改什麼/);

  // thread 內的下一則文字就是修改意見
  await socket.say({ text: '時間請改成 24 小時制並加上星期幾', threadTs: 'ts-root', userId: 'U1' });
  assert.deepEqual(decisions[1], { groupId: 'g1', approved: false, reason: '時間請改成 24 小時制並加上星期幾' });
  assert.match(client.sent.at(-1)!.text, /交給 agent/);
});

/**
 * 沒有意見的退回等於只跟 agent 說「不行」卻不說哪裡不行，
 * 它下一輪多半原封不動再送一次，人再退一次——純燒錢的迴圈。
 * 所以「先停下來」要能表達，但要明白告訴人後果。
 */
test('合併退回：回覆「無」= 只是先停下來，不附意見', async () => {
  const socket = new FakeSocket();
  const { client, gw } = await setup({ socket });
  const decisions: { approved: boolean; reason?: string }[] = [];
  gw.onMergeDecision((d) => decisions.push({ approved: d.approved, ...(d.reason ? { reason: d.reason } : {}) }));

  await gw.askMergeApproval('ts-root', { groupId: 'g1', branch: 'b', repo: 'acme/web', taskTitles: ['a'] });
  await socket.click({ actionId: ACTION_IDS.mergeReject, value: encodeActionValue({ groupId: 'g1' }), threadTs: 'ts-root', userId: 'U1' });
  await socket.say({ text: '無', threadTs: 'ts-root', userId: 'U1' });

  assert.deepEqual(decisions, [{ approved: false }], '「無」不該被當成修改意見送給 agent');
  assert.match(client.sent.at(-1)!.text, /未附意見/);
});

test('合併退回：問了原因之後，同一條 thread 的後續發言不再被當成退回意見', async () => {
  const socket = new FakeSocket();
  const { gw } = await setup({ socket });
  const decisions: unknown[] = [];
  gw.onMergeDecision((d) => decisions.push(d));

  await gw.askMergeApproval('ts-root', { groupId: 'g1', branch: 'b', repo: 'acme/web', taskTitles: ['a'] });
  await socket.click({ actionId: ACTION_IDS.mergeReject, value: encodeActionValue({ groupId: 'g1' }), threadTs: 'ts-root', userId: 'U1' });
  await socket.say({ text: '第一則是意見', threadTs: 'ts-root', userId: 'U1' });
  await socket.say({ text: '第二則只是閒聊', threadTs: 'ts-root', userId: 'U1' });

  assert.equal(decisions.length, 1, '只有第一則算意見');
});


test('入站：未知 action、缺 value、不認得的 thread 都安全忽略', async () => {
  const socket = new FakeSocket();
  const { gw } = await setup({ socket });
  const answers: ClarificationAnswer[] = [];
  const controls: ExtendedControlCommand[] = [];
  gw.onAnswer((a) => answers.push(a));
  gw.onControl((c) => controls.push(c));

  await socket.click({ actionId: 'someone_elses_button', value: 'x', threadTs: 'ts-1' });
  await socket.click({ actionId: ACTION_IDS.clarifyOption, threadTs: 'ts-1' });
  await socket.click({ actionId: ACTION_IDS.mergeApprove, value: '{}', threadTs: 'ts-1' });
  await socket.say({ text: '暫停', threadTs: 'unknown-thread' });

  assert.equal(answers.length, 0);
  assert.equal(controls.length, 0);
});

test('resolveTaskByThread：重啟後靠 ledger 反查也能接受控制指令', async () => {
  const socket = new FakeSocket();
  const client = new FakeSlackWeb();
  const gw = new SlackGateway({
    client,
    channel: 'C999DEV',
    log,
    socket,
    resolveTaskByThread: (ts) => (ts === 'ts-old' ? 'T-old' : undefined),
  });
  await gw.start();
  const controls: ExtendedControlCommand[] = [];
  gw.onControl((c) => controls.push(c));

  await socket.say({ text: '中止', threadTs: 'ts-old' });
  assert.deepEqual(controls, [{ type: 'abort', taskId: 'T-old' }]);
});

test('回呼丟例外不會中斷 Slack 事件處理', async () => {
  const socket = new FakeSocket();
  const { gw } = await setup({ socket });
  const ts = (await gw.postTaskCard(task))!;
  const seen: string[] = [];
  gw.onControl(() => {
    throw new Error('訂閱者爆炸');
  });
  gw.onControl((c) => seen.push(c.type));

  await socket.say({ text: '重試', threadTs: ts });
  assert.deepEqual(seen, ['retry']);
});

test('start/stop：沒有 socket 時只出站，不會 throw', async () => {
  const { gw } = await setup();
  await gw.start();
  await gw.stop();
});

// ── 純函式：入站 payload 解析 ──

test('parseBlockActions：取 action_id / value / thread_ts / user', () => {
  const actions = parseBlockActions({
    type: 'block_actions',
    user: { id: 'U1' },
    channel: { id: 'C1' },
    message: { ts: '111.1', thread_ts: '100.0' },
    actions: [{ action_id: ACTION_IDS.clarifyOption, value: '{"taskId":"T-1"}' }],
  });
  assert.deepEqual(actions, [
    { actionId: ACTION_IDS.clarifyOption, value: '{"taskId":"T-1"}', threadTs: '100.0', channel: 'C1', userId: 'U1' },
  ]);
});

test('parseBlockActions：點在 thread root 上時用 message.ts 當 thread_ts', () => {
  const [a] = parseBlockActions({
    message: { ts: '100.0' },
    actions: [{ action_id: ACTION_IDS.taskPause }],
  });
  assert.equal(a?.threadTs, '100.0');
});

test('parseBlockActions：垃圾輸入回空陣列', () => {
  assert.deepEqual(parseBlockActions(undefined), []);
  assert.deepEqual(parseBlockActions('x'), []);
  assert.deepEqual(parseBlockActions({ actions: [{ no_action_id: 1 }, null] }), []);
});

test('parseMessageEvent：只收人類在 thread 內的原始發言', () => {
  assert.deepEqual(parseMessageEvent({ text: 'hi', thread_ts: '1.1', channel: 'C1', user: 'U1' }), {
    text: 'hi',
    threadTs: '1.1',
    channel: 'C1',
    userId: 'U1',
  });
  // bot 自己貼的通知
  assert.equal(parseMessageEvent({ text: 'hi', thread_ts: '1.1', bot_id: 'B1' }), undefined);
  // 編輯/加入等 subtype
  assert.equal(parseMessageEvent({ text: 'hi', thread_ts: '1.1', subtype: 'message_changed' }), undefined);
  // 不在 thread 內的頻道發言
  assert.equal(parseMessageEvent({ text: 'hi', ts: '1.1' }), undefined);
  assert.equal(parseMessageEvent(null), undefined);
});

test('parseControlCommand：四種指令 + 不誤判一般句子', () => {
  assert.deepEqual(parseControlCommand('暫停', 'T-1'), { type: 'pause', taskId: 'T-1' });
  assert.deepEqual(parseControlCommand('中止！', 'T-1'), { type: 'abort', taskId: 'T-1' });
  assert.deepEqual(parseControlCommand('retry ', 'T-1'), { type: 'retry', taskId: 'T-1' });
  assert.deepEqual(parseControlCommand('用你的預設', 'T-1'), { type: 'use_default', taskId: 'T-1' });
  assert.equal(parseControlCommand('預設值應該用 UTC，不是指令', 'T-1'), undefined);
  assert.equal(parseControlCommand('這個要暫停嗎', 'T-1'), undefined);
});

test('parseControlCommand：no_change 的兩個出口，且不誤判閒聊（D18）', () => {
  assert.deepEqual(parseControlCommand('確認不用做', 'T-1'), { type: 'confirm_no_change', taskId: 'T-1' });
  assert.deepEqual(parseControlCommand('確認無需改動。', 'T-1'), { type: 'confirm_no_change', taskId: 'T-1' });
  assert.deepEqual(parseControlCommand('請你去做', 'T-1'), { type: 'retry', taskId: 'T-1', source: 'no_change_rejected' });
  assert.deepEqual(parseControlCommand('你誤判了！', 'T-1'), { type: 'retry', taskId: 'T-1', source: 'no_change_rejected' });
  // 不可逆的指令只認完整說法：句子中間、或只寫「確認」都不算
  assert.equal(parseControlCommand('確認不用做這件事嗎', 'T-1'), undefined);
  assert.equal(parseControlCommand('確認', 'T-1'), undefined);
  assert.equal(parseControlCommand('我幫你確認不用做', 'T-1'), undefined);
});

// ── 降級（未設定 Slack） ──

test('createNotifier：slack.enabled=false → ConsoleGateway，所有方法安全 no-op', async () => {
  const n = createNotifier({ slack: { enabled: false } }, log);
  assert.ok(n instanceof ConsoleGateway);
  assert.equal(await n.postTaskCard(task), undefined);
  await n.event(undefined, { type: 'claimed' }, task);
  await n.askClarification(undefined, { question: 'q', options: [], rationale: 'r' });
  await n.askMergeApproval(undefined, { groupId: 'g', branch: 'b', repo: 'r', taskTitles: [] });
  await n.askNoChangeConfirmation(undefined, { taskId: 'T-1', category: 'not_applicable', reason: 'r' });
  await n.postScreenshots(undefined, ['/nope.png']);
  n.onAnswer(() => {});
  n.onControl(() => {});
  n.onMergeDecision(() => {});
  await n.start();
  await n.stop();
});

test('ConsoleGateway：等人確認的卡要在 log 明講「無法從 Slack 操作」，不能無聲 park', async () => {
  const rec = createRecordingLogger();
  await new ConsoleGateway(rec.logger).askNoChangeConfirmation(undefined, noChange);

  const warns = rec.messages('warn').join('\n');
  assert.match(warns, /T-1/);
  assert.match(warns, /等你確認/);
  assert.match(warns, /無法從 Slack 操作/);
  assert.match(warns, /現況已符合需求/); // 分類要看得到，人才判斷得出 agent 有沒有誤判
});

test('createNotifier：缺 botToken 或整段 slack 設定缺席 → 降級不炸', () => {
  assert.ok(createNotifier({ slack: { enabled: true } }, log) instanceof ConsoleGateway);
  assert.ok(createNotifier({}, log) instanceof ConsoleGateway);
});

test('createNotifier：有 botToken 就回真的 SlackGateway（不連線）', () => {
  const n = createNotifier({ slack: { enabled: true, botToken: 'xoxb-test', channel: '#x' } }, log);
  assert.ok(n instanceof SlackGateway);
});

// ── 任務卡狀態更新 ──

/**
 * 卡片貼出去就不動的話，任務做完了、PR 開了、甚至在等人核准，卡片上還是同樣三顆
 * 按鈕，人根本看不出它在等自己——他得滑到頻道別處去找那張早就被洗掉的核准卡。
 * 這是介面「能不能用」的關鍵，不是裝飾。
 */
test('任務卡：狀態改變時真的去更新那則訊息', async () => {
  const socket = new FakeSocket();
  const { client, gw } = await setup({ socket });

  await gw.postTaskCard({ id: 'T-1', title: '做一件事', repo: 'acme/web', category: 'dev' });
  await gw.updateTaskCard('T-1', 'awaiting_merge', { groupId: 'g1' });

  assert.equal(client.updates.length, 1);
  const u = client.updates[0]!;
  assert.equal(u.ts, 'ts-1', '要更新的是原本那則任務卡');
  assert.match(u.text, /等你核准合併/);
});

test('任務卡：狀態沒變就不打 API（避免無意義的速率消耗）', async () => {
  const { client, gw } = await setup({ socket: new FakeSocket() });
  await gw.postTaskCard({ id: 'T-1', title: 't', repo: 'acme/web', category: 'dev' });

  await gw.updateTaskCard('T-1', 'verifying');
  await gw.updateTaskCard('T-1', 'verifying');

  assert.equal(client.updates.length, 1);
});

test('任務卡：沒貼過卡就更新 → 安全略過（不擲錯）', async () => {
  const { client, gw } = await setup({ socket: new FakeSocket() });
  await assert.doesNotReject(() => gw.updateTaskCard('沒見過的任務', 'merged'));
  assert.equal(client.updates.length, 0);
});

/** 訊息更新有時間與速率限制；更新失敗是介面問題，不該影響任務本身。 */
test('任務卡：更新失敗只留 warn，不擲錯', async () => {
  const { gw } = await setup({ socket: new FakeSocket(), updateFails: true });
  await gw.postTaskCard({ id: 'T-1', title: 't', repo: 'acme/web', category: 'dev' });
  await assert.doesNotReject(() => gw.updateTaskCard('T-1', 'merged'));
});

/**
 * 這條抓到過真的 bug。兩次更新在幾毫秒內發出時，送出順序是對的，但**回應順序沒有保證**
 * ——較早的那次晚落地就會把較新的蓋掉。實跑症狀：卡片停在「PR 已開」，真正的狀態卻是
 * 「等你核准」，於是核准按鈕永遠不會出現，人以為沒事要做。
 *
 * 單元測試原本抓不到，因為假的 chat.update 是同步 resolve 的，永遠不會亂序。
 */
test('任務卡：連續兩次更新時，最終顯示的是最新狀態（不會被舊的蓋掉）', async () => {
  const { client, gw } = await setup({ socket: new FakeSocket() });
  await gw.postTaskCard({ id: 'T-1', title: 't', repo: 'acme/web', category: 'dev' });

  // 第一次慢、第二次快 —— 沒有排隊的話，慢的那次會後到並蓋掉快的
  client.updateDelays = [40, 0];
  await Promise.all([
    gw.updateTaskCard('T-1', 'pr_open', { groupId: 'g1' }),
    gw.updateTaskCard('T-1', 'awaiting_merge', { groupId: 'g1' }),
  ]);

  const last = client.updates.at(-1)!;
  assert.match(last.text, /等你核准合併/, '最後落地的必須是最新狀態');
});

test('任務卡：排隊期間狀態又變 → 合併寫入，不重複打 API', async () => {
  const { client, gw } = await setup({ socket: new FakeSocket() });
  await gw.postTaskCard({ id: 'T-1', title: 't', repo: 'acme/web', category: 'dev' });

  client.updateDelays = [30, 0, 0];
  await Promise.all([
    gw.updateTaskCard('T-1', 'verifying'),
    gw.updateTaskCard('T-1', 'pr_open', { groupId: 'g1' }),
    gw.updateTaskCard('T-1', 'awaiting_merge', { groupId: 'g1' }),
  ]);

  assert.match(client.updates.at(-1)!.text, /等你核准合併/);
  assert.ok(client.updates.length <= 2, `三次請求應被合併成 1–2 次（實際 ${client.updates.length}）`);
});

test('任務卡：不同任務各自一條鏈，互不阻塞', async () => {
  const { client, gw } = await setup({ socket: new FakeSocket() });
  await gw.postTaskCard({ id: 'T-1', title: 'a', repo: 'acme/web', category: 'dev' });
  await gw.postTaskCard({ id: 'T-2', title: 'b', repo: 'acme/web', category: 'dev' });

  await Promise.all([
    gw.updateTaskCard('T-1', 'merged'),
    gw.updateTaskCard('T-2', 'failed'),
  ]);

  const texts = client.updates.map((u) => u.text).join('\n');
  assert.match(texts, /已合併/);
  assert.match(texts, /失敗/);
});

/**
 * 卡片狀態只活在記憶體的話，daemon 一重啟（改設定、修 bug 都會重啟）之前貼出去的卡
 * 就再也更新不到，永遠停在重啟前的樣子——而人是看卡片決定要不要動手的。
 */
test('任務卡：daemon 重啟後仍能更新先前貼出的卡（從 ledger 重建）', async () => {
  const client = new FakeSlackWeb();
  const gw = new SlackGateway({
    client,
    channel: 'C999DEV',
    log,
    // 模擬重啟：這個 gateway 沒有貼過任何卡，只能靠 ledger 反查
    resolveCard: (taskId) =>
      taskId === 'T-1'
        ? { ts: 'ts-舊的', card: { id: 'T-1', title: '重啟前的任務', repo: 'acme/web', category: 'dev' } }
        : undefined,
  });

  await gw.updateTaskCard('T-1', 'awaiting_merge', { groupId: 'g1' });

  assert.equal(client.updates.length, 1);
  assert.equal(client.updates[0]!.ts, 'ts-舊的', '要更新的是重啟前那則訊息');
  assert.match(client.updates[0]!.text, /等你核准合併/);
});

test('任務卡：ledger 也查不到（Slack 當時未啟用）→ 安全略過', async () => {
  const client = new FakeSlackWeb();
  const gw = new SlackGateway({ client, channel: 'C999DEV', log, resolveCard: () => undefined });
  await assert.doesNotReject(() => gw.updateTaskCard('T-9', 'merged'));
  assert.equal(client.updates.length, 0);
});

// ── 裁決後的即時回饋 ──

/**
 * 人按下核准/退回之後如果卡片沒反應，他不知道有沒有按到，就會重複點——
 * 而重複核准會重複寫憑證、重複觸發合併把關。按鈕必須立刻消失。
 */
test('核准後：卡片立刻變「合併把關中」且不再有按鈕', async () => {
  const socket = new FakeSocket();
  const { client, gw } = await setup({ socket });
  await gw.postTaskCard({ id: 'T-1', title: 't', repo: 'acme/web', category: 'dev' });
  await gw.updateTaskCard('T-1', 'awaiting_merge', { groupId: 'g1' });
  const before = client.updates.length;

  await socket.click({ actionId: ACTION_IDS.mergeApprove, value: encodeActionValue({ groupId: 'g1' }), threadTs: 'ts-1', userId: 'U1' });
  await new Promise((r) => setTimeout(r, 20));

  const last = client.updates.at(-1)!;
  assert.ok(client.updates.length > before, '核准後要立刻更新卡片');
  assert.match(last.text, /合併把關中/);
  const acts = (last.blocks as { type: string }[]).filter((b) => b.type === 'actions');
  assert.deepEqual(acts, [], '按鈕必須消失，否則可以重複點');
});

test('退回並附意見後：卡片立刻變「依你的意見重做中」', async () => {
  const socket = new FakeSocket();
  const { client, gw } = await setup({ socket });
  await gw.postTaskCard({ id: 'T-1', title: 't', repo: 'acme/web', category: 'dev' });
  await gw.updateTaskCard('T-1', 'awaiting_merge', { groupId: 'g1' });

  await socket.click({ actionId: ACTION_IDS.mergeReject, value: encodeActionValue({ groupId: 'g1' }), threadTs: 'ts-1', userId: 'U1' });
  await socket.say({ text: '清除前要跳確認', threadTs: 'ts-1', userId: 'U1' });
  await new Promise((r) => setTimeout(r, 20));

  const last = client.updates.at(-1)!;
  assert.match(last.text, /重做中/);
  assert.deepEqual((last.blocks as { type: string }[]).filter((b) => b.type === 'actions'), []);
});

/** 重啟後記憶體沒有群組↔任務的對應，得問 ledger，否則裁決後卡片不會動。 */
test('裁決後更新整群的卡片：記憶體查不到時改問 ledger', async () => {
  const client = new FakeSlackWeb();
  const socket = new FakeSocket();
  const gw = new SlackGateway({
    client, channel: 'C999DEV', log, socket,
    resolveGroupTasks: (g) => (g === 'g1' ? ['T-9'] : []),
    resolveCard: (id) => (id === 'T-9' ? { ts: 'ts-舊', card: { id: 'T-9', title: 'x', repo: 'acme/web', category: 'dev' } } : undefined),
  });
  await gw.start();

  await socket.click({ actionId: ACTION_IDS.mergeApprove, value: encodeActionValue({ groupId: 'g1' }), threadTs: 'ts-舊', userId: 'U1' });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(client.updates.length, 1);
  assert.equal(client.updates[0]!.ts, 'ts-舊');
  assert.match(client.updates[0]!.text, /合併把關中/);
});

// ── BoltSocket：多個訂閱者共用同一個 Bolt listener ──

/**
 * 實跑時每按一次按鈕就印一行「ack() has already been called」。
 * 原因是 onAction 有兩個呼叫端（任務卡 gateway、App Home 面板），
 * 各自向 Bolt 註冊 catch-all，於是同一則互動被兩個 listener 收到、各 ack 一次。
 *
 * 這個 bug 躲過了原本的測試，因為測試用的假 socket 只存得下一個 handler
 * （`onAction: (h) => void (actionCb = h)`）——假物件把「只會有一個訂閱者」
 * 這個錯誤假設一起複製了。所以這裡測的是 **BoltSocket 本體**。
 */
test('BoltSocket：兩個訂閱者只註冊一個 Bolt listener，且只 ack 一次', async () => {
  const registered: ((args: unknown) => Promise<void>)[] = [];
  const app = {
    action: (_m: unknown, fn: (args: unknown) => Promise<void>) => void registered.push(fn),
  };
  const socket = new BoltSocket(app as never, pino({ level: 'silent' }) as never);

  const seenA: string[] = [];
  const seenB: string[] = [];
  socket.onAction((a) => void seenA.push(a.actionId));
  socket.onAction((a) => void seenB.push(a.actionId));

  assert.equal(registered.length, 1, '不論幾個訂閱者，向 Bolt 只註冊一次');

  let acks = 0;
  await registered[0]!({
    ack: async () => void (acks += 1),
    body: { actions: [{ action_id: 'merge_approve', value: 'g1' }], message: { ts: '111.1' } },
  });

  assert.equal(acks, 1, '一則互動只能 ack 一次');
  assert.deepEqual(seenA, ['merge_approve']);
  assert.deepEqual(seenB, ['merge_approve'], '兩個訂閱者都要收到');
});

test('BoltSocket：一個訂閱者擲錯，其餘照樣收到（面板壞掉不能擋住裁決）', async () => {
  const registered: ((args: unknown) => Promise<void>)[] = [];
  const app = { action: (_m: unknown, fn: (args: unknown) => Promise<void>) => void registered.push(fn) };
  const socket = new BoltSocket(app as never, pino({ level: 'silent' }) as never);

  const seen: string[] = [];
  socket.onAction(() => { throw new Error('面板炸了'); });
  socket.onAction((a) => void seen.push(a.actionId));

  await assert.doesNotReject(() => registered[0]!({
    ack: async () => {},
    body: { actions: [{ action_id: 'merge_approve', value: 'g1' }], message: { ts: '111.1' } },
  }));
  assert.deepEqual(seen, ['merge_approve']);
});

// ── 過期卡片：舊卡上的按鈕不得生效 ──

/**
 * 頻道裡會累積前幾輪留下的舊卡，按鈕看起來一樣還能按。按鈕 value 帶的是 taskId／groupId，
 * 同一個任務再跑一次時 id 相同 ⇒ 點舊卡等於對「這一輪」下指令，人卻以為在操作舊的那一輪。
 * 最糟的是核准合併：看著舊卡的內容，核准掉的是新的一份改動。
 */
test('過期卡片：舊 thread 上的核准鈕不觸發裁決，並提示去看最新的卡', async () => {
  const socket = new FakeSocket();
  const client = new FakeSlackWeb();
  const gw = new SlackGateway({
    client,
    channel: 'C999DEV',
    log,
    socket,
    // ledger 記錄的「現行卡片」是 ts-new；ts-old 是上一輪留下的殘卡
    resolveCard: (taskId) => (taskId === 'T-1' ? { ts: 'ts-new', card: task } : undefined),
  });
  await gw.start();

  const merges: unknown[] = [];
  gw.onMergeDecision((d) => merges.push(d));

  await socket.click({
    actionId: ACTION_IDS.mergeApprove,
    value: encodeActionValue({ groupId: 'g1', taskId: 'T-1' }),
    threadTs: 'ts-old',
  });

  assert.deepEqual(merges, [], '過期卡片上的核准絕不可寫入裁決');
  assert.ok(
    client.sent.some((p) => /舊的任務卡/.test(p.text ?? '')),
    '要明確告訴人「這張是舊卡」，否則他只會覺得按鈕壞了',
  );
});

test('現行卡片上的同一顆按鈕照常生效（別把正常操作也擋掉）', async () => {
  const socket = new FakeSocket();
  const client = new FakeSlackWeb();
  const gw = new SlackGateway({
    client,
    channel: 'C999DEV',
    log,
    socket,
    resolveCard: (taskId) => (taskId === 'T-1' ? { ts: 'ts-new', card: task } : undefined),
  });
  await gw.start();

  const merges: { groupId: string; approved: boolean }[] = [];
  gw.onMergeDecision((d) => merges.push({ groupId: d.groupId, approved: d.approved }));

  await socket.click({
    actionId: ACTION_IDS.mergeApprove,
    value: encodeActionValue({ groupId: 'g1', taskId: 'T-1' }),
    threadTs: 'ts-new',
  });

  assert.deepEqual(merges, [{ groupId: 'g1', approved: true }]);
});

test('認不出任務時放行（寧可漏擋，也不要擋掉正常操作）', async () => {
  const socket = new FakeSocket();
  const client = new FakeSlackWeb();
  const gw = new SlackGateway({ client, channel: 'C999DEV', log, socket });
  await gw.start();

  const merges: unknown[] = [];
  gw.onMergeDecision((d) => merges.push(d));
  await socket.click({ actionId: ACTION_IDS.mergeApprove, value: encodeActionValue({ groupId: 'g1' }), threadTs: 'ts-x' });

  assert.equal(merges.length, 1);
});
