import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isRepoLocked, resetRepoLocksForTest, tryWithRepoLock, withRepoLock } from '../src/core/repo-lock.js';

/**
 * 合併必須序列化：Merge Guard 的保證是「rebase 到最新 base 重跑驗證」，
 * 而那只有在「驗的 base ＝ 合併落地的 base」時才成立。
 * 中間有別的群先合併進去，最終落地的組合就沒有人驗過。
 */
describe('withRepoLock', () => {
  it('同一個 repo 的工作依序執行，不交錯', async () => {
    resetRepoLocksForTest();
    const order: string[] = [];
    const slow = async (tag: string, ms: number) => {
      order.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}:end`);
    };
    await Promise.all([
      withRepoLock('/r', () => slow('A', 20)),
      withRepoLock('/r', () => slow('B', 1)),
    ]);
    assert.deepEqual(order, ['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('不同 repo 完全並行（一個專案卡住不該拖死另一個）', async () => {
    resetRepoLocksForTest();
    const order: string[] = [];
    const slow = async (tag: string, ms: number) => {
      order.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}:end`);
    };
    await Promise.all([
      withRepoLock('/a', () => slow('A', 20)),
      withRepoLock('/b', () => slow('B', 1)),
    ]);
    assert.deepEqual(order, ['A:start', 'B:start', 'B:end', 'A:end']);
  });

  it('前一段擲錯不傳染給排在後面的人，也不變成 unhandled rejection', async () => {
    resetRepoLocksForTest();
    const boom = withRepoLock('/r', async () => {
      throw new Error('炸了');
    });
    await assert.rejects(() => boom, /炸了/);
    assert.equal(await withRepoLock('/r', async () => 'ok'), 'ok');
  });

  it('鎖釋放後 isRepoLocked 回 false（即使中途擲錯）', async () => {
    resetRepoLocksForTest();
    await withRepoLock('/r', async () => {
      assert.equal(isRepoLocked('/r'), true);
    });
    assert.equal(isRepoLocked('/r'), false);
    await withRepoLock('/r', async () => {
      throw new Error('x');
    }).catch(() => undefined);
    assert.equal(isRepoLocked('/r'), false);
  });
});

/**
 * 合併佇列是在主迴圈裡 await 的。排隊等一個正在跑 Merge Guard 的 worker
 * 會把輪詢、規劃、派工、提醒整個卡住好幾分鐘——15 秒後的下一輪再試就好。
 */
describe('tryWithRepoLock', () => {
  it('拿不到鎖就不做，回 undefined（主迴圈不被長時間的合併卡住）', async () => {
    resetRepoLocksForTest();
    let ran = false;
    const held = withRepoLock('/r', () => new Promise<void>((r) => setTimeout(r, 20)));
    const skipped = await tryWithRepoLock('/r', async () => {
      ran = true;
      return 'done';
    });
    assert.equal(skipped, undefined);
    assert.equal(ran, false, '拿不到鎖就完全不執行，不是等到之後才執行');
    await held;
  });

  it('沒人持有時照常執行', async () => {
    resetRepoLocksForTest();
    assert.equal(await tryWithRepoLock('/r', async () => 'ok'), 'ok');
  });
});
