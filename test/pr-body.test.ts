import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrBody, narrativeFromSummaries, parseAgentSummary } from '../src/pr/pr-body.js';
import { makeTaskDetail } from './helpers/index.js';

// DESIGN.md §14 規定的九段版型，順序不可變（審查者靠固定結構快速掃讀）。
const SECTIONS = [
  '做了什麼 (What)',
  '怎麼做 (How)',
  '架構 (Architecture)',
  '畫面設計 (UI)',
  '操作形式 (UX)',
  '核心關鍵技術 (Key Tech)',
  '驗證 (Verification)',
  '假設與待確認 (Assumptions)',
  '涵蓋任務 (Tasks)',
];

/** 取出某段標題到下一個 `## ` 之間的內容。 */
function section(body: string, title: string): string {
  const lines = body.split('\n');
  const start = lines.indexOf(`## ${title}`);
  assert.notEqual(start, -1, `找不到段落：${title}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

test('九段齊全、順序正確，且無敘事時每段都標「（待補）」', () => {
  const body = generatePrBody({ tasks: [makeTaskDetail({ id: 'T-1', title: '修好登入' })] });

  const headings = body
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3));
  assert.deepEqual(headings, SECTIONS);

  for (const s of ['做了什麼 (What)', '怎麼做 (How)', '架構 (Architecture)', '畫面設計 (UI)', '操作形式 (UX)', '核心關鍵技術 (Key Tech)', '驗證 (Verification)']) {
    assert.equal(section(body, s), '（待補）', `${s} 缺內容時應標待補`);
  }
  assert.equal(section(body, '假設與待確認 (Assumptions)'), '（無）', '假設是「確實沒有」而非「還沒寫」，用（無）區分');
  assert.equal(body.endsWith('\n'), true, '內文應以單一換行結尾');
});

test('敘事段落原樣填入並去除頭尾空白', () => {
  const body = generatePrBody({
    tasks: [makeTaskDetail()],
    narrative: {
      what: '  新增深色模式  ',
      how: '以 CSS 變數切換主題',
      architecture: '新增 ThemeProvider',
      ui: '設定頁多一個切換開關',
      ux: '點擊即時生效並記憶偏好',
      keyTech: 'prefers-color-scheme + localStorage',
    },
  });

  assert.equal(section(body, '做了什麼 (What)'), '新增深色模式');
  assert.equal(section(body, '怎麼做 (How)'), '以 CSS 變數切換主題');
  assert.equal(section(body, '架構 (Architecture)'), '新增 ThemeProvider');
  assert.equal(section(body, '操作形式 (UX)'), '點擊即時生效並記憶偏好');
  assert.equal(section(body, '核心關鍵技術 (Key Tech)'), 'prefers-color-scheme + localStorage');
});

test('只有空白字元的敘事視同未填', () => {
  const body = generatePrBody({ tasks: [makeTaskDetail()], narrative: { what: '   \n  ' } });
  assert.equal(section(body, '做了什麼 (What)'), '（待補）');
});

// ── 截圖 ──

test('截圖以 markdown 圖片嵌入 UI 段，並接在 UI 敘述之後', () => {
  const body = generatePrBody({
    tasks: [makeTaskDetail()],
    narrative: { ui: '三個斷點都檢查過' },
    screenshots: ['artifacts/desktop.png', 'https://cdn.test/mobile.png'],
  });

  assert.equal(
    section(body, '畫面設計 (UI)'),
    ['三個斷點都檢查過', '', '![screenshot-1](artifacts/desktop.png)', '![screenshot-2](https://cdn.test/mobile.png)'].join('\n'),
  );
});

test('沒有 UI 敘述但有截圖時，UI 段只放截圖而不標待補', () => {
  const body = generatePrBody({ tasks: [makeTaskDetail()], screenshots: ['a.png'] });
  assert.equal(section(body, '畫面設計 (UI)'), '![screenshot-1](a.png)');
});

test('screenshots 為空陣列時 UI 段仍標待補', () => {
  const body = generatePrBody({ tasks: [makeTaskDetail()], screenshots: [] });
  assert.equal(section(body, '畫面設計 (UI)'), '（待補）');
});

// ── 驗證段 ──

test('驗證段以 ✅/❌ 列出每個關卡並附上 diff 統計', () => {
  const body = generatePrBody({
    tasks: [makeTaskDetail()],
    verification: [
      { name: 'typecheck', ok: true },
      { name: 'test', ok: false },
    ],
    diff: { files: ['src/a.ts', 'src/b.ts'], additions: 42, deletions: 7 },
  });

  assert.equal(
    section(body, '驗證 (Verification)'),
    ['- ✅ typecheck', '- ❌ test', '- 變更檔案 2 個（+42 / -7）'].join('\n'),
  );
});

test('只有 diff 沒有關卡結果時仍輸出 diff 統計', () => {
  const body = generatePrBody({
    tasks: [makeTaskDetail()],
    diff: { files: [], additions: 0, deletions: 0 },
  });
  assert.equal(section(body, '驗證 (Verification)'), '- 變更檔案 0 個（+0 / -0）');
});

// ── 假設 ──

test('假設逐條列出；沒有假設時標「（無）」', () => {
  const withAsm = generatePrBody({
    tasks: [makeTaskDetail()],
    assumptions: ['沿用既有色票，未新增 design token', '錯誤訊息文案暫用英文'],
  });
  assert.equal(
    section(withAsm, '假設與待確認 (Assumptions)'),
    ['- 沿用既有色票，未新增 design token', '- 錯誤訊息文案暫用英文'].join('\n'),
  );

  const emptyAsm = generatePrBody({ tasks: [makeTaskDetail()], assumptions: [] });
  assert.equal(section(emptyAsm, '假設與待確認 (Assumptions)'), '（無）');
});

// ── 涵蓋任務 ──

test('涵蓋任務列出 id、標題與 docRefs', () => {
  const body = generatePrBody({
    tasks: [
      makeTaskDetail({ id: 'T-1', title: '登入表單驗證', docRefs: ['spec/auth.md#登入', 'prd/x.md'] }),
      makeTaskDetail({ id: 'T-2', title: '錯誤提示', docRefs: [] }),
    ],
  });
  assert.equal(
    section(body, '涵蓋任務 (Tasks)'),
    ['- [T-1] 登入表單驗證（docRefs: spec/auth.md#登入, prd/x.md）', '- [T-2] 錯誤提示'].join('\n'),
  );
});

test('沒有任務時涵蓋任務段標待補（不應輸出空段）', () => {
  const body = generatePrBody({ tasks: [] });
  assert.equal(section(body, '涵蓋任務 (Tasks)'), '（待補）');
});

// ── 分群理由頁尾 ──

test('有分群理由時附在最後的引言區塊；沒有則完全不出現', () => {
  const withRationale = generatePrBody({ tasks: [makeTaskDetail()], rationale: ' 3 個任務共用 spec/auth.md ' });
  assert.match(withRationale, /\n---\n\n> 分群理由：3 個任務共用 spec\/auth\.md\n$/);

  const without = generatePrBody({ tasks: [makeTaskDetail()] });
  assert.equal(without.includes('分群理由'), false);
  assert.equal(without.includes('---'), false);
});

test('空白字串的分群理由視同沒有', () => {
  const body = generatePrBody({ tasks: [makeTaskDetail()], rationale: '   ' });
  assert.equal(body.includes('分群理由'), false);
});

// ── agent 總結 → 敘事 ──

test('markdown 標題對映到敘事欄位，假設段落轉成條列', () => {
  const { narrative, assumptions } = parseAgentSummary(
    [
      '## 做了什麼',
      '新增深色模式。',
      '## 怎麼做',
      '以 CSS 變數切換主題。',
      '## 架構',
      '新增 ThemeProvider。',
      '## 畫面設計',
      '設定頁多一個開關。',
      '## 操作形式',
      '點擊即時生效。',
      '## 核心關鍵技術',
      'prefers-color-scheme。',
      '## 假設與待確認',
      '- 沿用既有色票',
      '- 文案暫用英文',
    ].join('\n'),
  );

  assert.deepEqual(narrative, {
    what: '新增深色模式。',
    how: '以 CSS 變數切換主題。',
    architecture: '新增 ThemeProvider。',
    ui: '設定頁多一個開關。',
    ux: '點擊即時生效。',
    keyTech: 'prefers-color-scheme。',
  });
  assert.deepEqual(assumptions, ['沿用既有色票', '文案暫用英文']);
});

test('「畫面設計」歸 UI 而非架構（標題含「設計」二字不可誤判）', () => {
  const { narrative } = parseAgentSummary('## 畫面設計\n三個斷點都檢查過。');
  assert.equal(narrative.ui, '三個斷點都檢查過。');
  assert.equal(narrative.architecture, undefined);
});

test('沒有任何標題時整段當「做了什麼」（agent 常只寫一段話）', () => {
  const { narrative, assumptions } = parseAgentSummary('修好了登入按鈕沒反應的問題。');
  assert.equal(narrative.what, '修好了登入按鈕沒反應的問題。');
  assert.deepEqual(assumptions, []);
});

test('粗體標籤只有對得上欄位時才視為標題，內文的粗體強調不切段', () => {
  const { narrative } = parseAgentSummary(
    ['**怎麼做**：改 auth.ts', '**注意** 這行只是強調，不是新段落', '仍屬同一段。'].join('\n'),
  );
  assert.equal(
    narrative.how,
    ['改 auth.ts', '**注意** 這行只是強調，不是新段落', '仍屬同一段。'].join('\n'),
  );
});

test('未知標題的段落一律忽略，不硬塞進其他欄位', () => {
  const { narrative } = parseAgentSummary('## 隨手記\n跟 PR 無關的碎念。\n## 怎麼做\n改設定檔。');
  assert.equal(narrative.how, '改設定檔。');
  assert.equal(narrative.what, undefined, '未知段落不可被當成 what');
});

test('沒有假設段時，退而擷取全文含「假設」字樣的條列', () => {
  const { assumptions } = parseAgentSummary('## 怎麼做\n改了設定。\n- 假設預設語系為 zh-TW\n- 順手加了測試');
  assert.deepEqual(assumptions, ['假設預設語系為 zh-TW']);
});

test('假設段寫「（無）」視同沒有假設', () => {
  const { assumptions } = parseAgentSummary('## 假設\n（無）');
  assert.deepEqual(assumptions, []);
});

test('假設段是整段文字時折成單一條目（避免破壞 PR 的條列格式）', () => {
  const { assumptions } = parseAgentSummary('## 假設\n沿用既有錯誤碼，\n未新增型別。');
  assert.deepEqual(assumptions, ['沿用既有錯誤碼， 未新增型別。']);
});

test('多任務總結：各段以任務標題分小節，假設加上任務 id 前綴', () => {
  const { narrative, assumptions } = narrativeFromSummaries([
    { taskId: 'T-1', title: '登入表單', text: '## 做了什麼\n加上驗證。\n## 假設\n- 沿用既有錯誤碼' },
    { taskId: 'T-2', title: '錯誤提示', text: '## 做了什麼\n補上提示。' },
  ]);

  assert.equal(narrative.what, '### 登入表單\n\n加上驗證。\n\n### 錯誤提示\n\n補上提示。');
  assert.deepEqual(assumptions, ['[T-1] 沿用既有錯誤碼']);
});

test('單一任務總結不加小節標題；空總結被忽略', () => {
  const { narrative } = narrativeFromSummaries([
    { taskId: 'T-1', title: '登入表單', text: '## 做了什麼\n加上驗證。' },
    { taskId: 'T-2', title: '空的', text: '   ' },
  ]);
  assert.equal(narrative.what, '加上驗證。');
});

test('完全沒有總結時回空敘事（交由 generatePrBody 標待補）', () => {
  const { narrative, assumptions } = narrativeFromSummaries([]);
  assert.deepEqual(narrative, {});
  assert.deepEqual(assumptions, []);
  const body = generatePrBody({ tasks: [makeTaskDetail()], narrative, assumptions });
  assert.equal(section(body, '怎麼做 (How)'), '（待補）');
});

test('重複的假設只留一條', () => {
  const { assumptions } = narrativeFromSummaries([
    { taskId: 'T-1', title: 'a', text: '## 假設\n- 同一條' },
  ]);
  assert.deepEqual(assumptions, ['同一條']);
});

test('完整輸入時九段全部有實質內容（無任何待補）', () => {
  const body = generatePrBody({
    tasks: [makeTaskDetail({ id: 'T-1', title: '深色模式', docRefs: ['spec/theme.md'] })],
    narrative: { what: 'w', how: 'h', architecture: 'a', ui: 'u', ux: 'x', keyTech: 'k' },
    screenshots: ['s.png'],
    verification: [{ name: 'build', ok: true }],
    diff: { files: ['a.ts'], additions: 1, deletions: 0 },
    assumptions: ['預設開啟'],
    rationale: '單一任務',
  });
  assert.equal(body.includes('（待補）'), false);
  assert.equal(body.includes('（無）'), false);
});
