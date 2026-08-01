import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  GROUP_STATES,
  TASK_STATES,
  compact,
  displayWidth,
  formatCost,
  formatStatus,
  money,
  padDisplay,
  quietWaits,
  startOfToday,
  type StatusInput,
} from '../src/cli/report.js';
import type { CostSummary } from '../src/store/ledger.js';
import type { Group, GroupState, Task, TaskState } from '../src/types.js';

const NOW = new Date('2026-07-30T14:00:00+08:00').getTime();
const MIN = 60_000;

function task(over: Partial<Task> & { id: string }): Task {
  return {
    payloadHash: 'h', repo: 'acme/web', category: 'dev', title: `任務 ${over.id}`, description: '',
    dependencies: [], docRefs: [], state: 'discovered', attempts: 0, createdAt: NOW, updatedAt: NOW, ...over,
  } as Task;
}

function group(over: Partial<Group> & { id: string }): Group {
  return {
    repo: 'acme/web', branch: 'b', taskIds: [], footprint: [], state: 'ready',
    createdAt: NOW, updatedAt: NOW, ...over,
  } as Group;
}

function statusInput(tasks: Task[], groups: Group[], quietMinutes = 15): StatusInput {
  const tasksByState = Object.fromEntries(
    TASK_STATES.map((s) => [s, tasks.filter((t) => t.state === s)]),
  ) as Record<TaskState, Task[]>;
  const groupsByState = Object.fromEntries(
    GROUP_STATES.map((s) => [s, groups.filter((g) => g.state === s)]),
  ) as Record<GroupState, Group[]>;
  return { tasksByState, groupsByState, quietMinutesOf: () => quietMinutes, now: NOW };
}

const cost = (over: Partial<CostSummary> = {}): CostSummary =>
  ({ sessions: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, rounds: 0, ...over });

describe('CLI status 報表', () => {
  it('完全空的系統要明講「沒有進行中的工作」', () => {
    const out = formatStatus(statusInput([], []));
    assert.match(out, /沒有進行中的工作/);
  });

  it('列出各狀態的數量，數量為 0 的狀態不佔版面', () => {
    const out = formatStatus(statusInput([
      task({ id: 'T-1', state: 'in_progress' }),
      task({ id: 'T-2', state: 'done' }),
      task({ id: 'T-3', state: 'done' }),
    ], []));
    assert.match(out, /執行中\s+1/);
    assert.match(out, /完成\s+2/);
    assert.equal(/已排隊/.test(out), false, '沒有 queued 任務就不該出現這一行');
  });

  /**
   * discovered 卡著不動時人第一個念頭是「壞了嗎」。
   * 沒有這段倒數，靜置期看起來就跟當機一模一樣。
   */
  it('等靜置期的專案要顯示還要等多久', () => {
    const out = formatStatus(statusInput([
      task({ id: 'T-1', repo: 'acme/web', sourceUpdatedAt: NOW - 2 * MIN }),
      task({ id: 'T-2', repo: 'acme/web', sourceUpdatedAt: NOW - 2 * MIN }),
    ], []));
    assert.match(out, /等靜置期：2 個任務，還要約 13 分鐘/);
  });

  // ── 多專案：整體數字看得到「有多少事」，看不到「是哪個專案的事」 ──

  it('依專案逐段列出，執行中與受阻掛在各自的專案下', () => {
    const out = formatStatus(statusInput([
      task({ id: 'T-1', repo: 'acme/web', state: 'in_progress' }),
      task({ id: 'T-2', repo: 'acme/api', state: 'blocked', block: { reason: 'needs_clarification' } }),
      task({ id: 'T-3', repo: 'acme/api', state: 'done' }),
    ], []));

    // 專案依名稱排序 ⇒ api 在前、web 在後；各自的任務要掛在自己那一段裡
    const api = out.indexOf('acme/api');
    const web = out.indexOf('acme/web');
    assert.ok(api > 0 && web > api, '兩個專案都要出現，且依名稱排序');
    const apiBlock = out.slice(api, web);
    const webBlock = out.slice(web);
    assert.match(apiBlock, /⛔ T-2/);
    assert.match(apiBlock, /needs_clarification/);
    assert.equal(/T-1/.test(apiBlock), false, 'web 的任務不該出現在 api 那段');
    assert.match(webBlock, /🔧 T-1/);
  });

  it('帶了今日成本就逐專案顯示', () => {
    const input = statusInput([task({ id: 'T-1', repo: 'acme/web', state: 'in_progress' })], []);
    input.costToday = [{ repo: 'acme/web', costUsd: 2.5, rounds: 4, sessions: 1 }];
    assert.match(formatStatus(input), /今天 \$2\.50/);
  });

  it('沒有任務的專案也列出來（分得出「很閒」和「沒載入」）', () => {
    const input = statusInput([], []);
    input.projects = [{ repo: 'acme/idle' }];
    const out = formatStatus(input);
    assert.match(out, /acme\/idle/);
    assert.match(out, /執行中 0/);
  });

  it('已經等滿靜置期的專案不列在倒數區', () => {
    const out = formatStatus(statusInput([task({ id: 'T-1', sourceUpdatedAt: NOW - 30 * MIN })], []));
    assert.equal(/等靜置期/.test(out), false);
  });

  it('受阻任務列出原因（人才知道能不能自己處理）', () => {
    const out = formatStatus(statusInput([
      task({ id: 'T-9', state: 'blocked', block: { reason: 'needs_clarification', detail: '要用哪個 API' } }),
    ], []));
    assert.match(out, /T-9/);
    assert.match(out, /needs_clarification/);
  });

  it('群組多於 4 個時收斂顯示，不把終端機洗版', () => {
    const groups = Array.from({ length: 7 }, (_, i) => group({ id: `g${i}`, state: 'ready' }));
    const out = formatStatus(statusInput([], groups));
    assert.match(out, /…\+3/);
  });

  it('quietWaits 依「最快輪到的」排序', () => {
    const input = statusInput([
      task({ id: 'A', repo: 'r/slow', sourceUpdatedAt: NOW - 1 * MIN }),
      task({ id: 'B', repo: 'r/fast', sourceUpdatedAt: NOW - 14 * MIN }),
    ], []);
    assert.deepEqual(quietWaits(input).map((w) => w.repo), ['r/fast', 'r/slow']);
  });
});

describe('CLI cost 報表', () => {
  it('沒有紀錄時說清楚原因，不要顯示一排 $0 讓人以為壞了', () => {
    const out = formatCost({
      total: cost(), today: cost(), last7d: cost(), topTasks: [], titleOf: () => undefined,
    });
    assert.match(out, /尚無任何 agent 執行紀錄/);
    assert.equal(/今天/.test(out), false);
  });

  it('三個時間區間 + token 量級 + 最貴的任務', () => {
    const out = formatCost({
      total: cost({ sessions: 5, costUsd: 12.5, rounds: 20, inputTokens: 2_400_000, outputTokens: 45_000 }),
      today: cost({ sessions: 2, costUsd: 3.25, rounds: 6 }),
      last7d: cost({ sessions: 4, costUsd: 10, rounds: 15 }),
      topTasks: [{ taskId: 'T-1', costUsd: 8, rounds: 12 }],
      titleOf: (id) => (id === 'T-1' ? '做一個按鈕' : undefined),
    });
    assert.match(out, /今天\s+\$3\.25\s+2 個 session／6 輪/);
    assert.match(out, /近 7 天\s+\$10\.00/);
    assert.match(out, /全部\s+\$12\.50\s+5 個 session／20 輪/);
    assert.match(out, /輸入 2\.40M／輸出 45\.0k/);
    assert.match(out, /\$8\.00\s+T-1\s+做一個按鈕\s+\(12 輪\)/);
  });

  it('查不到標題就只顯示 id（不要印 undefined）', () => {
    const out = formatCost({
      total: cost({ sessions: 1, costUsd: 1 }), today: cost(), last7d: cost(),
      topTasks: [{ taskId: 'T-X', costUsd: 1, rounds: 1 }], titleOf: () => undefined,
    });
    assert.match(out, /T-X/);
    assert.equal(/undefined/.test(out), false);
  });
});

describe('格式化細節', () => {
  /** $0.004 印成「$0.00」等於沒說——小額專案會以為系統沒在花錢。 */
  it('金額：小額保留有效位數', () => {
    assert.equal(money(0), '$0');
    assert.equal(money(0.004), '$0.0040');
    assert.equal(money(0.25), '$0.250');
    assert.equal(money(12.5), '$12.50');
  });

  it('token：上千後改用量級', () => {
    assert.equal(compact(999), '999');
    assert.equal(compact(45_000), '45.0k');
    assert.equal(compact(2_400_000), '2.40M');
  });

  /** 中文標籤用 padEnd 補齊會歪掉；欄位對不齊會讓人看錯行。 */
  it('補齊依顯示寬度（中日韓字元算 2 欄）', () => {
    assert.equal(displayWidth('執行中'), 6);
    assert.equal(displayWidth('token'), 5);
    assert.equal(displayWidth('近 7 天'), 7);
    assert.equal(displayWidth(padDisplay('執行中', 10)), 10);
    assert.equal(displayWidth(padDisplay('token', 10)), 10);
    assert.equal(padDisplay('超過寬度就不截斷', 3), '超過寬度就不截斷');
  });

  it('今天的起點用本地時區（人問的是自己的今天）', () => {
    const d = new Date(startOfToday(NOW));
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    assert.ok(startOfToday(NOW) <= NOW);
  });
});

describe('cost 報表 — 花費上限', () => {
  const base = {
    total: cost({ sessions: 3, costUsd: 12, rounds: 9 }),
    today: cost({ sessions: 1, costUsd: 8, rounds: 3 }),
    last7d: cost({ sessions: 3, costUsd: 12, rounds: 9 }),
    topTasks: [],
    titleOf: () => undefined,
  };

  it('顯示各週期的用量與百分比', () => {
    const out = formatCost({ ...base, budget: [{ label: '今日', spentUsd: 8, limitUsd: 10, ratio: 0.8 }] });
    assert.match(out, /上限/);
    assert.match(out, /今日\s+\$8\.00 \/ \$10\.00\s+80%/);
  });

  /** 「已達上限」必須一眼看出來，否則人會以為只是花得比較多。 */
  it('達到上限要明說已暫停派新工作', () => {
    const out = formatCost({ ...base, budget: [{ label: '今日', spentUsd: 11, limitUsd: 10, ratio: 1.1 }] });
    assert.match(out, /已達上限，暫停派新工作/);
  });

  it('接近上限要標出來', () => {
    const out = formatCost({ ...base, budget: [{ label: '本月', spentUsd: 85, limitUsd: 100, ratio: 0.85 }] });
    assert.match(out, /接近上限/);
  });

  it('沒設上限就不佔版面', () => {
    assert.equal(/上限/.test(formatCost({ ...base, budget: [] })), false);
    assert.equal(/上限/.test(formatCost(base)), false);
  });
});
