import { execa } from 'execa';
import { splitOutput, type CheckContext, type CheckRecorder } from './check-recorder.js';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { CheckResult, GateReport, TaskCategory } from '../types.js';
import type { Logger } from '../observability/logger.js';
import { decomposeShellCommand, evaluateCommandRedline } from './agent-runtime.js';
import { EMPTY_TREE, changedSince } from '../git/status.js';

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
 * 視覺設定：**這個專案的畫面要看哪幾個頁面、哪些寬度**。
 *
 * 量測堆疊（截圖比對、版面稽核、UiJudge）已於第 15 片整套退場，畫面由審查者自己
 * 開瀏覽器判斷。但 routes 留著——那是專案在說「這個 repo 的畫面在哪裡」，
 * 審查者需要它才知道要導到哪一頁；`when`/`categories` 則是專案層唯一的關閉開關
 * （沒列 routes ＝ 這個專案不做視覺驗證）。
 */
export interface VisualGateConfig {
  /** 要看的路由（相對 dev server 根路徑）。空的 ＝ 這個專案不做視覺驗證。 */
  routes?: string[];
  /** 要看的視窗寬度。 */
  breakpoints?: { name: string; width: number; height?: number }[];
  /** 起 dev server 的指令與埠（審查者要靠它把畫面跑起來）。 */
  devServer?: string;
  devPort?: number;
  /** 截圖根目錄（相對路徑以 daemon 的 process.cwd() 為基準）。預設 ./data/screenshots */
  screenshotRoot?: string;
  /** 基準截圖根目錄。 */
  baselineRoot?: string;
  /** 何時跑。預設 'auto' */
  when?: VisualGateWhen;
  /** when='auto' 時視為「視覺任務」的類別。 */
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

export interface VerifierDeps {
  /** daemon 層的指令逾時預設（毫秒）；專案可用 VerifierConfig.timeoutMs 覆寫。 */
  commandTimeoutMs?: number;
  /**
   * 關卡執行的記帳出口。未注入 → 不記（測試與還沒接線的呼叫端）。
   *
   * 這是**旁路**：記帳失敗不改變關卡結果，也不往外冒。
   */
  checkRecorder?: CheckRecorder;
  /**
   * 記帳需要的上下文（哪個 repo、哪條分支、哪一種工作區、誰要求跑的）。
   * 沒有它就不知道這一列屬於誰，記了也查不出東西——所以缺它時視同沒接記帳。
   */
  checkContext?: CheckContext;
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
 * 失敗**種類**的固定碼。這是路由碼，不是從輸出猜出來的語意——
 * 它由驗證器自己產生（我拒絕執行了／我逾時了／我根本沒跑起來），
 * 是一組封閉的列舉，下游靠它分辨「這三種執行失敗」而不必去讀那段中文。
 *
 * 已經刪掉的是另一件事：先前還有一個 `extractFailingIds(output)`，
 * 用正則從測試輸出裡撈「失敗的測試叫什麼」。那個只認得 TAP／node:test／jest 三種格式，
 * 換一套工具鏈就靜默回空陣列——那是程式在猜語意，讀輸出是 agent 的事。
 */
const ID_NO_CHANGES = 'no-changes';
const ID_DIFF_UNAVAILABLE = 'unavailable';
const ID_TIMEOUT = 'timeout';
const ID_NO_GATES = 'no-gates';
/**
 * check_runs 裡代表「設定事實」的固定 command 標記（不是真的跑過的指令）。
 * 讀的人靠它分辨「這個專案沒設關卡」與「關卡還沒跑」——那兩件事在一張空表上長得一樣。
 */
export const NO_GATES_COMMAND = '（設定事實）本專案沒有任何可執行的關卡';
export const ONLY_DIFF_COMMAND = '（設定事實）只有 diff 非空關卡，沒有任何驗證指令';
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

  // ── `auto` 的語意：專案設了 devServer ＋ routes 就跑 ──
  //
  // 先前是「卡片類別要字面等於 'design'」。那個判準有兩個問題：
  // 1. **類別是任務板上一個人隨手填的字串**，跟這次改了什麼毫無關係。'dev' 是本系統
  //    自己文件裡的一級類別——一張把 Vue 元件改到破版的 'dev' 卡，
  //    typecheck/lint/build/test 全綠 → 綠燈 → 開 PR，而報告上完全看不出
  //    「視覺從來沒驗過」。
  // 2. 專案已經**明確 opt-in**（設了 commands.devServer 又列了 visual.routes）
  //    卻還是不跑，那個設定等於白設。
  //
  // 要縮小範圍的話由使用者在 `visual.categories` 明列自己的詞彙——
  // 那是「放寬預設、允許收緊」，而不是「預設就收緊、而且用我猜的詞」。
  const categories = config.categories;
  if (!categories?.length) return { run: true };
  const category = task?.category;
  if (category === undefined) return { run: true };
  return categories.includes(category)
    ? { run: true }
    : { run: false, reason: `任務類別 ${category} 不在專案自訂的視覺類別 ${categories.join('/')} 內` };
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
  constructor(private log: Logger, private deps: VerifierDeps = {}) {}

  async check(input: { cwd: string; config: VerifierConfig; task?: VisualTaskHint; signal?: AbortSignal }): Promise<GateReport> {
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
      checks.push(await this.runCheck(name, cmd, input.cwd, timeoutOf(input.config, this.deps), input.signal));
      commandsRun += 1;
      effective += 1;
    }


    // 專案沒設任何驗證指令時的兩種處置（缺陷 3：以前一律不綠且無回饋 → Worker 永遠跑不完）：
    if (effective === 0) {
      // 真的什麼都沒得驗 → 仍不綠（空驗證不能當通過），但要明講問題出在設定而非程式碼，
      // 否則回饋是一片空白，agent 只能亂猜亂改。
      checks.push({ name: 'config', ok: false, detail: NO_GATES_DETAIL, failingIds: [ID_NO_GATES] });
      this.log.error({ cwd: input.cwd }, 'DoD：本專案沒有任何可執行的關卡，無法判定完成（請補 projects.yaml 的 commands）');
      // **「零關卡」必須是一件查得到的事實，不是「查無資料」。**
      //
      // check_runs 是事後查證唯一的依據，而審查者／合併者去查的時候，
      // 「這個專案沒設關卡」與「關卡還沒跑」在一張空表上長得一模一樣——
      // 前者代表「這裡永遠不會有把關」，後者代表「再等一下」，處置完全相反。
      this.recordConfigFact(NO_GATES_COMMAND, NO_GATES_DETAIL);
    } else if (commandsRun === 0) {
      // 只剩 diff 關卡且它過了 → 算綠（否則任務永遠跑不完），但驗證強度很弱，必須留痕。
      checks.push({ name: 'config', ok: true, detail: ONLY_DIFF_DETAIL });
      this.log.warn({ cwd: input.cwd }, 'DoD：本專案未設定驗證指令，僅以「diff 非空」判定完成（把關強度很弱）');
      this.recordConfigFact(ONLY_DIFF_COMMAND, ONLY_DIFF_DETAIL);
    }

    const green = effective > 0 && checks.every((c) => c.ok);
    return this.finish(green, checks);
  }

  /**
   * 把一件「設定層面的事實」記成 check_run。
   *
   * exit code 刻意不填：那代表**沒有指令跑過**，與「跑了而且失敗（非 0）」是不同的事。
   * command 用固定字串當標記，讀的人（與之後的查詢）靠它認出這是設定事實而非執行結果。
   */
  private recordConfigFact(command: string, detail: string): void {
    const ctx = this.deps.checkContext;
    if (!this.deps.checkRecorder || !ctx) return;
    const now = Date.now();
    this.deps.checkRecorder.record({
      repo: ctx.repo,
      ...(ctx.branch ? { branch: ctx.branch } : {}),
      workspaceKind: ctx.workspaceKind,
      command,
      ...(ctx.headSha ? { headSha: ctx.headSha } : {}),
      ...(ctx.verifiedBaseSha ? { verifiedBaseSha: ctx.verifiedBaseSha } : {}),
      output: detail,
      requestedBy: ctx.requestedBy,
      startedAt: now,
      endedAt: now,
    });
  }

  /** 統一收尾：記 log、組報告（短路路徑也走這裡）。 */
  private finish(green: boolean, checks: CheckResult[], screenshots?: string[]): GateReport {
    this.log.info({ green, checks: checks.map((c) => `${c.name}:${c.ok ? 'ok' : 'fail'}`) }, 'DoD 關卡結果');
    return screenshots ? { green, checks, screenshots } : { green, checks };
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

  /**
   * ── 視覺關卡整段退場（第 15 片）──
   *
   * 這裡原本有一套量測堆疊：起 dev server、逐斷點截圖、算像素差、跑版面稽核規則、
   * 再交給一個 UiJudge 判「這樣算不算破版」（visual.ts 1005 行 ＋ layout-audit.ts 860 行
   * ＋ ui-judge.ts 535 行）。
   *
   * 換掉它的是**審查者自己開瀏覽器去看**（第 12 片）：它拿唯讀的瀏覽器工具、自己導頁、
   * 自己判斷，而且放行時必須填 uiChecked（看了哪幾條路由與哪些寬度，或為什麼沒看），
   * 空白會被退回。
   *
   * 為什麼不是兩個都留：同一個畫面跑兩套判斷、付兩次 LLM 的錢，而且舊的那套可以把
   * 新放行書已經放行的東西判紅——兩個閘門互相打架，人分不出到底是誰擋的。
   *
   * `visual` 設定裡的 routes 沒有跟著刪：那是專案在說「這個 repo 要看哪幾個頁面」，
   * 審查者需要它。
   */

  private async runCheck(name: string, cmd: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CheckResult> {
    const startedAt = Date.now();
    const inner = await this.runCheckInner(name, cmd, cwd, timeoutMs, signal);
    const ctx = this.deps.checkContext;
    if (this.deps.checkRecorder && ctx) {
      this.deps.checkRecorder.record({
        repo: ctx.repo,
        ...(ctx.branch ? { branch: ctx.branch } : {}),
        workspaceKind: ctx.workspaceKind,
        command: cmd,
        ...(ctx.headSha ? { headSha: ctx.headSha } : {}),
        ...(ctx.verifiedBaseSha ? { verifiedBaseSha: ctx.verifiedBaseSha } : {}),
        // undefined 代表**沒跑起來**（紅線擋下、spawn 失敗），與「跑了但失敗」是不同的事實
        ...(inner.exitCode === undefined ? {} : { exitCode: inner.exitCode }),
        output: inner.output,
        requestedBy: ctx.requestedBy,
        startedAt,
        endedAt: Date.now(),
      });
    }
    return inner.result;
  }

  private async runCheckInner(
    name: string,
    cmd: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ result: CheckResult; exitCode?: number; output: string }> {
    // 先過部署紅線：關卡指令是以 shell 實跑的，`npm run build` 可能一路展開到 `firebase deploy`。
    // 命中就**拒絕執行**並判紅（fail-closed）——寧可讓任務卡住等人看，也不能誤觸真實部署。
    const redline = await evaluateGateCommandRedline(cmd, cwd);
    if (redline.deny) {
      this.log.error({ name, cmd, cwd, reason: redline.reason }, 'DoD 關卡指令命中部署紅線，已拒絕執行');
      const detail =
        `已拒絕執行本關卡指令：${redline.reason}\n` +
        `關卡指令：${cmd}\n` +
        '調度器絕不代為執行部署（DESIGN §10）。請把部署動作移出這個關卡會跑到的 script' +
        '（例如改由 CI 或人工執行），或在 projects.yaml 改用不含部署的指令。';
      return { result: { name, ok: false, detail, failingIds: [ID_REDLINE] }, output: detail };
    }

    let res: Awaited<ReturnType<typeof runShell>>;
    try {
      res = await runShell(cmd, cwd, timeoutMs, signal);
    } catch (e) {
      // reject:false 之外仍可能丟（cwd 不存在、無法 spawn shell）。跑都跑不起來 = 沒驗到東西，
      // 絕不能當成通過。
      this.log.error({ name, cmd, cwd, err: errText(e) }, 'DoD 關卡指令無法執行');
      const detail = `指令無法執行（沒有驗到任何東西，因此不算通過）：${errText(e)}\n關卡指令：${cmd}`;
      return { result: { name, ok: false, detail, failingIds: [ID_EXEC_ERROR] }, output: detail };
    }
    const output = res.all ?? `${res.stdout}\n${res.stderr}`;

    if (res.timedOut) {
      this.log.error({ name, cmd, cwd, timeoutMs }, 'DoD 關卡逾時，已終止該指令');
      const detail =
        `逾時：指令超過 ${timeoutMs}ms 仍未結束，已被終止。` +
        `\n可能是測試/建置卡住（等待輸入、watch 模式、等不到的服務），或這個專案本來就需要更長時間` +
        `（可調 projects.yaml 的驗證逾時設定）。\n被終止前的輸出：\n${splitOutput(output).inline}`;
      return {
        result: { name, ok: false, detail, failingIds: [ID_TIMEOUT] },
        ...(res.exitCode === undefined ? {} : { exitCode: res.exitCode }),
        output,
      };
    }

    if (res.exitCode === undefined) {
      // 連 shell 都 spawn 不起來（cwd 不存在、沒有 /bin/sh）：exitCode 是 undefined、輸出全空。
      // 不會被誤判成通過，但若不特別說明，回饋就是一片空白，agent 只能亂改。
      const why = res.shortMessage || res.message || '未知原因';
      this.log.error({ name, cmd, cwd, err: why }, 'DoD 關卡指令無法執行');
      const detail = `指令無法執行（沒有驗到任何東西，因此不算通過）：${firstLine(why)}\n關卡指令：${cmd}`;
      return { result: { name, ok: false, detail, failingIds: [ID_EXEC_ERROR] }, output: output || detail };
    }

    const ok = res.exitCode === 0;
    // **紅了不把輸出交出去。**
    //
    // 程式跑了指令、拿到一個非 0 的結束碼——它知道的就只有這兩件事。
    // 「哪裡壞了」要讀輸出才知道，而讀輸出是 agent 的事：它有 Bash、在同一個 cwd、
    // 剛剛才自己跑過，想重跑、想只跑一個檔案、想加 --reporter 都可以。
    //
    // 先前這裡貼整份輸出（最多 256KB／條，四條都紅可以灌近 1MB 進 prompt，而且**每一輪重貼**）。
    // 那不是幫忙：vitest 的進度條、gradle 的下載列、tsc 的全量錯誤會把規格與 diff 擠出 context，
    // 真正的錯誤行埋在中間；一旦截斷，agent 連「被砍掉的是什麼」都不知道，
    // 卻會以為自己看到了全部。
    //
    // 全文完整落在 check_runs（含 output_path）——那是給人事後查的，不是給 prompt 的傳輸管道。
    return {
      result: {
        name,
        ok,
        detail: ok ? 'ok' : `跑了 \`${cmd}\`，exit code ${res.exitCode}`,
        command: cmd,
        exitCode: res.exitCode,
      },
      exitCode: res.exitCode,
      output,
    };
  }

}

/** 實跑關卡指令（獨立成函式，讓呼叫端拿得到 execa 依選項推導出的結果型別）。 */
function runShell(cmd: string, cwd: string, timeoutMs: number, signal?: AbortSignal) {
  return execa(cmd, {
    cwd,
    shell: true,
    reject: false,
    all: true,
    timeout: timeoutMs,
    // 中止時 execa 會殺掉子行程；沒有這個的話 daemon 收到 SIGTERM，
    // 一個跑了半小時的 `npm test` 照樣會撐到寬限逾時、然後變成孤兒。
    ...(signal ? { cancelSignal: signal } : {}),
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

// changedSince 的定義搬到 src/git/status.ts（那裡是「相對基準有沒有變更」的唯一來源）。
// 這裡 re-export 讓既有的 `import { changedSince } from './verifier.js'` 不必改。
export { changedSince, type WorkspaceChanges } from '../git/status.js';

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

