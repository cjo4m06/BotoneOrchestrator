// 錯誤三分類 + 重試/退避 + 熔斷（DESIGN.md §6）。
//
// 預期整合點（本檔不主動接線，由協調者在 main.ts / group-runner.ts 決定）：
//   1. PmmMcpClient 的呼叫：用 withRetryOut() 包住 startTask/completeTask，
//      transient 才重試；signal（依賴未完/未指派）原樣回傳讓 Worker 去 park。
//   2. Poller / PrManager / MergeGuard 的外部呼叫（MCP、GitHub、git push）：
//      用 withRetry() 包住；push 被拒(non-fast-forward) 屬 permanent，要 rebase 再推而非重試。
//   3. 熔斷：每個外部依賴（每個 MCP endpoint、GitHub）建一個 CircuitBreaker 長期持有，
//      透過 RetryOptions.breaker 傳入。open 時 Dispatcher 應停派新群（「暫停整池」），
//      snapshot() 供 log/dashboard 顯示。
//   4. 生產環境請注入 log；測試注入 sleep/now/random 以避免真實等待。

import type { McpOut } from '../types.js';
import type { Logger } from '../observability/logger.js';

// ── 錯誤三分類 ──

export type ErrorKind = 'transient' | 'permanent' | 'signal';

export interface ClassifiedError {
  kind: ErrorKind;
  detail: string;
  /** 有解析出 HTTP 狀態碼時附上，方便 log/dashboard 歸因。 */
  status?: number;
}

/** 明確可重試的狀態碼（DESIGN §6：429·500·502·503·529 + 常見逾時/過載變體）。 */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 509, 521, 522, 523, 524, 529, 598, 599]);

/** 明確不可重試：參數/認證/資源不存在/語意錯誤，重試只是浪費配額。 */
const PERMANENT_STATUS = new Set([400, 401, 403, 404, 405, 406, 409, 410, 411, 413, 414, 415, 422, 501, 505]);

/** 網路層錯誤碼：連不上/斷線/DNS 暫時失敗，都算 transient。 */
const NETWORK_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'EBUSY',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

/** 程式碼自身的 bug：重試永遠不會變好，歸 permanent 以免無謂退避。 */
const BUG_ERROR_NAMES = new Set(['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError']);

/** 純狀態碼分類；未知碼依 4xx→permanent / 5xx→transient 收斂。 */
export function classifyHttpStatus(status: number): ErrorKind {
  if (TRANSIENT_STATUS.has(status)) return 'transient';
  if (PERMANENT_STATUS.has(status)) return 'permanent';
  if (status >= 500) return 'transient';
  return 'permanent';
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/** 從例外物件（fetch Response、undici、octokit、execa…）挖 HTTP 狀態碼。 */
function extractStatus(e: unknown): number | undefined {
  const o = asRecord(e);
  if (!o) return undefined;
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const v = o[key];
    if (typeof v === 'number' && v >= 100 && v < 600) return v;
    if (typeof v === 'string' && /^\d{3}$/.test(v)) return Number(v);
  }
  const res = asRecord(o.response);
  const rs = res?.status;
  if (typeof rs === 'number' && rs >= 100 && rs < 600) return rs;
  return undefined;
}

/** MCP client 只把狀態碼寫進 message（見 mcp-client.classifyTransport），所以也從文字撈。 */
function statusFromMessage(msg: string): number | undefined {
  const m = /\b([45]\d{2})\b/.exec(msg);
  return m?.[1] ? Number(m[1]) : undefined;
}

function errorCode(e: unknown): string | undefined {
  const o = asRecord(e);
  const c = o?.code;
  return typeof c === 'string' ? c.toUpperCase() : undefined;
}

/**
 * 通用分類器。優先序：
 *   顯式 kind 欄位（McpError / McpOut 失敗）→ HTTP 狀態碼 → 網路錯誤碼/逾時字樣 → 程式 bug → 預設 transient。
 * 預設 transient 沿用 mcp-client 的保守做法：寧可退避重試幾次，也不要把暫時性故障當成永久失敗上報。
 */
export function classifyError(e: unknown): ClassifiedError {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e ?? null);

  const kindField = asRecord(e)?.kind;
  if (kindField === 'transient' || kindField === 'permanent' || kindField === 'signal') {
    return { kind: kindField, detail: msg };
  }

  const status = extractStatus(e) ?? statusFromMessage(msg);
  if (status !== undefined) return { kind: classifyHttpStatus(status), detail: msg, status };

  const code = errorCode(e);
  if (code && NETWORK_CODES.has(code)) return { kind: 'transient', detail: msg };
  if (/timed? ?out|socket hang up|network error|ECONN|EAI_AGAIN/i.test(msg)) return { kind: 'transient', detail: msg };
  if (/unauthor|forbidden|invalid api key|authentication/i.test(msg)) return { kind: 'permanent', detail: msg };

  const name = e instanceof Error ? e.name : undefined;
  if (name && BUG_ERROR_NAMES.has(name)) return { kind: 'permanent', detail: `${name}: ${msg}` };

  return { kind: 'transient', detail: msg };
}

// ── 退避計算 ──

export interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  /** 抖動幅度 0..1；0.2 = 實際延遲落在理論值的 ±20%。random() 回 0.5 時剛好等於理論值。 */
  jitter?: number;
  random?: () => number;
}

/** 第 n 次重試（n 從 1 起算）前應等待的毫秒數：指數退避 + 對稱 jitter，並夾在 maxDelayMs 內。 */
export function computeBackoffDelay(retryIndex: number, opts: BackoffOptions = {}): number {
  const { baseDelayMs = 500, maxDelayMs = 30_000, factor = 2, jitter = 0.2, random = Math.random } = opts;
  const raw = baseDelayMs * Math.pow(factor, Math.max(0, retryIndex - 1));
  const capped = Math.min(raw, maxDelayMs);
  // jitter 打散同時失敗的多個 worker，避免退避後又一起撞上去（thundering herd）
  const scale = 1 - jitter + random() * jitter * 2;
  return Math.max(0, Math.min(maxDelayMs, Math.round(capped * scale)));
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── withRetry ──

export type RetryFailureReason =
  | 'non_retryable'      // permanent / signal：立即回傳
  | 'attempts_exhausted' // 用完次數
  | 'timeout'            // 超過 maxTotalMs
  | 'circuit_open'       // 熔斷器擋下，根本沒送出
  | 'aborted';           // 外部取消

export interface RetryAttemptInfo {
  label?: string;
  attempt: number;       // 已失敗的第幾次嘗試（1 起算）
  delayMs: number;       // 接下來要睡多久
  error: ClassifiedError;
}

export interface RetryOptions extends BackoffOptions {
  /** 最大嘗試次數（含第一次）。預設 4 → 最多重試 3 次。 */
  attempts?: number;
  /** 從第一次嘗試起算的總時間上限；預估下一次退避會超過就提早放棄。 */
  maxTotalMs?: number;
  classify?: (e: unknown) => ClassifiedError;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  breaker?: CircuitBreaker;
  abort?: AbortSignal;
  onRetry?: (info: RetryAttemptInfo) => void;
  /** log 用的呼叫名稱，例如 'mcp.startTask'。 */
  label?: string;
  log?: Logger;
}

export type RetryResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; kind: ErrorKind; detail: string; status?: number; attempts: number; reason: RetryFailureReason; error?: unknown };

export class RetryError extends Error {
  constructor(
    readonly kind: ErrorKind,
    readonly reason: RetryFailureReason,
    readonly attempts: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RetryError';
  }
}

/**
 * 指數退避 + jitter 重試；只對 transient 重試，permanent/signal 立即回傳（不擲例外）。
 * 所有時間來源（sleep/now/random）都可注入，測試不需真的等待。
 */
export async function withRetryResult<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<RetryResult<T>> {
  const {
    attempts = 4, maxTotalMs, classify = classifyError, sleep = realSleep, now = Date.now,
    breaker, abort, onRetry, label, log,
  } = opts;
  const maxAttempts = Math.max(1, Math.floor(attempts));
  const startedAt = now();

  let last: ClassifiedError = { kind: 'transient', detail: '尚未嘗試' };
  let lastRaw: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (abort?.aborted) {
      return { ok: false, kind: 'signal', detail: `${label ?? '呼叫'}已取消`, attempts: attempt - 1, reason: 'aborted' };
    }
    if (breaker && !breaker.canPass()) {
      const detail = `熔斷器 ${breaker.name} 開啟中，暫不送出 ${label ?? '呼叫'}`;
      log?.warn({ label, breaker: breaker.snapshot() }, detail);
      return { ok: false, kind: 'transient', detail, attempts: attempt - 1, reason: 'circuit_open' };
    }

    try {
      const value = await fn(attempt);
      breaker?.onSuccess();
      return { ok: true, value, attempts: attempt };
    } catch (e) {
      lastRaw = e;
      last = classify(e);
      // 熔斷器量的是「對方還通不通」：permanent/signal 代表對方有回應，不算故障。
      if (last.kind === 'transient') breaker?.onFailure(last.detail);
      else breaker?.onSuccess();

      if (last.kind !== 'transient') {
        return { ok: false, ...last, attempts: attempt, reason: 'non_retryable', error: e };
      }
      if (attempt >= maxAttempts) {
        return { ok: false, ...last, attempts: attempt, reason: 'attempts_exhausted', error: e };
      }

      const delayMs = computeBackoffDelay(attempt, opts);
      if (maxTotalMs !== undefined && now() - startedAt + delayMs > maxTotalMs) {
        return { ok: false, ...last, attempts: attempt, reason: 'timeout', error: e };
      }
      onRetry?.({ label, attempt, delayMs, error: last });
      log?.warn({ label, attempt, delayMs, err: last.detail, status: last.status }, '外部呼叫暫時失敗，退避後重試');
      await sleep(delayMs);
    }
  }

  // 迴圈必然在內部回傳，這行只為型別完整性
  return { ok: false, ...last, attempts: maxAttempts, reason: 'attempts_exhausted', error: lastRaw };
}

/** withRetryResult 的擲例外版本，適合不想處理結果物件的呼叫點。 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const r = await withRetryResult(fn, opts);
  if (r.ok) return r.value;
  throw new RetryError(r.kind, r.reason, r.attempts, `${opts.label ?? '外部呼叫'}失敗（${r.reason}）：${r.detail}`, { cause: r.error });
}

/**
 * 針對回傳 McpOut 的呼叫（不擲例外、用 kind 表達分類）做重試。
 * transient 退避重試；permanent/signal 原樣回傳，讓上層照語意處理（park / 通知）。
 */
export async function withRetryOut<T>(fn: () => Promise<McpOut<T>>, opts: RetryOptions = {}): Promise<McpOut<T>> {
  const r = await withRetryResult<T>(async () => {
    const out = await fn();
    if (out.ok) return out.value;
    // 轉成例外交給共用分類器；kind 欄位會被 classifyError 直接採用
    throw Object.assign(new Error(out.detail), { kind: out.kind });
  }, opts);
  return r.ok ? { ok: true, value: r.value } : { ok: false, kind: r.kind, detail: r.detail };
}

// ── 熔斷器 ──

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** 連續失敗幾次 → open。預設 5。 */
  failureThreshold?: number;
  /** open 後多久允許試探。預設 30 秒。 */
  cooldownMs?: number;
  /** half-open 要連續成功幾次才 close。預設 1。 */
  successThreshold?: number;
  /** half-open 期間同時允許幾個試探呼叫。預設 1。 */
  halfOpenMaxProbes?: number;
  now?: () => number;
  log?: Logger;
  onStateChange?: (from: BreakerState, to: BreakerState, detail: string) => void;
}

export interface BreakerSnapshot {
  name: string;
  state: BreakerState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  openedAt?: number;
  /** open 狀態下，何時可以開始試探。 */
  nextProbeAt?: number;
  lastError?: string;
}

/**
 * 熔斷器（DESIGN §6：「全域連掛 → 熔斷暫停整池」）。
 * closed --連續失敗 N 次--> open --冷卻到期--> half_open --成功--> closed
 *                                                    └--失敗--> open（重新計冷卻）
 * 狀態轉換是惰性的：canPass()/state 讀取時才依 now() 判斷冷卻是否到期，不需背景 timer。
 */
export class CircuitBreaker {
  private _state: BreakerState = 'closed';
  private failures = 0;
  private successes = 0;
  private openedAt?: number;
  private probesInFlight = 0;
  private lastError?: string;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly successThreshold: number;
  private readonly halfOpenMaxProbes: number;
  private readonly now: () => number;

  constructor(readonly name: string, private opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, opts.failureThreshold ?? 5);
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.successThreshold = Math.max(1, opts.successThreshold ?? 1);
    this.halfOpenMaxProbes = Math.max(1, opts.halfOpenMaxProbes ?? 1);
    this.now = opts.now ?? Date.now;
  }

  get state(): BreakerState {
    this.maybeHalfOpen();
    return this._state;
  }

  snapshot(): BreakerSnapshot {
    const state = this.state;
    return {
      name: this.name,
      state,
      consecutiveFailures: this.failures,
      consecutiveSuccesses: this.successes,
      openedAt: this.openedAt,
      nextProbeAt: state === 'open' && this.openedAt !== undefined ? this.openedAt + this.cooldownMs : undefined,
      lastError: this.lastError,
    };
  }

  /** 是否放行。half-open 只放行有限個試探，其餘照樣擋著。 */
  canPass(): boolean {
    this.maybeHalfOpen();
    if (this._state === 'open') return false;
    if (this._state === 'half_open') {
      if (this.probesInFlight >= this.halfOpenMaxProbes) return false;
      this.probesInFlight += 1;
      return true;
    }
    return true;
  }

  onSuccess(): void {
    this.releaseProbe();
    if (this._state === 'half_open') {
      this.successes += 1;
      if (this.successes >= this.successThreshold) this.transition('closed', '試探成功，恢復服務');
      return;
    }
    this.failures = 0;
  }

  onFailure(detail?: string): void {
    this.releaseProbe();
    this.lastError = detail;
    if (this._state === 'half_open') {
      // 試探又掛 → 立刻回 open 並重新計冷卻，避免半開狀態被打爆
      this.openedAt = this.now();
      this.transition('open', `試探失敗：${detail ?? '未知'}`);
      return;
    }
    this.failures += 1;
    if (this._state === 'closed' && this.failures >= this.failureThreshold) {
      this.openedAt = this.now();
      this.transition('open', `連續失敗 ${this.failures} 次：${detail ?? '未知'}`);
    }
  }

  /** 供人工介入（Slack 控制指令）或 daemon 重啟後歸零。 */
  reset(): void {
    this.failures = 0;
    this.successes = 0;
    this.probesInFlight = 0;
    this.openedAt = undefined;
    this.transition('closed', '手動重置');
  }

  private maybeHalfOpen(): void {
    if (this._state !== 'open' || this.openedAt === undefined) return;
    if (this.now() - this.openedAt >= this.cooldownMs) {
      this.probesInFlight = 0;
      this.transition('half_open', '冷卻結束，開始試探');
    }
  }

  private releaseProbe(): void {
    this.probesInFlight = Math.max(0, this.probesInFlight - 1);
  }

  private transition(to: BreakerState, detail: string): void {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    if (to === 'closed') {
      this.failures = 0;
      this.successes = 0;
      this.openedAt = undefined;
    }
    if (to === 'half_open' || to === 'open') this.successes = 0;
    this.opts.log?.warn({ breaker: this.name, from, to }, `熔斷器狀態轉換：${detail}`);
    this.opts.onStateChange?.(from, to, detail);
  }
}
