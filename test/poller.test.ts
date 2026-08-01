import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Poller, payloadHash, sourceUpdatedAt, type PollSource } from '../src/core/poller.js';
import type { McpReadClient } from '../src/contracts.js';
import type { TaskBrief, TaskDetail } from '../src/types.js';
import { createTmpLedger, createSilentLogger, createRecordingLogger, makeTaskDetail, type TmpLedger } from './helpers/index.js';

const detail = (over: Partial<TaskDetail> = {}): TaskDetail =>
  makeTaskDetail({ id: 'T-1', title: '標題', status: 'todo', description: '描述', ...over });
const brief = (t: TaskDetail): TaskBrief => ({ id: t.id, title: t.title, status: t.status, repo: t.repo });

interface FakeClient extends McpReadClient {
  queries: unknown[];
  tasks: TaskDetail[];
  failList?: Error;
  failGetIds: Set<string>;
}

function fakeClient(tasks: TaskDetail[]): FakeClient {
  const c: FakeClient = {
    queries: [],
    tasks,
    failGetIds: new Set<string>(),
    async listTasks(q) {
      c.queries.push(q);
      if (c.failList) throw c.failList;
      return c.tasks.map(brief);
    },
    async getTask(id) {
      if (c.failGetIds.has(id)) throw new Error(`getTask ${id} 爆炸`);
      const t = c.tasks.find((x) => x.id === id);
      if (!t) throw new Error(`no such task ${id}`);
      return t;
    },
  };
  return c;
}

describe('Poller — 輪詢與去重', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp = createTmpLedger();
  });
  afterEach(() => tmp.cleanup());

  const src = (client: McpReadClient, repo = 'acme/web', mine = true): PollSource => ({ client, repo, mine });

  it('首輪：發現全部 todo 任務並落地為 discovered', async () => {
    const client = fakeClient([detail({ id: 'T-1' }), detail({ id: 'T-2', title: '第二' })]);
    const poller = new Poller([src(client)], tmp.ledger, createSilentLogger());

    const fresh = await poller.pollOnce();

    assert.deepEqual(fresh.map((t) => t.id), ['T-1', 'T-2']);
    assert.equal(tmp.ledger.getTask('T-1')?.state, 'discovered');
    assert.equal(tmp.ledger.listTasksByState('discovered').length, 2);
    // 查詢條件要帶 repo/status/mine（MCP 只回自己的 todo）
    assert.deepEqual(client.queries[0], { repo: 'acme/web', status: 'todo', mine: true });
  });

  it('次輪：MCP 重派同樣任務 → 全部去重，不回報為新任務', async () => {
    const client = fakeClient([detail({ id: 'T-1' })]);
    const poller = new Poller([src(client)], tmp.ledger, createSilentLogger());

    assert.equal((await poller.pollOnce()).length, 1);
    assert.deepEqual(await poller.pollOnce(), []);
    assert.equal(tmp.ledger.listTasksByState('discovered').length, 1);
  });

  it('已進行中/已完成的任務被重派也不會回頭當新任務', async () => {
    const client = fakeClient([detail({ id: 'T-1' })]);
    const poller = new Poller([src(client)], tmp.ledger, createSilentLogger());
    await poller.pollOnce();
    tmp.ledger.updateTaskState('T-1', 'done');

    assert.deepEqual(await poller.pollOnce(), []);
    assert.equal(tmp.ledger.getTask('T-1')?.state, 'done', '狀態不可被 poll 蓋回 discovered');
  });

  it('payload 變更：更新內容與 hash，但不算新任務、狀態不變', async () => {
    const t = detail({ id: 'T-1', title: '舊標題', description: '舊描述' });
    const client = fakeClient([t]);
    const poller = new Poller([src(client)], tmp.ledger, createSilentLogger());
    await poller.pollOnce();
    const before = tmp.ledger.getTask('T-1')!;
    tmp.ledger.updateTaskState('T-1', 'queued');

    client.tasks = [detail({ id: 'T-1', title: '新標題', description: '新描述', docRefs: ['spec/a.md#x'] })];
    const fresh = await poller.pollOnce();

    assert.deepEqual(fresh, [], 'payload 變更不算「新任務」');
    const after = tmp.ledger.getTask('T-1')!;
    assert.equal(after.title, '新標題');
    assert.deepEqual(after.docRefs, ['spec/a.md#x']);
    assert.notEqual(after.payloadHash, before.payloadHash);
    assert.equal(after.state, 'queued', '是否重排交由 planner，poll 不動狀態');
  });

  it('listTasks 失敗 → 略過該來源本輪，不炸掉整輪、其他來源照跑', async () => {
    const bad = fakeClient([]);
    bad.failList = new Error('MCP 503');
    const good = fakeClient([detail({ id: 'T-9', repo: 'acme/api' })]);
    const rec = createRecordingLogger();
    const poller = new Poller([src(bad, 'acme/web'), src(good, 'acme/api')], tmp.ledger, rec.logger);

    const fresh = await poller.pollOnce();

    assert.deepEqual(fresh.map((t) => t.id), ['T-9']);
    assert.ok(rec.messages('warn').includes('listTasks 失敗，略過本輪該來源'));
    assert.ok(rec.records.some((r) => r.err === 'MCP 503'));
  });

  it('getTask 失敗 → 只略過該任務，同來源其他任務仍落地', async () => {
    const client = fakeClient([detail({ id: 'T-1' }), detail({ id: 'T-2' }), detail({ id: 'T-3' })]);
    client.failGetIds.add('T-2');
    const rec = createRecordingLogger();
    const poller = new Poller([src(client)], tmp.ledger, rec.logger);

    const fresh = await poller.pollOnce();

    assert.deepEqual(fresh.map((t) => t.id), ['T-1', 'T-3']);
    assert.equal(tmp.ledger.getTask('T-2'), undefined);
    assert.ok(rec.messages('warn').includes('getTask 失敗，略過該任務'));
  });

  it('多來源：各自帶自己的 repo 查詢', async () => {
    const a = fakeClient([detail({ id: 'A-1', repo: 'acme/web' })]);
    const b = fakeClient([detail({ id: 'B-1', repo: 'acme/api' })]);
    const poller = new Poller(
      [{ client: a, repo: 'acme/web' }, { client: b, repo: 'acme/api', mine: false }],
      tmp.ledger,
      createSilentLogger(),
    );

    const fresh = await poller.pollOnce();

    assert.deepEqual(fresh.map((t) => t.id).sort(), ['A-1', 'B-1']);
    assert.deepEqual(a.queries[0], { repo: 'acme/web', status: 'todo', mine: undefined });
    assert.deepEqual(b.queries[0], { repo: 'acme/api', status: 'todo', mine: false });
  });

  it('落地內容忠實對映 MCP 欄位', async () => {
    const client = fakeClient([
      detail({ id: 'T-1', category: 'bug', dependencies: ['T-0'], docRefs: ['spec/a.md#s'], repo: 'acme/web' }),
    ]);
    const poller = new Poller([src(client)], tmp.ledger, createSilentLogger());
    await poller.pollOnce();

    const t = tmp.ledger.getTask('T-1')!;
    assert.equal(t.category, 'bug');
    assert.deepEqual(t.dependencies, ['T-0']);
    assert.deepEqual(t.docRefs, ['spec/a.md#s']);
    assert.equal(t.repo, 'acme/web');
    assert.equal(t.attempts, 0);
  });
});

describe('payloadHash — 去重指紋', () => {
  it('相同內容 → 相同 hash；依賴/docRefs 順序不影響', () => {
    const a = detail({ dependencies: ['b', 'a'], docRefs: ['y#1', 'x#2'] });
    const b = detail({ dependencies: ['a', 'b'], docRefs: ['x#2', 'y#1'] });
    assert.equal(payloadHash(a), payloadHash(b));
  });

  it('title/description/category/dependencies/docRefs 任一改變 → hash 改變', () => {
    const base = detail();
    const h = payloadHash(base);
    assert.notEqual(payloadHash({ ...base, title: 'x' }), h);
    assert.notEqual(payloadHash({ ...base, description: 'x' }), h);
    assert.notEqual(payloadHash({ ...base, category: 'bug' }), h);
    assert.notEqual(payloadHash({ ...base, dependencies: ['z'] }), h);
    assert.notEqual(payloadHash({ ...base, docRefs: ['z#1'] }), h);
  });

  it('與去重無關的欄位（status/assignee）改變 → hash 不變', () => {
    const base = detail();
    assert.equal(payloadHash({ ...base, status: 'in_progress', assigneeId: 'u1' }), payloadHash(base));
  });
});


// ── MCP 時間戳落地（靜置期的輸入） ──

describe('Poller — MCP 端活動時間', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp = createTmpLedger();
  });
  afterEach(() => tmp.cleanup());

  it('sourceUpdatedAt 取 createdAt/updatedAt 的較大者', () => {
    assert.equal(sourceUpdatedAt({ createdAt: 100, updatedAt: 500 }), 500);
    assert.equal(sourceUpdatedAt({ createdAt: 900, updatedAt: 500 }), 900);
    assert.equal(sourceUpdatedAt({ createdAt: 100 }), 100);
    assert.equal(sourceUpdatedAt({ updatedAt: 100 }), 100);
    assert.equal(sourceUpdatedAt({}), undefined, 'MCP 沒給時間戳 → undefined，讓靜置期退回本地發現時間');
  });

  it('落地時把 MCP 的活動時間寫進 ledger', async () => {
    const client = fakeClient([detail({ id: 'T-1', createdAt: 1000, updatedAt: 7000 })]);
    const poller = new Poller([{ client, repo: 'acme/web', mine: true }], tmp.ledger, createSilentLogger());

    await poller.pollOnce();

    assert.equal(tmp.ledger.getTask('T-1')?.sourceUpdatedAt, 7000);
  });

  it('MCP 沒給時間戳 → 欄位留空（不寫 0）', async () => {
    const client = fakeClient([detail({ id: 'T-2' })]);
    const poller = new Poller([{ client, repo: 'acme/web', mine: true }], tmp.ledger, createSilentLogger());

    await poller.pollOnce();

    assert.equal(tmp.ledger.getTask('T-2')?.sourceUpdatedAt, undefined);
  });

  /** 人編輯了任務內容 → 活動時間要跟著更新，靜置期才會重新開始等。 */
  it('任務內容變更時同步更新活動時間', async () => {
    const t = detail({ id: 'T-3', createdAt: 1000, updatedAt: 1000 });
    const client = fakeClient([t]);
    const poller = new Poller([{ client, repo: 'acme/web', mine: true }], tmp.ledger, createSilentLogger());
    await poller.pollOnce();

    client.tasks = [detail({ id: 'T-3', description: '人改過的描述', createdAt: 1000, updatedAt: 9000 })];
    await poller.pollOnce();

    assert.equal(tmp.ledger.getTask('T-3')?.sourceUpdatedAt, 9000);
  });
});
