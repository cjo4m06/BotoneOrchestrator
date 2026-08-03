// loadConfig 已不是執行期路徑：設定的事實源是 SQLite（config/store.ts）。
// 這裡的測試涵蓋的是 yaml→DB 一次性遷移會用到的解析行為（見 config-store.test.ts）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createTmpDir, withEnv } from './helpers/index.js';

/** 準備一個只含 config/ 的暫存 baseDir。 */
function setup(t: { after(fn: () => void): void }, files: Partial<Record<'orchestrator' | 'projects', string>> = {}) {
  const dir = createTmpDir('botone-config-');
  t.after(() => dir.cleanup());
  if (files.orchestrator !== undefined) dir.write('config/orchestrator.yaml', files.orchestrator);
  if (files.projects !== undefined) dir.write('config/projects.yaml', files.projects);
  return dir;
}

// ── 缺檔 / 預設值 ──

test('兩個設定檔都不存在時退回 schema 預設，且 projects 為空（骨架仍可啟動）', (t) => {
  const dir = setup(t);
  const cfg = loadConfig(dir.path);

  assert.deepEqual(cfg.projects, []);
  assert.equal(cfg.orchestrator.pollIntervalSec, 30);
  assert.equal(cfg.orchestrator.maxConcurrentWorkers, 3);
  assert.equal(cfg.orchestrator.noProgress.rounds, 3);
  assert.equal(cfg.orchestrator.slack.enabled, false);
  assert.equal(cfg.orchestrator.slack.channel, '#dev-orchestrator');
  assert.equal(cfg.orchestrator.github.token, undefined);
  assert.equal(cfg.orchestrator.shutdownGraceSec, 120);
  assert.equal(cfg.orchestrator.shutdownForceExitSec, 15);
  assert.equal(
    cfg.orchestrator.reconcileAfterUncleanShutdown,
    'conservative',
    '上次沒收乾淨時必須預設保守：worktree 可能還有 orphan 的 agent 在寫',
  );
  assert.equal(cfg.orchestrator.poll.mine, true, '預設只領指派給自己的任務');
  assert.equal(cfg.orchestrator.allowLocalMerge, false, '不可逆的動作預設必須關閉');
  assert.equal(cfg.orchestrator.allowLocalMerge, false, '外部副作用預設必須關閉');
  assert.equal(cfg.orchestrator.commandTimeoutSec, 600, 'DoD 指令逾時要有全域預設，否則 hang 住的 build 會凍住整個 daemon');
});

test('commandTimeoutSec：全域可調、每專案可覆寫（慢專案不該每輪被判逾時紅燈）', (t) => {
  const dir = setup(t, {
    orchestrator: 'commandTimeoutSec: 900\n',
    projects: [
      'projects:',
      '  - id: mono',
      '    repo: acme/mono',
      '    repoPath: /tmp/mono',
      '    commandTimeoutSec: 3600',
      '    mcp:',
      '      command: node',
      '',
    ].join('\n'),
  });
  const cfg = loadConfig(dir.path);
  assert.equal(cfg.orchestrator.commandTimeoutSec, 900);
  assert.equal(cfg.projects[0]?.commandTimeoutSec, 3600);
});

test('未設 commandTimeoutSec 的專案為 undefined（沿用全域，不在 schema 硬填）', (t) => {
  const dir = setup(t, {
    projects: ['projects:', '  - id: web', '    repo: acme/web', '    repoPath: /tmp/web', '    mcp:', '      command: node', ''].join('\n'),
  });
  assert.equal(loadConfig(dir.path).projects[0]?.commandTimeoutSec, undefined);
});

test('allowLocalMerge / poll.mine 可由設定開關（不再只能靠環境變數）', (t) => {
  const dir = setup(t, { orchestrator: 'allowLocalMerge: true\npoll:\n  mine: false\n' });
  const cfg = loadConfig(dir.path);
  assert.equal(cfg.orchestrator.allowLocalMerge, true);
  assert.equal(cfg.orchestrator.poll.mine, false);
});

test('停止行為可由設定調整（逾時後的處置必須是設定得到、寫得清楚的）', (t) => {
  const dir = setup(t, {
    orchestrator: 'shutdownGraceSec: 600\nshutdownForceExitSec: 0\nreconcileAfterUncleanShutdown: full\n',
  });
  const cfg = loadConfig(dir.path);
  assert.equal(cfg.orchestrator.shutdownGraceSec, 600);
  assert.equal(cfg.orchestrator.shutdownForceExitSec, 0, '0 = 不強制退出，等 launchd 的 SIGKILL');
  assert.equal(cfg.orchestrator.reconcileAfterUncleanShutdown, 'full');
});

test('reconcileAfterUncleanShutdown 只接受 conservative/full（打錯字不可靜默變成預設）', (t) => {
  const dir = setup(t, { orchestrator: 'reconcileAfterUncleanShutdown: yolo\n' });
  assert.throws(() => loadConfig(dir.path));
});

test('prefault：巢狀物件整段缺席時仍套用內層預設', (t) => {
  const dir = setup(t, { orchestrator: 'pollIntervalSec: 5\n' });
  const cfg = loadConfig(dir.path);
  assert.equal(cfg.orchestrator.pollIntervalSec, 5);
  assert.equal(cfg.orchestrator.noProgress.rounds, 3, 'noProgress 未出現在 YAML 也要有 rounds 預設');
  assert.equal(cfg.orchestrator.slack.channel, '#dev-orchestrator');
});

test('prefault：巢狀物件只填一半時，其餘欄位補預設', (t) => {
  const dir = setup(t, { orchestrator: 'slack:\n  enabled: true\n  botToken: xoxb-abc\n' });
  const cfg = loadConfig(dir.path);
  assert.equal(cfg.orchestrator.slack.enabled, true);
  assert.equal(cfg.orchestrator.slack.botToken, 'xoxb-abc');
  assert.equal(cfg.orchestrator.slack.channel, '#dev-orchestrator');
  assert.equal(cfg.orchestrator.slack.appToken, undefined);
});

// ── 環境變數展開 ──

test('${VAR} 會以環境變數展開', (t) => {
  const dir = setup(t, { orchestrator: 'github:\n  token: ${TEST_GH_TOKEN}\n' });
  const restore = withEnv({ TEST_GH_TOKEN: 'ghp_secret' });
  t.after(restore);

  assert.equal(loadConfig(dir.path).orchestrator.github.token, 'ghp_secret');
});

test('${MISSING} 展成空字串 → YAML 變 null → 被 stripNulls 移除 → 視為未設定', (t) => {
  const dir = setup(t, { orchestrator: 'github:\n  token: ${TEST_ABSENT_TOKEN}\n' });
  const restore = withEnv({ TEST_ABSENT_TOKEN: undefined });
  t.after(restore);

  const cfg = loadConfig(dir.path);
  assert.equal(cfg.orchestrator.github.token, undefined, '缺值不可變成空字串，否則下游會誤判「有 token」');
});

test('stripNulls 只清 null，不清空字串：加引號的 "${MISSING}" 會留下空字串', (t) => {
  const dir = setup(t, { orchestrator: 'github:\n  token: "${TEST_ABSENT_TOKEN}"\n' });
  const restore = withEnv({ TEST_ABSENT_TOKEN: undefined });
  t.after(restore);

  assert.equal(loadConfig(dir.path).orchestrator.github.token, '', 'YAML 引號會擋掉 null 轉換，設定檔請勿對可選密鑰加引號');
});

test('展開只認大寫/底線/數字的變數名，小寫 ${var} 原字面保留', (t) => {
  const dir = setup(t, { orchestrator: 'slack:\n  channel: "#${lower_case}"\n' });
  const restore = withEnv({ lower_case: '不該被用到' });
  t.after(restore);

  assert.equal(loadConfig(dir.path).orchestrator.slack.channel, '#${lower_case}');
});

test('陣列元素內的 ${VAR} 也會展開', (t) => {
  const dir = setup(t, {
    projects: [
      'projects:',
      '  - id: web',
      '    repo: acme/web',
      '    repoPath: /tmp/web',
      '    mcp:',
      '      transport: stdio',
      '      command: node',
      '      args: ["${TEST_MCP_ENTRY}", "--stdio"]',
      '',
    ].join('\n'),
  });
  const restore = withEnv({ TEST_MCP_ENTRY: '/srv/mcp.js' });
  t.after(restore);

  const p = loadConfig(dir.path).projects[0];
  assert.deepEqual(p?.mcp.args, ['/srv/mcp.js', '--stdio']);
});

test('stripNulls 會遞迴進陣列內的物件', (t) => {
  const dir = setup(t, {
    projects: [
      'projects:',
      '  - id: web',
      '    repo: acme/web',
      '    repoPath: /tmp/web',
      '    mcp:',
      '      transport: http',
      '      url: https://example.test/mcp',
      '      token: ${TEST_ABSENT_TOKEN}',
      '',
    ].join('\n'),
  });
  const restore = withEnv({ TEST_ABSENT_TOKEN: undefined });
  t.after(restore);

  const p = loadConfig(dir.path).projects[0];
  assert.equal(p?.mcp.url, 'https://example.test/mcp');
  assert.equal(p?.mcp.token, undefined);
});

// ── projects.yaml ──

test('完整專案設定可解析；commands / baseBranch 缺席時套預設', (t) => {
  const dir = setup(t, {
    projects: [
      'projects:',
      '  - id: web',
      '    repo: acme/web',
      '    repoPath: /tmp/web',
      '    mcp:',
      '      transport: stdio',
      '      command: node',
      '',
    ].join('\n'),
  });
  const cfg = loadConfig(dir.path);
  assert.equal(cfg.projects.length, 1);
  const p = cfg.projects[0]!;
  assert.equal(p.id, 'web');
  assert.equal(p.repo, 'acme/web');
  assert.equal(p.mcp.transport, 'stdio');
  assert.deepEqual(p.commands, {}, 'commands 全為 optional，缺席時是空物件而非 undefined');
  assert.equal(p.baseBranch, undefined, '未設 → 由 main.ts 偵測，不在 schema 硬寫 main');
  assert.equal(p.pollMine, undefined);
});

test('commands.typecheck 可設定（DoD 的 typecheck 關卡靠它才跑得起來）', (t) => {
  const dir = setup(t, {
    projects: [
      'projects:',
      '  - id: web',
      '    repo: acme/web',
      '    repoPath: /tmp/web',
      '    mcp:',
      '      command: node',
      '    commands:',
      '      typecheck: npm run typecheck',
      '      test: npm test',
      '',
    ].join('\n'),
  });
  const p = loadConfig(dir.path).projects[0]!;
  assert.equal(p.commands.typecheck, 'npm run typecheck');
  assert.equal(p.commands.test, 'npm test');
});

test('baseBranch / pollMine 可逐專案覆寫', (t) => {
  const dir = setup(t, {
    projects: [
      'projects:',
      '  - id: legacy',
      '    repo: acme/legacy',
      '    repoPath: /tmp/legacy',
      '    baseBranch: develop',
      '    pollMine: false',
      '    mcp:',
      '      command: node',
      '',
    ].join('\n'),
  });
  const p = loadConfig(dir.path).projects[0]!;
  assert.equal(p.baseBranch, 'develop');
  assert.equal(p.pollMine, false);
});

test('已移除的欄位（commands.install / reviewers）出現在 yaml 也只是被忽略，不會炸掉舊設定', (t) => {
  const dir = setup(t, {
    projects: [
      'projects:',
      '  - id: web',
      '    repo: acme/web',
      '    repoPath: /tmp/web',
      '    reviewers: ["alice"]',
      '    mcp:',
      '      command: node',
      '    commands:',
      '      install: npm ci',
      '',
    ].join('\n'),
  });
  const p = loadConfig(dir.path).projects[0]!;
  assert.deepEqual(Object.keys(p.commands), [], '沒人讀的設定不該留在 schema 裡誤導使用者');
  assert.equal('reviewers' in p, false);
});

test('mcp.transport 未指定時預設 stdio；不合法值會被拒', (t) => {
  const base = (transport: string) =>
    ['projects:', '  - id: web', '    repo: acme/web', '    repoPath: /tmp/web', '    mcp:', transport, ''].join('\n');

  const ok = setup(t, { projects: base('      command: node') });
  assert.equal(loadConfig(ok.path).projects[0]?.mcp.transport, 'stdio');

  const bad = setup(t, { projects: base('      transport: carrier-pigeon') });
  assert.throws(() => loadConfig(bad.path));
});

// 這三個組合以前都是「解析成功但 daemon 靜默略過該專案」→ 使用者得到空轉的 daemon。
test('stdio 缺 command / http 缺 url / sse 尚未支援 → 設定期就丟出清楚錯誤', (t) => {
  const proj = (mcp: string[]) =>
    ['projects:', '  - id: web', '    repo: acme/web', '    repoPath: /tmp/web', '    mcp:', ...mcp, ''].join('\n');

  const noCommand = setup(t, { projects: proj(['      transport: stdio']) });
  assert.throws(
    () => loadConfig(noCommand.path),
    (e: unknown) => e instanceof Error && /mcp\.command/.test(String(e)),
  );

  const noUrl = setup(t, { projects: proj(['      transport: http']) });
  assert.throws(
    () => loadConfig(noUrl.path),
    (e: unknown) => e instanceof Error && /mcp\.url/.test(String(e)),
  );

  const sse = setup(t, { projects: proj(['      transport: sse', '      url: https://example.test/mcp']) });
  assert.throws(
    () => loadConfig(sse.path),
    (e: unknown) => e instanceof Error && /尚未支援 sse/.test(String(e)),
  );
});

test('缺必要欄位的專案會直接丟錯（設定錯誤不該靜默略過）', (t) => {
  const dir = setup(t, {
    projects: ['projects:', '  - id: web', '    repoPath: /tmp/web', '    mcp:', '      command: node', ''].join('\n'),
  });
  assert.throws(() => loadConfig(dir.path), (e: unknown) => e instanceof Error && /repo/.test(String(e)));
});

test('projects.yaml 存在但沒有 projects 鍵 / 為空檔時，視為零專案', (t) => {
  const empty = setup(t, { projects: '' });
  assert.deepEqual(loadConfig(empty.path).projects, []);

  const noKey = setup(t, { projects: '# 只有註解\nsomethingElse: 1\n' });
  assert.deepEqual(loadConfig(noKey.path).projects, []);
});

test('orchestrator.yaml 缺席但 projects.yaml 存在時，兩者各自獨立載入', (t) => {
  const dir = setup(t, {
    projects: ['projects:', '  - id: api', '    repo: acme/api', '    repoPath: /tmp/api', '    mcp:', '      command: node', ''].join(
      '\n',
    ),
  });
  const cfg = loadConfig(dir.path);
  assert.equal(cfg.orchestrator.pollIntervalSec, 30);
  assert.equal(cfg.projects[0]?.id, 'api');
});

test('多個專案依 YAML 順序保留', (t) => {
  const dir = setup(t, {
    projects: [
      'projects:',
      '  - id: web',
      '    repo: acme/web',
      '    repoPath: /tmp/web',
      '    mcp:',
      '      command: node',
      '  - id: api',
      '    repo: acme/api',
      '    repoPath: /tmp/api',
      '    mcp:',
      '      command: node',
      '',
    ].join('\n'),
  });
  assert.deepEqual(
    loadConfig(dir.path).projects.map((p) => p.id),
    ['web', 'api'],
  );
});

test('型別不符（字串放到數字欄位）會丟錯', (t) => {
  const dir = setup(t, { orchestrator: 'pollIntervalSec: "很快"\n' });
  assert.throws(() => loadConfig(dir.path));
});

/**
 * 模型別名**刻意不接受版本號**：寫 opus 就永遠是最新的 opus。
 * 寫 claude-opus-5 的話出了新版還會停在舊的，而且沒有任何地方會提醒你——
 * 那正是這個系統一直在修的那種「靜默地停在錯的狀態」。
 */
test('各角色的模型：只收別名，不收版本號', (t) => {
  const dir = setup(t, {
    orchestrator: 'agent:\n  models:\n    coder: opus\n    riskJudge: haiku\n',
  });
  const cfg = loadConfig(dir.path);
  assert.equal(cfg.orchestrator.agent.models.coder, 'opus');
  assert.equal(cfg.orchestrator.agent.models.riskJudge, 'haiku');
  assert.equal(cfg.orchestrator.agent.models.reviewer, undefined, '沒設的角色維持 SDK 預設');
});

test('帶版本號的模型名被拒絕（否則會靜靜停在舊模型上）', (t) => {
  const dir = setup(t, { orchestrator: 'agent:\n  models:\n    coder: claude-opus-5\n' });
  assert.throws(() => loadConfig(dir.path), /coder|models|invalid|Invalid/i);
});

test('沒設 models → 全部 undefined（走 SDK 預設，行為與先前一致）', (t) => {
  const cfg = loadConfig(setup(t, {}).path);
  assert.deepEqual(cfg.orchestrator.agent.models, {});
});
