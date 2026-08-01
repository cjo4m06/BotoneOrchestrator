import type { CostSummary } from '../store/ledger.js';

/**
 * 花費上限。
 *
 * 這個系統刻意不限制單次執行的 turn／token（D10：綁手綁腳的 agent 做不完事），
 * 代價是**沒有任何東西會自己踩煞車**——一個迴圈半夜可以燒掉一整天的預算，
 * 而人是隔天早上看到帳單才知道。
 *
 * 兩件事分開：
 *   · **上限**是硬煞車：達到就停止派新工作。
 *   · **警戒線**是提早喊的那一聲，讓人有機會在撞牆前調整。
 *
 * 刻意**不砍進行中的工作**：那一輪的錢已經花掉了，砍掉只是把錢丟掉還留下半成品。
 * 停的是「再派新的」，所以最多超支一個群組的量，而且會停在一個乾淨的狀態。
 */

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';

export interface BudgetLimits {
  dailyUsd?: number;
  weeklyUsd?: number;
  monthlyUsd?: number;
  warnAtPercent: number;
}

export interface PeriodUsage {
  period: BudgetPeriod;
  limitUsd: number;
  spentUsd: number;
  /** 已用比例（0–1+）。 */
  ratio: number;
}

export interface BudgetVerdict {
  /** 可以派新工作嗎？ */
  ok: boolean;
  /** 超出上限的週期（ok=false 時非空）。 */
  exceeded: PeriodUsage[];
  /** 越過警戒線但還沒超限的週期。 */
  warning: PeriodUsage[];
  /** 全部有設上限的週期（顯示用）。 */
  all: PeriodUsage[];
}

const LABEL: Record<BudgetPeriod, string> = { daily: '今日', weekly: '本週', monthly: '本月' };

export function periodLabel(p: BudgetPeriod): string {
  return LABEL[p];
}

/** 週期起點（本地時區——人講的「今天」是自己的今天）。週一為一週之始。 */
export function periodStart(period: BudgetPeriod, now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (period === 'daily') return d.getTime();
  if (period === 'weekly') {
    const dow = (d.getDay() + 6) % 7; // 週一 = 0
    d.setDate(d.getDate() - dow);
    return d.getTime();
  }
  d.setDate(1);
  return d.getTime();
}

/** 這個週期的識別字串（用來做「同週期只通知一次」的去重鍵）。 */
export function periodKey(period: BudgetPeriod, now: number): string {
  const d = new Date(periodStart(period, now));
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${period}:${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function limitOf(limits: BudgetLimits, period: BudgetPeriod): number | undefined {
  const v = period === 'daily' ? limits.dailyUsd : period === 'weekly' ? limits.weeklyUsd : limits.monthlyUsd;
  return typeof v === 'number' && v > 0 ? v : undefined;
}

export interface BudgetInput {
  limits: BudgetLimits;
  /** 給定時間點之後的花費（通常是 ledger.costSummary）。 */
  spentSince: (sinceMs: number) => CostSummary;
  now: number;
}

export function evaluateBudget(input: BudgetInput): BudgetVerdict {
  const all: PeriodUsage[] = [];
  const exceeded: PeriodUsage[] = [];
  const warning: PeriodUsage[] = [];
  // 警戒比例夾在 1–99：
  //   設 0  → 還沒開始花就一直警告
  //   設 100 → 100% 時已經算「超限」了，警告永遠不會發，等於沒有警戒線
  // 上界取 99 才能保證「撞牆前一定先喊一聲」。
  const warnAt = Math.min(99, Math.max(1, input.limits.warnAtPercent)) / 100;

  for (const period of ['daily', 'weekly', 'monthly'] as const) {
    const limitUsd = limitOf(input.limits, period);
    if (limitUsd === undefined) continue;
    const spentUsd = input.spentSince(periodStart(period, input.now)).costUsd;
    const usage: PeriodUsage = { period, limitUsd, spentUsd, ratio: spentUsd / limitUsd };
    all.push(usage);
    if (usage.ratio >= 1) exceeded.push(usage);
    else if (usage.ratio >= warnAt) warning.push(usage);
  }

  return { ok: exceeded.length === 0, exceeded, warning, all };
}

/** 給人看的一行摘要。 */
export function describeUsage(u: PeriodUsage): string {
  return `${LABEL[u.period]} $${u.spentUsd.toFixed(2)} / $${u.limitUsd.toFixed(2)}（${Math.round(u.ratio * 100)}%）`;
}
