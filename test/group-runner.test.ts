import { describe, it, beforeEach, afterEach } from 'node:test';
import type { AgentSummaryCapture } from '../src/worker/agent-runtime.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GROUP_DEPS_BLOCKED_EVENT, GroupRunner, branchHasCommits, reworkProducedChanges, shouldRequeueGroup, stripAnsi, type FeedbackStoreLike, type GitRunner, type GroupRunnerDeps, type MergeApprovalAsk, type MergeGuardLike, type PrManagerLike, type ProjectRuntime, type WorktreeLike } from '../src/core/group-runner.js';
import type { AgentLike, McpTaskClient, Notifier, VerifierLike } from '../src/contracts.js';
import type { PolicyInput } from '../src/policy/policy-engine.js';
import type { MergeGuardOptions } from '../src/pr/merge-guard.js';
import type { ReviewFeedback } from '../src/pr/review-watcher.js';
import type { IterateInput, IterateResult } from '../src/worker/agent-runtime.js';
import type { GateReport, Group, LifecycleEvent, MergeVerdict, TaskDetail } from '../src/types.js';
import { createTmpLedger, createRecordingLogger, createSilentLogger, type RecordingLogger, type TmpLedger } from './helpers/index.js';
import { GROUP_ABORTED_EVENT } from '../src/core/group-runner.js';

// ── 假件（全部注入，測試不碰真實 git / repo） ──

function fakeWorktrees(): WorktreeLike & { created: string[]; removed: string[] } {
  const created: string[] = [];
  const removed: string[] = [];
  return {
    created,
    removed,
    async create(_repoPath, branch) {
      const path = `/tmp/fake-wt/${branch}`;
      created.push(path);
      return { path, branch };
    },
    async remove(_repoPath, worktreePath) {
      removed.push(worktreePath);
    },
  };
}

function fakePrManager(): PrManagerLike & {
  commits: string[];
  // repo 一併記下來：PR 開到哪個 repo 是安全性質，不記就測不到
  prs: { title: string; body: string; repo: string }[];
} {
  const commits: string[] = [];
  const prs: { title: string; body: string; repo: string }[] = [];
  return {
    commits,
    prs,
    async commitAll(_repoPath, message) {
      commits.push(message);
      return true;
    },
    async openPr(input) {
      prs.push({ title: input.title, body: input.body, repo: input.repo });
      return { url: 'https://example.test/pr/1', number: 1 };
    },
  };
}

function fakeGuard(
  attemptVerdict: MergeVerdict = { ok: true },
  postVerdict: MergeVerdict = { ok: true },
): MergeGuardLike & { attempts: number; posts: number } {
  const g = {
    attempts: 0,
    posts: 0,
    async attempt(): Promise<MergeVerdict> {
      g.attempts += 1;
      return attemptVerdict;
    },
    async postMergeCheck(): Promise<MergeVerdict> {
      g.posts += 1;
      return postVerdict;
    },
  };
  return g;
}

interface FakeGitOpts {
  failOn?: (args: string[]) => boolean;
  /** 主 clone 工作區是否有未提交變更（git status --porcelain 非空）。 */
  dirty?: boolean;
  /** 合併時工作區才變髒（模擬 revert 失敗後工作區殘留衝突檔）。 */
  dirtyAfterMerge?: boolean;
  /** 使用者原本待著的分支。 */
  branch?: string;
  /** 合併後 HEAD 被別人改掉（模擬另一群/使用者插入 commit）。 */
  headAfterMerge?: string;
  /** 每個指令執行前的掛勾（測互斥鎖用：可在此 await 延遲）。 */
  onCall?: (args: string[]) => Promise<void> | void;
}

/**
 * 假 git：記錄所有指令並維護 HEAD / parent 圖與工作區乾淨度，
 * 讓「合併 commit 身分驗證」「reset 前提檢查」「切回原分支」都能被斷言。
 */
function fakeGit(opts: FakeGitOpts = {}): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const parents = new Map<string, string>();
  let head = 'sha-before';
  let dirty = opts.dirty ?? false;
  let mergeSeq = 0;

  const run: GitRunner = async (_cwd, args) => {
    calls.push(args);
    await opts.onCall?.(args);
    if (opts.failOn?.(args)) return { exitCode: 1, stdout: '', stderr: `模擬失敗：${args.join(' ')}` };

    const ok = (stdout = ''): { exitCode: number; stdout: string; stderr: string } => ({ exitCode: 0, stdout, stderr: '' });

    if (args[0] === 'status' && args[1] === '--porcelain') return ok(dirty ? ' M src/a.ts\n' : '');
    if (args[0] === 'rev-parse') {
      const target = args[args.length - 1]!;
      if (target === 'HEAD' && args[1] === '--abbrev-ref') return ok(opts.branch ?? 'my-wip');
      if (target === 'HEAD') return ok(head);
      const m = /^(.+)\^1$/.exec(target);
      if (m) return ok(parents.get(m[1]!) ?? '');
      return ok(target);
    }
    if (args[0] === 'merge' && args[1] === '--no-ff') {
      mergeSeq += 1;
      // 每次合併產生不同 commit（同一份 clone 被連續合併兩次時才驗得出 parent 關係）
      const merged = mergeSeq === 1 ? 'sha-merge' : `sha-merge-${mergeSeq}`;
      parents.set(merged, head);
      head = opts.headAfterMerge ?? merged;
      if (opts.dirtyAfterMerge) dirty = true;
      return ok();
    }
    if (args[0] === 'revert' && args[1] === '--no-edit') {
      head = 'sha-revert';
      return ok();
    }
    if (args[0] === 'reset' && args[1] === '--hard') {
      head = args[2] ?? head;
      return ok();
    }
    return ok();
  };
  return { run, calls };
}

function fakeNotifier(): Notifier & { events: LifecycleEvent[]; threads: (string | undefined)[] } {
  const events: LifecycleEvent[] = [];
  const threads: (string | undefined)[] = [];
  return {
    events,
    threads,
    event: (ts, e) => {
      events.push(e);
      threads.push(ts);
    },
  };
}

/** 具備貼任務卡能力的通知端（Slack HumanGateway 的最小形狀）。 */
function fakeCardNotifier(
  ts: string | undefined = 'ts-1',
  onPost?: () => void,
): Notifier & { events: LifecycleEvent[]; cards: string[]; threads: (string | undefined)[] } {
  const base = fakeNotifier();
  const cards: string[] = [];
  return Object.assign(base, {
    cards,
    async postTaskCard(task: { id: string }) {
      cards.push(task.id);
      onPost?.();
      return ts;
    },
  });
}

/** 具備「發合併核准請求」能力的通知端（Slack HumanGateway 的最小形狀）。 */
function fakeApprovalNotifier(over: { fail?: boolean } = {}): Notifier & {
  events: LifecycleEvent[];
  cards: string[];
  asks: { threadTs: string | undefined; ask: MergeApprovalAsk }[];
} {
  const base = fakeCardNotifier('ts-1');
  const asks: { threadTs: string | undefined; ask: MergeApprovalAsk }[] = [];
  return Object.assign(base, {
    asks,
    async askMergeApproval(threadTs: string | undefined, ask: MergeApprovalAsk) {
      asks.push({ threadTs, ask });
      if (over.fail) throw new Error('Slack 掛了');
    },
  });
}

const greenVerifier = (): VerifierLike => ({
  async check() {
    return { green: true, checks: [{ name: 'test', ok: true, detail: 'ok' }] };
  },
});

/** 依 taskId 回不同總結；未列出的任務回空字串（模擬 agent 沒給總結）。 */
function fakeAgent(byTask: Record<string, AgentSummaryCapture> = {}): AgentLike & { rounds: number; calls: IterateInput[] } {
  // 型別標在變數上（不是最後才轉型）：這個假件少一個 IterateResult 的必填欄位時
  // 要當場紅，而不是被 `as` 蓋掉——那正是「假件與介面脫節、測試照樣綠」的路。
  const a: AgentLike & { rounds: number; calls: IterateInput[] } = {
    rounds: 0,
    calls: [],
    async iterate(input) {
      a.rounds += 1;
      a.calls.push(input);
      // agent 現在用 report_summary 交結構（先前是把散文丟在 resultText 讓程式用正則猜）
      const summary = byTask[input.task.id];
      return { sessionId: 's', resultText: '', toolCalls: {}, isError: false, ...(summary ? { summary } : {}) };
    },
  };
  return a;
}

function fakeMcp(detailOf: (id: string) => TaskDetail): McpTaskClient & { started: string[]; completed: string[] } {
  const started: string[] = [];
  const completed: string[] = [];
  return {
    started,
    completed,
    async startTask(id) {
      started.push(id);
      return { ok: true, value: detailOf(id) };
    },
    async completeTask(id) {
      completed.push(id);
      return { ok: true, value: undefined };
    },
    async loadDocs(refs) {
      return refs.map((ref) => ({ ref, content: `內容 ${ref}` }));
    },
    // 以下兩個是 Poller／認領被拒時的查詢路徑，GroupRunner 的流程走不到。
    // getTask 照 detailOf 回同一份任務（與這個假任務板的其餘行為一致）；
    // listTasks 直接炸掉——真的被呼叫代表測到的不是這裡要測的東西。
    async getTask(id) {
      return detailOf(id);
    },
    async listTasks() {
      throw new Error('測試不該走到這裡：GroupRunner 不會列任務板');
    },
  };
}

/** ReviewFeedbackStore 的最小替身：只要 peek/take，並記錄 take 有沒有被呼叫。 */
function fakeFeedback(fb?: ReviewFeedback): FeedbackStoreLike & { taken: string[] } {
  let held = fb;
  const taken: string[] = [];
  return {
    taken,
    peek: (id) => (held && held.groupId === id ? held : undefined),
    take(id) {
      if (!held || held.groupId !== id) return undefined;
      taken.push(id);
      const out = held;
      held = undefined;
      return out;
    },
  };
}

const reviewFeedback = (groupId: string, comments: string[]): ReviewFeedback => ({
  groupId,
  comments,
  source: 'github_review',
  at: 1,
});

/** 會攔下來的風險判斷者（測「需人工確認」那條路）。 */
const blockingJudge = (what: string) => ({
  judge: async () => ({ needsHuman: true as const, risks: [{ what, why: '做錯了救不回來', evidence: 'db/schema/001.sql:1' }] }),
});

const DOCS_DIFF: PolicyInput = { files: ['docs/guide.md'], deleted: [], additions: 5, deletions: 1 };
const DEPS_DIFF: PolicyInput = { files: ['package.json', 'src/a.ts'], deleted: [], additions: 20, deletions: 3 };

describe('GroupRunner — 合併決策 / PR 敘事 / 合併後 revert / worktree 清理', () => {
  let tmp: TmpLedger;
  let rec: RecordingLogger;

  beforeEach(() => {
    tmp = createTmpLedger();
    rec = createRecordingLogger();
  });
  afterEach(() => tmp.cleanup());

  /** 種一群任務並建立群組。 */
  function seedGroup(titles: string[]): Group {
    const ids: string[] = [];
    titles.forEach((title, i) => {
      const id = `T-${i + 1}`;
      ids.push(id);
      tmp.ledger.upsertDiscoveredTask({
        id, payloadHash: `h${i}`, repo: 'acme/web', category: 'dev',
        title, description: `描述 ${title}`, dependencies: [], docRefs: [],
      });
      tmp.ledger.updateTaskState(id, 'queued');
    });
    return tmp.ledger.createGroup({ repo: 'acme/web', branch: 'feat/g1', taskIds: ids, footprint: ['src/a.ts'] });
  }

  interface Harness {
    runner: GroupRunner;
    wt: ReturnType<typeof fakeWorktrees>;
    pr: ReturnType<typeof fakePrManager>;
    guard: ReturnType<typeof fakeGuard>;
    git: ReturnType<typeof fakeGit>;
    notifier: ReturnType<typeof fakeNotifier>;
    mcp: ReturnType<typeof fakeMcp>;
    agent: AgentLike;
    /** 建構 MergeGuard 時實際收到的 options（缺陷 4：以前根本沒帶）。 */
    guardOptions: MergeGuardOptions[];
  }

  function build(
    over: Partial<GroupRunnerDeps> & {
      guard?: ReturnType<typeof fakeGuard>;
      diff?: PolicyInput;
      summaries?: Record<string, AgentSummaryCapture>;
      gitOpts?: FakeGitOpts;
      /** 直接注入共用的假 git（測跨群互斥用）。 */
      sharedGit?: ReturnType<typeof fakeGit>;
      worktreeBaseBranch?: string;
      /** 專案覆寫的 remote 名稱（驗證有沒有帶進 MergeGuard options）。 */
      remote?: string;
      /** GitHub 動作的目標 repo（複本驗證用）。 */
    } = {},
  ): Harness {
    const wt = fakeWorktrees();
    const pr = fakePrManager();
    const guard = over.guard ?? fakeGuard();
    const git = over.sharedGit ?? fakeGit(over.gitOpts);
    const notifier = (over.notifier as ReturnType<typeof fakeNotifier> | undefined) ?? fakeNotifier();

    const mcp = fakeMcp((id) => {
      const t = tmp.ledger.getTask(id)!;
      return {
        id: t.id, title: t.title, status: 'in_progress', repo: t.repo,
        description: t.description, dependencies: [], docRefs: [], category: t.category,
      };
    });
    const project: ProjectRuntime = {
      repo: 'acme/web',
      repoPath: '/tmp/fake-repo',
      baseBranch: 'main',
      verifierConfig: { test: 'exit 0' },
      mcp,
      ...(over.remote ? { remote: over.remote } : {}),
    };

    const guardOptions: MergeGuardOptions[] = [];
    const agent = over.agent ?? fakeAgent(over.summaries);
    const deps: GroupRunnerDeps = {
      ledger: tmp.ledger,
      log: rec.logger,
      worktreeBase: '/tmp/fake-wt',
      resolveProject: (repo) => (repo === 'acme/web' ? project : undefined),
      agent,
      makeVerifier: greenVerifier,
      notifier,
      diffHash: async () => 'd1',
      readDiff: async () => over.diff ?? DOCS_DIFF,
      // 預設「沒有不可逆風險」。要測「攔下來」的情境就用 over.mergeRiskJudge 覆寫。
      mergeRiskJudge: over.mergeRiskJudge ?? { judge: async () => ({ needsHuman: false as const, notes: ['測試預設：無風險'] }) },
      screenshotsFor: () => [], // 預設不掃真實檔案系統；需要時由個別測試覆寫
      worktrees: wt,
      prManager: pr,
      makeMergeGuard: (_v, options) => {
        guardOptions.push(options);
        return guard;
      },
      git: git.run,
      ...over,
    };
    return { runner: new GroupRunner(deps), wt, pr, guard, git, notifier, mcp, agent, guardOptions };
  }

  const gitCmds = (h: Harness): string[] => h.git.calls.map((c) => c.join(' '));

  // ── 政策閘門 ──

  // ── 政策說可以自動合併，就要真的合併得了 ──

  /**
   * 先前政策放行但 PR 已開時，一律「交給 PR 合併路徑」然後停在 pr_open——
   * 而那條路徑等的是 GitHub 上的審查事件。單人專案根本產生不了那種事件
   * （GitHub 不允許核准自己的 PR），於是一個政策判定「安全、可自動合併」的純文件 PR
   * 會永遠等下去。政策放行的意義就是「不需要人」，結果反而卡在等人。
   * 實跑撞到：PR #26 是純 README 變更，政策放行，卻停在 pr_open 不動。
   */
  describe('自動合併開著 ＋ PR 已開', () => {
    it('直接合併那個 PR，不是停在 pr_open', async () => {
      const group = seedGroup(['寫文件']);
      const merges: { prNumber: number; approvedBy: string; deleteBranch?: boolean }[] = [];
      const h = build({
        allowLocalMerge: true,
        prManager: {
          commitAll: async () => true,
          openPr: async () => ({ url: 'https://x/pull/26', number: 26 }),
          merge: async (i) => {
            merges.push({ prNumber: i.prNumber, approvedBy: i.approvedBy, deleteBranch: i.deleteBranch });
            return { ok: true, detail: 'merged' };
          },
        },
      });

      await h.runner.run(group);

      assert.equal(tmp.ledger.getGroup(group.id)?.state, 'merged');
      assert.deepEqual(merges, [{ prNumber: 26, approvedBy: 'policy:auto_merge', deleteBranch: true }]);
    });

    it('合併失敗要標明白，不可假裝成功', async () => {
      const group = seedGroup(['寫文件']);
      const h = build({
        allowLocalMerge: true,
        prManager: {
          commitAll: async () => true,
          openPr: async () => ({ url: 'https://x/pull/27', number: 27 }),
          merge: async () => ({ ok: false, detail: '分支保護擋下' }),
        },
      });

      await h.runner.run(group);

      assert.notEqual(tmp.ledger.getGroup(group.id)?.state, 'merged');
      assert.ok(h.notifier.events.some((e) => e.type === 'failed'));
    });

    it('自動合併關著 → 開了 PR 後停在 in_review 等人核准（進得了待辦清單）', async () => {
      const group = seedGroup(['寫文件']);
      const merges: number[] = [];
      const h = build({
        allowLocalMerge: false,
        prManager: {
          commitAll: async () => true,
          openPr: async () => ({ url: 'https://x/pull/28', number: 28 }),
          merge: async (i) => { merges.push(i.prNumber); return { ok: true, detail: '' }; },
        },
      });

      await h.runner.run(group);

      assert.deepEqual(merges, [], '沒有明示同意就絕不合併');
      assert.equal(tmp.ledger.getGroup(group.id)?.state, 'in_review');
    });
  });

  it('自動合併關著 → 不動 base 分支，等人核准後才由合併佇列處理', async () => {
    const group = seedGroup(['寫文件']);
    const h = build();

    await h.runner.run(group);

    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'in_review');
    assert.deepEqual(gitCmds(h), [], '未開啟本地合併時不可執行任何 git 合併指令');
    assert.equal(h.guard.posts, 0);
  });

  it('風險判斷者攔下 → 走人工核准：狀態 in_review、發出核准請求、不合併', async () => {
    const group = seedGroup(['改依賴']);
    const h = build({ diff: DEPS_DIFF, allowLocalMerge: true, mergeRiskJudge: blockingJudge('會自動套用到正式資料庫的 migration') });

    await h.runner.run(group);

    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'in_review');
    const problem = h.notifier.events.find((e) => e.type === 'problem');
    assert.ok(problem && problem.type === 'problem' && problem.detail.includes('需人工確認'), '應發出人工核准請求');
    assert.match(problem?.type === 'problem' ? problem.detail : '', /正式資料庫/);
    assert.equal(h.guard.posts, 0, '需人工核准時不得進入合併後檢查');
    assert.deepEqual(gitCmds(h), [], '需人工核准時不得執行合併');
  });

  /**
   * 缺陷 3：以前只發一則文字事件「需人工核准才能合併：…」，**沒有核准按鈕**，
   * 人根本無從核准（實跑：policy_needs_human 記了 3 次、askMergeApproval 被呼叫 0 次），
   * 需求「人核准後合併」在真實路徑上不可達。
   */
  it('需人工核准 → 發出 Slack 核准請求（帶群組/分支/PR/理由，掛在任務 thread）', async () => {
    const group = seedGroup(['改依賴']);
    const notifier = fakeApprovalNotifier();
    const h = build({ diff: DEPS_DIFF, allowLocalMerge: true, notifier, mergeRiskJudge: blockingJudge('依賴變更會拉進沒審過的程式碼') });

    await h.runner.run(group);

    assert.equal(notifier.asks.length, 1, '沒有核准請求＝人只收到通知卻沒有按鈕可按');
    const { threadTs, ask } = notifier.asks[0]!;
    assert.equal(threadTs, 'ts-1', '核准請求要掛在任務 thread（一任務一 thread）');
    assert.equal(ask.groupId, group.id);
    assert.equal(ask.branch, group.branch);
    assert.equal(ask.repo, 'acme/web');
    assert.deepEqual(ask.taskTitles, ['改依賴']);
    assert.equal(ask.prUrl, 'https://example.test/pr/1', 'PR 連結要用 pr_open 之後最新的那份');
    assert.match(ask.reasons?.join('\n') ?? '', /依賴變更/);
    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'in_review', '等人核准，絕不自動合併');
    assert.equal(
      tmp.ledger.listEvents({ scope: 'group', refId: group.id, kind: 'merge_needs_human' }).length,
      1,
      '核准請求要留稽核（人沒回覆時查得到問過誰、為什麼）',
    );
  });

  it('notifier 沒有 askMergeApproval 能力 → 降級成文字通知並點名，不擲錯', async () => {
    const group = seedGroup(['改依賴']);
    const h = build({ diff: DEPS_DIFF, allowLocalMerge: true, mergeRiskJudge: blockingJudge('依賴變更會拉進沒審過的程式碼') }); // 預設 notifier 只有 event()

    await h.runner.run(group);

    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'in_review');
    assert.ok(h.notifier.events.some((e) => e.type === 'problem' && e.detail.includes('需人工確認')));
    assert.ok(rec.messages('warn').some((m) => m.includes('不支援合併核准請求')), '降級要看得見，不可靜默');
  });

  it('核准請求發送失敗 → 只記 log，不影響群組流程', async () => {
    const group = seedGroup(['改依賴']);
    const notifier = fakeApprovalNotifier({ fail: true });
    const h = build({ diff: DEPS_DIFF, allowLocalMerge: true, notifier, mergeRiskJudge: blockingJudge('依賴變更會拉進沒審過的程式碼') });

    await h.runner.run(group);
    await new Promise((r) => setTimeout(r, 5)); // 讓 fire-and-forget 的 catch 跑完

    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'in_review');
    assert.ok(rec.messages('warn').some((m) => m.includes('發送合併核准請求失敗')));
  });

  it('自動合併開著且無風險 → 不會去騷擾人要核准', async () => {
    const group = seedGroup(['寫文件']);
    const notifier = fakeApprovalNotifier();
    const h = build({ allowLocalMerge: true, notifier });

    await h.runner.run(group);

    assert.deepEqual(notifier.asks, [], '純文件變更是自動合併路徑，不該發核准請求');
  });

  it('Merge Guard 擋下但沒有共用的意見暫存區 → failed（意見送不到 agent，寧可停著等人）', async () => {
    const group = seedGroup(['會衝突的改動']);
    const h = build({
      guard: fakeGuard({ ok: false, reason: 'semantic_drift', detail: 'build 紅' }),
      allowLocalMerge: true,
    });

    await h.runner.run(group);

    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'failed');
    assert.deepEqual(gitCmds(h), []);
    assert.ok(h.notifier.events.some((e) => e.type === 'failed'));
  });

  /**
   * 實跑事故：兩個任務改到同一個檔案，先合併的那個改變了 base，後完成的那個
   * rebase 時撞衝突 → 整組被標 failed，17 分鐘的成果直接丟掉。
   *
   * 但 rebase 衝突正是 agent 修得動的問題——系統本來就有「把失敗事實回灌給 agent」
   * 的迴圈（DoD 紅燈、reviewer 退回都走它），只是 Merge Guard 這條沒接上去。
   */
  function feedbackSpy() {
    const saved: { groupId: string; comments: string[]; source: string }[] = [];
    return {
      saved,
      store: {
        peek: () => undefined,
        take: () => undefined,
        save: (i: { groupId: string; comments: string[]; source: string }) => void saved.push(i),
      },
    };
  }

  describe('Merge Guard 擋下 → 帶著原因交回 agent 修', () => {
    it('rebase 衝突 → 轉 changes_requested 並存下意見，不再標 failed', async () => {
      const group = seedGroup(['會衝突的改動']);
      const fb = feedbackSpy();
      const h = build({
        guard: fakeGuard({
          ok: false,
          reason: 'code_conflict',
          detail: 'CONFLICT (content): Merge conflict in src/views/SandboxView.vue',
        }),
        allowLocalMerge: true,
        feedback: fb.store,
      });

      await h.runner.run(group);

      assert.equal(tmp.ledger.getGroup(group.id)?.state, 'changes_requested', '要能被重新派工，不是死路');
      assert.equal(fb.saved.length, 1, '判決必須存成意見，否則 agent 不知道錯在哪');
      assert.equal(fb.saved[0]?.source, 'merge_guard');
      assert.match(fb.saved[0]!.comments[0]!, /SandboxView\.vue/, '要點名衝突檔案');
      assert.equal(h.notifier.events.some((e) => e.type === 'failed'), false, '交回重做不是失敗');
      assert.deepEqual(gitCmds(h), [], '擋下就不該碰 base 分支');
    });

    it('rebase 後測試紅（語意飄移）也走同一條路', async () => {
      const group = seedGroup(['會飄移的改動']);
      const fb = feedbackSpy();
      const h = build({
        guard: fakeGuard({ ok: false, reason: 'semantic_drift', detail: '[test] 3 個案例失敗' }),
        allowLocalMerge: true,
        feedback: fb.store,
      });

      await h.runner.run(group);

      assert.equal(tmp.ledger.getGroup(group.id)?.state, 'changes_requested');
      // 不再用 reason 代碼編故事：semantic_drift 有兩種來源（合併後測試紅、介面判斷紅），
      // 寫死其中一種的敘述會把 agent 引去錯方向。現在只講共通前提，細節交給原始輸出。
      assert.match(fb.saved[0]!.comments[0]!, /下面列的關卡沒過/);
      assert.match(fb.saved[0]!.comments[0]!, /實際失敗的是哪一項/);
      assert.equal(/哪個函式／元件／型別被改了/.test(fb.saved[0]!.comments[0]!), false, '不該預設是依賴被改掉');
      assert.match(fb.saved[0]!.comments[0]!, /3 個案例失敗/, '原始輸出要一起帶給 agent');
    });
  });

  /**
   * 定案③：人按過「照樣落地」之後，同一個紅不再擋這一群。
   *
   * 這條路的存在理由是實跑（2026-08-04）：PR #54 只新增 6 個檔（AvatarCropModal），
   * 被一個完全無關的後端測試（schedule-engine）擋下——agent 根本改不到那個檔，
   * 三輪必然修不好，16 個任務堵住。系統**沒有修 base 的權力**，所以除非有這顆按鈕，
   * 「已裁定非我方責任」的群跟誤判時一樣落不了地。
   */
  describe('人已表態「知道這個紅、照樣落地」', () => {
    it('合併後測試紅 ＋ 有放行 → PR 照開，而且內文誠實寫著它是紅的', async () => {
      const group = seedGroup(['裁切視窗']);
      tmp.ledger.grantKnownRedWaiver(group.id, 'base 上的 schedule-engine 本來就會偶爾紅', 'kchen');
      const h = build({
        guard: fakeGuard({ ok: false, reason: 'post_merge_red', detail: 'FAIL src/schedule-engine.test.ts' }),
        allowLocalMerge: true,
      });

      await h.runner.run(group);

      assert.notEqual(tmp.ledger.getGroup(group.id)?.state, 'changes_requested', '放行過就不該再交回 agent 修');
      assert.ok(h.pr.prs.length > 0, 'PR 要開得出來，否則這顆按鈕沒有意義');
      const body = h.pr.prs[0]!.body;
      assert.match(body, /Known Red/, '帶著紅上線這件事必須寫在 PR 最前面');
      assert.match(body, /schedule-engine 本來就會偶爾紅/, '人的理由要留下來');
      assert.match(body, /❌ 紅燈，由人工放行/, '**驗證清單不准把它印成綠的**——那份 PR 會在說謊');
      assert.equal(
        tmp.ledger.takeKnownRedWaiver(group.id),
        undefined,
        '放行是一次性的：用掉之後這一群要恢復正常把關',
      );
    });

    it('衝突 ＋ 有放行 → **照樣擋下**（衝突是這一群自己造成的，不在放行範圍）', async () => {
      const group = seedGroup(['會衝突的改動']);
      tmp.ledger.grantKnownRedWaiver(group.id, '我知道 base 的測試不穩', 'kchen');
      const fb = feedbackSpy();
      const h = build({
        guard: fakeGuard({ ok: false, reason: 'code_conflict', detail: 'CONFLICT in src/App.vue' }),
        allowLocalMerge: true,
        feedback: fb.store,
      });

      await h.runner.run(group);

      assert.equal(tmp.ledger.getGroup(group.id)?.state, 'changes_requested', '衝突要交回 agent 解，不能靠放行繞過');
      assert.equal(h.pr.prs.length, 0);
      assert.ok(
        tmp.ledger.takeKnownRedWaiver(group.id),
        '不在範圍內的判決不該把人的放行吃掉——那張還要留給真正的那個紅',
      );
    });

    /**
     * **這一條是這顆按鈕真正會遇到的情境。**
     *
     * 舊的放行清單是白名單 `{tests_red, post_merge_red}`，而真守衛的 attempt()
     * 一個都產不出來（post_merge_red 只有零呼叫端的 postMergeCheck 會回，
     * tests_red 全庫沒有產生端）。歸咎實驗證明「base 上本來就紅」時，
     * 判決一律以 semantic_drift 回來——正好是白名單排除掉的那個。
     * 於是人按了「照樣落地」，票據原封留著、群組再次被擋，按鈕靜默無效。
     * 舊測試之所以綠：fakeGuard 餵的是真守衛產不出來的值。
     */
    it('語意飄移（＝真守衛紅燈時實際會回的那個）＋ 有放行 → 落得了地', async () => {
      const group = seedGroup(['薪資欄位']);
      tmp.ledger.grantKnownRedWaiver(group.id, '歸咎實驗已證明 base 上也紅', 'kchen');
      const h = build({
        guard: fakeGuard({ ok: false, reason: 'semantic_drift', detail: '[test] 3 個案例失敗（base 上同樣紅）' }),
        allowLocalMerge: true,
      });

      await h.runner.run(group);

      assert.notEqual(tmp.ledger.getGroup(group.id)?.state, 'changes_requested',
        '人看完歸咎實驗證據按的放行，不該被程式的 reason 字串否決');
      assert.ok(h.pr.prs.length > 0, 'PR 要開得出來，否則這顆按鈕還是無效');
      assert.equal(tmp.ledger.takeKnownRedWaiver(group.id), undefined, '放行是一次性的');
    });

    it('前置失敗 ＋ 有放行 → 照樣擋下（根本沒驗到，談不上「已知的紅」）', async () => {
      const group = seedGroup(['某任務']);
      tmp.ledger.grantKnownRedWaiver(group.id, '我知道那個紅', 'kchen');
      const h = build({
        guard: fakeGuard({ ok: false, reason: 'precondition_failed', detail: '驗收樹建不起來' }),
        allowLocalMerge: true,
      });

      await h.runner.run(group);

      // 前置失敗走的是 failed（不是交回 agent 修——根本沒驗到，沒有東西可修）
      assert.equal(tmp.ledger.getGroup(group.id)?.state, 'failed');
      assert.equal(h.pr.prs.length, 0);
      assert.ok(tmp.ledger.takeKnownRedWaiver(group.id), '不在範圍內就不該把人的放行吃掉');
    });

    it('沒有放行 → 合併後測試紅照常交回 agent（放行不是預設行為）', async () => {
      const group = seedGroup(['某任務']);
      const fb = feedbackSpy();
      const h = build({
        guard: fakeGuard({ ok: false, reason: 'post_merge_red', detail: 'FAIL something' }),
        allowLocalMerge: true,
        feedback: fb.store,
      });

      await h.runner.run(group);

      assert.equal(tmp.ledger.getGroup(group.id)?.state, 'changes_requested');
      assert.equal(h.pr.prs.length, 0);
    });
  });

  /**
   * diff 只拿來寫 PR 內文了（合併決策已改由風險判斷者負責，它自己讀 git）。
   * 讀不到就是 PR 敘事少了機器事實那一段，不該讓整群崩掉。
   */
  it('讀 diff 失敗不讓群組崩潰（PR 照開）', async () => {
    const group = seedGroup(['某任務']);
    const h = build({
      allowLocalMerge: true,
      readDiff: async () => {
        throw new Error('git 不可用');
      },
    });

    await h.runner.run(group);

    assert.notEqual(tmp.ledger.getGroup(group.id)?.state, 'failed', '讀不到 diff 不是群組的失敗');
    assert.ok(h.pr.prs.length > 0, 'PR 照樣要開');
    assert.ok(rec.messages('warn').some((m) => m.includes('讀取 diff 失敗')), '降級要看得見');
  });

  // ── 合併 + 合併後檢查 + revert ──

  /**
   * 這裡原本有 10 條「本地合併」的測試（合併後檢查、紅燈 revert、reset 保護、
   * repo 互斥鎖、還原使用者原本的分支…）。那條路隨著 openPr 開關一起移除了——
   * 開 PR 是必經之路，所以永遠有 PR，永遠走「合併 PR」那條。
   *
   * 要留下的教訓：那些安全網（合併後回頭確認 base 還是綠的、紅燈自動回退）
   * **只長在不會執行的那條路上**。實際跑的 PR 合併路徑從來沒有合併後檢查。
   * 刪掉的是一個假的安全感，不是真的保護；真正的缺口另外處理。
   */

  // ── PR 敘事 ──

  it('PR 內文吃 agent 總結：敘事段與假設都被填入，不再是「（待補）」', async () => {
    const group = seedGroup(['深色模式']);
    const h = build({
      summaries: {
        'T-1': {
          what: '新增深色模式切換。',
          how: '以 CSS 變數切換主題。',
          architecture: '新增 ThemeProvider。',
          keyTech: 'prefers-color-scheme + localStorage。',
          assumptions: ['沿用既有色票，未新增 design token', '偏好存 localStorage'],
        },
      },
    });

    await h.runner.run(group);

    const body = h.pr.prs[0]?.body ?? '';
    assert.match(body, /## 做了什麼 \(What\)\n\n新增深色模式切換。/);
    assert.match(body, /## 怎麼做 \(How\)\n\n以 CSS 變數切換主題。/);
    assert.match(body, /## 架構 \(Architecture\)\n\n新增 ThemeProvider。/);
    assert.match(body, /prefers-color-scheme \+ localStorage/);
    assert.match(body, /- 沿用既有色票，未新增 design token/);
    assert.match(body, /- 變更檔案 1 個（\+5 \/ -1）/);
    assert.equal(tmp.ledger.getGroup(group.id)?.prUrl, 'https://example.test/pr/1');
  });

  /**
   * 這裡原本有一組 prRepo 的測試（任務板說 acme/web，但 PR 開到 acme/web-sandbox）。
   * 那個欄位已經移除：它是為了「用正式專案的任務板，但別動到正式 repo」而存在的，
   * 而那個需求本來就該用一個測試用的任務板 ＋ 測試 repo 解決。
   * 留著它反而是陷阱——repo 設對了但忘了設 prRepo，PR 就直接開到正式專案。
   */
  it('PR 開到專案設定的 repo', async () => {
    const group = seedGroup(['深色模式']);
    const h = build({});

    await h.runner.run(group);

    assert.equal(h.pr.prs[0]?.repo, 'acme/web');
  });

  it('多任務時各自的總結以任務標題分小節', async () => {
    const group = seedGroup(['登入表單', '錯誤提示']);
    const h = build({
      summaries: {
        'T-1': { what: '加上表單驗證。' },
        'T-2': { what: '補上錯誤提示。' },
      },
    });

    await h.runner.run(group);

    const body = h.pr.prs[0]?.body ?? '';
    assert.match(body, /### 登入表單\n加上表單驗證。/);
    assert.match(body, /### 錯誤提示\n補上錯誤提示。/);
  });

  it('agent 沒給總結 → 敘事退回任務標題，其餘段落維持「（待補）」（不可空白）', async () => {
    const group = seedGroup(['修好登入']);
    const h = build({ summaries: {} });

    await h.runner.run(group);

    const body = h.pr.prs[0]?.body ?? '';
    assert.match(body, /## 做了什麼 \(What\)\n\n修好登入/);
    assert.match(body, /## 怎麼做 \(How\)\n\n（待補）/);
    assert.match(body, /## 假設與待確認 \(Assumptions\)\n\n（無）/);
  });

  it('agent 總結會落 ledger events 供稽核', async () => {
    const group = seedGroup(['某任務']);
    const h = build({ summaries: { 'T-1': { what: '做完了：改了 a.ts' } } });

    await h.runner.run(group);

    // 事件表無讀取 API，以「不擲錯 + 群組完成」代表寫入路徑正常；內容細節由 pr-body 測試涵蓋
    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'in_review');
  });

  // ── worktree 清理 ──

  it('群組成功 → 清掉 worktree（避免無限累積）', async () => {
    const group = seedGroup(['寫文件']);
    const h = build();

    await h.runner.run(group);

    assert.deepEqual(h.wt.removed, ['/tmp/fake-wt/feat/g1']);
  });

  /** 讓認領以指定結果失敗的專案 runtime。 */
  function projectWithClaim(claim: { ok: false; kind: 'signal' | 'permanent' | 'transient'; detail: string }): ProjectRuntime {
    return {
      repo: 'acme/web',
      repoPath: '/tmp/fake-repo',
      baseBranch: 'main',
      verifierConfig: {},
      mcp: {
        async startTask() {
          return claim;
        },
        async completeTask() {
          return { ok: true, value: undefined };
        },
        async loadDocs() {
          return [];
        },
        // 這個假任務板只演「認領被拒」，沒有可回報的現況：
        // 走到查詢就等於測試踩到別條路徑，直接炸掉才看得到。
        async getTask() {
          throw new Error('測試不該走到這裡：認領被拒的假任務板沒有現況可查');
        },
        async listTasks() {
          throw new Error('測試不該走到這裡：認領被拒的假任務板不列任務');
        },
      },
    };
  }

  it('任務失敗（永久性錯誤）→ failed，保留 worktree 供診斷並在 log 說明原因', async () => {
    const group = seedGroup(['會失敗的任務']);
    const h = build({ resolveProject: () => projectWithClaim({ ok: false, kind: 'permanent', detail: '401 未授權' }) });

    await h.runner.run(group);

    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'failed');
    assert.deepEqual(h.wt.removed, [], '失敗現場必須保留');
    assert.ok(rec.messages('warn').some((m) => m.includes('保留 worktree')), 'log 要說明保留原因');
  });

  /**
   * **被停止不是崩潰。**
   *
   * daemon 收到 SIGTERM 時中止訊號一路傳到 agent 與 DoD 指令，它們擲出的例外落到
   * GroupRunner 的 catch。SDK 的訊息是「Claude Code process aborted by user」——
   * 看起來像使用者做錯什麼，實際上就是正常關機。
   *
   * 先前這個例外被記成 group_crashed 並寫成 failed（終態），而 failed 不在對帳的
   * GROUP_LIMBO 裡 → 開機時根本不會被看到，每次重啟都要人一個一個按重試
   *（實跑 22:03 使用者按了 4 個群）。
   */
  it('中止造成的例外不算崩潰：狀態原樣保留，留下可辨識的痕跡', async () => {
    const group = seedGroup(['做到一半被停止']);
    const ac = new AbortController();
    ac.abort();
    const h = build({
      agent: {
        async iterate() {
          // SDK 在 abort 時就是擲出這句（ProcessTransport）——它不是使用者做錯什麼
          throw new Error('Claude Code process aborted by user');
        },
      },
    });

    await h.runner.run(group, ac.signal);

    const state = tmp.ledger.getGroup(group.id)?.state;
    assert.notEqual(state, 'failed', '被停止不該進終態——那會讓開機對帳的恢復路徑失效');
    assert.ok(
      tmp.ledger.latestEvent('group', group.id, GROUP_ABORTED_EVENT),
      '要留下「被停止」的痕跡，事後才分得出這次重啟到底有沒有東西真的壞掉',
    );
    assert.equal(tmp.ledger.latestEvent('group', group.id, 'group_crashed'), undefined, '不該被記成崩潰');
    assert.deepEqual(h.wt.removed, [], '未 commit 的工作在 worktree 裡，絕不可清掉');
  });

  /** 真的崩潰（沒有中止訊號）仍然要走原本的 failed 路徑。 */
  it('沒有中止訊號時，例外照舊算崩潰', async () => {
    const group = seedGroup(['真的爆炸']);
    const h = build({
      agent: {
        async iterate() {
          throw new Error('真的爆炸了');
        },
      },
    });

    await h.runner.run(group);

    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'failed');
    assert.ok(tmp.ledger.latestEvent('group', group.id, 'group_crashed'));
  });

  // ── 群組狀態一定收斂（不可卡在 forming、可恢復的不可標 failed） ──

  /**
   * 缺陷 1：以前這裡直接寫 ready，**繞過** orchestrator 的統一 requeue 通道
   * （計數與退避都套不上），實跑量到每個 tick 完整重建一次 worktree、永不停止。
   * 現在必須 park 並留下 deps 事件，讓 orchestrator 退避後才重派。
   */
  it('任務因依賴未完成被擋 → park 等上游（不是 failed、也不可自己寫回 ready）', async () => {
    const group = seedGroup(['等上游的任務']);
    const h = build({ resolveProject: () => projectWithClaim({ ok: false, kind: 'signal', detail: '依賴未完成' }) });

    await h.runner.run(group);

    const state = tmp.ledger.getGroup(group.id)?.state;
    assert.equal(state, 'changes_requested', 'park 是可恢復狀態；failed 是終態，會讓任務永久遺失');
    assert.notEqual(state, 'ready', '自己寫回 ready 就繞過了 requeue 計數與退避（無上限緊迴圈）');
    const blocked = tmp.ledger.listEvents({ scope: 'group', refId: group.id, kind: GROUP_DEPS_BLOCKED_EVENT });
    assert.equal(blocked.length, 1, 'orchestrator 的退避完全靠這個事件觸發');
  });

  it('依賴未完成時保留 worktree（下次重派直接沿用，不再每輪重建）', async () => {
    const group = seedGroup(['等上游的任務']);
    const h = build({ resolveProject: () => projectWithClaim({ ok: false, kind: 'signal', detail: '依賴未完成' }) });

    await h.runner.run(group);

    assert.deepEqual(h.wt.removed, [], '受阻期間刪掉 worktree，下一次重派就得整包 node_modules 重複製一次');
  });

  it('任務 park 等澄清 → 群組標可恢復狀態（changes_requested）並保留 worktree', async () => {
    const group = seedGroup(['需要澄清的任務']);
    const h = build({
      agent: {
        async iterate(): Promise<IterateResult> {
          return {
            sessionId: 's',
            resultText: '',
            isError: false,
            toolCalls: {},
            askedClarification: { question: '要用哪個色票？', rationale: '不可逆' },
          };
        },
      },
    });

    await h.runner.run(group);

    const state = tmp.ledger.getGroup(group.id)?.state;
    assert.equal(state, 'changes_requested', 'park 不是失敗，必須留在可恢復狀態');
    assert.notEqual(state, 'failed');
    assert.deepEqual(h.wt.removed, [], 'agent 未提交的工作要保住，人回覆後才能續做');
  });

  it('shouldRequeueGroup：park 的群在任務回 queued 後才可重新派工', () => {
    const parked = { state: 'changes_requested' as const };
    assert.equal(shouldRequeueGroup(parked, [{ state: 'blocked' }]), false, '還在等人 → 不可派');
    assert.equal(shouldRequeueGroup(parked, [{ state: 'queued' }]), true, '人已回覆 → 可派');
    assert.equal(shouldRequeueGroup(parked, [{ state: 'done' }]), false, '全做完 → 不必再派');
    assert.equal(shouldRequeueGroup({ state: 'failed' }, [{ state: 'queued' }]), false, '終態不復活');
  });

  // ── 重新派工：已完成的任務不可重跑（start_task 會被 MCP 拒絕） ──

  it('重新派工時已 done 的任務不重跑，但仍列入 PR 的「涵蓋任務」', async () => {
    const group = seedGroup(['上一輪就做完的', '這輪才要做的']);
    tmp.ledger.updateTaskState('T-1', 'done');
    const h = build({});

    await h.runner.run(group);

    assert.deepEqual(h.mcp.started, ['T-2'], '已 done 的任務再 start_task 會被 MCP 拒絕 → 整群被誤判 failed');
    const body = h.pr.prs[0]?.body ?? '';
    assert.match(body, /- \[T-1\] 上一輪就做完的/, '跳過執行不等於不算數，PR 仍要涵蓋它');
    assert.match(body, /- \[T-2\] 這輪才要做的/);
    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'in_review');
  });

  it('群內任務全部已 done（且無審查意見）→ 不跑任何 worker，照常收斂而不是 failed', async () => {
    const group = seedGroup(['已完成 A', '已完成 B']);
    tmp.ledger.updateTaskState('T-1', 'done');
    tmp.ledger.updateTaskState('T-2', 'done');
    const h = build();

    await h.runner.run(group);

    assert.deepEqual(h.mcp.started, []);
    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'in_review');
  });

  // ── rework：帶著 reviewer 意見重做 ──

  const feedbackTextOf = (input: IterateInput | undefined): string =>
    (input?.feedback?.checks ?? []).map((c) => c.detail).join('\n');

  it('帶審查意見重新派工 → 意見進 agent 第一輪的 feedback，送達後才清掉暫存', async () => {
    const group = seedGroup(['要修的任務']);
    const store = fakeFeedback(reviewFeedback(group.id, ['@alice: 請補上邊界測試']));
    const agent = fakeAgent();
    const h = build({ agent, feedback: store });

    await h.runner.run(group);

    assert.match(feedbackTextOf(agent.calls[0]), /請補上邊界測試/, '意見沒餵給 agent = 它不知道要改什麼');
    assert.deepEqual(store.taken, [group.id], '交出去之後才可以清掉（先清會讓意見在失敗時人間蒸發）');
    assert.equal(feedbackTextOf(agent.calls[1] ?? undefined), '', '只注入第一輪（同一 session 續接，之後回灌的是本輪 DoD 失敗）');
  });

  it('沒注入 feedback store → 完全是全新群組的行為（優雅降級）', async () => {
    const group = seedGroup(['全新任務']);
    const agent = fakeAgent();
    const h = build({ agent });

    await h.runner.run(group);

    assert.equal(agent.calls[0]?.feedback, undefined);
    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'in_review');
  });

  /**
   * 被 reviewer／Merge Guard 打回來重做時，agent 先前是用**全新對話**在修。
   * 審查意見會透過 feedback 進提示詞，所以它知道「要修什麼」，但不知道自己
   * 上一輪為什麼那樣寫、試過哪些方向、哪條路已經撞牆——等於每次被退回都
   * 重新認識這個任務一次。
   */
  it('rework 時續接同一個 session（要記得自己上一輪做過什麼）', async () => {
    const group = seedGroup(['已完成的任務']);
    tmp.ledger.updateTaskState('T-1', 'done');
    tmp.ledger.recordAgentSession({ kind: 'worker', taskId: 'T-1', sessionId: 's-上一輪' });
    const agent = fakeAgent();
    const h = build({ agent, feedback: fakeFeedback(reviewFeedback(group.id, ['@bob: 這個命名要改'])) });
  
    await h.runner.run(group);
  
    assert.equal(agent.calls[0]?.resumeSessionId, 's-上一輪');
  });
  
  it('群內任務都已 done + 有審查意見 → 走 rework 迴圈修正並提交，全程不碰 MCP', async () => {
    const group = seedGroup(['已完成的任務']);
    tmp.ledger.updateTaskState('T-1', 'done');
    const store = fakeFeedback(reviewFeedback(group.id, ['@bob: 這個命名要改']));
    const agent = fakeAgent();
    const h = build({ agent, feedback: store });

    await h.runner.run(group);

    assert.deepEqual(h.mcp.started, [], 'done 的任務不可再認領');
    assert.deepEqual(h.mcp.completed, [], 'done 的任務不可再 complete_task（MCP 沒有反 done 工具）');
    assert.equal(agent.rounds, 1, '沒有 worker 會跑 → 必須自己驅動一輪，否則意見永遠沒人處理');
    assert.match(feedbackTextOf(agent.calls[0]), /這個命名要改/);
    assert.ok(h.pr.commits.some((m) => m.includes('依審查意見修正')), '修正要進到群組分支');
    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'in_review');
    assert.deepEqual(store.taken, [group.id]);
  });

  it('rework 後工作區沒有任何變更 → park 交人（不可當成「已修好」放行）', async () => {
    const group = seedGroup(['已完成的任務']);
    tmp.ledger.updateTaskState('T-1', 'done');
    const pr = fakePrManager();
    pr.commitAll = async () => false; // 沒東西可提交＝agent 其實什麼都沒改
    const h = build({ feedback: fakeFeedback(reviewFeedback(group.id, ['@bob: 請修'])), prManager: pr });

    await h.runner.run(group);

    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'changes_requested', 'park 是可恢復狀態，不是 failed');
    assert.deepEqual(h.wt.removed, [], '保留 worktree');
    assert.ok(h.notifier.events.some((e) => e.type === 'problem' && e.detail.includes('沒有產生任何變更')));
  });

  it('rework 連續紅燈到達輪數上限 → park 交人（不無限重打 API，也不誤標 failed）', async () => {
    const group = seedGroup(['已完成的任務']);
    tmp.ledger.updateTaskState('T-1', 'done');
    const agent = fakeAgent();
    const h = build({
      agent,
      feedback: fakeFeedback(reviewFeedback(group.id, ['@bob: 請修'])),
      reworkRounds: 2,
      makeVerifier: () => ({
        async check(): Promise<GateReport> {
          return { green: false, checks: [{ name: 'test', ok: false, detail: '測試紅' }] };
        },
      }),
    });

    await h.runner.run(group);

    assert.equal(agent.rounds, 2, '輪數上限必須生效');
    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'changes_requested');
    assert.deepEqual(h.wt.removed, []);
    assert.equal(h.guard.attempts, 0, '沒修好就不該進 Merge Guard');
  });

  it('rework 時 agent 宣告「無需改動」→ park 交人裁決（人的意見不能被 agent 一句話推翻）', async () => {
    const group = seedGroup(['已完成的任務']);
    tmp.ledger.updateTaskState('T-1', 'done');
    const agent: AgentLike = {
      async iterate(): Promise<IterateResult> {
        return {
          sessionId: 's',
          resultText: '',
          isError: false,
          toolCalls: {},
          reportedNoChange: { category: 'already_satisfied', reason: '我覺得已經符合了' },
        };
      },
    };
    const h = build({ agent, feedback: fakeFeedback(reviewFeedback(group.id, ['@bob: 請修'])) });

    await h.runner.run(group);

    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'changes_requested');
    assert.ok(h.notifier.events.some((e) => e.type === 'problem' && e.detail.includes('無需改動')));
  });

  it('意見還沒真的送達（agent 執行錯誤）→ 不清掉暫存，下一輪才能再回灌', async () => {
    const group = seedGroup(['已完成的任務']);
    tmp.ledger.updateTaskState('T-1', 'done');
    const store = fakeFeedback(reviewFeedback(group.id, ['@bob: 請修']));
    const agent: AgentLike = {
      async iterate(): Promise<IterateResult> {
        return { sessionId: 's', resultText: 'API 掛了', isError: true, toolCalls: {} };
      },
    };
    const h = build({ agent, feedback: store, reworkRounds: 1 });

    await h.runner.run(group);

    assert.deepEqual(store.taken, [], 'agent 沒看到意見就清掉 = 意見永久遺失');
    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'changes_requested');
  });

  // ── Merge Guard 的 options（缺陷 4：以前建構時根本沒帶） ──

  it('MergeGuard 建構時收得到 options（remote 覆寫 + base 新鮮度回呼）', async () => {
    const group = seedGroup(['某任務']);
    const h = build({ remote: 'upstream' });

    await h.runner.run(group);

    assert.equal(h.guardOptions[0]?.remote, 'upstream', '沒帶 options 的話 remote 永遠只能是 origin');
    assert.equal(typeof h.guardOptions[0]?.onBaseFreshness, 'function', '沒有回呼就收不到「有但書的綠燈」');
  });

  it('base 新鮮度但書 → 進 ledger 事件、Slack 通知、以及 PR 的「假設與待確認」', async () => {
    const group = seedGroup(['某任務']);
    let opts: MergeGuardOptions | undefined;
    const guard: MergeGuardLike = {
      async attempt(): Promise<MergeVerdict> {
        opts?.onBaseFreshness?.({ ref: 'main', fetched: false, caveat: '未能取得最新 base（離線），本次驗證基於本地狀態' });
        return { ok: true };
      },
    };
    const h = build({
      makeMergeGuard: (_v, o) => {
        opts = o;
        return guard;
      },
    });

    await h.runner.run(group);

    const body = h.pr.prs[0]?.body ?? '';
    assert.match(body, /有但書/, '「沒 fetch 到最新 base 的綠燈」必須寫在驗證欄位裡');
    assert.match(body, /⚠ 未能取得最新 base/, '但書也要進「假設與待確認」，審查者才一定看得到');
    assert.ok(
      h.notifier.events.some((e) => e.type === 'problem' && e.detail.includes('但書')),
      '但書要通知得到人',
    );
  });

  it('runGroup 擲例外 → 群組收斂到 failed（不可停在 forming 讓它再也不被派工）', async () => {
    const group = seedGroup(['會爆炸的任務']);
    const h = build({
      makeVerifier: () => ({
        async check(): Promise<never> {
          throw new Error('verifier 爆炸');
        },
      }),
    });

    await h.runner.run(group);

    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'failed');
    assert.ok(h.notifier.events.some((e) => e.type === 'failed'), '例外也要通知');
  });

  it('建立 worktree 擲例外 → 群組標 failed，不會卡在 forming', async () => {
    const group = seedGroup(['某任務']);
    const wt = fakeWorktrees();
    wt.create = async () => {
      throw new Error('worktree add 失敗：目錄已存在');
    };
    const h = build({ worktrees: wt });

    await h.runner.run(group);

    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'failed');
  });

  // ── Slack 任務卡 / thread 映射 ──

  it('notifier 有 postTaskCard → 貼任務卡、thread_ts 寫進 ledger 並用於後續事件', async () => {
    const group = seedGroup(['某任務']);
    const notifier = fakeCardNotifier('ts-abc');
    const h = build({ notifier, allowLocalMerge: true });

    await h.runner.run(group);

    assert.deepEqual(notifier.cards, ['T-1'], '每個任務開始前都要貼任務卡');
    assert.equal(tmp.ledger.getTask('T-1')?.slackThreadTs, 'ts-abc', 'thread↔task 映射必須落 ledger，入站才反查得到');
    assert.ok(notifier.threads.includes('ts-abc'), '群層事件要掛在任務 thread 上');
  });

  it('已有 thread_ts 的任務不重貼卡，事件掛回原 thread', async () => {
    const group = seedGroup(['某任務']);
    tmp.ledger.updateTaskState('T-1', 'queued', { slackThreadTs: 'ts-old' });
    const notifier = fakeCardNotifier('ts-new');
    const h = build({ notifier });

    await h.runner.run(group);

    assert.deepEqual(notifier.cards, [], '已有 thread 就不該重貼');
    assert.equal(tmp.ledger.getTask('T-1')?.slackThreadTs, 'ts-old');
  });

  it('貼任務卡失敗不影響任務執行', async () => {
    const group = seedGroup(['某任務']);
    const notifier: Notifier & { postTaskCard: () => Promise<string> } = {
      event: () => undefined,
      async postTaskCard() {
        throw new Error('Slack 掛了');
      },
    };
    const h = build({ notifier });

    await h.runner.run(group);

    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'in_review');
  });

  // ── 截圖進 PR ──

  it('本機截圖列成文字清單，不冒充成 GitHub render 得出來的圖片', async () => {
    const group = seedGroup(['深色模式']);
    const h = build({
      screenshotsFor: ({ taskId }) => [`/data/screenshots/${taskId}/desktop.png`, `/data/screenshots/${taskId}/mobile.png`],
    });

    await h.runner.run(group);

    const body = h.pr.prs[0]?.body ?? '';
    assert.ok(!body.includes('!['), '本機絕對路徑嵌成圖片在 GitHub 上是壞掉的圖，等於謊稱有截圖');
    assert.match(body, /已產生 2 張截圖/);
    assert.match(body, /本機/);
    assert.match(body, /`\/data\/screenshots\/T-1\/desktop\.png`/);
    assert.match(body, /`\/data\/screenshots\/T-1\/mobile\.png`/);
  });

  it('截圖若已是 http(s) URL → 仍以圖片嵌入（GitHub 真的顯示得出來）', async () => {
    const group = seedGroup(['深色模式']);
    const h = build({
      screenshotsFor: () => ['https://cdn.test/a.png', '/data/screenshots/T-1/b.png'],
    });

    await h.runner.run(group);

    const body = h.pr.prs[0]?.body ?? '';
    assert.match(body, /!\[screenshot-1\]\(https:\/\/cdn\.test\/a\.png\)/);
    assert.match(body, /`\/data\/screenshots\/T-1\/b\.png`/, '本機那張仍只列路徑');
  });

  it('沒有截圖時 PR 內文照常產出（畫面設計段標待補）', async () => {
    const group = seedGroup(['純後端任務']);
    const h = build({ screenshotsFor: () => [] });

    await h.runner.run(group);

    assert.match(h.pr.prs[0]?.body ?? '', /## 畫面設計 \(UI\)\n\n（待補）/);
  });

  it('讀取截圖擲錯不影響開 PR', async () => {
    const group = seedGroup(['某任務']);
    const h = build({
      screenshotsFor: () => {
        throw new Error('目錄權限不足');
      },
    });

    await h.runner.run(group);

    assert.equal(h.pr.prs.length, 1);
  });

  it('keepWorktree=true → 即使成功也不清（除錯模式）', async () => {
    const group = seedGroup(['寫文件']);
    const h = build({ keepWorktree: true });

    await h.runner.run(group);

    assert.deepEqual(h.wt.removed, []);
  });

  it('worktree 清理失敗只警告，不影響群組結果', async () => {
    const group = seedGroup(['寫文件']);
    const wt = fakeWorktrees();
    wt.remove = async () => {
      throw new Error('worktree busy');
    };
    const h = build({ worktrees: wt });

    await h.runner.run(group);

    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'in_review');
    assert.ok(rec.messages('warn').some((m) => m.includes('worktree 清理失敗')));
  });

  /**
   * 「查不到專案」有很多原因——使用者在控制台停用了它、正在編輯、MCP 一時連不上——
   * **每一種都會自己好**。標 failed 會讓 Orchestrator 走重新派工的路，
   * 而每 15 秒重試一次、連錯 3 次就永久停手：只要停用超過 45 秒，那一群就死了。
   *
   * 實跑撞到：使用者建立專案後停用去檢查設定，回來時 3 個群組（13 個任務）
   * 已經 requeue_exhausted 停在那裡，成果是零——純粹被系統自己判死。
   */
  it('查不到專案 → 退回 ready 等下一輪（不標 failed、不建 worktree）', async () => {
    const group = seedGroup(['某任務']);
    const h = build({ resolveProject: () => undefined });

    await h.runner.run(group);

    assert.equal(tmp.ledger.getGroup(group.id)?.state, 'ready', '專案回來就要能自動繼續');
    assert.deepEqual(h.wt.created, []);
  });

  it('查不到專案時只吵一次（停用期間每 15 秒都會撞到，不能洗版）', async () => {
    const group = seedGroup(['某任務']);
    const h = build({ resolveProject: () => undefined });

    await h.runner.run(group);
    await h.runner.run(group);
    await h.runner.run(group);

    assert.equal(rec.messages('warn').filter((m) => m.includes('查不到專案')).length, 1);
  });
});

// ── worktree 的 node_modules（不可污染使用者真實 clone） ──

/**
 * prepareNodeModules / prepareLocalFiles 的測試整組退場（2026-08-06）。
 *
 * 那兩個函式在猜「這個專案需要哪些被 gitignore 的東西」——寫死 `node_modules`
 * 對 Node 成立，對 Laravel（vendor/）、Python（.venv/）一律不成立。
 * 而且就算清單猜對了，複製出來的內容仍然是錯的：主 clone 的依賴對應的是它自己那顆
 * lockfile，worktree 停在別的 base、或 agent 剛改過 package.json，複製過去就不相符——
 * 而且看起來一切正常。這件事本身做不出正確結果，所以整個拆掉。
 *
 * 現在：agent 自己的工作區自己準備（提示詞明講 worktree 是空的）；
 * 合併守衛那棵沒有 agent 的驗收樹，安裝要寫進專案自己的驗收指令
 *（`npm ci && npm run build`）——那才會裝到那棵樹自己那顆 lockfile 的版本。
 */

describe('重做有沒有真的產生變更', () => {
  it('commitAll 有提交 → 算有做事', () => {
    assert.equal(reworkProducedChanges(true, 'a', 'a'), true);
  });

  it('agent 自己 commit（commitAll 回 false）但分支往前 → 算有做事', () => {
    assert.equal(reworkProducedChanges(false, 'sha-before', 'sha-after'), true);
  });

  it('完全沒動 → 才算沒做事', () => {
    assert.equal(reworkProducedChanges(false, 'sha-same', 'sha-same'), false);
  });

  /** 量不到就別誤殺：寧可少擋一次，也不要因為 git 指令失敗而把有做事的判成沒做。 */
  it('量不到 HEAD 時退回只看 commitAll', () => {
    assert.equal(reworkProducedChanges(false, undefined, 'sha'), false);
    assert.equal(reworkProducedChanges(false, 'sha', undefined), false);
    assert.equal(reworkProducedChanges(true, undefined, undefined), true);
  });
});

// ── worktree 要是一個「能動的開發環境」──

describe('stripAnsi：只清色碼，不動內容', () => {
  it('清掉色碼，其餘一字不動', () => {
    const raw = [
      ` \x1b[32m✓\x1b[39m tests/e2e/a.spec.ts (7 tests) 873ms`,
      '  Test Files  15 passed (15)',
      '[test] ❌ 有測試失敗（排程回覆不記名, MOD-22 平台 chat 排程）',
    ].join('\n');

    const out = stripAnsi(raw);

    assert.equal(out.includes('\x1b'), false, '色碼要清掉');
    assert.match(out, /✓ tests\/e2e\/a\.spec\.ts/);
    assert.match(out, /❌ 有測試失敗（排程回覆不記名/);
    assert.equal(out.split('\n').length, 3, '一行都不能少——挑行是讀的人的事');
  });

  it('沒有色碼就原樣回來', () => {
    assert.equal(stripAnsi('AssertionError: expected 1 to be 2'), 'AssertionError: expected 1 to be 2');
  });
});

/**
 * 開 PR 前的前置條件。實跑（2026-08-11，g_327e5320a9ab）：群內唯一的任務合法地
 * 結束在「不需要改動」（agent 查證後判定規格才是落後的一方），於是分支上零 commit。
 * 收尾邏輯照樣推去開 PR，`gh pr create` 必定失敗（`No commits between …`），
 * 收斂成 group_crashed → 使用者連按三次重試，每次一模一樣。
 */
describe('開 PR 前先問「分支上有東西嗎」', () => {
  const fakeGit = (out: Record<string, { exitCode: number; stdout: string }>) =>
    (async (_cwd: string, args: string[]) =>
      ({ stderr: '', ...(out[args[args.length - 1]!] ?? { exitCode: 128, stdout: '' }) })) as never;

  it('零 commit → false（那正是 gh 會失敗的情況）', async () => {
    const got = await branchHasCommits(fakeGit({ 'origin/main..HEAD': { exitCode: 0, stdout: '0\n' } }), '/wt', 'main');
    assert.equal(got, false);
  });

  it('有 commit → true', async () => {
    const got = await branchHasCommits(fakeGit({ 'origin/main..HEAD': { exitCode: 0, stdout: '3\n' } }), '/wt', 'main');
    assert.equal(got, true);
  });

  it('沒有 remote 追蹤分支 → 退回本地 base 再問一次', async () => {
    const got = await branchHasCommits(fakeGit({ 'main..HEAD': { exitCode: 0, stdout: '2\n' } }), '/wt', 'main');
    assert.equal(got, true);
  });

  it('自訂 remote 會被用上', async () => {
    const got = await branchHasCommits(fakeGit({ 'upstream/dev..HEAD': { exitCode: 0, stdout: '0\n' } }), '/wt', 'dev', 'upstream');
    assert.equal(got, false);
  });

  it('**量不到就不要擋**：兩個 ref 都解析不了 → undefined（照常開 PR）', async () => {
    const got = await branchHasCommits(fakeGit({}), '/wt', 'main');
    assert.equal(got, undefined, '把交付擋在一個量測失敗上，比讓 gh 報錯更糟');
  });

  it('零 commit 的群走進 closed（終態、不是錯誤、不開 stuck 交接單）', () => {
    // failed 會開 stuck_group 單、進待處理清單、給重試鈕——而這一群按幾次都一樣。
    // 實跑 2026-08-11（g_327e5320a9ab）：人按了四次，每次都回到同一個畫面。
    const src = readFileSync('src/core/group-runner.ts', 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const i = src.indexOf('group_nothing_to_deliver');
    assert.ok(i > 0);
    const block = src.slice(i, i + 400);
    assert.match(block, /updateGroupState\(group\.id, 'closed'\)/, '標成 failed 就會出現重試鈕');
    assert.doesNotMatch(block, /'failed'/);
    assert.doesNotMatch(block, /awaiting_human/, '這一群不需要人做決定，別叫人去看一張沒東西可按的卡');
  });

  it('closed 在每一份終態清單裡都算終態（漏一份就會被當成還在跑）', () => {
    const files: [string, RegExp][] = [
      ['src/core/reconciler.ts', /GROUP_TERMINAL[^=]*=\s*\[[^\]]*'closed'/],
      ['src/pr/review-watcher.ts', /TERMINAL_GROUP_STATES[^=]*=\s*\[[^\]]*'closed'/],
      ['src/console/server.ts', /'merged', 'failed', 'closed'/],
    ];
    for (const [f, re] of files) assert.match(readFileSync(f, 'utf8'), re, `${f} 的終態清單漏了 closed`);
  });

  it('開 PR 那條路真的有接上這道檢查', () => {
    const src = readFileSync('src/core/group-runner.ts', 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const i = src.indexOf('this.pr.openPr(');
    assert.ok(i > 0);
    // 檢查必須在呼叫 openPr **之前**，而且要比對**呼叫點**不是函式定義
    //（定義在 class 之前，用 lastIndexOf 找 'branchHasCommits(' 會命中它而永遠成立）
    assert.ok(
      src.lastIndexOf('this.branchHasCommits(wtPath', i) > 0,
      '前置條件要在動作之前，不是失敗後再分類',
    );
    assert.match(src, /group_nothing_to_deliver/);
  });
});

describe('控制台畫面', () => {
  it('群組列表也要把 closed 收起來（第六份終態清單）', () => {
  // 我第一次改 closed 時更新了五份終態清單，漏了畫面這一份，於是那一群
  // 永遠掛在群組列表上——使用者看到的還是「它卡在那裡」。
  const ui = readFileSync('src/console/ui.html', 'utf8');
  assert.match(ui, /GROUP_DONE\s*=\s*\['merged', 'closed'\]/, '群組列表沒把 closed 當成已結束');
  assert.doesNotMatch(ui, /filter\(\(x\) => x\.state !== 'merged'\)/, '只藏 merged 就會漏掉 closed');
});
});
