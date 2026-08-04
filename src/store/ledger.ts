import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA, applyColumnMigrations } from './schema.js';
import type { Task, TaskState, Group, GroupState, BlockReason } from '../types.js';
import type { Logger } from '../observability/logger.js';

type Row = Record<string, unknown>;

/** events 表的三種歸屬。 */
export type EventScope = 'task' | 'group' | 'system';

/**
 * events 表的一列。
 *
 * events 原本只寫不讀（純稽核），但有兩個功能實際上依賴它「讀得回來」：
 *   1. ReviewWatcher 的跨重啟去重（同一則審查意見不可觸發兩次）；
 *   2. 審查意見（review_feedback）在 daemon 重啟後的回讀——否則 changes_requested
 *      的群組永遠停著，沒人知道 reviewer 要求改什麼。
 * 因此把它升格為有型別的讀取結果，而不是讓呼叫端自己拼 SQL。
 */
export interface LedgerEvent {
  id: number;
  scope: EventScope;
  refId: string | null;
  kind: string;
  detail?: string;
  createdAt: number;
}

/** listEvents 的過濾條件；全部可省略（省略 = 不過濾）。 */
export interface EventQuery {
  scope?: EventScope;
  /** 明確傳 null 代表「只要 ref_id 為 NULL 的（system 事件）」。 */
  refId?: string | null;
  kind?: string;
  /** 只要 created_at >= sinceMs 的。 */
  sinceMs?: number;
  /** 上限筆數（預設 100）——避免不小心把整張稽核表讀進記憶體。 */
  limit?: number;
}

/** 正在進行的一件事（activity 表的一列）。 */
export interface Activity {
  id: string;
  kind: string;
  repo?: string;
  refId?: string;
  title: string;
  detail?: string;
  startedAt: number;
  heartbeatAt: number;
}
export type ActivityInput = Omit<Activity, 'startedAt' | 'heartbeatAt'>;

/** 一次 agent 執行的紀錄（同一 session 多輪會累加）。 */
/** agent 角色。記帳要分得出「寫程式的錢」與「判斷者的錢」。 */
export type AgentKind = 'worker' | 'plan' | 'reviewer' | 'ui_judge' | 'drift_judge' | 'merge_risk_judge';

export interface AgentSessionInput {
  /**
   * 角色。**必填**——src 裡的寫入者只有兩個（worker 與 recordAgentUsage），
   * 設成必填就讓 typecheck 替接線把關：漏了哪個角色，編譯當場失敗。
   */
  kind: AgentKind;
  /** 不屬於任何單一任務時給 ''（見 schema 的說明，不用 null）。 */
  taskId: string;
  /** 哪個專案燒的。判斷者不屬於任務，只有這個欄位看得出錢花在誰身上。 */
  repo?: string;
  sessionId: string;
  groupId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** 這一輪用到的模型名稱（與既有紀錄取併集）。 */
  models?: string[];
  status?: 'active' | 'done' | 'parked' | 'error';
}

/** 這一次關卡是在哪一種工作區上跑的。後兩種是拋棄式的，內容永遠不是任何東西的來源。 */
export type WorkspaceKind = 'group_tree' | 'verify_tree' | 'merge_tree';

/** 誰要求跑這一關。`program` = 編排流程自己跑的（不是任何 agent 主動要求）。 */
export type CheckRequester = 'coder' | 'reviewer' | 'merger' | 'program';

export interface CheckRunInput {
  repo: string;
  branch?: string;
  workspaceKind: WorkspaceKind;
  command: string;
  headSha?: string;
  /** 這一次驗的是對著哪一顆 base（與 groups.base_sha 語意相反，見 schema 的說明）。 */
  verifiedBaseSha?: string;
  /** NULL 代表沒跑起來（指令不存在、還沒開始就死）——與「跑了但失敗」是不同的事實。 */
  exitCode?: number;
  output?: string;
  /** 全文太長時的落地檔路徑。寫檔由呼叫端負責，ledger 只存路徑。 */
  outputPath?: string;
  requestedBy: CheckRequester;
  startedAt?: number;
  endedAt?: number;
}

export interface CheckRunRow extends Omit<CheckRunInput, 'startedAt' | 'endedAt'> {
  id: number;
  startedAt: number;
  endedAt?: number;
}

/**
 * 交接單的路由碼：**這張單要畫哪一組按鈕**，不是「這個失敗是什麼原因」。
 * 與被刪掉的 MergeVerdict.reason 性質不同——那個是程式替失敗分類。
 */
export type HandoffKind =
  | 'clarification'   // agent 問人一個問題
  | 'no_change'       // agent 宣告這張卡不用做，等人確認
  | 'needs_human'     // 一般的「要你處理」
  | 'reclaim_blocked' // 認領不回來，解法不在這個系統裡（要去任務板改狀態）
  | 'merge_approval'  // 等人核准合併
  | 'stuck_group'     // 群組停手，等人決定要不要重試
  | 'review_feedback' // 審查意見回灌給實作者
  | 'delivery';       // 交付說明（給下一棒的脈絡，通常 blocking=false）

export type HandoffRole = 'planner' | 'coder' | 'reviewer' | 'merger' | 'program' | 'human';

export interface HandoffInput {
  groupId?: string;
  taskId?: string;
  fromRole: HandoffRole;
  toRole: HandoffRole;
  kind: HandoffKind;
  title: string;
  /** **不可為空**——空字串會擲錯，見 openHandoff 的說明。 */
  body: string;
  /** agent 自己寫的一句結論。程式不解析。 */
  verdict?: string;
  /** false = 只是留個紀錄，不擋流程（例如交付說明）。預設 true。 */
  blocking?: boolean;
  options?: string[];
  ifIgnored?: string;
  /** 「我沒驗到什麼」。放行書必填，空白不合法（由呼叫端的 schema 保證）。 */
  blindspots?: string;
  /** check_runs id、截圖路徑之類的證據引用。 */
  evidence?: string[];
  /** 人的答覆適用到哪：這張卡／這一群／以後都這樣。 */
  scope?: string;
  sessionId?: string;
}

export interface HandoffRow extends Omit<HandoffInput, 'blocking'> {
  id: string;
  blocking: boolean;
  createdAt: number;
  consumedAt?: number;
}

/**
 * 開工基準只收 40 位 commit sha。
 *
 * **擲錯是刻意的**（與 openHandoff 同一種破例）：把 ref 名字（`origin/main`）寫進一個
 * 「永不重算」的欄位，等於在裡面放一個會飄的東西——三天後再讀它指到的是三天後的 main，
 * 而這個欄位存在的全部意義就是「我們從哪裡分岔出來」這個不會變的事實。
 * 那正是它要修的那個 bug 的形狀，所以要在寫程式階段就爆掉，不是變成一行看不見的 WARN。
 *
 * 呼叫端若是從 `git rev-parse` 拿到的（可能失敗、可能回空字串），要自己先判斷再呼叫。
 */
function assertCommitSha(sha: string, what: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${what}必須是 40 位 commit sha，收到的是 ${JSON.stringify(sha.slice(0, 60))}`);
  }
}

function toCheckRun(r: Row): CheckRunRow {
  return {
    id: r.id as number,
    repo: r.repo as string,
    ...((r.branch as string) ? { branch: r.branch as string } : {}),
    workspaceKind: r.workspace_kind as WorkspaceKind,
    command: r.command as string,
    ...((r.head_sha as string) ? { headSha: r.head_sha as string } : {}),
    ...((r.verified_base_sha as string) ? { verifiedBaseSha: r.verified_base_sha as string } : {}),
    ...(r.exit_code === null || r.exit_code === undefined ? {} : { exitCode: r.exit_code as number }),
    output: (r.output as string) ?? '',
    ...((r.output_path as string) ? { outputPath: r.output_path as string } : {}),
    requestedBy: r.requested_by as CheckRequester,
    startedAt: r.started_at as number,
    ...(r.ended_at === null || r.ended_at === undefined ? {} : { endedAt: r.ended_at as number }),
  };
}

function toHandoff(r: Row): HandoffRow {
  return {
    id: r.id as string,
    ...((r.group_id as string) ? { groupId: r.group_id as string } : {}),
    ...((r.task_id as string) ? { taskId: r.task_id as string } : {}),
    fromRole: r.from_role as HandoffRole,
    toRole: r.to_role as HandoffRole,
    kind: r.kind as HandoffKind,
    title: r.title as string,
    body: r.body as string,
    ...((r.verdict as string) ? { verdict: r.verdict as string } : {}),
    blocking: (r.blocking as number) !== 0,
    ...((r.options as string) ? { options: JSON.parse(r.options as string) as string[] } : {}),
    ...((r.if_ignored as string) ? { ifIgnored: r.if_ignored as string } : {}),
    ...((r.blindspots as string) ? { blindspots: r.blindspots as string } : {}),
    ...((r.evidence as string) ? { evidence: JSON.parse(r.evidence as string) as string[] } : {}),
    ...((r.scope as string) ? { scope: r.scope as string } : {}),
    ...((r.session_id as string) ? { sessionId: r.session_id as string } : {}),
    createdAt: r.created_at as number,
    ...(r.consumed_at === null || r.consumed_at === undefined ? {} : { consumedAt: r.consumed_at as number }),
  };
}

export interface AgentSessionRow {
  taskId: string;
  sessionId: string;
  groupId?: string;
  rounds: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  models: string[];
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface CostSummary {
  sessions: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  rounds: number;
}

export interface TaskCost {
  taskId: string;
  costUsd: number;
  rounds: number;
}

/** 依專案彙總的花費（多專案時「誰在燒錢」的答案）。 */
export interface RepoCost {
  repo: string;
  costUsd: number;
  rounds: number;
  sessions: number;
}

function parseModels(raw?: string): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toAgentSession(r: Record<string, unknown>): AgentSessionRow {
  return {
    taskId: r.task_id as string,
    sessionId: r.session_id as string,
    groupId: (r.group_id as string) ?? undefined,
    rounds: r.rounds as number,
    costUsd: r.cost_usd as number,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    models: parseModels(r.models as string),
    status: r.status as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

/** 任務去重/落地所需的最小輸入（來自 MCP poll）。 */
export interface DiscoveredTaskInput {
  id: string;
  payloadHash: string;
  repo: string;
  category: string;
  title: string;
  description: string;
  dependencies: string[];
  docRefs: string[];
  /** MCP 端的最後活動時間（毫秒）。沒有就留空，靜置期會退回本地發現時間。 */
  sourceUpdatedAt?: number;
}

/**
 * SQLite ledger：任務/群組細狀態的唯一事實源（DESIGN.md §11）。
 *
 * **更新類方法的統一契約**：`updateTaskState` / `setBlock` / `clearBlock` / `updateGroupState`
 * 一律回傳「有沒有真的更新到一列」，找不到目標時 `log.warn` 後回 false，**不擲錯**。
 *
 * 為什麼是 false 而不是 throw：這四個方法的呼叫端散在 worker / group-runner /
 * orchestrator / notifier，多數在事件迴圈的深處且沒有 try/catch。
 * 讓 ledger 對「目標不存在」擲錯，等於允許一筆過期的 Slack 回呼把整個 daemon 打掛
 * （例：使用者回覆一則早已被清掉的任務的澄清訊息）。
 * 反過來說，先前 `updateTaskState` 擲錯、其餘三個靜默 no-op 的不一致更糟——
 * 「狀態沒更新」在三個方法上是完全無聲的失敗。統一成 false + warn：
 * 呼叫端想嚴格處理就檢查回傳值，不檢查也至少會留下一行 warn。
 */
export class Ledger {
  private db: Database.Database;
  private taskObservers: ((taskId: string) => void)[] = [];

  constructor(path: string, private log: Logger) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  init(): void {
    const migrated = applyColumnMigrations(this.db); // 先補欄位，再跑 SCHEMA（新表由 SCHEMA 建）
    this.db.exec(SCHEMA);
    if (migrated > 0) this.log.info({ migrated }, 'ledger 補上新欄位');
    this.log.debug('ledger schema 已套用');
  }

  close(): void {
    this.db.close();
  }

  private now(): number {
    return Date.now();
  }

  /**
   * 訂閱「某個任務的狀態變了」。
   *
   * 存在的理由：介面同步（Slack 任務卡）先前掛在**發通知事件**上，於是任何
   * 「改了狀態但沒發事件」的轉換都不會反映到卡片。`verifying` 就是這樣消失的——
   * 標成驗證中之後直接去跑幾分鐘的測試指令，中間沒有任何事件，人看到的卡片
   * 還停在「執行中」。狀態的唯一事實源是 ledger，所以要訂閱的也是 ledger。
   *
   * 觀察者一律在 try 裡呼叫：畫面更新失敗絕不能影響資料寫入或讓呼叫端擲錯
   * （同類事故發生過：卡片同步擲錯冒到外層，整個群組被標成 failed）。
   */
  onTaskChanged(cb: (taskId: string) => void): void {
    this.taskObservers.push(cb);
  }

  private emitTaskChanged(id: string): void {
    for (const cb of this.taskObservers) {
      try {
        cb(id);
      } catch (e) {
        this.log.warn({ taskId: id, err: e instanceof Error ? e.message : String(e) }, '任務狀態觀察者擲錯（忽略）');
      }
    }
  }

  // ── Tasks ──

  /** 去重寫入：未見過 → 落地 discovered；已存在 → 略過（回報 payload 是否變動）。 */
  upsertDiscoveredTask(input: DiscoveredTaskInput): 'inserted' | 'exists' | 'payload_changed' {
    const existing = this.db
      .prepare('SELECT payload_hash FROM tasks WHERE id = ?')
      .get(input.id) as { payload_hash: string } | undefined;

    const ts = this.now();
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO tasks
             (id, payload_hash, repo, category, title, description, dependencies, doc_refs, state, attempts,
              source_updated_at, created_at, updated_at)
           VALUES
             (@id, @payloadHash, @repo, @category, @title, @description, @dependencies, @docRefs, 'discovered', 0,
              @sourceUpdatedAt, @ts, @ts)`,
        )
        .run({
          ...input,
          dependencies: JSON.stringify(input.dependencies),
          docRefs: JSON.stringify(input.docRefs),
          sourceUpdatedAt: input.sourceUpdatedAt ?? null,
          ts,
        });
      return 'inserted';
    }

    if (existing.payload_hash !== input.payloadHash) {
      // 內容變更：更新描述/依賴/docRefs 與 hash，狀態維持不動（是否重排交由 planner）。
      this.db
        .prepare(
          `UPDATE tasks SET payload_hash=@payloadHash, title=@title, description=@description,
             dependencies=@dependencies, doc_refs=@docRefs, source_updated_at=@sourceUpdatedAt,
             updated_at=@ts WHERE id=@id`,
        )
        .run({
          id: input.id,
          payloadHash: input.payloadHash,
          title: input.title,
          description: input.description,
          dependencies: JSON.stringify(input.dependencies),
          docRefs: JSON.stringify(input.docRefs),
          sourceUpdatedAt: input.sourceUpdatedAt ?? null,
          ts,
        });
      return 'payload_changed';
    }
    return 'exists';
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toTask(row) : undefined;
  }

  listTasksByState(state: TaskState): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE state = ? ORDER BY created_at').all(state) as Row[];
    return rows.map((r) => this.toTask(r));
  }

  /** @returns 是否真的更新到該任務（找不到 → warn + false，見類別註解的統一契約）。 */
  updateTaskState(
    id: string,
    state: TaskState,
    extra: { lastError?: string; groupId?: string; slackThreadTs?: string; incAttempts?: boolean } = {},
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE tasks SET state=@state, updated_at=@ts,
           last_error=COALESCE(@lastError, last_error),
           group_id=COALESCE(@groupId, group_id),
           slack_thread_ts=COALESCE(@threadTs, slack_thread_ts),
           attempts=attempts + @inc
         WHERE id=@id`,
      )
      .run({
        id,
        state,
        ts: this.now(),
        lastError: extra.lastError ?? null,
        groupId: extra.groupId ?? null,
        threadTs: extra.slackThreadTs ?? null,
        inc: extra.incAttempts ? 1 : 0,
      });
    const ok = this.affected(res.changes, 'updateTaskState', { id, state });
    if (ok) this.emitTaskChanged(id);
    return ok;
  }

  /** @returns 是否真的更新到該任務（找不到 → warn + false）。 */
  setBlock(id: string, reason: BlockReason, detail?: string): boolean {
    const res = this.db
      .prepare(`UPDATE tasks SET state='blocked', block_reason=@reason, block_detail=@detail, updated_at=@ts WHERE id=@id`)
      .run({ id, reason, detail: detail ?? null, ts: this.now() });
    const ok = this.affected(res.changes, 'setBlock', { id, reason });
    if (ok) this.emitTaskChanged(id);
    return ok;
  }

  /** @returns 是否真的更新到該任務（找不到 → warn + false）。 */
  clearBlock(id: string, nextState: TaskState): boolean {
    const res = this.db
      .prepare(`UPDATE tasks SET state=@state, block_reason=NULL, block_detail=NULL, updated_at=@ts WHERE id=@id`)
      .run({ id, state: nextState, ts: this.now() });
    const ok = this.affected(res.changes, 'clearBlock', { id, state: nextState });
    if (ok) this.emitTaskChanged(id);
    return ok;
  }

  // ── Agent sessions（session 追蹤 + 成本歸屬） ──

  /**
   * 記錄／累加一次 agent 執行。
   *
   * 同一個 (task_id, session_id) 會被多輪呼叫（監督迴圈每輪一次），所以用 UPSERT 累加：
   * rounds +1、成本與 token 累計、models 併集。這樣「這個任務總共花了多少」直接查得到，
   * 不必事後掃 log 加總。
   */
  recordAgentSession(input: AgentSessionInput): void {
    const ts = this.now();
    // models 併集在 JS 做：SQLite 沒有 json 的 distinct 聚合函式，
    // 硬用 SQL 拼會變成重複值累積（同一 session 每輪都會加一次同樣的模型名）
    const prev = this.db
      .prepare('SELECT models FROM agent_sessions WHERE task_id = ? AND session_id = ?')
      .get(input.taskId, input.sessionId) as { models?: string } | undefined;
    const merged = [...new Set([...parseModels(prev?.models), ...(input.models ?? [])])];
    const models = JSON.stringify(merged);
    this.db
      .prepare(
        `INSERT INTO agent_sessions
           (task_id, kind, repo, group_id, session_id, rounds, cost_usd, input_tokens, output_tokens,
            cache_read_tokens, models, status, created_at, updated_at)
         VALUES
           (@taskId, @kind, @repo, @groupId, @sessionId, 1, @costUsd, @inputTokens, @outputTokens,
            @cacheReadTokens, @models, @status, @ts, @ts)
         ON CONFLICT(task_id, session_id) DO UPDATE SET
           rounds = rounds + 1,
           cost_usd = cost_usd + @costUsd,
           input_tokens = input_tokens + @inputTokens,
           output_tokens = output_tokens + @outputTokens,
           cache_read_tokens = cache_read_tokens + @cacheReadTokens,
           -- 同一 session 後續輪次補上先前缺的 repo；null 不可以洗掉已有值
           repo = COALESCE(@repo, repo),
           -- models 併集：同一 session 中途換模型時兩個都要留下
           models = @models,
           status = @status,
           group_id = COALESCE(@groupId, group_id),
           updated_at = @ts`,
      )
      .run({
        taskId: input.taskId,
        // 型別上是必填，但 JS 呼叫端（測試假件、舊資料路徑）可能沒帶——
        // 之前欄位不在 SQL 裡時是靠 DEFAULT 兜住的，明寫之後要自己補
        kind: input.kind ?? 'worker',
        repo: input.repo ?? null,
        groupId: input.groupId ?? null,
        sessionId: input.sessionId,
        costUsd: input.costUsd ?? 0,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        cacheReadTokens: input.cacheReadTokens ?? 0,
        models,
        status: input.status ?? 'active',
        ts,
      });
  }

  /** 取某任務最近一次的 session（resume 用：人回覆澄清後要接回同一個 session）。 */
  latestAgentSession(taskId: string): AgentSessionRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1')
      .get(taskId) as Row | undefined;
    return row ? toAgentSession(row) : undefined;
  }

  /** 標記 session 的收尾狀態（done/parked/error），供事後分析。 */
  markAgentSession(taskId: string, sessionId: string, status: string): void {
    this.db
      .prepare('UPDATE agent_sessions SET status = @status, updated_at = @ts WHERE task_id = @taskId AND session_id = @sessionId')
      .run({ taskId, sessionId, status, ts: this.now() });
  }

  /** 成本彙總。省略 sinceMs 就是全部。 */
  costSummary(sinceMs?: number): CostSummary {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS sessions, COALESCE(SUM(cost_usd),0) AS cost,
                COALESCE(SUM(input_tokens),0) AS inTok, COALESCE(SUM(output_tokens),0) AS outTok,
                COALESCE(SUM(rounds),0) AS rounds
           FROM agent_sessions WHERE created_at >= ?`,
      )
      .get(sinceMs ?? 0) as { sessions: number; cost: number; inTok: number; outTok: number; rounds: number };
    return {
      sessions: row.sessions,
      costUsd: row.cost,
      inputTokens: row.inTok,
      outputTokens: row.outTok,
      rounds: row.rounds,
    };
  }

  /** 依任務列出成本（dashboard 用；預設取花費最高的前 N 筆）。 */
  costByTask(limit = 20): TaskCost[] {
    const rows = this.db
      .prepare(
        `SELECT task_id, COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(rounds),0) AS rounds
           FROM agent_sessions GROUP BY task_id ORDER BY cost DESC LIMIT ?`,
      )
      .all(limit) as { task_id: string; cost: number; rounds: number }[];
    return rows.map((r) => ({ taskId: r.task_id, costUsd: r.cost, rounds: r.rounds }));
  }

  /**
   * 依專案彙總花費。agent_sessions 只記 task_id，專案要 join tasks 才拿得到。
   * 對不到任務的 session（任務被清掉了）歸到 '(unknown)'，不要靜靜消失——
   * 帳目短少比多一列 unknown 難查得多。
   */
  costByRepo(sinceMs?: number): RepoCost[] {
    const rows = this.db
      .prepare(
        // **s.repo 要排在 t.repo 前面。** 判斷者與規劃者不屬於任何單一任務
        // （task_id 是 '' 哨兵值），join 不到 tasks——只看 join 的話它們的錢
        // 全部歸進 '(unknown)'，而那正是加 repo 欄位要解決的問題。
        `SELECT COALESCE(s.repo, t.repo, '(unknown)') AS repo,
                COALESCE(SUM(s.cost_usd),0) AS cost,
                COALESCE(SUM(s.rounds),0) AS rounds,
                COUNT(*) AS sessions
           FROM agent_sessions s LEFT JOIN tasks t ON t.id = s.task_id
          WHERE s.created_at >= ?
          GROUP BY COALESCE(s.repo, t.repo, '(unknown)')
          ORDER BY cost DESC`,
      )
      .all(sinceMs ?? 0) as { repo: string; cost: number; rounds: number; sessions: number }[];
    return rows.map((r) => ({ repo: r.repo, costUsd: r.cost, rounds: r.rounds, sessions: r.sessions }));
  }

  // ── Iterations（無進展偵測用） ──

  recordIteration(taskId: string, round: number, signature: string, green: boolean, diffHash?: string): void {
    this.db
      .prepare(
        `INSERT INTO task_iterations (task_id, round, signature, green, diff_hash, created_at)
         VALUES (@taskId, @round, @signature, @green, @diffHash, @ts)`,
      )
      .run({ taskId, round, signature, green: green ? 1 : 0, diffHash: diffHash ?? null, ts: this.now() });
  }

  /** 取最近 n 輪的結果簽章（新到舊）。 */
  recentSignatures(taskId: string, n: number): string[] {
    const rows = this.db
      .prepare('SELECT signature FROM task_iterations WHERE task_id = ? ORDER BY round DESC LIMIT ?')
      .all(taskId, n) as { signature: string }[];
    return rows.map((r) => r.signature);
  }

  // ── Groups ──

  upsertGroup(g: Omit<Group, 'createdAt' | 'updatedAt'>): void {
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO groups (id, repo, branch, task_ids, footprint, after_groups, rationale, state, pr_url, pr_number, created_at, updated_at)
           VALUES (@id, @repo, @branch, @taskIds, @footprint, @afterGroups, @rationale, @state, @prUrl, @prNumber, @ts, @ts)
         ON CONFLICT(id) DO UPDATE SET
           branch=@branch, task_ids=@taskIds, footprint=@footprint, after_groups=@afterGroups,
             -- rationale 只在建群時寫；重派時不該被空字串蓋掉
             rationale=CASE WHEN @rationale <> '' THEN @rationale ELSE rationale END, state=@state,
           pr_url=@prUrl, pr_number=@prNumber, updated_at=@ts`,
      )
      .run({
        id: g.id,
        repo: g.repo,
        branch: g.branch,
        taskIds: JSON.stringify(g.taskIds),
        footprint: JSON.stringify(g.footprint),
        afterGroups: JSON.stringify(g.afterGroups ?? []),
        rationale: g.rationale ?? '',
        state: g.state,
        prUrl: g.prUrl ?? null,
        prNumber: g.prNumber ?? null,
        ts,
      });
  }

  getGroup(id: string): Group | undefined {
    const row = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toGroup(row) : undefined;
  }

  /** 建立群組（id 由 repo+taskIds 決定，冪等：同組任務再規劃回同一群）。 */
  createGroup(input: { repo: string; branch: string; taskIds: string[]; footprint: string[]; afterGroups?: string[]; rationale?: string }): Group {
    const id = 'g_' + createHash('sha1').update(`${input.repo}|${[...input.taskIds].sort().join(',')}`).digest('hex').slice(0, 12);
    const existing = this.getGroup(id);
    if (existing) return existing;
    this.upsertGroup({
      id, repo: input.repo, branch: input.branch, taskIds: input.taskIds,
      footprint: input.footprint, afterGroups: input.afterGroups ?? [],
      rationale: input.rationale ?? '', state: 'ready',
    });
    return this.getGroup(id)!;
  }

  /**
   * 刪掉一個任務與它的附屬紀錄（停用專案時用，見 core/project-purge.ts）。
   *
   * 為什麼要真的刪而不是標記：留著的話下次啟用是拿舊快照在跑——
   * 任務板那邊可能已經改過描述、刪掉、或加了新的前置條件。
   */
  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM task_iterations WHERE task_id = ?').run(id);
    this.db.prepare('DELETE FROM agent_sessions WHERE task_id = ?').run(id);
    this.db.prepare('DELETE FROM clarifications WHERE task_id = ?').run(id);
    this.db.prepare("DELETE FROM events WHERE scope = 'task' AND ref_id = ?").run(id);
    // 手寫級聯（這個 schema 刻意不用 FOREIGN KEY）。漏掉的話停用專案會留下孤兒交接單，
    // 而「等你處理」是一條 `to_role='human' AND consumed_at IS NULL` 的查詢——
    // 孤兒單會永遠掛在清單上，指向一個已經不存在的任務。
    this.db.prepare('DELETE FROM handoffs WHERE task_id = ?').run(id);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  /** 刪掉一個群組與它的事件（停用專案時用）。 */
  deleteGroup(id: string): void {
    this.db.prepare("DELETE FROM events WHERE scope = 'group' AND ref_id = ?").run(id);
    this.db.prepare('DELETE FROM handoffs WHERE group_id = ?').run(id);
    this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  }

  listGroupsByState(state: GroupState): Group[] {
    const rows = this.db.prepare('SELECT * FROM groups WHERE state = ? ORDER BY created_at').all(state) as Row[];
    return rows.map((r) => this.toGroup(r));
  }

  /** @returns 是否真的更新到該群組（找不到 → warn + false）。 */
  updateGroupState(id: string, state: GroupState, extra: { prUrl?: string; prNumber?: number } = {}): boolean {
    const res = this.db
      .prepare(
        `UPDATE groups SET state=@state, updated_at=@ts,
           pr_url=COALESCE(@prUrl, pr_url), pr_number=COALESCE(@prNumber, pr_number) WHERE id=@id`,
      )
      .run({ id, state, ts: this.now(), prUrl: extra.prUrl ?? null, prNumber: extra.prNumber ?? null });
    const ok = this.affected(res.changes, 'updateGroupState', { id, state });
    // 群層狀態會改變群內每張卡的呈現（done 的任務在 in_review 下要變成「等你核准合併」）
    if (ok) for (const tid of this.getGroup(id)?.taskIds ?? []) this.emitTaskChanged(tid);
    return ok;
  }

  /** 更新類方法的共用收尾：沒更新到任何一列就留下 warn（不可靜默）。 */
  private affected(changes: number, op: string, ctx: Record<string, unknown>): boolean {
    if (changes > 0) return true;
    this.log.warn({ op, ...ctx }, `${op}：找不到目標，狀態未更新`);
    return false;
  }

  // ── Activity（現在誰在做什麼） ──
  //
  // 與 events 的差別：events 是「發生過什麼」（只增不刪），activity 是「正在做什麼」
  // （做完就刪）。花時間最久的那幾件事——規劃、審查、視覺驗證、合併把關——
  // 期間 ledger 完全靜止，控制台看起來就像停擺了。這張表就是給那段空白用的。

  /** 開始一件事（同 id 重入直接覆蓋，不會長出兩列）。 */
  startActivity(a: ActivityInput): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO activity (id, kind, repo, ref_id, title, detail, started_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, repo = excluded.repo, ref_id = excluded.ref_id,
           title = excluded.title, detail = excluded.detail, heartbeat_at = excluded.heartbeat_at`,
      )
      .run(a.id, a.kind, a.repo ?? null, a.refId ?? null, a.title, a.detail ?? null, now, now);
  }

  /**
   * 還活著（順便可以更新說明）。
   *
   * 沒有心跳的話，跑很久的工作與「daemon 被 kill 掉留下的殘列」在畫面上長得一模一樣，
   * 而那正是使用者最需要分辨的兩件事。
   */
  touchActivity(id: string, detail?: string): void {
    const sql = detail === undefined
      ? 'UPDATE activity SET heartbeat_at = ? WHERE id = ?'
      : 'UPDATE activity SET heartbeat_at = ?, detail = ? WHERE id = ?';
    const params: (string | number)[] = detail === undefined ? [this.now(), id] : [this.now(), detail, id];
    this.db.prepare(sql).run(...params);
  }

  endActivity(id: string): void {
    this.db.prepare('DELETE FROM activity WHERE id = ?').run(id);
  }

  /** 進行中的事（新的排前面）。 */
  listActivities(): Activity[] {
    const rows = this.db.prepare('SELECT * FROM activity ORDER BY started_at DESC').all() as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      title: String(r.title),
      startedAt: Number(r.started_at),
      heartbeatAt: Number(r.heartbeat_at),
      ...(r.repo != null ? { repo: String(r.repo) } : {}),
      ...(r.ref_id != null ? { refId: String(r.ref_id) } : {}),
      ...(r.detail != null ? { detail: String(r.detail) } : {}),
    }));
  }

  /**
   * 清掉殘列，回傳清掉幾筆。
   *
   * daemon 被 kill（或當掉）時不會有人來刪自己那幾列，重啟後畫面上就會永遠掛著
   * 幾件「進行中」的假工作。啟動時無條件清一次（`maxAgeMs` 給 0），
   * 執行期間則用心跳年齡清那些明明還在卻沒人餵的。
   */
  clearStaleActivities(maxAgeMs = 0): number {
    const cutoff = this.now() - Math.max(0, maxAgeMs);
    const r = this.db.prepare('DELETE FROM activity WHERE heartbeat_at <= ?').run(cutoff);
    return Number(r.changes ?? 0);
  }

  // ── Events（稽核） ──

  logEvent(scope: EventScope, refId: string | null, kind: string, detail?: string): void {
    this.db
      .prepare('INSERT INTO events (scope, ref_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(scope, refId, kind, detail ?? null, this.now());
  }

  /**
   * 這個 (scope, refId, kind[, detail]) 是否已有事件。
   * ReviewWatcher 用它做**跨重啟去重**：同一則審查意見在 daemon 重啟後不可再觸發一次。
   * 省略 detail = 不比對 detail（只問「這件事發生過沒」）。
   */
  hasEvent(scope: EventScope, refId: string | null, kind: string, detail?: string): boolean {
    const sql =
      'SELECT 1 FROM events WHERE scope = ? AND ref_id IS ? AND kind = ?'
      + (detail === undefined ? '' : ' AND detail IS ?')
      + ' LIMIT 1';
    const params: (string | null)[] = [scope, refId, kind];
    if (detail !== undefined) params.push(detail);
    return this.db.prepare(sql).get(...params) !== undefined;
  }

  /**
   * 取某 refId 最近一筆指定 kind 的事件（沒有回 undefined）。
   *
   * 這是「重啟後把狀態讀回來」的主要入口：例如 changes_requested 的群組，
   * 可以靠 `latestEvent('group', groupId, 'review_feedback')` 把 reviewer 當時的意見
   * 從稽核軌跡撈回來，而不是隨程序記憶體一起蒸發（群組因此不會永遠卡住）。
   * 以 id 遞減取最新：同毫秒寫入時 created_at 會相同，只有自增 id 能保證「最後寫的贏」。
   */
  latestEvent(scope: EventScope, refId: string | null, kind: string): LedgerEvent | undefined {
    const row = this.db
      .prepare('SELECT * FROM events WHERE scope = ? AND ref_id IS ? AND kind = ? ORDER BY id DESC LIMIT 1')
      .get(scope, refId, kind) as Row | undefined;
    return row ? this.toEvent(row) : undefined;
  }

  /** 查事件（新到舊）。給「一次把多個群組的狀態讀回來」這類啟動期重建用。 */
  listEvents(query: EventQuery = {}): LedgerEvent[] {
    const where: string[] = [];
    const params: (string | number | null)[] = [];
    if (query.scope !== undefined) {
      where.push('scope = ?');
      params.push(query.scope);
    }
    // refId 可以是 null（system 事件），所以用 'refId' in query 而非 !== undefined 判斷
    if ('refId' in query && query.refId !== undefined) {
      where.push('ref_id IS ?');
      params.push(query.refId);
    }
    if (query.kind !== undefined) {
      where.push('kind = ?');
      params.push(query.kind);
    }
    if (query.sinceMs !== undefined) {
      where.push('created_at >= ?');
      params.push(query.sinceMs);
    }
    const limit = Math.max(0, Math.floor(query.limit ?? 100));
    const sql =
      'SELECT * FROM events'
      + (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY id DESC LIMIT ?';
    const rows = this.db.prepare(sql).all(...params, limit) as Row[];
    return rows.map((r) => this.toEvent(r));
  }

  // ── 保留策略（長期常駐不能無限成長；由 Reconciler 週期性呼叫） ──

  /**
   * 刪除早於 cutoffMs 的稽核事件，回傳刪除筆數。
   *
   * 保守規則（寧可留太多，不要刪到還需要的）：**只清「已收攤」的對象**——
   *   - group 事件：群組已是終態（merged/failed）才可清。仍在 pr_open/in_review/
   *     changes_requested 的群組，其 review_seen（去重）與 review_feedback（審查意見）
   *     還在服役中，刪掉會導致舊意見重複觸發、或意見再也讀不回來。
   *   - task 事件：任務已 done 才可清。
   *   - ledger 已查無對應 task/group 的、以及 system 事件：純稽核，逾期即可清。
   */
  pruneEvents(cutoffMs: number): number {
    if (!Number.isFinite(cutoffMs)) {
      this.log.warn({ cutoffMs }, 'pruneEvents：cutoff 非有效數值，本次不清理');
      return 0;
    }
    const res = this.db
      .prepare(
        `DELETE FROM events
          WHERE created_at < @cutoff
            AND NOT (scope = 'group' AND ref_id IN (SELECT id FROM groups WHERE state NOT IN ('merged','failed')))
            AND NOT (scope = 'task'  AND ref_id IN (SELECT id FROM tasks  WHERE state <> 'done'))`,
      )
      .run({ cutoff: cutoffMs });
    if (res.changes > 0) this.log.info({ deleted: res.changes, cutoffMs }, '已清除逾期稽核事件');
    return res.changes;
  }

  /**
   * 刪除早於 cutoffMs 的迭代紀錄，但**每個任務至少保留最近 keepPerTask 筆**，回傳刪除筆數。
   *
   * 為什麼要保底：task_iterations 是無進展偵測（recentSignatures）的資料源，
   * 也是「這個任務到底試了幾輪、每輪結果如何」的唯一軌跡。純以時間清會讓一個
   * 長期卡住的任務把歷史整個清空，偵測邏輯反而看不出它一直沒進展。
   * 另外，進行中（in_progress/verifying）的任務一律完全不動——它的歷史正在被讀。
   */
  pruneTaskIterations(cutoffMs: number, keepPerTask: number): number {
    if (!Number.isFinite(cutoffMs)) {
      this.log.warn({ cutoffMs }, 'pruneTaskIterations：cutoff 非有效數值，本次不清理');
      return 0;
    }
    const keep = Number.isFinite(keepPerTask) ? Math.max(0, Math.floor(keepPerTask)) : 0;
    const res = this.db
      .prepare(
        `DELETE FROM task_iterations
          WHERE created_at < @cutoff
            AND task_id NOT IN (SELECT id FROM tasks WHERE state IN ('in_progress','verifying'))
            AND id NOT IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY round DESC, id DESC) AS rn
                  FROM task_iterations
              ) WHERE rn <= @keep
            )`,
      )
      .run({ cutoff: cutoffMs, keep });
    if (res.changes > 0) this.log.info({ deleted: res.changes, cutoffMs, keep }, '已清除逾期迭代紀錄');
    return res.changes;
  }

  // ── row 映射 ──

  private toEvent(r: Row): LedgerEvent {
    return {
      id: r.id as number,
      scope: r.scope as EventScope,
      refId: (r.ref_id as string | null) ?? null,
      kind: r.kind as string,
      detail: (r.detail as string) ?? undefined,
      createdAt: r.created_at as number,
    };
  }

  private toTask(r: Row): Task {
    return {
      id: r.id as string,
      payloadHash: r.payload_hash as string,
      repo: r.repo as string,
      category: r.category as string,
      title: r.title as string,
      description: r.description as string,
      dependencies: JSON.parse((r.dependencies as string) ?? '[]'),
      docRefs: JSON.parse((r.doc_refs as string) ?? '[]'),
      state: r.state as TaskState,
      block: r.block_reason
        ? { reason: r.block_reason as BlockReason, detail: (r.block_detail as string) ?? undefined }
        : undefined,
      groupId: (r.group_id as string) ?? undefined,
      slackThreadTs: (r.slack_thread_ts as string) ?? undefined,
      attempts: r.attempts as number,
      lastError: (r.last_error as string) ?? undefined,
      sourceUpdatedAt: (r.source_updated_at as number) ?? undefined,
      taskStartSha: (r.task_start_sha as string) ?? undefined,
      taskStartBranch: (r.task_start_branch as string) ?? undefined,
      toolCalls: r.tool_calls ? (JSON.parse(r.tool_calls as string) as Record<string, number>) : undefined,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    };
  }

  // ── 開工基準 sha（first-write-wins，永不重算） ──────────────────────

  /**
   * 寫下這一群的開工基準。**只有還沒有值時才寫得進去**——條件放在 SQL 裡，
   * 所以「已經有值就不覆寫」是原子的，不是「先讀再判斷再寫」那種會有競態的寫法。
   *
   * 為什麼一定要 first-write-wins：`GroupRunner.run()` **每次派工都會跑一次**
   * （requeue、park 復活、崩潰重排都會再進來），而它是唯一算得出 base 的地方。
   * 沒有這個條件，第二次派工就會把基準改成「現在的 base」，於是所有以它為準的比較
   * （diff 關卡、審查者的 diff、新舊問題分辨、合併者算 base 多了什麼）全部偏移。
   *
   * @returns 是否真的寫進去了（false = 已經有值，沿用舊的）
   */
  setGroupBaseSha(id: string, sha: string): boolean {
    assertCommitSha(sha, `群組 ${id} 的開工基準`);
    const r = this.db
      .prepare('UPDATE groups SET base_sha = @sha WHERE id = @id AND base_sha IS NULL')
      .run({ id, sha });
    return r.changes > 0;
  }

  /**
   * 寫下這個任務的開工基準（DoD「diff 非空」關卡用）。同樣 first-write-wins。
   * @returns 是否真的寫進去了
   */
  setTaskStartSha(id: string, sha: string, branch?: string): boolean {
    assertCommitSha(sha, `任務 ${id} 的開工基準`);
    const r = this.db
      .prepare(
        'UPDATE tasks SET task_start_sha = @sha, task_start_branch = @branch' +
          ' WHERE id = @id AND task_start_sha IS NULL',
      )
      .run({ id, sha, branch: branch ?? null });
    return r.changes > 0;
  }

  /**
   * 把這一輪的工具呼叫次數**累加**到任務層級。
   *
   * 累加而不是覆寫：agent 會 resume session，第 1 輪讀了規格、第 3 輪不會再讀一次。
   * 只看最後一輪的話，「這個任務從頭到尾沒查過規格」這個判斷會對每一個跑超過一輪的
   * 任務誤報。
   *
   * 空的計數也要呼叫（不是 no-op）：「跑了一輪、一個工具都沒用」與「從來沒跑過」
   * 是不同的事實，前者要留下 `{}` 這個痕跡。
   */
  addTaskToolCalls(taskId: string, counts: Record<string, number>): void {
    const cur = this.getTask(taskId)?.toolCalls ?? {};
    for (const [name, n] of Object.entries(counts)) cur[name] = (cur[name] ?? 0) + n;
    const r = this.db
      .prepare('UPDATE tasks SET tool_calls = @json, updated_at = @ts WHERE id = @id')
      .run({ id: taskId, json: JSON.stringify(cur), ts: this.now() });
    if (r.changes === 0) this.log.warn({ taskId }, '累加工具計數時找不到任務');
  }

  // ── check_runs：關卡執行的流水帳（純記帳、零解讀） ──────────────────

  /**
   * 記一次關卡執行。**這個方法不判斷任何事**——它不看 exit code 代表什麼、
   * 不從輸出裡抽失敗測試名、不算簽章。那些都是讀的人（agent 或人）的事。
   *
   * 全文超過 maxInline 時 spill 成檔案：DB 只留頭尾，`output_path` 指到落地檔。
   * 呼叫端負責寫檔（ledger 不碰檔案系統），這裡只存路徑。
   */
  recordCheckRun(input: CheckRunInput): number {
    const ts = this.now();
    const r = this.db
      .prepare(
        `INSERT INTO check_runs
           (repo, branch, workspace_kind, command, head_sha, verified_base_sha,
            exit_code, output, output_path, requested_by, started_at, ended_at)
         VALUES
           (@repo, @branch, @workspaceKind, @command, @headSha, @verifiedBaseSha,
            @exitCode, @output, @outputPath, @requestedBy, @startedAt, @endedAt)`,
      )
      .run({
        repo: input.repo,
        branch: input.branch ?? null,
        workspaceKind: input.workspaceKind,
        command: input.command,
        headSha: input.headSha ?? null,
        verifiedBaseSha: input.verifiedBaseSha ?? null,
        exitCode: input.exitCode ?? null,
        output: input.output ?? '',
        outputPath: input.outputPath ?? null,
        requestedBy: input.requestedBy,
        startedAt: input.startedAt ?? ts,
        endedAt: input.endedAt ?? ts,
      });
    return Number(r.lastInsertRowid);
  }

  /**
   * 查關卡歷史。這是「同一條分支 14:04:45 綠、14:13:51 紅」變成一次查詢的地方——
   * 先前那個事實只能靠事後翻 stdout.log 一行一行對時間才發現。
   */
  listCheckRuns(q: { repo?: string; branch?: string; command?: string; since?: number; limit?: number } = {}): CheckRunRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (q.repo) { where.push('repo = @repo'); params.repo = q.repo; }
    if (q.branch) { where.push('branch = @branch'); params.branch = q.branch; }
    if (q.command) { where.push('command = @command'); params.command = q.command; }
    if (q.since !== undefined) { where.push('started_at >= @since'); params.since = q.since; }
    const sql =
      `SELECT * FROM check_runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''}` +
      ` ORDER BY started_at DESC, id DESC LIMIT @limit`;
    const rows = this.db.prepare(sql).all({ ...params, limit: q.limit ?? 200 }) as Row[];
    return rows.map(toCheckRun);
  }

  /**
   * 清掉舊的關卡紀錄。**回傳被清掉那些列的 output_path**——呼叫端要據此刪檔案，
   * 否則 spill 出去的全文會變成沒有人指得到、也沒有人會清的孤兒（DB 瘦了、磁碟沒有）。
   *
   * `keepPerBranch` 是保底：就算某條分支的紀錄全都過期了，也留最近幾筆，
   * 免得「這個關卡在這條分支上從來沒綠過嗎」這種問題連一筆證據都查不到。
   */
  pruneCheckRuns(opts: { olderThan: number; keepPerBranch?: number }): string[] {
    const keep = opts.keepPerBranch ?? 20;
    const doomed = this.db
      .prepare(
        `SELECT id, output_path FROM check_runs
          WHERE started_at < @olderThan
            AND id NOT IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                  PARTITION BY repo, branch ORDER BY started_at DESC, id DESC
                ) AS rn FROM check_runs
              ) WHERE rn <= @keep
            )`,
      )
      .all({ olderThan: opts.olderThan, keep }) as Row[];
    if (doomed.length === 0) return [];
    const ids = doomed.map((r) => r.id as number);
    this.db.prepare(`DELETE FROM check_runs WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    return doomed.map((r) => (r.output_path as string) ?? '').filter((p) => p !== '');
  }

  // ── handoffs：交接單 ────────────────────────────────────────────────

  /**
   * 開一張交接單。**空白的 body 會擲錯**——這是刻意破例。
   *
   * ledger 其餘寫入方法的統一契約是「找不到就 warn + 回 false，絕不擲錯」
   * （常駐 daemon 不該因為一筆寫入失敗就倒）。但這一條不同：body 是「停手時要說的話」，
   * 而**停手與說話必須是同一個寫入動作**。允許空 body 就等於允許「停了但沒說」，
   * 那正是實跑撞到的那個 bug——兩個群在等人、控制台顯示「沒有需要你處理的事項」。
   * 擲錯讓它在寫程式階段就爆掉，而不是在正式環境變成一行看不見的 WARN。
   */
  openHandoff(input: HandoffInput): string {
    const body = (input.body ?? '').trim();
    if (body === '') {
      throw new Error(
        `交接單的說明欄不可為空（from=${input.fromRole} to=${input.toRole} kind=${input.kind}）。` +
          '停手與說話是同一個動作：開不出沒有說明的單，也就停不了一個沒開單的群。',
      );
    }
    const ts = this.now();
    const id =
      'h_' +
      createHash('sha1')
        .update(`${input.groupId ?? ''}|${input.taskId ?? ''}|${input.kind}|${input.toRole}|${ts}|${body}`)
        .digest('hex')
        .slice(0, 16);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO handoffs
           (id, group_id, task_id, from_role, to_role, kind, verdict, blocking,
            title, body, options, if_ignored, blindspots, evidence, scope, session_id,
            created_at, consumed_at)
         VALUES
           (@id, @groupId, @taskId, @fromRole, @toRole, @kind, @verdict, @blocking,
            @title, @body, @options, @ifIgnored, @blindspots, @evidence, @scope, @sessionId,
            @createdAt, NULL)`,
      )
      .run({
        id,
        groupId: input.groupId ?? null,
        taskId: input.taskId ?? null,
        fromRole: input.fromRole,
        toRole: input.toRole,
        kind: input.kind,
        verdict: input.verdict ?? null,
        blocking: input.blocking === false ? 0 : 1,
        title: input.title,
        body,
        options: input.options ? JSON.stringify(input.options) : null,
        ifIgnored: input.ifIgnored ?? null,
        blindspots: input.blindspots ?? null,
        evidence: input.evidence ? JSON.stringify(input.evidence) : null,
        scope: input.scope ?? null,
        sessionId: input.sessionId ?? null,
        createdAt: ts,
      });
    return id;
  }

  /**
   * 查交接單。`{ toRole: 'human', unconsumedOnly: true }` **就是待處理清單**——
   * 控制台、Slack、CLI 共用這一條查詢。
   *
   * 先前這件事是從「群組狀態＋事件」推論出來的，而推論綁在一張寫死的狀態清單上：
   * 漏一項就是一次靜默（實跑：群組停在 changes_requested，清單只掃 failed）。
   * 查詢不會漏。
   */
  listHandoffs(q: { toRole?: string; kind?: string; groupId?: string; taskId?: string; unconsumedOnly?: boolean; limit?: number } = {}): HandoffRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (q.toRole) { where.push('to_role = @toRole'); params.toRole = q.toRole; }
    if (q.kind) { where.push('kind = @kind'); params.kind = q.kind; }
    if (q.groupId) { where.push('group_id = @groupId'); params.groupId = q.groupId; }
    if (q.taskId) { where.push('task_id = @taskId'); params.taskId = q.taskId; }
    if (q.unconsumedOnly) where.push('consumed_at IS NULL');
    const sql =
      `SELECT * FROM handoffs${where.length ? ` WHERE ${where.join(' AND ')}` : ''}` +
      ' ORDER BY created_at ASC, id ASC LIMIT @limit';
    const rows = this.db.prepare(sql).all({ ...params, limit: q.limit ?? 500 }) as Row[];
    return rows.map(toHandoff);
  }

  /**
   * 標記一張單已被處理。**沒有這個寫入點，清單只會單向增長**——
   * 人回答了澄清、任務回到 queued，但那張單永遠留在「等你處理」上。
   *
   * @returns 是否真的標到（已標過或找不到 → false，不擲錯：這是收尾動作，
   *          重複呼叫是正常的，不該讓呼叫端的主要流程失敗）。
   */
  consumeHandoff(id: string): boolean {
    const r = this.db
      .prepare('UPDATE handoffs SET consumed_at = @ts WHERE id = @id AND consumed_at IS NULL')
      .run({ id, ts: this.now() });
    return r.changes > 0;
  }

  /** 把某個範圍內還沒處理的單一次標掉（例如群組結案時收掉它底下所有的單）。 */
  consumeHandoffsFor(q: { groupId?: string; taskId?: string; kind?: string }): number {
    const where: string[] = ['consumed_at IS NULL'];
    const params: Record<string, unknown> = { ts: this.now() };
    if (q.groupId) { where.push('group_id = @groupId'); params.groupId = q.groupId; }
    if (q.taskId) { where.push('task_id = @taskId'); params.taskId = q.taskId; }
    if (q.kind) { where.push('kind = @kind'); params.kind = q.kind; }
    const r = this.db.prepare(`UPDATE handoffs SET consumed_at = @ts WHERE ${where.join(' AND ')}`).run(params);
    return r.changes;
  }

  private toGroup(r: Row): Group {
    return {
      id: r.id as string,
      repo: r.repo as string,
      branch: r.branch as string,
      taskIds: JSON.parse((r.task_ids as string) ?? '[]'),
      footprint: JSON.parse((r.footprint as string) ?? '[]'),
      rationale: (r.rationale as string) ?? '',
      afterGroups: JSON.parse((r.after_groups as string) ?? '[]'),
      baseSha: (r.base_sha as string) ?? undefined,
      state: r.state as GroupState,
      prUrl: (r.pr_url as string) ?? undefined,
      prNumber: (r.pr_number as number) ?? undefined,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    };
  }
}
