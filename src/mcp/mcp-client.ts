import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CircuitBreaker, withRetryResult, type BreakerSnapshot, type BreakerState, type RetryOptions } from '../core/retry.js';
import type { McpTaskClient } from '../contracts.js';
import type { RepoInfo, TaskBrief, TaskDetail, McpOut, DocType } from '../types.js';
import type { LoadedDoc } from '../worker/agent-runtime.js';
import type { Logger } from '../observability/logger.js';

export interface McpClientConfig {
  /** http transport 的端點；用 createTransport 注入其他傳輸時可留空字串。 */
  url: string;
  token: string;
  /**
   * 自訂傳輸工廠（stdio 等非 HTTP 傳輸用）。未給 → Streamable HTTP。
   * 每次連線嘗試都會重呼叫一次：transport 用過即棄，重試必須拿新的一條。
   */
  createTransport?: () => Transport;
  /** 熔斷器/診斷用名稱；未給時由 url 的 host 推導（stdio 沒有 host 可用）。 */
  label?: string;
}

export type McpErrorKind = 'transient' | 'permanent' | 'signal';
export class McpError extends Error {
  constructor(public kind: McpErrorKind, message: string) {
    super(message);
    this.name = 'McpError';
  }
}

// ── 韌性設定（DESIGN §6：transient 退避重試、permanent/signal 不重試、連掛熔斷） ──

export interface McpResilienceOptions extends Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs' | 'maxTotalMs' | 'sleep' | 'now' | 'random'> {
  /** 直接注入熔斷器（多個 client 共用同一來源時用）；不給就依門檻自建一個。 */
  breaker?: CircuitBreaker;
  /** 連續 transient 失敗幾次 → 熔斷該來源。 */
  breakerFailureThreshold?: number;
  /** 熔斷後多久允許試探。 */
  breakerCooldownMs?: number;
  /** 熔斷狀態轉換通知（給 dashboard / Slack）。 */
  onBreakerChange?: (from: BreakerState, to: BreakerState, detail: string) => void;
}

/** 預設值：4 次嘗試（最多退避 3 次）、連續 5 次 transient 失敗熔斷 60 秒。 */
export const MCP_RESILIENCE_DEFAULTS = {
  attempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  breakerFailureThreshold: 5,
  breakerCooldownMs: 60_000,
} as const;

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const n = Number.parseInt(env[key] ?? '', 10);
  // 設錯（非數字/負數）就當沒設：韌性參數不該成為 daemon 啟動失敗的理由
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 從環境變數讀韌性參數（orchestrator.yaml 的 schema 由別處維護，這裡走 env 以免搶同一份設定）。
 * ORCH_MCP_RETRY_ATTEMPTS / ORCH_MCP_RETRY_BASE_MS / ORCH_MCP_RETRY_MAX_MS /
 * ORCH_MCP_BREAKER_THRESHOLD / ORCH_MCP_BREAKER_COOLDOWN_MS
 */
export function mcpResilienceFromEnv(env: NodeJS.ProcessEnv = process.env): McpResilienceOptions {
  const d = MCP_RESILIENCE_DEFAULTS;
  return {
    attempts: envInt(env, 'ORCH_MCP_RETRY_ATTEMPTS', d.attempts),
    baseDelayMs: envInt(env, 'ORCH_MCP_RETRY_BASE_MS', d.baseDelayMs),
    maxDelayMs: envInt(env, 'ORCH_MCP_RETRY_MAX_MS', d.maxDelayMs),
    breakerFailureThreshold: envInt(env, 'ORCH_MCP_BREAKER_THRESHOLD', d.breakerFailureThreshold),
    breakerCooldownMs: envInt(env, 'ORCH_MCP_BREAKER_COOLDOWN_MS', d.breakerCooldownMs),
  };
}

/** 熔斷器名稱用 host（同一台 MCP 的多個 client 在 log 裡才看得出是同一來源）。 */
function breakerNameOf(url: string): string {
  try {
    return `mcp:${new URL(url).host}`;
  } catch {
    return 'mcp';
  }
}

/** 傳輸層例外分類：401/403 永久，其餘（網路/逾時/5xx/429）預設可重試。 */
function classifyTransport(e: unknown): McpError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/\b40[13]\b|unauthor|forbidden/i.test(msg)) return new McpError('permanent', msg);
  return new McpError('transient', msg);
}

/** 帶內錯誤：payload 為 { ok:false, error, code }。 */
function inbandError(json: unknown): { error: string; code?: string } | undefined {
  if (json && typeof json === 'object' && (json as { ok?: unknown }).ok === false) {
    const j = json as { error?: string; code?: string };
    return { error: j.error ?? '未知錯誤', code: j.code };
  }
  return undefined;
}

// ── start_task 帶內失敗的語意分類（DESIGN §6 三分類 / §D18 誤殺） ──

/**
 * 「再等一下就會好」的措辭 —— 只有**依賴／前置未完成**算數。
 * 真實 MCP 長這樣：`還有 1 個前置任務未完成：「建立 /sandbox 路由骨架」(進行中)`。
 * 比對刻意寬鬆到能容忍措辭變化（中英、code 欄位），但**不含**任何泛用失敗字眼。
 */
const DEPS_WAIT_HINTS: RegExp[] = [
  /前置(任務|工作|項目|條件)/,
  /依賴|相依|上游任務/,
  /dep(s|end)/i, // DEPS_NOT_DONE / dependency / depends on
  /prerequisite|upstream/i,
  /blocked\s*by|waiting\s*(for|on)/i,
  /(還有|尚有)\s*\d*\s*[個項].{0,12}未完成/, // 「還有 2 個上游卡未完成」這類措辭變化
];

/**
 * 「等再久也不會好」的措辭 —— 一律 permanent，讓流程停下來讓人看到。
 *
 * 特別注意：`(進行中)` **不可**放進這裡——依賴訊息本身就會用它描述前置任務的狀態
 * （`…未完成：「X」(進行中)`），誤收會把真正的依賴訊號吃掉。所以只認「已…進行中」。
 */
const NOT_WAITABLE_HINTS: RegExp[] = [
  /已(經)?(被)?[^，。；]{0,8}?(認領|領取|接手)/, // 「任務已被 alice 認領」
  /已(在)?(開始|進行中)/, // 「任務已開始／已在進行中」（崩潰恢復後重新認領會撞到）
  /已(經)?(完成|結束|關閉)/, // 「任務已完成」——MCP 無反 done 工具，等不到它變回 todo
  /指派|分派|assign/i, // 指派給他人／未指派給你：不會因為等待而改變
  /不存在|找不到|無此|not\s*found|unknown\s*task/i,
  /權限|無權|forbidden|unauthor/i,
  /參數|格式|invalid|validation|bad\s*request/i,
  /already\s*(claimed|started|in[_\s-]?progress|done|completed|finished|assigned)/i,
];

/**
 * start_task 的帶內 `{ ok:false }` 該歸 signal 還是 permanent（缺陷 1）。
 *
 * 為什麼不能像以前那樣「一律 signal」：signal 的語意是「照做（標 blocked:deps）並稍後重試」，
 * 於是「已被認領／已完成／指派給他人／參數錯」全都變成無聲重試。
 * 最糟的是崩潰恢復：MCP 上任務還是 in_progress（上次已認領）→ 重新 start_task 失敗 →
 * signal → blocked:deps → 群回 ready → 下一輪再來 → **永久空轉**，Slack 一則通知都沒有。
 *
 * 取捨方向（§D18）：**寧可錯歸 permanent**。permanent 會停下來讓人看到，
 * signal 會無聲重試；誤殺一次有人來看，漏抓一次就是永遠空轉。
 * 所以規則是「否定優先、白名單其次、預設 permanent」。
 */
export function classifyStartTaskFailure(err: { error: string; code?: string }): 'signal' | 'permanent' {
  const text = `${err.code ?? ''} ${err.error}`;
  if (NOT_WAITABLE_HINTS.some((re) => re.test(text))) return 'permanent';
  if (DEPS_WAIT_HINTS.some((re) => re.test(text))) return 'signal';
  return 'permanent';
}

/** "spec/mcp-test-sandbox.md#驗收標準" → { docType, fileName, section } */
function parseDocRef(ref: string): { docType: DocType; fileName: string; section?: string } {
  const [path, section] = ref.split('#');
  const slash = (path ?? '').indexOf('/');
  const docType = (slash >= 0 ? path!.slice(0, slash) : 'spec') as DocType;
  const fileName = slash >= 0 ? path!.slice(slash + 1) : (path ?? '');
  return { docType, fileName, section: section || undefined };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapRepo(r: any): RepoInfo {
  return { repo: r.repo, owner: r.owner, name: r.name, branch: r.branch || undefined };
}
function mapTaskBrief(t: any): TaskBrief {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    repo: t.repo,
    assigneeId: t.assigneeId ?? undefined,
    ...timestamps(t),
  };
}

/**
 * MCP 的時間戳（pmm 回 ISO 字串，別的 server 可能回 epoch）→ 毫秒。
 * 解析不出來就整個省略，讓靜置期退回「本地發現時間」，而不是拿一個假的 0 當「很久以前」——
 * 那會讓一批剛建立的任務被當成靜置已久，直接開工做出半成品。
 */
function timestamps(t: any): { createdAt?: number; updatedAt?: number } {
  const out: { createdAt?: number; updatedAt?: number } = {};
  const c = toEpochMs(t?.createdAt);
  const u = toEpochMs(t?.updatedAt);
  if (c !== undefined) out.createdAt = c;
  if (u !== undefined) out.updatedAt = u;
  return out;
}

export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v <= 0) return undefined;
    return v < 1e12 ? v * 1000 : v; // 秒 vs 毫秒（1e12 ms ≈ 2001 年，早於本系統存在）
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Date.parse(v);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}
function mapTaskDetail(t: any): TaskDetail {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    repo: t.repo,
    assigneeId: t.assigneeId ?? undefined,
    category: t.category,
    description: t.description ?? t.summary ?? '',
    dependencies: Array.isArray(t.depIdList) ? t.depIdList : (t.dependencies ?? []),
    docRefs: Array.isArray(t.docRefsList) ? t.docRefsList : [],
    ...timestamps(t),
  };
}

/**
 * pmm MCP 的具體 client（Streamable HTTP + Bearer）。
 * 對映真實回應（DESIGN §12），並把帶內 { ok:false } 依語意分類：
 *   start_task 失敗 → 只有可辨識的「依賴未滿足」是 signal（稍後重試），
 *   其餘（已認領／已完成／指派他人／參數錯）與讀取失敗一律 permanent（見 classifyStartTaskFailure）。
 *
 * 韌性（DESIGN §6）包在**傳輸層**（callOnce）外面：只有丟例外的傳輸失敗會被重試/計入熔斷，
 * 帶內 { ok:false } 是「對方有正常回應」，走回傳值路徑，因此三分類語意完全不受影響
 * （尤其 start_task 的 signal 絕不會被當成暫時性故障重打）。
 */
export class PmmMcpClient implements McpTaskClient {
  private client: Client;
  private connected = false;
  private breaker: CircuitBreaker;
  private retry: RetryOptions;

  constructor(private cfg: McpClientConfig, private log: Logger, res: McpResilienceOptions = {}) {
    this.client = new Client({ name: 'botone-orchestrator', version: '0.0.1' });
    const d = MCP_RESILIENCE_DEFAULTS;
    this.breaker =
      res.breaker ??
      new CircuitBreaker(cfg.label ?? breakerNameOf(cfg.url), {
        failureThreshold: res.breakerFailureThreshold ?? d.breakerFailureThreshold,
        cooldownMs: res.breakerCooldownMs ?? d.breakerCooldownMs,
        log,
        ...(res.now ? { now: res.now } : {}),
        ...(res.onBreakerChange ? { onStateChange: res.onBreakerChange } : {}),
      });
    this.retry = {
      attempts: res.attempts ?? d.attempts,
      baseDelayMs: res.baseDelayMs ?? d.baseDelayMs,
      maxDelayMs: res.maxDelayMs ?? d.maxDelayMs,
      breaker: this.breaker,
      log,
      ...(res.maxTotalMs !== undefined ? { maxTotalMs: res.maxTotalMs } : {}),
      ...(res.sleep ? { sleep: res.sleep } : {}),
      ...(res.now ? { now: res.now } : {}),
      ...(res.random ? { random: res.random } : {}),
    };
  }

  /** 熔斷器現況（log / dashboard / Slack 診斷用）。 */
  breakerSnapshot(): BreakerSnapshot {
    return this.breaker.snapshot();
  }

  /** 連線同樣走退避重試（開機時 MCP 還沒起來很常見）；失敗擲 McpError，由呼叫端決定是否略過該專案。 */
  async connect(): Promise<void> {
    if (this.connected) return;
    const r = await withRetryResult(async () => {
      // transport 不可重用：每次嘗試都要新建一條
      const transport =
        this.cfg.createTransport?.() ??
        new StreamableHTTPClientTransport(new URL(this.cfg.url), {
          requestInit: { headers: { Authorization: `Bearer ${this.cfg.token}` } },
        });
      try {
        await this.client.connect(transport);
      } catch (e) {
        // 一定要先分類：undici 的連線失敗是 TypeError('fetch failed')，
        // 不轉成 McpError 會被通用分類器當成程式 bug（permanent）而放棄重試
        throw classifyTransport(e);
      }
    }, { ...this.retry, label: 'mcp.connect' });
    if (!r.ok) throw new McpError(r.kind, r.detail);
    this.connected = true;
    this.log.info('已連上 MCP');
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  /**
   * 呼叫工具（含指數退避重試 + 熔斷），回傳解析後 JSON。
   * transient 才重試；permanent 立即回傳；熔斷開啟時根本不送出（回 transient，避免整池狂打）。
   * 失敗一律以 McpError 呈現，維持既有呼叫端（rawOrThrow / startTask / completeTask）的處理方式。
   */
  private async raw(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const r = await withRetryResult(() => this.callOnce(name, args), { ...this.retry, label: `mcp.${name}` });
    if (r.ok) return r.value;
    throw new McpError(r.kind, r.detail);
  }

  /** 單次工具呼叫（不含重試）：傳輸例外 → McpError(transient/permanent)。 */
  private async callOnce(name: string, args: Record<string, unknown>): Promise<unknown> {
    let res: { content?: { type: string; text?: string }[] };
    try {
      res = (await this.client.callTool({ name, arguments: args })) as any;
    } catch (e) {
      throw classifyTransport(e);
    }
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** 讀取類：帶內 { ok:false } → 擲 McpError(permanent)。 */
  private async rawOrThrow(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const json = await this.raw(name, args);
    const err = inbandError(json);
    if (err) throw new McpError('permanent', `${name}: ${err.error}`);
    return json;
  }

  // ── 讀取 ──

  async listRepos(): Promise<RepoInfo[]> {
    const j = await this.rawOrThrow('handler__list_repos');
    return (j.rows ?? []).map(mapRepo);
  }

  async listTasks(q: { repo?: string; mine?: boolean; status?: 'todo' | 'in_progress' | 'done'; assigneeId?: string } = {}): Promise<TaskBrief[]> {
    const j = await this.rawOrThrow('handler__list_tasks', { ...q });
    return (j.tasks ?? []).map(mapTaskBrief);
  }

  async getTask(id: string): Promise<TaskDetail> {
    const j = await this.rawOrThrow('handler__get_task', { taskId: id });
    return mapTaskDetail(j);
  }

  async readDoc(docType: DocType, fileName: string, section?: string): Promise<string> {
    const j = await this.rawOrThrow('handler__read_doc', { docType, fileName, ...(section ? { section } : {}) });
    return typeof j === 'string' ? j : (j.body ?? '');
  }

  async loadDocs(refs: string[]): Promise<LoadedDoc[]> {
    const out: LoadedDoc[] = [];
    for (const ref of refs) {
      const { docType, fileName, section } = parseDocRef(ref);
      try {
        const content = await this.readDoc(docType, fileName, section);
        out.push({ ref, content });
      } catch (e) {
        this.log.warn({ ref, err: e instanceof Error ? e.message : String(e) }, 'read_doc 失敗，略過該段');
      }
    }
    return out;
  }

  // ── 認領/完成（回 McpOut，帶內錯誤依語意分類）──

  async startTask(id: string): Promise<McpOut<TaskDetail>> {
    try {
      const j = await this.raw('handler__start_task', { taskId: id });
      const err = inbandError(j);
      if (err) {
        // 只有**明確可辨識**的「依賴未滿足」才是 signal（＝照做：標 blocked 等下一輪）；
        // 其餘（已認領／已完成／指派他人／參數錯）一律 permanent，讓它停下來被人看到。
        const kind = classifyStartTaskFailure(err);
        this.log[kind === 'signal' ? 'info' : 'warn'](
          { taskId: id, code: err.code, kind, detail: err.error },
          kind === 'signal' ? 'start_task 受阻於依賴，稍後重試' : 'start_task 失敗且重試無用，交由呼叫端停下來處理',
        );
        return { ok: false, kind, detail: err.error };
      }
      return { ok: true, value: mapTaskDetail(j) };
    } catch (e) {
      const me = e instanceof McpError ? e : classifyTransport(e);
      return { ok: false, kind: me.kind, detail: me.message };
    }
  }

  async completeTask(id: string, opts?: { summary?: string }): Promise<McpOut<void>> {
    try {
      const j = await this.raw('handler__complete_task', {
        taskId: id,
        ...(opts?.summary ? { summary: opts.summary } : {}),
      });
      const err = inbandError(j);
      if (err) return { ok: false, kind: 'permanent', detail: err.error };
      return { ok: true, value: undefined };
    } catch (e) {
      const me = e instanceof McpError ? e : classifyTransport(e);
      return { ok: false, kind: me.kind, detail: me.message };
    }
  }
}
