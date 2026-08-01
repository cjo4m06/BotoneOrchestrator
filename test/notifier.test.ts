import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConsoleNotifier,
  InboundRouter,
  requestNoChangeConfirmation,
  summarizeEvent,
  type CompleteTaskFn,
  type ExtendedControlCommand,
  type InboundHooks,
  type InboundLedger,
  type InboundMergeDecision,
  type NoChangeConfirmInput,
} from '../src/notify/notifier.js';
import { createRecordingLogger, createSilentLogger, createTmpLedger, makeDiscoveredTask, makeGateReport, makeTaskDetail } from './helpers/index.js';
import type { Ledger } from '../src/store/ledger.js';
import type { ClarificationAnswer, LifecycleEvent, McpOut } from '../src/types.js';
import type { TmpLedger } from './helpers/ledger.js';

describe('summarizeEvent — 生命週期事件文案', () => {
  const cases: [LifecycleEvent, RegExp][] = [
    [{ type: 'claimed' }, /已認領/],
    [{ type: 'docs_read', refs: ['spec/a.md#1'] }, /已讀規格：spec\/a\.md#1/],
    [{ type: 'docs_read', refs: [] }, /（無）/],
    [{ type: 'iterating', round: 3 }, /第 3 輪/],
    [{ type: 'stalled', gate: makeGateReport({ green: false }) }, /卡在同一處/],
    [{ type: 'problem', detail: '磁碟滿了' }, /遇到問題：磁碟滿了/],
    [{ type: 'pr_open', url: 'https://x/pr/1' }, /PR 已開：https:\/\/x\/pr\/1/],
    [{ type: 'in_review' }, /進入審查/],
    [{ type: 'changes_requested', count: 2 }, /要求修改（2 則）/],
    [{ type: 'merged' }, /已合併/],
    [{ type: 'failed', detail: '測試紅' }, /失敗：測試紅/],
  ];

  for (const [event, pattern] of cases) {
    it(`${event.type} → ${pattern.source}`, () => {
      assert.match(summarizeEvent(event), pattern);
    });
  }
});

describe('ConsoleNotifier', () => {
  it('把事件寫進 log，並帶上 taskId / threadTs 便於追蹤', () => {
    const rec = createRecordingLogger();
    const task = makeTaskDetail({ id: 'T-9' });

    new ConsoleNotifier(rec.logger).event('1700.1', { type: 'claimed' }, task);

    const row = rec.records.at(-1);
    assert.equal(row?.taskId, 'T-9');
    assert.equal(row?.threadTs, '1700.1');
    assert.match(String(row?.msg), /已認領/);
  });
});

// ── InboundRouter：Slack 入站 → ledger ──

/** 記錄回呼註冊、並可手動觸發的假人機介面（HumanGateway 結構子集）。 */
function makeHooks(): InboundHooks & {
  fireAnswer(a: ClarificationAnswer): void;
  fireControl(c: ExtendedControlCommand): void;
  fireMerge(d: InboundMergeDecision): void;
  counts: { answer: number; control: number; merge: number };
} {
  const answer: ((a: ClarificationAnswer) => void)[] = [];
  const control: ((c: ExtendedControlCommand) => void)[] = [];
  const merge: ((d: InboundMergeDecision) => void)[] = [];
  return {
    onAnswer: (cb) => void answer.push(cb),
    onControl: (cb) => void control.push(cb),
    onMergeDecision: (cb) => void merge.push(cb),
    fireAnswer: (a) => answer.forEach((cb) => cb(a)),
    fireControl: (c) => control.forEach((cb) => cb(c)),
    fireMerge: (d) => merge.forEach((cb) => cb(d)),
    counts: {
      get answer() {
        return answer.length;
      },
      get control() {
        return control.length;
      },
      get merge() {
        return merge.length;
      },
    },
  };
}

describe('InboundRouter — 接線', () => {
  it('attach 會註冊三個入站回呼，事件經由回呼流進 ledger', () => {
    const tmp = createTmpLedger();
    try {
      tmp.ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-A' }));
      tmp.ledger.setBlock('T-A', 'needs_clarification', '要用哪個 API？');
      const hooks = makeHooks();

      new InboundRouter({ ledger: tmp.ledger, log: createSilentLogger() }).attach(hooks);
      assert.deepEqual({ ...hooks.counts }, { answer: 1, control: 1, merge: 1 });

      hooks.fireAnswer({ taskId: 'T-A', threadTs: '1.1', optionId: 'opt-a' });
      assert.equal(tmp.ledger.getTask('T-A')?.state, 'queued');
    } finally {
      tmp.cleanup();
    }
  });
});

describe('InboundRouter — 澄清答覆', () => {
  let tmp: TmpLedger;
  let ledger: Ledger;
  let router: InboundRouter;
  let rec: ReturnType<typeof createRecordingLogger>;

  beforeEach(() => {
    tmp = createTmpLedger();
    ledger = tmp.ledger;
    rec = createRecordingLogger();
    router = new InboundRouter({ ledger, log: rec.logger });
  });
  afterEach(() => tmp.cleanup());

  it('等待澄清中的任務收到答覆 → 解除 block 回 queued（下一輪重新派工）', () => {
    ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-1' }));
    ledger.setBlock('T-1', 'needs_clarification', '用哪個欄位當主鍵？');

    router.handleAnswer({ taskId: 'T-1', threadTs: '1.1', freeText: '用 uuid' });

    const t = ledger.getTask('T-1');
    assert.equal(t?.state, 'queued');
    assert.equal(t?.block, undefined, 'block 必須被清掉，否則永遠不會被撿走');
  });

  it('答覆內容寫進 events 稽核表（選項與自由文字都記）', () => {
    ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-2' }));
    ledger.setBlock('T-2', 'needs_clarification', 'Q');

    router.handleAnswer({ taskId: 'T-2', threadTs: '2.2', optionId: 'opt-b' });

    // events 沒有公開查詢 API，改以「不擲例外且狀態正確」+ log 佐證
    assert.equal(ledger.getTask('T-2')?.state, 'queued');
    assert.ok(rec.messages('info').some((m) => m.includes('已收到澄清答覆')));
  });

  it('ledger 之後補上 clarifications 表 API 時會自動採用（目前為可選）', () => {
    const seen: unknown[] = [];
    const fake = fakeLedger({
      tasks: { 'T-3': { state: 'blocked', block: { reason: 'needs_clarification' } } },
      recordClarificationAnswer: (...args: unknown[]) => void seen.push(args),
    });

    new InboundRouter({ ledger: fake, log: createSilentLogger() }).handleAnswer({
      taskId: 'T-3',
      threadTs: '3.3',
      optionId: 'yes',
    });

    assert.deepEqual(seen, [['T-3', '3.3', 'yes']]);
  });

  it('任務不存在 → 只警告不擲例外', () => {
    router.handleAnswer({ taskId: '不存在', threadTs: '9.9', freeText: 'x' });
    assert.ok(rec.messages('warn').some((m) => m.includes('沒有這個任務')));
  });

  it('任務不在等待澄清狀態 → 不亂改狀態（避免把跑到一半的任務踢回排隊）', () => {
    ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-4' }));
    ledger.updateTaskState('T-4', 'in_progress');

    router.handleAnswer({ taskId: 'T-4', threadTs: '4.4', freeText: '晚回的答案' });

    assert.equal(ledger.getTask('T-4')?.state, 'in_progress');
    assert.ok(rec.messages('warn').some((m) => m.includes('不在等待澄清狀態')));
  });
});

describe('InboundRouter — 控制指令', () => {
  let tmp: TmpLedger;
  let ledger: Ledger;
  let router: InboundRouter;
  let rec: ReturnType<typeof createRecordingLogger>;

  beforeEach(() => {
    tmp = createTmpLedger();
    ledger = tmp.ledger;
    rec = createRecordingLogger();
    router = new InboundRouter({ ledger, log: rec.logger });
  });
  afterEach(() => tmp.cleanup());

  for (const type of ['pause', 'abort'] as const) {
    it(`${type} → blocked:needs_human（reconciler 不會自動把它重排）`, () => {
      ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: `T-${type}` }));
      ledger.updateTaskState(`T-${type}`, 'in_progress');

      router.handleControl({ type, taskId: `T-${type}` });

      const t = ledger.getTask(`T-${type}`);
      assert.equal(t?.state, 'blocked');
      assert.equal(t?.block?.reason, 'needs_human');
    });
  }

  for (const type of ['retry', 'use_default'] as const) {
    it(`${type} → 回 queued 重排`, () => {
      ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: `T-${type}` }));
      ledger.setBlock(`T-${type}`, 'needs_clarification', 'Q');

      router.handleControl({ type, taskId: `T-${type}` });

      const t = ledger.getTask(`T-${type}`);
      assert.equal(t?.state, 'queued');
      assert.equal(t?.block, undefined);
    });
  }

  it('已完成的任務不受控制指令影響', () => {
    ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-done' }));
    ledger.updateTaskState('T-done', 'done');

    router.handleControl({ type: 'abort', taskId: 'T-done' });

    assert.equal(ledger.getTask('T-done')?.state, 'done');
    assert.ok(rec.messages('warn').some((m) => m.includes('控制指令不生效')));
  });

  it('任務不存在 → 只警告不擲例外', () => {
    router.handleControl({ type: 'retry', taskId: '不存在' });
    assert.ok(rec.messages('warn').some((m) => m.includes('沒有這個任務')));
  });
});

// ── 「這張卡不用做」的人工確認出口（DESIGN §7b + D18） ──

describe('InboundRouter — confirm_no_change', () => {
  let tmp: TmpLedger;
  let ledger: Ledger;
  let rec: ReturnType<typeof createRecordingLogger>;
  /** completeTask 的呼叫紀錄 + 可切換成失敗/丟例外。 */
  let mcp: {
    calls: { taskId: string; summary?: string }[];
    result: McpOut<void>;
    throws: boolean;
    fn: CompleteTaskFn;
  };

  /** 造一張「agent 宣告無需改動 → park 等人確認」的卡（和 worker.handleNoChange 落的痕跡一致）。 */
  function parkedNoChange(id: string, category = 'already_satisfied'): void {
    ledger.upsertDiscoveredTask(makeDiscoveredTask({ id }));
    ledger.logEvent(
      'task',
      id,
      'no_change_reported',
      JSON.stringify({ category, reason: '功能已存在', evidence: 'src/a.ts:10' }),
    );
    ledger.setBlock(id, 'needs_human', '無需改動：現況已符合需求：功能已存在');
  }

  function router(withMcp = true): InboundRouter {
    return new InboundRouter({
      ledger,
      log: rec.logger,
      ...(withMcp ? { completeTask: mcp.fn } : {}),
    });
  }

  beforeEach(() => {
    tmp = createTmpLedger();
    ledger = tmp.ledger;
    rec = createRecordingLogger();
    mcp = {
      calls: [],
      result: { ok: true, value: undefined },
      throws: false,
      fn: async (taskId, opts) => {
        mcp.calls.push({ taskId, ...(opts?.summary ? { summary: opts.summary } : {}) });
        if (mcp.throws) throw new Error('MCP 連線爆炸');
        return mcp.result;
      },
    };
  });
  afterEach(() => tmp.cleanup());

  it('確認 → 呼叫 completeTask 並標 done（park→retry→再 park 的迴圈有出口了）', async () => {
    parkedNoChange('T-1');

    await router().handleControl({ type: 'confirm_no_change', taskId: 'T-1', userId: 'U9' });

    assert.equal(mcp.calls.length, 1);
    assert.equal(mcp.calls[0]?.taskId, 'T-1');
    assert.match(String(mcp.calls[0]?.summary), /無需改動/);
    const t = ledger.getTask('T-1');
    assert.equal(t?.state, 'done');
    assert.equal(t?.block, undefined);
  });

  it('確認會留下稽核事件（誰、何時、確認了什麼）', async () => {
    parkedNoChange('T-2');

    await router().handleControl({ type: 'confirm_no_change', taskId: 'T-2', userId: 'U9' });

    const ev = ledger.latestEvent('task', 'T-2', 'no_change_confirmed');
    assert.ok(ev, '不可逆的操作必須留稽核');
    const payload = JSON.parse(ev!.detail!) as Record<string, unknown>;
    assert.equal(payload.userId, 'U9');
    assert.equal(payload.category, 'already_satisfied');
    assert.equal(payload.reason, '功能已存在');
    assert.equal(typeof payload.confirmedAt, 'number');
  });

  it('沒注入 completeTask → 維持 needs_human，絕不在本機假裝完成', async () => {
    parkedNoChange('T-3');

    await router(false).handleControl({ type: 'confirm_no_change', taskId: 'T-3' });

    // 本機標 done 而 MCP 上還開著，會讓下游任務的 start_task 被以「依賴未完成」擋下（D2/D3），
    // 形成無解的不一致，而且人會誤以為處理好了 → 寧可停在等待處理並大聲說明
    const t = ledger.getTask('T-3');
    assert.notEqual(t?.state, 'done');
    assert.equal(t?.block?.reason, 'needs_human');
    assert.match(t?.block?.detail ?? '', /無法呼叫 complete_task/);
    assert.ok(ledger.latestEvent('task', 'T-3', 'no_change_confirm_unwired'));
    const errors = rec.messages('error').join('\n');
    assert.match(errors, /沒有可用的 MCP 連線/);
  });

  it('completeTask 失敗 → 維持 needs_human，不假裝完成，也不回 queued 讓它再跑一輪', async () => {
    parkedNoChange('T-4');
    mcp.result = { ok: false, kind: 'transient', detail: '502' };

    await router().handleControl({ type: 'confirm_no_change', taskId: 'T-4' });

    const t = ledger.getTask('T-4');
    assert.equal(t?.state, 'blocked');
    assert.equal(t?.block?.reason, 'needs_human');
    assert.match(String(t?.block?.detail), /complete_task 失敗/);
    assert.ok(rec.messages('error').some((m) => m.includes('complete_task 失敗')));
  });

  it('completeTask 丟例外 → 吞下不外漏，任務不會變成 done', async () => {
    parkedNoChange('T-5');
    mcp.throws = true;

    await assert.doesNotReject(() => router().handleControl({ type: 'confirm_no_change', taskId: 'T-5' }));

    assert.equal(ledger.getTask('T-5')?.state, 'blocked');
    assert.ok(rec.messages('error').some((m) => m.includes('入站事件處理失敗')));
  });

  it('D18：沒有 no_change 宣告的卡不會被誤點結案（不可逆操作要有依據）', async () => {
    ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-6' }));
    ledger.setBlock('T-6', 'needs_human', '使用者要求暫停');

    await router().handleControl({ type: 'confirm_no_change', taskId: 'T-6' });

    assert.equal(mcp.calls.length, 0);
    assert.equal(ledger.getTask('T-6')?.state, 'blocked');
    assert.ok(rec.messages('warn').some((m) => m.includes('沒有「無需改動」的宣告紀錄')));
  });

  it('D18：worker 正在跑（in_progress）時不結案，避免蓋掉進行中的工作', async () => {
    parkedNoChange('T-7');
    ledger.updateTaskState('T-7', 'in_progress');

    await router().handleControl({ type: 'confirm_no_change', taskId: 'T-7' });

    assert.equal(mcp.calls.length, 0);
    assert.equal(ledger.getTask('T-7')?.state, 'in_progress');
    assert.ok(rec.messages('warn').some((m) => m.includes('不在「等人確認」的狀態')));
  });

  it('合法例外的出口：卡被重排回 queued 之後，人還是能確認（不然又卡死）', async () => {
    parkedNoChange('T-8');
    ledger.clearBlock('T-8', 'queued'); // 例如 reconciler 重排

    await router().handleControl({ type: 'confirm_no_change', taskId: 'T-8' });

    assert.equal(mcp.calls.length, 1);
    assert.equal(ledger.getTask('T-8')?.state, 'done');
  });

  it('block detail 有「無需改動」但事件查不到時，仍可確認（事件表被裁剪過的情況）', async () => {
    ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-9' }));
    ledger.setBlock('T-9', 'needs_human', '無需改動：缺外部依賴無法進行：等第三方 API 開通');

    await router().handleControl({ type: 'confirm_no_change', taskId: 'T-9' });

    assert.equal(ledger.getTask('T-9')?.state, 'done');
    assert.match(String(mcp.calls[0]?.summary), /等第三方 API 開通/);
  });

  it('「你誤判了，請你去做」→ 回 queued 重做，並留下可區分的稽核', async () => {
    parkedNoChange('T-10');

    await router().handleControl({ type: 'retry', taskId: 'T-10', source: 'no_change_rejected', userId: 'U9' });

    const t = ledger.getTask('T-10');
    assert.equal(t?.state, 'queued');
    assert.equal(t?.block, undefined);
    assert.equal(mcp.calls.length, 0, '否決不該碰不可逆的 complete_task');
    assert.ok(ledger.latestEvent('task', 'T-10', 'no_change_rejected'), '要能和一般 retry 分辨');
  });

  it('一般 retry 不會被誤記成「否決 no_change」', async () => {
    parkedNoChange('T-11');

    await router().handleControl({ type: 'retry', taskId: 'T-11' });

    assert.equal(ledger.getTask('T-11')?.state, 'queued');
    assert.equal(ledger.latestEvent('task', 'T-11', 'no_change_rejected'), undefined);
  });

  it('已 done 的卡再確認一次不會重複呼叫 completeTask', async () => {
    parkedNoChange('T-12');
    ledger.clearBlock('T-12', 'done');

    await router().handleControl({ type: 'confirm_no_change', taskId: 'T-12' });

    assert.equal(mcp.calls.length, 0);
    assert.ok(rec.messages('warn').some((m) => m.includes('控制指令不生效')));
  });

  it('attach 之後，Slack 送來的 confirm_no_change 會真的走完整條路徑', async () => {
    parkedNoChange('T-13');
    const hooks = makeHooks();
    router().attach(hooks);

    hooks.fireControl({ type: 'confirm_no_change', taskId: 'T-13', userId: 'U9' });
    await new Promise((r) => setImmediate(r)); // 回呼不 await，等 microtask 跑完

    assert.equal(mcp.calls.length, 1);
    assert.equal(ledger.getTask('T-13')?.state, 'done');
  });
});

describe('requestNoChangeConfirmation — 通知端能力偵測', () => {
  it('notifier 支援 → 呼叫並回 true', async () => {
    const seen: NoChangeConfirmInput[] = [];
    const ok = await requestNoChangeConfirmation(
      { askNoChangeConfirmation: async (_t: string | undefined, i: NoChangeConfirmInput) => void seen.push(i) },
      'ts-1',
      { taskId: 'T-1', category: 'not_applicable', reason: 'r' },
    );
    assert.equal(ok, true);
    assert.equal(seen[0]?.taskId, 'T-1');
  });

  it('notifier 不支援（舊 Notifier）→ 回 false，呼叫端可退回既有事件', async () => {
    const ok = await requestNoChangeConfirmation({ event: () => {} }, undefined, {
      taskId: 'T-1',
      category: 'not_applicable',
      reason: 'r',
    });
    assert.equal(ok, false);
  });

  it('貼訊息失敗 → 回 false 而不是把例外丟回任務流程', async () => {
    const rec = createRecordingLogger();
    const ok = await requestNoChangeConfirmation(
      {
        askNoChangeConfirmation: async () => {
          throw new Error('slack down');
        },
      },
      undefined,
      { taskId: 'T-1', category: 'not_applicable', reason: 'r' },
      rec.logger,
    );
    assert.equal(ok, false);
    assert.ok(rec.messages('warn').some((m) => m.includes('確認訊息失敗')));
  });
});

describe('InboundRouter — 合併裁決', () => {
  it('核准 → merge_guard；退回 → changes_requested', () => {
    const tmp = createTmpLedger();
    try {
      const g1 = tmp.ledger.createGroup({ repo: 'acme/web', branch: 'b1', taskIds: ['T-1'], footprint: [] });
      const g2 = tmp.ledger.createGroup({ repo: 'acme/web', branch: 'b2', taskIds: ['T-2'], footprint: [] });
      const router = new InboundRouter({ ledger: tmp.ledger, log: createSilentLogger() });

      router.handleMergeDecision({ groupId: g1.id, approved: true, userId: 'U1' });
      router.handleMergeDecision({ groupId: g2.id, approved: false, userId: 'U1' });

      assert.equal(tmp.ledger.getGroup(g1.id)?.state, 'merge_guard');
      assert.equal(tmp.ledger.getGroup(g2.id)?.state, 'changes_requested');
    } finally {
      tmp.cleanup();
    }
  });

  it('群組不存在 → 只警告不擲例外', () => {
    const rec = createRecordingLogger();
    const fake = fakeLedger({});
    new InboundRouter({ ledger: fake, log: rec.logger }).handleMergeDecision({ groupId: 'g-x', approved: true });
    assert.ok(rec.messages('warn').some((m) => m.includes('沒有這個群組')));
  });
});

describe('InboundRouter — 例外隔離', () => {
  it('ledger 丟例外 → 記錄 error 但不外漏（Slack 回呼不能拖垮 daemon）', async () => {
    const rec = createRecordingLogger();
    const boom = fakeLedger({
      tasks: { 'T-1': { state: 'blocked', block: { reason: 'needs_clarification' } } },
      onLogEvent: () => {
        throw new Error('ledger 掛了');
      },
    });
    const router = new InboundRouter({ ledger: boom, log: rec.logger });

    assert.doesNotThrow(() => router.handleAnswer({ taskId: 'T-1', threadTs: '1.1', freeText: 'x' }));
    // handleControl 現在是非同步（confirm_no_change 要等 MCP），故改用 doesNotReject
    await assert.doesNotReject(() => router.handleControl({ type: 'retry', taskId: 'T-1' }));
    assert.ok(rec.messages('error').filter((m) => m.includes('入站事件處理失敗')).length >= 2);
  });
});

// ── 假 ledger（只實作 InboundRouter 用得到的部分） ──

interface FakeLedgerSpec {
  tasks?: Record<string, { state: string; block?: { reason: string } }>;
  recordClarificationAnswer?: (...args: unknown[]) => void;
  onLogEvent?: () => void;
}

function fakeLedger(spec: FakeLedgerSpec): InboundLedger {
  const base: InboundLedger = {
    getTask: (id) => {
      const t = spec.tasks?.[id];
      // 只填 InboundRouter 讀得到的欄位；其餘用 makeTask 之外的最小值即可
      return t ? ({ id, state: t.state, block: t.block } as never) : undefined;
    },
    getGroup: () => undefined,
    setBlock: () => {},
    clearBlock: () => {},
    updateGroupState: () => {},
    logEvent: () => spec.onLogEvent?.(),
  };
  return spec.recordClarificationAnswer
    ? { ...base, recordClarificationAnswer: (a, b, c) => spec.recordClarificationAnswer!(a, b, c) }
    : base;
}
