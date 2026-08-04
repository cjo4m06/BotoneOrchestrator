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

  // 審查者吸收了介面判斷的職責——它要自己開瀏覽器看畫面。
  // 漏掉這組工具的症狀是：它照樣會被要求填 uiChecked，但**沒有能力去看**，
  // 於是每次都只能寫「沒看」，而那看起來完全合法。
  it('審查者有瀏覽器工具（它要自己去看畫面，不是靠別人餵截圖）', () => {
    const src = readFileSync('src/worker/reviewer.ts', 'utf8');
    assert.match(
      src,
      /\.\.\.READONLY_BROWSER_TOOLS/,
      '審查者的工具清單缺瀏覽器——它會被要求填 uiChecked 卻沒有能力去看',
    );
  });

  it('審查者有唯讀 git（分不出新舊就會把既有瑕疵算到這次頭上）', () => {
    const src = readFileSync('src/worker/reviewer.ts', 'utf8');
    for (const t of ['git_changed_files', 'git_diff', 'git_blame']) {
      assert.match(src, new RegExp(`mcp__git__${t}`), `審查者缺 ${t}`);
    }
  });

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

/**
 * 出口工具的接線。
 *
 * ── 這個 repo 已經被同一種病咬過四次 ──
 *
 * 能力做好了、清單漏一項，症狀只有一行 WARN 而閘門照樣綠燈：
 * DOCS_TOOLS 只接給 coder、ReviewWatcher 只掃兩種狀態（16 個任務死結）、
 * pending 只掃 failed、typecheck 沒跑 test/tsconfig（81 個型別錯誤累積）。
 *
 * `createFrictionServer` 也一樣——它被寫好之後**零個呼叫端**，
 * 而規劃者是唯一看得到「兩張卡彼此矛盾」的角色，一個出口都沒有。
 */
describe('出口工具接線', () => {
  it('規劃 agent 的工具清單裡有 report_friction', () => {
    const src = readFileSync('src/core/plan-agent.ts', 'utf8');
    assert.match(
      src,
      /mcp__friction__report_friction/,
      '它是唯一一次看到整批任務的角色——「兩張卡的要求彼此矛盾」只有它看得見',
    );
    assert.match(src, /createFrictionServer/, '清單列了工具但沒掛 server ＝ 呼叫時才失敗');
  });

  it('main 有把 sink 注入規劃 agent（沒接的話回報會靜靜消失）', () => {
    const src = readFileSync('src/main.ts', 'utf8');
    const i = src.indexOf('new PlanAgent({');
    assert.ok(i >= 0, '找不到 PlanAgent 的建構');
    assert.match(src.slice(i, i + 220), /frictionSink/, 'sink 沒接 → NOOP，agent 以為講出去了，其實沒有');
  });

  it('friction 的兩個註冊點欄位一致（少一個欄位＝那個角色講不出同樣的事）', () => {
    const inline = readFileSync('src/worker/agent-runtime.ts', 'utf8');
    const server = readFileSync('src/worker/friction-server.ts', 'utf8');
    for (const field of ['kind', 'what', 'evidence', 'suggestion']) {
      assert.match(server, new RegExp(`${field}:`), `friction-server 少了 ${field}`);
      assert.match(inline, new RegExp(`${field}:`), `agent-runtime 的 friction 少了 ${field}`);
    }
    // blocked 已退場：兩邊都不可以留著（留一邊＝兩個角色的契約不一樣）
    assert.doesNotMatch(server, /blocked:/);
  });
});
