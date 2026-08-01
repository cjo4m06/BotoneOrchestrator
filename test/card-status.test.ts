import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cardStatusOf, syncTaskCard, type CardLedgerView } from '../src/core/card-status.js';

/**
 * 稽核發現：光是會寫進 thread 的事件點就有二十幾個，逐一手動接卡片更新漏掉了十二個
 * （連 merged 都漏了）。改成集中推導之後，只要 ledger 狀態是對的，卡片就一定是對的。
 * 這批測試就是那份對照表。
 */
describe('ledger 狀態 → 任務卡狀態', () => {
  it('執行中的三個階段', () => {
    assert.equal(cardStatusOf({ taskState: 'queued' }), 'working');
    assert.equal(cardStatusOf({ taskState: 'in_progress' }), 'working');
    assert.equal(cardStatusOf({ taskState: 'verifying' }), 'verifying');
  });

  /** 等人與等上游是完全不同的兩件事，混在一起人會去看一張其實不用他管的卡。 */
  it('受阻要分得出在等誰', () => {
    assert.equal(cardStatusOf({ taskState: 'blocked', blockReason: 'needs_clarification' }), 'awaiting_reply');
    assert.equal(cardStatusOf({ taskState: 'blocked', blockReason: 'needs_human' }), 'awaiting_human');
    assert.equal(cardStatusOf({ taskState: 'blocked', blockReason: 'deps' }), 'blocked_deps');
  });

  it('任務完成後看群組走到哪', () => {
    assert.equal(cardStatusOf({ taskState: 'done' }), 'done');
    assert.equal(cardStatusOf({ taskState: 'done', groupState: 'pr_open' }), 'pr_open');
    assert.equal(cardStatusOf({ taskState: 'done', groupState: 'in_review' }), 'awaiting_merge');
  });

  /** 群層終態要壓過任務層：任務自己完成了，但群組被擋下時，人要看到的是群組的狀況。 */
  it('群組的終態優先於任務狀態', () => {
    assert.equal(cardStatusOf({ taskState: 'done', groupState: 'merged' }), 'merged');
    assert.equal(cardStatusOf({ taskState: 'in_progress', groupState: 'failed' }), 'failed');
    assert.equal(cardStatusOf({ taskState: 'done', groupState: 'changes_requested' }), 'reworking');
    assert.equal(cardStatusOf({ taskState: 'done', groupState: 'merge_guard' }), 'merge_checking');
  });

  it('即使任務還受阻，群組已合併就顯示已合併（不會停在舊狀態）', () => {
    assert.equal(cardStatusOf({ taskState: 'blocked', blockReason: 'needs_human', groupState: 'merged' }), 'merged');
  });

  it('沒有群組資訊時仍給得出合理狀態', () => {
    assert.equal(cardStatusOf({ taskState: 'in_progress' }), 'working');
    assert.equal(cardStatusOf({ taskState: 'done' }), 'done');
  });
});

/**
 * syncTaskCard 是「ledger 狀態 → 真的去更新那張卡」的那一段。
 * 它被兩處呼叫（群組流程的批次同步、ledger 狀態變更的即時同步），
 * 而**只有一處是不夠的**——先前只有批次那處，於是 verifying 從來沒顯示過。
 */
describe('syncTaskCard', () => {
  interface Sent { taskId: string; status: string; extra?: { groupId?: string; prompt?: string } }

  function fakeLedger(task: ReturnType<CardLedgerView['getTask']>, group?: { state: 'in_review' }): CardLedgerView {
    return { getTask: () => task, getGroup: () => group };
  }

  it('verifying 會真的送出一次卡片更新（實跑時完全沒出現過的那個狀態）', () => {
    const sent: Sent[] = [];
    syncTaskCard(
      fakeLedger({ state: 'verifying', groupId: 'g1' }),
      { updateTaskCard: (taskId, status, extra) => void sent.push({ taskId, status, ...(extra ? { extra } : {}) }) },
      'T-1',
      () => assert.fail('不該有錯'),
    );
    assert.deepEqual(sent, [{ taskId: 'T-1', status: 'verifying', extra: { groupId: 'g1' } }]);
  });

  it('受阻的細節會帶上卡片（人不必去 thread 裡翻問題是什麼）', () => {
    const sent: Sent[] = [];
    syncTaskCard(
      fakeLedger({ state: 'blocked', block: { reason: 'needs_clarification', detail: '要用哪個欄位排序？' } }),
      { updateTaskCard: (taskId, status, extra) => void sent.push({ taskId, status, ...(extra ? { extra } : {}) }) },
      'T-1',
      () => assert.fail('不該有錯'),
    );
    assert.equal(sent[0]?.status, 'awaiting_reply');
    assert.equal(sent[0]?.extra?.prompt, '要用哪個欄位排序？');
  });

  it('群層狀態蓋過任務層：done + in_review → 等你核准合併', () => {
    const sent: Sent[] = [];
    syncTaskCard(
      fakeLedger({ state: 'done', groupId: 'g1' }, { state: 'in_review' }),
      { updateTaskCard: (taskId, status) => void sent.push({ taskId, status }) },
      'T-1',
      () => assert.fail('不該有錯'),
    );
    assert.equal(sent[0]?.status, 'awaiting_merge');
  });

  it('查不到任務 → 靜靜跳過（過期的回呼不該讓流程出錯）', () => {
    let called = 0;
    syncTaskCard(fakeLedger(undefined), { updateTaskCard: () => void (called += 1) }, 'T-空', () => assert.fail('不該有錯'));
    assert.equal(called, 0);
  });

  it('沒有 updateTaskCard 能力（如 Slack 關閉）→ 不做任何事', () => {
    syncTaskCard(fakeLedger({ state: 'verifying' }), {}, 'T-1', () => assert.fail('不該有錯'));
  });

  it('更新擲錯（同步或非同步）都只交給 onError，絕不往外冒', async () => {
    const errs: unknown[] = [];
    syncTaskCard(fakeLedger({ state: 'verifying' }), {
      updateTaskCard: () => { throw new Error('同步炸'); },
    }, 'T-1', (e) => errs.push(e));

    syncTaskCard(fakeLedger({ state: 'verifying' }), {
      updateTaskCard: () => Promise.reject(new Error('非同步炸')),
    }, 'T-1', (e) => errs.push(e));

    await new Promise((r) => setImmediate(r));
    assert.equal(errs.length, 2, '同步與非同步兩種失敗都要被接住');
  });
});
