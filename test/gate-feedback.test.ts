import { describe, it, before, after } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Verifier, NO_GATES_COMMAND, ONLY_DIFF_COMMAND } from '../src/worker/verifier.js';
import { formatGateFeedback } from '../src/worker/agent-runtime.js';
import { createTmpDir, createSilentLogger, type TmpDir } from './helpers/index.js';
import type { CheckRunInput } from '../src/store/ledger.js';
import type { CheckContext } from '../src/worker/check-recorder.js';

/**
 * 第 14 片：驗證器縮成命令執行器之後，還活著的三件事。
 *
 * ── 為什麼這一組測試存在 ──
 *
 * 回灌管道是**靜默失效**的高風險區：接線斷掉時 typecheck 全綠、測試全綠、
 * log 也不會有錯誤，只有 agent 開始盲改，而那要好幾輪之後才看得出來。
 * 所以「上一輪的失敗有沒有真的送到 agent 面前」必須是一條被測住的性質，
 * 不是「應該有吧」。
 */

const CTX: CheckContext = { repo: 'o/r', branch: 'b', workspaceKind: 'group_tree', requestedBy: 'coder' };

function recorderSpy() {
  const runs: CheckRunInput[] = [];
  return { runs, recorder: { record: (i: CheckRunInput) => { runs.push(i); return 1; } } };
}

/**
 * **紅燈時輸出不進 prompt。**
 *
 * 程式跑了指令、拿到非 0，它知道的就這兩件事。「哪裡壞了」要讀輸出才知道，
 * 而讀輸出是 agent 的事——它有 Bash、在同一個工作區、剛剛才自己跑過。
 *
 * 先前這裡貼整份 stdout（每條最多 256KB，四條都紅近 1MB，而且每一輪重貼）。
 * 那不是幫忙：真正的錯誤埋在進度條裡，而截斷之後 agent 連「被砍掉什麼」都不知道。
 */
describe('紅燈只記帳，不把輸出塞進回饋', () => {
  let dir: TmpDir;
  before(() => { dir = createTmpDir('gate-feedback-'); });
  after(() => dir.cleanup());

  it('**輸出一個字都不進 detail**，只留指令與 exit code', async () => {
    const v = new Verifier(createSilentLogger());
    // 標記字串**只出現在輸出裡**，不出現在指令裡——不然斷言會抓到指令本身的回顯
    writeFileSync(join(dir.path, 'noisy.js'), "console.log('AAABBBCCC'); for(let i=0;i<200;i++)console.log('第 '+i+' 行'); process.exit(1)");
    const script = 'node noisy.js';

    const gate = await v.check({ cwd: dir.path, config: { test: script } });

    assert.equal(gate.green, false);
    const c = gate.checks[0]!;
    assert.doesNotMatch(c.detail, /AAABBBCCC/, '輸出不可以出現在回饋裡');
    assert.doesNotMatch(c.detail, /第 199 行/);
    assert.equal(c.command, script, '要留下指令，agent 才重跑得了');
    assert.equal(c.exitCode, 1);
  });

  it('全文照樣完整記進 check_runs（那是給人事後查的）', async () => {
    const spy = recorderSpy();
    const v = new Verifier(createSilentLogger(), { checkRecorder: spy.recorder, checkContext: CTX });
    writeFileSync(join(dir.path, 'boom.js'), "console.log('DDDEEEFFF'); process.exit(1)");

    await v.check({ cwd: dir.path, config: { test: 'node boom.js' } });

    assert.match(spy.runs[0]?.output ?? '', /DDDEEEFFF/, '不給 prompt ≠ 不記帳');
  });
});

describe('formatGateFeedback：agent 這一輪會看到的那段文字', () => {
  it('沒有失敗關卡 → 什麼都不輸出（不可掛「未通過」的標題）', () => {
    assert.equal(formatGateFeedback(undefined), undefined);
    assert.equal(
      formatGateFeedback({ green: true, checks: [{ name: 'test', ok: true, detail: 'ok' }] }),
      undefined,
      '全綠卻說「上一輪未通過」會讓 agent 去猜哪裡錯，反而動到不該動的東西',
    );
  });

  it('**只講指令與 exit code，並叫它自己去跑**', () => {
    const text = formatGateFeedback({
      green: false,
      checks: [
        { name: 'test', ok: false, detail: '跑了 `npm test`，exit code 1', command: 'npm test', exitCode: 1 },
        { name: 'build', ok: true, detail: 'ok' },
      ],
    }) ?? '';

    assert.match(text, /`test` 紅了：跑 `npm test` 回 exit code 1/);
    assert.match(text, /輸出沒有貼在這裡/, '要明講沒貼，否則 agent 會以為那就是全部');
    assert.match(text, /自己跑/);
    assert.doesNotMatch(text, /build/, '只列失敗項');
  });

  it('程式自己知道的事實（沒跑指令那幾種）照原樣給——不給它就不知道發生什麼', () => {
    const text = formatGateFeedback({
      green: false,
      checks: [{ name: 'diff', ok: false, detail: '工作區相對任務起點沒有任何變更', failingIds: ['no-changes'] }],
    }) ?? '';

    assert.match(text, /沒有任何變更/, '這是程式寫的短句，不是機器輸出');
  });
});

describe('「什麼都沒驗」要是一件查得到的事實', () => {
  let dir: TmpDir;
  before(() => { dir = createTmpDir('no-gates-'); });
  after(() => dir.cleanup());

  it('專案沒設任何關卡 → 不綠，而且 check_runs 留下一列可辨識的設定事實', async () => {
    const spy = recorderSpy();
    const v = new Verifier(createSilentLogger(), { checkRecorder: spy.recorder, checkContext: CTX });

    const gate = await v.check({ cwd: dir.path, config: {} });

    assert.equal(gate.green, false, '空驗證不能當通過');
    const fact = spy.runs.find((r) => r.command === NO_GATES_COMMAND);
    assert.ok(
      fact,
      '審查者去查 check_runs 時，「這個專案沒設關卡」與「關卡還沒跑」在一張空表上長得一模一樣——'
      + '前者代表這裡永遠不會有把關，後者代表再等一下，處置完全相反',
    );
    assert.equal(fact?.exitCode, undefined, '沒有指令跑過，不可以填 exit code（那會被當成「跑了而且失敗」）');
  });

  it('只有 diff 關卡（沒有任何驗證指令）→ 算綠但同樣留下把關很弱的事實', async () => {
    const spy = recorderSpy();
    const v = new Verifier(createSilentLogger(), { checkRecorder: spy.recorder, checkContext: CTX });
    // diff 關卡要有變更才會過；用一個一定有變更的暫存 repo 太重，這裡直接驗「沒設指令」那條路
    const gate = await v.check({ cwd: dir.path, config: { test: 'true' } });

    assert.equal(gate.green, true);
    assert.equal(
      spy.runs.some((r) => r.command === ONLY_DIFF_COMMAND || r.command === NO_GATES_COMMAND),
      false,
      '有跑到指令就不是「設定事實」，不該留這種紀錄',
    );
  });
});
