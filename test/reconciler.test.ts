// reconciler.ts 測試：ledger / 檔案系統 / git 全部用假件，不碰真實磁碟與 git。
// 執行：npx tsx --test test/reconciler.test.ts

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import {
  Reconciler,
  worktreeDirName,
  type FsProbe,
  type GitProbe,
  type ReconcilerDeps,
  type ReconcilerLedger,
  type ReconcilerProject,
} from '../src/core/reconciler.js';
import { createGitProbe } from '../src/core/reconciler.js';
import { execaSync } from 'execa';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Group, GroupState, Task, TaskBrief, TaskState } from '../src/types.js';
import type { Logger } from '../src/observability/logger.js';

const log = pino({ level: 'silent' }) as unknown as Logger;
const WT_BASE = '/wt';
const REPO = 'acme/app';
const PROJECT: ReconcilerProject = { repoPath: '/repos/app', baseBranch: 'main' };

function task(id: string, state: TaskState, extra: Partial<Task> = {}): Task {
  return {
    id, payloadHash: 'h', repo: REPO, category: 'dev', title: id, description: '',
    dependencies: [], docRefs: [], state, attempts: 0, createdAt: 1, updatedAt: 1, ...extra,
  };
}

function group(id: string, state: GroupState, taskIds: string[]): Group {
  return {
    id, repo: REPO, branch: `orch/app/${id}`, taskIds, footprint: [],
    state, createdAt: 1, updatedAt: 1,
  };
}

class FakeLedger implements ReconcilerLedger {
  readonly tasks = new Map<string, Task>();
  readonly groups = new Map<string, Group>();
  readonly events: { kind: string; detail?: string }[] = [];
  /** 假時鐘：狀態異動時寫進 updatedAt（保留期判斷會用到）。 */
  clockMs = Date.now();

  constructor(tasks: Task[] = [], groups: Group[] = []) {
    for (const t of tasks) this.tasks.set(t.id, t);
    for (const g of groups) this.groups.set(g.id, g);
  }
  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }
  listTasksByState(state: TaskState): Task[] {
    return [...this.tasks.values()].filter((t) => t.state === state);
  }
  listGroupsByState(state: GroupState): Group[] {
    return [...this.groups.values()].filter((g) => g.state === state);
  }
  getGroup(id: string): Group | undefined {
    return this.groups.get(id);
  }
  updateTaskState(id: string, state: TaskState, extra: { lastError?: string } = {}): void {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`找不到任務 ${id}`);
    this.tasks.set(id, { ...t, state, lastError: extra.lastError ?? t.lastError });
  }
  updateGroupState(id: string, state: GroupState): void {
    const g = this.groups.get(id);
    if (!g) throw new Error(`找不到群組 ${id}`);
    this.groups.set(id, { ...g, state, updatedAt: this.clockMs });
  }
  logEvent(_scope: 'task' | 'group' | 'system', _refId: string | null, kind: string, detail?: string): void {
    this.events.push({ kind, detail });
  }
  stateOf(id: string): TaskState | undefined {
    return this.tasks.get(id)?.state;
  }
  groupStateOf(id: string): GroupState | undefined {
    return this.groups.get(id)?.state;
  }
}

class FakeFs implements FsProbe {
  readonly removed: string[] = [];
  /** 目錄 → mtime（epoch ms）；沒登記代表「取不到時間」。 */
  readonly mtimes = new Map<string, number>();
  constructor(private dirs: Set<string> = new Set()) {}
  async dirExists(path: string): Promise<boolean> {
    return this.dirs.has(path);
  }
  async listDirs(base: string): Promise<string[]> {
    return [...this.dirs].filter((d) => d.startsWith(`${base}/`));
  }
  async removeDir(path: string): Promise<void> {
    this.dirs.delete(path);
    this.removed.push(path);
  }
  async dirMtimeMs(path: string): Promise<number | undefined> {
    return this.mtimes.get(path);
  }
  withMtime(path: string, ms: number): this {
    this.mtimes.set(path, ms);
    return this;
  }
}

class FakeGit implements GitProbe {
  readonly removedWorktrees: string[] = [];
  readonly deletedBranches: string[] = [];
  readonly pruned: string[] = [];
  constructor(private branches: Map<string, number> = new Map()) {}
  async branchExists(_repoPath: string, branch: string): Promise<boolean> {
    return this.branches.has(branch);
  }
  async commitsAhead(_repoPath: string, branch: string): Promise<number> {
    return this.branches.get(branch) ?? 0;
  }
  async removeWorktree(_repoPath: string, worktreePath: string): Promise<void> {
    this.removedWorktrees.push(worktreePath);
  }
  async deleteBranch(_repoPath: string, branch: string): Promise<void> {
    this.deletedBranches.push(branch);
    this.branches.delete(branch);
  }
  async prune(repoPath: string): Promise<void> {
    this.pruned.push(repoPath);
  }
}

function makeDeps(over: Partial<ReconcilerDeps> & { ledger: ReconcilerLedger; fs: FsProbe; git: GitProbe }): ReconcilerDeps {
  return {
    log,
    worktreeBase: WT_BASE,
    resolveProject: (repo) => (repo === REPO ? PROJECT : undefined),
    knownRepoPaths: () => [PROJECT.repoPath],
    ...over,
  };
}

const wtPathOf = (g: Group) => `${WT_BASE}/${worktreeDirName(g.branch)}`;

describe('群組恢復決策', () => {
  test('worktree 在 + 分支有 commit → 可續：保留分支、清舊 worktree、未完成任務回 queued', async () => {
    const g = group('g1', 'forming', ['t1', 't2']);
    const ledger = new FakeLedger([task('t1', 'done'), task('t2', 'in_progress', { groupId: 'g1' })], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)]));
    const git = new FakeGit(new Map([[g.branch, 2]]));

    const report = await new Reconciler(makeDeps({ ledger, fs, git })).reconcile();

    assert.equal(report.groupsResumed, 1);
    assert.equal(report.groupsRestarted, 0);
    assert.equal(ledger.groupStateOf('g1'), 'ready');
    assert.equal(ledger.stateOf('t1'), 'done', '已完成任務不可重做');
    assert.equal(ledger.stateOf('t2'), 'queued');
    assert.deepEqual(git.removedWorktrees, [wtPathOf(g)]);
    assert.deepEqual(git.deletedBranches, [], '可續時絕不刪分支');
  });

  test('worktree 消失 → 狀態不明：清理並重置為 queued', async () => {
    const g = group('g2', 'forming', ['t1']);
    const ledger = new FakeLedger([task('t1', 'verifying', { groupId: 'g2' })], [g]);
    const fs = new FakeFs();
    const git = new FakeGit();

    const report = await new Reconciler(makeDeps({ ledger, fs, git })).reconcile();

    assert.equal(report.groupsRestarted, 1);
    assert.equal(ledger.groupStateOf('g2'), 'ready');
    assert.equal(ledger.stateOf('t1'), 'queued');
    assert.deepEqual(git.pruned, [PROJECT.repoPath], 'worktree 目錄不在時要 prune 掉殘留登記');
  });

  test('worktree 在但分支沒有 commit → 重做：清 worktree + 刪分支', async () => {
    const g = group('g3', 'forming', ['t1']);
    const ledger = new FakeLedger([task('t1', 'in_progress', { groupId: 'g3' })], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)]));
    const git = new FakeGit(new Map([[g.branch, 0]]));

    const report = await new Reconciler(makeDeps({ ledger, fs, git })).reconcile();

    assert.equal(report.groupsRestarted, 1);
    assert.deepEqual(git.removedWorktrees, [wtPathOf(g)]);
    assert.deepEqual(git.deletedBranches, [g.branch]);
    assert.equal(ledger.stateOf('t1'), 'queued');
  });

  test('分支不存在但已有 done 任務 → 成果遺失，標 failed 交人處理（現場一律保留）', async () => {
    const g = group('g4', 'forming', ['t1', 't2']);
    const ledger = new FakeLedger([task('t1', 'done'), task('t2', 'in_progress', { groupId: 'g4' })], [g]);
    // worktree 還在：裡面可能是 agent 尚未 commit 的成果，是唯一的搶救現場
    const fs = new FakeFs(new Set([wtPathOf(g)]));
    const git = new FakeGit();

    const report = await new Reconciler(makeDeps({ ledger, fs, git })).reconcile();

    assert.equal(report.groupsFailed, 1);
    assert.equal(ledger.groupStateOf('g4'), 'failed');
    assert.equal(report.actions.some((a) => a.decision === 'unrecoverable'), true);
    assert.deepEqual(git.deletedBranches, []);
    assert.deepEqual(git.removedWorktrees, [], 'unrecoverable 不可刪 worktree');
    assert.deepEqual(fs.removed, [], '同一輪的孤兒清掃也不可把剛標 failed 的現場刪掉');
  });

  test('找不到專案 runtime（例如該專案 MCP 連不上）→ 延後處理，狀態與現場都不動', async () => {
    const g = { ...group('g5', 'forming', ['t1']), repo: 'other/gone' };
    const ledger = new FakeLedger([task('t1', 'in_progress', { groupId: 'g5' })], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)]));
    const git = new FakeGit(new Map([[g.branch, 3]]));

    const report = await new Reconciler(makeDeps({ ledger, fs, git })).reconcile();

    assert.equal(report.groupsDeferred, 1);
    assert.equal(report.groupsFailed, 0, '證據不足不可判 unrecoverable');
    assert.equal(ledger.groupStateOf('g5'), 'forming', '狀態維持非終態，下次對帳再看');
    assert.deepEqual(git.removedWorktrees, []);
    assert.deepEqual(git.deletedBranches, []);
    assert.deepEqual(fs.removed, [], '未 commit 的成果絕不可在資訊不全時被 rm -rf');
    assert.equal(ledger.stateOf('t1'), 'in_progress', '群組延後 → 群內任務也不動');
  });

  test('分支有 commit 但 worktree 目錄不見了 → 仍可續，絕不刪掉有 commit 的分支', async () => {
    const g = group('g5b', 'forming', ['t1']);
    const ledger = new FakeLedger([task('t1', 'in_progress', { groupId: 'g5b' })], [g]);
    const fs = new FakeFs();
    const git = new FakeGit(new Map([[g.branch, 2]]));

    const report = await new Reconciler(makeDeps({ ledger, fs, git })).reconcile();

    assert.equal(report.groupsResumed, 1);
    assert.deepEqual(git.deletedBranches, [], '分支上有成果，刪掉就永久遺失');
    assert.deepEqual(git.pruned, [PROJECT.repoPath], '目錄不在要 prune 掉殘留登記');
    assert.equal(ledger.stateOf('t1'), 'queued');
  });

  test('forming 但群內任務全部 done 且已 commit → 沒有自動續跑入口，交人工且不動現場', async () => {
    const g = group('g5c', 'forming', ['t1', 't2']);
    const ledger = new FakeLedger([task('t1', 'done'), task('t2', 'done')], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)]));
    const git = new FakeGit(new Map([[g.branch, 3]]));

    const report = await new Reconciler(makeDeps({ ledger, fs, git })).reconcile();

    assert.equal(report.groupsNeedsHuman, 1);
    assert.equal(report.groupsResumed, 0, '退回 ready 會讓 GroupRunner 對已 done 任務重新 start_task');
    assert.equal(ledger.groupStateOf('g5c'), 'forming');
    assert.deepEqual(git.removedWorktrees, []);
    assert.deepEqual(fs.removed, []);
  });

  test('等待澄清的任務不被崩潰恢復掃掉', async () => {
    const g = group('g6', 'forming', ['t1', 't2']);
    const ledger = new FakeLedger(
      [
        task('t1', 'blocked', { groupId: 'g6', block: { reason: 'needs_clarification', detail: '等回答' } }),
        task('t2', 'in_progress', { groupId: 'g6' }),
      ],
      [g],
    );
    const fs = new FakeFs(new Set([wtPathOf(g)]));
    const git = new FakeGit(new Map([[g.branch, 1]]));

    await new Reconciler(makeDeps({ ledger, fs, git })).reconcile();

    assert.equal(ledger.stateOf('t1'), 'blocked');
    assert.equal(ledger.stateOf('t2'), 'queued');
  });

  test('blocked:deps 會被重排（依賴可能早就完成了）', async () => {
    const g = group('g7', 'forming', ['t1']);
    const ledger = new FakeLedger([task('t1', 'blocked', { groupId: 'g7', block: { reason: 'deps' } })], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)]));
    const git = new FakeGit(new Map([[g.branch, 1]]));

    await new Reconciler(makeDeps({ ledger, fs, git })).reconcile();

    assert.equal(ledger.stateOf('t1'), 'queued');
  });
});

describe('非終態群組全覆蓋（狀態黑洞）', () => {
  test('每個非終態群組狀態都會被對帳看到（不是只有 forming）', async () => {
    const states: GroupState[] = ['forming', 'pr_open', 'in_review', 'changes_requested', 'merge_guard'];
    const groups = states.map((s, i) => group(`gs${i}`, s, ['t1']));
    const ledger = new FakeLedger([task('t1', 'done')], groups);
    const git = new FakeGit(new Map(groups.map((g) => [g.branch, 1])));

    const report = await new Reconciler(makeDeps({ ledger, fs: new FakeFs(), git })).reconcile();

    for (const g of groups) {
      assert.equal(report.actions.some((a) => a.scope === 'group' && a.ref === g.id), true, `${g.state} 群組沒有任何對帳決策 → 狀態黑洞`);
    }
  });

  test('崩潰在 merge_guard → 交人工，狀態/分支/worktree 全部保留', async () => {
    const g = group('gm1', 'merge_guard', ['t1']);
    const ledger = new FakeLedger([task('t1', 'done')], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)]));
    const git = new FakeGit(new Map([[g.branch, 2]]));

    const report = await new Reconciler(makeDeps({ ledger, fs, git })).reconcile();

    assert.equal(report.groupsNeedsHuman, 1);
    assert.equal(ledger.groupStateOf('gm1'), 'merge_guard');
    assert.deepEqual(git.removedWorktrees, []);
    assert.deepEqual(git.deletedBranches, []);
    assert.deepEqual(fs.removed, [], 'merge_guard 群組的 worktree 不可被孤兒清掃帶走');
    assert.equal(report.actions.some((a) => a.ref === 'gm1' && a.decision === 'needs_human'), true);
  });

  test('changes_requested → 交人工（目前沒有自動回頭改的路徑）', async () => {
    const g = group('gc1', 'changes_requested', ['t1']);
    const ledger = new FakeLedger([task('t1', 'done')], [g]);
    const report = await new Reconciler(makeDeps({ ledger, fs: new FakeFs(), git: new FakeGit() })).reconcile();

    assert.equal(report.groupsNeedsHuman, 1);
    assert.equal(ledger.groupStateOf('gc1'), 'changes_requested');
  });

  test('pr_open / in_review 是等外部事件，不算崩潰殘留 → 只記錄、不動手', async () => {
    const a = group('gp1', 'pr_open', ['t1']);
    const b = group('gp2', 'in_review', ['t2']);
    const ledger = new FakeLedger([task('t1', 'done'), task('t2', 'done')], [a, b]);
    const fs = new FakeFs(new Set([wtPathOf(a), wtPathOf(b)]));

    const report = await new Reconciler(makeDeps({ ledger, fs, git: new FakeGit() })).reconcile();

    assert.equal(report.groupsNeedsHuman, 0);
    assert.equal(report.groupsFailed, 0);
    assert.deepEqual(fs.removed, []);
    assert.equal(ledger.groupStateOf('gp1'), 'pr_open');
    assert.equal(ledger.groupStateOf('gp2'), 'in_review');
  });
});

describe('MCP 證據不足時的保守行為', () => {
  const brokenMcp = {
    async listTasks(): Promise<TaskBrief[]> {
      throw new Error('ECONNREFUSED');
    },
  };

  test('MCP 連不上且無成果證據 → 延後，不刪 worktree（可能有 agent 未 commit 的成果）', async () => {
    const g = group('ge1', 'forming', ['t1']);
    const ledger = new FakeLedger([task('t1', 'in_progress', { groupId: 'ge1' })], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)]));
    const git = new FakeGit(); // 分支不存在 → 舊版會走 restart 並 rm -rf

    const report = await new Reconciler(makeDeps({ ledger, fs, git, mcp: brokenMcp })).reconcile();

    assert.equal(report.groupsDeferred, 1);
    assert.equal(report.groupsRestarted, 0);
    assert.deepEqual(git.removedWorktrees, []);
    assert.deepEqual(fs.removed, []);
    assert.equal(ledger.groupStateOf('ge1'), 'forming');
    assert.equal(ledger.stateOf('t1'), 'in_progress');
  });

  test('MCP 連不上但沒有 worktree 可保護 → 照常重做（不讓保守檢查卡死正常流程）', async () => {
    const g = group('ge2', 'forming', ['t1']);
    const ledger = new FakeLedger([task('t1', 'in_progress', { groupId: 'ge2' })], [g]);

    const report = await new Reconciler(makeDeps({ ledger, fs: new FakeFs(), git: new FakeGit(), mcp: brokenMcp })).reconcile();

    assert.equal(report.groupsRestarted, 1);
    assert.equal(ledger.stateOf('t1'), 'queued');
  });

  test('聚合器回報部分 MCP 來源失敗 → 一樣視為證據不完整', async () => {
    const g = group('ge3', 'forming', ['t1']);
    const ledger = new FakeLedger([task('t1', 'in_progress', { groupId: 'ge3' })], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)]));
    const mcp = {
      async listTasks(): Promise<TaskBrief[]> {
        return [];
      },
      async listTasksDetailed(): Promise<{ tasks: TaskBrief[]; failedSources: number }> {
        return { tasks: [], failedSources: 1 };
      },
    };

    const report = await new Reconciler(makeDeps({ ledger, fs, git: new FakeGit(), mcp })).reconcile();

    assert.equal(report.groupsDeferred, 1);
    assert.deepEqual(fs.removed, []);
  });

  test('沒設定 MCP 讀取端不算「證據暫時遺失」→ 正常流程照跑', async () => {
    const g = group('ge4', 'forming', ['t1']);
    const ledger = new FakeLedger([task('t1', 'in_progress', { groupId: 'ge4' })], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)]));

    const report = await new Reconciler(makeDeps({ ledger, fs, git: new FakeGit() })).reconcile();

    assert.equal(report.groupsRestarted, 1);
    assert.deepEqual(fs.removed, [], 'restart 由 git.removeWorktree 負責，不走 rm -rf');
  });
});

describe('孤兒任務', () => {
  test('中間態但沒有進行中群組的任務回到 queued', async () => {
    const ledger = new FakeLedger([task('t1', 'in_progress'), task('t2', 'verifying', { groupId: 'nope' })]);
    const report = await new Reconciler(makeDeps({ ledger, fs: new FakeFs(), git: new FakeGit() })).reconcile();

    assert.equal(report.tasksRequeued, 2);
    assert.equal(ledger.stateOf('t1'), 'queued');
    assert.equal(ledger.stateOf('t2'), 'queued');
  });

  test('群組已離開 forming（例如 pr_open）時，殘留的中間態任務也要收斂', async () => {
    const g = group('g8', 'pr_open', ['t1']);
    const ledger = new FakeLedger([task('t1', 'verifying', { groupId: 'g8' })], [g]);
    await new Reconciler(makeDeps({ ledger, fs: new FakeFs(), git: new FakeGit() })).reconcile();
    assert.equal(ledger.stateOf('t1'), 'queued');
  });
});

describe('孤兒 worktree 清理', () => {
  test('ledger 沒記錄的目錄被刪除，存活群組的目錄保留', async () => {
    const alive = group('g9', 'pr_open', ['t1']);
    const ledger = new FakeLedger([task('t1', 'done')], [alive]);
    const orphanA = `${WT_BASE}/orch-app-g_dead`;
    const orphanB = `${WT_BASE}/orch-app-g_zombie`;
    const fs = new FakeFs(new Set([wtPathOf(alive), orphanA, orphanB]));
    const git = new FakeGit();

    const report = await new Reconciler(makeDeps({ ledger, fs, git })).reconcile();

    assert.equal(report.orphanWorktreesRemoved, 2);
    assert.deepEqual(fs.removed.sort(), [orphanA, orphanB].sort());
    assert.equal(fs.removed.includes(wtPathOf(alive)), false);
    assert.deepEqual(git.pruned, [PROJECT.repoPath], '刪目錄後要 prune 掉 git 的登記');
  });

  test('剛被恢復決策清掉的 worktree 不會被重複刪', async () => {
    const g = group('g10', 'forming', ['t1']);
    const ledger = new FakeLedger([task('t1', 'in_progress', { groupId: 'g10' })], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)]));
    const git = new FakeGit(new Map([[g.branch, 5]]));

    const report = await new Reconciler(makeDeps({ ledger, fs, git })).reconcile();

    // 群組恢復成 ready（仍屬存活狀態）→ 目錄雖已由 git 移除，也不該被當孤兒再刪一次
    assert.equal(report.orphanWorktreesRemoved, 0);
    assert.deepEqual(fs.removed, []);
  });

  test('worktree 根目錄不存在時安全跳過', async () => {
    const ledger = new FakeLedger();
    const report = await new Reconciler(makeDeps({ ledger, fs: new FakeFs(), git: new FakeGit() })).reconcile();
    assert.equal(report.orphanWorktreesRemoved, 0);
    assert.deepEqual(report.actions, []);
  });
});

describe('保留策略（避免長期常駐磁碟無限成長）', () => {
  const NOW = 1_700_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  /** 具備 prune 能力的 ledger（等同 ledger.ts 補上 prune* 之後的樣子）。 */
  class PrunableLedger extends FakeLedger {
    readonly pruneArgs: { events?: number; iterations?: [number, number] } = {};
    pruneEvents(cutoffMs: number): number {
      this.pruneArgs.events = cutoffMs;
      return 12;
    }
    pruneTaskIterations(cutoffMs: number, keepPerTask: number): number {
      this.pruneArgs.iterations = [cutoffMs, keepPerTask];
      return 34;
    }
  }

  test('失敗群組的 worktree：保留期內留著供診斷', async () => {
    const g = { ...group('gr1', 'failed', ['t1']), updatedAt: NOW - 2 * DAY };
    const ledger = new FakeLedger([task('t1', 'in_progress')], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)])).withMtime(wtPathOf(g), NOW - 2 * DAY);

    const report = await new Reconciler(makeDeps({ ledger, fs, git: new FakeGit(), clock: () => NOW })).reconcile();

    assert.equal(report.worktreesRetained, 1);
    assert.equal(report.orphanWorktreesRemoved, 0);
    assert.deepEqual(fs.removed, []);
  });

  test('失敗群組的 worktree：逾保留期才清（不必等 daemon 重啟以外的時機）', async () => {
    const g = { ...group('gr2', 'failed', ['t1']), updatedAt: NOW - 30 * DAY };
    const ledger = new FakeLedger([task('t1', 'done')], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)])).withMtime(wtPathOf(g), NOW - 30 * DAY);

    const report = await new Reconciler(makeDeps({ ledger, fs, git: new FakeGit(), clock: () => NOW })).reconcile();

    assert.equal(report.orphanWorktreesRemoved, 1);
    assert.deepEqual(fs.removed, [wtPathOf(g)]);
  });

  test('保留天數可調；已合併群組同樣適用', async () => {
    const g = { ...group('gr3', 'merged', ['t1']), updatedAt: NOW - 2 * DAY };
    const ledger = new FakeLedger([task('t1', 'done')], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)])).withMtime(wtPathOf(g), NOW - 2 * DAY);

    const report = await new Reconciler(
      makeDeps({ ledger, fs, git: new FakeGit(), clock: () => NOW, retention: { terminalWorktreeDays: 1 } }),
    ).reconcile();

    assert.equal(report.orphanWorktreesRemoved, 1);
  });

  test('截圖：任務未完成 → 不清；已完成且逾期 → 清；時間判不準 → 不清', async () => {
    const root = '/shots';
    const running = `${root}/t-running`;
    const doneOld = `${root}/t-done-old`;
    const doneNew = `${root}/t-done-new`;
    const unknownTime = `${root}/t-no-mtime`;
    const ledger = new FakeLedger([
      task('t-running', 'in_progress'),
      task('t-done-old', 'done'),
      task('t-done-new', 'done'),
      task('t-no-mtime', 'done'),
    ]);
    const fs = new FakeFs(new Set([running, doneOld, doneNew, unknownTime]))
      .withMtime(running, NOW - 100 * DAY)
      .withMtime(doneOld, NOW - 100 * DAY)
      .withMtime(doneNew, NOW - 1 * DAY);
    // unknownTime 刻意不登記 mtime

    const report = await new Reconciler(
      makeDeps({ ledger, fs, git: new FakeGit(), clock: () => NOW, screenshotRoot: root }),
    ).reconcile();

    assert.equal(report.screenshotDirsRemoved, 1);
    assert.deepEqual(fs.removed, [doneOld]);
  });

  test('ledger 具備 prune 能力時，events / task_iterations 依保留期清理', async () => {
    const ledger = new PrunableLedger();
    const report = await new Reconciler(
      makeDeps({ ledger, fs: new FakeFs(), git: new FakeGit(), clock: () => NOW, retention: { eventDays: 10, iterationDays: 5, keepIterationsPerTask: 7 } }),
    ).reconcile();

    assert.equal(report.eventsPruned, 12);
    assert.equal(report.iterationsPruned, 34);
    assert.equal(ledger.pruneArgs.events, NOW - 10 * DAY);
    assert.deepEqual(ledger.pruneArgs.iterations, [NOW - 5 * DAY, 7]);
  });

  test('ledger 沒有 prune 能力時安全略過（優雅降級）', async () => {
    const ledger = new FakeLedger();
    const report = await new Reconciler(makeDeps({ ledger, fs: new FakeFs(), git: new FakeGit(), clock: () => NOW })).reconcile();
    assert.equal(report.eventsPruned, 0);
    assert.equal(report.iterationsPruned, 0);
  });

  test('dryRun 不執行任何保留清理', async () => {
    const ledger = new PrunableLedger([task('t1', 'done')]);
    const fs = new FakeFs(new Set(['/shots/t1'])).withMtime('/shots/t1', NOW - 100 * DAY);
    const report = await new Reconciler(
      makeDeps({ ledger, fs, git: new FakeGit(), clock: () => NOW, screenshotRoot: '/shots' }),
    ).reconcile({ dryRun: true });

    assert.equal(report.eventsPruned, 0);
    assert.equal(report.screenshotDirsRemoved, 0);
    assert.deepEqual(fs.removed, []);
    assert.equal(ledger.pruneArgs.events, undefined);
  });
});

describe('MCP 對帳', () => {
  test('MCP 已 done → ledger 補記，不重做', async () => {
    const g = group('g11', 'forming', ['t1']);
    const ledger = new FakeLedger([task('t1', 'in_progress', { groupId: 'g11' })], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)]));
    const git = new FakeGit(new Map([[g.branch, 1]]));
    const mcp = {
      async listTasks(): Promise<TaskBrief[]> {
        return [{ id: 't1', title: 't1', status: 'done', repo: REPO }];
      },
    };

    const report = await new Reconciler(makeDeps({ ledger, fs, git, mcp })).reconcile();

    assert.equal(report.tasksSyncedDone, 1);
    assert.equal(report.tasksRequeued, 0);
    assert.equal(ledger.stateOf('t1'), 'done');
    // 補記後群內任務全部 done、成果也在分支上 → 不能退回 ready（GroupRunner 會對 done 任務再 start_task），
    // 改為保留現場交人工；重點仍是「不重做」。
    assert.equal(report.groupsNeedsHuman, 1);
    assert.equal(ledger.groupStateOf('g11'), 'forming');
    assert.deepEqual(git.removedWorktrees, []);
  });

  test('MCP 掛掉時退回只用本地證據判斷', async () => {
    const g = group('g12', 'forming', ['t1']);
    const ledger = new FakeLedger([task('t1', 'in_progress', { groupId: 'g12' })], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g)]));
    const git = new FakeGit(new Map([[g.branch, 1]]));
    const mcp = {
      async listTasks(): Promise<TaskBrief[]> {
        throw new Error('503 service unavailable');
      },
    };

    const report = await new Reconciler(makeDeps({ ledger, fs, git, mcp })).reconcile();

    assert.equal(report.groupsResumed, 1);
    assert.equal(ledger.stateOf('t1'), 'queued');
  });
});

describe('dryRun', () => {
  test('只回報決策、完全不動 ledger 與磁碟', async () => {
    const g = group('g13', 'forming', ['t1']);
    const orphan = `${WT_BASE}/orch-app-g_dead`;
    const ledger = new FakeLedger([task('t1', 'in_progress', { groupId: 'g13' })], [g]);
    const fs = new FakeFs(new Set([wtPathOf(g), orphan]));
    const git = new FakeGit(new Map([[g.branch, 4]]));

    const report = await new Reconciler(makeDeps({ ledger, fs, git })).reconcile({ dryRun: true });

    assert.equal(report.groupsResumed, 1);
    assert.equal(report.orphanWorktreesRemoved, 1);
    assert.equal(ledger.stateOf('t1'), 'in_progress');
    assert.equal(ledger.groupStateOf('g13'), 'forming');
    assert.deepEqual(git.removedWorktrees, []);
    assert.deepEqual(fs.removed, []);
    assert.deepEqual(ledger.events, [], 'dryRun 不寫稽核事件');
  });
});

describe('稽核與報告', () => {
  test('reconcile 完成後寫一筆 system 事件', async () => {
    const ledger = new FakeLedger([task('t1', 'in_progress')]);
    await new Reconciler(makeDeps({ ledger, fs: new FakeFs(), git: new FakeGit() })).reconcile();
    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.events[0]?.kind, 'reconcile');
  });

  test('worktreeDirName 與 WorktreeManager 的 slug 規則一致', () => {
    assert.equal(worktreeDirName('orch/app/g_abc123'), 'orch-app-g_abc123');
    assert.equal(worktreeDirName('feature/x y'), 'feature-x-y');
  });
});

/**
 * createGitProbe：對帳唯一會碰真 git 的地方。
 *
 * 上面所有測試的 git 都是假件，所以「ahead 到底怎麼算」從來沒被驗過——
 * 而那個數字正是 reconcileRunningGroup 三條決策路徑的分岔點。
 * 實跑抓到：本地 main 停在舊 commit（daemon 只 fetch、不 checkout 更新它），
 * 於是 agent 一行都還沒 commit 的群組被算成「領先 5 個 commit → 可續」。
 */
describe('createGitProbe（真 git）', () => {
  const mk = () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-git-'));
    const g = (...args: string[]) => execaSync('git', ['-C', dir, ...args], { reject: false });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'base');
    g('add', '-A');
    g('commit', '-qm', 'base');
    return { dir, g };
  };

  test('本地 base 過期時，不把「別人已合併的 commit」算成這個分支的成果', () => {
    const { dir, g } = mk();
    try {
      // 分支從 origin/main 長出來；本地 main 停在更早的 commit（= daemon 只 fetch 的真實狀態）
      const stale = execaSync('git', ['-C', dir, 'rev-parse', 'HEAD']).stdout.trim();
      writeFileSync(join(dir, 'b.txt'), '別的群組合併進去的');
      g('add', '-A');
      g('commit', '-qm', 'other group');
      g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      g('branch', 'orch/g1'); // 從 origin/main 分出去，自己一個 commit 都沒有
      g('update-ref', 'refs/heads/main', stale); // 本地 main 退回舊的

      const probe = createGitProbe(log);
      return probe.commitsAhead(dir, 'orch/g1', 'main').then((n) => {
        assert.equal(n, 0, '沒有自己的 commit 就該是 0，否則「成果遺失」永遠偵測不到');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('分支自己的 commit 照樣算得到', async () => {
    const { dir, g } = mk();
    try {
      g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      g('checkout', '-q', '-b', 'orch/g1');
      writeFileSync(join(dir, 'c.txt'), 'agent 的成果');
      g('add', '-A');
      g('commit', '-qm', 'agent work');
      assert.equal(await createGitProbe(log).commitsAhead(dir, 'orch/g1', 'main'), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('沒有 remote-tracking 的 repo 退回本地 base（離線／純本地 repo 照樣能對帳）', async () => {
    const { dir, g } = mk();
    try {
      g('checkout', '-q', '-b', 'orch/g1');
      writeFileSync(join(dir, 'c.txt'), 'x');
      g('add', '-A');
      g('commit', '-qm', 'w');
      assert.equal(await createGitProbe(log).commitsAhead(dir, 'orch/g1', 'main'), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
