import type { Group, Task } from '../types.js';
import type { Logger } from '../observability/logger.js';
import { createGitProbe, createFsProbe } from './reconciler.js';

/**
 * 停用專案時，把它的本地狀態清乾淨。
 *
 * ── 為什麼是「清掉」而不是「留著等它回來」 ──
 *
 * 留著的話，下次啟用是拿**舊資料**在跑：任務板那邊可能已經改過描述、刪掉、
 * 或加了新的前置條件，而我們拿的是停用前那一刻的快照。
 *
 * 實跑撞到的更糟：停用期間 ledger 裡還留著 discovered 任務，於是每一輪 tick
 * 都想規劃它們、每一輪都因為「查不到專案」擲錯——而 tick 一擲錯，
 * **後面的輪詢、審查監看、合併佇列、待辦提醒全部跳過**。
 * 一個被停用的專案讓整個 daemon 空轉，而錯誤訊息只說「需要本地 checkout 路徑」。
 *
 * ── 哪些能清，哪些不能 ──
 *
 * `discovered` / `queued` 從來沒被認領過（沒呼叫過 start_task），清掉完全乾淨——
 * 下次啟用重新從任務板撈就好。
 *
 * 但**已經認領過的**不一樣：MCP 沒有「取消認領」這種工具（只有 start_task 與
 * complete_task），所以那張卡在任務板上會一直是 in_progress。本地清掉之後，
 * 下次啟用時 `list_tasks(status: todo)` 撈不到它，那張卡就永遠沒人碰。
 * 這件事沒辦法自動解決，只能明確講出來讓人去任務板改回 todo。
 */

/** 已經認領過的狀態（呼叫過 start_task）。清掉這些要提醒人去任務板處理。 */
const CLAIMED_STATES = new Set(['in_progress', 'verifying', 'done', 'blocked']);

export interface PurgeLedger {
  listTasksByState(state: Task['state']): Task[];
  listGroupsByState(state: Group['state']): Group[];
  deleteTask?(id: string): void;
  deleteGroup?(id: string): void;
  logEvent(scope: 'system', refId: string | null, kind: string, detail?: string): void;
}

export interface PurgeGit {
  removeWorktree(repoPath: string, worktreePath: string): Promise<void>;
  deleteBranch(repoPath: string, branch: string): Promise<void>;
  dirExists(path: string): Promise<boolean>;
}

export interface PurgeResult {
  /** 清掉的任務數（依狀態分類）。 */
  tasks: number;
  groups: number;
  worktrees: number;
  branches: number;
  /**
   * 已認領、需要人去任務板改回 todo 的任務。
   * **空陣列才代表這次停用完全無副作用。**
   */
  claimed: { id: string; title: string; state: string }[];
}

const ALL_TASK_STATES: Task['state'][] = ['discovered', 'queued', 'blocked', 'in_progress', 'verifying', 'done'];
const ALL_GROUP_STATES: Group['state'][] = [
  'ready', 'forming', 'pr_open', 'in_review', 'changes_requested', 'merge_guard', 'merged', 'failed',
];

/**
 * 清掉某個 repo 的本地狀態。
 *
 * git 相關的失敗只記錄不擲錯：worktree／分支清不掉是磁碟層面的問題，
 * 不該讓「停用專案」這個動作失敗——ledger 清乾淨才是重點。
 */
export async function purgeProjectState(
  repo: string,
  ledger: PurgeLedger,
  opts: { repoPath?: string; worktreeBase?: string; git?: PurgeGit; log: Logger },
): Promise<PurgeResult> {
  const result: PurgeResult = { tasks: 0, groups: 0, worktrees: 0, branches: 0, claimed: [] };

  const groups = ALL_GROUP_STATES.flatMap((s) => ledger.listGroupsByState(s)).filter((g) => g.repo === repo);
  const tasks = ALL_TASK_STATES.flatMap((s) => ledger.listTasksByState(s)).filter((t) => t.repo === repo);

  for (const t of tasks) {
    if (CLAIMED_STATES.has(t.state)) result.claimed.push({ id: t.id, title: t.title, state: t.state });
    ledger.deleteTask?.(t.id);
    result.tasks += 1;
  }

  const { git, repoPath, worktreeBase } = opts;
  for (const g of groups) {
    if (git && repoPath) {
      if (worktreeBase) {
        const wt = `${worktreeBase}/${worktreeDirNameOf(g.branch)}`;
        try {
          if (await git.dirExists(wt)) {
            await git.removeWorktree(repoPath, wt);
            result.worktrees += 1;
          }
        } catch (e) {
          opts.log.warn({ group: g.id, wt, err: msg(e) }, '清除 worktree 失敗（不影響停用）');
        }
      }
      // 分支要在 worktree 之後刪：git 不允許刪掉正被 worktree 檢出的分支
      try {
        await git.deleteBranch(repoPath, g.branch);
        result.branches += 1;
      } catch (e) {
        opts.log.warn({ group: g.id, branch: g.branch, err: msg(e) }, '刪除分支失敗（不影響停用）');
      }
    }
    ledger.deleteGroup?.(g.id);
    result.groups += 1;
  }

  ledger.logEvent(
    'system', null, 'project_purged',
    `${repo}：清除 ${result.tasks} 個任務、${result.groups} 個群組、`
      + `${result.worktrees} 個 worktree、${result.branches} 條分支`
      + (result.claimed.length ? `；${result.claimed.length} 個任務已在任務板上認領過，需人工改回 todo` : ''),
  );
  return result;
}

/** 與 WorktreeManager 的 slug 規則一致（同 reconciler.worktreeDirName）。 */
export function worktreeDirNameOf(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 組出「停用某專案時要做的清理」這個函式。
 *
 * 兩個進入點（daemon 內建控制台、獨立控制台）必須用同一個，否則從哪一邊按停用
 * 會有不同結果。ConsoleDeps 把它列為**必填**就是為了這件事——少接一邊，
 * typecheck 當場就會擋下來，而不是等到實跑才發現「停用了但東西還在」。
 */
export function projectPurgerOf(deps: {
  store: { allProjects(): { config: { repo: string; repoPath: string } }[] };
  ledger: PurgeLedger;
  worktreeBase: string;
  log: Logger;
  git?: PurgeGit;
}): (repo: string) => Promise<PurgeResult> {
  const git = deps.git ?? defaultPurgeGit(deps.log);
  return (repo) => {
    // repoPath 要在旗標改掉之前查得到；查不到就只清 ledger（worktree 留著等對帳收）
    const repoPath = deps.store.allProjects().find((p) => p.config.repo === repo)?.config.repoPath;
    return purgeProjectState(repo, deps.ledger, {
      ...(repoPath ? { repoPath } : {}),
      worktreeBase: deps.worktreeBase,
      git,
      log: deps.log,
    });
  };
}

/** purgeProjectState 需要的 git 能力——沿用對帳那組探針，行為一致。 */
export function defaultPurgeGit(log: Logger): PurgeGit {
  const git = createGitProbe(log);
  const fs = createFsProbe();
  return {
    removeWorktree: (repoPath, wt) => git.removeWorktree(repoPath, wt),
    deleteBranch: (repoPath, branch) => git.deleteBranch(repoPath, branch),
    dirExists: (path) => fs.dirExists(path),
  };
}
