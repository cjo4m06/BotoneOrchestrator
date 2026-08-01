import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AppHome } from '../src/slack/app-home.js';
import { HOME_ACTION_IDS, SLASH_HELP, handleSlashCommand, homeViewBlocks, type HomeInput } from '../src/slack/home.js';
import { GROUP_STATES, TASK_STATES } from '../src/cli/report.js';
import { decodeActionValue } from '../src/slack/blocks.js';
import { createSilentLogger, createRecordingLogger } from './helpers/index.js';
import type { PendingItem } from '../src/cli/ask.js';
import type { InboundAction, InboundSlashCommand, SlackSocketLike } from '../src/slack/gateway.js';
import type { CostSummary } from '../src/store/ledger.js';
import type { Group, GroupState, Task, TaskState } from '../src/types.js';

const NOW = new Date('2026-07-30T14:05:00+08:00').getTime();

const emptyTasks = (): Record<TaskState, Task[]> =>
  Object.fromEntries(TASK_STATES.map((s) => [s, [] as Task[]])) as unknown as Record<TaskState, Task[]>;

const emptyCost = (over: Partial<CostSummary> = {}): CostSummary =>
  ({ sessions: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, rounds: 0, ...over });

function home(over: Partial<HomeInput> = {}): HomeInput {
  return {
    pending: [],
    tasksByState: emptyTasks(),
    groupsByState: Object.fromEntries(GROUP_STATES.map((s) => [s, [] as Group[]])) as unknown as Record<GroupState, Group[]>,
    cost: { today: emptyCost(), total: emptyCost() },
    costToday: [],
    projects: [{ repo: 'cjo4m06/Baolu', label: 'baolu' }],
    quietWaits: [],
    now: NOW,
    ...over,
  };
}

const item = (over: Partial<PendingItem> & { kind: PendingItem['kind']; id: string }): PendingItem => ({
  title: `標題 ${over.id}`, repo: 'cjo4m06/Baolu', detail: '細節', actions: [], ...over,
});

const task = (id: string, state: TaskState): Task => ({
  id, payloadHash: 'h', repo: 'acme/web', category: 'dev', title: `任務 ${id}`, description: '',
  dependencies: [], docRefs: [], state, attempts: 0, createdAt: NOW, updatedAt: NOW,
});

/** 從 blocks 撈出所有文字，方便斷言「有沒有講到某件事」。 */
function textOf(blocks: unknown[]): string {
  return JSON.stringify(blocks);
}

describe('App Home 版面', () => {
  /** Slack 一個 view 上限 100 block，超過整頁會被退回（等於面板整個消失）。 */
  it('待辦很多時收斂顯示，block 數不會爆掉', () => {
    const pending = Array.from({ length: 60 }, (_, i) => item({ kind: 'clarification', id: `T-${i}` }));
    const blocks = homeViewBlocks(home({ pending }));
    assert.ok(blocks.length < 100, `block 數 ${blocks.length} 應遠低於 Slack 上限`);
    assert.match(textOf(blocks), /另有 48 項/);
  });

  it('沒有待辦時明講「沒有需要你決定的事」', () => {
    assert.match(textOf(homeViewBlocks(home())), /沒有需要你決定的事/);
  });

  it('列出每一項待辦的種類、id 與說明', () => {
    const blocks = homeViewBlocks(home({
      pending: [item({ kind: 'merge_approval', id: 'g_1', title: '合併群組', detail: '程式碼變更需人工核准' })],
    }));
    const s = textOf(blocks);
    assert.match(s, /待核准合併/);
    assert.match(s, /g_1/);
    assert.match(s, /程式碼變更需人工核准/);
  });

  /**
   * 不可逆操作（確認「不用做」→ complete_task）刻意不放在 App Home。
   * 這是隨手滑過去的頁面，誤觸沒有回頭路。
   */
  it('不可逆的動作不出現在面板上', () => {
    const blocks = homeViewBlocks(home({
      pending: [item({ kind: 'no_change', id: 'T-1', category: 'already_satisfied' })],
    }));
    assert.equal(/no_change_confirm/.test(textOf(blocks)), false);
  });

  it('needs_human 提供重試鈕，且帶得回任務 id', () => {
    const blocks = homeViewBlocks(home({ pending: [item({ kind: 'needs_human', id: 'T-7' })] })) as {
      accessory?: { action_id?: string; value?: string };
    }[];
    const btn = blocks.find((b) => b.accessory?.action_id === 'task_retry')?.accessory;
    assert.ok(btn, '應有重試鈕');
    assert.equal(decodeActionValue(btn.value)?.taskId, 'T-7');
  });

  it('進度區顯示各狀態數量與執行中的任務', () => {
    const tasksByState = emptyTasks();
    tasksByState.in_progress = [task('T-1', 'in_progress')];
    tasksByState.done = [task('T-2', 'done'), task('T-3', 'done')];
    const s = textOf(homeViewBlocks(home({ tasksByState })));
    assert.match(s, /執行中 \*1\*/);
    assert.match(s, /完成 \*2\*/);
    assert.match(s, /T-1/);
  });

  it('等靜置期時說明還要多久（否則看起來就像當機）', () => {
    const s = textOf(homeViewBlocks(home({
      projects: [{ repo: 'acme/web', label: 'web' }],
      quietWaits: [{ repo: 'acme/web', count: 3, waitMs: 13 * 60_000 }],
    })));
    assert.match(s, /等靜置期/);
    assert.match(s, /約 13 分後自動開工/);
  });

  // ── 多專案：這個系統的核心形態就是一個 daemon 顧多個 MCP 任務板 ──

  it('每個專案各自一段，數字不會被加在一起', () => {
    const tasksByState = emptyTasks();
    tasksByState.in_progress = [task('T-1', 'in_progress'), task('T-2', 'in_progress')];
    tasksByState.in_progress[1]!.repo = 'acme/api';
    tasksByState.blocked = [task('T-3', 'blocked')];
    tasksByState.blocked[0]!.repo = 'acme/api';

    const s = textOf(homeViewBlocks(home({
      projects: [{ repo: 'acme/web' }, { repo: 'acme/api' }],
      tasksByState,
      costToday: [
        { repo: 'acme/web', costUsd: 1.5, rounds: 3, sessions: 1 },
        { repo: 'acme/api', costUsd: 4, rounds: 9, sessions: 2 },
      ],
    })));

    assert.match(s, /專案　2/);
    assert.match(s, /📁 \*web\*/);
    assert.match(s, /📁 \*api\*/);
    assert.match(s, /\$1\.50/);
    assert.match(s, /\$4\.00/);
    // 受阻只在有的時候才顯示，而且只掛在 api 那一段
    const apiIdx = s.indexOf('api');
    const webIdx = s.indexOf('web');
    assert.ok(apiIdx < webIdx, '有執行中又有受阻的 api 應排在前面');
  });

  it('完全沒有任務的專案也要列出來（否則分不清「很閒」和「沒載入」）', () => {
    const s = textOf(homeViewBlocks(home({ projects: [{ repo: 'acme/idle' }] })));
    assert.match(s, /📁 \*idle\*/);
    assert.match(s, /執行中 \*0\*/);
  });

  it('設定裡沒有、但 ledger 有任務的 repo 也要顯示（不讓任務變孤兒）', () => {
    const tasksByState = emptyTasks();
    tasksByState.blocked = [task('T-9', 'blocked')];
    tasksByState.blocked[0]!.repo = 'old/removed';
    const s = textOf(homeViewBlocks(home({ projects: [], tasksByState })));
    assert.match(s, /📁 \*removed\*/);
  });

  it('一個專案都沒有 → 明講是設定或連線有問題', () => {
    const s = textOf(homeViewBlocks(home({ projects: [] })));
    assert.match(s, /沒有載入任何專案/);
  });

  it('待辦每一列都標出所屬專案', () => {
    const s = textOf(homeViewBlocks(home({
      pending: [item({ kind: 'clarification', id: 'T-5', repo: 'acme/api' })],
    })));
    assert.match(s, /_api_/);
  });

  it('成本區顯示今天與累計', () => {
    const s = textOf(homeViewBlocks(home({
      cost: {
        today: emptyCost({ costUsd: 1.5, rounds: 4 }),
        total: emptyCost({ costUsd: 20, sessions: 9, inputTokens: 3_000_000, outputTokens: 50_000 }),
      },
    })));
    assert.match(s, /\$1\.50/);
    assert.match(s, /\$20\.00/);
    assert.match(s, /3\.00M/);
  });

  /** 任務標題來自外部（任務板），沒逃逸的話 `<` 會被 Slack 當成連結語法吃掉整段。 */
  it('標題中的 mrkdwn 保留字元會被逃逸', () => {
    const s = textOf(homeViewBlocks(home({
      pending: [item({ kind: 'clarification', id: 'T-1', title: '修 <script> & 標籤' })],
    })));
    assert.match(s, /&lt;script&gt; &amp; 標籤/);
  });

  it('有重新整理鈕', () => {
    assert.match(textOf(homeViewBlocks(home())), new RegExp(HOME_ACTION_IDS.refresh));
  });
});

describe('/orch slash command', () => {
  const render = { status: () => 'STATUS_OUT', cost: () => 'COST_OUT', pending: () => 'PENDING_OUT' };

  it('沒帶參數 → 列出待辦（最常用的那個）', () => {
    assert.equal(handleSlashCommand('', render).text, 'PENDING_OUT');
    assert.equal(handleSlashCommand('   ', render).text, 'PENDING_OUT');
  });

  it('status / cost / pending 各自對應', () => {
    assert.equal(handleSlashCommand('status', render).text, 'STATUS_OUT');
    assert.equal(handleSlashCommand('cost', render).text, 'COST_OUT');
    assert.equal(handleSlashCommand('pending', render).text, 'PENDING_OUT');
  });

  it('大小寫與多餘空白都認得', () => {
    assert.equal(handleSlashCommand('  STATUS  ', render).text, 'STATUS_OUT');
  });

  it('不認得的指令要附上說明，不能只回一句錯誤', () => {
    const out = handleSlashCommand('bogus', render).text;
    assert.match(out, /不認得的指令/);
    assert.match(out, /\/orch status/);
  });

  it('help 回說明', () => {
    assert.equal(handleSlashCommand('help', render).text, SLASH_HELP);
  });
});

// ── 接線 ──

interface FakeSocket extends SlackSocketLike {
  fireHome(userId: string): Promise<void>;
  fireAction(a: InboundAction): Promise<void>;
  fireSlash(c: InboundSlashCommand): Promise<string>;
}

function fakeSocket(opts: { home?: boolean; slash?: boolean } = { home: true, slash: true }): FakeSocket {
  let homeCb: ((u: string) => void | Promise<void>) | undefined;
  let actionCb: ((a: InboundAction) => void | Promise<void>) | undefined;
  let slashCb: ((c: InboundSlashCommand) => Promise<string>) | undefined;
  const s: FakeSocket = {
    onAction: (h) => void (actionCb = h),
    onMessage: () => {},
    ...(opts.home !== false ? { onHomeOpened: (h: (u: string) => void | Promise<void>) => void (homeCb = h) } : {}),
    ...(opts.slash !== false ? { onSlashCommand: (h: (c: InboundSlashCommand) => Promise<string>) => void (slashCb = h) } : {}),
    start: async () => {},
    stop: async () => {},
    async fireHome(userId) { await homeCb?.(userId); },
    async fireAction(a) { await actionCb?.(a); },
    async fireSlash(c) { return (await slashCb?.(c)) ?? ''; },
  } as FakeSocket;
  return s;
}

function fakeViews() {
  const calls: { user_id: string; view: { type: string; blocks: unknown[] } }[] = [];
  return {
    calls,
    async publish(args: { user_id: string; view: { type: 'home'; blocks: unknown[] } }) {
      calls.push(args);
      return {};
    },
  };
}

const render = { status: () => 'S', cost: () => 'C', pending: () => 'P' };

describe('AppHome 接線', () => {
  it('開啟 Home → 發佈當下的快照', async () => {
    const views = fakeViews();
    const socket = fakeSocket();
    let snapshots = 0;
    new AppHome({ views, socket, log: createSilentLogger(), snapshot: () => { snapshots += 1; return home(); }, render }).attach();

    await socket.fireHome('U123');

    assert.equal(views.calls.length, 1);
    assert.equal(views.calls[0]?.user_id, 'U123');
    assert.equal(views.calls[0]?.view.type, 'home');
    assert.equal(snapshots, 1, '每次開啟都要重新取數（不快取，否則顯示的是舊狀態）');
  });

  it('按重新整理 → 重新發佈；其他按鈕一律不理', async () => {
    const views = fakeViews();
    const socket = fakeSocket();
    new AppHome({ views, socket, log: createSilentLogger(), snapshot: home, render }).attach();

    await socket.fireAction({ actionId: HOME_ACTION_IDS.refresh, userId: 'U1' });
    assert.equal(views.calls.length, 1);

    await socket.fireAction({ actionId: 'merge_approve', userId: 'U1' });
    assert.equal(views.calls.length, 1, 'App Home 不該碰別人的 action');
  });

  /** 成功也要有 log：否則「面板一片空白」時，分不清是沒收到事件、發佈失敗、還是真的沒東西。 */
  it('發佈成功會留下可查的 log（含 block 數）', async () => {
    const rec = createRecordingLogger();
    const socket = fakeSocket();
    new AppHome({ views: fakeViews(), socket, log: rec.logger, snapshot: home, render }).attach();

    await socket.fireHome('U123');

    const hit = rec.records.find((r) => String(r.msg).includes('App Home 已發佈'));
    assert.ok(hit, '成功發佈要有 info log');
    assert.equal(hit.userId, 'U123');
    assert.ok(typeof hit.blocks === 'number' && hit.blocks > 0);
  });

  it('slash command 會留下可查的 log', async () => {
    const rec = createRecordingLogger();
    const socket = fakeSocket();
    new AppHome({ views: fakeViews(), socket, log: rec.logger, snapshot: home, render }).attach();

    await socket.fireSlash({ text: 'cost', userId: 'U9' });

    const hit = rec.records.find((r) => String(r.msg).includes('收到 /orch 指令'));
    assert.ok(hit);
    assert.equal(hit.text, 'cost');
    assert.equal(hit.userId, 'U9');
  });

  it('slash command 走同一批 formatter', async () => {
    const socket = fakeSocket();
    new AppHome({ views: fakeViews(), socket, log: createSilentLogger(), snapshot: home, render }).attach();
    assert.equal(await socket.fireSlash({ text: 'status' }), 'S');
    assert.equal(await socket.fireSlash({ text: '' }), 'P');
  });

  /**
   * 面板壞掉不該影響任何任務：Slack app 沒開 Home Tab 時 views.publish 會直接失敗，
   * 若這裡沒攔住，app_home_opened 的例外會冒到 Bolt 的錯誤處理，每開一次就噴一次。
   */
  it('發佈失敗只留 warn，不往外丟例外', async () => {
    const rec = createRecordingLogger();
    const socket = fakeSocket();
    new AppHome({
      views: { async publish() { throw new Error('not_allowed_token_type'); } },
      socket, log: rec.logger, snapshot: home, render,
    }).attach();

    await socket.fireHome('U1'); // 不該 throw
    assert.ok(rec.messages('warn').some((m) => m.includes('App Home 發佈失敗')));
    assert.ok(rec.records.some((r) => String(r.msg).includes('Home Tab')), '訊息要指出最可能的原因');
  });

  it('取數丟例外時 slash command 回可讀的訊息（不是崩潰）', async () => {
    const rec = createRecordingLogger();
    const socket = fakeSocket();
    new AppHome({
      views: fakeViews(), socket, log: rec.logger, snapshot: home,
      render: { status: () => { throw new Error('db locked'); }, cost: () => 'C', pending: () => 'P' },
    }).attach();

    assert.match(await socket.fireSlash({ text: 'status' }), /發生錯誤/);
  });

  it('socket 不支援 Home/slash（Slack app 沒設定）→ 安靜跳過，不炸', () => {
    const socket = fakeSocket({ home: false, slash: false });
    assert.doesNotThrow(() => {
      new AppHome({ views: fakeViews(), socket, log: createSilentLogger(), snapshot: home, render }).attach();
    });
  });

  it('沒有 userId 的事件不發佈（避免打一次註定失敗的 API）', async () => {
    const views = fakeViews();
    const socket = fakeSocket();
    new AppHome({ views, socket, log: createSilentLogger(), snapshot: home, render }).attach();
    await socket.fireAction({ actionId: HOME_ACTION_IDS.refresh });
    assert.equal(views.calls.length, 0);
  });
});
