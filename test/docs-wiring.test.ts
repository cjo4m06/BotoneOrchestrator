import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOCS_TOOLS } from '../src/worker/docs-server.js';
import { ALLOWED_TOOLS } from '../src/worker/agent-runtime.js';
import { RISK_JUDGE_TOOLS } from '../src/core/merge-risk-judge.js';

/**
 * 「規格由 agent 自己取」的接線測試。
 *
 * 這是這個專案最會重犯的錯：能力寫好了，只接上一半的呼叫點，症狀只有一行 WARN。
 * commit e2820a9 就是只把 DOCS_TOOLS 接給寫程式的 agent——而審查者的工作
 * 是「規格逐條 vs diff」，卻不能搜規格。
 *
 * 程式**不預抓規格內容**的理由（兩個都實際發生過）：
 * 1. docRef 字串對不上（實跑：docType 單複數不一致）→ 整份讀不到，只留一行 warn，
 *    而 build/test 全綠看起來完全正常
 * 2. 規格在任務進行中被更新 → 手上是開工那一刻的快照，而且不知道自己拿的是舊的
 */
describe('規格工具：每一個角色都要接到', () => {
  const ROLE_FILES: Record<string, string> = {
    '審查者': 'src/worker/reviewer.ts',
    '規劃者': 'src/core/plan-agent.ts',
    '語意飄移判斷者': 'src/pr/drift-judge.ts',
    '合併風險判斷者': 'src/core/merge-risk-judge.ts',
  };

  it('寫程式的 agent 有 DOCS_TOOLS', () => {
    for (const t of DOCS_TOOLS) assert.ok(ALLOWED_TOOLS.includes(t), `寫程式的 agent 缺 ${t}`);
  });

  it('合併風險判斷者有 DOCS_TOOLS（匯出的常數，直接比對）', () => {
    for (const t of DOCS_TOOLS) assert.ok(RISK_JUDGE_TOOLS.includes(t), `合併風險判斷者缺 ${t}`);
  });

  // 其餘三個角色的工具清單沒有匯出（各檔案內部的 const），改用原始碼比對——
  // 比「沒有測試」好：漏接時這裡會紅，而不是等到正式環境某個角色查不到規格。
  for (const [role, file] of Object.entries(ROLE_FILES)) {
    it(`${role} 的工具清單含 DOCS_TOOLS、且真的掛上 docs server`, () => {
      const src = readFileSync(file, 'utf8');
      assert.match(src, /\.\.\.DOCS_TOOLS/, `${role}（${file}）的工具清單沒有 DOCS_TOOLS`);
      assert.match(
        src,
        /docsServer \? \{[^}]*docs: docsServer/,
        `${role}（${file}）把工具列進清單了，卻沒有真的把 server 掛上 mcpServers——` +
          '那樣 agent 只會看到工具不存在，而且不會有任何錯誤',
      );
    });
  }

  it('main 把同一份 docs 來源接給所有角色（不是每個角色各寫一份）', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    const wired = (main.match(/docs: docsSourceOf/g) ?? []).length;
    assert.equal(
      wired,
      5,
      '五個角色（寫程式／審查／規劃／語意飄移／合併風險）都要接到同一份來源；' +
        `目前只接了 ${wired} 個——漏掉的那個會靜靜地查不到規格`,
    );
  });
});
