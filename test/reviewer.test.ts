import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Reviewer,
  buildReviewPrompt,
  hasClaudeAuth,
  parseReviewResponse,
  reviewGateReport,
  toReviewOutcome,
  type ReviewQueryFn,
} from '../src/worker/reviewer.js';
import { evaluateStopHook } from '../src/worker/agent-runtime.js';
import type { LoadedDoc } from '../src/worker/agent-runtime.js';
import type { ReviewerLike } from '../src/contracts.js';
import { makeTaskDetail } from './helpers/index.js';
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
  it('包含任務與規格逐段，但**不含 diff 內容**——只給比較基準', () => {
    const p = buildReviewPrompt(
      makeTaskDetail({ id: 'T-1', title: '深色模式' }),
      [{ ref: 'spec/a.md#§1', content: '要有切換開關' }],
      'abc123def',
    );

    assert.match(p, /深色模式/);
    assert.match(p, /要有切換開關/, '規格是程式從任務板讀的，照樣給');
    assert.match(p, /比較基準：`abc123def`/);
    assert.match(p, /git_changed_files/, '要告訴它怎麼自己查');
    assert.doesNotMatch(p, /```diff/, '程式先算好再砍一半的 diff 已經不給了');
  });

  it('要求輸出 JSON 判定格式', () => {
    const p = buildReviewPrompt(task, docs, DIFF);
    assert.match(p, /"status"/);
    assert.match(p, /violations/);
  });
});

describe('parseReviewResponse', () => {
  it('解析 ```json 圍欄內的 pass', () => {
    const v = parseReviewResponse('看完了。\n```json\n{"status":"pass","uiChecked":{"looked":false,"detail":"沒看：這次只改 server 端邏輯"},"notes":["都有做到"],"violations":[]}\n```');
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
    const v = parseReviewResponse('結論如下：\n{"status":"pass","uiChecked":{"looked":false,"detail":"沒看：這次只改 server 端邏輯"},"violations":[]}\n以上。');
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

  /**
   * **第三種判決：這不是實作的錯，是規格的問題。**
   *
   * 先前只有 pass / fail / skipped。撞到「這幾條 DoD 無法同時成立」時 reviewer 只能判 fail，
   * 而 fail 的語意是「coder 去修」——coder 修不動，於是下一輪再送一次、再被退一次。
   * 實跑（zZb5MGTMdQRZ）四輪 $36.64，最後帶著一條沒滿足的 DoD 被人按核准合併。
   */
  describe('spec_problem：規格本身有問題', () => {
    it('解析得出來，並保留「是哪幾條在打架」', () => {
      const v = parseReviewResponse(JSON.stringify({
        status: 'spec_problem',
        problem: '三條要求在幾何上無法同時成立（兩鍵中心距 28px）',
        conflicting: ['熱區至少 44×44', '不得改變視覺外觀', '相鄰熱區不得重疊'],
        uiChecked: { looked: true, detail: '看了 /chat（375）' },
      }));

      assert.equal(v?.status, 'spec_problem');
      assert.ok(v?.status === 'spec_problem' && v.conflicting.length === 3, '人要看得出是哪幾條在打架才裁決得了');
    });

    it('**指不出是哪幾條 → 退回成 fail**（不可以把任務停在一句空話上）', () => {
      const v = parseReviewResponse(JSON.stringify({ status: 'spec_problem', problem: '規格怪怪的' }));

      assert.equal(
        v?.status,
        'fail',
        '這條路不回灌給 coder——講不清楚就等於停下來卻沒人知道要決定什麼；讓它再跑一輪比較好',
      );
    });

    it('不算放行（規格沒解決就不該 complete_task）', () => {
      const out = toReviewOutcome({ status: 'spec_problem', problem: 'x', conflicting: ['a', 'b'] });
      assert.equal(out.ok, false);
    });

    it('**報告不可以印成綠燈**——它會進 PR 內文與事件表', () => {
      const g = reviewGateReport({ status: 'spec_problem', problem: '三條互斥', conflicting: ['A', 'B', 'C'] });

      assert.equal(g.green, false);
      assert.match(g.checks[0]?.detail ?? '', /不是實作的錯/);
      assert.match(g.checks[0]?.detail ?? '', /三條互斥/);
      assert.match(g.checks[0]?.detail ?? '', /1\. A/, '衝突清單要逐條列出來');
    });
  });

  it('違規內容原樣進 detail：規格要求、哪裡不符、建議都在', () => {
    const g = reviewGateReport({
      status: 'fail',
      violations: [{ docRef: 'spec/a.md#登入', requirement: '要有錯誤提示', problem: '沒有', suggestion: '加一個 toast' }],
    });

    const detail = g.checks[0]?.detail ?? '';
    assert.match(detail, /spec\/a\.md#登入/);
    assert.match(detail, /要有錯誤提示/);
    assert.match(detail, /沒有/);
    assert.match(detail, /加一個 toast/, '建議也要送到 agent 手上，否則它只知道錯不知道怎麼改');
  });

  it('ok 語意：只有 fail 會擋', () => {
    assert.equal(toReviewOutcome({ status: 'pass', notes: [] }).ok, true);
    assert.equal(toReviewOutcome({ status: 'skipped', reason: 'r' }).ok, true);
    assert.equal(toReviewOutcome({ status: 'fail', violations: [] }).ok, false);
  });
});

// truncateDiff 隨「程式不預先算 diff」一起退場——審查者自己用 git 工具查。


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
    const r = new Reviewer({ ...base, queryFn: fakeQuery('{"status":"pass","uiChecked":{"looked":false,"detail":"沒看：這次只改 server 端邏輯"},"violations":[]}') });
    const out = await r.check(task, [], '/wt', { baseRef: BASE });
    assert.equal(out.verdict.status, 'skipped');
  });


  it('合格 → ok=true', async () => {
    const r = new Reviewer({ ...base, queryFn: fakeQuery('```json\n{"status":"pass","uiChecked":{"looked":false,"detail":"沒看：這次只改 server 端邏輯"},"notes":["符合"],"violations":[]}\n```') });
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

/**
 * 「這次有沒有看畫面」必須寫在放行書上。
 *
 * 先前這件事是**程式**用卡片類別決定的（`category === 'design'`），而跳過時
 * 報告上一個字都沒有——於是「沒驗畫面」與「驗過而且沒問題」長得一模一樣。
 * 一張把 Vue 元件改到破版的 `dev` 卡，其他關卡全綠就一路 complete_task 開 PR。
 *
 * 現在由審查者拿實際 diff 自己決定要不要看（那比字面比對準得多），
 * 但它**必須說出來**。
 */
describe('uiChecked：放行書必填，空白不合法', () => {
  it('pass 但沒填 uiChecked → 退回要它補講（不是默默放行）', () => {
    const v = parseReviewResponse('{"status":"pass","notes":["都有做到"],"violations":[]}');
    assert.equal(v?.status, 'fail', '空白會被退回');
    assert.match(
      v?.status === 'fail' ? v.violations[0]!.problem : '',
      /uiChecked/,
      '要講清楚缺的是什麼，否則 agent 不知道要補什麼',
    );
  });

  it('「沒看」也完全合法——只要說得出為什麼', () => {
    const v = parseReviewResponse(
      '{"status":"pass","uiChecked":{"looked":false,"detail":"沒看：這次只改 API 序列化"},"violations":[]}',
    );
    assert.equal(v?.status, 'pass');
    assert.equal(v?.status === 'pass' ? v.uiChecked?.looked : undefined, false);
    assert.match(v?.status === 'pass' ? (v.uiChecked?.detail ?? '') : '', /只改 API/);
  });

  it('「看了」要寫出看了哪幾條路由與哪些寬度', () => {
    const v = parseReviewResponse(
      '{"status":"pass","uiChecked":{"looked":true,"detail":"看了 /profile 與 /settings（375 與 1440）"},"violations":[]}',
    );
    assert.equal(v?.status === 'pass' ? v.uiChecked?.looked : undefined, true);
  });

  it('detail 是空字串等同沒填（不能用空白字元蒙混）', () => {
    const v = parseReviewResponse('{"status":"pass","uiChecked":{"looked":true,"detail":"   "},"violations":[]}');
    assert.equal(v?.status, 'fail');
  });

  it('fail 不強制填（那時本來就要回去改，畫面的事下一輪再說）', () => {
    const v = parseReviewResponse('{"status":"fail","violations":[{"requirement":"A","problem":"缺 A"}]}');
    assert.equal(v?.status, 'fail');
    assert.equal(v?.status === 'fail' ? v.violations.length : 0, 1);
  });
});
