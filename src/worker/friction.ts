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
}

const Schema = z.object({
  kind: z.enum(FRICTION_KINDS).catch('other'),
  what: z.string().min(1),
  evidence: z.string().optional(),
  suggestion: z.string().optional(),
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
/**
 * report_friction 的定位。
 *
 * ── 為什麼要重寫 ──
 *
 * 舊版把它寫成「阻礙**或改進建議**」的管道，名義上是自我成長／流程優化的出口。
 * 正式庫 26 筆實測：`workflow`（流程建議）這個 kind **一筆都沒有**，
 * 100% 被當成「我被擋住了」在用。把它定義成「建議」正是原本設計失準的地方。
 *
 * 更嚴重的是舊版有一個 `blocked` 欄位，問 agent「這件事有沒有實際擋住你」。
 * 我追過消費端：那個值只寫進一行 log 與一個統計 struct，**沒有任何東西讀它來改變行為**。
 * 實跑 zZb5MGTMdQRZ 最後一筆 `blocked=true`——agent 明講「這擋住我了」——系統什麼都沒做。
 * 那不只是誤導，是一條回報成功卻什麼都不會發生的**安慰劑升級管道**：
 * agent 誠實標了 true 之後，就有理由認為「我已經講出去了」，於是不再敲 ask_human。
 * 填得越誠實，越不會求救。所以欄位整個拿掉。
 *
 * 現在它只剩一個定位：**我看到這個系統或產品有問題，你該知道，但它沒擋住我交付。**
 * 真的擋住了 → ask_human（而且同一類回報第二次，程式會自動停下來交人，見 stuck-detect.ts）。
 *
 * ── 判準換軸（2026-08-06）──
 *
 * 舊判準是「我還交得出去嗎」。那條軸把**壞掉的規格**整類推來這裡：規格壞掉時你永遠
 * 交得出某個 diff，只是不知道對不對，於是判準永遠說「回報一筆繼續做」。
 * 正式庫三筆實跑（#956／#893／#1072）都是這樣來的，其中兩筆是照著錯的前提出貨。
 * 現在問的是「**這件事會不會改變我這張卡該做出來的東西**」——會就去 ask_human。
 * 對應的 B 分支寫在 ASK_HUMAN_TOOL_DESCRIPTION，兩邊要一起看。
 */
export const FRICTION_TOOL_DESCRIPTION =
  '**我看到這個系統或產品有問題，你該知道——但它沒有擋住我交付。**\n\n' +
  '這個工具不影響本任務的結果，只是留一筆給維護者。\n\n' +
  '什麼時候用：\n' +
  '· 工具或權限不夠，但你找到了替代路徑（照樣做得完）\n' +
  '· 某個關卡誤判了你的實作，或反過來——你看到問題但關卡沒發現\n' +
  '· 你順手發現了與本任務無關的產品缺陷（不要順手修，改動會擴散到不相干的 PR）\n' +
  '· 規格有問題但不影響你這張卡；或你改對了、只是文件跟著過時（docs 唯讀，你改不到）\n\n' +
  '**真的擋住你的時候不要用這個，用 ask_human。**\n' +
  '判準是「這件事會不會改變我這張卡該做出來的東西」：不會就回報一筆繼續做，' +
  '會就停下來問人——**即使你交得出 diff**。\n' +
  '（同一類障礙你回報第二次時，調度器會自動停下來交人——因為那代表它其實擋住你了。）\n\n' +
  '**一定要附證據**：檔案與行號、指令輸出、量測數字。沒有證據的抱怨維護者無法據以判斷。\n' +
  '可以在同一個任務裡回報多次。';

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
      { taskId, source, kind: r.kind, what: r.what.slice(0, 160) },
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
  /** **未分診的**筆數（那才是「還要你看的」）。 */
  total: number;
  /** 已分診（已解決／不處理／已轉成任務）的筆數。預設不顯示，但要看得到它在減少。 */
  triaged: number;
  byKind: Record<string, number>;
  /**
   * 依 kind 分組。
   *
   * **只用 agent 自己填的 kind 分組，不做文字相似度**——那是猜語意，換個寫法就失效
   * （這一整串拆掉的垃圾設計都是那個形狀）。真正的去重（26 筆其實只有 7 件事）
   * 要交給分診 agent，不是這裡。
   */
  groups: { kind: string; count: number; items: FrictionItem[] }[];
  /** 攤平的清單（相容既有 CLI 輸出）。 */
  recent: FrictionItem[];
}

/** 一筆回報 ＋ 它的事件 id（分診要靠它指名道姓）。 */
export type FrictionItem = FrictionReport & {
  id: number;
  taskId: string;
  source?: string;
  at?: number;
  triaged?: { action: string; note?: string; by?: string };
};

/**
 * 彙總摩擦回報。
 *
 * 刻意只做統計與列出，**不做任何自動處置**：這些是 agent 的自我回報，
 * 可能是對的，也可能只是它不想做某件事。要不要動程式碼，由人看過證據再決定。
 * 讓 agent 自動改調度器是最容易「靜默地弄壞一切」的方向。
 */
export function summarizeFriction(
  rows: { id?: number; taskId: string; detail?: string }[],
  recentLimit = 20,
  /** 已分診的（事件 id → 紀錄）。未提供 ＝ 全部都算未分診（CLI 舊呼叫端）。 */
  triaged?: Map<number, { action: string; note?: string; by?: string }>,
): FrictionSummary {
  const parsed = rows
    .map((r) => ({ id: r.id ?? -1, taskId: r.taskId, rep: parseFrictionEvent(r.detail) }))
    .filter((x): x is { id: number; taskId: string; rep: NonNullable<ReturnType<typeof parseFrictionEvent>> } => x.rep !== undefined);

  // **預設只看未分診的。** 處理過的東西繼續佔版面，清單就永遠不會變短，
  // 而一份不會變短的清單過幾週就沒有人會點開它。
  const open = parsed.filter((x) => !triaged?.has(x.id));
  const toItem = ({ id, taskId, rep }: (typeof parsed)[number]): FrictionItem => {
    const t = triaged?.get(id);
    return { id, taskId, ...rep, ...(t ? { triaged: t } : {}) };
  };

  const byKind: Record<string, number> = {};
  for (const { rep } of open) byKind[rep.kind] = (byKind[rep.kind] ?? 0) + 1;

  const grouped = new Map<string, FrictionItem[]>();
  // **輸入已經是新到舊**（listEvents 是 ORDER BY id DESC）。先前這裡又 reverse 一次，
  // 結果同一類裡排在最前面的是**最舊的那筆**——而舊的多半早就在別處被處理掉了，
  // 人第一眼看到的是已經不重要的東西。
  for (const x of open) {
    grouped.set(x.rep.kind, [...(grouped.get(x.rep.kind) ?? []), toItem(x)]);
  }

  return {
    total: open.length,
    triaged: parsed.length - open.length,
    byKind,
    groups: [...grouped.entries()]
      .map(([kind, items]) => ({ kind, count: items.length, items }))
      .sort((a, b) => b.count - a.count),
    // 同上：輸入是新到舊，要取的是**前** N 筆。
    // 先前是 slice(-N)＝取尾端＝最舊的 N 筆，而欄位名叫 recent、CLI 標題寫著「最近」。
    recent: open.slice(0, recentLimit).map(toItem),
  };
}
