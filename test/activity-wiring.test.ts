import test from 'node:test';
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
