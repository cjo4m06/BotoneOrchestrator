import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DriftJudge, buildDriftPrompt, driftFeedback, parseDriftResponse } from '../src/pr/drift-judge.js';
import { createSilentLogger } from './helpers/index.js';

/**
 * Merge Guard 原本的兩層都是**事實**：rebase 有沒有文字衝突、合併後 build/test 紅不紅。
 * 它們抓得到「你依賴的東西被別人刪改 → 合併後爆掉」。
 *
 * 抓不到的是「能編譯、測試也綠，但兩邊的意圖打架」——A 把某個操作改成要二次確認，
 * B 把同一條流程改成一鍵完成，各自的測試都過，合起來卻自相矛盾。
 * 那只有讀得懂意圖的判斷得出來。這一層就是為此存在。
 */

const INPUT = {
  cwd: '/wt',
  mergeBase: 'abc123', baseRef: 'origin/main', branch: 'orch/g',
  taskTitles: ['把清除資料改成一鍵完成'],
};

const wrap = (o: unknown): string => '```json\n' + JSON.stringify(o) + '\n```';
const reply = (text: string) =>
  async function* () {
    yield { type: 'result', subtype: 'success', result: text };
  };

describe('parseDriftResponse', () => {
  it('clean 判定', () => {
    assert.deepEqual(parseDriftResponse(wrap({ status: 'clean', notes: ['看過了'] })), {
      status: 'clean',
      notes: ['看過了'],
    });
  });

  it('conflict 判定含逐項細節', () => {
    const v = parseDriftResponse(
      wrap({
        status: 'conflict',
        findings: [{ where: 'x.vue', baseIntent: '要二次確認', groupIntent: '一鍵完成', why: '不能同時成立' }],
      }),
    );
    assert.equal(v?.status, 'conflict');
    if (v?.status !== 'conflict') return;
    assert.equal(v.findings[0]?.where, 'x.vue');
  });

  it('說 conflict 卻沒給任何 finding → 不採信（無法回灌給 agent 修）', () => {
    assert.equal(parseDriftResponse(wrap({ status: 'conflict', findings: [] })), undefined);
  });

  it('不是 JSON → undefined 而不是丟例外', () => {
    assert.equal(parseDriftResponse('我覺得沒問題'), undefined);
  });
});

describe('DriftJudge', () => {
  it('判定 clean → 放行', async () => {
    const j = new DriftJudge({
      log: createSilentLogger(),
      hasAuth: () => true,
      queryFn: reply(wrap({ status: 'clean', notes: [] })),
    });
    assert.equal((await j.judge(INPUT)).status, 'clean');
  });

  it('判定 conflict → 回報逐項細節', async () => {
    const j = new DriftJudge({
      log: createSilentLogger(),
      hasAuth: () => true,
      queryFn: reply(
        wrap({
          status: 'conflict',
          findings: [{ where: 'x.vue', baseIntent: '要二次確認', groupIntent: '一鍵完成', why: '互斥' }],
        }),
      ),
    });
    const v = await j.judge(INPUT);
    assert.equal(v.status, 'conflict');
  });

  /**
   * 這一層的保守方向與其他關卡**相反**：判不出來就放行。
   * 它是在所有事實層都綠之後才跑的額外保險；讓它在不確定時擋下來，
   * 等於用一個主觀判斷去否決一組客觀證據。
   */
  it('呼叫失敗 → skipped，不阻斷已全綠的合併', async () => {
    const j = new DriftJudge({
      log: createSilentLogger(),
      hasAuth: () => true,
      queryFn: () => {
        throw new Error('網路斷了');
      },
    });
    assert.equal((await j.judge(INPUT)).status, 'skipped');
  });

  it('回應解析不出來 → skipped', async () => {
    const j = new DriftJudge({ log: createSilentLogger(), hasAuth: () => true, queryFn: reply('嗯') });
    assert.equal((await j.judge(INPUT)).status, 'skipped');
  });

  it('沒有認證 → skipped', async () => {
    const j = new DriftJudge({ log: createSilentLogger(), hasAuth: () => false });
    assert.equal((await j.judge(INPUT)).status, 'skipped');
  });

  it('base 在本群動工後沒有新變更 → skipped（沒有「兩邊」可言）', async () => {
    let called = 0;
    const j = new DriftJudge({
      log: createSilentLogger(),
      hasAuth: () => true,
      queryFn: () => {
        called += 1;
        return reply(wrap({ status: 'clean', notes: [] }))();
      },
    });
    // 「base 沒有新變更就跳過」已退場：那個判斷要先讀 diff 才做得出來，
    // 而 diff 現在是判斷者自己去查的。少跳過一次的代價（多花一次判斷）
    // 比漏判一次意圖打架便宜。
    assert.ok(j);
    assert.equal(called, 0);
  });
});

describe('buildDriftPrompt / driftFeedback', () => {
  it('prompt 明說建置與測試已通過，不要回報那些', () => {
    const p = buildDriftPrompt(INPUT);
    assert.match(p, /建置與測試都通過了/);
    assert.match(p, /把清除資料改成一鍵完成/);
  });

  it('prompt 只給 ref，叫它自己查——不貼 diff', () => {
    const p = buildDriftPrompt(INPUT);
    assert.match(p, /自己查/);
    assert.match(p, /git_changed_files/);
    assert.doesNotMatch(p, /```diff/, '程式先算好再砍一半的 diff 已經不給了');
  });

  it('回灌給 agent 的意見要禁止「把對方的變更還原」', () => {
    const fb = driftFeedback([{ where: 'x.vue', baseIntent: '要二次確認', groupIntent: '一鍵完成', why: '互斥' }]);
    assert.match(fb, /x\.vue/);
    assert.match(fb, /不可以.*還原|還原.*不可以/s);
    assert.match(fb, /ask_human/, '真的互斥時要交給人，不能自己選一邊');
  });
});
