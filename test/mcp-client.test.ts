import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  PmmMcpClient,
  McpError,
  mcpResilienceFromEnv,
  toEpochMs,
  MCP_RESILIENCE_DEFAULTS,
  type McpResilienceOptions,
} from '../src/mcp/mcp-client.js';
import { CircuitBreaker } from '../src/core/retry.js';
import { createSilentLogger, createRecordingLogger } from './helpers/index.js';
import type { Logger } from '../src/observability/logger.js';

// 不打真實網路：PmmMcpClient 只有 connect() 會建立 transport，這裡從不呼叫它，
// 改以假的 callTool 取代內部 Client（private 僅是編譯期限制，執行期可替換）。
interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}
type Responder = (call: ToolCall) => unknown | Promise<unknown>;

interface MakeClientOpts {
  log?: Logger;
  /** 韌性設定；預設維持正式預設值但把 sleep 換成瞬時（測試不真的等待）。 */
  resilience?: McpResilienceOptions;
}

interface MadeClient {
  client: PmmMcpClient;
  calls: ToolCall[];
  /** 每次退避實際睡了多久（毫秒），用來驗證指數成長。 */
  sleeps: number[];
}

function makeClient(responder: Responder, o: MakeClientOpts = {}): MadeClient {
  const calls: ToolCall[] = [];
  const sleeps: number[] = [];
  const client = new PmmMcpClient({ url: 'http://127.0.0.1:1/mcp', token: 'x' }, o.log ?? createSilentLogger(), {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5, // jitter 取中點 → 延遲等於理論值，可精確斷言
    ...o.resilience,
  });
  const fake = {
    async callTool(req: { name: string; arguments?: Record<string, unknown> }) {
      const call: ToolCall = { name: req.name, arguments: req.arguments ?? {} };
      calls.push(call);
      const out = await responder(call);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  (client as unknown as { client: typeof fake }).client = fake;
  return { client, calls, sleeps };
}

/** MCP 工具回應的標準外殼（content 內含 JSON 文字）。 */
const text = (v: unknown) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] });

describe('PmmMcpClient — 帶內錯誤分類', () => {
  /**
   * **不再猜這個錯誤代表什麼。**
   *
   * 先前有兩組中英關鍵字正則（DEPS_WAIT_HINTS / NOT_WAITABLE_HINTS）判它是
   *「可以等的前置未完成」還是「永久失敗」。註解自己寫著「比對刻意寬鬆到能容忍措辭變化」
   * ——那就是承認在猜。任務板換一版措辭、換一種語言、換一個錯誤碼就失效，
   * 而失效的方式是**靜默地全部落到預設值**。
   *
   * 程式知道的只有「認領失敗了」。要讀懂那句話是人或 agent 的事，
   * 而交人的路徑本來就在，錯誤全文會一起帶上去。
   */
  it('帶內錯誤一律 permanent，原始錯誤全文原樣帶出來', async () => {
    const { client } = makeClient(() => text({ ok: false, error: '依賴 T-0 尚未完成', code: 'DEPS_NOT_DONE' }));

    const out = await client.startTask('T-1');

    assert.deepEqual(out, { ok: false, kind: 'permanent', detail: '依賴 T-0 尚未完成' });
  });

  it('start_task 帶內錯誤沒有 error 欄位 → permanent（辨識不出「依賴未滿足」就不准無聲重試）', async () => {
    const { client } = makeClient(() => text({ ok: false }));
    const out = await client.startTask('T-1');
    assert.deepEqual(out, { ok: false, kind: 'permanent', detail: '未知錯誤' });
  });

  it('start_task 成功 → ok，並帶 taskId 參數', async () => {
    const { client, calls } = makeClient(() =>
      text({ id: 'T-1', title: '做事', status: 'in_progress', repo: 'acme/web', category: 'dev' }),
    );

    const out = await client.startTask('T-1');

    assert.equal(out.ok, true);
    assert.equal(out.ok === true ? out.value.status : '', 'in_progress');
    assert.deepEqual(calls[0], { name: 'handler__start_task', arguments: { taskId: 'T-1' } });
  });

  it('complete_task 帶內 { ok:false } → permanent（重送也沒用，屬設定/狀態問題）', async () => {
    const { client } = makeClient(() => text({ ok: false, error: '任務不在 in_progress' }));

    const out = await client.completeTask('T-1');

    assert.deepEqual(out, { ok: false, kind: 'permanent', detail: '任務不在 in_progress' });
  });

  it('complete_task：有 summary 才帶該欄位（bug 類才有修復報告）', async () => {
    const { client, calls } = makeClient(() => text({ ok: true }));

    await client.completeTask('T-1');
    await client.completeTask('T-2', { summary: '修好了' });
    await client.completeTask('T-3', { summary: '' });

    assert.deepEqual(calls[0]?.arguments, { taskId: 'T-1' });
    assert.deepEqual(calls[1]?.arguments, { taskId: 'T-2', summary: '修好了' });
    assert.deepEqual(calls[2]?.arguments, { taskId: 'T-3' }, '空字串 summary 不送');
  });

  it('讀取類（get_task / list_tasks / list_repos / read_doc）帶內錯誤 → 擲 McpError(permanent)', async () => {
    const { client } = makeClient((c) => text({ ok: false, error: `${c.name} 沒權限` }));

    for (const fn of [
      () => client.getTask('T-1'),
      () => client.listTasks({ repo: 'acme/web' }),
      () => client.listRepos(),
      () => client.readDoc('spec', 'a.md'),
    ]) {
      await assert.rejects(fn, (e: unknown) => {
        assert.ok(e instanceof McpError);
        assert.equal(e.kind, 'permanent');
        return true;
      });
    }
  });
});

/**
 * 缺陷 1：start_task 的帶內錯誤不能一律當 signal。
 * signal = 「照做並稍後重試」，會**無聲**地一輪一輪重打；permanent 會停下來讓人看到。
 * 崩潰恢復時 MCP 上的任務仍是 in_progress，舊行為會讓群組 ready↔blocked 永久空轉。
 */
/**
 * `start_task` 失敗不再被分類。
 *
 * 先前用兩組中英關鍵字正則猜「這是可以等的前置未完成嗎」，換一版措辭就失效——
 * 而失效的方式是靜默地全部落到預設值 permanent。要判斷「這個錯誤代表什麼」
 * 得讀得懂任務板的語意，那是人或 agent 的事；程式知道的只有「認領失敗了」。
 */

describe('PmmMcpClient — 傳輸層例外分類', () => {
  const cases: { msg: string; kind: 'permanent' | 'transient' }[] = [
    { msg: 'HTTP 401', kind: 'permanent' },
    { msg: 'HTTP 403 Forbidden', kind: 'permanent' },
    { msg: 'Unauthorized', kind: 'permanent' },
    { msg: 'socket hang up', kind: 'transient' },
    { msg: 'HTTP 503 Service Unavailable', kind: 'transient' },
    { msg: 'HTTP 429 Too Many Requests', kind: 'transient' },
    { msg: 'ETIMEDOUT', kind: 'transient' },
  ];

  for (const c of cases) {
    it(`start_task 傳輸例外「${c.msg}」→ ${c.kind}`, async () => {
      const { client } = makeClient(() => new Error(c.msg));
      const out = await client.startTask('T-1');
      assert.equal(out.ok, false);
      assert.equal(out.ok === false ? out.kind : '', c.kind);
    });
  }

  it('complete_task 傳輸例外同樣被分類（不會外漏例外）', async () => {
    const { client } = makeClient(() => new Error('fetch failed'));
    const out = await client.completeTask('T-1');
    assert.deepEqual(out, { ok: false, kind: 'transient', detail: 'fetch failed' });
  });

  it('讀取類傳輸例外 → 擲 McpError 並保留分類', async () => {
    const { client } = makeClient(() => new Error('403 forbidden'));
    await assert.rejects(() => client.getTask('T-1'), (e: unknown) => e instanceof McpError && e.kind === 'permanent');
  });
});

describe('PmmMcpClient — docRef 解析（loadDocs → read_doc 參數）', () => {
  async function argsFor(ref: string): Promise<Record<string, unknown>> {
    const { client, calls } = makeClient(() => text({ body: '內容' }));
    await client.loadDocs([ref]);
    return calls[0]?.arguments ?? {};
  }

  it('"spec/x.md#段落" → docType/fileName/section', async () => {
    assert.deepEqual(await argsFor('spec/mcp-test-sandbox.md#驗收標準'), {
      docType: 'spec',
      fileName: 'mcp-test-sandbox.md',
      section: '驗收標準',
    });
  });

  it('沒有 # → 不帶 section', async () => {
    assert.deepEqual(await argsFor('prd/product.md'), { docType: 'prd', fileName: 'product.md' });
  });

  it('# 後為空 → 視為沒有 section', async () => {
    assert.deepEqual(await argsFor('issue/bug-1.md#'), { docType: 'issue', fileName: 'bug-1.md' });
  });

  it('沒有目錄前綴 → docType 預設 spec', async () => {
    assert.deepEqual(await argsFor('x.md#s'), { docType: 'spec', fileName: 'x.md', section: 's' });
  });

  it('多層路徑 → 只有第一段是 docType，其餘都是 fileName', async () => {
    assert.deepEqual(await argsFor('spec/ui/button.md#狀態'), {
      docType: 'spec',
      fileName: 'ui/button.md',
      section: '狀態',
    });
  });

  it('loadDocs 回傳原始 ref 與內容，並保留順序', async () => {
    const { client } = makeClient((c) => text({ body: `內容-${String(c.arguments.fileName)}` }));
    const docs = await client.loadDocs(['spec/a.md#1', 'prd/b.md']);
    assert.deepEqual(docs, [
      { ref: 'spec/a.md#1', content: '內容-a.md' },
      { ref: 'prd/b.md', content: '內容-b.md' },
    ]);
  });

  /**
   * 讀不到的規格**不可以靜默略過**。先前失敗只留一行 warn，agent 連「有這份規格」
   * 都不知道就去做了——而它做出來的東西 build/test 都會過，看起來完全正常。
   *
   * 實跑撞到：任務的 docRef 是 issues/xxx.md，MCP 的 read_doc 只吃單數 issue，
   * 於是每一個帶 issue 規格的任務，agent 都是沒看過原始稽核報告就開始做的。
   */
  it('某段 read_doc 失敗 → 把失敗本身交給 agent，並指名要自己去找', async () => {
    const rec = createRecordingLogger();
    const { client } = makeClient(
      (c) => (c.arguments.fileName === 'bad.md' ? text({ ok: false, error: '找不到文件' }) : text({ body: 'ok' })),
      { log: rec.logger },
    );

    const docs = await client.loadDocs(['spec/bad.md', 'spec/good.md']);

    assert.equal(docs.length, 2, '失敗的那份也要在，不能消失');
    const bad = docs.find((d) => d.ref === 'spec/bad.md');
    assert.match(bad?.content ?? '', /讀不到/);
    assert.match(bad?.content ?? '', /search_docs/, '要指名用哪個工具找');
    assert.match(bad?.content ?? '', /不要當作它不存在/);
    assert.deepEqual(docs.find((d) => d.ref === 'spec/good.md'), { ref: 'spec/good.md', content: 'ok' });
    assert.ok(rec.messages('warn').some((m) => m.includes('read_doc 失敗')));
  });

  /**
   * MCP 自己的介面就對不上：list_docs 說文件在 issues/（複數），
   * read_doc 的 docType 只吃 issue（單數）。任務板給的 docRef 照抄過去必定失敗。
   */
  it('docType 單複數不一致由這裡兜掉（issues/ → issue）', async () => {
    const seen: Record<string, unknown>[] = [];
    const { client } = makeClient((c) => {
      seen.push(c.arguments);
      return text({ body: 'ok' });
    });

    await client.loadDocs(['issues/a.md', 'specs/b.md', 'prds/c.md', 'spec/d.md']);

    assert.deepEqual(seen.map((a) => a.docType), ['issue', 'spec', 'prd', 'spec']);
  });

  it('read_doc 回非 JSON 純文字 → 直接當成內容', async () => {
    const { client } = makeClient(() => text('# 標題\n內文'));
    assert.equal(await client.readDoc('spec', 'a.md'), '# 標題\n內文');
  });

  it('read_doc 回 JSON 但無 body → 空字串（不炸）', async () => {
    const { client } = makeClient(() => text({ meta: 1 }));
    assert.equal(await client.readDoc('spec', 'a.md'), '');
  });
});

describe('PmmMcpClient — 欄位映射', () => {
  const base = { id: 'T-1', title: '標題', status: 'todo', repo: 'acme/web', category: 'bug' };

  it('depIdList → dependencies、docRefsList → docRefs', async () => {
    const { client } = makeClient(() => text({ ...base, depIdList: ['T-0'], docRefsList: ['spec/a.md#1'] }));

    const t = await client.getTask('T-1');

    assert.deepEqual(t.dependencies, ['T-0']);
    assert.deepEqual(t.docRefs, ['spec/a.md#1']);
  });

  it('沒有 depIdList 時退回 dependencies；兩者皆無 → 空陣列', async () => {
    const withDeps = makeClient(() => text({ ...base, dependencies: ['T-9'] }));
    assert.deepEqual((await withDeps.client.getTask('T-1')).dependencies, ['T-9']);

    const none = makeClient(() => text(base));
    const t = await none.client.getTask('T-1');
    assert.deepEqual(t.dependencies, []);
    assert.deepEqual(t.docRefs, []);
  });

  it('description 缺席時退回 summary；都沒有 → 空字串', async () => {
    const s = makeClient(() => text({ ...base, summary: '這是摘要' }));
    assert.equal((await s.client.getTask('T-1')).description, '這是摘要');

    const d = makeClient(() => text({ ...base, description: '正式描述', summary: '摘要' }));
    assert.equal((await d.client.getTask('T-1')).description, '正式描述', 'description 優先於 summary');

    const n = makeClient(() => text(base));
    assert.equal((await n.client.getTask('T-1')).description, '');
  });

  it('assigneeId 為 null → undefined（不要把 null 灌進型別）', async () => {
    const { client } = makeClient(() => text({ ...base, assigneeId: null }));
    assert.equal((await client.getTask('T-1')).assigneeId, undefined);
  });

  it('list_tasks：讀 tasks 陣列並映射；缺欄位時回空陣列', async () => {
    const ok = makeClient(() => text({ tasks: [{ ...base, assigneeId: 'u1' }] }));
    const rows = await ok.client.listTasks({ repo: 'acme/web', mine: true, status: 'todo' });
    assert.deepEqual(rows, [{ id: 'T-1', title: '標題', status: 'todo', repo: 'acme/web', assigneeId: 'u1' }]);
    assert.deepEqual(ok.calls[0]?.arguments, { repo: 'acme/web', mine: true, status: 'todo' });

    const empty = makeClient(() => text({}));
    assert.deepEqual(await empty.client.listTasks(), []);
  });

  it('list_repos：讀 rows 陣列；空白 branch → undefined', async () => {
    const { client } = makeClient(() =>
      text({ rows: [{ repo: 'acme/web', owner: 'acme', name: 'web', branch: '' }, { repo: 'a/b', owner: 'a', name: 'b', branch: 'main' }] }),
    );

    const repos = await client.listRepos();

    assert.deepEqual(repos, [
      { repo: 'acme/web', owner: 'acme', name: 'web', branch: undefined },
      { repo: 'a/b', owner: 'a', name: 'b', branch: 'main' },
    ]);
  });
});

describe('PmmMcpClient — 回應外殼解析', () => {
  it('多個 text 區塊以換行串接後再解析', async () => {
    const { client } = makeClient(() => ({
      content: [
        { type: 'text', text: '{"id":"T-1","title":"t","status":"todo",' },
        { type: 'text', text: '"repo":"acme/web","category":"dev"}' },
      ],
    }));

    const t = await client.getTask('T-1');
    assert.equal(t.id, 'T-1');
  });

  it('非 text 區塊被忽略', async () => {
    const { client } = makeClient(() => ({
      content: [
        { type: 'image', data: 'xxx' },
        { type: 'text', text: JSON.stringify({ id: 'T-1', title: 't', status: 'todo', repo: 'r', category: 'dev' }) },
      ],
    }));

    assert.equal((await client.getTask('T-1')).id, 'T-1');
  });

  it('content 缺席 → 解析為空字串（不擲例外）', async () => {
    const { client } = makeClient(() => ({}));
    assert.equal(await client.readDoc('spec', 'a.md'), '');
  });
});

// ── 韌性（DESIGN §6）：退避重試只對 transient，三分類語意不可被污染 ──

const taskJson = { id: 'T-1', title: '做事', status: 'in_progress', repo: 'acme/web', category: 'dev' };

describe('PmmMcpClient — 退避重試', () => {
  it('transient 傳輸失敗 → 指數退避重試，最後成功', async () => {
    let n = 0;
    const { client, calls, sleeps } = makeClient(() => {
      n += 1;
      return n < 3 ? new Error('HTTP 503 Service Unavailable') : text(taskJson);
    });

    const out = await client.startTask('T-1');

    assert.equal(out.ok, true);
    assert.equal(calls.length, 3, '重試兩次後成功');
    assert.deepEqual(sleeps, [500, 1000], '延遲為 base × 2^n（jitter 取中點）');
  });

  it('permanent（401/403）→ 立即回傳，不重試', async () => {
    const { client, calls, sleeps } = makeClient(() => new Error('HTTP 401 Unauthorized'));

    const out = await client.startTask('T-1');

    assert.equal(out.ok === false ? out.kind : '', 'permanent');
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  });

  it('重試耗盡 → 維持 transient 分類與原始錯誤訊息', async () => {
    const { client, calls } = makeClient(() => new Error('socket hang up'), { resilience: { attempts: 3 } });

    const out = await client.completeTask('T-1');

    assert.deepEqual(out, { ok: false, kind: 'transient', detail: 'socket hang up' });
    assert.equal(calls.length, 3, '嘗試次數 = attempts');
  });

  it('讀取類也享有重試；重試耗盡才擲 McpError(transient)', async () => {
    let n = 0;
    const ok = makeClient(() => {
      n += 1;
      return n < 2 ? new Error('ETIMEDOUT') : text(taskJson);
    });
    assert.equal((await ok.client.getTask('T-1')).id, 'T-1');
    assert.equal(ok.calls.length, 2);

    const bad = makeClient(() => new Error('ETIMEDOUT'), { resilience: { attempts: 2 } });
    await assert.rejects(
      () => bad.client.getTask('T-1'),
      (e: unknown) => e instanceof McpError && e.kind === 'transient',
    );
    assert.equal(bad.calls.length, 2);
  });

  it('start_task 的帶內錯誤不重試也不計入熔斷（對方有回應，不是傳輸故障）', async () => {
    const { client, calls } = makeClient(() => text({ ok: false, error: '依賴 T-0 尚未完成' }), {
      resilience: { attempts: 4, breakerFailureThreshold: 2 },
    });

    for (let i = 0; i < 5; i++) {
      const out = await client.startTask('T-1');
      assert.deepEqual(out, { ok: false, kind: 'permanent', detail: '依賴 T-0 尚未完成' });
    }

    assert.equal(calls.length, 5, '每次只送一發，帶內錯誤不是暫時性故障');
    assert.equal(client.breakerSnapshot().state, 'closed', '對方有正常回應 → 熔斷器不該跳');
  });
});

describe('PmmMcpClient — 熔斷（暫停該來源）', () => {
  it('連續 transient 失敗達門檻 → 後續呼叫直接被擋，冷卻後試探成功即恢復', async () => {
    let clock = 0;
    let mode: 'fail' | 'ok' = 'fail';
    const { client, calls } = makeClient(() => (mode === 'fail' ? new Error('HTTP 502') : text(taskJson)), {
      resilience: { attempts: 1, breakerFailureThreshold: 2, breakerCooldownMs: 1_000, now: () => clock },
    });

    assert.equal((await client.startTask('T-1')).ok, false);
    assert.equal((await client.startTask('T-1')).ok, false);
    assert.equal(calls.length, 2);
    assert.equal(client.breakerSnapshot().state, 'open', '連續失敗 2 次 → 熔斷');

    const blocked = await client.startTask('T-1');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.ok === false ? blocked.kind : '', 'transient', '熔斷屬暫時性，稍後可再試');
    assert.match(blocked.ok === false ? blocked.detail : '', /熔斷器/);
    assert.equal(calls.length, 2, '熔斷期間不送出任何請求（避免整池狂打）');

    clock = 1_000; // 冷卻到期 → half_open 放行試探
    mode = 'ok';
    assert.equal((await client.startTask('T-1')).ok, true);
    assert.equal(calls.length, 3);
    assert.equal(client.breakerSnapshot().state, 'closed');
  });

  it('可注入共用熔斷器（同一來源多個 client 共用一個開關）', async () => {
    const shared = new CircuitBreaker('mcp:shared', { failureThreshold: 1, cooldownMs: 60_000 });
    const a = makeClient(() => new Error('HTTP 500'), { resilience: { attempts: 1, breaker: shared } });
    const b = makeClient(() => text(taskJson), { resilience: { attempts: 1, breaker: shared } });

    await a.client.startTask('T-1');

    const out = await b.client.startTask('T-2');
    assert.equal(out.ok, false, 'A 打掛了，B 也一起停手');
    assert.equal(b.calls.length, 0);
    assert.equal(b.client.breakerSnapshot().name, 'mcp:shared');
  });
});

describe('PmmMcpClient — 連線', () => {
  it('連不上（本機關閉的埠）→ 退避重試後擲 McpError(transient)，由呼叫端決定是否略過該專案', async () => {
    const sleeps: number[] = [];
    const client = new PmmMcpClient({ url: 'http://127.0.0.1:1/mcp', token: 'x' }, createSilentLogger(), {
      attempts: 2,
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0.5,
    });

    // undici 的連線失敗是 TypeError('fetch failed')，若沒先分類會被當成程式 bug 而不重試
    await assert.rejects(
      () => client.connect(),
      (e: unknown) => e instanceof McpError && e.kind === 'transient',
    );
    assert.equal(sleeps.length, 1, '重試一次後放棄');
  });
});

describe('mcpResilienceFromEnv', () => {
  it('未設定 → 全部走預設值', () => {
    const r = mcpResilienceFromEnv({});
    assert.equal(r.attempts, MCP_RESILIENCE_DEFAULTS.attempts);
    assert.equal(r.baseDelayMs, MCP_RESILIENCE_DEFAULTS.baseDelayMs);
    assert.equal(r.breakerFailureThreshold, MCP_RESILIENCE_DEFAULTS.breakerFailureThreshold);
    assert.equal(r.breakerCooldownMs, MCP_RESILIENCE_DEFAULTS.breakerCooldownMs);
  });

  it('有設定就採用；設錯（非數字/零/負數）視為沒設，不讓 daemon 開不起來', () => {
    assert.equal(mcpResilienceFromEnv({ ORCH_MCP_RETRY_ATTEMPTS: '7' }).attempts, 7);
    assert.equal(mcpResilienceFromEnv({ ORCH_MCP_BREAKER_COOLDOWN_MS: '5000' }).breakerCooldownMs, 5000);
    for (const bad of ['abc', '0', '-1', '']) {
      assert.equal(mcpResilienceFromEnv({ ORCH_MCP_RETRY_ATTEMPTS: bad }).attempts, MCP_RESILIENCE_DEFAULTS.attempts, bad);
    }
  });
});


// ── 時間戳解析（靜置期的輸入） ──

describe('toEpochMs — MCP 時間戳 → 毫秒', () => {
  it('ISO 字串（pmm 的實際格式）', () => {
    assert.equal(toEpochMs('2026-07-29T10:39:00.386Z'), Date.parse('2026-07-29T10:39:00.386Z'));
  });

  it('毫秒數字原樣回傳；秒數字自動 ×1000', () => {
    assert.equal(toEpochMs(1_800_000_000_000), 1_800_000_000_000);
    assert.equal(toEpochMs(1_800_000_000), 1_800_000_000_000);
  });

  /**
   * 解析不出來要回 undefined，**不能回 0**：0 會被靜置期讀成「1970 年就沒動作了」，
   * 一批剛建立的任務會被當成早就靜置直接開工——正好是這個功能要防的事。
   */
  it('無法解析的值一律 undefined（不可退化成 0）', () => {
    for (const v of [undefined, null, '', '  ', 'not-a-date', {}, [], NaN, 0, -1, false]) {
      assert.equal(toEpochMs(v), undefined, `${JSON.stringify(v)} 應為 undefined`);
    }
  });
});
