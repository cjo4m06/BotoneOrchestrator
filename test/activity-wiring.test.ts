import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { Planner } from '../src/core/planner.js';
import { Orchestrator, TICK_FAILED_EVENT } from '../src/core/orchestrator.js';
import { ConsoleServer } from '../src/console/server.js';
import { ConfigStore } from '../src/config/store.js';
import { Ledger } from '../src/store/ledger.js';
import { join } from 'node:path';
import type { ActivitySink } from '../src/observability/activity.js';
import { makeTask, createSilentLogger, createTmpLedger, createTmpDir } from './helpers/index.js';

/**
 * **接線**測試——功能本身在 activity.test.ts 測過了。
 *
 * 這裡問的是不同的問題：那些會跑很久的地方，到底有沒有真的登記進去。
 *
 * 這個系統一再出現的失效樣態是「能力有、接線沒接，症狀只有一行 WARN」。
 * 「現在在做什麼」如果沒接上，畫面一樣是靜止的，而且**看起來完全正常**——
 * 使用者只會再一次以為平台掛了。所以每一條接線都要有一個會壞掉的測試守著。
 */

function recordingSink(): ActivitySink & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    startActivity: (a) => void log.push(`start:${a.kind}:${a.title}`),
    touchActivity: (id, d) => void log.push(`touch:${d ?? ''}`),
    endActivity: () => void log.push('end'),
  };
}

test('規劃期間有登記——那是最久的一段（實測單次 6 分鐘）', async () => {
  const sink = recordingSink();
  let sawDuringCall: string[] = [];

  const planner = new Planner({
    log: createSilentLogger(),
    activity: sink,
    resolveRepoPath: () => '/repo',
    planAgent: {
      async plan(tasks, _repoPath, _inFlight, onProgress) {
        sawDuringCall = [...sink.log]; // agent 還在跑的當下，登記必須已經寫進去了
        onProgress?.('第 2/2 次嘗試（上一次回應不合格）');
        return { groups: [{ id: 'A', taskIds: tasks.map((t) => t.id), files: [], why: '' }], stages: [['A']] };
      },
    },
  });

  await planner.plan([makeTask({ id: 'T-1', repo: 'acme/web' }), makeTask({ id: 'T-2', repo: 'acme/web' })]);

  assert.ok(
    sawDuringCall.some((l) => l.startsWith('start:plan:')),
    '規劃 agent 跑起來之前就要登記，否則那幾分鐘畫面上還是什麼都沒有',
  );
  assert.ok(sawDuringCall.some((l) => l.includes('2 個任務')), '要講清楚在規劃幾個任務');
  assert.ok(sink.log.includes('touch:第 2/2 次嘗試（上一次回應不合格）'), '重問也要看得到——一次嘗試就是好幾分鐘');
  assert.ok(sink.log.includes('end'), '規劃完要收掉，不能留一件永遠做不完的假工作');
});

test('規劃擲錯也要收掉登記', async () => {
  const sink = recordingSink();
  const planner = new Planner({
    log: createSilentLogger(),
    activity: sink,
    resolveRepoPath: () => '/repo',
    planAgent: { plan: () => Promise.reject(new Error('規劃 agent 掛了')) },
  });

  await assert.rejects(planner.plan([makeTask({ id: 'T-1', repo: 'acme/web' })]));
  assert.ok(sink.log.includes('end'), '失敗之後畫面不該永遠停在「規劃中」');
});

/**
 * tick 的每一段都要看得到。使用者原話：「我以為整個專案都在停擺」——
 * 那正是輪詢／看審查／合併這幾段沒有任何畫面表現的時候。
 */
test('tick 的每一段都會登記進 ledger', async (t) => {
  const h = createTmpLedger();
  t.after(() => h.cleanup());

  // 每一段執行到一半時，看得到哪些登記
  const seen = new Map<string, string[]>();
  const snap = (at: string) => seen.set(at, h.ledger.listActivities().map((a) => a.kind));

  const orch = new Orchestrator({
    poller: { async pollOnce() { snap('poll'); return []; } } as never,
    planner: new Planner(),
    dispatcher: { dispatch() {} } as never,
    reviewWatcher: { async poll() { snap('review'); return []; } } as never,
    ledger: h.ledger,
    log: createSilentLogger(),
  } as never, 60);

  await orch.tick();

  assert.deepEqual(seen.get('poll'), ['poll'], '輪詢期間畫面上要看得到「輪詢中」');
  assert.deepEqual(seen.get('review'), ['review_poll'], '看審查期間也要');
  assert.deepEqual(h.ledger.listActivities(), [], 'tick 結束要收乾淨，不能留下假的進行中');
});

/** 標準的 UI 需求：畫面要有東西可讀，而且要分得出「還在跑」與「daemon 死了」。 */
test('控制台 /api/state 帶得出現在在做什麼，並標示失聯', async (t) => {
  const dir = createTmpDir('botone-act-');
  t.after(() => dir.cleanup());
  const dbPath = join(dir.path, 'daemon.db');
  const store = new ConfigStore(dbPath);
  const ledger = new Ledger(dbPath, createSilentLogger());
  ledger.init();
  const server = new ConsoleServer({
    store, ledger, log: createSilentLogger(), port: 0,
    purgeProject: async () => ({ tasks: 0, groups: 0, worktrees: 0, branches: 0, claimed: [] }),
  });
  await server.start();
  t.after(async () => { await server.stop(); ledger.close(); store.close(); });

  ledger.startActivity({ id: 'plan:acme/web', kind: 'plan', repo: 'acme/web', title: '規劃 14 個任務要怎麼分群' });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/state`);
  const body = await res.json() as { activities: { kind: string; title: string; stale: boolean }[] };

  assert.equal(body.activities.length, 1);
  assert.equal(body.activities[0]?.title, '規劃 14 個任務要怎麼分群');
  assert.equal(body.activities[0]?.stale, false, '剛開始的工作不能被標成失聯');
});

/**
 * 使用者原話：「他分群會一直失敗」——而畫面上完全看不出來。
 * 只寫 log 的話，「什麼都沒在動」與「每一輪都在同一個地方炸掉」長得一模一樣。
 */
test('tick 整輪失敗會留在 ledger，控制台看得到', async (t) => {
  const h = createTmpLedger();
  t.after(() => h.cleanup());

  const orch = new Orchestrator({
    poller: { pollOnce: () => Promise.reject(new Error('規劃 agent 無法產出可用的計畫')) } as never,
    planner: new Planner(),
    dispatcher: { dispatch() {} } as never,
    ledger: h.ledger,
    log: createSilentLogger(),
  } as never, 0.01);

  // run() 一輪就停：tick 失敗不能讓主迴圈死掉，而且要留下紀錄
  const ac = new AbortController();
  const p = orch.run(ac.signal);
  await new Promise((r) => setTimeout(r, 60));
  ac.abort();
  await p;

  const e = h.ledger.latestEvent('system', null, TICK_FAILED_EVENT);
  assert.ok(e, '整輪失敗只留在 log 的話，控制台永遠看不出來出過事');
  assert.match(e.detail ?? '', /規劃 agent 無法產出可用的計畫/, '要留下真正的原因，不是「發生錯誤」');
});

/**
 * **每一條會跑 agent 的路徑都要記「現在在做什麼」。**
 *
 * 實跑（2026-08-05 21:36）：Merge Guard 把群組打回來之後，group-runner 走的是
 * 「依審查意見重做」那條迴圈——它直接呼叫 agent.iterate，**沒有包 withActivity**。
 * 於是那十幾分鐘裡控制台顯示「閒著（沒有任何工作在進行）」，而 agent 正在寫程式，
 * 使用者因此以為系統卡住了。
 *
 * 一般任務那條有包、重做那條沒包——又是「能力有、一條路徑漏接」。
 */
test('重做迴圈有包 withActivity（不然重做期間畫面是「閒著」）', () => {
  const src = readFileSync('src/core/group-runner.ts', 'utf8');
  const i = src.indexOf("'依審查意見重做'");
  assert.ok(i >= 0, '找不到重做迴圈');
  assert.match(
    src.slice(i, i + 700),
    /withActivity\(/,
    '重做那一輪可以跑十幾分鐘不留任何 log——沒有 activity 就等於系統看起來死了',
  );
});

test('活動標題帶得出是第幾輪（人要看得出它在動，不是卡著）', () => {
  const src = readFileSync('src/core/group-runner.ts', 'utf8');
  const i = src.indexOf("'依審查意見重做'");
  assert.match(src.slice(i, i + 700), /第 \$\{round\}/);
});

/**
 * ── 合併把關那十幾分鐘先前完全看不見 ──
 *
 * 開 PR 前那次守衛（group-runner，包在 withRepoLock 裡）根本沒包 withActivity；
 * 核准後那次（orchestrator）只有一個沒有 refId、沒有階段的 `tick:merge`。
 * 而這段可以跑十幾分鐘：等同 repo 的鎖、建拋棄式驗收樹、npm ci、build、test、
 * 歸咎實驗、語意飄移判斷、風險判斷、開 PR。期間任務狀態不變、群組狀態不變、
 * 事件表沒有新列 ⇒ 畫面上就是「閒著」。
 */
test('守衛本身會回報跑到哪一段（沒有它，包了 withActivity 也只是一句固定的字）', async () => {
  const { MergeGuard } = await import('../src/pr/merge-guard.js');
  const stages: string[] = [];
  const guard = new MergeGuard(
    { check: async () => ({ green: true, checks: [] }) } as never,
    createSilentLogger(),
    {
      onStage: (d) => void stages.push(d),
      // 併不起來就停在第二段——重點是「前兩段有回報」，不是判決內容
      git: async () => ({ exitCode: 1, stdout: '', stderr: 'no remote' }),
    },
  );

  await guard.attempt({ repoPath: '/repo', branch: 'orch/x', base: 'main', verifierConfig: {} as never });

  assert.ok(stages.some((s) => s.includes('取最新')), '取 base 也要算——網路慢的時候它自己就是幾分鐘');
  assert.ok(stages.some((s) => s.includes('驗收樹')), '建樹＋npm ci 是最久的一段');
});

test('開 PR 前那次守衛有包 withActivity，而且在搶鎖之前就開始', () => {
  const src = readFileSync('src/core/group-runner.ts', 'utf8');
  const act = src.indexOf("id: `merge:${group.id}`");
  assert.ok(act > 0, '開 PR 前那次守衛沒有登記「現在在做什麼」');
  // **順序很重要**：同 repo 的守衛是序列的，排隊本身就是花掉的時間，
  // 而排隊中的群在畫面上原本完全看不見（不在「開發中」，也還沒到「等審查」）。
  assert.ok(
    src.indexOf('withActivity(', act - 400) < src.indexOf('withRepoLock(proj.repoPath', act),
    'withActivity 要包在 withRepoLock 外面，否則排隊那段仍然是空白',
  );
  assert.match(src.slice(act, act + 4000), /onStage: update/, '守衛內部的階段要接回這一列');
});

test('核准後那次守衛也有自己的活動列（tick:merge 沒有 refId、沒有階段）', () => {
  const src = readFileSync('src/core/orchestrator.ts', 'utf8');
  const i = src.indexOf('const verdict = await withActivity(');
  assert.ok(i > 0, '核准後那次守衛沒有登記');
  const block = src.slice(i, i + 900);
  assert.match(block, /refId: group\.id/, '沒有 refId 的話畫面只知道「有人在合併」，不知道是哪一群');
  assert.match(block, /onStage: update/);
});
