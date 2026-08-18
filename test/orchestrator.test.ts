import { releaseDeps } from '../src/core/deps-release.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { GROUP_RERUN_REQUESTED_EVENT } from '../src/core/group-runner.js';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import {
  Orchestrator,
  type MergeApprovalGateway,
  type MergePipelineDeps,
  type MergeProject,
  type OrchestratorDeps,
  type ReviewSignal,
  type ReviewWatcherLike,
} from '../src/core/orchestrator.js';
import { Dispatcher } from '../src/core/dispatcher.js';
import { collectPending } from '../src/core/pending.js';
import { Planner , type PlanAgentLike } from '../src/core/planner.js';
import { ReviewFeedbackStore } from '../src/pr/review-watcher.js';
import type { Group, GroupState, LifecycleEvent, MergeVerdict, PlanResult, Task, TaskDetail } from '../src/types.js';
import { Poller } from '../src/core/poller.js';
import type { BudgetVerdict } from '../src/core/budget.js';
import { createTmpLedger, createSilentLogger, createRecordingLogger, type TmpLedger } from './helpers/index.js';

interface FakePoller {
  pollOnce(): Promise<Task[]>;
  calls: number;
}

/**
 * 假 Poller：模擬真實行為（把任務落地 ledger 並回傳「新任務」）。
 * Poller 有私有欄位，結構型別不相容，故以 unknown 轉型注入。
 */
function fakePoller(tmp: TmpLedger, batches: { id: string; repo?: string; docRefs?: string[]; deps?: string[]; sourceUpdatedAt?: number }[][]): FakePoller {
  const p: FakePoller = {
    calls: 0,
    async pollOnce() {
      const batch = batches[p.calls] ?? [];
      p.calls += 1;
      const fresh: Task[] = [];
      for (const b of batch) {
        const res = tmp.ledger.upsertDiscoveredTask({
          id: b.id,
          payloadHash: `h-${b.id}`,
          repo: b.repo ?? 'acme/web',
          category: 'dev',
          title: `任務 ${b.id}`,
          description: '描述',
          dependencies: b.deps ?? [],
          docRefs: b.docRefs ?? [],
          ...(b.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: b.sourceUpdatedAt } : {}),
        });
        if (res === 'inserted') {
          const t = tmp.ledger.getTask(b.id);
          if (t) fresh.push(t);
        }
      }
      return fresh;
    },
  };
  return p;
}

const asPoller = (p: FakePoller): Poller => p as unknown as Poller;

/** 等待條件成立（用於觀察背景跑的 run() 進到某個階段）。 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等待條件逾時');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * 跑到「這一輪該發生的事都發生了」為止。
 *
 * 規劃改成背景執行之後（見 orchestrator 的 startPlanning），`tick()` 回來時
 * 規劃通常還沒跑完——建群發生在背景，派工要等**下一輪** tick。
 * 這是刻意的取捨：規劃一次十幾分鐘，await 它就等於這段時間內
 * 看審查、合併、重派全部停擺。多一輪（預設 30 秒）換掉十幾分鐘的全面停擺。
 */
async function tickAndPlan(o: { tick(s?: AbortSignal): Promise<void>; settlePlanning(): Promise<void> }): Promise<void> {
  await o.tick();
  await o.settlePlanning();
}

/**
 * 跑到「新任務已經被規劃、建群、而且派出去了」為止。
 *
 * 需要兩輪：第一輪發動背景規劃（不等它），規劃完成時本輪的派工步驟早就過去了，
 * 所以要下一輪才派得到。這一輪的延遲換掉的是「規劃期間十幾分鐘全面停擺」。
 */
async function tickUntilDispatched(o: { tick(s?: AbortSignal): Promise<void>; settlePlanning(): Promise<void> }): Promise<void> {
  await tickAndPlan(o);
  await o.tick();
}

/**
 * 假的規劃 agent：**依共用的規格檔分群**。
 *
 * 這條規則以前寫在 planner 裡（關鍵字相似度 ＋ 共用 docRef 的啟發式），第 15 片刪掉了——
 * 分群現在完全是 agent 的判斷。這裡把它做成測試替身，是因為這一批測試驗的是
 * **tick 的主流程**（poll → plan → 建群 → 派工），不是分群本身的品質；
 * 需要的只是一個「行為可預期」的規劃者。
 */
function fakePlanAgent(): PlanAgentLike {
  return {
    async plan(tasks) {
      const byDoc = new Map<string, string[]>();
      for (const t of tasks) {
        const key = (t.docRefs[0] ?? t.id).split('#')[0]!;
        byDoc.set(key, [...(byDoc.get(key) ?? []), t.id]);
      }
      const groups = [...byDoc.entries()].map(([file, taskIds], i) => ({
        id: `g${i + 1}`, taskIds, files: [file], why: `共用 ${file}`,
      }));
      return { groups, stages: [groups.map((g) => g.id)] };
    },
  };
}

describe('Orchestrator — 主控迴圈', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp = createTmpLedger();
  });
  afterEach(() => tmp.cleanup());

  function build(poller: FakePoller, over: Partial<OrchestratorDeps> = {}) {
    const dispatched: Group[] = [];
    const dispatcher =
      (over.dispatcher as Dispatcher | undefined) ??
      new Dispatcher(
        4,
        async (g) => {
          dispatched.push(g);
        },
        createSilentLogger(),
      );
    const deps: OrchestratorDeps = {
      poller: asPoller(poller),
      planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
      dispatcher,
      ledger: tmp.ledger,
      log: createSilentLogger(),
      // 這批測試驗的是 tick 的主流程，不是靜置期；關掉才不會被預設的 15 分鐘擋住
      // （靜置期本身另有專門的測試檔 quiet-period.test.ts / 本檔末段）。
      quietMinutesOf: () => 0,
      ...over,
    };
    return { orch: new Orchestrator(deps, 0.01), dispatched, deps };
  }

  it('一輪 tick：poll → plan → 建群(ready) → 任務轉 queued → dispatch', async () => {
    // 兩個任務共用同一份規格檔 → planner 會歸為一群
    const poller = fakePoller(tmp, [[{ id: 'T-1', docRefs: ['spec/ui.md#a'] }, { id: 'T-2', docRefs: ['spec/ui.md#b'] }]]);
    const { orch, dispatched } = build(poller);

    await tickUntilDispatched(orch);

    const groups = tmp.ledger.listGroupsByState('ready');
    assert.equal(groups.length, 1);
    const g = groups[0]!;
    assert.deepEqual([...g.taskIds].sort(), ['T-1', 'T-2']);
    assert.deepEqual(g.footprint, ['spec/ui.md']);
    // 分支名由 repo 短名 + groupId 組出
    assert.equal(g.branch, `orch/web/${g.id}`);

    for (const id of ['T-1', 'T-2']) {
      const t = tmp.ledger.getTask(id)!;
      assert.equal(t.state, 'queued');
      assert.equal(t.groupId, g.id);
    }
    assert.equal(tmp.ledger.listTasksByState('discovered').length, 0);

    assert.deepEqual(dispatched.map((x) => x.id), [g.id]);
    assert.equal(dispatched[0]?.branch, g.branch, '派出的群必須已帶分支名');
  });

  /**
   * **規劃失敗必須看得見。**
   *
   * 規劃是整條鏈的入口：它不成功，後面什麼都不會發生。先前這條路只寫一筆
   * `tick_failed` 事件，於是在沒有 Claude 認證的環境裡，daemon 每一輪都安靜地
   * 失敗一次、什麼都不做——控制台上「現在在做什麼」是空的、「等你處理」也是空的，
   * 看起來就像整台當機了，而其實只是需要有人去修一下認證。
   */
  it('沒有規劃 agent → 開一張交接單交人，不是每輪安靜地失敗', async () => {
    const poller = fakePoller(tmp, [[{ id: 'T-1', docRefs: ['spec/a.md#1'] }]]);
    // 沒有 planAgent ＝ 沒有 Claude 認證的環境
    const { orch } = build(poller, { planner: new Planner({ resolveRepoPath: () => '/repo' }) });

    await tickAndPlan(orch);

    const pending = collectPending(tmp.ledger);
    assert.equal(pending.length, 1, '這件事必須出現在「等你處理」上');
    assert.match(pending[0]!.detail, /認證/, '要講得出怎麼修');
    assert.equal(tmp.ledger.listGroupsByState('ready').length, 0, '不可以安靜地建出零群就當沒事');
  });

  it('規劃連續失敗 → 同一個專案只開一張單（不可以每輪灌一張）', async () => {
    const poller = fakePoller(tmp, [
      [{ id: 'T-1', docRefs: ['spec/a.md#1'] }],
      [{ id: 'T-2', docRefs: ['spec/b.md#1'] }],
    ]);
    const { orch } = build(poller, { planner: new Planner({ resolveRepoPath: () => '/repo' }) });

    await tickAndPlan(orch);
    await tickAndPlan(orch);

    assert.equal(
      collectPending(tmp.ledger).length,
      1,
      '同一件事灌爆清單會讓人不再相信那份清單——那正是交接單這整套要修掉的病',
    );
  });

  it('不相關的任務各自成群，群間可並行派出', async () => {
    const poller = fakePoller(tmp, [[{ id: 'T-1', docRefs: ['spec/a.md#1'] }, { id: 'T-2', docRefs: ['spec/b.md#1'] }]]);
    const { orch, dispatched } = build(poller);

    await tickUntilDispatched(orch);

    assert.equal(tmp.ledger.listGroupsByState('ready').length, 2);
    assert.equal(dispatched.length, 2);
  });

  it('二次 tick：沒有新 discovered 任務就不會重複建群', async () => {
    const poller = fakePoller(tmp, [
      [{ id: 'T-1', docRefs: ['spec/ui.md#a'] }],
      [{ id: 'T-1', docRefs: ['spec/ui.md#a'] }], // MCP 重派同一筆
    ]);
    const { orch } = build(poller);

    await tickAndPlan(orch);
    const first = tmp.ledger.listGroupsByState('ready');
    await tickAndPlan(orch);
    const second = tmp.ledger.listGroupsByState('ready');

    assert.equal(poller.calls, 2);
    assert.equal(second.length, 1);
    assert.deepEqual(second.map((g) => g.id), first.map((g) => g.id));
    assert.equal(second[0]?.createdAt, first[0]?.createdAt, '群不該被重建/覆寫');
  });

  it('二次 tick 出現新任務 → 只為新任務建新群', async () => {
    const poller = fakePoller(tmp, [
      [{ id: 'T-1', docRefs: ['spec/a.md#1'] }],
      [{ id: 'T-1', docRefs: ['spec/a.md#1'] }, { id: 'T-2', docRefs: ['spec/b.md#1'] }],
    ]);
    const { orch } = build(poller);

    await tickAndPlan(orch);
    await tickAndPlan(orch);

    const groups = tmp.ledger.listGroupsByState('ready');
    assert.equal(groups.length, 2);
    const g2 = groups.find((g) => g.taskIds.includes('T-2'))!;
    assert.deepEqual(g2.taskIds, ['T-2'], '既有群的任務不該被重新捲入');
  });

  it('沒有任何任務時 tick 是 no-op（不建空群、不 dispatch）', async () => {
    const poller = fakePoller(tmp, [[]]);
    const { orch, dispatched } = build(poller);

    await tickAndPlan(orch);

    assert.equal(tmp.ledger.listGroupsByState('ready').length, 0);
    assert.deepEqual(dispatched, []);
  });

  it('ready 群在下一輪 tick 會再次嘗試派出（Dispatcher 自行擋重複）', async () => {
    const poller = fakePoller(tmp, [[{ id: 'T-1' }], []]);
    const started: string[] = [];
    const pending: (() => void)[] = [];
    const dispatcher = new Dispatcher(
      4,
      (g) =>
        new Promise<void>((resolve) => {
          started.push(g.id);
          pending.push(resolve);
        }),
      createSilentLogger(),
    );
    const { orch } = build(poller, { dispatcher });

    await tickAndPlan(orch);
    await tickAndPlan(orch);

    assert.equal(started.length, 1, '同一群不該被派兩次');
    pending.forEach((r) => r());
  });

  /**
   * B2 的核心：**規劃期間 tick 不可以停擺**。
   *
   * 實跑撞到：25 個任務的規劃跑 13 分鐘，而 run() 是 `await tick()` 之後才 sleep，
   * 所以那十幾分鐘裡一輪 tick 都沒發生——開好的 PR 沒人去看審查結果、
   * 核准過的沒人去合併、卡住的沒人重派。一件慢事拖垮全部。
   */
  it('規劃跑很久時，同一輪的看審查與合併照樣進行', async () => {
    const poller = fakePoller(tmp, [[{ id: 'T-1' }]]);
    let released: (() => void) | undefined;
    const planner = {
      // 規劃卡住不回來（模擬那 13 分鐘）
      plan: () => new Promise<PlanResult>((r) => { released = () => r({ groups: [], schedule: [] }); }),
    } as unknown as Planner;

    const { orch } = build(poller, { planner });

    // 用時限而不是單純 await：改回 `await planner.plan(...)` 的話這裡會**永遠掛住**，
    // 而掛住的測試在 CI 上只會逾時，看不出是哪裡壞了。加時限讓它變成一句清楚的失敗。
    await Promise.race([
      orch.tick(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('tick 被規劃卡住了——規劃必須是背景執行')), 1500).unref?.()),
    ]);

    assert.ok(released, '規劃應該已經被發動');
    released();
    await orch.settlePlanning();
  });

  /** 規劃跑十幾分鐘，期間每一輪 tick 都會再看到同一批 discovered——不擋就會同時跑好幾個。 */
  it('同一個專案的規劃不會被重複發動', async () => {
    const poller = fakePoller(tmp, [[{ id: 'T-1' }], [], []]);
    let calls = 0;
    let release: (() => void) | undefined;
    const planner = {
      plan: () => { calls += 1; return new Promise<PlanResult>((r) => { release = () => r({ groups: [], schedule: [] }); }); },
    } as unknown as Planner;

    const { orch } = build(poller, { planner });
    await orch.tick();
    await orch.tick();
    await orch.tick();

    assert.equal(calls, 1, '規劃還在跑的時候，後面幾輪不該再發動一次');
    release?.();
    await orch.settlePlanning();
  });

  /** 漏掉 finally 的話，該專案從此永遠不再規劃——症狀是「什麼都不發生」，最難查的那種。 */
  it('規劃結束後旗標要放掉，下一批任務才規劃得了', async () => {
    const poller = fakePoller(tmp, [[{ id: 'T-1' }], [{ id: 'T-2' }]]);
    let calls = 0;
    const planner = { plan: async (): Promise<PlanResult> => { calls += 1; return { groups: [], schedule: [] }; } } as unknown as Planner;

    const { orch } = build(poller, { planner });
    await tickAndPlan(orch);
    await tickAndPlan(orch);

    assert.equal(calls, 2, '第一次規劃結束後旗標沒放掉的話，第二批永遠不會被規劃');
  });

  /** 規劃失敗也要放掉旗標，否則一次失敗就讓該專案永久停擺。 */
  it('規劃失敗後旗標一樣要放掉', async () => {
    const poller = fakePoller(tmp, [[{ id: 'T-1' }], [{ id: 'T-2' }]]);
    let calls = 0;
    const planner = { plan: async (): Promise<PlanResult> => { calls += 1; throw new Error('炸了'); } } as unknown as Planner;

    const { orch } = build(poller, { planner });
    await tickAndPlan(orch);
    await tickAndPlan(orch);

    assert.equal(calls, 2, '失敗之後要能再試，否則一次失敗＝永久停擺');
  });

  /**
   * 規劃已經燒了十幾分鐘與相應的錢。中止時把成果丟掉，等於下次啟動要從頭再燒一次。
   * 建群只是寫 ledger（ready ＋ queued），不會啟動任何東西。
   */
  it('中止時已完成的規劃照樣建群，成果留給下次啟動', async () => {
    const poller = fakePoller(tmp, [[{ id: 'T-1' }]]);
    // 中止必須發生在**規劃回來之前**，否則測不到那個分支
    let release: (() => void) | undefined;
    const planner = {
      plan: () => new Promise<PlanResult>((r) => {
        release = () => r({
          groups: [{ repo: 'acme/web', taskIds: ['T-1'], footprint: ['a.ts'], rationale: 'r', stageIndex: 0 }],
          schedule: [],
        });
      }),
    } as unknown as Planner;
    const { orch } = build(poller, { planner });

    const ac = new AbortController();
    await orch.tick(ac.signal);
    ac.abort();          // daemon 收到 SIGTERM
    release?.();         // 規劃這時候才回來
    await orch.settlePlanning();

    assert.equal(tmp.ledger.listGroupsByState('ready').length, 1, '花掉的錢不該白花');
    assert.equal(tmp.ledger.getTask('T-1')?.state, 'queued');
  });

  /**
   * 規劃跑十幾分鐘，這段時間任務可能已經不在了——最常見的是使用者在控制台停用專案
   * （那會清掉該專案的任務與群組）。不確認的話會建出一個指向不存在任務的群，
   * 而它永遠跑不完。
   */
  it('規劃期間任務被清掉 → 不建出指向幽靈任務的群', async () => {
    const poller = fakePoller(tmp, [[{ id: 'T-1' }, { id: 'T-2' }]]);
    let release: (() => void) | undefined;
    const planner = {
      plan: () => new Promise<PlanResult>((r) => {
        release = () => r({
          groups: [{ repo: 'acme/web', taskIds: ['T-1', 'T-2'], footprint: [], rationale: '', stageIndex: 0 }],
          schedule: [],
        });
      }),
    } as unknown as Planner;
    const { orch } = build(poller, { planner });

    await orch.tick();
    // 規劃還在跑的時候，任務被清掉（模擬控制台停用專案）
    tmp.ledger.deleteTask('T-1');
    release?.();
    await orch.settlePlanning();

    const groups = tmp.ledger.listGroupsByState('ready');
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]?.taskIds, ['T-2'], '只用還在的任務建群');
  });

  it('規劃期間任務全被清掉 → 完全不建群', async () => {
    const poller = fakePoller(tmp, [[{ id: 'T-1' }]]);
    let release: (() => void) | undefined;
    const planner = {
      plan: () => new Promise<PlanResult>((r) => {
        release = () => r({
          groups: [{ repo: 'acme/web', taskIds: ['T-1'], footprint: [], rationale: '', stageIndex: 0 }],
          schedule: [],
        });
      }),
    } as unknown as Planner;
    const { orch } = build(poller, { planner });

    await orch.tick();
    tmp.ledger.deleteTask('T-1');
    release?.();
    await orch.settlePlanning();

    assert.equal(tmp.ledger.listGroupsByState('ready').length, 0);
  });

  /**
   * 規劃改成背景跑之後，它的失敗**不再從 tick 冒出來**——這是刻意的。
   * 讓它冒出來的話，一次規劃失敗就會把同一輪的看審查、合併佇列全部跳過，
   * 而那些跟規劃一點關係都沒有。改成寫 tick_failed，控制台紅色橫幅與 Slack 照樣看得到。
   */
  it('planner 拋錯 → 不拖垮 tick，但要留下看得見的失敗紀錄', async () => {
    const poller = fakePoller(tmp, [[{ id: 'T-1' }]]);
    const planner = {
      async plan(): Promise<PlanResult> {
        throw new Error('planner 爆炸');
      },
    } as unknown as Planner;
    const { orch } = build(poller, { planner });

    await assert.doesNotReject(() => orch.tick(), '規劃失敗不該讓整輪中止');
    await orch.settlePlanning();

    const e = tmp.ledger.latestEvent('system', null, 'tick_failed');
    assert.ok(e, '失敗只留在 log 的話，控制台永遠看不出來出過事');
    assert.match(e.detail ?? '', /planner 爆炸/, '要留下真正的原因');
  });

  it('run()：tick 拋錯只記錄，不中斷迴圈；abort 後乾淨結束', async () => {
    const rec = createRecordingLogger();
    const controller = new AbortController();
    let calls = 0;
    const poller: FakePoller = {
      calls: 0,
      async pollOnce() {
        calls += 1;
        if (calls === 1) throw new Error('poll 爆炸');
        if (calls >= 3) controller.abort();
        return [];
      },
    };
    const { orch } = build(poller, { log: rec.logger });

    await orch.run(controller.signal);

    assert.ok(calls >= 3, `第一輪拋錯後仍應續跑（實際 ${calls} 輪）`);
    assert.ok(rec.messages('error').includes('tick 發生錯誤（續下一輪）'));
    assert.ok(rec.records.some((r) => r.err === 'poll 爆炸'));
    assert.equal(controller.signal.aborted, true);
  });

  /**
   * 這條是關機路徑：睡眠若不理會 abort，SIGTERM 到真正退出最久要等滿一個週期
   * （使用者可把 pollIntervalSec 調到幾百秒），launchd 等不到就補 SIGKILL，
   * 進行中的 worktree／PR 會留下殘骸。timeout 設短，退化成「等滿週期」時會直接紅。
   */
  it('run()：睡眠中收到 abort 立刻醒來，不等滿一個輪詢週期', { timeout: 5000 }, async () => {
    const poller = fakePoller(tmp, [[]]);
    const { deps } = build(poller);
    const orch = new Orchestrator(deps, 60); // 60 秒週期：不中斷睡眠就會超時
    const controller = new AbortController();

    const running = orch.run(controller.signal);
    await waitFor(() => poller.calls >= 1); // 第一輪 tick 已跑完 ⇒ 現在正在睡
    const t0 = Date.now();
    controller.abort();
    await running;

    assert.ok(Date.now() - t0 < 2000, `abort 後應立即結束（實際等了 ${Date.now() - t0}ms）`);
    assert.equal(poller.calls, 1, 'abort 後不該再多跑一輪');
  });

  it('run()：每輪睡眠都清掉 abort listener（長跑不累積洩漏）', { timeout: 10000 }, async () => {
    const poller = idlePoller();
    const { deps } = build(poller);
    const orch = new Orchestrator(deps, 0.001);
    const controller = new AbortController();

    const running = orch.run(controller.signal);
    await waitFor(() => poller.calls >= 30);
    // 取樣當下最多只會有「正在睡的那一輪」掛著一個 listener
    const attached = getEventListeners(controller.signal, 'abort').length;
    controller.abort();
    await running;

    assert.ok(attached <= 2, `abort listener 不該每輪累積（跑了 ${poller.calls} 輪，殘留 ${attached} 個）`);
  });

  it('run()：已 abort 的 signal 直接結束，不跑任何 tick', async () => {
    const poller = fakePoller(tmp, [[{ id: 'T-1' }]]);
    const { orch } = build(poller);
    const controller = new AbortController();
    controller.abort();

    await orch.run(controller.signal);

    assert.equal(poller.calls, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 需求 7 後半段：approved → 合併把關 → 合併；changes_requested → 回灌重做
// ══════════════════════════════════════════════════════════════════════

/** 靜止 Poller（這些測試不關心 poll）。 */
const idlePoller = (): FakePoller => ({ calls: 0, async pollOnce() { this.calls += 1; return []; } });

/** 回放一串預先安排好的審查事件（每次 poll 取一批）。 */
function fakeWatcher(batches: ReviewSignal[][]): ReviewWatcherLike & { calls: number } {
  const w = {
    calls: 0,
    async poll(): Promise<ReviewSignal[]> {
      const b = batches[w.calls] ?? [];
      w.calls += 1;
      return b;
    },
  };
  return w;
}

interface FakeMerge {
  deps: MergePipelineDeps;
  guardCalls: { repoPath: string; branch: string; base: string }[];
  fetched: { repoPath: string; base: string }[];
  merges: { repo: string; prNumber: number; approvedBy: string }[];
  released: { repoPath: string; base: string }[];
  /** 可在測試中途改 */
  verdict: MergeVerdict;
  mergeResult: { ok: boolean; detail: string };
}

const PROJECT: MergeProject = { repoPath: '/tmp/fake-repo', sourceRepoPath: '/tmp/fake-repo',
  baseBranch: 'main',
  verifierConfig: { build: 'npm run build', test: 'npm test' },
};

/**
 * 這個假件**沒有 diff／政策**：合併管線不再讀 diff，「這個改動危不危險」的判斷
 * 早就移到 GroupRunner 的風險判斷者了（見下方「政策判定」那段註解）。
 * 先前這裡還留著 readDiff 與 diff 欄位，是假件沒跟著介面收乾淨——
 * 餵什麼 diff 進來都不會改變任何結果，卻讓人以為測到了政策。
 */
function fakeMerge(over: Partial<Pick<FakeMerge, 'verdict' | 'mergeResult'>> = {}): FakeMerge {
  const f: FakeMerge = {
    guardCalls: [],
    fetched: [],
    merges: [],
    released: [],
    verdict: over.verdict ?? { ok: true },
    mergeResult: over.mergeResult ?? { ok: true, detail: 'merged' },
    deps: undefined as unknown as MergePipelineDeps,
  };
  f.deps = {
    resolveProject: (repo) => (repo === 'acme/web' ? PROJECT : undefined),
    guardFor: () => ({
      async attempt(input) {
        f.guardCalls.push({ repoPath: input.repoPath, branch: input.branch, base: input.base });
        return f.verdict;
      },
    }),
    pr: {
      async merge(input) {
        f.merges.push({ repo: input.repo, prNumber: input.prNumber, approvedBy: input.approvedBy });
        return f.mergeResult;
      },
    },
    async fetchBase(repoPath, base) {
      f.fetched.push({ repoPath, base });
    },
    async releaseBranch(repoPath, base) {
      f.released.push({ repoPath, base });
    },
  };
  return f;
}

function fakeGateway() {
  const asks: { groupId: string; reasons?: string[] }[] = [];
  let cb: ((d: { groupId: string; approved: boolean; userId?: string }) => void) | undefined;
  const gateway: MergeApprovalGateway = {
    async askMergeApproval(_ts, group) {
      asks.push({ groupId: group.groupId, ...(group.reasons ? { reasons: group.reasons } : {}) });
    },
    onMergeDecision(c) {
      cb = c;
    },
  };
  return {
    gateway,
    asks,
    decide(d: { groupId: string; approved: boolean; userId?: string }) {
      if (!cb) throw new Error('沒有人訂閱合併裁決');
      cb(d);
    },
  };
}

function fakeNotifier() {
  const events: LifecycleEvent[] = [];
  return {
    events,
    notifier: {
      event(_ts: string | undefined, e: LifecycleEvent, _t: TaskDetail): void {
        events.push(e);
      },
    },
  };
}

describe('Orchestrator — 審查通過後的合併把關（需求 7）', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp = createTmpLedger();
  });
  afterEach(() => tmp.cleanup());

  /** 建一個已開 PR、正在審查中的群組（含一個已完成的任務）。 */
  function seedReviewedGroup(o: { id?: string; state?: GroupState; prNumber?: number | undefined } = {}): Group {
    const id = o.id ?? 'g_pr';
    tmp.ledger.upsertDiscoveredTask({
      id: `T-${id}`, payloadHash: 'h', repo: 'acme/web', category: 'dev',
      title: '做一件事', description: '描述', dependencies: [], docRefs: [],
    });
    tmp.ledger.updateTaskState(`T-${id}`, 'done', { groupId: id });
    tmp.ledger.upsertGroup({
      id,
      repo: 'acme/web',
      branch: `orch/web/${id}`,
      taskIds: [`T-${id}`],
      footprint: ['src/a.ts'],
      afterGroups: [],
      rationale: '',
      state: o.state ?? 'in_review',
      prUrl: 'https://github.com/acme/web/pull/42',
      ...('prNumber' in o ? { prNumber: o.prNumber } : { prNumber: 42 }),
    });
    return tmp.ledger.getGroup(id)!;
  }

  function build(over: Partial<OrchestratorDeps> = {}) {
    const dispatched: Group[] = [];
    const deps: OrchestratorDeps = {
      poller: idlePoller() as unknown as Poller,
      planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
      dispatcher: new Dispatcher(4, async (g) => { dispatched.push(g); }, createSilentLogger()),
      ledger: tmp.ledger,
      log: createSilentLogger(),
      // 這批測試驗的是 tick 的主流程，不是靜置期；關掉才不會被預設的 15 分鐘擋住
      // （靜置期本身另有專門的測試檔 quiet-period.test.ts / 本檔末段）。
      quietMinutesOf: () => 0,
      ...over,
    };
    return { orch: new Orchestrator(deps, 0.01), dispatched, deps };
  }

  it('approved → 重跑 Merge Guard（含抓最新 base）→ 政策放行 → 以 reviewer 身分合併', async () => {
    const g = seedReviewedGroup();
    const m = fakeMerge();
    const notif = fakeNotifier();
    const { orch } = build({
      reviewWatcher: fakeWatcher([[{ type: 'approved', group: g.id, approvedBy: 'bob', prNumber: 42 }]]),
      merge: m.deps,
      notifier: notif.notifier,
    });

    await tickAndPlan(orch);

    assert.deepEqual(m.fetched, [{ repoPath: PROJECT.repoPath, base: 'main' }], '合併前必須先抓最新 base');
    assert.deepEqual(m.guardCalls, [{ repoPath: PROJECT.repoPath, branch: g.branch, base: 'main' }], '不可只信 GitHub 的 mergeable');
    assert.deepEqual(m.merges, [{ repo: 'acme/web', prNumber: 42, approvedBy: 'reviewer:bob' }]);
    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'merged');
    assert.ok(notif.events.some((e) => e.type === 'merged'));
  });

  /**
   * git 不允許同一條分支同時被兩個 worktree 檢出。守衛會把合併工作區檢出到群組分支，
   * 停在上面就占住了它——接著群組若要重做，任務 worktree 建不起來
   * （`is already used by worktree at .../merge-worktrees/live`），整組 failed。
   * 實跑撞到：核准 → 守衛擋下 → 要重做 → 建 worktree 失敗 → failed。
   */
  it('守衛跑完就把合併工作區切回 base，釋放群組分支', async () => {
    const g = seedReviewedGroup();
    const m = fakeMerge();
    const { orch } = build({
      reviewWatcher: fakeWatcher([[{ type: 'approved', group: g.id, approvedBy: 'bob', prNumber: 42 }]]),
      merge: m.deps,
    });

    await tickAndPlan(orch);

    assert.deepEqual(m.released, [{ repoPath: PROJECT.repoPath, base: 'main' }]);
  });

  it('守衛擋下時**也要**釋放分支（不然重做就建不了 worktree）', async () => {
    const g = seedReviewedGroup();
    const m = fakeMerge({ verdict: { ok: false, reason: 'code_conflict', detail: '衝突' } });
    const { orch } = build({
      reviewWatcher: fakeWatcher([[{ type: 'approved', group: g.id, approvedBy: 'bob', prNumber: 42 }]]),
      merge: m.deps,
    });

    await tickAndPlan(orch);

    assert.deepEqual(m.released, [{ repoPath: PROJECT.repoPath, base: 'main' }]);
    assert.deepEqual(m.merges, [], '擋下就不該合併');
  });

  /**
   * 不合併是對的（安全預設），但**不能讓群組就這樣消失**。
   *
   * 實跑撞到：多專案測試裡一個群組被人核准後永遠停在 merge_guard——
   * 不在待辦清單、沒合併、沒失敗，而依賴它的下一群就一直等下去。
   * 人按了核准，系統靜默地什麼都不做。標成 failed 不是說這批工作壞掉
   * （它通過了所有關卡），而是「這條路走不下去、需要人決定」——
   * failed 是唯一會進待辦清單、且有 retry 動作的狀態。
   */
  it('沒接合併管線（預設）→ 不合併，但要標 failed 讓人看得到（不能靜默卡住）', async () => {
    const g = seedReviewedGroup();
    const { orch } = build({
      reviewWatcher: fakeWatcher([[{ type: 'approved', group: g.id, approvedBy: 'bob' }]]),
    });

    await tickAndPlan(orch);
    await tickAndPlan(orch);

    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'failed', '要進得了待辦清單');
    const why = tmp.ledger.listEvents().find((e) => e.refId === g.id && e.kind === 'merge_blocked')?.detail ?? '';
    assert.match(why, /allowLocalMerge/, '原因要講清楚該去改什麼');
    assert.match(why, /分支還在/, '要講明成果沒有掉');
  });

  /**
   * 這裡原本有一條「政策判定需人工核准 → 就算 GitHub 上 approve 了也不合併」。
   *
   * 那條規則已經移除：它是靠比對檔案路徑（`**\/migrations\/**` 之類）猜「這個改動危不危險」，
   * 而那是在猜別人的 repo 長什麼樣。更根本的是——**GitHub 上的 approve 就是一個人看過並同意了**，
   * 再拿一組寫死的路徑規則去否決他，只是把「誰能決定」從人手上搶回程式手上。
   *
   * 現在：有核准憑證（GitHub 審查或 Slack/CLI）＋ Merge Guard 剛在最新 base 上通過 → 合併。
   * 「這個改動可不可逆」的判斷移到 GroupRunner 的風險判斷者，而且只在
   * 「自動合併」開著、根本沒有人要看的時候才需要。
   */
  it('GitHub 上審查通過 → 系統合併（需求 7 的閉環）', async () => {
    const g = seedReviewedGroup();
    const m = fakeMerge();
    const gw = fakeGateway();
    const { orch } = build({
      reviewWatcher: fakeWatcher([[{ type: 'approved', group: g.id, approvedBy: 'bob' }]]),
      merge: m.deps,
      gateway: gw.gateway,
    });

    await tickAndPlan(orch);

    assert.deepEqual(m.merges, [{ repo: 'acme/web', prNumber: 42, approvedBy: 'reviewer:bob' }]);
    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'merged');
    assert.equal(gw.asks.length, 0, '已經有人審過了，不必再問一次');
  });

  it('人在 Slack 核准 → 同樣合併，憑證記的是那個人', async () => {
    const g = seedReviewedGroup();
    const m = fakeMerge();
    const gw = fakeGateway();
    const { orch } = build({ merge: m.deps, gateway: gw.gateway });

    await tickAndPlan(orch);
    assert.deepEqual(m.merges, [], '沒有任何核准憑證就不合併');

    gw.decide({ groupId: g.id, approved: true, userId: 'U123' });
    await tickAndPlan(orch);

    assert.deepEqual(m.merges, [{ repo: 'acme/web', prNumber: 42, approvedBy: 'human:U123' }]);
    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'merged');
  });

  it('merge_guard 群組沒有核准憑證（崩潰殘留）→ 絕不合併，改問人', async () => {
    // 模擬 daemon 在 GroupRunner 就地跑守衛時崩潰，狀態停在 merge_guard
    const g = seedReviewedGroup({ state: 'merge_guard' });
    const m = fakeMerge();
    const gw = fakeGateway();
    const { orch } = build({ merge: m.deps, gateway: gw.gateway });

    await tickAndPlan(orch);
    await tickAndPlan(orch);

    assert.deepEqual(m.merges, [], '狀態是 merge_guard 不等於有人核准過');
    assert.deepEqual(m.guardCalls, []);
    assert.equal(gw.asks.length, 1);
    assert.match(gw.asks[0]?.reasons?.join('') ?? '', /沒有這個群組的核准紀錄/);
  });

  it('群組正在被 GroupRunner 執行時的 merge_guard 是暫態 → 完全不碰', async () => {
    const g = seedReviewedGroup({ state: 'merge_guard' });
    const m = fakeMerge();
    const gw = fakeGateway();
    // isRunning 恆為 true = GroupRunner 正在就地跑守衛
    const dispatcher = { dispatch: () => 0, isRunning: () => true };
    const { orch } = build({ merge: m.deps, gateway: gw.gateway, dispatcher });

    await tickAndPlan(orch);

    assert.deepEqual(m.merges, []);
    assert.deepEqual(gw.asks, [], '不可把別人手上的暫態當成待合併而騷擾人');
    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'merge_guard');
  });

  it('Merge Guard 擋下（語意飄移）→ 不合併、憑證作廢、退回 changes_requested 並存下可回灌的細節', async () => {
    const g = seedReviewedGroup();
    const m = fakeMerge({ verdict: { ok: false, reason: 'semantic_drift', detail: '[test] 3 個測試紅' } });
    const store = new ReviewFeedbackStore(tmp.ledger);
    const notif = fakeNotifier();
    const { orch } = build({
      reviewWatcher: fakeWatcher([[{ type: 'approved', group: g.id, approvedBy: 'bob' }]]),
      merge: m.deps,
      feedback: store,
      notifier: notif.notifier,
    });

    await tickAndPlan(orch);

    assert.deepEqual(m.merges, []);
    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'changes_requested');
    assert.match(store.peek(g.id)?.comments.join('') ?? '', /semantic_drift.*測試紅/s);
    assert.equal(store.peek(g.id)?.source, 'merge_guard');
    assert.ok(notif.events.some((e) => e.type === 'problem'));
  });

  it('Merge Guard 前置條件不成立（根本沒驗到）→ 標 failed，不可當成「要修」', async () => {
    const g = seedReviewedGroup();
    const m = fakeMerge({ verdict: { ok: false, reason: 'precondition_failed', detail: '分支不存在' } });
    const store = new ReviewFeedbackStore(tmp.ledger);
    const { orch } = build({
      reviewWatcher: fakeWatcher([[{ type: 'approved', group: g.id, approvedBy: 'bob' }]]),
      merge: m.deps,
      feedback: store,
    });

    await tickAndPlan(orch);

    assert.deepEqual(m.merges, []);
    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'failed');
    assert.equal(store.has(g.id), false, '沒驗到就沒有具體意見可回灌');
  });

  /**
   * 開 PR 是必經之路（openPr 開關已移除），所以正常情況一定有 PR 編號。
   * 沒有代表 ledger 紀錄不完整（例如開 PR 途中崩潰）——這時不能假裝合併過。
   */
  it('沒有 PR 編號（紀錄不完整）→ 不嘗試合併，標 failed 交人處理', async () => {
    const g = seedReviewedGroup({ prNumber: undefined });
    const m = fakeMerge();
    const { orch } = build({
      reviewWatcher: fakeWatcher([[{ type: 'approved', group: g.id, approvedBy: 'bob' }]]),
      merge: m.deps,
    });

    await tickAndPlan(orch);

    assert.deepEqual(m.merges, [], '本地模式沒有 PR 可合併');
    assert.deepEqual(m.guardCalls, []);
    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'failed');
    const why = tmp.ledger.listEvents().find((e) => e.refId === g.id && e.kind === 'merge_blocked')?.detail ?? '';
    assert.match(why, /紀錄不完整/);
  });

  it('合併呼叫失敗 → 不標 merged、憑證作廢（不會每輪靜默重試）', async () => {
    const g = seedReviewedGroup();
    const m = fakeMerge({ mergeResult: { ok: false, detail: '分支保護：需要 2 個核准' } });
    const notif = fakeNotifier();
    const { orch } = build({
      reviewWatcher: fakeWatcher([[{ type: 'approved', group: g.id, approvedBy: 'bob' }], []]),
      merge: m.deps,
      notifier: notif.notifier,
    });

    await tickAndPlan(orch);
    await tickAndPlan(orch);

    assert.equal(m.merges.length, 1, '失敗後不可每輪重打外部合併 API');
    assert.notEqual(tmp.ledger.getGroup(g.id)?.state, 'merged');
    assert.ok(notif.events.some((e) => e.type === 'failed'));
  });

  /**
   * 這條原本斷言 failed。實跑（2026-08-07，uniwork）證明那是錯的：
   * 使用者停用專案 → daemon 重啟（合併閉環只接到另一個專案）→ 把專案加回來，
   * 之後**每按一次「核准」就多一次 failed**，而合併工作區目錄明明還在，
   * 缺的只是記憶體裡那筆對照。「查不到專案」的三種來源全部會自己好，
   * 所以要保留現場與核准憑證，下一輪再試。
   */
  it('找不到專案 runtime → 保留核准、下一輪再試（**不可以判死**）', async () => {
    tmp.ledger.upsertGroup({
      id: 'g_unknown', repo: 'other/repo', branch: 'orch/repo/g', taskIds: [], footprint: [],
      afterGroups: [], rationale: '', state: 'in_review', prNumber: 7,
    });
    const m = fakeMerge();
    const { orch } = build({
      reviewWatcher: fakeWatcher([[{ type: 'approved', group: 'g_unknown', approvedBy: 'bob' }]]),
      merge: m.deps,
    });

    await tickAndPlan(orch);

    assert.deepEqual(m.merges, []);
    assert.notEqual(tmp.ledger.getGroup('g_unknown')?.state, 'failed',
      '判死等於毀掉人剛按的核准，而且下一輪就會成功的情況也救不回來');
  });

  it('審查事件的群組不存在 → 只記錄，不炸掉整輪', async () => {
    const g = seedReviewedGroup();
    const m = fakeMerge();
    const { orch } = build({
      reviewWatcher: fakeWatcher([[
        { type: 'approved', group: 'g_ghost', approvedBy: 'bob' },
        { type: 'approved', group: g.id, approvedBy: 'bob' },
      ]]),
      merge: m.deps,
    });

    await tickAndPlan(orch);

    assert.deepEqual(m.merges.map((x) => x.prNumber), [42], '幽靈事件不可讓後面的事件跟著掉');
  });

  it('Review Watcher 拋錯 → 記警告續跑，不影響合併佇列', async () => {
    const g = seedReviewedGroup({ state: 'merge_guard' });
    const m = fakeMerge();
    const gw = fakeGateway();
    const rec = createRecordingLogger();
    const watcher: ReviewWatcherLike = {
      async poll() {
        throw new Error('gh 爆炸');
      },
    };
    const { orch } = build({ reviewWatcher: watcher, merge: m.deps, gateway: gw.gateway, log: rec.logger });

    await tickAndPlan(orch);

    assert.ok(rec.messages('warn').some((msg) => msg.includes('Review Watcher 失敗')));
    assert.equal(gw.asks.length, 1, '審查旁路掛掉不該讓合併佇列停擺');
  });

  it('recordMergeApproval 拒絕空的 approvedBy（合併必須有可稽核的來源）', async () => {
    const g = seedReviewedGroup({ state: 'merge_guard' });
    const m = fakeMerge();
    const rec = createRecordingLogger();
    const { orch } = build({ merge: m.deps, log: rec.logger });

    orch.recordMergeApproval(g.id, '   ');
    await tickAndPlan(orch);

    assert.deepEqual(m.merges, []);
    assert.ok(rec.messages('error').some((msg) => msg.includes('未指明核准來源')));

    orch.recordMergeApproval(g.id, 'cli:alice');
    await tickAndPlan(orch);
    assert.deepEqual(m.merges, [{ repo: 'acme/web', prNumber: 42, approvedBy: 'cli:alice' }]);
  });

  /**
   * **退回時這裡只作廢憑證，不寫意見。**
   *
   * 先前它會存一句程式編的罐頭話（「請依 PR 上的意見修正後重新送審」），
   * 而 InboundRouter（同一個事件的另一個訂閱者）存的是人**實際打的字**——
   * 兩邊寫進同一個覆寫式的暫存區，接線順序讓罐頭句最後跑、蓋掉人的原話。
   * 這個函式的參數型別根本沒有 reason 欄位，結構上就拿不到人說了什麼。
   */
  it('人在 Slack 按退回 → 憑證作廢，而且**不編**一句假的意見蓋掉人的話', async () => {
    const g = seedReviewedGroup({ state: 'merge_guard' });
    const m = fakeMerge();
    const gw = fakeGateway();
    const store = new ReviewFeedbackStore(tmp.ledger);
    const { orch } = build({ merge: m.deps, gateway: gw.gateway, feedback: store });

    gw.decide({ groupId: g.id, approved: true, userId: 'U1' });
    gw.decide({ groupId: g.id, approved: false, userId: 'U1' });
    await tickAndPlan(orch);

    assert.deepEqual(m.merges, [], '退回之後不可再拿舊憑證去合併');
    assert.equal(
      store.peek(g.id),
      undefined,
      '意見只能由「拿得到人打的字」的那一端寫；這裡編一句只會蓋掉真的那句',
    );
  });

  // ── 第 2 刀：退回／park 一定要留下出口 ──

  /**
   * 實跑：g_dea636a3c852 停 5 小時、g_86224a8df710 停 53 小時，兩個都堵住五個下游群，
   * 而畫面顯示「目前沒有需要你決定的事」。這條路先前只有 warnOnce。
   */
  it('任務全 done ＋ 有 PR ＋ 沒有可回灌的意見 → 開一張單（不再只是 warnOnce）', async () => {
    const g = seedReviewedGroup({ state: 'changes_requested' });
    for (const id of g.taskIds) tmp.ledger.updateTaskState(id, 'done');
    const { orch } = build({ merge: fakeMerge().deps });

    await tickAndPlan(orch);

    const hs = tmp.ledger.listHandoffs({ groupId: g.id, toRole: 'human', unconsumedOnly: true });
    assert.equal(hs.length, 1, '停在非終態又沒推進 ⇒ 必須留下人看得見的東西');
    assert.match(hs[0]!.body, /沒有可回灌的審查意見/);
    assert.deepEqual(hs[0]!.options, ['retry'], '這裡沒有紅燈可放行');
  });

  /**
   * base 被外部動過**不是這一群的缺陷**，要做的只有再跑一次守衛。
   * 先前它 park 到 changes_requested（一個沒有「重跑守衛」入口的狀態）⇒ 必落上面那條死路。
   */
  it('base 被外部動過 → 送回 ready 重跑守衛，不是丟給人', async () => {
    const g = seedReviewedGroup({ state: 'changes_requested' });
    for (const id of g.taskIds) tmp.ledger.updateTaskState(id, 'done');
    tmp.ledger.logEvent('group', g.id, GROUP_RERUN_REQUESTED_EVENT, 'base 被動過');
    const { orch } = build({ merge: fakeMerge().deps });

    await tickAndPlan(orch);

    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'ready', '要自己重跑，不該停著等人');
  });

  it('重跑請求只認一次（重派之後那筆就失效，不會每輪重派）', async () => {
    const g = seedReviewedGroup({ state: 'changes_requested' });
    for (const id of g.taskIds) tmp.ledger.updateTaskState(id, 'done');
    tmp.ledger.logEvent('group', g.id, GROUP_RERUN_REQUESTED_EVENT, 'base 被動過');
    const { orch } = build({ merge: fakeMerge().deps });

    await tickAndPlan(orch);
    tmp.ledger.updateGroupState(g.id, 'changes_requested'); // 假裝又 park 回來
    await tickAndPlan(orch);

    assert.notEqual(tmp.ledger.getGroup(g.id)?.state, 'ready', '舊的重跑請求不可以一直生效');
  });

  // ── 第 1 刀：合併路徑不再有無聲循環 ──
  /**
   * 沒有 prNumber 的 merge_guard 群是真實存在的：group-runner 在**開 PR 之前**就設了
   * 那個狀態，而守衛被中止時刻意不覆寫狀態。對它給「核准合併」，下一輪
   * mergeApprovedGroup 的 !prNumber 會走 failGroup——**按一下把還救得回來的成果判死**。
   */
  it('merge_guard 但沒有 PR → 不問核准，開一張講清楚的 stuck_group 單', async () => {
    const g = seedReviewedGroup({ state: 'merge_guard' });
    tmp.ledger.updateGroupState(g.id, 'merge_guard');
    // 把 PR 編號拿掉（模擬守衛在開 PR 前被中止）
    tmp.ledger.upsertGroup({ ...tmp.ledger.getGroup(g.id)!, prNumber: undefined });
    const m = fakeMerge();
    const gw = fakeGateway();
    const { orch } = build({ merge: m.deps, gateway: gw.gateway });

    await tickAndPlan(orch);

    assert.deepEqual(gw.asks, [], '沒有 PR 就不該問核准——按下去會把群組判死');
    const handoffs = tmp.ledger.listHandoffs({ groupId: g.id, toRole: 'human', unconsumedOnly: true });
    assert.equal(handoffs.length, 1, '不問也要留下人看得見的東西');
    assert.equal(handoffs[0]!.kind, 'stuck_group');
    assert.match(handoffs[0]!.body, /還沒開 PR/);
    assert.notEqual(tmp.ledger.getGroup(g.id)?.state, 'failed', '不可以判死');
    // **這張單要按得動。** 舊文字寫「按重試會對已完成的任務重新 start_task」，那句已經過期：
    // GroupRunner 對 done 的任務是 skipped_already_done，送回 ready ＝ 只重跑守衛與開 PR。
    // 講「沒有入口」又不給按鈕，等於把做得到的事寫成做不到的。
    assert.deepEqual(handoffs[0]!.options, ['retry']);
    assert.doesNotMatch(handoffs[0]!.body, /重新 start_task/, '過期的說法會讓人不敢按');
  });

  /**
   * 合併佇列的清單是迴圈開始時就固定的，而每一輪都 await（一次合併好幾分鐘）。
   * 輪到後面的群時手上可能是舊快照。實跑（2026-08-18，g_197cc7012ad3）：
   * 17:51 群組因「分支零 commit」正確結案成 closed，17:53 迴圈才輪到它，
   * 拿著舊快照走進 escalateNoPr，對已結案的群開了張「請自己去開 PR」的單——
   * 而那條分支領先 main 0 個 commit，PR 開不出來。
   */
  it('迴圈中途群組已被別人結案 → 重讀當下狀態，不對舊快照動手', async () => {
    const g = seedReviewedGroup({ state: 'merge_guard' });
    tmp.ledger.updateGroupState(g.id, 'merge_guard');
    tmp.ledger.upsertGroup({ ...tmp.ledger.getGroup(g.id)!, prNumber: undefined });

    // 清單取出後、輪到它之前，別的路徑把它正確結案了
    const real = tmp.ledger.listGroupsByState.bind(tmp.ledger);
    let served = false;
    (tmp.ledger as { listGroupsByState: typeof real }).listGroupsByState = (st) => {
      const out = real(st);
      if (st === 'merge_guard' && !served) {
        served = true;
        tmp.ledger.updateGroupState(g.id, 'closed'); // ← 快照發出後才變的
      }
      return out;
    };

    const m = fakeMerge();
    const gw = fakeGateway();
    const { orch } = build({ merge: m.deps, gateway: gw.gateway });
    await tickAndPlan(orch);

    assert.deepEqual(
      tmp.ledger.listHandoffs({ groupId: g.id, toRole: 'human', unconsumedOnly: true }),
      [],
      '已經結案的群不該再收到「請人工接手」——那張單講的事情不存在',
    );
    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'closed');
  });

  it('問核准 ＝ 開一張 merge_approval 單（先前只發訊息，清單上不存在）', async () => {
    const g = seedReviewedGroup({ state: 'merge_guard' });
    const m = fakeMerge();
    const { orch } = build({ merge: m.deps, gateway: fakeGateway().gateway });

    await tickAndPlan(orch);

    const handoffs = tmp.ledger.listHandoffs({ groupId: g.id, toRole: 'human', kind: 'merge_approval', unconsumedOnly: true });
    assert.equal(handoffs.length, 1, '核准請求要在「等你處理」上看得到');
  });

  it('去重靠「單還在不在」，不是行程記憶體——連跑兩輪只會有一張', async () => {
    const g = seedReviewedGroup({ state: 'merge_guard' });
    const { orch } = build({ merge: fakeMerge().deps, gateway: fakeGateway().gateway });

    await tickAndPlan(orch);
    await tickAndPlan(orch);

    assert.equal(
      tmp.ledger.listHandoffs({ groupId: g.id, toRole: 'human', kind: 'merge_approval', unconsumedOnly: true }).length,
      1, '兩張長得一樣的單只會讓人不知道點哪個',
    );
  });

  it('人核准 → 那張單被消化，合併真的送得出去（四條核准入口共用同一個寫入）', async () => {
    const g = seedReviewedGroup({ state: 'merge_guard' });
    const m = fakeMerge();
    const { orch } = build({ merge: m.deps, gateway: fakeGateway().gateway });

    await tickAndPlan(orch);                       // → 開單
    orch.recordMergeApproval(g.id, 'cli:alice');   // 人表態
    await tickAndPlan(orch);

    assert.equal(
      tmp.ledger.listHandoffs({ groupId: g.id, toRole: 'human', kind: 'merge_approval', unconsumedOnly: true }).length,
      0, '核准之後那張單要結案，否則合併佇列會一直跳過',
    );
    assert.equal(m.merges.length, 1, '按了核准就要真的合併');
  });

describe('Orchestrator — requeue 階段（離開 ready 之後還有回頭路）', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp = createTmpLedger();
  });
  afterEach(() => tmp.cleanup());

  function seedTask(id: string, groupId: string, state: Task['state']): void {
    tmp.ledger.upsertDiscoveredTask({
      id, payloadHash: `h-${id}`, repo: 'acme/web', category: 'dev',
      title: `任務 ${id}`, description: '描述', dependencies: [], docRefs: [],
    });
    if (state !== 'discovered') tmp.ledger.updateTaskState(id, state, { groupId });
  }

  /**
   * prNumber 有無會改變 changes_requested 的語意：
   *   有 PR → 審查要求修改（要靠 reviewer 意見驅動）
   *   無 PR → park 等人回覆（人回覆後就該重派收尾）
   * 審查相關的情境一定要帶 prNumber，否則測到的是另一條路徑。
   */
  function seedGroup(id: string, state: GroupState, taskIds: string[], prNumber?: number): Group {
    tmp.ledger.upsertGroup({
      id, repo: 'acme/web', branch: `orch/web/${id}`, taskIds, footprint: ['src/a.ts'],
      afterGroups: [], rationale: '', state,
      ...(prNumber !== undefined ? { prNumber, prUrl: `https://example.test/pr/${prNumber}` } : {}),
    });
    return tmp.ledger.getGroup(id)!;
  }

  function build(over: Partial<OrchestratorDeps> = {}) {
    const dispatched: Group[] = [];
    const deps: OrchestratorDeps = {
      poller: idlePoller() as unknown as Poller,
      planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
      dispatcher: new Dispatcher(4, async (g) => { dispatched.push(g); }, createSilentLogger()),
      ledger: tmp.ledger,
      log: createSilentLogger(),
      // 這批測試驗的是 tick 的主流程，不是靜置期；關掉才不會被預設的 15 分鐘擋住
      // （靜置期本身另有專門的測試檔 quiet-period.test.ts / 本檔末段）。
      quietMinutesOf: () => 0,
      ...over,
    };
    return { orch: new Orchestrator(deps, 0.01), dispatched, deps };
  }

  it('changes_requested + 已有審查意見 → 轉 ready 並在同一輪被派出', async () => {
    seedTask('T-1', 'g_cr', 'done');
    const g = seedGroup('g_cr', 'changes_requested', ['T-1']);
    const store = new ReviewFeedbackStore(tmp.ledger);
    store.save({ groupId: g.id, comments: ['@bob: 加錯誤處理'], source: 'github_review' });
    const { orch, dispatched } = build({ feedback: store });

    await tickAndPlan(orch);

    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'ready');
    assert.deepEqual(dispatched.map((x) => x.id), [g.id]);
    assert.equal(store.has(g.id), true, '意見要留著給 GroupRunner 讀（由它 take 走）');
  });

  it('審查要求修改 → 下一輪 tick 就重新派出（端到端）', async () => {
    seedTask('T-1', 'g_cr', 'done');
    const g = seedGroup('g_cr', 'changes_requested', ['T-1'], 11);
    const store = new ReviewFeedbackStore(tmp.ledger);
    const { orch, dispatched } = build({
      feedback: store,
      reviewWatcher: fakeWatcher([[{ type: 'changes_requested', group: g.id, comments: ['@bob: 拆函式'] }]]),
    });

    await tickAndPlan(orch); // 事件進來、意見落地（requeue 在 pollReviews 之前，本輪還不會派）
    assert.equal(dispatched.length, 0);
    assert.match(store.promptFor(g.id) ?? '', /拆函式/);

    await tickAndPlan(orch);
    assert.deepEqual(dispatched.map((x) => x.id), [g.id]);
  });

  // 先前這裡驗的是一道互鎖：「有意見但沒接共用實例 → 不重新派工」。
  // 那道互鎖存在的原因是意見存在**記憶體**裡，兩個實例讀不到對方的。
  // 意見搬進 handoffs 表之後，誰拿到 ledger 誰就讀得到——互鎖與它擋掉的整類問題
  // 一起消失了。現在要驗的是相反的保證：**意見一定回得去**。
  it('審查意見存進 DB → 就算換一個 store 實例也讀得到（重啟不會讓它蒸發）', async () => {
    seedTask('T-1', 'g_cr', 'done');
    const g = seedGroup('g_cr', 'changes_requested', ['T-1'], 12);
    const { orch } = build({
      reviewWatcher: fakeWatcher([[{ type: 'changes_requested', group: g.id, comments: ['改這裡'] }]]),
    });

    await tickAndPlan(orch);

    // 模擬 daemon 重啟：全新的 store 實例，記憶體裡什麼都沒有
    const afterRestart = new ReviewFeedbackStore(tmp.ledger);
    assert.equal(afterRestart.has(g.id), true, '重啟後意見還要在，否則這一群永遠不會被重新派工');
    assert.deepEqual(afterRestart.peek(g.id)?.comments, ['改這裡']);
  });

  it('changes_requested 但沒有任何意見（重啟後遺失）→ 保守停著，不盲目重做', async () => {
    seedTask('T-1', 'g_cr', 'done');
    const g = seedGroup('g_cr', 'changes_requested', ['T-1'], 13);
    const { orch, dispatched } = build({ feedback: new ReviewFeedbackStore(tmp.ledger) });

    await tickAndPlan(orch);

    assert.deepEqual(dispatched, []);
    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'changes_requested');
  });

  it('澄清已答覆（任務回 queued、群組 failed）→ 群組轉 ready 重新派出', async () => {
    seedTask('T-1', 'g_park', 'done');
    seedTask('T-2', 'g_park', 'queued'); // InboundRouter.clearBlock(…, 'queued') 的結果
    const g = seedGroup('g_park', 'failed', ['T-1', 'T-2']);
    const { orch, dispatched } = build();

    await tickAndPlan(orch);

    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'ready');
    assert.deepEqual(dispatched.map((x) => x.id), [g.id]);
  });

  /**
   * park 的復活路徑（group-runner 的 shouldRequeueGroup 契約）。這條斷掉的話，
   * 所有「問了澄清問題」的群組都會永久停在 changes_requested ⇒ 群內任務等同遺失。
   */
  it('park 等人 → 人回覆（clearBlock 回 queued）→ 下一輪 tick 群組回 ready 並被派出', async () => {
    seedTask('T-1', 'g_park', 'done');
    seedTask('T-2', 'g_park', 'blocked'); // GroupRunner 問了澄清問題，群被 park
    const g = seedGroup('g_park', 'changes_requested', ['T-1', 'T-2']); // = PARKED_GROUP_STATE
    const rec = createRecordingLogger();
    const { orch, dispatched } = build({ log: rec.logger, feedback: new ReviewFeedbackStore(tmp.ledger) });

    await tickAndPlan(orch);
    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'changes_requested', '人還沒回覆 → 不動');
    assert.equal(dispatched.length, 0);
    assert.deepEqual(rec.messages('warn'), [], '等人是正常狀態，不該被當成「沒有意見可回灌」而警告');

    tmp.ledger.clearBlock('T-2', 'queued'); // InboundRouter 收到澄清答覆
    await tickAndPlan(orch);

    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'ready', 'park 的群必須回得了派工佇列');
    assert.deepEqual(dispatched.map((x) => x.id), [g.id]);
  });

  it('park 的群任務全部結案但還沒開 PR → 重派做收尾（否則永久卡住）', async () => {
    // 典型情境：人用 confirm_no_change 把 park 中的最後一張卡結案。收尾工作（開 PR、
    // Merge Guard、清 worktree）都還沒做，不重派的話群組會停在非終態且沒有任何人再碰它
    // ——e2e 實測過：群組卡死 + worktree 永久殘留。
    seedTask('T-1', 'g_done', 'done');
    const g = seedGroup('g_done', 'changes_requested', ['T-1']);
    const { orch, dispatched } = build({ feedback: new ReviewFeedbackStore(tmp.ledger) });

    await tickAndPlan(orch);

    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'ready');
    assert.deepEqual(dispatched.map((d) => d.id), ['g_done']);
  });

  it('已開 PR 的 changes_requested 沒有意見 → 保守停著（重派只會讓 agent 盲改）', async () => {
    seedTask('T-1', 'g_pr', 'done');
    const g = seedGroup('g_pr', 'changes_requested', ['T-1'], 21);
    const { orch, dispatched } = build({ feedback: new ReviewFeedbackStore(tmp.ledger) });

    await tickAndPlan(orch);

    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'changes_requested');
    assert.deepEqual(dispatched, []);
  });

  it('failed 群組沒有任何被要求重跑的任務 → 不動（不無限重試）', async () => {
    seedTask('T-1', 'g_dead', 'done');
    const g = seedGroup('g_dead', 'failed', ['T-1']);
    const { orch, dispatched } = build();

    await tickAndPlan(orch);

    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'failed');
    assert.deepEqual(dispatched, []);
  });

  it('forming 群組但沒人在跑它 → 有待跑任務就重新派出', async () => {
    seedTask('T-1', 'g_stale', 'queued');
    const g = seedGroup('g_stale', 'forming', ['T-1']);
    const { orch, dispatched } = build();

    await tickAndPlan(orch);

    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'ready');
    assert.deepEqual(dispatched.map((x) => x.id), [g.id]);
  });

  it('正在跑的群組不會被搶走狀態', async () => {
    seedTask('T-1', 'g_run', 'queued');
    const g = seedGroup('g_run', 'forming', ['T-1']);
    const dispatcher = { dispatch: () => 0, isRunning: () => true };
    const { orch } = build({ dispatcher });

    await tickAndPlan(orch);

    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'forming');
  });

  it('queued 但沒有對應群組的任務 → 退回 discovered，由 planner 重新分群', async () => {
    seedTask('T-orphan', 'g_gone', 'queued'); // 群組不存在
    const { orch, dispatched } = build();

    await tickUntilDispatched(orch);

    // 同一輪：requeue 退回 discovered → planner 重新建群 → 派出
    assert.equal(tmp.ledger.getTask('T-orphan')?.state, 'queued', '重新分群後回到 queued');
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0]?.taskIds, ['T-orphan']);
  });

  it('重新派工有次數上限，避免「派回去→立刻失敗→再派回去」空轉', async () => {
    seedTask('T-1', 'g_loop', 'queued');
    seedGroup('g_loop', 'failed', ['T-1']);
    const rec = createRecordingLogger();
    // runner 立刻把群組打回 failed，模擬每次派出都失敗
    const dispatcher = new Dispatcher(
      4,
      async (g) => {
        tmp.ledger.updateGroupState(g.id, 'failed');
      },
      createSilentLogger(),
    );
    const { orch } = build({ dispatcher, log: rec.logger, maxRequeuePerGroup: 2 });

    for (let i = 0; i < 5; i += 1) await tickAndPlan(orch);

    const requeues = rec.records.filter((r) => typeof r.msg === 'string' && r.msg.startsWith('♻️'));
    assert.equal(requeues.length, 2, '達上限就停手');
    assert.ok(rec.messages('error').some((m) => m.includes('已達上限')));
  });

  // ── 缺陷 2：撞上限不可靜默遺棄群組 ──

  /**
   * 實跑證據：第 10 輪起 log 只剩一行 warn，之後 5 個 tick 完全沒有任何動作，
   * 群組永遠停在非終態、worktree 永久殘留，而**人完全不知道有東西卡住**。
   */
  it('撞上限 → 寫 ledger 事件、通知人、推到明確的等人狀態（不再靜默遺棄）', async () => {
    seedTask('T-1', 'g_loop', 'queued');
    seedGroup('g_loop', 'failed', ['T-1']);
    const notif = fakeNotifier();
    const dispatcher = new Dispatcher(4, async (g) => { tmp.ledger.updateGroupState(g.id, 'failed'); }, createSilentLogger());
    const { orch } = build({ dispatcher, notifier: notif.notifier, maxRequeuePerGroup: 1 });

    for (let i = 0; i < 4; i += 1) await tickAndPlan(orch);

    const events = tmp.ledger.listEvents({ scope: 'group', refId: 'g_loop', kind: 'requeue_exhausted' });
    assert.equal(events.length, 1, '要有稽核事件，而且每個群只寫一次（不可每輪洗版）');
    const problems = notif.events.filter((e) => e.type === 'problem');
    assert.equal(problems.length, 1, '人必須被通知，否則沒人知道有東西卡住');
    assert.equal(
      tmp.ledger.getGroup('g_loop')?.state,
      'changes_requested',
      'failed/forming 會被誤認成「跑完了」或「還在跑」；park 才明確代表等人且可恢復',
    );
  });

  it('requeue 次數落 ledger：daemon 重啟（新 Orchestrator 實例）後不會歸零', async () => {
    seedTask('T-1', 'g_restart', 'queued');
    seedGroup('g_restart', 'failed', ['T-1']);
    const mk = () => {
      const rec = createRecordingLogger();
      const dispatcher = new Dispatcher(4, async (g) => { tmp.ledger.updateGroupState(g.id, 'failed'); }, createSilentLogger());
      return { rec, ...build({ dispatcher, log: rec.logger, maxRequeuePerGroup: 2 }) };
    };

    const first = mk();
    await first.orch.tick();
    await first.orch.tick();

    // 重啟：全新實例，記憶體計數歸零
    const second = mk();
    await second.orch.tick();
    await second.orch.tick();

    const requeues = tmp.ledger.listEvents({ scope: 'group', refId: 'g_restart', kind: 'requeued', limit: 50 });
    assert.equal(requeues.length, 2, '重啟後計數若歸零，被擋下的迴圈會從頭再跑一次');
    assert.ok(second.rec.messages('error').some((m) => m.includes('已達上限')));
  });

  it('人明確要求重跑（retry／澄清答覆）→ 重派預算重置，卡住的群救得回來', async () => {
    seedTask('T-1', 'g_saved', 'queued');
    seedGroup('g_saved', 'failed', ['T-1']);
    const dispatched: string[] = [];
    const dispatcher = new Dispatcher(
      4,
      async (g) => {
        dispatched.push(g.id);
        tmp.ledger.updateGroupState(g.id, 'failed');
      },
      createSilentLogger(),
    );
    const { orch } = build({ dispatcher, maxRequeuePerGroup: 1 });

    await tickAndPlan(orch);
    await tickAndPlan(orch);
    assert.equal(dispatched.length, 1, '先撞上限停手');

    // InboundRouter 收到 Slack 的 retry 指令會寫這則事件 + 把任務放回 queued
    tmp.ledger.logEvent('task', 'T-1', 'control:retry', 'state=queued by=U1');
    tmp.ledger.updateTaskState('T-1', 'queued');
    await tickAndPlan(orch);

    assert.equal(dispatched.length, 2, '人按了 retry 卻沒有任何反應＝上限本身變成新的黑洞');
    assert.equal(tmp.ledger.listEvents({ scope: 'group', refId: 'g_saved', kind: 'requeue_budget_reset' }).length, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 缺陷 1：deps 受阻不可變成無上限、無退避的緊迴圈
// （實測：30 個 tick = 30 次 worktree 建立/刪除，群狀態永遠是 ready）
// ══════════════════════════════════════════════════════════════════════

describe('Orchestrator — 等上游依賴（deps）的退避與計數', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp = createTmpLedger();
  });
  afterEach(() => tmp.cleanup());

  /** 群內任務 blocked:deps、群組 park，並留下 group-runner 會寫的 deps 事件。 */
  function seedDepsParked(id = 'g_deps'): Group {
    tmp.ledger.upsertDiscoveredTask({
      id: `T-${id}`, payloadHash: 'h', repo: 'acme/web', category: 'dev',
      title: '等上游的任務', description: '描述', dependencies: ['T-up'], docRefs: [],
    });
    tmp.ledger.updateTaskState(`T-${id}`, 'queued', { groupId: id });
    tmp.ledger.setBlock(`T-${id}`, 'deps', '依賴未完成：T-up');
    tmp.ledger.upsertGroup({
      id, repo: 'acme/web', branch: `orch/web/${id}`, taskIds: [`T-${id}`], footprint: ['src/a.ts'],
      afterGroups: [], rationale: '', state: 'changes_requested',
    });
    tmp.ledger.logEvent('group', id, 'group_deps_blocked', `T-${id}: 依賴未完成`);
    return tmp.ledger.getGroup(id)!;
  }

  /** 模擬 GroupRunner：被派出後認領又被擋 → 再 park 一次並寫新的 deps 事件。 */
  function blockedRunner(dispatched: string[]) {
    return async (g: Group): Promise<void> => {
      dispatched.push(g.id);
      tmp.ledger.logEvent('group', g.id, 'group_deps_blocked', '認領又被擋');
      tmp.ledger.updateGroupState(g.id, 'changes_requested');
    };
  }

  function build(over: Partial<OrchestratorDeps> = {}) {
    const deps: OrchestratorDeps = {
      poller: idlePoller() as unknown as Poller,
      planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
      dispatcher: new Dispatcher(4, async () => {}, createSilentLogger()),
      ledger: tmp.ledger,
      log: createSilentLogger(),
      ...over,
    };
    return { orch: new Orchestrator(deps, 0.01), deps };
  }

  it('deps 受阻 → 退避期間完全不派工（不再每輪重建 worktree）', async () => {
    const g = seedDepsParked();
    const dispatched: string[] = [];
    const dispatcher = new Dispatcher(4, blockedRunner(dispatched), createSilentLogger());
    // 第 1 次不等 → 立刻重派；第 2 次起要等 baseMs（測試設得夠長，跑 10 輪都不會到期）
    const { orch } = build({ dispatcher, depsBackoff: { baseMs: 60_000 } });

    for (let i = 0; i < 10; i += 1) await tickAndPlan(orch);

    assert.equal(dispatched.length, 1, '10 輪只該派一次；每輪都派＝實測的 worktree 建立/刪除 30 次');
    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'changes_requested', '退避中不可停在 ready（那就是 Dispatcher 的輸入）');
    assert.ok(tmp.ledger.listEvents({ scope: 'group', refId: g.id, kind: 'deps_backoff' }).length > 0, '退避要留稽核，人才知道為什麼沒動');
  });

  it('退避到期 → 自動重派（等的是上游任務，沒有人會來回覆）', async () => {
    seedDepsParked();
    const dispatched: string[] = [];
    const dispatcher = new Dispatcher(4, blockedRunner(dispatched), createSilentLogger());
    const { orch } = build({ dispatcher, depsBackoff: { baseMs: 20 } });

    await tickAndPlan(orch); // 第 1 次：不等，直接重派
    assert.equal(dispatched.length, 1);
    await tickAndPlan(orch); // 第 2 次：進入退避
    assert.equal(dispatched.length, 1);
    await new Promise((r) => setTimeout(r, 30));
    await tickAndPlan(orch);

    assert.equal(dispatched.length, 2, '退避到期後必須自己往前走，否則群組永久卡住');
  });

  it('退避是指數的：連續受阻的等待時間會拉長', async () => {
    const g = seedDepsParked();
    const dispatched: string[] = [];
    const dispatcher = new Dispatcher(4, blockedRunner(dispatched), createSilentLogger());
    const { orch } = build({ dispatcher, depsBackoff: { baseMs: 10, maxMs: 10_000 } });

    for (let i = 0; i < 6; i += 1) {
      await tickAndPlan(orch);
      await new Promise((r) => setTimeout(r, 12)); // 只夠第一格退避到期
    }

    const waits = tmp.ledger
      .listEvents({ scope: 'group', refId: g.id, kind: 'deps_backoff', limit: 50 })
      .map((e) => Number(/(\d+) 秒/.exec(e.detail ?? '')?.[1] ?? -1));
    assert.ok(waits.length >= 2, '要有多次退避紀錄');
    assert.ok(dispatched.length <= 3, `等待時間必須拉長，否則退避退化成固定間隔的迴圈（實派 ${dispatched.length} 次）`);
  });

  it('deps 用的是獨立預算：等上游不會被「失敗重試」的小額度誤殺（D18）', async () => {
    seedDepsParked();
    const dispatched: string[] = [];
    const dispatcher = new Dispatcher(4, blockedRunner(dispatched), createSilentLogger());
    // 一般預算只有 1 次；等上游是合法長等待，不該被它砍掉
    const { orch } = build({ dispatcher, maxRequeuePerGroup: 1, maxDepsRequeuePerGroup: 5, depsBackoff: { baseMs: 0 } });

    for (let i = 0; i < 4; i += 1) await tickAndPlan(orch);

    assert.equal(dispatched.length, 4, '上游可能只是還在等人回答澄清，砍掉等於任務永久遺失');
  });

  it('deps 預算真的耗盡 → 記事件、通知人、留在等人狀態（不會無聲無息地一直重試）', async () => {
    const g = seedDepsParked();
    const dispatched: string[] = [];
    const notif = fakeNotifier();
    const dispatcher = new Dispatcher(4, blockedRunner(dispatched), createSilentLogger());
    const { orch } = build({
      dispatcher, notifier: notif.notifier, maxDepsRequeuePerGroup: 2, depsBackoff: { baseMs: 0 },
    });

    for (let i = 0; i < 6; i += 1) await tickAndPlan(orch);

    assert.equal(dispatched.length, 2, '達上限就停手');
    const exhausted = tmp.ledger.listEvents({ scope: 'group', refId: g.id, kind: 'requeue_exhausted' });
    assert.equal(exhausted.length, 1);
    assert.match(exhausted[0]?.detail ?? '', /等上游/);
    assert.ok(notif.events.some((e) => e.type === 'problem'), '人要知道有群組卡在等上游');
    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'changes_requested');
  });

  it('人已回覆讓任務回 queued → 不必等退避，立刻恢復派工（合法例外的出口）', async () => {
    const g = seedDepsParked();
    const dispatched: string[] = [];
    // 派出後群組由 GroupRunner 接手（forming），這一輪 orchestrator 不再碰它
    const dispatcher = new Dispatcher(
      4,
      async (gr: Group) => {
        dispatched.push(gr.id);
        tmp.ledger.updateGroupState(gr.id, 'forming');
      },
      createSilentLogger(),
    );
    const { orch } = build({ dispatcher, depsBackoff: { baseMs: 60_000 } });

    await tickAndPlan(orch); // 第 1 次重派
    await tickAndPlan(orch); // 群組在 GroupRunner 手上，沒有新的 deps 事件
    tmp.ledger.updateGroupState(g.id, 'changes_requested');
    tmp.ledger.clearBlock(`T-${g.id}`, 'queued'); // 上游完成／人回覆 → 任務可跑了
    await tickAndPlan(orch);

    assert.equal(dispatched.length, 2, '任務已經可以跑了還被退避擋著＝誤殺');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 狀態黑洞盤點：GroupState 的每個非終態都要有推進者（見 orchestrator.ts 檔頭語意表）
// ══════════════════════════════════════════════════════════════════════

describe('Orchestrator — 群組狀態黑洞防護', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp = createTmpLedger();
  });
  afterEach(() => tmp.cleanup());

  function seed(id: string, state: GroupState): Group {
    tmp.ledger.upsertDiscoveredTask({
      id: `T-${id}`, payloadHash: `h-${id}`, repo: 'acme/web', category: 'dev',
      title: '做一件事', description: '描述', dependencies: [], docRefs: [],
    });
    tmp.ledger.updateTaskState(`T-${id}`, 'done', { groupId: id });
    tmp.ledger.upsertGroup({
      id, repo: 'acme/web', branch: `orch/web/${id}`, taskIds: [`T-${id}`], footprint: ['src/a.ts'],
      afterGroups: [], rationale: '', state, prUrl: 'https://github.com/acme/web/pull/9', prNumber: 9,
    });
    return tmp.ledger.getGroup(id)!;
  }

  function build(over: Partial<OrchestratorDeps> = {}) {
    const dispatched: Group[] = [];
    const deps: OrchestratorDeps = {
      poller: idlePoller() as unknown as Poller,
      planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
      dispatcher: new Dispatcher(4, async (g) => { dispatched.push(g); }, createSilentLogger()),
      ledger: tmp.ledger,
      log: createSilentLogger(),
      // 這批測試驗的是 tick 的主流程，不是靜置期；關掉才不會被預設的 15 分鐘擋住
      // （靜置期本身另有專門的測試檔 quiet-period.test.ts / 本檔末段）。
      quietMinutesOf: () => 0,
      ...over,
    };
    return { orch: new Orchestrator(deps, 0.01), dispatched, deps };
  }

  /**
   * pr_open / in_review 的唯一推進者是 ReviewWatcher。沒接線是刻意的降級（不開 PR 的
   * 使用者不該被強迫接線），但「卡住」與「正常跑」在外觀上一模一樣 —— 必須點名，
   * 否則使用者會以為任務還在進行中。
   */
  it('未接 ReviewWatcher → 點名卡在等審查的群組（每群只講一次，不洗版）', async () => {
    seed('g_review', 'in_review');
    seed('g_pr', 'pr_open');
    const rec = createRecordingLogger();
    const { orch } = build({ log: rec.logger });

    await tickAndPlan(orch);
    await tickAndPlan(orch);
    await tickAndPlan(orch);

    const warns = rec.records.filter((r) => typeof r.msg === 'string' && r.msg.includes('未接 ReviewWatcher'));
    assert.equal(warns.length, 2, '兩個群各點名一次');
    assert.deepEqual(warns.map((r) => r.group).sort(), ['g_pr', 'g_review']);
    assert.deepEqual(warns.map((r) => r.state).sort(), ['in_review', 'pr_open']);
  });

  it('已有核准憑證的群組不算黑洞（合併佇列會接手）→ 不點名', async () => {
    const g = seed('g_ok', 'in_review');
    const rec = createRecordingLogger();
    const { orch } = build({ log: rec.logger });

    orch.recordMergeApproval(g.id, 'cli:alice');
    await tickAndPlan(orch);

    assert.equal(rec.records.filter((r) => typeof r.msg === 'string' && r.msg.includes('未接 ReviewWatcher')).length, 0);
  });

  it('有接 ReviewWatcher → 不點名（它就是推進者）', async () => {
    seed('g_review', 'in_review');
    const rec = createRecordingLogger();
    const { orch } = build({ log: rec.logger, reviewWatcher: fakeWatcher([[]]) });

    await tickAndPlan(orch);

    assert.equal(rec.records.filter((r) => typeof r.msg === 'string' && r.msg.includes('未接 ReviewWatcher')).length, 0);
  });
});

// ── 靜置期閘門（tick 第 3 步之前） ──

describe('Orchestrator — 靜置期閘門', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp = createTmpLedger();
  });
  afterEach(() => tmp.cleanup());
  const MIN = 60_000;

  function build(poller: FakePoller, quietMinutes: number) {
    const dispatched: Group[] = [];
    const deps: OrchestratorDeps = {
      poller: asPoller(poller),
      planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
      dispatcher: new Dispatcher(4, async (g) => { dispatched.push(g); }, createSilentLogger()),
      ledger: tmp.ledger,
      log: createSilentLogger(),
      quietMinutesOf: () => quietMinutes,
    };
    return { orch: new Orchestrator(deps, 0.01), dispatched };
  }

  /**
   * 這條守的是需求本身：人還在陸續建任務時開工 = 半成品 PR。
   * 任務必須**留在 discovered**，下一輪還能再判一次（不是失敗、不是丟掉）。
   */
  it('任務板剛有動作 → 本輪不分群，任務留在 discovered', async () => {
    const { orch, dispatched } = build(
      fakePoller(tmp, [[{ id: 'T-1', sourceUpdatedAt: Date.now() - 2 * MIN }]]),
      15,
    );

    await tickAndPlan(orch);

    assert.equal(tmp.ledger.listGroupsByState('ready').length, 0, '不該建群');
    assert.equal(dispatched.length, 0, '不該派工');
    assert.deepEqual(tmp.ledger.listTasksByState('discovered').map((t) => t.id), ['T-1'], '任務原地等下一輪');
  });

  it('靜置期滿 → 下一輪自動放行（不需任何人介入）', async () => {
    const { orch } = build(fakePoller(tmp, [[{ id: 'T-1', sourceUpdatedAt: Date.now() - 20 * MIN }]]), 15);

    await tickAndPlan(orch);

    assert.equal(tmp.ledger.listGroupsByState('ready').length, 1);
    assert.equal(tmp.ledger.listTasksByState('discovered').length, 0);
  });

  /** 同系列任務分批出現時，要等到最後一批也靜置，才會一起分群成**一個** PR。 */
  it('分批出現的同系列任務 → 靜置後一次分群，不會拆成兩個 PR', async () => {
    const now = Date.now();
    const { orch } = build(
      fakePoller(tmp, [
        [{ id: 'T-1', docRefs: ['spec/a.md#x'], sourceUpdatedAt: now - 1 * MIN }],
        [{ id: 'T-2', docRefs: ['spec/a.md#x'], sourceUpdatedAt: now - 1 * MIN }],
      ]),
      15,
    );

    await tickAndPlan(orch); // T-1 出現，太新 → 等
    assert.equal(tmp.ledger.listGroupsByState('ready').length, 0);

    await tickAndPlan(orch); // T-2 出現，仍太新 → 還是等
    assert.equal(tmp.ledger.listGroupsByState('ready').length, 0);
    assert.equal(tmp.ledger.listTasksByState('discovered').length, 2);
  });
});

/**
 * 真實 Poller + 真實 Planner + 真實靜置期閘門，只有 MCP 是假的。
 *
 * 為什麼要多這一條：上面那組用 fakePoller 直接把 sourceUpdatedAt 寫進 ledger，
 * 等於跳過「MCP 回 ISO 字串 → 解析 → 落地」這一段。真實鏈路上最容易錯的就是那裡
 * （解析失敗會靜默退化成 undefined，靜置期就永遠是通的，而測試照樣全綠）。
 */
describe('Orchestrator — 靜置期（真實 Poller + MCP 時間戳）', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp = createTmpLedger();
  });
  afterEach(() => tmp.cleanup());

  function mcpWith(iso: string) {
    const t = {
      id: 'T-1', title: '任務', status: 'todo' as const, repo: 'acme/web', category: 'dev' as const,
      description: '描述', dependencies: [], docRefs: [],
      createdAt: Date.parse(iso), updatedAt: Date.parse(iso),
    };
    return {
      async listTasks() { return [t]; },
      async getTask() { return t; },
    };
  }

  function orchWith(client: ReturnType<typeof mcpWith>) {
    const dispatched: Group[] = [];
    const orch = new Orchestrator({
      poller: new Poller([{ client, repo: 'acme/web', mine: true }], tmp.ledger, createSilentLogger()),
      planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
      dispatcher: new Dispatcher(2, async (g) => { dispatched.push(g); }, createSilentLogger()),
      ledger: tmp.ledger,
      log: createSilentLogger(),
      quietMinutesOf: () => 15,
    }, 0.01);
    return { orch, dispatched };
  }

  it('MCP 說任務是 2 分鐘前建的 → 擋下', async () => {
    const { orch, dispatched } = orchWith(mcpWith(new Date(Date.now() - 2 * 60_000).toISOString()));
    await tickAndPlan(orch);
    assert.equal(dispatched.length, 0);
    assert.equal(tmp.ledger.getTask('T-1')?.state, 'discovered');
  });

  it('MCP 說任務是昨天建的 → 立刻放行（重啟後不必空等 15 分鐘）', async () => {
    const { orch, dispatched } = orchWith(mcpWith(new Date(Date.now() - 24 * 60 * 60_000).toISOString()));
    await tickUntilDispatched(orch);
    assert.equal(dispatched.length, 1);
    assert.equal(tmp.ledger.getTask('T-1')?.state, 'queued');
  });
});

// ── 花費上限 ──

describe('Orchestrator — 花費上限', () => {
  let tmp: TmpLedger;
  beforeEach(() => { tmp = createTmpLedger(); });
  afterEach(() => tmp.cleanup());

  function build(verdict: () => BudgetVerdict, over: Partial<OrchestratorDeps> = {}) {
    const dispatched: Group[] = [];
    const notices: string[] = [];
    const deps: OrchestratorDeps = {
      poller: asPoller({ calls: 0, async pollOnce() { return []; } }),
      planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
      dispatcher: new Dispatcher(4, async (g) => { dispatched.push(g); }, createSilentLogger()),
      ledger: tmp.ledger,
      log: createSilentLogger(),
      quietMinutesOf: () => 0,
      budget: verdict,
      // 與真實 SlackGateway 同形狀：系統層訊息走 notice，不是 event
      notifier: { event: () => {}, notice: async (t: string) => void notices.push(t) },
      ...over,
    };
    return { orch: new Orchestrator(deps, 0.01), dispatched, notices };
  }

  const usage = (ratio: number) => ({ period: 'daily' as const, limitUsd: 10, spentUsd: 10 * ratio, ratio });
  const ok = (): BudgetVerdict => ({ ok: true, exceeded: [], warning: [], all: [usage(0.2)] });
  const over = (): BudgetVerdict => ({ ok: false, exceeded: [usage(1.2)], warning: [], all: [usage(1.2)] });
  const warn = (): BudgetVerdict => ({ ok: true, exceeded: [], warning: [usage(0.85)], all: [usage(0.85)] });

  function seedReady(id: string): void {
    tmp.ledger.upsertGroup({
      id, repo: 'acme/web', branch: `orch/web/${id}`, taskIds: [], footprint: ['src/a.ts'],
      afterGroups: [], rationale: '', state: 'ready',
    });
  }

  it('未超限 → 照常派工', async () => {
    seedReady('g1');
    const { orch, dispatched } = build(ok);
    await tickAndPlan(orch);
    assert.equal(dispatched.length, 1);
  });

  /**
   * 刻意只擋「派新的」：進行中那一輪的錢已經花掉了，砍掉只是把錢丟掉還留下半成品。
   * 所以最多超支一個群組的量，而且會停在乾淨的狀態。
   */
  it('超過上限 → 不派新群組，並留下可查的事件', async () => {
    seedReady('g1');
    const { orch, dispatched } = build(over);
    await tickAndPlan(orch);
    assert.equal(dispatched.length, 0);
    assert.ok(tmp.ledger.hasEvent('system', null, 'budget_blocked'));
  });

  /**
   * 15 秒一輪的話，撞到上限後的剩餘時間就是約 5760 筆一模一樣的事件。
   * 事件表是待辦清單與摩擦彙總在讀的地方，被同一句話灌爆等於把要看的東西藏起來。
   */
  it('連續幾輪都超限，事件只記一次（不是每輪一筆）', async () => {
    seedReady('g1');
    const { orch, dispatched } = build(over);
    await tickAndPlan(orch);
    await tickAndPlan(orch);
    await tickAndPlan(orch);
    assert.equal(dispatched.length, 0);
    const blocked = tmp.ledger.listEvents().filter((e) => e.kind === 'budget_blocked');
    assert.equal(blocked.length, 1, `budget_blocked 應該只有一筆，實際 ${blocked.length}`);
  });

  it('越過警戒線仍然派工，但要通知', async () => {
    seedReady('g1');
    const { orch, dispatched, notices } = build(warn);
    await tickAndPlan(orch);
    assert.equal(dispatched.length, 1, '警戒不是煞車');
    assert.equal(notices.length, 1);
  });

  /** 每輪都通知的話，人會在半小時內收到上百則，然後把整個頻道靜音。 */
  it('同一週期只通知一次（跨重啟也是——去重鍵在 ledger）', async () => {
    seedReady('g1');
    const first = build(warn);
    await first.orch.tick();
    await first.orch.tick();
    assert.equal(first.notices.length, 1, '同一個 Orchestrator 內不重複');

    // 換一個 Orchestrator（模擬重啟）：ledger 還在，所以仍然不該再通知
    const second = build(warn);
    await second.orch.tick();
    assert.equal(second.notices.length, 0, '重啟後也不該重發');
  });

  it('超限與警戒是不同的通知（都會各發一次）', async () => {
    seedReady('g1');
    const { orch, notices } = build(() => ({ ok: false, exceeded: [usage(1.1)], warning: [], all: [usage(1.1)] }));
    await tickAndPlan(orch);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /暫停派出新群組/);
  });

  /** 監控壞掉就停產是最糟的失敗模式：算不出預算時應該照常運作。 */
  it('預算計算丟例外 → 本輪不擋，只留 warn', async () => {
    seedReady('g1');
    const rec = createRecordingLogger();
    const { orch, dispatched } = build(() => { throw new Error('DB 忙碌'); }, { log: rec.logger });
    await tickAndPlan(orch);
    assert.equal(dispatched.length, 1);
    assert.ok(rec.messages('warn').some((m) => m.includes('花費上限計算失敗')));
  });

  it('通知管道壞掉不影響煞車本身', async () => {
    seedReady('g1');
    const { orch, dispatched } = build(over, {
      // 非同步 rejection：實跑時就是這個沒被接住，把整個 daemon 殺掉
      notifier: { event: () => {}, notice: async () => { throw new Error('Slack 掛了'); } },
    });
    await tickAndPlan(orch);
    assert.equal(dispatched.length, 0, '通知失敗不該讓超限的群組被派出去');
  });

  it('未注入 budget → 完全不限制', async () => {
    seedReady('g1');
    const dispatched: Group[] = [];
    const orch = new Orchestrator({
      poller: asPoller({ calls: 0, async pollOnce() { return []; } }),
      planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
      dispatcher: new Dispatcher(4, async (g) => { dispatched.push(g); }, createSilentLogger()),
      ledger: tmp.ledger,
      log: createSilentLogger(),
      quietMinutesOf: () => 0,
    }, 0.01);
    await tickAndPlan(orch);
    assert.equal(dispatched.length, 1);
  });
});

// ── 核准憑證的持久性 ──

/**
 * D17 說「狀態不等於核准，合併需要核准憑證」——這是對的。但憑證原本只放在
 * Orchestrator 的記憶體 Map 裡，於是三條路都是壞的，而且壞得很安靜（人以為核准了）：
 *   · CLI 核准是另一個行程，憑證傳不到 daemon
 *   · 獨立執行的控制台同理
 *   · daemon 重啟 ⇒ 重啟前的核准全部消失
 */
describe('Orchestrator — 核准憑證要跨行程與跨重啟', () => {
  let tmp: TmpLedger;
  beforeEach(() => { tmp = createTmpLedger(); });
  afterEach(() => tmp.cleanup());

  function seedForMerge(id: string): void {
    tmp.ledger.upsertGroup({
      id, repo: 'acme/web', branch: `orch/web/${id}`, taskIds: [], footprint: [],
      afterGroups: [], rationale: '', state: 'merge_guard',
      prUrl: 'https://github.com/acme/web/pull/1', prNumber: 1,
    });
  }

  /** 沿用檔案上方既有的 fakeMerge／fakeGateway，避免另造一套語意不同的假件。 */
  function build(over: Partial<OrchestratorDeps> = {}) {
    const m = fakeMerge();
    const gw = fakeGateway();
    const deps: OrchestratorDeps = {
      poller: asPoller({ calls: 0, async pollOnce() { return []; } }),
      planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
      dispatcher: new Dispatcher(2, async () => {}, createSilentLogger()),
      ledger: tmp.ledger,
      log: createSilentLogger(),
      quietMinutesOf: () => 0,
      gateway: gw.gateway,
      merge: m.deps,
      ...over,
    };
    return { orch: new Orchestrator(deps, 0.01), asked: gw.asks, merged: m.merges };
  }

  it('同一個 Orchestrator 內：核准 → 合併', async () => {
    seedForMerge('g1');
    const a = build();
    a.orch.recordMergeApproval('g1', 'alice', 'human');
    await a.orch.tick();
    assert.equal(a.merged.length, 1);
    assert.equal(a.merged[0]?.approvedBy, 'alice');
  });

  it('核准後重啟（換一個 Orchestrator）→ 憑證仍在，照樣合併', async () => {
    seedForMerge('g1');
    build().orch.recordMergeApproval('g1', 'alice', 'human');

    const after = build(); // 模擬重啟：記憶體是空的，只剩 ledger
    await after.orch.tick();

    assert.equal(after.merged.length, 1, '重啟不該讓核准消失');
    assert.equal(after.merged[0]?.approvedBy, 'alice');
    assert.equal(after.asked.length, 0, '有憑證就不該再去問人');
  });

  it('別的行程（CLI／控制台）寫的憑證，daemon 認得', async () => {
    seedForMerge('g1');
    // CLI 走 InboundRouter，最終寫的就是這筆事件
    tmp.ledger.logEvent('group', 'g1', 'merge_credential', JSON.stringify({ approvedBy: 'human:cli', source: 'human' }));

    const d = build();
    await d.orch.tick();

    assert.equal(d.merged[0]?.approvedBy, 'human:cli');
  });

  /** 一次核准只能合併一次；作廢後不可以在下一輪又被撿起來用。 */
  it('合併完成後憑證作廢，不會被重複使用', async () => {
    seedForMerge('g1');
    const a = build();
    a.orch.recordMergeApproval('g1', 'alice', 'human');
    await a.orch.tick();
    assert.equal(a.merged.length, 1);

    // 把群組再推回 merge_guard（模擬後續流程又走到這個狀態）
    tmp.ledger.updateGroupState('g1', 'merge_guard');
    const b = build(); // 重啟：只能靠 ledger 判斷
    await b.orch.tick();

    assert.equal(b.merged.length, 0, '舊憑證已作廢，不可再用');
    assert.equal(b.asked.length, 1, '應改為重新問人');
  });

  it('沒有憑證 → 不合併，改問人', async () => {
    seedForMerge('g1');
    const d = build();
    await d.orch.tick();
    assert.equal(d.merged.length, 0);
    assert.equal(d.asked.length, 1);
  });

  /** 合併不可逆：壞掉的憑證等同沒有憑證，寧可再問一次人。 */
  it('憑證內容壞掉 → 視為未核准', async () => {
    seedForMerge('g1');
    tmp.ledger.logEvent('group', 'g1', 'merge_credential', '這不是 JSON');
    const d = build();
    await d.orch.tick();
    assert.equal(d.merged.length, 0);
    assert.equal(d.asked.length, 1);
  });

  it('憑證缺 approvedBy → 視為未核准（approvedBy 是稽核的唯一依據）', async () => {
    seedForMerge('g1');
    tmp.ledger.logEvent('group', 'g1', 'merge_credential', JSON.stringify({ source: 'human' }));
    const d = build();
    await d.orch.tick();
    assert.equal(d.merged.length, 0);
  });
});

// ── 待處理事項的定期提醒 ──

/**
 * 核准請求與澄清問題都是「發生當下推一次」。那一則沒被看到——Slack 剛好斷線、
 * daemon 在那一秒重啟、人當下沒注意——就再也沒有人會提起，群組安靜地卡在原地。
 * 實跑就撞到：政策要求人工核准的訊息在 Slack 尚未啟用時發出，之後群組停在
 * in_review 超過一小時，沒有任何地方會再講一次。
 */
describe('Orchestrator — 待處理事項不會無聲卡住', () => {
  let tmp: TmpLedger;
  beforeEach(() => { tmp = createTmpLedger(); });
  afterEach(() => tmp.cleanup());

  function build(reminderMs: number) {
    const events: LifecycleEvent[] = [];
    const notices: string[] = [];
    const orch = new Orchestrator({
      poller: asPoller({ calls: 0, async pollOnce() { return []; } }),
      planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
      dispatcher: new Dispatcher(2, async () => {}, createSilentLogger()),
      ledger: tmp.ledger,
      log: createSilentLogger(),
      quietMinutesOf: () => 0,
      // 假件要與真實 SlackGateway **同形狀**：event 會用到 task.id，notice 才是系統層。
      // 原本的假件無論傳什麼都不會爆，於是「用 event 送系統通知」這個錯誤永遠測不出來
      // ——實跑時它讓整個 daemon 掛掉。
      notifier: {
        event: (_ts, e, task) => { void task.id; events.push(e); },
        notice: async (text: string) => void notices.push(text),
      },
      pendingReminderMs: reminderMs,
    }, 0.01);
    return { orch, events, notices };
  }

  function seedPending(): void {
    tmp.ledger.upsertDiscoveredTask({
      id: 'T-1', payloadHash: 'h', repo: 'acme/web', category: 'dev',
      title: '要澄清的任務', description: 'd', dependencies: [], docRefs: [],
    });
    tmp.ledger.setBlock('T-1', 'needs_clarification', '要用哪個 API？');
  }

  const reminders = (notices: string[]): string[] => notices.filter((t) => t.includes('在等你處理'));

  it('有待處理事項 → 發出摘要提醒', async () => {
    seedPending();
    const { orch, notices } = build(60_000);
    await tickAndPlan(orch);
    const r = reminders(notices);
    assert.equal(r.length, 1);
    assert.match(r[0]!, /有 1 件事在等你處理/);
    assert.match(r[0]!, /T-1/);
  });

  /** 每輪都提醒的話，人會在半小時內收到上百則，然後學會忽略它。 */
  it('間隔內不重複提醒', async () => {
    seedPending();
    const { orch, notices } = build(60_000);
    await tickAndPlan(orch);
    await tickAndPlan(orch);
    await tickAndPlan(orch);
    assert.equal(reminders(notices).length, 1);
  });

  /** 節流狀態寫在 ledger ⇒ 重啟不該變成「每次啟動都吵一次」。 */
  it('重啟後仍受間隔限制（節流狀態在 ledger）', async () => {
    seedPending();
    const first = build(60_000);
    await first.orch.tick();
    assert.equal(reminders(first.notices).length, 1);

    const second = build(60_000); // 換一個實例 = 模擬重啟
    await second.orch.tick();
    assert.equal(reminders(second.notices).length, 0);
  });

  it('間隔到了會再提醒一次（事情還沒處理就要繼續叫）', async () => {
    seedPending();
    const { orch, notices } = build(1); // 1ms：等同「間隔已過」
    await tickAndPlan(orch);
    await new Promise((r) => setTimeout(r, 5));
    await tickAndPlan(orch);
    assert.equal(reminders(notices).length, 2);
  });

  it('沒有待處理事項 → 完全不吵', async () => {
    const { orch, notices } = build(60_000);
    await tickAndPlan(orch);
    assert.equal(reminders(notices).length, 0);
  });

  it('設 0 = 關閉提醒', async () => {
    seedPending();
    const { orch, notices } = build(0);
    await tickAndPlan(orch);
    assert.equal(reminders(notices).length, 0);
  });

  it('通知管道壞掉不影響 tick 的其他部分', async () => {
    seedPending();
    const orch = new Orchestrator({
      poller: asPoller({ calls: 0, async pollOnce() { return []; } }),
      planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
      dispatcher: new Dispatcher(2, async () => {}, createSilentLogger()),
      ledger: tmp.ledger,
      log: createSilentLogger(),
      quietMinutesOf: () => 0,
      notifier: {
        event: () => { throw new Error('Slack 掛了'); },
        // **非同步 rejection**：實跑時就是這個沒被接住，變成 unhandled rejection 殺掉 daemon
        notice: async () => { throw new Error('Slack 掛了'); },
      },
      pendingReminderMs: 60_000,
    }, 0.01);
    await assert.doesNotReject(() => orch.tick());
  });
});

/**
 * 跨批次的依賴。
 *
 * MCP 認定一個任務 done 的時機是 agent 呼叫 complete_task——那時 PR 才剛開、還沒合併。
 * 中間那段（等人審查，可能好幾小時）前置任務在任務板上已經是「完成」，
 * 但它的程式碼**不在 base 裡**。放行下游就會在一個沒有前置成果的 base 上開工，
 * 做出建立在假設上的東西，而且它自己的 build/test 會全綠。
 */
describe('Orchestrator — 前置任務的成果進 base 了沒', () => {
  let tmp: TmpLedger;
  beforeEach(() => { tmp = createTmpLedger(); });
  afterEach(() => tmp.cleanup());

  function build() {
    const dispatched: Group[] = [];
    const orch = new Orchestrator(
      {
        poller: asPoller({ calls: 0, async pollOnce() { return []; } }),
        planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
        dispatcher: new Dispatcher(4, async (g) => { dispatched.push(g); }, createSilentLogger()),
        ledger: tmp.ledger,
        log: createSilentLogger(),
        quietMinutesOf: () => 0,
      },
      0.01,
    );
    return { orch, dispatched };
  }

  /** 前置任務 up 在 upGroup 群裡；下游任務 down 在自己的 ready 群裡，宣告依賴 up。 */
  function seed(upGroupState: GroupState): void {
    for (const [id, deps] of [['T-up', []], ['T-down', ['T-up']]] as const) {
      tmp.ledger.upsertDiscoveredTask({
        id, payloadHash: `h-${id}`, repo: 'acme/web', category: 'dev',
        title: `任務 ${id}`, description: '描述', dependencies: [...deps], docRefs: [],
      });
    }
    tmp.ledger.upsertGroup({
      id: 'g-up', repo: 'acme/web', branch: 'orch/web/g-up', taskIds: ['T-up'],
      footprint: ['src/up.ts'], afterGroups: [], rationale: '', state: upGroupState,
    });
    tmp.ledger.updateTaskState('T-up', 'done', { groupId: 'g-up' });
    tmp.ledger.upsertGroup({
      id: 'g-down', repo: 'acme/web', branch: 'orch/web/g-down', taskIds: ['T-down'],
      footprint: ['src/down.ts'], afterGroups: [], rationale: '', state: 'ready',
    });
    tmp.ledger.updateTaskState('T-down', 'queued', { groupId: 'g-down' });
  }

  it('前置任務的 PR 還開著等審查 → 下游不派（MCP 說 done，但 base 裡沒有）', async () => {
    seed('in_review');
    const { orch, dispatched } = build();
    await tickAndPlan(orch);
    assert.deepEqual(dispatched.map((g) => g.id), [], '成果還沒進 base，不能開工');
  });

  it('前置群組已合併 → 放行', async () => {
    seed('merged');
    const { orch, dispatched } = build();
    await tickAndPlan(orch);
    assert.deepEqual(dispatched.map((g) => g.id), ['g-down']);
  });

  it('前置群組是 closed（永遠不會 merged）→ 下游死等，直到人放行', async () => {
    seed('closed');
    {
      const { orch, dispatched } = build();
      await tickAndPlan(orch);
      assert.deepEqual(dispatched.map((g) => g.id), [], 'closed 永遠不會進 base，這時放行等於在假前提上開工');
    }
    // 人表態：那一群確實交不出東西，但下游不靠它也做得下去
    releaseDeps(tmp.ledger, { groupId: 'g-up', state: 'closed', blocked: ['g-down'], userId: 'test' });
    {
      const { orch, dispatched } = build();
      await tickAndPlan(orch);
      // **任務層級的閘門也要一起放。** 只接群層級的話，人按了放行、畫面上還是不動——
      // 而那個症狀完全看不出是哪一道在擋。
      assert.deepEqual(dispatched.map((g) => g.id), ['g-down']);
    }
  });

  it('同一群內部的先後不受影響（同一個工作區依序做，成果直接看得到）', async () => {
    tmp.ledger.upsertDiscoveredTask({
      id: 'A', payloadHash: 'ha', repo: 'acme/web', category: 'dev',
      title: 'A', description: '', dependencies: [], docRefs: [],
    });
    tmp.ledger.upsertDiscoveredTask({
      id: 'B', payloadHash: 'hb', repo: 'acme/web', category: 'dev',
      title: 'B', description: '', dependencies: ['A'], docRefs: [],
    });
    tmp.ledger.upsertGroup({
      id: 'g1', repo: 'acme/web', branch: 'orch/web/g1', taskIds: ['A', 'B'],
      footprint: ['src/a.ts'], afterGroups: [], rationale: '', state: 'ready',
    });
    tmp.ledger.updateTaskState('A', 'queued', { groupId: 'g1' });
    tmp.ledger.updateTaskState('B', 'queued', { groupId: 'g1' });

    const { orch, dispatched } = build();
    await tickAndPlan(orch);
    assert.deepEqual(dispatched.map((g) => g.id), ['g1']);
  });

  it('前置任務不在本調度器範圍內 → 這裡不擋（交給 MCP 的認領閘門）', async () => {
    tmp.ledger.upsertDiscoveredTask({
      id: 'T-x', payloadHash: 'hx', repo: 'acme/web', category: 'dev',
      title: 'x', description: '', dependencies: ['別人家的任務'], docRefs: [],
    });
    tmp.ledger.upsertGroup({
      id: 'gx', repo: 'acme/web', branch: 'orch/web/gx', taskIds: ['T-x'],
      footprint: ['src/x.ts'], afterGroups: [], rationale: '', state: 'ready',
    });
    tmp.ledger.updateTaskState('T-x', 'queued', { groupId: 'gx' });

    const { orch, dispatched } = build();
    await tickAndPlan(orch);
    assert.deepEqual(dispatched.map((g) => g.id), ['gx']);
  });
});

/**
 * 階段順序必須按 repo 各自算。
 *
 * 規劃是每個 repo 分開做的，階段編號只在該 repo 內部有意義。跨 repo 共用一份
 * previousStage 的話，A 專案的群會去等 B 專案的群——一個專案卡住就拖死另一個，
 * 而且「前置群只認 merged」之後那會是永久的。
 *
 * 實跑撞到：demo2 的第二階段群組，afterGroups 裡混進了一個 Baolu 的群組 id。
 */
describe('Orchestrator — 多專案的階段順序', () => {
  let tmp: TmpLedger;
  beforeEach(() => { tmp = createTmpLedger(); });
  afterEach(() => tmp.cleanup());

  function run(groups: PlanResult['groups']) {
    const orch = new Orchestrator(
      {
        poller: asPoller({ calls: 0, async pollOnce() { return []; } }),
        planner: { plan: async () => ({ groups, schedule: [] }) } as unknown as Planner,
        dispatcher: new Dispatcher(0, async () => {}, createSilentLogger()), // 併發 0：只建群不派
        ledger: tmp.ledger,
        log: createSilentLogger(),
        quietMinutesOf: () => 0,
      },
      0.01,
    );
    return orch;
  }

  function seedDiscovered(ids: string[], repo: string): void {
    for (const id of ids) {
      tmp.ledger.upsertDiscoveredTask({
        id, payloadHash: `h-${id}`, repo, category: 'dev',
        title: `任務 ${id}`, description: '描述', dependencies: [], docRefs: [],
      });
    }
  }

  const pg = (repo: string, taskIds: string[], stageIndex: number) =>
    ({ repo, taskIds, footprint: [`src/${taskIds[0]}.ts`], rationale: '', stageIndex });

  it('A 專案的第二階段只等 A 專案的第一階段，不等 B 專案的', async () => {
    seedDiscovered(['A1', 'A2'], 'acme/a');
    seedDiscovered(['B1'], 'acme/b');
    await run([pg('acme/a', ['A1'], 0), pg('acme/b', ['B1'], 0), pg('acme/a', ['A2'], 1)]).tick();

    const groups = ['ready', 'forming'].flatMap((s) => tmp.ledger.listGroupsByState(s as never));
    const a1 = groups.find((g) => g.taskIds.includes('A1'))!;
    const b1 = groups.find((g) => g.taskIds.includes('B1'))!;
    const a2 = groups.find((g) => g.taskIds.includes('A2'))!;

    assert.deepEqual(a2.afterGroups, [a1.id], 'A2 只該等 A1');
    assert.ok(!a2.afterGroups.includes(b1.id), '絕不能等別的專案');
    assert.deepEqual(a1.afterGroups, []);
    assert.deepEqual(b1.afterGroups, []);
  });

  /**
   * 階段編號會跳號：repo A 有 stage 0/1/2，repo B 只有 stage 0/2。
   * 中間那一階段沒有 B 的群時，不能把 B 的 previousStage 覆寫成空的，
   * 否則 B 的 stage 2 就不會等 B 的 stage 0。
   */
  it('某一階段沒有該專案的群時，前一階段的等待關係要留著（階段編號會跳號）', async () => {
    seedDiscovered(['A1', 'A2'], 'acme/a');
    seedDiscovered(['B1', 'B2'], 'acme/b');
    await run([pg('acme/a', ['A1'], 0), pg('acme/b', ['B1'], 0), pg('acme/a', ['A2'], 1), pg('acme/b', ['B2'], 2)]).tick();

    const groups = ['ready', 'forming'].flatMap((s) => tmp.ledger.listGroupsByState(s as never));
    const b1 = groups.find((g) => g.taskIds.includes('B1'))!;
    const b2 = groups.find((g) => g.taskIds.includes('B2'))!;
    assert.deepEqual(b2.afterGroups, [b1.id], 'B2 要等 B1（中間那階段沒有 B 的群不該把關係清掉）');
  });
});

/**
 * 守衛的保證是「rebase 到最新 base 重跑驗證通過」——那句話只對**當時那個 base** 成立。
 *
 * 同 repo 的合併由 repo 鎖序列化，所以我們自己不會插隊。這一項擋的是
 * **鎖看不到的合併**：人在 GitHub 上自己按合併、或別的工具動了 base。
 */
describe('Orchestrator — 合併前確認 base 沒被外部動過', () => {
  let tmp: TmpLedger;
  beforeEach(() => { tmp = createTmpLedger(); });
  afterEach(() => tmp.cleanup());

  function seedApproved(): Group {
    tmp.ledger.upsertGroup({
      id: 'g1', repo: 'acme/web', branch: 'orch/web/g1', taskIds: [],
      footprint: [], afterGroups: [], rationale: '', state: 'merge_guard', prNumber: 42,
    });
    return tmp.ledger.getGroup('g1')!;
  }

  function build(currentBaseSha: () => Promise<string | undefined>, guardSha = 'sha-verified') {
    const merges: unknown[] = [];
    const orch = new Orchestrator(
      {
        poller: asPoller({ calls: 0, async pollOnce() { return []; } }),
        planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
        dispatcher: new Dispatcher(4, async () => {}, createSilentLogger()),
        ledger: tmp.ledger,
        log: createSilentLogger(),
        quietMinutesOf: () => 0,
        reviewWatcher: fakeWatcher([[{ type: 'approved', group: 'g1', approvedBy: 'bob' }]]),
        merge: {
          resolveProject: () => ({ repoPath: '/r', sourceRepoPath: '/r', baseBranch: 'main', verifierConfig: {} }),
          guardFor: () => ({ attempt: async () => ({ ok: true as const, baseSha: guardSha }) }),
          pr: { merge: async (i: unknown) => { merges.push(i); return { ok: true as const }; } },
          currentBaseSha,
        },
      } as never,
      0.01,
    );
    return { orch, merges };
  }

  it('base 沒動 → 照常合併', async () => {
    seedApproved();
    const { orch, merges } = build(async () => 'sha-verified');
    await tickAndPlan(orch);
    assert.equal(merges.length, 1);
    assert.equal(tmp.ledger.getGroup('g1')?.state, 'merged');
  });

  it('base 被動過 → 本輪不合併，留下可查的事件（下一輪重跑守衛）', async () => {
    seedApproved();
    const { orch, merges } = build(async () => 'sha-someone-else-merged');
    await tickAndPlan(orch);
    assert.deepEqual(merges, [], '守衛驗的那個世界已經不存在，不能就這樣合併');
    assert.notEqual(tmp.ledger.getGroup('g1')?.state, 'merged');
    assert.equal(
      tmp.ledger.listEvents({ scope: 'group', refId: 'g1', kind: 'base_moved' }).length,
      1,
      '要留紀錄，否則「為什麼這輪沒合併」查不到',
    );
  });

  it('讀不到 remote 狀態（離線／無 remote）→ 不亂擋', async () => {
    seedApproved();
    const { orch, merges } = build(async () => undefined);
    await tickAndPlan(orch);
    assert.equal(merges.length, 1);
  });
});

/**
 * 專案暫時不可用（使用者停用了、正在編輯、MCP 一時連不上）時，該專案的群組
 * **只是不派工**，狀態完全不動——每一種原因都會自己好。
 *
 * 實跑撞到：使用者建立專案後停用去檢查設定，群組被派出去 → GroupRunner 找不到專案
 * → 標 failed → 每 15 秒重派一次 → 3 次用完 requeue_exhausted。回來時
 * 3 個群組（13 個任務）已經被系統自己判死，而成果是零。
 */
describe('Orchestrator — 專案不可用時暫不派工', () => {
  let tmp: TmpLedger;
  beforeEach(() => { tmp = createTmpLedger(); });
  afterEach(() => tmp.cleanup());

  function build(available: boolean) {
    const dispatched: Group[] = [];
    const rec = createRecordingLogger();
    const orch = new Orchestrator(
      {
        poller: asPoller({ calls: 0, async pollOnce() { return []; } }),
        planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
        dispatcher: new Dispatcher(4, async (g) => { dispatched.push(g); }, createSilentLogger()),
        ledger: tmp.ledger,
        log: rec.logger,
        quietMinutesOf: () => 0,
        isProjectAvailable: () => available,
      },
      0.01,
    );
    tmp.ledger.upsertGroup({
      id: 'g1', repo: 'acme/web', branch: 'orch/web/g1', taskIds: [],
      footprint: ['src/a.ts'], afterGroups: [], rationale: '', state: 'ready',
    });
    return { orch, dispatched, rec };
  }

  it('專案不可用 → 不派工，且狀態維持 ready（恢復後自動繼續）', async () => {
    const { orch, dispatched } = build(false);
    await tickAndPlan(orch);
    assert.deepEqual(dispatched, []);
    assert.equal(tmp.ledger.getGroup('g1')?.state, 'ready', '絕不可以標 failed——那會燒掉重試預算');
  });

  it('專案可用 → 照常派工', async () => {
    const { orch, dispatched } = build(true);
    await tickAndPlan(orch);
    assert.deepEqual(dispatched.map((g) => g.id), ['g1']);
  });

  it('停用期間每輪都會撞到，但只吵一次', async () => {
    const { orch, rec } = build(false);
    await tickAndPlan(orch);
    await tickAndPlan(orch);
    await tickAndPlan(orch);
    assert.equal(rec.messages('warn').filter((m) => m.includes('專案目前不可用')).length, 1);
  });

  it('未注入 isProjectAvailable → 一律視為可用（舊呼叫端不受影響）', async () => {
    const dispatched: Group[] = [];
    const orch = new Orchestrator(
      {
        poller: asPoller({ calls: 0, async pollOnce() { return []; } }),
        planner: new Planner({ planAgent: fakePlanAgent(), resolveRepoPath: () => '/repo' }),
        dispatcher: new Dispatcher(4, async (g) => { dispatched.push(g); }, createSilentLogger()),
        ledger: tmp.ledger,
        log: createSilentLogger(),
        quietMinutesOf: () => 0,
      },
      0.01,
    );
    tmp.ledger.upsertGroup({
      id: 'g2', repo: 'acme/web', branch: 'orch/web/g2', taskIds: [],
      footprint: [], afterGroups: [], rationale: '', state: 'ready',
    });
    await tickAndPlan(orch);
    assert.deepEqual(dispatched.map((g) => g.id), ['g2']);
  });
});
});
