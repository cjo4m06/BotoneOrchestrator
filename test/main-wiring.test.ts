import { test, describe, it, beforeEach, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { hasClaudeAuth } from '../src/worker/reviewer.js';
import {
  InstanceLockedError,
  acquireInstanceLock,
  aggregateMcp,
  applyGithubToken,
  createGithubTokenApplier,
  bootReconcileMode,
  buildPipeline,
  createMcpClient,
  createMergePipeline,
  createShutdown,
  applyClaudeAuth,
  ensureMergeWorkspace,
  externalActionFlags,
  hasRemote,
  isHolderAlive,
  mcpTransportFactory,
  pollMineOf,
  pollSourceOf,
  projectRuntimeOf,
  readLockFile,
  reconcileOnBoot,
  resolveBaseBranch,
  resolveFlag,
  reconcilerDepsOf,
  scheduleForceExit,
  verifierConfigOf,
  verifierDepsOf,
  waitForInFlight,
  type GitRun,
  type MergeProjectSpec,
} from '../src/main.js';
import { PmmMcpClient } from '../src/mcp/mcp-client.js';
import { ProjectRegistry, type ProjectLookup } from '../src/core/project-registry.js';

/** 空的專案查詢：這批測試只驗接線，不需要真的專案。 */
const emptyLookup = (): ProjectLookup => ({ runtimeOf: () => undefined, repoPaths: () => [] });
/** buildPipeline 需要真的 registry；工廠不會被呼叫（沒有專案可同步）。 */
const emptyRegistry = (): ProjectRegistry => new ProjectRegistry(async () => undefined, createSilentLogger());
import { loadConfig, type AppConfig, type ProjectConfig } from '../src/config/index.js';
import type { MergePipelineDeps } from '../src/core/orchestrator.js';
import type { ProjectRuntime } from '../src/core/group-runner.js';
import type { CommandResult, CommandRunner } from '../src/pr/pr-manager.js';
import type { HumanGateway, MergeDecision } from '../src/slack/gateway.js';
import type { MergeApprovalInput } from '../src/slack/blocks.js';
import type { TaskBrief } from '../src/types.js';
import { createTmpDir, createTmpLedger, createRecordingLogger, createSilentLogger, makeDiscoveredTask } from './helpers/index.js';

/** 最小可用的專案設定（對映 ProjectSchema 的輸出型別）。 */
function proj(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'web',
    repo: 'acme/web',
    repoPath: '/tmp/web',
    mcp: { transport: 'stdio', command: 'node' },
    commands: {},
    ...over,
  };
}

// ── DoD：typecheck 關卡必須從設定接到 Verifier ──

test('verifierConfigOf 會映射 commands.typecheck（否則 DoD 第一關在生產路徑永遠不執行）', () => {
  const cfg = verifierConfigOf(
    proj({ commands: { typecheck: 'npm run typecheck', build: 'npm run build', test: 'npm test', lint: 'npm run lint' } }),
  );
  assert.equal(cfg.typecheck, 'npm run typecheck');
  assert.equal(cfg.build, 'npm run build');
  assert.equal(cfg.test, 'npm test');
  assert.equal(cfg.lint, 'npm run lint');
});

test('未設 commands.typecheck 時該關卡為 undefined（整段跳過，而非假綠燈）', () => {
  assert.equal(verifierConfigOf(proj()).typecheck, undefined);
});

// ── Poller 的 mine 過濾 ──

test('pollMineOf 預設 true（撿到別人的任務會因認領不到而卡死整群）', () => {
  assert.equal(pollMineOf({ poll: { mine: true } }, proj()), true);
});

test('pollMineOf：專案層可覆寫全域設定', () => {
  assert.equal(pollMineOf({ poll: { mine: true } }, proj({ pollMine: false })), false);
  assert.equal(pollMineOf({ poll: { mine: false } }, proj({ pollMine: true })), true);
  assert.equal(pollMineOf({ poll: { mine: false } }, proj()), false);
});

test('pollSourceOf：實際交給 Poller 的來源一定帶 mine（否則會撿到別人的任務）', () => {
  const client = { listTasks: async () => [], getTask: async () => ({}) } as never;
  const src = pollSourceOf({ poll: { mine: true } }, proj(), client);
  assert.equal(src.repo, 'acme/web');
  assert.equal(src.mine, true);
  assert.equal(pollSourceOf({ poll: { mine: true } }, proj({ pollMine: false }), client).mine, false);
});

// ── 專案執行期資料（base 分支不再硬寫 main） ──

const fakeMcp = {
  startTask: async () => ({ ok: false, kind: 'signal', detail: 'fake' }),
  completeTask: async () => ({ ok: false, kind: 'permanent', detail: 'fake' }),
  loadDocs: async () => [],
} as never;

test('projectRuntimeOf：base 分支由偵測結果決定，並帶上 typecheck 關卡', async () => {
  const g = fakeGit({ 'symbolic-ref': 'origin/develop' });
  const rt = await projectRuntimeOf(proj({ commands: { typecheck: 'tsc --noEmit' } }), { mcp: fakeMcp, git: g.run });
  assert.equal(rt.baseBranch, 'develop', '硬寫 main 會讓預設分支不是 main 的專案永遠建不出 worktree');
  assert.equal(rt.verifierConfig.typecheck, 'tsc --noEmit');
  assert.equal(rt.repoPath, '/tmp/web');
});

test('projectRuntimeOf：明寫的 baseBranch 優先於偵測', async () => {
  const g = fakeGit({ 'symbolic-ref': 'origin/main' });
  const rt = await projectRuntimeOf(proj({ baseBranch: 'release' }), { mcp: fakeMcp, git: g.run });
  assert.equal(rt.baseBranch, 'release');
});

// ── 設定驅動的開關 + 環境變數覆寫 ──

/**
 * 只剩一個開關：系統可不可以自己合併。
 * 「不開 PR」那個開關移除了——沒有 PR 就沒有審查，那條路本來就走不完；
 * 要用複本測試就把專案的 repo 與 repoPath 都指向複本。
 */
test('externalActionFlags：預設關；設定打開就會生效（不再只認環境變數）', () => {
  assert.deepEqual(externalActionFlags({ allowLocalMerge: false }, {}), { allowLocalMerge: false }, '安全預設：不自動合併');
  assert.deepEqual(
    externalActionFlags({ allowLocalMerge: true }, {}),
    { allowLocalMerge: true },
    'launchd plist 沒有環境變數也要能自動合併',
  );
  assert.deepEqual(
    externalActionFlags({ allowLocalMerge: true }, { ORCH_LOCAL_MERGE: '0' }),
    { allowLocalMerge: false },
    '環境變數可臨時關掉',
  );
  assert.deepEqual(externalActionFlags({ allowLocalMerge: false }, { ORCH_LOCAL_MERGE: '1' }), { allowLocalMerge: true });
});

test('resolveFlag：沒有環境變數時以設定檔為準', () => {
  assert.equal(resolveFlag({}, 'ORCH_LOCAL_MERGE', true), true);
  assert.equal(resolveFlag({}, 'ORCH_LOCAL_MERGE', false), false);
  assert.equal(resolveFlag({ ORCH_LOCAL_MERGE: '' }, 'ORCH_LOCAL_MERGE', true), true, '空字串視為未設');
});

test('resolveFlag：環境變數可雙向覆寫設定檔', () => {
  assert.equal(resolveFlag({ ORCH_LOCAL_MERGE: '1' }, 'ORCH_LOCAL_MERGE', false), true);
  assert.equal(resolveFlag({ ORCH_LOCAL_MERGE: 'true' }, 'ORCH_LOCAL_MERGE', false), true);
  assert.equal(resolveFlag({ ORCH_LOCAL_MERGE: '0' }, 'ORCH_LOCAL_MERGE', true), false);
  assert.equal(resolveFlag({ ORCH_LOCAL_MERGE: 'off' }, 'ORCH_LOCAL_MERGE', true), false);
});

test('resolveFlag：看不懂的值不猜方向，退回設定值並警告', () => {
  const rec = createRecordingLogger();
  assert.equal(resolveFlag({ ORCH_LOCAL_MERGE: '也許吧' }, 'ORCH_LOCAL_MERGE', false, rec.logger), false);
  assert.ok(rec.messages('warn').some((m) => m.includes('布林環境變數')));
});

// ── github.token 接線 ──

test('applyGithubToken：設定有 token 且環境沒有 → 灌進 GH_TOKEN/GITHUB_TOKEN 供 gh 使用', () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(applyGithubToken('ghp_x', env), 'set');
  assert.equal(env.GH_TOKEN, 'ghp_x');
  assert.equal(env.GITHUB_TOKEN, 'ghp_x');
});

test('applyGithubToken：環境已有 token 時不覆蓋（外部注入優先）', () => {
  const env: NodeJS.ProcessEnv = { GH_TOKEN: 'from-launchd' };
  assert.equal(applyGithubToken('ghp_x', env), 'kept');
  assert.equal(env.GH_TOKEN, 'from-launchd');
  assert.equal(env.GITHUB_TOKEN, undefined);
});

test('applyGithubToken：沒設定就什麼都不做（不會寫入空 token 讓 gh 誤以為已登入）', () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(applyGithubToken(undefined, env), 'absent');
  assert.equal(applyGithubToken('   ', env), 'absent');
  assert.equal('GH_TOKEN' in env, false);
});

// ── base 分支偵測 ──

/** 假 git：依 args 前綴回覆，未命中一律非零（等同「查不到」）。 */
function fakeGit(routes: Record<string, string>): { run: GitRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: GitRun = async (_repoPath, args) => {
    calls.push(args);
    const key = args.join(' ');
    const hit = Object.entries(routes).find(([k]) => key.startsWith(k));
    return hit ? { exitCode: 0, stdout: hit[1] } : { exitCode: 1, stdout: '' };
  };
  return { run, calls };
}

test('resolveBaseBranch：projects.yaml 明寫時直接採用，不去問 git', async () => {
  const g = fakeGit({});
  assert.equal(await resolveBaseBranch({ repoPath: '/tmp/x', baseBranch: 'develop' }, { git: g.run }), 'develop');
  assert.equal(g.calls.length, 0);
});

test('resolveBaseBranch：未設時由 origin/HEAD 偵測（預設分支不是 main 的專案不再建不出 worktree）', async () => {
  const g = fakeGit({ 'symbolic-ref': 'origin/master' });
  assert.equal(await resolveBaseBranch({ repoPath: '/tmp/x' }, { git: g.run }), 'master');
});

test('resolveBaseBranch：origin/HEAD 指向含斜線的分支名也要完整保留', async () => {
  const g = fakeGit({ 'symbolic-ref': 'origin/release/2026' });
  assert.equal(await resolveBaseBranch({ repoPath: '/tmp/x' }, { git: g.run }), 'release/2026');
});

test('resolveBaseBranch：沒有 origin/HEAD 時退回本地 main / master', async () => {
  const onlyMaster = fakeGit({ 'show-ref --verify --quiet refs/heads/master': '' });
  assert.equal(await resolveBaseBranch({ repoPath: '/tmp/x' }, { git: onlyMaster.run }), 'master');

  const both = fakeGit({ 'show-ref --verify --quiet refs/heads/main': '', 'show-ref --verify --quiet refs/heads/master': '' });
  assert.equal(await resolveBaseBranch({ repoPath: '/tmp/x' }, { git: both.run }), 'main', 'main 優先');
});

test('resolveBaseBranch：都查不到時用目前分支；連分支都沒有才退回 main 並警告', async () => {
  const cur = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'trunk' });
  assert.equal(await resolveBaseBranch({ repoPath: '/tmp/x' }, { git: cur.run }), 'trunk');

  const rec = createRecordingLogger();
  const nothing = fakeGit({});
  assert.equal(await resolveBaseBranch({ repoPath: '/tmp/x' }, { git: nothing.run, log: rec.logger }), 'main');
  assert.ok(rec.messages('warn').some((m) => m.includes('無法偵測 base 分支')));
});

test('resolveBaseBranch：detached HEAD（rev-parse 回 "HEAD"）不可當成分支名', async () => {
  const g = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'HEAD' });
  assert.equal(await resolveBaseBranch({ repoPath: '/tmp/x' }, { git: g.run }), 'main');
});

// ── MCP transport：stdio 必須真的被支援 ──

test('mcpTransportFactory：stdio 專案會拿到 StdioClientTransport 工廠（不再被靜默略過）', () => {
  const factory = mcpTransportFactory(proj({ mcp: { transport: 'stdio', command: 'node', args: ['/srv/mcp.js'] } }));
  assert.ok(factory, 'stdio 必須有 transport 工廠');
  assert.ok(factory() instanceof StdioClientTransport);
  // 工廠每次都要給新的一條：transport 用過即棄，連線重試不能重用
  assert.notEqual(factory(), factory());
});

test('mcpTransportFactory：http 回 undefined（沿用內建 Streamable HTTP）', () => {
  assert.equal(mcpTransportFactory(proj({ mcp: { transport: 'http', url: 'https://example.test/mcp' } })), undefined);
});

test('createMcpClient：stdio 與 http 都建得出 client；http 缺 url 則略過該專案', () => {
  const log = createSilentLogger();
  assert.ok(createMcpClient(proj(), log) instanceof PmmMcpClient, 'stdio 專案必須建得出 client');
  assert.ok(createMcpClient(proj({ mcp: { transport: 'http', url: 'https://example.test/mcp' } }), log) instanceof PmmMcpClient);
  assert.equal(createMcpClient(proj({ mcp: { transport: 'http' } }), log), undefined);
  assert.equal(createMcpClient(proj({ mcp: { transport: 'stdio' } }), log), undefined);
});

// ── 單一實例鎖 ──

test('acquireInstanceLock：取得鎖會寫入 pid 與行程啟動時間，release 後檔案消失', (t) => {
  const dir = createTmpDir('botone-lock-');
  t.after(() => dir.cleanup());
  const path = dir.join('data/orchestrator.lock');

  const lock = acquireInstanceLock({ path, pid: 4242, startedAtMs: 1_700_000_000_000, isAlive: () => false });
  const written = readLockFile(path);
  assert.equal(written?.pid, 4242);
  assert.equal(written?.startedAtMs, 1_700_000_000_000, '沒有啟動時間就無法分辨「pid 被回收給別的程序」');
  assert.equal(lock.previousUnclean, undefined);
  lock.release();
  assert.equal(existsSync(path), false);
});

test('acquireInstanceLock：持有者還活著 → 拒絕啟動（第二個 daemon 會對帳掉第一個的 worktree）', (t) => {
  const dir = createTmpDir('botone-lock-');
  t.after(() => dir.cleanup());
  const path = dir.join('orchestrator.lock');

  acquireInstanceLock({ path, pid: 111, isAlive: () => false });
  assert.throws(
    () => acquireInstanceLock({ path, pid: 222, isAlive: (pid) => pid === 111 }),
    (e: unknown) => e instanceof InstanceLockedError && e.holderPid === 111,
  );
  assert.equal(readLockFile(path)?.pid, 111, '拒絕時不可動到既有鎖');
});

test('acquireInstanceLock：殘留鎖（持有者已死或內容損毀）會被接管，不讓 daemon 從此起不來', (t) => {
  const dir = createTmpDir('botone-lock-');
  t.after(() => dir.cleanup());
  const path = dir.join('orchestrator.lock');
  const rec = createRecordingLogger();

  writeFileSync(path, '999\n'); // 舊格式（純 pid 文字）也要讀得懂
  acquireInstanceLock({ path, pid: 222, isAlive: () => false, log: rec.logger });
  assert.equal(readLockFile(path)?.pid, 222);
  assert.ok(rec.messages('warn').some((m) => m.includes('殘留')));

  writeFileSync(path, '不是 pid');
  acquireInstanceLock({ path, pid: 333, isAlive: () => true });
  assert.equal(readLockFile(path)?.pid, 333);
});

test('acquireInstanceLock：release 不會刪掉別人接管後的鎖', (t) => {
  const dir = createTmpDir('botone-lock-');
  t.after(() => dir.cleanup());
  const path = dir.join('orchestrator.lock');

  const mine = acquireInstanceLock({ path, pid: 111, isAlive: () => false });
  writeFileSync(path, '999\n'); // 模擬別的實例接管
  mine.release();
  assert.equal(readLockFile(path)?.pid, 999);
});

// ── pid 回收：只有握有正面證據時才敢說「殘留鎖」 ──

test('isHolderAlive：pid 存在且啟動時間對得上 → 活著（不可接管）', () => {
  const alive = isHolderAlive(
    { pid: 111, startedAtMs: 1_700_000_000_000 },
    { isAlive: () => true, processStartMs: () => 1_700_000_001_000 }, // 秒級誤差在容忍內
  );
  assert.equal(alive, true);
});

test('isHolderAlive：pid 存在但啟動時間差很多 → pid 已被回收給別的程序（可接管）', () => {
  const rec = createRecordingLogger();
  const alive = isHolderAlive(
    { pid: 111, startedAtMs: 1_700_000_000_000 },
    { isAlive: () => true, processStartMs: () => 1_700_000_600_000, log: rec.logger },
  );
  assert.equal(alive, false, '沒有啟動時間比對時，pid 回收會讓 daemon 從此起不來');
  assert.ok(rec.messages('warn').some((m) => m.includes('pid 目前屬於另一個行程')));
});

test('isHolderAlive：問不到啟動時間 / 舊格式鎖檔 → 保守視為活著（誤殺的代價是刪掉別人的 worktree）', () => {
  assert.equal(isHolderAlive({ pid: 111, startedAtMs: 1 }, { isAlive: () => true, processStartMs: () => undefined }), true);
  assert.equal(isHolderAlive({ pid: 111 }, { isAlive: () => true, processStartMs: () => 999 }), true);
  assert.equal(isHolderAlive({ pid: 111, startedAtMs: 1 }, { isAlive: () => false, processStartMs: () => 1 }), false, '行程真的不在就是不在');
});

test('acquireInstanceLock：pid 被回收（啟動時間對不上）時可接管，不會讓 daemon 永遠起不來', (t) => {
  const dir = createTmpDir('botone-lock-');
  t.after(() => dir.cleanup());
  const path = dir.join('orchestrator.lock');

  acquireInstanceLock({ path, pid: 111, startedAtMs: 1_000_000, isAlive: () => false });
  // pid 111 現在活著，但它是「另一個」行程（啟動時間完全不同）
  const took = acquireInstanceLock({ path, pid: 222, startedAtMs: 9_000_000, isAlive: () => true, processStartMs: () => 8_888_888 });
  assert.equal(took.pid, 222);
  assert.equal(readLockFile(path)?.pid, 222);
});

// ── 「上次沒收乾淨」標記：保住鎖 + 讓下一個實例保守 ──

test('markUnclean：鎖檔保留並帶上標記（釋放鎖 = 下一個實例會 force-remove 還在跑的 worktree）', (t) => {
  const dir = createTmpDir('botone-lock-');
  t.after(() => dir.cleanup());
  const path = dir.join('orchestrator.lock');

  const lock = acquireInstanceLock({ path, pid: 111, startedAtMs: 5, isAlive: () => false, now: () => 1_700_000_000_000 });
  lock.markUnclean({ remaining: 2, detail: '收尾逾時' });

  assert.equal(existsSync(path), true, '鎖檔必須留著');
  const content = readLockFile(path);
  assert.equal(content?.pid, 111);
  assert.equal(content?.startedAtMs, 5, '標記後仍要能判斷 pid 回收');
  assert.deepEqual(content?.unclean, { remaining: 2, detail: '收尾逾時', at: 1_700_000_000_000 });
});

test('markUnclean：鎖已被別人接管時不覆寫（不可蓋掉別人的 pid）', (t) => {
  const dir = createTmpDir('botone-lock-');
  t.after(() => dir.cleanup());
  const path = dir.join('orchestrator.lock');

  const lock = acquireInstanceLock({ path, pid: 111, isAlive: () => false });
  writeFileSync(path, '999\n');
  lock.markUnclean({ remaining: 1 });
  assert.equal(readLockFile(path)?.pid, 999);
});

test('acquireInstanceLock：接管殘留鎖時把上一位的 unclean 標記帶出來（下次啟動才知道要保守）', (t) => {
  const dir = createTmpDir('botone-lock-');
  t.after(() => dir.cleanup());
  const path = dir.join('orchestrator.lock');

  // 模擬「上個實例收尾逾時，保住鎖並標記」後行程結束
  const prev = acquireInstanceLock({ path, pid: 111, startedAtMs: 5, isAlive: () => false, now: () => 1_700_000_000_000 });
  prev.markUnclean({ remaining: 3, detail: '收尾逾時' });

  const next = acquireInstanceLock({ path, pid: 222, isAlive: () => false });
  assert.equal(next.previousUnclean?.remaining, 3, '沒帶出標記 = 新實例會照常做破壞性對帳，清掉還在被寫入的 worktree');
  assert.equal(next.previousUnclean?.at, 1_700_000_000_000);
  assert.equal(readLockFile(path)?.unclean, undefined, '標記只影響接管後的這一次啟動，不可一路黏著');
});

test('acquireInstanceLock：帶 unclean 標記但持有者還活著 → 仍然拒絕啟動（標記不是接管許可）', (t) => {
  const dir = createTmpDir('botone-lock-');
  t.after(() => dir.cleanup());
  const path = dir.join('orchestrator.lock');

  const prev = acquireInstanceLock({ path, pid: 111, startedAtMs: 5, isAlive: () => false });
  prev.markUnclean({ remaining: 1 });
  assert.throws(
    () => acquireInstanceLock({ path, pid: 222, isAlive: () => true, processStartMs: () => 5 }),
    InstanceLockedError,
  );
});

// ── 優雅停止：等待進行中的群組 ──

/** 假時鐘：sleep 直接推進時間，測試不真的等。 */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

test('waitForInFlight：沒有進行中的群組時立刻回傳', async () => {
  const clock = fakeClock();
  const r = await waitForInFlight({ activeCount: () => 0, timeoutMs: 5000, ...clock });
  assert.deepEqual(r, { drained: true, remaining: 0 });
  assert.equal(clock.now(), 0, '不該白等');
});

test('waitForInFlight：等到群組收尾才回傳（避免 ledger/MCP 被提前關閉）', async () => {
  const clock = fakeClock();
  let active = 2;
  const r = await waitForInFlight({
    activeCount: () => (clock.now() >= 600 ? 0 : active),
    timeoutMs: 10_000,
    ...clock,
  });
  active = 0;
  assert.deepEqual(r, { drained: true, remaining: 0 });
  assert.ok(clock.now() >= 600, '應該真的有等');
});

test('createShutdown：資源關閉前一定先等進行中的群組收尾', async () => {
  const order: string[] = [];
  let active = 1;
  const shutdown = createShutdown({
    dispatcher: { activeCount: () => active },
    gateway: { stop: async () => void order.push('gateway') },
    clients: [{ close: async () => void order.push('mcp') }],
    ledger: { close: () => void order.push('ledger') },
    lock: { release: () => void order.push('lock') },
    graceMs: 10_000,
    log: createSilentLogger(),
    // 假等待：模擬「等到群組真的收尾」
    wait: async ({ activeCount }) => {
      order.push(`wait:${activeCount()}`);
      active = 0;
      return { drained: true, remaining: 0 };
    },
  });

  await shutdown();
  assert.deepEqual(order, ['wait:1', 'gateway', 'mcp', 'ledger', 'lock'], 'ledger 不可早於等待被關閉，否則進行中任務寫入會擲例外');
});

test('createShutdown：單一 MCP 關閉失敗不影響後續資源釋放（含實例鎖）', async () => {
  const order: string[] = [];
  const shutdown = createShutdown({
    dispatcher: { activeCount: () => 0 },
    gateway: { stop: async () => void order.push('gateway') },
    clients: [
      { close: async () => Promise.reject(new Error('socket 已斷')) },
      { close: async () => void order.push('mcp2') },
    ],
    ledger: { close: () => void order.push('ledger') },
    lock: { release: () => void order.push('lock') },
    graceMs: 0,
    log: createSilentLogger(),
  });

  await shutdown();
  assert.deepEqual(order, ['gateway', 'mcp2', 'ledger', 'lock'], '鎖沒釋放的話，下次啟動會被自己的殘留鎖擋（雖可接管，但不該發生）');
});

test('waitForInFlight：逾時只警告不卡死（launchd 會 SIGKILL，停不下來更糟）', async () => {
  const clock = fakeClock();
  const rec = createRecordingLogger();
  const r = await waitForInFlight({ activeCount: () => 1, timeoutMs: 1000, log: rec.logger, ...clock });
  assert.deepEqual(r, { drained: false, remaining: 1 });
  assert.ok(clock.now() >= 1000 && clock.now() <= 1250, `等待時間應受上限約束，實際 ${clock.now()}`);
  assert.ok(rec.messages('warn').some((m) => m.includes('等待逾時')));
});

// ── 收尾逾時（drained=false）：D10 之下這是常態，不是例外 ──

/** 收尾逾時的假件：記錄動作順序與鎖上的標記。 */
function shutdownFixture(remaining: number) {
  const order: string[] = [];
  const marks: { remaining: number; detail?: string }[] = [];
  const events: string[] = [];
  const rec = createRecordingLogger();
  const shutdown = createShutdown({
    dispatcher: { activeCount: () => remaining },
    gateway: { stop: async () => void order.push('gateway') },
    clients: [{ close: async () => void order.push('mcp') }],
    ledger: {
      close: () => void order.push('ledger'),
      logEvent: (_s, _r, kind, detail) => void events.push(`${kind}:${detail ?? ''}`),
    },
    lock: {
      release: () => void order.push('lock'),
      markUnclean: (info) => {
        order.push('markUnclean');
        marks.push(info);
      },
    },
    graceMs: 120_000,
    log: rec.logger,
    wait: async () => ({ drained: remaining === 0, remaining }),
  });
  return { shutdown, order, marks, events, rec };
}

test('createShutdown：逾時仍有群組進行中 → 不關 ledger（否則進行中的寫入會擲 "database connection is not open"）', async () => {
  const f = shutdownFixture(2);
  const result = await f.shutdown();

  assert.deepEqual(result, { drained: false, remaining: 2 });
  assert.equal(f.order.includes('ledger'), false, 'ledger 一關，還在跑的 worker 寫入就會爆');
  assert.ok(f.events.some((e) => e.startsWith('shutdown_unclean:')), '要留下稽核紀錄，人才知道下次為何保守');
  assert.ok(f.rec.messages('error').some((m) => m.includes('優雅停止逾時')));
});

test('createShutdown：逾時仍有群組進行中 → 不釋放實例鎖，改標記 unclean（新實例會 force-remove 還在跑的 worktree）', async () => {
  const f = shutdownFixture(1);
  await f.shutdown();

  assert.equal(f.order.includes('lock'), false, '釋放鎖 = 新實例立刻接管並對還在跑的 worktree 執行 remove --force / branch -D');
  assert.deepEqual(f.marks, [{ remaining: 1, detail: '收尾逾時（grace 120s），仍有 1 個群組進行中' }]);
  assert.ok(f.order.indexOf('markUnclean') < f.order.indexOf('gateway'), '標記要在關連線之前寫，避免關閉過程出錯就沒標記了');
});

test('createShutdown：逾時仍會關 gateway/MCP（不關的話行程根本退不出去，launchd 只會 SIGKILL）', async () => {
  const f = shutdownFixture(1);
  await f.shutdown();
  assert.ok(f.order.includes('gateway') && f.order.includes('mcp'));
});

test('createShutdown：正常收乾淨時照樣關 ledger、釋放鎖，且回報 drained', async () => {
  const f = shutdownFixture(0);
  const result = await f.shutdown();
  assert.deepEqual(result, { drained: true, remaining: 0 });
  assert.deepEqual(f.order, ['gateway', 'mcp', 'ledger', 'lock']);
  assert.deepEqual(f.marks, [], '收乾淨了就不該留下 unclean 標記，否則下次啟動白白轉保守');
});

test('真實件整合：收尾逾時後 ledger 仍可寫、鎖檔還在且帶標記、下一個實例會轉保守', async (t) => {
  // 這條複刻實跑診斷的情境：真的 Ledger、真的鎖、activeCount 恆為 1（agent 還在跑）
  const dir = createTmpDir('botone-shutdown-');
  const tmp = createTmpLedger();
  t.after(() => {
    tmp.cleanup();
    dir.cleanup();
  });
  const lockPath = dir.join('data/orchestrator.lock');
  const lock = acquireInstanceLock({ path: lockPath, pid: 111, startedAtMs: 5, isAlive: () => false });

  const shutdown = createShutdown({
    dispatcher: { activeCount: () => 1 },
    gateway: { stop: async () => undefined },
    clients: [],
    ledger: tmp.ledger,
    lock,
    graceMs: 0,
    log: createSilentLogger(),
  });

  const result = await shutdown();
  assert.equal(result.drained, false);

  // 1) 進行中的 worker 之後還寫得了 ledger（舊行為會擲 "database connection is not open"）
  tmp.ledger.logEvent('system', null, 'still_writing', '模擬進行中的 worker');
  assert.ok(tmp.ledger.hasEvent('system', null, 'still_writing'));
  assert.ok(tmp.ledger.hasEvent('system', null, 'shutdown_unclean'));

  // 2) 鎖沒被釋放，且帶著標記
  assert.equal(existsSync(lockPath), true, '舊行為會釋放鎖 → 新實例對還在跑的 worktree 執行 remove --force');
  assert.equal(readLockFile(lockPath)?.unclean?.remaining, 1);

  // 3) 下一個實例仍啟動得起來（接管），但轉保守
  const next = acquireInstanceLock({ path: lockPath, pid: 222, isAlive: () => false });
  const mode = bootReconcileMode({ ...(next.previousUnclean ? { unclean: next.previousUnclean } : {}), setting: 'conservative', env: {} });
  assert.equal(mode.conservative, true, '鎖不釋放又要能重啟：標記語意是「上次沒收乾淨」，不是「有實例在跑」');
});

test('scheduleForceExit：設定秒數 <= 0 時不強制結束；有設定時逾時後才強制', async () => {
  const rec = createRecordingLogger();
  assert.equal(scheduleForceExit(0, rec.logger, () => assert.fail('不該強制退出')), undefined);
  assert.equal(scheduleForceExit(-1, rec.logger, () => assert.fail('不該強制退出')), undefined);

  const codes: number[] = [];
  const timer = scheduleForceExit(0.01, rec.logger, (c) => codes.push(c));
  assert.ok(timer);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(codes, [1], '行程被 in-flight 的 agent 撐著時要有最後保險');
});

// ── 上次沒收乾淨 → 這次開機的對帳要保守 ──

const uncleanMark = { at: 1_700_000_000_000, remaining: 2, detail: '收尾逾時' };

test('bootReconcileMode：沒有 unclean 標記 → 完整對帳（正常路徑不受影響）', () => {
  assert.deepEqual(bootReconcileMode({ setting: 'conservative', env: {} }), { conservative: false });
});

test('bootReconcileMode：有 unclean 標記 → 保守（worktree 可能還有 orphan 的 agent 在寫）', () => {
  const mode = bootReconcileMode({ unclean: uncleanMark, setting: 'conservative', env: {} });
  assert.equal(mode.conservative, true);
  assert.ok(mode.reason?.includes('上次收尾未完成'));
});

test('bootReconcileMode：合法例外的出口 —— 設定 full 或 ORCH_FORCE_RECONCILE=1 可恢復完整對帳', () => {
  const rec = createRecordingLogger();
  assert.equal(bootReconcileMode({ unclean: uncleanMark, setting: 'full', env: {}, log: rec.logger }).conservative, false);
  assert.equal(
    bootReconcileMode({ unclean: uncleanMark, setting: 'conservative', env: { ORCH_FORCE_RECONCILE: '1' } }).conservative,
    false,
    '機器重開過就確定沒有殘留行程了，人要能一次性解除保守',
  );
  assert.equal(
    bootReconcileMode({ unclean: uncleanMark, setting: 'full', env: { ORCH_FORCE_RECONCILE: '0' } }).conservative,
    true,
    '環境變數也要能反向把保守打開',
  );
});

test('reconcileOnBoot：保守模式一定用 dryRun 呼叫 Reconciler（不刪 worktree、不刪分支、不改狀態）', async (t) => {
  const tmp = createTmpLedger();
  t.after(() => tmp.cleanup());
  const seen: (boolean | undefined)[] = [];
  const rec = createRecordingLogger();

  await reconcileOnBoot({
    ledger: tmp.ledger,
    log: rec.logger,
    registry: emptyLookup(),
    clients: [],
    mode: { conservative: true, reason: '上次收尾未完成' },
    reconciler: { reconcile: async (o) => (seen.push(o.dryRun), { actions: [] }) },
  });

  assert.deepEqual(seen, [true], '保守卻照樣動手 = 把使用者正在跑的 worktree 清掉');
  assert.ok(tmp.ledger.hasEvent('system', null, 'reconcile_conservative'), '要留下紀錄，人才知道這輪沒有恢復狀態');
  assert.ok(rec.messages('error').some((m) => m.includes('保守開機對帳')));
});

test('reconcileOnBoot：正常開機仍是完整對帳（保守不可變成新的預設，否則殘留狀態永遠收不回來）', async (t) => {
  const tmp = createTmpLedger();
  t.after(() => tmp.cleanup());
  const seen: (boolean | undefined)[] = [];

  await reconcileOnBoot({
    ledger: tmp.ledger,
    log: createSilentLogger(),
    registry: emptyLookup(),
    clients: [],
    mode: { conservative: false },
    reconciler: { reconcile: async (o) => (seen.push(o.dryRun), { actions: [] }) },
  });

  assert.deepEqual(seen, [false]);
  assert.equal(tmp.ledger.hasEvent('system', null, 'reconcile_conservative'), false);
});

// ── 指令逾時：設定 → Verifier（缺這條接線時，慢專案每輪都被判逾時紅燈） ──

test('verifierConfigOf：專案的 commandTimeoutSec 會變成 VerifierConfig.timeoutMs', () => {
  assert.equal(verifierConfigOf(proj({ commandTimeoutSec: 1800 })).timeoutMs, 1_800_000);
  assert.equal(verifierConfigOf(proj()).timeoutMs, undefined, '未設 → 交給全域預設，不在這裡硬填');
  assert.equal(verifierConfigOf(proj({ commandTimeoutSec: 0 })).timeoutMs, undefined, '非正數視為未設（不接受關閉逾時）');
});

test('verifierDepsOf：全域 commandTimeoutSec 會變成 Verifier 的 commandTimeoutMs', () => {
  assert.deepEqual(verifierDepsOf({ commandTimeoutSec: 600, agent: { models: {} } }), { commandTimeoutMs: 600_000 });
  assert.deepEqual(verifierDepsOf({ commandTimeoutSec: 0, agent: { models: {} } }), {}, '非正數 → 用 verifier 內建預設，絕不變成「無逾時」');
});

// ── 截圖保留策略的根目錄（沒接 = 截圖永不清理，磁碟無限成長） ──

// ── 多來源 MCP 聚合：查詢失敗必須可被對帳看見 ──

function briefs(...ids: string[]): TaskBrief[] {
  return ids.map((id) => ({ id, title: id, status: 'done', repo: 'acme/web' }) as TaskBrief);
}

test('aggregateMcp：listTasksDetailed 回報失敗來源數（對帳才不會把「查不到」當「確定沒有」）', async () => {
  const ok = { listTasks: async () => briefs('T-1') };
  const boom = { listTasks: async () => { throw new Error('MCP 斷線'); } };
  const agg = aggregateMcp([ok, boom], createSilentLogger());

  assert.ok(agg.listTasksDetailed, '沒有這個方法 → Reconciler 只能假設證據完整，可能刪掉未提交的成果');
  const detailed = await agg.listTasksDetailed!({ mine: true, status: 'done' });
  assert.deepEqual(detailed.tasks.map((t) => t.id), ['T-1']);
  assert.equal(detailed.failedSources, 1);

  const allOk = aggregateMcp([ok, { listTasks: async () => briefs('T-2') }], createSilentLogger());
  assert.equal((await allOk.listTasksDetailed!({ mine: true, status: 'done' })).failedSources, 0);
});

test('aggregateMcp：listTasks 仍照舊吞下個別失敗（相容既有呼叫端）', async () => {
  const agg = aggregateMcp(
    [{ listTasks: async () => briefs('T-1') }, { listTasks: async () => { throw new Error('掛了'); } }],
    createSilentLogger(),
  );
  assert.deepEqual((await agg.listTasks({ mine: true })).map((t) => t.id), ['T-1']);
});

// ── 合併路徑的獨立 worktree（絕不動使用者的主 clone） ──

test('ensureMergeWorkspace：沒有登記過就以 --detach 建立（不佔用分支、不 checkout 主 clone）', async (t) => {
  const dir = createTmpDir('botone-merge-ws-');
  t.after(() => dir.cleanup());
  const calls: string[][] = [];
  const git: GitRun = async (_repo, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: '' };
  };
  const path = dir.join('merge-worktrees/web');
  assert.equal(await ensureMergeWorkspace({ repoPath: '/tmp/web', path, base: 'main', git }), path);
  assert.deepEqual(calls[1], ['worktree', 'add', '--detach', path, 'main']);
  assert.ok(!calls.some((a) => a[0] === 'checkout'), '合併工作區的準備階段絕不可 checkout 主 clone');
});

test('ensureMergeWorkspace：已登記過就沿用，不重複建立', async (t) => {
  const dir = createTmpDir('botone-merge-ws-');
  t.after(() => dir.cleanup());
  const path = dir.join('merge-worktrees/web');
  const calls: string[][] = [];
  const git: GitRun = async (_repo, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: `worktree /Users/x/code/web\n\nworktree ${path}\n` };
  };
  assert.equal(await ensureMergeWorkspace({ repoPath: '/tmp/web', path, base: 'main', git }), path);
  assert.equal(calls.length, 1, '只查一次 worktree list，不再 add');
});

test('ensureMergeWorkspace：建不出來就回 undefined（寧可不合併，也不退而求其次動主 clone）', async () => {
  const git: GitRun = async (_repo, args) => ({ exitCode: args[1] === 'list' ? 0 : 1, stdout: '', stderr: 'fatal: 目錄已存在' });
  const rec = createRecordingLogger();
  assert.equal(
    await ensureMergeWorkspace({ repoPath: '/tmp/web', path: '/tmp/does-not-matter/web', base: 'main', git, log: rec.logger }),
    undefined,
  );
  assert.ok(rec.messages('error').some((m) => m.includes('合併專用 worktree')));
});

// ── 合併管線（需求 7）：預設關閉、開啟後只在專用 worktree 內動作 ──

function runtimeOf(over: Partial<ProjectRuntime> = {}): ProjectRuntime {
  return {
    repo: 'acme/web',
    repoPath: '/Users/me/code/web',
    baseBranch: 'main',
    verifierConfig: { test: 'npm test' },
    mcp: fakeMcp,
    ...over,
  };
}

const specs = (): MergeProjectSpec[] => [{ id: 'web', runtime: runtimeOf() }];

/**
 * 合併管線**永遠接線**。它原本被 allowLocalMerge 關掉，但那造成矛盾：
 * 開關關著時每個群組都停在 in_review 等人核准，人按了核准卻沒有東西可以執行合併。
 * 開關的意思是「要不要等人」，不是「要不要有合併能力」——
 * 真正的把關是**逐次**的核准憑證，比一個全域開關精確。
 */
test('createMergePipeline：不受 allowLocalMerge 影響，照樣接線（把關的是核准憑證）', async () => {
  const log = createSilentLogger();
  const ws = async () => '/tmp/merge-ws';
  assert.notEqual(
    await createMergePipeline({ projects: specs(), actions: { allowLocalMerge: false }, log, ensureWorkspace: ws }),
    undefined,
  );
});

test('createMergePipeline：兩個開關都開時接線，且工作目錄是專用 worktree（不是使用者的主 clone）', async () => {
  const seen: string[] = [];
  // 路徑要真的存在：resolveProject 現在會確認工作區還在（它消失過，見「自我修復」那組測試）
  const wt = mkdtempSync(join(tmpdir(), 'mw-pipeline-'));
  const pipeline = await createMergePipeline({
    projects: specs(),
    actions: { allowLocalMerge: true },
    log: createSilentLogger(),
    ensureWorkspace: async (input) => {
      seen.push(input.repoPath);
      return wt;
    },
  });
  assert.ok(pipeline, '兩個開關都開就必須接線，否則需求 7 的合併永遠不會發生');
  const proj = pipeline!.resolveProject('acme/web');
  assert.equal(proj?.repoPath, wt, 'Merge Guard 會 checkout 群組分支，不可指向使用者的主 clone');
  assert.equal(proj?.baseBranch, 'main');
  assert.equal(pipeline!.resolveProject('acme/unknown'), undefined);
  assert.deepEqual(seen, ['/Users/me/code/web']);
  // MergePipelineDeps 現在連 policy 這個欄位都沒有了（合併風險改由 GroupRunner 的判斷者逐案決定）。
  // 這條仍然要驗執行期真的沒塞這個鍵——型別上不存在，不等於實作不會多塞一個進去。
  assert.equal(
    (pipeline as MergePipelineDeps & { policy?: unknown }).policy,
    undefined,
    '不注入單一 policy，才能讓每專案的合併風險判斷生效',
  );
  assert.ok(pipeline!.fetchBase, '沒有 fetchBase 就是拿過期的 base 驗證，語意飄移抓不到');
});

test('createMergePipeline：所有專案都拿不到專用工作區 → 不接線（不會退回主 clone）', async () => {
  const pipeline = await createMergePipeline({
    projects: specs(),
    actions: { allowLocalMerge: true },
    log: createSilentLogger(),
    ensureWorkspace: async () => undefined,
  });
  assert.equal(pipeline, undefined);
});

// ── 主鏈路組裝：審查意見必須是「同一個」暫存區 ──

/** 可觸發人工裁決的假人機介面（ConsoleGateway 的 onMergeDecision 是 no-op，測不到接線）。 */
function fakeGateway(): { gateway: HumanGateway; emitMerge(d: MergeDecision): void; asked: MergeApprovalInput[] } {
  const cbs: ((d: MergeDecision) => void)[] = [];
  const asked: MergeApprovalInput[] = [];
  const gateway = {
    postTaskCard: async () => undefined,
    event: async () => undefined,
    askClarification: async () => undefined,
    askMergeApproval: async (_ts: string | undefined, g: MergeApprovalInput) => void asked.push(g),
    postScreenshots: async () => undefined,
    onAnswer: () => undefined,
    onControl: () => undefined,
    onMergeDecision: (cb: (d: MergeDecision) => void) => void cbs.push(cb),
    start: async () => undefined,
    stop: async () => undefined,
  } as unknown as HumanGateway;
  return { gateway, emitMerge: (d) => cbs.forEach((cb) => cb(d)), asked };
}

/** 用預設設定（沒有任何 config 檔）組一條主鏈路，worktree 落在暫存目錄。 */
function pipelineFixture(
  t: { after(fn: () => void): void },
  opts: { commandRunner?: CommandRunner; merge?: MergePipelineDeps } = {},
) {
  const dir = createTmpDir('botone-pipeline-');
  const tmp = createTmpLedger();
  t.after(() => {
    tmp.cleanup();
    dir.cleanup();
  });
  // 沒有任何 config 檔 → 全部走 schema 預設（與「照文件安裝的使用者」一致）
  const config: AppConfig = loadConfig(dir.path);
  const gw = fakeGateway();
  const pipeline = buildPipeline({
    config,
    ledger: tmp.ledger,
    log: createSilentLogger(),
    gateway: gw.gateway,
    registry: emptyRegistry(),
    allowLocalMerge: false,
    worktreeBase: dir.join('worktrees'),
    ...(opts.commandRunner ? { commandRunner: opts.commandRunner } : {}),
    ...(opts.merge ? { merge: opts.merge } : {}),
  });
  return { pipeline, ledger: tmp.ledger, gw };
}

/** 建一個「任務都已完成、正等審查意見」的群組。 */
function parkedGroup(ledger: ReturnType<typeof createTmpLedger>['ledger']) {
  const input = makeDiscoveredTask({ repo: 'acme/web' });
  ledger.upsertDiscoveredTask(input);
  const g = ledger.createGroup({ repo: 'acme/web', branch: 'orch/web/g1', taskIds: [input.id], footprint: [] });
  ledger.updateTaskState(input.id, 'done', { groupId: g.id });
  ledger.updateGroupState(g.id, 'changes_requested');
  return g;
}

test('buildPipeline：GroupRunner 拿到的是同一個 ReviewFeedbackStore（不同實例 = agent 讀不到審查意見）', (t) => {
  const { pipeline } = pipelineFixture(t);
  assert.equal(pipeline.groupRunnerDeps.feedback, pipeline.feedback);
});

test('buildPipeline：Orchestrator 共用同一個暫存區，changes_requested 的群才會被重新派工', async (t) => {
  const { pipeline, ledger } = pipelineFixture(t);
  const g = parkedGroup(ledger);
  pipeline.feedback.save({ groupId: g.id, comments: ['請補測試'], source: 'github_review' });

  await pipeline.orchestrator.tick();

  assert.ok(
    ledger.hasEvent('group', g.id, 'requeued'),
    '沒有共用實例時 Orchestrator 讀不到意見，安全互鎖會讓群組永遠停在 changes_requested',
  );
});

test('buildPipeline：ReviewWatcher 把 GitHub 的「要求修改」寫進同一個暫存區', async (t) => {
  const view = {
    number: 7,
    state: 'OPEN',
    reviews: [{ id: 'r1', author: { login: 'alice' }, state: 'CHANGES_REQUESTED', body: '請補測試', submittedAt: '2026-01-01T00:00:00Z' }],
    comments: [],
  };
  const gh: CommandRunner = async (): Promise<CommandResult> => ({ exitCode: 0, stdout: JSON.stringify(view), stderr: '' });
  const { pipeline, ledger } = pipelineFixture(t, { commandRunner: gh });

  const input = makeDiscoveredTask({ repo: 'acme/web' });
  ledger.upsertDiscoveredTask(input);
  const g = ledger.createGroup({ repo: 'acme/web', branch: 'orch/web/g1', taskIds: [input.id], footprint: [] });
  ledger.updateTaskState(input.id, 'done', { groupId: g.id });
  ledger.updateGroupState(g.id, 'pr_open', { prNumber: 7, prUrl: 'https://github.com/acme/web/pull/7' });

  const events = await pipeline.reviewWatcher.poll();

  assert.equal(events[0]?.type, 'changes_requested');
  assert.ok(pipeline.feedback.has(g.id), 'ReviewWatcher 沒拿到共用實例的話，意見只會躺在 events 表裡沒人讀');
});

test('buildPipeline：人在 Slack 的合併裁決會變成核准憑證（gateway 有接上 onMergeDecision）', (t) => {
  const { pipeline, ledger, gw } = pipelineFixture(t);
  const g = parkedGroup(ledger);
  ledger.updateGroupState(g.id, 'in_review');

  gw.emitMerge({ groupId: g.id, approved: true, userId: 'U123' });

  assert.ok(ledger.hasEvent('group', g.id, 'merge_approval'), 'gateway 沒接線 → 人按了核准也不會產生憑證，PR 永遠不會被合併');
  assert.equal(ledger.getGroup(g.id)?.state, 'merge_guard');
  assert.ok(pipeline.orchestrator);
});

// ── 崩潰對帳的接線（截圖保留策略 + MCP 證據） ──

test('reconcilerDepsOf：截圖根目錄有接上（沒接 = 截圖永不清理，磁碟無限成長）', (t) => {
  const tmp = createTmpLedger();
  t.after(() => tmp.cleanup());
  const deps = reconcilerDepsOf({
    ledger: tmp.ledger,
    log: createSilentLogger(),
    registry: emptyLookup(),
    clients: [],
    screenshotRoot: './data/screenshots',
  });
  assert.equal(deps.screenshotRoot, './data/screenshots');
  assert.equal(deps.mcp, undefined, '沒有 MCP client 就不該假裝有遠端證據');
});

test('reconcilerDepsOf：有 MCP client 時提供可回報失敗來源的聚合器', (t) => {
  const tmp = createTmpLedger();
  t.after(() => tmp.cleanup());
  const deps = reconcilerDepsOf({
    ledger: tmp.ledger,
    log: createSilentLogger(),
    registry: emptyLookup(),
    clients: [{ listTasks: async () => briefs('T-9') }],
  });
  assert.ok(deps.mcp?.listTasksDetailed, '對帳必須分得出「查不到」與「確定沒有」');
});

// ── 需求 7 的閉環：人核准 → Merge Guard → 政策 → 真的合併 PR ──

interface MergeSpy {
  merge: MergePipelineDeps;
  merged: { repo: string; prNumber: number; approvedBy: string; cwd?: string }[];
  guarded: string[];
}

/** 假的合併管線：不碰 git、不碰 gh，只記錄「有沒有被呼叫、帶了什麼」。 */
function mergeSpy(): MergeSpy {
  const merged: MergeSpy['merged'] = [];
  const guarded: string[] = [];
  return {
    merged,
    guarded,
    merge: {
      resolveProject: () => ({ repoPath: '/tmp/merge-worktrees/web', sourceRepoPath: '/tmp/merge-worktrees/web', baseBranch: 'main', verifierConfig: {} }),
      guardFor: () => ({
        attempt: async (input: { branch: string }) => {
          guarded.push(input.branch);
          return { ok: true as const };
        },
      }),
      pr: {
        merge: async (input) => {
          merged.push(input);
          return { ok: true, detail: 'merged' };
        },
      },
      fetchBase: async () => undefined,
    },
  };
}

test('buildPipeline + merge：核准後走完把關並合併 PR，approvedBy 稽核原封不動傳遞', async (t) => {
  const spy = mergeSpy();
  const { pipeline, ledger, gw } = pipelineFixture(t, { merge: spy.merge });
  const g = parkedGroup(ledger);
  ledger.updateGroupState(g.id, 'in_review', { prNumber: 42, prUrl: 'https://github.com/acme/web/pull/42' });

  // 人在 Slack 按了核准 → 產生憑證（狀態同時轉 merge_guard）
  gw.emitMerge({ groupId: g.id, approved: true, userId: 'U123' });
  await pipeline.orchestrator.tick();

  assert.deepEqual(spy.guarded, [g.branch], '合併前一定要重跑 Merge Guard');
  assert.equal(spy.merged.length, 1, '需求 7：審查通過後必須真的合併 PR，否則等於沒接線');
  assert.equal(spy.merged[0]?.prNumber, 42);
  assert.equal(spy.merged[0]?.approvedBy, 'human:U123', 'approvedBy 是稽核唯一依據，不可被改寫或省略');
  assert.equal(spy.merged[0]?.cwd, '/tmp/merge-worktrees/web', 'gh 要在合併專用工作區內執行');
  assert.equal(ledger.getGroup(g.id)?.state, 'merged');
  assert.deepEqual(gw.asked, [], '政策放行 + 有憑證 → 不必再問人');
});

test('buildPipeline + merge：沒有核准憑證時，即使群組是 merge_guard 也不合併（改成問人）', async (t) => {
  const spy = mergeSpy();
  const { pipeline, ledger, gw } = pipelineFixture(t, { merge: spy.merge });
  const g = parkedGroup(ledger);
  ledger.updateGroupState(g.id, 'merge_guard', { prNumber: 42 });

  await pipeline.orchestrator.tick();

  assert.deepEqual(spy.merged, [], '狀態不等於核准：崩潰殘留的 merge_guard 不可被當成有人點過頭');
  assert.equal(gw.asked.length, 1, '沒有憑證就問人');
});

/**
 * 控制台的 HTTP server 會讓 node 的事件迴圈一直活著。收尾時不關的話，
 * `--once` 跑完一輪也退不出去——實測整整卡到逾時，看起來像 daemon 當掉，
 * 其實只是沒有人關那個 socket。
 */
test('createShutdown：extraClose 會被關掉（否則 --once 退不出去）', async () => {
  const closed: string[] = [];
  const shutdown = createShutdown({
    dispatcher: { activeCount: () => 0 },
    gateway: { stop: async () => void closed.push('gateway') },
    clients: [{ close: async () => void closed.push('mcp') }],
    extraClose: [async () => void closed.push('console')],
    ledger: { close: () => void closed.push('ledger') },
    lock: { release: () => void closed.push('lock') },
    graceMs: 10,
    log: createSilentLogger(),
  });

  await shutdown();

  assert.deepEqual(closed, ['gateway', 'mcp', 'console', 'ledger', 'lock']);
});

test('createShutdown：extraClose 丟例外只忽略，不擋住後續收尾', async () => {
  const closed: string[] = [];
  const rec = createRecordingLogger();
  const shutdown = createShutdown({
    dispatcher: { activeCount: () => 0 },
    gateway: { stop: async () => {} },
    clients: [],
    extraClose: [async () => { throw new Error('關不掉'); }],
    ledger: { close: () => void closed.push('ledger') },
    lock: { release: () => void closed.push('lock') },
    graceMs: 10,
    log: rec.logger,
  });

  await shutdown();

  assert.deepEqual(closed, ['ledger', 'lock'], 'ledger 與鎖仍要正常釋放');
  assert.ok(rec.messages('warn').some((m) => m.includes('附加資源關閉失敗')));
});

// ── GitHub token 熱套用 ──

/**
 * `gh` 是子行程，token 靠 process.env 傳給它。只在啟動時套一次的話，
 * 控制台改了 token 要重啟才生效——而控制台的整個意義就是不必重啟。
 */
test('GitHub token：控制台改了新值，下一輪就套用（不必重啟）', () => {
  const env: NodeJS.ProcessEnv = {};
  const apply = createGithubTokenApplier(env);

  assert.equal(apply('tok-1'), 'set');
  assert.equal(env.GH_TOKEN, 'tok-1');
  assert.equal(env.GITHUB_TOKEN, 'tok-1');

  assert.equal(apply('tok-1'), 'kept', '沒變就不重寫、不重複記 log');

  assert.equal(apply('tok-2'), 'set', '換了新 token 要立刻生效');
  assert.equal(env.GH_TOKEN, 'tok-2');
});

/**
 * 「外部注入優先」仍然成立：launchd／export 設的值不可以被資料庫裡的舊值蓋掉，
 * 否則部署時注入的憑證會在第一輪 tick 就消失。
 */
test('GitHub token：外部注入的值不會被設定覆蓋', () => {
  const env: NodeJS.ProcessEnv = { GH_TOKEN: '外部注入的' };
  const apply = createGithubTokenApplier(env);

  assert.equal(apply('資料庫裡的'), 'kept');
  assert.equal(env.GH_TOKEN, '外部注入的');
});

test('GitHub token：空字串視為未設，不會清掉既有值', () => {
  const env: NodeJS.ProcessEnv = {};
  const apply = createGithubTokenApplier(env);
  apply('tok-1');

  assert.equal(apply(''), 'absent');
  assert.equal(apply(undefined), 'absent');
  assert.equal(apply('   '), 'absent');
  assert.equal(env.GH_TOKEN, 'tok-1', '未設不等於要清空');
});

test('applyGithubToken 的單次行為維持不變（既有呼叫端不受影響）', () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(applyGithubToken('t', env), 'set');
  assert.equal(env.GH_TOKEN, 't');
  assert.equal(applyGithubToken(undefined, {}), 'absent');
  assert.equal(applyGithubToken('新的', { GH_TOKEN: '舊的' }), 'kept');
});

// ── 合併工作區消失後要自己回來 ──

/**
 * 合併工作區先前只在啟動時建立一次。它一旦消失（清理腳本掃掉、磁碟工具刪掉、人手動 rm），
 * daemon 永遠不會重建，之後每一次合併都倒在
 * `fatal: cannot change to '.../merge-worktrees/live': No such file or directory`
 * → precondition_failed → 群組 failed。實跑撞到（我自己的清理刪掉了它）。
 */
describe('合併工作區的自我修復', () => {
  it('工作區還在 → 照常回傳專案', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'mw-ok-'));
    const pipeline = await createMergePipeline({
      projects: specs(),
      actions: { allowLocalMerge: true },
      log: createSilentLogger(),
      ensureWorkspace: async () => wt,
    });
    assert.equal(pipeline?.resolveProject('acme/web')?.repoPath, wt);
  });

  it('工作區不見了 → 本輪不合併並講明原因（比倒在 git 指令上清楚）', async () => {
    const gone = join(tmpdir(), 'mw-gone-does-not-exist-' + process.pid);
    const rec = createRecordingLogger();
    const pipeline = await createMergePipeline({
      projects: specs(),
      actions: { allowLocalMerge: true },
      log: rec.logger,
      ensureWorkspace: async () => gone,
    });

    assert.equal(pipeline?.resolveProject('acme/web'), undefined);
    const errs = rec.messages('error');
    assert.ok(errs.some((m) => /合併工作區不見了/.test(m)));
    assert.ok(errs.some((m) => /憑證會保留/.test(m)), '要講明不必重新核准，否則人會白跑一趟');
  });
});

/**
 * 一群做完之後只有一個出口：推分支 → 開 PR → 審查 → 合併。
 * 沒有 remote 的 repo 一步都走不了，它產出的每一群最後都會停在「做完了但無處可去」。
 *
 * 實跑撞出來的：我把一個純本地的測試專案接進來，它一路跑到「政策判定需人工核准 →
 * 人按了核准」，然後沒有任何程式路徑可以合併，群組永遠停在那裡，還把依賴它的
 * 下一群一起卡住。錯不在最後那一步沒寫，錯在這種專案根本不該被登錄起來跑。
 */
describe('hasRemote — 專案走不走得完整條路', () => {
  const fake = (out: string, exitCode = 0) =>
    (async () => ({ exitCode, stdout: out, stderr: '' })) as unknown as Parameters<typeof hasRemote>[2];

  it('有設定該 remote → true', async () => {
    assert.equal(await hasRemote('/r', 'origin', fake('origin\nupstream')), true);
  });

  it('沒有任何 remote（純本地 repo）→ false', async () => {
    assert.equal(await hasRemote('/r', 'origin', fake('')), false);
  });

  it('有 remote 但名字不同 → false（設定寫錯跟沒設一樣走不通）', async () => {
    assert.equal(await hasRemote('/r', 'origin', fake('upstream')), false);
  });

  it('git 查不到 → 放行，讓後續流程去報真正的錯', async () => {
    assert.equal(await hasRemote('/r', 'origin', fake('', 128)), true);
  });
});

/**
 * reviewer 與所有判斷者（分群／介面／飄移／風險）都是**在 daemon 自己的行程裡**
 * 直接呼叫 query()，只看 process.env。寫程式的 agent 不一樣——它走子行程，
 * 認證是注入進去的，所以它能跑不代表判斷者能跑。
 *
 * 實跑撞到：把認證搬進 DB、正式資料夾是全新 clone（沒有 .env），於是
 *   · reviewer  → 「未設定 Claude 認證」直接略過（DoD 綠燈但沒人審過）
 *   · 分群 agent → 沒接線 → 退回啟發式 → 足跡混進整個目錄 → 任何兩群都重疊
 * 而日誌只有一行 WARN，「Claude 認證已載入」還照印——那行只證明讀得到設定。
 */
describe('applyClaudeAuth — 認證要套進本行程，判斷者才跑得起來', () => {
  it('DB 有認證、環境沒有 → 套進去，hasClaudeAuth 才會是 true', () => {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(hasClaudeAuth(env), false, '前提：環境本來沒有');
    const applied = applyClaudeAuth({ authToken: 'tok', baseUrl: 'https://x' }, env);
    assert.deepEqual(applied, ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
    assert.equal(hasClaudeAuth(env), true, '套完之後判斷者才用得到');
  });

  it('API key 也算', () => {
    const env: NodeJS.ProcessEnv = {};
    applyClaudeAuth({ apiKey: 'sk-x' }, env);
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-x');
    assert.equal(hasClaudeAuth(env), true);
  });

  /** 使用者用 .env 或 launchd 明確指定時，不該被 DB 的舊值蓋掉。 */
  it('環境變數優先，不被 DB 覆寫', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_AUTH_TOKEN: '環境的' };
    const applied = applyClaudeAuth({ authToken: 'DB 的' }, env);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, '環境的');
    assert.deepEqual(applied, [], '沒套用任何東西');
  });

  it('空字串／空白視為沒設定（不會把 env 洗成空值）', () => {
    const env: NodeJS.ProcessEnv = {};
    assert.deepEqual(applyClaudeAuth({ authToken: '  ', apiKey: '', baseUrl: undefined }, env), []);
    assert.equal(hasClaudeAuth(env), false);
  });
});

/**
 * 上面那組測的是 applyClaudeAuth 這個函式本身。但這個 bug 的本質不是函式壞掉，
 * 是**沒有人呼叫它**——能力存在、接線沒接，而症狀只有一行 WARN。
 *
 * 所以真正要鎖的是：建 pipeline 就一定先套過認證。放在 buildPipeline 裡
 * （而不是 main()）就是為了這個：main() 沒辦法在單元測試裡跑，buildPipeline 可以。
 */
describe('buildPipeline 一定會先套用 Claude 認證', () => {
  const KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('認證只在設定裡（環境沒有）→ 建完 pipeline 後判斷者用得到', () => {
    assert.equal(hasClaudeAuth(), false, '前提：環境本來沒有');
    const tmp = createTmpLedger();
    try {
      const dir = createTmpDir();
      const config = loadConfig(dir.path);
      // 認證只存在設定裡（＝控制台存進 DB 的情況），環境變數是空的
      config.orchestrator.agent = { authToken: 'tok-from-db', baseUrl: 'https://gw.example', models: {} };
      buildPipeline({
        config,
        ledger: tmp.ledger,
        log: createSilentLogger(),
        gateway: fakeGateway().gateway,
        registry: emptyRegistry(),
        allowLocalMerge: false,
        worktreeBase: dir.join('worktrees'),
      });
      dir.cleanup();
      assert.equal(hasClaudeAuth(), true, 'reviewer 與所有判斷者靠這個決定要不要接線');
      assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://gw.example');
    } finally {
      tmp.cleanup();
    }
  });
});

/**
 * 各角色的難度差很多：寫程式與 reviewer 要讀懂整份規格與 diff，
 * 合併風險判斷者只回答「這個改動可不可逆」。全部跑同一個最貴的模型，
 * 錢會花在判斷不出差別的地方——所以要能分角色設定。
 *
 * 這裡鎖的是**接線**：設定裡填了，那個呼叫點才真的會用到。
 * （各自獨立建構，漏接一個不會有任何症狀，只會安靜地用預設模型。）
 */
describe('各角色的模型設定要真的接到 agent 上', () => {
  // UiJudge 的接線測試退場（第 15 片）：介面判斷者連同整套截圖量測堆疊一起刪掉了，
  // 畫面改由審查者自己開瀏覽器判斷（它的模型接線在 reviewer 那幾條測試裡）。
});

/**
 * **依賴不再由程式帶進工作區。**
 *
 * ── 這裡原本守的是什麼 ──
 *
 * 實跑（2026-08-05，g_da31b3e8c2ac）：群組執行那一側的守衛 13:39 通過 → 人 13:42 核准
 * → 核准後那次在 13:45 重跑，驗收樹**沒有 node_modules**：
 *
 *   Cannot find package 'tsx' imported from /tmp/orch-merge-nhveOH/apps/web/
 *
 * 於是判 semantic_drift、憑證作廢、退回 changes_requested，42 則「build 紅了」回灌給
 * 改不動它的 agent。**任何需要建置的專案都合併不了。** 當時的修法是替兩個守衛呼叫點
 * 都補上 prepareTree，把主 clone 的 node_modules 複製進拋棄式樹。
 *
 * ── 為什麼那個修法本身是錯的 ──
 *
 * 1. 它寫死 `node_modules`。對 Laravel（vendor/）、Python（.venv/）一律不成立，
 *    而症狀就是上面那種「看起來像程式碼壞掉」的紅燈。
 * 2. **就算清單猜對，複製來的內容也是錯的。** 主 clone 的依賴對應它自己那顆 lockfile；
 *    驗收樹是別的 commit、agent 可能剛改過 package.json——複製過去就是不相符的版本，
 *    而且看起來一切正常。這件事本身做不出正確結果。
 *
 * 現在：agent 自己的工作區自己準備，沒有 agent 的驗收樹則由**專案自己的指令**負責
 *（`npm ci && npm run build`）——那才會裝到那棵樹自己那顆 lockfile 的版本。
 *
 * 所以這幾條改成守「不要再長回來」，以及「兩個沒有程式幫忙的地方都有被告知」。
 */
describe('依賴由誰準備', () => {
  /**
   * `.env` 與依賴是**不同的東西**，第一版把它們一起拆掉是拆過頭了。
   *
   * 依賴有 lockfile，複製過去可能對不上這棵樹的版本；`.env` 沒有版控對照物——
   * 主 clone 那份就是唯一一份，不帶不會得到「舊版本」，只會得到**沒有**。
   * 實測 WorkerControl：少了 .env，Laravel 退回 config/database.php 的預設值，
   * 測試直接 `Access denied for user 'forge'`。
   */
  it('本機設定檔還是要帶（三個沒有 agent 的地方都要）', () => {
    for (const f of ['src/main.ts', 'src/core/group-runner.ts']) {
      assert.match(readFileSync(f, 'utf8'), /prepareLocalConfig\(/, `${f} 沒有帶本機設定檔`);
    }
    assert.match(readFileSync('src/pr/merge-guard.ts', 'utf8'), /prepareTree/, '驗收樹沒有 agent，設定檔只能由它帶');
  });

  it('程式不再複製依賴進工作區（清單猜不對，而且複製來的版本也不對）', () => {
    // 只看程式碼——註解裡提到那兩個名字是在解釋「為什麼拆掉」，不算數
    const codeOf = (f: string): string =>
      readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const f of ['src/main.ts', 'src/core/group-runner.ts', 'src/pr/merge-guard.ts']) {
      assert.doesNotMatch(codeOf(f), /prepareNodeModules|prepareLocalFiles/, `${f} 又開始複製依賴了`);
    }
  });

  it('agent 被告知工作區是空的（否則它會以為依賴都在，直接跑 build）', () => {
    const src = readFileSync('src/worker/agent-runtime.ts', 'utf8');
    assert.match(src, /你的工作區是全新的 worktree/);
    assert.match(src, /要跑建置或測試就自己先裝起來/);
  });

  /**
   * 合併守衛那棵樹**沒有 agent**——這是整條路上唯一沒有人能自己補救的地方，
   * 所以使用者必須在填指令的當下就知道。看不到這句話，重演的就是 g_da31b3e8c2ac。
   */
  it('控制台講明「需要安裝的專案要寫進指令本身」', () => {
    const ui = readFileSync('src/console/ui.html', 'utf8');
    assert.match(ui, /全新的 worktree/);
    assert.match(ui, /npm ci/, '要給得出具體寫法，不能只說「請自行處理」');
  });
});
