import { execa } from 'execa';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { CheckResult, GateReport, TaskCategory } from '../types.js';
import type { Logger } from '../observability/logger.js';
import { decomposeShellCommand, evaluateCommandRedline } from './agent-runtime.js';
import { uiCheck, type UiVerdict } from './ui-judge.js';
import { DEFAULT_BREAKPOINTS, VisualVerifier, classifyVisualError, toGateFragment, type VisualConfig, type VisualResult } from './visual.js';

/** 指令型關卡（跑得到 exit code 的那種）。 */
export type VerifierCommand = 'typecheck' | 'lint' | 'build' | 'test';

/** 視覺關卡的觸發時機（見 decideVisualGate 的規則說明）。 */
export type VisualGateWhen = 'auto' | 'always' | 'never';

/** 判定「這個任務要不要跑視覺」所需的最小任務資訊（呼叫端可不帶）。 */
/**
 * 任務資訊。
 *
 * **每個欄位都有實際用途，漏傳會靜默降級：**
 * · baseRef 沒給 → 介面判斷者沒有唯讀 git → 分不出「這次弄的」與「本來就有的」
 *   → 把既有瑕疵算到這次頭上，擋掉不該擋的 PR
 * · title / description 沒給 → 判斷者不知道這個畫面「該達成什麼目的」
 *
 * 同一個疏漏犯過三次（group-runner 的 Merge Guard、orchestrator 的合併路徑、
 * 重做迴圈），每次症狀都一樣難查。所以這裡集中說明，並提供 taskHintOf() 一次組好，
 * 呼叫端不要再自己拼欄位。
 */
export interface VisualTaskHint {
  id?: string;
  category?: TaskCategory;
  /**
   * 比較基準（例如 'origin/main'）。判斷者要靠它查「這次改了什麼」，
   * 才分得出「這次弄壞的」與「本來就有的」。未給時判斷者只能保守地全部當成新引入。
   */
  baseRef?: string;
  /** 給截圖判斷者的背景：判斷「畫面有沒有達成目的」需要知道目的是什麼。 */
  title?: string;
  description?: string;
}

/**
 * 視覺關卡設定。沿用 VisualConfig 的所有旋鈕，但把「截圖／基準目錄」換成 *Root：
 * 實際目錄由 Verifier 依任務再開一層，而且**強制落在 worktree 之外**——
 * 截圖若寫進 worktree 會被算進 git diff，既污染 PR 也讓「diff 非空」的 DoD 判定失真。
 */
export interface VisualGateConfig extends Omit<VisualConfig, 'screenshotDir' | 'baselineDir'> {
  /** 截圖根目錄（相對路徑以 daemon 的 process.cwd() 為基準）。預設 ./data/screenshots */
  screenshotRoot?: string;
  /** 基準截圖根目錄；未設 → 不做視覺回歸（只截圖 + 爆版偵測） */
  baselineRoot?: string;
  /** 何時跑。預設 'auto' */
  when?: VisualGateWhen;
  /** when='auto' 時視為「視覺任務」的類別。預設 ['design'] */
  categories?: string[];
}

/**
 * 「diff 非空」關卡設定（DESIGN §5 的 DoD 明列此項）。
 *
 * **只有 Worker 會設定它**，而且每個任務帶自己的基準；Merge Guard 的 rebase 重測、
 * 合併後檢查不設（那些情境本來就不該有未提交變更）。沒設 = 不跑這關（向後相容）。
 */
export interface DiffGateConfig {
  /**
   * 比較基準：**本任務開始時的 HEAD**。
   * 不能用群分支起點——群內多個任務共用同一 worktree，前面的任務已被 commitAll 提交，
   * 用群起點當基準會讓「第二個任務什麼都沒做」被前一個任務的 commit 誤判成有變更。
   */
  baseRef: string;
}

/** 可設定的驗證指令（來自 projects.yaml 的 commands）＋ 視覺／diff 關卡設定。 */
export interface VerifierConfig {
  typecheck?: string;
  lint?: string;
  build?: string;
  test?: string;
  /** 未設 → 完全不啟瀏覽器（見 decideVisualGate） */
  visual?: VisualGateConfig;
  /** 未設 → 不跑「diff 非空」關卡（Merge Guard 等重測情境） */
  diff?: DiffGateConfig;
  /** 單一專案指令的執行逾時（毫秒）。未設／非正數 → 用 VerifierDeps.commandTimeoutMs 或內建預設。 */
  timeoutMs?: number;
}

/** VisualVerifier 的結構介面（供注入假件；單元測試不該真的開瀏覽器）。 */
export interface VisualVerifierLike {
  verify(input: {
    cwd: string;
    config: VisualConfig;
    /** dev server 還活著時要做的事（判斷者要導頁互動）；回傳的關卡會併進結果。 */
    whileServerUp?: (ctx: {
      baseUrl: string;
      screenshots: string[];
      hints: CheckResult[];
    }) => Promise<CheckResult[]>;
  }): Promise<VisualResult>;
}

/**
 * 從任務與專案設定組出完整的 VisualTaskHint。
 * 呼叫端一律用它，不要自己拼欄位——漏一個就是一次靜默降級（見 VisualTaskHint 說明）。
 */
export function taskHintOf(
  task: { id: string; category?: TaskCategory; title?: string; description?: string },
  proj: { baseBranch: string; remote?: string },
): VisualTaskHint {
  return {
    id: task.id,
    ...(task.category ? { category: task.category } : {}),
    ...(task.title ? { title: task.title } : {}),
    ...(task.description ? { description: task.description } : {}),
    baseRef: `${proj.remote ?? 'origin'}/${proj.baseBranch}`,
  };
}

/** 介面判斷者的最小介面（供注入假件）。 */
export interface UiJudgeLike {
  judge(input: {
    cwd: string;
    baseRef?: string;
    taskId?: string;
    screenshots: string[];
    baseUrl?: string;
    routes?: string[];
    hints?: string[];
    taskTitle: string;
    taskDescription?: string;
  }): Promise<UiVerdict>;
}

export interface VerifierDeps {
  /** 注入假的視覺驗證器；未注入時才 lazy 建立真的（避免無視覺任務也付出成本） */
  visual?: VisualVerifierLike;
  /**
   * 截圖判斷者：量測之外，讓 agent 實際看那張圖。未注入就不跑這層，量測不受影響。
   */
  uiJudge?: UiJudgeLike;
  /** daemon 層的指令逾時預設（毫秒）；專案可用 VerifierConfig.timeoutMs 覆寫。 */
  commandTimeoutMs?: number;
  /**
   * 視覺關卡「執行期例外」（量測端自己壞掉，不是環境缺件）的通知鉤子。
   * 未注入 → 只寫 error log（優雅降級：沒接通知的環境不能因此壞掉）。
   * 這種故障靠 agent 修不好（問題在調度器/量測程式），必須讓人知道。
   */
  onVisualError?: (info: { cwd: string; detail: string }) => void | Promise<void>;
}

// 固定關卡順序：便宜/快的先跑（早失敗早回饋）。視覺關卡最貴，永遠排最後。
const ORDER: VerifierCommand[] = ['typecheck', 'lint', 'build', 'test'];

const DEFAULT_SCREENSHOT_ROOT = './data/screenshots';
export const DEFAULT_VISUAL_CATEGORIES = ['design'];

/**
 * 專案指令的預設逾時：10 分鐘。
 * 沒有逾時的話，一個 hang 住的 test/build（等待輸入、卡在 watch 模式、等不到的 port）
 * 會永遠凍住整個 daemon —— 這條迴圈是單執行緒的監督迴圈，沒人會來救它。
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;

/** git 查詢的逾時：git 只是讀本地狀態，10 秒還沒回應等於出事了。 */
const GIT_TIMEOUT_MS = 10_000;

/**
 * 固定的失敗識別字串。**絕不可帶變動內容**（檔名、數量、耗時），
 * 否則結果簽章每輪都變，無進展偵測（§D11）就永遠抓不到空轉。
 */
const ID_NO_CHANGES = 'no-changes';
const ID_DIFF_UNAVAILABLE = 'unavailable';
const ID_TIMEOUT = 'timeout';
const ID_NO_GATES = 'no-gates';
/** 視覺關卡執行期例外（量測端壞掉）。不帶錯誤訊息，簽章才穩定。 */
const ID_VISUAL_ERROR = 'visual-error';
/** 關卡指令命中紅線而被拒絕執行。 */
const ID_REDLINE = 'redline';
/** 指令連跑都跑不起來（execa 丟例外）。 */
const ID_EXEC_ERROR = 'exec-error';

/** 零變更時回灌給 agent 的說明（要能讓它知道「該做事」而不是「該收工」）。 */
const NO_CHANGES_DETAIL = [
  '相對本任務開始時的 HEAD，工作區沒有任何變更（沒有新增、修改或刪除任何檔案）。',
  '完成的定義是「程式碼真的改了且驗證通過」，不是「判斷已經做過了」。',
  '請實際做出這個任務需要的修改；若你確信需求已由既有程式碼完全滿足，',
  '請不要直接結束，改用 ask_human 說明理由並附上佐證（檔案與行號）。',
].join('\n');

/** 專案完全沒設驗證指令時的說明（問題在設定，不在程式碼——要講清楚，別讓 agent 亂改）。 */
const NO_GATES_DETAIL = [
  '本專案沒有任何可執行的 DoD 關卡（projects.yaml 的 commands 未設 typecheck/lint/build/test，',
  '也沒有視覺關卡與 diff 關卡），無法機器判定「完成」。',
  '這是**設定問題**，不是程式碼問題：請補上專案的驗證指令，不要為了讓關卡變綠而修改程式。',
].join('\n');

/** 視覺結果自相矛盾（status=failed 但沒有任何失敗 check）時補上的說明。 */
const VISUAL_INCONSISTENT_DETAIL =
  '視覺驗證回報失敗，但沒有提供任何失敗明細（量測端契約不一致）。' +
  '無法確認頁面是好的，因此不算通過——這是調度器的問題，請不要為此修改專案程式碼。';

/** 只有 diff 關卡可跑時的提醒：驗證強度很弱，報告與 log 都要講明。 */
const ONLY_DIFF_DETAIL =
  '本專案未設定任何驗證指令（typecheck/lint/build/test），DoD 僅檢查「有變更」——' +
  '這是最低限度的把關，正確性完全依賴後續 reviewer 與人工 review。';

export type VisualGateDecision = { run: true } | { run: false; reason: string };

/**
 * 視覺關卡的觸發規則（需求 6-3：只有需要時才跑，其餘完全不啟瀏覽器）：
 *  1. 沒有 visual 設定、沒有 devServer、或沒列 routes → 不跑。
 *     routes 是專案層「這些頁面要保持不爆版」的明示 opt-in，沒列就代表這專案不做視覺驗證。
 *  2. when='never' → 不跑；when='always' → 一律跑。
 *  3. when='auto'（預設）：
 *     - 呼叫端有帶任務資訊 → 類別屬於 categories（預設 design）才跑，
 *       避免修 bug 的任務每一輪都白啟一次瀏覽器。
 *     - 沒帶任務資訊（例如 Merge Guard 合併前重測）→ 跑。
 *       那正是 DESIGN §9 的「關鍵路徑驗證」，且專案既然列了 routes 就是要求把關。
 */
export function decideVisualGate(config: VisualGateConfig | undefined, task?: VisualTaskHint): VisualGateDecision {
  if (!config) return { run: false, reason: '未設定視覺關卡' };
  if (!config.devServer) return { run: false, reason: '專案未設定 commands.devServer' };
  if (!config.routes || config.routes.length === 0) return { run: false, reason: '未指定視覺驗證路徑（visual.routes）' };
  if (config.when === 'never') return { run: false, reason: '設定為 when=never' };
  if (config.when === 'always') return { run: true };

  const category = task?.category;
  if (category === undefined) return { run: true };
  const categories = config.categories?.length ? config.categories : DEFAULT_VISUAL_CATEGORIES;
  return categories.includes(category)
    ? { run: true }
    : { run: false, reason: `任務類別 ${category} 不在視覺類別 ${categories.join('/')} 內` };
}

/**
 * 決定截圖／基準目錄的實體位置。硬性條件：**不得落在 worktree（cwd）內**，
 * 否則 git diff 會多出一堆 png。設定值若不慎指進 worktree，會被改導到預設根目錄並警告。
 */
export function resolveVisualDirs(input: {
  cwd: string;
  config: VisualGateConfig;
  key: string;
  log?: Logger;
}): { screenshotDir: string; baselineDir?: string } {
  const { cwd, config, key, log } = input;
  const shotRoot = outsideWorktree(config.screenshotRoot ?? DEFAULT_SCREENSHOT_ROOT, cwd, log);
  const dirs: { screenshotDir: string; baselineDir?: string } = { screenshotDir: join(shotRoot, safeKey(key)) };
  // 基準要跨任務、跨輪次沿用，所以不再依任務分層——每個專案自己設一個 root 即可
  if (config.baselineRoot) dirs.baselineDir = outsideWorktree(config.baselineRoot, cwd, log);
  return dirs;
}

/**
 * DoD 關卡（DESIGN.md §5/§D14）：由調度器實跑專案自己的指令判定「完成」，
 * 而非相信 agent 自稱。並計算「結果簽章」供無進展偵測使用。
 *
 * 關卡順序：diff 非空 → typecheck → lint → build → test → 視覺（截圖 + 爆版偵測 + 視覺回歸）。
 * 四條鐵律：
 *  - **diff 非空排第一**：agent 一行都沒改也可能宣稱完成，而綠燈會一路走到 complete_task，
 *    MCP 的 done 不可逆（還會解鎖下游、開出空 diff 的 PR）。零變更時後面的關卡一定跟上一輪
 *    同結果，跑了只是白燒幾分鐘，所以直接短路回饋。
 *  - 視覺關卡**環境缺件**（沒 playwright／沒瀏覽器／dev server 起不來）一律 skipped，**不把 DoD 弄紅**；
 *    但**執行期例外**（量測/比對/截圖程式自己壞掉）判紅並通知——「量測端壞掉 → 靜默綠燈」
 *    是最危險的誤判，爆版頁面只要讓量測程式丟例外就能過關。分類規則見 visual.ts 的 classifyVisualError。
 *  - **出錯一律不算通過**：指令跑不起來、關卡指令命中部署紅線，全部判紅（fail-closed），
 *    沒有任何一條「例外 → 綠燈」的路。
 *  - 簽章只吃「關卡名 + 穩定 failingIds」，不吃像素差百分比／耗時，否則無進展偵測會失效。
 */
export class Verifier {
  private lazyVisual?: VisualVerifierLike;

  constructor(private log: Logger, private deps: VerifierDeps = {}) {}

  async check(input: { cwd: string; config: VerifierConfig; task?: VisualTaskHint }): Promise<GateReport> {
    const checks: CheckResult[] = [];
    // 「有效關卡數」：真的驗到東西的關卡。說明性質的 check（視覺跳過、設定缺漏）不算數，
    // 否則「什麼都沒驗」會被當成綠燈（沿用原本「空驗證不算通過」的規則）。
    let effective = 0;

    // 關卡 0：diff 非空。未帶 config.diff（Merge Guard 等重測）→ 不跑。
    if (input.config.diff) {
      const diff = await this.runDiffCheck(input.cwd, input.config.diff);
      checks.push(diff);
      effective += 1;
      if (!diff.ok) {
        this.log.warn(
          { cwd: input.cwd, baseRef: input.config.diff.baseRef, reason: diff.failingIds?.[0] },
          'DoD：工作區相對任務起點沒有可判定的變更 → 略過其餘關卡，直接回灌「尚未實作」',
        );
        return this.finish(false, checks);
      }
    }

    let commandsRun = 0;
    for (const name of ORDER) {
      const cmd = input.config[name];
      if (!cmd) continue;
      checks.push(await this.runCheck(name, cmd, input.cwd, timeoutOf(input.config, this.deps)));
      commandsRun += 1;
      effective += 1;
    }

    let screenshots: string[] | undefined;
    let visualRan = false;

    const visual = await this.runVisualGate(input, checks.every((c) => c.ok));
    if (visual) {
      checks.push(...visual.checks);
      if (visual.screenshots.length > 0) screenshots = visual.screenshots;
      if (visual.status !== 'skipped') {
        effective += visual.checks.length;
        visualRan = true;
      }
    }

    // 專案沒設任何驗證指令時的兩種處置（缺陷 3：以前一律不綠且無回饋 → Worker 永遠跑不完）：
    if (effective === 0) {
      // 真的什麼都沒得驗 → 仍不綠（空驗證不能當通過），但要明講問題出在設定而非程式碼，
      // 否則回饋是一片空白，agent 只能亂猜亂改。
      checks.push({ name: 'config', ok: false, detail: NO_GATES_DETAIL, failingIds: [ID_NO_GATES] });
      this.log.error({ cwd: input.cwd }, 'DoD：本專案沒有任何可執行的關卡，無法判定完成（請補 projects.yaml 的 commands）');
    } else if (commandsRun === 0 && !visualRan) {
      // 只剩 diff 關卡且它過了 → 算綠（否則任務永遠跑不完），但驗證強度很弱，必須留痕。
      checks.push({ name: 'config', ok: true, detail: ONLY_DIFF_DETAIL });
      this.log.warn({ cwd: input.cwd }, 'DoD：本專案未設定驗證指令，僅以「diff 非空」判定完成（把關強度很弱）');
    }

    const green = effective > 0 && checks.every((c) => c.ok);
    return this.finish(green, checks, screenshots);
  }

  /** 統一收尾：算簽章、記 log、組報告（短路路徑也走這裡，確保簽章規則一致）。 */
  private finish(green: boolean, checks: CheckResult[], screenshots?: string[]): GateReport {
    const signature = this.signature(checks);
    this.log.info({ green, checks: checks.map((c) => `${c.name}:${c.ok ? 'ok' : 'fail'}`), signature }, 'DoD 關卡結果');
    return screenshots ? { green, checks, signature, screenshots } : { green, checks, signature };
  }

  /**
   * 「diff 非空」關卡。三種結果都用**固定** failingId，簽章才穩定：
   *  - 有變更 → ok
   *  - 零變更 → no-changes（回灌「尚未實作」讓 agent 續做，不把任務標 error）
   *  - 判定不了（git 出錯）→ unavailable，**保守擋下**：空 diff 誤判成綠燈會直接走到
   *    complete_task，而 MCP 的 done 不可逆；擋下最多是多跑幾輪並觸發卡牆通知。
   */
  private async runDiffCheck(cwd: string, cfg: DiffGateConfig): Promise<CheckResult> {
    const r = await changedSince(cwd, cfg.baseRef);
    if (!r.ok) {
      return {
        name: 'diff',
        ok: false,
        detail: `無法判定工作區是否有變更（${r.detail}）。在確認變更之前不能判定完成。`,
        failingIds: [ID_DIFF_UNAVAILABLE],
      };
    }
    if (r.files.length === 0) {
      return { name: 'diff', ok: false, detail: NO_CHANGES_DETAIL, failingIds: [ID_NO_CHANGES] };
    }
    return { name: 'diff', ok: true, detail: `${r.files.length} 個檔案有變更` };
  }

  /** 回傳 undefined 代表「這輪根本沒跑視覺」（不列 check、不影響簽章）。 */
  private async runVisualGate(
    input: { cwd: string; config: VerifierConfig; task?: VisualTaskHint },
    commandsGreen: boolean,
  ): Promise<{ checks: CheckResult[]; screenshots: string[]; status: VisualResult['status'] } | undefined> {
    const config = input.config.visual;
    const decision = decideVisualGate(config, input.task);
    if (!decision.run) {
      this.log.debug({ reason: decision.reason }, '視覺關卡：不需執行');
      return undefined;
    }
    if (!commandsGreen) {
      // 指令關卡就紅了：dev server 多半也起不來，白花一次逾時；先把回饋集中在該修的東西上
      this.log.info('指令關卡未綠，本輪略過視覺關卡');
      return undefined;
    }

    const cfg = config as VisualGateConfig; // decision.run === true 保證存在

    // 目錄解析與建立驗證器也放進 try：這段若丟例外同樣是「量測端壞掉」，
    // 不能讓它冒到 check() 外面（那條路一樣不會有人判紅）。
    try {
      const dirs = resolveVisualDirs({ cwd: input.cwd, config: cfg, key: input.task?.id ?? basename(input.cwd), log: this.log });
      const visualConfig: VisualConfig = { ...stripGateOnly(cfg), ...dirs };
      // 判斷者在 dev server 還活著時跑：它要自己導頁、自己操作，
      // 而不是只看某個路由某一瞬間的靜態截圖（按下去之後長怎樣，PNG 上永遠看不到）。
      const r = await this.visual().verify({
        cwd: input.cwd,
        config: visualConfig,
        whileServerUp: async (ctx) => {
          const judged = await this.judgeUi(input, {
            ...ctx,
            routes: visualConfig.routes,
            // 判斷者要知道「證據只涵蓋這幾個寬度」，才有辦法去看縫隙
            capturedWidths: (visualConfig.breakpoints ?? DEFAULT_BREAKPOINTS).map((b) => b.width),
          });
          return judged ? [judged] : [];
        },
      });
      const fragment = toGateFragment(r);
      // 防呆：回報 failed 卻沒有任何 ok:false 的 check，green 會照樣是 true（靜默綠燈）。
      // 這是 VisualVerifier 與 Verifier 之間的契約，寧可多一條紅燈也不能讓它默默通過。
      const checks =
        r.status === 'failed' && fragment.checks.every((c) => c.ok)
          ? [...fragment.checks, { name: 'visual', ok: false, detail: VISUAL_INCONSISTENT_DETAIL, failingIds: [ID_VISUAL_ERROR] }]
          : fragment.checks;
      return { checks, screenshots: fragment.screenshots, status: r.status };
    } catch (e) {
      const detail = errText(e);
      // 分兩類處置。以前這裡是 catch-all → 一律「跳過（綠）」，等於：只要量測程式丟例外，
      // 爆版頁面就能靜默過關——這是最危險的誤判，必須拆開。
      if (classifyVisualError(e) === 'environment') {
        // 環境缺件（沒 playwright／沒瀏覽器／dev server 的執行檔不存在）：跳過但講明白，
        // 不能因為這台機器沒瀏覽器就誤殺整個 DoD。
        this.log.info({ err: detail }, '視覺關卡：環境缺件（不影響 DoD），視為跳過');
        return {
          checks: [{ name: 'visual', ok: true, detail: `跳過（環境缺件，非程式碼問題）：${detail}` }],
          screenshots: [],
          status: 'skipped',
        };
      }
      // 執行期例外：量測/比對/截圖程式自己壞了，這一輪根本沒驗到頁面 → 不算通過。
      // failingIds 用固定字串，反覆發生時簽章一致，才會被無進展偵測抓到（不會無限重試）。
      await this.notifyVisualError(input.cwd, detail);
      return {
        checks: [
          {
            name: 'visual',
            ok: false,
            detail:
              `視覺關卡執行期例外（量測端故障，不是頁面本身的問題）：${detail}\n` +
              '這一輪沒有任何頁面被真正量測到，因此不能算通過。這通常是調度器/量測程式的問題，' +
              '不是被驗專案的程式碼問題——請不要為了讓這關變綠而修改程式碼。',
            failingIds: [ID_VISUAL_ERROR],
          },
        ],
        screenshots: [],
        status: 'failed',
      };
    }
  }

  /**
   * 通知「量測端壞掉」。這種故障 agent 修不好（問題在調度器），只能讓人知道。
   * 沒注入鉤子 → 只寫 error log（優雅降級）；鉤子自己丟錯也不能反過來炸掉 DoD。
   */
  private async notifyVisualError(cwd: string, detail: string): Promise<void> {
    this.log.error({ cwd, err: detail }, '視覺關卡執行期例外（量測端故障）：判定未通過並通知');
    const hook = this.deps.onVisualError;
    if (!hook) return;
    try {
      await hook({ cwd, detail });
    } catch (e) {
      this.log.warn({ err: errText(e) }, '視覺關卡例外通知失敗（不影響 DoD 判定）');
    }
  }

  /**
   * 讓 agent 看截圖判斷畫面。回傳 undefined 代表這一層不適用（沒注入判斷者、沒截圖）。
   *
   * 全程不擲錯：這是量測之外的主觀判斷層，任何失敗都不該讓量測結果被推翻。
   */
  private async judgeUi(
    input: { cwd: string; task?: VisualTaskHint },
    ctx: { baseUrl?: string; screenshots: string[]; hints?: CheckResult[]; routes?: string[]; capturedWidths?: number[] },
  ): Promise<CheckResult | undefined> {
    // 沒有材料就談不上判斷（量測本身失敗時另有紅燈）
    if (ctx.screenshots.length === 0 && !ctx.baseUrl) return undefined;

    const judge = this.deps.uiJudge;
    if (!judge) {
      // 視覺關卡跑了、也拿到畫面，卻沒有任何判斷者——那這一關等於沒有把關者。
      // 這是接線問題，要吵出來，不能安靜地綠燈通過。
      return {
        name: 'visual:judge',
        ok: false,
        detail: '視覺關卡已啟用，但沒有接上介面判斷者（uiJudge）。沒有把關者的關卡不放行。',
      };
    }
    try {
      const verdict = await judge.judge({
        cwd: input.cwd,
        ...(input.task?.id ? { taskId: input.task.id } : {}),
        // 判斷者在 worktree 裡，但沒有 Bash——給它唯讀的 git，它才查得到新舊
        ...(input.task?.baseRef ? { baseRef: input.task.baseRef } : {}),
        screenshots: ctx.screenshots,
        // 有 dev server 就讓它自己導頁、自己互動——靜態截圖看不到「按下去之後」
        ...(ctx.baseUrl ? { baseUrl: ctx.baseUrl } : {}),
        ...(ctx.routes?.length ? { routes: ctx.routes } : {}),
        ...(ctx.capturedWidths?.length ? { capturedWidths: ctx.capturedWidths } : {}),
        // 量測到的可疑之處只當線索，不當結論
        ...(ctx.hints?.length ? { hints: ctx.hints.map((h) => h.detail) } : {}),
        taskTitle: input.task?.title ?? input.task?.id ?? '（未提供任務標題）',
        ...(input.task?.description ? { taskDescription: input.task.description } : {}),
      });
      return uiCheck(verdict);
    } catch (e) {
      this.log.warn({ err: errText(e) }, '介面判斷失敗，略過（不影響量測結果）');
      return undefined;
    }
  }

  /** 真的要用時才建立（沒視覺任務的專案完全不碰 playwright）。 */
  private visual(): VisualVerifierLike {
    this.lazyVisual ??= this.deps.visual ?? new VisualVerifier({ log: this.log });
    return this.lazyVisual;
  }

  /**
   * 跑一個專案指令。**一定要有逾時**：hang 住的 test/build（等待輸入、watch 模式、
   * 等不到的 port）會永久凍結整個 daemon。逾時視為該關卡失敗並在 detail 明說原因，
   * 讓 agent 知道是「跑不完」而不是「測試紅」。
   *
   * 註：shell:true 時 execa 殺的是 shell；孫行程理論上可能殘留（子行程自己 detach 的情況），
   * 但至少監督迴圈能繼續走，不會整個調度器卡死。
   */
  private async runCheck(name: string, cmd: string, cwd: string, timeoutMs: number): Promise<CheckResult> {
    // 先過部署紅線：關卡指令是以 shell 實跑的，`npm run build` 可能一路展開到 `firebase deploy`。
    // 命中就**拒絕執行**並判紅（fail-closed）——寧可讓任務卡住等人看，也不能誤觸真實部署。
    const redline = await evaluateGateCommandRedline(cmd, cwd);
    if (redline.deny) {
      this.log.error({ name, cmd, cwd, reason: redline.reason }, 'DoD 關卡指令命中部署紅線，已拒絕執行');
      return {
        name,
        ok: false,
        detail:
          `已拒絕執行本關卡指令：${redline.reason}\n` +
          `關卡指令：${cmd}\n` +
          '調度器絕不代為執行部署（DESIGN §10）。請把部署動作移出這個關卡會跑到的 script' +
          '（例如改由 CI 或人工執行），或在 projects.yaml 改用不含部署的指令。',
        // 固定 id：設定沒改的話每輪都一樣，無進展偵測才抓得到（不會無限重試）
        failingIds: [ID_REDLINE],
      };
    }

    let res: Awaited<ReturnType<typeof runShell>>;
    try {
      res = await runShell(cmd, cwd, timeoutMs);
    } catch (e) {
      // reject:false 之外仍可能丟（cwd 不存在、無法 spawn shell）。跑都跑不起來 = 沒驗到東西，
      // 絕不能當成通過。
      this.log.error({ name, cmd, cwd, err: errText(e) }, 'DoD 關卡指令無法執行');
      return {
        name,
        ok: false,
        detail: `指令無法執行（沒有驗到任何東西，因此不算通過）：${errText(e)}\n關卡指令：${cmd}`,
        failingIds: [ID_EXEC_ERROR],
      };
    }
    const output = res.all ?? `${res.stdout}\n${res.stderr}`;

    if (res.timedOut) {
      this.log.error({ name, cmd, cwd, timeoutMs }, 'DoD 關卡逾時，已終止該指令');
      return {
        name,
        ok: false,
        detail:
          `逾時：指令超過 ${timeoutMs}ms 仍未結束，已被終止。` +
          `\n可能是測試/建置卡住（等待輸入、watch 模式、等不到的服務），或這個專案本來就需要更長時間` +
          `（可調 projects.yaml 的驗證逾時設定）。\n最後輸出：\n${lastLines(output, 20)}`,
        // 固定 id：逾時反覆發生時簽章要一致，才會被無進展偵測抓到
        failingIds: [ID_TIMEOUT],
      };
    }

    if (res.exitCode === undefined) {
      // 連 shell 都 spawn 不起來（cwd 不存在、沒有 /bin/sh）：exitCode 是 undefined、輸出全空。
      // 不會被誤判成通過，但若不特別說明，回饋就是一片空白，agent 只能亂改。
      const why = res.shortMessage || res.message || '未知原因';
      this.log.error({ name, cmd, cwd, err: why }, 'DoD 關卡指令無法執行');
      return {
        name,
        ok: false,
        detail: `指令無法執行（沒有驗到任何東西，因此不算通過）：${firstLine(why)}\n關卡指令：${cmd}`,
        failingIds: [ID_EXEC_ERROR],
      };
    }

    const ok = res.exitCode === 0;
    return {
      name,
      ok,
      detail: ok ? 'ok' : lastLines(output, 30),
      failingIds: ok ? undefined : extractFailingIds(output),
    };
  }

  /**
   * 結果簽章 = 失敗關卡名 + 正規化後的失敗測試/錯誤 id 之排序雜湊。
   * 「同一批東西一直紅」→ 簽章不變 → 無進展偵測會抓到。
   * 視覺關卡刻意只提供穩定的 failingIds（斷點+路徑、元素定位字串），
   * 浮動的像素差百分比只出現在 detail，不會進簽章。
   */
  private signature(checks: CheckResult[]): string {
    const failing = checks
      .filter((c) => !c.ok)
      .map((c) => `${c.name}:${[...(c.failingIds ?? [])].sort().join(',')}`)
      .sort();
    return createHash('sha1').update(failing.join('|')).digest('hex').slice(0, 16);
  }
}

/** 實跑關卡指令（獨立成函式，讓呼叫端拿得到 execa 依選項推導出的結果型別）。 */
function runShell(cmd: string, cwd: string, timeoutMs: number) {
  return execa(cmd, {
    cwd,
    shell: true,
    reject: false,
    all: true,
    timeout: timeoutMs,
    forceKillAfterDelay: 5_000, // SIGTERM 後還不死就 SIGKILL
  });
}

// ── 關卡指令的部署紅線（工具層擋不到的那一半） ──
//
// 失敗情境：repo 的 package.json 在 agent 開工前就寫著 `"build": "vite build && firebase deploy"`。
// agent-runtime 的工具層紅線只擋「agent 自己改 package.json」，擋不到「本來就有」的內容，
// 而 Verifier 會用 shell 實跑 `npm run build` —— 於是驗證動作本身觸發真實部署。
// 所以這裡在執行前把「指令 → package.json script → 巢狀 script」展開，逐段過同一套紅線。
//
// 限制（刻意的，寫明以免誤以為滴水不漏）：
//  - 只解析靜態的 script 字串。script 若靠環境變數、外部腳本檔（`bash deploy-all.sh`）或
//    `npm run $TARGET` 動態決定實際指令，這裡展不開（`deploy*.sh` 本身另有紅線擋）。
//  - 遞迴層數上限 MAX_SCRIPT_DEPTH，且同名 script 只展一次（互相呼叫不會無限迴圈）。
//  - 讀不到／解析不了 package.json 就當作「無從判斷」放行（優雅降級：非 Node 專案照跑）。

/** package.json script 的展開層數上限（`build → bundle → deploy` 這種鏈只追這麼深）。 */
export const MAX_SCRIPT_DEPTH = 3;

const PACKAGE_MANAGERS = new Set(['npm', 'yarn', 'pnpm', 'bun']);
/** npm 的內建別名：`npm test` 等同 `npm run test`（其餘子指令不會跑 script）。 */
const NPM_SCRIPT_ALIASES = new Set(['test', 'start', 'stop', 'restart']);

export interface GateRedlineVerdict {
  deny: boolean;
  reason?: string;
}

/**
 * 關卡指令（含它會展開到的 package.json script）是否命中部署紅線。
 * 判定本身完全唯讀：只讀 package.json，不執行任何東西。
 */
export async function evaluateGateCommandRedline(cmd: string, cwd: string): Promise<GateRedlineVerdict> {
  const direct = evaluateCommandRedline(cmd);
  if (direct.deny) return { deny: true, reason: direct.reason };

  const scripts = await readPackageScripts(cwd);
  if (Object.keys(scripts).length === 0) return { deny: false };

  const seen = new Set<string>();
  // chain 只是給人看的呼叫鏈（build → bundle），讓「到底是哪一層踩到紅線」一目了然
  let frontier = scriptRefs(cmd, scripts).map((name) => ({ name, chain: name }));

  for (let depth = 0; depth < MAX_SCRIPT_DEPTH && frontier.length > 0; depth += 1) {
    const next: Array<{ name: string; chain: string }> = [];
    for (const { name, chain } of frontier) {
      if (seen.has(name)) continue;
      seen.add(name);
      const body = scripts[name];
      if (body === undefined) continue;
      const verdict = evaluateCommandRedline(body);
      if (verdict.deny) {
        return { deny: true, reason: `${verdict.reason}（來自 package.json script「${chain}」：${body}）` };
      }
      for (const ref of scriptRefs(body, scripts)) next.push({ name: ref, chain: `${chain} → ${ref}` });
    }
    frontier = next;
  }
  return { deny: false };
}

/**
 * 一段 shell 指令會跑到哪些 package.json script。
 * 連 npm 的 pre/post 鉤子一起算：`"postbuild": "firebase deploy"` 同樣會被 `npm run build` 帶起來。
 */
function scriptRefs(cmd: string, scripts: Record<string, string>): string[] {
  const out: string[] = [];
  for (const tokens of decomposeShellCommand(cmd).commands) {
    const name = scriptNameOf(tokens, scripts);
    if (name === undefined) continue;
    for (const n of [`pre${name}`, name, `post${name}`]) {
      if (Object.hasOwn(scripts, n)) out.push(n);
    }
  }
  return out;
}

/**
 * 這段指令實際要跑的 script 名。**只認 package.json 真的有的名字**，
 * 這樣 `pnpm install`、`npm ci` 這類子指令不會被誤判成 script。
 */
function scriptNameOf(tokens: string[], scripts: Record<string, string>): string | undefined {
  const head = basename(tokens[0] ?? '');
  if (!PACKAGE_MANAGERS.has(head)) return undefined;
  const args = tokens.slice(1);
  const runIdx = args.findIndex((t) => t === 'run' || t === 'run-script');
  if (runIdx >= 0) {
    const name = args.slice(runIdx + 1).find((t) => !t.startsWith('-'));
    return name !== undefined && Object.hasOwn(scripts, name) ? name : undefined;
  }
  // 沒有 run：yarn/pnpm/bun 可以省略，npm 只有少數內建別名會轉呼叫同名 script
  const first = args.find((t) => !t.startsWith('-'));
  if (first === undefined || !Object.hasOwn(scripts, first)) return undefined;
  if (head === 'npm' && !NPM_SCRIPT_ALIASES.has(first)) return undefined;
  return first;
}

/** 讀 cwd 的 package.json scripts；沒有／壞掉 → 空表（無從判斷就放行，不能讓非 Node 專案跑不動）。 */
async function readPackageScripts(cwd: string): Promise<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** 指令逾時：專案設定 > daemon 預設 > 內建 10 分鐘。非正數視為未設（不接受「關閉逾時」）。 */
function timeoutOf(config: VerifierConfig, deps: VerifierDeps): number {
  const candidate = config.timeoutMs ?? deps.commandTimeoutMs;
  return candidate !== undefined && candidate > 0 ? candidate : DEFAULT_COMMAND_TIMEOUT_MS;
}

// ── diff 非空關卡的 git 查詢 ──

/** git 空樹的固定 sha：repo 還沒有任何 commit 時當基準，等於「所有檔案都是新增」。 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

type GitOut = { ok: true; stdout: string } | { ok: false; detail: string };

async function git(cwd: string, args: string[]): Promise<GitOut> {
  try {
    const r = await execa('git', ['-C', cwd, ...args], { reject: false, timeout: GIT_TIMEOUT_MS });
    if (r.exitCode !== 0) return { ok: false, detail: `git ${args[0]} 失敗：${lastLines(r.stderr || r.stdout, 3).trim()}` };
    return { ok: true, stdout: r.stdout };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 取目前 HEAD，供呼叫端記錄「本任務開始時」的基準。
 * - 正常 → commit sha
 * - repo 存在但還沒有任何 commit → 空樹 sha（照樣能算出「有沒有新增檔案」）
 * - 根本不是 git 工作區 → undefined（呼叫端據此**停用** diff 關卡，優雅降級而非卡死）
 */
export async function gitHeadRef(cwd: string): Promise<string | undefined> {
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  if (head.ok && head.stdout.trim()) return head.stdout.trim();
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return inside.ok && inside.stdout.trim() === 'true' ? EMPTY_TREE : undefined;
}

export type WorkspaceChanges = { ok: true; files: string[] } | { ok: false; detail: string };

/**
 * 相對 baseRef 有沒有任何變更。兩路都要查，缺一不可：
 *  - `git diff --name-only <baseRef>`：工作區 vs baseRef，涵蓋「已 commit」與「改了還沒 commit」
 *    的追蹤檔（agent 自己 commit 過也算數）。
 *  - `git ls-files --others --exclude-standard`：**未追蹤的新檔案**——新增檔案也是變更，
 *    但還沒進 index，上面那道 diff 看不到它。
 *
 * 截圖不會混進來：Verifier 已強制把截圖目錄導到 worktree 之外（見 resolveVisualDirs）。
 */
export async function changedSince(cwd: string, baseRef: string): Promise<WorkspaceChanges> {
  const tracked = await git(cwd, ['diff', '--name-only', '-z', baseRef, '--']);
  if (!tracked.ok) return tracked;
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!untracked.ok) return untracked;

  const files = [...splitNul(tracked.stdout), ...splitNul(untracked.stdout)].filter(countsAsChange);
  return { ok: true, files: [...new Set(files)] };
}

/** -z 輸出以 NUL 分隔（避免路徑含空白/中文被 git 加引號跳脫）。 */
function splitNul(s: string): string[] {
  return s.split('\0').filter((x) => x.length > 0);
}

/**
 * node_modules 不算「本任務的變更」：GroupRunner 會把它 symlink 進 worktree，
 * 專案若沒把它加進 .gitignore 就會被列成未追蹤檔——那正是我們要防的「空 diff 誤判成有做事」。
 */
function countsAsChange(path: string): boolean {
  return path !== 'node_modules' && !path.startsWith('node_modules/');
}

/** 去掉只有 Verifier 看得懂的欄位（*Root/when/categories），剩下的才是 VisualVerifier 的設定。 */
function stripGateOnly(config: VisualGateConfig): VisualConfig {
  const rest: Record<string, unknown> = { ...config };
  for (const k of ['screenshotRoot', 'baselineRoot', 'when', 'categories']) delete rest[k];
  return rest as VisualConfig;
}

/** 解成絕對路徑，並確保不在 worktree 內；若在，改導到預設根目錄（再不行就用系統暫存）。 */
function outsideWorktree(dir: string, cwd: string, log?: Logger): string {
  const abs = resolve(dir);
  if (!isInside(cwd, abs)) return abs;

  const fallback = resolve(DEFAULT_SCREENSHOT_ROOT);
  const safe = isInside(cwd, fallback) ? join(tmpdir(), 'botone-screenshots') : fallback;
  log?.warn({ dir: abs, fallback: safe }, '截圖目錄落在 worktree 內（會污染 git diff），已改導到 worktree 外');
  return safe;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 目錄名只留安全字元（任務 id 可能帶 / 或空白）。 */
function safeKey(key: string): string {
  const s = key.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'default';
}

function lastLines(s: string, n: number): string {
  const lines = s.split('\n');
  return lines.slice(-n).join('\n');
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? s;
}

/**
 * 從輸出盡力抽出失敗識別（TAP / node:test / jest 常見格式）。
 * 需正規化掉「每次都變」的雜訊（如耗時 (0.85ms)），否則簽章不穩、無進展偵測失效。
 */
function extractFailingIds(output: string): string[] {
  const ids = new Set<string>();
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    const tap = /^not ok \d+ - (.+)$/.exec(line);
    const mark = /^[✖✗×]\s+(.+)$/.exec(line);
    const fail = /^FAIL\s+(.+)$/.exec(line);
    let g = tap?.[1] ?? mark?.[1] ?? fail?.[1];
    if (!g) continue;
    g = g.replace(/\s*\(\d[\d.]*\s*m?s\)\s*$/i, '').trim(); // 去耗時 (0.85ms)/(1.2s)
    if (!g || /^(failing|passing|todo|skipped)\s+tests:?$/i.test(g)) continue; // 濾掉區段標題
    ids.add(g);
  }
  return [...ids];
}
