import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  HUMAN_REPLY_CONSUMED,
  markHumanReplyConsumed,
  pendingHumanReply,
} from '../src/worker/human-reply.js';
import type { TaskBrief, TaskDetail } from '../src/types.js';
import { createTmpLedger, createSilentLogger, type TmpLedger } from './helpers/index.js';

describe('人類回覆 — 讀出、注入、只用一次', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp = createTmpLedger();
  });
  afterEach(() => tmp.cleanup());

  const answer = (taskId: string, text: string): void =>
    tmp.ledger.logEvent('task', taskId, 'clarification_answer', JSON.stringify({ threadTs: 't1', answer: text }));

  it('沒有任何回覆 → undefined', () => {
    assert.equal(pendingHumanReply(tmp.ledger, 'T-1'), undefined);
  });

  it('讀出澄清答覆，並帶上當初的問題', () => {
    tmp.ledger.logEvent('task', 'T-1', 'clarification_asked', '要用 REST 還是 GraphQL？');
    answer('T-1', '用 REST');

    const r = pendingHumanReply(tmp.ledger, 'T-1');
    assert.equal(r?.kind, 'clarification_answer');
    assert.equal(r?.question, '要用 REST 還是 GraphQL？');
    assert.equal(r?.answer, '用 REST');
  });

  it('answer 欄位不是 JSON 時退回原字串（不會變成空白）', () => {
    tmp.ledger.logEvent('task', 'T-1', 'clarification_answer', '就照舊做');
    assert.equal(pendingHumanReply(tmp.ledger, 'T-1')?.answer, '就照舊做');
  });

  it('找不到原問題也給得出敘述（prompt 不會出現空問題）', () => {
    answer('T-1', '用 REST');
    assert.equal(pendingHumanReply(tmp.ledger, 'T-1')?.question, '（你先前提出的問題）');
  });

  /**
   * 不標消費的話，同一個答覆會在之後每一輪重跑時再貼一次——
   * agent 會以為人又回答了一次，把處理完的問題重做一遍。
   */
  it('標記消費後就不再回傳同一則', () => {
    answer('T-1', '用 REST');
    const r = pendingHumanReply(tmp.ledger, 'T-1');
    assert.ok(r);
    markHumanReplyConsumed(tmp.ledger, 'T-1', r);
    assert.equal(pendingHumanReply(tmp.ledger, 'T-1'), undefined);
  });

  it('消費之後人再回一次 → 新的那則要讀得到', () => {
    answer('T-1', '第一次回答');
    markHumanReplyConsumed(tmp.ledger, 'T-1', pendingHumanReply(tmp.ledger, 'T-1')!);
    answer('T-1', '第二次回答');
    assert.equal(pendingHumanReply(tmp.ledger, 'T-1')?.answer, '第二次回答');
  });

  it('「否決無需改動」也是一種人類回覆，內容要求 agent 別再宣告一次', () => {
    tmp.ledger.logEvent('task', 'T-1', 'no_change_rejected', JSON.stringify({ userId: 'U1' }));
    const r = pendingHumanReply(tmp.ledger, 'T-1');
    assert.equal(r?.kind, 'no_change_rejected');
    assert.match(r?.answer ?? '', /不要再次呼叫 report_no_change/);
  });

  it('多種回覆並存時取最新的那則', () => {
    answer('T-1', '舊答覆');
    tmp.ledger.logEvent('task', 'T-1', 'no_change_rejected', '{}');
    assert.equal(pendingHumanReply(tmp.ledger, 'T-1')?.kind, 'no_change_rejected');

    answer('T-1', '更新的答覆');
    const r = pendingHumanReply(tmp.ledger, 'T-1');
    assert.equal(r?.kind, 'clarification_answer');
    assert.equal(r?.answer, '更新的答覆');
  });

  it('各任務互不影響', () => {
    answer('T-1', 'A');
    assert.equal(pendingHumanReply(tmp.ledger, 'T-2'), undefined);
  });

  it('消費標記寫的是來源事件 id', () => {
    answer('T-1', 'A');
    const r = pendingHumanReply(tmp.ledger, 'T-1')!;
    markHumanReplyConsumed(tmp.ledger, 'T-1', r);
    assert.equal(tmp.ledger.latestEvent('task', 'T-1', HUMAN_REPLY_CONSUMED)?.detail, String(r.eventId));
  });

  /** 壞掉的消費標記（人手動改過 DB、或舊版格式）不該讓答覆永遠讀不出來。 */
  it('消費標記無法解析時，仍然讀得到回覆', () => {
    answer('T-1', 'A');
    tmp.ledger.logEvent('task', 'T-1', HUMAN_REPLY_CONSUMED, '壞掉的值');
    assert.equal(pendingHumanReply(tmp.ledger, 'T-1')?.answer, 'A');
  });
});

// ── resume 失敗的判定 ──

describe('isResumeFailure — 只有真的續接不到才降級重跑', () => {
  // 動態載入避免與上面的 ledger 測試共用狀態
  const load = async () => (await import('../src/worker/agent-runtime.js')).isResumeFailure;

  it('明確指向 session 不存在 → true', async () => {
    const isResumeFailure = await load();
    assert.equal(isResumeFailure({ isError: true, sdkError: 'invalid_request', resultText: 'No conversation found for session abc' }), true);
    assert.equal(isResumeFailure({ isError: true, resultText: 'Session xyz has expired' }), true);
    assert.equal(isResumeFailure({ isError: true, resultText: '指定的 session 不存在' }), true);
  });

  /** 放寬條件的代價是每個真實故障都付兩份錢，所以這幾條要是紅的就代表判準太鬆。 */
  it('一般失敗一律 false（不重跑）', async () => {
    const isResumeFailure = await load();
    assert.equal(isResumeFailure({ isError: false, resultText: 'session not found' }), false, '沒失敗就不該重跑');
    assert.equal(isResumeFailure({ isError: true, sdkError: 'rate_limit' }), false);
    assert.equal(isResumeFailure({ isError: true, sdkError: 'authentication_failed' }), false);
    assert.equal(isResumeFailure({ isError: true, resultText: 'file not found: src/app.ts' }), false, '「not found」但與 session 無關');
    assert.equal(isResumeFailure({ isError: true }), false);
  });
});

// ── Worker 端：帶著回覆續跑 ──

describe('Worker — 人回覆後接回原 session', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp = createTmpLedger();
  });
  afterEach(() => tmp.cleanup());

  it('有未消費的回覆 → resume 舊 session 並注入答覆；沒有則從新 session 開始', async () => {
    const { Worker } = await import('../src/worker/worker.js');
    const { ProgressMonitor } = await import('../src/worker/progress.js');
    const { makeTaskDetail } = await import('./helpers/index.js');

    const task = makeTaskDetail({ id: 'T-1', status: 'todo', docRefs: [] });
    tmp.ledger.upsertDiscoveredTask({
      id: task.id, payloadHash: 'h', repo: task.repo, category: task.category,
      title: task.title, description: task.description, dependencies: [], docRefs: [],
    });
    // 先前那一輪留下的 session（人回覆後要接回這個）
    tmp.ledger.recordAgentSession({ kind: 'worker', taskId: task.id, sessionId: 's-old' });
    tmp.ledger.logEvent('task', task.id, 'clarification_asked', '要用哪個 API？');
    tmp.ledger.logEvent('task', task.id, 'clarification_answer', JSON.stringify({ threadTs: 't', answer: '用 REST' }));

    const inputs: { resume?: string; answer?: { question: string; answer: string } }[] = [];
    const worker = new Worker({
      mcp: {
        async startTask() { return { ok: true as const, value: task }; },
        async completeTask() { return { ok: true as const, value: undefined }; },
        async loadDocs() { return []; },
        // 認領一定成功，Worker 走不到「查任務板現況」那條路；真的被呼叫代表測錯了路徑
        async getTask(): Promise<TaskDetail> { throw new Error('測試不該走到這裡：認領成功時不會查任務板現況'); },
        async listTasks(): Promise<TaskBrief[]> { throw new Error('測試不該走到這裡：Worker 不列任務板'); },
      },
      agent: {
        async iterate(i) {
          inputs.push({ resume: i.resumeSessionId, answer: i.answer });
          return { sessionId: 's-old', resultText: '好', toolCalls: {}, isError: false };
        },
      },
      verifier: { async check() { return { green: true, checks: [{ name: 'test', ok: true, detail: 'ok' }], signature: 'g' }; } },
      progress: new ProgressMonitor(tmp.ledger, 3),
      ledger: tmp.ledger,
      notifier: { event: () => {} },
      diffHash: async () => 'd1',
      headRef: async () => undefined,
      sleep: async () => {},
      log: createSilentLogger(),
    });

    await worker.runTask({ task, cwd: '/tmp/wt', verifierConfig: { test: 'exit 0' } });

    assert.equal(inputs[0]?.resume, 's-old', '第一輪要接回原 session');
    assert.equal(inputs[0]?.answer?.answer, '用 REST', '答覆要注入 prompt');
    assert.equal(inputs[0]?.answer?.question, '要用哪個 API？');
    assert.equal(
      tmp.ledger.latestEvent('task', task.id, HUMAN_REPLY_CONSUMED)?.detail !== undefined,
      true,
      '注入後要標記已消費',
    );
  });

  /**
   * 這條原本鎖的是「沒有人類回覆就開全新 session」。那是錯的：
   * daemon 重啟後、或群組被重新派工時，agent 會完全不記得自己上一輪做過什麼，
   * 先前試過又放棄的方向可能再試一次。
   *
   * 現在一律續接同一個任務的 session；只有「注入人工答覆」才看 pending。
   * session 存在 Claude Code engine 的磁碟上，不是行程記憶體，重啟後接得回來；
   * 真過期了 iterate 會自己降級開新的。
   */
  it('沒有人類回覆 → 照樣續接同一個 session，但不注入答覆', async () => {
    const { Worker } = await import('../src/worker/worker.js');
    const { ProgressMonitor } = await import('../src/worker/progress.js');
    const { makeTaskDetail } = await import('./helpers/index.js');

    const task = makeTaskDetail({ id: 'T-2', status: 'todo', docRefs: [] });
    tmp.ledger.upsertDiscoveredTask({
      id: task.id, payloadHash: 'h', repo: task.repo, category: task.category,
      title: task.title, description: task.description, dependencies: [], docRefs: [],
    });
    tmp.ledger.recordAgentSession({ kind: 'worker', taskId: task.id, sessionId: 's-old' });

    const inputs: { resume?: string; answer?: unknown }[] = [];
    const worker = new Worker({
      mcp: {
        async startTask() { return { ok: true as const, value: task }; },
        async completeTask() { return { ok: true as const, value: undefined }; },
        async loadDocs() { return []; },
        // 認領一定成功，Worker 走不到「查任務板現況」那條路；真的被呼叫代表測錯了路徑
        async getTask(): Promise<TaskDetail> { throw new Error('測試不該走到這裡：認領成功時不會查任務板現況'); },
        async listTasks(): Promise<TaskBrief[]> { throw new Error('測試不該走到這裡：Worker 不列任務板'); },
      },
      agent: {
        async iterate(i) {
          inputs.push({ resume: i.resumeSessionId, answer: i.answer });
          return { sessionId: 's-new', resultText: '好', toolCalls: {}, isError: false };
        },
      },
      verifier: { async check() { return { green: true, checks: [{ name: 'test', ok: true, detail: 'ok' }], signature: 'g' }; } },
      progress: new ProgressMonitor(tmp.ledger, 3),
      ledger: tmp.ledger,
      notifier: { event: () => {} },
      diffHash: async () => 'd1',
      headRef: async () => undefined,
      sleep: async () => {},
      log: createSilentLogger(),
    });

    await worker.runTask({ task, cwd: '/tmp/wt', verifierConfig: { test: 'exit 0' } });

    assert.equal(inputs[0]?.resume, 's-old', '同一個任務要記得自己上一輪做過什麼');
    assert.equal(inputs[0]?.answer, undefined, '沒有待注入的答覆就不該注入');
  });
});
