import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../observability/logger.js';

/**
 * 讓 agent 自己去找任務板上的規格文件。
 *
 * ── 為什麼需要 ──
 *
 * 先前規格是**程式**幫 agent 讀好、貼進提示詞的：把任務的 docRef 字串拆成
 * `docType/fileName#section` 再呼叫 read_doc。那個做法很脆弱——只要檔案改名、
 * 章節改名、或 docType 對不上，就整份讀不到，而且只留一行 warn。
 *
 * 實跑撞到：任務的 docRef 是 `issues/2026-07-31-xxx.md`，但 MCP 的 read_doc 只吃
 * 單數 `issue`，於是每一個帶 issue 規格的任務，agent 都是**沒看過原始稽核報告**
 * 就開始做的。它做出來的東西 build/test 全過，看起來完全正常。
 *
 * 程式做不到的是「找」：字串對不上就是對不上。agent 可以搜、可以列出來看、
 * 可以讀內容判斷像不像——這件事本來就該是它做。
 *
 * ── 為什麼搜尋結果要它自己判斷 ──
 *
 * search_docs 是語意搜尋，**會回傳不相干的東西**。所以工具說明明講這件事，
 * 要求它讀過內容確認，而不是拿第一個結果當規格。程式不會替它篩，
 * 因為程式篩不出「這份是不是我要的」。
 */

export interface DocsSource {
  listDocs(): Promise<string>;
  searchDocs(query: string): Promise<string>;
  readDoc(docType: string, fileName: string, section?: string): Promise<string>;
}

/** 這個 server 提供的工具名（給 allowedTools 用）。 */
export const DOCS_TOOLS = ['mcp__docs__list_docs', 'mcp__docs__search_docs', 'mcp__docs__read_doc'];

/** 單一回應的字元上限：文件可能很長，塞爆 context 反而讓它看不到重點。 */
const MAX_CHARS = 30_000;

function clip(s: string): string {
  return s.length <= MAX_CHARS ? s : `${s.slice(0, MAX_CHARS)}\n…（內容過長已截斷，用 section 參數讀特定章節）`;
}

export function createDocsServer(src: DocsSource, log: Logger) {
  const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
  const fail = (what: string, e: unknown) => {
    const why = e instanceof Error ? e.message : String(e);
    log.warn({ what, err: why }, '文件工具呼叫失敗（已回報給 agent）');
    return text(`${what} 失敗：${why}`);
  };

  return createSdkMcpServer({
    name: 'docs',
    version: '1.0.0',
    tools: [
      tool(
        'list_docs',
        '列出這個專案的所有規格文件（prd/、spec/、issues/）。' +
          '**規格讀不到時先用這個**——多半是檔名或路徑跟任務裡寫的不一樣。',
        {},
        async () => {
          try {
            return text(clip(await src.listDocs()));
          } catch (e) {
            return fail('list_docs', e);
          }
        },
      ),
      tool(
        'search_docs',
        '用自然語言搜尋規格文件。' +
          '**這是語意搜尋，會回傳不相干的結果**——一定要把找到的文件讀過，' +
          '確認它真的在講這個任務的需求，再拿來當規格。不要拿第一個結果就開始寫。',
        { query: z.string().min(1).describe('要找什麼。用任務的關鍵字，例如「手機版觸控熱區 44px」') },
        async (args) => {
          try {
            return text(clip(await src.searchDocs(args.query)));
          } catch (e) {
            return fail('search_docs', e);
          }
        },
      ),
      tool(
        'read_doc',
        '讀一份規格文件的內容。docType 是 prd / spec / issue（**單數**），' +
          'fileName 是檔名。整份太長時用 section 讀特定章節。',
        {
          docType: z.string().describe('prd / spec / issue（單數。任務裡若寫 issues/ 請改成 issue）'),
          fileName: z.string().min(1).describe('檔名，例如 2026-07-31-mobile-menu.md'),
          section: z.string().optional().describe('只讀某個章節（標題文字）；省略＝整份'),
        },
        async (args) => {
          try {
            return text(clip(await src.readDoc(args.docType, args.fileName, args.section)));
          } catch (e) {
            return fail('read_doc', e);
          }
        },
      ),
    ],
  });
}
