import assert from 'node:assert/strict';
import { execa } from 'execa';
import test from 'node:test';

import { Verifier } from '../src/worker/verifier.js';
import { createSilentLogger } from './helpers/index.js';

/**
 * ── 這一組刻意**真的跑行程**，不只斷言物件內容 ──
 *
 * 實跑（2026-08-19，PR #150）：合併把關的 `npm test` 卡在單一測試檔
 * **104 分鐘、只用掉 1.5 秒 CPU、105 分鐘零輸出**，而畫面上心跳照跳、
 * 群組永遠停在 merge_guard。原因有兩層，兩層都只有真的起行程才驗得出來：
 *
 *  1. 殺的是 `sh`，但 `npm test` 底下的行程被 init 收養、**繼承 stdout/stderr 管線** ⇒
 *     execa 要等「行程結束 **且** 串流關閉」，串流永遠不 EOF ⇒ promise 永遠不 settle。
 *  2. 總時長分不出「卡死」與「本來就要跑這麼久」。
 *
 * 只斷言 timeoutMs 傳對了完全抓不到這兩件事——那正是先前測試全綠而實跑卡死的原因。
 */

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * 硬上限。**這個 bug 復發時的症狀是「永遠不回來」**，而永遠不回來的測試會掛住整個
 * 測試回合、不是變紅——那樣就沒有守門的作用了。所以一定要 race。
 */
function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      const t = setTimeout(() => rej(new Error(`${what}：超過 ${ms}ms 還沒回來（＝promise 永遠不 settle 的那個 bug）`)), ms);
      t.unref?.();
    }),
  ]);
}

test('孫行程握著管線也要能結束——不然整條路凍住（不是紅燈，是永遠不回來）', async () => {
  // sh 生一個 sleep 當背景孫行程，它繼承管線後 sh 自己結束。
  // 沒有整組砍的話，execa 會等那個 sleep 把管線放掉——3000 秒。
  const v = new Verifier(createSilentLogger(), {});
  const started = Date.now();
  const r = await within(45_000, '孫行程握著管線', v.check({
    cwd: process.cwd(),
    config: { test: 'sh -c "sleep 3000 &" ; echo started ; sleep 3000', idleTimeoutMs: 1500, timeoutMs: 0 },
  }));
  const took = Date.now() - started;

  assert.equal(r.green, false, '被砍掉的關卡不可以算通過');
  assert.ok(took < 30_000, `應該在閒置上限後就回來，實際等了 ${took}ms（永遠不回來就是這個 bug）`);
  const detail = r.checks.map((c) => c.detail).join('\n');
  assert.match(detail, /卡住/, '要講「卡住」，不是含糊的「逾時」');
  assert.match(detail, /沒有任何輸出/);
  assert.doesNotMatch(detail, /可調 projects\.yaml/, '卡死時叫人調長時間上限是錯的指示');
});

test('整棵行程樹都要被砍掉——不能只殺最外層的 shell', async () => {
  const marker = `orch-hang-probe-${process.pid}`;
  const v = new Verifier(createSilentLogger(), {});
  await within(45_000, '整棵樹要被砍', v.check({
    cwd: process.cwd(),
    // 孫行程好認：用一個帶標記的 sleep
    config: { test: `sh -c "exec -a ${marker} sleep 3000" & sleep 3000`, idleTimeoutMs: 1200, timeoutMs: 0 },
  }));

  // 給收屍一點時間
  await new Promise((r) => setTimeout(r, 6000));
  const { stdout } = await execa('pgrep', ['-f', marker], { reject: false });
  const left = stdout.split('\n').map((x) => x.trim()).filter(Boolean).filter((p) => alive(Number(p)));
  // 掃到殘留就順手清掉，不要污染後面的測試與這台機器
  for (const p of left) { try { process.kill(Number(p), 'SIGKILL'); } catch { /* 已死 */ } }
  assert.deepEqual(left, [], `孫行程沒被砍乾淨（機器上撈到 6 個 8～15 天的孤兒就是這樣來的）`);
});

test('一直有輸出的慢指令不可以被誤殺——這是「卡死 vs 慢」的分界', async () => {
  const v = new Verifier(createSilentLogger(), {});
  // 每 0.3 秒吐一次，總共約 3 秒；閒置上限 1.5 秒。有進展 ⇒ 計時器一直被重置 ⇒ 不該被砍。
  const r = await v.check({
    cwd: process.cwd(),
    config: { test: 'i=0; while [ $i -lt 10 ]; do echo tick $i; sleep 0.3; i=$((i+1)); done', idleTimeoutMs: 1500, timeoutMs: 0 },
  });
  assert.equal(r.green, true, '有持續輸出就是在做事，不可以當成卡死');
});

test('真的跑太久（但有輸出）→ 總時長上限接手，訊息要跟「卡死」分開講', async () => {
  const v = new Verifier(createSilentLogger(), {});
  const r = await v.check({
    cwd: process.cwd(),
    // 一直有輸出（閒置判定不會觸發），但總時長很短 ⇒ 由 wall 上限砍
    config: { test: 'while true; do echo tick; sleep 0.2; done', idleTimeoutMs: 60_000, timeoutMs: 2000 },
  });
  assert.equal(r.green, false);
  const detail = r.checks.map((c) => c.detail).join('\n');
  assert.match(detail, /總時長/, '這種才是「跑太久」，要跟卡死分開');
  assert.doesNotMatch(detail, /沒有任何輸出/, '有輸出卻說它沒輸出，會讓人查錯方向');
});
