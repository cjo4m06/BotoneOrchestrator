import { execa } from 'execa';
import { createMergeTree } from './merge-verify.js';
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
  /**
   * 重跑 DoD 時要帶下去的任務資訊（含 baseRef）。
   * 沒有它，這一關的介面判斷者就沒有 git 可查，分不出新舊問題。
   */
  task?: { id?: string; category?: string; title?: string; description?: string; baseRef?: string };
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
   * 驗收樹建好之後的準備工作（node_modules、本機設定檔）。
   * **一定要接**：沒有依賴就跑關卡，紅的是環境不是程式碼，而 agent 會去修一個沒壞的東西。
   */
  prepareTree?: (treePath: string) => Promise<void>;
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
   * 語意飄移的**判斷層**（rebase 成功且測試綠之後才跑）。未注入就不跑這層。
   * 見 drift-judge.ts：前兩層是事實（衝突、紅燈），這一層是判斷（意圖打不打架）。
   */
  driftJudge?: DriftJudgeLike;
}

/** 語意飄移判斷者的最小介面（供注入假件）。 */
export interface DriftJudgeLike {
  judge(input: {
    cwd: string;
    baseChanges: string;
    groupChanges: string;
    taskTitles: string[];
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
    const built = await createMergeTree({
      repoPath,
      branch,
      baseRef: freshness.ref,
      log: this.log,
      // **一定要把注入的 git 傳下去。** 不傳的話守衛會用到兩條不同的 git 路徑：
      // 一條可被測試/呼叫端替換，一條寫死用 execa——那種不一致查起來特別花時間。
      git: (cwd, args) => this.git(cwd, args),
      ...(this.opts.prepareTree ? { prepare: this.opts.prepareTree } : {}),
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
      // **任務資訊要帶下去**：少了它，介面判斷者拿不到 baseRef，就分不出
      // 「這次弄的」與「本來就有的」（實跑撞到：把別人先前 commit 的瑕疵算到這次頭上）。
      const gate = await this.verifier.check({
        cwd: tree.path,
        config: input.verifierConfig,
        ...(input.task ? { task: input.task } : {}),
      });
      if (!gate.green) {
        this.log.warn({ branch, base: freshness.ref }, 'Merge Guard：併上最新 base 後建置/測試紅');
        return { ok: false, reason: 'semantic_drift', detail: withCaveat(freshness, failSummary(gate)) };
      }

      // 4) 事實層都綠了 → 判斷層：兩邊的意圖有沒有打架。
      //    抓的是「能編譯、測試也綠，但合起來的產品行為自相矛盾」——量不出來，
      //    只有讀得懂意圖的才判斷得出。判不出來就放行（見 drift-judge.ts）。
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
      // 兩份 diff 都用**明確的 ref 範圍**算，不依賴任何工作區的 HEAD——
      // 先前用 `${baseRef}..HEAD` 是因為那時分支被 rebase 到主 clone 的 HEAD 上；
      // 現在群分支不動，HEAD 在哪由呼叫者決定，寫死 HEAD 會算到別的東西。
      const baseChanges = (await this.git(input.repoPath, ['diff', '--no-color', `${mergeBase}..${baseRef}`])).stdout;
      const groupChanges = (await this.git(input.repoPath, ['diff', '--no-color', `${mergeBase}..${input.branch}`])).stdout;
      const verdict = await judge.judge({
        // 判斷者要站在**合併後狀態**上看：那才是它要判斷「意圖有沒有打架」的世界
        cwd: treePath,
        baseChanges,
        groupChanges,
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
