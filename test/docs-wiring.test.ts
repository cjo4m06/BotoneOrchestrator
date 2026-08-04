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
/**
 * 「每個角色都接得到規格工具」的逐一比對已經退場——那些是**手寫清單時代**的測試：
 * 一個角色一條 grep，加角色要記得加測試，而「記得」正是這個 repo 壞過六次的東西。
 *
 * 現在唯一的事實源是 capabilities.ts 的 `ROLE_CAPABILITIES`，
 * 由 test/capabilities.test.ts 用**結構性質**守著（只有一份清單、每個角色都在上面、
 * 宣告了就一定接得上、沒有人再手寫）。
 *
 * 這裡只留 main 的接線——那是表管不到的一段：材料要有人注入。
 */

describe('出口工具接線', () => {
  it('規劃 agent 真的建得出 friction server（清單有工具但沒掛 server ＝ 呼叫時才失敗）', () => {
    assert.match(readFileSync('src/core/plan-agent.ts', 'utf8'), /createFrictionServer/);
  });

  it('**審查者拿得到瀏覽器與唯讀 git 的材料**（它宣告了，main 就得給）', () => {
    const src = readFileSync('src/main.ts', 'utf8');
    const i = src.indexOf('new Reviewer({');
    assert.ok(i >= 0);
    assert.match(
      src.slice(i, i + 400),
      /browserOutputRoot/,
      '第 12 片讓審查者「自己開瀏覽器看畫面」，但 server 從來沒被掛上——'
      + '工具名在清單裡、實際叫不動，而放行書填「沒看」完全合法，閘門照樣綠燈',
    );
    assert.match(readFileSync('src/worker/reviewer.ts', 'utf8'), /createGitInspectServer/);
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
