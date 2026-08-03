import { execa } from 'execa';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 未追蹤檔案內容最多納入多少（避免一個巨大的產出檔把每輪都拖慢）。 */
const MAX_UNTRACKED_FILES = 500;
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

/**
 * 工作區變更指紋（給無進展偵測）。
 *
 * 涵蓋三部分：未追蹤/已修改清單（porcelain）、相對 HEAD 的 diff 內容，
 * **以及未追蹤檔案的內容**。
 *
 * 第三部分不能省：porcelain 對未追蹤檔案只印檔名（`?? a.ts`），而 `git diff HEAD`
 * 完全看不到它們。少了它，「agent 新建一個檔案、之後每輪都在改它」每輪都會得到
 * 一模一樣的簽章，被無進展偵測判成卡住——正在好好做事的任務反而被 park。
 */
export async function gitDiffHash(cwd: string): Promise<string> {
  const porcelain = (await execa('git', ['-C', cwd, 'status', '--porcelain'], { reject: false })).stdout;
  const diff = (await execa('git', ['-C', cwd, 'diff', '--no-color', 'HEAD'], { reject: false })).stdout;
  const untracked = await untrackedHash(cwd);
  return createHash('sha1').update(`${porcelain} ${diff} ${untracked}`).digest('hex');
}

/**
 * 未追蹤檔案（已套用 .gitignore）的內容摘要。
 * 讀不到的檔案以固定字串代替——刪除／權限問題本身就是一種「有變化」。
 */
async function untrackedHash(cwd: string): Promise<string> {
  const r = await execa('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard', '-z'], { reject: false });
  const files = r.stdout.split('\0').filter((f) => f !== '').sort().slice(0, MAX_UNTRACKED_FILES);
  if (files.length === 0) return '';

  const h = createHash('sha1');
  for (const rel of files) {
    h.update(rel);
    const abs = join(cwd, rel);
    try {
      const size = statSync(abs).size;
      // 超大檔只納入大小：那通常是建置產物，而大小已足以反映「有沒有變」
      if (size > MAX_UNTRACKED_BYTES) h.update(`size:${size}`);
      else h.update(readFileSync(abs));
    } catch {
      h.update('unreadable');
    }
  }
  return h.digest('hex');
}

/**
 * 相對 `baseRef` 有沒有任何變更。
 *
 * **一定要帶 baseRef。** 不帶的話只看得到「未 commit 的東西」（`status --porcelain`），
 * 而 agent 有 git commit 的能力——它把工作做完並提交之後 porcelain 就是空的。
 *
 * 實跑撞到：agent 改了 15 行、commit 成 113c824，Stop hook 卻在**它自己的回合裡**
 * 當面告訴它「工作區沒有任何檔案變更，代表這個任務還沒被實作」。
 * agent 對那句話最直接的反應是 `git reset HEAD~1` 把 commit 退掉讓變更「重新出現」——
 * 我們用一句錯的訊息，教會了它去改寫 git 歷史。
 */
export async function workingTreeChanged(cwd: string, baseRef?: string): Promise<boolean> {
  if (baseRef !== undefined) {
    const r = await changedSince(cwd, baseRef);
    // 查不出來時保守回 true：擋下收工的代價是多跑一輪，誤判「沒做事」的代價是叫它去改 git
    return r.ok ? r.files.length > 0 : true;
  }
  const p = (await execa('git', ['-C', cwd, 'status', '--porcelain'], { reject: false })).stdout.trim();
  return p.length > 0;
}

// ── 「相對某個基準有沒有變更／變更長什麼樣」的唯一定義 ──
//
// 這件事原本散在三個地方，而且只有 DoD 那一份用對基準：
//   1. verifier 的 changedSince(baseRef)          ← 對的
//   2. status.ts 的 workingTreeChanged(porcelain) ← Stop hook 用，agent 一 commit 就瞎
//   3. reviewer 的 collectGitDiff('HEAD')          ← 同上，而且 git 失敗會被當成「沒實作」
// 全部收斂到這裡，讓「基準」只有一種寫法。

/** git 空樹的固定 sha：repo 還沒有任何 commit 時當基準，等於「所有檔案都是新增」。 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** git 查詢逾時：卡住的 git 不該讓整個任務跟著卡住。 */
const GIT_TIMEOUT_MS = 10_000;

/** 未追蹤新檔補內容的上限（避免一個巨大產出檔把 reviewer 的 context 塞爆）。 */
const MAX_UNTRACKED_DIFF_FILES = 50;
const MAX_UNTRACKED_DIFF_BYTES = 64 * 1024;

export type WorkspaceChanges = { ok: true; files: string[] } | { ok: false; detail: string };

type GitOut = { ok: true; stdout: string } | { ok: false; detail: string };

async function git(cwd: string, args: string[], okExit = 0): Promise<GitOut> {
  try {
    const r = await execa('git', ['-C', cwd, ...args], { reject: false, timeout: GIT_TIMEOUT_MS });
    if ((r.exitCode ?? 1) > okExit) {
      const why = (r.stderr || r.stdout || '').split('\n').slice(-3).join(' ').trim();
      return { ok: false, detail: `git ${args[0]} 失敗：${why || `exit ${r.exitCode}`}` };
    }
    return { ok: true, stdout: r.stdout };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 相對 baseRef 有沒有任何變更。兩路都要查，缺一不可：
 *  - `git diff --name-only <baseRef>`：工作區 vs baseRef，涵蓋「已 commit」與「改了還沒 commit」
 *    的追蹤檔（agent 自己 commit 過也算數）。
 *  - `git ls-files --others --exclude-standard`：**未追蹤的新檔案**——新增檔案也是變更，
 *    但還沒進 index，上面那道 diff 看不到它。
 *
 * 截圖不會混進來：Verifier 已強制把截圖目錄導到 worktree 之外（見 resolveVisualDirs）。
 */
export async function changedSince(cwd: string, baseRef: string): Promise<WorkspaceChanges> {
  const tracked = await git(cwd, ['diff', '--name-only', '-z', baseRef, '--']);
  if (!tracked.ok) return tracked;
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!untracked.ok) return untracked;

  const files = [...splitNul(tracked.stdout), ...splitNul(untracked.stdout)].filter(countsAsChange);
  return { ok: true, files: [...new Set(files)] };
}

/**
 * 取相對 baseRef 的完整 diff 內容（給 reviewer 看）。
 *
 * **git 失敗一律擲錯，不回空字串。** 先前的實作兩個 execa 都帶 `{ reject: false }`，
 * 於是「不是 git 工作區」「baseRef 解析不到」「git 不在 PATH」全都變成空字串，
 * 而空字串在 reviewer 那邊等於「你沒有實作」——把量測端的故障翻譯成對 agent 的指控。
 *
 * 未追蹤的新檔要補上內容：只列檔名的話，「這個任務主要在新增檔案」時
 * reviewer 一行程式碼都看不到，卻要它判斷實作對不對。
 */
export async function collectDiffSince(cwd: string, baseRef: string): Promise<string> {
  const tracked = await git(cwd, ['diff', '--no-color', baseRef, '--']);
  if (!tracked.ok) throw new Error(tracked.detail);

  const listed = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!listed.ok) throw new Error(listed.detail);
  const news = splitNul(listed.stdout).filter(countsAsChange).slice(0, MAX_UNTRACKED_DIFF_FILES);

  const parts: string[] = [tracked.stdout];
  for (const rel of news) {
    let size = Number.POSITIVE_INFINITY;
    try {
      size = statSync(join(cwd, rel)).size;
    } catch {
      // 讀不到大小就當它過大，只列檔名——不要為了補內容而讓整個審查失敗
    }
    if (size > MAX_UNTRACKED_DIFF_BYTES) {
      parts.push(`\n# ${rel}（新檔，內容過大僅列檔名）`);
      continue;
    }
    // --no-index 是唯讀比對，不必 git add -N（reviewer 不該動 index）。
    // 有差異時它的 exit code 是 1，所以 okExit 給 1。
    const one = await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', rel], 1);
    parts.push(one.ok ? one.stdout : `\n# ${rel}（新檔，取內容失敗：${one.detail}）`);
  }
  if (splitNul(listed.stdout).filter(countsAsChange).length > news.length) {
    parts.push(`\n# …另有未追蹤新檔未列出（超過 ${MAX_UNTRACKED_DIFF_FILES} 個）`);
  }
  return parts.join('\n');
}

/** -z 輸出以 NUL 分隔（避免路徑含空白/中文被 git 加引號跳脫）。 */
function splitNul(s: string): string[] {
  return s.split('\0').filter((x) => x.length > 0);
}

/**
 * node_modules 不算「本任務的變更」：GroupRunner 會把它 symlink 進 worktree，
 * 專案若沒把它加進 .gitignore 就會被列成未追蹤檔——那正是我們要防的「空 diff 誤判成有做事」。
 */
function countsAsChange(path: string): boolean {
  return path !== 'node_modules' && !path.startsWith('node_modules/');
}
