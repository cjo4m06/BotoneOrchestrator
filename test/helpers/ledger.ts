import { Ledger } from '../../src/store/ledger.js';
import type { DiscoveredTaskInput } from '../../src/store/ledger.js';
import { createTmpDir, type TmpDir } from './tmp.js';
import { createSilentLogger } from './logger.js';

export interface TmpLedger {
  ledger: Ledger;
  /** ledger.db 的絕對路徑（測試可驗證檔案真的落地）。 */
  dbPath: string;
  dir: TmpDir;
  cleanup(): void;
}

/**
 * 建立暫存 SQLite ledger（已呼叫 init() 套用 schema）。
 * 走真實檔案而非 :memory:，因為 Ledger 建構子會 mkdir + 開 WAL，
 * 測試要涵蓋的正是這條真實路徑。
 */
export function createTmpLedger(): TmpLedger {
  const dir = createTmpDir('botone-ledger-');
  const dbPath = dir.join('data', 'ledger.db');
  const ledger = new Ledger(dbPath, createSilentLogger());
  ledger.init();
  return {
    ledger,
    dbPath,
    dir,
    cleanup() {
      try {
        ledger.close();
      } catch {
        // 已關閉時忽略，cleanup 必須可重入
      }
      dir.cleanup();
    },
  };
}

let seq = 0;

/** 產生 upsertDiscoveredTask 的輸入；欄位可覆寫。 */
export function makeDiscoveredTask(overrides: Partial<DiscoveredTaskInput> = {}): DiscoveredTaskInput {
  seq += 1;
  return {
    id: `T-${seq}`,
    payloadHash: `h${seq}`,
    repo: 'acme/web',
    category: 'dev',
    title: `任務 ${seq}`,
    description: `描述 ${seq}`,
    dependencies: [],
    docRefs: [],
    ...overrides,
  };
}
