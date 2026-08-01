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

    const r = await h({ kind: 'system_limitation', what: '查不到 base 的變更', evidence: 'git 不在工具清單', blocked: true });

    assert.equal(s.rows.length, 1);
    assert.equal(s.rows[0]?.kind, FRICTION_EVENT);
    const parsed = parseFrictionEvent(s.rows[0]?.detail);
    assert.equal(parsed?.what, '查不到 base 的變更');
    assert.equal(parsed?.blocked, true);
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

  it('工具說明要講明「不是交差的出口」，否則會被當成偷懶的藉口', () => {
    assert.match(FRICTION_TOOL_DESCRIPTION, /不影響本任務的結果/);
    assert.match(FRICTION_TOOL_DESCRIPTION, /不要拿它當「做不完但想交差」的出口/);
    assert.match(FRICTION_TOOL_DESCRIPTION, /一定要附證據/);
  });
});

describe('summarizeFriction', () => {
  const ev = (o: Record<string, unknown>) => ({ taskId: String(o.taskId ?? 'T-1'), detail: JSON.stringify(o) });

  it('統計總數、擋住的數量與分類', () => {
    const s = summarizeFriction([
      ev({ kind: 'system_limitation', what: 'a', blocked: true }),
      ev({ kind: 'system_limitation', what: 'b' }),
      ev({ kind: 'spec_problem', what: 'c', blocked: true }),
    ]);
    assert.equal(s.total, 3);
    assert.equal(s.blocked, 2);
    assert.deepEqual(s.byKind, { system_limitation: 2, spec_problem: 1 });
  });

  it('壞掉的資料被跳過，不汙染統計', () => {
    const s = summarizeFriction([ev({ kind: 'other', what: 'ok' }), { taskId: 'T-2', detail: '不是 JSON' }, { taskId: 'T-3' }]);
    assert.equal(s.total, 1);
  });

  it('最近的排前面（人最想看最新的）', () => {
    const s = summarizeFriction([ev({ what: '舊', kind: 'other' }), ev({ what: '新', kind: 'other' })]);
    assert.equal(s.recent[0]?.what, '新');
  });
});
