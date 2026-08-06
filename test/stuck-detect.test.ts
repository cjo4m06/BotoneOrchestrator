import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectStuck, repeatedFriction, repeatedRejection } from '../src/worker/stuck-detect.js';
import { FRICTION_EVENT } from '../src/worker/friction.js';
import { ASK_HUMAN_TOOL_DESCRIPTION } from '../src/worker/agent-runtime.js';
import type { LedgerEvent } from '../src/store/ledger.js';

/**
 * 「同一個障礙第二次擋住你」的程式層保險。
 *
 * ── 為什麼不能只靠提示詞 ──
 *
 * 實跑（zZb5MGTMdQRZ，2026-08-04）：agent 用 report_friction 講了三次「spec 寫不進去」、
 * 一次都沒用 ask_human——而**它沒有做錯**。friction 的描述說「不影響本任務」，
 * ask_human 的描述說「不可逆或高風險的歧義」，而它遇到的既不是歧義也不高風險。
 * 它同時遵守了兩份說明，然後撞牆四輪、燒掉 36 美元。
 *
 * 所以這裡數的是**呼叫端看得到的事實**，不讀內容、不判斷語意。
 */

let seq = 0;
function ev(kind: string, detail: string): LedgerEvent {
  seq += 1;
  return { id: seq, scope: 'task', refId: 'T-1', kind, detail, createdAt: seq };
}
function friction(kind: string, what: string, evidence?: string): LedgerEvent {
  return ev(FRICTION_EVENT, JSON.stringify({ kind, what, ...(evidence ? { evidence } : {}) }));
}

describe('repeatedFriction：同一類障礙回報第二次', () => {
  it('同一個 kind 第二次 → 停下來，並把每一次的原話都帶出來', () => {
    const r = repeatedFriction([
      friction('system_limitation', 'PMM MCP 工具全程無授權'),
      friction('system_limitation', 'spec/ 不在 repo，docs MCP 唯讀，寫不回去', 'docRefs: spec/preview-panel.md'),
    ]);

    assert.equal(r?.kind, 'system_limitation');
    assert.equal(r?.count, 2);
    assert.match(r?.body ?? '', /PMM MCP 工具全程無授權/, '第一次的原話要在——人要看得出這兩次是不是同一件事');
    assert.match(r?.body ?? '', /docs MCP 唯讀/);
    assert.match(r?.body ?? '', /docRefs: spec\/preview-panel\.md/, '證據要一起帶');
  });

  it('只回報一次 → 不停（一次可能只是雜訊，而 park 會停掉整個群組）', () => {
    assert.equal(repeatedFriction([friction('system_limitation', 'PMM 沒授權')]), undefined);
  });

  it('兩次但不同 kind → 不停', () => {
    const r = repeatedFriction([
      friction('system_limitation', 'PMM 沒授權'),
      friction('gate_false_positive', '後端測試跟我無關'),
    ]);
    assert.equal(r, undefined, '不同類的兩件事不代表「同一個障礙擋了兩次」');
  });

  it('比對的是 kind 不是內容（agent 每輪都會重寫措辭）', () => {
    const r = repeatedFriction([
      friction('spec_problem', '規格 A 與現況不符'),
      friction('spec_problem', '完全不同的一段文字，講的是規格 B'),
    ]);
    assert.equal(r?.count, 2, '內容比對會因為 agent 換句話說而失效，kind 是封閉列舉才數得準');
  });

  it('壞掉的 friction JSON 不會讓偵測崩掉', () => {
    assert.doesNotThrow(() => repeatedFriction([ev(FRICTION_EVENT, '{壞掉的'), friction('other', 'x')]));
  });
});

/**
 * **只數次數，不讀內容。**
 *
 * 先前這裡用 `/\[(.*\.md.*)\]/` 從退回理由裡撈規格檔名，比對「同一份規格被退回兩次」。
 * 那是程式在讀審查者寫的散文然後猜「它在講哪一份規格」——換個寫法（不加方括號、
 * 英文檔名、根本沒提檔名）就撈不到，而撈不到就靜靜地不觸發。
 *
 * 「是不是同一件事」要讀懂內容才判斷得出來，那是人的事。程式數得準的是次數。
 */
describe('repeatedRejection：連續退回三次就交人', () => {
  const rej = (n: number) => ev('review_rejected', `第 ${n} 次退回：某個理由`);

  it('連續三次 → 停下來，並把每一輪的原話都附上', () => {
    const r = repeatedRejection([rej(1), rej(2), rej(3)]);

    assert.equal(r?.kind, 'review');
    assert.equal(r?.count, 3);
    assert.match(r?.body ?? '', /第 1 次退回/);
    assert.match(r?.body ?? '', /第 3 次退回/);
    assert.match(r?.body ?? '', /無法同時成立/, '要點出「這可能是互斥」，否則人以為只是 agent 做不好');
  });

  it('兩次 → 不停（第二次還在合理的迭代範圍）', () => {
    assert.equal(repeatedRejection([rej(1), rej(2)]), undefined);
  });

  it('不看內容——沒有檔名、英文、隨便寫都一樣數得到', () => {
    const r = repeatedRejection([
      ev('review_rejected', 'nope'),
      ev('review_rejected', 'still not right'),
      ev('review_rejected', '就是不行'),
    ]);
    assert.equal(r?.count, 3, '先前的正則要求方括號裡有 .md，這三筆一個都撈不到');
  });
});

describe('detectStuck：兩道保險合一', () => {
  it('連續退回優先報（它代表已經燒掉三輪）', () => {
    const r = detectStuck([
      friction('system_limitation', 'a'),
      friction('system_limitation', 'b'),
      ev('review_rejected', '不符 1'),
      ev('review_rejected', '不符 2'),
      ev('review_rejected', '不符 3'),
    ]);
    assert.equal(r?.kind, 'review');
  });

  it('什麼都沒重複 → undefined（不可以動不動就停整個群組）', () => {
    assert.equal(detectStuck([friction('system_limitation', 'a'), ev('review_rejected', '不符')]), undefined);
  });

  it('空事件表 → undefined', () => {
    assert.equal(detectStuck([]), undefined);
  });
});

describe('ask_human 的門檻：軸是「能力」不是「後果」', () => {
  const d = ASK_HUMAN_TOOL_DESCRIPTION;

  it('三個條件都寫出來了', () => {
    assert.match(d, /實際擋住交付/);
    assert.match(d, /修復點.*不在你碰得到的範圍/);
    assert.match(d, /第二次擋住你/);
  });

  it('明講判準是能力而不是後果', () => {
    assert.match(d, /我修不修得動/);
    assert.match(d, /不是「後果嚴不嚴重」/);
    assert.match(
      d,
      /可逆又低風險/,
      '舊門檻（不可逆／高風險）正是漏掉實跑那次的原因——要明寫「可逆低風險也可能要問」',
    );
  });

  it('**一定要有反例**，否則會過度求助（ask_human 會停掉整個群組）', () => {
    assert.match(d, /這些不要問/);
    assert.match(d, /兩個方案都可行/);
    assert.match(d, /還沒動手試過/);
  });

  it('點出互斥要說出來、不要自己選一邊', () => {
    assert.match(d, /互斥/);
    assert.match(d, /不要自己選一邊/);
  });

  it('講出代價（會停掉整個群組，不只這張卡）', () => {
    assert.match(d, /整個群組/);
  });
});
