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
/**
 * `start_task` 失敗要怎麼處置。
 *
 * ── 為什麼不再猜 ──
 *
 * 先前這裡有兩組中英關鍵字正則（DEPS_WAIT_HINTS / NOT_WAITABLE_HINTS），
 * 拿 `${err.code} ${err.error}` 串成一段文字去比對，判它是「可以等的前置未完成」
 * 還是「永久失敗」。註解自己寫著「比對刻意寬鬆到能容忍措辭變化」——
 * 那就是承認它在猜：任務板換一版措辭、換一種語言、換一個錯誤碼，
 * 整組就失效，而失效的方式是**靜默地全部判成 permanent**（預設值），
 * 於是本來只要等一下的任務被直接交人。
 *
 * 現在一律回 permanent 交給呼叫端處置——那是誠實的：程式看到一個它讀不懂的錯誤字串，
 * 它唯一知道的事實就是「認領失敗了」。要判斷「這個錯誤代表什麼」得讀得懂任務板的語意，
 * 那是 agent 或人的事，而交人的路徑本來就在（交接單會帶著原始錯誤全文）。
 */
function classifyStartTaskFailure(_err: { code?: string; error: string }): 'permanent' {
  return 'permanent';
}

/** "spec/mcp-test-sandbox.md#驗收標準" → { docType, fileName, section } */
/**
 * docType 的單複數不一致要在這裡兜掉。
 *
 * MCP 自己的介面就對不上：`list_docs` 的說明講文件放在 `prd/`、`spec/`、**`issues/`**（複數），
 * 但 `read_doc` 的 docType 只吃 `"prd" | "spec" | "issue"`（單數）。任務板給的 docRef 是
 * `issues/2026-07-31-xxx.md`，照抄過去必定失敗——實跑就是這樣：
 *   read_doc 失敗：未知的 docType：issues（可用值：prd / spec / issue）
 * 而失敗的後果是 agent 根本沒拿到那份規格就去做了。
 */
export function normalizeDocType(raw: string): DocType {
  const t = raw.trim().toLowerCase();
  if (t === 'issues' || t === 'issue') return 'issue' as DocType;
  if (t === 'specs' || t === 'spec') return 'spec' as DocType;
  if (t === 'prds' || t === 'prd') return 'prd' as DocType;
  return t as DocType; // 未知的原樣傳過去，讓 MCP 自己報錯（不要猜）
}

export function parseDocRef(ref: string): { docType: DocType; fileName: string; section?: string } {
  const [path, section] = ref.split('#');
  const slash = (path ?? '').indexOf('/');
  const docType = normalizeDocType(slash >= 0 ? path!.slice(0, slash) : 'spec');
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

  /** 列出這個專案的所有文件（prd/ spec/ issues/）。找不到指定檔案時的第一手線索。 */
  async listDocs(): Promise<string> {
    const j = await this.rawOrThrow('handler__list_docs', {});
    return typeof j === 'string' ? j : JSON.stringify(j);
  }

  /**
   * 語意搜尋文件。**可能回傳不相干的結果**——呼叫端要自己讀過確認，
   * 所以這個工具只給 agent 用，程式不會拿它的結果直接當規格。
   */
  async searchDocs(query: string): Promise<string> {
    const j = await this.rawOrThrow('handler__search_docs', { query });
    return typeof j === 'string' ? j : JSON.stringify(j);
  }

  async readDoc(docType: DocType, fileName: string, section?: string): Promise<string> {
    const j = await this.rawOrThrow('handler__read_doc', { docType, fileName, ...(section ? { section } : {}) });
    return typeof j === 'string' ? j : (j.body ?? '');
  }

  /**
   * 讀不到的規格**不可以靜默略過**。
   *
   * 先前失敗只留一行 warn，agent 連「有這份規格」都不知道就去做了。
   * 檔案改名、章節改名、docType 對不上——任何一種都會讓它少拿到一段需求，
   * 而它做出來的東西看起來完全正常（build/test 都會過）。
   *
   * 改成把失敗本身當成一筆內容交給它，並指名要用 search_docs／list_docs 自己找。
   * 那件事只有 agent 做得到：程式只能照字串比對，agent 讀得到內容、判斷得出像不像。
   */
  async loadDocs(refs: string[]): Promise<LoadedDoc[]> {
    const out: LoadedDoc[] = [];
    for (const ref of refs) {
      const { docType, fileName, section } = parseDocRef(ref);
      try {
        const content = await this.readDoc(docType, fileName, section);
        out.push({ ref, content });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        this.log.warn({ ref, err: why }, 'read_doc 失敗 → 改交給 agent 自己找');
        out.push({
          ref,
          content:
            `⚠️ 這份規格讀不到：${why}\n\n`
            + `**不要當作它不存在。** 可能是檔案改名、章節改名，或 docType 對不上。\n`
            + `請用 \`search_docs\`（語意搜尋，可能回不相干的結果，要自己讀過確認）`
            + `或 \`list_docs\`（列出全部文件）把它找出來再動工。\n`
            + `真的找不到，就用 ask_human 問，不要憑任務標題猜規格。`,
        });
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
        // **不猜這個錯誤代表什麼。** 一律 permanent → 停下來交人，錯誤全文一起帶上去。
        // 先前用兩組中英關鍵字正則猜「這是可以等的前置未完成嗎」，換一版措辭就失效，
        // 而失效的方式是靜默地全部落到預設值。要判斷「這個錯誤代表什麼」得讀得懂
        // 任務板的語意——那是人或 agent 的事，而交人的路徑本來就在。
        const kind = classifyStartTaskFailure(err);
        this.log.warn(
          { taskId: id, code: err.code, detail: err.error },
          'start_task 失敗，交由呼叫端停下來處理（原始錯誤一起帶給人）',
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
