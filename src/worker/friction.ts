import { z } from 'zod';
import type { Logger } from '../observability/logger.js';

/**
 * agent 的「這個系統擋到我了」回報出口。
 *
 * 為什麼需要：今天好幾個真 bug，是從 agent **順口說的話**裡撿到的——
 *   · 「AppModal 被 teleport 到 body 之外，就算補 dark: 也不會生效」→ 才知道是 CSS 作用域問題
 *   · 「這個決策缺乏可查證出處」→ 才發現 reviewer 看不到人的裁決
 *   · 「規格的前提與實測結果不符，實測 5.55:1 已通過門檻」→ 才知道規格本身寫錯
 *
 * 那些都是我**碰巧讀到**的。沒讀到的就消失了。給一個結構化的出口，
 * 這些觀察才留得下來、彙總得起來、看得出趨勢。
 *
 * **這個工具不影響任務結果。** 它不會讓任務通過、也不會讓任務失敗——
 * 純粹是留一筆紀錄。這一點要在工具說明裡講清楚，否則 agent 會拿它當
 * 「我做不完但想交差」的出口（那是 ask_human 與 report_no_change 的職責）。
 */

export const FRICTION_KINDS = [
  'system_limitation', // 系統的限制擋住了我（工具不夠、資訊拿不到、權限不足）
  'spec_problem', // 規格本身有問題（前提錯誤、自相矛盾、缺關鍵資訊）
  'gate_false_positive', // 某個關卡誤判，我的實作其實沒問題
  'gate_missed', // 某個關卡該擋沒擋（我看到了但它沒發現）
  'workflow', // 流程上的建議（順序、重複勞動、可以自動化的地方）
  'other',
] as const;
export type FrictionKind = (typeof FRICTION_KINDS)[number];

export interface FrictionReport {
  kind: FrictionKind;
  /** 一句話說明遇到什麼。 */
  what: string;
  /** 具體證據：檔案、行號、指令輸出、量測數字。沒有證據的抱怨沒有價值。 */
  evidence?: string;
  /** 建議怎麼改（可選——只回報問題也有價值）。 */
  suggestion?: string;
  /** 這件事有沒有實際擋住你？ */
  blocked?: boolean;
}

const Schema = z.object({
  kind: z.enum(FRICTION_KINDS).catch('other'),
  what: z.string().min(1),
  evidence: z.string().optional(),
  suggestion: z.string().optional(),
  blocked: z.boolean().optional(),
});

/** 寫入端只需要能記事件（Ledger 結構上即滿足）。 */
export interface FrictionSink {
  logEvent(scope: 'task', refId: string, kind: string, detail?: string): void;
}

export const FRICTION_EVENT = 'friction_report';

/**
 * 工具說明。刻意寫得長一點——這個工具的價值完全取決於 agent 用不用它、
 * 以及用得對不對，而那由這段文字決定。
 */
export const FRICTION_TOOL_DESCRIPTION =
  '回報你在這個系統裡遇到的阻礙或改進建議。' +
  '**這個工具不影響本任務的結果**——它不會讓任務通過或失敗，只是留一筆紀錄給維護者看。' +
  '所以不要拿它當「做不完但想交差」的出口（那是 ask_human／report_no_change 的職責）。\n\n' +
  '什麼時候該用：\n' +
  '· 你想做某件事但工具或權限不夠（例如查不到某個資訊、某個指令被擋）\n' +
  '· 規格本身有問題（前提與現況不符、自相矛盾、缺關鍵資訊）\n' +
  '· 某個關卡誤判了你的實作，或反過來——你看到問題但關卡沒發現\n' +
  '· 流程上有明顯可改善的地方（重複勞動、順序不合理）\n\n' +
  '**一定要附證據**：檔案與行號、指令輸出、量測數字。沒有證據的抱怨沒有價值，' +
  '維護者無法據以判斷。可以在同一個任務裡回報多次。';

export function createFrictionHandler(sink: FrictionSink, log: Logger, taskId: string, source: string) {
  return async (args: unknown) => {
    const parsed = Schema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: '回報格式不正確，至少要有 what（一句話說明遇到什麼）。' }] };
    }
    const r = parsed.data;
    try {
      sink.logEvent('task', taskId, FRICTION_EVENT, JSON.stringify({ ...r, source, at: Date.now() }));
    } catch (e) {
      // 留不下來只是少一筆觀察，絕不能影響任務
      log.warn({ taskId, err: e instanceof Error ? e.message : String(e) }, '摩擦回報寫入失敗（忽略）');
    }
    log.info(
      { taskId, source, kind: r.kind, blocked: r.blocked === true, what: r.what.slice(0, 160) },
      '📋 agent 回報了系統摩擦',
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: '已記錄，謝謝。這不影響本任務——請繼續你原本在做的事。',
        },
      ],
    };
  };
}

/** 從事件 detail 還原回報內容；解析不出來就當作沒有（不讓壞資料汙染彙總）。 */
export function parseFrictionEvent(detail: string | undefined): (FrictionReport & { source?: string; at?: number }) | undefined {
  if (!detail) return undefined;
  try {
    const j = JSON.parse(detail) as unknown;
    const p = Schema.safeParse(j);
    if (!p.success) return undefined;
    const o = j as { source?: unknown; at?: unknown };
    return {
      ...p.data,
      ...(typeof o.source === 'string' ? { source: o.source } : {}),
      ...(typeof o.at === 'number' ? { at: o.at } : {}),
    };
  } catch {
    return undefined;
  }
}

export interface FrictionSummary {
  total: number;
  blocked: number;
  byKind: Record<string, number>;
  /** 最近幾筆，給人直接讀。 */
  recent: (FrictionReport & { taskId: string; source?: string; at?: number })[];
}

/**
 * 彙總摩擦回報。
 *
 * 刻意只做統計與列出，**不做任何自動處置**：這些是 agent 的自我回報，
 * 可能是對的，也可能只是它不想做某件事。要不要動程式碼，由人看過證據再決定。
 * 讓 agent 自動改調度器是最容易「靜默地弄壞一切」的方向。
 */
export function summarizeFriction(
  rows: { taskId: string; detail?: string }[],
  recentLimit = 20,
): FrictionSummary {
  const parsed = rows
    .map((r) => ({ taskId: r.taskId, rep: parseFrictionEvent(r.detail) }))
    .filter((x): x is { taskId: string; rep: NonNullable<ReturnType<typeof parseFrictionEvent>> } => x.rep !== undefined);

  const byKind: Record<string, number> = {};
  let blocked = 0;
  for (const { rep } of parsed) {
    byKind[rep.kind] = (byKind[rep.kind] ?? 0) + 1;
    if (rep.blocked === true) blocked += 1;
  }
  return {
    total: parsed.length,
    blocked,
    byKind,
    recent: parsed.slice(-recentLimit).reverse().map(({ taskId, rep }) => ({ taskId, ...rep })),
  };
}
