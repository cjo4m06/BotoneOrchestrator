import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FootprintScanner,
  docFile,
  extractPathHints,
  extractSymbolHints,
  footprintOverlap,
  matchFilesByHints,
  rankCandidates,
  toDirs,
} from '../src/worker/footprint.js';
import type { Logger } from '../src/observability/logger.js';

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

const REPO_FILES = [
  'src/components/LoginForm.tsx',
  'src/components/Header.tsx',
  'src/auth/context.tsx',
  'src/styles/login-form.css',
  'src/api/user-profile.ts',
  'README.md',
];

describe('extractPathHints', () => {
  it('抽出含目錄的路徑與單獨檔名', () => {
    const hints = extractPathHints('請修改 src/components/LoginForm.tsx，並同步更新 login-form.css 的樣式');
    assert.ok(hints.includes('src/components/LoginForm.tsx'));
    assert.ok(hints.includes('login-form.css'));
  });

  it('中文夾雜不影響切分', () => {
    const hints = extractPathHints('在src/api/user-profile.ts加一個欄位');
    assert.ok(hints.includes('src/api/user-profile.ts'));
  });

  it('過濾 URL 與 scope 套件名', () => {
    const hints = extractPathHints('參考 https://github.com/foo/bar 與 @scope/pkg 的做法');
    assert.equal(hints.some((h) => h.includes('github.com')), false);
    assert.equal(hints.some((h) => h.startsWith('@')), false);
  });

  it('去掉句尾標點', () => {
    const hints = extractPathHints('改 src/index.ts, 然後 build');
    assert.ok(hints.includes('src/index.ts'));
  });
});

describe('extractSymbolHints', () => {
  it('抽出 CamelCase 元件名與 use* hook', () => {
    const s = extractSymbolHints('把 LoginForm 改成用 useAuthStore 取得狀態');
    assert.ok(s.includes('LoginForm'));
    assert.ok(s.includes('useAuthStore'));
  });

  it('抽出反引號內識別字與 kebab-case 模組名', () => {
    const s = extractSymbolHints('呼叫 `fetchProfile`，模組是 user-profile');
    assert.ok(s.includes('fetchProfile'));
    assert.ok(s.includes('user-profile'));
  });

  it('濾掉常見大寫縮寫雜訊', () => {
    const s = extractSymbolHints('這個 API 走 HTTP，PR 裡說明');
    assert.equal(s.includes('API'), false);
    assert.equal(s.includes('HTTP'), false);
  });
});

describe('matchFilesByHints', () => {
  it('完全相符的路徑分數最高', () => {
    const c = matchFilesByHints(REPO_FILES, ['src/components/LoginForm.tsx'], []);
    const top = rankCandidates(c)[0];
    assert.equal(top, 'src/components/LoginForm.tsx');
  });

  it('部分路徑（後綴）也能定位', () => {
    const c = matchFilesByHints(REPO_FILES, ['components/Header.tsx'], []);
    assert.deepEqual(rankCandidates(c), ['src/components/Header.tsx']);
  });

  it('符號可跨命名風格對到檔名（LoginForm ↔ login-form.css）', () => {
    const c = matchFilesByHints(REPO_FILES, [], ['LoginForm']);
    const files = rankCandidates(c);
    assert.ok(files.includes('src/components/LoginForm.tsx'));
    assert.ok(files.includes('src/styles/login-form.css'));
  });

  it('對不上的線索不產生候選', () => {
    assert.deepEqual(matchFilesByHints(REPO_FILES, ['does/not/exist.ts'], ['NoSuchThing']), []);
  });

  it('同檔案多線索命中會累加分數', () => {
    const c = matchFilesByHints(REPO_FILES, ['src/components/LoginForm.tsx'], ['LoginForm']);
    const hit = c.find((x) => x.file === 'src/components/LoginForm.tsx')!;
    assert.equal(hit.score, 15);
    assert.equal(hit.reasons.length, 2);
  });
});

describe('toDirs / footprintOverlap / docFile', () => {
  it('toDirs 取所屬目錄並去重', () => {
    assert.deepEqual(toDirs(['src/a/x.ts', 'src/a/y.ts', 'z.md']), ['src/a', '.']);
  });

  it('footprintOverlap 找出交集', () => {
    assert.deepEqual(footprintOverlap(['a.ts', 'b.ts'], ['b.ts', 'c.ts']), ['b.ts']);
    assert.deepEqual(footprintOverlap(['a.ts'], ['c.ts']), []);
  });

  it('footprintOverlap 也接受 Footprint 物件（含目錄層）', () => {
    const a = { files: ['src/a/x.ts'], dirs: ['src/a'], hints: { paths: [], symbols: [] } };
    const b = { files: ['src/a/y.ts'], dirs: ['src/a'], hints: { paths: [], symbols: [] } };
    assert.deepEqual(footprintOverlap(a, b), ['src/a']);
  });

  it('docFile 去掉 #section', () => {
    assert.equal(docFile('spec/login.md#表單驗證'), 'spec/login.md');
    assert.equal(docFile('spec/login.md'), 'spec/login.md');
  });
});

describe('FootprintScanner.scan', () => {
  const scanner = (over: Partial<Parameters<typeof makeDeps>[0]> = {}) => new FootprintScanner(makeDeps(over));
  function makeDeps(o: { files?: string[]; grep?: Record<string, string[]>; throwOnList?: boolean }) {
    return {
      log,
      listFiles: async () => {
        if (o.throwOnList) throw new Error('not a git repo');
        return o.files ?? REPO_FILES;
      },
      grepFiles: async (_repo: string, needle: string) => o.grep?.[needle] ?? [],
    };
  }

  it('綜合描述 + docRefs 定位候選檔案', async () => {
    const fp = await scanner().scan({
      repoPath: '/repo',
      title: '修正登入表單驗證',
      description: '調整 src/components/LoginForm.tsx，樣式在 login-form.css',
      docRefs: ['spec/login.md#驗證規則'],
    });
    assert.ok(fp.files.includes('src/components/LoginForm.tsx'));
    assert.ok(fp.files.includes('src/styles/login-form.css'));
    assert.ok(fp.dirs.includes('src/components'));
    assert.ok(fp.hints.paths.includes('spec/login.md'));
  });

  it('檔名對不上的符號才走 grep', async () => {
    const fp = await scanner({ grep: { AuthProvider: ['src/auth/context.tsx'] } }).scan({
      repoPath: '/repo',
      description: '把 AuthProvider 包到最外層',
    });
    assert.deepEqual(fp.files, ['src/auth/context.tsx']);
  });

  it('grep 失敗只略過該線索，不炸', async () => {
    const s = new FootprintScanner({
      log,
      listFiles: async () => REPO_FILES,
      grepFiles: async () => {
        throw new Error('grep boom');
      },
    });
    const fp = await s.scan({ repoPath: '/repo', description: '調整 SomeUnknownThing 與 `Header` 元件' });
    assert.ok(fp.files.includes('src/components/Header.tsx'));
  });

  it('repo 不存在（列檔失敗）回傳空足跡而非拋錯', async () => {
    const fp = await scanner({ throwOnList: true }).scan({
      repoPath: '/nope',
      description: '改 src/components/LoginForm.tsx',
    });
    assert.deepEqual(fp.files, []);
    assert.deepEqual(fp.dirs, []);
    assert.ok(fp.hints.paths.length > 0); // 線索仍保留供除錯
  });

  it('空 repo 回傳空足跡', async () => {
    const fp = await scanner({ files: [] }).scan({ repoPath: '/repo', description: '改 LoginForm' });
    assert.deepEqual(fp.files, []);
  });

  it('沒有任何線索時不會把整個 repo 拉進足跡', async () => {
    const fp = await scanner().scan({ repoPath: '/repo', description: '把畫面調得好看一點' });
    assert.deepEqual(fp.files, []);
  });

  it('docContents 內的路徑也會被採用', async () => {
    const fp = await scanner().scan({
      repoPath: '/repo',
      description: '照規格做',
      docContents: ['欄位定義見 src/api/user-profile.ts'],
    });
    assert.ok(fp.files.includes('src/api/user-profile.ts'));
  });
});
