import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadEnv } from '../src/config/env.js';
import { gitDiffHash, workingTreeChanged } from '../src/git/status.js';
import { createTmpDir, createTmpGitRepo } from './helpers/index.js';

const KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] as const;

describe('loadEnv — Claude 認證方式判定', () => {
  const saved = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
  });
  const clear = (): void => {
    for (const k of KEYS) { saved.set(k, process.env[k]); delete process.env[k]; }
  };

  it('沒有任何認證 → none', () => {
    clear();
    assert.equal(loadEnv(join(createTmpDir('env-none-').path, '.env')).method, 'none');
  });

  /** auth_token 要優先於 api_key：兩個都設時，自訂端點用的是前者。 */
  it('auth token 優先於 api key', () => {
    clear();
    process.env.ANTHROPIC_AUTH_TOKEN = 't';
    process.env.ANTHROPIC_API_KEY = 'k';
    assert.equal(loadEnv(join(createTmpDir('env-both-').path, '.env')).method, 'auth_token');
  });

  it('只有 api key → api_key', () => {
    clear();
    process.env.ANTHROPIC_API_KEY = 'k';
    assert.equal(loadEnv(join(createTmpDir('env-key-').path, '.env')).method, 'api_key');
  });

  it('會把 .env 讀進 process.env，並回報 baseUrl', () => {
    clear();
    const dir = createTmpDir('env-file-');
    const f = join(dir.path, '.env');
    writeFileSync(f, 'ANTHROPIC_AUTH_TOKEN=from-file\nANTHROPIC_BASE_URL=https://x.test\n');
    const r = loadEnv(f);
    assert.equal(r.method, 'auth_token');
    assert.equal(r.baseUrl, 'https://x.test');
    assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'from-file');
  });

  /** dotenv 不覆蓋既有值：launchd/export 設的優先，否則部署設定會被檔案偷偷蓋掉。 */
  it('已存在的環境變數不會被 .env 覆蓋', () => {
    clear();
    process.env.ANTHROPIC_AUTH_TOKEN = '外部注入的';
    const dir = createTmpDir('env-prio-');
    const f = join(dir.path, '.env');
    writeFileSync(f, 'ANTHROPIC_AUTH_TOKEN=檔案裡的\n');
    loadEnv(f);
    assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, '外部注入的');
  });
});

describe('git status 輔助', () => {
  /**
   * 這條抓到過真的 bug：porcelain 對未追蹤檔案只印檔名，`git diff HEAD` 又看不到它們，
   * 所以「agent 新建檔案、之後每輪都在改」會得到一樣的簽章 → 正在做事的任務被判卡住。
   */
  it('相同內容 → 相同 hash；改了就變（無進展偵測靠它）', async () => {
    const repo = createTmpGitRepo();
    try {
      writeFileSync(join(repo.path, 'a.txt'), 'one');
      const h1 = await gitDiffHash(repo.path);
      const h2 = await gitDiffHash(repo.path);
      assert.equal(h1, h2, '同樣的工作區狀態要得到同樣的簽章');

      writeFileSync(join(repo.path, 'a.txt'), 'two');
      assert.notEqual(await gitDiffHash(repo.path), h1);
    } finally { repo.cleanup(); }
  });

  it('乾淨的工作區也有穩定簽章（不是 undefined）', async () => {
    const repo = createTmpGitRepo();
    try {
      const h = await gitDiffHash(repo.path);
      assert.equal(typeof h, 'string');
      assert.equal(await gitDiffHash(repo.path), h);
    } finally { repo.cleanup(); }
  });

  it('不是 git repo → 不擲錯（呼叫端會退回其他判斷）', async () => {
    const dir = createTmpDir('not-a-repo-');
    try {
      await assert.doesNotReject(() => gitDiffHash(dir.path));
    } finally { dir.cleanup(); }
  });

  /** DoD 的「diff 非空」關卡靠它：判錯的話，什麼都沒做的 agent 會被判完成。 */
  it('workingTreeChanged：乾淨=false，有未追蹤檔案=true', async () => {
    const repo = createTmpGitRepo();
    try {
      assert.equal(await workingTreeChanged(repo.path), false, '乾淨的工作區不能算有變更');
      mkdirSync(join(repo.path, 'src'), { recursive: true });
      writeFileSync(join(repo.path, 'src', 'new.ts'), 'export const x = 1;');
      assert.equal(await workingTreeChanged(repo.path), true, '未追蹤的新檔案也算變更');
    } finally { repo.cleanup(); }
  });

  it('workingTreeChanged：改動既有檔案也算', async () => {
    const repo = createTmpGitRepo();
    try {
      writeFileSync(join(repo.path, 'README.md'), '改過了');
      assert.equal(await workingTreeChanged(repo.path), true);
    } finally { repo.cleanup(); }
  });
});
