import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DOCS_TOOLS, createDocsServer, type DocsSource } from '../src/worker/docs-server.js';
import { createSilentLogger, createRecordingLogger } from './helpers/index.js';

/**
 * 規格先前是**程式**幫 agent 讀好的：把 docRef 拆成 docType/fileName#section 再呼叫 read_doc。
 * 只要檔案改名、章節改名、或 docType 對不上，就整份讀不到，而且只留一行 warn。
 *
 * 實跑撞到：任務的 docRef 是 issues/2026-07-31-xxx.md，MCP 的 read_doc 只吃單數 issue，
 * 於是每一個帶 issue 規格的任務，agent 都是沒看過原始稽核報告就做的——
 * 而它做出來的東西 build/test 全過。
 *
 * 程式做不到的是「找」：字串對不上就是對不上。agent 可以搜、可以列出來看、
 * 可以讀內容判斷像不像。
 */

const source = (over: Partial<DocsSource> = {}): DocsSource => ({
  listDocs: async () => 'prd/a.md\nspec/b.md\nissues/c.md',
  searchDocs: async (q) => `搜尋「${q}」的結果`,
  readDoc: async (t, f, s) => `[${t}/${f}${s ? '#' + s : ''}] 內容`,
  ...over,
});

/**
 * SDK 把工具註冊在 McpServer 實例的 `_registeredTools` 裡（名稱 → { callback }）。
 * 這是內部結構，但沒有公開的取用方式，而「工具真的會回什麼」正是要測的東西。
 */
const handlerOf = (server: unknown, name: string): ((args: unknown) => Promise<{ content: { text: string }[] }>) => {
  const reg = (server as { instance: { _registeredTools: Record<string, { handler: unknown }> } })
    .instance._registeredTools;
  const t = reg[name];
  assert.ok(t, `找不到工具 ${name}（實際有：${Object.keys(reg).join(', ')}）`);
  return t.handler as (a: unknown) => Promise<{ content: { text: string }[] }>;
};

describe('docs-server', () => {
  it('提供三個工具，名稱與 allowedTools 一致', () => {
    assert.deepEqual(DOCS_TOOLS, ['mcp__docs__list_docs', 'mcp__docs__search_docs', 'mcp__docs__read_doc']);
  });

  it('list_docs / search_docs / read_doc 都會把結果交回去', async () => {
    const s = createDocsServer(source(), createSilentLogger());
    assert.match((await handlerOf(s, 'list_docs')({})).content[0]!.text, /spec\/b\.md/);
    assert.match((await handlerOf(s, 'search_docs')({ query: '觸控熱區' })).content[0]!.text, /觸控熱區/);
    assert.match((await handlerOf(s, 'read_doc')({ docType: 'issue', fileName: 'c.md' })).content[0]!.text, /issue\/c\.md/);
  });

  /**
   * 工具壞掉不可以讓 agent 那一輪整個報銷——它要能看到錯誤訊息、換個方式再找。
   */
  it('底層失敗 → 把錯誤當成回應交給 agent，不擲錯', async () => {
    const rec = createRecordingLogger();
    const s = createDocsServer(
      source({ searchDocs: async () => { throw new Error('搜尋服務掛了'); } }),
      rec.logger,
    );
    const r = await handlerOf(s, 'search_docs')({ query: 'x' });
    assert.match(r.content[0]!.text, /search_docs 失敗：搜尋服務掛了/);
    assert.ok(rec.messages('warn').some((m) => m.includes('文件工具呼叫失敗')));
  });

  it('過長的內容會截斷（塞爆 context 反而讓它看不到重點）', async () => {
    const s = createDocsServer(source({ readDoc: async () => 'x'.repeat(50_000) }), createSilentLogger());
    const r = await handlerOf(s, 'read_doc')({ docType: 'spec', fileName: 'big.md' });
    assert.ok(r.content[0]!.text.length < 31_000);
    assert.match(r.content[0]!.text, /已截斷/);
  });
});
