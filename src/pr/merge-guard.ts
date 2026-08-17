import { execa } from 'execa';
import type { CheckRunInput } from '../store/ledger.js';
import { createMergeTree } from './merge-verify.js';
import { runExperiment, formatExperiments, type ExperimentBudget, type ExperimentResult } from './blame.js';
import { resolveBaseFreshness, type BaseFreshness } from '../git/base-freshness.js';
import type { VerifierLike } from '../contracts.js';
import type { VerifierConfig } from '../worker/verifier.js';
import type { MergeVerdict, GateReport } from '../types.js';
import { driftFeedback, type DriftVerdict } from './drift-judge.js';
import type { Logger } from '../observability/logger.js';

export interface MergeGuardInput {
  /** 所屬 repo——判斷者要靠它去任務板查規格（程式不預抓）。 */
  repo?: string;
  repoPath: string; // 本地 clone（工作區）
  branch: string; // 群組分支
  base: string; // 目標分支（如 main）
  verifierConfig: VerifierConfig;
  /** 本群在做什麼（任務標題）。給語意飄移判斷當背景。 */
  taskTitles?: string[];
}

/** git 執行結果的最小形狀（供注入假件；預設實作用 execa）。 */
export interface GitExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 可注入的 git 執行器：測試靠它模擬「fetch 失敗 / 沒有 remote」而不必真的連網。 */
export type GitRunner = (repoPath: string, args: string[], opts?: { timeoutMs?: number }) => Promise<GitExecResult>;

export interface MergeGuardOptions {
  /**
   * 歸咎實驗的配額。未給 → 不跑實驗（紅燈只回報原始輸出，行為與先前相同）。
   * 用完時 runExperiment 會明講，不靜默降級。
   */
  experimentBudget?: ExperimentBudget;
  /** 實驗的記帳出口（每次都要進 check_runs，那是事後查證的唯一依據）。 */
  recordCheck?: (input: CheckRunInput) => void;
  /**
   * 驗收樹建好之後的準備工作（node_modules、本機設定檔）。
   * **一定要接**：沒有依賴就跑關卡，紅的是環境不是程式碼，而 agent 會去修一個沒壞的東西。
   */
  /**
   * 驗收樹建好之後、跑關卡之前的準備。
   *
   * 用途只有一個：把主 clone 的本機設定檔（.env 之類）帶進來——它沒有版控對照物，
   * 不帶就是沒有，而 Laravel 少了 .env 連 DB 都連不上。**依賴不走這裡**
   * （複製來的版本對不上這棵樹的 lockfile，見 group-runner 的說明），
   * 那要寫進專案自己的驗收指令。
   */
  prepareTree?: (treePath: string, repoPath: string) => Promise<void>;
  /**
   * 拋棄式驗收樹建在哪。未給 → 系統暫存目錄（`tmpdir()`）。
   *
   * 為什麼要能指定：那是三種工作區裡唯一不在 dataRoot 底下的。樹平常跑完會自己刪，
   * 但 daemon 在驗到一半掛掉時會留下——而開機對帳只掃 dataRoot 底下，掃不到 /tmp。
   * 指到 dataRoot 底下之後，「誰負責清」這件事才是完整的。
   */
  treeRoot?: string;
  /** 取最新 base 的 remote 名稱。預設 'origin' */
  remote?: string;
  /** 是否在 attempt() 前 fetch 最新 base。預設 true；設 false 等於明示「接受基於本地狀態的驗證」 */
  fetch?: boolean;
  /** fetch 逾時（毫秒）。預設 60 秒——網路卡住不可以讓整個守衛無限期停住 */
  fetchTimeoutMs?: number;
  /** 注入 git 執行器（測試用） */
  git?: GitRunner;
  /** 每次 attempt() 回報一次 base 新鮮度，讓呼叫端能把「但書」帶進通知/PR 內文 */
  onBaseFreshness?: (freshness: BaseFreshness) => void;
  /**
   * 現在跑到哪一段。**這是這條路上唯一會動的東西**——守衛期間任務狀態不變、
   * 群組狀態不變、事件表沒有新列，而它可以跑十幾分鐘（建樹、npm ci、build、
   * test、歸咎實驗、飄移判斷）。沒有它，畫面上就是「什麼都沒在做」。
   * 未接 → 什麼都不做（純顯示用，不影響判決）。
   */
  onStage?: (detail: string) => void;
  /**
   * 語意飄移的**判斷層**（rebase 成功且測試綠之後才跑）。未注入就不跑這層。
   * 見 drift-judge.ts：前兩層是事實（衝突、紅燈），這一層是判斷（意圖打不打架）。
   */
  driftJudge?: DriftJudgeLike;
}

/** 語意飄移判斷者的最小介面（供注入假件）。 */
export interface DriftJudgeLike {
  judge(input: {
    cwd: string;
    mergeBase: string;
    baseRef: string;
    branch: string;
    taskTitles: string[];
    repo?: string;
  }): Promise<DriftVerdict>;
}

/**
 * base 新鮮度：這次驗證到底是對著「remote 上真實的 base」還是「可能過期的本地 base」跑的。
 * 語意飄移最常見的成因就是「別人已經把變更推上 remote」，所以沒 fetch 到最新 base 的綠燈
 * 是假綠燈。取不到時系統不該整個失敗（離線／本地無 remote 的 repo 也要能跑），
 * 但一定要把 caveat 標示出來——把「假綠燈」降級成「有但書的綠燈」。
 */
export type { BaseFreshness };

/**
 * 合併守衛（DESIGN §9 / 需求 7）：合併前把最新 base rebase 進分支，再「在合併後狀態」
 * 重跑 build/test。這能抓出 diff 看不出來的**語意飄移**——沒有文字衝突，但依賴的函式/檔案
 * 被別的 PR 刪改，導致合併後建置/測試失敗。
 *
 * 註：實際 merge 到 base 與 push 屬外部動作，由呼叫端在守衛回 ok 後執行。
 */
export class MergeGuard {
  constructor(
    private verifier: VerifierLike,
    private log: Logger,
    private opts: MergeGuardOptions = {},
  ) {}

  private async git(repoPath: string, args: string[], opts?: { timeoutMs?: number }): Promise<GitExecResult> {
    if (this.opts.git) return await this.opts.git(repoPath, args, opts);
    const r = await execa('git', ['-C', repoPath, ...args], {
      reject: false,
      ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
    // 逾時/被訊號中止時 exitCode 會是 undefined，一律當成失敗（寧可降級也不要誤判成功）
    return { exitCode: r.exitCode ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  /**
   * 驗「這一群併上最新 base 之後好不好」。
   *
   * ── 這裡不再 rebase 群分支 ──
   *
   * 先前是 `checkout 群分支 → rebase 最新 base → 驗 → force-push`。
   * 現在改成在**一棵拋棄式的樹**上 detach 到群分支的 sha、把 base 併進來、跑關卡、
   * 跑完連樹一起刪掉（見 pr/merge-verify.ts）。
   *
   * 換來兩件事：
   * 1. **群分支一位元都不會被改寫** → 永遠不需要 force push，整整一類不可逆動作消失。
   * 2. 「使用者在 GitHub 上看到的那份」與「我們驗過的那份」始終是同一個東西。
   *
   * 代價：PR 會一直顯示 "out of date"（我們驗的是合併後狀態，不是 head）。那是正常的。
   */
  async attempt(input: MergeGuardInput): Promise<MergeVerdict> {
    const { repoPath, branch, base } = input;

    // 1) 取最新 base。不 fetch 的話驗的是「本地那份可能停在舊 commit 的 base」，
    //    也就是一個不存在的世界——而真正會出事的情況恰恰就是 remote 有新變更。
    this.opts.onStage?.(`取最新的 ${base}`);
    const freshness = await this.resolveBase(repoPath, base);
    this.opts.onBaseFreshness?.(freshness);
    if (freshness.caveat) {
      this.log.warn({ branch, base, ref: freshness.ref, caveat: freshness.caveat }, 'Merge Guard：base 新鮮度有但書');
    }

    // 分岔點要在併之前取：併完就再也算不出「base 在本群動工之後多了什麼」，
    // 而那正是判斷意圖有沒有打架的材料。
    const mergeBase = (
      await this.git(repoPath, ['merge-base', branch, freshness.ref])
    ).stdout.trim();

    // 2) 建拋棄式驗收樹（群分支 ＋ 最新 base）。併不起來就是 code_conflict。
    this.opts.onStage?.(`把 ${freshness.ref} 併進 ${branch}，建一棵拋棄式驗收樹`);
    const built = await createMergeTree({
      repoPath,
      branch,
      baseRef: freshness.ref,
      log: this.log,
      // **一定要把注入的 git 傳下去。** 不傳的話守衛會用到兩條不同的 git 路徑：
      // 一條可被測試/呼叫端替換，一條寫死用 execa——那種不一致查起來特別花時間。
      git: (cwd, args) => this.git(cwd, args),
      ...(this.opts.treeRoot ? { root: this.opts.treeRoot } : {}),
      ...(this.opts.prepareTree ? { prepare: (tree: string) => this.opts.prepareTree!(tree, repoPath) } : {}),
    });
    if (!built.ok) {
      if (built.reason === 'conflict') {
        this.log.warn({ branch, base: freshness.ref, conflicts: built.conflicts }, 'Merge Guard：併上最新 base 有衝突');
        return {
          ok: false,
          reason: 'code_conflict',
          detail: withCaveat(freshness, built.output),
          conflicts: built.conflicts,
        };
      }
      this.log.error({ branch, base: freshness.ref }, 'Merge Guard：驗收樹建不起來，前置條件不成立');
      return { ok: false, reason: 'precondition_failed', detail: withCaveat(freshness, built.output) };
    }

    const { tree } = built;
    try {
      // 3) 在「合併後狀態」重跑關卡。
      this.opts.onStage?.('在合併後的狀態重跑關卡（build／test）');
      const gate = await this.verifier.check({ cwd: tree.path, config: input.verifierConfig });
      if (!gate.green) {
        // **紅了不代表是這一群造成的。**
        //
        // 實跑（2026-08-04）：PR #54 只新增 6 個檔，被一個完全無關的後端測試擋下，
        // 判成 semantic_drift 回灌給 agent 修三輪——它根本改不到那個檔。16 個任務堵住。
        //
        // 所以先做兩個實驗，把「是誰造成的」變成有證據可判的事：
        //   1. 同一顆 base 上（不含本群）跑幾次 → base 本來就紅嗎？
        //   2. 同一個合併後狀態再跑一次 → 這個紅穩定嗎？
        // 實驗**只產生事實**，結論由讀的人下（見 pr/blame.ts）。
        this.opts.onStage?.('紅了 → 跑歸咎實驗（base 本來就紅嗎？這個紅穩定嗎？）');
        const evidence = await this.gatherBlameEvidence(input, freshness.ref, tree.path);
        this.log.warn(
          { branch, base: freshness.ref, experiments: evidence.length },
          'Merge Guard：併上最新 base 後建置/測試紅，已跑實驗釐清歸咎',
        );
        return {
          ok: false,
          reason: 'semantic_drift',
          detail: withCaveat(freshness, failSummary(gate)) + (evidence.length ? `\n\n── 歸咎實驗 ──${formatExperiments(evidence)}` : ''),
        };
      }

      // 4) 事實層都綠了 → 判斷層：兩邊的意圖有沒有打架。
      //    抓的是「能編譯、測試也綠，但合起來的產品行為自相矛盾」——量不出來，
      //    只有讀得懂意圖的才判斷得出。判不出來就放行（見 drift-judge.ts）。
      this.opts.onStage?.('關卡都綠 → 判斷語意飄移（兩邊的意圖有沒有打架）');
      const drift = await this.judgeDrift(input, freshness.ref, mergeBase, tree.path);
      if (drift) return drift;

      this.log.info(
        { branch, base: freshness.ref, fetched: freshness.fetched, baseSha: tree.verifiedBaseSha.slice(0, 8) },
        freshness.caveat
          ? 'Merge Guard：併上最新 base 重測通過（但書：未能確認 base 為最新）'
          : 'Merge Guard：併上最新 base 重測通過，可安全合併',
      );
      return { ok: true, baseSha: tree.verifiedBaseSha };
    } finally {
      // 拋棄式的東西一定要收掉——留著會累積在磁碟上，而且下一輪撞名就是一整群報銷
      await tree.dispose();
    }
  }

  /**
   * 紅燈時跑兩個實驗，回傳原始事實。
   *
   * **這裡不下結論。** 不比對輸出內容、不算相似度、不判斷「像不像同一個失敗」——
   * 那些都是猜，換一個測試框架就全錯而且沒有人會知道。只回報 exit code 與全文，
   * 讓讀得懂的人（合併者 agent、或人）自己判斷。
   *
   * 沒接實驗器就回空陣列：這是額外的證據，不是必要條件。
   */
  private async gatherBlameEvidence(
    input: MergeGuardInput,
    baseRef: string,
    treePath: string,
  ): Promise<ExperimentResult[]> {
    const budget = this.opts.experimentBudget;
    if (!budget || budget.runsLeft <= 0) return [];
    const runCheck = async (cwd: string): Promise<{ exitCode?: number; output: string }> => {
      const g = await this.verifier.check({ cwd, config: input.verifierConfig });
      return { exitCode: g.green ? 0 : 1, output: failSummary(g) };
    };
    const out: ExperimentResult[] = [];
    try {
      // 實驗 1：**base 自己**紅不紅（不含本群的任何東西）。
      // 這一個就能答出 PR #54 那題——base 上也紅，那就不是這一群造成的。
      out.push(
        await runExperiment({
          repoPath: input.repoPath,
          branch: baseRef, // 直接拿 base 當「分支」：樹會 detach 到它，併自己是 no-op
          spec: { ref: baseRef, times: 2, question: '不含本群的 base 上，同一組關卡紅不紅' },
          runCheck,
          budget,
          log: this.log,
          git: (cwd, args) => this.git(cwd, args),
          ...(this.opts.treeRoot ? { treeRoot: this.opts.treeRoot } : {}),
          ...(this.opts.prepareTree ? { prepare: (tree: string) => this.opts.prepareTree!(tree, input.repoPath) } : {}),
          ...(input.repo ? { repo: input.repo } : {}),
          ...(this.opts.recordCheck ? { record: this.opts.recordCheck } : {}),
        }),
      );
      // 實驗 2：同一個合併後狀態再跑一次——這個紅穩不穩定。
      // 樹已經在手上，直接重跑，不必再建一棵。
      const again = await runCheck(treePath);
      out.push({
        spec: { ref: 'merged', times: 1, question: '同一個合併後狀態再跑一次，結果一樣嗎' },
        runs: [{ attempt: 1, ...(again.exitCode === undefined ? {} : { exitCode: again.exitCode }), output: again.output, startedAt: 0, endedAt: 0 }],
      });
      budget.runsLeft -= 1;
    } catch (e) {
      this.log.warn({ err: e instanceof Error ? e.message : String(e) }, '歸咎實驗失敗，只回報原始紅燈');
    }
    return out;
  }

  /**
   * 語意飄移的判斷層。回傳 undefined 代表放行。
   *
   * 全程不擲錯：這一層是在所有事實層都綠之後才跑的額外保險，任何失敗都不該
   * 讓一組已經通過的客觀證據被否決。
   */
  private async judgeDrift(
    input: MergeGuardInput,
    baseRef: string,
    mergeBase: string,
    /** 判斷者要看的工作區＝**驗收樹**（合併後狀態），不是主 clone。 */
    treePath: string,
  ): Promise<MergeVerdict | undefined> {
    const judge = this.opts.driftJudge;
    if (!judge || !mergeBase) return undefined;
    try {
      // **程式不先算 diff。** 只給 ref，判斷者自己用唯讀 git 去看——
      // 要先看檔案清單縮範圍、要挑哪幾個檔細看、要看幾次，由它決定。
      // 先前是程式算好兩份 diff 各砍到 40K（只留頭）貼進 prompt：改動一大就有整批檔案
      // 它根本沒看到，而且不知道被砍了什麼。
      const verdict = await judge.judge({
        // 判斷者要站在**合併後狀態**上看：那才是它要判斷「意圖有沒有打架」的世界
        cwd: treePath,
        mergeBase,
        baseRef,
        branch: input.branch,
        taskTitles: input.taskTitles ?? [],
        ...(input.repo ? { repo: input.repo } : {}),
      });
      if (verdict.status !== 'conflict') return undefined;
      this.log.warn(
        { branch: input.branch, findings: verdict.findings.length },
        'Merge Guard：合併後意圖打架 → 語意飄移',
      );
      return { ok: false, reason: 'semantic_drift', detail: driftFeedback(verdict.findings) };
    } catch (e) {
      this.log.warn(
        { branch: input.branch, err: e instanceof Error ? e.message : String(e) },
        '語意飄移判斷失敗，略過（不阻斷已全綠的合併）',
      );
      return undefined;
    }
  }

  /**
   * 決定要 rebase 到哪個 ref，並回報這個決定的但書。
   * 實作在 git/base-freshness.ts —— **開工時與合併時必須用同一套判斷**，
   * 兩份實作遲早會分歧，而分歧的症狀是「合併守衛說 base 是最新的，agent 卻在舊碼上做」。
   */
  private async resolveBase(repoPath: string, base: string): Promise<BaseFreshness> {
    return resolveBaseFreshness(repoPath, base, {
      git: (p, a, o) => this.git(p, a, o),
      ...(this.opts.remote ? { remote: this.opts.remote } : {}),
      ...(this.opts.fetch !== undefined ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.fetchTimeoutMs ? { fetchTimeoutMs: this.opts.fetchTimeoutMs } : {}),
    });
  }

  /**
   * 合併後守衛：在 base 上再跑一次 DoD（合併已完成後呼叫）。
   * 紅燈代表 main 被弄壞 → 呼叫端應自動 revert。
   */
  async postMergeCheck(repoPath: string, base: string, config: VerifierConfig): Promise<MergeVerdict> {
    const co = await this.git(repoPath, ['checkout', base]);
    if (co.exitCode !== 0) {
      this.log.error({ base }, 'Merge Guard：合併後無法切到 base，無法驗證');
      return { ok: false, reason: 'precondition_failed', detail: tail(`${co.stdout}\n${co.stderr}`) };
    }
    const gate = await this.verifier.check({ cwd: repoPath, config });
    if (!gate.green) return { ok: false, reason: 'post_merge_red', detail: failSummary(gate) };
    return { ok: true };
  }
}

/** 失敗詳情前面掛上 base 但書，讓「這次驗證的前提」跟結論一起被人看到。 */
function withCaveat(freshness: BaseFreshness, detail: string): string {
  return freshness.caveat ? `⚠ ${freshness.caveat}\n${detail}` : detail;
}

function failSummary(gate: GateReport): string {
  return gate.checks
    .filter((c) => !c.ok)
    .map((c) => `[${c.name}] ${c.detail}${c.failingIds?.length ? `（${c.failingIds.join(', ')}）` : ''}`)
    .join('\n');
}

function tail(s: string, n = 20): string {
  return s.split('\n').slice(-n).join('\n');
}
