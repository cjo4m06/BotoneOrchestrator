import test from 'node:test';
import assert from 'node:assert/strict';
import { execa } from 'execa';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { releaseMergeWorktreeBranch } from '../src/main.js';
import { createTmpDir } from './helpers/index.js';

/**
 * 合併工作區用完之後要**放掉群組分支**。
 *
 * ── 實跑災情 ──
 *
 * 舊實作是 `git checkout <baseBranch>`，但 **git 不允許同一條分支同時被兩個 worktree
 * 檢出**，而 base 分支正被使用者的主 checkout 佔著：
 *
 *   WARN 合併工作區收尾擲錯（忽略）
 *        err: 切回 main 失敗：fatal: 'main' is already used by worktree at '…/work/Dinosaur'
 *
 * 上層 catch 成 warn，看起來無害——但它代表群組分支**從來沒被放掉**，
 * 於是那一群要重做時 `worktree add` 會失敗，整組 failed。每次合併完都噴一次。
 *
 * 合併工作區建立時本來就是 `worktree add --detach`，釋放時卻去 checkout 分支，
 * 兩邊不一致。這裡用真 git 重現那個佔用狀態。
 */

async function setup(t: { after(fn: () => void): void }): Promise<{ repo: string; mergeWt: string; groupBranch: string }> {
  const dir = createTmpDir('botone-mwt-');
  t.after(() => dir.cleanup());
  const repo = join(dir.path, 'repo');
  const git = (cwd: string, ...args: string[]) => execa('git', ['-C', cwd, ...args]);

  await execa('git', ['init', '-q', '-b', 'main', repo]);
  await git(repo, 'config', 'user.email', 't@t');
  await git(repo, 'config', 'user.name', 't');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'base');

  // 群組分支（合併工作區會檢出它）。**要跟 main 分岔**，
  // 否則「detach 到 base」與「退回 HEAD」會停在同一顆，測不出差別。
  const groupBranch = 'orch/x/g_1';
  await git(repo, 'branch', groupBranch);
  await git(repo, 'checkout', '-q', groupBranch);
  writeFileSync(join(repo, 'g.txt'), 'group work\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'group');
  await git(repo, 'checkout', '-q', 'main');

  // 合併專用工作區，停在群組分支上——這是合併結束時的實際狀態
  const mergeWt = join(dir.path, 'merge-wt');
  await git(repo, 'worktree', 'add', mergeWt, groupBranch);

  // 主 repo 仍然停在 main（這正是衝突的來源）
  assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'main');
  return { repo, mergeWt, groupBranch };
}

const branchOf = async (cwd: string): Promise<string> =>
  (await execa('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();

test('main 被主 checkout 佔住時，照樣要放掉群組分支', async (t) => {
  const { repo, mergeWt, groupBranch } = await setup(t);

  // 前提：舊實作在這裡一定失敗
  const old = await execa('git', ['-C', mergeWt, 'checkout', 'main'], { reject: false });
  assert.notEqual(old.exitCode, 0, 'git 的行為前提：main 已被主 worktree 佔住');
  assert.match(old.stderr, /already used by worktree/);

  await releaseMergeWorktreeBranch(mergeWt, 'main');

  assert.equal(await branchOf(mergeWt), 'HEAD', '合併工作區應該變成 detached');
  // 群組分支放掉了 → 別的 worktree 才檢出得了它（那正是「群組重做」會做的事）
  const reuse = await execa('git', ['-C', repo, 'worktree', 'add', join(mergeWt, '..', 'again'), groupBranch], { reject: false });
  assert.equal(reuse.exitCode, 0, `群組分支還被佔著：${reuse.stderr}`);
});

test('有 origin/base 時 detach 到遠端那顆（合併後最新的位置）', async (t) => {
  const { repo, mergeWt } = await setup(t);
  // 造一個假 remote：origin/main 比本地 main 多一顆
  const bare = join(repo, '..', 'bare.git');
  await execa('git', ['init', '-q', '--bare', bare]);
  await execa('git', ['-C', repo, 'remote', 'add', 'origin', bare]);
  await execa('git', ['-C', repo, 'push', '-q', 'origin', 'main']);
  writeFileSync(join(repo, 'b.txt'), 'newer\n');
  await execa('git', ['-C', repo, 'add', '-A']);
  await execa('git', ['-C', repo, 'commit', '-qm', 'newer']);
  await execa('git', ['-C', repo, 'push', '-q', 'origin', 'main']);
  const remoteTip = (await execa('git', ['-C', repo, 'rev-parse', 'origin/main'])).stdout.trim();

  await releaseMergeWorktreeBranch(mergeWt, 'main');

  assert.equal((await execa('git', ['-C', mergeWt, 'rev-parse', 'HEAD'])).stdout.trim(), remoteTip);
});

/** 沒有 remote 的 repo 也要能放掉分支——不然那些專案每次合併都留一個佔用。 */
test('沒有 origin 時 detach 到本地 base（不是留在群組分支那顆）', async (t) => {
  const { repo, mergeWt, groupBranch } = await setup(t);
  const mainTip = (await execa('git', ['-C', repo, 'rev-parse', 'main'])).stdout.trim();
  const groupTip = (await execa('git', ['-C', repo, 'rev-parse', groupBranch])).stdout.trim();
  assert.notEqual(mainTip, groupTip, '前提：兩條分支要分岔');

  await releaseMergeWorktreeBranch(mergeWt, 'main');

  assert.equal(await branchOf(mergeWt), 'HEAD');
  // **這一條才分辨得出 --detach**：`git checkout main` 會因為 main 被主 worktree 佔住而失敗，
  // 只有 `git checkout --detach main` 過得去。少了 --detach 就會掉到 HEAD 那個退路，
  // 停在群組分支那顆——分支雖然放掉了，但工作區停在錯的位置。
  assert.equal(
    (await execa('git', ['-C', mergeWt, 'rev-parse', 'HEAD'])).stdout.trim(),
    mainTip,
    '應該停在 base 那顆；停在群組分支那顆代表沒有用 --detach',
  );
  const reuse = await execa('git', ['-C', repo, 'worktree', 'add', join(mergeWt, '..', 'again2'), groupBranch], { reject: false });
  assert.equal(reuse.exitCode, 0);
});

/** base 分支根本不存在時也不能擲錯——目的只是別再佔著群組分支。 */
test('base 分支不存在 → 退回 HEAD，不擲錯', async (t) => {
  const { mergeWt } = await setup(t);
  await assert.doesNotReject(() => releaseMergeWorktreeBranch(mergeWt, 'no-such-branch'));
  assert.equal(await branchOf(mergeWt), 'HEAD');
});
