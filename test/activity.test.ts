import test from 'node:test';
import assert from 'node:assert/strict';

import { withActivity, STALE_AFTER_MS, HEARTBEAT_MS } from '../src/observability/activity.js';
import type { ActivitySink } from '../src/observability/activity.js';
import { createTmpLedger } from './helpers/index.js';

/**
 * 「現在在做什麼」。
 *
 * 這個功能存在的唯一理由：花時間最久的那幾件事（規劃、審查、視覺驗證、合併把關）
 * 期間 ledger 完全靜止，控制台上什麼都不動——使用者實際回報「我以為整個專案都在停擺」。
 *
 * 所以測的重點不是「能不能寫一列」，而是**該包的地方有沒有真的包**，
 * 以及**做完有沒有收乾淨**（留下假的進行中比沒有這功能更糟）。
 */

function spy(): ActivitySink & { started: string[]; ended: string[]; touched: string[] } {
  const started: string[] = [];
  const ended: string[] = [];
  const touched: string[] = [];
  return {
    started, ended, touched,
    startActivity: (a) => void started.push(a.id),
    touchActivity: (id, d) => void touched.push(d === undefined ? id : `${id}:${d}`),
    endActivity: (id) => void ended.push(id),
  };
}

const noTimers = { setInterval: () => ({ unref: () => {} }), clearInterval: () => {} };

test('withActivity：開始寫一列、結束刪掉', async () => {
  const s = spy();
  const r = await withActivity(s, { id: 'a', kind: 'plan', title: '規劃' }, async () => 42, noTimers);
  assert.equal(r, 42);
  assert.deepEqual(s.started, ['a']);
  assert.deepEqual(s.ended, ['a']);
});

/** 沒收乾淨的話畫面會永遠掛著一件假的進行中，使用者會學會不相信這塊畫面。 */
test('withActivity：擲錯也要刪掉', async () => {
  const s = spy();
  await assert.rejects(
    withActivity(s, { id: 'a', kind: 'plan', title: '規劃' }, () => Promise.reject(new Error('炸了')), noTimers),
  );
  assert.deepEqual(s.ended, ['a'], '擲錯之後那一列還在的話，畫面就永遠停在「規劃中」');
});

test('withActivity：中途可以更新說明（第幾輪、跑哪一關）', async () => {
  const s = spy();
  await withActivity(s, { id: 'a', kind: 'code', title: 'T-1' }, async (update) => {
    update('第 1 輪：agent 寫程式中');
    update('第 1 輪：跑驗收關卡');
  }, noTimers);
  assert.deepEqual(s.touched, ['a:第 1 輪：agent 寫程式中', 'a:第 1 輪：跑驗收關卡']);
});

test('withActivity：心跳失敗不會弄掛正在做的事', async () => {
  const s = spy();
  s.touchActivity = () => { throw new Error('DB 忙線'); };
  const r = await withActivity(s, { id: 'a', kind: 'code', title: 'T-1' }, async (update) => {
    update('還在跑');
    return 'ok';
  }, noTimers);
  assert.equal(r, 'ok', '心跳只是給畫面看的，寫不進去不該讓真正的工作失敗');
});

test('withActivity：定時餵心跳，讓「跑很久」與「daemon 死了」分得出來', async () => {
  const s = spy();
  let beat: (() => void) | undefined;
  await withActivity(s, { id: 'a', kind: 'plan', title: '規劃' }, async () => {
    beat?.(); beat?.();
  }, { setInterval: (fn, ms) => { assert.equal(ms, HEARTBEAT_MS); beat = fn; return { unref: () => {} }; }, clearInterval: () => {} });
  assert.deepEqual(s.touched, ['a', 'a']);
});

test('ledger：寫入 → 讀出 → 刪除', (t) => {
  const h = createTmpLedger();
  t.after(() => h.cleanup());

  h.ledger.startActivity({ id: 'plan:acme/web', kind: 'plan', repo: 'acme/web', title: '規劃 14 個任務' });
  const [a] = h.ledger.listActivities();
  assert.equal(a?.title, '規劃 14 個任務');
  assert.equal(a?.repo, 'acme/web');
  assert.ok(a && a.heartbeatAt >= a.startedAt);

  h.ledger.touchActivity('plan:acme/web', '第 2/2 次嘗試');
  assert.equal(h.ledger.listActivities()[0]?.detail, '第 2/2 次嘗試');

  h.ledger.endActivity('plan:acme/web');
  assert.deepEqual(h.ledger.listActivities(), []);
});

test('ledger：同一個 id 重入只有一列，不會長出兩件假工作', (t) => {
  const h = createTmpLedger();
  t.after(() => h.cleanup());
  h.ledger.startActivity({ id: 'x', kind: 'plan', title: '第一次' });
  h.ledger.startActivity({ id: 'x', kind: 'plan', title: '第二次' });
  assert.equal(h.ledger.listActivities().length, 1);
  assert.equal(h.ledger.listActivities()[0]?.title, '第二次');
});

/** daemon 被 kill 時沒有人來刪自己那幾列，重啟後畫面會永遠掛著幾件做不完的假工作。 */
test('ledger：開機清殘列（maxAgeMs=0 清光）', (t) => {
  const h = createTmpLedger();
  t.after(() => h.cleanup());
  h.ledger.startActivity({ id: 'ghost', kind: 'code', title: '上次沒收掉的' });
  assert.equal(h.ledger.clearStaleActivities(0), 1);
  assert.deepEqual(h.ledger.listActivities(), []);
});

test('ledger：還在心跳的不會被當成殘列清掉', (t) => {
  const h = createTmpLedger();
  t.after(() => h.cleanup());
  h.ledger.startActivity({ id: 'alive', kind: 'code', title: '正在跑' });
  assert.equal(h.ledger.clearStaleActivities(STALE_AFTER_MS), 0, '剛開始的工作不能被誤清');
  assert.equal(h.ledger.listActivities().length, 1);
});
