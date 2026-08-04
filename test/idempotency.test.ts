import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTmpLedger, createTmpDir, createRecordingLogger, makeDiscoveredTask } from './helpers/index.js';
import { Ledger } from '../src/store/ledger.js';

/**
 * 不可逆動作的冪等鍵。
 *
 * **重放會發生**：daemon 崩在「動作已送出、ledger 還沒寫」之間，重啟後對帳會再走一次。
 * 而做第二次的後果與第一次不同——尤其 `complete_task`：任務板拒絕一張已結案的卡，
 * 那個拒絕在呼叫端看起來與「這張卡不存在」一模一樣，於是整群被判 failed。
 */
describe('不可逆動作的冪等鍵', () => {
  function setup(t: { after(fn: () => void): void }) {
    const h = createTmpLedger();
    t.after(() => h.cleanup());
    return h;
  }

  it('只有第一個呼叫者拿得到 true', (t) => {
    const { ledger } = setup(t);
    assert.equal(ledger.claimIrreversible('merge:o/r#1:abc', 'merge_pr', 'g1'), true);
    assert.equal(ledger.claimIrreversible('merge:o/r#1:abc', 'merge_pr', 'g1'), false);
  });

  it('第二次被擋下時要留 warn（靜默跳過看起來像「什麼都沒發生」）', (t) => {
    const dir = createTmpDir('idem-');
    t.after(() => dir.cleanup());
    const rec = createRecordingLogger();
    const ledger = new Ledger(dir.join('ledger.db'), rec.logger);
    ledger.init();

    ledger.claimIrreversible('k', 'merge_pr');
    ledger.claimIrreversible('k', 'merge_pr');

    assert.ok(rec.messages('warn').some((m) => /已經做過了/.test(m)));
  });

  it('鍵含這一次的識別 → base 前進之後可以再合併一次（那是合法的）', (t) => {
    const { ledger } = setup(t);
    assert.equal(ledger.claimIrreversible('merge:o/r#1:base-A', 'merge_pr'), true);
    assert.equal(
      ledger.claimIrreversible('merge:o/r#1:base-B', 'merge_pr'),
      true,
      '同一個 PR 在新的 base 上再合併一次，不該被上一次的紀錄擋住',
    );
  });

  it('動作確定沒生效 → 放掉鍵，否則是「什麼都沒做卻再也做不了」的死結', (t) => {
    const { ledger } = setup(t);
    ledger.claimIrreversible('complete:T-1', 'complete_task', 'T-1');

    ledger.releaseIrreversible('complete:T-1');

    assert.equal(ledger.claimIrreversible('complete:T-1', 'complete_task', 'T-1'), true, '重試要能成立');
  });

  it('hasIrreversible 是唯讀查詢，不會佔掉鍵', (t) => {
    const { ledger } = setup(t);
    assert.equal(ledger.hasIrreversible('k'), false);
    assert.equal(ledger.claimIrreversible('k', 'merge_pr'), true);
    assert.equal(ledger.hasIrreversible('k'), true);
  });

  it('不同動作互不干擾', (t) => {
    const { ledger } = setup(t);
    ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-1' }));
    assert.equal(ledger.claimIrreversible('complete:T-1', 'complete_task', 'T-1'), true);
    assert.equal(ledger.claimIrreversible('merge:o/r#1:x', 'merge_pr', 'g1'), true);
    assert.equal(ledger.claimIrreversible('complete:T-2', 'complete_task', 'T-2'), true);
  });
});
