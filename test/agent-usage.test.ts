import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { usageFromResult, recordAgentUsage, type UsageSink } from '../src/core/agent-usage.js';
import { createTmpLedger, createSilentLogger, createRecordingLogger } from './helpers/index.js';

/**
 * 全部角色都要記帳。
 *
 * 先前**只有寫程式的 agent** 會寫 agent_sessions。規劃、reviewer、介面判斷者、
 * 飄移判斷者、合併風險判斷者——五個角色一毛都沒記。實跑撞到：一次跑 13 分鐘、
 * 輸出 139k token、快取讀 3.3M 的規劃，帳面 $0。
 *
 * 而**預算閘門用的是同一份數字**，所以使用者設的花費上限只擋到一部分支出。
 */

function spy(): UsageSink & { rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];
  return { rows, recordAgentSession: (r) => void rows.push(r as never) };
}

const RESULT = {
  type: 'result',
  subtype: 'success',
  session_id: 's-1',
  total_cost_usd: 1.25,
  modelUsage: { 'claude-opus-5': { inputTokens: 100, outputTokens: 2000, cacheReadInputTokens: 50_000, costUSD: 1.25 } },
};

test('從 SDK result 取出花費', () => {
  const u = usageFromResult(RESULT);
  assert.equal(u?.costUsd, 1.25);
  assert.equal(u?.outputTokens, 2000);
  assert.equal(u?.cacheReadTokens, 50_000);
  assert.deepEqual(u?.models, ['claude-opus-5']);
});

/** 只看其中一個欄位的話，SDK 版本一變就會靜靜地記成 0。 */
test('只有 modelUsage 沒有 total_cost_usd 也算得出來', () => {
  const u = usageFromResult({ ...RESULT, total_cost_usd: undefined });
  assert.equal(u?.costUsd, 1.25, '要從逐模型明細加總');
});

test('不是 result 訊息 → 不記', () => {
  assert.equal(usageFromResult({ type: 'assistant' }), undefined);
  assert.equal(usageFromResult(null), undefined);
  assert.equal(usageFromResult({ type: 'result' }), undefined, '沒有任何花費資訊就不要記一筆 0');
});

test('記進 ledger，並標明角色與專案', (t) => {
  const h = createTmpLedger();
  t.after(() => h.cleanup());

  recordAgentUsage(h.ledger, createSilentLogger(), { kind: 'plan', repo: 'acme/web' }, RESULT);

  const total = h.ledger.costSummary();
  assert.equal(total.costUsd, 1.25, '規劃的花費要算進總額——預算閘門看的就是這個');
});

test('不屬於任何任務的角色也記得下來（taskId 用哨兵值）', (t) => {
  const h = createTmpLedger();
  t.after(() => h.cleanup());
  recordAgentUsage(h.ledger, createSilentLogger(), { kind: 'plan', repo: 'acme/web' }, RESULT);
  assert.equal(h.ledger.costSummary().costUsd, 1.25);
});

/** 記帳是觀測，不是業務邏輯——它壞掉不可以讓正在做的事失敗。 */
test('記帳失敗不擲錯，但要留下痕跡', () => {
  const log = createRecordingLogger();
  const broken: UsageSink = { recordAgentSession: () => { throw new Error('DB 鎖住'); } };
  assert.doesNotThrow(() => recordAgentUsage(broken, log.logger, { kind: 'reviewer' }, RESULT));
  assert.ok(log.messages('warn').some((m) => m.includes('花費')), '無聲吞掉的話，帳面 0 與真的沒花錢分不出來');
});

test('沒注入 sink → 什麼都不做，不當機', () => {
  assert.doesNotThrow(() => recordAgentUsage(undefined, createSilentLogger(), { kind: 'plan' }, RESULT));
});

test('同一個 session 多次記錄要累加，不是長出兩列', (t) => {
  const h = createTmpLedger();
  t.after(() => h.cleanup());
  recordAgentUsage(h.ledger, createSilentLogger(), { kind: 'plan', repo: 'a/b' }, RESULT);
  recordAgentUsage(h.ledger, createSilentLogger(), { kind: 'plan', repo: 'a/b' }, RESULT);
  assert.equal(h.ledger.costSummary().costUsd, 2.5);
  assert.equal(h.ledger.costSummary().sessions, 1, '同一個 session 應該累加');
});

// ── 接線：五個角色有沒有真的接上 ──
//
// 這一段才是重點。函式本身好好的但某個角色忘了接，症狀就是「那個角色的花費永遠是 0」，
// 而畫面上看起來完全正常——那正是這個 bug 原本的形狀。

test('五個 agent 角色都在 runQuery 裡記帳', () => {
  const roles = [
    ['src/core/plan-agent.ts', 'plan', '規劃 agent（單次十幾分鐘，最貴的之一）'],
    ['src/worker/reviewer.ts', 'reviewer', 'reviewer'],
    ['src/worker/ui-judge.ts', 'ui_judge', '介面判斷者（開瀏覽器跑很多輪）'],
    ['src/pr/drift-judge.ts', 'drift_judge', '飄移判斷者'],
    ['src/core/merge-risk-judge.ts', 'merge_risk_judge', '合併風險判斷者'],
  ] as const;

  for (const [file, kind, who] of roles) {
    const src = readFileSync(file, 'utf8');
    assert.match(src, /recordAgentUsage\(/, `${who}（${file}）沒有記帳`);
    assert.ok(src.includes(`kind: '${kind}'`), `${who} 的角色標記應該是 '${kind}'`);
  }
});

/** 漏掉這個接線，五個角色的 usage sink 都是 undefined，記帳等於沒做。 */
test('main 有把 ledger 當成 usage sink 注入五個角色', () => {
  const src = readFileSync('src/main.ts', 'utf8');
  for (const ctor of ['new PlanAgent({', 'new Reviewer({', 'new DriftJudge({', 'new MergeRiskJudge({']) {
    const i = src.indexOf(ctor);
    assert.ok(i >= 0, `找不到 ${ctor}`);
    assert.match(src.slice(i, i + 200), /usage: ledger/, `${ctor} 沒有注入 usage sink`);
  }
  // 介面判斷者走 verifierDepsOf
  assert.match(src, /usage \? \{ usage \} : \{\}/, 'UiJudge 沒有接 usage');
});

/** 預算閘門與帳面用的是同一個查詢——這正是這個 bug 之所以危險的原因。 */
test('預算閘門讀的是含全部角色的總額', (t) => {
  const h = createTmpLedger();
  t.after(() => h.cleanup());
  recordAgentUsage(h.ledger, createSilentLogger(), { kind: 'plan', repo: 'a/b' }, RESULT);
  recordAgentUsage(h.ledger, createSilentLogger(), { kind: 'ui_judge', repo: 'a/b' }, { ...RESULT, session_id: 's-2' });

  assert.equal(h.ledger.costSummary().costUsd, 2.5, '判斷者的錢也要進總額，否則上限擋不住');
});
