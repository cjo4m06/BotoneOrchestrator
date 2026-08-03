import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Reviewer,
  buildReviewPrompt,
  hasClaudeAuth,
  parseReviewResponse,
  reviewGateReport,
  toReviewOutcome,
  truncateDiff,
  type ReviewQueryFn,
} from '../src/worker/reviewer.js';
import { evaluateStopHook } from '../src/worker/agent-runtime.js';
import type { LoadedDoc } from '../src/worker/agent-runtime.js';
import type { ReviewerLike } from '../src/contracts.js';
import type { Logger } from '../src/observability/logger.js';
import type { TaskDetail } from '../src/types.js';

/** 任務起點 sha：reviewer 與 DoD 用的是同一枚，不是會動的 'HEAD'。 */
const BASE = 'a'.repeat(40);

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

const task: TaskDetail = {
  id: 'T-1',
  title: '登入表單驗證',
  status: 'in_progress',
  repo: 'acme/web',
  description: '表單需驗證 email 格式與密碼長度',
  dependencies: [],
  docRefs: ['spec/login.md#驗證'],
  category: 'dev',
};
const docs: LoadedDoc[] = [{ ref: 'spec/login.md#驗證', content: 'email 必須驗證格式；密碼至少 8 碼。' }];
const DIFF = 'diff --git a/src/login.ts b/src/login.ts\n+const ok = true;\n';

/** 產生一個假的 SDK query：吐出 result 訊息。 */
function fakeQuery(resultText: string, subtype = 'success'): ReviewQueryFn {
  return async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's1' };
    yield { type: 'result', subtype, result: resultText, session_id: 's1' };
  };
}

describe('buildReviewPrompt', () => {
  it('包含任務、規格逐段與 diff', () => {
    const p = buildReviewPrompt(task, docs, DIFF);
    assert.match(p, /T-1/);
    assert.match(p, /登入表單驗證/);
    assert.match(p, /spec\/login\.md#驗證/);
    assert.match(p, /密碼至少 8 碼/);
    assert.match(p, /```diff/);
    assert.match(p, /const ok = true/);
  });

  it('要求輸出 JSON 判定格式', () => {
    const p = buildReviewPrompt(task, docs, DIFF);
    assert.match(p, /"status"/);
    assert.match(p, /violations/);
  });
});

describe('parseReviewResponse', () => {
  it('解析 ```json 圍欄內的 pass', () => {
    const v = parseReviewResponse('看完了。\n```json\n{"status":"pass","notes":["都有做到"],"violations":[]}\n```');
    assert.equal(v?.status, 'pass');
    assert.deepEqual(v?.status === 'pass' ? v.notes : [], ['都有做到']);
  });

  it('解析裸 JSON 的 fail 與違規細節', () => {
    const v = parseReviewResponse(
      '{"status":"fail","violations":[{"docRef":"spec/login.md#驗證","requirement":"密碼至少 8 碼","problem":"沒有長度檢查","suggestion":"加上 length >= 8"}]}',
    );
    assert.equal(v?.status, 'fail');
    if (v?.status !== 'fail') return;
    assert.equal(v.violations.length, 1);
    assert.equal(v.violations[0]!.docRef, 'spec/login.md#驗證');
    assert.equal(v.violations[0]!.suggestion, '加上 length >= 8');
  });

  it('容忍 JSON 前後夾雜說明文字', () => {
    const v = parseReviewResponse('結論如下：\n{"status":"pass","violations":[]}\n以上。');
    assert.equal(v?.status, 'pass');
  });

  it('說 pass 卻列了違規 → 以違規為準判 fail', () => {
    const v = parseReviewResponse('{"status":"pass","violations":[{"requirement":"A","problem":"缺 A"}]}');
    assert.equal(v?.status, 'fail');
  });

  it('說 fail 卻沒給理由 → 補一條泛用理由', () => {
    const v = parseReviewResponse('{"status":"fail","violations":[]}');
    assert.equal(v?.status, 'fail');
    if (v?.status !== 'fail') return;
    assert.equal(v.violations.length, 1);
  });

  it('容忍字串形式的違規項', () => {
    const v = parseReviewResponse('{"status":"fail","violations":["沒做密碼長度檢查"]}');
    if (v?.status !== 'fail') return assert.fail('應為 fail');
    assert.equal(v.violations[0]!.requirement, '沒做密碼長度檢查');
  });

  it('無法解析時回 null', () => {
    assert.equal(parseReviewResponse('我覺得還行吧'), null);
    assert.equal(parseReviewResponse('{壞掉的 json'), null);
    assert.equal(parseReviewResponse('{"foo":1}'), null);
  });
});

describe('reviewGateReport / toReviewOutcome', () => {
  it('fail → 非綠燈，違規進 detail 與 failingIds', () => {
    const g = reviewGateReport({
      status: 'fail',
      violations: [{ docRef: 'spec/login.md', requirement: '密碼至少 8 碼', problem: '沒檢查', suggestion: '加檢查' }],
    });
    assert.equal(g.green, false);
    assert.equal(g.checks[0]!.name, 'reviewer');
    assert.match(g.checks[0]!.detail, /密碼至少 8 碼/);
    assert.match(g.checks[0]!.detail, /加檢查/);
    assert.deepEqual(g.checks[0]!.failingIds, ['密碼至少 8 碼']);
  });

  it('pass / skipped → 綠燈', () => {
    assert.equal(reviewGateReport({ status: 'pass', notes: [] }).green, true);
    assert.equal(reviewGateReport({ status: 'skipped', reason: '無金鑰' }).green, true);
  });

  it('同一批違規簽章穩定、不同批不同（供無進展偵測）', () => {
    const a = reviewGateReport({ status: 'fail', violations: [{ requirement: 'A', problem: 'x' }] });
    const b = reviewGateReport({ status: 'fail', violations: [{ requirement: 'A', problem: 'y' }] });
    const c = reviewGateReport({ status: 'fail', violations: [{ requirement: 'B', problem: 'x' }] });
    assert.equal(a.signature, b.signature);
    assert.notEqual(a.signature, c.signature);
  });

  it('ok 語意：只有 fail 會擋', () => {
    assert.equal(toReviewOutcome({ status: 'pass', notes: [] }).ok, true);
    assert.equal(toReviewOutcome({ status: 'skipped', reason: 'r' }).ok, true);
    assert.equal(toReviewOutcome({ status: 'fail', violations: [] }).ok, false);
  });
});

describe('truncateDiff', () => {
  it('短 diff 原樣返回', () => {
    assert.equal(truncateDiff('abc', 100), 'abc');
  });
  it('長 diff 保留頭尾並標註省略', () => {
    const out = truncateDiff('x'.repeat(1000), 100);
    assert.ok(out.length < 400);
    assert.match(out, /diff 過長/);
  });
});

describe('hasClaudeAuth', () => {
  it('依環境變數判斷', () => {
    assert.equal(hasClaudeAuth({} as NodeJS.ProcessEnv), false);
    assert.equal(hasClaudeAuth({ ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv), true);
    assert.equal(hasClaudeAuth({ ANTHROPIC_AUTH_TOKEN: 't' } as NodeJS.ProcessEnv), true);
  });
});

describe('Reviewer.check', () => {
  const base = { log, hasAuth: () => true, collectDiff: async () => DIFF };

  it('無金鑰 → skipped（不炸、不擋）', async () => {
    const r = new Reviewer({ log, hasAuth: () => false, queryFn: fakeQuery('{"status":"fail","violations":[]}') });
    const out = await r.check(task, docs, '/wt', { baseRef: BASE });
    assert.equal(out.verdict.status, 'skipped');
    assert.equal(out.ok, true);
    assert.equal(out.asGateReport().green, true);
  });

  it('沒有 docRefs 規格 → skipped', async () => {
    const r = new Reviewer({ ...base, queryFn: fakeQuery('{"status":"pass","violations":[]}') });
    const out = await r.check(task, [], '/wt', { baseRef: BASE });
    assert.equal(out.verdict.status, 'skipped');
  });

  it('diff 為空 → 直接判 fail（不必問 agent）', async () => {
    let called = false;
    const r = new Reviewer({
      log,
      hasAuth: () => true,
      collectDiff: async () => '   ',
      queryFn: (args) => {
        called = true;
        return fakeQuery('')(args);
      },
    });
    const out = await r.check(task, docs, '/wt', { baseRef: BASE });
    assert.equal(out.ok, false);
    assert.equal(called, false);
  });

  it('合格 → ok=true', async () => {
    const r = new Reviewer({ ...base, queryFn: fakeQuery('```json\n{"status":"pass","notes":["符合"],"violations":[]}\n```') });
    const out = await r.check(task, docs, '/wt', { baseRef: BASE });
    assert.equal(out.ok, true);
    assert.equal(out.verdict.status, 'pass');
  });

  it('不合格 → ok=false，asGateReport 可回灌具體理由', async () => {
    const r = new Reviewer({
      ...base,
      queryFn: fakeQuery('{"status":"fail","violations":[{"requirement":"密碼至少 8 碼","problem":"沒檢查"}]}'),
    });
    const out = await r.check(task, docs, '/wt', { baseRef: BASE });
    assert.equal(out.ok, false);
    const g = out.asGateReport();
    assert.equal(g.green, false);
    assert.match(g.checks[0]!.detail, /密碼至少 8 碼/);
  });

  it('prompt 有真的帶進 diff 與規格', async () => {
    let seen = '';
    const r = new Reviewer({
      ...base,
      queryFn: (args) => {
        seen = args.prompt;
        return fakeQuery('{"status":"pass","violations":[]}')(args);
      },
    });
    await r.check(task, docs, '/wt', { baseRef: BASE });
    assert.match(seen, /密碼至少 8 碼/);
    assert.match(seen, /const ok = true/);
  });

  it('SDK 拋錯 → skipped（不阻斷流水線）', async () => {
    const r = new Reviewer({
      ...base,
      queryFn: () => {
        throw new Error('network down');
      },
    });
    const out = await r.check(task, docs, '/wt', { baseRef: BASE });
    assert.equal(out.verdict.status, 'skipped');
    assert.equal(out.ok, true);
  });

  it('SDK 回錯誤結果 → skipped', async () => {
    const r = new Reviewer({ ...base, queryFn: fakeQuery('', 'error_max_turns') });
    const out = await r.check(task, docs, '/wt', { baseRef: BASE });
    assert.equal(out.verdict.status, 'skipped');
  });

  it('回應無法解析 → skipped（避免無限迴圈）', async () => {
    const r = new Reviewer({ ...base, queryFn: fakeQuery('嗯，看起來不錯') });
    const out = await r.check(task, docs, '/wt', { baseRef: BASE });
    assert.equal(out.verdict.status, 'skipped');
    assert.equal(out.ok, true);
  });

  it('取 diff 失敗 → skipped', async () => {
    const r = new Reviewer({
      log,
      hasAuth: () => true,
      collectDiff: async () => {
        throw new Error('not a repo');
      },
      queryFn: fakeQuery('{"status":"pass","violations":[]}'),
    });
    assert.equal((await r.check(task, docs, '/wt', { baseRef: BASE })).verdict.status, 'skipped');
  });

  it('opts.diff 可覆寫 collectDiff', async () => {
    let seen = '';
    const r = new Reviewer({
      log,
      hasAuth: () => true,
      collectDiff: async () => {
        throw new Error('不該被呼叫');
      },
      queryFn: (args) => {
        seen = args.prompt;
        return fakeQuery('{"status":"pass","violations":[]}')(args);
      },
    });
    const out = await r.check(task, docs, '/wt', { baseRef: BASE, diff: 'INLINE_DIFF_MARKER' });
    assert.equal(out.ok, true);
    assert.match(seen, /INLINE_DIFF_MARKER/);
  });
});

describe('Reviewer 與 Worker 的契約', () => {
  it('Reviewer 可直接當 ReviewerLike 注入 Worker（型別對得上就不會在整合處才爆）', async () => {
    const r: ReviewerLike = new Reviewer({ log, hasAuth: () => false });
    const out = await r.check(task, docs, '/wt', { baseRef: BASE });
    assert.equal(out.ok, true, '無金鑰時必須放行，不能擋住 Worker 的監督迴圈');
  });
});

describe('evaluateStopHook（Stop hook 純邏輯）', () => {
  const base = { workingTreeChanged: false, askedClarification: false, blocksSoFar: 0, maxBlocks: 2 };

  it('工作區零變更 → 擋下並給續做指示', () => {
    const d = evaluateStopHook(base);
    assert.equal(d.block, true);
    assert.match(d.reason ?? '', /沒有任何檔案變更/);
  });

  it('已有變更 → 放行（DoD 由外層判）', () => {
    assert.equal(evaluateStopHook({ ...base, workingTreeChanged: true }).block, false);
  });

  it('提出澄清而停 → 放行（park 是正當收工）', () => {
    assert.equal(evaluateStopHook({ ...base, askedClarification: true }).block, false);
  });

  it('擋滿上限後放行，避免活鎖', () => {
    assert.equal(evaluateStopHook({ ...base, blocksSoFar: 1 }).block, true);
    assert.equal(evaluateStopHook({ ...base, blocksSoFar: 2 }).block, false);
    assert.equal(evaluateStopHook({ ...base, blocksSoFar: 5 }).block, false);
  });

  it('stopHookActive 當計數下限（計數器歸零也不會無限重擋）', () => {
    assert.equal(evaluateStopHook({ ...base, blocksSoFar: 0, stopHookActive: true, maxBlocks: 1 }).block, false);
    assert.equal(evaluateStopHook({ ...base, blocksSoFar: 0, stopHookActive: true, maxBlocks: 2 }).block, true);
  });
});

// ── 人已經拍板的決定 ──

/**
 * reviewer 只看得到規格與 diff。規格寫「沒有定論」的地方，如果人已經透過 ask_human
 * 拍板了，reviewer 不知道——它會把一個已經解決的問題重新提出來、退回 agent，白費一輪。
 *
 * 實跑撞到：規格明寫「主題要不要一併重設沒有定論」，人回答了「不要」，agent 照做，
 * reviewer 卻退回說「你不該自行決定，應該先問需求方」。
 */
describe('reviewer 要知道人已經決定了什麼', () => {
  it('prompt 帶上已拍板的決定，並明講照做不算違規', () => {
    const p = buildReviewPrompt(
      task,
      [{ ref: 'spec/a.md', content: '主題要不要一併重設沒有定論' }],
      DIFF,
      [{ question: '重設要不要一併重設主題？', answer: '不要，那是跨頁面偏好' }],
    );
    assert.match(p, /已經拍板的決定/);
    assert.match(p, /重設要不要一併重設主題/);
    assert.match(p, /不要，那是跨頁面偏好/);
    assert.match(p, /不要因為「規格沒寫」或「規格說沒定論」而回報違規/);
  });

  it('沒有任何決定時不多印一段空的（別讓 prompt 出現沒內容的標題）', () => {
    const p = buildReviewPrompt(task, docs, DIFF, []);
    assert.equal(/已經拍板的決定/.test(p), false);
  });
});
