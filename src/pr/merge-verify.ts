import { execa } from 'execa';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../observability/logger.js';

/**
 * 拋棄式驗收樹：在「群分支併上最新 base 之後」的狀態上跑關卡。
 *
 * ── 為什麼不 rebase 群分支 ──
 *
 * 先前的做法是把群分支 rebase 到最新 base、驗完再 force-push 回去。那有兩個代價：
 * 1. **force push 是不可逆動作**，而且是最容易出事的那一種（lease 過期、
 *    別人剛推了東西、rebase 把成果重寫成別的 sha）。
 * 2. 分支被改寫之後，「使用者在 GitHub 上看到的那份」與「我們驗過的那份」不是同一個東西。
 *
 * 改成：**永遠不動群分支**。在一棵拋棄式的樹上 detach 到群分支的 sha，
 * 把 base 併進來（`git merge`，不是 rebase），跑關卡，跑完連樹一起刪掉。
 * 整整一類不可逆動作因此消失。
 *
 * 代價要講清楚：PR 在 GitHub 上會一直顯示 "out of date"（因為我們驗的是合併後狀態、
 * 不是 head）。那是正常的，PR 內文會說明。
 *
 * ── 為什麼用裸 git 而不是 WorktreeManager ──
 *
 * **`withRepoLock` 不可重入**（它是 promise 佇列：`prev.then(...)`）。合併路徑整段
 * 持著同鍵的鎖，而 `WorktreeManager.create` 內部也要那把鎖——內層排在外層後面、
 * 外層等內層回來，**永久死鎖，不拋錯、不留 log**，症狀是那個 repo 之後所有群組全部靜止。
 * 見 test/repo-lock-reentrancy.test.ts。
 */

export type GitRun = (cwd: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const defaultGit: GitRun = async (cwd, args) => {
  const r = await execa('git', ['-C', cwd, ...args], { reject: false, all: true });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export interface MergeTree {
  /** 樹的路徑（跑關卡的 cwd）。 */
  path: string;
  /** 這次驗的是對著哪一顆 base（40 位 sha）。 */
  verifiedBaseSha: string;
  /** 合併之後的 HEAD。 */
  headSha: string;
  /** 用完一定要叫——它會把樹整個刪掉。 */
  dispose(): Promise<void>;
}

export type MergeTreeResult =
  | { ok: true; tree: MergeTree }
  /**
   * 併不起來。`conflicts` 來自 `git diff --name-only --diff-filter=U` ——
   * **機器格式，不是解析 git 印給人看的那份**。
   * 先前是從人類可讀訊息用正則撈檔名，12 個檔衝突時會掉 5 個，
   * 然後用肯定句對 agent 說「衝突檔案：…」。
   */
  | { ok: false; reason: 'conflict'; conflicts: string[]; output: string }
  | { ok: false; reason: 'setup_failed'; output: string };

export interface MergeTreeInput {
  /** 主 clone 的路徑。 */
  repoPath: string;
  /** 群分支（**不會被修改**）。 */
  branch: string;
  /** 要併進來的 base ref，例如 `origin/main`。 */
  baseRef: string;
  log: Logger;
  git?: GitRun;
  /** 樹建好之後的準備工作（node_modules、本機設定檔）。跑關卡前一定要有。 */
  prepare?: (treePath: string) => Promise<void>;
  /** 樹要建在哪（測試用；預設系統暫存目錄）。 */
  root?: string;
}

/**
 * 建一棵「群分支 ＋ 最新 base」的拋棄式樹。
 *
 * 全程用裸 git（見檔頭：不能碰 WorktreeManager，那裡有不可重入的鎖）。
 * 任何一步失敗都會把已經建好的東西清乾淨再回報——半個樹留在磁碟上，
 * 下一輪 `git worktree add` 會撞到同名而失敗，那是一整群報銷。
 */
export async function createMergeTree(input: MergeTreeInput): Promise<MergeTreeResult> {
  const git = input.git ?? defaultGit;
  const { repoPath, branch, baseRef, log } = input;
  const root = input.root ?? tmpdir();
  const treePath = mkdtempSync(join(root, 'orch-merge-'));

  const cleanup = async (): Promise<void> => {
    // 順序重要：先讓主 clone 忘掉這棵樹，再刪目錄。反過來的話
    // `.git/worktrees/` 會留下指向不存在路徑的殘骸，之後 `worktree add` 會抱怨。
    await git(repoPath, ['worktree', 'remove', '--force', treePath]).catch(() => undefined);
    rmSync(treePath, { recursive: true, force: true });
    await git(repoPath, ['worktree', 'prune']).catch(() => undefined);
  };

  const fail = async (reason: 'conflict' | 'setup_failed', output: string, conflicts?: string[]): Promise<MergeTreeResult> => {
    await cleanup();
    return reason === 'conflict'
      ? { ok: false, reason, conflicts: conflicts ?? [], output }
      : { ok: false, reason, output };
  };

  // 1) detach 到群分支的 sha。**detach 是關鍵**：分支本身不能被任何東西簽出兩次，
  //    而群 worktree 可能正拿著它（park 的群刻意保留現場）。
  const tip = await git(repoPath, ['rev-parse', branch]);
  if (tip.exitCode !== 0) return fail('setup_failed', `解不開群分支 ${branch}：${tip.stderr}`);
  const branchSha = tip.stdout.trim();

  const add = await git(repoPath, ['worktree', 'add', '--detach', treePath, branchSha]);
  if (add.exitCode !== 0) return fail('setup_failed', `建立驗收樹失敗：${add.stdout}\n${add.stderr}`);

  const baseSha = (await git(repoPath, ['rev-parse', baseRef])).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(baseSha)) return fail('setup_failed', `解不開 base ${baseRef}`);

  // 2) 把 base 併進來。**merge 不是 rebase**：群分支的 commit 一顆都不會被改寫，
  //    所以永遠不需要 force push。
  const merged = await git(treePath, [
    '-c', 'user.name=orchestrator', '-c', 'user.email=orchestrator@local',
    'merge', '--no-edit', baseSha,
  ]);
  if (merged.exitCode !== 0) {
    // 衝突檔案從**機器格式**拿，不從人類可讀訊息撈
    const u = await git(treePath, ['diff', '--name-only', '--diff-filter=U']);
    const conflicts = u.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    log.warn({ branch, baseRef, conflicts: conflicts.length }, '併上最新 base 時有衝突');
    return fail('conflict', `${merged.stdout}\n${merged.stderr}`, conflicts);
  }

  const headSha = (await git(treePath, ['rev-parse', 'HEAD'])).stdout.trim();

  if (input.prepare) {
    try {
      await input.prepare(treePath);
    } catch (e) {
      // 沒有 node_modules／設定檔就跑關卡，紅的是環境不是程式碼——
      // 那會讓 agent 去修一個根本沒壞的東西。
      return fail('setup_failed', `驗收樹的依賴準備失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  log.info(
    { branch, baseRef, baseSha: baseSha.slice(0, 8), headSha: headSha.slice(0, 8), tree: treePath },
    '驗收樹已備妥（群分支併上最新 base，分支本身未被修改）',
  );

  return {
    ok: true,
    tree: { path: treePath, verifiedBaseSha: baseSha, headSha, dispose: cleanup },
  };
}
