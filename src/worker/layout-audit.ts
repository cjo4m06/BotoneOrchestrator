// 版面稽核：頁面內量測腳本 + 純判定規則。
//
// 為何獨立成檔：量測函式必須「可序列化進瀏覽器執行」（不能引用模組外的變數，
// 也不能依賴 DOM 型別以外的東西），而判定邏輯必須「不開瀏覽器就能單元測試」。
// 兩者混在 visual.ts 會讓判定規則被瀏覽器生命週期綁死、難以測試。
//
// 注意：tsconfig 的 lib 沒有 "DOM"，所以本檔自行宣告最小 DOM 介面，
// 透過 globalThis 取用 document/window。型別在編譯後會被抹除，不影響序列化。

import type { CheckResult } from '../types.js';

// ── 量測資料結構（page.evaluate 的回傳值，必須是純 JSON） ──

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementMeasure {
  /** 可讀定位字串（含最多兩層祖先 + class + 同層序號）——只給人看，不可拿來當 failingId */
  selector: string;
  /**
   * 穩定鍵：只由「最近的具名祖先（id/data-testid）或語意標籤 + 標籤路徑」組成，
   * 不含 class、不含同層序號，因此 agent 改 class 名或在前面插入元素都不會變。
   * failingId 一律用它（見 idOf）——不穩的簽章會讓無進展偵測永遠不觸發。
   */
  key?: string;
  tag: string;
  rect: Rect;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  /** 前 40 字文字，方便人在報告裡認出是哪一塊 */
  text?: string;
}

export interface OverlapPair {
  a: string;
  b: string;
  /** a / b 的穩定鍵（供 failingId 用） */
  aKey?: string;
  bKey?: string;
  /** 交集面積 / 較小元素面積 */
  ratio: number;
}

export interface ObscuredElement {
  selector: string;
  key?: string;
  /** 蓋住它的元素 */
  by: string;
  /** 取樣點被蓋住的比例 */
  ratio: number;
}

export interface RowMeasure {
  parent: string;
  parentKey?: string;
  selectors: string[];
  /**
   * 「頂端 / 中線 / 底端」三種對齊基準的最小偏差（px）。
   * 三者皆偏大才代表真的沒對齊——只看單一基準會誤殺 align-items:center/baseline。
   */
  skewPx: number;
  /** 相鄰元素水平間距（px），依左緣排序 */
  gaps: number[];
  /** 是否為同質清單（>=3 個同 tag 子元素）——只有這種才適合判間距一致性 */
  uniform: boolean;
}

export interface LayoutMetrics {
  route: string;
  breakpoint: string;
  viewport: { width: number; height: number };
  doc: { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number };
  /** 超出 viewport 左/右緣的元素 */
  overflowX: ElementMeasure[];
  /** 文字被容器裁切（overflow hidden 且內容比容器寬/高） */
  clippedText: ElementMeasure[];
  /** 應該有內容卻量到 0 尺寸 */
  zeroSized: ElementMeasure[];
  /** 非預期的元素重疊 */
  overlaps: OverlapPair[];
  /** 被上層元素遮蔽（z-index 疊錯） */
  obscured: ObscuredElement[];
  /** 同一列的對齊 / 間距量測 */
  rows: RowMeasure[];
  /** 實際取樣元素數（0 代表頁面空白，本身就可疑） */
  sampled: number;
}

export interface CollectInput {
  route: string;
  breakpoint: string;
  /** 取樣上限，避免超大 DOM 讓 O(n²) 重疊比對爆掉 */
  maxElements: number;
  /**
   * 專案級豁免選擇器（projects.yaml visual.ignoreSelectors）。命中的子樹整片不量測。
   *
   * 為何需要：頁面內的 `data-layout-audit="ignore"` 要求改「被驗專案」的原始碼，
   * 但 orchestrator 常常是在別人的 repo 上跑驗證，不該為了讓稽核閉嘴而去改人家的 DOM。
   * 有了這個設定，刻意的橫捲容器／第三方 widget 可以在 orchestrator 這側豁免。
   */
  ignoreSelectors?: string[];
}

/**
 * 量測結果的形狀驗證（邊界防線）。
 *
 * 為何需要：LayoutMetrics 是從瀏覽器頁面內回傳的（page.evaluate），量測腳本一旦在頁面內出錯，
 * 拿回來的可能是 undefined / {} / 半截物件。這種東西直接送進 evaluateLayoutMetrics 會丟例外，
 * 而上游 Verifier 對「視覺關卡拋例外」的處理是降級成 ok:true 的跳過——
 * 等於量測端壞掉時爆版頁面被靜默放行（整個視覺驗證變空殼）。
 * 所以在邊界就擋下來，讓呼叫端能把它變成明確的紅燈而不是無聲的綠燈。
 */
export function isLayoutMetrics(v: unknown): v is LayoutMetrics {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  if (typeof m['route'] !== 'string' || typeof m['breakpoint'] !== 'string') return false;
  if (!hasFiniteFields(m['viewport'], ['width', 'height'])) return false;
  if (!hasFiniteFields(m['doc'], ['scrollWidth', 'clientWidth', 'scrollHeight', 'clientHeight'])) return false;
  for (const k of ['overflowX', 'clippedText', 'zeroSized', 'overlaps', 'obscured', 'rows']) {
    if (!Array.isArray(m[k])) return false;
  }
  return isFinite_(m['sampled']);
}

function isFinite_(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function hasFiniteFields(v: unknown, keys: readonly string[]): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return keys.every((k) => isFinite_(o[k]));
}

// ── 判定門檻 ──

export interface LayoutThresholds {
  /** 文件層級橫向溢出容許值（次像素/捲軸誤差） */
  docOverflowSlackPx: number;
  /** 單一元素超出 viewport 邊緣的容許值 */
  elementOverflowSlackPx: number;
  /** 文字裁切容許值 */
  textClipSlackPx: number;
  /** 重疊面積比上限（超過視為非預期重疊） */
  maxOverlapRatio: number;
  /** 同列對齊偏差上限 */
  maxRowSkewPx: number;
  /** 同質清單間距落差上限（絕對值） */
  maxGapSpreadPx: number;
  /** 同質清單間距落差上限（相對於最大間距的比例）——兩者都超過才算 */
  gapSpreadRelative: number;
  /** 遮蔽比例上限 */
  maxObscuredRatio: number;
  /**
   * 是否讓「對齊 / 間距」計入紅燈。預設 false（只回報，不擋關卡）。
   *
   * 為何預設關閉（D18 誤殺比漏抓更糟）：這兩項判的是「風格」不是「壞掉」——
   * margin-left:auto 推右的導覽列、刻意錯落的卡片牆、非對稱的英雄區都是正常設計，
   * 但在幾何上看起來就是「間距不一致 / 沒對齊」。若它們能擋下 DoD，agent 唯一的
   * 解法就是把設計拉平——等於用自動化去破壞人刻意做的版面。
   */
  strictStyleChecks: boolean;
}

export const DEFAULT_LAYOUT_THRESHOLDS: LayoutThresholds = {
  docOverflowSlackPx: 1,
  elementOverflowSlackPx: 2,
  textClipSlackPx: 2,
  // 0.5 = 「其中一個元素被蓋掉一半以上」才算壞掉。
  // 舊值 0.1 會把堆疊頭像（負 margin 疊 30%）、徽章角標這類刻意重疊全部判紅。
  maxOverlapRatio: 0.5,
  maxRowSkewPx: 8,
  maxGapSpreadPx: 16,
  gapSpreadRelative: 0.5,
  maxObscuredRatio: 0.9,
  strictStyleChecks: false,
};

// ── 純判定：量測結果 → CheckResult[]（不需瀏覽器，可直接單元測試） ──

interface Finding {
  /** 穩定識別（不含會浮動的像素數字），供結果簽章/無進展偵測使用 */
  id: string;
  /** 給人看的說明（可含數字） */
  note: string;
}

/** failingId 一律取穩定鍵；舊格式（沒有 key）才退回可讀字串。 */
function idOf(m: { key?: string; selector: string }): string {
  return m.key && m.key !== '' ? m.key : m.selector;
}

/**
 * 把多頁多斷點的量測結果判定成 DoD 關卡。
 * 設計原則：失敗訊息要能直接回灌給 agent 修（講清楚哪個斷點、哪個元素、差多少）。
 */
export function evaluateLayoutMetrics(
  pages: LayoutMetrics[],
  overrides: Partial<LayoutThresholds> = {},
): CheckResult[] {
  const t = { ...DEFAULT_LAYOUT_THRESHOLDS, ...overrides };
  if (pages.length === 0) {
    return [{ name: 'visual:layout', ok: true, detail: '無量測資料，略過版面判定' }];
  }

  const docOverflow: Finding[] = [];
  const elemOverflow: Finding[] = [];
  const textClip: Finding[] = [];
  const overlap: Finding[] = [];
  const zeroSize: Finding[] = [];
  const alignment: Finding[] = [];
  const spacing: Finding[] = [];
  const obscured: Finding[] = [];
  const empty: Finding[] = [];

  for (const p of pages) {
    const at = `${p.breakpoint}${p.route}`;

    if (p.sampled === 0) {
      empty.push({ id: `${at}::empty`, note: `${at} 沒有量到任何可見元素（頁面可能空白或渲染失敗）` });
    }

    const docOver = p.doc.scrollWidth - p.doc.clientWidth;
    if (docOver > t.docOverflowSlackPx) {
      docOverflow.push({ id: `${at}::document`, note: `${at} 橫向溢出 ${round(docOver)}px（scrollWidth ${p.doc.scrollWidth} > clientWidth ${p.doc.clientWidth}）` });
    }

    for (const e of p.overflowX) {
      const right = e.rect.x + e.rect.width - p.viewport.width;
      const left = -e.rect.x;
      const over = Math.max(right, left);
      if (over <= t.elementOverflowSlackPx) continue;
      const side = right >= left ? '右' : '左';
      elemOverflow.push({ id: `${at}::${idOf(e)}`, note: `${at} ${e.selector} 超出 viewport ${side}緣 ${round(over)}px` });
    }

    for (const e of p.clippedText) {
      const dx = e.scrollWidth - e.clientWidth;
      const dy = e.scrollHeight - e.clientHeight;
      if (Math.max(dx, dy) <= t.textClipSlackPx) continue;
      const dir = dx >= dy ? `橫向 ${round(dx)}px` : `縱向 ${round(dy)}px`;
      textClip.push({ id: `${at}::${idOf(e)}`, note: `${at} ${e.selector} 文字被裁切（${dir}）${e.text ? `：「${e.text}」` : ''}` });
    }

    for (const o of p.overlaps) {
      if (o.ratio <= t.maxOverlapRatio) continue;
      overlap.push({ id: `${at}::${o.aKey ?? o.a}|${o.bKey ?? o.b}`, note: `${at} ${o.a} 與 ${o.b} 重疊 ${pct(o.ratio)}` });
    }

    for (const e of p.zeroSized) {
      zeroSize.push({ id: `${at}::${idOf(e)}`, note: `${at} ${e.selector} 尺寸為 0（${round(e.rect.width)}×${round(e.rect.height)}）但有內容` });
    }

    for (const o of p.obscured) {
      if (o.ratio < t.maxObscuredRatio) continue;
      obscured.push({ id: `${at}::${idOf(o)}`, note: `${at} ${o.selector} 被 ${o.by} 遮蔽 ${pct(o.ratio)}（z-index 疊錯？）` });
    }

    for (const r of p.rows) {
      const rowId = r.parentKey ?? r.parent;
      if (r.skewPx > t.maxRowSkewPx) {
        alignment.push({ id: `${at}::${rowId}`, note: `${at} ${r.parent} 同列元素未對齊，偏差 ${round(r.skewPx)}px（${r.selectors.join(', ')}）` });
      }
      if (!r.uniform || r.gaps.length < 2) continue;
      const max = Math.max(...r.gaps);
      const spread = max - Math.min(...r.gaps);
      // 絕對與相對落差都超標才算——只看絕對值會誤殺「本來就很寬鬆」的版面
      if (spread > t.maxGapSpreadPx && spread > max * t.gapSpreadRelative) {
        spacing.push({ id: `${at}::${rowId}`, note: `${at} ${r.parent} 同質清單間距不一致（${r.gaps.map(round).join(' / ')}px）` });
      }
    }
  }

  // 對齊/間距是風格判斷：預設只回報不判紅（見 LayoutThresholds.strictStyleChecks）
  const style = t.strictStyleChecks ? toCheck : toAdvisory;

  return [
    toCheck('visual:render', empty, '頁面有渲染內容'),
    toCheck('visual:overflow-x', docOverflow, '無橫向溢出'),
    toCheck('visual:element-overflow', elemOverflow, '所有元素都在 viewport 內'),
    toCheck('visual:text-clip', textClip, '無文字被裁切'),
    toCheck('visual:overlap', overlap, '無非預期元素重疊'),
    toCheck('visual:zero-size', zeroSize, '無零尺寸元素'),
    toCheck('visual:obscured', obscured, '無元素被遮蔽'),
    style('visual:alignment', alignment, '同列元素對齊'),
    style('visual:spacing', spacing, '間距一致'),
  ];
}

/** 失敗清單過長時只列前幾筆——回灌給 agent 的訊息要能讀，不是傾倒。 */
const MAX_LISTED = 8;

/**
 * 同一個穩定鍵只留一筆。
 *
 * 為何要去重：穩定鍵刻意拿掉了同層序號，所以一張表格的 30 個 <td> 溢出會壓成同一個鍵。
 * 不去重的話 detail 會出現「39 筆問題」但其實只有一個地方要修，failingIds 也會塞滿重複值。
 */
function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

function toCheck(name: string, raw: Finding[], okDetail: string): CheckResult {
  const findings = dedupe(raw);
  if (findings.length === 0) return { name, ok: true, detail: okDetail };
  const listed = findings.slice(0, MAX_LISTED).map((f) => `- ${f.note}`);
  const more = findings.length > MAX_LISTED ? [`- …另有 ${findings.length - MAX_LISTED} 筆`] : [];
  return {
    name,
    ok: false,
    detail: [`${findings.length} 筆問題：`, ...listed, ...more].join('\n'),
    failingIds: findings.map((f) => f.id),
  };
}

/** 前綴，讓 agent 一眼看出「這條不用為了它改東西」。 */
export const ADVISORY_PREFIX = '（僅供參考，不計入紅燈）';

/**
 * 諮詢式關卡：照樣把問題寫進 detail，但 ok 恆為 true。
 * 不帶 failingIds——ok:true 的 failingIds 對簽章/無進展偵測沒有意義，只會製造噪音。
 */
function toAdvisory(name: string, raw: Finding[], okDetail: string): CheckResult {
  const findings = dedupe(raw);
  if (findings.length === 0) return { name, ok: true, detail: okDetail };
  const listed = findings.slice(0, MAX_LISTED).map((f) => `- ${f.note}`);
  const more = findings.length > MAX_LISTED ? [`- …另有 ${findings.length - MAX_LISTED} 筆`] : [];
  return {
    name,
    ok: true,
    detail: [`${ADVISORY_PREFIX}${findings.length} 筆風格提醒：`, ...listed, ...more].join('\n'),
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

// ── 頁面內量測（由 page.evaluate 執行；本函式不得引用模組外的任何變數） ──

interface DomRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}
interface DomNode {
  nodeType: number;
  textContent: string | null;
}
interface DomCollection<T> {
  length: number;
  item(i: number): T | null;
}
interface DomStyle {
  display: string;
  visibility: string;
  opacity: string;
  position: string;
  overflowX: string;
  overflowY: string;
  flexDirection: string;
  flexWrap: string;
  /** 以下欄位在自製 DOM stub 可能不存在，取用一律經過 str() */
  textOverflow?: string;
  webkitLineClamp?: string;
  transform?: string;
  zIndex?: string;
  getPropertyValue?(prop: string): string;
}
/** Web Animations API：用來判斷截圖當下是否還有東西在動 */
interface DomAnimation {
  playState: string;
  effect: { target?: DomElement | null } | null;
}
interface DomElement extends DomNode {
  tagName: string;
  id: string;
  className: unknown;
  children: DomCollection<DomElement>;
  childNodes: DomCollection<DomNode>;
  parentElement: DomElement | null;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  getBoundingClientRect(): DomRect;
  getAttribute(name: string): string | null;
  closest(sel: string): DomElement | null;
  contains(other: DomElement | null): boolean;
  querySelectorAll(sel: string): DomCollection<DomElement>;
  checkVisibility?(): boolean;
}
interface DomDocument {
  scrollingElement: DomElement | null;
  documentElement: DomElement;
  body: DomElement | null;
  elementFromPoint(x: number, y: number): DomElement | null;
  getAnimations?(): DomAnimation[];
}
interface DomWindow {
  innerWidth: number;
  innerHeight: number;
  getComputedStyle(el: DomElement): DomStyle;
}

/**
 * 在瀏覽器內量測版面。整段會被序列化送進頁面，因此所有 helper 都定義在函式內。
 * 只負責「量」，不負責「判」——門檻交給 evaluateLayoutMetrics，方便離線測試。
 */
export function collectLayoutMetrics(input: CollectInput): LayoutMetrics {
  const doc = (globalThis as unknown as { document: DomDocument }).document;
  const win = globalThis as unknown as DomWindow;

  const EPS = 0.5; // 收集階段只濾掉次像素雜訊，真正門檻由純函式決定
  const REPLACED = ['IMG', 'SVG', 'CANVAS', 'VIDEO', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'IFRAME'];
  const NON_VISUAL = ['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'TEMPLATE', 'OPTION', 'BR', 'NOSCRIPT'];

  const vw = win.innerWidth;
  const vh = win.innerHeight;

  function describe(el: DomElement): string {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const raw = typeof el.className === 'string' ? el.className.trim() : '';
    const cls = raw ? `.${raw.split(/\s+/).slice(0, 2).join('.')}` : '';
    let idx = 0;
    const parent = el.parentElement;
    if (parent) {
      for (let i = 0; i < parent.children.length; i++) {
        if (parent.children.item(i) === el) {
          idx = i;
          break;
        }
      }
    }
    return `${tag}${id}${cls}[${idx}]`;
  }

  function path(el: DomElement): string {
    const parts: string[] = [describe(el)];
    let cur = el.parentElement;
    for (let depth = 0; depth < 2 && cur && cur.tagName !== 'BODY'; depth++) {
      parts.unshift(describe(cur));
      cur = cur.parentElement;
    }
    return parts.join('>');
  }

  /**
   * 穩定鍵：往上找到最近的「具名祖先」（id / data-testid …）或語意標籤當錨點，
   * 再接最多三層標籤名。刻意不含 class、不含同層序號——
   * agent 改個 class 或在前面插一個元素就換簽章的話，無進展偵測永遠不會觸發。
   */
  function stableKey(el: DomElement): string {
    const NAMED = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'name'];
    const LANDMARK = ['MAIN', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'SECTION', 'ARTICLE', 'FORM', 'DIALOG', 'TABLE', 'FIGURE'];
    const chain: string[] = [];
    let anchor = '';
    let cur: DomElement | null = el;
    for (let d = 0; cur && d < 10; d++) {
      const tag = cur.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;
      let ref = cur.id ? `#${cur.id}` : '';
      if (!ref) {
        for (const a of NAMED) {
          const v = cur.getAttribute(a);
          if (v) {
            ref = `@${v}`;
            break;
          }
        }
      }
      if (ref) {
        anchor = ref; // 具名祖先本身不進標籤路徑（它就是錨）
        break;
      }
      chain.unshift(tag);
      if (d > 0 && LANDMARK.indexOf(cur.tagName) >= 0) {
        anchor = tag;
        chain.shift();
        break;
      }
      cur = cur.parentElement;
    }
    const tail = chain.slice(-3).join('>');
    if (anchor) return tail ? `${anchor}>${tail}` : anchor;
    return tail || el.tagName.toLowerCase();
  }

  function ignored(el: DomElement): boolean {
    if (el.closest('[data-layout-audit="ignore"],[aria-hidden="true"],[hidden]') !== null) return true;
    const extra = input.ignoreSelectors ?? [];
    for (const sel of extra) {
      if (!sel) continue;
      try {
        if (el.closest(sel) !== null) return true;
      } catch {
        // 設定寫錯的選擇器不該讓整個量測爆掉（爆掉會被上游降級成「跳過」＝靜默綠燈）
      }
    }
    return false;
  }

  function str(v: string | undefined): string {
    return typeof v === 'string' ? v : '';
  }

  /**
   * 「刻意疊放層」：脫離文件流或自成疊層的元素。
   * modal / backdrop / toast / sticky header / 固定底部 tab bar / 有 transform 位移的裝飾
   * 全都落在這一類，它們與其他東西重疊是設計本身，不是壞掉。
   */
  function intentionalLayer(style: DomStyle): boolean {
    const pos = str(style.position);
    if (pos === 'absolute' || pos === 'fixed' || pos === 'sticky') return true;
    const z = str(style.zIndex);
    if (z !== '' && z !== 'auto' && z !== '0') return true;
    const tf = str(style.transform);
    return tf !== '' && tf !== 'none';
  }

  /** 自己或任一祖先屬於刻意疊放層 → 重疊/遮蔽判定一律跳過。 */
  function inIntentionalLayer(el: DomElement): boolean {
    for (let cur: DomElement | null = el, d = 0; cur && d < 12; d++, cur = cur.parentElement) {
      if (cur.tagName === 'BODY' || cur.tagName === 'HTML') break;
      if (intentionalLayer(win.getComputedStyle(cur))) return true;
    }
    return false;
  }

  /**
   * 元素是否被祖先的 overflow 裁住 → 不會真的畫到 viewport 外面。
   * 橫捲表格、可橫捲的程式碼區塊、carousel 都靠這條豁免：
   * `overflow-x:auto` 的容器裡放超寬內容是標準做法，不是爆版。
   */
  function clippedByAncestor(el: DomElement, style: DomStyle): boolean {
    const pos = str(style.position);
    if (pos === 'fixed') return false; // fixed 以 viewport 為容器，祖先的 overflow 管不到它
    const abs = pos === 'absolute';
    for (let cur: DomElement | null = el.parentElement, d = 0; cur && d < 20; d++, cur = cur.parentElement) {
      const cs = win.getComputedStyle(cur);
      const isRoot = cur.tagName === 'BODY' || cur.tagName === 'HTML';
      // absolute 只被「定位祖先」裁切，static 祖先的 overflow 對它無效
      if (abs && str(cs.position) === 'static' && !isRoot) continue;
      const ox = str(cs.overflowX);
      if (ox !== '' && ox !== 'visible') return true;
      if (cur.tagName === 'HTML') break;
    }
    return false;
  }

  /** 刻意的文字截斷（ellipsis / line-clamp）不是「被裁切」，那是設計。 */
  function deliberateTruncation(style: DomStyle): boolean {
    if (str(style.textOverflow).indexOf('ellipsis') >= 0) return true;
    let clamp = str(style.webkitLineClamp);
    if (!clamp && typeof style.getPropertyValue === 'function') {
      try {
        clamp = str(style.getPropertyValue('-webkit-line-clamp'));
      } catch {
        clamp = '';
      }
    }
    return clamp !== '' && clamp !== 'none';
  }

  function directText(el: DomElement): string {
    let s = '';
    for (let i = 0; i < el.childNodes.length; i++) {
      const n = el.childNodes.item(i);
      if (n && n.nodeType === 3) s += n.textContent ?? '';
    }
    return s.trim();
  }

  function measure(el: DomElement, rect: DomRect): ElementMeasure {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return {
      selector: path(el),
      key: stableKey(el),
      tag: el.tagName.toLowerCase(),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      text: text || undefined,
    };
  }

  const overflowX: ElementMeasure[] = [];
  const clippedText: ElementMeasure[] = [];
  const zeroSized: ElementMeasure[] = [];
  const overlaps: OverlapPair[] = [];
  const obscured: ObscuredElement[] = [];
  const rows: RowMeasure[] = [];

  const all = doc.body ? doc.body.querySelectorAll('*') : { length: 0, item: () => null };
  const limit = Math.min(all.length, input.maxElements);

  // ── 動畫中的元素一律不判 ──
  // 進場動畫（transform/opacity 過場）在跑到一半時，元素本來就會在畫面外、疊在一起。
  // 那是截圖時機的問題不是版面壞掉，判紅只會逼 agent 去拔掉動畫。
  // visual.ts 會先等動畫停（waitForAnimations），這裡是第二層保險：
  // 無限動畫（spinner）永遠等不到停，只能靠這裡排除。
  const moving: DomElement[] = [];
  try {
    const list = typeof doc.getAnimations === 'function' ? doc.getAnimations() : [];
    for (let i = 0; i < list.length && moving.length < 50; i++) {
      const a = list[i];
      if (!a || a.playState !== 'running') continue;
      const target = a.effect ? a.effect.target : null;
      if (target && moving.indexOf(target) < 0) moving.push(target);
    }
  } catch {
    // 不支援 Web Animations API 就當作沒有動畫在跑
  }
  function inMotion(el: DomElement): boolean {
    for (const r of moving) {
      if (r === el || r.contains(el)) return true;
    }
    return false;
  }

  interface Cand {
    el: DomElement;
    rect: DomRect;
    style: DomStyle;
    leaf: boolean;
    /** 動畫進行中：不參與重疊/遮蔽/同列判定 */
    animating: boolean;
    /** 位於刻意疊放層（fixed/absolute/sticky/z-index/transform 之下） */
    layered: boolean;
  }
  const visible: Cand[] = [];
  let sampled = 0;

  for (let i = 0; i < limit; i++) {
    const el = all.item(i);
    if (!el || NON_VISUAL.indexOf(el.tagName) >= 0 || ignored(el)) continue;

    const style = win.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const hasBox = typeof el.checkVisibility === 'function' ? el.checkVisibility() : style.display !== 'none';

    // 零尺寸：瀏覽器認為它該渲染，卻量不到面積。只看「有直屬文字或是替換元素」的，
    // 否則純包裝 div（子元素 absolute 定位）會被大量誤報。
    if (hasBox && (rect.width < EPS || rect.height < EPS)) {
      if (directText(el) !== '' || REPLACED.indexOf(el.tagName) >= 0) {
        if (zeroSized.length < 20) zeroSized.push(measure(el, rect));
      }
      continue;
    }
    if (!hasBox || style.visibility === 'hidden' || !(parseFloat(style.opacity || '1') > 0.01)) continue;

    sampled++;
    const animating = inMotion(el);

    // 溢出：祖先有橫向捲軸/裁切 → 內容根本畫不到 viewport 外，那是刻意的橫捲容器
    if (!animating && (rect.right > vw + EPS || rect.left < -EPS) && !clippedByAncestor(el, style)) {
      if (overflowX.length < 20) overflowX.push(measure(el, rect));
    }

    // 文字裁切：只有真的會裁掉內容的 overflow 值才算（scroll/auto 使用者還能捲），
    // 且排除 ellipsis / line-clamp——那是「刻意截斷並顯示省略號」的標準做法
    const clipsX = style.overflowX === 'hidden' || style.overflowX === 'clip';
    const clipsY = style.overflowY === 'hidden' || style.overflowY === 'clip';
    const hasText = directText(el) !== '';
    if (hasText && !deliberateTruncation(style) && ((clipsX && el.scrollWidth - el.clientWidth > EPS) || (clipsY && el.scrollHeight - el.clientHeight > EPS))) {
      if (clippedText.length < 20) clippedText.push(measure(el, rect));
    }

    visible.push({ el, rect, style, leaf: el.children.length === 0, animating, layered: inIntentionalLayer(el) });
  }

  // ── 重疊：只比對「留在文件流裡、沒在動」的葉節點。 ──
  // 排除 layered 是關鍵：固定底部 tab bar、modal 內容、堆疊裝飾都是刻意疊上去的，
  // 只看元素自身 position 會漏掉「祖先才是 fixed」的情況（tab bar 的 <a> 本身是 static）。
  const leaves = visible.filter((c) => c.leaf && !c.layered && !c.animating && c.rect.width * c.rect.height >= 16).slice(0, 250);
  for (let i = 0; i < leaves.length; i++) {
    const a = leaves[i];
    if (!a) continue;
    for (let j = i + 1; j < leaves.length; j++) {
      const b = leaves[j];
      if (!b) continue;
      const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (w <= 0 || h <= 0) continue;
      const inter = w * h;
      const min = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
      const ratio = min > 0 ? inter / min : 0;
      if (ratio > 0.02) overlaps.push({ a: path(a.el), b: path(b.el), aKey: stableKey(a.el), bKey: stableKey(b.el), ratio });
    }
  }
  overlaps.sort((x, y) => y.ratio - x.ratio);
  overlaps.length = Math.min(overlaps.length, 20);

  // ── 遮蔽：用 elementFromPoint 取樣 5 點，看命中的是不是自己（或自己的親屬） ──
  //
  // 「蓋住別人的是 viewport 級的 chrome 或全螢幕遮罩」一律不算問題：
  // modal 的 backdrop、drawer 的 scrim、sticky header、固定底部 tab bar、cookie 橫幅、toast
  // 都是刻意蓋上去的。真正的 z-index 疊錯是「內容區裡某個小浮層擋住了按鈕」，
  // 那種 coverer 不是 fixed/sticky，也不會鋪滿整個畫面。
  // 注意要往上找祖先：elementFromPoint 命中的常常是浮層裡的子元素
  // （tab bar 的 <a>、backdrop 上的按鈕），它們自己都是 static。
  function intentionalCover(hit: DomElement): boolean {
    for (let cur: DomElement | null = hit, d = 0; cur && d < 12; d++, cur = cur.parentElement) {
      if (cur.tagName === 'BODY' || cur.tagName === 'HTML') break;
      const pos = str(win.getComputedStyle(cur).position);
      if (pos === 'fixed' || pos === 'sticky') return true; // 釘在 viewport 上的 chrome
      if (pos === 'absolute') {
        const r = cur.getBoundingClientRect();
        // 幾乎鋪滿畫面 = 遮罩（modal backdrop / drawer scrim），設計者不可能沒看到
        if ((Math.min(r.width, vw) * Math.min(r.height, vh)) / (vw * vh) >= 0.6) return true;
      }
    }
    return false;
  }

  for (const c of visible) {
    if (!c.leaf && REPLACED.indexOf(c.el.tagName) < 0) continue;
    if (c.animating || c.layered) continue;
    if (c.rect.width * c.rect.height < 64) continue;
    if (directText(c.el) === '' && REPLACED.indexOf(c.el.tagName) < 0) continue;
    const pts: Array<[number, number]> = [
      [c.rect.left + c.rect.width / 2, c.rect.top + c.rect.height / 2],
      [c.rect.left + c.rect.width * 0.25, c.rect.top + c.rect.height * 0.25],
      [c.rect.left + c.rect.width * 0.75, c.rect.top + c.rect.height * 0.25],
      [c.rect.left + c.rect.width * 0.25, c.rect.top + c.rect.height * 0.75],
      [c.rect.left + c.rect.width * 0.75, c.rect.top + c.rect.height * 0.75],
    ];
    let tested = 0;
    let covered = 0;
    let by = '';
    for (const p of pts) {
      const x = p[0];
      const y = p[1];
      if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
      tested++;
      const hit = doc.elementFromPoint(x, y);
      if (!hit || hit === c.el || c.el.contains(hit) || hit.contains(c.el)) continue;
      if (intentionalCover(hit)) continue;
      covered++;
      if (!by) by = path(hit);
    }
    if (tested > 0 && covered > 0) {
      const ratio = covered / tested;
      if (ratio >= 0.5 && obscured.length < 20) obscured.push({ selector: path(c.el), key: stableKey(c.el), by, ratio });
    }
  }

  // ── 同列對齊 / 間距：以「父元素 + 其子元素全部在同一視覺列」為單位 ──
  const byEl = new Map<DomElement, Cand>();
  for (const c of visible) byEl.set(c.el, c);
  for (const c of visible) {
    if (c.animating) continue; // 進場動畫跑到一半的列不算數
    const kids: Cand[] = [];
    for (let i = 0; i < c.el.children.length; i++) {
      const k = c.el.children.item(i);
      if (!k) continue;
      const found = byEl.get(k);
      if (!found) continue;
      // 脫離文件流的子元素不參與列判定；inline 是文字流不是版面列
      if (found.style.position !== 'static' && found.style.position !== 'relative') continue;
      if (found.style.display === 'inline') continue;
      if (found.animating) continue;
      kids.push(found);
    }
    if (kids.length < 2 || kids.length > 12) continue;
    // 父層若混有實體文字節點，子元素間距其實是文字排出來的，判間距沒有意義
    if (directText(c.el) !== '') continue;

    // 不換行的 flex row：定義上就是同一列，不必再看幾何。
    // 這很重要——歪得夠嚴重時子元素根本不再垂直重疊，用幾何判反而會漏掉最該抓的案例。
    const flexRow =
      (c.style.display === 'flex' || c.style.display === 'inline-flex') &&
      (c.style.flexDirection === 'row' || c.style.flexDirection === 'row-reverse') &&
      c.style.flexWrap === 'nowrap';

    if (!flexRow) {
      // 其他版面（grid/inline-block/float…）退回幾何判定：兩兩垂直重疊過半才算同列
      let sameRow = true;
      for (let i = 0; i < kids.length && sameRow; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i];
          const b = kids[j];
          if (!a || !b) continue;
          const ov = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
          if (ov < Math.min(a.rect.height, b.rect.height) * 0.5) {
            sameRow = false;
            break;
          }
        }
      }
      if (!sameRow) continue;
    }

    const tops = kids.map((k) => k.rect.top);
    const bottoms = kids.map((k) => k.rect.bottom);
    const centers = kids.map((k) => k.rect.top + k.rect.height / 2);
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    const skewPx = Math.min(spread(tops), spread(bottoms), spread(centers));

    const sorted = kids.slice().sort((a, b) => a.rect.left - b.rect.left);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (!prev || !cur) continue;
      gaps.push(cur.rect.left - prev.rect.right);
    }
    const firstTag = sorted[0]?.el.tagName;
    const uniform = sorted.length >= 3 && sorted.every((k) => k.el.tagName === firstTag);

    rows.push({ parent: path(c.el), parentKey: stableKey(c.el), selectors: sorted.map((k) => path(k.el)), skewPx, gaps, uniform });
  }
  rows.sort((a, b) => b.skewPx - a.skewPx);
  rows.length = Math.min(rows.length, 40);

  const scroller = doc.scrollingElement ?? doc.documentElement;
  return {
    route: input.route,
    breakpoint: input.breakpoint,
    viewport: { width: vw, height: vh },
    doc: {
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    },
    overflowX,
    clippedText,
    zeroSized,
    overlaps,
    obscured,
    rows,
    sampled,
  };
}
