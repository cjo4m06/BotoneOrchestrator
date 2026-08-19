import assert from 'node:assert/strict';
import { execa } from 'execa';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Verifier, type StallReport } from '../src/worker/verifier.js';
import { createSilentLogger } from './helpers/index.js';

/**
 * ── 這一組刻意**真的跑行程** ──
 *
 * 實跑（2026-08-19，PR #150）：合併把關的 `npm test` 卡在單一測試檔
 * **104 分鐘、只用掉 1.5 秒 CPU、105 分鐘零輸出**，而畫面上心跳照跳、
 * 群組永遠停在 merge_guard。只斷言「timeoutMs 有傳對」完全抓不到——
 * 那正是先前測試全綠而實跑凍住的原因。
 *
 * 兩件事要分清楚：
 *  1. **要停的時候必須停得掉**（殺整棵 process group）。孫行程握著 stdout/stderr
 *     的話 execa 會等串流 EOF，promise 永遠不 settle ⇒ 不是紅燈，是整條路凍住。
 *  2. **不猜「該不該停」**。安靜太久只回報事實，不動手：從外面看「等一個合法的東西」
 *     與「等一個永遠不會來的東西」分不出來（agent 的腳本可能每 5 分鐘輪詢一次 API，
 *     輸出 0、CPU 差值 0，但它在正常工作）。
 */

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** 硬上限。這個 bug 復發時的症狀是「永遠不回來」，而掛住的測試不會變紅、只會拖死整回合。 */
function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      const t = setTimeout(() => rej(new Error(`${what}：超過 ${ms}ms 還沒回來（＝promise 永遠不 settle 的那個 bug）`)), ms);
      t.unref?.();
    }),
  ]);
}

test('安靜太久 → 只回報事實，不終止（合法的等待不可以被砍掉）', async () => {
  const stalls: StallReport[] = [];
  const v = new Verifier(createSilentLogger(), { onStall: (i) => void stalls.push(i) });

  // 先吐一行，然後安靜 4 秒才結束。閒置門檻 1 秒 ⇒ 會回報數次，但指令要能自己跑完。
  const r = await within(30_000, '只回報不終止', v.check({
    cwd: process.cwd(),
    config: { test: 'echo starting; sleep 4; echo done', idleTimeoutMs: 1000, timeoutMs: 0 },
  }));

  assert.equal(r.green, true, '安靜不等於壞了——它自己跑完就是綠的，不可以被中途砍掉');
  assert.ok(stalls.length > 0, '安靜超過門檻就要講出來，否則又是靜默凍住');
  const s = stalls[0]!;
  assert.equal(s.check, 'test');
  assert.match(s.command, /sleep 4/);
  assert.ok(s.quietMs >= 900, `要報出「多久沒有輸出」，實際 ${s.quietMs}`);
  assert.ok(s.bytes > 0, '要報出到目前為止收到多少輸出（0 與非 0 是不同的線索）');
});

test('從頭到尾零輸出也照樣只回報（bytes=0 是最強的線索，但仍不是結論）', async () => {
  const stalls: StallReport[] = [];
  const v = new Verifier(createSilentLogger(), { onStall: (i) => void stalls.push(i) });

  const r = await within(30_000, '零輸出只回報', v.check({
    cwd: process.cwd(),
    config: { test: 'sleep 3', idleTimeoutMs: 800, timeoutMs: 0 },
  }));

  assert.equal(r.green, true);
  assert.ok(stalls.length > 0);
  assert.equal(stalls[0]!.bytes, 0, '一個字都沒吐過');
});

test('總時長上限（使用者明確設的值）→ 砍掉整棵行程樹', async () => {
  const marker = `orch-hang-probe-${process.pid}`;
  const v = new Verifier(createSilentLogger(), {});

  // 孫行程握著管線：沒有整組砍的話 execa 會等它放掉 ⇒ 永遠不 settle
  const r = await within(45_000, '總時長要砍得掉整棵樹', v.check({
    cwd: process.cwd(),
    config: { test: `sh -c "exec -a ${marker} sleep 3000" & sleep 3000`, idleTimeoutMs: 0, timeoutMs: 2000 },
  }));
  assert.equal(r.green, false, '被上限終止的關卡不可以算通過');

  await new Promise((res) => setTimeout(res, 6000)); // 給收屍時間
  const { stdout } = await execa('pgrep', ['-f', marker], { reject: false });
  const left = stdout.split('\n').map((x) => x.trim()).filter(Boolean).filter((p) => alive(Number(p)));
  for (const p of left) { try { process.kill(Number(p), 'SIGKILL'); } catch { /* 已死 */ } }
  assert.deepEqual(left, [], '孫行程沒被砍乾淨（機器上撈到 6 個 8～15 天的孤兒就是這樣來的）');
});

test('總時長的訊息不可以斷言「卡住」——它只知道超過了設定的上限', async () => {
  const v = new Verifier(createSilentLogger(), {});
  const r = await within(30_000, '訊息要誠實', v.check({
    cwd: process.cwd(),
    config: { test: 'sleep 3000', idleTimeoutMs: 0, timeoutMs: 1500 },
  }));
  const detail = r.checks.map((c) => c.detail).join('\n');
  assert.match(detail, /總時長超過/);
  assert.match(detail, /這不代表它壞了/, '講成「卡住」會讓 agent 去改一個沒壞的東西');
  assert.doesNotMatch(detail, /^卡住/m);
});

/**
 * ── 接線：能力有、沒人接 ＝ 等於沒有 ──
 *
 * onStall 是可選的，而這個 repo 反覆踩到的正是「可選項某一邊忘了傳」。
 * 兩條路都要接：任務關卡（Worker 的 onPhase）與合併把關（onStage）。
 * 沒接的症狀就是先前那個——畫面顯示「跑驗收關卡」而心跳照跳，看不出它一小時沒動。
 */
test('兩個呼叫端都把安靜回報接到人在看的那一列', () => {
  const strip = (f: string): string =>
    readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  const w = strip('src/worker/worker.ts');
  assert.match(w, /onStall: \(i\) => input\.onPhase\?\./, '任務關卡沒接 → 寫程式那條路看不見');
  assert.match(w, /沒有輸出/, '要講出「多久沒有輸出」，不然人還是分不出死活');

  const g = strip('src/pr/merge-guard.ts');
  assert.match(g, /onStall: \(i\) => this\.opts\.onStage\?\./, '合併把關沒接 → 就是 PR #150 那次');
  assert.match(g, /沒有輸出/);
});

test('一直有輸出的慢指令不會被回報成安靜', async () => {
  const stalls: StallReport[] = [];
  const v = new Verifier(createSilentLogger(), { onStall: (i) => void stalls.push(i) });
  const r = await within(30_000, '有輸出不算安靜', v.check({
    cwd: process.cwd(),
    config: { test: 'i=0; while [ $i -lt 12 ]; do echo tick $i; sleep 0.25; i=$((i+1)); done', idleTimeoutMs: 1500, timeoutMs: 0 },
  }));
  assert.equal(r.green, true);
  assert.deepEqual(stalls, [], '每 0.25 秒吐一次還被說安靜，就是計時器沒被重置');
});
