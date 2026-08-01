import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execaSync } from 'execa';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorktreeManager } from '../src/git/worktree.js';
import { createRecordingLogger, createTmpDir, createTmpGitRepo, type RecordingLogger, type TmpDir, type TmpGitRepo } from './helpers/index.js';

/**
 * WorktreeManager 用真實 git 驗證（不 mock）：這裡要保證的正是「git 真的怎麼反應」——
 * 目錄已存在、登記殘留、分支不符，這些行為 mock 不出來也就驗不到。
 */
describe('WorktreeManager', () => {
  let repo: TmpGitRepo;
  let base: TmpDir;
  let rec: RecordingLogger;
  let wm: WorktreeManager;

  beforeEach(() => {
    repo = createTmpGitRepo();
    base = createTmpDir('botone-wt-');
    rec = createRecordingLogger();
    wm = new WorktreeManager(base.path, rec.logger);
  });

  afterEach(() => {
    // worktree 會在 repo 內留登記，先讓 git 自己清，避免暫存目錄殘留
    try {
      execaSync('git', ['-C', repo.path, 'worktree', 'prune']);
    } catch {
      /* 清理失敗不影響測試結論 */
    }
    base.cleanup();
    repo.cleanup();
  });

  const wtPath = (branch: string): string => join(base.path, branch.replace(/[^a-zA-Z0-9._-]/g, '-'));

  it('建立新分支的 worktree：目錄存在且停在該分支', async () => {
    const info = await wm.create(repo.path, 'feat/g1', { base: 'main' });

    assert.equal(info.branch, 'feat/g1');
    assert.equal(info.path, wtPath('feat/g1'));
    assert.ok(existsSync(info.path));
    assert.equal(execaSync('git', ['-C', info.path, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'feat/g1');
  });

  // ── 冪等：park 的群恢復時會再呼叫一次 create ──

  it('同分支重複 create → 沿用既有 worktree，agent 未提交的成果不會遺失', async () => {
    const first = await wm.create(repo.path, 'feat/g1', { base: 'main' });
    // 模擬 agent 寫到一半被 park：未提交的變更留在 worktree
    writeFileSync(join(first.path, 'wip.txt'), '未提交的成果', 'utf8');

    const second = await wm.create(repo.path, 'feat/g1', { base: 'main' });

    assert.equal(second.path, first.path);
    assert.equal(second.branch, 'feat/g1');
    assert.equal(readFileSync(join(first.path, 'wip.txt'), 'utf8'), '未提交的成果', '未提交的成果必須原封不動');
    assert.ok(rec.messages('info').some((m) => m.includes('沿用既有 worktree')));
  });

  it('沿用時分支仍然正確（不是隨便回一個路徑就算數）', async () => {
    await wm.create(repo.path, 'feat/g1', { base: 'main' });
    const again = await wm.create(repo.path, 'feat/g1', { base: 'main' });

    assert.equal(execaSync('git', ['-C', again.path, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'feat/g1');
  });

  it('既有 worktree 停在別的分支 → 擲錯，絕不沿用（否則會寫進錯的分支）', async () => {
    const info = await wm.create(repo.path, 'feat/g1', { base: 'main' });
    execaSync('git', ['-C', info.path, 'checkout', '-q', '-b', 'someone-else']);

    await assert.rejects(
      () => wm.create(repo.path, 'feat/g1', { base: 'main' }),
      /位於分支/,
    );
    assert.ok(existsSync(info.path), '擲錯時不可自動刪掉目錄（裡面可能有未提交的成果）');
  });

  it('目錄存在但不是本 repo 的 worktree（殘骸）→ 擲錯且不刪目錄', async () => {
    const path = wtPath('feat/g1');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'keep.txt'), '別人的東西', 'utf8');

    await assert.rejects(() => wm.create(repo.path, 'feat/g1', { base: 'main' }), /不是.*登記的 worktree/s);
    assert.equal(readFileSync(join(path, 'keep.txt'), 'utf8'), '別人的東西');
  });

  it('有登記但目錄被手動刪掉 → prune 後照常重建（不因 already registered 卡死）', async () => {
    const info = await wm.create(repo.path, 'feat/g1', { base: 'main' });
    rmSync(info.path, { recursive: true, force: true });

    const again = await wm.create(repo.path, 'feat/g1', { base: 'main' });

    assert.equal(again.path, info.path);
    assert.ok(existsSync(again.path));
    assert.ok(rec.messages('warn').some((m) => m.includes('目錄不存在')));
  });

  it('分支已存在（上一輪的成果已 commit）→ 掛上既有分支而非重建', async () => {
    const info = await wm.create(repo.path, 'feat/g1', { base: 'main' });
    writeFileSync(join(info.path, 'done.txt'), 'ok', 'utf8');
    execaSync('git', ['-C', info.path, 'add', '-A']);
    execaSync('git', ['-C', info.path, 'commit', '-q', '-m', 'feat: 第一輪'], {
      env: { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.tw', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.tw' },
      extendEnv: true,
    });
    await wm.remove(repo.path, info.path);

    const again = await wm.create(repo.path, 'feat/g1', { base: 'main' });

    assert.ok(existsSync(join(again.path, 'done.txt')), '應掛回既有分支，上一輪已提交的成果要在');
  });

  // ── list / remove ──

  it('list 回報所有 worktree（含主工作區）與其分支', async () => {
    await wm.create(repo.path, 'feat/g1', { base: 'main' });
    const list = await wm.list(repo.path);

    assert.ok(list.some((w) => w.branch === 'main'));
    assert.ok(list.some((w) => w.branch === 'feat/g1'));
  });

  it('remove 之後可以重新建立同名 worktree', async () => {
    const info = await wm.create(repo.path, 'feat/g1', { base: 'main' });
    await wm.remove(repo.path, info.path);
    assert.ok(!existsSync(info.path));

    const again = await wm.create(repo.path, 'feat/g1', { base: 'main' });
    assert.ok(existsSync(again.path));
  });
});
