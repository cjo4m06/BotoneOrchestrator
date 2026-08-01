import { execa } from 'execa';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Logger } from '../observability/logger.js';

/**
 * 檔案足跡掃描（DESIGN.md §D7-D9）。Dispatcher 靠足跡判斷「兩群會不會撞同一批檔案」；
 * Planner 目前只用 docRef 檔名當代理，太粗糙——這裡改成從任務文字抽線索，再到 repo 定位候選檔。
 *
 * 刻意做輕：只有「路徑比對 + 檔名比對 + 字面 grep」，不做 AST/import graph。
 * 這是吞吐量最佳化而非正確性保證（§D9），判錯由 Merge Guard 兜底，所以寧可快也不要重。
 */

export interface FootprintScanInput {
  /** repo 本地路徑；不存在或非 git repo 時回空足跡（不炸）。 */
  repoPath: string;
  title?: string;
  description?: string;
  /** "path#section" 形式的 docRefs。 */
  docRefs?: string[];
  /** 已載入的規格內容（有的話一起抽線索，命中率更高）。 */
  docContents?: string[];
}

export interface Footprint {
  /** 命中的檔案（repo 相對路徑），依信心分數排序。 */
  files: string[];
  /** files 的所屬目錄（粗粒度重疊判斷用）。 */
  dirs: string[];
  /** 抽出的線索，供 log/除錯與人工檢視。 */
  hints: { paths: string[]; symbols: string[] };
}

export interface FootprintScannerDeps {
  log: Logger;
  /** 列出 repo 內受版控檔案。預設 `git ls-files`，失敗時退回檔案系統走訪。 */
  listFiles?: (repoPath: string) => Promise<string[]>;
  /** 以字面字串搜尋內容，回傳命中檔案。預設 `git grep -l -F`。 */
  grepFiles?: (repoPath: string, needle: string) => Promise<string[]>;
}

/** 掃描上限：避免一個描述含大量詞彙時把整個 repo 拉進足跡。 */
const MAX_SYMBOLS_TO_GREP = 8;
const MAX_FILES = 60;
const MAX_GREP_HITS_PER_SYMBOL = 12;

export class FootprintScanner {
  constructor(private deps: FootprintScannerDeps) {}

  async scan(input: FootprintScanInput): Promise<Footprint> {
    const text = [input.title, input.description, ...(input.docContents ?? [])].filter(Boolean).join('\n');
    const paths = uniq([...extractPathHints(text), ...(input.docRefs ?? []).map(docFile)]);
    const symbols = extractSymbolHints(text);
    const hints = { paths, symbols };

    const listFiles = this.deps.listFiles ?? defaultListFiles;
    let repoFiles: string[];
    try {
      repoFiles = await listFiles(input.repoPath);
    } catch (e) {
      // repo 不存在/非 git → 優雅回退成空足跡，讓 Dispatcher 退化為「保守序列化」判斷
      this.deps.log.warn({ repoPath: input.repoPath, err: msg(e) }, '足跡掃描：無法列出 repo 檔案，回傳空足跡');
      return { files: [], dirs: [], hints };
    }
    if (repoFiles.length === 0) return { files: [], dirs: [], hints };

    const scored = matchFilesByHints(repoFiles, paths, symbols);

    // 檔名對不上的 symbol 才進 grep（貴），且只取前幾個最具辨識度的
    const unmatched = symbols.filter((s) => !scored.some((c) => c.reasons.includes(`symbol:${s}`)));
    const grepFiles = this.deps.grepFiles ?? defaultGrepFiles;
    for (const sym of unmatched.slice(0, MAX_SYMBOLS_TO_GREP)) {
      let hits: string[] = [];
      try {
        hits = (await grepFiles(input.repoPath, sym)).slice(0, MAX_GREP_HITS_PER_SYMBOL);
      } catch (e) {
        this.deps.log.debug({ sym, err: msg(e) }, '足跡掃描：grep 失敗，略過此線索');
        continue;
      }
      for (const f of hits) addCandidate(scored, f, 1, `grep:${sym}`);
    }

    const files = rankCandidates(scored).slice(0, MAX_FILES);
    this.deps.log.debug({ paths, symbols, hit: files.length }, '足跡掃描完成');
    return { files, dirs: toDirs(files), hints };
  }
}

// ── 純函式（可單元驗證） ──

export interface FileCandidate {
  file: string;
  score: number;
  reasons: string[];
}

/** docRef "path#section" → "path"。 */
export const docFile = (ref: string): string => ref.split('#')[0] ?? ref;

/**
 * 從文字抽「看起來像檔案路徑」的線索。
 * 兩種形態：含目錄分隔的路徑（src/foo/bar.ts）、單獨的帶副檔名檔名（Button.tsx）。
 */
export function extractPathHints(text: string): string[] {
  const out = new Set<string>();
  const EXT = 'ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|rb|java|kt|swift|css|scss|less|html|json|yaml|yml|md|sql|sh';
  const withDir = new RegExp(`(?:[\\w.@-]+/)+[\\w.@-]+(?:\\.(?:${EXT}))?`, 'g');
  const bareFile = new RegExp(`\\b[\\w.@-]+\\.(?:${EXT})\\b`, 'g');

  for (const m of text.matchAll(withDir)) {
    const raw = trimPath(m[0]);
    // 過濾 URL/套件名雜訊：github.com/x/y、@scope/pkg
    if (/^https?:/.test(raw) || raw.startsWith('@') || /\.(com|org|net|io|dev)\//.test(raw)) continue;
    if (raw.length > 1) out.add(raw);
  }
  for (const m of text.matchAll(bareFile)) {
    const raw = trimPath(m[0]);
    if (raw.length > 2) out.add(raw);
  }
  return [...out];
}

const CODE_STOPWORDS = new Set([
  'TODO', 'NOTE', 'API', 'URL', 'HTTP', 'HTTPS', 'JSON', 'YAML', 'HTML', 'CSS', 'SQL',
  'PR', 'CI', 'UI', 'UX', 'DB', 'ID', 'MCP', 'SDK', 'README', 'DESIGN',
]);

/**
 * 從文字抽「元件/模組名」線索：CamelCase 識別字、反引號內的識別字、kebab-case 模組名。
 * 這些之後會拿去比對檔名或字面 grep。
 */
export function extractSymbolHints(text: string): string[] {
  const out = new Set<string>();

  // 反引號內容優先（作者刻意標示的識別字）
  for (const m of text.matchAll(/`([A-Za-z_][\w.-]{2,})`/g)) {
    const s = m[1]!;
    if (!s.includes('.') && !CODE_STOPWORDS.has(s)) out.add(s);
  }
  // CamelCase / PascalCase（LoginForm、useAuthStore）
  for (const m of text.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|use[A-Z][A-Za-z0-9]+)\b/g)) {
    if (!CODE_STOPWORDS.has(m[1]!)) out.add(m[1]!);
  }
  // kebab-case 模組名（user-profile-card），需含至少一個 -
  for (const m of text.matchAll(/\b([a-z][a-z0-9]{1,}(?:-[a-z0-9]+)+)\b/g)) out.add(m[1]!);

  return [...out];
}

/**
 * 把線索對映到 repo 內實際檔案。
 * 路徑線索：完全相符或後綴相符（描述常只寫部分路徑）。
 * 符號線索：檔名（去副檔名）以各種命名風格比對（LoginForm ↔ login-form.tsx ↔ login_form.py）。
 */
export function matchFilesByHints(repoFiles: string[], paths: string[], symbols: string[]): FileCandidate[] {
  const candidates: FileCandidate[] = [];
  const normalized = repoFiles.map((f) => f.replace(/^\.\//, ''));

  for (const hint of paths) {
    const h = hint.replace(/^\.\//, '');
    for (const f of normalized) {
      if (f === h) addCandidate(candidates, f, 10, `path:${hint}`);
      else if (f.endsWith(`/${h}`)) addCandidate(candidates, f, 6, `path:${hint}`);
      // 只給了檔名（無目錄）→ 比對 basename，但分數低（可能多檔同名）
      else if (!h.includes('/') && basename(f) === h) addCandidate(candidates, f, 4, `path:${hint}`);
    }
  }

  const symKeys = symbols.map((s) => ({ sym: s, key: normalizeIdent(s) })).filter((x) => x.key.length >= 3);
  for (const f of normalized) {
    const stem = normalizeIdent(stripExt(basename(f)));
    if (!stem) continue;
    for (const { sym, key } of symKeys) {
      if (stem === key) addCandidate(candidates, f, 5, `symbol:${sym}`);
      else if (stem.includes(key) && key.length >= 5) addCandidate(candidates, f, 3, `symbol:${sym}`);
    }
  }

  return candidates;
}

/** 依分數（同分則命中線索多者優先、再依路徑）排序輸出檔案清單。 */
export function rankCandidates(candidates: FileCandidate[]): string[] {
  return [...candidates]
    .sort((a, b) => b.score - a.score || b.reasons.length - a.reasons.length || a.file.localeCompare(b.file))
    .map((c) => c.file);
}

/** 檔案清單 → 去重後的所屬目錄（根目錄檔案記為 '.'）。 */
export function toDirs(files: string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const i = f.lastIndexOf('/');
    out.add(i < 0 ? '.' : f.slice(0, i));
  }
  return [...out];
}

/** 兩份足跡的交集（Dispatcher 判斷群間能否並行）。目錄層級也算重疊。 */
export function footprintOverlap(a: Footprint | string[], b: Footprint | string[]): string[] {
  const fa = Array.isArray(a) ? a : [...a.files, ...a.dirs];
  const fb = new Set(Array.isArray(b) ? b : [...b.files, ...b.dirs]);
  return [...new Set(fa.filter((x) => fb.has(x)))];
}

// ── 預設 IO 實作 ──

async function defaultListFiles(repoPath: string): Promise<string[]> {
  const res = await execa('git', ['-C', repoPath, 'ls-files'], { reject: false });
  if (res.exitCode === 0 && res.stdout.trim()) return res.stdout.split('\n').filter(Boolean);
  // 非 git repo（或空 repo）→ 退回走訪檔案系統
  return walk(repoPath);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '__pycache__']);

async function walk(root: string, dir = root, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, acc);
    else if (e.isFile()) acc.push(relative(root, full).split(sep).join('/'));
    if (acc.length > 5000) break; // 超大 repo 保護：足跡估算不需要看完全部
  }
  return acc;
}

async function defaultGrepFiles(repoPath: string, needle: string): Promise<string[]> {
  const res = await execa('git', ['-C', repoPath, 'grep', '-l', '-F', '--', needle], { reject: false });
  if (res.exitCode !== 0) return []; // exit 1 = 無命中，非錯誤
  return res.stdout.split('\n').filter(Boolean);
}

// ── 小工具 ──

function addCandidate(list: FileCandidate[], file: string, score: number, reason: string): void {
  const found = list.find((c) => c.file === file);
  if (found) {
    found.score += score;
    if (!found.reasons.includes(reason)) found.reasons.push(reason);
    return;
  }
  list.push({ file, score, reasons: [reason] });
}

/** 命名風格正規化：LoginForm / login-form / login_form → loginform，讓跨風格比對成立。 */
function normalizeIdent(s: string): string {
  return s.replace(/[-_.\s]/g, '').toLowerCase();
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const stripExt = (f: string): string => f.replace(/\.[A-Za-z0-9]+$/, '');
const trimPath = (s: string): string => s.replace(/^[^\w./@-]+/, '').replace(/[.,;:)\]}]+$/, '');
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
