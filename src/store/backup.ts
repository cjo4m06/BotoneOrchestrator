import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

import type { Logger } from '../observability/logger.js';

/**
 * 啟動時備份 ledger。
 *
 * 資料庫現在是唯一事實源：所有設定、所有密鑰、所有任務與成本紀錄都在裡面。
 * 誤刪 `data/`、磁碟壞掉、或某次遷移寫壞，代價是全部重來——包括重新申請 token。
 *
 * 用 SQLite 的 `VACUUM INTO` 而不是複製檔案：WAL 模式下直接 copy 主檔會拿到
 * 「少了還在 WAL 裡的那些交易」的版本，看起來成功、還原時才發現少東西。
 * VACUUM INTO 產生的是一致的快照。失敗才退回檔案複製（總比沒有好，但會標明）。
 */

export interface BackupOptions {
  /** 保留幾份（由新到舊）。預設 10。 */
  keep?: number;
  /** 備份目錄。預設 <ledger 所在目錄>/backups。 */
  dir?: string;
  /** 檔名時間戳（測試注入用）。 */
  stamp?: string;
}

export function backupLedger(ledgerPath: string, log: Logger, opts: BackupOptions = {}): string | undefined {
  if (!existsSync(ledgerPath)) return undefined; // 全新安裝，沒有東西可備份

  const dir = opts.dir ?? join(dirname(ledgerPath), 'backups');
  const keep = Math.max(1, opts.keep ?? 10);
  const stamp = opts.stamp ?? timestamp();
  const target = join(dir, `ledger-${stamp}.db`);

  // 連目錄都建不起來（權限、同名檔案佔位）也只能放棄備份——
  // **絕不能讓備份失敗變成啟動失敗**，那等於「保險買不到就不准出門」。
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    log.error({ dir, err: e instanceof Error ? e.message : String(e) }, '備份目錄建立失敗，跳過備份（啟動繼續）');
    return undefined;
  }

  try {
    const db = new Database(ledgerPath, { readonly: true });
    try {
      // 參數不能綁在 VACUUM INTO 上，只能字串內嵌 → 單引號跳脫避免路徑帶引號時炸掉
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
  } catch (e) {
    // 退而求其次：WAL 可能導致快照不完整，所以要標明這是降級的備份
    try {
      copyFileSync(ledgerPath, target);
      log.warn(
        { err: e instanceof Error ? e.message : String(e), target },
        'VACUUM INTO 失敗，改用檔案複製（WAL 中未落盤的交易可能不在這份備份裡）',
      );
    } catch (e2) {
      log.error({ err: e2 instanceof Error ? e2.message : String(e2) }, '資料庫備份失敗（啟動繼續）');
      return undefined;
    }
  }

  const removed = prune(dir, keep);
  log.info({ target, keep, removed }, '資料庫已備份');
  return target;
}

/** 只留最新的 keep 份。回傳刪掉的數量。 */
export function prune(dir: string, keep: number): number {
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir)
    .filter((f) => /^ledger-.*\.db$/.test(f))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const { f } of files.slice(keep)) {
    try {
      rmSync(join(dir, f));
      removed += 1;
    } catch {
      // 刪不掉就算了：保留策略失敗不該讓啟動失敗（頂多多佔一點磁碟）
    }
  }
  return removed;
}

function timestamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
