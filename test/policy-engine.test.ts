import { describe, it, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execaSync } from 'execa';
import { dirname, join, resolve } from 'node:path';
import { expandRenamePath, matchGlob, readDiffStat, resolveDiffBase } from '../src/policy/policy-engine.js';
import { createTmpGitRepo, type TmpGitRepo } from './helpers/index.js';

describe('matchGlob', () => {
  it('** 可跨層，也可匹配零層目錄', () => {
    assert.equal(matchGlob('README.md', '**/*.md'), true);
    assert.equal(matchGlob('docs/a/b/c.md', '**/*.md'), true);
    assert.equal(matchGlob('db/migrations/001_init.sql', '**/migrations/**'), true);
  });

  it('* 不跨目錄分隔', () => {
    assert.equal(matchGlob('src/a.css', '*.css'), false);
    assert.equal(matchGlob('a.css', '*.css'), true);
  });

  it('點號等特殊字元被跳脫（不會誤配）', () => {
    assert.equal(matchGlob('packageXjson', '**/package.json'), false);
    assert.equal(matchGlob('web/package.json', '**/package.json'), true);
  });

  it('忽略前綴 ./', () => {
    assert.equal(matchGlob('./docs/x.md', 'docs/**'), true);
  });
});

describe('expandRenamePath', () => {
  it('展開 `a => b`（改名後的舊/新路徑都要各自判定）', () => {
    const r = expandRenamePath('docs/notes.md => .github/workflows/deploy.yml');
    assert.deepEqual(r.paths, ['docs/notes.md', '.github/workflows/deploy.yml']);
    assert.equal(r.from, 'docs/notes.md');
    assert.equal(r.to, '.github/workflows/deploy.yml');
  });

  it('展開帶共同前後綴的 `pre/{a => b}/post`', () => {
    const r = expandRenamePath('src/{old => new}/a.ts');
    assert.deepEqual(r.paths, ['src/old/a.ts', 'src/new/a.ts']);
  });

  it('大括號一邊為空時不留下多餘斜線', () => {
    assert.deepEqual(expandRenamePath('src/{ => new}/a.ts').paths, ['src/a.ts', 'src/new/a.ts']);
    assert.deepEqual(expandRenamePath('{docs => }/a.md').paths, ['docs/a.md', 'a.md']);
  });

  it('一般路徑原樣回傳（含含空白/箭頭字樣的檔名不誤判）', () => {
    assert.deepEqual(expandRenamePath('src/index.ts').paths, ['src/index.ts']);
    assert.equal(expandRenamePath('src/index.ts').from, undefined);
  });
});

describe('readDiffStat（真實 git repo）', () => {
  const repos: TmpGitRepo[] = [];
  const make = (files: Record<string, string>): TmpGitRepo => {
    const r = createTmpGitRepo({ files });
    repos.push(r);
    return r;
  };
  const write = (repo: TmpGitRepo, rel: string, content: string): void => {
    const abs = resolve(repo.path, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  };

  after(() => {
    for (const r of repos) r.cleanup();
  });

  it('新增檔案：路徑進 files、加行數計入', async () => {
    const repo = make({ 'README.md': '# x\n' });
    write(repo, 'src/a.ts', 'export const a = 1;\nexport const b = 2;\n');
    repo.git('add', '-A');

    const d = await readDiffStat(repo.path, 'HEAD');
    assert.deepEqual(d.files, ['src/a.ts']);
    assert.deepEqual(d.deleted, []);
    assert.equal(d.additions, 2);
    assert.equal(d.deletions, 0);
  });

  it('修改檔案：加/刪行數正確', async () => {
    const repo = make({ 'a.txt': 'l1\nl2\nl3\n' });
    write(repo, 'a.txt', 'l1\nl2x\nl3\nl4\n');

    const d = await readDiffStat(repo.path, 'HEAD');
    assert.deepEqual(d.files, ['a.txt']);
    assert.deepEqual(d.deleted, []);
    assert.equal(d.additions, 2);
    assert.equal(d.deletions, 1);
  });

  it('刪除檔案：同時進 files 與 deleted', async () => {
    const repo = make({ 'a.txt': 'l1\nl2\n', 'b.txt': 'x\n' });
    rmSync(resolve(repo.path, 'a.txt'));

    const d = await readDiffStat(repo.path, 'HEAD');
    assert.deepEqual(d.files, ['a.txt']);
    assert.deepEqual(d.deleted, ['a.txt']);
    assert.equal(d.deletions, 2);
  });

  // ── 回歸測試：改名曾讓整段政策紅線失效 ──
  // git 會把改名輸出成單一合併路徑 `docs/notes.md => .github/workflows/deploy.yml`，
  // 那串字被 `docs/**` 這條安全 glob 整串命中 → 新增 CI workflow 被判「可自動合併」。
  it('改名：拆成舊路徑（刪）+ 新路徑（增），不得出現合併字串', async () => {
    const repo = make({ 'docs/notes.md': 'hello\n' });
    mkdirSync(resolve(repo.path, '.github/workflows'), { recursive: true });
    repo.git('mv', 'docs/notes.md', '.github/workflows/deploy.yml');

    const d = await readDiffStat(repo.path, 'HEAD');
    assert.ok(!d.files.some((f) => f.includes('=>')), `files 不可含合併路徑：${d.files.join(', ')}`);
    assert.deepEqual([...d.files].sort(), ['.github/workflows/deploy.yml', 'docs/notes.md']);
    assert.deepEqual(d.deleted, ['docs/notes.md']);
  });

  /**
   * 改名時 git 會把兩個路徑併成一個欄位（`docs/notes.md => .github/workflows/deploy.yml`）。
   * 整串當成一個路徑的話，舊路徑與新路徑都對不上任何比對——
   * 而讀這份清單的人（PR 內文、風險判斷者的參考）就看不到「新增了一個 workflow」。
   */
  it('跨目錄改名要拆成兩筆，舊路徑同時算刪除', async () => {
    const repo = make({ 'docs/notes.md': 'hello\n' });
    mkdirSync(resolve(repo.path, '.github/workflows'), { recursive: true });
    repo.git('mv', 'docs/notes.md', '.github/workflows/deploy.yml');

    const d = await readDiffStat(repo.path, 'HEAD');
    assert.deepEqual([...d.files].sort(), ['.github/workflows/deploy.yml', 'docs/notes.md']);
    assert.deepEqual(d.deleted, ['docs/notes.md']);
  });

  it('同目錄內改名（git 會用 {a => b} 形式）一樣拆成兩筆', async () => {
    const repo = make({ 'src/old.ts': 'export const x = 1;\n' });
    repo.git('mv', 'src/old.ts', 'src/new.ts');

    const d = await readDiffStat(repo.path, 'HEAD');
    assert.deepEqual([...d.files].sort(), ['src/new.ts', 'src/old.ts']);
    assert.deepEqual(d.deleted, ['src/old.ts']);
  });

  it('二進位檔（numstat 為 -）不會把 NaN 加進統計', async () => {
    const repo = make({ 'README.md': '# x\n' });
    writeFileSync(resolve(repo.path, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    repo.git('add', '-A');

    const d = await readDiffStat(repo.path, 'HEAD');
    assert.deepEqual(d.files, ['logo.png']);
    assert.equal(Number.isNaN(d.additions), false);
    assert.equal(d.additions, 0);
  });

  it('多檔混合：新增/修改/刪除各自歸位', async () => {
    const repo = make({ 'keep.txt': 'a\n', 'gone.txt': 'b\n', 'edit.txt': 'c\n' });
    rmSync(resolve(repo.path, 'gone.txt'));
    write(repo, 'edit.txt', 'c\nd\n');
    write(repo, 'new.txt', 'e\n');
    repo.git('add', '-A');

    const d = await readDiffStat(repo.path, 'HEAD');
    assert.deepEqual([...d.files].sort(), ['edit.txt', 'gone.txt', 'new.txt']);
    assert.deepEqual(d.deleted, ['gone.txt']);
  });

  it('無變更 → 全空（不可回報假變更）', async () => {
    const repo = make({ 'a.txt': 'x\n' });
    const d = await readDiffStat(repo.path, 'HEAD');
    assert.deepEqual(d.files, []);
    assert.deepEqual(d.deleted, []);
    assert.equal(d.additions, 0);
  });

  it('非 git 目錄 / 壞 ref → 回空而不是丟例外（優雅降級）', async () => {
    const repo = make({ 'a.txt': 'x\n' });
    assert.deepEqual(await readDiffStat(repo.path, 'no-such-ref'), { files: [], deleted: [], additions: 0, deletions: 0 });
    assert.deepEqual(await readDiffStat(resolve(repo.path, '..'), 'HEAD'), {
      files: [],
      deleted: [],
      additions: 0,
      deletions: 0,
    });
  });

  it('以某個 base commit 為基準時，涵蓋已 commit 的變更', async () => {
    const repo = make({ 'a.txt': 'x\n' });
    const base = repo.head();
    repo.commit({ '.github/workflows/ci.yml': 'name: ci\n' }, 'feat: 加 CI');

    const d = await readDiffStat(repo.path, base);
    assert.deepEqual(d.files, ['.github/workflows/ci.yml']);
  });
});

describe('resolveDiffBase', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'diffbase-'));
    execaSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    execaSync('git', ['-C', dir, 'config', 'user.email', 't@t'], { reject: false });
    execaSync('git', ['-C', dir, 'config', 'user.name', 't'], { reject: false });
    writeFileSync(join(dir, 'a.txt'), 'x');
    execaSync('git', ['-C', dir, 'add', '-A']);
    execaSync('git', ['-C', dir, 'commit', '-qm', 'init']);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('有 remote-tracking 就用三點形式（比的是「這個分支做了什麼」）', async () => {
    execaSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
    assert.equal(await resolveDiffBase(dir, 'main'), 'origin/main...');
  });

  it('沒有 remote-tracking 就退回原本的行為（離線或無 remote 的 repo 照樣能跑）', async () => {
    assert.equal(await resolveDiffBase(dir, 'main'), 'main');
  });

  it('HEAD 與已經含 .. 的 ref 原樣使用（那是別的用途，不該被改寫）', async () => {
    execaSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
    assert.equal(await resolveDiffBase(dir, 'HEAD'), 'HEAD');
    assert.equal(await resolveDiffBase(dir, 'main...HEAD'), 'main...HEAD');
  });
});
