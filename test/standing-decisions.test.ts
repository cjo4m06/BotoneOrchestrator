import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { InboundRouter } from '../src/notify/notifier.js';
import { standingDecisions, STANDING_DECISION } from '../src/worker/human-reply.js';
import { buildAgentPrompt } from '../src/worker/agent-runtime.js';
import { resolveAction } from '../src/cli/ask.js';
import { createTmpLedger, createSilentLogger, makeTaskDetail, type TmpLedger } from './helpers/index.js';
import { HANDOFF_ACTIONS } from '../src/core/handoff.js';

/**
 * 常設決定：人拍板過的事，下一張卡不必再問一次。
 *
 * ── 為什麼需要它 ──
 *
 * 實跑（2026-08-04）：`spec/ 寫不進去` 這件事，02:43 害了 QTa5wZ5CIi_z，
 * 17:44 又原封不動害了 zZb5MGTMdQRZ——**同一個 repo、同一個成因、相隔 14 小時**。
 *
 * 就算第一次有人回答了，那個答案也只存在於第一張卡的事件裡。第二張卡看不到，
 * 於是重問一次、重卡一次。而 `handoffs.scope`（「人的答覆適用到哪」）這個欄位
 * 早就建好了，只是**零個生產者**——這個 repo 被同一種病咬過五次。
 */

describe('常設決定的寫入端', () => {
  let tmp: TmpLedger;
  beforeEach(() => { tmp?.cleanup(); tmp = createTmpLedger(); });
  after(() => tmp?.cleanup());

  function seedAsking(): void {
    tmp.ledger.upsertDiscoveredTask({
      id: 'T-1', payloadHash: 'h', repo: 'o/r', category: 'dev',
      title: '修觸控熱區', description: 'd', dependencies: [], docRefs: [],
    });
    tmp.ledger.logEvent('task', 'T-1', 'clarification_asked', JSON.stringify({ question: 'spec/ 寫不進去，這個特例要記在哪？' }));
    tmp.ledger.setBlock('T-1', 'needs_clarification', 'spec/ 寫不進去');
  }

  it('scope=always → 掛到 repo 上，連問題一起記', () => {
    seedAsking();
    const router = new InboundRouter({ ledger: tmp.ledger, log: createSilentLogger() });

    router.handleAnswer({ taskId: 'T-1', threadTs: 't', freeText: '記在 PR 內文就好，不必寫 spec', scope: 'always' });

    const d = standingDecisions(tmp.ledger, 'o/r');
    assert.equal(d.length, 1);
    assert.match(d[0]!.answer, /記在 PR 內文/);
    assert.match(d[0]!.question, /spec\/ 寫不進去/, '只留答案的話下一個 agent 不知道它在回答什麼');
  });

  it('沒標 always → 只留在這張卡上（預設不擴散）', () => {
    seedAsking();
    const router = new InboundRouter({ ledger: tmp.ledger, log: createSilentLogger() });

    router.handleAnswer({ taskId: 'T-1', threadTs: 't', freeText: '這次先這樣' });

    assert.deepEqual(standingDecisions(tmp.ledger, 'o/r'), [], '一次性的答案擴散出去比不擴散更危險');
    assert.equal(tmp.ledger.getTask('T-1')?.state, 'queued', '但這張卡照樣解除受阻');
  });

  it('常設決定只影響同一個 repo', () => {
    seedAsking();
    new InboundRouter({ ledger: tmp.ledger, log: createSilentLogger() })
      .handleAnswer({ taskId: 'T-1', threadTs: 't', freeText: 'x', scope: 'always' });

    assert.equal(standingDecisions(tmp.ledger, 'other/repo').length, 0);
  });

  it('壞掉的紀錄不會讓讀取端崩掉', () => {
    tmp.ledger.logEvent('system', 'o/r', STANDING_DECISION, '{壞掉的');
    assert.doesNotThrow(() => standingDecisions(tmp.ledger, 'o/r'));
  });
});

describe('常設決定的讀取端：要真的送到寫程式的 agent 面前', () => {
  const base = {
    cwd: '/tmp/worktree',
    task: makeTaskDetail({ id: 'T-2', docRefs: [] }),
    docs: [],
  };

  it('出現在 prompt 裡，並明講「不要再問一次」', () => {
    const p = buildAgentPrompt({
      ...base,
      standingDecisions: [{ question: 'spec/ 寫不進去，特例記在哪？', answer: '記在 PR 內文就好' }],
    });

    assert.match(p, /spec\/ 寫不進去/);
    assert.match(p, /記在 PR 內文就好/);
    assert.match(p, /不要再問一次/, '沒有這句它會照樣再問，那這整套就白做了');
  });

  it('沒有常設決定 → 完全不出現這一段（不要用空段落佔版面）', () => {
    assert.doesNotMatch(buildAgentPrompt(base), /已經拍板的決定/);
  });

  it('允許偏離但要說出理由（不可以默默改掉人的決定）', () => {
    const p = buildAgentPrompt({ ...base, standingDecisions: [{ question: 'q', answer: 'a' }] });
    assert.match(p, /說出理由再偏離/);
  });
});

describe('CLI：--always', () => {
  const clar = {
    kind: 'clarification' as const,
    id: 'T-1', repo: 'o/r', title: '要問你', detail: '?',
    actions: HANDOFF_ACTIONS.clarification, since: 0,
  };

  it('答覆末尾的 --always 被解析成 scope，且不會混進答案裡', () => {
    const a = resolveAction([clar], 'T-1', ['記在', 'PR', '內文就好', '--always']);
    assert.ok(typeof a !== 'string');
    assert.equal(a.scope, 'always');
    assert.equal(a.answer, '記在 PR 內文就好', '--always 是旗標，不可以變成答案的一部分');
  });

  it('沒加旗標 → scope 是 undefined（預設只套這張卡）', () => {
    const a = resolveAction([clar], 'T-1', ['就這樣']);
    assert.ok(typeof a !== 'string');
    assert.equal(a.scope, undefined);
  });

  it('只打 --always 沒有答案 → 拒絕（不可以留下一筆空的常設決定）', () => {
    assert.equal(typeof resolveAction([clar], 'T-1', ['--always']), 'string');
  });
});
