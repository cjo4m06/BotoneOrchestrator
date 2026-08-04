import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFrictionHandler,
  parseFrictionEvent,
  summarizeFriction,
  FRICTION_EVENT,
  FRICTION_TOOL_DESCRIPTION,
} from '../src/worker/friction.js';
import { createSilentLogger, createRecordingLogger } from './helpers/index.js';

/**
 * 為什麼要有這個出口：今天好幾個真 bug，是從 agent **順口說的話**裡撿到的——
 *   · 「AppModal 被 teleport 到 body 之外，就算補 dark: 也不會生效」
 *   · 「這個決策缺乏可查證出處」
 *   · 「規格的前提與實測結果不符，實測 5.55:1 已通過門檻」
 * 那些都是碰巧被讀到的。沒讀到的就消失了。
 */
describe('摩擦回報', () => {
  function sink() {
    const rows: { taskId: string; kind: string; detail?: string }[] = [];
    return {
      rows,
      logEvent: (_s: 'task', refId: string, kind: string, detail?: string) =>
        void rows.push({ taskId: refId, kind, ...(detail ? { detail } : {}) }),
    };
  }

  it('記下回報並回一句「這不影響本任務」', async () => {
    const s = sink();
    const h = createFrictionHandler(s, createSilentLogger(), 'T-1', 'coder');

    const r = await h({ kind: 'system_limitation', what: '查不到 base 的變更', evidence: 'git 不在工具清單' });

    assert.equal(s.rows.length, 1);
    assert.equal(s.rows[0]?.kind, FRICTION_EVENT);
    const parsed = parseFrictionEvent(s.rows[0]?.detail);
    assert.equal(parsed?.what, '查不到 base 的變更');
    // `blocked` 欄位已退場（第 C 片）：它問 agent「這件事有沒有實際擋住你」，
    // 但那個值只寫進 log 與統計，**沒有任何東西讀它改變行為**——實跑最後一筆
    // blocked=true，系統什麼都沒做。填得越誠實越不會求救，所以整個拿掉。
    assert.equal((parsed as unknown as Record<string, unknown>).blocked, undefined);
    assert.equal(parsed?.source, 'coder');
    // 這句很重要：不講清楚的話 agent 會以為回報等於交差
    assert.match(JSON.stringify(r), /不影響本任務/);
  });

  it('缺 what → 退回並說明要什麼，不寫入垃圾', async () => {
    const s = sink();
    const h = createFrictionHandler(s, createSilentLogger(), 'T-1', 'coder');
    await h({ kind: 'other' });
    assert.deepEqual(s.rows, []);
  });

  it('未知的 kind 退化成 other，不讓整筆回報作廢', async () => {
    const s = sink();
    await createFrictionHandler(s, createSilentLogger(), 'T-1', 'coder')({ kind: '我亂發明的', what: 'x' });
    assert.equal(parseFrictionEvent(s.rows[0]?.detail)?.kind, 'other');
  });

  it('寫入失敗只留 warn，絕不影響任務', async () => {
    const rec = createRecordingLogger();
    const bad = { logEvent: () => { throw new Error('db 掛了'); } };
    const r = await createFrictionHandler(bad, rec.logger, 'T-1', 'coder')({ kind: 'other', what: 'x' });
    assert.match(JSON.stringify(r), /已記錄/);
    assert.ok(rec.messages('warn').some((m) => /摩擦回報寫入失敗/.test(m)));
  });

  /**
   * 正式庫 26 筆實測：`workflow`（流程建議）這個 kind **一筆都沒有**，
   * 100% 被當成「我被擋住了」在用。把它定義成「建議管道」正是原本設計失準的地方。
   * 現在的定位只有一個：**我看到問題，你該知道，但它沒擋住我交付。**
   */
  it('工具說明要把分界線講死：擋住了就去 ask_human，不是留在這裡', () => {
    assert.match(FRICTION_TOOL_DESCRIPTION, /沒有擋住我交付/);
    assert.match(FRICTION_TOOL_DESCRIPTION, /不要用這個，用 ask_human/, '沒有這句就會重演：agent 講了三次卻沒人被通知');
    assert.match(FRICTION_TOOL_DESCRIPTION, /我還交得出去嗎/, '判準要給得出來，不能只說「看情況」');
    assert.match(FRICTION_TOOL_DESCRIPTION, /第二次/, '要讓 agent 知道重複回報會被自動升級');
    assert.match(FRICTION_TOOL_DESCRIPTION, /一定要附證據/);
  });
});

describe('summarizeFriction', () => {
  const ev = (o: Record<string, unknown>) => ({ taskId: String(o.taskId ?? 'T-1'), detail: JSON.stringify(o) });

  it('統計總數與分類', () => {
    const s = summarizeFriction([
      ev({ kind: 'system_limitation', what: 'a' }),
      ev({ kind: 'system_limitation', what: 'b' }),
      ev({ kind: 'spec_problem', what: 'c' }),
    ]);
    assert.equal(s.total, 3);

    assert.deepEqual(s.byKind, { system_limitation: 2, spec_problem: 1 });
  });

  it('壞掉的資料被跳過，不汙染統計', () => {
    const s = summarizeFriction([ev({ kind: 'other', what: 'ok' }), { taskId: 'T-2', detail: '不是 JSON' }, { taskId: 'T-3' }]);
    assert.equal(s.total, 1);
  });

  /**
   * **輸入是新到舊**（`listEvents` 是 `ORDER BY id DESC`）。
   *
   * 這條測試原本餵的是舊→新，於是 `slice(-N).reverse()`（取尾端＝最舊的 N 筆）
   * 剛好也會過——假件的方向與真實資料相反，把 bug 蓋掉了。實跑 26 筆時
   * 畫面第一眼看到的是「第 1 筆」，而欄位叫 recent、CLI 標題寫著「最近」。
   */
  it('最近的排前面（人最想看最新的）', () => {
    const s = summarizeFriction([ev({ what: '新', kind: 'other' }), ev({ what: '舊', kind: 'other' })]);
    assert.equal(s.recent[0]?.what, '新');
    assert.equal(s.recent[1]?.what, '舊');
  });
});
