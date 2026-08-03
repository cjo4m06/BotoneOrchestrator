import test from 'node:test';
import assert from 'node:assert/strict';
import { execa } from 'execa';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { workingTreeChanged, changedSince, collectDiffSince } from '../src/git/status.js';
import { Reviewer } from '../src/worker/reviewer.js';
import { evaluateStopHook } from '../src/worker/agent-runtime.js';
import { createTmpDir, createSilentLogger } from './helpers/index.js';

/**
 * 「相對某個基準有沒有變更」——這件事原本寫在三個地方，只有 DoD 那一份用對基準。
 *
 * 實跑災情（任務 Kbp-pDYN1ZbT）：agent 改了 15 行、commit 成 113c824，然後
 *   - Stop hook（git status --porcelain）→ 空的 → 當面告訴 agent「你什麼都沒做」
 *   - reviewer（git diff HEAD）      → 空的 → 判「diff 為空，看不到任何實作」
 *   - DoD（git diff <任務起點 sha>）   → 15 行 → 綠燈
 * agent 對那句話最直接的反應是 `git reset HEAD~1` 把 commit 退掉讓變更「重新出現」。
 * 我們用一句錯的訊息教會了它改寫 git 歷史。
 *
 * 這些測試走**真的 git**，因為要驗的正是「commit 之後 porcelain 會變空」這個 git 行為。
 */

async function repo(t: { after(fn: () => void): void }): Promise<{ cwd: string; base: string }> {
  const dir = createTmpDir('botone-diffbase-');
  t.after(() => dir.cleanup());
  const cwd = dir.path;
  const git = (...args: string[]) => execa('git', ['-C', cwd, ...args]);
  await git('init', '-q');
  await git('config', 'user.email', 'test@test');
  await git('config', 'user.name', 'test');
  await git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(cwd, 'a.txt'), '起點\n');
  await git('add', '-A');
  await git('commit', '-qm', 'base');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();
  return { cwd, base };
}

const gitIn = (cwd: string) => (...args: string[]) => execa('git', ['-C', cwd, ...args]);

test('agent 做完並 commit → 仍然算「有變更」', async (t) => {
  const { cwd, base } = await repo(t);
  const git = gitIn(cwd);
  writeFileSync(join(cwd, 'a.txt'), '起點\n改好了\n');
  await git('add', '-A');
  await git('commit', '-qm', 'fix: 做完了');

  // 這是災情的核心：commit 之後 porcelain 就是空的
  assert.equal((await git('status', '--porcelain')).stdout.trim(), '', 'git 的行為前提：commit 後 porcelain 為空');

  assert.equal(await workingTreeChanged(cwd, base), true, '帶基準 → 看得到已提交的成果');
  assert.equal(await workingTreeChanged(cwd), false, '不帶基準 → 就是當年那個瞎掉的判斷');
});

test('未提交的變更也算', async (t) => {
  const { cwd, base } = await repo(t);
  writeFileSync(join(cwd, 'a.txt'), '起點\n還沒 commit\n');
  assert.equal(await workingTreeChanged(cwd, base), true);
});

test('新增的未追蹤檔案也算（新增檔案是變更）', async (t) => {
  const { cwd, base } = await repo(t);
  writeFileSync(join(cwd, 'b.txt'), '全新的檔案\n');
  assert.equal(await workingTreeChanged(cwd, base), true);
  assert.deepEqual((await changedSince(cwd, base)).ok && (await changedSince(cwd, base)).files, ['b.txt']);
});

test('真的什麼都沒做 → false（這個判斷不能因為修 bug 而失效）', async (t) => {
  const { cwd, base } = await repo(t);
  assert.equal(await workingTreeChanged(cwd, base), false);
});

test('node_modules 不算變更（它是 symlink 進來的）', async (t) => {
  const { cwd, base } = await repo(t);
  mkdirSync(join(cwd, 'node_modules'));
  writeFileSync(join(cwd, 'node_modules', 'x.js'), 'x\n');
  assert.equal(await workingTreeChanged(cwd, base), false, '否則「什麼都沒做」會被當成有做事');
});

test('查不出來時保守回 true——誤判「沒做事」會叫 agent 去改 git', async (t) => {
  const dir = createTmpDir('botone-notgit-');
  t.after(() => dir.cleanup());
  assert.equal(await workingTreeChanged(dir.path, 'a'.repeat(40)), true);
});

// ── reviewer 看得到的內容 ──

test('collectDiffSince：已提交的變更看得到完整內容', async (t) => {
  const { cwd, base } = await repo(t);
  const git = gitIn(cwd);
  writeFileSync(join(cwd, 'a.txt'), '起點\n改好了\n');
  await git('add', '-A');
  await git('commit', '-qm', 'fix');

  const diff = await collectDiffSince(cwd, base);
  assert.match(diff, /\+改好了/, 'reviewer 要看得到 agent 實際寫了什麼');
});

/** 只列檔名的話，「這個任務主要在新增檔案」時 reviewer 一行程式碼都看不到。 */
test('collectDiffSince：未追蹤新檔要補上內容，不是只列檔名', async (t) => {
  const { cwd, base } = await repo(t);
  writeFileSync(join(cwd, 'new.ts'), 'export const x = 1;\n');
  const diff = await collectDiffSince(cwd, base);
  assert.match(diff, /new\.ts/);
  assert.match(diff, /\+export const x = 1;/, '要有內容，不能只有檔名');
});

/** git 故障不可以被翻譯成「你沒有實作」再回灌給 agent。 */
test('collectDiffSince：git 失敗要擲錯，不是回空字串', async (t) => {
  const dir = createTmpDir('botone-notgit2-');
  t.after(() => dir.cleanup());
  await assert.rejects(() => collectDiffSince(dir.path, 'HEAD'), /git/);
});

test('reviewer：沒有基準就 skip，不是判「沒有實作」', async () => {
  const r = new Reviewer({ log: createSilentLogger(), hasAuth: () => true });
  const out = await r.check(
    { id: 'T-1', title: 't', status: 'todo', repo: 'a/b', category: 'dev', description: '', dependencies: [], docRefs: ['spec/x.md'] },
    [{ ref: 'spec/x.md', text: '規格' }] as never,
    '/wt',
    { baseRef: undefined },
  );
  assert.equal(out.verdict.status, 'skipped');
  assert.match(out.verdict.status === 'skipped' ? out.verdict.reason : '', /基準/);
});

// ── Stop hook 的續做指示 ──

test('Stop hook 不可以叫 agent 去 reset／amend 讓變更重新出現', () => {
  const d = evaluateStopHook({
    workingTreeChanged: false,
    askedClarification: false,
    reportedNoChange: false,
    blocksSoFar: 0,
    maxBlocks: 2,
    stopHookActive: false,
  });
  assert.equal(d.block, true);
  const reason = d.block ? d.reason : '';
  assert.match(reason, /已經把變更 commit 了.*算數/s, '要明講已提交的成果算數');
  assert.match(reason, /不要用 reset／amend／rebase/, '要明擋改寫歷史這條路');
  assert.match(reason, /report_no_change/, '合法的零變更出口不能被這次修改弄丟');
});

test('Stop hook：宣告過 no_change 就放行（合法的零變更出口）', () => {
  const d = evaluateStopHook({
    workingTreeChanged: false,
    askedClarification: false,
    reportedNoChange: true,
    blocksSoFar: 0,
    maxBlocks: 2,
    stopHookActive: false,
  });
  assert.equal(d.block, false);
});
