import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigStore, expandEnv } from '../src/config/store.js';
import { migrateYamlIfPresent } from '../src/config/migrate.js';
import { loadBootstrap, profileOf, DEFAULT_DATA_ROOT, TEST_DATA_ROOT } from '../src/config/bootstrap.js';
import { createTmpDir, createSilentLogger, createRecordingLogger } from './helpers/index.js';

const PROJECT_YAML = `projects:
  - id: baolu
    repo: acme/web
    repoPath: /tmp/repo
    quietPeriodMinutes: 20
    mcp:
      transport: http
      url: https://example.test/mcp
      token: \${MY_TOKEN}
    commands:
      build: npm run build
`;

describe('Bootstrap — 只有「資料放哪」來自環境變數', () => {
  it('預設的資料根目錄是 data/，ledger 與鎖檔掛在它底下', () => {
    const b = loadBootstrap({}, '/base');
    assert.equal(b.dataRoot, '/base/data');
    assert.equal(b.ledgerPath, '/base/data/ledger.db');
    assert.equal(b.lockPath, '/base/data/orchestrator.lock');
    assert.equal(DEFAULT_DATA_ROOT, './data');
  });

  /**
   * 分的是**整個資料目錄**，不是只有資料庫。
   *
   * 原本只有 ledger 與鎖檔分 profile，worktree／合併工作區／截圖／瀏覽器暫存／備份
   * 全部共用——跑一次測試就把 worktree 建進正式那份目錄，事後分不出哪些是真的，
   * 要清理也不敢下手。實跑撞到：正式庫裡躺著一個我為了測試加的專案。
   */
  it('ORCH_PROFILE=test → 整個資料根目錄都不同', () => {
    const b = loadBootstrap({ ORCH_PROFILE: 'test' }, '/base');
    assert.equal(b.profile, 'test');
    assert.equal(b.dataRoot, '/base/data/test');
    assert.equal(b.ledgerPath, '/base/data/test/ledger.db');
    assert.equal(b.lockPath, '/base/data/test/orchestrator.lock');
    assert.equal(TEST_DATA_ROOT, './data/test');
  });

  it('ORCH_DATA_ROOT 可整包指到別處（e2e harness 用）', () => {
    const b = loadBootstrap({ ORCH_DATA_ROOT: '/tmp/x' }, '/base');
    assert.equal(b.dataRoot, '/tmp/x');
    assert.equal(b.ledgerPath, '/tmp/x/ledger.db');
  });

  it('NODE_ENV=test 也算測試（免得忘了設 ORCH_PROFILE 就污染正式庫）', () => {
    assert.equal(profileOf({ NODE_ENV: 'test' }), 'test');
    assert.equal(loadBootstrap({ NODE_ENV: 'test' }, '/base').dataRoot, '/base/data/test');
  });

  it('預設是 prod：忘了設時該落在「不會弄壞測試」那一邊', () => {
    assert.equal(profileOf({}), 'prod');
    assert.equal(profileOf({ ORCH_PROFILE: '  PROD ' }), 'prod');
    assert.equal(profileOf({ ORCH_PROFILE: '亂寫' }), 'prod');
  });

  it('明確指定路徑時優先於 profile（e2e harness 指到自己的暫存目錄）', () => {
    const b = loadBootstrap({ ORCH_PROFILE: 'test', ORCH_LEDGER_PATH: '/tmp/x.db' }, '/base');
    assert.equal(b.ledgerPath, '/tmp/x.db');
  });

  it('環境變數可覆寫，且一律轉成絕對路徑', () => {
    const b = loadBootstrap({ ORCH_LEDGER_PATH: 'x/y.db', ORCH_LOCK_PATH: '/abs/l.lock' }, '/base');
    assert.equal(b.ledgerPath, '/base/x/y.db');
    assert.equal(b.lockPath, '/abs/l.lock');
  });

  it('空字串視為未設（不會變成「基準目錄本身」）', () => {
    assert.equal(loadBootstrap({ ORCH_LEDGER_PATH: '   ' }, '/base').ledgerPath, '/base/data/ledger.db');
    assert.equal(loadBootstrap({ ORCH_DATA_ROOT: '  ' }, '/base').dataRoot, '/base/data');
  });
});

describe('expandEnv — 讀取時展開 ${VAR}', () => {
  it('遞迴展開字串、陣列與物件', () => {
    const out = expandEnv({ a: '${A}', b: ['x', '${B}'], c: { d: 'p-${A}' } }, { A: '1', B: '2' });
    assert.deepEqual(out, { a: '1', b: ['x', '2'], c: { d: 'p-1' } });
  });

  it('缺值展開成空字串（等同未設）', () => {
    assert.deepEqual(expandEnv({ t: '${MISSING}' }, {}), { t: '' });
  });

  it('只認大寫/數字/底線，小寫變數名原字面保留', () => {
    assert.deepEqual(expandEnv({ t: '${lower}' }, { lower: '不該被用到' }), { t: '${lower}' });
  });

  it('非字串原樣通過', () => {
    assert.deepEqual(expandEnv({ n: 5, b: true, z: null }, {}), { n: 5, b: true, z: null });
  });
});

describe('ConfigStore — 設定的唯一事實源', () => {
  let dir: ReturnType<typeof createTmpDir>;
  let store: ConfigStore;

  beforeEach(() => {
    dir = createTmpDir('botone-cfgstore-');
    store = new ConfigStore(join(dir.path, 'data', 'daemon.db'));
  });
  afterEach(() => {
    store.close();
    dir.cleanup();
  });

  it('全新安裝沒有設定 → 回 schema 預設（不是錯誤）', () => {
    assert.equal(store.hasSettings(), false);
    const s = store.settings();
    assert.equal(s.pollIntervalSec, 30);
    assert.equal(s.maxConcurrentWorkers, 3);
    assert.equal(s.slack.enabled, false);
    assert.deepEqual(store.projects(), []);
  });

  it('存了就讀得回來，未指定的欄位仍由 schema 補預設', () => {
    store.saveSettings({ pollIntervalSec: 5 });
    assert.equal(store.settings().pollIntervalSec, 5);
    assert.equal(store.settings().maxConcurrentWorkers, 3, '沒動到的欄位要維持預設');
    assert.equal(store.hasSettings(), true);
  });

  it('局部更新是合併，不是覆寫（改一個欄位不該清掉其他設定）', () => {
    store.saveSettings({ pollIntervalSec: 5, allowLocalMerge: true });
    store.saveSettings({ maxConcurrentWorkers: 4 });
    const s = store.settings();
    assert.equal(s.pollIntervalSec, 5);
    assert.equal(s.allowLocalMerge, true);
    assert.equal(s.maxConcurrentWorkers, 4);
  });

  /**
   * 先驗證再寫是必要的：寫進去才發現不合法的話，下次啟動會死在讀取，
   * 而使用者手上沒有任何工具改得回來——控制台自己也讀不了設定。
   */
  it('不合法的值會被擋下，且不會污染既有設定', () => {
    store.saveSettings({ pollIntervalSec: 15 });
    assert.throws(() => store.saveSettings({ pollIntervalSec: '很快' as unknown as number }));
    assert.equal(store.settings().pollIntervalSec, 15, '失敗的寫入不該改變任何東西');
  });

  it('密鑰以 ${VAR} 存、讀取時才展開；原始值查得回來供編輯', () => {
    store.saveSettings({ slack: { enabled: true, botToken: '${TK}', channel: '#x' } });
    process.env.TK = 'xoxb-real';
    try {
      assert.equal(store.settings().slack.botToken, 'xoxb-real');
      assert.equal((store.rawSettings() as { slack: { botToken: string } }).slack.botToken, '${TK}',
        '編輯畫面要顯示使用者當初填的東西，不是展開後的密鑰');
    } finally {
      delete process.env.TK;
    }
  });

  // ── 專案 ──

  const project = (over: Record<string, unknown> = {}) => ({
    id: 'p1', repo: 'acme/web', repoPath: '/tmp/r',
    mcp: { transport: 'http', url: 'https://x.test', token: 't' },
    commands: { build: 'npm run build' },
    ...over,
  });

  it('新增專案預設啟用，projects() 只回啟用中的', () => {
    store.upsertProject(project());
    assert.deepEqual(store.projects().map((p) => p.id), ['p1']);
    assert.equal(store.allProjects()[0]?.enabled, true);
  });

  it('停用的專案 daemon 看不到，但控制台仍列得出來', () => {
    store.upsertProject(project());
    assert.equal(store.setProjectEnabled('p1', false), true);
    assert.deepEqual(store.projects(), []);
    assert.equal(store.allProjects().length, 1);
    assert.equal(store.allProjects()[0]?.enabled, false);
  });

  it('更新專案不會把停用狀態洗掉', () => {
    store.upsertProject(project());
    store.setProjectEnabled('p1', false);
    store.upsertProject(project({ repoPath: '/tmp/changed' }));
    assert.equal(store.allProjects()[0]?.enabled, false, '沒指定 enabled 時要保留原值');
    assert.equal(store.allProjects()[0]?.config.repoPath, '/tmp/changed');
  });

  it('刪除專案回報有沒有真的刪到', () => {
    store.upsertProject(project());
    assert.equal(store.removeProject('p1'), true);
    assert.equal(store.removeProject('p1'), false);
    assert.equal(store.setProjectEnabled('nope', true), false);
  });

  it('不合法的專案設定會被擋下（缺必填欄位）', () => {
    assert.throws(() => store.upsertProject({ id: 'bad' }));
    assert.deepEqual(store.projects(), []);
  });
});

describe('yaml → DB 一次性遷移', () => {
  let dir: ReturnType<typeof createTmpDir>;
  let store: ConfigStore;

  beforeEach(() => {
    dir = createTmpDir('botone-migrate-cfg-');
    mkdirSync(join(dir.path, 'config'), { recursive: true });
    store = new ConfigStore(join(dir.path, 'data', 'daemon.db'));
  });
  afterEach(() => {
    store.close();
    dir.cleanup();
  });

  const writeYaml = (): void => {
    writeFileSync(join(dir.path, 'config', 'orchestrator.yaml'), 'pollIntervalSec: 15\nslack:\n  enabled: true\n  botToken: ${BOT}\n');
    writeFileSync(join(dir.path, 'config', 'projects.yaml'), PROJECT_YAML);
  };

  it('把 yaml 匯入 DB，並把檔案改名成 .imported', () => {
    writeYaml();
    assert.equal(migrateYamlIfPresent(store, createSilentLogger(), dir.path), true);

    assert.equal(store.settings().pollIntervalSec, 15);
    assert.equal(store.projects()[0]?.id, 'baolu');
    assert.equal(store.projects()[0]?.quietPeriodMinutes, 20);
    assert.equal(existsSync(join(dir.path, 'config', 'orchestrator.yaml')), false);
    assert.equal(existsSync(join(dir.path, 'config', 'orchestrator.yaml.imported')), true);
  });

  /**
   * 這條是實跑撞到的：遷移若存展開後的值，而遷移當下沒載入 .env，
   * token 會靜靜變成空字串——直到 daemon 下次啟動以「連不上 MCP」的形式爆出來。
   */
  it('保留 ${VAR} 字面值，不把密鑰複製進 DB', () => {
    writeYaml();
    migrateYamlIfPresent(store, createSilentLogger(), dir.path); // 刻意不設定 BOT/MY_TOKEN

    const rawProj = store.rawProject('baolu') as { mcp: { token: string } };
    assert.equal(rawProj.mcp.token, '${MY_TOKEN}');
    assert.equal((store.rawSettings() as { slack: { botToken: string } }).slack.botToken, '${BOT}');

    process.env.MY_TOKEN = 'secret-123';
    try {
      assert.equal(store.projects()[0]?.mcp.token, 'secret-123', '讀取時才展開');
    } finally {
      delete process.env.MY_TOKEN;
    }
  });

  /**
   * 每次啟動都重匯的話，yaml 會把使用者在控制台改的東西蓋回去——
   * 而且是靜默的，使用者只會看到「我改的又跑掉了」。
   */
  it('DB 已有設定就不再匯入（避免蓋掉控制台的修改）', () => {
    store.saveSettings({ pollIntervalSec: 99 });
    writeYaml();

    assert.equal(migrateYamlIfPresent(store, createSilentLogger(), dir.path), false);

    assert.equal(store.settings().pollIntervalSec, 99);
    assert.equal(existsSync(join(dir.path, 'config', 'orchestrator.yaml')), true, '沒匯入就不該動檔案');
  });

  it('沒有 yaml 就什麼都不做（全新安裝的正常路徑）', () => {
    assert.equal(migrateYamlIfPresent(store, createSilentLogger(), dir.path), false);
    assert.equal(store.hasSettings(), false);
  });

  it('改名失敗只留 warn，設定仍算匯入成功', () => {
    writeYaml();
    const rec = createRecordingLogger();
    // 先佔住目標檔名為目錄 → rename 必失敗
    mkdirSync(join(dir.path, 'config', 'orchestrator.yaml.imported'), { recursive: true });
    writeFileSync(join(dir.path, 'config', 'orchestrator.yaml.imported', 'x'), '1');

    assert.equal(migrateYamlIfPresent(store, rec.logger, dir.path), true);
    assert.equal(store.settings().pollIntervalSec, 15);
    assert.ok(rec.messages('warn').some((m) => m.includes('yaml 改名失敗')));
  });
});
