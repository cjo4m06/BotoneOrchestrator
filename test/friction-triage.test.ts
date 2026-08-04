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
