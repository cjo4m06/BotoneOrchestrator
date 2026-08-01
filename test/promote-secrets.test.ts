import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { ConfigStore } from '../src/config/store.js';
import { promoteSecrets, envRef } from '../src/config/promote-secrets.js';
import { agentAuthEnv, buildAgentEnv } from '../src/worker/agent-runtime.js';
import { createTmpDir, createRecordingLogger } from './helpers/index.js';

describe('envRef — 只認純粹的 ${VAR} 參照', () => {
  it('純參照才算', () => {
    assert.equal(envRef('${MY_TOKEN}'), 'MY_TOKEN');
    assert.equal(envRef('  ${A_B1}  '), 'A_B1');
  });

  /** 混在字串中間的多半是刻意組出來的（例如 URL），動它會改壞使用者的設定。 */
  it('混在字串中間的不動', () => {
    assert.equal(envRef('prefix-${A}'), undefined);
    assert.equal(envRef('${A}${B}'), undefined);
    assert.equal(envRef('${lower}'), undefined, '小寫不是環境變數語法');
    assert.equal(envRef('xoxb-real-token'), undefined);
    assert.equal(envRef(42), undefined);
  });
});

describe('把 ${VAR} 搬進資料庫', () => {
  let dir: ReturnType<typeof createTmpDir>;
  let store: ConfigStore;

  beforeEach(() => {
    dir = createTmpDir('botone-promote-');
    store = new ConfigStore(join(dir.path, 'daemon.db'));
  });
  afterEach(() => { store.close(); dir.cleanup(); });

  const project = (token: string) => ({
    id: 'p1', repo: 'a/b', repoPath: '/tmp/r',
    mcp: { transport: 'http', url: 'https://x.test', token },
    commands: {},
  });

  it('解析得出值 → 寫死進 DB，之後不再需要環境變數', () => {
    store.saveSettings({ slack: { enabled: true, botToken: '${BOT}', appToken: '${APP}' } });
    store.upsertProject(project('${MCP}'));

    const r = promoteSecrets(store, createRecordingLogger().logger, { BOT: 'xoxb-1', APP: 'xapp-2', MCP: 'tok-3' });

    assert.deepEqual(r.settings, ['slack.botToken', 'slack.appToken']);
    assert.deepEqual(r.projects, ['p1']);
    const raw = store.rawSettings() as { slack: { botToken: string; appToken: string } };
    assert.equal(raw.slack.botToken, 'xoxb-1');
    assert.equal(raw.slack.appToken, 'xapp-2');
    assert.equal((store.rawProject('p1') as { mcp: { token: string } }).mcp.token, 'tok-3');
  });

  /**
   * 用空字串蓋掉一個 token，症狀會是「daemon 起來了但每次都 401」——
   * 比留著 ${VAR} 參照難查得多。所以解析不出來就維持原樣並點名。
   */
  it('環境變數沒有值 → 維持原樣並列進 unresolved', () => {
    store.saveSettings({ slack: { botToken: '${MISSING}' } });
    const rec = createRecordingLogger();

    const r = promoteSecrets(store, rec.logger, {});

    assert.deepEqual(r.settings, []);
    assert.deepEqual(r.unresolved, ['slack.botToken = ${MISSING}']);
    assert.equal((store.rawSettings() as { slack: { botToken: string } }).slack.botToken, '${MISSING}');
    assert.ok(rec.messages('warn').some((m) => m.includes('維持 ${VAR} 參照')));
  });

  it('已經是字面值就什麼都不做（可重複執行）', () => {
    store.saveSettings({ slack: { botToken: 'xoxb-literal' } });
    const r = promoteSecrets(store, createRecordingLogger().logger, { BOT: 'x' });
    assert.deepEqual(r, { settings: [], projects: [], unresolved: [] });
    assert.equal((store.rawSettings() as { slack: { botToken: string } }).slack.botToken, 'xoxb-literal');
  });

  it('搬移不會動到其他設定，也不會改變停用狀態', () => {
    store.saveSettings({ pollIntervalSec: 42, slack: { botToken: '${BOT}' } });
    store.upsertProject(project('${MCP}'));
    store.setProjectEnabled('p1', false);

    promoteSecrets(store, createRecordingLogger().logger, { BOT: 'b', MCP: 'm' });

    assert.equal(store.settings().pollIntervalSec, 42);
    assert.equal(store.allProjects()[0]?.enabled, false, '停用狀態不可被搬移洗掉');
  });
});

describe('Claude 認證從設定注入 agent 子行程', () => {
  it('設定有值 → 覆寫行程環境（換 token 不必重啟）', () => {
    const env = buildAgentEnv(
      { ANTHROPIC_AUTH_TOKEN: '舊的', PATH: '/usr/bin' },
      agentAuthEnv({ authToken: '新的', baseUrl: 'https://x.test' }),
    );
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, '新的');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://x.test');
    assert.equal(env.PATH, '/usr/bin', '其他環境變數要原樣傳下去');
  });

  /** 用空字串覆寫會讓原本可用的認證失效——症狀是每次執行都 401。 */
  it('設定留空 → 不覆寫，沿用行程環境', () => {
    const env = buildAgentEnv({ ANTHROPIC_AUTH_TOKEN: '原本的' }, agentAuthEnv({ authToken: '', baseUrl: '   ' }));
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, '原本的');
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  });

  it('沒有覆寫時行為與原本完全相同（GitHub 認證仍被剝掉）', () => {
    const env = buildAgentEnv({ ANTHROPIC_AUTH_TOKEN: 'x', GH_TOKEN: '不該傳', GITHUB_TOKEN: '也不該' });
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'x');
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
  });
});
