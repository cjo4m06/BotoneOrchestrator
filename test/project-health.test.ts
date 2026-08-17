import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ProjectHealthTracker,
  reportProjectHealth,
  PROJECT_DOWN_KIND,
  PROJECT_DOWN_MIN_FAILURES,
  PROJECT_DOWN_GRACE_MS,
} from '../src/core/project-health.js';
import { createSilentLogger, createTmpLedger } from './helpers/index.js';

/**
 * 專案連不上（MCP 掛了、token 過期、repo 沒有 remote）時，orchestrator 只會
 * warnOnce 然後把該專案的 ready 群組整批靜默過濾掉——群組停在 ready、任務停在 queued，
 * 而控制台對 enabled 的專案一律印綠色「啟用中」。**連不上的和健康的長得一模一樣。**
 */
describe('專案健康度：連不上要看得見', () => {
  const F = { repo: 'acme/web', reason: 'MCP 連線失敗：ECONNREFUSED', fix: '到控制台按測試連線' };

  it('抖動不吵：次數或時間任一不足都不算壞掉', () => {
    const t = new ProjectHealthTracker();
    const t0 = 1_000_000;
    t.fail(F, t0);
    assert.deepEqual(t.blocked(t0 + PROJECT_DOWN_GRACE_MS + 1), [], '只失敗一次 → 不吵');

    const t2 = new ProjectHealthTracker();
    for (let i = 0; i < PROJECT_DOWN_MIN_FAILURES; i += 1) t2.fail(F, t0);
    assert.deepEqual(t2.blocked(t0 + 1), [], '次數夠但時間不夠 → 還在等它自己好');
  });

  it('兩個條件同時成立才算壞掉', () => {
    const t = new ProjectHealthTracker();
    const t0 = 1_000_000;
    for (let i = 0; i < PROJECT_DOWN_MIN_FAILURES; i += 1) t.fail(F, t0 + i);
    const bad = t.blocked(t0 + PROJECT_DOWN_GRACE_MS + 1);
    assert.equal(bad.length, 1);
    assert.equal(bad[0]!.repo, 'acme/web');
    assert.equal(bad[0]!.failures, PROJECT_DOWN_MIN_FAILURES);
  });

  it('成功一次就清零——修好了要收得掉那張單', () => {
    const t = new ProjectHealthTracker();
    const t0 = 1_000_000;
    for (let i = 0; i < PROJECT_DOWN_MIN_FAILURES; i += 1) t.fail(F, t0);
    t.ok('acme/web');
    assert.deepEqual(t.blocked(t0 + PROJECT_DOWN_GRACE_MS + 1), []);
  });

  it('開單：講出原因與怎麼修，而且沒有按鈕（解法不在這個系統裡）', () => {
    const tmp = createTmpLedger();
    try {
      const now = 2_000_000;
      reportProjectHealth({
        ledger: tmp.ledger, log: createSilentLogger(), now,
        downs: [{ ...F, since: now - PROJECT_DOWN_GRACE_MS * 2, failures: 5, lastAt: now }],
      });
      const hs = tmp.ledger.listHandoffs({ toRole: 'human', kind: PROJECT_DOWN_KIND, unconsumedOnly: true });
      assert.equal(hs.length, 1);
      assert.equal(hs[0]!.repo, 'acme/web', '要掛在專案上——那種問題不屬於任何群組或任務');
      assert.match(hs[0]!.body, /ECONNREFUSED/);
      assert.match(hs[0]!.body, /怎麼修/);
      assert.deepEqual(hs[0]!.options, [], '按什麼都沒用就不要給按鈕');
    } finally { tmp.cleanup(); }
  });

  it('同一個專案不會每輪長一張', () => {
    const tmp = createTmpLedger();
    try {
      const now = 2_000_000;
      const downs = [{ ...F, since: now - PROJECT_DOWN_GRACE_MS * 2, failures: 5, lastAt: now }];
      reportProjectHealth({ ledger: tmp.ledger, log: createSilentLogger(), now, downs });
      reportProjectHealth({ ledger: tmp.ledger, log: createSilentLogger(), now: now + 1000, downs });
      assert.equal(tmp.ledger.listHandoffs({ toRole: 'human', kind: PROJECT_DOWN_KIND, unconsumedOnly: true }).length, 1);
    } finally { tmp.cleanup(); }
  });

  /**
   * 收單用對帳（拿現在的清單比 DB），不是記憶體差集——那會漏掉
   * 「daemon 停著時人在獨立行程的控制台把專案停用／刪掉」。
   */
  it('恢復／停用／刪除 → 那張單自己收掉', () => {
    const tmp = createTmpLedger();
    try {
      const now = 2_000_000;
      reportProjectHealth({
        ledger: tmp.ledger, log: createSilentLogger(), now,
        downs: [{ ...F, since: now - PROJECT_DOWN_GRACE_MS * 2, failures: 5, lastAt: now }],
      });
      reportProjectHealth({ ledger: tmp.ledger, log: createSilentLogger(), now: now + 1000, downs: [] });
      assert.equal(tmp.ledger.listHandoffs({ toRole: 'human', kind: PROJECT_DOWN_KIND, unconsumedOnly: true }).length, 0);
    } finally { tmp.cleanup(); }
  });

  it('「沒有 remote」的 fix 不可以是「去按測試連線」（那顆只測 MCP，按了會綠）', () => {
    const src = readFileSync('src/main.ts', 'utf8');
    const i = src.indexOf('本地 repo 沒有 remote「');   // health.fail 那一格的 reason
    assert.ok(i > 0, '找不到 no-remote 的回報點');
    const block = src.slice(i, i + 600);
    assert.match(block, /git remote add origin/, '要講出真正做得到的那一步');
    assert.doesNotMatch(block, /按「測試連線」/, '那顆只測 MCP，按了會拿到綠燈、問題還在');
  });
});

describe('Poller 要餵健康度（registry 看不到的那一半）', () => {
  /**
   * registry 指紋沒變就不會重建 runtime，所以「跑三天後 MCP 掛掉／token 過期／
   * 任務板改權限」registry 一次都不會觸發。那一半只有 Poller 看得到。
   */
  it('listTasks 失敗 → 餵給 tracker，不只是 log', async () => {
    const { Poller } = await import('../src/core/poller.js');
    const tmp = createTmpLedger();
    try {
      const fails: string[] = [];
      const health = { fail: (f: { repo: string }) => void fails.push(f.repo), ok: () => {} };
      const client = {
        async listTasks() { throw new Error('ECONNREFUSED'); },
        async getTask() { throw new Error('unused'); },
      } as never;
      const poller = new Poller([{ client, repo: 'acme/web', mine: false }], tmp.ledger, createSilentLogger(), health);

      await poller.pollOnce();

      assert.deepEqual(fails, ['acme/web'], '任務板連不上一定要餵進計數器');
    } finally { tmp.cleanup(); }
  });

  it('listTasks 成功 → 標回健康（否則修好之後那張單收不掉）', async () => {
    const { Poller } = await import('../src/core/poller.js');
    const tmp = createTmpLedger();
    try {
      const oks: string[] = [];
      const health = { fail: () => {}, ok: (repo: string) => void oks.push(repo) };
      const client = { async listTasks() { return []; }, async getTask() { throw new Error('unused'); } } as never;
      const poller = new Poller([{ client, repo: 'acme/web', mine: false }], tmp.ledger, createSilentLogger(), health);

      await poller.pollOnce();

      assert.deepEqual(oks, ['acme/web']);
    } finally { tmp.cleanup(); }
  });
});
