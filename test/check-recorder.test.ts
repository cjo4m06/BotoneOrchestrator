import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCheckRecorder, splitOutput, MAX_INLINE_OUTPUT, NOOP_RECORDER } from '../src/worker/check-recorder.js';
import type { CheckRunInput } from '../src/store/ledger.js';
import { createTmpDir, createRecordingLogger } from './helpers/index.js';

function sink() {
  const rows: CheckRunInput[] = [];
  return { rows, recordCheckRun: (i: CheckRunInput) => { rows.push(i); return rows.length; } };
}

const BASE = { repo: 'o/r', workspaceKind: 'group_tree' as const, command: 'npm test', requestedBy: 'coder' as const };

describe('splitOutput：截斷一定要說，而且要留尾巴', () => {
  it('沒超過上限就原樣給，不落地', () => {
    assert.deepEqual(splitOutput('short'), { inline: 'short' });
  });

  it('超過上限 → 頭尾都留、中間標明省略幾個字元、全文要落地', () => {
    const raw = 'H'.repeat(40_000) + 'M'.repeat(400_000) + '❌ 真正的失敗在這裡';
    const { inline, spill } = splitOutput(raw);

    assert.ok(inline.length < raw.length);
    assert.match(inline, /❌ 真正的失敗在這裡/, '尾巴一定要留——測試輸出的慣例是失敗訊息在最後');
    assert.match(inline, /^HHH/, '頭也要留，才看得出跑的是什麼');
    assert.match(inline, /中間省略 \d+ 個字元/, '無標記的截斷會讓下游把殘缺當完整');
    assert.equal(spill, raw, '全文要交出去落地');
  });

  it('上限可調（測試不必產生 256KB）', () => {
    const { inline, spill } = splitOutput('abcdefghij', 4);
    assert.ok(spill !== undefined);
    assert.match(inline, /中間省略/);
  });
});

describe('createCheckRecorder', () => {
  it('原樣記下 exit code 與全文——不解讀、不挑行', (t) => {
    const s = sink();
    const rec = createCheckRecorder({ ledger: s, log: createRecordingLogger().logger });
    const output = '  ✓ a.spec.ts (7)\n  Tests 130 passed\n[test] ❌ 有測試失敗（排程回覆）';

    rec.record({ ...BASE, exitCode: 1, output, startedAt: 1, endedAt: 2 });

    assert.equal(s.rows.length, 1);
    assert.equal(s.rows[0]?.output, output, '一個字都不能改——挑行是讀的人的事');
    assert.equal(s.rows[0]?.exitCode, 1);
  });

  it('沒跑起來（exitCode 未給）不可以被記成 exit 0', (t) => {
    const s = sink();
    createCheckRecorder({ ledger: s, log: createRecordingLogger().logger }).record({ ...BASE, output: '紅線擋下' });
    assert.equal(s.rows[0]?.exitCode, undefined);
  });

  it('全文太長 → 落地成檔案，DB 存頭尾並指到那個檔', (t) => {
    const dir = createTmpDir('check-out-');
    t.after(() => dir.cleanup());
    const s = sink();
    const rec = createCheckRecorder({ ledger: s, log: createRecordingLogger().logger, outputRoot: dir.path, maxInline: 100 });
    const raw = 'x'.repeat(500) + 'FAIL 最後這行不能掉';

    rec.record({ ...BASE, exitCode: 1, output: raw, startedAt: 7 });

    const row = s.rows[0]!;
    assert.ok(row.outputPath, '要指到落地檔，否則全文就找不回來了');
    assert.equal(readFileSync(row.outputPath!, 'utf8'), raw, '落地的是全文');
    assert.match(row.output!, /FAIL 最後這行不能掉/, 'DB 那份也要留得住尾巴');
  });

  it('記帳失敗絕不往外冒，但一定要留 warn（靜默失敗會讓空表看起來像沒跑過）', (t) => {
    const rec2 = createRecordingLogger();
    const boom = { recordCheckRun: () => { throw new Error('DB 鎖住'); } };
    const rec = createCheckRecorder({ ledger: boom, log: rec2.logger });

    assert.doesNotThrow(() => rec.record({ ...BASE, exitCode: 0, output: 'ok' }));
    assert.ok(rec2.messages('warn').some((w) => /記帳失敗/.test(w)));
  });

  it('NOOP_RECORDER 什麼都不做也不擲錯', () => {
    assert.doesNotThrow(() => NOOP_RECORDER.record({ ...BASE, output: '' }));
  });

  it('上限預設是 256KB', () => {
    assert.equal(MAX_INLINE_OUTPUT, 256 * 1024);
  });
});
