import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProgressMonitor } from '../src/worker/progress.js';
import { createTmpLedger, makeGateReport } from './helpers/index.js';

function setup(t: { after(fn: () => void): void }, rounds: number) {
  const h = createTmpLedger();
  t.after(() => h.cleanup());
  return { ledger: h.ledger, monitor: new ProgressMonitor(h.ledger, rounds) };
}

const red = (signature: string) => makeGateReport({ green: false, signature, checks: [{ name: 'test', ok: false, detail: '3 failed' }] });
const green = (signature: string) => makeGateReport({ green: true, signature, checks: [{ name: 'test', ok: true, detail: 'ok' }] });

test('連續 N 輪同簽章且未綠 → 判定卡牆', (t) => {
  const { monitor } = setup(t, 3);
  assert.deepEqual(monitor.record('T-1', 1, red('sig')), { stalled: false, rounds: 1 });
  assert.deepEqual(monitor.record('T-1', 2, red('sig')), { stalled: false, rounds: 2 });
  assert.deepEqual(monitor.record('T-1', 3, red('sig')), { stalled: true, rounds: 3 });
});

test('輪數不足 N 時不判卡牆（避免第一輪就誤報）', (t) => {
  const { monitor } = setup(t, 5);
  for (let r = 1; r <= 4; r++) {
    const v = monitor.record('T-1', r, red('sig'));
    assert.equal(v.stalled, false, `第 ${r} 輪不該判卡牆`);
    assert.equal(v.rounds, r);
  }
  assert.equal(monitor.record('T-1', 5, red('sig')).stalled, true);
});

test('簽章有變化就不算卡牆（慢但真的在前進）', (t) => {
  const { monitor } = setup(t, 3);
  monitor.record('T-1', 1, red('a'));
  monitor.record('T-1', 2, red('a'));
  assert.equal(monitor.record('T-1', 3, red('b')).stalled, false);
});

test('綠燈豁免：簽章連續相同但已綠燈 → 不判卡牆', (t) => {
  const { monitor } = setup(t, 3);
  monitor.record('T-1', 1, red('sig'));
  monitor.record('T-1', 2, red('sig'));
  const v = monitor.record('T-1', 3, green('sig'));
  assert.equal(v.stalled, false, '綠燈代表任務已達標，不應同時被標成卡牆');
  assert.equal(v.rounds, 3);
});

test('只看最近 N 輪：早期不同簽章不影響後續卡牆判定', (t) => {
  const { monitor } = setup(t, 3);
  monitor.record('T-1', 1, red('a'));
  monitor.record('T-1', 2, red('a'));
  monitor.record('T-1', 3, red('b'));
  assert.equal(monitor.record('T-1', 4, red('b')).stalled, false);
  assert.equal(monitor.record('T-1', 5, red('b')).stalled, true, '最近三輪都是 b → 卡牆');
});

test('先前有綠燈紀錄不影響判定，只看當輪 green 旗標', (t) => {
  const { monitor } = setup(t, 3);
  monitor.record('T-1', 1, green('sig'));
  monitor.record('T-1', 2, green('sig'));
  assert.equal(monitor.record('T-1', 3, red('sig')).stalled, true);
});

test('rounds=1 時，單輪未綠即判卡牆（極端設定仍需自洽）', (t) => {
  const { monitor } = setup(t, 1);
  assert.deepEqual(monitor.record('T-1', 1, red('sig')), { stalled: true, rounds: 1 });
  assert.equal(monitor.record('T-1', 2, green('sig')).stalled, false);
});

test('不同任務的簽章互不干擾', (t) => {
  const { monitor } = setup(t, 2);
  monitor.record('T-1', 1, red('sig'));
  monitor.record('T-2', 1, red('sig'));
  assert.equal(monitor.record('T-2', 2, red('other')).stalled, false);
  assert.equal(monitor.record('T-1', 2, red('sig')).stalled, true);
});

test('每輪都會落地到 ledger（含 green 與 diffHash），供事後稽核', (t) => {
  const { ledger, monitor } = setup(t, 3);
  monitor.record('T-1', 1, red('a'), 'diff-1');
  monitor.record('T-1', 2, green('b'));

  assert.deepEqual(ledger.recentSignatures('T-1', 5), ['b', 'a'], '簽章需依 round 由新到舊落地');
});

// ── 跨重跑（Worker.runTask 每次都從 round=1 重新計數） ──

test('重跑時只看本次執行的簽章，不會被上一輪執行的舊簽章誤判卡牆', (t) => {
  const { monitor } = setup(t, 3);
  // 第一次執行：連三輪同簽章 → 卡牆
  monitor.record('T-1', 1, red('old'));
  monitor.record('T-1', 2, red('old'));
  assert.equal(monitor.record('T-1', 3, red('old')).stalled, true);

  // 第二次執行（澄清後續跑／審查後重跑）：round 從 1 重新開始，簽章已經不同
  assert.deepEqual(monitor.record('T-1', 1, red('new')), { stalled: false, rounds: 1 }, '本次執行才第一輪，不可判卡牆');
  assert.equal(monitor.record('T-1', 2, red('new')).stalled, false);
  assert.equal(monitor.record('T-1', 3, red('new')).stalled, true, '本次執行連三輪同簽章才算卡牆');
});

test('重跑後真的卡牆一樣抓得到（即使上一次執行的簽章都不同）', (t) => {
  const { monitor } = setup(t, 3);
  monitor.record('T-1', 1, red('a'));
  monitor.record('T-1', 2, red('b'));
  monitor.record('T-1', 3, red('c'));

  monitor.record('T-1', 1, red('x'));
  monitor.record('T-1', 2, red('x'));
  assert.equal(monitor.record('T-1', 3, red('x')).stalled, true);
});

test('落地的 round 單調遞增，重跑不覆蓋也不亂序（稽核可讀）', (t) => {
  const { ledger, monitor } = setup(t, 3);
  monitor.record('T-1', 1, red('a1'));
  monitor.record('T-1', 2, red('a2'));
  monitor.record('T-1', 1, red('b1')); // 重跑
  monitor.record('T-1', 2, red('b2'));

  assert.deepEqual(
    ledger.recentSignatures('T-1', 10),
    ['b2', 'b1', 'a2', 'a1'],
    'ORDER BY round DESC 必須剛好等於「由新到舊」，重跑的簽章不可排在舊簽章後面',
  );
});

test('ledger 提供 maxIterationRound 時，序號接續既有紀錄（跨重啟不重號）', () => {
  const rows: { round: number; signature: string }[] = [];
  const fake = {
    recordIteration(_taskId: string, round: number, signature: string): void {
      rows.push({ round, signature });
    },
    maxIterationRound(): number {
      return 7; // 假設上次程序已寫到第 7 輪
    },
  };
  const monitor = new ProgressMonitor(fake, 2);
  monitor.record('T-1', 1, red('s1'));
  monitor.record('T-1', 2, red('s2'));

  assert.deepEqual(rows, [{ round: 8, signature: 's1' }, { round: 9, signature: 's2' }]);
});
