import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PlanAgent, buildPlanPrompt, parsePlanResponse } from '../src/core/plan-agent.js';
import { createSilentLogger } from './helpers/index.js';
import type { Task } from '../src/types.js';
import { createTmpLedger } from './helpers/index.js';
import { buildAgentPrompt } from '../src/worker/agent-runtime.js';
import { readFileSync } from 'node:fs';

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
  payloadHash: `hash-${id}`,
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

  it('明講「不要只看標題猜」，且不確定時要保守', () => {
    const p = buildPlanPrompt([task('T-1')]);
    assert.match(p, /不要只看標題猜/);
    // 舊版寫「判斷不準時一律排到不同階段」——那句話正是矛盾的來源：
    // 它與「動到同一批檔案就同一群」牴觸，而分階段其實是**最貴**的手段
    // （要等人審完、合併進 main 才開工）。改成「當成有交集」，
    // 由判準 1 收斂到同一群——同一個工作區依序做，比分階段既安全又便宜。
    assert.match(p, /一律\*\*當成有交集\*\*處理/);
  });

  /** 判準必須有優先順序，否則兩條都成立時規劃者可以合理選任何一邊（實跑就是這樣切出 16 群）。 */
  it('判準有明確的優先順序，且同檔案預設同群', () => {
    const p = buildPlanPrompt([task('T-1')]);
    assert.match(p, /\*\*有優先順序\*\*/);
    assert.match(p, /會動到同一個檔案的任務 → 放同一群/);
    assert.match(p, /最高優先/);
  });

  /** 舊版從沒說過「多切一群要付什麼代價」，規劃者當然以為多切是保守做法。 */
  it('講清楚多一群、多一階段的真實成本', () => {
    const p = buildPlanPrompt([task('T-1')]);
    assert.match(p, /多一個群/);
    assert.match(p, /多一次人工審查/);
    assert.match(p, /分階段是最貴的手段/);
  });

  /** 群要多大是判斷題，不是算術題——不要給任何數字，也不要給額外的判準。 */
  it('不對群的大小設任何限制', () => {
    const p = buildPlanPrompt([task('T-1')]);
    assert.doesNotMatch(p, /一群最多 \d+ 個任務/);
    assert.doesNotMatch(p, /files 合計最多 \d+/);
    assert.doesNotMatch(p, /規模上限/);
  });

  /**
   * **同一份規格的任務要合成一群，就算檔案完全不重疊。**
   *
   * 實跑撞到：6 個任務的 docRefs 全部指向同一份
   * `issues/2026-07-31-mobile-menu-touch-target-below-44px.md`
   * （同一種修法套用在六個元件），卻被切成 6 個群、6 個 PR。
   * 每一條 rationale 都寫「獨立…N 個檔案皆無其他任務觸碰」——它是照著
   * 「只看檔案交集」的判準正確推理的，因為舊版把「內容高度相關」那句刪掉了。
   */
  it('把「類似／相關的任務」列為最高優先，且明講與檔案無關', () => {
    const p = buildPlanPrompt([task('T-1')]);
    const rules = p.slice(p.indexOf('## 判準'), p.indexOf('## 輸出格式'));

    const series = rules.indexOf('類似的、相關的、屬於同一件事的任務 → 放同一群');
    const sameFile = rules.indexOf('會動到同一個檔案的任務 → 放同一群');
    assert.ok(series >= 0, '要有「同一系列」這一條');
    assert.ok(sameFile >= 0, '「同檔案」那一條要留著');
    assert.ok(series < sameFile, '系列要排在檔案前面——不然又會變成純檔案分群');

    assert.match(rules, /docRefs 指到同一份文件/, 'docRefs 是最強訊號，而它本來就在提示詞裡');
    assert.match(rules, /這一條和檔案完全沒有關係/, '不明講的話它會繼續只看檔案交集');
    assert.match(rules, /「類似」由你判斷/, '要讓它自己判斷相似，不要給封閉的清單');
  });

  /** 範例本身就是指示。只示範單任務群，等於默默鼓勵一群一個任務。 */
  it('輸出範例示範多任務群與同階段並行', () => {
    const p = buildPlanPrompt([task('T-1')]);
    const example = p.slice(p.indexOf('## 輸出格式'));
    assert.match(example, /"taskIds": \["T-1", "T-3", "T-7"\]/, '要示範一群多個任務');
    assert.match(example, /"stages": \[\["A", "B"\]\]/, '要示範同階段並行');
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
    // 沒有既有群組時，afterExisting 連提都不要提：欄位擺在範例裡卻沒有解釋，
    // 規劃者會照字面理解成「這一群排在哪幾群後面」，把自家群代號填進去（實跑撞到）
    assert.doesNotMatch(p, /afterExisting/, '沒有既有群組時不該出現這個欄位');
    assert.match(p, /群與群之間的先後一律用/, '要明講先後只用 stages');
  });

  it('有既有群組時才解釋 afterExisting，並列出可填的 id', () => {
    const p = buildPlanPrompt([task('T-1')], [
      { id: 'g_abc123', state: 'pr_open', tasks: [{ id: 'T-0', title: '舊的' }], files: ['a.ts'] },
    ]);
    assert.match(p, /afterExisting/);
    assert.match(p, /g_abc123/);
    assert.match(p, /群與群之間的先後一律用/, '就算有既有群組，兄弟順序仍然只用 stages');
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

  /**
   * 實跑撞到的那一個：14 個任務分成 A…N 十幾群，規劃者用 afterExisting 表達
   * 「這一群排在那一群後面」（那本來就是這個欄位名的字面意思）。
   * 原本每次都被打回，重問又犯同樣的錯，一輪 tick 燒掉十幾分鐘後整個失敗，
   * 下一輪從頭再來——專案永遠分不了群。
   */
  it('afterExisting 指到同一份計畫裡的群 → 折成階段順序，不是錯誤', () => {
    const r = parsePlanResponse(
      wrap({
        groups: [
          { id: 'A', taskIds: ['T-1'], files: [], why: '' },
          { id: 'B', taskIds: ['T-2'], files: [], why: '', afterExisting: ['A'] },
        ],
        stages: [['A', 'B']], // 規劃者把兩群放同一階段，順序全靠 afterExisting 講
      }),
      ['T-1', 'T-2'],
      [], // 這次一個既有群組也沒有——正是實跑的情境
    );

    assert.ok(r.ok, r.ok ? '' : r.error);
    const stages = r.ok ? r.value.stages : [];
    assert.deepEqual(stages, [['A'], ['B']], 'B 要被推到 A 後面的階段');
    assert.deepEqual(r.ok ? r.value.groups[1]?.afterExisting : undefined, [], '兄弟參照不該留在 afterExisting 裡');
    assert.ok(r.ok && r.notes.some((n) => n.includes('B')), '改了別人的計畫就要講出來');
  });

  it('多層兄弟依賴 → 一路往後推到底', () => {
    const r = parsePlanResponse(
      wrap({
        groups: [
          { id: 'A', taskIds: ['T-1'] },
          { id: 'B', taskIds: ['T-2'], afterExisting: ['A'] },
          { id: 'C', taskIds: ['T-3'], afterExisting: ['B'] },
        ],
        stages: [['A', 'B', 'C']],
      }),
      ['T-1', 'T-2', 'T-3'],
    );
    assert.ok(r.ok, r.ok ? '' : r.error);
    assert.deepEqual(r.ok ? r.value.stages : [], [['A'], ['B'], ['C']]);
  });

  it('既有群組與兄弟混在一起 → 各歸各的', () => {
    const r = parsePlanResponse(
      wrap({
        groups: [
          { id: 'A', taskIds: ['T-1'] },
          { id: 'B', taskIds: ['T-2'], afterExisting: ['A', 'g_abc123'] },
        ],
        stages: [['A', 'B']],
      }),
      ['T-1', 'T-2'],
      ['g_abc123'],
    );
    assert.ok(r.ok, r.ok ? '' : r.error);
    assert.deepEqual(r.ok ? r.value.groups[1]?.afterExisting : undefined, ['g_abc123'], '既有群組要留著');
    assert.deepEqual(r.ok ? r.value.stages : [], [['A'], ['B']], '兄弟的部分變成階段');
  });

  /** 已經排對順序的就不要亂動——只往後推，不往前拉。 */
  it('階段本來就正確 → 不動它', () => {
    const r = parsePlanResponse(
      wrap({
        groups: [{ id: 'A', taskIds: ['T-1'] }, { id: 'B', taskIds: ['T-2'], afterExisting: ['A'] }],
        stages: [['A'], ['B']],
      }),
      ['T-1', 'T-2'],
    );
    assert.ok(r.ok);
    assert.deepEqual(r.ok ? r.value.stages : [], [['A'], ['B']]);
    assert.deepEqual(r.ok ? r.notes : ['x'], [], '沒動就不該說動過');
  });

  /** A 等 B、B 等 A：規劃者自己講矛盾了，那不是我們能替它決定的。 */
  it('兄弟依賴成環 → 退回重問', () => {
    const r = parsePlanResponse(
      wrap({
        groups: [
          { id: 'A', taskIds: ['T-1'], afterExisting: ['B'] },
          { id: 'B', taskIds: ['T-2'], afterExisting: ['A'] },
        ],
        stages: [['A', 'B']],
      }),
      ['T-1', 'T-2'],
    );
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error, /循環/);
  });

  it('自己等自己 → 忽略，不算錯', () => {
    const r = parsePlanResponse(
      wrap({ groups: [{ id: 'A', taskIds: ['T-1'], afterExisting: ['A'] }], stages: [['A']] }),
      ['T-1'],
    );
    assert.ok(r.ok, r.ok ? '' : r.error);
    assert.deepEqual(r.ok ? r.value.stages : [], [['A']]);
  });

  /** 編出來的 id 還是要退回——那才是真的不知道它在指什麼。 */
  it('既不是既有群組也不是自家群代號 → 仍然重問', () => {
    const r = parsePlanResponse(
      wrap({ groups: [{ id: 'A', taskIds: ['T-1'], afterExisting: ['Z'] }], stages: [['A']] }),
      ['T-1'],
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

describe('規劃成果傳給下游（B3）', () => {
  /**
   * 規劃 agent 讀完整個 repo 才得出 rationale 與 footprint（實測 13 分鐘），
   * 先前 rationale 只寫 log 就丟掉、footprint 只用來判斷兩群能不能並行，
   * 而寫程式的 agent 在新 worktree 從零把同一批檔案再讀一次——同一件調查付兩次錢。
   */
  it('rationale 存得進 ledger、讀得回來', () => {
    const h = createTmpLedger();
    try {
      const g = h.ledger.createGroup({
        repo: 'acme/web', branch: 'b', taskIds: ['T-1'], footprint: ['a.ts'],
        rationale: '三個任務都改 Foo.vue 的同一段',
      });
      assert.equal(h.ledger.getGroup(g.id)?.rationale, '三個任務都改 Foo.vue 的同一段');
    } finally {
      h.cleanup();
    }
  });

  /** 重派時 upsertGroup 會帶著空 rationale 進來——不能把當初的判斷洗掉。 */
  it('重派不會把 rationale 洗成空字串', () => {
    const h = createTmpLedger();
    try {
      const g = h.ledger.createGroup({
        repo: 'acme/web', branch: 'b', taskIds: ['T-1'], footprint: [], rationale: '原本的理由',
      });
      h.ledger.upsertGroup({ ...g, rationale: '', state: 'forming' });
      assert.equal(h.ledger.getGroup(g.id)?.rationale, '原本的理由');
    } finally {
      h.cleanup();
    }
  });

  it('線索有進到 agent 的提示詞裡', () => {
    const p = buildAgentPrompt({
      task: { id: 'T-1', title: 't', repo: 'a/b', category: 'dev', description: 'd', dependencies: [], docRefs: [], status: 'todo' },
      docs: [],
      cwd: '/wt',
      planHint: { rationale: '都改 Foo.vue 的同一段', files: ['src/Foo.vue', 'src/useFoo.ts'] },
    } as never);
    assert.match(p, /都改 Foo\.vue 的同一段/);
    assert.match(p, /src\/Foo\.vue/);
  });

  /**
   * **措辭是關鍵。** 讓 agent 把線索當成事實的話，它會只改那幾個檔案就收工——
   * 那比沒有這段更糟（規劃沒看過要寫的程式碼，本來就可能漏）。
   */
  it('明講線索不是事實、該改哪些由 agent 自己決定', () => {
    const p = buildAgentPrompt({
      task: { id: 'T-1', title: 't', repo: 'a/b', category: 'dev', description: 'd', dependencies: [], docRefs: [], status: 'todo' },
      docs: [],
      cwd: '/wt',
      planHint: { rationale: 'r', files: ['a.ts'] },
    } as never);
    assert.match(p, /參考用，不是事實/);
    assert.match(p, /由你自己查證決定/);
    assert.match(p, /不要因為某個檔案不在下面就不去改它/, '要明擋「只改清單內」這個偷懶路徑');
  });

  it('沒有線索時整段不出現（不要塞空標題讓 agent 去猜）', () => {
    const p = buildAgentPrompt({
      task: { id: 'T-1', title: 't', repo: 'a/b', category: 'dev', description: 'd', dependencies: [], docRefs: [], status: 'todo' },
      docs: [],
      cwd: '/wt',
    } as never);
    assert.doesNotMatch(p, /規劃階段的線索/);
  });

  /** 接線：GroupRunner 有沒有真的把 group 的東西帶下去。 */
  it('GroupRunner 把 rationale 與 footprint 交給 Worker', () => {
    const src = readFileSync('src/core/group-runner.ts', 'utf8');
    assert.match(src, /planHint:\s*\{\s*rationale:\s*group\.rationale,\s*files:\s*group\.footprint\s*\}/);
  });

  it('Worker 把線索轉給 agent', () => {
    const src = readFileSync('src/worker/worker.ts', 'utf8');
    assert.match(src, /planHint:\s*input\.planHint/);
  });
});
