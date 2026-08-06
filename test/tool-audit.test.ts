import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createPreToolUseGuard } from '../src/worker/agent-runtime.js';
import { createToolAuditor, serializeToolInput, NO_TOOL_AUDIT, type ToolCallRecord } from '../src/worker/tool-audit.js';
import { readFileSync } from 'node:fs';
import { createSilentLogger, createTmpLedger, type TmpLedger } from './helpers/index.js';

/**
 * 這一整支測的是「事後查得到是誰動了這個工作區」。
 *
 * 實跑 HIAzzBkS0x5a：工作區在任務進行中被清空兩次，reflog 只留下
 * `reset: moving to HEAD`。調度器程式碼裡沒有任何 reset/clean，所以是某個 agent
 * 下的手——但 coder 與 reviewer 共用同一個 worktree，指令字串沒有任何地方留著，
 * 事後完全無法歸因。
 */

describe('serializeToolInput — 截斷是機械的，不挑欄位', () => {
  it('一般參數原封不動（Bash 的 command 是整套東西存在的理由）', () => {
    const s = serializeToolInput({ command: 'git reset --hard HEAD', description: '退回上一版' });
    assert.equal(JSON.parse(s).command, 'git reset --hard HEAD');
  });

  /**
   * **不挑欄位**：挑欄位要維護一份「每個工具的哪些參數重要」的對照表，
   * 而新工具一加就會靜靜地漏記。這裡鎖的是「沒見過的參數也要留下來」。
   */
  it('沒見過的工具與參數照樣留得下來', () => {
    const s = serializeToolInput({ 未來新工具的參數: 'x', nested: { deep: [1, 2] } });
    const o = JSON.parse(s) as Record<string, unknown>;
    assert.equal(o.未來新工具的參數, 'x');
    assert.deepEqual(o.nested, { deep: [1, 2] });
  });

  it('長字串截斷並標明原長（Write 的整份檔案內容對歸因沒有價值）', () => {
    const s = serializeToolInput({ content: 'x'.repeat(50_000) });
    assert.ok(s.length < 10_000, `截斷後應遠小於原文，實際 ${s.length}`);
    assert.match(s, /原長 50000/, '要講出被砍掉多少，否則讀的人不知道自己看到的是殘缺的');
  });

  /** 記帳失敗絕不能影響工具呼叫——連序列化都不可以擲錯。 */
  it('循環參照不擲錯', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    assert.doesNotThrow(() => serializeToolInput(a));
  });
});

describe('PreToolUse hook — 每次呼叫都要留下全文', () => {
  const guardWith = (sink: ToolCallRecord[], policy?: Parameters<typeof createPreToolUseGuard>[1]) =>
    createPreToolUseGuard(createSilentLogger(), policy, (e) => {
      sink.push({ at: 0, role: 'coder', tool: e.tool, input: serializeToolInput(e.input), ...(e.denied ? { denied: e.denied } : {}), ...(e.cwd ? { cwd: e.cwd } : {}) });
    });

  it('放行的呼叫留得下指令原文與工作區', async () => {
    const got: ToolCallRecord[] = [];
    const guard = guardWith(got);

    await guard({ tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD' }, cwd: '/wt/g-1' });

    assert.equal(got.length, 1);
    assert.equal(got[0]?.tool, 'Bash');
    assert.equal(got[0]?.cwd, '/wt/g-1', 'cwd 是歸因的主軸——問題永遠是「這個目錄被誰動了」');
    assert.match(got[0]?.input ?? '', /git reset --hard HEAD/);
    assert.equal(got[0]?.denied, undefined, '沒被擋就不該有 denied');
  });

  /** 被擋下的嘗試比成功的更值得看：它說明 agent 當時想做什麼。 */
  it('被紅線擋下的呼叫也要留，而且要留下理由', async () => {
    const got: ToolCallRecord[] = [];
    const guard = guardWith(got);

    const v = await guard({ tool_name: 'Bash', tool_input: { command: 'firebase deploy' }, cwd: '/wt/g-1' });

    assert.equal((v as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(got.length, 1, '擋下來不代表沒發生過');
    assert.match(got[0]?.denied ?? '', /firebase deploy/);
  });

  it('hookInput 缺欄位時照樣記一筆，不擲錯', async () => {
    const got: ToolCallRecord[] = [];
    const guard = guardWith(got);
    await assert.doesNotReject(() => guard({}));
    assert.equal(got.length, 1);
  });

  /**
   * 稽核**不可以**改變放行與否。它一旦有機會影響閘門，紅線就多了一個失效方式。
   */
  it('稽核回呼擲錯也不影響放行判定', async () => {
    const guard = createPreToolUseGuard(createSilentLogger(), undefined, () => {
      throw new Error('稽核壞了');
    });
    await assert.rejects(() => guard({ tool_name: 'Read', tool_input: {} }), /稽核壞了/,
      '這裡刻意讓它冒出來：createToolAuditor 自己會吞例外，而「回呼會擲錯」代表接線的人寫錯了，不該靜悄悄');
  });
});

describe('createToolAuditor — 沒接 sink 就什麼都不做', () => {
  it('未注入 sink 不擲錯', () => {
    const audit = createToolAuditor(createSilentLogger(), 'coder', { taskId: 'T-1' });
    assert.doesNotThrow(() => audit({ tool: 'Bash', input: { command: 'ls' } }));
  });

  /** sink 壞掉只該少一筆紀錄，絕不能讓 agent 的工具呼叫失敗。 */
  it('sink 擲錯被吞掉', () => {
    const audit = createToolAuditor(createSilentLogger(), 'coder', {}, {
      recordToolCall() { throw new Error('DB 滿了'); },
    });
    assert.doesNotThrow(() => audit({ tool: 'Bash', input: {} }));
  });

  it('NO_TOOL_AUDIT 是明確的「不記」，不是省略參數', () => {
    assert.doesNotThrow(() => NO_TOOL_AUDIT({ tool: 'Bash', input: {} }));
  });
});

/**
 * 接線測試。形狀與 docs-wiring 相同，理由也相同：**能力寫好了，只接上一半的呼叫點。**
 *
 * 這裡的漏接症狀特別惡劣——「那個角色什麼都沒記」與「那個角色什麼都沒做」
 * 在資料上長得一模一樣。而工作區被清空那次，共用目錄的角色正好有三個。
 *
 * hook 那一層已經是編譯錯誤（createPreToolUseGuard 的第三個參數必填），
 * 這裡守的是編譯器管不到的兩段：sink 有沒有被注入、有沒有人偷傳 NO_TOOL_AUDIT。
 */
describe('工具稽核接線 — 五個角色一個都不能少', () => {
  const ROLES: [string, string][] = [
    ['寫程式', 'src/worker/agent-runtime.ts'],
    ['審查者', 'src/worker/reviewer.ts'],
    ['規劃者', 'src/core/plan-agent.ts'],
    ['飄移判斷者', 'src/pr/drift-judge.ts'],
    ['風險判斷者', 'src/core/merge-risk-judge.ts'],
  ];

  for (const [role, file] of ROLES) {
    it(`${role}會把工具呼叫記下來`, () => {
      assert.match(readFileSync(file, 'utf8'), /createToolAuditor\(/, `${file} 沒有接稽核`);
    });
  }

  /** 註解裡提到它不算數（agent-runtime 的說明就寫著「不想記就傳 NO_TOOL_AUDIT」）。 */
  const codeOf = (file: string): string =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');

  it('沒有任何正式角色偷傳 NO_TOOL_AUDIT（那是測試專用的「明確不記」）', () => {
    for (const [, file] of ROLES) {
      assert.doesNotMatch(codeOf(file), /NO_TOOL_AUDIT/, `${file} 把稽核關掉了`);
    }
  });

  it('main 有把 sink 注入五個角色（沒接 → 靜靜地什麼都不記）', () => {
    const src = readFileSync('src/main.ts', 'utf8');
    for (const ctor of ['new AgentRuntime(', 'new Reviewer({', 'new PlanAgent({', 'new DriftJudge({', 'new MergeRiskJudge({']) {
      const i = src.indexOf(ctor);
      assert.ok(i >= 0, `找不到 ${ctor}`);
      assert.match(src.slice(i, i + 600), /toolAudit: ledger/, `${ctor} 沒有注入 toolAudit`);
    }
  });

  /** 保留策略沒接的話，這張表會無限長大——它的成長是別人的一到兩個數量級。 */
  it('保留策略有接上（不然這張表只進不出）', () => {
    assert.match(readFileSync('src/core/reconciler.ts', 'utf8'), /pruneToolCalls/);
  });
});

describe('Ledger — 工具紀錄的寫入與查詢', () => {
  let tmp: TmpLedger;
  beforeEach(() => { tmp = createTmpLedger(); });
  afterEach(() => tmp.cleanup());

  const rec = (o: Partial<ToolCallRecord>): ToolCallRecord => ({
    at: 1_000, role: 'coder', tool: 'Bash', input: '{}', ...o,
  });

  it('寫得進去、讀得回來（最新的在前）', () => {
    tmp.ledger.recordToolCall(rec({ at: 1, input: '{"command":"npm test"}' }));
    tmp.ledger.recordToolCall(rec({ at: 2, input: '{"command":"git reset --hard HEAD"}' }));

    const rows = tmp.ledger.listToolCalls();
    assert.equal(rows.length, 2);
    assert.match(rows[0]?.input ?? '', /reset --hard/, '最新的要在前面');
  });

  /**
   * 這條是整張表存在的理由：「**這個目錄**在那段時間被誰動了什麼」。
   * 共用工作區的角色不只一個，所以查詢主軸是 cwd 而不是 taskId。
   */
  it('依 cwd 查得出「誰動了這個工作區」——跨角色', () => {
    const wt = '/wt/orch-Dinosaur-g_3e2bd22d1c42';
    tmp.ledger.recordToolCall(rec({ at: 1, role: 'coder', cwd: wt, input: '{"command":"npm run build"}' }));
    tmp.ledger.recordToolCall(rec({ at: 2, role: 'reviewer', cwd: wt, input: '{"command":"git reset --hard HEAD"}' }));
    tmp.ledger.recordToolCall(rec({ at: 3, role: 'coder', cwd: '/wt/別的群', input: '{"command":"ls"}' }));

    const rows = tmp.ledger.listToolCalls({ cwd: wt });
    assert.equal(rows.length, 2, '只能是這個目錄的');
    assert.equal(rows.find((r) => /reset --hard/.test(r.input))?.role, 'reviewer', '要指得出是哪個角色下的手');
  });

  it('查得出被紅線擋下的嘗試', () => {
    tmp.ledger.recordToolCall(rec({ at: 1 }));
    tmp.ledger.recordToolCall(rec({ at: 2, denied: '紅線：禁止 firebase deploy（專案綁部署）' }));

    const rows = tmp.ledger.listToolCalls({ deniedOnly: true });
    assert.equal(rows.length, 1);
    assert.match(rows[0]?.denied ?? '', /firebase deploy/);
  });

  it('依任務、角色、工具、時間各自篩得動', () => {
    tmp.ledger.recordToolCall(rec({ at: 10, taskId: 'T-1', role: 'coder', tool: 'Bash' }));
    tmp.ledger.recordToolCall(rec({ at: 20, taskId: 'T-2', role: 'reviewer', tool: 'Read' }));

    assert.equal(tmp.ledger.listToolCalls({ taskId: 'T-1' }).length, 1);
    assert.equal(tmp.ledger.listToolCalls({ role: 'reviewer' }).length, 1);
    assert.equal(tmp.ledger.listToolCalls({ tool: 'Bash' }).length, 1);
    assert.equal(tmp.ledger.listToolCalls({ since: 15 }).length, 1);
  });

  /** 稽核寫入失敗只該少一筆紀錄——絕不能讓呼叫端崩掉。 */
  it('寫入失敗不擲錯', () => {
    assert.doesNotThrow(() => tmp.ledger.recordToolCall(rec({ input: undefined as unknown as string })));
  });

  it('保留策略清得掉舊紀錄，且不碰新的', () => {
    tmp.ledger.recordToolCall(rec({ at: 100 }));
    tmp.ledger.recordToolCall(rec({ at: 900 }));

    assert.equal(tmp.ledger.pruneToolCalls(500), 1);
    assert.equal(tmp.ledger.listToolCalls().length, 1);
    assert.equal(tmp.ledger.pruneToolCalls(Number.NaN), 0, 'cutoff 壞掉時寧可不清，也不要清光');
  });
});
