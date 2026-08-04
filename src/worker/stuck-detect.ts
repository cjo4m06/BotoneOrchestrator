import { parseFrictionEvent, FRICTION_EVENT } from './friction.js';
import type { LedgerEvent } from '../store/ledger.js';

/**
 * 「同一個障礙第二次擋住你」——用**數的**，不用判斷語意。
 *
 * ── 為什麼要有程式層的保險 ──
 *
 * 提示詞已經失效過一次。實跑（zZb5MGTMdQRZ，2026-08-04）：DoD 三條在幾何上互斥，
 * 唯一出路是改 spec 而 agent 寫不進去。它用 report_friction 講了三次、
 * 一次都沒用 ask_human——而它**沒有做錯**：friction 的描述說「不影響本任務」，
 * ask_human 的描述說「不可逆或高風險的歧義」，而它遇到的既不是歧義也不高風險。
 * 它同時遵守了兩份說明，然後撞牆四輪、燒掉 36 美元。
 *
 * 所以不能只改措辭。這裡做的是**呼叫端數得出來的事實**：
 * 同一個 kind 回報第二次、同一份規格被退回第二次。兩者都不需要讀懂內容。
 *
 * ── 誤判的代價是不對稱的 ──
 *
 * 誤停一次 ＝ 人按一下重試。漏掉一次 ＝ 上面那 36 美元，外加一條沒滿足的 DoD
 * 被人按核准合併、而「這是刻意的特例」沒有留在任何地方。所以偏向多停。
 */

/** 重複障礙的判定結果。`undefined` ＝ 沒有重複，不必停。 */
export interface RepeatedObstacle {
  /** 重複的那一類（friction 的 kind，或 'spec' 代表同一份規格重複被退回）。 */
  kind: string;
  /** 第幾次（≥2 才會回傳）。 */
  count: number;
  /** 給人看的全文：把每一次的原話依序列出來，程式不摘要、不改寫。 */
  body: string;
}

/**
 * 同一個 friction kind 在這個任務裡出現第二次 → 回傳它。
 *
 * **比對的是 kind 不是內容**：內容每次的措辭都會變（agent 每輪重寫），
 * 而 kind 是一組封閉的列舉，數起來穩定。
 */
export function repeatedFriction(events: LedgerEvent[]): RepeatedObstacle | undefined {
  const byKind = new Map<string, string[]>();
  for (const e of events) {
    if (e.kind !== FRICTION_EVENT) continue;
    const r = parseFrictionEvent(e.detail);
    if (!r) continue;
    const k = r.kind ?? 'other';
    const line = r.evidence ? `${r.what}\n  證據：${r.evidence}` : r.what;
    byKind.set(k, [...(byKind.get(k) ?? []), line]);
  }
  for (const [kind, whats] of byKind) {
    if (whats.length < 2) continue;
    return {
      kind,
      count: whats.length,
      body: [
        `agent 在這個任務裡回報了 ${whats.length} 次同一類障礙（${kind}），但沒有呼叫 ask_human。`,
        '',
        '它每一次的原話：',
        ...whats.map((w, i) => `${i + 1}. ${w}`),
      ].join('\n'),
    };
  }
  return undefined;
}

/**
 * 同一份規格（docRef）在兩次以上的審查退回裡都被點名 → 回傳它。
 *
 * ── 為什麼這個訊號抓得到「需求互斥」──
 *
 * agent 撞到互斥的需求時，**它多半沒意識到那是互斥**：它挑一邊滿足、被另一邊退回、
 * 翻過去、又被第一邊退回。實跑的 zZb5MGTMdQRZ 四輪就是這樣，從頭到尾沒有一次說出
 * 「這三條在幾何上不可能同時成立」。
 *
 * 而那件事在事件表上**看得出來**：
 *   退回 #1  spec/design-system-buttons.md#觸控目標尺寸
 *   退回 #2  issues/2026-07-31-mobile-menu-touch-target-below-44px.md
 *   退回 #3  spec/design-system-buttons.md#觸控目標尺寸   ← 又是它
 * 中間 agent 改過實作，同一條規格還是把它擋下來——那就是「你選的那一邊被另一邊退回」。
 *
 * 只抽 `[...]` 裡的 docRef，不讀退回理由的內容。
 */
export function repeatedRejection(events: LedgerEvent[]): RepeatedObstacle | undefined {
  const rounds: { round: number; refs: string[]; text: string }[] = [];
  for (const e of events) {
    if (e.kind !== 'review_rejected' || !e.detail) continue;
    const refs = [...e.detail.matchAll(/\[([^\]]*?\.md[^\]]*?)\]/g)].map((m) => m[1]!.trim());
    rounds.push({ round: rounds.length + 1, refs: [...new Set(refs)], text: e.detail });
  }
  if (rounds.length < 2) return undefined;

  const seenIn = new Map<string, number[]>();
  for (const r of rounds) for (const ref of r.refs) seenIn.set(ref, [...(seenIn.get(ref) ?? []), r.round]);

  for (const [ref, where] of seenIn) {
    if (where.length < 2) continue;
    return {
      kind: 'spec',
      count: where.length,
      body: [
        `第 ${where.join(' 與第 ')} 輪的審查都因為同一份規格被退回：${ref}`,
        '而 agent 在兩次之間改過實作——這通常代表**幾條要求無法同時成立**，',
        'agent 每次滿足其中一邊，就被另一邊擋下來。',
        '',
        '各輪退回的原話：',
        ...rounds.map((r) => `\n── 第 ${r.round} 次 ──\n${r.text}`),
      ].join('\n'),
    };
  }
  return undefined;
}

/**
 * 兩道保險合一。回傳第一個命中的；都沒有就 undefined。
 *
 * 順序是刻意的：規格重複退回比 friction 重複更明確（它代表**已經燒掉兩輪以上**），
 * 所以先報它。
 */
export function detectStuck(events: LedgerEvent[]): RepeatedObstacle | undefined {
  return repeatedRejection(events) ?? repeatedFriction(events);
}
