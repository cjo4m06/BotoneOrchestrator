// SQLite schema（對映 DESIGN.md §11）。以字串常數內嵌，避免 build 時檔案搬移問題。
export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  payload_hash   TEXT NOT NULL,
  repo           TEXT NOT NULL,
  category       TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL,
  dependencies   TEXT NOT NULL DEFAULT '[]',   -- JSON array（只當順序提示）
  doc_refs       TEXT NOT NULL DEFAULT '[]',   -- JSON array "path#section"
  state          TEXT NOT NULL,
  block_reason   TEXT,
  block_detail   TEXT,
  group_id       TEXT,
  slack_thread_ts TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  source_updated_at INTEGER,                  -- MCP 端最後活動時間（靜置期用）
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_repo  ON tasks(repo);
CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id);

CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  repo        TEXT NOT NULL,
  branch      TEXT NOT NULL,
  task_ids    TEXT NOT NULL DEFAULT '[]',
  footprint   TEXT NOT NULL DEFAULT '[]',
  after_groups TEXT NOT NULL DEFAULT '[]',
  state       TEXT NOT NULL,
  pr_url      TEXT,
  pr_number   INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_state ON groups(state);

CREATE TABLE IF NOT EXISTS task_iterations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  round       INTEGER NOT NULL,
  signature   TEXT NOT NULL,
  green       INTEGER NOT NULL,
  diff_hash   TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_iter_task ON task_iterations(task_id);
-- 保留策略要「每個任務留最近 N 筆」，需要 (task_id, round) 的走訪順序；
-- created_at 索引則讓「刪除逾期」不必全表掃描。
CREATE INDEX IF NOT EXISTS idx_iter_task_round ON task_iterations(task_id, round DESC);
CREATE INDEX IF NOT EXISTS idx_iter_created ON task_iterations(created_at);

CREATE TABLE IF NOT EXISTS clarifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  thread_ts   TEXT NOT NULL,
  question    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | answered | timeout
  answer      TEXT,
  created_at  INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_clar_thread ON clarifications(thread_ts);
CREATE INDEX IF NOT EXISTS idx_clar_task   ON clarifications(task_id);

-- agent 執行紀錄：一列 = 一個任務在一個 SDK session 上的一次執行。
--
-- 兩個用途：
--   1. **session 追蹤**：哪個任務用哪個 session_id 跑的。人回覆澄清後要 resume 同一個
--      session（而不是整個任務重跑），就得靠這張表找回 session_id；事後查 log 也要靠它對照。
--   2. **成本歸屬**：SDK 每輪 result 會給 total_cost_usd 與各模型的 token 用量，
--      累加在這裡才答得出「這個任務／這個群組花了多少錢」。
-- 一列 = 一個 agent 的一次執行（同 session 多輪會累加）。
--
-- **不是只有寫程式的 agent**。先前只有 Worker 會寫這張表，於是規劃、reviewer、
-- 三個判斷者的花費一毛都沒被記——一次跑 13 分鐘、輸出 139k token 的規劃，帳面 $0。
-- 更糟的是預算閘門（orchestrator 的 withinBudget）用的是同一份數字，
-- 使用者設的花費上限因此只擋到一部分的支出。
CREATE TABLE IF NOT EXISTS agent_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 判斷者／規劃者不屬於任何單一任務時是 ''（哨兵值）。
  -- 不改成 nullable 是因為 UNIQUE(task_id, session_id) 在 SQLite 裡對 NULL 不生效，
  -- 那會讓同一個 session 重複寫入時長出多列而不是累加。
  task_id       TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'worker', -- worker | plan | reviewer | ui_judge | drift_judge | merge_risk_judge
  repo          TEXT,
  group_id      TEXT,
  session_id    TEXT NOT NULL,
  rounds        INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL    NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  models        TEXT,                        -- JSON: 用過的模型名稱陣列
  status        TEXT NOT NULL DEFAULT 'active', -- active | done | parked | error
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(task_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON agent_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_group ON agent_sessions(group_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON agent_sessions(created_at);

-- 設定：整個系統唯一的設定來源（取代原本的 config/*.yaml）。
--
-- 為什麼放 DB 而不是設定檔：控制台要能改，改完要立刻生效。
-- 寫檔的話 (a) 程式改寫檔案很脆弱（註解、順序、引號），(b) 檔案改了還得重啟才會被讀到，
-- 那控制台就只是個很貴的文字編輯器。DB 可以精準 UPDATE 單一欄位，也能被熱重載讀走。
-- 密鑰放這裡的保護等級與 .env 相同（同機器、同使用者權限、data/ 已在 .gitignore）。
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,   -- 目前只有 'orchestrator'
  value      TEXT NOT NULL,      -- JSON，由 zod schema 驗證（schema 仍是唯一的型別事實源）
  updated_at INTEGER NOT NULL
);

-- 專案：一列一個 MCP 任務板。config 存整份 JSON（含 mcp url/token、commands、visual…），
-- 另外把 repo 與 enabled 拉成欄位，因為熱重載每輪都要用它們過濾。
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  repo       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  config     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_repo ON projects(repo);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,   -- task | group | system
  ref_id     TEXT,
  kind       TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ref ON events(ref_id);
-- events 從「只寫的稽核表」變成也要讀（審查去重、審查意見跨重啟回讀），
-- 查詢型態固定是 (ref_id, kind) 取最新一筆，故加複合索引；created_at 供保留策略掃描。
CREATE INDEX IF NOT EXISTS idx_events_lookup ON events(ref_id, kind, id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

-- 現在誰在做什麼。**這張表是活的，不是稽核紀錄**：工作開始寫一列、結束刪掉。
--
-- 為什麼需要一張表而不是只看任務狀態：花時間最久的那幾件事根本不對應任何狀態變化。
-- 規劃 agent 讀完整個 repo 再分群要跑好幾分鐘、reviewer 在審、判斷者在開瀏覽器量版面、
-- 合併把關在比對 diff——這些期間 ledger 完全靜止，控制台看起來就像平台停擺了
-- （使用者實際回報：「我以為整個專案都在停擺」）。
--
-- 放 DB 而不是放記憶體，因為獨立控制台（npm run console）是**另一個行程**，
-- 讀不到 daemon 的記憶體。同一個 SQLite 是兩邊唯一的共同介面。
CREATE TABLE IF NOT EXISTS activity (
  id           TEXT PRIMARY KEY,  -- 呼叫端給的穩定 id（同一件事重入時覆蓋，不會長出兩列）
  kind         TEXT NOT NULL,     -- plan | poll | code | verify | review | judge | merge …
  repo         TEXT,
  ref_id       TEXT,              -- 對應的 task/group id（可空）
  title        TEXT NOT NULL,     -- 給人看的一句話：「規劃 14 個任務的分群」
  detail       TEXT,              -- 次要說明：第幾次嘗試、跑哪一關
  started_at   INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL   -- 最後一次還活著的時間；daemon 被 kill 的殘留列靠它判死
);
CREATE INDEX IF NOT EXISTS idx_activity_started ON activity(started_at);
`;

/**
 * 既有 DB 的欄位補齊。
 *
 * SCHEMA 用的是 CREATE TABLE IF NOT EXISTS：新表會建，但**已存在的表不會長出新欄位**。
 * 常駐系統的 DB 是連續使用的，加欄位若沒有這一段，升級後每個查詢都會 `no such column` 炸掉。
 * 只做「加欄位」這一種遷移（不改型別、不刪欄位），所以無條件安全、可重複執行。
 */
export const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: 'tasks', column: 'source_updated_at', ddl: 'ALTER TABLE tasks ADD COLUMN source_updated_at INTEGER' },
  // 執行階段：這個群要等哪些群結束才能開跑（規劃 agent 排出來的順序）
  { table: 'groups', column: 'after_groups', ddl: "ALTER TABLE groups ADD COLUMN after_groups TEXT NOT NULL DEFAULT '[]'" },
  // 記帳從「只有寫程式的 agent」擴到全部角色（規劃／reviewer／三個判斷者）
  { table: 'agent_sessions', column: 'kind', ddl: "ALTER TABLE agent_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'worker'" },
  { table: 'agent_sessions', column: 'repo', ddl: 'ALTER TABLE agent_sessions ADD COLUMN repo TEXT' },
];

export interface MigratableDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): unknown;
}

/** 回傳實際執行的遷移數（測試與啟動日誌用）。 */
export function applyColumnMigrations(db: MigratableDb): number {
  let applied = 0;
  for (const m of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name?: string }[];
    if (cols.length === 0) continue; // 表還不存在 → SCHEMA 會用完整定義建，不需要遷移
    if (cols.some((c) => c.name === m.column)) continue;
    db.exec(m.ddl);
    applied++;
  }
  return applied;
}
