import { execa } from 'execa';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Logger } from '../observability/logger.js';

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/** 將分支名轉成安全的目錄名。 */
function slug(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * 正規化路徑再比對。
 * 為什麼不能直接比字串：`git worktree list` 回的是**解析過 symlink 的真實路徑**
 * （macOS 上 /var/... 會變成 /private/var/...），直接比會判成「不是同一個 worktree」，
 * 於是明明可以沿用的目錄被當成殘骸擋下來——那正是我們要修的斷掉的恢復路徑。
 */
function samePath(a: string, b: string): boolean {
  return realPath(a) === realPath(b);
}

function realPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // 路徑本身不存在（例如目錄被手動刪掉，但 git 還留著登記）：改解析父目錄再接回檔名，
    // 否則 /var 與 /private/var 這種差異會讓「登記還在」的情況永遠比對不到。
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

/**
 * git worktree 管理器（DESIGN.md §D5/§D6）。
 * 每個 group 一條分支、一個獨立 worktree 目錄；群間並行靠此隔離，互不踩檔。
 */
export class WorktreeManager {
  constructor(private baseDir: string, private log: Logger) {
    mkdirSync(resolve(baseDir), { recursive: true });
  }

  private async git(repoPath: string, args: string[]): Promise<string> {
    const res = await execa('git', ['-C', repoPath, ...args]);
    return res.stdout.trim();
  }

  private async branchExists(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 為 repo 建立一個 worktree（**冪等**）。
   * branch 不存在 → 以 base（預設 HEAD）為基底建新分支；已存在 → 直接掛上。
   *
   * 為什麼必須冪等：park（等人回覆／審查要求修改）的群組會**保留 worktree**，
   * 保住 agent 尚未提交的成果；人回覆後群組被重新派工，這裡就會第二次被呼叫。
   * 若照舊直接 `worktree add`，git 會因目錄已存在而擲錯，例外被收斂成群組 failed（終態）
   * ⇒ 恢復路徑等於是斷的。所以「已存在且確實是同一個 worktree、分支也相符」時直接沿用。
   *
   * 但**不盲目沿用**：目錄存在不代表它是這個 repo 的 worktree，也不代表它停在對的分支。
   * 沿用錯的目錄會讓 agent 在別的分支上寫程式、成果被合進錯的地方，所以這兩種情形一律
   * 視為真錯誤往外擲（也絕不自動刪除目錄——裡面可能正是別人未提交的工作）。
   */
  async create(repoPath: string, branch: string, opts: { base?: string } = {}): Promise<WorktreeInfo> {
    const worktreePath = join(resolve(this.baseDir), slug(branch));

    const reused = await this.reuseExisting(repoPath, worktreePath, branch);
    if (reused) return reused;

    if (await this.branchExists(repoPath, branch)) {
      await this.git(repoPath, ['worktree', 'add', worktreePath, branch]);
    } else {
      const base = opts.base ?? 'HEAD';
      await this.git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, base]);
    }

    await this.excludeToolJunk(worktreePath);
    this.log.info({ repoPath, branch, worktreePath }, '建立 worktree');
    return { path: worktreePath, branch };
  }

  /**
   * 把工具的暫存輸出寫進**這個 worktree 私有的**忽略清單。
   *
   * 為什麼是 `.git/info/exclude` 而不是 `.gitignore`：
   * `.gitignore` 是被追蹤的檔案，動它本身就是一筆 diff——會出現在 PR 裡、
   * 也會被「diff 非空」的 DoD 當成「有做事」。`.git/info/exclude` 是每個工作區私有、
   * 不進版控，正是為這種情況存在的。
   *
   * 目前擋的是 Playwright MCP 的輸出目錄（它預設寫在「當下工作目錄」）。
   * 這是第二道防線——第一道是啟動時用 --output-dir 指到 worktree 外。
   * 兩道都設是因為換版本／換工具時第一道可能失效，而失效的症狀
   * （PR 混進一堆 .yml、DoD 被垃圾檔滿足）很難一眼看出來。
   */
  private async excludeToolJunk(worktreePath: string): Promise<void> {
    const entries = ['.playwright-mcp/'];
    try {
      // worktree 的 .git 是檔案不是目錄，內容指向真正的 git dir
      const gitDir = await this.git(worktreePath, ['rev-parse', '--git-dir']);
      if (!gitDir) return;
      const abs = isAbsolute(gitDir) ? gitDir : join(worktreePath, gitDir);
      const file = join(abs, 'info', 'exclude');
      mkdirSync(dirname(file), { recursive: true });
      const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const missing = entries.filter((e) => !existing.split('\n').some((l) => l.trim() === e));
      if (missing.length === 0) return;
      appendFileSync(file, `${existing.endsWith('\n') || existing === '' ? '' : '\n'}# 工具暫存輸出（不進版控）\n${missing.join('\n')}\n`);
    } catch (e) {
      // 寫不進去只是少一道防線，還有 --output-dir 與 commitAll 的 pathspec 兜著
      this.log.warn({ worktreePath, err: e instanceof Error ? e.message : String(e) }, '寫入 info/exclude 失敗（忽略）');
    }
  }

  /**
   * 判斷既有目錄能不能直接沿用。
   * 回 WorktreeInfo = 可沿用；回 undefined = 沒有障礙，照常新建；擲錯 = 有東西擋著且不該自動處理。
   */
  private async reuseExisting(repoPath: string, worktreePath: string, branch: string): Promise<WorktreeInfo | undefined> {
    const registered = (await this.list(repoPath).catch(() => [] as WorktreeInfo[])).find((w) =>
      samePath(w.path, worktreePath),
    );

    if (!registered || !existsSync(worktreePath)) {
      if (registered) {
        // 有登記、目錄卻不見了（被人手動刪掉）：沒有成果可保，prune 掉登記後照常新建
        this.log.warn({ repoPath, worktreePath }, 'worktree 有登記但目錄不存在，prune 後重建');
      } else if (existsSync(worktreePath)) {
        // 目錄在、卻不在本 repo 的 worktree 清單上：可能是上次被強制刪除後殘留的空殼、
        // 也可能是別的 repo 的 worktree 佔用了同名目錄。裡面可能有未提交的成果，不自動刪。
        throw new Error(
          `worktree 目錄已存在但不是 ${repoPath} 登記的 worktree：${worktreePath}` +
            `（可能是殘骸或被其他 repo 佔用）。為避免誤刪未提交的成果，請人工確認後移除。`,
        );
      }
      // 目錄不在、登記可能還留著（remove 只刪目錄的情況）→ prune 掉，否則 add 會說 already registered
      await this.git(repoPath, ['worktree', 'prune']).catch((e) => {
        this.log.warn({ err: String(e), repoPath }, 'worktree prune 失敗（忽略，繼續嘗試建立）');
        return '';
      });
      return undefined;
    }

    if (registered.branch !== branch) {
      // 分支不符：沿用會讓 agent 寫在別的分支上（成果最後併進錯的地方），是最需要擋下的情況
      throw new Error(
        `worktree ${worktreePath} 已存在但位於分支「${registered.branch}」，預期「${branch}」。` +
          `為避免在錯誤的分支上寫入，請人工確認後處理。`,
      );
    }

    this.log.info({ repoPath, branch, worktreePath }, '沿用既有 worktree（保住上一輪未提交的成果）');
    return { path: worktreePath, branch };
  }

  /** 移除 worktree（強制），並 prune 殘留登記。 */
  async remove(repoPath: string, worktreePath: string): Promise<void> {
    await this.git(repoPath, ['worktree', 'remove', '--force', worktreePath]).catch(async (e) => {
      this.log.warn({ err: String(e), worktreePath }, 'worktree remove 失敗，嘗試 prune');
    });
    await this.git(repoPath, ['worktree', 'prune']);
    this.log.info({ worktreePath }, '移除 worktree');
  }

  /** 列出 repo 目前的所有 worktree（含主工作區）。 */
  async list(repoPath: string): Promise<WorktreeInfo[]> {
    const out = await this.git(repoPath, ['worktree', 'list', '--porcelain']);
    const infos: WorktreeInfo[] = [];
    let cur: Partial<WorktreeInfo> = {};
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) cur.path = line.slice('worktree '.length);
      else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).replace('refs/heads/', '');
      else if (line === '') {
        if (cur.path) infos.push({ path: cur.path, branch: cur.branch ?? '(detached)' });
        cur = {};
      }
    }
    if (cur.path) infos.push({ path: cur.path, branch: cur.branch ?? '(detached)' });
    return infos;
  }
}
