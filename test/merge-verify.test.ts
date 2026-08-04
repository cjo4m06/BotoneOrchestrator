import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createMergeTree } from '../src/pr/merge-verify.js';
import { createTmpGitRepo, createTmpDir, createSilentLogger } from './helpers/index.js';
import { withRepoLock } from '../src/core/repo-lock.js';

describe('createMergeTree：群分支併上最新 base 的拋棄式樹', () => {
  function repoWithBranch(t: { after(fn: () => void): void }) {
    const repo = createTmpGitRepo({ files: { 'a.txt': 'base-1\n' } });
    t.after(() => repo.cleanup());
    repo.git('checkout', '-q', '-b', 'orch/g1');
    repo.commit({ 'feature.txt': '群的成果\n' }, 'feat: 群的成果');
    repo.git('checkout', '-q', 'main');
    return repo;
  }

  it('把 base 併進來，而且**完全不動群分支**（所以永遠不需要 force push）', async (t) => {
    const repo = repoWithBranch(t);
    const before = repo.git('rev-parse', 'orch/g1');
    repo.commit({ 'b.txt': 'base 之後多的東西\n' }, 'chore: base 前進');

    const r = await createMergeTree({ repoPath: repo.path, branch: 'orch/g1', baseRef: 'main', log: createSilentLogger() });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    t.after(() => void r.tree.dispose());

    assert.equal(repo.git('rev-parse', 'orch/g1'), before, '群分支的 sha 一位元都不能變');
    assert.equal(readFileSync(`${r.tree.path}/feature.txt`, 'utf8'), '群的成果\n', '群的成果要在');
    assert.equal(readFileSync(`${r.tree.path}/b.txt`, 'utf8'), 'base 之後多的東西\n', 'base 的新東西也要在');
    assert.match(r.tree.verifiedBaseSha, /^[0-9a-f]{40}$/);
  });

  it('衝突時從**機器格式**取檔名（不是解析 git 印給人看的訊息）', async (t) => {
    const repo = createTmpGitRepo({ files: { 'x.txt': 'orig\n' } });
    t.after(() => repo.cleanup());
    repo.git('checkout', '-q', '-b', 'orch/g1');
    repo.commit({ 'x.txt': '群改的\n' }, 'feat: 群改 x');
    repo.git('checkout', '-q', 'main');
    repo.commit({ 'x.txt': 'base 改的\n' }, 'chore: base 也改 x');

    const r = await createMergeTree({ repoPath: repo.path, branch: 'orch/g1', baseRef: 'main', log: createSilentLogger() });

    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'conflict');
    assert.deepEqual(r.reason === 'conflict' ? r.conflicts : [], ['x.txt']);
  });

  it('失敗時把半個樹清乾淨（留著的話下一輪 worktree add 會撞名，那是一整群報銷）', async (t) => {
    const repo = createTmpGitRepo({ files: { 'x.txt': 'a\n' } });
    t.after(() => repo.cleanup());
    const root = createTmpDir('merge-tree-');
    t.after(() => root.cleanup());

    const r = await createMergeTree({
      repoPath: repo.path, branch: '不存在的分支', baseRef: 'main',
      log: createSilentLogger(), root: root.path,
    });

    assert.equal(r.ok, false);
    const leftovers = repo.git('worktree', 'list');
    assert.equal(leftovers.split('\n').length, 1, '主 clone 不該留下指向不存在路徑的殘骸');
  });

  it('dispose 之後樹要真的不見（拋棄式的東西不能累積在磁碟上）', async (t) => {
    const repo = repoWithBranch(t);
    const r = await createMergeTree({ repoPath: repo.path, branch: 'orch/g1', baseRef: 'main', log: createSilentLogger() });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const p = r.tree.path;

    await r.tree.dispose();

    assert.equal(existsSync(p), false);
  });

  it('**在持有 repo 鎖的情況下也要建得起來**（不可重入的鎖會讓它永久死鎖）', async (t) => {
    const repo = repoWithBranch(t);

    // 這正是真實合併路徑的形狀：group-runner 持著 withRepoLock，裡面要一棵驗收樹。
    // 若 createMergeTree 走 WorktreeManager（內部也要同一把鎖），這裡會永遠回不來。
    const done = await withRepoLock(repo.path, async () => {
      const r = await Promise.race([
        createMergeTree({ repoPath: repo.path, branch: 'orch/g1', baseRef: 'main', log: createSilentLogger() }),
        new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 5_000)),
      ]);
      if (r !== 'timeout' && r.ok) await r.tree.dispose();
      return r === 'timeout' ? 'timeout' : 'ok';
    });

    assert.equal(done, 'ok', '死鎖不會拋錯、不會有 log——症狀是那個 repo 之後所有群組全部靜止');
  });

  it('prepare 失敗 → setup_failed，而不是讓關卡在沒有依賴的樹上跑', async (t) => {
    const repo = repoWithBranch(t);
    const r = await createMergeTree({
      repoPath: repo.path, branch: 'orch/g1', baseRef: 'main', log: createSilentLogger(),
      prepare: async () => { throw new Error('node_modules 帶不進來'); },
    });

    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'setup_failed');
    assert.match(r.output, /node_modules 帶不進來/);
  });
});
