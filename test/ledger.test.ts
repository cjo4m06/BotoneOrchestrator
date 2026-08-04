import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Ledger } from '../src/store/ledger.js';
import { createTmpDir, createTmpLedger, createRecordingLogger, makeDiscoveredTask } from './helpers/index.js';

// 每個 test 開一份獨立 ledger，避免測試間互相污染狀態。
function setup(t: { after(fn: () => void): void }) {
  const h = createTmpLedger();
  t.after(() => h.cleanup());
  return h;
}

/** 同上，但換成記錄式 logger——用來驗證「更新不到目標時有留下 warn」。 */
function setupWithLog(t: { after(fn: () => void): void }) {
  const dir = createTmpDir('botone-ledger-log-');
  const rec = createRecordingLogger();
  const ledger = new Ledger(dir.join('data', 'ledger.db'), rec.logger);
  ledger.init();
  t.after(() => {
    ledger.close();
    dir.cleanup();
  });
  return { ledger, rec };
}

test('init 會在指定路徑建出 db 檔（含缺失的父目錄）', (t) => {
  const { dbPath } = setup(t);
  assert.ok(existsSync(dbPath), 'ledger.db 應被建立在自動建立的 data/ 目錄下');
});

// ── upsertDiscoveredTask：去重三態 ──

test('upsertDiscoveredTask：首次 inserted、同 payload exists、payload 變更 payload_changed', (t) => {
  const { ledger } = setup(t);
  const input = makeDiscoveredTask({ id: 'T-1', payloadHash: 'h1', title: '原標題' });

  assert.equal(ledger.upsertDiscoveredTask(input), 'inserted');
  assert.equal(ledger.upsertDiscoveredTask(input), 'exists');
  assert.equal(ledger.upsertDiscoveredTask({ ...input, title: '只有標題變、hash 沒變' }), 'exists');

  const changed = ledger.upsertDiscoveredTask({
    ...input,
    payloadHash: 'h2',
    title: '新標題',
    description: '新描述',
    dependencies: ['T-0'],
    docRefs: ['spec/a.md#§1'],
  });
  assert.equal(changed, 'payload_changed');

  const t1 = ledger.getTask('T-1');
  assert.ok(t1);
  assert.equal(t1.payloadHash, 'h2');
  assert.equal(t1.title, '新標題');
  assert.equal(t1.description, '新描述');
  assert.deepEqual(t1.dependencies, ['T-0']);
  assert.deepEqual(t1.docRefs, ['spec/a.md#§1']);
});

test('payload_changed 不會重置狀態（是否重排交由 planner）', (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-2', payloadHash: 'h1' }));
  ledger.updateTaskState('T-2', 'in_progress', { groupId: 'g_x' });

  assert.equal(ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-2', payloadHash: 'h9' })), 'payload_changed');

  const t2 = ledger.getTask('T-2');
  assert.equal(t2?.state, 'in_progress', '重新發現不得把進行中的任務打回 discovered');
  assert.equal(t2?.groupId, 'g_x');
});

test('新任務落地為 discovered、attempts=0，且 dependencies/docRefs 正確 round-trip', (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(
    makeDiscoveredTask({
      id: 'T-3',
      dependencies: ['A', 'B'],
      docRefs: ['prd/x.md#目標', 'spec/y.md'],
      category: 'bug',
    }),
  );
  const t3 = ledger.getTask('T-3');
  assert.ok(t3);
  assert.equal(t3.state, 'discovered');
  assert.equal(t3.attempts, 0);
  assert.equal(t3.category, 'bug');
  assert.deepEqual(t3.dependencies, ['A', 'B']);
  assert.deepEqual(t3.docRefs, ['prd/x.md#目標', 'spec/y.md']);
  assert.equal(t3.block, undefined);
  assert.equal(t3.groupId, undefined);
  assert.equal(t3.lastError, undefined);
  assert.ok(t3.createdAt > 0 && t3.updatedAt >= t3.createdAt);
});

test('getTask 找不到回 undefined；listTasksByState 只回該狀態且依 createdAt 排序', (t) => {
  const { ledger } = setup(t);
  assert.equal(ledger.getTask('不存在'), undefined);

  for (const id of ['A', 'B', 'C']) ledger.upsertDiscoveredTask(makeDiscoveredTask({ id }));
  ledger.updateTaskState('B', 'queued');

  assert.deepEqual(
    ledger.listTasksByState('discovered').map((x) => x.id),
    ['A', 'C'],
  );
  assert.deepEqual(
    ledger.listTasksByState('queued').map((x) => x.id),
    ['B'],
  );
  assert.deepEqual(ledger.listTasksByState('done'), []);
});

// ── 狀態轉移 ──

test('updateTaskState：狀態轉移 + attempts 累加 + COALESCE 保留既有欄位', (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-4' }));

  ledger.updateTaskState('T-4', 'queued', { groupId: 'g_1', slackThreadTs: '1700.001' });
  ledger.updateTaskState('T-4', 'in_progress', { incAttempts: true });
  ledger.updateTaskState('T-4', 'verifying', { lastError: 'test 紅燈' });

  const t4 = ledger.getTask('T-4');
  assert.equal(t4?.state, 'verifying');
  assert.equal(t4?.attempts, 1, '只有 incAttempts 的那次會 +1');
  assert.equal(t4?.groupId, 'g_1', '未指定 groupId 時應保留原值');
  assert.equal(t4?.slackThreadTs, '1700.001');
  assert.equal(t4?.lastError, 'test 紅燈');

  ledger.updateTaskState('T-4', 'done', { incAttempts: true });
  const done = ledger.getTask('T-4');
  assert.equal(done?.state, 'done');
  assert.equal(done?.attempts, 2);
  assert.equal(done?.lastError, 'test 紅燈', 'lastError 不會被 null 覆蓋（COALESCE）');
});

// 更新類方法的統一契約：更新到 → true；找不到目標 → false + warn（一律不擲錯）。
// 舊行為只有 updateTaskState 會擲錯、其餘三個靜默 no-op，讓「狀態沒更新」變成無聲失敗。

test('更新類方法：更新到目標一律回 true', (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-ok' }));
  const g = ledger.createGroup({ repo: 'acme/web', branch: 'b', taskIds: ['T-ok'], footprint: [] });

  assert.equal(ledger.updateTaskState('T-ok', 'queued'), true);
  assert.equal(ledger.setBlock('T-ok', 'deps'), true);
  assert.equal(ledger.clearBlock('T-ok', 'queued'), true);
  assert.equal(ledger.updateGroupState(g.id, 'forming'), true);
});

test('更新類方法：目標不存在一律回 false 且留下 warn（不擲錯，避免打掛 daemon）', (t) => {
  const { ledger, rec } = setupWithLog(t);

  assert.equal(ledger.updateTaskState('幽靈', 'done'), false);
  assert.equal(ledger.setBlock('幽靈', 'needs_human', 'x'), false);
  assert.equal(ledger.clearBlock('幽靈', 'queued'), false);
  assert.equal(ledger.updateGroupState('g_幽靈', 'merged'), false);

  const warned = rec.records.filter((r) => r.level >= 40).map((r) => r.op);
  assert.deepEqual(warned, ['updateTaskState', 'setBlock', 'clearBlock', 'updateGroupState']);
});

test('更新類方法：目標不存在時不得偷偷新增資料列', (t) => {
  const { ledger } = setup(t);
  ledger.setBlock('幽靈', 'deps');
  ledger.updateGroupState('g_幽靈', 'merged');
  assert.equal(ledger.getTask('幽靈'), undefined);
  assert.equal(ledger.getGroup('g_幽靈'), undefined);
});

test('updateTaskState 會推進 updatedAt', async (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-5' }));
  const before = ledger.getTask('T-5')!.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  ledger.updateTaskState('T-5', 'queued');
  assert.ok(ledger.getTask('T-5')!.updatedAt > before);
});

// ── block / clearBlock ──

test('setBlock 會轉為 blocked 並帶上原因與細節；clearBlock 會清空並轉到指定狀態', (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-6' }));

  ledger.setBlock('T-6', 'deps', '上游 T-0 尚未 done');
  const blocked = ledger.getTask('T-6');
  assert.equal(blocked?.state, 'blocked');
  assert.deepEqual(blocked?.block, { reason: 'deps', detail: '上游 T-0 尚未 done' });

  ledger.clearBlock('T-6', 'queued');
  const cleared = ledger.getTask('T-6');
  assert.equal(cleared?.state, 'queued');
  assert.equal(cleared?.block, undefined, 'clearBlock 必須把 block_reason/detail 一併清掉');
});

test('setBlock 可不帶 detail；換原因會覆蓋前一次的 detail', (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-7' }));

  ledger.setBlock('T-7', 'needs_clarification', '要問人：用哪個 API');
  ledger.setBlock('T-7', 'needs_human');
  const b = ledger.getTask('T-7')?.block;
  assert.equal(b?.reason, 'needs_human');
  assert.equal(b?.detail, undefined, '新的 block 不應殘留舊 detail');
});

// ── iterations（無進展偵測資料源） ──

test('recordIteration / recentSignatures：新到舊排序並受 n 限制', (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-8' }));

  ledger.recordIteration('T-8', 1, 'sig-a', false, 'diff1');
  ledger.recordIteration('T-8', 2, 'sig-b', false);
  ledger.recordIteration('T-8', 3, 'sig-c', true, 'diff3');

  assert.deepEqual(ledger.recentSignatures('T-8', 2), ['sig-c', 'sig-b']);
  assert.deepEqual(ledger.recentSignatures('T-8', 10), ['sig-c', 'sig-b', 'sig-a']);
  assert.deepEqual(ledger.recentSignatures('T-8', 0), []);
});

test('recentSignatures 只看該任務，且無紀錄時回空陣列', (t) => {
  const { ledger } = setup(t);
  ledger.recordIteration('T-9', 1, 'x', false);
  assert.deepEqual(ledger.recentSignatures('T-9', 3), ['x']);
  assert.deepEqual(ledger.recentSignatures('T-other', 3), []);
});

// ── Groups ──

test('createGroup 冪等：同 repo 同任務集合（不論順序）回同一個群', (t) => {
  const { ledger } = setup(t);
  const a = ledger.createGroup({ repo: 'acme/web', branch: 'auto/g-1', taskIds: ['T-1', 'T-2'], footprint: ['a.md'] });
  const b = ledger.createGroup({ repo: 'acme/web', branch: '完全不同的分支', taskIds: ['T-2', 'T-1'], footprint: [] });

  assert.equal(a.id, b.id);
  assert.match(a.id, /^g_[0-9a-f]{12}$/);
  assert.equal(b.branch, 'auto/g-1', '既存群組不應被第二次呼叫覆寫');
  assert.deepEqual(b.footprint, ['a.md']);
  assert.equal(b.state, 'ready');
  assert.deepEqual(a.taskIds, ['T-1', 'T-2'], 'taskIds 保存呼叫時的真實排序（只有 id 計算才排序）');
});

test('createGroup：不同 repo 或不同任務集合 → 不同群', (t) => {
  const { ledger } = setup(t);
  const g1 = ledger.createGroup({ repo: 'acme/web', branch: 'b1', taskIds: ['T-1'], footprint: [] });
  const g2 = ledger.createGroup({ repo: 'acme/api', branch: 'b2', taskIds: ['T-1'], footprint: [] });
  const g3 = ledger.createGroup({ repo: 'acme/web', branch: 'b3', taskIds: ['T-1', 'T-9'], footprint: [] });
  assert.equal(new Set([g1.id, g2.id, g3.id]).size, 3);
});

test('listGroupsByState 依狀態過濾；updateGroupState 寫入 PR 資訊且 COALESCE 保留', (t) => {
  const { ledger } = setup(t);
  const g1 = ledger.createGroup({ repo: 'acme/web', branch: 'b1', taskIds: ['T-1'], footprint: [] });
  const g2 = ledger.createGroup({ repo: 'acme/web', branch: 'b2', taskIds: ['T-2'], footprint: [] });

  assert.deepEqual(
    ledger.listGroupsByState('ready').map((g) => g.id).sort(),
    [g1.id, g2.id].sort(),
  );

  ledger.updateGroupState(g1.id, 'pr_open', { prUrl: 'https://github.com/acme/web/pull/7', prNumber: 7 });
  assert.deepEqual(ledger.listGroupsByState('ready').map((g) => g.id), [g2.id]);

  const open = ledger.listGroupsByState('pr_open');
  assert.equal(open.length, 1);
  assert.equal(open[0]?.prNumber, 7);
  assert.equal(open[0]?.prUrl, 'https://github.com/acme/web/pull/7');

  ledger.updateGroupState(g1.id, 'in_review');
  const reviewed = ledger.getGroup(g1.id);
  assert.equal(reviewed?.state, 'in_review');
  assert.equal(reviewed?.prNumber, 7, '後續狀態轉移不得把 PR 編號沖掉');
  assert.equal(reviewed?.prUrl, 'https://github.com/acme/web/pull/7');
});

test('getGroup 找不到回 undefined；新群沒有 PR 欄位', (t) => {
  const { ledger } = setup(t);
  assert.equal(ledger.getGroup('g_nope'), undefined);
  const g = ledger.createGroup({ repo: 'acme/web', branch: 'b', taskIds: ['T-1'], footprint: ['a', 'b'] });
  assert.equal(g.prUrl, undefined);
  assert.equal(g.prNumber, undefined);
  assert.deepEqual(g.footprint, ['a', 'b']);
});

test('upsertGroup 對同 id 為更新而非重複插入', (t) => {
  const { ledger } = setup(t);
  ledger.upsertGroup({ id: 'g_fixed', repo: 'acme/web', branch: 'b1', taskIds: ['T-1'], footprint: [], state: 'forming' });
  ledger.upsertGroup({ id: 'g_fixed', repo: 'acme/web', branch: 'b2', taskIds: ['T-1', 'T-2'], footprint: ['x'], state: 'ready' });

  assert.equal(ledger.listGroupsByState('forming').length, 0);
  const g = ledger.getGroup('g_fixed');
  assert.equal(g?.branch, 'b2');
  assert.equal(g?.state, 'ready');
  assert.deepEqual(g?.taskIds, ['T-1', 'T-2']);
});

// ── events ──

test('logEvent 可接受各 scope 與 null refId（稽核不得因缺參數而爆）', (t) => {
  const { ledger } = setup(t);
  assert.doesNotThrow(() => {
    ledger.logEvent('task', 'T-1', 'claimed', '認領成功');
    ledger.logEvent('group', 'g_1', 'pr_open');
    ledger.logEvent('system', null, 'boot');
  });
});

// ── events 讀取（跨重啟去重 / 審查意見回讀） ──

test('hasEvent：寫過的 (scope, refId, kind, detail) 查得到，任一欄不同就查不到', (t) => {
  const { ledger } = setup(t);
  ledger.logEvent('group', 'g_1', 'review_seen', 'review:99');

  assert.equal(ledger.hasEvent('group', 'g_1', 'review_seen', 'review:99'), true);
  assert.equal(ledger.hasEvent('group', 'g_1', 'review_seen', 'review:100'), false);
  assert.equal(ledger.hasEvent('group', 'g_2', 'review_seen', 'review:99'), false);
  assert.equal(ledger.hasEvent('task', 'g_1', 'review_seen', 'review:99'), false);
  assert.equal(ledger.hasEvent('group', 'g_1', '別的 kind', 'review:99'), false);
});

test('hasEvent：省略 detail 表示不比對 detail；refId 可為 null（system 事件）', (t) => {
  const { ledger } = setup(t);
  ledger.logEvent('group', 'g_1', 'review_seen', 'review:99');
  ledger.logEvent('system', null, 'boot');

  assert.equal(ledger.hasEvent('group', 'g_1', 'review_seen'), true);
  assert.equal(ledger.hasEvent('system', null, 'boot'), true);
  assert.equal(ledger.hasEvent('system', null, 'boot', undefined), true, 'detail 沒寫入時也要查得到');
  assert.equal(ledger.hasEvent('system', 'g_1', 'boot'), false, 'null refId 不可與具名 refId 混淆');
});

test('latestEvent：回最後寫入的那一筆（同毫秒也要靠 id 分勝負）；查無回 undefined', (t) => {
  const { ledger } = setup(t);
  ledger.logEvent('group', 'g_1', 'review_feedback', '第一次');
  ledger.logEvent('group', 'g_1', '別的 kind', '干擾');
  ledger.logEvent('group', 'g_2', 'review_feedback', '別的群組');
  ledger.logEvent('group', 'g_1', 'review_feedback', '第二次');

  const latest = ledger.latestEvent('group', 'g_1', 'review_feedback');
  assert.equal(latest?.detail, '第二次');
  assert.equal(latest?.scope, 'group');
  assert.equal(latest?.refId, 'g_1');
  assert.ok(latest && latest.id > 0 && latest.createdAt > 0);
  assert.equal(ledger.latestEvent('group', 'g_nope', 'review_feedback'), undefined);
});

test('審查意見可跨重啟讀回：logEvent 寫的 JSON 能原樣還原（changes_requested 不再是死狀態）', (t) => {
  const { dir, ledger, dbPath } = createTmpLedger();
  t.after(() => dir.cleanup());
  const fb = { groupId: 'g_1', comments: ['@bob: 要加測試'], source: 'github_review', at: 1_700_000_000_000 };
  ledger.logEvent('group', 'g_1', 'review_feedback', JSON.stringify(fb));
  ledger.close();

  // 模擬 daemon 重啟：重開同一個 db 檔，意見必須還在
  const reopened = new Ledger(dbPath, createRecordingLogger().logger);
  reopened.init();
  t.after(() => reopened.close());
  const row = reopened.latestEvent('group', 'g_1', 'review_feedback');
  assert.ok(row?.detail);
  assert.deepEqual(JSON.parse(row.detail), fb);
});

test('listEvents：新到舊、可依 scope/refId/kind/sinceMs 過濾並受 limit 限制', (t) => {
  const { ledger } = setup(t);
  ledger.logEvent('group', 'g_1', 'k', 'a');
  ledger.logEvent('group', 'g_1', 'k', 'b');
  ledger.logEvent('task', 'T-1', 'k', 'c');
  ledger.logEvent('system', null, 'k', 'd');

  assert.deepEqual(ledger.listEvents({ kind: 'k' }).map((e) => e.detail), ['d', 'c', 'b', 'a']);
  assert.deepEqual(ledger.listEvents({ scope: 'group', refId: 'g_1' }).map((e) => e.detail), ['b', 'a']);
  assert.deepEqual(ledger.listEvents({ refId: null }).map((e) => e.detail), ['d'], 'refId: null 只挑 system 事件');
  assert.deepEqual(ledger.listEvents({ limit: 1 }).map((e) => e.detail), ['d']);
  assert.deepEqual(ledger.listEvents({ sinceMs: Date.now() + 60_000 }), [], '未來時間點之後沒有事件');
  assert.equal(ledger.listEvents({ sinceMs: 0 }).length, 4);
});

// ── 保留策略（pruneEvents / pruneTaskIterations） ──

/** 直接改寫 created_at，模擬「很久以前寫的」資料（不必真的等 30 天）。 */
function ageEvents(dbPath: string, kind: string, createdAt: number): void {
  const db = new Database(dbPath);
  db.prepare('UPDATE events SET created_at = ? WHERE kind = ?').run(createdAt, kind);
  db.close();
}

test('pruneEvents：只清逾期且對象已收攤的事件；進行中的群組/任務事件一律保留', (t) => {
  const h = setup(t);
  const { ledger } = h;
  const old = Date.now() - 90 * 24 * 3600_000;

  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-done' }));
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-live' }));
  ledger.updateTaskState('T-done', 'done');
  const gDone = ledger.createGroup({ repo: 'acme/web', branch: 'b1', taskIds: ['T-done'], footprint: [] });
  const gLive = ledger.createGroup({ repo: 'acme/web', branch: 'b2', taskIds: ['T-live'], footprint: [] });
  ledger.updateGroupState(gDone.id, 'merged');
  ledger.updateGroupState(gLive.id, 'in_review');

  ledger.logEvent('task', 'T-done', 'old', '任務已 done');
  ledger.logEvent('task', 'T-live', 'old', '任務還沒 done');
  ledger.logEvent('group', gDone.id, 'old', '群組已合併');
  ledger.logEvent('group', gLive.id, 'old', '審查中的群組：去重/意見還在服役');
  ledger.logEvent('group', 'g_不存在', 'old', 'ledger 已查無此群組');
  ledger.logEvent('system', null, 'old', '純稽核');
  ageEvents(h.dbPath, 'old', old);
  ledger.logEvent('system', null, 'fresh', '還很新');

  const deleted = ledger.pruneEvents(Date.now() - 30 * 24 * 3600_000);
  assert.equal(deleted, 4, '只有「已 done 任務 / 終態群組 / 查無群組 / system」的逾期事件會被清');

  const kept = ledger.listEvents({}).map((e) => e.detail).sort();
  assert.deepEqual(kept, ['任務還沒 done', '審查中的群組：去重/意見還在服役', '還很新'].sort());
});

test('pruneEvents：cutoff 之後的事件不動；cutoff 非數值時保守不清', (t) => {
  const { ledger } = setup(t);
  ledger.logEvent('system', null, 'k', 'a');
  assert.equal(ledger.pruneEvents(Date.now() - 1000), 0, '剛寫的事件不在保留期外');
  assert.equal(ledger.pruneEvents(Number.NaN), 0);
  assert.equal(ledger.listEvents({}).length, 1);
});

/** 直接寫入指定 created_at 的迭代紀錄（繞過 recordIteration 的 now()）。 */
function seedIterations(dbPath: string, taskId: string, rounds: number[], createdAt: number): void {
  const db = new Database(dbPath);
  const stmt = db.prepare(
    'INSERT INTO task_iterations (task_id, round, signature, green, diff_hash, created_at) VALUES (?, ?, ?, 0, NULL, ?)',
  );
  for (const r of rounds) stmt.run(taskId, r, `sig-${r}`, createdAt);
  db.close();
}

test('pruneTaskIterations：清逾期但每個任務至少保留最近 N 筆（保住無進展偵測的軌跡）', (t) => {
  const h = setup(t);
  const old = Date.now() - 90 * 24 * 3600_000;
  h.ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-a' }));
  h.ledger.updateTaskState('T-a', 'done');
  seedIterations(h.dbPath, 'T-a', [1, 2, 3, 4, 5], old);

  const deleted = h.ledger.pruneTaskIterations(Date.now() - 30 * 24 * 3600_000, 2);
  assert.equal(deleted, 3);
  assert.deepEqual(h.ledger.recentSignatures('T-a', 10), ['sig-5', 'sig-4'], '保留的必須是最近的那幾輪');
});

test('pruneTaskIterations：進行中的任務完全不動；未逾期的也不動', (t) => {
  const h = setup(t);
  const old = Date.now() - 90 * 24 * 3600_000;
  for (const id of ['T-run', 'T-verify', 'T-done']) {
    h.ledger.upsertDiscoveredTask(makeDiscoveredTask({ id }));
    seedIterations(h.dbPath, id, [1, 2, 3], old);
  }
  h.ledger.updateTaskState('T-run', 'in_progress');
  h.ledger.updateTaskState('T-verify', 'verifying');
  h.ledger.updateTaskState('T-done', 'done');
  h.ledger.recordIteration('T-done', 4, 'sig-new', true); // 新的，不該被清

  const deleted = h.ledger.pruneTaskIterations(Date.now() - 30 * 24 * 3600_000, 0);
  assert.equal(deleted, 3, '只有已 done 任務的 3 筆逾期紀錄會被清');
  assert.deepEqual(h.ledger.recentSignatures('T-run', 10), ['sig-3', 'sig-2', 'sig-1']);
  assert.deepEqual(h.ledger.recentSignatures('T-verify', 10), ['sig-3', 'sig-2', 'sig-1']);
  assert.deepEqual(h.ledger.recentSignatures('T-done', 10), ['sig-new']);
});

test('pruneTaskIterations：cutoff 非數值時保守不清；keepPerTask 為負數視為 0', (t) => {
  const h = setup(t);
  seedIterations(h.dbPath, 'T-x', [1], Date.now() - 90 * 24 * 3600_000);
  assert.equal(h.ledger.pruneTaskIterations(Number.NaN, 5), 0);
  assert.equal(h.ledger.recentSignatures('T-x', 10).length, 1);
  assert.equal(h.ledger.pruneTaskIterations(Date.now(), -1), 1);
});

test('close 之後再操作會丟錯（確保連線真的關掉）', (t) => {
  const h = createTmpLedger();
  t.after(() => h.cleanup());
  h.ledger.close();
  assert.throws(() => h.ledger.getTask('T-1'));
});

// ── onTaskChanged：狀態變更的觀察者（卡片同步的掛載點）──

/**
 * 這批測試存在的理由是一個實跑才發現的洞：卡片更新原本掛在「有發通知事件」上，
 * 於是 `verifying` 這種「改完狀態就直接去跑幾分鐘測試、中間不發任何事件」的轉換
 * 完全不會反映到卡片——實測跑了好幾輪，「驗證中」一次都沒出現過。
 * 狀態的唯一事實源是 ledger，所以觀察者也掛在 ledger。
 */
test('onTaskChanged：updateTaskState 成功即通知（verifying 這種不發事件的轉換也算）', (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-1' }));

  const seen: string[] = [];
  ledger.onTaskChanged((id) => seen.push(id));

  ledger.updateTaskState('T-1', 'in_progress');
  ledger.updateTaskState('T-1', 'verifying');
  ledger.updateTaskState('T-1', 'done');

  assert.deepEqual(seen, ['T-1', 'T-1', 'T-1']);
});

test('onTaskChanged：setBlock / clearBlock 也會通知（等人與解除都要反映在卡片）', (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-1' }));
  const seen: string[] = [];
  ledger.onTaskChanged((id) => seen.push(id));

  ledger.setBlock('T-1', 'needs_clarification', '要用哪個欄位排序？');
  ledger.clearBlock('T-1', 'in_progress');

  assert.deepEqual(seen, ['T-1', 'T-1']);
});

test('onTaskChanged：群組狀態變更會通知群內每一個任務', (t) => {
  const { ledger } = setup(t);
  for (const id of ['T-1', 'T-2']) ledger.upsertDiscoveredTask(makeDiscoveredTask({ id }));
  const g = ledger.createGroup({ repo: 'acme/web', branch: 'b', taskIds: ['T-1', 'T-2'], footprint: [] });

  const seen: string[] = [];
  ledger.onTaskChanged((id) => seen.push(id));
  ledger.updateGroupState(g.id, 'in_review');

  // 群層狀態會改變群內每張卡的呈現（done 的任務在 in_review 下要變成「等你核准合併」）
  assert.deepEqual(seen.sort(), ['T-1', 'T-2']);
});

test('onTaskChanged：更新不到目標時不通知（沒有真的變化就不該騙卡片去重畫）', (t) => {
  const { ledger } = setupWithLog(t);
  const seen: string[] = [];
  ledger.onTaskChanged((id) => seen.push(id));

  ledger.updateTaskState('不存在的任務', 'done');
  ledger.setBlock('不存在的任務', 'deps');

  assert.deepEqual(seen, []);
});

test('onTaskChanged：觀察者擲錯不得影響資料寫入，也不得往外冒', (t) => {
  const { ledger, rec } = setupWithLog(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-1' }));
  ledger.onTaskChanged(() => {
    throw new Error('Slack 掛了');
  });

  // 畫卡片失敗絕不能影響實際工作——同類事故發生過（卡片同步擲錯冒到外層，整群被標 failed）
  assert.doesNotThrow(() => ledger.updateTaskState('T-1', 'done'));
  assert.equal(ledger.getTask('T-1')?.state, 'done', '狀態必須照樣寫進去');
  assert.ok(rec.messages('warn').some((w) => /觀察者擲錯/.test(w)), '應留下 warn 而不是靜默吞掉');
});

// ─────────────────────────────────────────────────────────────────────
// check_runs：關卡執行的流水帳
//
// 這張表存在的理由是「同一條分支 14:04:45 綠、14:13:51 紅」——那個事實
// 先前只能靠事後翻 stdout.log 一行一行對時間才發現，而它正是判斷
// 「這個紅是不是這一群造成的」唯一有用的證據。
// ─────────────────────────────────────────────────────────────────────

test('check_runs：同一條分支的綠與紅都留著，查得出「什麼時候翻的」', (t) => {
  const { ledger } = setup(t);
  const base = { repo: 'o/r', branch: 'orch/g1', workspaceKind: 'merge_tree' as const, command: 'npm test', requestedBy: 'program' as const };
  ledger.recordCheckRun({ ...base, exitCode: 0, output: '130 passed', startedAt: 1_000, endedAt: 1_100 });
  ledger.recordCheckRun({ ...base, exitCode: 1, output: '❌ schedule-engine', startedAt: 2_000, endedAt: 2_100 });

  const rows = ledger.listCheckRuns({ repo: 'o/r', branch: 'orch/g1' });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.exitCode), [1, 0], '由新到舊');
  assert.match(rows[0]!.output, /schedule-engine/, '全文要留著，不截斷不挑行');
});

test('check_runs：exitCode 未給 = 沒跑起來，與「跑了但失敗」是不同的事實', (t) => {
  const { ledger } = setup(t);
  ledger.recordCheckRun({ repo: 'o/r', workspaceKind: 'verify_tree', command: 'make test', requestedBy: 'reviewer' });
  const [row] = ledger.listCheckRuns({ repo: 'o/r' });
  assert.equal(row?.exitCode, undefined, '沒跑起來不可以被記成 exit 0');
});

test('check_runs：prune 回傳被清掉那些列的落地檔路徑（否則全文變孤兒）', (t) => {
  const { ledger } = setup(t);
  const old = { repo: 'o/r', branch: 'b', workspaceKind: 'group_tree' as const, command: 'npm test', requestedBy: 'program' as const };
  for (let i = 0; i < 25; i += 1) {
    ledger.recordCheckRun({ ...old, exitCode: 0, outputPath: `/tmp/out-${i}.log`, startedAt: 1_000 + i, endedAt: 1_000 + i });
  }

  const paths = ledger.pruneCheckRuns({ olderThan: 9_999, keepPerBranch: 20 });

  assert.equal(paths.length, 5, '25 筆保底留 20 → 清掉 5 筆');
  assert.ok(paths.every((p) => p.startsWith('/tmp/out-')), '要把路徑交回去給呼叫端刪檔');
  assert.equal(ledger.listCheckRuns({ repo: 'o/r' }).length, 20);
});

test('check_runs：保底筆數內的紀錄不會因為太舊而被清光', (t) => {
  const { ledger } = setup(t);
  ledger.recordCheckRun({ repo: 'o/r', branch: 'b', workspaceKind: 'group_tree', command: 'npm test', requestedBy: 'program', exitCode: 1, startedAt: 1, endedAt: 1 });
  assert.deepEqual(ledger.pruneCheckRuns({ olderThan: 9_999, keepPerBranch: 20 }), []);
  assert.equal(ledger.listCheckRuns({ repo: 'o/r' }).length, 1, '唯一一筆證據不能因為過期就消失');
});

// ─────────────────────────────────────────────────────────────────────
// handoffs：交接單
//
// 「停手與說話是同一個寫入動作」。實跑撞到的 bug：兩個群耗盡重試停在
// changes_requested、16 個任務堵著，而控制台顯示「沒有需要你處理的事項」。
// ─────────────────────────────────────────────────────────────────────

const HANDOFF = {
  groupId: 'g1', fromRole: 'merger' as const, toRole: 'human' as const,
  kind: 'stuck_group' as const, title: '群組停手',
};

test('handoffs：開不出沒有說明的單（停手與說話是同一個動作）', (t) => {
  const { ledger } = setup(t);
  assert.throws(() => ledger.openHandoff({ ...HANDOFF, body: '' }), /說明欄不可為空/);
  assert.throws(() => ledger.openHandoff({ ...HANDOFF, body: '   \n  ' }), /說明欄不可為空/, '只有空白也不算說明');
  assert.deepEqual(ledger.listHandoffs({}), [], '擲錯就不該留下半張單');
});

test('handoffs：to_role=human 且未處理 = 待處理清單（不看群組狀態）', (t) => {
  const { ledger } = setup(t);
  ledger.openHandoff({ ...HANDOFF, body: '測試紅了，要你決定' });
  ledger.openHandoff({ ...HANDOFF, toRole: 'coder', kind: 'review_feedback', body: '審查意見：X 不符規格' });

  const inbox = ledger.listHandoffs({ toRole: 'human', unconsumedOnly: true });

  assert.equal(inbox.length, 1, '給 coder 的審查往返不該出現在人的清單上');
  assert.equal(inbox[0]!.kind, 'stuck_group');
});

test('handoffs：處理完就從清單上消失（沒有這個寫入點，清單只會單向增長）', (t) => {
  const { ledger } = setup(t);
  const id = ledger.openHandoff({ ...HANDOFF, body: '要你決定' });

  assert.equal(ledger.consumeHandoff(id), true);
  assert.deepEqual(ledger.listHandoffs({ toRole: 'human', unconsumedOnly: true }), []);
  assert.equal(ledger.consumeHandoff(id), false, '重複標掉回 false，但不擲錯（收尾動作重放是正常的）');
  assert.equal(ledger.listHandoffs({ toRole: 'human' }).length, 1, '單本身留著當稽核軌跡');
});

test('handoffs：kind 是路由碼，UI 靠它決定畫哪組按鈕', (t) => {
  const { ledger } = setup(t);
  ledger.openHandoff({ ...HANDOFF, kind: 'clarification', body: '要用哪一種快取？' });
  ledger.openHandoff({ ...HANDOFF, kind: 'merge_approval', body: '等你核准合併' });

  assert.equal(ledger.listHandoffs({ toRole: 'human', kind: 'merge_approval' }).length, 1);
  assert.equal(ledger.listHandoffs({ toRole: 'human', kind: 'clarification' }).length, 1);
});

test('handoffs：blocking=false 的交付說明照樣存得下（給下一棒的脈絡）', (t) => {
  const { ledger } = setup(t);
  ledger.openHandoff({
    groupId: 'g1', taskId: 'T-1', fromRole: 'coder', toRole: 'coder', kind: 'delivery',
    blocking: false, title: 'T-1 交付', body: '做了 X，放棄了 Y 因為 Z',
    evidence: ['check_run:12'], blindspots: '沒驗 /settings',
  });
  const [row] = ledger.listHandoffs({ groupId: 'g1' });
  assert.equal(row?.blocking, false);
  assert.deepEqual(row?.evidence, ['check_run:12']);
  assert.equal(row?.blindspots, '沒驗 /settings');
});

test('handoffs：consumeHandoffsFor 一次收掉整群未處理的單', (t) => {
  const { ledger } = setup(t);
  ledger.openHandoff({ ...HANDOFF, body: 'a' });
  ledger.openHandoff({ ...HANDOFF, kind: 'merge_approval', body: 'b' });
  ledger.openHandoff({ ...HANDOFF, groupId: 'g2', body: '別群的' });

  assert.equal(ledger.consumeHandoffsFor({ groupId: 'g1' }), 2);
  assert.equal(ledger.listHandoffs({ toRole: 'human', unconsumedOnly: true }).length, 1, '別群的不受影響');
});

test('停用專案不留孤兒：刪任務／群組要級聯刪掉交接單', (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-1' }));
  ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: ['T-1'], footprint: [] });
  const gid = ledger.getTask('T-1') && ledger.listGroupsByState('ready')[0]!.id;
  ledger.openHandoff({ groupId: gid, fromRole: 'merger', toRole: 'human', kind: 'stuck_group', title: 't', body: '要你決定' });
  ledger.openHandoff({ taskId: 'T-1', fromRole: 'coder', toRole: 'human', kind: 'clarification', title: 't', body: '問題' });

  ledger.deleteGroup(gid!);
  ledger.deleteTask('T-1');

  assert.deepEqual(
    ledger.listHandoffs({ toRole: 'human', unconsumedOnly: true }),
    [],
    '孤兒單會永遠掛在「等你處理」上，指向一個已經不存在的東西',
  );
});
