import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PlanAgent, buildPlanPrompt, parsePlanResponse } from '../src/core/plan-agent.js';
import { createSilentLogger } from './helpers/index.js';
import type { Task } from '../src/types.js';

/**
 * 這批測試對應的是一次實跑事故：
 * 「在 /sandbox 頁面加上深色模式切換」與「在 /sandbox 頁面加上複製按鈕」被判定互不相干
 * 而並行，最後兩個都改 src/views/SandboxView.vue，後完成的那個 rebase 撞衝突、整組報銷。
 * 原因是分群靠關鍵字與正規表示式猜——「/sandbox 頁面」既不像路徑也不像識別字，一個檔案都沒掃到。
 *
 * 改成 agent 判斷之後，正確性由「計畫必須自洽」把關：任務不重不漏、群不重不漏。
 * 那些檢查不是形式主義——少一個任務代表它永遠不會被做，而且沒有任何錯誤訊息。
 */

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  repo: 'acme/web',
  category: 'feature',
  title: `任務 ${id}`,
  description: '描述',
  state: 'discovered',
  attempts: 0,
  dependencies: [],
  docRefs: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const wrap = (o: unknown): string => '```json\n' + JSON.stringify(o) + '\n```';

const GOOD = {
  groups: [
    { id: 'A', taskIds: ['T-1', 'T-2'], files: ['src/views/SandboxView.vue'], why: '都改同一個頁面' },
    { id: 'B', taskIds: ['T-3'], files: ['src/api/user.ts'], why: '獨立的 API 改動' },
  ],
  stages: [['A'], ['B']],
};

describe('parsePlanResponse', () => {
  const ids = ['T-1', 'T-2', 'T-3'];

  it('合格的回應 → 解析出群與階段', () => {
    const r = parsePlanResponse(wrap(GOOD), ids);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.value.stages, [['A'], ['B']]);
    assert.deepEqual(r.value.groups[0]?.taskIds, ['T-1', 'T-2']);
  });

  it('沒有圍欄的裸 JSON 也吃得下', () => {
    assert.equal(parsePlanResponse(`結論如下：\n${JSON.stringify(GOOD)}\n以上。`, ids).ok, true);
  });

  it('漏掉任務 → 不合格（漏掉等於那個任務永遠不會被做，而且無聲無息）', () => {
    const bad = { ...GOOD, groups: [GOOD.groups[0]!], stages: [['A']] };
    const r = parsePlanResponse(wrap(bad), ids);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /T-3/);
  });

  it('同一個任務分到兩個群 → 不合格（會被實作兩次）', () => {
    const bad = {
      groups: [
        { id: 'A', taskIds: ['T-1', 'T-2'], files: [], why: '' },
        { id: 'B', taskIds: ['T-2', 'T-3'], files: [], why: '' },
      ],
      stages: [['A'], ['B']],
    };
    const r = parsePlanResponse(wrap(bad), ids);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /不只一個群/);
  });

  it('冒出清單裡沒有的任務 → 不合格', () => {
    const bad = { ...GOOD, groups: [...GOOD.groups, { id: 'C', taskIds: ['T-99'], files: [], why: '' }], stages: [['A'], ['B'], ['C']] };
    const r = parsePlanResponse(wrap(bad), ids);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /T-99/);
  });

  it('有群沒被排進任何階段 → 不合格（那個群永遠不會被派）', () => {
    const r = parsePlanResponse(wrap({ ...GOOD, stages: [['A']] }), ids);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /沒有被排進任何階段/);
  });

  it('階段裡出現不存在的群 → 不合格', () => {
    const r = parsePlanResponse(wrap({ ...GOOD, stages: [['A'], ['B'], ['Z']] }), ids);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /不存在的群/);
  });

  it('完全不是 JSON → 不合格（而不是丟出例外）', () => {
    assert.equal(parsePlanResponse('我覺得可以分成兩群。', ids).ok, false);
  });
});

describe('buildPlanPrompt', () => {
  it('把任務內容、依賴與規格都放進 prompt', () => {
    const p = buildPlanPrompt([
      task('T-1', { title: '加深色模式', description: '右上角切換鈕', docRefs: ['spec/dark.md'] }),
      task('T-2', { dependencies: ['T-1'] }),
    ]);
    assert.match(p, /T-1｜加深色模式/);
    assert.match(p, /右上角切換鈕/);
    assert.match(p, /spec\/dark\.md/);
    assert.match(p, /前置任務：T-1/);
  });

  it('明講「不要只看標題猜」與「判斷不準就排到不同階段」', () => {
    const p = buildPlanPrompt([task('T-1')]);
    assert.match(p, /不要只看標題猜/);
    assert.match(p, /判斷不準時一律排到不同階段/);
  });

  it('重問時把上次的錯誤原因帶進去', () => {
    const p = buildPlanPrompt([task('T-1')], [], '這些任務沒有被分到任何群：T-1');
    assert.match(p, /上一次回應不合格/);
    assert.match(p, /沒有被分到任何群：T-1/);
  });

  /**
   * 任務是一批一批進來的。第二批規劃時，第一批可能已經做完開了 PR 但還沒合併——
   * **那些改動不在 repo 裡**，agent 用 Read/Grep 看不到。沒有這段資訊它就是瞎的：
   * 會把「以那些成果為前提」的新任務直接排下去，在一個沒有前置成果的 base 上開工。
   */
  it('把「成果還沒進 base」的群組寫進提示詞，並點名 pr_open / in_review 最要命', () => {
    const p = buildPlanPrompt([task('T-9')], [
      { id: 'g_abc123', state: 'in_review', tasks: [{ id: 'T-1', title: '加上攝氏華氏互換' }], files: ['src/units.js'], prUrl: 'https://x/pull/7' },
    ]);
    assert.match(p, /g_abc123/);
    assert.match(p, /in_review/);
    assert.match(p, /加上攝氏華氏互換/);
    assert.match(p, /src\/units\.js/);
    assert.match(p, /https:\/\/x\/pull\/7/);
    assert.match(p, /afterExisting/);
  });

  it('沒有在飛的群組時不提那一段，判準也不多出第 5 條（不要憑空要它填東西）', () => {
    const p = buildPlanPrompt([task('T-9')], []);
    assert.doesNotMatch(p, /已經在進行/);
    assert.doesNotMatch(p, /跨批次的依賴用/);
  });
});

describe('parsePlanResponse — 跨批次依賴', () => {
  const wrap = (o: unknown) => '```json\n' + JSON.stringify(o) + '\n```';

  it('afterExisting 指向真實存在的既有群組 → 通過', () => {
    const r = parsePlanResponse(
      wrap({ groups: [{ id: 'A', taskIds: ['T-1'], files: [], why: '', afterExisting: ['g_abc123'] }], stages: [['A']] }),
      ['T-1'],
      ['g_abc123'],
    );
    assert.ok(r.ok);
    assert.deepEqual(r.ok ? r.value.groups[0]?.afterExisting : undefined, ['g_abc123']);
  });

  /**
   * 指錯不能默默丟掉：丟掉的話那個依賴就永遠不存在，
   * 而它正是「B 需要 A 的成果」這種最要命的關係——下游會在錯的 base 上開工。
   */
  it('afterExisting 指到不存在的群組 → 當錯誤重問，不默默丟掉', () => {
    const r = parsePlanResponse(
      wrap({ groups: [{ id: 'A', taskIds: ['T-1'], files: [], why: '', afterExisting: ['g_不存在'] }], stages: [['A']] }),
      ['T-1'],
      ['g_abc123'],
    );
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error, /afterExisting 指到不存在的群組/);
  });

  it('沒填 afterExisting → 空陣列（大多數情況）', () => {
    const r = parsePlanResponse(wrap({ groups: [{ id: 'A', taskIds: ['T-1'] }], stages: [['A']] }), ['T-1']);
    assert.ok(r.ok);
    assert.deepEqual(r.ok ? r.value.groups[0]?.afterExisting : undefined, []);
  });
});

describe('PlanAgent', () => {
  const tasks = [task('T-1'), task('T-2'), task('T-3')];
  const reply = (text: string) =>
    async function* () {
      yield { type: 'result', subtype: 'success', result: text };
    };

  it('回應合格 → 直接回傳計畫', async () => {
    const agent = new PlanAgent({ log: createSilentLogger(), queryFn: reply(wrap(GOOD)) });
    const r = await agent.plan(tasks, '/repo');
    assert.deepEqual(r.stages, [['A'], ['B']]);
  });

  it('第一次不合格 → 帶著錯誤重問一次就成功', async () => {
    let n = 0;
    const prompts: string[] = [];
    const agent = new PlanAgent({
      log: createSilentLogger(),
      queryFn: (args) => {
        prompts.push(args.prompt);
        n += 1;
        return reply(n === 1 ? '亂寫的' : wrap(GOOD))();
      },
    });
    const r = await agent.plan(tasks, '/repo');
    assert.deepEqual(r.stages, [['A'], ['B']]);
    assert.equal(n, 2);
    assert.match(prompts[1]!, /上一次回應不合格/, '重問要帶上原因，否則它只會再錯一次');
  });

  it('重問完仍不合格 → 擲錯（絕不退回猜測式分群）', async () => {
    const agent = new PlanAgent({ log: createSilentLogger(), queryFn: reply('還是亂寫') });
    await assert.rejects(() => agent.plan(tasks, '/repo'), /無法產出可用的計畫/);
  });

  it('SDK 回錯誤結果 → 擲錯', async () => {
    const agent = new PlanAgent({
      log: createSilentLogger(),
      queryFn: () =>
        (async function* () {
          yield { type: 'result', subtype: 'error_max_turns' };
        })(),
    });
    await assert.rejects(() => agent.plan(tasks, '/repo'), /error_max_turns/);
  });
});
