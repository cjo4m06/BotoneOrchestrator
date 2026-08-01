// retry.ts 測試：全程假時鐘，不真的等待。
// 執行：npx tsx --test test/retry.test.ts

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CircuitBreaker,
  RetryError,
  classifyError,
  classifyHttpStatus,
  computeBackoffDelay,
  withRetry,
  withRetryOut,
  withRetryResult,
  type RetryOptions,
} from '../src/core/retry.js';
import type { McpOut } from '../src/types.js';

/** 假時鐘：sleep 不等待，只記錄毫秒數並推進虛擬時間。 */
class FakeClock {
  private t = 0;
  readonly slept: number[] = [];
  now = (): number => this.t;
  sleep = async (ms: number): Promise<void> => {
    this.slept.push(ms);
    this.t += ms;
  };
  advance(ms: number): void {
    this.t += ms;
  }
}

/** 產生帶 HTTP 狀態碼的錯誤（模擬 fetch/octokit 例外）。 */
function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** 依序丟出指定錯誤，用完後回傳 value。 */
function failThen<T>(errors: unknown[], value: T): (attempt: number) => Promise<T> {
  let i = 0;
  return async () => {
    if (i < errors.length) throw errors[i++];
    return value;
  };
}

/** 測試預設：random 固定 0.5 → jitter 剛好抵銷，退避等於理論值。 */
function baseOpts(clock: FakeClock, extra: RetryOptions = {}): RetryOptions {
  return { sleep: clock.sleep, now: clock.now, random: () => 0.5, baseDelayMs: 100, factor: 2, ...extra };
}

describe('錯誤三分類', () => {
  test('transient 狀態碼', () => {
    for (const s of [408, 429, 500, 502, 503, 504, 529]) {
      assert.equal(classifyHttpStatus(s), 'transient', `${s} 應為 transient`);
    }
  });

  test('permanent 狀態碼', () => {
    for (const s of [400, 401, 403, 404, 422]) {
      assert.equal(classifyHttpStatus(s), 'permanent', `${s} 應為 permanent`);
    }
  });

  test('從例外物件的 status / response.status 取碼', () => {
    assert.equal(classifyError(httpError(503)).kind, 'transient');
    assert.equal(classifyError(httpError(401)).kind, 'permanent');
    assert.equal(classifyError({ response: { status: 429 } }).kind, 'transient');
    assert.equal(classifyError(httpError(500)).status, 500);
  });

  test('MCP client 只有訊息時，從文字撈狀態碼', () => {
    assert.equal(classifyError(new Error('請求失敗 429 Too Many Requests')).kind, 'transient');
    assert.equal(classifyError(new Error('403 Forbidden')).kind, 'permanent');
  });

  test('網路錯誤碼與逾時字樣 → transient', () => {
    assert.equal(classifyError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).kind, 'transient');
    assert.equal(classifyError(Object.assign(new Error('x'), { code: 'ECONNRESET' })).kind, 'transient');
    assert.equal(classifyError(new Error('socket hang up')).kind, 'transient');
    assert.equal(classifyError(new Error('request timed out')).kind, 'transient');
  });

  test('顯式 kind 欄位（McpError / McpOut）優先', () => {
    assert.equal(classifyError({ kind: 'signal', message: '依賴未完' }).kind, 'signal');
    assert.equal(classifyError(Object.assign(new Error('依賴未完'), { kind: 'signal', status: 500 })).kind, 'signal');
  });

  test('程式 bug 類例外不重試', () => {
    assert.equal(classifyError(new TypeError('x is not a function')).kind, 'permanent');
  });

  test('無從判斷時預設 transient（沿用 mcp-client 的保守做法）', () => {
    assert.equal(classifyError(new Error('???')).kind, 'transient');
  });
});

describe('退避序列', () => {
  test('random=0.5 時等於指數理論值', () => {
    const o = { baseDelayMs: 100, factor: 2, random: () => 0.5 };
    assert.deepEqual([1, 2, 3, 4].map((i) => computeBackoffDelay(i, o)), [100, 200, 400, 800]);
  });

  test('maxDelayMs 夾住上限', () => {
    const o = { baseDelayMs: 1000, factor: 10, maxDelayMs: 5000, random: () => 0.5 };
    assert.deepEqual([1, 2, 3, 4].map((i) => computeBackoffDelay(i, o)), [1000, 5000, 5000, 5000]);
  });

  test('jitter 讓延遲落在 ±20% 區間', () => {
    const o = { baseDelayMs: 1000, jitter: 0.2 };
    assert.equal(computeBackoffDelay(1, { ...o, random: () => 0 }), 800);
    assert.equal(computeBackoffDelay(1, { ...o, random: () => 1 }), 1200);
    assert.equal(computeBackoffDelay(1, { ...o, random: () => 0.5 }), 1000);
  });

  test('jitter=0 時完全決定性', () => {
    assert.equal(computeBackoffDelay(2, { baseDelayMs: 300, factor: 3, jitter: 0, random: () => 0.9 }), 900);
  });
});

describe('withRetry', () => {
  test('transient 失敗兩次後成功：退避序列 100/200，不真的等待', async () => {
    const clock = new FakeClock();
    const r = await withRetryResult(failThen([httpError(503), httpError(502)], 'ok'), baseOpts(clock));
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value, 'ok');
    assert.equal(r.attempts, 3);
    assert.deepEqual(clock.slept, [100, 200]);
  });

  test('permanent 立即回傳、完全不退避', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const r = await withRetryResult(async () => {
      calls += 1;
      throw httpError(401);
    }, baseOpts(clock));
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.kind, 'permanent');
    assert.equal(!r.ok && r.reason, 'non_retryable');
    assert.equal(calls, 1);
    assert.deepEqual(clock.slept, []);
  });

  test('signal 立即回傳（照做而非重試）', async () => {
    const clock = new FakeClock();
    const r = await withRetryResult(async () => {
      throw Object.assign(new Error('依賴未完成'), { kind: 'signal' });
    }, baseOpts(clock));
    assert.equal(!r.ok && r.kind, 'signal');
    assert.equal(!r.ok && r.reason, 'non_retryable');
    assert.deepEqual(clock.slept, []);
  });

  test('用完次數 → attempts_exhausted，退避次數 = attempts-1', async () => {
    const clock = new FakeClock();
    const r = await withRetryResult(async () => {
      throw httpError(500);
    }, baseOpts(clock, { attempts: 4 }));
    assert.equal(!r.ok && r.reason, 'attempts_exhausted');
    assert.equal(r.attempts, 4);
    assert.deepEqual(clock.slept, [100, 200, 400]);
  });

  test('maxTotalMs 到期提早放棄', async () => {
    const clock = new FakeClock();
    const r = await withRetryResult(async () => {
      throw httpError(503);
    }, baseOpts(clock, { attempts: 10, maxTotalMs: 350 }));
    // 100 + 200 = 300 已用掉；下一次要 400，超過 350 → 停
    assert.equal(!r.ok && r.reason, 'timeout');
    assert.deepEqual(clock.slept, [100, 200]);
  });

  test('AbortSignal 觸發後不再嘗試', async () => {
    const clock = new FakeClock();
    const ac = new AbortController();
    let calls = 0;
    const r = await withRetryResult(async () => {
      calls += 1;
      ac.abort();
      throw httpError(503);
    }, baseOpts(clock, { abort: ac.signal, attempts: 5 }));
    assert.equal(!r.ok && r.reason, 'aborted');
    assert.equal(calls, 1);
  });

  test('onRetry 回報每次退避資訊', async () => {
    const clock = new FakeClock();
    const seen: number[] = [];
    await withRetryResult(failThen([httpError(503), httpError(503)], 1), baseOpts(clock, {
      label: 'mcp.startTask',
      onRetry: (i) => seen.push(i.delayMs),
    }));
    assert.deepEqual(seen, [100, 200]);
  });

  test('withRetry 失敗時擲 RetryError 並保留 kind/cause', async () => {
    const clock = new FakeClock();
    const boom = httpError(400);
    await assert.rejects(
      () => withRetry(async () => { throw boom; }, baseOpts(clock, { label: 'gh.createPr' })),
      (e: unknown) => {
        assert.ok(e instanceof RetryError);
        assert.equal(e.kind, 'permanent');
        assert.equal(e.reason, 'non_retryable');
        assert.equal(e.cause, boom);
        return true;
      },
    );
  });

  test('attempts=1 等同不重試', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const r = await withRetryResult(async () => { calls += 1; throw httpError(500); }, baseOpts(clock, { attempts: 1 }));
    assert.equal(calls, 1);
    assert.equal(!r.ok && r.reason, 'attempts_exhausted');
    assert.deepEqual(clock.slept, []);
  });
});

describe('withRetryOut（McpOut 介面）', () => {
  test('transient 重試後成功', async () => {
    const clock = new FakeClock();
    let n = 0;
    const out = await withRetryOut<string>(async (): Promise<McpOut<string>> => {
      n += 1;
      return n < 3 ? { ok: false, kind: 'transient', detail: '503' } : { ok: true, value: 'done' };
    }, baseOpts(clock));
    assert.deepEqual(out, { ok: true, value: 'done' });
    assert.deepEqual(clock.slept, [100, 200]);
  });

  test('signal 原樣回傳，不重試（讓 Worker 去 park）', async () => {
    const clock = new FakeClock();
    let n = 0;
    const out = await withRetryOut<string>(async (): Promise<McpOut<string>> => {
      n += 1;
      return { ok: false, kind: 'signal', detail: '依賴未完成' };
    }, baseOpts(clock));
    assert.deepEqual(out, { ok: false, kind: 'signal', detail: '依賴未完成' });
    assert.equal(n, 1);
    assert.deepEqual(clock.slept, []);
  });
});

describe('CircuitBreaker', () => {
  test('連續失敗達門檻 → open', () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker('mcp', { failureThreshold: 3, cooldownMs: 1000, now: clock.now });
    assert.equal(cb.state, 'closed');
    cb.onFailure('a');
    cb.onFailure('b');
    assert.equal(cb.state, 'closed');
    assert.equal(cb.canPass(), true);
    cb.onFailure('c');
    assert.equal(cb.state, 'open');
    assert.equal(cb.canPass(), false);
  });

  test('中途成功會清掉連續失敗計數', () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker('mcp', { failureThreshold: 3, now: clock.now });
    cb.onFailure();
    cb.onFailure();
    cb.onSuccess();
    cb.onFailure();
    cb.onFailure();
    assert.equal(cb.state, 'closed');
  });

  test('冷卻到期 → half_open，試探成功 → closed', () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker('mcp', { failureThreshold: 2, cooldownMs: 1000, now: clock.now });
    cb.onFailure('x');
    cb.onFailure('x');
    assert.equal(cb.state, 'open');

    clock.advance(999);
    assert.equal(cb.canPass(), false, '冷卻未到不放行');

    clock.advance(1);
    assert.equal(cb.state, 'half_open');
    assert.equal(cb.canPass(), true, '冷卻到期放行一個試探');
    cb.onSuccess();
    assert.equal(cb.state, 'closed');
    assert.equal(cb.snapshot().consecutiveFailures, 0);
  });

  test('half_open 期間只放行設定數量的試探', () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker('mcp', { failureThreshold: 1, cooldownMs: 100, halfOpenMaxProbes: 1, now: clock.now });
    cb.onFailure('x');
    clock.advance(100);
    assert.equal(cb.canPass(), true);
    assert.equal(cb.canPass(), false, '第二個試探要被擋下');
  });

  test('試探失敗 → 回 open 並重新計冷卻', () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker('mcp', { failureThreshold: 1, cooldownMs: 100, now: clock.now });
    cb.onFailure('x');
    clock.advance(100);
    assert.equal(cb.canPass(), true);
    cb.onFailure('again');
    assert.equal(cb.state, 'open');
    assert.equal(cb.snapshot().nextProbeAt, clock.now() + 100);
    assert.equal(cb.canPass(), false);
    clock.advance(100);
    assert.equal(cb.state, 'half_open');
  });

  test('successThreshold > 1 需連續成功才 close', () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker('mcp', { failureThreshold: 1, cooldownMs: 10, successThreshold: 2, halfOpenMaxProbes: 2, now: clock.now });
    cb.onFailure('x');
    clock.advance(10);
    assert.equal(cb.canPass(), true);
    cb.onSuccess();
    assert.equal(cb.state, 'half_open');
    assert.equal(cb.canPass(), true);
    cb.onSuccess();
    assert.equal(cb.state, 'closed');
  });

  test('snapshot 供 log/dashboard 查詢', () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker('github', { failureThreshold: 1, cooldownMs: 500, now: clock.now });
    cb.onFailure('502 bad gateway');
    const s = cb.snapshot();
    assert.equal(s.name, 'github');
    assert.equal(s.state, 'open');
    assert.equal(s.lastError, '502 bad gateway');
    assert.equal(s.nextProbeAt, 500);
  });

  test('reset 手動歸零', () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker('mcp', { failureThreshold: 1, cooldownMs: 1000, now: clock.now });
    cb.onFailure('x');
    assert.equal(cb.state, 'open');
    cb.reset();
    assert.equal(cb.state, 'closed');
    assert.equal(cb.canPass(), true);
  });

  test('onStateChange 通知（供 Slack/dashboard）', () => {
    const clock = new FakeClock();
    const seen: string[] = [];
    const cb = new CircuitBreaker('mcp', {
      failureThreshold: 1, cooldownMs: 10, now: clock.now,
      onStateChange: (from, to) => seen.push(`${from}->${to}`),
    });
    cb.onFailure('x');
    clock.advance(10);
    cb.canPass();
    cb.onSuccess();
    assert.deepEqual(seen, ['closed->open', 'open->half_open', 'half_open->closed']);
  });
});

describe('withRetry × CircuitBreaker', () => {
  test('熔斷開啟後直接擋下呼叫，不送出', async () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker('mcp', { failureThreshold: 2, cooldownMs: 1000, now: clock.now });
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls += 1;
      throw httpError(503);
    };

    const first = await withRetryResult(fn, baseOpts(clock, { attempts: 2, breaker: cb }));
    assert.equal(!first.ok && first.reason, 'attempts_exhausted');
    assert.equal(calls, 2);
    assert.equal(cb.state, 'open');

    const second = await withRetryResult(fn, baseOpts(clock, { attempts: 2, breaker: cb }));
    assert.equal(!second.ok && second.reason, 'circuit_open');
    assert.equal(calls, 2, '熔斷後不應再送出請求');
  });

  test('permanent 不算熔斷器故障（對方有回應）', async () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker('mcp', { failureThreshold: 2, now: clock.now });
    for (let i = 0; i < 5; i++) {
      await withRetryResult(async () => { throw httpError(400); }, baseOpts(clock, { breaker: cb }));
    }
    assert.equal(cb.state, 'closed');
  });

  test('冷卻後試探成功 → 熔斷關閉且呼叫恢復', async () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker('mcp', { failureThreshold: 1, cooldownMs: 1000, now: clock.now });
    await withRetryResult(async () => { throw httpError(503); }, baseOpts(clock, { attempts: 1, breaker: cb }));
    assert.equal(cb.state, 'open');

    clock.advance(1000);
    const r = await withRetryResult(async () => 'back', baseOpts(clock, { breaker: cb }));
    assert.equal(r.ok && r.value, 'back');
    assert.equal(cb.state, 'closed');
  });
});
