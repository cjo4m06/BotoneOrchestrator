import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMergeGuard, blameExperimentBudget } from '../src/pr/merge-guard-factory.js';
import type { MergeGuardOptions } from '../src/pr/merge-guard.js';
import type { VerifierLike } from '../src/contracts.js';
import { createSilentLogger } from './helpers/index.js';

/**
 * Merge Guard 有兩個呼叫點：開 PR 前那次（group-runner）與**核准後、真的要合併的那次**
 * （main.ts 的合併管線）。先前前者接了六項選項、後者只接了一項，而兩者的判決文字
 * 一模一樣——所以缺項在畫面上完全看不出來。
 *
 * 這個檔案守的不是「守衛會不會動」（那在 merge-guard.test.ts），
 * 而是「**兩個呼叫點拿到的東西一不一樣**」。既有的接線測試是
 * 「原始碼裡有沒有出現某個函式名」的正則比對——它抓得到「有沒有呼叫」，
 * 抓不到「傳的參數不同」，而這正是這一整類 bug 的形狀。
 */

/** 剝掉註解行再比對——說明文字一定會提到這些名字，會誤判成「有接」。 */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

function capture(): { options: MergeGuardOptions | undefined; seam: NonNullable<Parameters<typeof createMergeGuard>[0]['makeGuard']> } {
  const box: { options: MergeGuardOptions | undefined } = { options: undefined };
  return {
    get options() { return box.options; },
    seam: (_v: VerifierLike, o: MergeGuardOptions) => {
      box.options = o;
      return { attempt: async () => ({ ok: true as const, baseSha: 'x' }) };
    },
  };
}

const baseWiring = () => {
  const log = createSilentLogger();
  return {
    log,
    ctx: { repo: 'acme/web', branch: 'orch/x', workspaceKind: 'merge_tree' as const, requestedBy: 'merger' as const },
    makeVerifier: () => ({ check: async () => ({ green: true, checks: [] }) }) as unknown as VerifierLike,
    sourceRepoPath: '/main/clone',
    verifyTreeRoot: '/data/verify-trees',
    onBaseFreshness: () => {},
  };
};

test('工廠一定會給歸咎實驗配額——少了它，紅燈時證據靜默消失', () => {
  const c = capture();
  createMergeGuard({ ...baseWiring(), makeGuard: c.seam });
  assert.deepEqual(c.options?.experimentBudget, blameExperimentBudget(),
    'experimentBudget 缺席時 gatherBlameEvidence 直接回空陣列，連 log 都沒有');
});

test('工廠一定會給 prepareTree，而且來源是主 clone 不是守衛轉交的工作區', async () => {
  const src = mkdtempSync(join(tmpdir(), 'orch-main-clone-'));
  const tree = mkdtempSync(join(tmpdir(), 'orch-verify-tree-'));
  const wrong = mkdtempSync(join(tmpdir(), 'orch-merge-workspace-'));
  try {
    writeFileSync(join(src, '.env'), 'FROM=main-clone\n');
    writeFileSync(join(wrong, '.env'), 'FROM=merge-workspace-stale\n');

    const c = capture();
    createMergeGuard({ ...baseWiring(), sourceRepoPath: src, makeGuard: c.seam });
    assert.ok(c.options?.prepareTree, 'prepareTree 缺席 → 驗收樹沒有 .env，Laravel 連 DB 都連不上');

    // merge-guard 會把 input.repoPath（＝合併工作區）當第二個參數轉交進來。
    // 工廠必須**忽略它**，否則那條路永遠拿開機當下複製的那份舊設定。
    await c.options!.prepareTree!(tree, wrong);
    assert.equal(readFileSync(join(tree, '.env'), 'utf8'), 'FROM=main-clone\n',
      '.env 必須來自主 clone；用守衛轉交的 repoPath 會拿到合併工作區那份過期快照');
  } finally {
    for (const d of [src, tree, wrong]) rmSync(d, { recursive: true, force: true });
  }
});

test('工廠一定會給 onBaseFreshness（可以是只寫 log 的實作，但不能沒有）', () => {
  const c = capture();
  createMergeGuard({ ...baseWiring(), makeGuard: c.seam });
  assert.equal(typeof c.options?.onBaseFreshness, 'function');
});

test('remote／driftJudge／recordCheck 給了就會傳下去', () => {
  const c = capture();
  const judge = { judge: async () => ({ ok: true as const }) } as never;
  const rec = () => {};
  createMergeGuard({ ...baseWiring(), remote: 'upstream', driftJudge: judge, recordCheck: rec, makeGuard: c.seam });
  assert.equal(c.options?.remote, 'upstream');
  assert.equal(c.options?.driftJudge, judge);
  assert.equal(c.options?.recordCheck, rec);
});

test('makeVerifier 拿得到 CheckContext——沒有它，那一輪一列 check_run 都不會寫', () => {
  let seen: unknown;
  createMergeGuard({
    ...baseWiring(),
    makeVerifier: (ctx) => { seen = ctx; return { check: async () => ({ green: true, checks: [] }) } as unknown as VerifierLike; },
    makeGuard: capture().seam,
  });
  assert.deepEqual(seen, { repo: 'acme/web', branch: 'orch/x', workspaceKind: 'merge_tree', requestedBy: 'merger' });
});

// ── 接線：兩個呼叫點都必須走工廠 ──

test('正式路徑不准自己 new MergeGuard——兩個呼叫點都要走工廠', () => {
  const offenders: string[] = [];
  for (const f of ['src/main.ts', 'src/core/group-runner.ts', 'src/core/orchestrator.ts']) {
    if (/new MergeGuard\(/.test(codeOf(f))) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    '自己 new 就會回到「一邊接六項、一邊接一項」的狀態，而兩者的判決文字一模一樣');
});

test('兩個呼叫點都出現 createMergeGuard（少一邊就是又只修了一半）', () => {
  for (const f of ['src/main.ts', 'src/core/group-runner.ts']) {
    assert.match(codeOf(f), /createMergeGuard\(/, `${f} 沒有走工廠`);
  }
});

test('合併那條路的守衛是「每群現造」，不是一顆共用實例', () => {
  // 共用實例造不出每群不同的 CheckContext，那正是 check_runs 整輪缺席的原因
  assert.match(codeOf('src/core/orchestrator.ts'), /guardFor\(ctx: \{ repo: string; branch: string \}\)/);
  assert.match(codeOf('src/core/orchestrator.ts'), /m\.guardFor\(\{ repo: group\.repo, branch: group\.branch \}\)/);
});

test('MergeProject 帶主 clone 路徑（不然工廠無從知道 .env 該去哪裡拿）', () => {
  const src = codeOf('src/core/orchestrator.ts');
  assert.match(src, /sourceRepoPath: string;/);
  assert.match(codeOf('src/main.ts'), /sourceRepoPath: runtime\.repoPath/);
});

// ── 調度器丟進工作區的檔案，不可以被算成「這一群改了東西」 ──

test('prepareLocalConfig 帶進去的檔案會自動排除，不會被 git 當成未追蹤變更', async () => {
  const { execa } = await import('execa');
  const { prepareLocalConfig } = await import('../src/core/local-config.js');
  const main = mkdtempSync(join(tmpdir(), 'orch-src-'));
  const wt = mkdtempSync(join(tmpdir(), 'orch-wt-'));
  try {
    // 一個**沒有 .gitignore** 的 repo——那正是鏈條會完整的情況（data/test/repos/demo2 就是）
    await execa('git', ['-C', main, 'init', '-q']);
    await execa('git', ['-C', main, 'config', 'user.email', 't@t'], { reject: false });
    await execa('git', ['-C', main, 'config', 'user.name', 't'], { reject: false });
    writeFileSync(join(main, 'README.md'), '# x\n');
    await execa('git', ['-C', main, 'add', '-A']);
    await execa('git', ['-C', main, 'commit', '-qm', 'init']);
    // 被 gitignore 不到的本機設定檔
    writeFileSync(join(main, '.env'), 'SECRET=xyz\n');

    rmSync(wt, { recursive: true, force: true });
    await execa('git', ['-C', main, 'worktree', 'add', '-q', '--detach', wt]);

    const copied = await prepareLocalConfig(main, wt, createSilentLogger());
    assert.ok(copied.includes('.env'), '.env 要帶進去（它沒有版控對照物）');

    const status = await execa('git', ['-C', wt, 'status', '--porcelain']);
    assert.equal(status.stdout.trim(), '',
      '調度器自己丟進去的檔案被算成未追蹤變更 ⇒「diff 非空」的 DoD 在 agent 一行沒改時就綠，而且會被 git add -A 吃進 PR');
  } finally {
    await (await import('execa')).execa('git', ['-C', main, 'worktree', 'remove', '--force', wt], { reject: false });
    for (const d of [main, wt]) rmSync(d, { recursive: true, force: true });
  }
});

test('拋棄式驗收樹建在 dataRoot 底下，不是系統暫存目錄', () => {
  // /tmp 底下的樹沒有任何對帳掃得到——daemon 驗到一半掛掉就留在那裡沒人清
  const c = capture();
  createMergeGuard({ ...baseWiring(), verifyTreeRoot: '/data/verify-trees', makeGuard: c.seam });
  assert.equal(c.options?.treeRoot, '/data/verify-trees');
  // 兩個呼叫點都要給（型別上是必填，這裡再確認正式碼真的算得出來）
  assert.match(codeOf('src/main.ts'), /verifyTreeRoot: verifyTreeRootOf\(/);
  assert.match(codeOf('src/core/group-runner.ts'), /verifyTreeRoot: join\(dirname\(this\.deps\.worktreeBase\), 'verify-trees'\)/);
  // 開機要清掉上次留下的
  assert.match(codeOf('src/main.ts'), /export function clearVerifyTrees/);
});

test('驗收樹的根目錄還不存在時要自己建起來（否則整條合併鏈路倒在建樹）', async () => {
  const { execa } = await import('execa');
  const { createMergeTree } = await import('../src/pr/merge-verify.js');
  const repo = mkdtempSync(join(tmpdir(), 'orch-mv-'));
  const rootParent = mkdtempSync(join(tmpdir(), 'orch-root-'));
  const root = join(rootParent, 'verify-trees');   // **刻意不存在**（dataRoot 底下第一次就是這樣）
  try {
    await execa('git', ['-C', repo, 'init', '-q']);
    await execa('git', ['-C', repo, 'config', 'user.email', 't@t'], { reject: false });
    await execa('git', ['-C', repo, 'config', 'user.name', 't'], { reject: false });
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    await execa('git', ['-C', repo, 'add', '-A']);
    await execa('git', ['-C', repo, 'commit', '-qm', 'init']);
    const base = (await execa('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    await execa('git', ['-C', repo, 'checkout', '-qb', 'feat']);
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    await execa('git', ['-C', repo, 'add', '-A']);
    await execa('git', ['-C', repo, 'commit', '-qm', 'feat']);

    const built = await createMergeTree({
      repoPath: repo, branch: 'feat', baseRef: base, log: createSilentLogger(), root,
    });
    assert.equal(built.ok, true,
      `根目錄不存在時 mkdtempSync 會失敗 ⇒ 判 precondition_failed ⇒ 整群 failed。實際：${JSON.stringify(built)}`);
    if (built.ok) await built.tree.dispose();
  } finally {
    await (await import('execa')).execa('git', ['-C', repo, 'worktree', 'prune'], { reject: false });
    for (const d of [repo, rootParent]) rmSync(d, { recursive: true, force: true });
  }
});
