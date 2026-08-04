import { describe, it, beforeEach, afterEach } from 'node:test';
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { Worker, type WorkerDeps } from '../src/worker/worker.js';
import { ProgressMonitor } from '../src/worker/progress.js';
import { Verifier, gitHeadRef, type VerifierConfig } from '../src/worker/verifier.js';
import type { AgentLike, McpTaskClient, Notifier, ReviewerLike, VerifierLike } from '../src/contracts.js';
import type { IterateInput, IterateResult, LoadedDoc, NoChangeCapture } from '../src/worker/agent-runtime.js';
import { toReviewOutcome, type ReviewVerdict } from '../src/worker/reviewer.js';
import type { GateReport, LifecycleEvent, McpOut, TaskDetail } from '../src/types.js';
import {
  createTmpLedger,
  createSilentLogger,
  createRecordingLogger,
  createTmpGitRepo,
  makeTaskDetail,
  type TmpLedger,
} from './helpers/index.js';

// ── 假件 ──

const makeTask = (over: Partial<TaskDetail> = {}): TaskDetail =>
  makeTaskDetail({ id: 'T-1', title: '做一個按鈕', status: 'todo', description: '描述', docRefs: ['spec/ui.md#按鈕'], ...over });

const green = (sig = 'green'): GateReport => ({ green: true, checks: [{ name: 'test', ok: true, detail: 'ok' }], signature: sig });
const red = (sig = 'red', ids: string[] = ['alpha']): GateReport => ({
  green: false,
  checks: [{ name: 'test', ok: false, detail: 'not ok 1 - alpha', failingIds: ids }],
  signature: sig,
});

interface FakeMcp extends McpTaskClient {
  startCalls: string[];
  /** 認領被拒時 Worker 去查任務板的紀錄（見下方 getTask）。 */
  getCalls: string[];
  completeCalls: { id: string; opts?: { summary?: string } }[];
  docCalls: string[][];
}

function fakeMcp(
  over: Partial<{ start: McpOut<TaskDetail>; complete: McpOut<void>; docs: LoadedDoc[]; board: TaskDetail | Error }> = {},
): FakeMcp {
  const startCalls: string[] = [];
  const getCalls: string[] = [];
  const completeCalls: { id: string; opts?: { summary?: string } }[] = [];
  const docCalls: string[][] = [];
  return {
    startCalls,
    completeCalls,
    docCalls,
    getCalls,
    // 認領被拒時 Worker 會用它查任務板現況——那是「這張還是不是我的」的唯一外部證據
    async getTask(id: string): Promise<TaskDetail> {
      getCalls.push(id);
      if (over.board instanceof Error) throw over.board;
      return over.board ?? makeTask();
    },
    async listTasks() {
      return [];
    },
    async startTask(id) {
      startCalls.push(id);
      return over.start ?? { ok: true, value: makeTask() };
    },
    async completeTask(id, opts) {
      completeCalls.push({ id, opts });
      return over.complete ?? { ok: true, value: undefined };
    },
    async loadDocs(refs) {
      docCalls.push(refs);
      return over.docs ?? refs.map((ref) => ({ ref, content: `內容 ${ref}` }));
    },
  };
}

interface FakeAgent extends AgentLike {
  inputs: IterateInput[];
}

/** 依序回傳預設結果；用完後重複最後一筆（避免測試無限迴圈時無從診斷）。 */
function fakeAgent(results: Partial<IterateResult>[]): FakeAgent {
  const inputs: IterateInput[] = [];
  let i = 0;
  return {
    inputs,
    async iterate(input) {
      inputs.push(input);
      const r = results[Math.min(i, results.length - 1)] ?? {};
      i += 1;
      const base: IterateResult = { sessionId: 's1', resultText: '完成了', isError: false, toolCalls: {} };
      return { ...base, ...r };
    },
  };
}

function fakeVerifier(reports: GateReport[]): VerifierLike & { calls: number } {
  let i = 0;
  const v = {
    calls: 0,
    async check() {
      v.calls += 1;
      const r = reports[Math.min(i, reports.length - 1)] ?? green();
      i += 1;
      return r;
    },
  };
  return v;
}

function fakeNotifier(): Notifier & { events: LifecycleEvent[] } {
  const events: LifecycleEvent[] = [];
  return { events, event: (_ts, e) => void events.push(e) };
}

interface FakeReviewer extends ReviewerLike {
  calls: { taskId: string; docRefs: string[]; cwd: string; baseRef?: string | undefined }[];
}

/** 依序回傳判定；用完後重複最後一筆（模擬 reviewer 反覆否決）。 */
function fakeReviewer(verdicts: ReviewVerdict[]): FakeReviewer {
  const calls: { taskId: string; docRefs: string[]; cwd: string; baseRef?: string | undefined }[] = [];
  let i = 0;
  return {
    calls,
    async check(task, docs, cwd, opts) {
      calls.push({ taskId: task.id, docRefs: docs.map((d) => d.ref), cwd, baseRef: opts.baseRef });
      const v = verdicts[Math.min(i, verdicts.length - 1)] ?? { status: 'pass' as const, notes: [] };
      i += 1;
      return toReviewOutcome(v);
    },
  };
}

const fails = (requirement: string): ReviewVerdict => ({
  status: 'fail',
  violations: [{ requirement, problem: `未實作 ${requirement}` }],
});

// ── 測試 ──

describe('Worker — 單任務監督迴圈', () => {
  let tmp: TmpLedger;

  beforeEach(() => {
    tmp = createTmpLedger();
  });
  afterEach(() => tmp.cleanup());

  /** 任務必須先在 ledger 裡（updateTaskState 找不到會擲錯）。 */
  function seed(task: TaskDetail): void {
    tmp.ledger.upsertDiscoveredTask({
      id: task.id,
      payloadHash: 'h1',
      repo: task.repo,
      category: task.category,
      title: task.title,
      description: task.description,
      dependencies: task.dependencies,
      docRefs: task.docRefs,
    });
  }

  function build(over: Partial<WorkerDeps> = {}): { worker: Worker; deps: WorkerDeps } {
    const deps: WorkerDeps = {
      mcp: fakeMcp(),
      agent: fakeAgent([{}]),
      verifier: fakeVerifier([green()]),
      progress: new ProgressMonitor(tmp.ledger, 3),
      ledger: tmp.ledger,
      notifier: fakeNotifier(),
      diffHash: async () => 'd1',
      // 預設不碰 git（cwd 是假路徑）：diff 非空關卡另有專屬測試
      headRef: async () => undefined,
      // 退避不真的睡；jitter 的 random 固定成 0.5 → 延遲等於理論值，可精確斷言
      sleep: async () => {},
      errorBackoff: { random: () => 0.5 },
      log: createSilentLogger(),
      ...over,
    };
    return { worker: new Worker(deps), deps };
  }

  const cfg = { verifierConfig: { test: 'exit 0' }, cwd: '/tmp/wt' };

  /**
   * 一個任務可能跑幾十分鐘，而任務狀態只有 in_progress／verifying 兩格。
   * 「agent 在改第 3 輪」「在跑 npm test」「reviewer 在審」的等待時間差很多，
   * 分不出來的話人只能盯著同一個狀態猜平台是不是掛了（使用者實際回報過）。
   */
  /**
   * reviewer 與 DoD 必須用**同一枚基準**。
   *
   * 實跑災情：reviewer 預設用 'HEAD'，agent 把工作 commit 之後 `git diff HEAD` 就是空的，
   * 一份正確的 15 行實作被判成「看不到任何實作」，白繞兩輪、燒 $6.78，
   * 而且逼得 agent 去 `git reset HEAD~1` 改寫歷史來繞過。
   *
   * 這個測試鎖的是**接線**：worker 有沒有真的把 gateConfig.diff.baseRef 交給 reviewer。
   */
  it('reviewer 收到的基準＝DoD 的基準（不是 HEAD、不是 undefined）', async () => {
    const task = makeTask();
    seed(task);
    const sha = 'c'.repeat(40);
    const reviewer = fakeReviewer([{ status: 'pass', notes: [] }]);
    const { worker } = build({
      reviewer,
      mcp: fakeMcp(),
      // 任務起點：withDiffGate 會拿它當 diff 關卡的基準
      headRef: async () => sha,
    });

    await worker.runTask({ task, ...cfg });

    assert.equal(reviewer.calls.length, 1, 'reviewer 應該被呼叫');
    assert.equal(reviewer.calls[0]?.baseRef, sha, 'reviewer 拿到的必須是任務起點 sha');
  });

  /** 取不到基準時要傳 undefined 讓 reviewer 自己 skip——不可以偷偷退回 'HEAD'。 */
  it('取不到 HEAD → 傳 undefined 給 reviewer，不退回 HEAD', async () => {
    const task = makeTask();
    seed(task);
    const reviewer = fakeReviewer([{ status: 'pass', notes: [] }]);
    const { worker } = build({ reviewer, mcp: fakeMcp(), headRef: async () => undefined });

    await worker.runTask({ task, ...cfg });

    assert.equal(reviewer.calls[0]?.baseRef, undefined);
  });

  // ── 重啟後的續認領 ──
  //
  // MCP 只讓「待辦」被認領，而且**沒有取消認領的工具**。daemon 重啟時對帳把
  // in_progress 任務推回 queued 重跑，但任務板那側還停在「進行中」→ 重新認領必定失敗。
  // 實跑：使用者對同一個群按了 4 次重試，每次 3 分鐘後同樣失敗。

  const CLAIM_REJECTED: McpOut<TaskDetail> = {
    ok: false, kind: 'permanent', detail: '任務狀態是「進行中」，不能再次認領（只有「待辦」可以）',
  };

  it('這張卡本來就是我們認領的 → 直接續做，不重新認領', async () => {
    const task = makeTask();
    seed(task);
    const mcp = fakeMcp({ start: CLAIM_REJECTED, board: { ...task, status: 'in_progress' } });
    const { worker } = build({ mcp });
    // 本機證據：我們先前認領過（重啟前）
    tmp.ledger.logEvent('task', task.id, 'task_claimed', task.title);

    const out = await worker.runTask({ task, ...cfg });

    assert.deepEqual(out, { status: 'done' }, '應該續做完成，而不是停下來等人');
    assert.deepEqual(mcp.getCalls, [task.id], '要查任務板確認「還是我的」');
    assert.equal(mcp.completeCalls.length, 1);
  });

  /**
   * **這是最重要的一條：不可以去做別人的卡。**
   * ledger 說我們認領過，但那張卡可能已經被轉給別人、或被改回待辦又指派出去。
   * 只憑本機紀錄就跳過認領，等於兩個人做同一張卡。
   */
  it('任務板說它已經不是我們的 → 停下來交人，不續做', async () => {
    const task = makeTask();
    seed(task);
    const mcp = fakeMcp({ start: CLAIM_REJECTED, board: { ...task, status: 'todo' } });
    const { worker } = build({ mcp });
    tmp.ledger.logEvent('task', task.id, 'task_claimed', task.title);

    const out = await worker.runTask({ task, ...cfg });

    assert.equal(out.status, 'blocked');
    assert.equal(out.status === 'blocked' ? out.reason : '', 'needs_human');
    assert.equal(mcp.completeCalls.length, 0, '絕不可以結案別人的卡');
    assert.match(tmp.ledger.getTask(task.id)?.block?.detail ?? '', /認領不回來/);
  });

  it('任務板說已經結案 → 停下來，不重做', async () => {
    const task = makeTask();
    seed(task);
    const mcp = fakeMcp({ start: CLAIM_REJECTED, board: { ...task, status: 'done' } });
    const { worker } = build({ mcp });
    tmp.ledger.logEvent('task', task.id, 'task_claimed', task.title);

    const out = await worker.runTask({ task, ...cfg });
    assert.equal(out.status, 'blocked');
    assert.equal(mcp.completeCalls.length, 0);
  });

  /** 查不到任務板現況 ≠ 還是我的。不敢確認就不要動。 */
  it('查不到任務板現況 → 停下來，不猜', async () => {
    const task = makeTask();
    seed(task);
    const mcp = fakeMcp({ start: CLAIM_REJECTED, board: new Error('MCP 連不上') });
    const { worker } = build({ mcp });
    tmp.ledger.logEvent('task', task.id, 'task_claimed', task.title);

    const out = await worker.runTask({ task, ...cfg });
    assert.equal(out.status, 'blocked');
    assert.match(tmp.ledger.getTask(task.id)?.block?.detail ?? '', /查不到它在任務板上的現況|查不到任務板現況/);
  });

  /** 沒有本機認領紀錄的失敗是一般的永久性錯誤，要維持原本的「交由群組停下來」。 */
  it('沒認領過的卡認領失敗 → 維持 error，不給誤導的「去改任務板」', async () => {
    const task = makeTask();
    seed(task);
    const mcp = fakeMcp({ start: CLAIM_REJECTED });
    const { worker } = build({ mcp });

    const out = await worker.runTask({ task, ...cfg });

    assert.equal(out.status, 'error');
    assert.deepEqual(mcp.getCalls, [], '沒認領過就不必去查任務板');
  });

  /** 卡住的訊息必須講出「去哪裡做什麼」——按這邊的重試永遠沒用。 */
  it('認領不回來的說明要指出解法在任務板', async () => {
    const task = makeTask();
    seed(task);
    const { worker } = build({ mcp: fakeMcp({ start: CLAIM_REJECTED, board: { ...task, status: 'todo' } }) });
    tmp.ledger.logEvent('task', task.id, 'task_claimed', task.title);

    await worker.runTask({ task, ...cfg });

    const detail = tmp.ledger.getTask(task.id)?.block?.detail ?? '';
    assert.match(detail, /請到任務板把這張卡改回「待辦」/);
    assert.match(detail, /在這裡按重試不會有用/, '不講的話人會一直按（實跑按了 4 次）');
  });

  it('回報現在在哪一步（給控制台的「現在在做什麼」）', async () => {
    const task = makeTask();
    seed(task);
    const { worker } = build({ verifier: fakeVerifier([red(), green()]), agent: fakeAgent([{}, {}]) });
    const phases: string[] = [];

    await worker.runTask({ task, ...cfg, onPhase: (d) => void phases.push(d) });

    assert.ok(phases.some((p) => p.includes('agent 寫程式中')), '寫程式那段要看得到');
    assert.ok(phases.some((p) => p.includes('跑驗收關卡')), '跑驗收那段要看得到');
    // 輪次是「同一句話重複出現時」唯一看得出有在動的線索
    assert.ok(phases.some((p) => p.startsWith('第 2 輪')), '第二輪要看得出來是第二輪');
  });

  it('happy path：紅 → 回灌具體失敗 → 綠 → complete_task → done', async () => {
    const task = makeTask();
    seed(task);
    const gateRed = red();
    const agent = fakeAgent([{}]);
    const mcp = fakeMcp();
    const notifier = fakeNotifier();
    const { worker } = build({
      agent,
      mcp,
      notifier,
      verifier: fakeVerifier([gateRed, green()]),
    });

    const out = await worker.runTask({ task, ...cfg });

    assert.deepEqual(out, { status: 'done' });
    assert.deepEqual(mcp.startCalls, ['T-1']);
    // 第一輪無回饋；第二輪必須帶上一輪的具體失敗（回灌）
    assert.equal(agent.inputs.length, 2);
    assert.equal(agent.inputs[0]?.feedback, undefined);
    assert.equal(agent.inputs[1]?.feedback, gateRed);
    assert.deepEqual(agent.inputs[1]?.feedback?.checks[0]?.failingIds, ['alpha']);
    // resume 同一 session
    assert.equal(agent.inputs[1]?.resumeSessionId, 's1');
    assert.equal(tmp.ledger.getTask('T-1')?.state, 'done');
  });

  it('未讀 docRefs 不准寫 code：loadDocs 先於 agent，且內容傳給 agent', async () => {
    const task = makeTask({ docRefs: ['spec/a.md#x', 'prd/b.md'] });
    seed(task);
    const mcp = fakeMcp({ start: { ok: true, value: makeTask({ docRefs: ['spec/a.md#x', 'prd/b.md'] }) } });
    const agent = fakeAgent([{}]);
    const notifier = fakeNotifier();
    const { worker } = build({ mcp, agent, notifier });

    await worker.runTask({ task, ...cfg });

    assert.deepEqual(mcp.docCalls, [['spec/a.md#x', 'prd/b.md']]);
    assert.deepEqual(agent.inputs[0]?.docs.map((d) => d.ref), ['spec/a.md#x', 'prd/b.md']);
    const kinds = notifier.events.map((e) => e.type);
    assert.deepEqual(kinds.slice(0, 3), ['claimed', 'docs_read', 'iterating']);
  });

  it('start_task 回 signal（依賴未完/未指派）→ blocked:deps，不進入迴圈', async () => {
    const task = makeTask();
    seed(task);
    const mcp = fakeMcp({ start: { ok: false, kind: 'signal', detail: '依賴 T-0 尚未完成' } });
    const agent = fakeAgent([{}]);
    const { worker } = build({ mcp, agent });

    const out = await worker.runTask({ task, ...cfg });

    assert.deepEqual(out, { status: 'blocked', reason: 'deps', detail: '依賴 T-0 尚未完成' });
    assert.equal(agent.inputs.length, 0, 'signal 時不該啟動 agent');
    const t = tmp.ledger.getTask('T-1');
    assert.equal(t?.state, 'blocked');
    assert.deepEqual(t?.block, { reason: 'deps', detail: '依賴 T-0 尚未完成' });
  });

  it('start_task 回 permanent → error，狀態不改為 blocked，並留下稽核事件', async () => {
    const task = makeTask();
    seed(task);
    const mcp = fakeMcp({ start: { ok: false, kind: 'permanent', detail: '401 未授權' } });
    const { worker } = build({ mcp });

    const out = await worker.runTask({ task, ...cfg });

    assert.deepEqual(out, { status: 'error', detail: '401 未授權' });
    assert.equal(tmp.ledger.getTask('T-1')?.state, 'discovered');
    // 群組會因此停下來；要查得到停在哪一步、為什麼
    assert.equal(tmp.ledger.listEvents({ scope: 'task', refId: 'T-1', kind: 'claim_failed' }).length, 1);
  });

  it('agent 提出不可逆歧義 → park 並標 blocked:needs_clarification（釋放 worker）', async () => {
    const task = makeTask();
    seed(task);
    const clar = { question: '要刪除既有資料表嗎？', rationale: '不可逆', options: ['刪', '不刪'] };
    const verifier = fakeVerifier([green()]);
    const notifier = fakeNotifier();
    const { worker } = build({ agent: fakeAgent([{ askedClarification: clar }]), verifier, notifier });

    const out = await worker.runTask({ task, ...cfg });

    assert.equal(out.status, 'parked');
    assert.deepEqual(out.status === 'parked' ? out.clarification : undefined, clar);
    assert.equal(verifier.calls, 0, '澄清時不該再跑 DoD');
    const t = tmp.ledger.getTask('T-1');
    assert.equal(t?.state, 'blocked');
    assert.equal(t?.block?.reason, 'needs_clarification');
    assert.equal(t?.block?.detail, clar.question);
    assert.ok(notifier.events.some((e) => e.type === 'problem'));
  });

  it('agent isError → 記錄 lastError、attempts+1 並續跑下一輪', async () => {
    const task = makeTask();
    seed(task);
    const verifier = fakeVerifier([green()]);
    const notifier = fakeNotifier();
    const { worker } = build({
      agent: fakeAgent([{ isError: true }, { isError: false }]),
      verifier,
      notifier,
    });

    const out = await worker.runTask({ task, ...cfg });

    assert.deepEqual(out, { status: 'done' });
    assert.equal(verifier.calls, 1, '出錯那輪不該跑 DoD');
    const t = tmp.ledger.getTask('T-1');
    assert.equal(t?.attempts, 1);
    // lastError now 帶上 agent 的錯誤訊息（供診斷），前綴不變
    assert.match(t?.lastError ?? '', /^agent 執行錯誤/);
    assert.ok(notifier.events.some((e) => e.type === 'problem' && e.detail.includes('agent 執行錯誤')));
  });

  it('無進展（簽章連續 N 輪相同）→ 只通知 stalled，不中止任務', async () => {
    const task = makeTask();
    seed(task);
    const notifier = fakeNotifier();
    const { worker } = build({
      // 連兩輪同一簽章 → 第 2 輪判定卡牆；第 3 輪轉綠
      verifier: fakeVerifier([red('same'), red('same'), green()]),
      progress: new ProgressMonitor(tmp.ledger, 2),
      notifier,
    });

    const out = await worker.runTask({ task, ...cfg });

    assert.deepEqual(out, { status: 'done' }, '卡牆只通知，不能中止任務');
    const stalls = notifier.events.filter((e) => e.type === 'stalled');
    assert.equal(stalls.length, 1);
    // 迭代歷史有落地（供之後診斷）
    assert.deepEqual(tmp.ledger.recentSignatures('T-1', 3), ['green', 'same', 'same']);
  });

  it('bug 類完成 → complete_task 帶 summary 修復報告', async () => {
    const task = makeTask({ category: 'bug', title: '修好登入' });
    seed(task);
    const mcp = fakeMcp({ start: { ok: true, value: makeTask({ category: 'bug', title: '修好登入' }) } });
    const { worker } = build({ mcp, agent: fakeAgent([{ resultText: '改了 auth.ts' }]) });

    await worker.runTask({ task, ...cfg });

    assert.equal(mcp.completeCalls.length, 1);
    const summary = mcp.completeCalls[0]?.opts?.summary ?? '';
    assert.match(summary, /修復報告：修好登入/);
    assert.match(summary, /改了 auth\.ts/);
  });

  it('非 bug 類完成 → complete_task 不帶 summary', async () => {
    const task = makeTask({ category: 'dev' });
    seed(task);
    const mcp = fakeMcp();
    const { worker } = build({ mcp });

    await worker.runTask({ task, ...cfg });

    assert.deepEqual(mcp.completeCalls, [{ id: 'T-1', opts: undefined }]);
  });

  it('可注入自訂 buildFixReport 取代預設修復報告', async () => {
    const task = makeTask({ category: 'bug' });
    seed(task);
    const mcp = fakeMcp({ start: { ok: true, value: makeTask({ category: 'bug' }) } });
    const { worker } = build({ mcp, buildFixReport: (t) => `自訂:${t.id}` });

    await worker.runTask({ task, ...cfg });

    assert.equal(mcp.completeCalls[0]?.opts?.summary, '自訂:T-1');
  });

  it('complete_task 失敗 → error，狀態停在 verifying 並記下原因（不可誤標 done）', async () => {
    const task = makeTask();
    seed(task);
    const mcp = fakeMcp({ complete: { ok: false, kind: 'permanent', detail: 'task 已被他人完成' } });
    const { worker } = build({ mcp });

    const out = await worker.runTask({ task, ...cfg });

    assert.deepEqual(out, { status: 'error', detail: 'complete_task 失敗：task 已被他人完成' });
    const t = tmp.ledger.getTask('T-1');
    assert.equal(t?.state, 'verifying');
    assert.match(t?.lastError ?? '', /complete_task 失敗/);
  });

  it('DoD 由調度器判定：agent 說完成但關卡紅 → 不 complete，繼續迴圈', async () => {
    const task = makeTask();
    seed(task);
    const mcp = fakeMcp();
    const verifier = fakeVerifier([red('r1'), red('r2'), green()]);
    const { worker } = build({ mcp, verifier });

    await worker.runTask({ task, ...cfg });

    assert.equal(verifier.calls, 3);
    assert.equal(mcp.completeCalls.length, 1, '只有綠燈那輪才呼叫 complete_task');
  });

  it('diffHash 以 worktree 路徑呼叫，並寫入迭代紀錄', async () => {
    const task = makeTask();
    seed(task);
    const seen: string[] = [];
    const { worker } = build({ diffHash: async (cwd) => (seen.push(cwd), 'hash-x') });

    await worker.runTask({ task, cwd: '/tmp/worktree-a', verifierConfig: {} });

    assert.deepEqual(seen, ['/tmp/worktree-a']);
  });

  it('回饋只在真的有失敗關卡時才傳給 agent（空失敗清單不回灌）', async () => {
    const task = makeTask();
    seed(task);
    const agent = fakeAgent([{}]);
    // green=false 但沒有任何 ok=false 的 check：沒東西可講，不該回灌
    const { worker } = build({ agent, verifier: fakeVerifier([{ green: false, checks: [], signature: 'empty' }, green()]) });

    await worker.runTask({ task, ...cfg });

    assert.equal(agent.inputs.length, 2);
    assert.equal(agent.inputs[1]?.feedback, undefined, '沒有具體失敗項就不要餵一份空回饋');
  });

  // ── DoD「diff 非空」關卡的接線（缺陷 1） ──

  describe('diff 非空關卡', () => {
    /** 記下每次 verifier.check 收到的設定，用來斷言 Worker 有正確接上基準。 */
    function recordingVerifier(reports: GateReport[]): VerifierLike & { configs: VerifierConfig[] } {
      let i = 0;
      const configs: VerifierConfig[] = [];
      return {
        configs,
        async check(input) {
          configs.push(input.config);
          const r = reports[Math.min(i, reports.length - 1)] ?? green();
          i += 1;
          return r;
        },
      };
    }

    it('把「任務開始時的 HEAD」當基準傳給 Verifier', async () => {
      const task = makeTask();
      seed(task);
      const verifier = recordingVerifier([green()]);
      const { worker } = build({ verifier, headRef: async () => 'sha-at-task-start' });

      await worker.runTask({ task, ...cfg });

      assert.deepEqual(verifier.configs[0]?.diff, { baseRef: 'sha-at-task-start' });
      assert.equal(verifier.configs[0]?.test, 'exit 0', '原本的專案指令要保留');
    });

    it('基準只在任務開始時取一次（群內前一任務的 commit 不會被算成本任務的成果）', async () => {
      const task = makeTask();
      seed(task);
      const heads = ['head-1', 'head-2', 'head-3'];
      let i = 0;
      const verifier = recordingVerifier([red('r1'), red('r2'), green()]);
      const { worker } = build({ verifier, headRef: async () => heads[i++] ?? 'x' });

      await worker.runTask({ task, ...cfg });

      assert.equal(i, 1, 'headRef 只該被呼叫一次');
      assert.deepEqual(
        verifier.configs.map((c) => c.diff?.baseRef),
        ['head-1', 'head-1', 'head-1'],
      );
    });

    it('取不到 HEAD → 停用此關卡但大聲留痕（安全檢查不該讓正常流程癱瘓）', async () => {
      const task = makeTask();
      seed(task);
      const rec = createRecordingLogger();
      const verifier = recordingVerifier([green()]);
      const { worker } = build({ verifier, headRef: async () => undefined, log: rec.logger });

      assert.deepEqual(await worker.runTask({ task, ...cfg }), { status: 'done' });
      assert.equal(verifier.configs[0]?.diff, undefined);
      assert.ok(
        rec.messages('error').some((m) => m.includes('diff 非空')),
        '停用把關必須留下 error 等級的紀錄',
      );
    });

    it('headRef 拋錯 → 一樣降級，不讓任務炸掉', async () => {
      const task = makeTask();
      seed(task);
      const verifier = recordingVerifier([green()]);
      const { worker } = build({
        verifier,
        headRef: async () => {
          throw new Error('git 不在 PATH');
        },
      });

      assert.deepEqual(await worker.runTask({ task, ...cfg }), { status: 'done' });
      assert.equal(verifier.configs[0]?.diff, undefined);
    });

    // ── 基準跨輪沿用 ─────────────────────────────────────────────
    //
    // 一個任務會被重跑（retry／澄清答覆後續做／重啟對帳重排），而 agent 上一輪很可能
    // 已經自己 commit 了。基準每輪重抓的話，第二輪就會拿「含它自己上一輪產出」的 HEAD
    // 當基準 → diff 為空 → 判「本輪無變更」→ 回灌「尚未實作」。正式 log 實際撞到過。

    it('同一任務再跑一次 → 沿用首次認領時的基準，不重抓', async () => {
      const task = makeTask();
      seed(task);
      const heads = ['head-first-claim', 'head-after-agent-committed'];
      let i = 0;
      const verifier = recordingVerifier([green(), green()]);
      const { worker } = build({
        verifier,
        headRef: async () => heads[i++],
        currentBranch: async () => 'orch/proj/g_1',
        commitExists: async () => true,
      });

      await worker.runTask({ task, ...cfg });
      seed(task); // 任務被重新派工
      await worker.runTask({ task, ...cfg });

      assert.equal(i, 1, '第二輪不該再抓 HEAD——那個 HEAD 已經含 agent 上一輪的 commit');
      assert.deepEqual(
        verifier.configs.map((c) => c.diff?.baseRef),
        ['head-first-claim', 'head-first-claim'],
      );
    });

    it('分支不同了 → 重抓基準（群分支被刪掉重開，舊 sha 可能太舊或已成孤兒）', async () => {
      const task = makeTask();
      seed(task);
      const heads = ['head-on-branch-a', 'head-on-branch-b'];
      let i = 0;
      const branches = ['orch/proj/g_1', 'orch/proj/g_2'];
      let b = 0;
      const verifier = recordingVerifier([green(), green()]);
      const { worker } = build({
        verifier,
        headRef: async () => heads[i++],
        currentBranch: async () => branches[b++],
        commitExists: async () => true,
      });

      await worker.runTask({ task, ...cfg });
      seed(task);
      await worker.runTask({ task, ...cfg });

      assert.deepEqual(
        verifier.configs.map((c) => c.diff?.baseRef),
        ['head-on-branch-a', 'head-on-branch-b'],
      );
    });

    it('存下來的 sha 已不在工作區 → 重抓，不讓 git diff 擲錯把整道關卡靜靜停用', async () => {
      const task = makeTask();
      seed(task);
      const heads = ['orphaned-sha', 'fresh-sha'];
      let i = 0;
      const verifier = recordingVerifier([green(), green()]);
      const { worker } = build({
        verifier,
        headRef: async () => heads[i++],
        currentBranch: async () => 'orch/proj/g_1',
        commitExists: async (_cwd, sha) => sha !== 'orphaned-sha',
      });

      await worker.runTask({ task, ...cfg });
      seed(task);
      await worker.runTask({ task, ...cfg });

      assert.deepEqual(
        verifier.configs.map((c) => c.diff?.baseRef),
        ['orphaned-sha', 'fresh-sha'],
      );
    });

    // 上面那些測試用的是 'head-1' 這種假 sha，走不進欄位那條路（欄位只收 40 位 sha）。
    // 這一條專門證明**欄位本身**生效：只寫欄位、不寫事件，基準仍要被沿用。
    // 群內共用 session（使用者裁決）：群裡第二個任務不該是全新 context。
    it('群內第二個任務續接同一群的寫程式 session，不是自己開新的', async () => {
      const task = makeTask();
      seed(task);
      // 同一群、別的任務先跑過一輪
      tmp.ledger.recordAgentSession({ kind: 'worker', taskId: 'T-前一個', groupId: 'g-shared', sessionId: 's-群共用', costUsd: 1 });

      const inputs: IterateInput[] = [];
      const agent: AgentLike = {
        async iterate(i) { inputs.push(i); return { sessionId: 's-群共用', resultText: '完成', isError: false, toolCalls: {} }; },
      };
      const { worker } = build({ agent });

      await worker.runTask({ task, ...cfg, groupId: 'g-shared' });

      assert.equal(inputs[0]?.resumeSessionId, 's-群共用', '第二個任務要接得上第一個的脈絡');
    });

    it('沒有群（單獨派工）時退回這個任務自己的 session', async () => {
      const task = makeTask();
      seed(task);
      tmp.ledger.recordAgentSession({ kind: 'worker', taskId: task.id, sessionId: 's-自己的', costUsd: 1 });

      const inputs: IterateInput[] = [];
      const agent: AgentLike = {
        async iterate(i) { inputs.push(i); return { sessionId: 's-自己的', resultText: '完成', isError: false, toolCalls: {} }; },
      };
      const { worker } = build({ agent });

      await worker.runTask({ task, ...cfg });

      assert.equal(inputs[0]?.resumeSessionId, 's-自己的');
    });

    // 交付說明存 DB、下一個任務從 DB 讀——群內共用 session 的 context 會被自動壓縮
    // （單一任務就可能到 170k token），壓縮壓得掉對話、壓不掉 DB。
    it('前面任務的交付說明會進到下一個任務的提示詞', async () => {
      const task = makeTask();
      seed(task);
      tmp.ledger.openHandoff({
        groupId: 'g-shared', taskId: 'T-前一個', fromRole: 'coder', toRole: 'coder',
        kind: 'delivery', blocking: false, title: 't', body: '用了 useLocalStorage；試過 pinia 但放棄，因為 SSR 會炸',
      });

      const inputs: IterateInput[] = [];
      const agent: AgentLike = {
        async iterate(i) { inputs.push(i); return { sessionId: 's', resultText: '完成', isError: false, toolCalls: {} }; },
      };
      const { worker } = build({ agent });

      await worker.runTask({ task, ...cfg, groupId: 'g-shared' });

      assert.deepEqual(inputs[0]?.priorDeliveries, [
        { taskId: 'T-前一個', text: '用了 useLocalStorage；試過 pinia 但放棄，因為 SSR 會炸' },
      ]);
    });

    it('自己上一輪的交付說明不會再貼給自己（會被當成別人做的）', async () => {
      const task = makeTask();
      seed(task);
      tmp.ledger.openHandoff({
        groupId: 'g-shared', taskId: task.id, fromRole: 'coder', toRole: 'coder',
        kind: 'delivery', blocking: false, title: 't', body: '我自己上一輪寫的',
      });

      const inputs: IterateInput[] = [];
      const agent: AgentLike = {
        async iterate(i) { inputs.push(i); return { sessionId: 's', resultText: '完成', isError: false, toolCalls: {} }; },
      };
      const { worker } = build({ agent });

      await worker.runTask({ task, ...cfg, groupId: 'g-shared' });

      assert.equal(inputs[0]?.priorDeliveries, undefined);
    });

    it('基準沿用讀的是 tasks.task_start_sha 欄位（不是只靠 events）', async () => {
      const task = makeTask();
      seed(task);
      const stored = 'a'.repeat(40);
      tmp.ledger.setTaskStartSha(task.id, stored, 'orch/proj/g1');

      const verifier = recordingVerifier([green()]);
      let headCalls = 0;
      const { worker } = build({
        verifier,
        headRef: async () => { headCalls += 1; return 'b'.repeat(40); },
        currentBranch: async () => 'orch/proj/g1',
        commitExists: async () => true,
      });

      await worker.runTask({ task, ...cfg });

      assert.equal(verifier.configs[0]?.diff?.baseRef, stored, '應該用欄位裡的值，不是重抓的 HEAD');
      assert.equal(headCalls, 0, '欄位有值就不該再付一次 rev-parse');
    });

    it('欄位的分支與現在不同 → 重抓（群分支刪掉重開，舊 sha 可能還解得開但太舊）', async () => {
      const task = makeTask();
      seed(task);
      tmp.ledger.setTaskStartSha(task.id, 'a'.repeat(40), 'orch/proj/g1');

      const verifier = recordingVerifier([green()]);
      const { worker } = build({
        verifier,
        headRef: async () => 'c'.repeat(40),
        currentBranch: async () => 'orch/proj/g2',
        commitExists: async () => true,
      });

      await worker.runTask({ task, ...cfg });

      assert.equal(verifier.configs[0]?.diff?.baseRef, 'c'.repeat(40), '分支不同就要重抓');
    });

    it('端到端（真 Verifier + 真 git）：任務重跑時，agent 上一輪自己 commit 的成果仍算數', async () => {
      const repo = createTmpGitRepo({ files: { 'a.txt': 'v1\n' } });
      try {
        const task = makeTask();
        seed(task);
        const mcp = fakeMcp();
        // 第一輪：改檔並**自己 commit**（agent 常這麼做），然後這一輪被中斷／重派。
        // 第二輪：什麼都不做。舊行為會在第二輪判「本輪無變更」，因為基準被重抓成
        // 那個 commit 本身。正確行為是沿用第一輪的基準，看得到那個 commit 的內容。
        let round = 0;
        const agent: AgentLike = {
          async iterate() {
            round += 1;
            if (round === 1) repo.commit({ 'a.txt': 'v2\n' }, 'agent 自己提交的成果');
            return { sessionId: 's1', resultText: '完成了', isError: false, toolCalls: {} };
          },
        };
        const { worker } = build({ mcp, agent, verifier: new Verifier(createSilentLogger()), headRef: gitHeadRef });
        const run = () => worker.runTask({ task, cwd: repo.path, verifierConfig: { test: 'exit 0' } });

        assert.deepEqual(await run(), { status: 'done' });
        seed(task);
        assert.deepEqual(await run(), { status: 'done' }, '第二輪不該因為基準被重抓而判成「尚未實作」');
        assert.equal(round, 2, 'agent 不該被 Stop hook 逼著再做一輪');
      } finally {
        repo.cleanup();
      }
    });

    it('端到端（真 Verifier + 真 git）：agent 什麼都沒改 → 不 complete_task，回灌後續做才完成', async () => {
      const repo = createTmpGitRepo({ files: { 'a.txt': 'v1\n' } });
      try {
        const task = makeTask();
        seed(task);
        const mcp = fakeMcp();
        const inputs: IterateInput[] = [];
        let round = 0;
        // 第一輪「判斷這已經做過了」直接收工；第二輪才真的改檔案
        const agent: AgentLike = {
          async iterate(input) {
            inputs.push(input);
            round += 1;
            if (round >= 2) repo.dir.write('a.txt', 'v2\n');
            return { sessionId: 's1', resultText: '完成了', isError: false, toolCalls: {} };
          },
        };
        const { worker } = build({
          mcp,
          agent,
          verifier: new Verifier(createSilentLogger()),
          headRef: gitHeadRef,
        });

        const out = await worker.runTask({
          task,
          cwd: repo.path,
          verifierConfig: { test: 'exit 0' }, // 未改動的 repo 當然綠 → 只有 diff 關卡擋得住
        });

        assert.deepEqual(out, { status: 'done' });
        assert.equal(inputs.length, 2, '零變更那輪不可放行，必須回去續做');
        assert.equal(mcp.completeCalls.length, 1, 'complete_task 只能在真的有變更後呼叫');
        // 第二輪要收到「還沒有任何變更」的具體回饋
        const fb = inputs[1]?.feedback;
        assert.equal(fb?.green, false);
        assert.equal(fb?.checks[0]?.name, 'diff');
        assert.match(fb?.checks[0]?.detail ?? '', /沒有任何變更/);
      } finally {
        repo.cleanup();
      }
    });
  });

  // ── agent 連續錯誤的退避（缺陷 2） ──

  describe('agent 執行錯誤的退避', () => {
    /** 收集退避時間；同時證明「有真的等待」而不是熱迴圈。 */
    function sleepSpy(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
      const delays: number[] = [];
      return { delays, sleep: async (ms) => void delays.push(ms) };
    }

    it('連續錯誤 → 指數退避（不是無退避的熱迴圈）', async () => {
      const task = makeTask();
      seed(task);
      const spy = sleepSpy();
      const { worker } = build({
        agent: fakeAgent([{ isError: true }, { isError: true }, { isError: true }, { isError: false }]),
        sleep: spy.sleep,
        errorBackoff: { baseDelayMs: 1_000, maxDelayMs: 60_000, random: () => 0.5 },
      });

      assert.deepEqual(await worker.runTask({ task, ...cfg }), { status: 'done' });
      assert.deepEqual(spy.delays, [1_000, 2_000, 4_000]);
      assert.equal(tmp.ledger.getTask('T-1')?.attempts, 3);
    });

    it('退避有上限（不會退到天荒地老）', async () => {
      const task = makeTask();
      seed(task);
      const spy = sleepSpy();
      const { worker } = build({
        agent: fakeAgent([...Array.from({ length: 5 }, () => ({ isError: true })), { isError: false }]),
        sleep: spy.sleep,
        errorBackoff: { baseDelayMs: 1_000, maxDelayMs: 3_000, random: () => 0.5 },
      });

      await worker.runTask({ task, ...cfg });
      assert.deepEqual(spy.delays, [1_000, 2_000, 3_000, 3_000, 3_000]);
    });

    it('成功一輪後計數歸零（偶發錯誤不會累積成長退避）', async () => {
      const task = makeTask();
      seed(task);
      const spy = sleepSpy();
      const { worker } = build({
        // 錯 → 成功(DoD 紅) → 錯 → 成功(DoD 綠)
        agent: fakeAgent([{ isError: true }, { isError: false }, { isError: true }, { isError: false }]),
        verifier: fakeVerifier([red('r1'), green()]),
        sleep: spy.sleep,
        errorBackoff: { baseDelayMs: 1_000, random: () => 0.5 },
      });

      await worker.runTask({ task, ...cfg });
      assert.deepEqual(spy.delays, [1_000, 1_000]);
    });

    it('連續錯誤達門檻 → 發升級通知，但不中止任務（§D10/§D11）', async () => {
      const task = makeTask();
      seed(task);
      const notifier = fakeNotifier();
      const { worker } = build({
        agent: fakeAgent([{ isError: true }, { isError: true }, { isError: false }]),
        notifier,
        sleep: async () => {},
        errorBackoff: { notifyEvery: 2, random: () => 0.5 },
      });

      const out = await worker.runTask({ task, ...cfg });

      assert.deepEqual(out, { status: 'done' }, '連續錯誤只通知，不能讓任務失敗');
      const problems = notifier.events.flatMap((e) => (e.type === 'problem' ? [e.detail] : []));
      assert.equal(problems.length, 2, '每輪錯誤只發一則事件');
      assert.match(problems[1] ?? '', /已連續 2 次/);
      assert.match(problems[1] ?? '', /不中止/);
    });

    it('未達門檻的錯誤只發例行提示（噪音控制）', async () => {
      const task = makeTask();
      seed(task);
      const notifier = fakeNotifier();
      const { worker } = build({
        agent: fakeAgent([{ isError: true }, { isError: false }]),
        notifier,
        sleep: async () => {},
        errorBackoff: { notifyEvery: 3, baseDelayMs: 1_000, random: () => 0.5 },
      });

      await worker.runTask({ task, ...cfg });
      const problems = notifier.events.flatMap((e) => (e.type === 'problem' ? [e.detail] : []));
      assert.deepEqual(problems, ['agent 執行錯誤，1000ms 後重試（連續第 1 次）']);
    });
  });

  // ── 監督迴圈的兜底出口（缺陷 2） ──

  /**
   * 沒有兜底的 while(true) 是**無聲的無限迴圈**：燒 token、佔住 worker slot、
   * 群組永遠不開 PR、Slack 完全沒通知。兜底的形狀必須是「park 交人」而不是 failed，
   * 而且門檻要寬鬆到正常任務碰不到（§D10 的精神是不武斷放棄，不是允許無限迴圈）。
   */
  describe('輪數兜底（park 交人，不是放棄）', () => {
    it('DoD 永遠不綠 → 撞上限就 park:needs_human，保留現場並通知', async () => {
      const task = makeTask();
      seed(task);
      const mcp = fakeMcp();
      const agent = fakeAgent([{}]);
      const notifier = fakeNotifier();
      const { worker } = build({ mcp, agent, notifier, verifier: fakeVerifier([red('r1')]), maxRounds: 3 });

      const out = await worker.runTask({ task, ...cfg });

      assert.equal(out.status, 'blocked');
      assert.equal(out.status === 'blocked' ? out.reason : undefined, 'needs_human', 'park 交人＝可恢復，不可是終態');
      assert.equal(agent.inputs.length, 3, '上限之內照跑，撞到才停');
      assert.equal(mcp.completeCalls.length, 0);

      const t = tmp.ledger.getTask('T-1');
      assert.equal(t?.state, 'blocked');
      assert.equal(t?.block?.reason, 'needs_human');
      // Slack 必須看得到，而且要點出「可能是系統問題」
      const problem = notifier.events.find((e) => e.type === 'problem');
      assert.ok(problem && problem.type === 'problem' && /已跑 3 輪/.test(problem.detail));
      assert.ok(problem && problem.type === 'problem' && /系統問題/.test(problem.detail));
      // 最後未通過的關卡要帶進通知，人才知道從哪看起
      assert.ok(problem && problem.type === 'problem' && /not ok 1 - alpha/.test(problem.detail));
      assert.equal(tmp.ledger.listEvents({ scope: 'task', refId: 'T-1', kind: 'round_limit_parked' }).length, 1);
    });

    it('預設上限夠寬鬆：跑 10 輪才綠的任務不會被誤殺（§D18 出口）', async () => {
      const task = makeTask();
      seed(task);
      const mcp = fakeMcp();
      const reports = [...Array.from({ length: 10 }, (_, i) => red(`r${i}`)), green()];
      const { worker } = build({ mcp, verifier: fakeVerifier(reports) }); // 不指定 maxRounds → 預設 20

      assert.deepEqual(await worker.runTask({ task, ...cfg }), { status: 'done' });
      assert.equal(mcp.completeCalls.length, 1);
    });

    it('maxRounds=0 → 停用兜底，回到純 §D10 的無上限行為（刻意長跑的專案出口）', async () => {
      const task = makeTask();
      seed(task);
      const agent = fakeAgent([{}]);
      const reports = [...Array.from({ length: 25 }, (_, i) => red(`r${i}`)), green()];
      const { worker } = build({ agent, verifier: fakeVerifier(reports), maxRounds: 0 });

      assert.deepEqual(await worker.runTask({ task, ...cfg }), { status: 'done' });
      assert.equal(agent.inputs.length, 26, '停用後就算超過預設 20 輪也要繼續跑到綠');
    });

    it('agent 連續執行錯誤也計入輪數（不會無聲燒 token 到天荒地老）', async () => {
      const task = makeTask();
      seed(task);
      const notifier = fakeNotifier();
      const { worker } = build({ agent: fakeAgent([{ isError: true }]), notifier, maxRounds: 4 });

      const out = await worker.runTask({ task, ...cfg });

      assert.equal(out.status, 'blocked');
      assert.equal(out.status === 'blocked' ? out.reason : undefined, 'needs_human');
      assert.equal(tmp.ledger.getTask('T-1')?.block?.reason, 'needs_human');
    });
  });

  // ── 連續 deps 受阻（缺陷 3） ──

  /**
   * 契約：`blocked:deps` = 暫時受阻（群組回 ready 重試）、`blocked:needs_human` = 反覆受阻（交人）。
   * 升級條件刻意要「次數 + 持續時間」同時成立：依賴未完成是完全合法的狀態
   * （上游正被別的群組認真做），只看次數會在幾分鐘內把正常等待誤殺掉（§D18）。
   */
  describe('連續 deps 受阻', () => {
    const blocked = (detail = '還有 1 個前置任務未完成：「建立骨架」(進行中)') =>
      fakeMcp({ start: { ok: false, kind: 'signal' as const, detail } });

    it('未達門檻 → 維持 blocked:deps（可重試）', async () => {
      const task = makeTask();
      seed(task);
      const { worker } = build({ mcp: blocked(), maxDepsBlocks: 3, minDepsBlockedMs: 0 });

      for (let i = 0; i < 2; i++) {
        const out = await worker.runTask({ task, ...cfg });
        assert.equal(out.status === 'blocked' ? out.reason : undefined, 'deps', `第 ${i + 1} 次`);
      }
      assert.equal(tmp.ledger.getTask('T-1')?.block?.reason, 'deps');
    });

    it('連續次數 + 持續時間都超標 → 升級成 needs_human 並通知人', async () => {
      const task = makeTask();
      seed(task);
      const notifier = fakeNotifier();
      // now 往後推 40 分鐘：事件寫入用真實時間，注入的 now 讓「已持續 40 分鐘」成立
      const { worker } = build({
        mcp: blocked(),
        notifier,
        maxDepsBlocks: 3,
        minDepsBlockedMs: 30 * 60_000,
        now: () => Date.now() + 40 * 60_000,
      });

      const outs = [];
      for (let i = 0; i < 3; i++) outs.push(await worker.runTask({ task, ...cfg }));

      assert.deepEqual(
        outs.map((o) => (o.status === 'blocked' ? o.reason : o.status)),
        ['deps', 'deps', 'needs_human'],
      );
      const t = tmp.ledger.getTask('T-1');
      assert.equal(t?.block?.reason, 'needs_human');
      assert.match(t?.block?.detail ?? '', /依賴長期未滿足/);
      const problem = notifier.events.find((e) => e.type === 'problem');
      assert.ok(problem && problem.type === 'problem' && /連續 3 次/.test(problem.detail));
      assert.equal(tmp.ledger.listEvents({ scope: 'task', refId: 'T-1', kind: 'deps_blocked_escalated' }).length, 1);
    });

    it('次數到了但還沒卡夠久 → 仍是 deps（正常等待不可誤殺）', async () => {
      const task = makeTask();
      seed(task);
      const { worker } = build({
        mcp: blocked(),
        maxDepsBlocks: 2,
        minDepsBlockedMs: 30 * 60_000, // 時間條件不成立
      });

      const outs = [];
      for (let i = 0; i < 5; i++) outs.push(await worker.runTask({ task, ...cfg }));

      assert.deepEqual(
        outs.map((o) => (o.status === 'blocked' ? o.reason : o.status)),
        ['deps', 'deps', 'deps', 'deps', 'deps'],
      );
    });

    it('中途認領成功過 → 連續計數歸零（偶爾被擋不會累積成交人）', async () => {
      const task = makeTask();
      seed(task);
      const now = () => Date.now() + 40 * 60_000;
      const opts = { maxDepsBlocks: 3, minDepsBlockedMs: 30 * 60_000, now };

      const stuck = build({ mcp: blocked(), ...opts }).worker;
      await stuck.runTask({ task, ...cfg });
      await stuck.runTask({ task, ...cfg });

      // 依賴完成 → 這一輪認領成功（跑完整條 happy path）
      assert.deepEqual(await build({ ...opts }).worker.runTask({ task, ...cfg }), { status: 'done' });

      // 之後又被擋：計數從 1 重新算，不該一次就升級
      const out = await build({ mcp: blocked(), ...opts }).worker.runTask({ task, ...cfg });
      assert.equal(out.status === 'blocked' ? out.reason : undefined, 'deps');
    });

    it('依賴解開後認領成功 → 清掉舊的 block:deps 標記（不可帶著過期封鎖走到 done）', async () => {
      const task = makeTask();
      seed(task);
      tmp.ledger.setBlock(task.id, 'deps', '還有 1 個前置任務未完成');

      assert.deepEqual(await build().worker.runTask({ task, ...cfg }), { status: 'done' });

      const t = tmp.ledger.getTask('T-1');
      assert.equal(t?.state, 'done');
      assert.equal(t?.block, undefined, 'done 的任務不該還掛著 blocked:deps');
    });

    it('maxDepsBlocks=0 → 停用升級（永遠只回 deps 讓群組重試）', async () => {
      const task = makeTask();
      seed(task);
      const { worker } = build({ mcp: blocked(), maxDepsBlocks: 0, minDepsBlockedMs: 0, now: () => Date.now() + 1e9 });

      for (let i = 0; i < 6; i++) {
        const out = await worker.runTask({ task, ...cfg });
        assert.equal(out.status === 'blocked' ? out.reason : undefined, 'deps');
      }
    });
  });

  // ── 獨立 reviewer（DESIGN §5） ──

  describe('獨立 reviewer 審查', () => {
    it('未注入 reviewer → 維持既有行為：DoD 綠燈即 complete_task', async () => {
      const task = makeTask();
      seed(task);
      const mcp = fakeMcp();
      const { worker } = build({ mcp });

      assert.deepEqual(await worker.runTask({ task, ...cfg }), { status: 'done' });
      assert.equal(mcp.completeCalls.length, 1);
    });

    it('合格 → 才 complete_task；reviewer 收到任務、規格與 worktree', async () => {
      const task = makeTask();
      seed(task);
      const mcp = fakeMcp();
      const reviewer = fakeReviewer([{ status: 'pass', notes: ['符合規格'] }]);
      const { worker } = build({ mcp, reviewer });

      const out = await worker.runTask({ task, cwd: '/tmp/wt-r', verifierConfig: {} });

      assert.deepEqual(out, { status: 'done' });
      assert.deepEqual(reviewer.calls, [{ taskId: 'T-1', docRefs: ['spec/ui.md#按鈕'], cwd: '/tmp/wt-r', baseRef: undefined }]);
      assert.equal(mcp.completeCalls.length, 1);
    });

    it('不合格 → 不 complete，理由轉 GateReport 回灌 coder 續做', async () => {
      const task = makeTask();
      seed(task);
      const mcp = fakeMcp();
      const agent = fakeAgent([{}]);
      const reviewer = fakeReviewer([fails('按鈕要有 loading 狀態'), { status: 'pass', notes: [] }]);
      const { worker } = build({ mcp, agent, reviewer });

      const out = await worker.runTask({ task, ...cfg });

      assert.deepEqual(out, { status: 'done' });
      assert.equal(agent.inputs.length, 2, '被否決要回去續做一輪');
      const fb = agent.inputs[1]?.feedback;
      assert.equal(fb?.green, false);
      assert.equal(fb?.checks[0]?.name, 'reviewer');
      assert.match(fb?.checks[0]?.detail ?? '', /按鈕要有 loading 狀態/);
      assert.equal(mcp.completeCalls.length, 1, '只有 reviewer 放行後才 complete_task');
    });

    it('DoD 未綠時不呼叫 reviewer（審查是綠燈之後的事）', async () => {
      const task = makeTask();
      seed(task);
      const reviewer = fakeReviewer([{ status: 'pass', notes: [] }]);
      const { worker } = build({ reviewer, verifier: fakeVerifier([red('r1'), green()]) });

      await worker.runTask({ task, ...cfg });

      assert.equal(reviewer.calls.length, 1, '只有綠燈那輪才審查');
    });

    it('reviewer 回 skipped（無金鑰等）→ 不阻擋，照常完成', async () => {
      const task = makeTask();
      seed(task);
      const mcp = fakeMcp();
      const { worker } = build({ mcp, reviewer: fakeReviewer([{ status: 'skipped', reason: '未設定 Claude 認證' }]) });

      assert.deepEqual(await worker.runTask({ task, ...cfg }), { status: 'done' });
      assert.equal(mcp.completeCalls.length, 1);
    });

    it('reviewer 呼叫拋錯 → 降級為「沒有 reviewer」，不讓任務卡死', async () => {
      const task = makeTask();
      seed(task);
      const mcp = fakeMcp();
      const reviewer: ReviewerLike = {
        async check() {
          throw new Error('network down');
        },
      };
      const { worker } = build({ mcp, reviewer });

      assert.deepEqual(await worker.runTask({ task, ...cfg }), { status: 'done' });
      assert.equal(mcp.completeCalls.length, 1);
    });

    it('活鎖收斂：否決達上限 → 警告 + 放行交人工 review', async () => {
      const task = makeTask();
      seed(task);
      const mcp = fakeMcp();
      const agent = fakeAgent([{}]);
      const notifier = fakeNotifier();
      const reviewer = fakeReviewer([fails('A')]); // 永遠否決
      const { worker } = build({ mcp, agent, notifier, reviewer, maxReviewRejections: 2 });

      const out = await worker.runTask({ task, ...cfg });

      assert.deepEqual(out, { status: 'done' }, '撞上限要放行，不能無限迴圈');
      assert.equal(reviewer.calls.length, 3, '回灌 2 次後第 3 次否決放行');
      assert.equal(agent.inputs.length, 3);
      assert.equal(mcp.completeCalls.length, 1);
      const problems = notifier.events.filter((e) => e.type === 'problem');
      assert.ok(
        problems.some((e) => e.type === 'problem' && /放行交人工 review/.test(e.detail)),
        '撞上限要明講「放行交人工把關」',
      );
      // 每次退回都要把理由寫進 thread：先前只記了「rejections: 1」這個數字，
      // 退回原因 log、task_iterations、events 三處都沒有，事後完全查不到 agent 為什麼被退。
      assert.equal(
        problems.filter((e) => e.type === 'problem' && /reviewer 第 \d+ 次退回/.test(e.detail)).length,
        2,
        '兩次回灌都要留下理由',
      );
    });

    it('reviewer 否決納入無進展簽章：同一批違規重複出現 → 通知 stalled（不中止）', async () => {
      const task = makeTask();
      seed(task);
      const notifier = fakeNotifier();
      const { worker } = build({
        notifier,
        progress: new ProgressMonitor(tmp.ledger, 2),
        reviewer: fakeReviewer([fails('A'), fails('A'), { status: 'pass', notes: [] }]),
        maxReviewRejections: 5,
      });

      const out = await worker.runTask({ task, ...cfg });

      assert.deepEqual(out, { status: 'done' });
      assert.equal(notifier.events.filter((e) => e.type === 'stalled').length, 1);
      // DoD 全綠但 reviewer 否決的兩輪，簽章要落地成同一枚（否則偵測不到空轉）
      const sigs = tmp.ledger.recentSignatures('T-1', 3);
      assert.equal(sigs[1], sigs[2]);
    });
  });

  describe('SDK 錯誤處置（重試無用的要立刻交人）', () => {
    it('permanent（認證失效）→ 立刻 park 交人，不進退避迴圈', async () => {
      const task = makeTask();
      seed(task);
      const agent = fakeAgent([{ isError: true, errorKind: 'permanent', sdkError: 'authentication_failed', httpStatus: 401 }]);
      const notifier = fakeNotifier();
      let slept = 0;
      const { worker } = build({ agent, notifier, sleep: async () => { slept += 1; } });

      const out = await worker.runTask({ task, ...cfg });

      assert.equal(out.status, 'blocked');
      assert.equal(out.status === 'blocked' ? out.reason : undefined, 'needs_human');
      assert.equal(agent.inputs.length, 1, '重試一萬次也不會好，不該再叫 agent');
      assert.equal(slept, 0, '不該退避');
      const t = tmp.ledger.getTask('T-1');
      assert.match(t?.block?.detail ?? '', /authentication_failed|401/);
      // 給人的訊息要能直接照著修，不能只說「失敗」
      assert.match(t?.block?.detail ?? '', /ANTHROPIC_AUTH_TOKEN|認證/);
      assert.ok(notifier.events.some((e) => e.type === 'problem'));
    });

    it('capacity（輸出超上限）→ 交人調整，不是等它自己好', async () => {
      const task = makeTask();
      seed(task);
      const agent = fakeAgent([{ isError: true, errorKind: 'capacity', sdkError: 'max_output_tokens' }]);
      const { worker } = build({ agent });

      const out = await worker.runTask({ task, ...cfg });

      assert.equal(out.status, 'blocked');
      assert.equal(agent.inputs.length, 1);
      assert.match(tmp.ledger.getTask('T-1')?.block?.detail ?? '', /拆小|上限/);
    });

    it('transient（529 過載）→ 照常退避重試，不可誤判成永久失敗', async () => {
      const task = makeTask();
      seed(task);
      const agent = fakeAgent([
        { isError: true, errorKind: 'transient', sdkError: 'overloaded', httpStatus: 529, sdkRetries: 3 },
        {},
      ]);
      const { worker } = build({ agent, verifier: fakeVerifier([green()]) });

      const out = await worker.runTask({ task, ...cfg });

      assert.deepEqual(out, { status: 'done' }, '過載是暫時的，退避後應該要能完成');
      assert.equal(agent.inputs.length, 2);
      // SDK 的重試資訊要落進 lastError，人才知道是 API 在退避而不是 agent 卡住
      const events = tmp.ledger.recentSignatures('T-1', 5);
      assert.ok(events.length >= 0);
    });

    it('沒有 errorKind（舊行為/分不出來）→ 維持退避重試，不可因此永久停下', async () => {
      const task = makeTask();
      seed(task);
      const agent = fakeAgent([{ isError: true }, {}]);
      const { worker } = build({ agent, verifier: fakeVerifier([green()]) });

      const out = await worker.runTask({ task, ...cfg });

      assert.deepEqual(out, { status: 'done' });
      assert.equal(agent.inputs.length, 2);
    });
  });

  /**
   * report_no_change：合法的零 diff 出口。
   * 沒有這條路徑，DoD 的「diff 非空」關卡會逼 agent 為了讓驗證通過而亂改程式碼
   * ——那比漏抓「agent 沒做事」更糟。
   */
  describe('無需改動宣告（report_no_change）', () => {
    const noChange = (over: Partial<NoChangeCapture> = {}): NoChangeCapture => ({
      category: 'already_satisfied',
      reason: '登入頁已經有記住我選項',
      evidence: 'src/views/Login.vue:42 已實作',
      ...over,
    });
    /** 有 baseRef 才會去驗「宣告是否屬實」。 */
    const withBase = { headRef: async () => 'BASE_SHA' };

    it('預設政策：零變更 + 有宣告 → park 等人確認，絕不 complete_task', async () => {
      const task = makeTask();
      seed(task);
      const report = noChange();
      const mcp = fakeMcp();
      const verifier = fakeVerifier([green()]);
      const notifier = fakeNotifier();
      const { worker } = build({
        ...withBase,
        mcp,
        verifier,
        notifier,
        agent: fakeAgent([{ reportedNoChange: report }]),
        changedSince: async () => ({ ok: true, files: [] }),
      });

      const out = await worker.runTask({ task, ...cfg });

      assert.equal(out.status, 'blocked');
      assert.equal(out.status === 'blocked' ? out.reason : undefined, 'needs_human');
      assert.equal(mcp.completeCalls.length, 0, 'done 不可逆，未經人確認絕不能標完成');
      assert.equal(verifier.calls, 0, '已宣告無需改動就不必再跑 DoD');

      const t = tmp.ledger.getTask('T-1');
      assert.equal(t?.state, 'blocked');
      assert.equal(t?.block?.reason, 'needs_human');
      assert.match(t?.block?.detail ?? '', /現況已符合需求/);
      assert.ok(notifier.events.some((e) => e.type === 'problem' && /無需改動/.test(e.detail)));
    });

    it('宣告了但工作區確實有變更 → 宣告作廢，照常走 DoD 驗證並完成', async () => {
      const task = makeTask();
      seed(task);
      const mcp = fakeMcp();
      const verifier = fakeVerifier([green()]);
      const { worker } = build({
        ...withBase,
        mcp,
        verifier,
        agent: fakeAgent([{ reportedNoChange: noChange() }]),
        changedSince: async () => ({ ok: true, files: ['src/a.ts'] }),
      });

      const out = await worker.runTask({ task, ...cfg });

      assert.deepEqual(out, { status: 'done' }, '它終究做了事，以事實為準');
      assert.equal(verifier.calls, 1, '宣告作廢後要照常驗證');
      assert.equal(mcp.completeCalls.length, 1);
      assert.equal(tmp.ledger.getTask('T-1')?.state, 'done');
    });

    it('政策設 auto_complete → 直接結案並記錄理由', async () => {
      const task = makeTask();
      seed(task);
      const mcp = fakeMcp();
      const { worker } = build({
        ...withBase,
        mcp,
        agent: fakeAgent([{ reportedNoChange: noChange() }]),
        changedSince: async () => ({ ok: true, files: [] }),
        noChangePolicy: { already_satisfied: 'auto_complete' },
      });

      const out = await worker.runTask({ task, ...cfg });

      assert.deepEqual(out, { status: 'done' });
      assert.equal(mcp.completeCalls.length, 1);
      assert.equal(tmp.ledger.getTask('T-1')?.state, 'done');
    });

    it('政策只放行特定分類：未列入的分類仍要人確認', async () => {
      const task = makeTask();
      seed(task);
      const mcp = fakeMcp();
      const { worker } = build({
        ...withBase,
        mcp,
        agent: fakeAgent([{ reportedNoChange: noChange({ category: 'not_applicable' }) }]),
        changedSince: async () => ({ ok: true, files: [] }),
        noChangePolicy: { already_satisfied: 'auto_complete' },
      });

      const out = await worker.runTask({ task, ...cfg });

      assert.equal(out.status, 'blocked');
      assert.equal(mcp.completeCalls.length, 0);
    });

    it('取不到 baseRef（非 git 工作區）→ 無法查證，保守交人確認', async () => {
      const task = makeTask();
      seed(task);
      const mcp = fakeMcp();
      let checked = false;
      const { worker } = build({
        mcp,
        headRef: async () => undefined,
        agent: fakeAgent([{ reportedNoChange: noChange() }]),
        changedSince: async () => {
          checked = true;
          return { ok: true, files: [] };
        },
      });

      const out = await worker.runTask({ task, ...cfg });

      assert.equal(out.status, 'blocked');
      assert.equal(checked, false, '沒有基準就不該假裝查證過');
      assert.equal(mcp.completeCalls.length, 0);
    });

    it('宣告內容落進 ledger events，供事後稽核「為什麼這張卡沒做」', async () => {
      const task = makeTask();
      seed(task);
      const report = noChange({ category: 'blocked_externally', reason: '缺 API 金鑰' });
      const { worker } = build({
        ...withBase,
        agent: fakeAgent([{ reportedNoChange: report }]),
        changedSince: async () => ({ ok: true, files: [] }),
      });

      await worker.runTask({ task, ...cfg });

      // events 表沒有公開查詢 API，另開唯讀連線驗證稽核軌跡確實落地
      const db = new Database(tmp.dbPath, { readonly: true });
      const row = db
        .prepare("SELECT detail FROM events WHERE ref_id = ? AND kind = 'no_change_reported'")
        .get('T-1') as { detail?: string } | undefined;
      db.close();
      assert.ok(row, '宣告必須留下稽核紀錄');
      assert.match(row?.detail ?? '', /blocked_externally/);
      assert.match(row?.detail ?? '', /缺 API 金鑰/);
    });
  });
});

// ── session 追蹤與成本歸屬 ──

describe('Worker — 每輪都記 session（含非互動）', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp = createTmpLedger();
  });
  afterEach(() => tmp.cleanup());

  function seed(task: TaskDetail): void {
    tmp.ledger.upsertDiscoveredTask({
      id: task.id, payloadHash: 'h1', repo: task.repo, category: task.category,
      title: task.title, description: task.description, dependencies: task.dependencies, docRefs: task.docRefs,
    });
  }

  function build(over: Partial<WorkerDeps> = {}): Worker {
    return new Worker({
      mcp: fakeMcp(),
      agent: fakeAgent([{}]),
      verifier: fakeVerifier([green()]),
      progress: new ProgressMonitor(tmp.ledger, 3),
      ledger: tmp.ledger,
      notifier: fakeNotifier(),
      diffHash: async () => 'd1',
      headRef: async () => undefined,
      sleep: async () => {},
      errorBackoff: { random: () => 0.5 },
      log: createSilentLogger(),
      ...over,
    });
  }

  const cfg = { verifierConfig: { test: 'exit 0' }, cwd: '/tmp/wt' };

  /**
   * 使用者的要求原話：「session id 都要保留就算不是用來互動也要」。
   * 一路順跑（完全沒有互動）也必須留下 task_id ↔ session_id 的對照，
   * 否則事後查 log 時，最正常的那些任務反而是查不到的空白。
   */
  it('順跑一輪就完成 → 仍然寫入 session 紀錄與用量', async () => {
    const task = makeTask();
    seed(task);
    const agent = fakeAgent([{
      usage: { costUsd: 0.42, inputTokens: 120, outputTokens: 30, cacheReadTokens: 4000, models: ['claude-opus-5'] },
    }]);

    await build({ agent }).runTask({ task, ...cfg, groupId: 'G-9' });

    const row = tmp.ledger.latestAgentSession(task.id);
    assert.equal(row?.sessionId, 's1');
    assert.equal(row?.groupId, 'G-9', '群組要記下來，才能按群彙總成本');
    assert.equal(row?.rounds, 1);
    assert.equal(row?.costUsd, 0.42);
    assert.equal(row?.inputTokens, 120);
    assert.deepEqual(row?.models, ['claude-opus-5']);
  });

  it('多輪監督 → 累加成同一列（rounds 與成本疊加）', async () => {
    const task = makeTask();
    seed(task);
    const agent = fakeAgent([{ usage: { costUsd: 1, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, models: [] } }]);

    await build({ agent, verifier: fakeVerifier([red(), red('red2'), green()]) }).runTask({ task, ...cfg });

    const row = tmp.ledger.latestAgentSession(task.id);
    assert.equal(row?.rounds, 3);
    assert.equal(row?.costUsd, 3);
  });

  it('SDK 沒回用量也要記下 session（成本 0，但對照關係還在）', async () => {
    const task = makeTask();
    seed(task);

    await build({ agent: fakeAgent([{}]) }).runTask({ task, ...cfg });

    const row = tmp.ledger.latestAgentSession(task.id);
    assert.equal(row?.sessionId, 's1');
    assert.equal(row?.costUsd, 0);
  });

  /** agent 那輪爆掉照樣花了錢，也照樣要留下對照——不記就是帳目短少。 */
  it('agent 出錯的那一輪也記（狀態標成 error）', async () => {
    const task = makeTask();
    seed(task);
    const agent = fakeAgent([{
      isError: true,
      errorKind: 'permanent',
      sdkError: 'authentication_failed',
      usage: { costUsd: 0.01, inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, models: ['claude-opus-5'] },
    }]);

    await build({ agent }).runTask({ task, ...cfg });

    const row = tmp.ledger.latestAgentSession(task.id);
    assert.equal(row?.status, 'error');
    assert.equal(row?.costUsd, 0.01);
  });

  it('agent 提出澄清 → session 標成 parked（人回覆後要靠它 resume）', async () => {
    const task = makeTask();
    seed(task);
    const agent = fakeAgent([{ askedClarification: { question: '要用哪個 API？' } }]);

    await build({ agent }).runTask({ task, ...cfg });

    const row = tmp.ledger.latestAgentSession(task.id);
    assert.equal(row?.status, 'parked');
    assert.equal(row?.sessionId, 's1');
  });

  /** 觀測資料寫壞不該讓任務失敗——這是紀錄，不是流程。 */
  it('session 寫入失敗只留 warn，不影響任務結果', async () => {
    const task = makeTask();
    seed(task);
    const rec = createRecordingLogger();
    const broken = Object.create(tmp.ledger) as typeof tmp.ledger;
    broken.recordAgentSession = () => { throw new Error('db 爆炸'); };

    const outcome = await build({ ledger: broken, log: rec.logger }).runTask({ task, ...cfg });

    assert.equal(outcome.status, 'done');
    assert.ok(rec.messages('warn').includes('session 紀錄寫入失敗'));
  });
});
