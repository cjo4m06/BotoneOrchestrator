import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { ConsoleServer } from '../src/console/server.js';
import type { ConsoleDeps } from '../src/console/server.js';
import { projectPurgerOf } from '../src/core/project-purge.js';
import { ConfigStore } from '../src/config/store.js';
import { Ledger } from '../src/store/ledger.js';
import { InboundRouter } from '../src/notify/notifier.js';
import { createTmpDir, createSilentLogger, createRecordingLogger, makeDiscoveredTask } from './helpers/index.js';

interface Harness {
  base: string;
  store: ConfigStore;
  ledger: Ledger;
  server: ConsoleServer;
  dir: ReturnType<typeof createTmpDir>;
  close(): Promise<void>;
}

async function start(opts: { router?: InboundRouter; purgeProject?: ConsoleDeps['purgeProject'] } = {}): Promise<Harness> {
  const dir = createTmpDir('botone-console-');
  const dbPath = join(dir.path, 'daemon.db');
  const store = new ConfigStore(dbPath);
  const ledger = new Ledger(dbPath, createSilentLogger());
  ledger.init();
  const server = new ConsoleServer({
    store, ledger, log: createSilentLogger(), port: 0, // 0 = 讓 OS 挑埠，測試才能平行跑
    // 預設接真的：控制台測試要走到實際那條路，不是走一個什麼都不做的替身
    purgeProject:
      opts.purgeProject
      ?? projectPurgerOf({ store, ledger, worktreeBase: join(dir.path, 'wt'), log: createSilentLogger() }),
    ...(opts.router ? { router: opts.router } : {}),
  });
  await server.start();
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    store, ledger, server, dir,
    async close() { await server.stop(); ledger.close(); store.close(); dir.cleanup(); },
  };
}

const json = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, unknown> });
const get = async (h: Harness, p: string) => json(await fetch(h.base + p));
const send = async (h: Harness, method: string, p: string, body?: unknown) =>
  json(await fetch(h.base + p, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));

const project = (over: Record<string, unknown> = {}) => ({
  id: 'p1', repo: 'acme/web', repoPath: '/tmp/r',
  mcp: { transport: 'http', url: 'https://x.test', token: 'tok' },
  commands: { build: 'npm run build' },
  ...over,
});

describe('控制台 — 綁定位址', () => {
  /** 位址檢查只碰建構子，走不到專案清理——真的被呼叫代表測試寫錯了。 */
  const purgeProject: ConsoleDeps['purgeProject'] = () =>
    Promise.reject(new Error('測試不該走到這裡：綁定位址測試不該觸發專案清理'));

  /**
   * 這個介面可以改 MCP token、停用專案、核准合併。綁到外部位址是安全事故，
   * 不是設定選項——所以在建構時就擋，而不是「預設值剛好是 loopback」。
   */
  it('非 loopback 位址一律拒絕', () => {
    const deps = { store: {} as ConfigStore, ledger: {} as Ledger, log: createSilentLogger(), purgeProject };
    for (const host of ['0.0.0.0', '192.168.1.5', '::']) {
      assert.throws(() => new ConsoleServer({ ...deps, host }), /loopback/);
    }
  });

  it('loopback 的三種寫法都接受', () => {
    const deps = { store: {} as ConfigStore, ledger: {} as Ledger, log: createSilentLogger(), purgeProject };
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      assert.doesNotThrow(() => new ConsoleServer({ ...deps, host }));
    }
  });
});

describe('控制台 API', () => {
  let h: Harness;
  beforeEach(async () => { h = await start(); });
  afterEach(async () => { await h.close(); });

  it('/api/state 回得出空系統的樣子（不是錯誤）', async () => {
    const { status, body } = await get(h, '/api/state');
    assert.equal(status, 200);
    assert.deepEqual(body.projects, []);
    assert.deepEqual(body.pending, []);
    assert.equal((body.taskCounts as Record<string, number>).done, 0);
    assert.equal(body.canDecide, false, '沒注入 router 就是唯讀');
  });

  it('設定：讀出預設 → 寫入 → 讀回', async () => {
    assert.equal(((await get(h, '/api/settings')).body.effective as { pollIntervalSec: number }).pollIntervalSec, 30);
    await send(h, 'PUT', '/api/settings', { pollIntervalSec: 7 });
    assert.equal(((await get(h, '/api/settings')).body.effective as { pollIntervalSec: number }).pollIntervalSec, 7);
  });

  /** 存進去才發現不合法的話，下次啟動會死在讀取，而使用者沒有工具改得回來。 */
  it('設定不合法 → 400 且不寫入', async () => {
    await send(h, 'PUT', '/api/settings', { pollIntervalSec: 9 });
    const bad = await send(h, 'PUT', '/api/settings', { pollIntervalSec: '很快' });
    assert.equal(bad.status, 400);
    assert.ok(typeof bad.body.error === 'string');
    assert.equal(((await get(h, '/api/settings')).body.effective as { pollIntervalSec: number }).pollIntervalSec, 9);
  });

  it('專案：新增（預設停用）→ 列出 → 啟用 → 停用 → 刪除', async () => {
    assert.equal((await send(h, 'PUT', '/api/projects', project())).status, 200);

    const list = await get(h, '/api/projects');
    const rows = list.body.projects as { enabled: boolean; effective: { id: string } }[];
    assert.deepEqual(rows.map((r) => r.effective.id), ['p1']);
    // 新專案預設停用：控制台列得出來，但 daemon 不會撿它去做事，
    // 讓使用者有機會先檢查驗收指令等設定（實跑撞過：一存好就開始做 13 個任務）
    assert.equal(rows[0]?.enabled, false);

    await send(h, 'POST', '/api/projects/p1/enabled', { enabled: true });
    assert.equal(((await get(h, '/api/projects')).body.projects as { enabled: boolean }[])[0]?.enabled, true);

    await send(h, 'POST', '/api/projects/p1/enabled', { enabled: false });
    assert.equal(((await get(h, '/api/projects')).body.projects as { enabled: boolean }[])[0]?.enabled, false);

    assert.equal((await send(h, 'DELETE', '/api/projects/p1')).status, 200);
    assert.deepEqual((await get(h, '/api/projects')).body.projects, []);
  });

  /**
   * 停用＝清乾淨。實跑撞到的災情：停用只改了旗標，ledger 裡 18 張 discovered 還在，
   * 於是每一輪 tick 都想規劃它們、每一輪都因為查不到專案擲錯，
   * 連帶讓後面的輪詢、審查監看、合併佇列全部跳過——一個停用的專案讓整個 daemon 空轉。
   */
  it('停用專案 → 該專案的任務與群組一起清掉', async () => {
    await send(h, 'PUT', '/api/projects', project());
    await send(h, 'POST', '/api/projects/p1/enabled', { enabled: true });
    h.ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-1', repo: 'acme/web' }));
    h.ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-2', repo: 'acme/web' }));
    h.ledger.createGroup({ repo: 'acme/web', branch: 'auto/g-1', taskIds: ['T-1'], footprint: [] });

    const res = await send(h, 'POST', '/api/projects/p1/enabled', { enabled: false });

    assert.equal(res.status, 200);
    assert.deepEqual(h.ledger.listTasksByState('discovered'), [], '停用後 daemon 不該再看到這些任務');
    assert.deepEqual(h.ledger.listGroupsByState('ready'), []);
    const purged = res.body.purged as { tasks: number; groups: number; claimed: unknown[] };
    assert.equal(purged.tasks, 2, '要回報清了什麼，人才知道發生過什麼事');
    assert.equal(purged.groups, 1);
    assert.deepEqual(purged.claimed, [], '沒認領過的任務不該被列成待處理');
  });

  it('啟用專案不會清東西', async () => {
    await send(h, 'PUT', '/api/projects', project());
    h.ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-1', repo: 'acme/web' }));

    const res = await send(h, 'POST', '/api/projects/p1/enabled', { enabled: true });

    assert.equal(res.body.purged, undefined);
    assert.equal(h.ledger.getTask('T-1')?.id, 'T-1');
  });

  /** 清理失敗不該讓停用失敗——旗標已經關了，那才是重點；卡在「還是啟用中」更糟。 */
  it('清理擲錯時，專案仍然停用', async () => {
    const broken = await start({ purgeProject: () => Promise.reject(new Error('磁碟壞了')) });
    try {
      await send(broken, 'PUT', '/api/projects', project());
      await send(broken, 'POST', '/api/projects/p1/enabled', { enabled: true });
      const res = await send(broken, 'POST', '/api/projects/p1/enabled', { enabled: false });
      assert.equal(res.status, 200);
      const rows = (await get(broken, '/api/projects')).body.projects as { enabled: boolean }[];
      assert.equal(rows[0]?.enabled, false);
    } finally {
      await broken.close();
    }
  });

  it('刪除不存在的專案 → 404（而不是假裝成功）', async () => {
    assert.equal((await send(h, 'DELETE', '/api/projects/nope')).status, 404);
    assert.equal((await send(h, 'POST', '/api/projects/nope/enabled', { enabled: true })).status, 404);
  });

  it('專案缺必填欄位 → 400', async () => {
    const r = await send(h, 'PUT', '/api/projects', { id: 'bad' });
    assert.equal(r.status, 400);
    assert.deepEqual((await get(h, '/api/projects')).body.projects, []);
  });

  /** 編輯畫面要顯示使用者當初填的東西，不是展開後的密鑰。 */
  it('raw 保留 ${VAR} 字面值，effective 是展開後的', async () => {
    process.env.CONSOLE_TEST_TOKEN = 'real-token';
    try {
      await send(h, 'PUT', '/api/projects', project({ mcp: { transport: 'http', url: 'https://x.test', token: '${CONSOLE_TEST_TOKEN}' } }));
      const rows = (await get(h, '/api/projects')).body.projects as { raw: { mcp: { token: string } }; effective: { mcp: { token: string } } }[];
      assert.equal(rows[0]?.raw.mcp.token, '${CONSOLE_TEST_TOKEN}');
      assert.equal(rows[0]?.effective.mcp.token, 'real-token');
    } finally { delete process.env.CONSOLE_TEST_TOKEN; }
  });

  it('/api/fs 只列目錄，並標出哪些是 git repo', async () => {
    const { body } = await get(h, '/api/fs?path=' + encodeURIComponent(process.cwd()));
    const entries = body.entries as { name: string; isRepo: boolean }[];
    assert.ok(entries.some((e) => e.name === 'src'));
    assert.equal(entries.some((e) => e.name.startsWith('.')), false, '隱藏目錄不列');
    assert.equal(body.isRepo, true, '專案本身是 git repo');
    assert.ok(body.parent);
  });

  it('/api/fs 對不存在的路徑回錯誤訊息而不是 500', async () => {
    const { status, body } = await get(h, '/api/fs?path=/絕對不存在的路徑');
    assert.equal(status, 200);
    assert.ok(body.error, '要把原因講出來，本機工具看得到真正的錯誤才修得動');
    assert.deepEqual(body.entries, []);
  });

  it('/api/branches 需要 repoPath', async () => {
    assert.equal((await get(h, '/api/branches')).status, 400);
  });

  it('/api/branches 讀得出本專案的分支', async () => {
    const { body } = await get(h, '/api/branches?repoPath=' + encodeURIComponent(process.cwd()));
    assert.ok(Array.isArray(body.local));
    assert.ok((body.local as string[]).length > 0);
  });

  it('未知路徑回 404，不是 500', async () => {
    assert.equal((await get(h, '/api/不存在')).status, 404);
    assert.equal((await fetch(h.base + '/隨便')).status, 404);
  });

  it('首頁與 favicon 都回得出來（favicon 404 會淹沒真正的錯誤）', async () => {
    const page = await fetch(h.base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.equal((await fetch(h.base + '/favicon.ico')).status, 200);
  });

  it('沒有 router 時裁決被拒絕（唯讀模式不能假裝成功）', async () => {
    const { body } = await send(h, 'POST', '/api/decide', { action: 'retry', id: 'T-1' });
    assert.equal(body.ok, false);
    assert.match(String(body.error), /沒有接上裁決路徑/);
  });
});

describe('控制台 — 人的裁決走 InboundRouter（不是第二套邏輯）', () => {
  let h: Harness;
  const seen: { kind: string; id: string; extra?: string }[] = [];

  beforeEach(async () => {
    seen.length = 0;
    const dir = createTmpDir('botone-console-r-');
    const dbPath = join(dir.path, 'daemon.db');
    const store = new ConfigStore(dbPath);
    const ledger = new Ledger(dbPath, createSilentLogger());
    ledger.init();
    ledger.upsertDiscoveredTask({
      id: 'T-1', payloadHash: 'h', repo: 'a/b', category: 'dev',
      title: '任務', description: 'd', dependencies: [], docRefs: [],
    });
    ledger.setBlock('T-1', 'needs_clarification', '要用哪個 API？');

    const router = new InboundRouter({ ledger, log: createSilentLogger() });
    const server = new ConsoleServer({
      store, ledger, log: createSilentLogger(), port: 0, router, inProcess: true,
      // 接真的（與 start() 一致）：這批測試不走停用，但假件會讓「停用只改旗標」的漏接躲過型別檢查
      purgeProject: projectPurgerOf({ store, ledger, worktreeBase: join(dir.path, 'wt'), log: createSilentLogger() }),
    });
    await server.start();
    h = {
      base: `http://127.0.0.1:${server.address().port}`, store, ledger, server, dir,
      async close() { await server.stop(); ledger.close(); store.close(); dir.cleanup(); },
    };
  });
  afterEach(async () => { await h.close(); });

  it('有 router 時 state 回報可裁決', async () => {
    assert.equal((await get(h, '/api/state')).body.canDecide, true);
  });

  it('回答澄清 → 任務解除封鎖回到 queued，答覆留在事件裡', async () => {
    const r = await send(h, 'POST', '/api/decide', { action: 'answer', id: 'T-1', text: '用 REST' });
    assert.equal(r.body.ok, true);
    assert.equal(h.ledger.getTask('T-1')?.state, 'queued');
    assert.match(h.ledger.latestEvent('task', 'T-1', 'clarification_answer')?.detail ?? '', /用 REST/);
  });

  it('缺 id → 明確拒絕', async () => {
    assert.equal((await send(h, 'POST', '/api/decide', { action: 'retry' })).body.ok, false);
  });

  it('未知動作 → 明確拒絕（不要靜靜什麼都不做）', async () => {
    const { body } = await send(h, 'POST', '/api/decide', { action: '亂寫', id: 'T-1' });
    assert.equal(body.ok, false);
    assert.match(String(body.error), /未知的動作/);
  });

  it('待處理清單看得到這個任務', async () => {
    const pending = (await get(h, '/api/state')).body.pending as { id: string; kind: string }[];
    assert.deepEqual(pending.map((p) => p.kind), ['clarification']);
    assert.equal(pending[0]?.id, 'T-1');
  });

  it('/api/events 有上限，不會把整張稽核表讀進記憶體', async () => {
    for (let i = 0; i < 20; i += 1) h.ledger.logEvent('system', null, 'noise', String(i));
    const { body } = await get(h, '/api/events?limit=5');
    assert.equal((body.events as unknown[]).length, 5);
    const capped = await get(h, '/api/events?limit=99999');
    assert.ok((capped.body.events as unknown[]).length <= 500);
  });
});


describe('控制台 — 跨站請求', () => {
  /**
   * 「只綁 loopback 所以連得到的就是坐在機器前面的人」——這個假設對**瀏覽器**不成立。
   *
   * 使用者瀏覽任何一個惡意網頁，那個網頁就能對 127.0.0.1:8787 發請求，
   * 而這個介面可以改 MCP token、核准合併、停用專案（會連 worktree 與分支一起清掉）。
   *
   * `text/plain` 是 CORS 的「簡單」型別，不觸發 preflight，所以瀏覽器會直接送出去。
   * 改這段之前實測是成功的。
   */
  let h: Harness;
  before(async () => { h = await start(); });
  after(async () => { await h.close(); });

  const raw = (method: string, path: string, headers: Record<string, string>, body?: string) =>
    fetch(h.base + path, { method, headers, ...(body ? { body } : {}) });

  it('帶外部 Origin 的寫入請求 → 403', async () => {
    const res = await raw('PUT', '/api/projects',
      { 'content-type': 'application/json', origin: 'https://evil.example' },
      JSON.stringify(project()));
    assert.equal(res.status, 403);
    assert.equal(((await get(h, '/api/projects')).body.projects as unknown[]).length, 0, '不可以寫進去');
  });

  /** 這是最關鍵的一條：text/plain 不觸發預檢，是真正可用的攻擊路徑。 */
  it('text/plain 的寫入請求 → 403（就算沒有 Origin）', async () => {
    const res = await raw('PUT', '/api/projects', { 'content-type': 'text/plain' }, JSON.stringify(project()));
    assert.equal(res.status, 403);
    assert.match((await res.json() as { error: string }).error, /application\/json/);
    assert.equal(((await get(h, '/api/projects')).body.projects as unknown[]).length, 0);
  });

  it('沒有 content-type 的寫入請求 → 403', async () => {
    const res = await raw('POST', '/api/projects/x/enabled', {}, '{"enabled":false}');
    assert.equal(res.status, 403);
  });

  it('讀取不受影響（GET 沒有副作用）', async () => {
    assert.equal((await raw('GET', '/api/state', {})).status, 200);
  });

  it('自己的頁面照常運作（同源 Origin ＋ json）', async () => {
    const { port } = h.server.address();
    const res = await raw('PUT', '/api/projects',
      { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      JSON.stringify(project()));
    assert.equal(res.status, 200, '不能把正常使用擋掉');
  });
});
