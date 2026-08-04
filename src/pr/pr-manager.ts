import { execa } from 'execa';
import { z } from 'zod';
import type { PullRequest } from '../types.js';
import type { Logger } from '../observability/logger.js';
import { withFetchLock } from '../git/fetch-lock.js';

/** 外部指令的執行結果（已正規化：連「指令不存在」都回結果而不丟例外）。 */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * 外部指令執行器（git / gh）。抽成介面的理由有二：
 *   1. 測試必須能注入假件——絕不允許測試真的去碰 git remote 或真實 PR。
 *   2. 之後要加權限閘門/稽核時，只要包一層 runner 即可，不必動 PrManager。
 */
export type CommandRunner = (file: string, args: string[], opts?: { cwd?: string }) => Promise<CommandResult>;

/**
 * 預設執行器：execa + reject:false。
 * 不讓 execa 自己丟例外，是因為「非零退出」對這裡多半是可處理的情況
 * （PR 已存在、gh 未登入…），由呼叫端依 exitCode 決定要不要視為致命。
 */
export const execaRunner: CommandRunner = async (file, args, opts = {}) => {
  try {
    const r = await execa(file, args, { cwd: opts.cwd, reject: false });
    return { exitCode: r.exitCode ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (e) {
    // 指令不存在（ENOENT）等 spawn 期失敗仍可能丟；一律轉成 exitCode -1，
    // 讓上層能走「優雅降級」而不是讓 daemon 崩潰。
    return { exitCode: -1, stdout: '', stderr: String(e instanceof Error ? e.message : e) };
  }
};

/** GitHub 的合併方式。預設 squash（一群 = 一個語意變更，歷史乾淨）。 */
export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface OpenPrInput {
  repoPath: string;
  repo: string; // owner/name
  branch: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface UpdatePrInput {
  repo: string; // owner/name
  prNumber: number;
  body?: string;
  title?: string;
  /** 執行 gh 的工作目錄（可省略；gh 靠 --repo 定位）。 */
  cwd?: string;
}

export interface MergePrInput {
  repo: string; // owner/name
  prNumber: number;
  /**
   * 誰／哪條規則核准了這次合併（如 'reviewer:alice'、'policy:auto-merge'）。
   * **必填且不得為空**——見 merge() 的安全說明。
   */
  approvedBy: string;
  method?: MergeMethod;
  deleteBranch?: boolean;
  cwd?: string;
}

export interface MergeResult {
  ok: boolean;
  detail: string;
}

// gh 的 JSON 輸出只取需要的欄位；多的欄位由 zod 自動忽略。
const PrRowSchema = z.object({ number: z.number(), url: z.string() });
const PrListSchema = z.array(PrRowSchema);

/**
 * PR 管理（DESIGN §14）。分支建立/commit 為本地動作；push、`gh pr create/edit/merge`
 * 為外部動作（會受權限閘門管制）。合併週期的本地驗證（Merge Guard、本地 merge）不需這些外部步驟。
 */
export class PrManager {
  constructor(private log: Logger, private run: CommandRunner = execaRunner) {}

  private git(repoPath: string, args: string[]): Promise<CommandResult> {
    return this.run('git', ['-C', repoPath, ...args]);
  }

  /** 本地 git 步驟出錯屬致命（不該默默往下走）→ 保留既有「失敗即丟」語意。 */
  private async gitOrThrow(repoPath: string, args: string[]): Promise<CommandResult> {
    const r = await this.git(repoPath, args);
    if (r.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} 失敗（exit ${r.exitCode}）：${tail(r.stderr || r.stdout)}`);
    }
    return r;
  }

  private gh(args: string[], cwd?: string): Promise<CommandResult> {
    return this.run('gh', args, cwd === undefined ? {} : { cwd });
  }

  /** 從 base 建立/重置群組分支。 */
  async ensureBranch(repoPath: string, branch: string, base: string): Promise<void> {
    await this.gitOrThrow(repoPath, ['checkout', base]);
    await this.gitOrThrow(repoPath, ['checkout', '-B', branch]);
    this.log.info({ branch, base }, '建立群組分支');
  }

  /**
   * 將工作區變更提交到目前分支（排除 node_modules）。
   * 註：worktree 的 node_modules 常為 symlink，而 .gitignore 若寫 `node_modules/`（尾斜線）
   * 只比對目錄、不比對 symlink，故此處以 pathspec 明確排除，避免誤 commit 依賴。
   * agent 若已自行 commit，這裡會 no-op（無 staged 變更 → 不重複提交）。
   */
  async commitAll(repoPath: string, message: string): Promise<boolean> {
    // .playwright-mcp 是瀏覽器 MCP 的暫存輸出。前兩道防線（--output-dir 指到 worktree 外、
    // .git/info/exclude）都可能失守——換版本、換工具、忘了接線——所以這裡再擋一次。
    // 它混進 commit 的後果不只是髒 diff，還會讓「diff 非空」的 DoD 判定失真。
    await this.git(repoPath, ['add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude).playwright-mcp']);
    const staged = await this.git(repoPath, ['diff', '--cached', '--name-only']);
    if (!staged.stdout.trim()) {
      this.log.warn('無變更可提交（可能 agent 已自行 commit）');
      return false;
    }
    await this.gitOrThrow(repoPath, ['commit', '-q', '-m', message]);
    return true;
  }

  /**
   * 查同一 head 分支上「開著的」PR。查不到（含 gh 失敗）一律回 undefined，
   * 由呼叫端決定要不要建立——查詢失敗不該讓開 PR 這件事整個停擺。
   */
  async findOpenPr(repo: string, branch: string, cwd?: string): Promise<PullRequest | undefined> {
    return this.findPr(repo, branch, 'open', cwd);
  }

  /**
   * 查同一 head 分支上**已合併**的 PR。
   *
   * 用途是判斷「遠端這顆殘留分支砍掉安不安全」。不能只靠 `merge-base --is-ancestor`：
   * 預設的合併方式是 **squash**，它把整條分支壓成 base 上的一顆新 commit，
   * 原本那些 commits 一顆都不會成為 base 的祖先。所以對 squash 合併過的分支，
   * 祖先判斷永遠是否——「已經合併掉的分支」會被誤判成「還有未合併的內容」。
   * （這個洞是拿真實 repo 對照才發現的：PR #9 squash 合併後，
   *   `merge-base --is-ancestor origin/orch/... origin/main` 回 false。）
   *
   * GitHub 說某個 PR 是 merged，就代表它的內容已經進了 base——這才是對的信號。
   */
  async findMergedPr(repo: string, branch: string, cwd?: string): Promise<PullRequest | undefined> {
    return this.findPr(repo, branch, 'merged', cwd);
  }

  private async findPr(
    repo: string,
    branch: string,
    state: 'open' | 'merged',
    cwd?: string,
  ): Promise<PullRequest | undefined> {
    const r = await this.gh(
      ['pr', 'list', '--repo', repo, '--head', branch, '--state', state, '--json', 'number,url', '--limit', '1'],
      cwd,
    );
    if (r.exitCode !== 0) {
      // 回 undefined 是刻意的：兩個呼叫端都安全（openPr 接著建立時會拿到真正的錯誤；
      // 刪分支那條在 !ancestor && !mergedPr 時擲錯拒絕動作）。
      // 但**等級要是 error 不是 warn**，而且要把 GitHub 那句誤導的訊息翻譯出來——
      // 實跑撞到：這裡連兩次靜靜 warn，真正的原因（token 沒權限）延後一小時
      // 才在 openPr 那裡浮現，而浮現時的訊息看起來像「repo 不存在」。
      const detail = tail(r.stderr || r.stdout);
      this.log.error(
        { repo, branch, state, detail, 可能原因: interpretGhError(detail, repo) },
        '查詢既有 PR 失敗（本次視為沒有，但這通常是認證或權限問題）',
      );
      return undefined;
    }
    const parsed = PrListSchema.safeParse(safeJson(r.stdout));
    if (!parsed.success) {
      this.log.warn({ repo, branch }, 'gh pr list 輸出無法解析（視為沒有）');
      return undefined;
    }
    const row = parsed.data[0];
    return row ? { url: row.url, number: row.number } : undefined;
  }

  /**
   * 開 PR（外部動作）：push 分支 + `gh pr create`。**冪等**——同分支已有開著的 PR 就直接沿用，
   * 因此整個群組流程重跑（daemon 重啟、群組重試）不會因為「PR 已存在」而失敗。
   * draft 預設 true，避免尚未確認就進入正式審查。
   */
  async openPr(input: OpenPrInput): Promise<PullRequest> {
    await this.pushBranch(input);

    const existing = await this.findOpenPr(input.repo, input.branch, input.repoPath);
    if (existing) {
      this.log.info({ url: existing.url, number: existing.number }, 'PR 已存在，沿用（冪等）');
      return existing;
    }

    const args = [
      'pr', 'create',
      '--repo', input.repo,
      '--base', input.base,
      '--head', input.branch,
      '--title', input.title,
      '--body', input.body,
      ...(input.draft === false ? [] : ['--draft']),
    ];
    const r = await this.gh(args, input.repoPath);
    if (r.exitCode !== 0) {
      // 競態：查詢與建立之間別人（或上一輪殘留）剛好開了同一個 PR → 再查一次就當成功
      const raced = await this.findOpenPr(input.repo, input.branch, input.repoPath);
      if (raced) {
        this.log.info({ url: raced.url }, 'gh pr create 失敗但 PR 已存在，沿用');
        return raced;
      }
      throw new Error(`gh pr create 失敗（exit ${r.exitCode}）：${tail(r.stderr || r.stdout)}`);
    }

    const url = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
    if (!number) {
      // 不同 gh 版本輸出格式可能不同；解析不到編號就退回查詢（編號是後續追審查的關鍵）
      const q = await this.findOpenPr(input.repo, input.branch, input.repoPath);
      if (q) return q;
      this.log.warn({ url }, '無法從 gh 輸出解析 PR 編號（Review Watcher 將無法追蹤此 PR）');
    }
    this.log.info({ url, number }, '已開 PR');
    return { url, number };
  }

  /**
   * 推送群組分支，並處理「遠端留著同名舊分支」這個必然會發生的狀況。
   *
   * 為什麼必然：群組 id 是 `sha1(repo|任務清單)`，同一組任務永遠得到同一個分支名。
   * 而 GitHub 合併 PR 後**不會**自動刪來源分支。於是同一組任務再跑一次時，
   * 本地分支從新的 base 長出來，遠端那顆卻是上次合併掉的舊 tip → 兩邊分歧 →
   * `push` 以 non-fast-forward 被拒 → 整個群組 failed。實跑撞到過（PR #8 合併後的下一輪）。
   *
   * 補救只在**可證明安全**時進行：遠端那顆必須已經完全併進 base（`merge-base --is-ancestor`），
   * 也就是它的內容一行不差都還在 base 裡，砍掉不會失去任何東西；而且該分支上不能還有開著的 PR
   * （砍分支會連帶關掉 PR）。兩個條件都成立才 delete + 重推。
   *
   * **永遠不用 force push**：那會蓋掉可能還沒被合併的他人成果。條件不成立時寧可失敗，
   * 把現場留給人判斷——這種時候「卡住」比「安靜地弄丟東西」好。
   */
  private async pushBranch(input: OpenPrInput): Promise<void> {
    const { repoPath, branch, base, repo } = input;
    const first = await this.git(repoPath, ['push', '-u', 'origin', branch]);
    if (first.exitCode === 0) return;

    const out = `${first.stderr}${first.stdout}`;
    const rejected = /non-fast-forward|\[rejected\]|fetch first|behind its remote/i.test(out);
    if (!rejected) {
      throw new Error(`git push -u origin ${branch} 失敗（exit ${first.exitCode}）：${tail(out)}`);
    }

    const openPr = await this.findOpenPr(repo, branch, repoPath);
    if (openPr) {
      // **群分支不再被改寫，所以這裡不該再出現 non-fast-forward。**
      //
      // 先前 Merge Guard 會 rebase 群分支（改寫歷史），於是每次「開了 PR 又要重做」
      // 都必然要 force push；那條路用 `--force-with-lease` 守著，但它終究是
      // 一個不可逆動作，而且 lease 過期時的失敗形狀很難懂。
      //
      // 現在合併驗證跑在拋棄式樹上（見 pr/merge-verify.ts），群分支一位元都不會被動——
      // 分支只會往前長。所以走到這裡代表**遠端有我們不知道的東西**，
      // 那不是「更新自己的 PR」，是真的分歧了。停下來讓人看，不要猜。
      throw new Error(
        `分支 ${branch} 與遠端分歧，但它有開著的 PR #${openPr.number}（${openPr.url}）。\n` +
          '群分支不會被本系統改寫，所以這代表遠端被別的東西動過了。\n' +
          '已停下來而不是強制覆寫——請看一下那個 PR 再決定。\n' +
          `git push 的輸出：${tail(out)}`,
      );
    }

    // 「安不安全刪掉」有兩種證明，任一成立即可：
    //   (a) 遠端那顆是 base 的祖先——內容一行不差都在 base 裡（merge / rebase 合併）
    //   (b) 這個分支上有 **已合併** 的 PR——GitHub 說進去了就是進去了（squash 合併走這條）
    // 少了 (b) 這條路實際上是死的：預設合併方式是 squash，它會把整條分支壓成一顆新
    // commit，原本的 commits 一顆都不是 base 的祖先，(a) 永遠不成立。
    await withFetchLock(repoPath, () => this.git(repoPath, ['fetch', 'origin', branch, base]));
    const remoteTip = (await this.git(repoPath, ['rev-parse', `refs/remotes/origin/${branch}`])).stdout.trim();
    const baseTip = (await this.git(repoPath, ['rev-parse', `refs/remotes/origin/${base}`])).stdout.trim();
    const ancestor =
      remoteTip !== '' &&
      baseTip !== '' &&
      (await this.git(repoPath, ['merge-base', '--is-ancestor', remoteTip, baseTip])).exitCode === 0;
    const mergedPr = ancestor ? undefined : await this.findMergedPr(repo, branch, repoPath);
    if (!ancestor && !mergedPr) {
      throw new Error(
        `分支 ${branch} 與遠端分歧，且遠端那顆（${remoteTip.slice(0, 8)}）既不是 ${base} 的祖先、` +
          `也沒有已合併的 PR；不做任何覆寫（絕不 force push），請人工處理。原始錯誤：${tail(out)}`,
      );
    }

    this.log.warn(
      { repo, branch, remoteTip: remoteTip.slice(0, 8), base, why: ancestor ? 'ancestor' : `merged:#${mergedPr?.number}` },
      '遠端留有已合併的同名舊分支 → 刪除後重推',
    );
    await this.gitOrThrow(repoPath, ['push', 'origin', '--delete', branch]);
    await this.gitOrThrow(repoPath, ['push', '-u', 'origin', branch]);
  }

  /**
   * 更新 PR 內文/標題（changes_requested 修完後回報最新狀態用）。
   * 刻意「非致命」：gh 不可用或 PR 不存在時只記 warn 回 false，不讓群組流程整個掛掉——
   * PR 內文沒更新到是可容忍的，daemon 停擺不是。
   */
  async updatePr(input: UpdatePrInput): Promise<boolean> {
    const fields: string[] = [];
    if (input.body !== undefined) fields.push('--body', input.body);
    if (input.title !== undefined) fields.push('--title', input.title);
    if (fields.length === 0) {
      this.log.warn({ prNumber: input.prNumber }, 'updatePr 沒有要更新的欄位，略過');
      return false;
    }
    const r = await this.gh(['pr', 'edit', String(input.prNumber), '--repo', input.repo, ...fields], input.cwd);
    if (r.exitCode !== 0) {
      this.log.warn(
        { repo: input.repo, prNumber: input.prNumber, detail: tail(r.stderr || r.stdout) },
        '更新 PR 失敗（略過，不影響其餘流程）',
      );
      return false;
    }
    this.log.info({ repo: input.repo, prNumber: input.prNumber }, '已更新 PR 內文');
    return true;
  }

  /**
   * 合併 PR——**外部且不可逆**的動作。
   *
   * 安全設計（重要）：此函式不會被任何預設流程自動呼叫，且不提供「省略即合併」的預設呼叫方式。
   * 呼叫端必須明示 `approvedBy`（是哪個審查人／哪條政策核准的），空字串一律拒絕。
   * 這讓合併永遠是「有人明確要求」的結果，而不是某條路徑順手帶到的副作用。
   * 失敗只回 ok:false（不丟例外），讓上層能通知人類接手。
   */
  async merge(input: MergePrInput): Promise<MergeResult> {
    const approvedBy = input.approvedBy.trim();
    if (!approvedBy) {
      // 這是防呆而非防惡意：擋掉「忘了帶核准來源」的呼叫，避免無主的自動合併
      this.log.error({ prNumber: input.prNumber }, '拒絕合併：未指明核准來源（approvedBy）');
      return { ok: false, detail: '拒絕合併：未指明核准來源（approvedBy）' };
    }
    const method: MergeMethod = input.method ?? 'squash';
    const args = [
      'pr', 'merge', String(input.prNumber),
      '--repo', input.repo,
      `--${method}`,
      ...(input.deleteBranch ? ['--delete-branch'] : []),
    ];
    let r = await this.gh(args, input.cwd);

    // draft PR 不能被合併（GitHub 直接擋）。我們開 PR 時刻意用 draft——那代表「機器產出、
    // 還沒被人看過」；但人核准之後它就該轉正式。這裡自動 ready 再重試一次，
    // 否則需求「核准後合併」在 draft PR 上永遠失敗（實測撞到：still a draft）。
    if (r.exitCode !== 0 && /still a draft|draft pull request/i.test(`${r.stderr}${r.stdout}`)) {
      this.log.info({ repo: input.repo, prNumber: input.prNumber }, 'PR 仍是 draft → 先轉正式再合併');
      const ready = await this.gh(['pr', 'ready', String(input.prNumber), '--repo', input.repo], input.cwd);
      if (ready.exitCode !== 0) {
        const detail = tail(ready.stderr || ready.stdout);
        this.log.error({ repo: input.repo, prNumber: input.prNumber, detail }, 'draft PR 轉正式失敗');
        return { ok: false, detail: `draft 轉正式失敗：${detail}` };
      }
      r = await this.gh(args, input.cwd);
    }

    if (r.exitCode !== 0) {
      const detail = tail(r.stderr || r.stdout);
      this.log.error({ repo: input.repo, prNumber: input.prNumber, method, detail }, '合併 PR 失敗');
      return { ok: false, detail };
    }
    this.log.info({ repo: input.repo, prNumber: input.prNumber, method, approvedBy }, '已合併 PR');
    return { ok: true, detail: r.stdout.trim() };
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function tail(s: string, n = 20): string {
  return s.split('\n').slice(-n).join('\n').trim();
}


/**
 * 把 GitHub 那句誤導的錯誤翻譯成人看得懂的原因。
 *
 * 私有 repo 沒權限時 GitHub **回 Not Found 而不是 403**（避免洩漏私有 repo 是否存在），
 * 於是 gh 吐出來的是：
 *
 *   GraphQL: Could not resolve to a Repository with the name 'org/repo'
 *
 * 那看起來像「repo 名稱打錯了」或「repo 被刪了」，實際上幾乎都是**權限**。
 * 實跑撞到：使用者的 fine-grained PAT resource owner 選了個人帳號，
 * 而 repo 屬於 organization——那種 token 看不到任何 organization 的 repo。
 */
export function interpretGhError(detail: string, repo: string): string | undefined {
  if (/Could not resolve to a Repository|HTTP 404|Not Found/i.test(detail)) {
    const org = repo.includes('/') ? repo.split('/')[0] : repo;
    return (
      `多半是 token 看不到 ${repo}（GitHub 對無權限的私有 repo 回 Not Found 不是 403）。`
      + `若 ${org} 是 organization，fine-grained PAT 的 resource owner 必須選 ${org} 而不是個人帳號，`
      + '且可能需要組織核准；或改用有 repo scope 的 classic token／gh auth login。'
    );
  }
  if (/gh auth login|not logged|authentication|Bad credentials|HTTP 401/i.test(detail)) {
    return 'gh 沒有有效認證（token 過期或未登入）。';
  }
  return undefined;
}
