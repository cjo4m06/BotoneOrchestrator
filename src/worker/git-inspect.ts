import { execa } from 'execa';
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../observability/logger.js';

/**
 * 給「判斷者」用的唯讀 git 工具。
 *
 * 存在的理由：判斷者人就在 worktree 裡，git 歷史整份都在，但它拿到的工具只有
 * Read/Glob 與瀏覽器——**沒有任何能執行 git 的東西**。於是它只看得到
 * 「現在這個頁面長什麼樣」，看不到「這次改了什麼」。
 *
 * 後果實跑到了：介面判斷者回報「× 關閉鈕只有 36×20px」——這是事實，但那顆按鈕
 * 是既有的、不是這次任務弄的。它在稽核整個頁面，因為我問的問題就是「這個介面行不行」，
 * 而它沒有辦法分辨新舊。不是它判斷錯，是我給了它一間沒有窗戶的房間。
 *
 * 為什麼不直接給 Bash：判斷者不該有改東西的能力。這裡把邊界劃在工具層——
 * 只有白名單內的唯讀子指令、工作目錄鎖死、參數不接受任意字串拼接。
 * 判斷交給 agent，邊界由程式守住，跟系統其他地方同一個原則。
 */

export interface GitInspectOptions {
  /** 工作目錄。所有指令都鎖在這裡，呼叫端不能改。 */
  cwd: string;
  /** 比較基準（例如 'origin/main'）。判斷「這次改了什麼」的參照點。 */
  baseRef: string;
  log: Logger;
  /** 單一輸出上限（字元）。diff 可能非常大，塞爆 context 反而讓它看不到重點。 */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 30_000;

/** 路徑參數的防呆：不接受跳出工作目錄，也不接受把選項當路徑塞進來。 */
export function safeRelPath(p: string): string | undefined {
  const t = p.trim();
  if (t === '') return undefined;
  if (t.startsWith('-')) return undefined; // 別讓 "--upload-pack=..." 這種東西進 argv
  if (t.includes('\0')) return undefined;
  const segs = t.split('/');
  if (segs.includes('..')) return undefined;
  if (t.startsWith('/')) return undefined;
  return t;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…（輸出過長已截斷，請縮小範圍再查一次）`;
}

/**
 * 判斷者的工具組：唯讀 git ＋ 摩擦回報。
 *
 * 為什麼判斷者也要有回報出口：它們是最常撞到「我看到問題但查不下去」的角色——
 * 沒有 git 就分不出新舊、沒有某個工具就驗證不了猜測。那些限制先前只會變成
 * 一句它沒說出口的話，或者更糟：變成一個它只好猜的判定。
 */
export function createGitInspectServer(opts: GitInspectOptions) {
  const max = opts.maxChars ?? DEFAULT_MAX_CHARS;

  const run = async (args: string[]): Promise<string> => {
    const r = await execa('git', ['-C', opts.cwd, ...args], { reject: false });
    if (r.exitCode !== 0) {
      const detail = (r.stderr || r.stdout || '').trim();
      opts.log.debug({ args, detail }, 'git 唯讀查詢失敗');
      return `git ${args.join(' ')} 失敗：${detail || '（無輸出）'}`;
    }
    return clip(r.stdout, max);
  };

  const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

  return createSdkMcpServer({
    name: 'git',
    version: '1.0.0',
    tools: [
      tool(
        'git_changed_files',
        '列出「這次改動」動到哪些檔案（相對於基準分支），含每個檔案的增刪行數。' +
          '判斷一個問題是不是這次引入的，先從這裡開始。',
        {},
        async () => text(await run(['diff', '--stat', `${opts.baseRef}...HEAD`])),
      ),
      tool(
        'git_diff',
        '看某個檔案（或全部）在這次改動裡的 diff。先用 git_changed_files 縮小範圍，再查特定檔案。',
        {
          path: z.string().optional().describe('檔案路徑（repo 相對路徑）。省略＝全部，可能很長'),
        },
        async (args) => {
          const rel = args.path === undefined ? undefined : safeRelPath(args.path);
          if (args.path !== undefined && rel === undefined) return text(`不接受這個路徑：${args.path}`);
          return text(await run(['diff', `${opts.baseRef}...HEAD`, ...(rel ? ['--', rel] : [])]));
        },
      ),
      tool(
        'git_log',
        '看最近的 commit（訊息與時間）。用來理解這次改動的意圖，以及某個檔案的變更脈絡。',
        {
          path: z.string().optional().describe('只看動到這個檔案的 commit'),
          limit: z.number().int().min(1).max(50).optional().describe('筆數，預設 20'),
        },
        async (args) => {
          const rel = args.path === undefined ? undefined : safeRelPath(args.path);
          if (args.path !== undefined && rel === undefined) return text(`不接受這個路徑：${args.path}`);
          return text(
            await run([
              'log',
              `-${args.limit ?? 20}`,
              '--date=short',
              '--pretty=format:%h %ad %an  %s',
              ...(rel ? ['--', rel] : []),
            ]),
          );
        },
      ),
      tool(
        'git_blame',
        '查某個檔案某幾行**上次是誰、什麼時候改的**。' +
          '這是分辨「這次引入的問題」與「本來就有的問題」最直接的方法——' +
          '如果那幾行不在這次的 commit 裡，就是既有問題。',
        {
          path: z.string().describe('檔案路徑（repo 相對路徑）'),
          startLine: z.number().int().min(1).describe('起始行'),
          endLine: z.number().int().min(1).describe('結束行'),
        },
        async (args) => {
          const rel = safeRelPath(args.path);
          if (!rel) return text(`不接受這個路徑：${args.path}`);
          const from = Math.min(args.startLine, args.endLine);
          const to = Math.max(args.startLine, args.endLine);
          return text(
            await run(['blame', '-L', `${from},${to}`, '--date=short', '-w', 'HEAD', '--', rel]),
          );
        },
      ),
    ],
  });
}
