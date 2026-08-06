import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrBody, narrativeFromSummaries } from '../src/pr/pr-body.js';
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

/**
 * **agent 直接交結構，程式不解析散文。**
 *
 * 先前有六條中文關鍵字正則去猜 markdown 標題屬於哪一欄，對不上就整段丟掉——
 * agent 只要寫英文標題（## Implementation / ## Changes）就整份總結被丟光，
 * 而 PR 上是一片空白不是一個警訊。資料一開始就是結構化的（提示詞規定了格式），
 * 程式卻讓它渲染成散文再猜回來。現在它用 report_summary 交欄位。
 */
test('欄位原樣搬進 PR，不做任何解析', () => {
  const { narrative, assumptions } = narrativeFromSummaries([
    {
      taskId: 'T-1',
      title: '深色模式',
      summary: {
        what: '加了切換開關',
        ui: '三個斷點都檢查過',
        assumptions: ['預設跟隨系統'],
      },
    },
  ]);

  assert.equal(narrative.what, '加了切換開關');
  assert.equal(narrative.ui, '三個斷點都檢查過');
  assert.deepEqual(assumptions, ['預設跟隨系統']);
  assert.equal(narrative.architecture, undefined, '沒填的欄位就是沒有，不要生一個出來');
});

test('英文內容一樣進得去（先前六條中文正則會整份丟掉）', () => {
  const { narrative } = narrativeFromSummaries([
    { taskId: 'T-1', title: 'Dark mode', summary: { what: 'Added a toggle', how: 'CSS variables' } },
  ]);

  assert.equal(narrative.what, 'Added a toggle');
  assert.equal(narrative.how, 'CSS variables');
});


