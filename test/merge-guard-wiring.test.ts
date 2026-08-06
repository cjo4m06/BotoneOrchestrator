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
