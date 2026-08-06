import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '../observability/logger.js';

/**
 * 把主 clone 根目錄下的**本機設定檔**帶進工作區。
 *
 * ── 為什麼這個要複製，依賴不要 ──
 *
 * 上面拆掉依賴的第二個理由（複製來的版本對不上這棵樹的 lockfile）**對設定檔不成立**：
 * `.env` 沒有 lockfile、沒有版控對照物，主 clone 那份就是唯一一份。
 * 不複製不會得到「比較舊的版本」，只會得到**沒有**——而 Laravel 少了 .env 會退回
 * `config/database.php` 的預設值，測試直接 `Access denied for user 'forge'`（實測）。
 *
 * ── 判準是 git，不是一份檔名清單 ──
 *
 * 先前寫死 `['.env', '.env.local', '.env.development', '.npmrc']`——又是一份會漏的清單
 *（composer 的 auth.json、Python 的 .env.test… 每種生態都不一樣）。
 *
 * 現在的規則：**根目錄下、主 clone 有而工作區沒有的「檔案」**。
 * 那等價於「git 管不到的根目錄檔案」——因為被追蹤的檔案 `git worktree add` 一定會簽出。
 * 目錄一律不碰：目錄就是依賴與建置產物，那些才是不能複製的東西。
 */
export async function prepareLocalConfig(
  repoPath: string,
  wtPath: string,
  log: Logger,
  io: {
    list: (dir: string) => { name: string; isFile: boolean }[];
    exists: (p: string) => boolean;
    copy: (a: string, b: string) => void;
  } = {
    list: (dir) => readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isFile: e.isFile() })),
    exists: existsSync,
    copy: (a, b) => copyFileSync(a, b),
  },
): Promise<string[]> {
  const copied: string[] = [];
  let entries: { name: string; isFile: boolean }[];
  try {
    entries = io.list(repoPath);
  } catch (e) {
    log.warn({ repoPath, err: e instanceof Error ? e.message : String(e) }, '讀不到主 clone 根目錄，略過本機設定檔');
    return copied;
  }
  for (const e of entries) {
    if (!e.isFile) continue; // 目錄＝依賴／產物，不碰
    const dst = join(wtPath, e.name);
    if (io.exists(dst)) continue; // 已被 git 簽出（＝有版控）或已經帶過
    try {
      io.copy(join(repoPath, e.name), dst);
      copied.push(e.name);
    } catch (err) {
      // 帶不過去只是少一個檔，不該讓整個群組跑不起來
      log.warn({ file: e.name, err: err instanceof Error ? err.message : String(err) }, '本機設定檔複製失敗（略過）');
    }
  }
  if (copied.length > 0) {
    log.info({ wtPath, files: copied }, '本機設定檔已帶入工作區');
    excludeCopied(wtPath, copied, log);
  }
  return copied;
}

/**
 * 把**調度器自己丟進去的檔案**寫進這個工作區私有的忽略清單。
 *
 * 為什麼一定要做：複製的判準是「主 clone 有、工作區沒有」＝ 未被追蹤，
 * 而三道「別把非本次改動掃進 PR」的防線（worktree 的 info/exclude、commitAll 的 pathspec、
 * status 的 --exclude-standard）前提都是「被 .gitignore 忽略」。**兩者不等價**：
 * 專案沒有 .gitignore、或它剛好沒列到某個檔（composer 的 auth.json、Python 的 .env.test），
 * 鏈條就完整了——複製進 worktree → 被列成未追蹤變更 →「diff 非空」這道排第一的 DoD
 * 在 agent 一行都沒改時就綠 → `git add -A` 把它 commit 進 PR。
 * 如果那個檔是 .env，那就是連密鑰一起進版控。
 *
 * 調度器**知道自己丟了哪些**（就是 copied），所以由它自己負責排除，
 * 不要指望專案的 .gitignore 剛好涵蓋。
 *
 * 用 `.git/info/exclude` 而不是 `.gitignore`：後者是被追蹤的檔案，動它本身就是一筆 diff。
 */
function excludeCopied(wtPath: string, copied: string[], log: Logger): void {
  try {
    // worktree 的 .git 是**檔案**，內容指向真正的 git dir
    const dotGit = join(wtPath, '.git');
    if (!existsSync(dotGit)) return;
    let gitDir: string;
    if (statSync(dotGit).isDirectory()) {
      gitDir = dotGit;
    } else {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
      if (!m?.[1]) return;
      gitDir = m[1].trim();
      if (!gitDir.startsWith('/')) gitDir = join(wtPath, gitDir);
    }
    // **必須寫 common-dir，不是每個 worktree 自己的 gitdir。**
    // 實測：把 /.env 寫進 `<main>/.git/worktrees/<name>/info/exclude` 完全沒有效果，
    // 寫進 `<main>/.git/info/exclude` 才生效——git 讀的是 $GIT_COMMON_DIR/info/exclude。
    // （git 把 gitdir 底下的 `commondir` 檔當指標，內容是相對路徑。）
    //
    // 代價：這份忽略清單是**整個 repo 共用的**，主 clone 也會跟著忽略那些檔。
    // 可以接受——我們只複製「主 clone 有、工作區沒有」的檔，也就是本來就沒被追蹤的東西；
    // 把它們列進本機忽略清單不會改變任何已追蹤檔案的狀態，而且 info/exclude 不進版控。
    const commonPtr = join(gitDir, 'commondir');
    const commonDir = existsSync(commonPtr)
      ? (() => {
          const rel = readFileSync(commonPtr, 'utf8').trim();
          return rel.startsWith('/') ? rel : join(gitDir, rel);
        })()
      : gitDir;
    const file = join(commonDir, 'info', 'exclude');
    mkdirSync(dirname(file), { recursive: true });
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const lines = existing.split('\n').map((l) => l.trim());
    const missing = copied.map((n) => `/${n}`).filter((e) => !lines.includes(e));
    if (missing.length === 0) return;
    appendFileSync(file, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}# 調度器帶進來的本機設定檔（不是這一群改的，不進 diff）\n${missing.join('\n')}\n`);
  } catch (e) {
    // 寫不進去只是少一道防線，不該讓群組跑不起來
    log.warn({ wtPath, err: e instanceof Error ? e.message : String(e) }, '寫入 info/exclude 失敗（忽略）');
  }
}
