import test from 'node:test';
import assert from 'node:assert/strict';
import { execa } from 'execa';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withFetchLock } from '../src/git/fetch-lock.js';
import { createTmpDir } from './helpers/index.js';

/**
 * 同一個 repo 的 `git fetch` 必須序列化。
 *
 * ── 實跑災情（22:36）──
 *
 *   WARN 抓取最新 base 失敗，守衛驗的可能是過期的 base
 *        err: git fetch origin main 失敗：error: cannot lock ref 'refs/remotes/origin/main':
 *             is at ebbce529… but expected 493e1cb6…
 *
 * `git fetch` 更新 `refs/remotes/<remote>/<branch>` 用的是 compare-and-swap：
 * 讀舊值 → 寫新值，寫的時候確認舊值沒被動過。兩個 fetch 同時跑，後者的預期值
 * 已經被前者改掉了。
 *
 * **這個競態不會讓流程停下來**——呼叫端拿不到最新 base 時只掛一個但書照樣放行。
 * 也就是說它會讓一次合併把關悄悄降級，而畫面上只有一行 WARN。
 */

async function repoWithRemote(t: { after(fn: () => void): void }): Promise<string> {
  const dir = createTmpDir('botone-fetch-');
  t.after(() => dir.cleanup());
  const bare = join(dir.path, 'origin.git');
  const repo = join(dir.path, 'repo');
  await execa('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  await execa('git', ['clone', '-q', bare, repo]);
  const git = (...a: string[]) => execa('git', ['-C', repo, ...a]);
  await git('config', 'user.email', 't@t');
  await git('config', 'user.name', 't');
  await git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  await git('add', '-A');
  await git('commit', '-qm', 'base');
  await git('push', '-q', 'origin', 'main');
  return repo;
}

/** 讓遠端一直往前跑，才有東西可以搶著更新 refs/remotes/origin/main。 */
async function advanceRemote(repo: string, n: number): Promise<void> {
  const dir = join(repo, '..', 'pusher');
  await execa('git', ['clone', '-q', join(repo, '..', 'origin.git'), dir], { reject: false });
  const git = (...a: string[]) => execa('git', ['-C', dir, ...a]);
  await git('config', 'user.email', 't@t');
  await git('config', 'user.name', 't');
  await git('config', 'commit.gpgsign', 'false');
  for (let i = 0; i < n; i += 1) {
    writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
    await git('add', '-A');
    await git('commit', '-qm', `c${i}`);
  }
  await git('push', '-q', 'origin', 'main');
}

test('併發 fetch 不會撞 ref lock', async (t) => {
  const repo = await repoWithRemote(t);
  await advanceRemote(repo, 3);

  const runs = Array.from({ length: 6 }, () =>
    withFetchLock(repo, () => execa('git', ['-C', repo, 'fetch', '--quiet', 'origin', 'main'], { reject: false })),
  );
  const results = await Promise.all(runs);

  const failed = results.filter((r) => (r.exitCode ?? 0) !== 0);
  assert.deepEqual(
    failed.map((r) => r.stderr.slice(0, 100)),
    [],
    '併發 fetch 全部都該成功——失敗代表 refs/remotes 的 compare-and-swap 撞在一起',
  );
});

/** 鎖是真的在序列化，不是剛好沒撞到。 */
test('同一個 repo 的 fetch 一次只跑一個', async () => {
  let running = 0;
  let peak = 0;
  const task = () =>
    withFetchLock('/same/repo', async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 15));
      running -= 1;
    });

  await Promise.all([task(), task(), task(), task()]);
  assert.equal(peak, 1, '同時有兩個以上在跑就代表沒序列化');
});

/** 不同 repo 不該互相排隊——否則多專案時會白白拖慢。 */
test('不同 repo 的 fetch 可以並行', async () => {
  let running = 0;
  let peak = 0;
  const task = (repo: string) =>
    withFetchLock(repo, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 15));
      running -= 1;
    });

  await Promise.all([task('/a'), task('/b'), task('/c')]);
  assert.equal(peak, 3, '不同專案不該互相擋');
});

/**
 * **不可以跟 withRepoLock 共用同一把鎖。**
 * Merge Guard 已經持有 `repoPath` 那把（group-runner），它裡面又會 fetch——
 * 共用就是自己等自己，直接死鎖。
 */
test('fetch 鎖與 repo 鎖互不干擾（否則 Merge Guard 會死鎖）', async () => {
  const { withRepoLock } = await import('../src/core/repo-lock.js');
  const order: string[] = [];

  await withRepoLock('/repo', async () => {
    order.push('外層取得 repo 鎖');
    // 這正是 Merge Guard 內部的形狀：持有 repo 鎖時再去 fetch
    await withFetchLock('/repo', async () => void order.push('內層取得 fetch 鎖'));
    order.push('外層完成');
  });

  assert.deepEqual(order, ['外層取得 repo 鎖', '內層取得 fetch 鎖', '外層完成']);
});

/** 六個 fetch 呼叫點都要包住——漏一個就還是會撞。 */
test('所有 git fetch 呼叫點都在鎖裡面', () => {
  const files = ['src/main.ts', 'src/pr/pr-manager.ts', 'src/core/group-runner.ts', 'src/git/base-freshness.ts'];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const line of src.split('\n')) {
      if (!/\['fetch'/.test(line)) continue;
      // 同一行有 withFetchLock，或它是 withFetchLock(...) 的續行（前一行有）
      const idx = src.split('\n').indexOf(line);
      const ctx = src.split('\n').slice(Math.max(0, idx - 2), idx + 1).join('\n');
      assert.match(ctx, /withFetchLock/, `${f} 有沒被鎖住的 fetch：${line.trim().slice(0, 70)}`);
    }
  }
});
