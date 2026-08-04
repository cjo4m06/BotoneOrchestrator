import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Planner, scheduleFromStages, type PlanAgentLike } from '../src/core/planner.js';
import { makeTask } from './helpers/index.js';
import type { PlannedGroup } from '../src/types.js';

/**
 * 分群完全交給規劃 agent（第 15 片）。
 *
 * ── 這裡原本有什麼，為什麼刪掉 ──
 *
 * 一套啟發式：Intl.Segmenter 中文分詞 → 停用詞過濾 → Jaccard 關鍵字相似度 ≥ 0.5
 * → 聯集查找併群，加上「共用 docRef 檔案」與依賴邊。它有 30 幾條測試，全部會過。
 *
 * 問題不是「不夠準」，是**換一個專案就整個失效而且沒有人會知道**：
 * · 停用詞表是照著某一塊任務板的高頻套語（「新增」「調整」「支援」）調出來的
 * · 門檻 0.5 是拿當時那批中英語料校準的
 * · 「深色模式切換開關」與「深色模式切換預設」分完詞之後可以零交集
 *
 * 換一塊任務板、換一種寫卡片的習慣，它會安靜地把不相干的東西併成一群、
 * 或把該一起做的拆開，而**分群錯了的症狀要到合併衝突那一刻才看得到**。
 *
 * 分群真正的判準是「這幾個任務會不會動到同一批程式碼」，那要讀完整個 repo
 * 才判斷得出來（實測十幾分鐘）。所以它是 agent 的工作，而且沒有 agent 就不開工。
 */

function fakeAgent(
  plan: { groups: { id: string; taskIds: string[]; files: string[]; why: string; afterExisting?: string[] }[]; stages: string[][] },
): PlanAgentLike & { calls: { repo: string; taskIds: string[] }[] } {
  const calls: { repo: string; taskIds: string[] }[] = [];
  return {
    calls,
    async plan(tasks, repoPath) {
      calls.push({ repo: repoPath, taskIds: tasks.map((t) => t.id) });
      return plan;
    },
  };
}

const ONE_GROUP = {
  groups: [{ id: 'g1', taskIds: ['A', 'B'], files: ['src/x.ts'], why: '都在改結帳流程', afterExisting: [] }],
  stages: [['g1']],
};

test('空輸入回空計畫（連 agent 都不必叫）', async () => {
  const agent = fakeAgent(ONE_GROUP);
  const plan = await new Planner({ planAgent: agent, resolveRepoPath: () => '/repo' }).plan([]);

  assert.deepEqual(plan.groups, []);
  assert.deepEqual(agent.calls, [], '沒有任務就不該花錢叫 agent');
});

test('**沒有規劃 agent → 明確擲錯**，不再有啟發式退路', async () => {
  const planner = new Planner({ resolveRepoPath: () => '/repo' });

  await assert.rejects(
    () => planner.plan([makeTask({ id: 'A' })]),
    /沒有規劃 agent/,
    '硬用關鍵字相似度湊出來的群會等到合併時才炸開——寧可停手交人',
  );
});

test('擲出的訊息要講得出「怎麼修」，人才知道該做什麼', async () => {
  const planner = new Planner({ resolveRepoPath: () => '/repo' });
  const err = await planner.plan([makeTask({ id: 'A' })]).catch((e: Error) => e);

  assert.match(String(err), /認證/, '最常見的成因是 Claude 認證失效，要點名');
});

test('agent 的分群結果原樣採用：taskIds / files / why 都不改寫', async () => {
  const agent = fakeAgent(ONE_GROUP);
  const plan = await new Planner({ planAgent: agent, resolveRepoPath: () => '/repo' }).plan([
    makeTask({ id: 'A' }),
    makeTask({ id: 'B' }),
  ]);

  assert.equal(plan.groups.length, 1);
  const g = plan.groups[0]!;
  assert.deepEqual(g.taskIds, ['A', 'B']);
  assert.deepEqual(g.footprint, ['src/x.ts']);
  assert.equal(g.rationale, '都在改結帳流程', '規劃理由要留著——它是寫程式 agent 的起手線索');
});

test('沒有本地 checkout → 擲錯（agent 要實際看 repo 才判斷得出誰會撞誰）', async () => {
  const planner = new Planner({ planAgent: fakeAgent(ONE_GROUP), resolveRepoPath: () => undefined });

  await assert.rejects(() => planner.plan([makeTask({ id: 'A' })]), /本地 checkout/);
});

test('不同 repo 分開叫 agent（一個 repo 的分群不該看到另一個 repo 的任務）', async () => {
  const agent = fakeAgent({ groups: [{ id: 'g1', taskIds: ['A'], files: [], why: 'x' }], stages: [['g1']] });
  await new Planner({ planAgent: agent, resolveRepoPath: (r) => `/repos/${r}` }).plan([
    makeTask({ id: 'A', repo: 'acme/web' }),
    makeTask({ id: 'B', repo: 'acme/api' }),
  ]);

  assert.equal(agent.calls.length, 2);
  assert.deepEqual(agent.calls.map((c) => c.repo).sort(), ['/repos/acme/api', '/repos/acme/web']);
});

test('階段序號從 stages 對回每一群', async () => {
  const agent = fakeAgent({
    groups: [
      { id: 'g1', taskIds: ['A'], files: [], why: '先做這個' },
      { id: 'g2', taskIds: ['B'], files: [], why: '要等 g1' },
    ],
    stages: [['g1'], ['g2']],
  });
  const plan = await new Planner({ planAgent: agent, resolveRepoPath: () => '/repo' }).plan([
    makeTask({ id: 'A' }),
    makeTask({ id: 'B' }),
  ]);

  assert.equal(plan.groups.find((g) => g.taskIds.includes('A'))?.stageIndex, 0);
  assert.equal(plan.groups.find((g) => g.taskIds.includes('B'))?.stageIndex, 1);
});

test('沒被排進任何階段的群 → 落在第 0 階段（不可以從計畫裡消失）', async () => {
  const agent = fakeAgent({
    groups: [{ id: 'g1', taskIds: ['A'], files: [], why: 'x' }],
    stages: [], // agent 忘了排
  });
  const plan = await new Planner({ planAgent: agent, resolveRepoPath: () => '/repo' }).plan([makeTask({ id: 'A' })]);

  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0]?.stageIndex, 0);
});

test('afterExisting（要等還沒進 base 的既有群）原樣帶出來', async () => {
  const agent = fakeAgent({
    groups: [{ id: 'g1', taskIds: ['A'], files: [], why: 'x', afterExisting: ['g_old'] }],
    stages: [['g1']],
  });
  const plan = await new Planner({ planAgent: agent, resolveRepoPath: () => '/repo' }).plan([makeTask({ id: 'A' })]);

  assert.deepEqual(plan.groups[0]?.afterExisting, ['g_old']);
});

test('agent 呼叫失敗一律往上擲（不退回啟發式，也不安靜地建出零群）', async () => {
  const planner = new Planner({
    planAgent: { async plan() { throw new Error('認證過期'); } },
    resolveRepoPath: () => '/repo',
  });

  await assert.rejects(() => planner.plan([makeTask({ id: 'A' })]), /認證過期/);
});

// ── 階段 → 排程邊 ──

test('scheduleFromStages：後一階段的群要等前一階段全部結束', () => {
  const groups: PlannedGroup[] = [
    { repo: 'a/b', taskIds: ['A'], footprint: [], rationale: '', stageIndex: 0 },
    { repo: 'a/b', taskIds: ['B'], footprint: [], rationale: '', stageIndex: 1 },
  ];

  assert.deepEqual(scheduleFromStages(groups), [{ fromGroup: '0', toGroup: '1', reason: 'file-overlap' }]);
});

test('scheduleFromStages：同階段的群之間沒有邊（那正是「可以並行」的意思）', () => {
  const groups: PlannedGroup[] = [
    { repo: 'a/b', taskIds: ['A'], footprint: [], rationale: '', stageIndex: 0 },
    { repo: 'a/b', taskIds: ['B'], footprint: [], rationale: '', stageIndex: 0 },
  ];

  assert.deepEqual(scheduleFromStages(groups), []);
});
