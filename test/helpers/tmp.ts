import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface TmpDir {
  /** 暫存目錄絕對路徑。 */
  path: string;
  /** 在暫存目錄下寫檔（自動建立父目錄），回傳絕對路徑。 */
  write(relPath: string, content: string): string;
  /** 取暫存目錄下某相對路徑的絕對路徑。 */
  join(...parts: string[]): string;
  cleanup(): void;
}

/**
 * 建立一次性暫存目錄。測試務必在 t.after() 呼叫 cleanup()，
 * 避免 CI 累積殘留（macOS 的 /var 與 /private/var 是同一處，故 realpath 統一）。
 */
export function createTmpDir(prefix = 'botone-test-'): TmpDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    write(relPath, content) {
      const abs = resolve(path, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
      return abs;
    },
    join(...parts) {
      return resolve(path, ...parts);
    },
    cleanup() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/**
 * 在測試期間暫時覆寫環境變數，回傳還原函式。
 * 傳 undefined 代表「刪除該變數」，用來驗證 ${MISSING} 展開行為。
 */
export function withEnv(vars: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
