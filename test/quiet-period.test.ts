import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_QUIET_MINUTES, splitByQuietPeriod, taskActivityAt } from '../src/core/quiet-period.js';
import type { Task } from '../src/types.js';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

function task(over: Partial<Task> & { id: string; repo: string }): Task {
  return {
    payloadHash: 'h',
    category: 'dev',
    title: over.id,
    description: '',
    dependencies: [],
    docRefs: [],
    state: 'discovered',
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as Task;
}

describe('靜置期 — 任務板安靜夠久才准分群', () => {
  it('預設 15 分鐘（使用者指定）', () => {
    assert.equal(DEFAULT_QUIET_MINUTES, 15);
  });

  it('活動時間優先用 MCP 的時間戳，缺了才退回本地發現時間', () => {
    assert.equal(taskActivityAt(task({ id: 'a', repo: 'r', createdAt: 100, sourceUpdatedAt: 500 })), 500);
    assert.equal(taskActivityAt(task({ id: 'b', repo: 'r', createdAt: 100 })), 100);
  });

  /**
   * 這條就是整個功能的存在理由：人正在陸續建立同系列任務時，
   * 已經抓到的那幾個**不可以**先開工，否則就是半成品 PR。
   */
  it('剛有新任務 → 整個專案本輪都不分群（連早就存在的任務也一起等）', () => {
    const tasks = [
      task({ id: 'old', repo: 'o/r', sourceUpdatedAt: NOW - 60 * MIN }),
      task({ id: 'new', repo: 'o/r', sourceUpdatedAt: NOW - 2 * MIN }),
    ];
    const { ready, waiting, decisions } = splitByQuietPeriod(tasks, () => 15, NOW);

    assert.equal(ready.length, 0, '同專案有新動作 → 一個都不放行');
    assert.deepEqual(waiting.map((t) => t.id).sort(), ['new', 'old']);
    assert.equal(decisions[0]?.quiet, false);
    assert.equal(decisions[0]?.waitMs, 13 * MIN, '還要等 13 分鐘');
  });

  it('最後動作已超過靜置期 → 放行', () => {
    const tasks = [task({ id: 'a', repo: 'o/r', sourceUpdatedAt: NOW - 16 * MIN })];
    const { ready, waiting, decisions } = splitByQuietPeriod(tasks, () => 15, NOW);
    assert.deepEqual(ready.map((t) => t.id), ['a']);
    assert.equal(waiting.length, 0);
    assert.equal(decisions[0]?.quiet, true);
    assert.equal(decisions[0]?.waitMs, 0);
  });

  it('剛好等滿（idle == 靜置期）就放行，不會多卡一輪', () => {
    const tasks = [task({ id: 'a', repo: 'o/r', sourceUpdatedAt: NOW - 15 * MIN })];
    assert.equal(splitByQuietPeriod(tasks, () => 15, NOW).ready.length, 1);
  });

  /** 靜置是**專案**（MCP 任務板）為單位：A 專案在忙不該卡住 B 專案。 */
  it('以專案為單位判定，互不影響', () => {
    const tasks = [
      task({ id: 'a1', repo: 'o/a', sourceUpdatedAt: NOW - 1 * MIN }),
      task({ id: 'b1', repo: 'o/b', sourceUpdatedAt: NOW - 30 * MIN }),
    ];
    const { ready, waiting } = splitByQuietPeriod(tasks, () => 15, NOW);
    assert.deepEqual(ready.map((t) => t.id), ['b1']);
    assert.deepEqual(waiting.map((t) => t.id), ['a1']);
  });

  it('每個專案可設不同分鐘數', () => {
    const tasks = [
      task({ id: 'a1', repo: 'o/a', sourceUpdatedAt: NOW - 5 * MIN }),
      task({ id: 'b1', repo: 'o/b', sourceUpdatedAt: NOW - 5 * MIN }),
    ];
    const { ready } = splitByQuietPeriod(tasks, (r) => (r === 'o/a' ? 2 : 60), NOW);
    assert.deepEqual(ready.map((t) => t.id), ['a1']);
  });

  it('設 0 → 關閉靜置期（抓到就做）', () => {
    const tasks = [task({ id: 'a', repo: 'o/r', sourceUpdatedAt: NOW })];
    assert.equal(splitByQuietPeriod(tasks, () => 0, NOW).ready.length, 1);
  });

  /**
   * MCP 端時鐘比本機快（或時區處理錯）會讓 lastActivityAt 落在未來。
   * 若不夾住，idle 會是負數 → 永遠等不到靜置 → 整個專案靜默卡死（最難查的那種故障）。
   */
  it('未來時間戳不會讓專案永久卡住：最多等一個完整靜置期', () => {
    const tasks = [task({ id: 'a', repo: 'o/r', sourceUpdatedAt: NOW + 10 * MIN })];
    const { decisions } = splitByQuietPeriod(tasks, () => 15, NOW);
    assert.equal(decisions[0]?.quiet, false);
    assert.equal(decisions[0]?.waitMs, 15 * MIN, 'idle 夾到 0 ⇒ 等一個完整週期，不是 25 分鐘');
  });

  it('空清單不會產生任何判定', () => {
    const { ready, waiting, decisions } = splitByQuietPeriod([], () => 15, NOW);
    assert.deepEqual([ready.length, waiting.length, decisions.length], [0, 0, 0]);
  });
});
