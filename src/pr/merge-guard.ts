import { execa } from 'execa';
import { resolveBaseFreshness, type BaseFreshness } from '../git/base-freshness.js';
import type { VerifierLike } from '../contracts.js';
import type { VerifierConfig } from '../worker/verifier.js';
import type { MergeVerdict, GateReport } from '../types.js';
import { driftFeedback, type DriftVerdict } from './drift-judge.js';
import type { Logger } from '../observability/logger.js';

export interface MergeGuardInput {
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

  async attempt(input: MergeGuardInput): Promise<MergeVerdict> {
    const { repoPath, branch, base } = input;

    // 0) 前置：確實切到目標分支。checkout 失敗（分支不存在等）若不檢查，後續會在
    //    「當前分支」上 rebase+驗證並回綠燈——等於替一個從未檢出的分支背書，是嚴重誤判。
    const co = await this.git(repoPath, ['checkout', branch]);
    if (co.exitCode !== 0) {
      this.log.error({ branch }, 'Merge Guard：無法切到目標分支，前置條件不成立');
      return { ok: false, reason: 'precondition_failed', detail: tail(`${co.stdout}\n${co.stderr}`) };
    }

    // 1) 取最新 base。不 fetch 的話，rebase 的是「本地那份可能停在舊 commit 的 base」，
    //    驗證的是一個不存在的世界；而真正會發生語意飄移的情況恰恰就是 remote 有新變更。
    const freshness = await this.resolveBase(repoPath, base);
    this.opts.onBaseFreshness?.(freshness);
    if (freshness.caveat) {
      this.log.warn({ branch, base, ref: freshness.ref, caveat: freshness.caveat }, 'Merge Guard：base 新鮮度有但書');
    }

    // 分岔點必須在 rebase **之前**取：rebase 會把分支接到 base 頂端，
    // 之後就再也算不出「base 在本群動工之後多了什麼」——而那正是判斷意圖有沒有打架的材料。
    const mergeBase = (await this.git(repoPath, ['merge-base', 'HEAD', freshness.ref])).stdout.trim();

    // 2) rebase 最新 base → 有文字衝突即 code_conflict
    const rb = await this.git(repoPath, ['rebase', freshness.ref]);
    if (rb.exitCode !== 0) {
      await this.git(repoPath, ['rebase', '--abort']);
      this.log.warn({ branch, base: freshness.ref }, 'Merge Guard：rebase 有 CODE 衝突');
      return { ok: false, reason: 'code_conflict', detail: withCaveat(freshness, tail(`${rb.stdout}\n${rb.stderr}`)) };
    }

    // 3) 在「合併後狀態」重跑 DoD → 紅燈即語意飄移（無衝突但功能壞）
    // **任務資訊要帶下去。** 少了它，這一關的介面判斷者拿不到 baseRef，
    // 就沒有唯讀 git 可用，也就分不出「這次弄的」與「本來就有的」——
    // 實跑撞到：同一輪裡任務關卡那次有查 git、Merge Guard 這次沒有，
    // 而擋下 PR 的正是後者，把別人先前 commit 的瑕疵算到這次頭上。
    const gate = await this.verifier.check({
      cwd: repoPath,
      config: input.verifierConfig,
      ...(input.task ? { task: input.task } : {}),
    });
    if (!gate.green) {
      this.log.warn({ branch, base: freshness.ref }, 'Merge Guard：rebase 後建置/測試紅 → 語意飄移');
      return { ok: false, reason: 'semantic_drift', detail: withCaveat(freshness, failSummary(gate)) };
    }

    // 4) 事實層都綠了 → 判斷層：兩邊的意圖有沒有打架。
    //    這一層抓的是「能編譯、測試也綠，但合起來的產品行為自相矛盾」——量不出來，
    //    只有讀得懂意圖的才判斷得出。判不出來就放行（見 drift-judge.ts 的說明）。
    const drift = await this.judgeDrift(input, freshness.ref, mergeBase);
    if (drift) return drift;

    // 記下「驗的是哪一個 base」。合併之前呼叫端會再讀一次比對——
    // 不一樣代表 base 在這之後被動過，上面那句「可安全合併」對現在的 base 就不成立了。
    const baseSha = (await this.git(repoPath, ['rev-parse', freshness.ref])).stdout.trim();

    this.log.info(
      { branch, base: freshness.ref, fetched: freshness.fetched, baseSha: baseSha.slice(0, 8) },
      freshness.caveat
        ? 'Merge Guard：rebase + 重測通過（但書：未能確認 base 為最新）'
        : 'Merge Guard：rebase + 重測通過，可安全合併',
    );
    return baseSha ? { ok: true, baseSha } : { ok: true };
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
  ): Promise<MergeVerdict | undefined> {
    const judge = this.opts.driftJudge;
    if (!judge || !mergeBase) return undefined;
    try {
      const baseChanges = (await this.git(input.repoPath, ['diff', '--no-color', `${mergeBase}..${baseRef}`])).stdout;
      const groupChanges = (await this.git(input.repoPath, ['diff', '--no-color', `${baseRef}..HEAD`])).stdout;
      const verdict = await judge.judge({
        cwd: input.repoPath,
        baseChanges,
        groupChanges,
        taskTitles: input.taskTitles ?? [],
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
