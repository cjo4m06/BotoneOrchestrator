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

/** 工作區是否有任何變更（DoD：diff 非空）。 */
export async function workingTreeChanged(cwd: string): Promise<boolean> {
  const p = (await execa('git', ['-C', cwd, 'status', '--porcelain'], { reject: false })).stdout.trim();
  return p.length > 0;
}
