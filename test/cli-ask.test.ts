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
import { openStuckGroupHandoff, openMergeApprovalHandoff, STUCK_GROUP_STATES } from '../src/core/handoff.js';
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

    it('標成 failed 就一定出現在清單上，並帶上呼叫端給的理由', () => {
      seedTask('T-A', '某任務');
      const g = tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: ['T-A'], footprint: [] });
      tmp.ledger.updateGroupState(g.id, 'failed', { reason: 'code_conflict: CONFLICT in a.ts' });

      const stuck = collectPending(tmp.ledger).filter((i) => i.kind === 'stuck_group');

      assert.equal(stuck.length, 1);
      assert.match(stuck[0]!.detail, /CONFLICT in a\.ts/);
      // 定案③加上「照樣落地」：系統沒有修 base 的權力，裁定「非本群造成」之後
      // 沒有這顆的話，這一群跟誤判時一樣落不了地。
      assert.deepEqual(stuck[0]!.actions, ['retry', 'land-anyway']);
    });

    /**
   * **核准單只有在群組真的還在等核准時才算數。**
   *
   * 實跑（2026-08-05，g_da31b3e8c2ac）：13:40 開核准單 → 13:42 人核准 →
   * 13:45 守衛擋下退回 changes_requested → **那張單還掛著**。
   * 人重啟後看到「待核准合併」再按一次，換來
   *   「這個群組正在等人回覆（park），不是等合併核准 — 已忽略此次核准」
   * 而真正該處理的 stuck_group 單就排在它旁邊，兩張長得一樣，人分不出該點哪一個。
   */
  it('群組離開 in_review 之後 → 核准單自動消化，不再出現在清單上', () => {
    seedTask('T-M', '某任務');
    const g = tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: ['T-M'], footprint: [] });
    tmp.ledger.updateGroupState(g.id, 'in_review');
    openMergeApprovalHandoff(tmp.ledger, createSilentLogger(), {
      groupId: g.id, title: '等你核准合併', why: 'x', taskIds: ['T-M'],
    });
    assert.equal(collectPending(tmp.ledger).filter((i) => i.kind === 'merge_approval').length, 1, '前置：在等核准');

    // 守衛擋下 → 退回 changes_requested
    tmp.ledger.updateGroupState(g.id, 'changes_requested');

    assert.equal(
      collectPending(tmp.ledger).filter((i) => i.kind === 'merge_approval').length,
      0,
      '核准是對「這一群現在這個樣子」的裁決；被退回之後那張單講的事情就不存在了',
    );
    // **直接驗資料，不是驗畫面。** 讀取端也有一道過濾（給舊資料用），
    // 只斷言 collectPending 的話，寫入端整個不做事也會過——那筆單會永遠留在庫裡
    // 未結案，而 Slack App Home 之類直接讀 handoffs 的地方就還是看得到它。
    assert.deepEqual(
      tmp.ledger.listHandoffs({ groupId: g.id, kind: 'merge_approval', unconsumedOnly: true }),
      [],
      '離開等核准的狀態時，那張單要真的被標成已處理',
    );
  });

  it('**舊資料也要消失**：單子早就掛在庫裡，群組狀態已經不對了', () => {
    seedTask('T-N', '某任務');
    const g = tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: ['T-N'], footprint: [] });
    // 模擬升級前留下來的：單在、群組狀態已經是 changes_requested，而且不會再有狀態變化
    tmp.ledger.updateGroupState(g.id, 'changes_requested');
    openMergeApprovalHandoff(tmp.ledger, createSilentLogger(), {
      groupId: g.id, title: '等你核准合併', why: 'x', taskIds: ['T-N'],
    });

    assert.equal(
      collectPending(tmp.ledger).filter((i) => i.kind === 'merge_approval').length,
      0,
      '寫入端只對之後的狀態變化有效——已經卡在庫裡的舊單要靠讀取端才會消失',
    );
  });

  it('還在 in_review → 核准單照常出現（別把正常的也濾掉）', () => {
    seedTask('T-O', '某任務');
    const g = tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: ['T-O'], footprint: [] });
    tmp.ledger.updateGroupState(g.id, 'in_review');
    openMergeApprovalHandoff(tmp.ledger, createSilentLogger(), {
      groupId: g.id, title: '等你核准合併', why: 'x', taskIds: ['T-O'],
    });

    assert.equal(collectPending(tmp.ledger).filter((i) => i.kind === 'merge_approval').length, 1);
  });

  /**
   * **人回答了，那張單就要當場消失。**
   *
   * 實跑（2026-08-05）：核准會把群組推進 merge_guard，而消化規則是
   * 「離開 in_review／merge_guard 才消化」——正好不涵蓋這一步。
   * 於是按完之後「待核准合併」還掛著、按鈕也還在，人很自然會再按一次。
   * 同一群被連按兩次 ×2 輪（13:42:16/20、14:37:17/30）。
   */
  it('核准之後那張核准單當場消失（否則人會重複按同一顆按鈕）', () => {
    seedTask('T-AP', '某任務');
    const g = tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: ['T-AP'], footprint: [] });
    tmp.ledger.updateGroupState(g.id, 'in_review');
    openMergeApprovalHandoff(tmp.ledger, createSilentLogger(), {
      groupId: g.id, title: '等你核准合併', why: 'x', taskIds: ['T-AP'],
    });
    assert.equal(collectPending(tmp.ledger).filter((i) => i.id === g.id).length, 1, '前置：在等核准');

    new InboundRouter({ ledger: tmp.ledger, log: createSilentLogger() })
      .handleMergeDecision({ groupId: g.id, approved: true, userId: 'console' });

    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'merge_guard');
    assert.equal(
      collectPending(tmp.ledger).filter((i) => i.id === g.id).length,
      0,
      '核准會把群組推進 merge_guard——而消化規則不涵蓋這一步，所以要在裁決時直接消化',
    );
    assert.deepEqual(
      tmp.ledger.listHandoffs({ groupId: g.id, kind: 'merge_approval', unconsumedOnly: true }),
      [],
      '直接驗資料：那筆單要真的被標成已處理，不只是畫面上看不到',
    );
  });

  it('退回也一樣當場消失（人已經回答過了）', () => {
    seedTask('T-DN', '某任務');
    const g = tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: ['T-DN'], footprint: [] });
    tmp.ledger.updateGroupState(g.id, 'in_review');
    openMergeApprovalHandoff(tmp.ledger, createSilentLogger(), {
      groupId: g.id, title: '等你核准合併', why: 'x', taskIds: ['T-DN'],
    });

    new InboundRouter({ ledger: tmp.ledger, log: createSilentLogger() })
      .handleMergeDecision({ groupId: g.id, approved: false, reason: '先不要', userId: 'console' });

    assert.equal(collectPending(tmp.ledger).filter((i) => i.kind === 'merge_approval').length, 0);
  });

  /**
   * **畫面上給的按鈕，按下去就要能動。**
   *
   * 實跑（2026-08-05，g_da31b3e8c2ac）：清單對 changes_requested 的群組開「停手」單、
   * 給「重試」按鈕，而 `reviveGroup` 只認 `failed` ——使用者連按數次，每次都拿到
   * 「無法復活這個群組（可能已被清掉或狀態已改變）」，而群組好端端地在那裡。
   *
   * 兩邊各寫一份狀態清單就是這樣壞的。現在共用 STUCK_GROUP_STATES。
   */
  for (const st of STUCK_GROUP_STATES) {
    it(`${st} 的群組：清單給了重試按鈕，reviveGroup 就要真的復活得了`, async () => {
      seedTask(`T-${st}`, '某任務');
      const g = tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: [`T-${st}`], footprint: [] });
      tmp.ledger.updateGroupState(g.id, st);

      // 正式那群是走**交接單**路徑（不是自檢），這裡照同一條路來
      openStuckGroupHandoff(tmp.ledger, createSilentLogger(), {
        groupId: g.id, repo: 'o/r', why: `停在 ${st}`,
      });

      const item = collectPending(tmp.ledger).find((i) => i.id === g.id);
      assert.ok(item, `${st} 應該要出現在待處理清單上`);
      assert.ok(item.actions.includes('retry'), `${st} 的單有「重試」按鈕`);

      const ok = await new InboundRouter({ ledger: tmp.ledger, log: createSilentLogger() })
        .reviveGroup({ groupId: g.id, userId: 'test' });

      assert.equal(ok, true, `按鈕給了卻復活不了——這正是使用者按到「無法復活這個群組」的那個 bug`);
      assert.equal(tmp.ledger.getGroup(g.id)?.state, 'ready');
      // 按過的東西要從清單上消失，否則人會一直看到它、一直再按一次
      assert.equal(
        collectPending(tmp.ledger).filter((i) => i.id === g.id).length,
        0,
        '復活了但單子還掛著 → 使用者會重複按同一顆按鈕',
      );
    });
  }

  it('已合併的群組不可以被「復活」（那是終態，復活會讓它再跑一次）', async () => {
    seedTask('T-MG', '某任務');
    const g = tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: ['T-MG'], footprint: [] });
    tmp.ledger.updateGroupState(g.id, 'merged');

    const ok = await new InboundRouter({ ledger: tmp.ledger, log: createSilentLogger() })
      .reviveGroup({ groupId: g.id, userId: 'test' });

    assert.equal(ok, false);
    assert.equal(tmp.ledger.getGroup(g.id)?.state, 'merged');
  });

  // **這一條是這整套的核心保證**：呼叫端忘了給理由也絕不會讓群組消失。
    // 文字漂不漂亮是次要的——先前它靠推論，而推論漏掉一種狀態就是 16 個任務靜靜堵著。
    it('連原因都沒給也要列（並講明去看 log）', () => {
      failedGroup('g-b', 'T-B');
      const stuck = collectPending(tmp.ledger).filter((i) => i.kind === 'stuck_group');
      assert.equal(stuck.length, 1);
      assert.match(stuck[0]!.detail, /沒有留下原因/);
    });

    it('requeue 耗盡走自己的產生端，說法與一般失敗分開（那是不同的處境）', () => {
      seedTask('T-C', '某任務');
      const g = tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: ['T-C'], footprint: [] });
      openStuckGroupHandoff(tmp.ledger, createSilentLogger(), {
        groupId: g.id, repo: 'o/r', why: '重新派工已達上限：已重試 3 次',
      });
      const stuck = collectPending(tmp.ledger).filter((i) => i.kind === 'stuck_group');
      assert.match(stuck[0]!.detail, /重新派工已達上限/);
    });
  });

  /**
   * 停手交人**不一定會進 failed**——群組可能就停在原本的狀態。
   *
   * 實跑撞到：g_1fb6a29e1a0c 重新派工用完 3 次，事件寫著「停手交人處理｜停在
   * changes_requested」；同時 g_5dc7cbe807d4 有 reconcile_needs_human 也停在
   * changes_requested。兩群在等人、16 個任務堵在它們後面，而控制台的
   * 「等你處理」是空的——上面那個「一律要浮出來」的修正只套用到 failed。
   */
  describe('停在 failed 以外的狀態、但已經交人的群組也要浮出來', () => {
    function stoppedGroup(id: string, taskId: string, state: 'changes_requested' | 'pr_open' | 'merge_guard') {
      seedTask(taskId, '某任務');
      const g = tmp.ledger.createGroup({ repo: 'o/r', branch: 'b', taskIds: [taskId], footprint: [] });
      tmp.ledger.updateGroupState(g.id, state);
      return g.id;
    }

    it('requeue 耗盡但停在 changes_requested → 要列出來', () => {
      const gid = stoppedGroup('g-d', 'T-D', 'changes_requested');
      openStuckGroupHandoff(tmp.ledger, createSilentLogger(), {
        groupId: gid, repo: 'o/r',
        why: '重新派工已達上限：已重試 3 次（停在 changes_requested）',
      });

      const stuck = collectPending(tmp.ledger).filter((i) => i.kind === 'stuck_group');

      assert.equal(stuck.length, 1, '狀態不是 failed 不代表它不需要人');
      assert.equal(stuck[0]!.id, gid);
      assert.match(stuck[0]!.detail, /重新派工已達上限/);
    });

    it('reconcile_needs_human → 要列出來，而且說法要跟「重試用完」分開', () => {
      const gid = stoppedGroup('g-e', 'T-E', 'changes_requested');
      openStuckGroupHandoff(tmp.ledger, createSilentLogger(), {
        groupId: gid, repo: 'o/r',
        why: '沒有自動處理的路徑：審查要求修改，需人工處理',
      });

      const stuck = collectPending(tmp.ledger).filter((i) => i.kind === 'stuck_group');

      assert.equal(stuck.length, 1);
      assert.match(stuck[0]!.detail, /沒有自動處理的路徑/);
      // 這兩件事處境不同：一個是「還要不要再試」，一個是「再按重試也不會有事發生」
      assert.equal(/重新派工已達上限/.test(stuck[0]!.detail), false);
    });

    // **這一條驗的是最後一道防線。**
    // 前面每一條都假設「產生端記得開單」。萬一某條路徑忘了，症狀與「真的沒事」
    // 完全一樣——所以要有一道反向檢查主動把它撈出來。
    it('產生端忘了開單 → 自檢仍要把它撈出來（不會悄悄消失）', () => {
      const gid = stoppedGroup('g-forgot', 'T-forgot', 'changes_requested');
      // 只留停手的事件、故意不開單（模擬某條路徑漏接）
      tmp.ledger.logEvent('group', gid, 'requeue_exhausted', '已重試 3 次');

      const stuck = collectPending(tmp.ledger).filter((i) => i.kind === 'stuck_group');

      assert.equal(stuck.length, 1, '漏接的路徑必須被自檢接住');
      assert.match(stuck[0]!.detail, /說不出它在等什麼/, '要明講這是系統的漏接，而不是假裝知道原因');
    });

    it('沒有交人事件的 changes_requested 群組不要列（它還在正常流程裡）', () => {
      stoppedGroup('g-f', 'T-F', 'changes_requested');
      assert.deepEqual(collectPending(tmp.ledger).filter((i) => i.kind === 'stuck_group'), []);
    });

    it('同一群同時是 failed 又有交人事件 → 只列一次', () => {
      const gid = stoppedGroup('g-g', 'T-G', 'changes_requested');
      tmp.ledger.logEvent('group', gid, 'requeue_exhausted', '已重試 3 次');
      tmp.ledger.updateGroupState(gid, 'failed');

      assert.equal(collectPending(tmp.ledger).filter((i) => i.kind === 'stuck_group').length, 1);
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
      openMergeApprovalHandoff(tmp.ledger, createSilentLogger(), {
        groupId: g.id, title: `群組 ${g.id}（2 個任務）`, why: '存在非「純樣式/文件」變更：gamma.js', taskIds: ['T-1', 'T-2'],
      });

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
      // 「還有幾群在等它」由產生端算好寫進單裡——那個數字直接代表
      // 修好這一群能解開多少後續工作（沒有它，人看到的只是一則孤立的失敗）。
      openStuckGroupHandoff(tmp.ledger, createSilentLogger(), {
        groupId: a.id, repo: 'o/r', why: '群組失敗',
        waitingGroups: tmp.ledger.listGroupsByState('ready').filter((x) => x.afterGroups.includes(a.id)).map((x) => x.id),
      });
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
      // 核准請求是**開單開出來的**，不是從 in_review 這個狀態推的——
      // 那個推論先前把「有人在 GitHub 上開始看」也當成「等你核准」。
      openMergeApprovalHandoff(tmp.ledger, createSilentLogger(), {
        groupId: g.id, title: `群組 ${g.id}`, why: '等待人工核准合併', taskIds: ['T-1'],
      });
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
        log: createSilentLogger(),
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
        log: createSilentLogger(),
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
        log: createSilentLogger(),
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
