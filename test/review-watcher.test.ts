import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEEDBACK_EVENT_KIND,
  ReviewFeedbackStore,
  ReviewWatcher,
  formatFeedback,
  formatReviewFeedback,
  SEEN_EVENT_KIND,
  type ReviewLedgerLike,
  groupsWithLivePr,
} from '../src/pr/review-watcher.js';
import type { CommandResult, CommandRunner } from '../src/pr/pr-manager.js';
import type { Group, GroupState } from '../src/types.js';
import { createSilentLogger, createRecordingLogger, createTmpLedger, type TmpLedger } from './helpers/index.js';

// ── 假件 ──────────────────────────────────────────────────────────────
// 本檔一律不碰真實 gh／真實 repo：所有 GitHub 互動都由 fakeGh 回應。

interface GhCall {
  file: string;
  args: string[];
}

function fakeGh(replies: (Partial<CommandResult> | undefined)[] | ((n: number) => Partial<CommandResult>)): {
  run: CommandRunner;
  calls: GhCall[];
} {
  const calls: GhCall[] = [];
  const run: CommandRunner = async (file, args) => {
    const n = calls.length;
    calls.push({ file, args });
    const r = (typeof replies === 'function' ? replies(n) : replies[n]) ?? { exitCode: 1, stderr: '沒有預備回覆' };
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { run, calls };
}

/** gh pr view --json 的輸出（只放我們會讀的欄位）。 */
function ghView(v: Record<string, unknown>): { stdout: string } {
  return { stdout: JSON.stringify({ number: 42, state: 'OPEN', mergeable: 'MERGEABLE', ...v }) };
}

const review = (o: Partial<{ id: string; login: string; state: string; body: string; at: string }>) => ({
  id: o.id ?? 'PRR_1',
  author: { login: o.login ?? 'alice' },
  state: o.state ?? 'COMMENTED',
  body: o.body ?? '',
  submittedAt: o.at ?? '2026-07-01T10:00:00Z',
});

const comment = (o: Partial<{ id: string; login: string; body: string; at: string }>) => ({
  id: o.id ?? 'IC_1',
  author: { login: o.login ?? 'alice' },
  body: o.body ?? '',
  createdAt: o.at ?? '2026-07-01T10:00:00Z',
});

interface EventRow {
  scope: string;
  refId: string | null;
  kind: string;
  detail?: string;
}

function makeGroup(o: Partial<Group> = {}): Group {
  const now = Date.now();
  return {
    id: 'g_1',
    repo: 'acme/web',
    branch: 'feat/g1',
    taskIds: ['T-1'],
    footprint: ['src/a.ts'],
    afterGroups: [],
    rationale: '',
    state: 'pr_open',
    prNumber: 42,
    prUrl: 'https://github.com/acme/web/pull/42',
    createdAt: now,
    updatedAt: now,
    ...o,
  };
}

/** 記憶體 ledger 假件。withEventQuery=true 模擬「ledger 具備 events 查詢能力」的情況。 */
function fakeLedger(groups: Group[], opts: { withEventQuery?: boolean } = {}) {
  const events: EventRow[] = [];
  const base = {
    listGroupsByState(state: GroupState): Group[] {
      return groups.filter((g) => g.state === state);
    },
    updateGroupState(id: string, state: GroupState): void {
      const g = groups.find((x) => x.id === id);
      if (g) g.state = state;
    },
    logEvent(scope: 'task' | 'group' | 'system', refId: string | null, kind: string, detail?: string): void {
      events.push({ scope, refId, kind, detail });
    },
  };
  const ledger: ReviewLedgerLike = opts.withEventQuery
    ? {
        ...base,
        hasEvent(scope, refId, kind, detail) {
          return events.some((e) => e.scope === scope && e.refId === refId && e.kind === kind && e.detail === detail);
        },
      }
    : base;
  return { ledger, events, groups };
}

// ── 測試 ──────────────────────────────────────────────────────────────

describe('ReviewWatcher — 事件解析', () => {
  // 「沒東西可追」的判準是**沒有 PR 編號**，不是「狀態不是 pr_open/in_review」。
  // 被 requeue 的群組會回到 ready，但它的 PR 還開在 GitHub 上——那正是先前被漏掉、
  // 造成 16 個任務永久死結的情況（見 groupsWithLivePr 的說明）。
  it('沒有 PR 的群組 → 直接回空，連 gh 都不呼叫', async () => {
    const g = makeGroup({ state: 'ready' });
    delete (g as { prNumber?: number }).prNumber;
    const { ledger } = fakeLedger([g]);
    const gh = fakeGh([]);
    const events = await new ReviewWatcher({ ledger, log: createSilentLogger(), run: gh.run }).poll();

    assert.deepEqual(events, []);
    assert.equal(gh.calls.length, 0);
  });

  it('approved → 回報事件、狀態留在 in_review 由呼叫端接 Merge Guard', async () => {
    const f = fakeLedger([makeGroup()]);
    const gh = fakeGh([ghView({ reviews: [review({ state: 'APPROVED', login: 'bob' })], comments: [] })]);
    const events = await new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run: gh.run }).poll();

    // approvedBy 必須被帶出來：它是下游 PrManager.merge 的 approvedBy（合併稽核的唯一憑證）
    assert.deepEqual(events, [{ type: 'approved', group: 'g_1', approvedBy: 'bob', prNumber: 42 }]);
    assert.equal(f.groups[0]?.state, 'in_review', '核准後不自行進 merge_guard／merged');
    assert.deepEqual(gh.calls[0]?.args, [
      'pr', 'view', '42', '--repo', 'acme/web',
      '--json', 'number,state,mergeable,reviewDecision,isDraft,url,reviews,comments',
    ]);
    assert.ok(f.events.some((e) => e.kind === 'review_approved' && e.detail === 'bob'));
  });

  it('changes_requested → 群組轉狀態，reviewer 意見（含一般留言）整理成 feedback', async () => {
    const f = fakeLedger([makeGroup({ state: 'in_review' })]);
    const gh = fakeGh([
      ghView({
        reviews: [review({ id: 'PRR_9', state: 'CHANGES_REQUESTED', login: 'bob', body: '這裡要加錯誤處理' })],
        comments: [comment({ id: 'IC_9', login: 'carol', body: '順便補測試' })],
      }),
    ]);
    const events = await new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run: gh.run }).poll();

    assert.deepEqual(events, [
      { type: 'changes_requested', group: 'g_1', comments: ['@bob: 這裡要加錯誤處理', '@carol: 順便補測試'] },
    ]);
    assert.equal(f.groups[0]?.state, 'changes_requested');
    const logged = f.events.find((e) => e.kind === 'review_changes_requested');
    assert.deepEqual(JSON.parse(logged?.detail ?? 'null'), ['@bob: 這裡要加錯誤處理', '@carol: 順便補測試']);
  });

  it('pr_open 有審查活動 → 先轉 in_review', async () => {
    const f = fakeLedger([makeGroup({ state: 'pr_open' })]);
    const gh = fakeGh([ghView({ reviews: [], comments: [comment({ body: '看一下這段' })] })]);
    const events = await new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run: gh.run }).poll();

    assert.deepEqual(events, [], '只有留言不算決定，不產生事件');
    assert.equal(f.groups[0]?.state, 'in_review');
  });

  it('只有留言時不標記已處理 → 之後要求修改時仍會被一併回灌', async () => {
    const f = fakeLedger([makeGroup({ state: 'in_review' })]);
    const gh = fakeGh([
      ghView({ reviews: [], comments: [comment({ id: 'IC_1', login: 'alice', body: '這個命名怪怪的' })] }),
      ghView({
        reviews: [review({ id: 'PRR_2', state: 'CHANGES_REQUESTED', login: 'alice', body: '請照上面留言改' })],
        comments: [comment({ id: 'IC_1', login: 'alice', body: '這個命名怪怪的' })],
      }),
    ]);
    const w = new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run: gh.run });

    assert.deepEqual(await w.poll(), []);
    const second = await w.poll();

    assert.equal(second.length, 1);
    assert.deepEqual(second[0], {
      type: 'changes_requested',
      group: 'g_1',
      comments: ['@alice: 請照上面留言改', '@alice: 這個命名怪怪的'],
    });
  });

  it('同輪出現多則 review → 由最新一則決定（時間序，不看陣列順序）', async () => {
    const f = fakeLedger([makeGroup({ state: 'in_review' })]);
    const gh = fakeGh([
      ghView({
        reviews: [
          review({ id: 'PRR_new', state: 'APPROVED', login: 'bob', at: '2026-07-02T09:00:00Z' }),
          review({ id: 'PRR_old', state: 'CHANGES_REQUESTED', login: 'bob', body: '舊意見', at: '2026-07-01T09:00:00Z' }),
        ],
        comments: [],
      }),
    ]);
    const events = await new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run: gh.run }).poll();

    assert.deepEqual(events, [{ type: 'approved', group: 'g_1', approvedBy: 'bob', prNumber: 42 }]);
    assert.equal(f.groups[0]?.state, 'in_review');
  });

  it('空 body 的核准不會變成空白 feedback', async () => {
    const f = fakeLedger([makeGroup({ state: 'in_review' })]);
    const gh = fakeGh([
      ghView({
        reviews: [
          review({ id: 'PRR_a', state: 'APPROVED', body: '' }),
          review({ id: 'PRR_b', state: 'CHANGES_REQUESTED', body: '  ', at: '2026-07-03T00:00:00Z' }),
        ],
        comments: [],
      }),
    ]);
    const events = await new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run: gh.run }).poll();

    assert.deepEqual(events, [{ type: 'changes_requested', group: 'g_1', comments: [] }]);
  });
});

describe('ReviewWatcher — 去重', () => {
  it('同一則 review 連續兩輪只觸發一次', async () => {
    const f = fakeLedger([makeGroup({ state: 'in_review' })]);
    const payload = ghView({ reviews: [review({ id: 'PRR_1', state: 'APPROVED' })], comments: [] });
    const gh = fakeGh(() => payload);
    const w = new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run: gh.run });

    assert.equal((await w.poll()).length, 1);
    assert.deepEqual(await w.poll(), []);
    assert.equal(gh.calls.length, 2, '仍會查，只是不重複觸發');
    assert.equal(f.events.filter((e) => e.kind === SEEN_EVENT_KIND).length, 1);
  });

  it('沒有 id 的 review 以內容雜湊去重（舊版 gh 輸出）', async () => {
    const f = fakeLedger([makeGroup({ state: 'in_review' })]);
    const raw = {
      reviews: [{ author: { login: 'bob' }, state: 'CHANGES_REQUESTED', body: '改這裡', submittedAt: '2026-07-01T10:00:00Z' }],
      comments: [],
    };
    const gh = fakeGh(() => ghView(raw));
    const w = new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run: gh.run });

    assert.equal((await w.poll()).length, 1);
    f.groups[0]!.state = 'in_review'; // 模擬修完後回到審查中
    assert.deepEqual(await w.poll(), [], '同一則意見不可再次觸發');
  });

  it('ledger 具備 events 查詢能力時，換一個 watcher 實例（模擬重啟）也不重複觸發', async () => {
    const f = fakeLedger([makeGroup({ state: 'in_review' })], { withEventQuery: true });
    const gh = fakeGh(() => ghView({ reviews: [review({ id: 'PRR_1', state: 'APPROVED' })], comments: [] }));

    const first = await new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run: gh.run }).poll();
    const afterRestart = await new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run: gh.run }).poll();

    assert.equal(first.length, 1);
    assert.deepEqual(afterRestart, [], '已處理過的 review 記在 ledger events，重啟後仍去重');
  });
});

describe('ReviewWatcher — 優雅降級', () => {
  it('未安裝 gh（spawn 失敗）→ 回空、記警告，且不再對其餘群組發指令', async () => {
    const f = fakeLedger([makeGroup({ id: 'g_1' }), makeGroup({ id: 'g_2', prNumber: 43 })]);
    const gh = fakeGh(() => ({ exitCode: -1, stderr: 'spawn gh ENOENT' }));
    const rec = createRecordingLogger();
    const w = new ReviewWatcher({ ledger: f.ledger, log: rec.logger, run: gh.run });

    assert.deepEqual(await w.poll(), []);
    assert.equal(gh.calls.length, 1, 'gh 整體不可用就不必再問下一個群組');
    assert.ok(rec.messages('warn').some((m) => m.includes('gh 不可用')));
    assert.deepEqual(f.groups.map((g) => g.state), ['pr_open', 'pr_open'], '狀態不可被亂改');
  });

  it('未登入（exit 4）→ 進入退避，退避期間不再呼叫 gh；到期後重試', async () => {
    const f = fakeLedger([makeGroup({ state: 'in_review' })]);
    const gh = fakeGh((n) =>
      n === 0
        ? { exitCode: 4, stderr: 'gh auth login 需要重新登入' }
        : ghView({ reviews: [review({ id: 'PRR_1', state: 'APPROVED' })], comments: [] }),
    );
    let clock = 1_000;
    const w = new ReviewWatcher({
      ledger: f.ledger, log: createSilentLogger(), run: gh.run,
      unavailableBackoffMs: 5_000, now: () => clock,
    });

    assert.deepEqual(await w.poll(), []);
    clock += 1_000;
    assert.deepEqual(await w.poll(), []);
    assert.equal(gh.calls.length, 1, '退避期間不該再打 gh');

    clock += 10_000;
    assert.deepEqual(await w.poll(), [{ type: 'approved', group: 'g_1', approvedBy: 'alice', prNumber: 42 }]);
    assert.equal(gh.calls.length, 2);
  });

  it('PR 不存在／無權限 → 只跳過該群組，其他群組照常處理', async () => {
    const f = fakeLedger([
      makeGroup({ id: 'g_1', prNumber: 42, state: 'in_review' }),
      makeGroup({ id: 'g_2', prNumber: 43, state: 'in_review' }),
    ]);
    const gh = fakeGh((n) =>
      n === 0
        ? { exitCode: 1, stderr: 'no pull requests found for branch' }
        : ghView({ number: 43, reviews: [review({ id: 'PRR_2', state: 'APPROVED' })], comments: [] }),
    );
    const rec = createRecordingLogger();
    const events = await new ReviewWatcher({ ledger: f.ledger, log: rec.logger, run: gh.run }).poll();

    assert.deepEqual(events, [{ type: 'approved', group: 'g_2', approvedBy: 'alice', prNumber: 43 }]);
    assert.ok(rec.messages('warn').some((m) => m.includes('gh pr view 失敗')));
  });

  it('gh 輸出不是合法 JSON → 略過，不丟例外', async () => {
    const f = fakeLedger([makeGroup({ state: 'in_review' })]);
    const gh = fakeGh([{ stdout: '<html>proxy</html>' }]);
    const rec = createRecordingLogger();

    assert.deepEqual(await new ReviewWatcher({ ledger: f.ledger, log: rec.logger, run: gh.run }).poll(), []);
    assert.ok(rec.messages('warn').some((m) => m.includes('無法解析')));
  });

  it('執行器本身丟例外 → 該群組略過，整輪仍完成', async () => {
    const f = fakeLedger([
      makeGroup({ id: 'g_1', prNumber: 42, state: 'in_review' }),
      makeGroup({ id: 'g_2', prNumber: 43, state: 'in_review' }),
    ]);
    let n = 0;
    const run: CommandRunner = async () => {
      if (n++ === 0) throw new Error('突發爆炸');
      return { exitCode: 0, ...ghView({ reviews: [review({ id: 'x', state: 'APPROVED' })], comments: [] }), stderr: '' };
    };
    const events = await new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run }).poll();

    assert.deepEqual(events, [{ type: 'approved', group: 'g_2', approvedBy: 'alice', prNumber: 43 }]);
  });

  it('群組沒有 PR 編號（本地模式）→ 不呼叫 gh', async () => {
    const g = makeGroup();
    delete g.prNumber;
    const f = fakeLedger([g]);
    const gh = fakeGh([]);

    assert.deepEqual(await new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run: gh.run }).poll(), []);
    assert.equal(gh.calls.length, 0);
  });
});

describe('ReviewWatcher — PR 已離開審查', () => {
  it('PR 已被合併 → 群組收斂為 merged（不再無止境輪詢）', async () => {
    const f = fakeLedger([makeGroup({ state: 'in_review' })]);
    const gh = fakeGh([ghView({ state: 'MERGED', reviews: [], comments: [] })]);

    assert.deepEqual(await new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run: gh.run }).poll(), []);
    assert.equal(f.groups[0]?.state, 'merged');
    assert.ok(f.events.some((e) => e.kind === 'pr_merged'));
  });

  it('PR 被關閉（人為否決）→ 群組標記 failed 並警告', async () => {
    const f = fakeLedger([makeGroup({ state: 'in_review' })]);
    const gh = fakeGh([ghView({ state: 'CLOSED', reviews: [], comments: [] })]);
    const rec = createRecordingLogger();

    await new ReviewWatcher({ ledger: f.ledger, log: rec.logger, run: gh.run }).poll();

    assert.equal(f.groups[0]?.state, 'failed');
    assert.ok(rec.messages('warn').some((m) => m.includes('PR 已被關閉')));
  });
});

describe('ReviewWatcher — 與真實 Ledger 整合', () => {
  it('用真實 Ledger 走一遍：狀態真的落地、事件真的寫進 events', async () => {
    const tmp = createTmpLedger();
    try {
      tmp.ledger.upsertGroup({
        id: 'g_real', repo: 'acme/web', branch: 'feat/real', taskIds: ['T-1'], footprint: [],
        afterGroups: [], rationale: '',
        state: 'pr_open', prUrl: 'https://github.com/acme/web/pull/7', prNumber: 7,
      });
      const gh = fakeGh([
        ghView({
          number: 7,
          reviews: [review({ id: 'PRR_r', state: 'CHANGES_REQUESTED', login: 'dave', body: '請拆函式' })],
          comments: [],
        }),
      ]);
      // 型別上直接吃真實 Ledger（結構相容），不需任何轉接
      const events = await new ReviewWatcher({ ledger: tmp.ledger, log: createSilentLogger(), run: gh.run }).poll();

      assert.deepEqual(events, [{ type: 'changes_requested', group: 'g_real', comments: ['@dave: 請拆函式'] }]);
      assert.equal(tmp.ledger.getGroup('g_real')?.state, 'changes_requested');
      assert.deepEqual(tmp.ledger.listGroupsByState('changes_requested').map((g) => g.id), ['g_real']);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('ReviewFeedbackStore — 可回灌的審查意見', () => {
  // **意見存在 DB 裡，不是記憶體。** 先前是一個 Map，daemon 重啟就掉——
  // 而 orchestrator 看到「changes_requested 但沒有可回灌的意見」就不重新派工，
  // 於是群組永遠停著，log 上只有一行「可能 daemon 重啟過，暫不重新派工」。
  let tmp: TmpLedger;
  beforeEach(() => { tmp = createTmpLedger(); });
  afterEach(() => tmp.cleanup());

  it('存入後可被讀取；take 會讀走（避免下一輪重複回灌）', () => {
    const store = new ReviewFeedbackStore(tmp.ledger, () => 1234);
    store.save({ groupId: 'g_1', comments: ['@bob: 加錯誤處理'], source: 'github_review' });

    assert.equal(store.has('g_1'), true);
    // `at` 現在來自 DB 的 created_at（意見存在 handoffs 表裡），不是注入的時鐘
    const got = store.peek('g_1');
    assert.equal(got?.groupId, 'g_1');
    assert.deepEqual(got?.comments, ['@bob: 加錯誤處理']);
    assert.equal(got?.source, 'github_review');
    assert.equal(store.has('g_1'), true, 'peek 不可清掉');

    assert.equal(store.take('g_1')?.comments[0], '@bob: 加錯誤處理');
    assert.equal(store.has('g_1'), false, 'take 之後就不該再被回灌');
    assert.equal(store.take('g_1'), undefined);
  });

  // **這一條是這一片存在的理由。**
  //
  // 先前 store 是一個 Map，註解自陳「daemon 重啟後意見會遺失」。實跑的後果比那句話嚴重：
  // 重啟之後 orchestrator 看到「changes_requested 但沒有可回灌的意見」就不重新派工，
  // 於是群組永遠停著——log 上只有一行「可能 daemon 重啟過，暫不重新派工」。
  it('daemon 重啟後意見還在（換一個 store 實例照樣讀得到）', () => {
    new ReviewFeedbackStore(tmp.ledger).save({
      groupId: 'g_1', comments: ['@bob: 加錯誤處理'], source: 'merge_guard',
    });

    // 模擬重啟：全新的 store 實例，記憶體裡什麼都沒有
    const afterRestart = new ReviewFeedbackStore(tmp.ledger);

    assert.equal(afterRestart.has('g_1'), true, '重啟不該讓審查意見蒸發');
    assert.deepEqual(afterRestart.peek('g_1')?.comments, ['@bob: 加錯誤處理']);
    assert.equal(afterRestart.peek('g_1')?.source, 'merge_guard', '來源也要留著（決定回灌時的措辭）');
  });

  it('審查者按了 Request changes 卻沒留字 → 照樣開得出單（不然這一群會從回灌路徑上消失）', () => {
    const store = new ReviewFeedbackStore(tmp.ledger);
    store.save({ groupId: 'g_1', comments: [], source: 'github_review' });

    assert.equal(store.has('g_1'), true);
    assert.match(store.peek('g_1')?.comments[0] ?? '', /沒有留下文字說明/);
  });

  it('審查往返不會出現在人的待處理清單上（to_role 是 coder 不是 human）', () => {
    new ReviewFeedbackStore(tmp.ledger).save({ groupId: 'g_1', comments: ['改這裡'], source: 'github_review' });

    assert.deepEqual(
      tmp.ledger.listHandoffs({ toRole: 'human', unconsumedOnly: true }),
      [],
      '正常的審查往返灌進人的清單，人就再也分不出哪幾件真的需要自己動手',
    );
    assert.equal(tmp.ledger.listHandoffs({ toRole: 'coder', unconsumedOnly: true }).length, 1);
  });

  it('同一群組再次要求修改 → 覆寫（舊意見已被新意見取代）', () => {
    const store = new ReviewFeedbackStore(tmp.ledger);
    store.save({ groupId: 'g_1', comments: ['舊'], source: 'github_review' });
    store.save({ groupId: 'g_1', comments: ['新'], source: 'merge_guard' });

    assert.deepEqual(store.peek('g_1')?.comments, ['新']);
    assert.equal(store.peek('g_1')?.source, 'merge_guard');
  });

  it('每次寫入都留一份 events 稽核（重啟後仍查得到當時要求改什麼）', () => {
    const tmp = createTmpLedger();
    try {
      // 真實 Ledger（events 目前只能寫不能讀）：驗證稽核寫入這條路真的走得通、不丟例外
      const store = new ReviewFeedbackStore(tmp.ledger);
      store.save({ groupId: 'g_real', comments: ['@dave: 請拆函式'], source: 'github_review' });

      assert.equal(FEEDBACK_EVENT_KIND, 'review_feedback');
      assert.match(JSON.stringify(store.peek('g_real')), /請拆函式/);
    } finally {
      tmp.cleanup();
    }
  });

  it('promptFor 直接產出可塞進 agent prompt 的文字', () => {
    const store = new ReviewFeedbackStore(tmp.ledger);
    assert.equal(store.promptFor('g_x'), undefined, '沒有意見就不要生出空 prompt');
    store.save({ groupId: 'g_x', comments: ['A', 'B'], source: 'github_review' });
    const text = store.promptFor('g_x')!;
    assert.match(text, /1\. A/);
    assert.match(text, /2\. B/);
  });
});

describe('ReviewWatcher — 意見存進共用 store（changes_requested 不再是死狀態）', () => {
  let tmp: TmpLedger;
  beforeEach(() => { tmp = createTmpLedger(); });
  afterEach(() => tmp.cleanup());

  it('要求修改 → 意見進 store，可被 GroupRunner 回灌', async () => {
    const f = fakeLedger([makeGroup({ state: 'in_review' })]);
    const store = new ReviewFeedbackStore(tmp.ledger);
    const gh = fakeGh([
      ghView({
        reviews: [review({ id: 'PRR_9', state: 'CHANGES_REQUESTED', login: 'bob', body: '這裡要加錯誤處理' })],
        comments: [comment({ id: 'IC_9', login: 'carol', body: '順便補測試' })],
      }),
    ]);

    await new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run: gh.run, feedback: store }).poll();

    assert.equal(f.groups[0]?.state, 'changes_requested');
    assert.deepEqual(store.peek('g_1')?.comments, ['@bob: 這裡要加錯誤處理', '@carol: 順便補測試']);
    assert.equal(store.peek('g_1')?.source, 'github_review');
    assert.match(store.promptFor('g_1')!, /1\. @bob: 這裡要加錯誤處理/);
  });

  it('核准不會在 store 留下修改意見', async () => {
    const f = fakeLedger([makeGroup({ state: 'in_review' })]);
    const store = new ReviewFeedbackStore(tmp.ledger);
    const gh = fakeGh([ghView({ reviews: [review({ id: 'PRR_1', state: 'APPROVED', login: 'bob' })], comments: [] })]);

    await new ReviewWatcher({ ledger: f.ledger, log: createSilentLogger(), run: gh.run, feedback: store }).poll();

    assert.equal(store.has('g_1'), false);
  });
});

describe('formatFeedback', () => {
  it('依來源給不同開場白，意見逐條編號', () => {
    const guard = formatFeedback({ groupId: 'g', comments: ['[semantic_drift] build 紅'], source: 'merge_guard', at: 0 });
    assert.match(guard, /合併守衛/);
    assert.match(guard, /1\. \[semantic_drift\] build 紅/);

    const human = formatFeedback({ groupId: 'g', comments: ['再想想'], source: 'human_reject', at: 0 });
    assert.match(human, /人工合併閘門退回/);
  });

  it('沒有意見時依來源給明確替代說明（不產生空白 prompt）', () => {
    for (const source of ['github_review', 'merge_guard', 'human_reject'] as const) {
      const text = formatFeedback({ groupId: 'g', comments: [], source, at: 0 });
      assert.ok(text.length > 10, `${source} 必須有替代說明`);
      assert.doesNotMatch(text, /^\s*$/);
    }
  });
});

describe('formatReviewFeedback', () => {
  it('把意見編號後組成可回灌 agent 的文字', () => {
    const text = formatReviewFeedback({ type: 'changes_requested', group: 'g', comments: ['@bob: A', '@bob: B'] });
    assert.match(text, /1\. @bob: A/);
    assert.match(text, /2\. @bob: B/);
    assert.match(text, /DoD/);
  });

  it('沒有具體意見時給明確替代說明（不產生空白 prompt）', () => {
    const text = formatReviewFeedback({ type: 'changes_requested', group: 'g', comments: [] });
    assert.match(text, /未留下具體意見/);
  });
});

// ── PR 所在的 repo ──

/**
 * PR 一定開在 group.repo。
 *
 * 這裡原本要處理「PR 在 prRepo、不在 group.repo」的情況（把 PR 導到複本 repo 驗證），
 * 那個欄位已經移除——用測試用的任務板 ＋ 測試 repo 就好，不需要在系統裡多一層對映。
 */
describe('ReviewWatcher — 查 PR 用的是 group.repo', () => {
  const group = {
    id: 'g1', repo: 'acme/web', branch: 'b', taskIds: [], footprint: [],
    state: 'in_review' as const, prNumber: 7, createdAt: 0, updatedAt: 0,
  };

  it('用 group.repo 查', async () => {
    const calls: string[][] = [];
    const ledger = {
      listGroupsByState: (s: string) => (s === 'in_review' ? [group] : []),
      updateGroupState: () => {},
      logEvent: () => {},
      hasEvent: () => false,
      latestEvent: () => undefined,
    };
    const w = new ReviewWatcher({
      ledger: ledger as never,
      log: createSilentLogger(),
      run: async (_cmd: string, args: string[]) => {
        calls.push(args);
        return { exitCode: 0, stdout: JSON.stringify({ state: 'OPEN', reviews: [], comments: [] }), stderr: '' };
      },
    });
    await w.poll();
    assert.equal(calls[0]![calls[0]!.indexOf('--repo') + 1], 'acme/web');
  });
});

/**
 * 被 Merge Guard 退回 changes_requested 的群組，PR 還開著、還會被人在 GitHub 上合併。
 *
 * 實跑撞到的死結：poll() 寫死只掃 ['pr_open','in_review']，於是那兩個群永遠不再被輪詢——
 * 使用者手動合併了 PR #54/#46，群組卻永遠停在 changes_requested，
 * 下游 4 個群一直回報「前置任務的成果還沒進 base」，16 個任務永久卡住，
 * 而每輪只有一行 WARN，看起來跟正常等待一模一樣。
 */
describe('ReviewWatcher — 還開著 PR 的群組都要被追', () => {
  for (const state of ['changes_requested', 'merge_guard', 'pr_open', 'in_review'] as const) {
    it(`${state} 的群組，PR 在 GitHub 被合併 → 收斂成 merged`, async () => {
      const group = makeGroup({ id: 'g1', state, prNumber: 42 });
      const { ledger } = fakeLedger([group]);
      const watcher = new ReviewWatcher({
        ledger,
        log: createSilentLogger(),
        run: async () => ({ exitCode: 0, stdout: JSON.stringify({ number: 42, state: 'MERGED', url: 'u' }), stderr: '' }),
      });

      await watcher.poll();

      assert.equal(group.state, 'merged', `${state} 的群組沒有被追到——PR 合了它卻永遠停在原地`);
    });
  }

  it('沒有 PR 編號的群組不會被輪詢（forming/ready 本來就沒東西可追）', async () => {
    const group = makeGroup({ id: 'g2', state: 'ready' });
    delete (group as { prNumber?: number }).prNumber;
    const { ledger } = fakeLedger([group]);
    let called = 0;
    const watcher = new ReviewWatcher({
      ledger,
      log: createSilentLogger(),
      run: async () => { called += 1; return { exitCode: 0, stdout: '{}', stderr: '' }; },
    });

    await watcher.poll();

    assert.equal(called, 0, '沒有 PR 就不該去問 GitHub');
  });

  it('同一群同時符合多個狀態查詢時只列一次', () => {
    const g = makeGroup({ id: 'dup', state: 'changes_requested', prNumber: 7 });
    const ledger = { listGroupsByState: (_s: GroupState) => [g] };
    assert.equal(groupsWithLivePr(ledger).length, 1);
  });
});
