import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InboundRouter } from '../src/notify/notifier.js';
import { resolveAction, applyAction, type AskAction } from '../src/cli/ask.js';
import { collectPending } from '../src/core/pending.js';
import { HANDOFF_ACTIONS } from '../src/core/handoff.js';
import { generatePrBody } from '../src/pr/pr-body.js';
import { createTmpLedger, createSilentLogger, type TmpLedger } from './helpers/index.js';
import type { TaskDetail } from '../src/types.js';

/**
 * 定案③：「我知道這個紅，但它不是這一群造成的，照樣落地」。
 *
 * ── 這一組測試在守什麼 ──
 *
 * 這顆按鈕的存在理由是：系統**沒有修 base 的權力**。合併者做完歸咎實驗、
 * 裁定「這個紅在 base 上本來就會發生」之後，這一群依然落不了地——
 * 會累積一批「已裁定非我方責任、但卡著」的群，堵住的張數與誤判時一模一樣。
 *
 * 但一顆「無視紅燈」的按鈕本身就是危險品，所以三條界線要被測住：
 * 1. **一次性**——放行對的是當下那份程式碼＋當下那個紅，常駐等於永久關掉守衛。
 * 2. **理由必填**——事後查「當時憑什麼帶紅上線」只剩那一行字。
 * 3. **PR 不准說謊**——被放行的紅燈在驗證清單上必須是 ❌，不是 ✅。
 */

describe('Ledger：一次性的「已知紅燈」放行', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp?.cleanup();
    tmp = createTmpLedger();
  });
  after(() => tmp?.cleanup());

  it('沒人放行過 → 拿不到', () => {
    assert.equal(tmp.ledger.takeKnownRedWaiver('g_1'), undefined);
  });

  it('放行一次 → 拿得到理由，**第二次就沒有了**', () => {
    tmp.ledger.grantKnownRedWaiver('g_1', 'base 上的 schedule-engine 測試本來就會偶爾紅', 'kchen');

    assert.match(tmp.ledger.takeKnownRedWaiver('g_1') ?? '', /schedule-engine/);
    assert.equal(
      tmp.ledger.takeKnownRedWaiver('g_1'),
      undefined,
      '放行必須是一次性的：常駐的話這一群之後每次重跑都會自動吞掉紅燈，包括 agent 真的改壞的那個',
    );
  });

  it('用掉之後再放行一次 → 又拿得到（人可以重複表態）', () => {
    tmp.ledger.grantKnownRedWaiver('g_2', '第一次', 'kchen');
    tmp.ledger.takeKnownRedWaiver('g_2');
    tmp.ledger.grantKnownRedWaiver('g_2', '第二次', 'kchen');

    assert.equal(tmp.ledger.takeKnownRedWaiver('g_2'), '由 kchen 放行：第二次');
  });

  it('理由是空的 → 擲錯（事後查證只剩這一行字）', () => {
    assert.throws(() => tmp.ledger.grantKnownRedWaiver('g_3', '   ', 'kchen'), /理由不可為空/);
  });

  it('放行只影響指定的群組', () => {
    tmp.ledger.grantKnownRedWaiver('g_4', '只有這一群', 'kchen');
    assert.equal(tmp.ledger.takeKnownRedWaiver('g_5'), undefined);
    assert.ok(tmp.ledger.takeKnownRedWaiver('g_4'));
  });
});

describe('InboundRouter.landAnyway：人按下按鈕之後', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp?.cleanup();
    tmp = createTmpLedger();
  });
  after(() => tmp?.cleanup());

  function seedStuckGroup(): string {
    tmp.ledger.upsertDiscoveredTask({
      id: 'T-1', payloadHash: 'h', repo: 'o/r', category: 'dev',
      title: '做一個裁切視窗', description: 'd', dependencies: [], docRefs: [],
    });
    const g = tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: ['T-1'], footprint: [] });
    // failed 會由 updateGroupState 自動開一張 stuck_group 交接單
    tmp.ledger.updateGroupState(g.id, 'failed', { reason: 'Merge Guard 擋下（tests_red）' });
    return g.id;
  }

  it('放行 → 群組回到待派工、交接單被標成已處理、ledger 留下理由', async () => {
    const groupId = seedStuckGroup();
    assert.equal(collectPending(tmp.ledger).length, 1, '前置：這一群正在等人處理');

    const router = new InboundRouter({ ledger: tmp.ledger, log: createSilentLogger() });
    const ok = await router.landAnyway({ groupId, userId: 'kchen', note: 'base 自己就紅，跟這群無關' });

    assert.equal(ok, true);
    assert.equal(tmp.ledger.getGroup(groupId)?.state, 'ready');
    assert.equal(
      collectPending(tmp.ledger).length,
      0,
      '人按過的東西不能繼續掛在「等你處理」上——不然人會不再相信那份清單',
    );
    assert.match(tmp.ledger.takeKnownRedWaiver(groupId) ?? '', /base 自己就紅/);
  });

  it('沒附理由 → 不放行（不留下一筆查不出原因的放行）', async () => {
    const groupId = seedStuckGroup();
    const router = new InboundRouter({ ledger: tmp.ledger, log: createSilentLogger() });

    assert.equal(await router.landAnyway({ groupId, userId: 'kchen', note: '  ' }), false);
    assert.equal(tmp.ledger.takeKnownRedWaiver(groupId), undefined);
    assert.equal(tmp.ledger.getGroup(groupId)?.state, 'failed', '群組必須維持原狀');
  });

  it('群組不存在 → false，不擲錯（人機介面的回呼不能倒）', async () => {
    const router = new InboundRouter({ ledger: tmp.ledger, log: createSilentLogger() });
    assert.equal(await router.landAnyway({ groupId: 'g_nope', userId: 'kchen', note: '理由' }), false);
  });
});

describe('CLI：land-anyway 的解析與派送', () => {
  let tmp: TmpLedger;
  before(() => { tmp = createTmpLedger(); });
  after(() => tmp.cleanup());

  const stuck = {
    kind: 'stuck_group' as const,
    id: 'g_1',
    repo: 'o/r',
    title: '群組停手',
    detail: 'Merge Guard 擋下',
    actions: HANDOFF_ACTIONS.stuck_group,
    since: 0,
  };

  it('停手的群組有「照樣落地」這顆按鈕', () => {
    assert.ok(
      HANDOFF_ACTIONS.stuck_group.includes('land-anyway'),
      '沒有這顆的話，已裁定「非我方責任」的群永遠落不了地',
    );
  });

  it('`land-anyway <理由>` → 理由被帶進動作', () => {
    const a = resolveAction([stuck], 'g_1', ['land-anyway', 'base', '本來就紅']);
    assert.ok(typeof a !== 'string');
    assert.equal(a.verb, 'land-anyway');
    assert.equal(a.answer, 'base 本來就紅');
  });

  it('不支援這顆按鈕的項目 → 拒絕（澄清單不該能放行紅燈）', () => {
    const clar = { ...stuck, kind: 'clarification' as const, actions: HANDOFF_ACTIONS.clarification };
    const a = resolveAction([clar], 'g_1', ['land-anyway']);
    assert.equal(typeof a, 'string');
  });

  it('派送 → 呼叫 router.landAnyway 並把理由原樣傳過去', async () => {
    const seen: { groupId: string; note: string }[] = [];
    const action = resolveAction([stuck], 'g_1', ['land-anyway', '無關的後端測試不穩']) as AskAction;
    const msg = await applyAction(action, {
      log: createSilentLogger(),
      router: {
        handleAnswer: () => {},
        handleControl: () => {},
        handleMergeDecision: () => {},
        landAnyway: async (i) => { seen.push({ groupId: i.groupId, note: i.note }); return true; },
      },
    });

    assert.deepEqual(seen, [{ groupId: 'g_1', note: '無關的後端測試不穩' }]);
    assert.match(msg, /照樣落地/);
  });

  it('daemon 不在同一行程（沒接上 landAnyway）→ 明講沒接上，不謊報成功', async () => {
    const action = resolveAction([stuck], 'g_1', ['land-anyway', '理由']) as AskAction;
    const msg = await applyAction(action, {
      log: createSilentLogger(),
      router: { handleAnswer: () => {}, handleControl: () => {}, handleMergeDecision: () => {} },
    });
    assert.match(msg, /沒有接上/);
  });
});

describe('PR 內文：被放行的紅燈不准被寫成綠的', () => {
  const tasks: TaskDetail[] = [
    { id: 'T-1', title: '裁切視窗', status: 'done', repo: 'o/r', description: '', dependencies: [], docRefs: [], category: 'dev' },
  ];

  it('有放行 → 內文最前面就有一段「帶著一個已知的失敗合併」，含理由與判決全文', () => {
    const body = generatePrBody({
      tasks,
      knownRed: { note: 'base 上的 schedule-engine 本來就會偶爾紅', verdict: 'FAIL src/schedule-engine.test.ts\n  timeout' },
    });

    assert.match(body, /Known Red/);
    assert.match(body, /schedule-engine 本來就會偶爾紅/);
    assert.match(body, /FAIL src\/schedule-engine\.test\.ts/, '判決全文要在，不是只留一句摘要');
    assert.ok(
      body.indexOf('Known Red') < body.indexOf('涵蓋任務'),
      '這是審查者不主動找就不會知道、但一定要知道的事，必須在前面',
    );
  });

  it('沒放行 → 完全不出現這一段（正常的 PR 不該被警語污染）', () => {
    assert.doesNotMatch(generatePrBody({ tasks }), /Known Red/);
  });
});
