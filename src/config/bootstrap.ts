import { join, resolve } from 'node:path';

/**
 * 開機前就要知道、因此**不能**存在 DB 裡的東西。
 *
 * 雞生蛋：其他設定全部存在 SQLite，但「SQLite 在哪」本身沒辦法從 SQLite 讀。
 * 同理，單一實例鎖必須在開 DB 之前就取得（兩個 daemon 同時開同一個 ledger
 * 會互相把對方正在用的 worktree 對帳掉）。
 *
 * 所以只有這兩個值來自環境變數，其餘一律由控制台管理。
 * 這也是刻意的邊界：能改「DB 在哪」的介面，如果它自己就住在那個 DB 裡，
 * 改完就再也找不到自己了。
 */
export interface Bootstrap {
  /** prod = 正式；test = 測試（**整個資料目錄都不同**，互不污染）。 */
  profile: Profile;
  /**
   * 這個 profile 的資料根目錄（絕對路徑）。
   *
   * worktree、合併工作區、截圖、瀏覽器暫存、備份**全部**掛在這底下。
   * 原本只有 ledger 與鎖檔分 profile，其餘共用——於是跑一次測試就會把 worktree
   * 建進正式那份目錄、截圖與備份也混進去。分不出哪些是真的，清理時也不敢下手。
   */
  dataRoot: string;
  /** SQLite ledger 檔案路徑（絕對路徑）。 */
  ledgerPath: string;
  /** 單一實例鎖檔路徑（絕對路徑）。 */
  lockPath: string;
  /** 控制台的埠（正式 8787、測試 8788；ORCH_CONSOLE_PORT 可覆寫）。 */
  consolePort: number;
}

export const DEFAULT_DATA_ROOT = './data';
export const TEST_DATA_ROOT = './data/test';

/**
 * 控制台的埠也要分 profile。
 *
 * 兩邊都寫死 8787 的話，在開發資料夾開一次控制台就會搶掉正式那份的埠
 * ——而且症狀是「正式的控制台起不來」或「打開看到的是測試的資料」，兩種都很難查。
 * 這是資料目錄之外的第三個共用資源（前兩個：ledger、worktree 等產出目錄）。
 */
export const DEFAULT_CONSOLE_PORT = 8787;
export const TEST_CONSOLE_PORT = 8788;
/** ledger 與鎖檔在各自的 dataRoot 底下，檔名一致（看路徑就知道是哪個 profile）。 */
export const LEDGER_FILENAME = 'ledger.db';
export const LOCK_FILENAME = 'orchestrator.lock';

/**
 * 執行設定檔（profile）：正式與測試各用一份資料庫。
 *
 * 沒有這個分離的話，跑一次 e2e、開一次 --once 除錯，都會在正式 ledger 裡留下
 * boot／reconcile／discovered 事件，甚至建出測試用的群組與任務。那些垃圾會混進
 * 成本統計、控制台的清單、崩潰對帳的判斷——而且事後分不出哪些是真的。
 *
 * 預設是 **prod**：忘了設的時候應該落在「不會弄壞測試」那一邊，而不是反過來。
 */
export type Profile = 'prod' | 'test';

export function profileOf(env: NodeJS.ProcessEnv = process.env): Profile {
  const raw = (env.ORCH_PROFILE ?? '').trim().toLowerCase();
  if (raw === 'test') return 'test';
  // NODE_ENV=test（測試框架常自動設）也視為測試，免得忘了設 ORCH_PROFILE 就污染正式庫
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'test') return 'test';
  return 'prod';
}

export function loadBootstrap(env: NodeJS.ProcessEnv = process.env, baseDir = process.cwd()): Bootstrap {
  const profile = profileOf(env);
  const pick = (v: string | undefined, fallback: string): string =>
    resolve(baseDir, v && v.trim() !== '' ? v.trim() : fallback);
  const dataRoot = pick(env.ORCH_DATA_ROOT, profile === 'test' ? TEST_DATA_ROOT : DEFAULT_DATA_ROOT);
  return {
    profile,
    dataRoot,
    // 明確指定的路徑優先（e2e harness 會指到自己的暫存目錄）
    ledgerPath: pick(env.ORCH_LEDGER_PATH, join(dataRoot, LEDGER_FILENAME)),
    lockPath: pick(env.ORCH_LOCK_PATH, join(dataRoot, LOCK_FILENAME)),
    consolePort: consolePortOf(env, profile),
  };
}

/** 控制台的埠：環境變數優先，其次依 profile。 */
export function consolePortOf(env: NodeJS.ProcessEnv = process.env, profile: Profile = profileOf(env)): number {
  const raw = Number(env.ORCH_CONSOLE_PORT);
  if (Number.isInteger(raw) && raw > 0 && raw < 65536) return raw;
  return profile === 'test' ? TEST_CONSOLE_PORT : DEFAULT_CONSOLE_PORT;
}
