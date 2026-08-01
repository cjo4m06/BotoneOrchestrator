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

/** 一次 agent 執行的紀錄（同一 session 多輪會累加）。 */
export interface AgentSessionInput {
  taskId: string;
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
           (task_id, group_id, session_id, rounds, cost_usd, input_tokens, output_tokens,
            cache_read_tokens, models, status, created_at, updated_at)
         VALUES
           (@taskId, @groupId, @sessionId, 1, @costUsd, @inputTokens, @outputTokens,
            @cacheReadTokens, @models, @status, @ts, @ts)
         ON CONFLICT(task_id, session_id) DO UPDATE SET
           rounds = rounds + 1,
           cost_usd = cost_usd + @costUsd,
           input_tokens = input_tokens + @inputTokens,
           output_tokens = output_tokens + @outputTokens,
           cache_read_tokens = cache_read_tokens + @cacheReadTokens,
           -- models 併集：同一 session 中途換模型時兩個都要留下
           models = @models,
           status = @status,
           group_id = COALESCE(@groupId, group_id),
           updated_at = @ts`,
      )
      .run({
        taskId: input.taskId,
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
        `SELECT COALESCE(t.repo, '(unknown)') AS repo,
                COALESCE(SUM(s.cost_usd),0) AS cost,
                COALESCE(SUM(s.rounds),0) AS rounds,
                COUNT(*) AS sessions
           FROM agent_sessions s LEFT JOIN tasks t ON t.id = s.task_id
          WHERE s.created_at >= ?
          GROUP BY COALESCE(t.repo, '(unknown)')
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
        `INSERT INTO groups (id, repo, branch, task_ids, footprint, after_groups, state, pr_url, pr_number, created_at, updated_at)
           VALUES (@id, @repo, @branch, @taskIds, @footprint, @afterGroups, @state, @prUrl, @prNumber, @ts, @ts)
         ON CONFLICT(id) DO UPDATE SET
           branch=@branch, task_ids=@taskIds, footprint=@footprint, after_groups=@afterGroups, state=@state,
           pr_url=@prUrl, pr_number=@prNumber, updated_at=@ts`,
      )
      .run({
        id: g.id,
        repo: g.repo,
        branch: g.branch,
        taskIds: JSON.stringify(g.taskIds),
        footprint: JSON.stringify(g.footprint),
        afterGroups: JSON.stringify(g.afterGroups ?? []),
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
  createGroup(input: { repo: string; branch: string; taskIds: string[]; footprint: string[]; afterGroups?: string[] }): Group {
    const id = 'g_' + createHash('sha1').update(`${input.repo}|${[...input.taskIds].sort().join(',')}`).digest('hex').slice(0, 12);
    const existing = this.getGroup(id);
    if (existing) return existing;
    this.upsertGroup({
      id, repo: input.repo, branch: input.branch, taskIds: input.taskIds,
      footprint: input.footprint, afterGroups: input.afterGroups ?? [], state: 'ready',
    });
    return this.getGroup(id)!;
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
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    };
  }

  private toGroup(r: Row): Group {
    return {
      id: r.id as string,
      repo: r.repo as string,
      branch: r.branch as string,
      taskIds: JSON.parse((r.task_ids as string) ?? '[]'),
      footprint: JSON.parse((r.footprint as string) ?? '[]'),
      afterGroups: JSON.parse((r.after_groups as string) ?? '[]'),
      state: r.state as GroupState,
      prUrl: (r.pr_url as string) ?? undefined,
      prNumber: (r.pr_number as number) ?? undefined,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    };
  }
}
