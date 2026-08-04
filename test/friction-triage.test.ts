import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  triagedMap,
  toTaskCardText,
  isTriageAction,
  FRICTION_TRIAGED,
  TRIAGE_LABEL,
  TRIAGE_ACTIONS,
} from '../src/worker/friction-triage.js';
import { summarizeFriction, FRICTION_EVENT } from '../src/worker/friction.js';
import type { LedgerEvent } from '../src/store/ledger.js';
import { createTmpLedger } from './helpers/index.js';

/**
 * 分診：把「看得見」補成「處理得掉」。
 *
 * ── 這組測試在守什麼 ──
 *
 * 一份**只會長不會消**的清單，三週後就是沒人點的紅點——而那正是這一整串在修的病
 * （`blocked` 欄位、被灌爆的待處理清單，形狀都一樣：講得出來，但講了沒有用）。
 *
 * 所以守的重點是兩個方向都不能壞：
 * · 處理過的**要真的消失**（否則清單不會變短）
 * · 沒處理過的**絕不能被藏起來**（那比不能處理更糟——它會靜靜地不見）
 */

let seq = 0;
function ev(kind: string, refId: string | null, detail: string): LedgerEvent {
  seq += 1;
  return { id: seq, scope: kind === FRICTION_TRIAGED ? 'system' : 'task', refId, kind, detail, createdAt: seq };
}
function report(id: number, taskId: string, kind: string, what: string) {
  return { id, taskId, detail: JSON.stringify({ kind, what }) };
}

describe('triagedMap：哪幾筆已經處理過', () => {
  it('讀得出動作與理由', () => {
    const m = triagedMap([ev(FRICTION_TRIAGED, '7', JSON.stringify({ action: 'wont_fix', note: '有替代路徑', by: 'console' }))]);
    assert.equal(m.get(7)?.action, 'wont_fix');
    assert.equal(m.get(7)?.note, '有替代路徑');
  });

  it('同一筆分診兩次 → 以最後一次為準（人會改變主意）', () => {
    const m = triagedMap([
      ev(FRICTION_TRIAGED, '7', JSON.stringify({ action: 'wont_fix', note: '先不管' })),
      ev(FRICTION_TRIAGED, '7', JSON.stringify({ action: 'to_task' })),
    ]);
    assert.equal(m.get(7)?.action, 'to_task', '先標不處理、後來發現真的要修，是正常的');
  });

  it('**壞掉的紀錄當成沒處理過**（寧可讓它再出現一次，也不要靜靜地藏起來）', () => {
    const m = triagedMap([
      ev(FRICTION_TRIAGED, '7', '{壞掉的'),
      ev(FRICTION_TRIAGED, '8', JSON.stringify({ action: '亂寫的動作' })),
    ]);
    assert.equal(m.has(7), false);
    assert.equal(m.has(8), false, '不認得的動作也一樣——藏起來比重複出現危險得多');
  });

  it('refId 不是數字就跳過，不會崩', () => {
    assert.doesNotThrow(() => triagedMap([ev(FRICTION_TRIAGED, 'abc', JSON.stringify({ action: 'resolved' }))]));
  });

  it('三個動作都是合法的，其他不是', () => {
    for (const a of TRIAGE_ACTIONS) assert.ok(isTriageAction(a));
    assert.equal(isTriageAction('deleted'), false);
    assert.equal(isTriageAction(''), false);
    assert.deepEqual(Object.keys(TRIAGE_LABEL).sort(), [...TRIAGE_ACTIONS].sort(), '按鈕文案要與動作一一對應');
  });
});

describe('summarizeFriction：處理過的要消失，沒處理過的不准不見', () => {
  const rows = [
    report(1, 'T-1', 'system_limitation', 'PMM 沒授權'),
    report(2, 'T-2', 'system_limitation', 'spec/ 寫不進去'),
    report(3, 'T-3', 'gate_false_positive', '後端測試跟我無關'),
  ];

  it('沒有分診紀錄 → 全部都是待處理', () => {
    const s = summarizeFriction(rows, 20, new Map());
    assert.equal(s.total, 3);
    assert.equal(s.triaged, 0);
  });

  it('處理過的從 total、groups、recent 三個地方**同時**消失', () => {
    const s = summarizeFriction(rows, 20, new Map([[1, { action: 'resolved' }]]));

    assert.equal(s.total, 2);
    assert.equal(s.triaged, 1, '要看得到它在減少，否則人不知道自己有沒有在前進');
    assert.equal(s.groups.flatMap((g) => g.items).some((i) => i.id === 1), false);
    assert.equal(s.recent.some((i) => i.id === 1), false, '三個出口漏一個，畫面就會前後不一致');
    assert.equal(s.byKind.system_limitation, 1, '分類統計也要跟著減');
  });

  it('**沒被分診的一筆都不能少**（藏起來比不能處理更糟）', () => {
    const s = summarizeFriction(rows, 20, new Map([[999, { action: 'resolved' }]]));
    assert.equal(s.total, 3, '分診紀錄指到不存在的 id 時，不可以誤殺任何一筆');
  });

  it('依 kind 分組，多的排前面', () => {
    const s = summarizeFriction(rows, 20, new Map());
    assert.deepEqual(s.groups.map((g) => `${g.kind}:${g.count}`), ['system_limitation:2', 'gate_false_positive:1']);
  });

  it('分組**只用 agent 自己填的 kind**，不做文字相似度', () => {
    // 兩筆內容幾乎一樣但 kind 不同 → 不可以被併在一起
    const s = summarizeFriction(
      [report(1, 'T-1', 'spec_problem', '規格 A 有問題'), report(2, 'T-2', 'gate_missed', '規格 A 有問題')],
      20,
      new Map(),
    );
    assert.equal(s.groups.length, 2, '猜語意的相似度換個寫法就失效——真正的去重要交給分診 agent');
  });

  it('全部處理完 → total 0，畫面會顯示空狀態而不是舊資料', () => {
    const s = summarizeFriction(rows, 20, new Map(rows.map((r) => [r.id, { action: 'resolved' as const }])));
    assert.equal(s.total, 0);
    assert.deepEqual(s.groups, []);
    assert.equal(s.triaged, 3);
  });

  it('沒帶分診表（CLI 舊呼叫端）→ 全部視為待處理，不會爆', () => {
    assert.equal(summarizeFriction(rows).total, 3);
  });
});

describe('toTaskCardText：轉成任務板的文字', () => {
  it('原話、證據、建議、出處全部原樣帶過去', () => {
    const t = toTaskCardText({
      kind: 'gate_missed',
      what: 'listNotifications 的 keyset 游標會在同一毫秒內多列時靜默漏資料',
      evidence: 'src/server/notifications.ts:142',
      suggestion: '游標改成 (created_at, id) 複合鍵',
      taskId: 'p-xSTMgKe3Ij',
    });

    assert.match(t, /keyset 游標/);
    assert.match(t, /src\/server\/notifications\.ts:142/, '檔案與行號是這些回報唯一有價值的東西，不可以被摘要掉');
    assert.match(t, /複合鍵/);
    assert.match(t, /p-xSTMgKe3Ij/, '要查得回原始出處');
  });

  it('缺欄位不會產生「undefined」這種字串', () => {
    const t = toTaskCardText({ what: '只有一句話' });
    assert.doesNotMatch(t, /undefined/);
  });
});

/**
 * 對抗式稽核（2026-08-04）找出來的四個洞。每一個都會讓回報**靜靜消失或永遠消不掉**，
 * 而那正是這個功能存在的理由——所以它們的回歸測試放在這裡，不放在別處。
 */
describe('稽核找出來的洞（回歸）', () => {
  function freshLedger(t: { after(fn: () => void): void }) {
    const h = createTmpLedger();
    t.after(() => h.cleanup());
    h.ledger.upsertDiscoveredTask({
      id: 'T', payloadHash: 'h', repo: 'o/r', category: 'dev',
      title: 't', description: '', dependencies: [], docRefs: [],
    });
    return h.ledger;
  }

  it('**已分診的不佔視窗名額**——否則越處理，未處理的老回報越進不來', (t) => {
    const l = freshLedger(t);
    l.logEvent('task', 'T', FRICTION_EVENT, JSON.stringify({ kind: 'other', what: '從來沒人碰過的老回報' }));
    for (let i = 0; i < 200; i += 1) {
      l.logEvent('task', 'T', FRICTION_EVENT, JSON.stringify({ kind: 'other', what: `新 ${i}` }));
    }
    for (const e of l.listEvents({ scope: 'task', kind: FRICTION_EVENT, limit: 500 })) {
      if (e.detail?.includes('新 ')) l.logEvent('system', String(e.id), FRICTION_TRIAGED, JSON.stringify({ action: 'resolved' }));
    }

    const open = l.listOpenFriction(FRICTION_EVENT, FRICTION_TRIAGED, 200);

    assert.equal(open.length, 1, '視窗要留給還沒處理的');
    assert.match(open[0]!.detail ?? '', /老回報/,
      '先撈 200 筆再過濾的話，這筆會被已處理的擠出視窗——畫面顯示「沒有待處理的回報」，'
      + '而它還躺在 DB 裡。那是一個假的全綠燈：沒有錯誤、沒有 WARN，東西就是不見了');
    assert.equal(l.countTriagedFriction(FRICTION_EVENT, FRICTION_TRIAGED), 200);
  });

  it('新到舊：第一眼看到的是最新的那筆，不是最舊的', (t) => {
    const l = freshLedger(t);
    for (let i = 1; i <= 26; i += 1) {
      l.logEvent('task', 'T', FRICTION_EVENT, JSON.stringify({ kind: 'other', what: `第 ${i} 筆` }));
    }
    const rows = l.listOpenFriction(FRICTION_EVENT, FRICTION_TRIAGED, 200)
      .map((e) => ({ id: e.id, taskId: e.refId ?? '', ...(e.detail ? { detail: e.detail } : {}) }));

    const s = summarizeFriction(rows, 20, new Map());

    assert.match(s.recent[0]?.what ?? '', /第 26 筆/, '欄位叫 recent、CLI 標題寫「最近」，就不該給最舊的');
    assert.match(s.groups[0]?.items[0]?.what ?? '', /第 26 筆/, '同一類裡也要最新的排前面');
  });

  it('**保留策略不可以吃掉沒人處理過的回報**（會與「有人處理掉了」分不出來）', (t) => {
    const l = freshLedger(t);
    l.logEvent('task', 'T', FRICTION_EVENT, JSON.stringify({ kind: 'other', what: '沒人碰過' }));
    l.updateTaskState('T', 'done'); // 任務 done 之後就失去 scope='task' 的保護

    const deleted = l.pruneEvents(Date.now() + 86_400_000); // cutoff 拉到未來 = 全部逾期

    assert.equal(l.listOpenFriction(FRICTION_EVENT, FRICTION_TRIAGED, 200).length, 1,
      `回報被 prune 掉了（本次清了 ${deleted} 筆）。畫面上 total 少一筆、triaged 不會加一——`
      + '人完全看不出是「被清掉」還是「有人處理掉了」');
  });

  it('**分診紀錄也不可以被吃掉**（否則標過「不處理」的又跳回來，理由還消失了）', (t) => {
    const l = freshLedger(t);
    l.logEvent('task', 'T', FRICTION_EVENT, JSON.stringify({ kind: 'other', what: 'x' }));
    const id = l.listEvents({ scope: 'task', kind: FRICTION_EVENT, limit: 10 })[0]!.id;
    l.logEvent('system', String(id), FRICTION_TRIAGED, JSON.stringify({ action: 'wont_fix', note: '有替代路徑' }));

    l.pruneEvents(Date.now() + 86_400_000);

    const t2 = triagedMap(l.listEvents({ scope: 'system', kind: FRICTION_TRIAGED, limit: 10 }));
    assert.equal(t2.get(id)?.note, '有替代路徑',
      '分診紀錄（scope=system）逾期無條件刪、回報卻被保護 → 那筆回報原封不動跳回清單，'
      + '而當初「為什麼不處理」那句必填的理由永久消失');
  });
});
