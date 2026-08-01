import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { describeUsage, evaluateBudget, limitOf, periodKey, periodStart, type BudgetLimits } from '../src/core/budget.js';
import type { CostSummary } from '../src/store/ledger.js';

const NOW = new Date('2026-07-30T14:00:00+08:00').getTime(); // 週四
const limits = (over: Partial<BudgetLimits> = {}): BudgetLimits => ({ warnAtPercent: 80, ...over });
const cost = (usd: number): CostSummary => ({ sessions: 1, costUsd: usd, inputTokens: 0, outputTokens: 0, rounds: 1 });

describe('週期起點', () => {
  it('今天 00:00（本地時區）', () => {
    const d = new Date(periodStart('daily', NOW));
    assert.equal(d.getHours(), 0);
    assert.equal(d.getDate(), 30);
  });

  it('本週從週一算起', () => {
    const d = new Date(periodStart('weekly', NOW));
    assert.equal(d.getDay(), 1, '7/30 是週四 → 本週一');
    assert.equal(d.getDate(), 27);
  });

  it('本月從 1 號算起', () => {
    const d = new Date(periodStart('monthly', NOW));
    assert.equal(d.getDate(), 1);
    assert.equal(d.getMonth(), 6);
  });

  /** 去重鍵要能區分週期：同一天但「本週」與「本月」的鍵必須不同。 */
  it('週期鍵含週期名與起點日期', () => {
    assert.equal(periodKey('daily', NOW), 'daily:2026-07-30');
    assert.equal(periodKey('weekly', NOW), 'weekly:2026-07-27');
    assert.equal(periodKey('monthly', NOW), 'monthly:2026-07-01');
  });

  it('跨週期就換鍵（隔天的通知會重新發一次）', () => {
    const tomorrow = NOW + 24 * 3600_000;
    assert.notEqual(periodKey('daily', NOW), periodKey('daily', tomorrow));
    assert.equal(periodKey('monthly', NOW), periodKey('monthly', tomorrow), '同月則同鍵');
  });
});

describe('上限解析', () => {
  it('0 或負數視為不限制（避免「設 0 等於完全停工」的誤解）', () => {
    assert.equal(limitOf(limits({ dailyUsd: 0 }), 'daily'), undefined);
    assert.equal(limitOf(limits({ dailyUsd: -5 }), 'daily'), undefined);
    assert.equal(limitOf(limits({ dailyUsd: 10 }), 'daily'), 10);
  });
});

describe('花費上限判定', () => {
  const evalWith = (l: BudgetLimits, spent: number) =>
    evaluateBudget({ limits: l, spentSince: () => cost(spent), now: NOW });

  it('沒設任何上限 → 一律放行，也沒有任何警告', () => {
    const v = evalWith(limits(), 9999);
    assert.equal(v.ok, true);
    assert.deepEqual(v.all, []);
    assert.deepEqual(v.warning, []);
  });

  it('未達警戒線 → 放行且不吵', () => {
    const v = evalWith(limits({ dailyUsd: 10 }), 5);
    assert.equal(v.ok, true);
    assert.deepEqual(v.warning, []);
    assert.equal(v.all.length, 1);
  });

  it('越過警戒線但未超限 → 放行但要警告', () => {
    const v = evalWith(limits({ dailyUsd: 10 }), 8.5);
    assert.equal(v.ok, true);
    assert.equal(v.warning.length, 1);
    assert.equal(v.warning[0]?.period, 'daily');
  });

  it('達到上限 → 擋下（等於上限也算超過）', () => {
    const v = evalWith(limits({ dailyUsd: 10 }), 10);
    assert.equal(v.ok, false);
    assert.equal(v.exceeded[0]?.period, 'daily');
    assert.deepEqual(v.warning, [], '已超限就不再另外算警告');
  });

  it('多個週期同時判定，任何一個超限就擋', () => {
    const v = evaluateBudget({
      limits: limits({ dailyUsd: 100, weeklyUsd: 50, monthlyUsd: 1000 }),
      spentSince: (since) => cost(since === periodStart('weekly', NOW) ? 60 : 10),
      now: NOW,
    });
    assert.equal(v.ok, false);
    assert.deepEqual(v.exceeded.map((x) => x.period), ['weekly']);
    assert.equal(v.all.length, 3);
  });

  /** 設 0 會讓「還沒開始花」就一直警告；設 200 等於沒有警戒線。兩邊都要夾住。 */
  it('警戒比例夾在 1–100', () => {
    assert.equal(evalWith(limits({ dailyUsd: 10, warnAtPercent: 0 }), 0).warning.length, 0);
    assert.equal(evalWith(limits({ dailyUsd: 10, warnAtPercent: 0 }), 0.1).warning.length, 1, '1% 起才警告');
    assert.equal(evalWith(limits({ dailyUsd: 10, warnAtPercent: 500 }), 9.9).warning.length, 1, '夾到 100% 仍會在接近時警告');
  });

  it('摘要文字帶金額與百分比（人要看得懂還剩多少）', () => {
    const v = evalWith(limits({ dailyUsd: 20 }), 7);
    assert.equal(describeUsage(v.all[0]!), '今日 $7.00 / $20.00（35%）');
  });
});
