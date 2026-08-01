// 測試工具自身的煙霧測試：helpers 被所有測試依賴，壞掉時要在這裡先炸，
// 而不是讓其他測試檔出現一堆難以歸因的紅燈。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRecordingLogger, createSilentLogger, createTmpDir, createTmpGitRepo, withEnv } from './helpers/index.js';

test('createTmpDir：write 會自動建父目錄，cleanup 會整個刪掉', () => {
  const dir = createTmpDir();
  const abs = dir.write('a/b/c.txt', 'hi');
  assert.equal(readFileSync(abs, 'utf8'), 'hi');
  assert.equal(abs, dir.join('a/b/c.txt'));

  dir.cleanup();
  assert.equal(existsSync(dir.path), false);
});

test('withEnv：可設定與刪除變數，還原後回到原狀', () => {
  process.env.HELPER_KEEP = '原值';
  delete process.env.HELPER_ABSENT;

  const restore = withEnv({ HELPER_KEEP: '暫時值', HELPER_ABSENT: '新增', HELPER_DELETE_ME: undefined });
  assert.equal(process.env.HELPER_KEEP, '暫時值');
  assert.equal(process.env.HELPER_ABSENT, '新增');

  restore();
  assert.equal(process.env.HELPER_KEEP, '原值');
  assert.equal('HELPER_ABSENT' in process.env, false, '原本不存在的變數還原後應被刪掉');
  delete process.env.HELPER_KEEP;
});

test('createSilentLogger：可當 Logger 用且不輸出', () => {
  const log = createSilentLogger();
  assert.doesNotThrow(() => {
    log.debug({ a: 1 }, 'debug');
    log.info('info');
    log.warn({ b: 2 }, 'warn');
    log.error(new Error('boom'), 'error');
  });
});

test('createRecordingLogger：記下訊息與欄位，供斷言「有沒有記到某件事」', () => {
  const rec = createRecordingLogger();
  rec.logger.debug('細節');
  rec.logger.warn({ taskId: 'T-1' }, '政策閘門擋下工具呼叫');

  assert.deepEqual(rec.messages(), ['細節', '政策閘門擋下工具呼叫']);
  assert.deepEqual(rec.messages('warn'), ['政策閘門擋下工具呼叫']);
  assert.equal(rec.records[1]?.taskId, 'T-1');
});

test('createTmpGitRepo：初始化在指定分支且已有一個 commit', (t) => {
  const repo = createTmpGitRepo({ files: { 'src/a.ts': 'export const a = 1;\n' }, branch: 'main' });
  t.after(() => repo.cleanup());

  assert.equal(repo.branch(), 'main');
  assert.match(repo.head(), /^[0-9a-f]{40}$/);
  assert.equal(repo.git('status', '--porcelain'), '', '初始 commit 後工作區應乾淨');
  assert.equal(readFileSync(repo.dir.join('src/a.ts'), 'utf8'), 'export const a = 1;\n');
});

test('createTmpGitRepo：commit() 會產生新 commit 並保持工作區乾淨', (t) => {
  const repo = createTmpGitRepo();
  t.after(() => repo.cleanup());

  const first = repo.head();
  const second = repo.commit({ 'src/b.ts': 'export const b = 2;\n' }, 'feat: 加 b');

  assert.notEqual(first, second);
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.equal(repo.git('rev-list', '--count', 'HEAD'), '2');
  assert.match(repo.git('log', '-1', '--pretty=%s'), /feat: 加 b/);
  assert.match(repo.git('show', '--stat', '--oneline', 'HEAD'), /src\/b\.ts/);
});

test('createTmpGitRepo：未 commit 的變更會出現在 status（供 diff/髒工作區測試）', (t) => {
  const repo = createTmpGitRepo();
  t.after(() => repo.cleanup());

  repo.dir.write('dirty.txt', 'x');
  assert.match(repo.git('status', '--porcelain'), /dirty\.txt/);
});
