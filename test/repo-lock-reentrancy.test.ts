import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withRepoLock } from '../src/core/repo-lock.js';

/**
 * `withRepoLock` 是 promise 佇列（`prev.then(...)`），**完全不可重入**。
 *
 * 持有者在自己的 fn 裡再呼叫一次同鍵的 withRepoLock，內層會排在外層後面，
 * 而外層在等內層回來——**永久死鎖**。它不拋錯、不留 log，症狀是那個 repo 之後
 * 所有的群組全部靜止。
 *
 * 這條測試把這個性質釘住，因為第 10 片有一個很自然的寫法會踩到它：
 * 「在合併路徑裡建一棵拋棄式驗收樹」——而 WorktreeManager.create 內部就有這把鎖。
 */
describe('withRepoLock 不可重入（踩到就是永久死鎖，不拋錯不留 log）', () => {
  it('同鍵重入會卡住——所以任何持鎖的路徑都不准再呼叫它', async () => {
    const key = '/tmp/reentrancy-probe';
    let innerRan = false;

    const outer = withRepoLock(key, async () => {
      // 這一行在真實程式裡長得像 `await this.wm.create(repoPath, ...)`
      const inner = withRepoLock(key, async () => { innerRan = true; });
      const raced = await Promise.race([
        inner.then(() => 'inner-done' as const),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 300)),
      ]);
      return raced;
    });

    assert.equal(await outer, 'timeout', '內層拿不到鎖——這就是死鎖的形狀');
    assert.equal(innerRan, false);
  });

  it('不同鍵不受影響（合併鎖與 fetch 鎖刻意分開就是這個道理）', async () => {
    let ran = false;
    await withRepoLock('/tmp/key-a', async () => {
      await withRepoLock('/tmp/key-b', async () => { ran = true; });
    });
    assert.equal(ran, true);
  });
});
