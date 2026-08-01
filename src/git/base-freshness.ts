import type { Logger } from '../observability/logger.js';

/**
 * base 新鮮度：這次要對著「remote 上真實的 base」還是「可能過期的本地 base」工作。
 *
 * 原本這段邏輯只長在 MergeGuard 裡，也就是**只有合併前才會確認 base 是不是最新的**。
 * 但開工時同樣需要：本地 clone 停在三天前的 main，agent 就會在過期的程式碼上實作——
 * 可能重做別人已經做過的東西、對著不存在的 API 寫、或是驗證全綠但一 rebase 就爆。
 * 這種問題在 PR 階段才發現的話，整群的工都要重來。
 *
 * 取不到最新版時**不讓流程失敗**（離線、無 remote 的本地 repo 也要能跑），
 * 但一定要把 caveat 標出來——把「假的最新」降級成「有但書的最新」。
 */

export interface BaseFreshness {
  /** 實際該使用的 ref（如 origin/main 或 main）。 */
  ref: string;
  /** 是否確實從 remote 取得了最新 base。 */
  fetched: boolean;
  /** 但書：非空代表這次有前提，需要揭露給人看。 */
  caveat?: string;
}

export interface GitExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (repoPath: string, args: string[], opts?: { timeoutMs?: number }) => Promise<GitExecResult>;

export interface FreshnessOptions {
  git: GitRunner;
  remote?: string;
  /** false = 完全不連外（離線或測試）。 */
  fetch?: boolean;
  fetchTimeoutMs?: number;
  log?: Logger;
}

export const DEFAULT_REMOTE = 'origin';
export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

/**
 * 決定該用哪個 ref 當基準，並回報這個決定的但書。
 * 任何一步失敗都只降級成「用本地 base + caveat」，不讓呼叫端整個失敗。
 */
export async function resolveBaseFreshness(
  repoPath: string,
  base: string,
  opts: FreshnessOptions,
): Promise<BaseFreshness> {
  const git = opts.git;
  const remote = opts.remote ?? DEFAULT_REMOTE;
  const stale = (why: string): BaseFreshness => ({
    ref: base,
    fetched: false,
    caveat: `未能取得最新 base（${why}），本次基於本地狀態`,
  });

  if (opts.fetch === false) return stale('已停用 fetch');

  // 沒設定這個 remote（本地測試用 repo 就常常沒有）→ 沒有「最新」可取，直接降級
  const remotes = await git(repoPath, ['remote']);
  const names = remotes.stdout.split('\n').map((s) => s.trim());
  if (remotes.exitCode !== 0 || !names.includes(remote)) return stale(`找不到 remote「${remote}」`);

  const fetched = await git(repoPath, ['fetch', '--quiet', remote, base], {
    timeoutMs: opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  });
  if (fetched.exitCode !== 0) return stale(`git fetch 失敗：${tail(`${fetched.stderr}\n${fetched.stdout}`, 3).trim()}`);

  // 標準 clone 會同時更新 refs/remotes/<remote>/<base>；refspec 沒設定時只有 FETCH_HEAD。
  const remoteRef = await firstResolvable(git, repoPath, [`${remote}/${base}`, 'FETCH_HEAD']);
  if (!remoteRef) return stale(`fetch 後仍解析不到 ${remote}/${base}`);

  // 本地 base 已包含 remote 的最新內容（本地超前或相同）→ 用本地即可，沒有但書。
  if (await isAncestor(git, repoPath, remoteRef, base)) return { ref: base, fetched: true };

  // remote 比本地新（正常情形）→ 以 remote 為基準。
  if (await isAncestor(git, repoPath, base, remoteRef)) return { ref: remoteRef, fetched: true };

  // 兩邊分歧：本地 base 有沒推上去的 commit。以 remote（真正要併進去的世界）為基準，
  // 但要揭露「本地未推送的 commit 不在範圍內」。
  return {
    ref: remoteRef,
    fetched: true,
    caveat: `本地 ${base} 與 ${remoteRef} 已分歧，改以 ${remoteRef} 為基準；本地未推送的 commit 不在範圍內`,
  };
}

/** 回傳第一個解析得到 commit 的 ref；都解析不到回 undefined。 */
export async function firstResolvable(
  git: GitRunner,
  repoPath: string,
  refs: string[],
): Promise<string | undefined> {
  for (const ref of refs) {
    const rp = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (rp.exitCode === 0 && rp.stdout.trim() !== '') return ref;
  }
  return undefined;
}

/**
 * 「拿來當比較基準」該用哪個 ref：有 remote-tracking 版本就用它，沒有才退回本地。
 *
 * 為什麼一定要優先 remote：daemon 只 fetch，**不會 checkout base 分支去更新它**，
 * 所以本地 base 常常停在好幾個 commit 以前。拿它當基準的話，
 * 「別的群組已經合併進去的 commit」會被算成「這個分支自己的成果」。
 *
 * 這個坑踩過兩次，兩次都是實跑才發現：
 *   · 政策閘門：一個只改 README 的 PR 被判成「還改了三個不相干的檔案」（那三個是上一群剛合併的）
 *   · 崩潰對帳：agent 連一行都還沒 commit 的群組，被判成「可續（分支領先 5 個 commit）」——
 *     那 5 個是 origin/main 領先本地 main 的量。後果是「成果遺失」永遠偵測不到。
 *
 * 跟 resolveBaseFreshness 的差別：那個會連外 fetch 並回報但書，適合開工／合併前；
 * 這個純粹是本地解析、不連外，適合對帳與 diff 這種「只是要挑對參照點」的場合。
 */
export async function preferRemoteRef(
  git: GitRunner,
  repoPath: string,
  base: string,
  remote = DEFAULT_REMOTE,
): Promise<string> {
  return (await firstResolvable(git, repoPath, [`${remote}/${base}`, base])) ?? base;
}

export async function isAncestor(
  git: GitRunner,
  repoPath: string,
  maybeAncestor: string,
  descendant: string,
): Promise<boolean> {
  const r = await git(repoPath, ['merge-base', '--is-ancestor', maybeAncestor, descendant]);
  return r.exitCode === 0;
}

/** 本機分支清單（控制台的分支下拉選單用）。 */
export async function listBranches(git: GitRunner, repoPath: string): Promise<{ local: string[]; remote: string[] }> {
  const fmt = ['for-each-ref', '--format=%(refname:short)'];
  const [l, r] = await Promise.all([
    git(repoPath, [...fmt, 'refs/heads']),
    git(repoPath, [...fmt, 'refs/remotes']),
  ]);
  const parse = (out: string): string[] => out.split('\n').map((s) => s.trim()).filter((s) => s !== '');
  return {
    local: l.exitCode === 0 ? parse(l.stdout).filter((s) => !s.endsWith('/HEAD')) : [],
    // origin/main → main（給人選的是分支名，不是 ref）。
    // refs/remotes/origin/HEAD 的 short form 是 **origin**（git 會縮成純 remote 名），
    // 不是 origin/HEAD——只濾 /HEAD 的話，remote 名稱本身會混進分支清單裡。
    remote:
      r.exitCode === 0
        ? [...new Set(parse(r.stdout).filter((x) => x.includes('/')).map((x) => x.replace(/^[^/]+\//, '')))]
        : [],
  };
}

function tail(s: string, n: number): string {
  return s.split('\n').slice(-n).join('\n');
}
