import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
  if (copied.length > 0) log.info({ wtPath, files: copied }, '本機設定檔已帶入工作區');
  return copied;
}
