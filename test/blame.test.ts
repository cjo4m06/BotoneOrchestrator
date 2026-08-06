import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runExperiment, formatExperiments, type ExperimentResult } from '../src/pr/blame.js';
import { createTmpGitRepo, createSilentLogger } from './helpers/index.js';
import type { CheckRunInput } from '../src/store/ledger.js';

/**
 * 實跑（2026-08-04）：PR #54 只新增 6 個檔（AvatarCropModal），被一個完全無關的
 * 後端測試（schedule-engine.test.ts）擋下。程式只跑一次測試、紅了就斷定是這一群
 * 造成的，回灌給 agent 修三輪——它根本改不到那個檔。16 個任務堵住。
 *
 * 事後兩個實驗就看得出來：同一條分支 9 分鐘前才通過同一道關卡；四次失敗有
 * 四個不同的失敗指紋。這個模組把那兩個實驗變成程式跑得起來的東西。
 */
describe('runExperiment：用實驗回答「這個紅是誰造成的」', () => {
  function repo(t: { after(fn: () => void): void }) {
    const r = createTmpGitRepo({ files: { 'a.txt': 'base\n' } });
    t.after(() => r.cleanup());
    r.git('checkout', '-q', '-b', 'orch/g1');
    r.commit({ 'f.txt': '群的成果\n' }, 'feat: 群');
    r.git('checkout', '-q', 'main');
    return r;
  }

  const budget = () => ({ runsLeft: 10, msLeft: 60_000 });

  it('跑 N 次，每次的 exit code 與全文都留著（不穩定的測試要跑多次才看得出來）', async (t) => {
    const r = repo(t);
    let n = 0;
    const res = await runExperiment({
      repoPath: r.path, branch: 'orch/g1', log: createSilentLogger(), budget: budget(),
      spec: { ref: 'main', times: 3, question: 'base 上是不是本來就紅' },
      runCheck: async () => { n += 1; return { exitCode: n === 2 ? 0 : 1, output: `第 ${n} 次的輸出` }; },
    });

    assert.equal(res.runs.length, 3);
    assert.deepEqual(res.runs.map((x) => x.exitCode), [1, 0, 1], '一次綠兩次紅——那正是「不穩定」的形狀');
    assert.deepEqual(res.runs.map((x) => x.output), ['第 1 次的輸出', '第 2 次的輸出', '第 3 次的輸出']);
    assert.equal(res.incomplete, undefined);
  });

  it('配額用完要**明講**——靜默降級會讓「沒查」被當成「查過沒事」', async (t) => {
    const r = repo(t);
    const res = await runExperiment({
      repoPath: r.path, branch: 'orch/g1', log: createSilentLogger(),
      budget: { runsLeft: 0, msLeft: 60_000 },
      spec: { ref: 'main', times: 3, question: 'x' },
      runCheck: async () => ({ exitCode: 0, output: '' }),
    });

    assert.deepEqual(res.runs, []);
    assert.match(res.incomplete ?? '', /配額已用完/);
  });

  it('配額不夠時跑得到幾次算幾次，並扣掉預算', async (t) => {
    const r = repo(t);
    const b = { runsLeft: 2, msLeft: 60_000 };
    const res = await runExperiment({
      repoPath: r.path, branch: 'orch/g1', log: createSilentLogger(), budget: b,
      spec: { ref: 'main', times: 5, question: 'x' },
      runCheck: async () => ({ exitCode: 1, output: 'red' }),
    });

    assert.equal(res.runs.length, 2);
    assert.equal(b.runsLeft, 0, '預算要真的被扣，否則同一群可以無限跑實驗');
  });

  it('每一次實驗都進 check_runs（事後查證的唯一依據）', async (t) => {
    const r = repo(t);
    const rows: CheckRunInput[] = [];
    await runExperiment({
      repoPath: r.path, branch: 'orch/g1', log: createSilentLogger(), budget: budget(), repo: 'o/r',
      spec: { ref: 'main', times: 2, question: 'base 上是不是本來就紅' },
      runCheck: async () => ({ exitCode: 1, output: '❌ schedule-engine' }),
      record: (i) => rows.push(i),
    });

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.workspaceKind, 'verify_tree');
    assert.equal(rows[0]?.requestedBy, 'merger');
    assert.match(rows[0]?.command ?? '', /base 上是不是本來就紅/);
    assert.match(rows[0]?.output ?? '', /schedule-engine/, '全文要留著');
  });

  it('實驗跑在拋棄式副本上——群分支一位元都不會被動', async (t) => {
    const r = repo(t);
    const before = r.git('rev-parse', 'orch/g1');
    await runExperiment({
      repoPath: r.path, branch: 'orch/g1', log: createSilentLogger(), budget: budget(),
      spec: { ref: 'main', times: 1, question: 'x' },
      runCheck: async () => ({ exitCode: 0, output: '' }),
    });
    assert.equal(r.git('rev-parse', 'orch/g1'), before);
    assert.equal(r.git('worktree', 'list').split('\n').length, 1, '不留殘骸');
  });

  it('環境建不起來要說清楚，不是回一個空結果', async (t) => {
    const r = repo(t);
    const res = await runExperiment({
      repoPath: r.path, branch: '不存在', log: createSilentLogger(), budget: budget(),
      spec: { ref: 'main', times: 1, question: 'x' },
      runCheck: async () => ({ exitCode: 0, output: '' }),
    });
    assert.deepEqual(res.runs, []);
    assert.match(res.incomplete ?? '', /建不起來/);
  });
});

describe('formatExperiments：只陳述事實，不下結論', () => {
  it('只列跑了幾次與每次的 exit code——**輸出不貼**（全文在 check_runs）', () => {
    const text = formatExperiments([
      {
        spec: { ref: 'origin/main', times: 2, question: 'base 上紅不紅' },
        runs: [
          { attempt: 1, exitCode: 1, output: 'ZZZQQQ 這行不可以出現', startedAt: 0, endedAt: 1 },
          { attempt: 2, exitCode: 0, output: 'ZZZQQQ 這行也不可以', startedAt: 0, endedAt: 1 },
        ],
      },
    ]);

    assert.match(text, /base 上紅不紅/);
    assert.match(text, /exit code：1 \/ 0/);
    assert.doesNotMatch(text, /ZZZQQQ/, '三次實驗的完整 build\/test 輸出接在判決後面回灌，就是在塞垃圾');
  });


  it('沒跑滿時把原因帶進文字（證據強度不同）', () => {
    const text = formatExperiments([{
      spec: { ref: 'main', times: 3, question: 'x' },
      runs: [{ attempt: 1, exitCode: 1, output: 'red', startedAt: 0, endedAt: 1 }],
      incomplete: '實驗配額已用完',
    }]);
    assert.match(text, /配額已用完/, '「只跑了一次」與「跑了三次都紅」是不同的證據強度');
  });
});
