import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBaseFreshness, listBranches, type GitRunner } from '../src/git/base-freshness.js';

/** 依照 git 參數回傳結果的假 runner；沒對到的指令一律成功、空輸出。 */
function fakeGit(table: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const g = (async (_repo: string, args: string[]) => {
    calls.push(args);
    const hit = table[args.join(' ')];
    return { exitCode: hit?.exitCode ?? 0, stdout: hit?.stdout ?? '', stderr: hit?.stderr ?? '' };
  }) as GitRunner & { calls: string[][] };
  g.calls = calls;
  return g;
}

const REMOTES = { remote: { stdout: 'origin' } };

describe('base 新鮮度 — 開工與合併共用同一套判斷', () => {
  it('remote 比本地新 → 用 origin/<base>，沒有但書', async () => {
    const git = fakeGit({
      ...REMOTES,
      'rev-parse --verify --quiet origin/main^{commit}': { stdout: 'abc' },
      'merge-base --is-ancestor origin/main main': { exitCode: 1 }, // 本地沒包含 remote
      'merge-base --is-ancestor main origin/main': { exitCode: 0 }, // remote 超前
    });
    const f = await resolveBaseFreshness('/r', 'main', { git });
    assert.equal(f.ref, 'origin/main');
    assert.equal(f.fetched, true);
    assert.equal(f.caveat, undefined);
    assert.ok(git.calls.some((a) => a[0] === 'fetch'), '要真的去 fetch');
  });

  it('本地已包含 remote 最新內容 → 用本地，沒有但書', async () => {
    const git = fakeGit({
      ...REMOTES,
      'rev-parse --verify --quiet origin/main^{commit}': { stdout: 'abc' },
      'merge-base --is-ancestor origin/main main': { exitCode: 0 },
    });
    const f = await resolveBaseFreshness('/r', 'main', { git });
    assert.deepEqual(f, { ref: 'main', fetched: true });
  });

  it('兩邊分歧 → 以 remote 為準，但要揭露本地未推送的 commit 不在範圍內', async () => {
    const git = fakeGit({
      ...REMOTES,
      'rev-parse --verify --quiet origin/main^{commit}': { stdout: 'abc' },
      'merge-base --is-ancestor origin/main main': { exitCode: 1 },
      'merge-base --is-ancestor main origin/main': { exitCode: 1 },
    });
    const f = await resolveBaseFreshness('/r', 'main', { git });
    assert.equal(f.ref, 'origin/main');
    assert.match(f.caveat ?? '', /已分歧/);
  });

  /**
   * 離線／無 remote 的 repo 也必須跑得完：取不到最新版是降級，不是失敗。
   * 但但書一定要留下，否則「基於三天前的程式碼」會被當成正常結果。
   */
  it('沒有 remote → 降級成本地 base + 但書', async () => {
    const f = await resolveBaseFreshness('/r', 'main', { git: fakeGit({ remote: { stdout: '' } }) });
    assert.equal(f.ref, 'main');
    assert.equal(f.fetched, false);
    assert.match(f.caveat ?? '', /找不到 remote/);
  });

  it('fetch 失敗（離線）→ 降級 + 但書帶上原因', async () => {
    const git = fakeGit({ ...REMOTES, 'fetch --quiet origin main': { exitCode: 1, stderr: 'could not resolve host' } });
    const f = await resolveBaseFreshness('/r', 'main', { git });
    assert.equal(f.fetched, false);
    assert.match(f.caveat ?? '', /git fetch 失敗/);
    assert.match(f.caveat ?? '', /could not resolve host/);
  });

  it('fetch 成功但解析不到 remote ref → 降級', async () => {
    const git = fakeGit({ ...REMOTES, 'rev-parse --verify --quiet origin/main^{commit}': { exitCode: 1 }, 'rev-parse --verify --quiet FETCH_HEAD^{commit}': { exitCode: 1 } });
    const f = await resolveBaseFreshness('/r', 'main', { git });
    assert.match(f.caveat ?? '', /解析不到/);
  });

  it('refspec 沒設定時退回 FETCH_HEAD', async () => {
    const git = fakeGit({
      ...REMOTES,
      'rev-parse --verify --quiet origin/main^{commit}': { exitCode: 1 },
      'rev-parse --verify --quiet FETCH_HEAD^{commit}': { stdout: 'abc' },
      'merge-base --is-ancestor FETCH_HEAD main': { exitCode: 1 },
      'merge-base --is-ancestor main FETCH_HEAD': { exitCode: 0 },
    });
    assert.equal((await resolveBaseFreshness('/r', 'main', { git })).ref, 'FETCH_HEAD');
  });

  it('停用 fetch → 直接降級，一次連外都不做', async () => {
    const git = fakeGit(REMOTES);
    const f = await resolveBaseFreshness('/r', 'main', { git, fetch: false });
    assert.equal(f.fetched, false);
    assert.equal(git.calls.length, 0, '停用時不該打任何 git 指令');
  });

  it('自訂 remote 名稱', async () => {
    const git = fakeGit({
      remote: { stdout: 'upstream\norigin' },
      'rev-parse --verify --quiet upstream/dev^{commit}': { stdout: 'abc' },
      'merge-base --is-ancestor upstream/dev dev': { exitCode: 0 },
    });
    const f = await resolveBaseFreshness('/r', 'dev', { git, remote: 'upstream' });
    assert.equal(f.ref, 'dev');
    assert.ok(git.calls.some((a) => a.join(' ') === 'fetch --quiet upstream dev'));
  });
});

describe('listBranches — 控制台的分支選單', () => {
  it('列出本機與遠端分支，遠端去掉 remote 前綴並去重', async () => {
    const git = fakeGit({
      'for-each-ref --format=%(refname:short) refs/heads': { stdout: 'main\ndev\nfeature/x' },
      // 實測撞到：refs/remotes/origin/HEAD 的 short form 是 **origin**（純 remote 名），
      // 不是 origin/HEAD。只濾 /HEAD 的話，「origin」會被當成一個分支列給使用者選。
      'for-each-ref --format=%(refname:short) refs/remotes': { stdout: 'origin\norigin/main\norigin/dev\nupstream/dev' },
    });
    const b = await listBranches(git, '/r');
    assert.deepEqual(b.local, ['main', 'dev', 'feature/x']);
    assert.deepEqual(b.remote, ['main', 'dev'], 'remote 名稱本身要濾掉、重複的 dev 要去重');
    assert.equal(b.remote.includes('origin'), false, 'origin 不是分支');
  });

  it('不是 git repo → 兩邊都空（不擲錯）', async () => {
    const git = fakeGit({
      'for-each-ref --format=%(refname:short) refs/heads': { exitCode: 128 },
      'for-each-ref --format=%(refname:short) refs/remotes': { exitCode: 128 },
    });
    assert.deepEqual(await listBranches(git, '/nope'), { local: [], remote: [] });
  });
});
