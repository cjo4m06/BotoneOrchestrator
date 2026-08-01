import { execaSync } from 'execa';
import { createTmpDir, type TmpDir } from './tmp.js';

export interface TmpGitRepo {
  dir: TmpDir;
  /** repo 根目錄絕對路徑。 */
  path: string;
  /** 在此 repo 執行 git 指令，回傳 trim 過的 stdout。 */
  git(...args: string[]): string;
  /** 寫檔並 commit，回傳新的 commit sha。 */
  commit(files: Record<string, string>, message: string): string;
  /** 目前 HEAD sha。 */
  head(): string;
  /** 目前分支名。 */
  branch(): string;
  cleanup(): void;
}

// 測試環境不得依賴使用者的 git 全域設定（簽章/hook/預設分支都可能不同）
const ISOLATED_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Botone Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Botone Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
} as const;

/**
 * 建立暫存 git repo：git init（預設分支 main）+ 一次初始 commit。
 * 供 worktree / diff / merge-guard 這類需要真實 repo 的測試使用。
 */
export function createTmpGitRepo(
  opts: { files?: Record<string, string>; branch?: string; message?: string } = {},
): TmpGitRepo {
  const dir = createTmpDir('botone-repo-');
  const cwd = dir.path;
  const branch = opts.branch ?? 'main';
  const run = (...args: string[]): string =>
    execaSync('git', args, { cwd, env: ISOLATED_ENV, extendEnv: true }).stdout.trim();

  run('init', '--quiet', '-b', branch);
  run('config', 'user.name', 'Botone Test');
  run('config', 'user.email', 'test@example.com');
  run('config', 'commit.gpgsign', 'false');

  const files = opts.files ?? { 'README.md': '# tmp repo\n' };
  for (const [rel, content] of Object.entries(files)) dir.write(rel, content);
  run('add', '-A');
  run('commit', '--quiet', '-m', opts.message ?? 'chore: 初始 commit');

  return {
    dir,
    path: cwd,
    git: run,
    commit(newFiles, message) {
      for (const [rel, content] of Object.entries(newFiles)) dir.write(rel, content);
      run('add', '-A');
      run('commit', '--quiet', '-m', message);
      return run('rev-parse', 'HEAD');
    },
    head: () => run('rev-parse', 'HEAD'),
    branch: () => run('rev-parse', '--abbrev-ref', 'HEAD'),
    cleanup: () => dir.cleanup(),
  };
}
