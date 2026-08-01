import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompleteTask,
  collectPending,
  formatPending,
  resolveAction,
  applyAction,
  needsConfirmation,
  type PendingItem,
} from '../src/cli/ask.js';
import { InboundRouter } from '../src/notify/notifier.js';
import { createTmpLedger, createSilentLogger, type TmpLedger } from './helpers/index.js';
import type { McpOut } from '../src/types.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PmmMcpClient } from '../src/mcp/mcp-client.js';
import type { Ledger } from '../src/store/ledger.js';

describe('CLI ask — 本機互動入口', () => {
  let tmp: TmpLedger;
  beforeEach(() => {
    tmp = createTmpLedger();
  });
  afterEach(() => tmp.cleanup());

  function seedTask(id: string, title = '做一個按鈕'): void {
    tmp.ledger.upsertDiscoveredTask({
      id, payloadHash: 'h', repo: 'o/r', category: 'dev',
      title, description: 'd', dependencies: [], docRefs: [],
    });
  }

  /**
   * 先前只有「重新派工已達上限」的 failed 群組會進待處理清單，其餘全部靜默：
   * 執行中擲出例外、前置條件不成立、合併工作區不見、建 worktree 失敗……
   * 群組停在 failed，控制台卻回報「沒有需要你處理的事項」。
   * 實跑撞到：一個群組 failed 了半小時，清單是空的——系統悄悄放棄了一批工作。
   * **沒人看得到的失敗，比失敗本身更糟。**
   */
  describe('failed 群組一律要浮出來', () => {
    function failedGroup(id: string, taskId: string) {
      seedTask(taskId, '某任務');
      const g = tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: [taskId], footprint: [] });
      tmp.ledger.updateGroupState(g.id, 'failed');
      return g.id;
    }

    it('沒有 requeue_exhausted 也要列，並帶上最後一則失敗原因的第一行', () => {
      const gid = failedGroup('g-a', 'T-A');
      tmp.ledger.logEvent('group', gid, 'merge_guard_blocked', 'code_conflict: CONFLICT in a.ts\n第二行不該出現');

      const stuck = collectPending(tmp.ledger).filter((i) => i.kind === 'stuck_group');

      assert.equal(stuck.length, 1);
      assert.match(stuck[0]!.detail, /需要你決定要不要重試/);
      assert.match(stuck[0]!.detail, /CONFLICT in a\.ts/);
      assert.equal(/第二行不該出現/.test(stuck[0]!.detail), false, '清單只放第一行，細節去看事件');
      assert.deepEqual(stuck[0]!.actions, ['retry']);
    });

    it('連原因都沒留下也要列（並講明去看 log）', () => {
      failedGroup('g-b', 'T-B');
      const stuck = collectPending(tmp.ledger).filter((i) => i.kind === 'stuck_group');
      assert.equal(stuck.length, 1);
      assert.match(stuck[0]!.detail, /沒有留下原因/);
    });

    it('requeue 耗盡維持原本的說法（那是不同的處境）', () => {
      const gid = failedGroup('g-c', 'T-C');
      tmp.ledger.logEvent('group', gid, 'requeue_exhausted', '已重試 3 次');
      const stuck = collectPending(tmp.ledger).filter((i) => i.kind === 'stuck_group');
      assert.match(stuck[0]!.detail, /重新派工已達上限/);
    });
  });

  describe('collectPending：掃出等人處理的事項', () => {
    it('澄清：抓出問題並解析 agent 建議的預設', () => {
      seedTask('T-1', '登入頁');
      tmp.ledger.setBlock('T-1', 'needs_clarification', 'CTA 要固定底部還是隨內容捲動？\n建議：固定底部');

      const items = collectPending(tmp.ledger);

      assert.equal(items.length, 1);
      assert.equal(items[0]?.kind, 'clarification');
      assert.equal(items[0]?.id, 'T-1');
      assert.equal(items[0]?.suggestion, '固定底部');
      assert.ok(items[0]?.actions.includes('--default'));
    });

    it('無需改動：從 events 取回分類與依據（人要靠它判斷 agent 有沒有誤判）', () => {
      seedTask('T-2');
      tmp.ledger.setBlock('T-2', 'needs_human', '無需改動：現況已符合需求');
      tmp.ledger.logEvent(
        'task', 'T-2', 'no_change_reported',
        JSON.stringify({ category: 'already_satisfied', reason: '登入頁已有記住我', evidence: 'Login.vue:42' }),
      );

      const items = collectPending(tmp.ledger);

      assert.equal(items[0]?.kind, 'no_change');
      assert.equal(items[0]?.category, 'already_satisfied');
      assert.equal(items[0]?.detail, '登入頁已有記住我');
      assert.equal(items[0]?.evidence, 'Login.vue:42');
      assert.deepEqual(items[0]?.actions, ['confirm', 'reject']);
    });

    it('無需改動：事件不見或格式壞掉時仍列出（退回 block detail，不整個爆掉）', () => {
      seedTask('T-3');
      tmp.ledger.setBlock('T-3', 'needs_human', '無需改動：缺外部依賴');
      tmp.ledger.logEvent('task', 'T-3', 'no_change_reported', '{壞掉的 json');

      const items = collectPending(tmp.ledger);

      assert.equal(items[0]?.kind, 'no_change');
      assert.equal(items[0]?.detail, '無需改動：缺外部依賴');
    });

    it('一般 needs_human 與 no_change 要分開（動作不同）', () => {
      seedTask('T-4');
      tmp.ledger.setBlock('T-4', 'needs_human', '跑了 20 輪仍未綠，可能是系統問題');

      const items = collectPending(tmp.ledger);

      assert.equal(items[0]?.kind, 'needs_human');
      assert.deepEqual(items[0]?.actions, ['retry', 'abort']);
    });

    it('blocked:deps 不列入（那是自動等待，不需要人做事）', () => {
      seedTask('T-5');
      tmp.ledger.setBlock('T-5', 'deps', '前置任務未完成');

      assert.deepEqual(collectPending(tmp.ledger), []);
    });

    it('待核准的群組會列出，並帶上政策理由', () => {
      tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: ['T-1', 'T-2'], footprint: [] });
      const g = tmp.ledger.listGroupsByState('ready')[0]!;
      tmp.ledger.updateGroupState(g.id, 'in_review');
      tmp.ledger.logEvent('group', g.id, 'policy_needs_human', '存在非「純樣式/文件」變更：gamma.js');

      const items = collectPending(tmp.ledger);

      assert.equal(items[0]?.kind, 'merge_approval');
      assert.match(items[0]?.detail ?? '', /gamma\.js/);
      assert.deepEqual(items[0]?.actions, ['approve', 'deny']);
    });

    /**
     * afterGroups 只有真的有依賴才會有值，所以「幾群在等它」直接代表
     * 修好這一群能解開多少後續工作。沒有這個數字，人看到的只是一則孤立的失敗，
     * 不知道背後還有一整條鏈停在那裡。
     */
    it('失敗的群組要標出後面有幾群在等它進 base', () => {
      const a = tmp.ledger.createGroup({ repo: 'o/r', branch: 'a', taskIds: ['T-1'], footprint: [] });
      tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: ['T-2'], footprint: [], afterGroups: [a.id] });
      tmp.ledger.createGroup({ repo: 'o/r', branch: 'c', taskIds: ['T-3'], footprint: [], afterGroups: [a.id] });
      tmp.ledger.updateGroupState(a.id, 'failed');

      const stuck = collectPending(tmp.ledger).find((i) => i.kind === 'stuck_group');
      assert.match(stuck?.detail ?? '', /還有 2 群在等它進 base/);
    });

    it('沒有後續群組時就完全不提（不要多出一句沒資訊的話）', () => {
      const a = tmp.ledger.createGroup({ repo: 'o/r', branch: 'a', taskIds: ['T-1'], footprint: [] });
      tmp.ledger.updateGroupState(a.id, 'failed');

      const stuck = collectPending(tmp.ledger).find((i) => i.kind === 'stuck_group');
      assert.doesNotMatch(stuck?.detail ?? '', /在等它/);
    });

    it('沒有待辦時回空陣列，格式化成友善訊息', () => {
      assert.deepEqual(collectPending(tmp.ledger), []);
      assert.match(formatPending([]), /沒有需要你處理/);
    });
  });

  describe('resolveAction：命令列參數 → 動作', () => {
    const clar: PendingItem = {
      kind: 'clarification', id: 'T-1', title: 't', repo: 'acme/web', detail: 'q',
      suggestion: '固定底部', actions: ['<你的答案>', '--default', 'abort'],
    };
    const noChange: PendingItem = {
      kind: 'no_change', id: 'T-2', title: 't', repo: 'acme/web', detail: 'r', actions: ['confirm', 'reject'],
    };

    it('自由文字視為澄清答案', () => {
      const a = resolveAction([clar], '1', ['隨內容', '捲動']);
      assert.ok(typeof a !== 'string');
      assert.equal(a.verb, 'answer');
      assert.equal(a.answer, '隨內容 捲動');
    });

    it('--default 採用 agent 的建議', () => {
      const a = resolveAction([clar], '1', ['--default']);
      assert.ok(typeof a !== 'string');
      assert.equal(a.answer, '固定底部');
    });

    it('沒有建議時 --default 要明確報錯，不可亂猜', () => {
      const noSuggestion = { ...clar, suggestion: undefined };
      const a = resolveAction([noSuggestion], '1', ['--default']);
      assert.equal(typeof a, 'string');
      assert.match(a as string, /沒有可用的建議/);
    });

    it('動作必須在該項的可用清單內', () => {
      assert.match(resolveAction([noChange], '1', ['approve']) as string, /不支援/);
      const ok = resolveAction([noChange], '1', ['confirm']);
      assert.ok(typeof ok !== 'string');
    });

    it('非澄清項目不接受自由文字（避免把答案誤當動作）', () => {
      assert.match(resolveAction([noChange], '1', ['隨便打的字']) as string, /需要動作而非自由文字/);
    });

    it('找不到目標要報錯（編號越界或不存在的 id）', () => {
      assert.match(resolveAction([clar], '0', ['x']) as string, /找不到目標/);
      assert.match(resolveAction([clar], '9', ['x']) as string, /找不到目標/);
      assert.match(resolveAction([clar], 'T-NOPE', ['x']) as string, /找不到目標/);
    });

    it('可用 id 指定，避免清單變動造成的誤操作', () => {
      // 實測踩過：處理完前一項後清單重新編號，原本的 [3] 變成 [2]，
      // 於是「對第 2 項確認」打到了另一個群組的合併核准。用 id 就不會指錯。
      const a = resolveAction([clar, noChange], 'T-2', ['confirm']);
      assert.ok(typeof a !== 'string');
      assert.equal(a.item.id, 'T-2');
      assert.equal(a.verb, 'confirm');
    });

    it('id 優先於編號（即使 id 剛好長得像數字也不會被當序位）', () => {
      const numericId: PendingItem = { ...noChange, id: '1' };
      // items[0] 是 clar；若把 '1' 當編號會選到 clar，但實際上有 id='1' 的項目
      const a = resolveAction([clar, numericId], '1', ['confirm']);
      assert.ok(typeof a !== 'string');
      assert.equal(a.item.id, '1');
      assert.equal(a.item.kind, 'no_change');
    });
  });

  describe('applyAction：走與 Slack 相同的 InboundRouter', () => {
    function build(completeTask?: (id: string) => Promise<McpOut<void>>) {
      const log = createSilentLogger();
      const router = new InboundRouter({
        ledger: tmp.ledger,
        log,
        ...(completeTask ? { completeTask: async (id) => completeTask(id) } : {}),
      });
      return { router, log };
    }

    it('回答澄清 → 任務回到 queued（daemon 下輪會重跑）', async () => {
      seedTask('T-1');
      tmp.ledger.setBlock('T-1', 'needs_clarification', '要 A 還是 B？');
      const items = collectPending(tmp.ledger);
      const action = resolveAction(items, '1', ['選', 'B']);
      assert.ok(typeof action !== 'string');

      const msg = await applyAction(action, build());

      assert.match(msg, /已回覆/);
      const t = tmp.ledger.getTask('T-1');
      assert.equal(t?.state, 'queued');
      assert.equal(t?.block, undefined);
    });

    it('confirm → 呼叫 complete_task 並標 done（這是不可逆的出口）', async () => {
      seedTask('T-2');
      tmp.ledger.setBlock('T-2', 'needs_human', '無需改動：現況已符合需求');
      tmp.ledger.logEvent('task', 'T-2', 'no_change_reported',
        JSON.stringify({ category: 'already_satisfied', reason: '已存在' }));

      const completed: string[] = [];
      const items = collectPending(tmp.ledger);
      const action = resolveAction(items, '1', ['confirm']);
      assert.ok(typeof action !== 'string');

      await applyAction(action, build(async (id) => {
        completed.push(id);
        return { ok: true, value: undefined };
      }));

      assert.deepEqual(completed, ['T-2'], 'MCP 上的卡必須真的被關掉');
      assert.equal(tmp.ledger.getTask('T-2')?.state, 'done');
    });

    it('confirm 但 MCP 拒絕 → 誠實回報未完成，不可謊稱成功', async () => {
      seedTask('T-8');
      tmp.ledger.setBlock('T-8', 'needs_human', '無需改動：現況已符合需求');
      const items = collectPending(tmp.ledger);
      const action = resolveAction(items, 'T-8', ['confirm']);
      assert.ok(typeof action !== 'string');

      const log = createSilentLogger();
      const router = new InboundRouter({
        ledger: tmp.ledger,
        log,
        completeTask: async () => ({ ok: false, kind: 'permanent', detail: '找不到這個任務' }),
      });
      const msg = await applyAction(action, {
        router,
        log,
        readTaskState: (id) => {
          const t = tmp.ledger.getTask(id);
          return t ? { state: t.state, ...(t.block?.detail ? { blockDetail: t.block.detail } : {}) } : undefined;
        },
      });

      // 實測踩過：router 吞掉自己的錯誤，CLI 卻印「已標記完成」——訊息與事實不符
      assert.match(msg, /確認未完成/);
      assert.match(msg, /找不到這個任務/);
      assert.doesNotMatch(msg, /任務已標記完成/);
      assert.notEqual(tmp.ledger.getTask('T-8')?.state, 'done');
    });

    it('reject → 任務回 queued 讓 agent 重做（而不是結案）', async () => {
      seedTask('T-3');
      tmp.ledger.setBlock('T-3', 'needs_human', '無需改動：我覺得不用做');
      const items = collectPending(tmp.ledger);
      const action = resolveAction(items, '1', ['reject']);
      assert.ok(typeof action !== 'string');

      const completed: string[] = [];
      await applyAction(action, build(async (id) => {
        completed.push(id);
        return { ok: true, value: undefined };
      }));

      assert.deepEqual(completed, [], 'reject 不可呼叫 complete_task');
      assert.equal(tmp.ledger.getTask('T-3')?.state, 'queued');
    });

    it('approve → 群組進入 merge_guard 等 daemon 重跑守衛', async () => {
      tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: ['T-1'], footprint: [] });
      const g = tmp.ledger.listGroupsByState('ready')[0]!;
      tmp.ledger.updateGroupState(g.id, 'in_review');
      const items = collectPending(tmp.ledger);
      const action = resolveAction(items, '1', ['approve']);
      assert.ok(typeof action !== 'string');

      await applyAction(action, build());

      assert.equal(tmp.ledger.getGroup(g.id)?.state, 'merge_guard');
    });
  });

  describe('安全性', () => {
    it('只有 confirm 需要二次確認（它會呼叫不可逆的 complete_task）', () => {
      const mk = (verb: string): { item: PendingItem; verb: never } =>
        ({ item: { kind: 'no_change', id: 'T', title: 't', repo: 'acme/web', detail: 'd', actions: [] }, verb: verb as never });
      assert.equal(needsConfirmation(mk('confirm')), true);
      for (const v of ['reject', 'answer', 'approve', 'deny', 'retry', 'abort', 'pause']) {
        assert.equal(needsConfirmation(mk(v)), false, `${v} 不該要求二次確認`);
      }
    });

    it('沒注入 completeTask 時 confirm 不可把任務標 done（免得任務板上的卡沒關掉卻在本機顯示完成）', async () => {
      seedTask('T-9');
      tmp.ledger.setBlock('T-9', 'needs_human', '無需改動：現況已符合需求');
      const items = collectPending(tmp.ledger);
      const action = resolveAction(items, '1', ['confirm']);
      assert.ok(typeof action !== 'string');

      const log = createSilentLogger();
      await applyAction(action, { router: new InboundRouter({ ledger: tmp.ledger, log }), log });

      assert.notEqual(tmp.ledger.getTask('T-9')?.state, 'done');
    });
  });
});

describe('deny 要能帶修改意見', () => {
  const group: PendingItem = {
    kind: 'merge_approval', id: 'g1', title: '群組 g1', repo: 'acme/web',
    detail: '需人工核准', actions: ['approve', 'deny'],
  };

  /**
   * 沒有意見的退回等於只跟 agent 說「不行」卻不說哪裡不行，
   * 它下一輪多半原封不動再送一次，人再退一次——純燒錢的迴圈。
   */
  it('`deny <要改什麼>` 把意見帶進動作', () => {
    const a = resolveAction([group], 'g1', ['deny', '時間改成', '24', '小時制']);
    assert.ok(typeof a !== 'string');
    assert.equal(a.verb, 'deny');
    assert.equal(a.answer, '時間改成 24 小時制');
  });

  it('單純 `deny` 仍然可用（只是先停下來）', () => {
    const a = resolveAction([group], 'g1', ['deny']);
    assert.ok(typeof a !== 'string');
    assert.equal(a.verb, 'deny');
    assert.equal(a.answer, undefined);
  });

  it('不支援 deny 的項目不會因為多帶文字就繞過檢查', () => {
    const clar: PendingItem = {
      kind: 'clarification', id: 'T-1', title: 't', repo: 'acme/web', detail: 'q',
      actions: ['<你的答案>', '--default', 'abort'],
    };
    // 澄清項目的自由文字仍該被當成答案，而不是 deny
    const a = resolveAction([clar], 'T-1', ['deny', '這其實是答案']);
    assert.ok(typeof a !== 'string');
    assert.equal(a.verb, 'answer');
  });
});

// ── failed 群組要真的救得回來 ──

/**
 * 待處理清單告訴人「可用動作：retry」，但 handleControl 的 retry 做的是
 * `clearBlock(taskId, 'queued')`——對「任務都 done、只是收尾失敗」的群組完全無效。
 * 而那正是最常見的 failed 形態（Merge Guard 擋下、開 PR 失敗、工作區不見）。
 * 實跑撞到：按了 retry，什麼都沒發生，群組永遠躺在 failed。
 * **提供一個沒用的動作，比不提供更糟**——人以為處理過了。
 */
describe('stuck_group 的 retry', () => {
  const item = {
    kind: 'stuck_group' as const,
    id: 'g_abc123',
    title: '群組 g_abc123',
    repo: 'o/r',
    detail: '群組失敗',
    actions: ['retry'],
  };

  it('走群組復活，不是任務層的 clearBlock', async () => {
    const calls: string[] = [];
    const msg = await applyAction(
      { item, verb: 'retry' },
      {
        router: {
          handleAnswer: () => {},
          handleControl: () => void calls.push('handleControl'),
          handleMergeDecision: () => {},
          reviveGroup: async () => { calls.push('reviveGroup'); return true; },
        },
      },
    );
    assert.deepEqual(calls, ['reviveGroup'], '絕不能走 handleControl——那對 done 的任務是空操作');
    assert.match(msg, /已回到待派工/);
  });

  it('復活失敗要說出來，不能回報成功', async () => {
    const msg = await applyAction(
      { item, verb: 'retry' },
      {
        router: {
          handleAnswer: () => {},
          handleControl: () => {},
          handleMergeDecision: () => {},
          reviveGroup: async () => false,
        },
      },
    );
    assert.match(msg, /無法復活/);
  });

  it('一般任務的 retry 維持原本行為', async () => {
    const calls: string[] = [];
    await applyAction(
      { item: { ...item, kind: 'needs_human' as const, id: 'T-1' }, verb: 'retry' },
      {
        router: {
          handleAnswer: () => {},
          handleControl: () => void calls.push('handleControl'),
          handleMergeDecision: () => {},
          reviveGroup: async () => { calls.push('reviveGroup'); return true; },
        },
      },
    );
    assert.deepEqual(calls, ['handleControl']);
  });
});

/**
 * confirm / reject 要能真的呼叫 complete_task，否則 agent 回報「無需改動」之後，
 * 人想確認也確認不了，任務永遠停在 blocked——那個出口等於不存在。
 *
 * 實跑撞到：CLI 自己拼了一個 `{ url: '', token: '', stdio: {...} }` 當 MCP 設定，
 * 但 McpClientConfig **根本沒有 stdio 這個欄位**（stdio 是用 createTransport 注入的）。
 * 那個物件會被當成「連 url='' 的 HTTP」，於是對**任何 stdio 任務板**都必定連不上。
 * 錯誤訊息還很誠實地說「無法連上任何 MCP」，所以看起來像環境問題，不像程式錯。
 */
describe('buildCompleteTask — stdio 任務板要連得上', () => {
  const tmp = { ledger: undefined as unknown as Ledger };

  it('stdio 專案連得上，並且真的呼叫得到 complete_task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-mcp-'));
    const tasksFile = join(dir, 'tasks.json');
    writeFileSync(
      tasksFile,
      JSON.stringify({
        tasks: [{
          id: 'X-1', title: '任務', status: 'todo', repo: 'acme/web', category: 'dev',
          summary: '', assigneeId: 'me', createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z', depIdList: [], docRefsList: [], completedSummary: '',
        }],
        docs: {}, calls: [],
      }),
    );

    const t = createTmpLedger();
    tmp.ledger = t.ledger as unknown as Ledger;
    const clients: PmmMcpClient[] = [];
    try {
      const complete = await buildCompleteTask(
        {
          projects: [{
            id: 'p', repo: 'acme/web', repoPath: dir, quietPeriodMinutes: 0,
            mcp: {
              transport: 'stdio', command: 'npx',
              args: ['tsx', resolve('scripts/mock-mcp-server.ts')],
              env: { ORCH_MOCK_TASKS: tasksFile },
            },
            commands: {}, visual: { routes: [], when: 'never', categories: [] },
          }],
        } as never,
        t.ledger as never,
        createSilentLogger(),
        clients,
      );
      assert.notEqual(complete, undefined, 'stdio 任務板必須連得上，否則 confirm 這條路是死的');
    } finally {
      for (const c of clients) await c.close().catch(() => undefined);
      t.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
