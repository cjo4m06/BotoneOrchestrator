import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execa, execaSync } from 'execa';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MergeGuard, type BaseFreshness, type DriftJudgeLike, type GitExecResult, type GitRunner } from '../src/pr/merge-guard.js';
import { Verifier } from '../src/worker/verifier.js';
import type { VerifierLike } from '../src/contracts.js';
import type { GateReport } from '../src/types.js';
import {
  createTmpDir,
  createTmpGitRepo,
  createSilentLogger,
  createRecordingLogger,
  type TmpGitRepo,
} from './helpers/index.js';

function fakeVerifier(green: boolean, checks: GateReport['checks'] = []): VerifierLike & { calls: { cwd: string }[] } {
  const calls: { cwd: string }[] = [];
  return {
    calls,
    async check(input) {
      calls.push({ cwd: input.cwd });
      return { green, checks, signature: green ? 'g' : 'r' };
    },
  };
}

// 基底：lib.js 提供 foo()，app.js 使用它。node app.js 即「專案測試」。
const BASE_FILES = {
  'lib.js': 'export function foo() { return 1; }\n',
  'app.js': "import { foo } from './lib.js';\nif (foo() !== 1) process.exit(1);\n",
  'package.json': '{"type":"module"}\n',
};

// 測試不得依賴使用者的 git 全域設定（簽章/hook/預設分支都可能不同）
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Botone Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Botone Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
} as const;

function git(cwd: string, ...args: string[]): string {
  return execaSync('git', args, { cwd, env: GIT_ENV, extendEnv: true }).stdout.trim();
}

function commitIn(cwd: string, files: Record<string, string>, message: string): void {
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(cwd, rel), content, 'utf8');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '--quiet', '-m', message);
}

interface RemoteSetup {
  /** bare repo（扮演 GitHub） */
  origin: string;
  /** 別人的工作副本：用來把「別的 PR」推上 origin */
  upstream: string;
  /** 守衛實際操作的 clone（有 origin remote） */
  work: string;
  cleanup(): void;
}

/** 建一組 origin(bare) + upstream + work clone，用來重現「remote 有新變更、本地卻不知道」。 */
function createRemoteSetup(files: Record<string, string> = BASE_FILES): RemoteSetup {
  const dir = createTmpDir('botone-remote-');
  const origin = join(dir.path, 'origin.git');
  const upstream = join(dir.path, 'upstream');
  const work = join(dir.path, 'work');

  git(dir.path, 'init', '--bare', '--quiet', '-b', 'main', origin);
  mkdirSync(upstream, { recursive: true });
  git(upstream, 'init', '--quiet', '-b', 'main');
  configure(upstream);
  commitIn(upstream, files, 'base');
  git(upstream, 'remote', 'add', 'origin', origin);
  git(upstream, 'push', '--quiet', 'origin', 'main');

  git(dir.path, 'clone', '--quiet', origin, work);
  configure(work);
  return { origin, upstream, work, cleanup: () => dir.cleanup() };
}

function configure(repo: string): void {
  git(repo, 'config', 'user.name', 'Botone Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
}

/**
 * 記錄所有 git 呼叫的假 runner；預設每個指令都成功。
 *
 * `rev-parse` 回一個像樣的 40 位 sha：驗收樹會拿它當「這次驗的是哪一顆 base」，
 * 而那個欄位有格式檢查（存 ref 名字進去等於放一個會飄的東西）。
 */
function spyGit(overrides: (args: string[]) => GitExecResult | undefined = () => undefined): {
  runner: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    async runner(_repoPath, args) {
      calls.push(args);
      const forced = overrides(args);
      if (forced) return forced;
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'a'.repeat(40), stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

describe('MergeGuard — 合併守衛', () => {
  let repo: TmpGitRepo;

  beforeEach(() => {
    repo = createTmpGitRepo({ files: BASE_FILES, branch: 'main', message: 'base' });
  });
  afterEach(() => repo.cleanup());

  /** 從 main 拉出群組分支、提交一筆變更後切回 main。 */
  function branchWith(name: string, files: Record<string, string>, msg: string): void {
    repo.git('checkout', '--quiet', '-b', name);
    repo.commit(files, msg);
    repo.git('checkout', '--quiet', 'main');
  }

  /**
   * Merge Guard 重跑 DoD 時**必須把任務資訊帶下去**。
   *
   * 實跑撞到：同一輪裡，任務關卡那次的介面判斷者有查 git（分得出新舊問題），
   * Merge Guard 這次沒有——因為這裡呼叫 verifier 時完全沒傳 task，
   * 判斷者拿不到 baseRef 就沒有唯讀 git 可用。而擋下 PR 的正是後者，
   * 於是別人先前 commit 的畫面瑕疵被算到這次頭上。
   */
  it('重跑 DoD 時要把任務資訊（含 baseRef）帶給 verifier', async () => {
    branchWith('feat/a', { 'feature.js': 'export const a = 1;\n' }, 'add feature');
    repo.commit({ 'readme.md': 'hi\n' }, 'main moves on');

    const seen: unknown[] = [];
    const verifier = {
      async check(input: { cwd: string; task?: unknown }) {
        seen.push(input.task);
        return { green: true, checks: [], signature: 'g' };
      },
    };
    const guard = new MergeGuard(verifier as never, createSilentLogger());
    await guard.attempt({
      repoPath: repo.path, branch: 'feat/a', base: 'main', verifierConfig: { test: 'exit 0' },
      task: { id: 'T-1', title: '加一顆按鈕', baseRef: 'origin/main' },
    });

    assert.deepEqual(seen[0], { id: 'T-1', title: '加一顆按鈕', baseRef: 'origin/main' });
  });

  /**
   * 第三層（判斷層）：前兩層都是事實——rebase 有沒有衝突、合併後測試紅不紅。
   * 它們抓不到「能編譯、測試也綠，但兩邊的意圖打架」。這批測試驗證那一層真的接上了，
   * 而且**只在事實層全綠之後**才跑（前面就擋下來時不該白花一次 agent 呼叫）。
   */
  describe('語意飄移判斷層', () => {
    function spyJudge(verdict: Awaited<ReturnType<DriftJudgeLike['judge']>>) {
      const calls: { baseChanges: string; groupChanges: string; taskTitles: string[] }[] = [];
      return {
        calls,
        judge: {
          judge: async (i: Parameters<DriftJudgeLike['judge']>[0]) => {
            calls.push({ baseChanges: i.baseChanges, groupChanges: i.groupChanges, taskTitles: i.taskTitles });
            return verdict;
          },
        } as DriftJudgeLike,
      };
    }

    it('事實層全綠但判斷層說意圖打架 → semantic_drift，且原因可直接回灌 agent', async () => {
      branchWith('feat/a', { 'feature.js': 'export const a = 1;\n' }, 'add feature');
      repo.commit({ 'readme.md': 'hi\n' }, 'main moves on');

      const spy = spyJudge({
        status: 'conflict',
        findings: [{ where: 'feature.js', baseIntent: '要二次確認', groupIntent: '一鍵完成', why: '互斥' }],
      });
      const guard = new MergeGuard(fakeVerifier(true), createSilentLogger(), { driftJudge: spy.judge });

      const verdict = await guard.attempt({
        repoPath: repo.path, branch: 'feat/a', base: 'main',
        verifierConfig: { test: 'exit 0' }, taskTitles: ['把清除資料改成一鍵完成'],
      });

      assert.equal(verdict.ok, false);
      assert.equal(verdict.ok === false ? verdict.reason : '', 'semantic_drift');
      assert.match(verdict.ok === false ? verdict.detail! : '', /feature\.js/);
      assert.deepEqual(spy.calls[0]?.taskTitles, ['把清除資料改成一鍵完成'], '要把本群在做什麼帶給判斷者');
      assert.match(spy.calls[0]!.baseChanges, /readme\.md/, 'base 這段期間多的變更要餵進去');
      assert.match(spy.calls[0]!.groupChanges, /feature\.js/, '本群的變更也要餵進去');
    });

    it('判斷層說 clean → 照常放行', async () => {
      branchWith('feat/a', { 'feature.js': 'export const a = 1;\n' }, 'add feature');
      repo.commit({ 'readme.md': 'hi\n' }, 'main moves on');
      const spy = spyJudge({ status: 'clean', notes: [] });
      const guard = new MergeGuard(fakeVerifier(true), createSilentLogger(), { driftJudge: spy.judge });

      const verdict = await guard.attempt({
        repoPath: repo.path, branch: 'feat/a', base: 'main', verifierConfig: { test: 'exit 0' },
      });
      assert.equal(verdict.ok, true);
    });

    it('前兩層就擋下來時不呼叫判斷層（不白花錢）', async () => {
      branchWith('feat/a', { 'lib.js': 'export function foo() { return 2; }\n' }, 'branch changes lib');
      repo.commit({ 'lib.js': 'export function foo() { return 3; }\n' }, 'main changes lib too');

      const spy = spyJudge({ status: 'clean', notes: [] });
      const guard = new MergeGuard(fakeVerifier(true), createSilentLogger(), { driftJudge: spy.judge });

      const verdict = await guard.attempt({
        repoPath: repo.path, branch: 'feat/a', base: 'main', verifierConfig: { test: 'exit 0' },
      });
      assert.equal(verdict.ok === false ? verdict.reason : '', 'code_conflict');
      assert.equal(spy.calls.length, 0);
    });

    it('判斷層擲錯 → 放行（不讓主觀判斷否決一組客觀證據）', async () => {
      branchWith('feat/a', { 'feature.js': 'export const a = 1;\n' }, 'add feature');
      repo.commit({ 'readme.md': 'hi\n' }, 'main moves on');
      const guard = new MergeGuard(fakeVerifier(true), createSilentLogger(), {
        driftJudge: { judge: async () => { throw new Error('判斷者掛了'); } },
      });

      const verdict = await guard.attempt({
        repoPath: repo.path, branch: 'feat/a', base: 'main', verifierConfig: { test: 'exit 0' },
      });
      assert.equal(verdict.ok, true);
    });

    it('未注入判斷層 → 行為與從前完全相同', async () => {
      branchWith('feat/a', { 'feature.js': 'export const a = 1;\n' }, 'add feature');
      repo.commit({ 'readme.md': 'hi\n' }, 'main moves on');
      const guard = new MergeGuard(fakeVerifier(true), createSilentLogger());
      const verdict = await guard.attempt({
        repoPath: repo.path, branch: 'feat/a', base: 'main', verifierConfig: { test: 'exit 0' },
      });
      assert.equal(verdict.ok, true);
    });
  });

  it('乾淨合併：rebase 成功 + 重測綠 → ok', async () => {
    branchWith('feat/a', { 'feature.js': 'export const a = 1;\n' }, 'add feature');
    repo.commit({ 'readme.md': 'hi\n' }, 'main moves on'); // 不同檔案 → 無衝突

    const verifier = fakeVerifier(true);
    const guard = new MergeGuard(verifier, createSilentLogger());

    const branchTip = repo.git('rev-parse', 'feat/a');
    const verdict = await guard.attempt({
      repoPath: repo.path,
      branch: 'feat/a',
      base: 'main',
      verifierConfig: { test: 'exit 0' },
    });

    assert.equal(verdict.ok, true);
    // 驗證跑在**拋棄式驗收樹**上，不是主 clone——群分支一位元都不該被動到
    assert.equal(verifier.calls.length, 1);
    assert.notEqual(verifier.calls[0]?.cwd, repo.path, '驗的是合併後狀態的那棵樹');
    assert.equal(branchTip, repo.git('rev-parse', 'feat/a'), '群分支的 sha 不變 → 永遠不需要 force push');
    assert.equal(repo.branch(), 'main', '主 clone 的 HEAD 也不該被切走');
  });

  it('語意飄移：無文字衝突，但 rebase 後測試紅 → semantic_drift', async () => {
    // diff 看不出來的那種：分支只動 app.js、main 只動 lib.js，各自都綠，合併後卻壞。
    repo.commit(
      { 'lib.js': 'export function foo() { return 1; }\nexport function bar() { return 2; }\n' },
      'main 提供 bar',
    );
    branchWith(
      'feat/b',
      { 'app.js': "import { foo, bar } from './lib.js';\nif (foo() + bar() !== 3) process.exit(1);\n" },
      'app 開始使用 bar',
    );

    // 前提：分支在自己的基底上是綠的
    repo.git('checkout', '--quiet', 'feat/b');
    assert.equal((await execa('node', ['app.js'], { cwd: repo.path, reject: false })).exitCode, 0);
    repo.git('checkout', '--quiet', 'main');

    // 別的 PR 把 bar 刪了；main 自己仍綠（main 的 app.js 沒用到 bar）
    repo.commit({ 'lib.js': 'export function foo() { return 1; }\n' }, 'main 移除 bar');
    assert.equal((await execa('node', ['app.js'], { cwd: repo.path, reject: false })).exitCode, 0);

    const guard = new MergeGuard(new Verifier(createSilentLogger()), createSilentLogger());
    const verdict = await guard.attempt({
      repoPath: repo.path,
      branch: 'feat/b',
      base: 'main',
      verifierConfig: { test: 'node app.js' },
    });

    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false ? verdict.reason : '', 'semantic_drift');
    assert.match(verdict.ok === false ? verdict.detail : '', /\[test\]/);
    // 併是成功的（沒有文字衝突），而且主 clone 完全沒被動過
    assert.equal(repo.branch(), 'main');
    assert.equal(existsSync(join(repo.path, '.git', 'rebase-merge')), false);
  });

  it('語意飄移細節帶上失敗關卡與 failingIds，供退回修正時回灌', async () => {
    branchWith('feat/c', { 'x.js': '1\n' }, 'x');
    const verifier = fakeVerifier(false, [
      { name: 'test', ok: false, detail: '2 failing', failingIds: ['alpha', 'beta'] },
      { name: 'build', ok: true, detail: 'ok' },
    ]);
    const guard = new MergeGuard(verifier, createSilentLogger());

    const verdict = await guard.attempt({ repoPath: repo.path, branch: 'feat/c', base: 'main', verifierConfig: {} });

    assert.equal(verdict.ok, false);
    const detail = verdict.ok === false ? verdict.detail : '';
    assert.match(detail, /\[test\] 2 failing（alpha, beta）/);
    assert.ok(!detail.includes('build'), '通過的關卡不該出現在失敗摘要');
  });

  it('文字衝突：rebase 失敗 → code_conflict，並把 rebase 中止（不留半途狀態）', async () => {
    branchWith('feat/d', { 'lib.js': 'export function foo() { return 2; }\n' }, 'branch changes foo');
    repo.commit({ 'lib.js': 'export function foo() { return 3; }\n' }, 'main changes foo');

    const verifier = fakeVerifier(true);
    const rec = createRecordingLogger();
    const guard = new MergeGuard(verifier, rec.logger);

    const verdict = await guard.attempt({ repoPath: repo.path, branch: 'feat/d', base: 'main', verifierConfig: {} });

    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false ? verdict.reason : '', 'code_conflict');
    assert.match(verdict.ok === false ? verdict.detail : '', /conflict/i);
    assert.equal(verifier.calls.length, 0, '有衝突時不該再跑驗證');
    // 現在併在拋棄式樹上，主 clone 從頭到尾沒被碰過——沒有「半途狀態」可言
    assert.equal(repo.branch(), 'main', '主 clone 的 HEAD 不該被切走');
    assert.match(repo.git('show', 'feat/d:lib.js'), /return 2/, '群分支的內容不變');
    // 衝突檔案來自機器格式（git diff --diff-filter=U），不是解析人類可讀訊息
    assert.deepEqual(verdict.ok === false ? verdict.conflicts : [], ['lib.js']);
    assert.ok(rec.messages('warn').includes('Merge Guard：併上最新 base 有衝突'));
  });

  it('分支已包含最新 base → rebase 為 no-op，仍照跑驗證', async () => {
    branchWith('feat/e', { 'e.js': '1\n' }, 'e');
    const verifier = fakeVerifier(true);
    const guard = new MergeGuard(verifier, createSilentLogger());

    const verdict = await guard.attempt({ repoPath: repo.path, branch: 'feat/e', base: 'main', verifierConfig: {} });

    assert.equal(verdict.ok, true);
    assert.equal(verifier.calls.length, 1);
  });

  it('分支不存在 → precondition_failed，且不動 HEAD、不跑驗證（不可替沒檢出的分支背書）', async () => {
    const before = repo.head();
    const verifier = fakeVerifier(true);
    const rec = createRecordingLogger();
    const guard = new MergeGuard(verifier, rec.logger);

    const verdict = await guard.attempt({
      repoPath: repo.path,
      branch: 'feat/does-not-exist',
      base: 'main',
      verifierConfig: { test: 'exit 0' },
    });

    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false ? verdict.reason : '', 'precondition_failed');
    assert.notEqual(verdict.ok === false ? verdict.detail : '', '', '應帶上 git 的錯誤輸出');
    assert.equal(verifier.calls.length, 0, 'checkout 失敗後不該再驗證');
    assert.equal(repo.branch(), 'main', 'HEAD 不可被改動');
    assert.equal(repo.head(), before);
    assert.ok(rec.messages('error').includes('Merge Guard：驗收樹建不起來，前置條件不成立'));
  });

  describe('base 新鮮度（fetch）— 需求 7 的前提', () => {
    it('remote 上別的 PR 刪了我依賴的函式 → fetch 後抓到 semantic_drift（本地 base 過期也不會假綠燈）', async (t) => {
      const remote = createRemoteSetup();
      t.after(() => remote.cleanup());

      // 我的分支：開始使用 upstream 提供的 bar
      commitIn(remote.upstream, { 'lib.js': 'export function foo() { return 1; }\nexport function bar() { return 2; }\n' }, 'upstream 提供 bar');
      git(remote.upstream, 'push', '--quiet', 'origin', 'main');
      git(remote.work, 'pull', '--quiet', 'origin', 'main');
      git(remote.work, 'checkout', '--quiet', '-b', 'feat/uses-bar');
      commitIn(remote.work, { 'app.js': "import { foo, bar } from './lib.js';\nif (foo() + bar() !== 3) process.exit(1);\n" }, 'app 使用 bar');
      git(remote.work, 'checkout', '--quiet', 'main');

      // 別的 PR 在 remote 把 bar 刪了；本地 main / origin/main 都還停在舊 commit
      commitIn(remote.upstream, { 'lib.js': 'export function foo() { return 1; }\n' }, 'upstream 移除 bar');
      git(remote.upstream, 'push', '--quiet', 'origin', 'main');
      assert.match(git(remote.work, 'show', 'main:lib.js'), /bar/, '前提：本地 base 確實過期');

      const freshness: BaseFreshness[] = [];
      const guard = new MergeGuard(new Verifier(createSilentLogger()), createSilentLogger(), {
        onBaseFreshness: (f) => freshness.push(f),
      });
      const verdict = await guard.attempt({
        repoPath: remote.work,
        branch: 'feat/uses-bar',
        base: 'main',
        verifierConfig: { test: 'node app.js' },
      });

      assert.deepEqual(freshness, [{ ref: 'origin/main', fetched: true }]);
      assert.equal(verdict.ok, false, '沒 fetch 的話這裡會是假綠燈');
      assert.equal(verdict.ok === false ? verdict.reason : '', 'semantic_drift');
      // 主 clone 的 HEAD 本來就不會被動（併在拋棄式樹上），所以要驗的是
      // **fetch 之後的 origin/main**——那才是這一次併的基準。
      assert.ok(
        !git(remote.work, 'show', 'origin/main:lib.js').includes('bar'),
        '併的基準必須是 remote 的最新 base（fetch 過的那份）',
      );
      assert.equal(git(remote.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', '主 clone 的 HEAD 不該被切走');
    });

    it('有 remote 且 fetch 成功、無飄移 → ok，且以 origin/base 為基準、無但書', async (t) => {
      const remote = createRemoteSetup();
      t.after(() => remote.cleanup());

      git(remote.work, 'checkout', '--quiet', '-b', 'feat/ok');
      commitIn(remote.work, { 'feature.js': 'export const a = 1;\n' }, 'add feature');
      git(remote.work, 'checkout', '--quiet', 'main');
      commitIn(remote.upstream, { 'readme.md': 'hi\n' }, 'upstream 前進');
      git(remote.upstream, 'push', '--quiet', 'origin', 'main');

      const freshness: BaseFreshness[] = [];
      const rec = createRecordingLogger();
      const guard = new MergeGuard(new Verifier(createSilentLogger()), rec.logger, {
        onBaseFreshness: (f) => freshness.push(f),
      });
      const verdict = await guard.attempt({
        repoPath: remote.work,
        branch: 'feat/ok',
        base: 'main',
        verifierConfig: { test: 'node app.js' },
      });

      assert.equal(verdict.ok, true);
      assert.deepEqual(freshness, [{ ref: 'origin/main', fetched: true }]);
      // 群分支不再被 rebase，所以不能看主 clone 的歷史。要驗的是：
      // **remote 最新 base 確實是這次併的基準**——`origin/main` 是它已經進來的祖先。
      assert.equal(git(remote.work, 'log', '--format=%s', '-1', 'origin/main'), 'upstream 前進');
      assert.equal(
        git(remote.work, 'rev-parse', 'feat/ok'),
        git(remote.work, 'rev-parse', 'feat/ok@{0}'),
        '群分支一位元都沒被改寫',
      );
      assert.ok(!rec.messages('warn').includes('Merge Guard：base 新鮮度有但書'));
    });

    it('本地 base 超前 remote（有未推送 commit）→ 用本地 base，不倒退成 remote 的舊狀態', async (t) => {
      const remote = createRemoteSetup();
      t.after(() => remote.cleanup());

      commitIn(remote.work, { 'local.js': '1\n' }, '本地 main 未推送的 commit');
      git(remote.work, 'checkout', '--quiet', '-b', 'feat/local');
      commitIn(remote.work, { 'f.js': '1\n' }, 'f');
      git(remote.work, 'checkout', '--quiet', 'main');

      const freshness: BaseFreshness[] = [];
      const verifier = fakeVerifier(true);
      const guard = new MergeGuard(verifier, createSilentLogger(), { onBaseFreshness: (f) => freshness.push(f) });
      const verdict = await guard.attempt({ repoPath: remote.work, branch: 'feat/local', base: 'main', verifierConfig: {} });

      assert.equal(verdict.ok, true);
      assert.deepEqual(freshness, [{ ref: 'main', fetched: true }]);
      assert.ok(existsSync(join(remote.work, 'local.js')), '本地未推送的 commit 不可被丟掉');
    });

    it('本地 base 與 remote 分歧 → 以 remote 為基準但標示但書', async (t) => {
      const remote = createRemoteSetup();
      t.after(() => remote.cleanup());

      commitIn(remote.work, { 'local.js': '1\n' }, '本地 main 未推送的 commit');
      git(remote.work, 'checkout', '--quiet', '-b', 'feat/div');
      commitIn(remote.work, { 'f.js': '1\n' }, 'f');
      git(remote.work, 'checkout', '--quiet', 'main');
      commitIn(remote.upstream, { 'remote.js': '1\n' }, 'upstream 前進');
      git(remote.upstream, 'push', '--quiet', 'origin', 'main');

      const freshness: BaseFreshness[] = [];
      const verifier = fakeVerifier(true);
      const guard = new MergeGuard(verifier, createSilentLogger(), { onBaseFreshness: (f) => freshness.push(f) });
      const verdict = await guard.attempt({ repoPath: remote.work, branch: 'feat/div', base: 'main', verifierConfig: {} });

      assert.equal(verdict.ok, true);
      assert.equal(freshness[0]?.ref, 'origin/main');
      assert.equal(freshness[0]?.fetched, true);
      assert.match(freshness[0]?.caveat ?? '', /分歧/);
    });

    it('沒有 remote（純本地 repo）→ 仍跑得完，但標示「基於本地狀態」的但書', async () => {
      branchWith('feat/no-remote', { 'n.js': '1\n' }, 'n');
      const freshness: BaseFreshness[] = [];
      const rec = createRecordingLogger();
      const guard = new MergeGuard(fakeVerifier(true), rec.logger, { onBaseFreshness: (f) => freshness.push(f) });

      const verdict = await guard.attempt({ repoPath: repo.path, branch: 'feat/no-remote', base: 'main', verifierConfig: {} });

      assert.equal(verdict.ok, true, '離線/無 remote 不可讓守衛整個失敗');
      assert.equal(freshness[0]?.fetched, false);
      assert.match(freshness[0]?.caveat ?? '', /未能取得最新 base（找不到 remote「origin」）/);
      assert.equal(freshness[0]?.ref, 'main');
      assert.ok(rec.messages('warn').includes('Merge Guard：base 新鮮度有但書'));
    });

    it('fetch 失敗（remote 連不上）→ 降級續跑，且但書會寫進失敗詳情', async () => {
      branchWith('feat/offline', { 'o.js': '1\n' }, 'o');
      repo.git('remote', 'add', 'origin', join(repo.path, 'no-such-remote.git'));
      const freshness: BaseFreshness[] = [];
      const verifier = fakeVerifier(false, [{ name: 'test', ok: false, detail: '1 failing' }]);
      const guard = new MergeGuard(verifier, createSilentLogger(), { onBaseFreshness: (f) => freshness.push(f) });

      const verdict = await guard.attempt({ repoPath: repo.path, branch: 'feat/offline', base: 'main', verifierConfig: {} });

      assert.equal(freshness[0]?.fetched, false);
      assert.match(freshness[0]?.caveat ?? '', /git fetch 失敗/);
      assert.equal(verifier.calls.length, 1, 'fetch 失敗不可跳過驗證');
      assert.equal(verdict.ok, false);
      const detail = verdict.ok === false ? verdict.detail : '';
      assert.match(detail, /未能取得最新 base/, '報告要揭露這次驗證的前提');
      assert.match(detail, /\[test\] 1 failing/);
    });

    it('fetch: false → 完全不呼叫 git fetch，但仍標示但書', async () => {
      const spy = spyGit();
      const freshness: BaseFreshness[] = [];
      const guard = new MergeGuard(fakeVerifier(true), createSilentLogger(), {
        fetch: false,
        git: spy.runner,
        onBaseFreshness: (f) => freshness.push(f),
      });

      const verdict = await guard.attempt({ repoPath: '/nowhere', branch: 'b', base: 'main', verifierConfig: {} });

      assert.equal(verdict.ok, true);
      assert.ok(!spy.calls.some((a) => a[0] === 'fetch'), '停用時不可連網');
      assert.match(freshness[0]?.caveat ?? '', /已停用 fetch/);
    });

    it('可設定 remote 名稱，fetch 的是指定 remote 的目標 base', async () => {
      const spy = spyGit((args) => {
        if (args[0] === 'remote') return { exitCode: 0, stdout: 'origin\nupstream\n', stderr: '' };
        if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'deadbeef\n', stderr: '' };
        // remote 領先本地：args = [merge-base, --is-ancestor, <ancestor>, <descendant>]
        if (args[0] === 'merge-base') return { exitCode: args[2] === 'release' ? 0 : 1, stdout: '', stderr: '' };
        return undefined;
      });
      const freshness: BaseFreshness[] = [];
      const guard = new MergeGuard(fakeVerifier(true), createSilentLogger(), {
        remote: 'upstream',
        git: spy.runner,
        onBaseFreshness: (f) => freshness.push(f),
      });

      await guard.attempt({ repoPath: '/nowhere', branch: 'b', base: 'release', verifierConfig: {} });

      assert.deepEqual(
        spy.calls.find((a) => a[0] === 'fetch'),
        ['fetch', '--quiet', 'upstream', 'release'],
      );
      assert.equal(freshness[0]?.fetched, true);
    });
  });

  describe('postMergeCheck — 守住 main', () => {
    it('切回 base 後全綠 → ok', async () => {
      repo.git('checkout', '--quiet', '-b', 'other');
      const verifier = fakeVerifier(true);
      const guard = new MergeGuard(verifier, createSilentLogger());

      const verdict = await guard.postMergeCheck(repo.path, 'main', { test: 'exit 0' });

      assert.equal(verdict.ok, true);
      assert.equal(repo.branch(), 'main', '必須在 base 上驗證，不能沿用當前分支');
      assert.deepEqual(verifier.calls, [{ cwd: repo.path }]);
    });

    it('合併後 main 紅 → post_merge_red（呼叫端據此 revert）', async () => {
      const verifier = fakeVerifier(false, [{ name: 'build', ok: false, detail: 'tsc 錯誤' }]);
      const guard = new MergeGuard(verifier, createSilentLogger());

      const verdict = await guard.postMergeCheck(repo.path, 'main', {});

      assert.equal(verdict.ok, false);
      assert.equal(verdict.ok === false ? verdict.reason : '', 'post_merge_red');
      assert.match(verdict.ok === false ? verdict.detail : '', /\[build\] tsc 錯誤/);
    });

    it('切不到 base（分支不存在）→ precondition_failed，不驗證也不動 HEAD', async () => {
      repo.git('checkout', '--quiet', '-b', 'other');
      const before = repo.head();
      const verifier = fakeVerifier(true);
      const rec = createRecordingLogger();
      const guard = new MergeGuard(verifier, rec.logger);

      const verdict = await guard.postMergeCheck(repo.path, 'release/nope', { test: 'exit 0' });

      assert.equal(verdict.ok, false);
      assert.equal(verdict.ok === false ? verdict.reason : '', 'precondition_failed');
      assert.notEqual(verdict.ok === false ? verdict.detail : '', '');
      assert.equal(verifier.calls.length, 0, '沒切到 base 就驗證等於驗錯東西');
      assert.equal(repo.branch(), 'other');
      assert.equal(repo.head(), before);
      assert.ok(rec.messages('error').includes('Merge Guard：合併後無法切到 base，無法驗證'));
    });

    it('用真實 Verifier 在 main 上跑：壞掉的 main 會被抓出來', async () => {
      repo.commit({ 'app.js': 'process.exit(1);\n' }, 'break main');
      const guard = new MergeGuard(new Verifier(createSilentLogger()), createSilentLogger());

      const verdict = await guard.postMergeCheck(repo.path, 'main', { test: 'node app.js' });

      assert.equal(verdict.ok, false);
      assert.equal(verdict.ok === false ? verdict.reason : '', 'post_merge_red');
    });
  });
});

/**
 * 守衛的保證是「rebase 到最新 base 重跑驗證通過」。那句話只對**當時那個 base** 成立。
 * 同 repo 的合併由 repo 鎖序列化，所以我們自己不會插隊——但鎖看不到
 * 「人在 GitHub 上自己按合併」。所以守衛要留下它驗的是哪一顆 commit，
 * 呼叫端在真的合併之前再讀一次比對。
 */
describe('MergeGuard — 留下驗證時的 base commit', () => {
  it('通過時回傳 baseSha，且就是當時 base 的 commit', async (t) => {
    const remote = createRemoteSetup();
    t.after(() => remote.cleanup());

    const baseSha = execaSync('git', ['-C', remote.work, 'rev-parse', 'origin/main']).stdout.trim();
    git(remote.work, 'checkout', '--quiet', '-b', 'feat/sha');
    commitIn(remote.work, { 'x.js': '1\n' }, 'x');

    const guard = new MergeGuard(fakeVerifier(true), createSilentLogger());
    const verdict = await guard.attempt({ repoPath: remote.work, branch: 'feat/sha', base: 'main', verifierConfig: {} });

    assert.equal(verdict.ok, true);
    assert.equal(
      verdict.ok === true ? verdict.baseSha : undefined,
      baseSha,
      '要記下驗的是哪一顆，不然合併前無從比對',
    );
  });
});
