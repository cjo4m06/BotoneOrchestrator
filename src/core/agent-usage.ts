import type { AgentKind } from '../store/ledger.js';
import type { Logger } from '../observability/logger.js';

/**
 * 把一次 agent 執行的花費記下來。
 *
 * ── 為什麼要有這個共用件 ──
 *
 * 先前**只有寫程式的 agent** 會記帳。規劃、reviewer、介面判斷者、飄移判斷者、
 * 合併風險判斷者——五個角色一毛都沒記。實跑撞到：一次跑 13 分鐘、輸出 139k token、
 * 快取讀 3.3M 的規劃，帳面 $0。
 *
 * 更要命的是**預算閘門用的是同一份數字**（orchestrator 的 withinBudget →
 * ledger.costSummary），所以使用者設的花費上限只擋到一部分支出，
 * 而他完全不知道差多少。
 *
 * 每個角色各寫一份取值邏輯的話，這種「漏接一個」必然會再發生——
 * 那正是這個系統最常見的 bug 形狀。所以統一在這裡：
 * 五個 runQuery 只要把 SDK 的 result 訊息丟進來。
 */

/** ledger 的記帳能力（只取這個模組用得到的部分，方便測試注入）。 */
export interface UsageSink {
  recordAgentSession(input: {
    kind: AgentKind;
    taskId: string;
    repo?: string;
    sessionId: string;
    groupId?: string;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    models?: string[];
    status?: 'active' | 'done' | 'parked' | 'error';
  }): void;
}

export interface UsageContext {
  kind: AgentKind;
  /** 不屬於任何單一任務時省略（會存成 '' 哨兵值，見 schema）。 */
  taskId?: string;
  repo?: string;
  groupId?: string;
}

/** SDK 的 result 訊息裡跟花費有關的欄位（形狀與 agent-runtime 的 usageOf 一致）。 */
type PerModel = Partial<Record<'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'costUSD', number>>;

/**
 * 從 SDK 的 result 訊息取出花費。取不到回 undefined（呼叫端就不記）。
 *
 * 兩條路都要試：`total_cost_usd` 是總額，`modelUsage` 是逐模型明細。
 * 只看其中一個的話，SDK 版本一變就會靜靜地記成 0。
 */
export function usageFromResult(raw: unknown): {
  costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; models: string[];
} | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'result') return undefined;

  const perModel = (typeof m.modelUsage === 'object' && m.modelUsage !== null
    ? (m.modelUsage as Record<string, PerModel>)
    : {});
  const models = Object.keys(perModel);
  const total = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined;
  if (models.length === 0 && total === undefined) return undefined;

  const sum = (f: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens'): number =>
    models.reduce((acc, k) => acc + (perModel[k]?.[f] ?? 0), 0);

  return {
    costUsd: total ?? models.reduce((s, k) => s + (perModel[k]?.costUSD ?? 0), 0),
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadInputTokens'),
    models,
  };
}

/**
 * 記一次花費。
 *
 * **記帳失敗不可以讓正在做的事失敗**——它是觀測，不是業務邏輯。
 * 但也不能無聲吞掉，否則「帳面是 0」與「真的沒花錢」分不出來（那正是這個 bug 的形狀）。
 */
export function recordAgentUsage(
  sink: UsageSink | undefined,
  log: Logger,
  ctx: UsageContext,
  raw: unknown,
): void {
  if (!sink) return;
  const usage = usageFromResult(raw);
  if (!usage) return;

  // session id：SDK 每次 query 都會給。沒有就用角色＋repo 當鍵，
  // 至少讓同一個角色的花費累加在一起，而不是整筆丟掉
  const m = raw as Record<string, unknown>;
  const sessionId = typeof m.session_id === 'string' && m.session_id
    ? m.session_id
    : `${ctx.kind}:${ctx.repo ?? ctx.taskId ?? 'unknown'}`;

  try {
    sink.recordAgentSession({
      kind: ctx.kind,
      taskId: ctx.taskId ?? '',
      ...(ctx.repo ? { repo: ctx.repo } : {}),
      ...(ctx.groupId ? { groupId: ctx.groupId } : {}),
      sessionId,
      costUsd: usage.costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      models: usage.models,
      status: 'done',
    });
    log.debug({ kind: ctx.kind, repo: ctx.repo, costUsd: usage.costUsd }, 'agent 花費已記錄');
  } catch (e) {
    log.warn({ kind: ctx.kind, err: e instanceof Error ? e.message : String(e) }, 'agent 花費記錄失敗（不影響執行）');
  }
}
