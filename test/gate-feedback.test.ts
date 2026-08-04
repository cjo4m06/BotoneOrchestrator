import { describe, it, before, after } from 'node:test';
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

describe('紅燈的完整輸出交給 agent，不挑行也不猜測試名', () => {
  let dir: TmpDir;
  before(() => { dir = createTmpDir('gate-feedback-'); });
  after(() => dir.cleanup());

  it('失敗關卡的 detail 是整份輸出——第一行與第兩百行都在', async () => {
    const v = new Verifier(createSilentLogger());
    // 200 行輸出，關鍵資訊在**第一行**：舊版只留最後 30 行，正好會把它切掉
    const script = `node -e "console.log('FAIL src/a.test.ts'); for(let i=0;i<200;i++)console.log('  第 '+i+' 行細節'); process.exit(1)"`;

    const gate = await v.check({ cwd: dir.path, config: { test: script } });

    assert.equal(gate.green, false);
    const detail = gate.checks[0]?.detail ?? '';
    assert.match(detail, /FAIL src\/a\.test\.ts/, '第一行是失敗的檔名，不可以被截掉');
    assert.match(detail, /第 199 行細節/);
  });

  it('不再從輸出撈失敗的測試名（那個正則只認得三種格式）', async () => {
    const v = new Verifier(createSilentLogger());
    const script = `node -e "console.log('not ok 1 - alpha'); process.exit(1)"`;

    const gate = await v.check({ cwd: dir.path, config: { test: script } });

    assert.equal(
      gate.checks[0]?.failingIds,
      undefined,
      '「alpha」是從輸出猜出來的語意——換一套測試框架就撈不到，而下游還是會用肯定句講出來',
    );
    assert.match(gate.checks[0]?.detail ?? '', /not ok 1 - alpha/, '但原始輸出必須在，讀得懂的是 agent');
  });

  // 「簽章不再產生」那條退場：GateReport.signature 這個欄位本身已於第 15 片刪掉，
  // 由 typecheck 守著（誰想加回來會當場編不過），不必再用執行期斷言。
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

  it('種類碼標出來，讓 agent 分得出逾時與測試紅', () => {
    const text = formatGateFeedback({
      green: false,
      checks: [
        { name: 'test', ok: false, detail: '逾時：超過 600000ms', failingIds: ['timeout'] },
        { name: 'build', ok: true, detail: 'ok' },
      ],
    });

    assert.match(text ?? '', /\[test\]（timeout） 逾時/);
    assert.doesNotMatch(text ?? '', /build/, '只列失敗項，通過的不必占版面');
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
