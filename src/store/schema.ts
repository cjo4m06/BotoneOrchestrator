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
  -- 本任務**首次認領**時的 HEAD，DoD「diff 非空」關卡的基準。first-write-wins。
  -- 每輪重抓會讓重跑的任務把自己上一輪的 commit 算進基準 → 判「本輪無變更」（實跑撞過）。
  task_start_sha TEXT,
  -- 記下基準是「在哪條分支上」抓的。沿用前要比對——群分支被刪掉重開之後，
  -- 舊 sha 可能還解得開（所以 commitExists 擋不住）但已經太舊，
  -- 拿它當基準會讓 diff 含進別的任務的成果，關卡就變成橡皮圖章。
  task_start_branch TEXT,
  -- 這個任務**累計**用過哪些工具幾次（JSON: {"Read": 12, "mcp__docs__read_doc": 2}）。
  --
  -- 為什麼是累計而不是每輪：agent 會 resume session——第 1 輪讀了規格，第 3 輪不會再讀一次。
  -- 按輪算的話「這個任務從頭到尾沒查過規格」這個判斷會誤報。
  tool_calls TEXT,
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
  rationale  TEXT NOT NULL DEFAULT '',  -- 規劃 agent 說明「為什麼這幾個一組」；給下游 agent 當起手線索
  after_groups TEXT NOT NULL DEFAULT '[]',
  -- 這一群「從哪裡開工」的 base commit。**first-write-wins，永不重算。**
  -- 與 check_runs.verified_base_sha 語意相反（那個是「這次驗證對著哪顆 base」，每次重算）：
  -- 一旦有人把後者寫進這裡，擋「人在 GitHub 上自己按合併」的那道防線就變成自己跟自己比。
  -- 存的是 40 位 sha 不是 ref 名字——存 'origin/main' 等於欄位裡放一個會飄的東西。
  base_sha    TEXT,
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

-- 關卡執行的流水帳。**純記帳、零解讀**——這張表不判斷任何事，只記「跑了什麼、結果是什麼」。
--
-- 為什麼需要：先前每次跑完 build/test 就把輸出丟掉，只在 log 裡留一行綠或紅。
-- 於是「同一條分支 14:04:45 綠、14:13:51 紅」這種**只有橫跨時間才看得見**的事實，
-- 事後只能靠翻 stdout.log 一行一行對時間才發現——而那正是判斷「這個紅是不是這一群造成的」
-- 唯一有用的證據（實跑：PR #54 被一個完全無關的不穩定測試擋下，回灌三輪，16 個任務堵住）。
--
-- output 存**全文不截斷**：哪幾行有用只有讀的人（agent 或人）判斷得出來，
-- 程式用正則猜「哪行像失敗」換一個測試框架就會抓錯，而且沒有人會知道。
-- 超過 MAX_INLINE_OUTPUT 的部分 spill 成 dataRoot 底下的檔案（output_path），DB 只留頭尾。
CREATE TABLE IF NOT EXISTS check_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo           TEXT NOT NULL,
  branch         TEXT,
  -- 這一次是在哪一種工作區上跑的。group_tree 可寫可提交；verify_tree 與 merge_tree
  -- 是拋棄式的，跑完就刪，**它們的內容永遠不是任何東西的來源**。
  workspace_kind TEXT NOT NULL,            -- group_tree | verify_tree | merge_tree
  command        TEXT NOT NULL,
  head_sha       TEXT,                     -- 執行當下的 HEAD
  -- 這一次驗的是「對著哪一顆 base」。與 groups.base_sha（開工基準、永不重算）語意相反，
  -- 命名刻意分家：一旦有人把它寫進「永不重算」的欄位，擋「人在 GitHub 上自己按合併」
  -- 的那道防線就變成自己跟自己比。
  verified_base_sha TEXT,
  exit_code      INTEGER,                  -- NULL = 沒跑起來（指令不存在／逾時前就死）
  output         TEXT NOT NULL DEFAULT '',
  output_path    TEXT,                     -- 全文太長時的落地檔；prune 時要一起刪
  requested_by   TEXT NOT NULL,            -- coder | reviewer | merger | program
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_check_runs_repo_branch ON check_runs(repo, branch, started_at);
CREATE INDEX IF NOT EXISTS idx_check_runs_started ON check_runs(started_at);

-- 交接單：一個角色停下來、把事情交給下一個角色（或人）時開的單。
--
-- **停手與說話是同一個寫入動作。** body NOT NULL 就是這件事的實作——
-- 開不出一張沒有說明的單，也就停不了一個沒開單的群。先前那是兩件要「記得同步」的事，
-- 於是實跑撞到：兩個群耗盡重試停在 changes_requested、16 個任務堵著，
-- 而控制台顯示「沒有需要你處理的事項」（待處理清單只掃 failed，推論漏了一種狀態）。
--
-- **「等人」從推論變成資料**：'to_role='human' AND consumed_at IS NULL' 就是待處理清單，
-- 控制台／Slack／CLI 共用這一條查詢。推論會漏，查詢不會。
--
-- 機器可讀的**只有 to_role 與 kind 兩欄**：前者決定送給誰，後者決定 UI 畫哪幾顆按鈕。
-- 成因分類、判斷內容、該怎麼辦一律在 body 裡，程式不讀也不解析——
-- 這是為了不再長出第二個 semantic_drift（程式替失敗分類，然後假設失敗只有那幾種形狀）。
CREATE TABLE IF NOT EXISTS handoffs (
  id          TEXT PRIMARY KEY,
  group_id    TEXT,
  task_id     TEXT,
  from_role   TEXT NOT NULL,             -- planner | coder | reviewer | merger | program
  to_role     TEXT NOT NULL,             -- planner | coder | reviewer | merger | human
  -- UI 路由碼：這張單要畫哪一組按鈕、按下去打到哪個 handler。
  -- **這是「排版」不是「判斷」**——與被刪掉的 MergeVerdict.reason 性質不同：
  -- 那個是程式替失敗分類，這個是「這張單長什麼樣」。
  kind        TEXT NOT NULL,             -- clarification | no_change | needs_human | reclaim_blocked
                                         -- | merge_approval | stuck_group | review_feedback | delivery
  verdict     TEXT,                      -- agent 自己寫的一句結論（給人看，程式不解析）
  blocking    INTEGER NOT NULL DEFAULT 1, -- 0 = 只是留個紀錄，不擋流程
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,             -- 見上：NOT NULL 是刻意的，空字串由 openHandoff 擋
  options     TEXT,                      -- JSON：給人的選項
  if_ignored  TEXT,                      -- 不處理會怎樣
  blindspots  TEXT,                      -- 「我沒驗到什麼」——放行書必填，空白不合法
  evidence    TEXT,                      -- JSON：check_runs id／截圖路徑
  scope       TEXT,                      -- 這個答覆適用範圍：這張卡／這一群／以後都這樣
  session_id  TEXT,
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER                    -- 人／下一棒處理完的時間。NULL = 還在等
);
CREATE INDEX IF NOT EXISTS idx_handoffs_inbox ON handoffs(to_role, consumed_at, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_group ON handoffs(group_id);
CREATE INDEX IF NOT EXISTS idx_handoffs_task ON handoffs(task_id);
`;

/**
 * 既有 DB 的欄位補齊。
 *
 * SCHEMA 用的是 CREATE TABLE IF NOT EXISTS：新表會建，但**已存在的表不會長出新欄位**。
 * 常駐系統的 DB 是連續使用的，加欄位若沒有這一段，升級後每個查詢都會 `no such column` 炸掉。
 * 只做「加欄位」這一種遷移（不改型別、不刪欄位），所以無條件安全、可重複執行。
 */
// **新表只有「第一次部署之前」是免費的。**
// SCHEMA 裡的 CREATE TABLE IF NOT EXISTS 對已存在的表完全無效——正式 DB 一旦長出
// check_runs／handoffs，之後想加欄位就只能走下面這張清單。所以那兩張表的欄位是
// 一次建齊的（含目前還沒有寫入者的 verdict／blindspots／scope），寧可容忍 NULL。
export const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: 'tasks', column: 'source_updated_at', ddl: 'ALTER TABLE tasks ADD COLUMN source_updated_at INTEGER' },
  // 執行階段：這個群要等哪些群結束才能開跑（規劃 agent 排出來的順序）
  { table: 'groups', column: 'after_groups', ddl: "ALTER TABLE groups ADD COLUMN after_groups TEXT NOT NULL DEFAULT '[]'" },
  // 記帳從「只有寫程式的 agent」擴到全部角色（規劃／reviewer／三個判斷者）
  { table: 'agent_sessions', column: 'kind', ddl: "ALTER TABLE agent_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'worker'" },
  { table: 'agent_sessions', column: 'repo', ddl: 'ALTER TABLE agent_sessions ADD COLUMN repo TEXT' },
  // 規劃 agent 判斷「這幾個任務為什麼是一組」的理由——先前只寫 log 就丟掉了
  { table: 'groups', column: 'rationale', ddl: "ALTER TABLE groups ADD COLUMN rationale TEXT NOT NULL DEFAULT ''" },
  // 開工基準 sha：first-write-wins、永不重算（見 SCHEMA 裡的說明）
  { table: 'groups', column: 'base_sha', ddl: 'ALTER TABLE groups ADD COLUMN base_sha TEXT' },
  { table: 'tasks', column: 'task_start_sha', ddl: 'ALTER TABLE tasks ADD COLUMN task_start_sha TEXT' },
  { table: 'tasks', column: 'task_start_branch', ddl: 'ALTER TABLE tasks ADD COLUMN task_start_branch TEXT' },
  { table: 'tasks', column: 'tool_calls', ddl: 'ALTER TABLE tasks ADD COLUMN tool_calls TEXT' },
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
