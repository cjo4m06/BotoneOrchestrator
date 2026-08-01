// 視覺驗證的單元測試。重點在兩件事：
// 1) 「量測結果 → 判定」的純函式（不需瀏覽器）
// 2) 環境缺件時的優雅降級（playwright/瀏覽器/dev server 缺 → skipped 而非讓 DoD 變紅）

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { deflateSync, crc32 } from 'node:zlib';

import {
  evaluateLayoutMetrics,
  DEFAULT_LAYOUT_THRESHOLDS,
  type LayoutMetrics,
} from '../src/worker/layout-audit.js';
import {
  VisualVerifier,
  VisualEnvironmentError,
  classifyVisualError,
  decodePng,
  diffImages,
  comparePngBuffers,
  defaultStartServer,
  evaluateScreenshotDiffs,
  evaluateScreenshotCoverage,
  evaluateMeasurement,
  evaluateNavigation,
  collectorExpression,
  waitForAnimations,
  ANIMATION_IDLE_EXPRESSION,
  sniffPort,
  baseUrlCandidates,
  slug,
  type BrowserLike,
  type ContextLike,
  type PageLike,
  type PlaywrightLike,
  type ScreenshotDiff,
  type StartServerResult,
  type VisualConfig,
} from '../src/worker/visual.js';
import type { Logger } from '../src/observability/logger.js';

// ── 測試替身 ──

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
} as unknown as Logger;

/** 一份「完全乾淨」的量測結果，各測試只覆寫要驗的欄位。 */
function cleanMetrics(over: Partial<LayoutMetrics> = {}): LayoutMetrics {
  return {
    route: '/sandbox',
    breakpoint: 'mobile',
    viewport: { width: 375, height: 812 },
    doc: { scrollWidth: 375, clientWidth: 375, scrollHeight: 1200, clientHeight: 812 },
    overflowX: [],
    clippedText: [],
    zeroSized: [],
    overlaps: [],
    obscured: [],
    rows: [],
    sampled: 42,
    ...over,
  };
}

function elem(selector: string, over: Record<string, unknown> = {}) {
  return {
    selector,
    tag: 'div',
    rect: { x: 0, y: 0, width: 100, height: 40 },
    scrollWidth: 100,
    clientWidth: 100,
    scrollHeight: 40,
    clientHeight: 40,
    ...over,
  } as LayoutMetrics['overflowX'][number];
}

function checkOf(checks: ReturnType<typeof evaluateLayoutMetrics>, name: string) {
  const c = checks.find((x) => x.name === name);
  assert.ok(c, `找不到 check：${name}`);
  return c;
}

// ── 純判定邏輯 ──

describe('evaluateLayoutMetrics', () => {
  test('乾淨頁面：全部關卡綠燈', () => {
    const checks = evaluateLayoutMetrics([cleanMetrics()]);
    assert.ok(checks.length > 0);
    assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));
  });

  test('沒有量測資料時不判定為失敗', () => {
    const checks = evaluateLayoutMetrics([]);
    assert.ok(checks.every((c) => c.ok));
  });

  test('文件橫向溢出 → visual:overflow-x 紅', () => {
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ doc: { scrollWidth: 520, clientWidth: 375, scrollHeight: 1200, clientHeight: 812 } }),
    ]);
    const c = checkOf(checks, 'visual:overflow-x');
    assert.equal(c.ok, false);
    assert.match(c.detail, /145/);
    assert.deepEqual(c.failingIds, ['mobile/sandbox::document']);
  });

  test('1px 內的次像素溢出視為容許', () => {
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ doc: { scrollWidth: 375.6, clientWidth: 375, scrollHeight: 1200, clientHeight: 812 } }),
    ]);
    assert.equal(checkOf(checks, 'visual:overflow-x').ok, true);
  });

  test('元素超出 viewport 右緣 → visual:element-overflow 紅', () => {
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ overflowX: [elem('div.card[0]', { rect: { x: 300, y: 10, width: 200, height: 50 } })] }),
    ]);
    const c = checkOf(checks, 'visual:element-overflow');
    assert.equal(c.ok, false);
    assert.match(c.detail, /右緣 125px/);
  });

  test('元素超出左緣也會抓到', () => {
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ overflowX: [elem('nav[0]', { rect: { x: -40, y: 0, width: 100, height: 50 } })] }),
    ]);
    assert.match(checkOf(checks, 'visual:element-overflow').detail, /左緣 40px/);
  });

  test('容許值內的溢出不算', () => {
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ overflowX: [elem('div[0]', { rect: { x: 275, y: 0, width: 101, height: 50 } })] }),
    ]);
    assert.equal(checkOf(checks, 'visual:element-overflow').ok, true);
  });

  test('文字被裁切 → visual:text-clip 紅', () => {
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ clippedText: [elem('span.title[0]', { scrollWidth: 260, clientWidth: 100, text: '很長的標題文字' })] }),
    ]);
    const c = checkOf(checks, 'visual:text-clip');
    assert.equal(c.ok, false);
    assert.match(c.detail, /橫向 160px/);
    assert.match(c.detail, /很長的標題文字/);
  });

  test('元素重疊超過比例 → visual:overlap 紅；門檻內則綠', () => {
    const red = evaluateLayoutMetrics([cleanMetrics({ overlaps: [{ a: 'a[0]', b: 'b[1]', ratio: 0.75 }] })]);
    const c = checkOf(red, 'visual:overlap');
    assert.equal(c.ok, false);
    assert.match(c.detail, /75%/);

    const green = evaluateLayoutMetrics([cleanMetrics({ overlaps: [{ a: 'a[0]', b: 'b[1]', ratio: 0.05 }] })]);
    assert.equal(checkOf(green, 'visual:overlap').ok, true);
  });

  test('小面積重疊不判紅——堆疊頭像/角標徽章刻意疊 30% 是設計不是壞掉', () => {
    const checks = evaluateLayoutMetrics([cleanMetrics({ overlaps: [{ a: 'div.av[0]', b: 'div.av[1]', ratio: 0.3 }] })]);
    assert.equal(checkOf(checks, 'visual:overlap').ok, true);
    assert.equal(DEFAULT_LAYOUT_THRESHOLDS.maxOverlapRatio, 0.5);
  });

  test('零尺寸元素 → visual:zero-size 紅', () => {
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ zeroSized: [elem('img.logo[0]', { rect: { x: 0, y: 0, width: 0, height: 0 } })] }),
    ]);
    const c = checkOf(checks, 'visual:zero-size');
    assert.equal(c.ok, false);
    assert.deepEqual(c.failingIds, ['mobile/sandbox::img.logo[0]']);
  });

  test('同列基線不齊 → visual:alignment 紅', () => {
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ rows: [{ parent: 'div.row[0]', selectors: ['a[0]', 'b[1]'], skewPx: 23, gaps: [], uniform: false }] }),
    ]);
    const c = checkOf(checks, 'visual:alignment');
    // 預設是諮詢式：照樣寫進 detail，但不判紅（見 LayoutThresholds.strictStyleChecks）
    assert.equal(c.ok, true);
    assert.match(c.detail, /僅供參考/);
    assert.match(c.detail, /偏差 23px/);
    assert.equal(c.failingIds, undefined);

    const strict = evaluateLayoutMetrics(
      [cleanMetrics({ rows: [{ parent: 'div.row[0]', selectors: ['a[0]', 'b[1]'], skewPx: 23, gaps: [], uniform: false }] })],
      { strictStyleChecks: true },
    );
    assert.equal(checkOf(strict, 'visual:alignment').ok, false);
  });

  test('三種對齊基準取最小值：align-items:center 的列不誤報', () => {
    // 頂端/底端差很多但中線對齊 → collectLayoutMetrics 算出的 skewPx 會是 0
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ rows: [{ parent: 'div.row[0]', selectors: ['a[0]', 'b[1]'], skewPx: 0, gaps: [], uniform: false }] }),
    ]);
    assert.equal(checkOf(checks, 'visual:alignment').ok, true);
  });

  test('同質清單間距不一致 → visual:spacing 紅', () => {
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ rows: [{ parent: 'ul.nav[0]', selectors: ['li[0]', 'li[1]', 'li[2]'], skewPx: 0, gaps: [8, 90], uniform: true }] }),
    ]);
    const c = checkOf(checks, 'visual:spacing');
    assert.equal(c.ok, true); // 諮詢式：導覽列用 margin-left:auto 推右也長這樣，不能拿來擋 DoD
    assert.match(c.detail, /僅供參考/);
    assert.match(c.detail, /8 \/ 90/);

    const strict = evaluateLayoutMetrics(
      [cleanMetrics({ rows: [{ parent: 'ul.nav[0]', selectors: ['li[0]', 'li[1]', 'li[2]'], skewPx: 0, gaps: [8, 90], uniform: true }] })],
      { strictStyleChecks: true },
    );
    assert.equal(checkOf(strict, 'visual:spacing').ok, false);
  });

  test('非同質清單不判間距（避免誤殺 logo + 選單這種版面）', () => {
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ rows: [{ parent: 'header[0]', selectors: ['img[0]', 'nav[1]'], skewPx: 0, gaps: [8, 200], uniform: false }] }),
    ]);
    assert.equal(checkOf(checks, 'visual:spacing').ok, true);
  });

  test('間距落差需同時超過絕對值與相對比例', () => {
    // spread=20 > 16，但相對於 maxGap 120 只有 16.7% < 50% → 視為刻意的寬鬆版面
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ rows: [{ parent: 'ul[0]', selectors: ['li[0]', 'li[1]', 'li[2]'], skewPx: 0, gaps: [100, 120], uniform: true }] }),
    ]);
    assert.equal(checkOf(checks, 'visual:spacing').ok, true);
  });

  test('z-index 疊錯造成遮蔽 → visual:obscured 紅', () => {
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ obscured: [{ selector: 'button.submit[0]', by: 'div.overlay[3]', ratio: 1 }] }),
    ]);
    const c = checkOf(checks, 'visual:obscured');
    assert.equal(c.ok, false);
    assert.match(c.detail, /div.overlay\[3\]/);
  });

  test('部分遮蔽（低於門檻）不算——下拉選單蓋住背景是正常的', () => {
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ obscured: [{ selector: 'p[0]', by: 'div.menu[1]', ratio: 0.6 }] }),
    ]);
    assert.equal(checkOf(checks, 'visual:obscured').ok, true);
  });

  test('頁面完全沒渲染 → visual:render 紅', () => {
    const checks = evaluateLayoutMetrics([cleanMetrics({ sampled: 0 })]);
    assert.equal(checkOf(checks, 'visual:render').ok, false);
  });

  test('門檻可覆寫', () => {
    const m = cleanMetrics({ rows: [{ parent: 'div[0]', selectors: ['a[0]'], skewPx: 23, gaps: [], uniform: false }] });
    assert.equal(checkOf(evaluateLayoutMetrics([m], { maxRowSkewPx: 50 }), 'visual:alignment').ok, true);
    assert.equal(DEFAULT_LAYOUT_THRESHOLDS.maxRowSkewPx, 8);
  });

  test('多斷點的問題會分別標註且 failingId 不含浮動數字', () => {
    const checks = evaluateLayoutMetrics([
      cleanMetrics({ breakpoint: 'mobile', doc: { scrollWidth: 500, clientWidth: 375, scrollHeight: 1, clientHeight: 1 } }),
      cleanMetrics({ breakpoint: 'desktop', viewport: { width: 1440, height: 900 }, doc: { scrollWidth: 1600, clientWidth: 1440, scrollHeight: 1, clientHeight: 1 } }),
    ]);
    const c = checkOf(checks, 'visual:overflow-x');
    assert.deepEqual(c.failingIds, ['mobile/sandbox::document', 'desktop/sandbox::document']);
  });
});

// ── 截圖/回歸判定 ──

describe('截圖與視覺回歸判定', () => {
  test('未設 baseline → 回歸關卡略過但為綠', () => {
    const c = evaluateScreenshotDiffs([], 0.02);
    assert.equal(c.ok, true);
    assert.match(c.detail, /略過視覺回歸/);
  });

  test('差異超過門檻 → 紅', () => {
    const diffs: ScreenshotDiff[] = [
      { route: '/', breakpoint: 'mobile', actualPath: 'a.png', status: 'diff', diffRatio: 0.31 },
      { route: '/', breakpoint: 'desktop', actualPath: 'b.png', status: 'diff', diffRatio: 0.001 },
    ];
    const c = evaluateScreenshotDiffs(diffs, 0.02);
    assert.equal(c.ok, false);
    assert.deepEqual(c.failingIds, ['mobile/']);
  });

  test('新建基準與無法比對不算失敗', () => {
    const diffs: ScreenshotDiff[] = [
      { route: '/', breakpoint: 'mobile', actualPath: 'a.png', status: 'new-baseline', diffRatio: 0 },
      { route: '/', breakpoint: 'tablet', actualPath: 'b.png', status: 'incomparable', diffRatio: 0, detail: '不支援的 PNG' },
    ];
    const c = evaluateScreenshotDiffs(diffs, 0.02);
    assert.equal(c.ok, true);
    assert.match(c.detail, /新建基準/);
  });

  test('截圖張數不足 → 紅', () => {
    assert.equal(evaluateScreenshotCoverage(3, 3).ok, true);
    assert.equal(evaluateScreenshotCoverage(2, 3).ok, false);
    assert.equal(evaluateScreenshotCoverage(0, 0).ok, false);
  });

  test('導覽失敗會列出斷點與路徑', () => {
    const c = evaluateNavigation(['mobile/sandbox：timeout'], 3);
    assert.equal(c.ok, false);
    assert.deepEqual(c.failingIds, ['mobile/sandbox']);
  });
});

// ── PNG 解碼與像素比對 ──

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

/** 產生 RGBA、filter=0 的最小 PNG（測試用，不進 src）。 */
function encodePng(width: number, height: number, rgba: Uint8Array, filter = 0): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const v = rgba[y * stride + x] ?? 0;
      // filter=2 (Up)：存的是與上一列的差值
      raw[y * (stride + 1) + 1 + x] = filter === 2 && y > 0 ? (v - (rgba[(y - 1) * stride + x] ?? 0)) & 0xff : v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 6; // colorType RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function solid(w: number, h: number, r: number, g: number, b: number): Uint8Array {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  return d;
}

describe('PNG 解碼與像素差異', () => {
  test('filter=0 解碼還原原始像素', () => {
    const px = solid(3, 2, 10, 20, 30);
    const img = decodePng(encodePng(3, 2, px));
    assert.equal(img.width, 3);
    assert.equal(img.height, 2);
    assert.equal(img.channels, 4);
    assert.deepEqual([...img.data], [...px]);
  });

  test('filter=2 (Up) 解碼正確', () => {
    const px = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < px.length; i++) px[i] = (i * 7) & 0xff;
    const img = decodePng(encodePng(2, 2, px, 2));
    assert.deepEqual([...img.data], [...px]);
  });

  test('相同圖片差異為 0，不同顏色為 100%', () => {
    const a = decodePng(encodePng(4, 4, solid(4, 4, 0, 0, 0)));
    const b = decodePng(encodePng(4, 4, solid(4, 4, 0, 0, 0)));
    assert.equal(diffImages(a, b).diffRatio, 0);

    const c = decodePng(encodePng(4, 4, solid(4, 4, 255, 255, 255)));
    assert.equal(diffImages(a, c).diffRatio, 1);
  });

  test('通道差在容許值內不算差異', () => {
    const a = decodePng(encodePng(2, 2, solid(2, 2, 100, 100, 100)));
    const b = decodePng(encodePng(2, 2, solid(2, 2, 104, 100, 100)));
    assert.equal(diffImages(a, b, 8).diffRatio, 0);
    assert.equal(diffImages(a, b, 2).diffRatio, 1);
  });

  test('尺寸不同 → 直接視為 100% 差異並說明', () => {
    const a = decodePng(encodePng(2, 2, solid(2, 2, 0, 0, 0)));
    const b = decodePng(encodePng(4, 2, solid(4, 2, 0, 0, 0)));
    const r = diffImages(a, b);
    assert.equal(r.diffRatio, 1);
    assert.match(r.detail ?? '', /尺寸不同/);
  });

  test('comparePngBuffers 直接吃 Buffer', () => {
    const one = encodePng(2, 2, solid(2, 2, 1, 2, 3));
    assert.equal(comparePngBuffers(one, one).diffRatio, 0);
  });

  test('非 PNG 會丟錯（由呼叫端降級成無法比對）', () => {
    assert.throws(() => decodePng(Buffer.from('not a png at all')), /不是 PNG/);
  });
});

// ── PNG 解碼器的完整覆蓋 ──
//
// 為何要測到這麼細：這是自寫的解碼器，解錯不會噴錯，只會安靜地算出錯誤的 diffRatio——
// 視覺回歸關卡就此失去意義（該擋的沒擋、不該擋的亂擋）。真實瀏覽器截圖每一列會挑不同的
// filter、IDAT 也常被切成多塊，所以這些路徑都得逐一驗過，不能只測 filter 0。

interface RawImage {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

function paethRef(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 依 PNG 規格逐列套用 filter 後編碼（測試用的參考實作）。
 * 用「規格的編碼端」去驗「我們的解碼端」，兩邊獨立才有意義。
 */
function encodePngFull(
  img: RawImage,
  opts: { filters?: number[]; colorType?: number; idatChunks?: number; bitDepth?: number; interlace?: number; extraChunks?: Array<[string, Buffer]> } = {},
): Buffer {
  const { width, height, channels, data } = img;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const f = opts.filters?.[y % (opts.filters.length || 1)] ?? 0;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const cur = data[y * stride + x] ?? 0;
      const a = x >= channels ? (data[y * stride + x - channels] ?? 0) : 0;
      const b = y > 0 ? (data[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= channels && y > 0 ? (data[(y - 1) * stride + x - channels] ?? 0) : 0;
      let v: number;
      switch (f) {
        case 0: v = cur; break;
        case 1: v = cur - a; break;
        case 2: v = cur - b; break;
        case 3: v = cur - ((a + b) >> 1); break;
        case 4: v = cur - paethRef(a, b, c); break;
        default: v = cur; break; // 用來製造「未知 filter」的壞檔
      }
      raw[y * (stride + 1) + 1 + x] = v & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = opts.bitDepth ?? 8;
  ihdr[9] = opts.colorType ?? (channels === 1 ? 0 : channels === 2 ? 4 : channels === 3 ? 2 : 6);
  ihdr[12] = opts.interlace ?? 0;

  const compressed = deflateSync(raw);
  const parts = Math.max(1, opts.idatChunks ?? 1);
  const size = Math.ceil(compressed.length / parts);
  const idats: Buffer[] = [];
  for (let i = 0; i < compressed.length; i += size) idats.push(pngChunk('IDAT', compressed.subarray(i, i + size)));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...(opts.extraChunks ?? []).map(([t, d]) => pngChunk(t, d)),
    ...idats,
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 可重現的偽隨機像素——固定 seed，失敗時才能重跑。 */
function noise(w: number, h: number, channels: number, seed = 1): RawImage {
  const data = new Uint8Array(w * h * channels);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (s >> 16) & 0xff;
  }
  return { width: w, height: h, channels, data };
}

describe('PNG 解碼器：真實截圖會走到的每條路徑', () => {
  test('五種 filter 逐列混用都能完整還原', () => {
    const img = noise(6, 5, 4, 7);
    const decoded = decodePng(encodePngFull(img, { filters: [0, 1, 2, 3, 4] }));
    assert.equal(decoded.channels, 4);
    assert.deepEqual([...decoded.data], [...img.data]);
  });

  test('每種 filter 單獨使用也正確（逐一驗，避免互相掩蓋）', () => {
    for (const f of [0, 1, 2, 3, 4]) {
      const img = noise(4, 4, 3, f + 1);
      const decoded = decodePng(encodePngFull(img, { filters: [f] }));
      assert.deepEqual([...decoded.data], [...img.data], `filter ${f} 還原錯誤`);
    }
  });

  test('灰階（colorType 0）與 RGB（colorType 2）都能解，channels 判定正確', () => {
    const gray = noise(5, 3, 1, 3);
    const g = decodePng(encodePngFull(gray, { filters: [1, 4] }));
    assert.equal(g.channels, 1);
    assert.deepEqual([...g.data], [...gray.data]);

    const rgb = noise(5, 3, 3, 4);
    const r = decodePng(encodePngFull(rgb, { filters: [3] }));
    assert.equal(r.channels, 3);
    assert.deepEqual([...r.data], [...rgb.data]);

    const ga = noise(4, 2, 2, 5);
    const a = decodePng(encodePngFull(ga, { filters: [2] }));
    assert.equal(a.channels, 2);
    assert.deepEqual([...a.data], [...ga.data]);
  });

  test('IDAT 被切成多塊（瀏覽器截圖的常態）仍能解', () => {
    const img = noise(16, 16, 4, 9);
    const one = decodePng(encodePngFull(img, { filters: [0, 1, 2, 3, 4], idatChunks: 1 }));
    const many = decodePng(encodePngFull(img, { filters: [0, 1, 2, 3, 4], idatChunks: 7 }));
    assert.deepEqual([...many.data], [...img.data]);
    assert.deepEqual([...many.data], [...one.data]);
  });

  test('IHDR 之後的輔助 chunk（pHYs/tEXt）會被跳過而不是解錯', () => {
    const img = noise(4, 4, 4, 11);
    const buf = encodePngFull(img, {
      filters: [4],
      extraChunks: [['pHYs', Buffer.alloc(9)], ['tEXt', Buffer.from('Software\0test', 'latin1')]],
    });
    assert.deepEqual([...decodePng(buf).data], [...img.data]);
  });

  test('不支援的變體一律丟錯（讓呼叫端降級成 incomparable，而不是算出錯的差異）', () => {
    const img = noise(4, 4, 4, 13);
    assert.throws(() => decodePng(encodePngFull(img, { bitDepth: 16 })), /bitDepth/);
    assert.throws(() => decodePng(encodePngFull(img, { interlace: 1 })), /交錯/);
    assert.throws(() => decodePng(encodePngFull(img, { colorType: 3 })), /colorType/);
    assert.throws(() => decodePng(encodePngFull(img, { filters: [9] })), /filter/);
  });

  test('像素資料被截斷 → 丟錯而非讀出垃圾', () => {
    const img = noise(8, 8, 4, 17);
    const full = encodePngFull(img);
    // 把 IHDR 的高度灌大，IDAT 資料就不夠了
    const broken = Buffer.from(full);
    broken.writeUInt32BE(64, 8 + 8 + 4);
    assert.throws(() => decodePng(broken), /長度不足/);
  });

  test('尺寸為 0 的 PNG 被視為無效', () => {
    const img = noise(4, 4, 4, 19);
    const buf = Buffer.from(encodePngFull(img));
    buf.writeUInt32BE(0, 8 + 8); // IHDR width = 0
    assert.throws(() => decodePng(buf), /尺寸無效/);
  });

  test('同一張圖不同 filter 編碼 → 解出來的像素一致 → 差異為 0（回歸比對不會被編碼方式左右）', () => {
    const img = noise(12, 9, 4, 23);
    const a = encodePngFull(img, { filters: [0] });
    const b = encodePngFull(img, { filters: [4, 3, 2, 1], idatChunks: 3 });
    assert.equal(comparePngBuffers(a, b).diffRatio, 0);
  });

  test('只有一個像素不同 → diffRatio 正確反映（不是四捨五入成 0）', () => {
    const img = noise(10, 10, 4, 29);
    const changed: RawImage = { ...img, data: Uint8Array.from(img.data) };
    changed.data[0] = ((img.data[0] ?? 0) + 128) & 0xff;
    const cmp = comparePngBuffers(encodePngFull(img, { filters: [1] }), encodePngFull(changed, { filters: [4] }));
    assert.equal(cmp.diffPixels, 1);
    assert.equal(cmp.totalPixels, 100);
    assert.equal(cmp.diffRatio, 0.01);
  });

  test('基準是 RGB、實際是 RGBA 時只比共同通道（不會整張誤判為差異）', () => {
    const rgb = noise(6, 6, 3, 31);
    const rgba: RawImage = { width: 6, height: 6, channels: 4, data: new Uint8Array(6 * 6 * 4) };
    for (let i = 0; i < 36; i++) {
      for (let k = 0; k < 3; k++) rgba.data[i * 4 + k] = rgb.data[i * 3 + k] ?? 0;
      rgba.data[i * 4 + 3] = 255;
    }
    assert.equal(comparePngBuffers(encodePngFull(rgb, { filters: [2] }), encodePngFull(rgba, { filters: [4] })).diffRatio, 0);
  });
});

// ── 小工具 ──

describe('工具函式', () => {
  test('sniffPort 從 dev server 輸出抓埠號（含 ANSI）', () => {
    assert.equal(sniffPort('  \x1b[32m➜\x1b[0m  Local:   http://localhost:5173/'), 5173);
    assert.equal(sniffPort('ready on http://127.0.0.1:3000'), 3000);
    assert.equal(sniffPort('starting…'), undefined);
  });

  test('slug 把路徑轉成檔名', () => {
    assert.equal(slug('/'), 'root');
    assert.equal(slug('/sandbox'), 'sandbox');
    assert.equal(slug('/a/b?c=1'), 'a_b_c_1');
  });

  test('collectorExpression 產生語法合法、內嵌參數、含 __name 墊片的運算式', () => {
    const src = collectorExpression({ route: '/sandbox', breakpoint: 'mobile', maxElements: 900 });
    // 轉譯器插入的 __name helper 在頁面內不存在，必須自備墊片
    assert.match(src, /const __name = \(f\) => f;/);
    // Playwright 收到字串時不會傳 arg，參數得內嵌
    assert.match(src, /"route":"\/sandbox"/);
    assert.match(src, /"maxElements":900/);
    // 語法檢查（只編譯不執行——執行需要真的 DOM）
    assert.doesNotThrow(() => new Function(`return ${src};`));
  });
});

// ── 優雅降級 ──

function fakePlaywright(onScreenshot: (path: string) => void, metrics: LayoutMetrics): PlaywrightLike {
  const page: PageLike = {
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async <R,>() => metrics as unknown as R,
    screenshot: async (opts) => {
      if (opts.path) onScreenshot(opts.path);
      return Buffer.alloc(0);
    },
  };
  const ctx: ContextLike = { newPage: async () => page, close: async () => undefined };
  const browser: BrowserLike = { newContext: async () => ctx, close: async () => undefined };
  return { chromium: { launch: async () => browser } };
}

describe('VisualVerifier 降級行為', () => {
  const baseConfig: VisualConfig = { devServer: 'npm run dev', devPort: 5173, routes: ['/sandbox'] };

  test('專案未設定 devServer → skipped，且不碰 playwright', async () => {
    let loaded = false;
    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => { loaded = true; return undefined; },
      startServer: async () => { throw new Error('不該啟動 server'); },
    });
    const r = await v.verify({ cwd: '/nowhere', config: {} });
    assert.equal(r.status, 'skipped');
    assert.match(r.skipReason ?? '', /devServer/);
    assert.equal(loaded, false);
    assert.deepEqual(r.checks.map((c) => c.ok), [true]);
  });

  test('playwright 未安裝 → skipped 且 check 為綠（不拖垮 DoD）', async () => {
    let serverStarted = false;
    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => undefined,
      startServer: async () => { serverStarted = true; return { ok: false, reason: 'x' }; },
    });
    const r = await v.verify({ cwd: '/nowhere', config: baseConfig });
    assert.equal(r.status, 'skipped');
    assert.match(r.skipReason ?? '', /playwright 未安裝/);
    // 瀏覽器不可用時不該白啟一個 dev server
    assert.equal(serverStarted, false);
    assert.equal(r.checks.length, 1);
    assert.equal(r.checks[0]?.ok, true);
    assert.deepEqual(r.screenshots, []);
  });

  test('瀏覽器未下載（launch 丟錯）→ skipped', async () => {
    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => ({
        chromium: { launch: async () => { throw new Error("Executable doesn't exist at /ms-playwright/chromium"); } },
      }),
      startServer: async () => { throw new Error('不該啟動 server'); },
    });
    const r = await v.verify({ cwd: '/nowhere', config: baseConfig });
    assert.equal(r.status, 'skipped');
    assert.match(r.skipReason ?? '', /瀏覽器無法啟動/);
    assert.equal(r.checks[0]?.ok, true);
  });

  test('內建 chromium 沒下載時退回系統 Chrome', async () => {
    const tried: Array<string | undefined> = [];
    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => ({
        chromium: {
          launch: async (o) => {
            tried.push(o?.channel);
            if (!o?.channel) throw new Error("Executable doesn't exist");
            return { newContext: async () => { throw new Error('停在這就好'); }, close: async () => undefined };
          },
        },
      }),
      startServer: async () => ({ ok: false, reason: '測試到此為止' }),
    });
    const r = await v.verify({ cwd: '/nowhere', config: baseConfig });
    assert.deepEqual(tried, [undefined, 'chrome']);
    // 這個測試只在乎「有沒有退回系統 Chrome」。瀏覽器成功後才會去啟 server，
    // 所以流程會走到「server 連不上」——那現在是紅燈而不是跳過（見下面的測試）。
    assert.equal(r.status, 'failed');
    assert.match(r.checks.find((c) => c.name === 'visual:server')?.detail ?? '', /測試到此為止/);
  });

  test('指定 browserChannel 時只試那一個', async () => {
    const tried: Array<string | undefined> = [];
    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => ({
        chromium: { launch: async (o) => { tried.push(o?.channel); throw new Error('no'); } },
      }),
      startServer: async () => ({ ok: false, reason: 'x' }),
    });
    const r = await v.verify({ cwd: '/nowhere', config: { ...baseConfig, browserChannel: 'msedge' } });
    assert.deepEqual(tried, ['msedge']);
    assert.equal(r.status, 'skipped');
  });

  /**
   * 從 skipped 改成 failed。
   *
   * 「沒裝 playwright」「沒設 devServer」是環境缺件，跳過並放行是對的——那個專案
   * 本來就不做視覺驗證。但「dev server 起了、我們卻連不上」是**我們自己的故障**，
   * 而它會讓一個真的需要視覺驗證的任務靜默通過。
   * 實跑撞到兩次（併行撞埠、Vite 只綁 IPv6），兩次的 DoD 都顯示 visual:ok，
   * 其實一張圖都沒看過。
   */
  test('dev server 連不上 → **判紅**，且瀏覽器有被關掉', async () => {
    let closed = false;
    const browser: BrowserLike = {
      newContext: async () => { throw new Error('不該開 context'); },
      close: async () => { closed = true; },
    };
    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => ({ chromium: { launch: async () => browser } }),
      startServer: async (): Promise<StartServerResult> => ({ ok: false, reason: '等待 60000ms 仍未就緒' }),
    });
    const r = await v.verify({ cwd: '/nowhere', config: baseConfig });
    assert.equal(r.status, 'failed', '連不上不能算跳過，那會靜默放行');
    const check = r.checks.find((c) => c.name === 'visual:server');
    assert.equal(check?.ok, false);
    assert.match(check?.detail ?? '', /等待 60000ms 仍未就緒/, '要帶上原始原因，人才查得動');
    assert.match(check?.detail ?? '', /不是程式碼的問題/, '要講明這是環境問題，免得 agent 白改程式');
    assert.equal(closed, true);
  });

  test('happy path：多斷點截圖、建立基準、資源都收乾淨', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'visual-'));
    const shots: string[] = [];
    let stopped = false;
    let browserClosed = false;

    const pw = fakePlaywright((p) => {
      shots.push(p);
      writeFileSync(p, encodePng(2, 2, solid(2, 2, 9, 9, 9)));
    }, cleanMetrics());
    const browser = await pw.chromium.launch();
    const wrapped: PlaywrightLike = {
      chromium: {
        launch: async () => ({
          newContext: (o) => browser.newContext(o),
          close: async () => { browserClosed = true; },
        }),
      },
    };

    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => wrapped,
      startServer: async () => ({
        ok: true,
        handle: { baseUrl: 'http://127.0.0.1:5173', stop: async () => { stopped = true; } },
      }),
    });

    const r = await v.verify({
      cwd,
      config: { ...baseConfig, screenshotDir: 'shots', baselineDir: 'baseline' },
    });

    assert.equal(r.status, 'ok');
    assert.equal(r.screenshots.length, 3); // 375 / 768 / 1440
    assert.ok(r.screenshots.every((p) => existsSync(p)));
    assert.ok(existsSync(join(cwd, 'shots', 'layout-metrics.json')));
    assert.equal(r.diffs.length, 3);
    assert.ok(r.diffs.every((d) => d.status === 'new-baseline'));
    assert.ok(existsSync(join(cwd, 'baseline', 'mobile-sandbox.png')));
    assert.ok(r.checks.every((c) => c.ok), JSON.stringify(r.checks.filter((c) => !c.ok)));
    assert.equal(stopped, true);
    assert.equal(browserClosed, true);
    assert.deepEqual(shots.length, 3);
  });

  test('絕對路徑的截圖/基準目錄（Verifier 給的 worktree 外位置）不會在 worktree 留檔', async () => {
    // 截圖若落在 worktree 內會被算進 git diff，污染 PR 也讓「diff 非空」的 DoD 判定失真
    const cwd = mkdtempSync(join(tmpdir(), 'visual-wt-'));
    const outside = mkdtempSync(join(tmpdir(), 'visual-out-'));
    const pw = fakePlaywright((p) => writeFileSync(p, encodePng(2, 2, solid(2, 2, 5, 5, 5))), cleanMetrics());

    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => pw,
      startServer: async () => ({ ok: true, handle: { baseUrl: 'http://127.0.0.1:5173', stop: async () => undefined } }),
    });
    const r = await v.verify({
      cwd,
      config: { ...baseConfig, screenshotDir: join(outside, 'shots'), baselineDir: join(outside, 'baseline') },
    });

    assert.equal(r.status, 'ok');
    assert.ok(r.screenshots.every((p) => p.startsWith(join(outside, 'shots'))), r.screenshots.join(','));
    assert.ok(existsSync(join(outside, 'baseline', 'mobile-sandbox.png')));
    assert.equal(readdirSync(cwd).length, 0, 'worktree 內不該留下任何檔案');
  });

  /**
   * 版面門檻已經**降級成線索**：溢出幾 px 這種數字回答不了「這畫面好不好看、好不好讀」，
   * 也會把刻意的錯位設計誤判成破版。所以它不再決定紅綠——它的工作是指出可疑之處，
   * 交給看得到畫面的判斷者。紅綠由 Verifier 那層的 visual:judge 決定。
   */
  test('頁面真的爆版 → 進 hints（線索），不再自己判紅', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'visual-'));
    const broken = cleanMetrics({ doc: { scrollWidth: 900, clientWidth: 375, scrollHeight: 1, clientHeight: 1 } });
    const pw = fakePlaywright((p) => writeFileSync(p, encodePng(2, 2, solid(2, 2, 0, 0, 0))), broken);

    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => pw,
      startServer: async () => ({ ok: true, handle: { baseUrl: 'http://127.0.0.1:5173', stop: async () => undefined } }),
    });
    const r = await v.verify({ cwd, config: { ...baseConfig, screenshotDir: 'shots' } });

    assert.equal(r.status, 'ok', '量測本身沒問題；畫面好壞不由門檻值判定');
    const overflow = r.hints?.find((c) => c.name === 'visual:overflow-x');
    assert.ok(overflow, '爆版仍要被量出來並列為線索');
    assert.equal(overflow?.ok, false);
    assert.equal(r.checks.some((c) => c.name === 'visual:overflow-x'), false, '線索不該混進決定紅綠的 checks');
  });

  test('導覽失敗仍會清理 server 並回報失敗而非拋例外', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'visual-'));
    let stopped = false;
    const page: PageLike = {
      goto: async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); },
      waitForTimeout: async () => undefined,
      evaluate: async <R,>() => ({}) as R,
      screenshot: async () => Buffer.alloc(0),
    };
    const pw: PlaywrightLike = {
      chromium: {
        launch: async () => ({
          newContext: async () => ({ newPage: async () => page, close: async () => undefined }),
          close: async () => undefined,
        }),
      },
    };
    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => pw,
      startServer: async () => ({ ok: true, handle: { baseUrl: 'http://127.0.0.1:1', stop: async () => { stopped = true; } } }),
    });
    const r = await v.verify({ cwd, config: { ...baseConfig, screenshotDir: 'shots' } });

    assert.equal(r.status, 'failed');
    assert.equal(r.checks.find((c) => c.name === 'visual:navigate')?.ok, false);
    assert.equal(stopped, true);
  });
});

// ── 量測失敗不得變成「安靜的綠燈」 ──
//
// 這組是整個視覺驗證最要命的地方：Verifier 對「視覺關卡拋例外」的處理是降級成 ok:true 的跳過。
// 所以只要 capture 讓例外冒出去，量測腳本壞掉的後果就是「爆版頁面靜默過關」。
// 這裡驗的是：例外必須在 capture 內被接住，並轉成明確的紅燈。

function pwWithPage(page: PageLike): PlaywrightLike {
  return {
    chromium: {
      launch: async () => ({
        newContext: async () => ({ newPage: async () => page, close: async () => undefined }),
        close: async () => undefined,
      }),
    },
  };
}

const okServer = async (): Promise<StartServerResult> => ({
  ok: true,
  handle: { baseUrl: 'http://127.0.0.1:5173', stop: async () => undefined },
});

describe('量測端失敗的處理', () => {
  const baseConfig: VisualConfig = { devServer: 'npm run dev', devPort: 5173, routes: ['/sandbox'] };

  test('evaluateMeasurement：沒失敗為綠，有失敗為紅且 failingId 穩定', () => {
    assert.equal(evaluateMeasurement([], 3, 3).ok, true);
    const c = evaluateMeasurement(['mobile/sandbox：量測腳本執行失敗（__name is not defined）'], 0, 3);
    assert.equal(c.ok, false);
    assert.deepEqual(c.failingIds, ['mobile/sandbox']);
    assert.match(c.detail, /__name is not defined/);
  });

  test('量測腳本在頁面內丟錯 → visual:measure 紅、status failed（不是拋例外讓上游降級成綠）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'visual-m-'));
    let stopped = false;
    const page: PageLike = {
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
      evaluate: async () => { throw new Error('ReferenceError: __name is not defined'); },
      screenshot: async (o) => { if (o.path) writeFileSync(o.path, encodePng(2, 2, solid(2, 2, 1, 1, 1))); return Buffer.alloc(0); },
    };
    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => pwWithPage(page),
      startServer: async () => ({ ok: true, handle: { baseUrl: 'http://127.0.0.1:5173', stop: async () => { stopped = true; } } }),
    });
    const r = await v.verify({ cwd, config: { ...baseConfig, screenshotDir: 'shots' } });

    assert.equal(r.status, 'failed');
    const measure = r.checks.find((c) => c.name === 'visual:measure');
    assert.equal(measure?.ok, false);
    assert.match(measure?.detail ?? '', /__name is not defined/);
    assert.deepEqual(measure?.failingIds, ['mobile/sandbox', 'tablet/sandbox', 'desktop/sandbox']);
    // 量不到資料時版面判定什麼線索都給不出來——這正是「量測端壞掉 → 沒有人發現爆版」
    // 的機制，所以非得靠 visual:measure 這條**設施故障**的紅燈講出真相。
    // （版面判定本身已降級成線索，不再出現在 checks 裡。）
    assert.deepEqual(r.metrics, []);
    assert.equal(r.checks.some((c) => c.name === 'visual:layout'), false);
    assert.equal(r.hints?.some((c) => c.name === 'visual:layout'), false);
    assert.equal(stopped, true);
  });

  test('量測回傳半截物件（頁面內只跑了一半）→ 一樣判紅', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'visual-m2-'));
    const page: PageLike = {
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
      evaluate: async <R,>() => ({ route: '/sandbox', breakpoint: 'mobile' }) as R,
      screenshot: async (o) => { if (o.path) writeFileSync(o.path, encodePng(2, 2, solid(2, 2, 1, 1, 1))); return Buffer.alloc(0); },
    };
    const v = new VisualVerifier({ log: silentLog, loadPlaywright: async () => pwWithPage(page), startServer: okServer });
    const r = await v.verify({ cwd, config: { ...baseConfig, screenshotDir: 'shots' } });

    assert.equal(r.status, 'failed');
    const measure = r.checks.find((c) => c.name === 'visual:measure');
    assert.equal(measure?.ok, false);
    assert.match(measure?.detail ?? '', /格式不符/);
  });

  test('量測回傳 undefined（page.evaluate 沒回東西）→ 判紅而非炸掉', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'visual-m3-'));
    const page: PageLike = {
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
      evaluate: async <R,>() => undefined as R,
      screenshot: async (o) => { if (o.path) writeFileSync(o.path, encodePng(2, 2, solid(2, 2, 1, 1, 1))); return Buffer.alloc(0); },
    };
    const v = new VisualVerifier({ log: silentLog, loadPlaywright: async () => pwWithPage(page), startServer: okServer });
    const r = await v.verify({ cwd, config: { ...baseConfig, screenshotDir: 'shots' } });
    assert.equal(r.status, 'failed');
    assert.equal(r.checks.find((c) => c.name === 'visual:measure')?.ok, false);
  });

  test('截圖失敗 → visual:screenshots 紅，但不拋例外（同樣不能變成跳過）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'visual-s-'));
    const page: PageLike = {
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
      evaluate: async <R,>() => cleanMetrics() as unknown as R,
      screenshot: async () => { throw new Error('EACCES: permission denied'); },
    };
    const v = new VisualVerifier({ log: silentLog, loadPlaywright: async () => pwWithPage(page), startServer: okServer });
    const r = await v.verify({ cwd, config: { ...baseConfig, screenshotDir: 'shots' } });

    assert.equal(r.status, 'failed');
    assert.equal(r.checks.find((c) => c.name === 'visual:screenshots')?.ok, false);
    // 量測本身是好的，就不該連坐
    assert.equal(r.checks.find((c) => c.name === 'visual:measure')?.ok, true);
    assert.deepEqual(r.screenshots, []);
  });

  test('建立基準失敗 → incomparable（不炸、也不誤判為回歸）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'visual-b-'));
    const readonlyDir = mkdtempSync(join(tmpdir(), 'visual-ro-'));
    chmodSync(readonlyDir, 0o500); // 不可寫
    try {
      const pw = fakePlaywright((p) => writeFileSync(p, encodePng(2, 2, solid(2, 2, 3, 3, 3))), cleanMetrics());
      const v = new VisualVerifier({ log: silentLog, loadPlaywright: async () => pw, startServer: okServer });
      const r = await v.verify({
        cwd,
        config: { ...baseConfig, screenshotDir: 'shots', baselineDir: join(readonlyDir, 'baseline') },
      });
      assert.ok(r.diffs.every((d) => d.status === 'incomparable'), JSON.stringify(r.diffs));
      // 像素比對同樣降級成線索：incomparable 不是問題，所以不會出現在 hints 裡
      assert.equal(r.hints?.some((c) => c.name === 'visual:regression'), false);
      assert.equal(r.status, 'ok');
    } finally {
      chmodSync(readonlyDir, 0o700);
    }
  });
});

// ── dev server 生命週期（真的起 process，確認不留殘留） ──
//
// 這裡刻意不用假件：殘留 process 佔埠是「下一個任務莫名其妙驗證失敗」的經典成因，
// 只有真的 spawn 再真的 kill，才能證明 stop() 有把整個 process group 收乾淨。

/** 借一個沒人用的埠（借完立刻還）。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error('拿不到埠號'))));
    });
  });
}

async function portAlive(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

/** 等埠真的關閉（kill 到 socket 釋放有幾十毫秒的延遲）。 */
async function waitPortClosed(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portAlive(port))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** 寫一個臨時 .cjs 腳本並回傳可直接丟給 shell 的指令。 */
function scriptCmd(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'devserver-'));
  const file = join(dir, 'server.cjs');
  writeFileSync(file, body, 'utf8');
  return `"${process.execPath}" "${file}"`;
}

const listenScript = (port: number, announce: boolean) =>
  `const http=require('http');
   // 保險絲：萬一 stop() 的清理壞掉，這個假 server 也會自己死，
   // 讓測試「失敗」而不是「整組 npm test 掛住」
   setTimeout(()=>process.exit(0), 15000);
   http.createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1',()=>{
     ${announce ? `console.log('  Local:   http://localhost:${port}/');` : `console.log('server up');`}
   });`;

describe('defaultStartServer — dev server 生命週期', () => {
  test('未設定 devServer → 直接回不 ok（不會 spawn 任何東西）', async () => {
    const r = await defaultStartServer(process.cwd(), {});
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : '', /未設定 devServer/);
  });

  test('正常路徑：起得來、探得到、stop() 之後埠被釋放且不留 exit listener', async () => {
    const port = await freePort();
    const before = process.listenerCount('exit');
    const r = await defaultStartServer(process.cwd(), {
      devServer: scriptCmd(listenScript(port, false)),
      devPort: port,
      serverReadyTimeoutMs: 15_000,
    });
    assert.equal(r.ok, true, r.ok === false ? r.reason : '');
    if (!r.ok) return;
    // 優先用伺服器自己印的位址：Vite 之類的工具常只綁 IPv6 的 localhost，
    // 自己組 127.0.0.1 會連不上（實跑撞到，症狀是視覺驗證靜默跳過並放行）
    assert.match(r.handle.baseUrl, new RegExp(`:${port}$`));
    assert.ok(/localhost|127\.0\.0\.1|\[::1\]/.test(r.handle.baseUrl), r.handle.baseUrl);
    assert.equal(await portAlive(port), true);
    // daemon 中途掛掉也要收得掉 → 啟動期間必須掛著 exit listener
    assert.equal(process.listenerCount('exit'), before + 1);

    await r.handle.stop();
    assert.equal(await waitPortClosed(port), true, 'stop() 之後埠仍被佔用 → 有殘留 process');
    assert.equal(process.listenerCount('exit'), before, 'exit listener 沒被移除 → 每跑一次就洩漏一個');
  });

  test('沒給 devPort 時從輸出嗅探埠號', async () => {
    const port = await freePort();
    const r = await defaultStartServer(process.cwd(), {
      devServer: scriptCmd(listenScript(port, true)),
      serverReadyTimeoutMs: 15_000,
    });
    assert.equal(r.ok, true, r.ok === false ? r.reason : '');
    if (!r.ok) return;
    // 優先用伺服器自己印的位址：Vite 之類的工具常只綁 IPv6 的 localhost，
    // 自己組 127.0.0.1 會連不上——實跑撞到，症狀是視覺驗證靜默跳過並放行。
    assert.match(r.handle.baseUrl, new RegExp(`:${port}$`));
    assert.ok(/localhost|127\.0\.0\.1|\[::1\]/.test(r.handle.baseUrl), r.handle.baseUrl);
    await r.handle.stop();
    assert.equal(await waitPortClosed(port), true);
  });

  test('指令立刻失敗 → 回報「提前結束」並帶上輸出（不是空等到逾時）', async () => {
    const before = process.listenerCount('exit');
    const started = Date.now();
    const r = await defaultStartServer(process.cwd(), {
      devServer: scriptCmd(`console.error('Error: Cannot find module "vite"'); process.exit(1);`),
      devPort: 65_000,
      serverReadyTimeoutMs: 15_000,
    });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : '', /提前結束/);
    assert.match(r.ok === false ? r.reason : '', /Cannot find module/);
    assert.ok(Date.now() - started < 10_000, '應該一偵測到結束就回報，而不是等滿逾時');
    assert.equal(process.listenerCount('exit'), before);
  });

  test('逾時：一直沒就緒 → 回報未就緒，且把已經起來的 process 殺乾淨', async () => {
    const listening = await freePort(); // 子行程真的會聽這個
    const probed = await freePort(); // 但我們探的是另一個，永遠探不到
    const before = process.listenerCount('exit');

    const r = await defaultStartServer(process.cwd(), {
      devServer: scriptCmd(listenScript(listening, false)),
      devPort: probed,
      serverReadyTimeoutMs: 1200,
    });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : '', /仍未就緒/);
    // 關鍵：逾時路徑也必須把子行程收掉，否則下一個任務會撞到佔埠的殘留
    assert.equal(await waitPortClosed(listening), true, '逾時後子行程仍在跑 → 殘留 process');
    assert.equal(process.listenerCount('exit'), before);
  });

  test('stop() 重複呼叫不會丟例外（清理路徑會被重複觸發）', async () => {
    const port = await freePort();
    const r = await defaultStartServer(process.cwd(), {
      devServer: scriptCmd(listenScript(port, false)),
      devPort: port,
      serverReadyTimeoutMs: 15_000,
    });
    assert.equal(r.ok, true, r.ok === false ? r.reason : '');
    if (!r.ok) return;
    await r.handle.stop();
    await r.handle.stop();
    assert.equal(await waitPortClosed(port), true);
  });
});

// ── 例外分類：environment（合理跳過）vs runtime（量測端壞掉，必須判紅） ──
//
// 這是「量測端壞掉 → 靜默綠燈」的最後一道防線：Verifier 的 catch 依這個分類決定
// 要跳過還是判紅，所以分類本身錯了整條防線就沒了。

describe('classifyVisualError', () => {
  test('VisualEnvironmentError（含跨模組實例的品牌欄位）→ environment', () => {
    assert.equal(classifyVisualError(new VisualEnvironmentError('沒有瀏覽器')), 'environment');
    // 重複載入模組時 instanceof 會失準，改看旗標
    assert.equal(classifyVisualError({ message: 'x', isVisualEnvironmentError: true }), 'environment');
  });

  test('已知的環境缺件訊息 → environment', () => {
    const cases = [
      "browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1084/chrome-linux/chrome",
      'Cannot find module playwright',
      'Error: ERR_MODULE_NOT_FOUND',
      'Please run the following command to download new browsers: npx playwright install',
      'Host system is missing dependencies to run browsers',
      'error while loading shared libraries: libnss3.so',
      'spawn vite ENOENT',
    ];
    for (const m of cases) assert.equal(classifyVisualError(new Error(m)), 'environment', m);
  });

  test('包在 cause 裡的環境缺件也認得出來', () => {
    const wrapped = new Error('載入視覺模組失敗', { cause: new Error("Executable doesn't exist") });
    assert.equal(classifyVisualError(wrapped), 'environment');
  });

  test('一般例外（含量測/比對程式自己壞掉）→ runtime，分不出來時偏保守', () => {
    const cases = [
      new Error('ReferenceError: __name is not defined'),
      new Error('Target page, context or browser has been closed'),
      new Error('不支援的 PNG colorType：3'),
      new TypeError('Cannot read properties of undefined'),
      '字串例外',
      undefined,
      { some: 'object' },
    ];
    for (const e of cases) assert.equal(classifyVisualError(e), 'runtime', String(e));
  });

  test('cause 鏈很深也會終止（不會無限迴圈）', () => {
    let e = new Error('底層');
    for (let i = 0; i < 50; i += 1) e = new Error(`第 ${i} 層`, { cause: e });
    assert.equal(classifyVisualError(e), 'runtime');
  });
});

describe('VisualVerifier 的對外契約：只有環境缺件能變成 skipped', () => {
  const baseConfig: VisualConfig = { devServer: 'npm run dev', devPort: 5173, routes: ['/sandbox'] };

  test('loadPlaywright 丟環境缺件 → skipped（綠）', async () => {
    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => { throw new Error('Cannot find module playwright'); },
      startServer: async () => { throw new Error('不該啟動 server'); },
    });
    const r = await v.verify({ cwd: '/nowhere', config: baseConfig });
    assert.equal(r.status, 'skipped');
    assert.equal(r.checks[0]?.ok, true);
  });

  test('loadPlaywright 自己壞掉（一般例外）→ 往上拋，不得偽裝成跳過', async () => {
    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => { throw new TypeError('載入器寫壞了'); },
      startServer: async () => { throw new Error('不該啟動 server'); },
    });
    await assert.rejects(() => v.verify({ cwd: '/nowhere', config: baseConfig }), /載入器寫壞了/);
  });

  test('startServer 丟環境缺件（執行檔不存在）→ skipped，且瀏覽器有收掉', async () => {
    let closed = false;
    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => ({
        chromium: { launch: async () => ({ newContext: async () => { throw new Error('不該開 context'); }, close: async () => { closed = true; } }) },
      }),
      startServer: async () => { throw new Error('spawn vite ENOENT'); },
    });
    const r = await v.verify({ cwd: '/nowhere', config: baseConfig });
    assert.equal(r.status, 'skipped');
    assert.equal(r.checks[0]?.ok, true);
    assert.equal(closed, true);
  });

  test('startServer 自己壞掉（一般例外）→ 往上拋，且瀏覽器仍有收掉', async () => {
    let closed = false;
    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => ({
        chromium: { launch: async () => ({ newContext: async () => { throw new Error('不該開 context'); }, close: async () => { closed = true; } }) },
      }),
      startServer: async () => { throw new TypeError('啟動器寫壞了'); },
    });
    await assert.rejects(() => v.verify({ cwd: '/nowhere', config: baseConfig }), /啟動器寫壞了/);
    assert.equal(closed, true, '例外往上拋也不能留下殘留的瀏覽器');
  });

  test('瀏覽器在量測途中崩潰（newContext 丟錯）→ 往上拋讓 Verifier 判紅', async () => {
    const v = new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => ({
        chromium: { launch: async () => ({ newContext: async () => { throw new Error('Browser has been closed'); }, close: async () => undefined }) },
      }),
      startServer: okServer,
    });
    await assert.rejects(() => v.verify({ cwd: '/nowhere', config: baseConfig }), /Browser has been closed/);
  });
});

// ── 動畫穩定等待與專案級豁免（誤殺防線的另外兩塊） ──

/** 可編排回應的假 page：用來驗 waitForAnimations 的收斂條件。 */
function scriptedPage(answers: unknown[]): PageLike & { calls: number; waits: number } {
  let i = 0;
  const p = {
    calls: 0,
    waits: 0,
    goto: async () => undefined,
    waitForTimeout: async () => {
      p.waits += 1;
    },
    evaluate: async <R,>(): Promise<R> => {
      p.calls += 1;
      const v = answers[Math.min(i, answers.length - 1)];
      i += 1;
      if (v instanceof Error) throw v;
      return v as R;
    },
    screenshot: async () => Buffer.alloc(0),
  };
  return p;
}

describe('waitForAnimations', () => {
  test('動畫跑完（連續兩次靜止）才往下走', async () => {
    const p = scriptedPage([false, false, true, true]);
    await waitForAnimations(p, 5000);
    assert.equal(p.calls, 4);
  });

  test('只靜止一次不算——避免抓到兩段交錯動畫之間的空檔', async () => {
    const p = scriptedPage([true, false, true, true]);
    await waitForAnimations(p, 5000);
    assert.equal(p.calls, 4);
  });

  test('回傳值不是 boolean（頁面不支援 / 假件）→ 立刻放行，不把預算耗光', async () => {
    const p = scriptedPage([{ some: 'metrics' }]);
    const t0 = Date.now();
    await waitForAnimations(p, 5000);
    assert.equal(p.calls, 1);
    assert.ok(Date.now() - t0 < 1000, '不該真的等滿預算');
  });

  test('求值丟錯不會往上炸（動畫等待是加分項，不該變成新的失敗來源）', async () => {
    const p = scriptedPage([new Error('Execution context was destroyed')]);
    await waitForAnimations(p, 5000);
    assert.equal(p.calls, 1);
  });

  test('無限動畫（永遠不靜止）也會在預算內結束', async () => {
    const p = scriptedPage([false]);
    const t0 = Date.now();
    await waitForAnimations(p, 300);
    const spent = Date.now() - t0;
    assert.ok(spent >= 100 && spent < 3000, `耗時 ${spent}ms`);
    assert.ok(p.calls > 0);
  });

  test('預算 0 → 完全不呼叫頁面（可關閉這段等待）', async () => {
    const p = scriptedPage([false]);
    await waitForAnimations(p, 0);
    assert.equal(p.calls, 0);
  });

  test('判斷式忽略無限循環的動畫（spinner 不該讓整段等待卡滿）', () => {
    assert.match(ANIMATION_IDLE_EXPRESSION, /iterations === Infinity/);
    assert.doesNotThrow(() => new Function(`return ${ANIMATION_IDLE_EXPRESSION};`));
  });
});

describe('VisualVerifier 把設定送進量測腳本', () => {
  /** 記錄所有 evaluate 到的運算式，並回一份乾淨量測結果。 */
  function recordingPlaywright(seen: string[], metrics: LayoutMetrics): PlaywrightLike {
    const page: PageLike = {
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
      evaluate: async <R,>(expression: string): Promise<R> => {
        seen.push(expression);
        // 先回「已靜止」把動畫等待收掉，之後才回量測結果
        if (expression.includes('getAnimations')) return true as R;
        return metrics as unknown as R;
      },
      screenshot: async () => Buffer.alloc(0),
    };
    const ctx: ContextLike = { newPage: async () => page, close: async () => undefined };
    const browser: BrowserLike = { newContext: async () => ctx, close: async () => undefined };
    return { chromium: { launch: async () => browser } };
  }

  test('ignoreSelectors 會內嵌進量測腳本；沒設定時不出現這個欄位', async () => {
    const metrics = cleanMetrics({ route: '/sandbox', breakpoint: 'mobile' });
    const withCfg: string[] = [];
    await new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => recordingPlaywright(withCfg, metrics),
      startServer: async (): Promise<StartServerResult> => ({ ok: true, handle: { baseUrl: 'http://127.0.0.1:1', stop: async () => undefined } }),
    }).verify({
      cwd: mkdtempSync(join(tmpdir(), 'vis-cfg-')),
      config: { devServer: 'x', routes: ['/sandbox'], breakpoints: [{ name: 'mobile', width: 375, height: 812 }], ignoreSelectors: ['.legacy', '#third-party'] },
    });
    const collector = withCfg.find((e) => e.includes('collectLayoutMetrics') || e.includes('maxElements'));
    assert.ok(collector, `沒看到量測腳本：${withCfg.map((e) => e.slice(0, 40)).join('|')}`);
    assert.match(collector, /"ignoreSelectors":\["\.legacy","#third-party"\]/);

    const noCfg: string[] = [];
    await new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => recordingPlaywright(noCfg, metrics),
      startServer: async (): Promise<StartServerResult> => ({ ok: true, handle: { baseUrl: 'http://127.0.0.1:1', stop: async () => undefined } }),
    }).verify({
      cwd: mkdtempSync(join(tmpdir(), 'vis-cfg-')),
      config: { devServer: 'x', routes: ['/sandbox'], breakpoints: [{ name: 'mobile', width: 375, height: 812 }] },
    });
    const plain = noCfg.find((e) => e.includes('maxElements'));
    assert.ok(plain);
    // 只看內嵌的 JSON 參數（函式原始碼本身當然會提到 ignoreSelectors 這個欄位名）
    assert.ok(!/"ignoreSelectors"/.test(plain), plain.slice(0, 200));
  });

  test('每頁都會先等動畫再量測（順序不能反）', async () => {
    const seen: string[] = [];
    await new VisualVerifier({
      log: silentLog,
      loadPlaywright: async () => recordingPlaywright(seen, cleanMetrics()),
      startServer: async (): Promise<StartServerResult> => ({ ok: true, handle: { baseUrl: 'http://127.0.0.1:1', stop: async () => undefined } }),
    }).verify({
      cwd: mkdtempSync(join(tmpdir(), 'vis-anim-')),
      config: { devServer: 'x', routes: ['/sandbox'], breakpoints: [{ name: 'mobile', width: 375, height: 812 }] },
    });
    const animAt = seen.findIndex((e) => e.includes('getAnimations'));
    const measureAt = seen.findIndex((e) => e.includes('maxElements'));
    assert.ok(animAt >= 0 && measureAt >= 0, seen.length.toString());
    assert.ok(animAt < measureAt, '應先等動畫停再量測');
  });
});

// ── base URL 候選（IPv4 / IPv6）──

/**
 * Vite 之類的工具預設把 localhost 綁在 **IPv6 的 ::1**，不綁 127.0.0.1。
 * 實測 `curl 127.0.0.1:5173` 回 000、`curl localhost:5173` 回 200。
 * 先前只抽埠號再自己組 `http://127.0.0.1:<port>`，於是永遠探不到，
 * 等滿 60 秒判「環境缺件」→ 視覺驗證跳過並綠燈放行。破版頁面就這樣過關。
 */
describe('baseUrlCandidates', () => {
  it('伺服器印出的位址排最前面（那是它自己說的）', () => {
    const out = '  VITE v6.4.2  ready in 113 ms\n  ➜  Local:   http://localhost:5173/\n';
    assert.equal(baseUrlCandidates(out, 5173)[0], 'http://localhost:5173');
  });

  it('IPv4 與 IPv6 兩種寫法都當候選（由 probe 決定哪個通）', () => {
    const c = baseUrlCandidates('', 5173);
    assert.ok(c.includes('http://127.0.0.1:5173'));
    assert.ok(c.includes('http://localhost:5173'));
    assert.ok(c.includes('http://[::1]:5173'));
  });

  it('只採用埠號相符的那些（重試時輸出裡會有舊的埠）', () => {
    const out = 'Port 5173 is in use, trying another one...\n  ➜  Local:   http://localhost:5174/\n';
    const c = baseUrlCandidates(out, 5174);
    assert.equal(c[0], 'http://localhost:5174');
    assert.equal(c.some((u) => u.includes('5173')), false);
  });

  it('候選不重複（印出的剛好等於自己組的時候）', () => {
    const c = baseUrlCandidates('http://127.0.0.1:5173/', 5173);
    assert.equal(new Set(c).size, c.length);
  });
});
