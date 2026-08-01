import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MergeRiskJudge, buildRiskPrompt, parseRiskResponse } from '../src/core/merge-risk-judge.js';
import { createSilentLogger } from './helpers/index.js';

/**
 * 這一關取代了原本的「政策引擎」——那套是比對檔案路徑（`**\/migrations\/**`、
 * `.github/workflows/**`）來判斷「這個 PR 要不要人工核准」。
 *
 * 它在猜別人的 repo 長什麼樣：換一個把 migration 放在 `db/schema/` 的專案就同時
 * 做錯兩件事——該擋的沒擋、不該擋的亂擋。secrets 那組更是裝飾品，只抓得到
 * 「檔名叫 .env」，而真正會發生的是「把 API key 貼進 src/config.ts」。
 *
 * 判斷者人在那個 repo 裡，看得到實際結構與檔案內容。
 */

const INPUT = { cwd: '/wt', baseRef: 'origin/main', taskTitles: ['加上匯出功能'] };
const wrap = (o: unknown): string => '```json\n' + JSON.stringify(o) + '\n```';
const reply = (text: string) =>
  async function* () {
    yield { type: 'result', subtype: 'success', result: text };
  };

describe('parseRiskResponse', () => {
  it('無風險', () => {
    assert.deepEqual(parseRiskResponse(wrap({ needsHuman: false, notes: ['只動了元件樣式'] })), {
      needsHuman: false,
      notes: ['只動了元件樣式'],
    });
  });

  it('有風險：逐項帶證據', () => {
    const v = parseRiskResponse(wrap({ needsHuman: true, risks: [{ what: 'schema 變更', why: '資料回不去', evidence: 'db/x.sql:3' }] }));
    assert.equal(v?.needsHuman, true);
    assert.equal(v?.needsHuman === true ? v.risks[0]?.evidence : undefined, 'db/x.sql:3');
  });

  it('沒有圍欄也解析得到（agent 常常直接吐 JSON）', () => {
    assert.equal(parseRiskResponse('好的\n{"needsHuman": false, "notes": []}')?.needsHuman, false);
  });

  it('needsHuman: true 卻沒列出任何一項 → 解析失敗（沒有理由的攔截等於沒有資訊）', () => {
    assert.equal(parseRiskResponse(wrap({ needsHuman: true, risks: [] })), undefined);
  });

  it('不是 JSON → undefined', () => {
    assert.equal(parseRiskResponse('我覺得應該沒問題'), undefined);
  });
});

/**
 * 「無法確認安全」與「確認安全」是兩件事。
 * 這一關唯一的失敗方向必須是「多問人一次」，絕不能是「安靜地合併下去」。
 */
describe('判不出來一律當要問人', () => {
  it('沒有認證', async () => {
    const j = new MergeRiskJudge({ log: createSilentLogger(), hasAuth: () => false });
    assert.equal((await j.judge(INPUT)).needsHuman, true);
  });

  it('呼叫失敗', async () => {
    const j = new MergeRiskJudge({
      log: createSilentLogger(),
      queryFn: () => {
        throw new Error('網路斷了');
      },
    });
    const v = await j.judge(INPUT);
    assert.equal(v.needsHuman, true);
    assert.match(v.needsHuman === true ? v.risks[0]!.why : '', /網路斷了/);
  });

  it('回應解析不出來', async () => {
    const j = new MergeRiskJudge({ log: createSilentLogger(), queryFn: reply('嗯，看起來還好') });
    assert.equal((await j.judge(INPUT)).needsHuman, true);
  });

  it('判定無風險 → 放行', async () => {
    const j = new MergeRiskJudge({ log: createSilentLogger(), queryFn: reply(wrap({ needsHuman: false, notes: ['純樣式'] })) });
    assert.equal((await j.judge(INPUT)).needsHuman, false);
  });
});

describe('buildRiskPrompt', () => {
  it('說清楚判準是「後果」不是「檔案放在哪個目錄」', () => {
    const p = buildRiskPrompt(INPUT);
    assert.match(p, /判準是\*\*後果\*\*，不是檔案放在哪個目錄/);
    assert.match(p, /不要只看檔名猜/);
  });

  it('要求先用 git 工具看實際改了什麼', () => {
    const p = buildRiskPrompt(INPUT);
    assert.match(p, /git_changed_files/);
    assert.match(p, /git_diff/);
  });

  it('明講不要攔一般的功能與修錯（否則它會變成第二個 reviewer）', () => {
    assert.match(buildRiskPrompt(INPUT), /\*\*不要\*\*攔這些/);
  });

  it('secrets 要看內容而不是檔名', () => {
    assert.match(buildRiskPrompt(INPUT), /貼在一般程式碼裡的 key 才是真正會發生的情況/);
  });

  it('帶上任務內容（判斷「改動有沒有超出任務範圍」需要知道意圖）', () => {
    const p = buildRiskPrompt({ ...INPUT, taskDescriptions: ['把清單匯出成 CSV'] });
    assert.match(p, /加上匯出功能/);
    assert.match(p, /把清單匯出成 CSV/);
  });
});
