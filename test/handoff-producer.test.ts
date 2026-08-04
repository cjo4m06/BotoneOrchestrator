import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handoffKindOfBlock, HANDOFF_ACTIONS } from '../src/core/handoff.js';
import { NO_CHANGE_BLOCK_PREFIX, RECLAIM_BLOCK_PREFIX } from '../src/notify/notifier.js';
import { createTmpLedger, makeDiscoveredTask, createSilentLogger, type TmpLedger } from './helpers/index.js';
import { collectPending } from '../src/core/pending.js';
import { openMergeApprovalHandoff, openStuckGroupHandoff } from '../src/core/handoff.js';

describe('handoffKindOfBlock：block 對應哪一種交接單', () => {
  it('needs_clarification → clarification', () => {
    assert.equal(handoffKindOfBlock('needs_clarification', '要用哪種快取？'), 'clarification');
  });

  it('「無需改動」前綴 → no_change（按鈕是確認／退回，不是重試）', () => {
    assert.equal(handoffKindOfBlock('needs_human', `${NO_CHANGE_BLOCK_PREFIX}：功能已存在`), 'no_change');
    assert.deepEqual(HANDOFF_ACTIONS.no_change, ['confirm', 'reject']);
  });

  it('「認領不回來」前綴 → reclaim_blocked，而且**沒有任何按鈕**', () => {
    assert.equal(handoffKindOfBlock('needs_human', `${RECLAIM_BLOCK_PREFIX}：卡在進行中`), 'reclaim_blocked');
    assert.deepEqual(
      HANDOFF_ACTIONS.reclaim_blocked,
      [],
      '解法不在這個系統裡——人得去任務板改回「待辦」，在這邊按重試永遠沒用（實跑：使用者按了 4 次）',
    );
  });

  it('其餘 needs_human → needs_human', () => {
    assert.equal(handoffKindOfBlock('needs_human', '跑了 20 輪仍未綠'), 'needs_human');
  });

  it('deps **不開單**——那是自動等待，不是要人處理的事', () => {
    assert.equal(
      handoffKindOfBlock('deps', '前置任務未完成'),
      undefined,
      '寫成單會把待處理清單灌爆，人就再也分不出哪幾件真的需要自己動手',
    );
  });
});

describe('setBlock 一定同時開單（停手與說話是同一個寫入動作）', () => {
  function setup(t: { after(fn: () => void): void }): TmpLedger {
    const h = createTmpLedger();
    t.after(() => h.cleanup());
    h.ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-1', title: '做一個按鈕' }));
    return h;
  }

  it('受阻就有單，不必呼叫端記得配一次', (t) => {
    const { ledger } = setup(t);
    ledger.setBlock('T-1', 'needs_clarification', 'CTA 要固定底部嗎？');

    const inbox = ledger.listHandoffs({ toRole: 'human', unconsumedOnly: true });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.kind, 'clarification');
    assert.equal(inbox[0]?.taskId, 'T-1');
    assert.equal(inbox[0]?.body, 'CTA 要固定底部嗎？');
    assert.equal(inbox[0]?.title, '做一個按鈕', '標題要看得出是哪張卡');
  });

  it('deps 不開單（自動等待）', (t) => {
    const { ledger } = setup(t);
    ledger.setBlock('T-1', 'deps', '前置任務未完成');
    assert.deepEqual(ledger.listHandoffs({ toRole: 'human', unconsumedOnly: true }), []);
  });

  it('同一種 kind 重複受阻只留一張（每輪都寫入，不去重會長出一整排）', (t) => {
    const { ledger } = setup(t);
    ledger.setBlock('T-1', 'needs_human', '跑了 20 輪仍未綠');
    ledger.setBlock('T-1', 'needs_human', '跑了 21 輪仍未綠');

    assert.equal(ledger.listHandoffs({ toRole: 'human', unconsumedOnly: true }).length, 1);
  });

  it('處理完之後再次受阻 → 開新的一張（不是被舊的擋住）', (t) => {
    const { ledger } = setup(t);
    ledger.setBlock('T-1', 'needs_human', '第一次');
    const first = ledger.listHandoffs({ toRole: 'human', unconsumedOnly: true })[0]!;
    ledger.consumeHandoff(first.id);

    ledger.setBlock('T-1', 'needs_human', '第二次');

    const inbox = ledger.listHandoffs({ toRole: 'human', unconsumedOnly: true });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.body, '第二次');
  });

  it('detail 是空的也要開得出單（用標題兜底）', (t) => {
    const { ledger } = setup(t);
    ledger.setBlock('T-1', 'needs_human');

    const inbox = ledger.listHandoffs({ toRole: 'human', unconsumedOnly: true });
    assert.equal(inbox.length, 1, '開不出單比「開一張沒有說明的單」更糟：前者是靜默');
    assert.equal(inbox[0]?.body, '做一個按鈕');
  });

  it('不同 kind 各自一張（澄清與「無需改動」的按鈕完全不同）', (t) => {
    const { ledger } = setup(t);
    ledger.setBlock('T-1', 'needs_clarification', '問題');
    ledger.setBlock('T-1', 'needs_human', `${NO_CHANGE_BLOCK_PREFIX}：已存在`);

    const kinds = ledger.listHandoffs({ toRole: 'human', unconsumedOnly: true }).map((h) => h.kind).sort();
    assert.deepEqual(kinds, ['clarification', 'no_change']);
  });
});

/**
 * 新舊兩套「誰在等人」的比對——第 8 片換讀取端之前的硬性關卡。
 *
 * 舊的是**推論**（從任務 block 狀態 + 群組狀態 + 事件反推），新的是**查詢**
 * （`to_role='human' AND consumed_at IS NULL`）。推論會漏，查詢不會——
 * 而漏掉的那次代價是 16 個任務堵著、控制台顯示「沒有需要你處理的事項」。
 */
describe('新舊清單比對：浮出來的東西必須一樣', () => {
  it('六種情境下，被通知的任務／群組集合完全一致', (t) => {
    const h = createTmpLedger();
    t.after(() => h.cleanup());
    const L = h.ledger;
    const log = createSilentLogger();
    const seed = (id: string) => L.upsertDiscoveredTask(makeDiscoveredTask({ id, title: `任務 ${id}` }));

    seed('T-clar'); L.setBlock('T-clar', 'needs_clarification', '要用哪種快取？');
    seed('T-nc');   L.setBlock('T-nc', 'needs_human', `${NO_CHANGE_BLOCK_PREFIX}：功能已存在`);
    seed('T-nh');   L.setBlock('T-nh', 'needs_human', '跑了 20 輪仍未綠');
    seed('T-rc');   L.setBlock('T-rc', 'needs_human', `${RECLAIM_BLOCK_PREFIX}：卡在進行中`);
    seed('T-deps'); L.setBlock('T-deps', 'deps', '前置未完成');

    seed('T-g1');
    const g1 = L.createGroup({ repo: 'o/r', branch: 'b1', taskIds: ['T-g1'], footprint: [] });
    L.updateGroupState(g1.id, 'in_review');
    L.logEvent('group', g1.id, 'policy_needs_human', '自動合併未開啟');
    openMergeApprovalHandoff(L, log, { groupId: g1.id, title: 't', why: '自動合併未開啟', taskIds: ['T-g1'] });

    seed('T-g2');
    const g2 = L.createGroup({ repo: 'o/r', branch: 'b2', taskIds: ['T-g2'], footprint: [] });
    L.updateGroupState(g2.id, 'changes_requested');
    L.logEvent('group', g2.id, 'requeue_exhausted', '已重試 3 次');
    openStuckGroupHandoff(L, log, { groupId: g2.id, repo: 'o/r', why: '重新派工已達上限' });

    const oldIds = new Set(collectPending(L).map((i) => i.id));
    const newIds = new Set(
      L.listHandoffs({ toRole: 'human', unconsumedOnly: true }).map((x) => x.taskId ?? x.groupId ?? '?'),
    );

    assert.deepEqual([...newIds].sort(), [...oldIds].sort(), '被通知的對象一個都不能多、一個都不能少');
    assert.equal(oldIds.has('T-deps'), false, 'deps 兩邊都不該出現（自動等待不是要人處理的事）');
  });

  // 舊推論沒有 reclaim_blocked 這條分支，一律標成 needs_human → 顯示「重試／中止」按鈕，
  // 而按重試永遠沒用（解法在任務板：要把卡改回「待辦」）。實跑：使用者按了 4 次。
  // `PendingKind` 早就宣告了這一種，只是從來沒有人產生它。
  it('認領不回來的卡標成 reclaim_blocked，而且沒有按鈕可按', (t) => {
    const h = createTmpLedger();
    t.after(() => h.cleanup());
    h.ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-rc', title: 'x' }));
    h.ledger.setBlock('T-rc', 'needs_human', `${RECLAIM_BLOCK_PREFIX}：卡在進行中`);

    const item = collectPending(h.ledger)[0];
    assert.equal(item?.kind, 'reclaim_blocked');
    assert.deepEqual(item?.actions, [], '給一顆按了沒用的按鈕比不給更糟');
  });
});

/**
 * clearBlock 一定要收單——**沒有這個寫入點，清單只會單向增長**。
 *
 * 原施工計畫的四條驗收全部只驗得到「看得見」，沒有一條驗「處理完會消失」。
 * 那個漏洞的症狀是：人回答了澄清、任務回到 queued，但那張單永遠留在「等你處理」上
 * ——比漏掉更糟，因為它看起來像系統壞了。
 */
describe('clearBlock 收單（處理完就從清單上消失）', () => {
  function setup(t: { after(fn: () => void): void }) {
    const h = createTmpLedger();
    t.after(() => h.cleanup());
    h.ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-1', title: '做一個按鈕' }));
    return h.ledger;
  }

  it('解除受阻 → 那張單標成已處理', (t) => {
    const L = setup(t);
    L.setBlock('T-1', 'needs_clarification', '要用哪種快取？');
    assert.equal(collectPending(L).length, 1);

    L.clearBlock('T-1', 'queued');

    assert.deepEqual(collectPending(L), [], '人回答完了，那張單就不該還掛在「等你處理」上');
    assert.equal(L.listHandoffs({ taskId: 'T-1' }).length, 1, '單本身留著當稽核軌跡');
  });

  it('同一任務多張單一次收乾淨', (t) => {
    const L = setup(t);
    L.setBlock('T-1', 'needs_clarification', '問題');
    L.setBlock('T-1', 'needs_human', '另一件事');
    assert.equal(collectPending(L).length, 2);

    L.clearBlock('T-1', 'queued');

    assert.deepEqual(collectPending(L), []);
  });

  it('不收別的任務的單', (t) => {
    const L = setup(t);
    L.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-2', title: '另一張卡' }));
    L.setBlock('T-1', 'needs_human', 'a');
    L.setBlock('T-2', 'needs_human', 'b');

    L.clearBlock('T-1', 'queued');

    assert.deepEqual(collectPending(L).map((i) => i.id), ['T-2']);
  });

  it('給 coder 的單（審查意見／交付說明）不被 clearBlock 收掉', (t) => {
    const L = setup(t);
    L.openHandoff({
      taskId: 'T-1', groupId: 'g1', fromRole: 'reviewer', toRole: 'coder',
      kind: 'review_feedback', title: 't', body: '這裡不符規格',
    });
    L.setBlock('T-1', 'needs_human', '等人');

    L.clearBlock('T-1', 'queued');

    assert.equal(
      L.listHandoffs({ taskId: 'T-1', toRole: 'coder', unconsumedOnly: true }).length,
      1,
      '人處理完自己那件事，不代表 agent 那邊的意見也處理完了',
    );
  });
});
