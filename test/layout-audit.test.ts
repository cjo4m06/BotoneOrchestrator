// 版面量測端（collectLayoutMetrics / collectorExpression）的執行測試。
//
// 為何需要這個檔：判定端 evaluateLayoutMetrics 早就有測試（餵假 metrics），但「產生 metrics 的
// 那半」——真正在瀏覽器頁面內跑的量測腳本——從來沒被執行過。量測端一旦壞掉，metrics 會是空的，
// 所有版面關卡都會「因為沒資料所以全綠」，爆版頁面照樣過關；整個視覺驗證變空殼。
//
// 兩層防護：
//  A) 真實瀏覽器（chromium → chrome → msedge 遞補，與 visual.ts 同一套策略）跑 collectorExpression
//     產生的「字串運算式」。只有真的在頁面內 evaluate 才抓得到諸如「轉譯器 keepNames 注入的
//     __name helper 在頁面內不存在 → ReferenceError」這種只會在頁面內炸的雷。
//  B) 環境沒有瀏覽器時 A 會 skip（不是 fail，見 DESIGN「不因環境問題把 DoD 弄紅」的精神），
//     所以另備一組自製 DOM stub 直接呼叫 collectLayoutMetrics 保底，確保量測邏輯永遠有被執行。

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectLayoutMetrics,
  evaluateLayoutMetrics,
  isLayoutMetrics,
  type CollectInput,
  type LayoutMetrics,
  type LayoutThresholds,
} from '../src/worker/layout-audit.js';
import { collectorExpression, decodePng, comparePngBuffers } from '../src/worker/visual.js';

// ── 共用小工具 ──

/** 回傳判定為紅的關卡名稱（依名稱排序，方便斷言）。 */
function redNames(metrics: LayoutMetrics[], overrides: Partial<LayoutThresholds> = {}): string[] {
  return evaluateLayoutMetrics(metrics, overrides)
    .filter((c) => !c.ok)
    .map((c) => c.name)
    .sort();
}

/** 對齊/間距預設是諮詢式（ok:true），要驗「有抓到」得開 strictStyleChecks。 */
const STRICT: Partial<LayoutThresholds> = { strictStyleChecks: true };

function detailOf(metrics: LayoutMetrics[], name: string): string {
  const c = evaluateLayoutMetrics(metrics).find((x) => x.name === name);
  assert.ok(c, `找不到 check：${name}`);
  return c.detail;
}

const ARG: CollectInput = { route: '/x', breakpoint: 'mobile', maxElements: 1500 };

// ══════════════════════════════════════════════════════════════════
// A) 真實瀏覽器
// ══════════════════════════════════════════════════════════════════

// 刻意用結構介面而非 import playwright 的型別：與 visual.ts 一致，套件缺席時本檔仍可編譯/執行。
interface PwPage {
  setContent(html: string, opts?: { waitUntil?: 'load' }): Promise<void>;
  evaluate<R>(expression: string): Promise<R>;
  screenshot(opts?: { fullPage?: boolean }): Promise<Buffer>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(opts: { viewport: { width: number; height: number }; deviceScaleFactor?: number }): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwModule {
  chromium: { launch(opts?: { headless?: boolean; channel?: string }): Promise<PwBrowser> };
}

async function launchAnyBrowser(): Promise<PwBrowser | undefined> {
  let pw: PwModule;
  try {
    const spec = 'playwright';
    pw = (await import(spec)) as PwModule;
  } catch {
    return undefined;
  }
  // 與 visual.ts 的 launchBrowser 相同順序：內建 chromium → 系統 Chrome → 系統 Edge
  for (const channel of [undefined, 'chrome', 'msedge']) {
    try {
      return await pw.chromium.launch(channel ? { headless: true, channel } : { headless: true });
    } catch {
      /* 換下一個 */
    }
  }
  return undefined;
}

// 於模組載入時就決定「有沒有瀏覽器」，才能用 describe 的 skip 選項整組略過。
const browser = await launchAnyBrowser();
after(async () => {
  if (browser) await browser.close();
});

/** 用 collectorExpression 產生的字串在真實頁面內量測（走的就是正式流程那條路）。 */
async function measureInBrowser(
  html: string,
  opts: { width?: number; height?: number; breakpoint?: string; maxElements?: number; ignoreSelectors?: string[] } = {},
): Promise<LayoutMetrics> {
  assert.ok(browser, '沒有瀏覽器不該跑到這裡');
  const ctx = await browser.newContext({
    viewport: { width: opts.width ?? 375, height: opts.height ?? 812 },
    deviceScaleFactor: 1,
  });
  try {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const raw = await page.evaluate<unknown>(
      collectorExpression({
        route: '/x',
        breakpoint: opts.breakpoint ?? 'mobile',
        maxElements: opts.maxElements ?? 1500,
        ...(opts.ignoreSelectors ? { ignoreSelectors: opts.ignoreSelectors } : {}),
      }),
    );
    // 這行就是「量測端沒壞」的核心斷言：頁面回來的必須是完整的 LayoutMetrics
    assert.ok(isLayoutMetrics(raw), `量測結果格式不符：${JSON.stringify(raw)?.slice(0, 200)}`);
    return raw;
  } finally {
    await ctx.close();
  }
}

const RESET = `*{box-sizing:border-box;margin:0;padding:0}body{font:16px/1.5 system-ui;color:#222;background:#fff}`;
const page = (style: string, body: string) =>
  `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><style>${RESET}${style}</style></head><body>${body}</body></html>`;

/** 一個「正常、好看」的頁面：sticky header、grid 卡片、表單、下拉選單、footer。 */
const HEALTHY = page(
  `header{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #eee;background:#fff;z-index:10}
   nav{display:flex;gap:16px}
   nav a{display:block;padding:4px 8px;color:#06c;text-decoration:none}
   main{padding:16px;display:grid;gap:16px}
   .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px}
   .card{border:1px solid #ddd;border-radius:8px;padding:12px}
   .card h3{font-size:16px;margin-bottom:8px}
   .dropdown{position:relative}
   .menu{position:absolute;right:0;top:100%;display:none;border:1px solid #ddd;background:#fff;padding:8px}
   form{display:grid;gap:8px;max-width:400px}
   input,button{padding:8px;font:inherit}
   footer{padding:24px 16px;background:#fafafa;color:#666}`,
  `<header><strong>品牌</strong><nav><a href="#a">首頁</a><a href="#b">產品</a><a href="#c">關於</a></nav></header>
   <main>
     <h1>歡迎光臨</h1>
     <p>這是一段介紹文字，用來確認正常頁面不會被誤報。</p>
     <section class="cards">
       <article class="card"><h3>卡片一</h3><p>說明文字一</p></article>
       <article class="card"><h3>卡片二</h3><p>說明文字二</p></article>
       <article class="card"><h3>卡片三</h3><p>說明文字三</p></article>
       <article class="card"><h3>卡片四</h3><p>說明文字四</p></article>
     </section>
     <form><label>姓名<input name="n"></label><label>信箱<input name="e"></label><button>送出</button></form>
     <div class="dropdown"><button>更多</button><div class="menu"><a href="#x">選項</a></div></div>
   </main>
   <footer><p>© 2026 測試站</p></footer>`,
);

const skipReason = browser ? false : '環境無可用瀏覽器（chromium/chrome/msedge 皆啟動失敗）；改由下方 DOM stub 測試保底';

describe('collectLayoutMetrics — 在真實瀏覽器頁面內執行', { skip: skipReason }, () => {
  test('collectorExpression 的字串真的能在頁面內 evaluate（__name 墊片有效）', async () => {
    const m = await measureInBrowser(page('', '<div>哈囉</div>'));
    // 量到東西才代表腳本整段跑完，而不是「回了個空殼」
    assert.ok(m.sampled > 0, `sampled 應大於 0，實際 ${m.sampled}`);
    assert.equal(m.route, '/x');
    assert.equal(m.breakpoint, 'mobile');
    assert.equal(m.viewport.width, 375);
    assert.ok(m.doc.clientWidth > 0);
  });

  test('正常頁面在三個斷點都零誤報', async () => {
    const pages: LayoutMetrics[] = [];
    for (const bp of [
      { name: 'mobile', width: 375, height: 812 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'desktop', width: 1440, height: 900 },
    ]) {
      pages.push(await measureInBrowser(HEALTHY, { width: bp.width, height: bp.height, breakpoint: bp.name }));
    }
    assert.ok(pages.every((m) => m.sampled > 10), pages.map((m) => m.sampled).join(','));
    assert.deepEqual(redNames(pages), [], JSON.stringify(evaluateLayoutMetrics(pages).filter((c) => !c.ok), null, 1));
  });

  test('爆版：超寬區塊 → 文件與元素雙重橫向溢出', async () => {
    const m = await measureInBrowser(page('.wide{width:900px;height:60px;background:#f00}', '<div class="wide">超寬區塊</div>'));
    assert.deepEqual(redNames([m]), ['visual:element-overflow', 'visual:overflow-x']);
    assert.match(detailOf([m], 'visual:element-overflow'), /div\.wide\[0\] 超出 viewport 右緣/);
  });

  test('文字被容器裁切 → visual:text-clip', async () => {
    const m = await measureInBrowser(
      page('.box{width:120px;overflow:hidden;white-space:nowrap;border:1px solid #000}', '<div class="box">這是一段非常非常長的標題文字會被容器裁切掉</div>'),
    );
    assert.equal(m.clippedText.length, 1);
    assert.deepEqual(redNames([m]), ['visual:text-clip']);
    assert.match(detailOf([m], 'visual:text-clip'), /文字被裁切（橫向/);
  });

  test('該顯示的圖片量到 0 尺寸 → visual:zero-size', async () => {
    const m = await measureInBrowser(
      page('img{width:0;height:0}', '<img alt="logo" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><p>內容</p>'),
    );
    assert.deepEqual(m.zeroSized.map((e) => e.tag), ['img']);
    assert.deepEqual(redNames([m]), ['visual:zero-size']);
  });

  test('負 margin 讓兩張卡片疊在一起 → visual:overlap（同時被 obscured 抓到）', async () => {
    const m = await measureInBrowser(
      page('.a,.b{width:200px;height:80px}.a{background:#ccc}.b{background:#aaa;margin-top:-60px}', '<div class="a">上面的卡片</div><div class="b">下面的卡片</div>'),
    );
    assert.equal(m.overlaps.length, 1);
    assert.ok((m.overlaps[0]?.ratio ?? 0) > 0.5);
    assert.ok(redNames([m]).includes('visual:overlap'));
  });

  test('z-index 疊錯把按鈕蓋住 → visual:obscured', async () => {
    const m = await measureInBrowser(
      page(
        'button{width:200px;height:60px}.overlay{position:absolute;left:0;top:0;width:300px;height:200px;background:rgba(0,0,0,.5);z-index:9}',
        '<button>送出訂單</button><div class="overlay"></div>',
      ),
    );
    assert.deepEqual(m.obscured.map((o) => o.selector), ['button[0]']);
    assert.equal(m.obscured[0]?.ratio, 1);
    assert.ok(redNames([m]).includes('visual:obscured'));
  });

  test('同列元素歪掉（基線不齊）→ visual:alignment', async () => {
    const m = await measureInBrowser(
      page(
        '.row{display:flex;flex-direction:row;flex-wrap:nowrap;align-items:flex-start}.row div{width:80px;height:40px;background:#ddd}.row .off{margin-top:37px}',
        '<div class="row"><div>一</div><div class="off">二</div><div>三</div></div>',
      ),
    );
    assert.equal(m.rows.length, 1);
    assert.ok((m.rows[0]?.skewPx ?? 0) >= 30, `skewPx=${m.rows[0]?.skewPx}`);
    assert.ok(redNames([m], STRICT).includes('visual:alignment'));
    // 預設是諮詢式：問題照樣寫進 detail，但不判紅（刻意錯落的版面不該被逼著拉平）
    assert.ok(!redNames([m]).includes('visual:alignment'));
    assert.match(detailOf([m], 'visual:alignment'), /僅供參考/);
  });

  test('align-items:center 的列不會被誤判成歪掉（三基準取最小值）', async () => {
    const m = await measureInBrowser(
      page(
        '.row{display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;gap:12px}.row div{background:#ddd}.tall{height:80px;width:60px}.short{height:20px;width:60px}',
        '<div class="row"><div class="tall">高</div><div class="short">矮</div><div class="tall">高</div></div>',
      ),
    );
    assert.equal(m.rows[0]?.skewPx, 0);
    assert.deepEqual(redNames([m]), []);
  });

  test('同質清單間距忽寬忽窄 → visual:spacing', async () => {
    const m = await measureInBrowser(
      page(
        '.row{display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center}.row span{display:block;width:60px;height:30px;background:#ddd}.row span+span{margin-left:6px}.row span.far{margin-left:90px}',
        '<div class="row"><span>1</span><span>2</span><span class="far">3</span></div>',
      ),
    );
    assert.deepEqual(m.rows[0]?.gaps, [6, 90]);
    assert.equal(m.rows[0]?.uniform, true);
    assert.ok(redNames([m], STRICT).includes('visual:spacing'));
    assert.ok(!redNames([m]).includes('visual:spacing'));
  });

  test('空白頁面 → sampled 0 → visual:render 紅（渲染失敗不能算通過）', async () => {
    const m = await measureInBrowser(page('', ''));
    assert.equal(m.sampled, 0);
    assert.ok(redNames([m]).includes('visual:render'));
  });

  test('data-layout-audit="ignore" 可豁免刻意的溢出裝飾', async () => {
    // 用 position:fixed 的超寬條：它真的畫到 viewport 外（element-overflow 會抓到），
    // 但不會撐大文件捲動範圍，所以「安靜」與否只取決於豁免標記本身。
    // （不能再用 overflow:hidden 的外框——祖先只要會裁切，元素就畫不到 viewport 外，
    //   本來就不算溢出，那樣測不出豁免標記有沒有作用。）
    const style = '.wide{position:fixed;left:0;top:120px;width:900px;height:60px;background:#eee}';
    const noisy = await measureInBrowser(page(style, '<div class="wide">超寬</div><p>正常內容</p>'));
    const quiet = await measureInBrowser(page(style, '<div class="wide" data-layout-audit="ignore">超寬</div><p>正常內容</p>'));
    // 先證明沒標記時真的會被抓到，才能證明「安靜」不是因為根本沒偵測
    assert.deepEqual(noisy.overflowX.map((e) => e.selector), ['div.wide[0]']);
    assert.ok(redNames([noisy]).includes('visual:element-overflow'));
    assert.deepEqual(quiet.overflowX, []);
    assert.deepEqual(redNames([quiet]), []);
  });

  test('看不見的元素不列入取樣（display:none / visibility:hidden / opacity:0）', async () => {
    const m = await measureInBrowser(
      page(
        '.gone{display:none}.invis{visibility:hidden;width:100px;height:20px}.clear{opacity:0;width:100px;height:20px}',
        '<div class="gone">看不到</div><div class="invis">透明</div><div class="clear">全透明</div><p>正常</p>',
      ),
    );
    assert.equal(m.sampled, 1); // 只有 <p>
    assert.deepEqual(redNames([m]), []);
  });

  test('maxElements 會真的限制取樣量（避免大 DOM 讓 O(n²) 比對爆掉）', async () => {
    const html = page('i{display:block;height:2px}', '<i>x</i>'.repeat(50));
    assert.equal((await measureInBrowser(html, { maxElements: 10 })).sampled, 10);
    assert.equal((await measureInBrowser(html, { maxElements: 1500 })).sampled, 50);
  });

  test('多個問題同時存在時各關卡都會亮紅，且 failingId 穩定可重現', async () => {
    const html = page(
      '.wide{width:900px;height:40px}.clip{width:100px;overflow:hidden;white-space:nowrap}',
      '<div class="wide">超寬</div><div class="clip">被裁切的長長長長長長長長文字</div>',
    );
    const a = await measureInBrowser(html);
    const b = await measureInBrowser(html);
    const ids = (m: LayoutMetrics) => evaluateLayoutMetrics([m]).flatMap((c) => c.failingIds ?? []);
    assert.ok(redNames([a]).includes('visual:text-clip'));
    assert.ok(redNames([a]).includes('visual:element-overflow'));
    // 同一頁量兩次要得到相同的 failingIds——不穩定會讓無進展偵測失效
    assert.deepEqual(ids(a), ids(b));
    assert.ok(ids(a).every((id) => !/\d+px/.test(id)), ids(a).join(','));
  });
});

// ══════════════════════════════════════════════════════════════════
// A2) 誤殺防線（DESIGN D18：誤殺比漏抓更會拖垮自動化系統）
//
// 這一組是實跑診斷的結晶：18 個「刻意這樣設計」的正常頁面，舊版把其中 10 個判紅。
// 後果不是「多一條紅燈」，而是 agent 為了讓視覺關卡變綠，只能去破壞設計本身
// （拿掉橫捲、拿掉 ellipsis、把固定底欄改靜態、把錯落版面拉平）。
// 所以這裡的斷言是「零紅燈」，而下一組 BUSTED 則確保消除誤殺沒有讓偵測失效。
// ══════════════════════════════════════════════════════════════════

interface Fixture {
  name: string;
  html: string;
}

/** 18 個正常頁面（等價於診斷者用的那組 /tmp/fpcheck/pages）。 */
const HEALTHY_PAGES: Fixture[] = [
  {
    name: '01 表格放在 overflow-x:auto 容器',
    html: page(
      `.wrap{overflow-x:auto;border:1px solid #ddd}table{border-collapse:collapse;min-width:1100px}th,td{border:1px solid #eee;padding:8px 12px;white-space:nowrap}`,
      `<h1>季度營收</h1><div class="wrap"><table><thead><tr><th>區域</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th><th>YoY</th><th>備註說明欄位</th><th>負責人</th></tr></thead>
       <tbody><tr><td>北美</td><td>1,200,000</td><td>1,310,000</td><td>1,455,000</td><td>1,610,000</td><td>+12.4%</td><td>含通路折扣調整</td><td>Alice Chen</td></tr>
       <tr><td>歐洲</td><td>980,000</td><td>1,010,000</td><td>1,120,000</td><td>1,240,000</td><td>+8.1%</td><td>匯率影響已還原</td><td>Bob Lin</td></tr></tbody></table></div>
       <p>表格刻意可橫向捲動，這是設計。</p>`,
    ),
  },
  {
    name: '02 可橫捲的程式碼區塊',
    html: page(
      `pre{overflow-x:auto;background:#0d1117;color:#c9d1d9;padding:12px;border-radius:6px}code{white-space:pre;font-family:ui-monospace,monospace}`,
      `<h2>安裝</h2><pre><code>docker run --rm -it -v "$(pwd)":/workspace -w /workspace --env NODE_OPTIONS=--max-old-space-size=8192 node:24-bookworm npm run build -- --mode production</code></pre><p>程式碼區塊刻意不換行。</p>`,
    ),
  },
  {
    name: '03 輪播 carousel',
    html: page(
      `.track{display:flex;gap:16px;overflow-x:auto;padding-bottom:8px}.card{flex:0 0 280px;height:160px;background:#f2f4f8;border-radius:12px;padding:12px}`,
      `<h2>精選</h2><div class="track"><div class="card">卡片一</div><div class="card">卡片二</div><div class="card">卡片三</div><div class="card">卡片四</div><div class="card">卡片五</div><div class="card">卡片六</div></div>`,
    ),
  },
  {
    name: '04 sticky header + modal + backdrop + toast',
    html: page(
      `header{position:sticky;top:0;background:#fff;border-bottom:1px solid #eee;padding:12px 16px;z-index:10}
       main{padding:16px}
       .toast{position:fixed;right:16px;bottom:16px;background:#222;color:#fff;padding:10px 14px;border-radius:8px;z-index:50}
       .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100}
       .modal{position:fixed;z-index:101;left:50%;top:50%;transform:translate(-50%,-50%);background:#fff;border-radius:12px;padding:20px;width:min(420px,90vw)}`,
      `<header><strong>我的應用</strong></header><main><h1>設定</h1><p>這是一段內容文字，說明目前的設定狀態。</p><p>另一段內容。</p></main>
       <div class="toast">已儲存</div><div class="backdrop"></div>
       <div class="modal"><h3>確認刪除？</h3><p>此操作無法復原。</p><button>取消</button> <button>刪除</button></div>`,
    ),
  },
  {
    name: '05 masonry 多欄版面',
    html: page(
      `.grid{columns:3 220px;column-gap:16px}.card{break-inside:avoid;margin:0 0 16px;background:#f5f5f7;border-radius:10px;padding:12px}
       .a{height:120px}.b{height:200px}.c{height:90px}.d{height:170px}.e{height:140px}.f{height:230px}`,
      `<h2>作品集</h2><div class="grid"><div class="card a">一</div><div class="card b">二</div><div class="card c">三</div><div class="card d">四</div><div class="card e">五</div><div class="card f">六</div></div>`,
    ),
  },
  {
    name: '06 置中的空狀態',
    html: page(
      `body{display:grid;place-items:center;height:100vh}.box{text-align:center;color:#666}`,
      `<div class="box"><h2>還沒有任何項目</h2><p>建立第一個項目來開始。</p><button>新增項目</button></div>`,
    ),
  },
  {
    name: '07 ellipsis 與 line-clamp 截斷',
    html: page(
      `.row{display:flex;align-items:center;gap:12px;padding:10px;border-bottom:1px solid #eee}
       .title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
       .clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-width:520px;color:#555}`,
      `<h2>收件匣</h2>
       <div class="row"><span class="title">這是一封標題非常長的信件，長到一定會超出容器寬度因此需要使用 ellipsis 省略號來處理，這是刻意的設計</span><span>10:24</span></div>
       <div class="row"><span class="title">另一封同樣很長的信件標題，也會被省略號截斷，這在清單類介面是標準做法</span><span>09:02</span></div>
       <p class="clamp">這是一段需要限制在兩行內的摘要文字，超過的部分會被裁掉並顯示省略號。這在卡片式介面非常常見，例如新聞摘要、商品描述、通知內容等等，都會用 line-clamp 控制高度以維持版面整齊。</p>`,
    ),
  },
  {
    name: '08 baseline 對齊的價格列',
    html: page(
      `.price{display:flex;align-items:baseline;gap:8px}.amount{font-size:48px;font-weight:700}.unit{font-size:14px;color:#666}.per{font-size:14px;color:#999}`,
      `<h2>方案</h2><div class="price"><span class="amount">$29</span><span class="unit">USD</span><span class="per">/ 每月</span></div><p>價格數字與單位以 baseline 對齊。</p>`,
    ),
  },
  {
    name: '09 導覽列用 margin-left:auto 推右',
    html: page(
      `nav{display:flex;align-items:center;gap:20px;padding:12px 20px;border-bottom:1px solid #eee}
       nav a{text-decoration:none;color:#333}nav a.cta{margin-left:auto;background:#111;color:#fff;padding:8px 14px;border-radius:6px}main{padding:20px}`,
      `<nav><a href="#">首頁</a><a href="#">產品</a><a href="#">價格</a><a href="#">文件</a><a class="cta" href="#">開始使用</a></nav><main><h1>歡迎</h1><p>導覽列最後一項推到最右。</p></main>`,
    ),
  },
  {
    name: '10 負 margin 的堆疊頭像',
    html: page(
      `.stack{display:flex}.av{width:40px;height:40px;border-radius:50%;border:2px solid #fff;background:#8ab;display:grid;place-items:center;color:#fff;font-size:12px}.av+.av{margin-left:-12px}`,
      `<h3>參與者</h3><div class="stack"><div class="av">A</div><div class="av">B</div><div class="av">C</div><div class="av">D</div></div><p>頭像刻意重疊堆疊。</p>`,
    ),
  },
  {
    name: '12 一般著陸頁',
    html: page(
      `header{padding:16px 20px;border-bottom:1px solid #eee}.hero{padding:48px 20px;text-align:center;background:#fafafa}
       .features{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;padding:24px 20px}
       .f{background:#fff;border:1px solid #eee;border-radius:10px;padding:16px}footer{padding:20px;color:#888;border-top:1px solid #eee}`,
      `<header><strong>Acme</strong></header><div class="hero"><h1>更快地交付</h1><p>簡單、可靠的工作流程。</p><button>免費試用</button></div>
       <div class="features"><div class="f"><h3>快速</h3><p>秒級回應。</p></div><div class="f"><h3>穩定</h3><p>99.9% 可用性。</p></div><div class="f"><h3>安全</h3><p>端到端加密。</p></div></div><footer>© 2026 Acme</footer>`,
    ),
  },
  {
    name: '14 固定底部 cookie 橫幅',
    html: page(
      `body{padding:16px 16px 120px}.banner{position:fixed;left:0;right:0;bottom:0;background:#111;color:#fff;padding:16px;display:flex;gap:12px;align-items:center;justify-content:space-between}.banner button{padding:8px 14px}`,
      `<h1>部落格文章</h1><p>第一段內容。</p><p>第二段內容。</p><p>第三段內容說明。</p><div class="banner"><span>我們使用 cookie 以改善體驗。</span><button>接受</button></div>`,
    ),
  },
  {
    name: '15 inline-block 的 baseline 價格列',
    html: page(
      `.price{display:flex;align-items:baseline;gap:8px}.price>span{display:inline-block}.amount{font-size:48px;font-weight:700}.unit{font-size:14px;color:#666}.per{font-size:14px;color:#999}`,
      `<div class="price"><span class="amount">$29</span><span class="unit">USD</span><span class="per">/每月</span></div>`,
    ),
  },
  {
    name: '17 手機固定底部 tab bar',
    html: page(
      `body{padding:12px}.list div{padding:14px 8px;border-bottom:1px solid #eee}
       .tabs{position:fixed;left:0;right:0;bottom:0;display:flex;background:#fff;border-top:1px solid #ddd}
       .tabs a{flex:1;text-align:center;padding:12px;text-decoration:none;color:#333;font-size:12px}`,
      `<h2>訊息</h2><div class="list">${Array.from({ length: 20 }, (_, i) => `<div>項目 ${i + 1}</div>`).join('')}</div>
       <nav class="tabs"><a href="#">首頁</a><a href="#">搜尋</a><a href="#">通知</a><a href="#">我的</a></nav>`,
    ),
  },
  {
    name: '18 刻意錯落的卡片牆',
    html: page(
      `.row{display:flex;gap:16px;align-items:flex-start}.card{flex:1;background:#f4f4f8;border-radius:12px;padding:16px;height:160px}.card:nth-child(even){margin-top:32px}`,
      `<h2>錯落式排版</h2><div class="row"><div class="card">一</div><div class="card">二</div><div class="card">三</div><div class="card">四</div></div>`,
    ),
  },
];

/** 真正壞掉的頁面：消除誤殺不能把偵測一起消掉。 */
const BUSTED_PAGES: Array<Fixture & { expect: string }> = [
  {
    name: '超寬區塊撐破版面',
    expect: 'visual:element-overflow',
    html: page('.wide{width:1600px;height:60px;background:#f88}', '<h1>標題</h1><div class="wide">超寬區塊</div>'),
  },
  {
    name: '固定條比 viewport 還寬（祖先沒有橫捲可以擋）',
    expect: 'visual:element-overflow',
    html: page('.bar{position:fixed;left:0;top:0;width:1600px;height:48px;background:#88f}', '<div class="bar">超寬固定條</div><p>內容</p>'),
  },
  {
    name: '文字被 overflow:hidden 硬裁（沒有 ellipsis）',
    expect: 'visual:text-clip',
    html: page('.box{width:120px;overflow:hidden;white-space:nowrap;border:1px solid #000}', '<div class="box">這是一段非常非常長的標題文字會被容器裁切掉</div>'),
  },
  {
    name: '負 margin 讓兩張卡片大面積重疊',
    expect: 'visual:overlap',
    html: page('.a,.b{width:200px;height:80px}.a{background:#ccc}.b{background:#aaa;margin-top:-60px}', '<div class="a">上面的卡片</div><div class="b">下面的卡片</div>'),
  },
  {
    name: '內容區裡的小浮層把按鈕蓋住（真正的 z-index 疊錯）',
    expect: 'visual:obscured',
    html: page(
      'button{width:200px;height:60px}.overlay{position:absolute;left:0;top:0;width:300px;height:200px;background:rgba(0,0,0,.5);z-index:9}',
      '<button>送出訂單</button><div class="overlay"></div>',
    ),
  },
  {
    name: '該顯示的圖片量到 0 尺寸',
    expect: 'visual:zero-size',
    html: page('img{width:0;height:0}', '<img alt="logo" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><p>內容</p>'),
  },
];

describe('誤殺防線：正常設計不得判紅（D18）', { skip: skipReason }, () => {
  for (const fx of HEALTHY_PAGES) {
    test(`${fx.name} → 零紅燈`, async () => {
      const pages: LayoutMetrics[] = [
        await measureInBrowser(fx.html, { width: 375, height: 812, breakpoint: 'mobile' }),
        await measureInBrowser(fx.html, { width: 1440, height: 900, breakpoint: 'desktop' }),
      ];
      const reds = evaluateLayoutMetrics(pages).filter((c) => !c.ok);
      assert.deepEqual(reds.map((c) => c.name), [], reds.map((c) => `${c.name}\n${c.detail}`).join('\n---\n'));
    });
  }

  test('進場動畫還在跑時不判紅；同一頁把動畫暫停就抓得到（證明不是偵測死掉）', async () => {
    const css = `@keyframes slidein{from{transform:translateX(500px)}to{transform:translateX(0)}}
      .banner{position:fixed;left:0;top:100px;width:300px;height:60px;background:#eef;animation:slidein 8s linear}`;
    // position:fixed 讓它不影響文件捲動範圍，才能單獨驗「動畫中的元素不算溢出」這條規則
    const running = await measureInBrowser(page(css, '<div class="banner">滑入中的橫幅</div><p>正常內容</p>'));
    const paused = await measureInBrowser(page(`${css}.banner{animation-play-state:paused}`, '<div class="banner">滑入中的橫幅</div><p>正常內容</p>'));

    assert.deepEqual(running.overflowX, [], JSON.stringify(running.overflowX));
    assert.deepEqual(redNames([running]), []);
    // 幾何完全一樣、只差動畫在不在跑 → 暫停版必須被抓到
    assert.deepEqual(paused.overflowX.map((e) => e.selector), ['div.banner[0]']);
  });

  for (const fx of BUSTED_PAGES) {
    test(`仍抓得到：${fx.name}`, async () => {
      const m = await measureInBrowser(fx.html);
      assert.ok(redNames([m]).includes(fx.expect), `${fx.expect} 沒有變紅：${JSON.stringify(redNames([m]))}`);
    });
  }

  test('專案級 ignoreSelectors 可豁免（不必去改被驗專案的原始碼）', async () => {
    const html = page('.legacy-widget{width:1600px;height:60px;background:#eee}', '<div class="legacy-widget">第三方 widget</div><p>內容</p>');
    const noisy = await measureInBrowser(html);
    const quiet = await measureInBrowser(html, { ignoreSelectors: ['.legacy-widget'] });
    assert.ok(noisy.overflowX.length > 0);
    assert.deepEqual(quiet.overflowX, []);
    assert.equal(quiet.sampled, noisy.sampled - 1); // 整片子樹都不量了
  });

  test('壞掉的 ignoreSelectors 不會炸掉量測（量測端爆炸＝靜默綠燈）', async () => {
    const html = page('.wide{width:1600px;height:60px}', '<div class="wide">超寬</div>');
    const m = await measureInBrowser(html, { ignoreSelectors: ['>>>不是合法選擇器'] });
    assert.ok(m.sampled > 0);
    assert.ok(redNames([m]).includes('visual:element-overflow'));
  });
});

describe('failingId 穩定性（無進展偵測的前提）', { skip: skipReason }, () => {
  const ids = (m: LayoutMetrics) => evaluateLayoutMetrics([m]).flatMap((c) => c.failingIds ?? []);

  test('改 class 名 / 在前面插入元素 / 換包裝順序都不改變 failingId', async () => {
    const css = (cls: string) => `.${cls}{width:1600px;height:60px;background:#f88}`;
    const base = await measureInBrowser(page(css('wide'), '<main id="app"><div class="wide">超寬</div></main>'));
    // 1) agent 把 class 改名（最常見的「修一修」動作）
    const renamed = await measureInBrowser(page(css('table-wrap'), '<main id="app"><div class="table-wrap">超寬</div></main>'));
    // 2) agent 在前面插入一個元素（同層序號會變）
    const inserted = await measureInBrowser(page(css('wide'), '<main id="app"><p>新增的說明</p><div class="wide">超寬</div></main>'));
    // 3) 兩者同時發生
    const both = await measureInBrowser(page(css('x9'), '<main id="app"><p>新增的說明</p><div class="x9">超寬</div></main>'));

    assert.ok(ids(base).length > 0, '先確認真的有 failingId');
    assert.deepEqual(ids(renamed), ids(base));
    assert.deepEqual(ids(inserted), ids(base));
    assert.deepEqual(ids(both), ids(base));
    // 穩定鍵是「具名祖先 + 標籤路徑」，不含 class 也不含序號
    assert.ok(ids(base).every((id) => !/\[\d+\]/.test(id) && !/wide|table-wrap|x9/.test(id)), ids(base).join(','));
    assert.ok(ids(base).some((id) => id.includes('#app')), ids(base).join(','));
  });

  test('沒有 id/testid 時退回語意標籤路徑，仍不含 class 與序號', async () => {
    const a = await measureInBrowser(page('.wide{width:1600px;height:60px}', '<section><div class="wide">超寬</div></section>'));
    const b = await measureInBrowser(page('.zzz{width:1600px;height:60px}', '<section><span>前面</span><div class="zzz">超寬</div></section>'));
    assert.deepEqual(ids(b), ids(a));
  });

  test('data-testid 會被當成錨點（比標籤路徑更耐重構）', async () => {
    const a = await measureInBrowser(page('.wide{width:1600px;height:60px}', '<div><div data-testid="report"><div class="wide">超寬</div></div></div>'));
    const b = await measureInBrowser(page('.wide{width:1600px;height:60px}', '<section class="new"><div data-testid="report"><div class="wide">超寬</div></div></section>'));
    assert.deepEqual(ids(b), ids(a));
    assert.ok(ids(a).some((id) => id.includes('@report')), ids(a).join(','));
  });
});

// 自寫的 PNG 解碼器對「真實瀏覽器截圖」的驗證。
// 合成 PNG（test/visual.test.ts 那組）能覆蓋各種 filter，但真的截圖才是它每天要吃的東西：
// 瀏覽器逐列挑不同 filter、IDAT 切多塊。這裡順道用已經開好的瀏覽器驗一次。
describe('decodePng — 真實瀏覽器截圖', { skip: skipReason }, () => {
  async function shot(html: string, width = 320, height = 240): Promise<Buffer> {
    assert.ok(browser, '沒有瀏覽器不該跑到這裡');
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    try {
      const p = await ctx.newPage();
      await p.setContent(html, { waitUntil: 'load' });
      return await p.screenshot({ fullPage: false });
    } finally {
      await ctx.close();
    }
  }

  test('解得開 Chrome 產出的 PNG，且尺寸與 viewport 相符', async () => {
    const png = await shot(HEALTHY);
    const img = decodePng(png);
    assert.equal(img.width, 320);
    assert.equal(img.height, 240);
    assert.ok(img.channels === 3 || img.channels === 4, `channels=${img.channels}`);
    assert.equal(img.data.length, 320 * 240 * img.channels);
  });

  test('同一頁截兩次 → 差異 0；換一頁 → 差異明顯（解碼真的有解出內容）', async () => {
    const html = page('body{background:#fff}h1{font-size:20px}', '<h1>一樣的頁面</h1>');
    const a = await shot(html);
    const b = await shot(html);
    assert.equal(comparePngBuffers(a, b).diffRatio, 0);

    const other = await shot(page('body{background:#000;color:#fff}h1{font-size:20px}', '<h1>換了配色</h1>'));
    const cmp = comparePngBuffers(a, other);
    assert.ok(cmp.diffRatio > 0.5, `整頁換底色卻只差 ${cmp.diffRatio}`);
  });
});

// ══════════════════════════════════════════════════════════════════
// B) 自製 DOM stub（無瀏覽器環境的保底；直接呼叫 collectLayoutMetrics）
// ══════════════════════════════════════════════════════════════════

interface StubStyle {
  display: string;
  visibility: string;
  opacity: string;
  position: string;
  overflowX: string;
  overflowY: string;
  flexDirection: string;
  flexWrap: string;
}

const BASE_STYLE: StubStyle = {
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  position: 'static',
  overflowX: 'visible',
  overflowY: 'visible',
  flexDirection: 'row',
  flexWrap: 'nowrap',
};

interface StubSpec {
  tag: string;
  id?: string;
  cls?: string;
  /** 直屬文字節點 */
  text?: string;
  /** [x, y, width, height] */
  rect?: [number, number, number, number];
  /** 內容尺寸；未給則等於 client（= rect 尺寸），即「沒有被裁切」 */
  scroll?: { w?: number; h?: number };
  style?: Partial<StubStyle>;
  attrs?: Record<string, string>;
  children?: StubSpec[];
}

interface StubTextNode {
  nodeType: 3;
  textContent: string;
}

/** 極簡 DOM 元素：只實作 collectLayoutMetrics 真正會用到的成員。 */
class StubElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly id: string;
  readonly className: string;
  readonly style: StubStyle;
  readonly attrs: Record<string, string>;
  readonly kids: StubElement[] = [];
  readonly nodes: Array<StubElement | StubTextNode> = [];
  parentElement: StubElement | null = null;
  private readonly box: { x: number; y: number; w: number; h: number };
  private readonly scrollW: number;
  private readonly scrollH: number;

  constructor(spec: StubSpec, private readonly supportsCheckVisibility: boolean) {
    this.tagName = spec.tag.toUpperCase();
    this.id = spec.id ?? '';
    this.className = spec.cls ?? '';
    this.style = { ...BASE_STYLE, ...spec.style };
    this.attrs = { ...spec.attrs };
    const r = spec.rect ?? [0, 0, 0, 0];
    this.box = { x: r[0], y: r[1], w: r[2], h: r[3] };
    this.scrollW = spec.scroll?.w ?? r[2];
    this.scrollH = spec.scroll?.h ?? r[3];
    if (spec.text !== undefined) this.nodes.push({ nodeType: 3, textContent: spec.text });
    for (const c of spec.children ?? []) {
      const el = new StubElement(c, supportsCheckVisibility);
      el.parentElement = this;
      this.kids.push(el);
      this.nodes.push(el);
    }
    if (!supportsCheckVisibility) {
      // 模擬「不支援 checkVisibility 的環境」→ 量測程式應退回看 display。
      // 用「同名 own property 蓋掉原型方法」而不是 delete——delete 只刪 own property，
      // 原型上的方法還在，那樣就測不到 fallback 分支了。
      (this as { checkVisibility?: undefined }).checkVisibility = undefined;
    }
  }

  get children() {
    return collection(this.kids);
  }
  get childNodes() {
    return collection(this.nodes);
  }
  get clientWidth(): number {
    return this.box.w;
  }
  get clientHeight(): number {
    return this.box.h;
  }
  get scrollWidth(): number {
    return this.scrollW;
  }
  get scrollHeight(): number {
    return this.scrollH;
  }
  get textContent(): string {
    return this.nodes.map((n) => (n.nodeType === 3 ? n.textContent : (n as StubElement).textContent)).join('');
  }

  checkVisibility?(): boolean {
    for (let cur: StubElement | null = this; cur; cur = cur.parentElement) {
      if (cur.style.display === 'none') return false;
    }
    return true;
  }

  getBoundingClientRect() {
    const { x, y, w, h } = this.box;
    return { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h };
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  /** 只支援「逗號分隔的屬性選擇器」——量測程式唯一用到的形式。 */
  closest(sel: string): StubElement | null {
    const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
    for (let cur: StubElement | null = this; cur; cur = cur.parentElement) {
      for (const p of parts) {
        const m = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(p);
        if (!m || !m[1]) continue;
        const v = cur.attrs[m[1]];
        if (v === undefined) continue;
        if (m[2] === undefined || v === m[2]) return cur;
      }
    }
    return null;
  }

  contains(other: StubElement | null): boolean {
    for (let cur = other; cur; cur = cur.parentElement) if (cur === this) return true;
    return false;
  }

  /** 只支援 '*'（量測程式唯一用到的形式）：回傳所有後代，document order。 */
  querySelectorAll(sel: string): { length: number; item(i: number): StubElement | null } {
    assert.equal(sel, '*', 'stub 只支援 querySelectorAll("*")');
    const out: StubElement[] = [];
    const walk = (el: StubElement) => {
      for (const k of el.kids) {
        out.push(k);
        walk(k);
      }
    };
    walk(this);
    return collection(out);
  }

  descendants(): StubElement[] {
    const out: StubElement[] = [this];
    for (const k of this.kids) out.push(...k.descendants());
    return out;
  }
}

function collection<T>(items: T[]): { length: number; item(i: number): T | null } {
  return { length: items.length, item: (i: number) => items[i] ?? null };
}

interface StubDomOptions {
  width?: number;
  height?: number;
  /** 預設 true；設 false 模擬沒有 Element.checkVisibility 的環境（如舊瀏覽器 / jsdom） */
  checkVisibility?: boolean;
}

/**
 * 裝上假的 document/window，執行量測，再還原全域。
 * collectLayoutMetrics 是靠 globalThis 取用 DOM 的（因為它要能被序列化進頁面），
 * 所以離線測試也只能用同一條路。
 */
function measureWithStub(bodySpec: StubSpec, opts: StubDomOptions = {}, arg: CollectInput = ARG): LayoutMetrics {
  const supports = opts.checkVisibility !== false;
  const body = new StubElement({ ...bodySpec, tag: bodySpec.tag || 'body' }, supports);
  const html = new StubElement(
    { tag: 'html', rect: [0, 0, opts.width ?? 375, opts.height ?? 812], scroll: { w: 0, h: 0 } },
    supports,
  );
  // documentElement 的 scroll/client 尺寸就是文件層級溢出的判準
  const docScrollW = Math.max(opts.width ?? 375, ...body.descendants().map((e) => e.getBoundingClientRect().right));
  const scroller = new StubElement({ tag: 'html' }, supports) as StubElement & {
    scrollWidth: number;
    clientWidth: number;
    scrollHeight: number;
    clientHeight: number;
  };
  Object.defineProperties(scroller, {
    scrollWidth: { value: docScrollW, configurable: true },
    clientWidth: { value: opts.width ?? 375, configurable: true },
    scrollHeight: { value: opts.height ?? 812, configurable: true },
    clientHeight: { value: opts.height ?? 812, configurable: true },
  });
  void html;

  const all = body.descendants().slice(1); // 不含 body 自己
  const doc = {
    scrollingElement: scroller,
    documentElement: scroller,
    body,
    /** 近似瀏覽器的堆疊：document order 靠後者蓋在前面 */
    elementFromPoint(x: number, y: number): StubElement | null {
      let hit: StubElement | null = null;
      for (const el of all) {
        if (el.style.display === 'none' || el.style.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) hit = el;
      }
      return hit;
    },
  };

  const g = globalThis as unknown as Record<string, unknown>;
  const saved = {
    document: g['document'],
    innerWidth: g['innerWidth'],
    innerHeight: g['innerHeight'],
    getComputedStyle: g['getComputedStyle'],
  };
  g['document'] = doc;
  g['innerWidth'] = opts.width ?? 375;
  g['innerHeight'] = opts.height ?? 812;
  g['getComputedStyle'] = (el: StubElement) => el.style;
  try {
    return collectLayoutMetrics(arg);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  }
}

const div = (over: Partial<StubSpec> = {}): StubSpec => ({ tag: 'div', ...over });

describe('collectLayoutMetrics — DOM stub（無瀏覽器環境的保底）', () => {
  test('正常版面：零誤報，且真的有取樣到元素', () => {
    const m = measureWithStub({
      tag: 'body',
      children: [
        {
          tag: 'div',
          cls: 'row',
          rect: [0, 0, 375, 40],
          style: { display: 'flex' },
          children: [
            div({ cls: 'item', text: '一', rect: [0, 0, 110, 40] }),
            div({ cls: 'item', text: '二', rect: [122, 0, 110, 40] }),
            div({ cls: 'item', text: '三', rect: [244, 0, 110, 40] }),
          ],
        },
        div({ tag: 'p', text: '一段內容', rect: [0, 56, 375, 24] }),
      ],
    });
    assert.equal(m.sampled, 5);
    assert.equal(m.rows.length, 1);
    assert.deepEqual(m.rows[0]?.gaps, [12, 12]);
    assert.equal(m.rows[0]?.uniform, true);
    assert.deepEqual(redNames([m]), []);
  });

  test('元素超出 viewport 右緣 → 進 overflowX 並判紅', () => {
    const m = measureWithStub({ tag: 'body', children: [div({ cls: 'wide', text: '超寬', rect: [0, 0, 900, 60] })] });
    assert.deepEqual(m.overflowX.map((e) => e.selector), ['div.wide[0]']);
    assert.ok(redNames([m]).includes('visual:element-overflow'));
  });

  test('overflow:hidden 且內容比容器寬 → clippedText；scroll/auto 則不算', () => {
    const clipped = measureWithStub({
      tag: 'body',
      children: [div({ cls: 'box', text: '很長的文字', rect: [0, 0, 120, 24], scroll: { w: 336 }, style: { overflowX: 'hidden' } })],
    });
    assert.equal(clipped.clippedText.length, 1);
    assert.ok(redNames([clipped]).includes('visual:text-clip'));

    const scrollable = measureWithStub({
      tag: 'body',
      children: [div({ cls: 'box', text: '很長的文字', rect: [0, 0, 120, 24], scroll: { w: 336 }, style: { overflowX: 'auto' } })],
    });
    assert.deepEqual(scrollable.clippedText, []);
    assert.deepEqual(redNames([scrollable]), []);
  });

  test('有內容卻量到 0 尺寸 → zeroSized；純包裝 div 不誤報', () => {
    const m = measureWithStub({
      tag: 'body',
      children: [
        div({ tag: 'img', cls: 'logo', rect: [0, 0, 0, 0] }),
        div({ tag: 'span', text: '看不到的字', rect: [0, 0, 0, 0] }),
        div({ cls: 'wrapper', rect: [0, 0, 0, 0], children: [div({ text: '子', rect: [0, 0, 100, 20], style: { position: 'absolute' } })] }),
      ],
    });
    assert.deepEqual(m.zeroSized.map((e) => e.tag).sort(), ['img', 'span']);
    assert.ok(redNames([m]).includes('visual:zero-size'));
  });

  test('靜態葉節點互相重疊 → overlaps；只是相鄰不算', () => {
    const over = measureWithStub({
      tag: 'body',
      children: [div({ cls: 'a', text: 'A', rect: [0, 0, 200, 80] }), div({ cls: 'b', text: 'B', rect: [0, 20, 200, 80] })],
    });
    assert.equal(over.overlaps.length, 1);
    assert.ok((over.overlaps[0]?.ratio ?? 0) > 0.7);
    assert.ok(redNames([over]).includes('visual:overlap'));

    const apart = measureWithStub({
      tag: 'body',
      children: [div({ cls: 'a', text: 'A', rect: [0, 0, 200, 80] }), div({ cls: 'b', text: 'B', rect: [0, 80, 200, 80] })],
    });
    assert.deepEqual(apart.overlaps, []);
  });

  test('被後面的絕對定位元素蓋住 → obscured', () => {
    const m = measureWithStub({
      tag: 'body',
      children: [
        div({ tag: 'button', text: '送出', rect: [0, 0, 200, 60] }),
        div({ cls: 'overlay', rect: [0, 0, 300, 200], style: { position: 'absolute' } }),
      ],
    });
    assert.deepEqual(m.obscured.map((o) => o.selector), ['button[0]']);
    assert.equal(m.obscured[0]?.by, 'div.overlay[1]');
    assert.ok(redNames([m]).includes('visual:obscured'));
  });

  test('flex row 歪掉 → skewPx 反映偏差；置中對齊則為 0', () => {
    const skewed = measureWithStub({
      tag: 'body',
      children: [
        {
          tag: 'div',
          cls: 'row',
          rect: [0, 0, 375, 80],
          style: { display: 'flex' },
          children: [
            div({ text: '一', rect: [0, 0, 80, 40] }),
            div({ cls: 'off', text: '二', rect: [80, 37, 80, 40] }),
            div({ text: '三', rect: [160, 0, 80, 40] }),
          ],
        },
      ],
    });
    assert.equal(skewed.rows[0]?.skewPx, 37);
    assert.ok(redNames([skewed], STRICT).includes('visual:alignment'));

    const centered = measureWithStub({
      tag: 'body',
      children: [
        {
          tag: 'div',
          cls: 'row',
          rect: [0, 0, 375, 80],
          style: { display: 'flex' },
          children: [
            div({ text: '高', rect: [0, 0, 60, 80] }),
            div({ text: '矮', rect: [72, 30, 60, 20] }),
            div({ text: '高', rect: [144, 0, 60, 80] }),
          ],
        },
      ],
    });
    assert.equal(centered.rows[0]?.skewPx, 0);
    assert.deepEqual(redNames([centered]), []);
  });

  test('同質清單間距忽寬忽窄 → gaps 反映落差並判紅', () => {
    const m = measureWithStub({
      tag: 'body',
      children: [
        {
          tag: 'div',
          cls: 'row',
          rect: [0, 0, 375, 30],
          style: { display: 'flex' },
          children: [
            div({ tag: 'span', text: '1', rect: [0, 0, 60, 30] }),
            div({ tag: 'span', text: '2', rect: [66, 0, 60, 30] }),
            div({ tag: 'span', cls: 'far', text: '3', rect: [216, 0, 60, 30] }),
          ],
        },
      ],
    });
    assert.deepEqual(m.rows[0]?.gaps, [6, 90]);
    assert.ok(redNames([m], STRICT).includes('visual:spacing'));
  });

  test('flex row 歪到不再垂直重疊也抓得到（不能退回幾何判定就漏掉）', () => {
    const m = measureWithStub({
      tag: 'body',
      children: [
        {
          tag: 'div',
          cls: 'row',
          rect: [0, 0, 375, 200],
          style: { display: 'flex' },
          children: [
            div({ text: '一', rect: [0, 0, 80, 40] }),
            div({ text: '二', rect: [80, 120, 80, 40] }), // 完全錯開
          ],
        },
      ],
    });
    assert.equal(m.rows.length, 1);
    assert.equal(m.rows[0]?.skewPx, 120);
    assert.ok(redNames([m], STRICT).includes('visual:alignment'));
  });

  test('aria-hidden / hidden / data-layout-audit=ignore 的子樹整片豁免', () => {
    const cases: Record<string, string>[] = [{ 'aria-hidden': 'true' }, { hidden: '' }, { 'data-layout-audit': 'ignore' }];
    for (const attrs of cases) {
      const m = measureWithStub({
        tag: 'body',
        children: [
          { tag: 'div', cls: 'wrap', rect: [0, 0, 375, 60], attrs, children: [div({ cls: 'wide', text: '超寬', rect: [0, 0, 900, 60] })] },
          div({ tag: 'p', text: '正常', rect: [0, 60, 375, 20] }),
        ],
      });
      assert.deepEqual(m.overflowX, [], JSON.stringify(attrs));
      assert.equal(m.sampled, 1);
    }
  });

  test('沒有 checkVisibility 的環境退回看 display（不會整組漏掉）', () => {
    const m = measureWithStub(
      {
        tag: 'body',
        children: [
          div({ cls: 'gone', text: '不顯示', rect: [0, 0, 900, 20], style: { display: 'none' } }),
          div({ cls: 'wide', text: '超寬', rect: [0, 0, 900, 60] }),
        ],
      },
      { checkVisibility: false },
    );
    assert.equal(m.sampled, 1);
    assert.deepEqual(m.overflowX.map((e) => e.selector), ['div.wide[1]']);
  });

  test('maxElements 限制取樣量', () => {
    const children = Array.from({ length: 30 }, (_, i) => div({ text: `第${i}項`, rect: [0, i * 10, 100, 8] }));
    const full = measureWithStub({ tag: 'body', children });
    const capped = measureWithStub({ tag: 'body', children }, {}, { ...ARG, maxElements: 5 });
    assert.equal(full.sampled, 30);
    assert.equal(capped.sampled, 5);
  });

  test('空 body → sampled 0 → visual:render 紅', () => {
    const m = measureWithStub({ tag: 'body', children: [] });
    assert.equal(m.sampled, 0);
    assert.ok(redNames([m]).includes('visual:render'));
  });

  test('selector 帶祖先與同層序號，且量測結果可 JSON 往返（要能穿過 page.evaluate）', () => {
    const m = measureWithStub({
      tag: 'body',
      children: [
        {
          tag: 'section',
          cls: 'cards main',
          rect: [0, 0, 375, 60],
          children: [div({ id: 'first', rect: [0, 0, 100, 20], text: 'a' }), div({ cls: 'wide', text: '超寬', rect: [0, 20, 900, 40] })],
        },
      ],
    });
    assert.deepEqual(m.overflowX.map((e) => e.selector), ['section.cards.main[0]>div.wide[1]']);
    const round = JSON.parse(JSON.stringify(m)) as unknown;
    assert.ok(isLayoutMetrics(round));
    assert.deepEqual(round, m);
  });
});

// ══════════════════════════════════════════════════════════════════
// 邊界防線：量測結果的形狀驗證
// ══════════════════════════════════════════════════════════════════

describe('isLayoutMetrics', () => {
  const good = measureWithStub({ tag: 'body', children: [div({ text: 'x', rect: [0, 0, 10, 10] })] });

  test('真正的量測結果會通過', () => {
    assert.equal(isLayoutMetrics(good), true);
  });

  test('量測腳本壞掉時常見的回傳值一律擋下', () => {
    for (const bad of [undefined, null, 0, '', 'ok', [], {}, { route: '/', breakpoint: 'mobile' }]) {
      assert.equal(isLayoutMetrics(bad), false, JSON.stringify(bad ?? String(bad)));
    }
  });

  test('少任何一段量測資料都算不合格（半截物件比空物件更危險）', () => {
    for (const k of ['overflowX', 'clippedText', 'zeroSized', 'overlaps', 'obscured', 'rows', 'sampled', 'doc', 'viewport'] as const) {
      const copy = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
      delete copy[k];
      assert.equal(isLayoutMetrics(copy), false, `缺 ${k} 卻被放行`);
    }
  });

  test('數值欄位是 NaN/字串也算不合格', () => {
    const copy = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    copy['sampled'] = Number.NaN;
    assert.equal(isLayoutMetrics(copy), false);
    const copy2 = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    copy2['doc'] = { scrollWidth: '375', clientWidth: 375, scrollHeight: 1, clientHeight: 1 };
    assert.equal(isLayoutMetrics(copy2), false);
  });
});
