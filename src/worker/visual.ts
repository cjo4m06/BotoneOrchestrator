// 視覺驗證關卡（DESIGN.md §5 DoD「（視覺任務）多斷點截圖產出且視覺回歸在閾值內」）。
//
// 已接進 DoD 關卡：Verifier（worker/verifier.ts）在 typecheck/lint/build/test 之後呼叫本檔，
// 把 checks 併進 GateReport、screenshots 填入報告，並重算 green 與結果簽章。
// 觸發條件與目錄解析都在 verifier.ts（decideVisualGate / resolveVisualDirs）。
//
// 關鍵設計：**永遠不因環境問題把 DoD 弄紅**。playwright 未安裝、瀏覽器未下載、
// 專案沒設 devServer、dev server 起不來 → 一律回 status:'skipped' 並附一條 ok:true 的說明 check。
// 只有「頁面真的爆版/歪掉/視覺回歸超標」才回 ok:false。
//
// 但「環境缺件 → 綠」這條路只保留給**確定是環境**的情況。量測／截圖／比對程式自己爆炸
// 一律不得走這條路：那等於「量測端壞掉 → 靜默綠燈」，爆版頁面照樣過關。
// 因此本檔對外承諾：
//  - 已知環境缺件 → 就地回 skipped（不丟例外）；
//  - 真的必須以例外表達的環境問題 → 丟 VisualEnvironmentError；
//  - 其餘任何例外 → **原樣往上拋**，由 Verifier 判紅（見 classifyVisualError 與 verifier.ts）。
//
// 另一條鐵律：failingIds 必須穩定（斷點+路徑+規則+元素的「穩定鍵」），浮動數字（像素差 %、耗時）
// 只能出現在 detail——簽章吃 failingIds，不穩就會讓無進展偵測失效。
// 穩定鍵刻意不含 class 與同層序號（見 layout-audit.ts 的 stableKey）：agent 改個 class 名
// 或在前面插入一個元素，簽章就跟著變的話，ProgressMonitor 的「連續數輪同簽章」永遠不成立。
//
// 第三條：誤殺（false positive）比漏抓更會拖垮自動化系統（DESIGN D18）。
// 視覺關卡一旦誤判正常設計，agent 唯一能讓它變綠的方法就是去破壞那個設計
// （拿掉橫捲、拿掉 ellipsis、把固定底欄改靜態）。所以每條規則都必須替合法情況留出口，
// 判不準的（對齊/間距）就降級成 advisory，並提供 ignoreSelectors 這種不必改被驗專案的豁免。
//
// 注意：screenshotDir / baselineDir 走 resolve(cwd, …)，若傳相對路徑會落在 worktree 內。
// Verifier 一律傳「worktree 外」的絕對路徑（<screenshotRoot>/<taskId>），
// 否則截圖會被算進 git diff，污染 PR 也影響「diff 非空」的判定。

import { execa, type ResultPromise } from 'execa';
import { inflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import type { CheckResult } from '../types.js';
import type { Logger } from '../observability/logger.js';
import {
  collectLayoutMetrics,
  evaluateLayoutMetrics,
  isLayoutMetrics,
  type CollectInput,
  type LayoutMetrics,
  type LayoutThresholds,
} from './layout-audit.js';

// ── 設定 ──

export interface VisualBreakpoint {
  name: string;
  width: number;
  height: number;
}

/** 需求指定的三個斷點：手機 / 平板 / 桌機。 */
export const DEFAULT_BREAKPOINTS: VisualBreakpoint[] = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

export interface VisualConfig {
  /** dev server 啟動指令（projects.yaml commands.devServer）。未設 → 整個關卡跳過 */
  devServer?: string;
  /** dev server 埠號（projects.yaml commands.devPort）。未設則從 server 輸出嗅探 URL */
  devPort?: number;
  /** 要檢查的路徑，如 ['/', '/sandbox']。預設 ['/'] */
  routes?: string[];
  breakpoints?: VisualBreakpoint[];
  /** 截圖輸出目錄。預設 <cwd>/.orchestrator/screenshots */
  screenshotDir?: string;
  /** 基準截圖目錄。未設 → 不做視覺回歸（回 ok:true 的略過 check） */
  baselineDir?: string;
  /** 像素差異比率上限（0–1）。預設 0.02 */
  maxDiffRatio?: number;
  /** 單一像素被視為「有差」的通道差值門檻（抗編碼雜訊）。預設 8 */
  pixelTolerance?: number;
  /** 強制以本次結果覆寫基準（首次建立或刻意重置） */
  updateBaseline?: boolean;
  /** dev server 就緒逾時（ms）。預設 60000 */
  serverReadyTimeoutMs?: number;
  /** 單頁導覽逾時（ms）。預設 20000 */
  navTimeoutMs?: number;
  /** 導覽後等待版面穩定（動畫/字型）的時間（ms）。預設 400 */
  settleMs?: number;
  /**
   * 等待 CSS 動畫/過場結束的額外預算（ms）。預設 3000。
   * 進場動畫跑到一半截圖，元素本來就在畫面外、疊在一起——那是時機問題不是版面壞掉。
   * 設 0 可關閉這段等待（例如頁面有無限動畫且已知不影響版面）。
   */
  animationSettleMs?: number;
  /** 單頁取樣元素上限。預設 1500 */
  maxElements?: number;
  /**
   * 專案級豁免選擇器：命中的子樹不列入版面稽核。
   * 沒有它就只剩頁面內的 `data-layout-audit="ignore"`，等於要改被驗專案的原始碼才能豁免。
   */
  ignoreSelectors?: string[];
  /**
   * 指定瀏覽器 channel（'chrome' / 'msedge' …）。未指定時會依序嘗試
   * 內建 chromium → chrome → msedge，讓「沒跑過 playwright install」的機器也能用系統瀏覽器。
   */
  browserChannel?: string;
  thresholds?: Partial<LayoutThresholds>;
}

export interface ScreenshotDiff {
  route: string;
  breakpoint: string;
  actualPath: string;
  baselinePath?: string;
  status: 'match' | 'diff' | 'new-baseline' | 'incomparable';
  diffRatio: number;
  detail?: string;
}

export interface VisualResult {
  status: 'ok' | 'failed' | 'skipped';
  /**
   * 量測發現的可疑之處（溢出、重疊、歪斜、像素差異…）。
   * **不決定紅綠**——交給看得到畫面的判斷者當線索，見 verify() 裡的說明。
   */
  hints?: CheckResult[];

  /** status==='skipped' 時說明為什麼 */
  skipReason?: string;
  checks: CheckResult[];
  screenshots: string[];
  metrics: LayoutMetrics[];
  diffs: ScreenshotDiff[];
}

// ── Playwright 的最小結構介面 ──
// 刻意不 import playwright 的型別：本檔要在「playwright 未安裝」時也能編譯與執行，
// 而且結構介面讓測試能注入極輕量的假瀏覽器。

export interface PageLike {
  goto(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<unknown>;
  setDefaultTimeout?(ms: number): void;
  waitForTimeout(ms: number): Promise<void>;
  /** 只用字串運算式形式（見 collectorExpression 的說明） */
  evaluate<R>(expression: string): Promise<R>;
  screenshot(opts: { path?: string; fullPage?: boolean }): Promise<Buffer>;
}
export interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
export interface BrowserLike {
  newContext(opts: { viewport: { width: number; height: number }; deviceScaleFactor?: number }): Promise<ContextLike>;
  close(): Promise<void>;
}
export interface PlaywrightLike {
  chromium: { launch(opts?: { headless?: boolean; channel?: string }): Promise<BrowserLike> };
}

/** 已啟動的 dev server，stop() 必須確實把整個 process group 收掉。 */
export interface ServerHandle {
  baseUrl: string;
  stop(): Promise<void>;
}

export type StartServerResult =
  | { ok: true; handle: ServerHandle }
  | { ok: false; reason: string };

// ── 例外分類（環境缺件 vs 執行期例外） ──

/**
 * 「環境缺件」例外：playwright 沒裝、瀏覽器沒下載、dev server 起不來這類
 * **與被驗程式碼無關**的失敗。收到它的一方（Verifier）會判成 skipped（ok:true）。
 *
 * 注入假件的實作若想表達「這台機器就是沒有瀏覽器」，請丟這個型別，
 * 不要丟一般 Error——一般 Error 會被當成量測端自己壞掉而判紅。
 */
export class VisualEnvironmentError extends Error {
  /** 品牌欄位：跨模組實例（重複載入、打包）時 instanceof 可能失準，改看這個旗標。 */
  readonly isVisualEnvironmentError = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VisualEnvironmentError';
  }
}

/**
 * 環境缺件的訊息特徵。刻意寫得**窄**：誤判成 environment 就等於放行一個壞掉的量測端
 * （靜默綠燈）；反之誤判成 runtime 只是讓沒有瀏覽器的機器多一條紅燈，而那條路已經
 * 由 VisualVerifier 就地回 skipped 擋掉了，走到例外分類的機率很低。
 */
const ENVIRONMENT_PATTERNS: RegExp[] = [
  /cannot find (?:module|package)/i, // import('playwright') 失敗
  /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/,
  /executable doesn'?t exist/i, // playwright 未下載瀏覽器
  /playwright install/i,
  /browsertype\.launch/i,
  /host system is missing dependencies/i, // playwright 的系統套件檢查
  /error while loading shared libraries|libnss3|libatk|libgbm/i,
  /spawn\s+\S+\s+ENOENT/i, // dev server 的執行檔不存在
];

/**
 * 例外分類：'environment'（合理跳過，ok:true）或 'runtime'（量測端自己壞了，判紅）。
 *
 * **預設是 runtime**——分不出來時要偏向「不算通過」，因為反過來的代價是爆版頁面靜默過關。
 */
export function classifyVisualError(err: unknown): 'environment' | 'runtime' {
  if (err instanceof VisualEnvironmentError) return 'environment';
  if (typeof err === 'object' && err !== null && (err as { isVisualEnvironmentError?: unknown }).isVisualEnvironmentError === true) {
    return 'environment';
  }
  // cause 也要看：載入器常把底層錯誤包一層再丟
  const texts: string[] = [];
  for (let cur: unknown = err, depth = 0; cur !== undefined && cur !== null && depth < 5; depth += 1) {
    texts.push(errText(cur));
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  const joined = texts.join('\n');
  return ENVIRONMENT_PATTERNS.some((re) => re.test(joined)) ? 'environment' : 'runtime';
}

export interface VisualVerifierDeps {
  log: Logger;
  /** 載入 playwright；載不到回 undefined（→ 跳過）。測試可注入假件 */
  loadPlaywright?: () => Promise<PlaywrightLike | undefined>;
  /** 啟動 dev server。測試可注入假件 */
  startServer?: (cwd: string, config: VisualConfig) => Promise<StartServerResult>;
}

/**
 * 量測腳本以「自呼叫運算式字串」送進頁面，參數直接內嵌，原因有二：
 * 1) 轉譯器（tsx/esbuild 的 keepNames）會在函式體內插入 `__name(...)` helper，
 *    直接傳函式參考時頁面內找不到 helper 會噴 ReferenceError → 補一個 no-op 墊片。
 * 2) Playwright 收到字串時只當運算式求值、不會把 arg 傳進去，所以參數得自己內嵌。
 */
export function collectorExpression(arg: CollectInput): string {
  return `(() => {
  const __name = (f) => f;
  return (${collectLayoutMetrics.toString()})(${JSON.stringify(arg)});
})()`;
}

/**
 * 「畫面是否已經不動了」的頁面內判斷式。
 *
 * 回傳 boolean：true = 沒有在跑的動畫/過場。
 * 刻意忽略無限循環的動畫（spinner、跑馬燈）——它們永遠不會停，等下去只是浪費預算；
 * 那類元素改由量測端的 inMotion 排除。
 */
export const ANIMATION_IDLE_EXPRESSION = `(() => {
  if (typeof document.getAnimations !== 'function') return true;
  const list = document.getAnimations();
  for (const a of list) {
    if (a.playState !== 'running') continue;
    const t = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
    if (t && (t.iterations === Infinity || t.iterations === null)) continue;
    return false;
  }
  return true;
})()`;

/** 動畫穩定判定的輪詢間隔；需要連續兩次「靜止」才算穩，避免抓到兩段動畫之間的空檔。 */
const ANIMATION_POLL_MS = 120;
const ANIMATION_STABLE_STREAK = 2;

const DEFAULTS = {
  routes: ['/'],
  maxDiffRatio: 0.02,
  pixelTolerance: 8,
  serverReadyTimeoutMs: 60_000,
  navTimeoutMs: 20_000,
  settleMs: 400,
  animationSettleMs: 3000,
  maxElements: 1500,
};

/**
 * 等到頁面沒有動畫在跑（或用完預算）才回傳。
 *
 * 契約：**永遠不丟例外、永遠不無限等**。
 * - 頁面不支援 getAnimations、或求值結果不是 boolean（例如測試注入的假 page）→ 立刻視為穩定，
 *   不能因為「看不懂回傳值」就把每一頁都拖滿預算。
 * - 求值丟錯 → 同樣放行；動畫等待是加分項，不該變成新的失敗來源。
 */
export async function waitForAnimations(page: PageLike, budgetMs: number): Promise<void> {
  if (budgetMs <= 0) return;
  const deadline = Date.now() + budgetMs;
  let streak = 0;
  while (Date.now() < deadline) {
    let idle: unknown;
    try {
      idle = await page.evaluate<unknown>(ANIMATION_IDLE_EXPRESSION);
    } catch {
      return;
    }
    if (typeof idle !== 'boolean') return;
    if (!idle) {
      streak = 0;
    } else if (++streak >= ANIMATION_STABLE_STREAK) {
      return;
    }
    await page.waitForTimeout(ANIMATION_POLL_MS);
  }
}

/**
 * 多斷點截圖 + 爆版/歪版偵測 + 視覺回歸。
 * 所有外部依賴（playwright、dev server）都走 deps 注入，缺席即優雅降級。
 */
export class VisualVerifier {
  private readonly loadPlaywright: () => Promise<PlaywrightLike | undefined>;
  private readonly startServer: (cwd: string, config: VisualConfig) => Promise<StartServerResult>;

  constructor(private deps: VisualVerifierDeps) {
    this.loadPlaywright = deps.loadPlaywright ?? defaultLoadPlaywright;
    this.startServer = deps.startServer ?? defaultStartServer;
  }

  /**
   * @param input.whileServerUp dev server **還活著時**要做的事，回傳的關卡會併進結果。
   *   存在的理由：判斷者要自己導頁互動，而 server 在 verify 回傳前就會被 finally 收掉——
   *   把 baseUrl 放進回傳值等於交出一個已經失效的位址。用回呼才能既保住生命週期、
   *   又讓判斷者在對的時間點連得上。
   */
  async verify(input: {
    cwd: string;
    config: VisualConfig;
    whileServerUp?: (ctx: { baseUrl: string; screenshots: string[]; hints: CheckResult[] }) => Promise<CheckResult[]>;
  }): Promise<VisualResult> {
    const { cwd, config } = input;
    const log = this.deps.log;

    if (!config.devServer) {
      return skipped('專案未設定 commands.devServer，無法做瀏覽器驗證', log);
    }

    // 先確認瀏覽器可用再啟 server——反過來會白白起一個 server 又要收掉
    let pw: PlaywrightLike | undefined;
    try {
      pw = await this.loadPlaywright();
    } catch (e) {
      // 載入器丟錯：找不到模組之類算缺件（跳過）；載入器自己壞掉則往上拋，由 Verifier 判紅
      if (classifyVisualError(e) !== 'environment') throw e;
      return skipped(`playwright 載入失敗（視為未安裝）：${firstLine(errText(e))}`, log);
    }
    if (!pw) {
      return skipped('playwright 未安裝（npm i -D playwright），跳過視覺驗證', log);
    }

    const launched = await launchBrowser(pw, config.browserChannel);
    if (!launched.ok) {
      // 最常見：套件在但瀏覽器沒下載（npx playwright install chromium），且系統也沒有 Chrome/Edge
      return skipped(`瀏覽器無法啟動（多半是未下載瀏覽器）：${launched.reason}`, log);
    }
    const browser = launched.browser;

    let server: ServerHandle | undefined;
    try {
      let started: StartServerResult;
      try {
        started = await this.startServer(cwd, config);
      } catch (e) {
        // 同上：啟動器丟出「執行檔不存在」這類缺件才跳過，其餘往上拋（瀏覽器由 finally 收掉）
        if (classifyVisualError(e) !== 'environment') throw e;
        return skipped(`dev server 啟動失敗：${firstLine(errText(e))}`, log);
      }
      if (!started.ok) {
        // **這是紅燈，不是跳過。**
        //
        // 「沒裝 playwright」「沒有 devServer 設定」是環境缺件——那個專案本來就不做視覺驗證，
        // 跳過並放行是對的。但「dev server 起了、我們卻連不上」是**我們自己的故障**，
        // 而且它會讓一個真的需要視覺驗證的任務靜默通過。
        //
        // 實跑撞到兩次，症狀都一樣：DoD 顯示 `visual:ok`，其實一張圖都沒看。
        // 第一次是併行時撞埠、第二次是 Vite 只綁 IPv6 而我們探 127.0.0.1。
        // 兩次都「跳過並綠燈」——最危險的方向。
        log.error({ reason: started.reason }, 'dev server 連不上，視覺驗證判紅（不是跳過）');
        return {
          status: 'failed',
          checks: [
            {
              name: 'visual:server',
              ok: false,
              detail:
                `dev server 起不來或連不上，無法做畫面驗證：${started.reason}\n` +
                `這是驗證環境的問題，不是程式碼的問題——請檢查專案的 devServer 指令與埠設定。`,
              failingIds: ['visual/server'],
            },
          ],
          screenshots: [],
          metrics: [],
          diffs: [],
        };
      }
      server = started.handle;
      const r = await this.capture(cwd, config, browser, server.baseUrl);
      if (input.whileServerUp) {
        try {
          const extra = await input.whileServerUp({
            baseUrl: server.baseUrl,
            screenshots: r.screenshots,
            hints: r.hints ?? [],
          });
          if (extra.length > 0) {
            const checks = [...r.checks, ...extra];
            return { ...r, checks, status: checks.every((c) => c.ok) ? 'ok' : 'failed' };
          }
        } catch (e) {
          // 判斷層失敗不該推翻量測結果，也不該讓整條視覺關卡爆掉
          log.warn({ err: errText(e) }, 'server 存活期間的附加檢查失敗（略過）');
        }
      }
      return r;
    } finally {
      // 不論成敗都要收乾淨，避免殘留 chromium / dev server 佔埠
      await safe(() => browser.close());
      const s = server;
      if (s) await safe(() => s.stop());
    }
  }

  private async capture(cwd: string, config: VisualConfig, browser: BrowserLike, baseUrl: string): Promise<VisualResult> {
    const log = this.deps.log;
    const routes = config.routes?.length ? config.routes : DEFAULTS.routes;
    const breakpoints = config.breakpoints?.length ? config.breakpoints : DEFAULT_BREAKPOINTS;
    const shotDir = resolve(cwd, config.screenshotDir ?? '.orchestrator/screenshots');
    const navTimeout = config.navTimeoutMs ?? DEFAULTS.navTimeoutMs;
    const settle = config.settleMs ?? DEFAULTS.settleMs;
    const animationSettle = config.animationSettleMs ?? DEFAULTS.animationSettleMs;
    const maxElements = config.maxElements ?? DEFAULTS.maxElements;
    const ignoreSelectors = config.ignoreSelectors?.length ? config.ignoreSelectors : undefined;

    // 建不出目錄不該讓整段 capture 拋例外（拋出去會被 Verifier 降級成「跳過（綠）」）；
    // 後續截圖會失敗 → 由 visual:screenshots 關卡誠實地變紅
    await safe(() => mkdir(shotDir, { recursive: true }));

    const metrics: LayoutMetrics[] = [];
    const screenshots: string[] = [];
    const navFailures: string[] = [];
    const measureFailures: string[] = [];

    for (const bp of breakpoints) {
      const ctx = await browser.newContext({ viewport: { width: bp.width, height: bp.height }, deviceScaleFactor: 1 });
      try {
        for (const route of routes) {
          const page = await ctx.newPage();
          page.setDefaultTimeout?.(navTimeout);
          const url = joinUrl(baseUrl, route);
          try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: navTimeout });
          } catch (e) {
            // networkidle 在有長輪詢/WS 的 app 會逾時，退一步用 load 再試一次
            try {
              await page.goto(url, { waitUntil: 'load', timeout: navTimeout });
            } catch (e2) {
              navFailures.push(`${bp.name}${route}：${errText(e2)}`);
              log.warn({ url, err: errText(e2) }, '視覺驗證：頁面導覽失敗');
              continue;
            }
            void e;
          }
          await page.waitForTimeout(settle);
          // 先等動畫停再量：進場動畫未結束時截圖，會量到「元素在畫面外 / 互相重疊」的假象
          await waitForAnimations(page, animationSettle);

          // 量測腳本在頁面內出錯（或回傳半截物件）絕不能被吞掉：
          // 靜默失敗會讓 metrics 全空 → 版面判定全綠 → 爆版頁面照樣過關
          const arg: CollectInput = { route, breakpoint: bp.name, maxElements, ...(ignoreSelectors ? { ignoreSelectors } : {}) };
          try {
            const raw = await page.evaluate<unknown>(collectorExpression(arg));
            if (isLayoutMetrics(raw)) {
              metrics.push(raw);
            } else {
              measureFailures.push(`${bp.name}${route}：量測結果格式不符（${preview(raw)}）`);
              log.warn({ url, got: preview(raw) }, '視覺驗證：量測結果格式不符');
            }
          } catch (e) {
            measureFailures.push(`${bp.name}${route}：量測腳本執行失敗（${firstLine(errText(e))}）`);
            log.warn({ url, err: errText(e) }, '視覺驗證：量測腳本執行失敗');
          }

          const file = join(shotDir, `${bp.name}-${slug(route)}.png`);
          try {
            await page.screenshot({ path: file, fullPage: true });
            screenshots.push(file);
          } catch (e) {
            // 同理：截圖失敗改由 visual:screenshots 判紅，不要讓例外冒出去變成「跳過」
            log.warn({ file, err: errText(e) }, '視覺驗證：截圖失敗');
          }
        }
      } finally {
        await safe(() => ctx.close());
      }
    }

    // 量測明細留檔，PR 內文/除錯用得到
    await safe(() => writeFile(join(shotDir, 'layout-metrics.json'), JSON.stringify(metrics, null, 2), 'utf8'));

    const expected = breakpoints.length * routes.length;

    // 這三條是**量測本身有沒有做到**：導頁失敗、量測失敗、截圖沒拍齊。
    // 它們是設施故障，不是畫面好壞，所以仍然直接判紅——沒有材料就談不上判斷。
    const checks: CheckResult[] = [];
    checks.push(evaluateNavigation(navFailures, expected));
    checks.push(evaluateMeasurement(measureFailures, metrics.length, expected));
    checks.push(evaluateScreenshotCoverage(screenshots.length, expected));

    const diffs = await this.compareBaselines(cwd, config, screenshots, breakpoints, routes);

    // 版面門檻與像素比對**不再決定紅綠**，降級成給判斷者的線索。
    //
    // 理由：那九個門檻（溢出幾 px、歪斜幾 px、重疊比例…）回答不了「這畫面好不好看、
    // 好不好讀」。maxRowSkewPx 判得出「歪了 3px」，判不出「這個排版讓人找不到重點」；
    // 反過來刻意的錯位設計也會被它判紅。像素比對同理——改了顏色就是 100% 不同，
    // 那不代表變醜了。
    //
    // 這些數字仍然有價值，但價值在於**指出可疑的地方**（「這裡量到溢出 340px，
    // 你看一下是不是真的破了」），而不是自己下結論。最後說行不行的是看得到畫面的 agent。
    const hints: CheckResult[] = [
      ...evaluateLayoutMetrics(metrics, config.thresholds),
      evaluateScreenshotDiffs(diffs, config.maxDiffRatio ?? DEFAULTS.maxDiffRatio),
    ].filter((c) => !c.ok);

    const ok = checks.every((c) => c.ok);
    log.info(
      { ok, pages: metrics.length, screenshots: screenshots.length, hints: hints.length },
      '視覺驗證完成（量測與線索；紅綠由判斷者決定）',
    );
    return { status: ok ? 'ok' : 'failed', checks, screenshots, metrics, diffs, hints };
  }

  /** 與基準截圖比對；未設 baselineDir 就不做（回空陣列 → 判定為略過）。 */
  private async compareBaselines(
    cwd: string,
    config: VisualConfig,
    screenshots: string[],
    breakpoints: VisualBreakpoint[],
    routes: string[],
  ): Promise<ScreenshotDiff[]> {
    if (!config.baselineDir) return [];
    const baseDir = resolve(cwd, config.baselineDir);
    await safe(() => mkdir(baseDir, { recursive: true }));

    const tolerance = config.pixelTolerance ?? DEFAULTS.pixelTolerance;
    const out: ScreenshotDiff[] = [];

    for (const bp of breakpoints) {
      for (const route of routes) {
        const name = `${bp.name}-${slug(route)}.png`;
        const actualPath = screenshots.find((p) => p.endsWith(name));
        if (!actualPath) continue;
        const baselinePath = join(baseDir, name);

        if (config.updateBaseline || !existsSync(baselinePath)) {
          try {
            await mkdir(dirname(baselinePath), { recursive: true });
            await copyFile(actualPath, baselinePath);
            out.push({ route, breakpoint: bp.name, actualPath, baselinePath, status: 'new-baseline', diffRatio: 0 });
          } catch (e) {
            // 建基準失敗（磁碟/權限）不該把整段 capture 炸掉——例外會被上游降級成「跳過（綠）」
            out.push({ route, breakpoint: bp.name, actualPath, baselinePath, status: 'incomparable', diffRatio: 0, detail: `無法建立基準：${errText(e)}` });
          }
          continue;
        }

        try {
          const [a, b] = await Promise.all([readFile(baselinePath), readFile(actualPath)]);
          const cmp = comparePngBuffers(a, b, tolerance);
          out.push({
            route,
            breakpoint: bp.name,
            actualPath,
            baselinePath,
            status: cmp.comparable ? (cmp.diffRatio > 0 ? 'diff' : 'match') : 'incomparable',
            diffRatio: cmp.diffRatio,
            detail: cmp.detail,
          });
        } catch (e) {
          // 解碼失敗不該讓 DoD 變紅（可能是不支援的 PNG 變體）
          out.push({ route, breakpoint: bp.name, actualPath, baselinePath, status: 'incomparable', diffRatio: 0, detail: errText(e) });
        }
      }
    }
    return out;
  }
}

// ── 純判定函式（可離線單元測試） ──

export function evaluateNavigation(failures: string[], expected: number): CheckResult {
  if (failures.length === 0) return { name: 'visual:navigate', ok: true, detail: `${expected} 個頁面皆成功載入` };
  return {
    name: 'visual:navigate',
    ok: false,
    detail: [`${failures.length}/${expected} 個頁面載入失敗：`, ...failures.map((f) => `- ${f}`)].join('\n'),
    failingIds: failures.map((f) => f.split('：')[0] ?? f),
  };
}

/**
 * 版面量測是否真的跑起來。
 *
 * 這條刻意判「紅」而不是比照環境缺件判綠：能走到量測這一步代表 playwright、瀏覽器、
 * dev server、頁面導覽全都正常，此時量測失敗只可能是頁面炸了或量測腳本本身壞了
 * （例如轉譯器注入的 helper 在頁面內不存在）。若這種情況判綠，metrics 會是空的，
 * 後續所有版面關卡都會「因為沒資料所以全綠」——爆版頁面就這樣被放行。
 */
export function evaluateMeasurement(failures: string[], measured: number, expected: number): CheckResult {
  if (failures.length === 0) {
    return { name: 'visual:measure', ok: true, detail: `已完成 ${measured}/${expected} 個頁面的版面量測` };
  }
  return {
    name: 'visual:measure',
    ok: false,
    detail: [`${failures.length} 個頁面量測失敗（版面判定會因此失去意義）：`, ...failures.map((f) => `- ${f}`)].join('\n'),
    failingIds: failures.map((f) => f.split('：')[0] ?? f),
  };
}

export function evaluateScreenshotCoverage(actual: number, expected: number): CheckResult {
  const ok = actual >= expected && expected > 0;
  return {
    name: 'visual:screenshots',
    ok,
    detail: ok ? `已產出 ${actual} 張多斷點截圖` : `截圖不足：預期 ${expected} 張，實際 ${actual} 張`,
    failingIds: ok ? undefined : ['screenshots'],
  };
}

export function evaluateScreenshotDiffs(diffs: ScreenshotDiff[], maxDiffRatio: number): CheckResult {
  if (diffs.length === 0) {
    return { name: 'visual:regression', ok: true, detail: '未設定 baselineDir，略過視覺回歸' };
  }
  const created = diffs.filter((d) => d.status === 'new-baseline');
  const bad = diffs.filter((d) => d.status === 'diff' && d.diffRatio > maxDiffRatio);
  const odd = diffs.filter((d) => d.status === 'incomparable');
  if (bad.length === 0) {
    const notes = [`${diffs.length} 張比對通過（門檻 ${pctText(maxDiffRatio)}）`];
    if (created.length > 0) notes.push(`其中 ${created.length} 張為新建基準`);
    if (odd.length > 0) notes.push(`${odd.length} 張無法比對（已略過）`);
    return { name: 'visual:regression', ok: true, detail: notes.join('；') };
  }
  return {
    name: 'visual:regression',
    ok: false,
    detail: [
      `${bad.length} 張截圖超出視覺回歸門檻 ${pctText(maxDiffRatio)}：`,
      ...bad.map((d) => `- ${d.breakpoint}${d.route} 差異 ${pctText(d.diffRatio)}${d.detail ? `（${d.detail}）` : ''}`),
    ].join('\n'),
    failingIds: bad.map((d) => `${d.breakpoint}${d.route}`),
  };
}

/** 給 Verifier 併入 GateReport 的片段。 */
export function toGateFragment(r: VisualResult): { checks: CheckResult[]; screenshots: string[] } {
  return { checks: r.checks, screenshots: r.screenshots };
}

// ── PNG 解碼 / 像素比對（不引入影像庫；Node 內建 zlib 就夠） ──

export interface DecodedImage {
  width: number;
  height: number;
  channels: number;
  /** 逐列 RGBA/RGB 位元組 */
  data: Uint8Array;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 最小 PNG 解碼器：只支援 bitDepth 8、非交錯、灰階/RGB/RGBA。
 * Playwright 的截圖正是這個格式；遇到其他變體就丟錯，由呼叫端降級成「無法比對」。
 */
export function decodePng(buf: Buffer): DecodedImage {
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (buf[i] !== PNG_SIG[i]) throw new Error('不是 PNG 檔');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const start = off + 8;
    if (type === 'IHDR') {
      width = buf.readUInt32BE(start);
      height = buf.readUInt32BE(start + 4);
      bitDepth = buf[start + 8] ?? 0;
      colorType = buf[start + 9] ?? -1;
      interlace = buf[start + 12] ?? 0;
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, start + len));
    } else if (type === 'IEND') {
      break;
    }
    off = start + len + 4; // +4 = CRC
  }

  if (bitDepth !== 8) throw new Error(`不支援的 PNG bitDepth：${bitDepth}`);
  if (interlace !== 0) throw new Error('不支援交錯式 PNG');
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : -1;
  if (channels < 0) throw new Error(`不支援的 PNG colorType：${colorType}`);
  if (width <= 0 || height <= 0) throw new Error('PNG 尺寸無效');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error('PNG 資料長度不足');

  const out = new Uint8Array(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++] ?? 0;
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[pos + x] ?? 0;
      const a = x >= channels ? (out[rowStart + x - channels] ?? 0) : 0;
      const b = y > 0 ? (out[prevStart + x] ?? 0) : 0;
      const c = x >= channels && y > 0 ? (out[prevStart + x - channels] ?? 0) : 0;
      let v: number;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: v = cur + paeth(a, b, c); break;
        default: throw new Error(`未知的 PNG filter：${filter}`);
      }
      out[rowStart + x] = v & 0xff;
    }
    pos += stride;
  }
  return { width, height, channels, data: out };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export interface PixelComparison {
  comparable: boolean;
  diffPixels: number;
  totalPixels: number;
  diffRatio: number;
  detail?: string;
}

/** 逐像素比對；任一通道差值超過 tolerance 即計為一個差異像素。 */
export function diffImages(a: DecodedImage, b: DecodedImage, tolerance = DEFAULTS.pixelTolerance): PixelComparison {
  if (a.width !== b.width || a.height !== b.height) {
    // 尺寸不同本身就是回歸（版面變了），直接視為 100% 差異
    return {
      comparable: true,
      diffPixels: a.width * a.height,
      totalPixels: a.width * a.height,
      diffRatio: 1,
      detail: `尺寸不同：基準 ${a.width}×${a.height}，實際 ${b.width}×${b.height}`,
    };
  }
  const ch = Math.min(a.channels, b.channels);
  const total = a.width * a.height;
  let diff = 0;
  for (let i = 0; i < total; i++) {
    const ai = i * a.channels;
    const bi = i * b.channels;
    for (let k = 0; k < ch; k++) {
      if (Math.abs((a.data[ai + k] ?? 0) - (b.data[bi + k] ?? 0)) > tolerance) {
        diff++;
        break;
      }
    }
  }
  return { comparable: true, diffPixels: diff, totalPixels: total, diffRatio: total > 0 ? diff / total : 0 };
}

export function comparePngBuffers(baseline: Buffer, actual: Buffer, tolerance = DEFAULTS.pixelTolerance): PixelComparison {
  return diffImages(decodePng(baseline), decodePng(actual), tolerance);
}

// ── dev server 生命週期 ──

const READY_POLL_MS = 250;

/**
 * 用 execa 起 dev server 並等到真的能回應 HTTP。
 * detached:true 讓子行程自成 process group——npm run dev 底下常還有一層真正的 server，
 * 只 kill 直接子行程會留下孤兒佔住埠。
 */
export async function defaultStartServer(cwd: string, config: VisualConfig): Promise<StartServerResult> {
  const cmd = config.devServer;
  if (!cmd) return { ok: false, reason: '未設定 devServer' };
  const timeout = config.serverReadyTimeoutMs ?? DEFAULTS.serverReadyTimeoutMs;

  let child: ResultPromise;
  try {
    child = execa(cmd, {
      cwd,
      shell: true,
      detached: true,
      reject: false,
      // 避免 dev server 自動開瀏覽器 / 輸出 ANSI 干擾埠號嗅探
      env: { BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (e) {
    return { ok: false, reason: `無法啟動 dev server：${errText(e)}` };
  }

  let output = '';
  let exited = false;
  child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
  void child.then(() => { exited = true; }, () => { exited = true; });

  const kill = makeKiller(child);
  // daemon 若在驗證途中掛掉，至少別留下佔埠的 dev server
  const onExit = () => kill('SIGKILL');
  process.once('exit', onExit);
  const stop = async () => {
    process.removeListener('exit', onExit);
    kill('SIGTERM');
    await Promise.race([child.catch(() => undefined), delay(5000)]);
    if (!exited) kill('SIGKILL');
  };

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (exited) {
      await stop();
      return { ok: false, reason: `dev server 提前結束：${lastLines(output, 10)}` };
    }
    // **嗅探優先於設定值**：dev server 說它在哪個埠，那就是事實。
    // 設定的埠只是期望——Vite 等工具在埠被佔用時會自動換一個並印出來
    // （`Port 5173 is in use, trying another one... Local: http://localhost:5174/`）。
    // 先前是設定值優先，於是併行跑兩個 worktree 時必然有一個死等錯的埠，
    // 60 秒後被判成「環境缺件」→ **視覺驗證靜默跳過並放行**。破版頁面就這樣過關。
    const port = sniffPort(output) ?? config.devPort;
    if (port) {
      for (const baseUrl of baseUrlCandidates(output, port)) {
        if (await probe(baseUrl)) return { ok: true, handle: { baseUrl, stop } };
      }
    }
    await delay(READY_POLL_MS);
  }
  await stop();
  return { ok: false, reason: `等待 ${timeout}ms 仍未就緒：${lastLines(output, 10)}` };
}

function makeKiller(child: ResultPromise): (sig: 'SIGTERM' | 'SIGKILL') => void {
  return (sig) => {
    const pid = child.pid;
    try {
      if (pid) process.kill(-pid, sig); // 負號 = 整個 process group
      else child.kill(sig);
    } catch {
      try { child.kill(sig); } catch { /* 已經死了 */ }
    }
  };
}

/** 從 dev server 輸出嗅探埠號（vite/next/CRA 都會印 http://localhost:PORT）。 */
/**
 * 從 dev server 的輸出抽出**可以真的連上的** base URL。
 *
 * 為什麼不能只抽埠號再自己組 `http://127.0.0.1:<port>`：Vite 之類的工具預設把
 * localhost 綁在 **IPv6 的 ::1**，不綁 127.0.0.1。實測 `curl 127.0.0.1:5173` 回 000、
 * `curl localhost:5173` 回 200——於是我們永遠探不到，等滿 60 秒後判成「環境缺件」，
 * **視覺驗證跳過並綠燈放行**。破版頁面就這樣過關，而畫面上只寫著「dev server 未就緒」。
 *
 * 所以候選要含 IPv4 與 IPv6 兩種寫法，由 probe 決定哪個真的通。
 */
export function baseUrlCandidates(output: string, port: number): string[] {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const printed = [...clean.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/gi)]
    .filter((m) => Number(m[1]) === port)
    .map((m) => m[0].replace(/\/$/, ''));
  // 印出來的優先（那是它自己說的），再補上另外兩種寫法當備援
  return [...new Set([...printed, `http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`])];
}

export function sniffPort(output: string): number | undefined {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  // 取**最後一個**而不是第一個：埠被佔用時工具會重試並再印一次
  // （`Port 5173 is in use, trying another one...` → 後面才是真正在用的那個）。
  // 後印的一定比先印的新，取最後一個才是當下實際監聽的埠。
  const all = [...clean.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/gi)];
  const last = all.at(-1)?.[1];
  const port = last ? Number(last) : undefined;
  return port && port > 0 && port < 65536 ? port : undefined;
}

async function probe(baseUrl: string): Promise<boolean> {
  try {
    // 任何 HTTP 回應（含 404/500）都代表 server 起來了
    await fetch(baseUrl, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

// ── 小工具 ──

/**
 * 依序嘗試「內建 chromium → 系統 Chrome → 系統 Edge」。
 * 需求明訂不下載瀏覽器，所以能借用系統瀏覽器就別直接放棄整個關卡。
 */
async function launchBrowser(
  pw: PlaywrightLike,
  channel?: string,
): Promise<{ ok: true; browser: BrowserLike } | { ok: false; reason: string }> {
  const attempts: Array<string | undefined> = channel ? [channel] : [undefined, 'chrome', 'msedge'];
  const errors: string[] = [];
  for (const ch of attempts) {
    try {
      const browser = await pw.chromium.launch(ch ? { headless: true, channel: ch } : { headless: true });
      return { ok: true, browser };
    } catch (e) {
      errors.push(`${ch ?? 'chromium'}: ${firstLine(errText(e))}`);
    }
  }
  return { ok: false, reason: errors.join('；') };
}

async function defaultLoadPlaywright(): Promise<PlaywrightLike | undefined> {
  try {
    // 用變數當 specifier：讓 TS 不把 playwright 變成編譯期硬相依，未安裝也能 build
    const spec = 'playwright';
    const mod: unknown = await import(spec);
    const pw = mod as Partial<PlaywrightLike>;
    return typeof pw.chromium?.launch === 'function' ? (pw as PlaywrightLike) : undefined;
  } catch {
    return undefined;
  }
}

function skipped(reason: string, log: Logger): VisualResult {
  log.info({ reason }, '視覺驗證跳過');
  // ok:true 是刻意的：環境缺件不該把不需要視覺驗證的任務拖紅
  return {
    status: 'skipped',
    skipReason: reason,
    checks: [{ name: 'visual', ok: true, detail: `跳過：${reason}` }],
    screenshots: [],
    metrics: [],
    diffs: [],
  };
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch { /* 清理失敗不影響結果 */ }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function joinUrl(baseUrl: string, route: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${route.replace(/^\/+/, '')}`;
}

export function slug(route: string): string {
  const s = route.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'root';
}

function pctText(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

function lastLines(s: string, n: number): string {
  return s.split('\n').filter((l) => l.trim()).slice(-n).join(' | ');
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? s;
}

/** 把「不知道是什麼」的回傳值壓成一行短字串，放進失敗訊息給人看。 */
function preview(v: unknown): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    s = String(v);
  }
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
