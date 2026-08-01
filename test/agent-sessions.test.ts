import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { Ledger } from '../src/store/ledger.js';
import { applyColumnMigrations, COLUMN_MIGRATIONS } from '../src/store/schema.js';
import { createTmpDir, createTmpLedger, createSilentLogger } from './helpers/index.js';

function setup(t: { after(fn: () => void): void }) {
  const h = createTmpLedger();
  t.after(() => h.cleanup());
  return h;
}

// ── session 追蹤 ──

test('recordAgentSession：同一 (task, session) 多輪會累加，不會變成多列', (t) => {
  const { ledger } = setup(t);
  ledger.recordAgentSession({
    taskId: 'T-1', sessionId: 's-1', groupId: 'G-1',
    costUsd: 0.5, inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, models: ['claude-opus-5'],
  });
  ledger.recordAgentSession({
    taskId: 'T-1', sessionId: 's-1',
    costUsd: 0.25, inputTokens: 40, outputTokens: 10, cacheReadTokens: 100, models: ['claude-opus-5'],
  });

  const row = ledger.latestAgentSession('T-1');
  assert.equal(row?.rounds, 2);
  assert.equal(row?.costUsd, 0.75);
  assert.equal(row?.inputTokens, 140);
  assert.equal(row?.outputTokens, 30);
  assert.equal(row?.cacheReadTokens, 1000);
  assert.equal(row?.groupId, 'G-1', 'groupId 只在第一輪帶入，後續不該被 null 洗掉');
  assert.deepEqual(row?.models, ['claude-opus-5'], '同一模型重複記錄不該累積重複值');
});

test('同一 session 中途換模型 → models 取併集', (t) => {
  const { ledger } = setup(t);
  ledger.recordAgentSession({ taskId: 'T-1', sessionId: 's-1', models: ['claude-opus-5'] });
  ledger.recordAgentSession({ taskId: 'T-1', sessionId: 's-1', models: ['claude-haiku-4-5-20251001'] });
  assert.deepEqual(ledger.latestAgentSession('T-1')?.models, ['claude-opus-5', 'claude-haiku-4-5-20251001']);
});

/**
 * resume 的前提：人回覆澄清後要接回**最近**那個 session，而不是第一個。
 * 取錯 session 會讓 agent 從舊上下文重跑，等於白做一輪。
 */
test('latestAgentSession 取的是最近更新的那個 session', (t) => {
  const { ledger } = setup(t);
  ledger.recordAgentSession({ taskId: 'T-1', sessionId: 's-old' });
  ledger.recordAgentSession({ taskId: 'T-1', sessionId: 's-new' });
  assert.equal(ledger.latestAgentSession('T-1')?.sessionId, 's-new');
});

test('沒有紀錄時 latestAgentSession 回 undefined（而不是丟例外）', (t) => {
  const { ledger } = setup(t);
  assert.equal(ledger.latestAgentSession('never-seen'), undefined);
});

test('markAgentSession 標記收尾狀態', (t) => {
  const { ledger } = setup(t);
  ledger.recordAgentSession({ taskId: 'T-1', sessionId: 's-1' });
  ledger.markAgentSession('T-1', 's-1', 'done');
  assert.equal(ledger.latestAgentSession('T-1')?.status, 'done');
});

// ── 成本歸屬 ──

test('costSummary 彙總全部；costByTask 依花費排序', (t) => {
  const { ledger } = setup(t);
  ledger.recordAgentSession({ taskId: 'T-1', sessionId: 's-1', costUsd: 1, inputTokens: 10, outputTokens: 1 });
  ledger.recordAgentSession({ taskId: 'T-2', sessionId: 's-2', costUsd: 3, inputTokens: 30, outputTokens: 3 });
  ledger.recordAgentSession({ taskId: 'T-2', sessionId: 's-3', costUsd: 2, inputTokens: 20, outputTokens: 2 });

  const sum = ledger.costSummary();
  assert.equal(sum.sessions, 3);
  assert.equal(sum.costUsd, 6);
  assert.equal(sum.rounds, 3);
  assert.equal(sum.inputTokens, 60);

  const byTask = ledger.costByTask();
  assert.deepEqual(byTask.map((r) => r.taskId), ['T-2', 'T-1']);
  assert.equal(byTask[0]?.costUsd, 5);
  assert.equal(byTask[0]?.rounds, 2);
});

test('costSummary(sinceMs) 只算該時間點之後的 session', (t) => {
  const { ledger } = setup(t);
  ledger.recordAgentSession({ taskId: 'T-1', sessionId: 's-1', costUsd: 1 });
  const cutoff = Date.now() + 1000; // 未來 → 應該一筆都不算
  assert.equal(ledger.costSummary(cutoff).sessions, 0);
  assert.equal(ledger.costSummary(0).sessions, 1);
});

// ── 欄位遷移 ──

/**
 * 常駐系統的 DB 是連續使用的：加欄位若不遷移，升級後所有查詢都會 `no such column`。
 * 這條直接模擬「舊版 DB」——建一張沒有新欄位的 tasks，再跑 init。
 */
test('既有 DB 缺欄位 → init 會自動補上（不用刪庫重建）', (t) => {
  const dir = createTmpDir('botone-migrate-');
  t.after(() => dir.cleanup());
  const path = dir.join('old.db'); // 直接放在暫存目錄下（better-sqlite3 不會自己建父目錄）

  const raw = new Database(path);
  raw.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, repo TEXT NOT NULL, category TEXT NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL, dependencies TEXT NOT NULL DEFAULT '[]',
    doc_refs TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, block_reason TEXT, block_detail TEXT,
    group_id TEXT, slack_thread_ts TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  const before = (raw.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
  assert.equal(before.includes('source_updated_at'), false, '前置條件：舊表沒有新欄位');
  raw.close();

  const ledger = new Ledger(path, createSilentLogger());
  ledger.init();
  ledger.upsertDiscoveredTask({
    id: 'T-1', payloadHash: 'h', repo: 'o/r', category: 'dev', title: 't', description: 'd',
    dependencies: [], docRefs: [], sourceUpdatedAt: 12345,
  });
  assert.equal(ledger.getTask('T-1')?.sourceUpdatedAt, 12345);
  ledger.close();
});

test('欄位遷移可重複執行（第二次不做事）', (t) => {
  const { ledger, dbPath } = setup(t);
  ledger.init(); // 再跑一次 init 不該炸
  const raw = new Database(dbPath);
  t.after(() => raw.close());
  assert.equal(applyColumnMigrations(raw), 0, '欄位都在了 → 不該再執行任何 ALTER');
});

test('表還不存在時遷移直接跳過（交給 SCHEMA 用完整定義建）', (t) => {
  const dir = createTmpDir('botone-migrate-empty-');
  t.after(() => dir.cleanup());
  const raw = new Database(dir.join('empty.db'));
  t.after(() => raw.close());
  assert.equal(applyColumnMigrations(raw), 0);
  assert.ok(COLUMN_MIGRATIONS.length > 0, '至少要有一條遷移，否則這條測試沒在測東西');
});
