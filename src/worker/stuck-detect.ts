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
  // **只數次數，不讀內容。**
  //
  // 先前這裡用 `/\[(.*\.md.*)\]/` 從退回理由裡撈規格檔名，再比對「同一份規格被退回兩次」。
  // 那是程式在讀審查者寫的散文然後猜「它在講哪一份規格」——換個寫法（不加方括號、
  // 用英文檔名、根本沒提檔名）就撈不到，而撈不到就靜靜地不觸發。
  //
  // 真正數得準又不必讀內容的是**退回次數**：連續被退回三次還沒過，就代表
  // 這個迴圈自己收斂不了，該交給人。至於「是不是同一件事」——那要讀懂內容才判斷得出來，
  // 是人的事，所以把每一輪的原話原樣附上讓人自己看。
  const rounds = events.filter((e) => e.kind === 'review_rejected' && e.detail);
  if (rounds.length < REJECTIONS_BEFORE_HANDOFF) return undefined;
  return {
    kind: 'review',
    count: rounds.length,
    body: [
      `審查連續退回了 ${rounds.length} 次，這個迴圈自己收斂不了。`,
      '',
      '**如果這幾條要求無法同時成立，需要你決定誰讓步**——',
      'agent 每次滿足其中一邊都會被另一邊退回，再跑幾輪也一樣。',
      '',
      '各輪退回的原話：',
      ...rounds.map((r, i) => `\n── 第 ${i + 1} 次 ──\n${r.detail}`),
    ].join('\n'),
  };
}

/** 連續被退回幾次就交人。三次＝agent 已經試過三種改法還是不過。 */
const REJECTIONS_BEFORE_HANDOFF = 3;

/**
 * 兩道保險合一。回傳第一個命中的；都沒有就 undefined。
 *
 * 順序是刻意的：規格重複退回比 friction 重複更明確（它代表**已經燒掉兩輪以上**），
 * 所以先報它。
 */
export function detectStuck(events: LedgerEvent[]): RepeatedObstacle | undefined {
  return repeatedRejection(events) ?? repeatedFriction(events);
}
