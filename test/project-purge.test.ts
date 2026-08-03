import test from 'node:test';
import assert from 'node:assert/strict';

import { purgeProjectState, projectPurgerOf, worktreeDirNameOf } from '../src/core/project-purge.js';
import type { PurgeGit } from '../src/core/project-purge.js';
import { createTmpLedger, makeDiscoveredTask, createSilentLogger, createRecordingLogger } from './helpers/index.js';

/**
 * 停用專案＝清乾淨。
 *
 * 這裡的重點不是「函式會不會刪東西」，而是**停用之後 daemon 不會再看到那些任務**——
 * 實跑撞到的災情是：停用只改了旗標，ledger 裡 18 張 discovered 還在，
 * 於是每一輪 tick 都想規劃它們、每一輪都因為查不到專案擲錯，
 * 連帶讓後面的輪詢、審查監看、合併佇列全部跳過。
 */

function setup(t: { after(fn: () => void): void }) {
  const h = createTmpLedger();
  t.after(() => h.cleanup());
  return h;
}

function fakeGit(): PurgeGit & { removed: string[]; deleted: string[] } {
  const removed: string[] = [];
  const deleted: string[] = [];
  return {
    removed, deleted,
    async dirExists() { return true; },
    async removeWorktree(_repo, wt) { removed.push(wt); },
    async deleteBranch(_repo, b) { deleted.push(b); },
  };
}

test('清掉之後 daemon 看不到那個專案的任務與群組', async (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-a', repo: 'acme/web' }));
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-b', repo: 'acme/web' }));
  const g = ledger.createGroup({ repo: 'acme/web', branch: 'auto/g-1', taskIds: ['T-a'], footprint: [] });

  const r = await purgeProjectState('acme/web', ledger, { log: createSilentLogger() });

  assert.equal(r.tasks, 2);
  assert.equal(r.groups, 1);
  // 非空洞：直接問 daemon 每一輪會問的那個問題
  assert.deepEqual(ledger.listTasksByState('discovered'), []);
  assert.deepEqual(ledger.listGroupsByState('ready'), []);
  assert.equal(ledger.getTask('T-a'), undefined);
  assert.equal(ledger.getGroup(g.id), undefined);
});

test('只清指定的 repo，別的專案不能被波及', async (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-mine', repo: 'acme/web' }));
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-other', repo: 'acme/api' }));
  ledger.createGroup({ repo: 'acme/api', branch: 'auto/keep', taskIds: ['T-other'], footprint: [] });

  const r = await purgeProjectState('acme/web', ledger, { log: createSilentLogger() });

  assert.equal(r.tasks, 1);
  assert.equal(r.groups, 0);
  assert.equal(ledger.getTask('T-other')?.repo, 'acme/api', '另一個專案的任務不能被清掉');
  assert.equal(ledger.listGroupsByState('ready').length, 1);
});

test('已認領過的任務要被列出來——MCP 沒有取消認領的工具，那幾張卡得人工改回 todo', async (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-new', repo: 'acme/web' }));
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-run', repo: 'acme/web', title: '做到一半' }));
  ledger.updateTaskState('T-run', 'in_progress');

  const r = await purgeProjectState('acme/web', ledger, { log: createSilentLogger() });

  assert.equal(r.tasks, 2);
  assert.deepEqual(
    r.claimed.map((c) => c.id),
    ['T-run'],
    '沒認領過的不該被算進來——否則每次停用都在喊狼來了，真正要人處理的那張就被淹掉',
  );
  assert.equal(r.claimed[0]?.title, '做到一半', '要有標題，人才知道去任務板找哪一張');
});

test('群組的 worktree 與分支一起清掉（分支要在 worktree 之後刪）', async (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-a', repo: 'acme/web' }));
  ledger.createGroup({ repo: 'acme/web', branch: 'auto/g 1', taskIds: ['T-a'], footprint: [] });
  const git = fakeGit();

  const r = await purgeProjectState('acme/web', ledger, {
    repoPath: '/repo', worktreeBase: '/wt', git, log: createSilentLogger(),
  });

  assert.equal(r.worktrees, 1);
  assert.equal(r.branches, 1);
  assert.deepEqual(git.removed, [`/wt/${worktreeDirNameOf('auto/g 1')}`]);
  assert.deepEqual(git.deleted, ['auto/g 1']);
});

test('沒給 repoPath 就只清 ledger，不亂碰磁碟', async (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-a', repo: 'acme/web' }));
  ledger.createGroup({ repo: 'acme/web', branch: 'auto/g-1', taskIds: ['T-a'], footprint: [] });
  const git = fakeGit();

  const r = await purgeProjectState('acme/web', ledger, { worktreeBase: '/wt', git, log: createSilentLogger() });

  assert.deepEqual(git.removed, []);
  assert.deepEqual(git.deleted, []);
  assert.equal(r.groups, 1, 'ledger 還是要清乾淨');
});

test('git 清不掉不會讓停用失敗——旗標已經關了，ledger 清乾淨才是重點', async (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-a', repo: 'acme/web' }));
  ledger.createGroup({ repo: 'acme/web', branch: 'auto/g-1', taskIds: ['T-a'], footprint: [] });
  const log = createRecordingLogger();

  const r = await purgeProjectState('acme/web', ledger, {
    repoPath: '/repo',
    worktreeBase: '/wt',
    git: {
      async dirExists() { return true; },
      async removeWorktree() { throw new Error('worktree is locked'); },
      async deleteBranch() { throw new Error('branch is checked out'); },
    },
    log: log.logger,
  });

  assert.equal(r.tasks, 1);
  assert.equal(r.groups, 1);
  assert.equal(r.worktrees, 0);
  assert.equal(r.branches, 0);
  assert.equal(ledger.getTask('T-a'), undefined, 'git 失敗不能讓 ledger 留著舊資料');
  assert.ok(log.messages('warn').some((w) => w.includes('worktree')), '清不掉要留下痕跡，不能無聲吞掉');
});

test('清理留下事件紀錄，人事後查得到當初清了什麼', async (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-a', repo: 'acme/web' }));

  await purgeProjectState('acme/web', ledger, { log: createSilentLogger() });

  const ev = ledger.listEvents({ kind: 'project_purged' })[0];
  assert.ok(ev, '沒有事件的話，人只會看到任務突然消失，查不出是誰清的');
  assert.match(ev.detail ?? '', /acme\/web/);
});

test('projectPurgerOf 從設定裡查 repoPath——兩個控制台才會有一樣的結果', async (t) => {
  const { ledger } = setup(t);
  ledger.upsertDiscoveredTask(makeDiscoveredTask({ id: 'T-a', repo: 'acme/web' }));
  ledger.createGroup({ repo: 'acme/web', branch: 'auto/g-1', taskIds: ['T-a'], footprint: [] });
  const git = fakeGit();
  const store = { allProjects: () => [{ config: { repo: 'acme/web', repoPath: '/checkout/web' } }] };

  const purge = projectPurgerOf({ store, ledger, worktreeBase: '/wt', log: createSilentLogger(), git });
  const r = await purge('acme/web');

  assert.equal(r.branches, 1, '查得到 repoPath 才會動 git');
  assert.deepEqual(git.removed, [`/wt/${worktreeDirNameOf('auto/g-1')}`]);
  assert.equal(ledger.getTask('T-a'), undefined);
});
