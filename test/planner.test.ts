import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Planner, type FootprintScannerLike } from '../src/core/planner.js';
import { makeTask } from './helpers/index.js';
import type { PlannedGroup } from '../src/types.js';
import type { Footprint, FootprintScanInput } from '../src/worker/footprint.js';
import { toDirs } from '../src/worker/footprint.js';

const planner = new Planner();

/** 找出包含指定任務的群（群陣列順序由連通分量決定，不宜直接用索引斷言）。 */
function groupWith(groups: PlannedGroup[], taskId: string): PlannedGroup {
  const g = groups.find((x) => x.taskIds.includes(taskId));
  assert.ok(g, `找不到包含 ${taskId} 的群`);
  return g;
}

/** 兩個任務是否落在同一群。 */
function sameGroup(groups: PlannedGroup[], a: string, b: string): boolean {
  return groupWith(groups, a) === groupWith(groups, b);
}

// 英文語料：near* 為高度相似（Jaccard 0.83），related* 只是主題相關（0.30），其餘互不相似。
// （分數比舊版高，是因為停用詞表補上了 add/to/on 這類與中文「新增」對稱的套語。）
const nearA = { title: 'dark mode toggle', description: 'add dark mode toggle to settings panel' };
const nearB = { title: 'dark mode toggle default', description: 'dark mode toggle to settings panel default on' };
const related = {
  title: 'checkout payment retry',
  description: 'add retry logic when payment gateway times out',
};
const relatedB = {
  title: 'payment gateway timeout handling',
  description: 'handle payment gateway timeout with retry',
};
const unrelated = { title: 'export csv report', description: 'generate monthly csv export for finance' };

// 中文語料（本專案的實際使用情境）：zhDark* 高度相似（0.50），其餘兩兩 ≤ 0.11。
const zhDark = { title: '深色模式切換', description: '在設定頁面加入深色模式切換開關' };
const zhDarkB = { title: '深色模式切換預設開啟', description: '深色模式切換開關預設為開啟狀態' };
const zhLogin = { title: '修正登入表單驗證訊息', description: '登入表單的錯誤訊息要顯示在欄位下方' };
const zhLoginB = { title: '登入表單驗證訊息樣式', description: '調整登入表單驗證錯誤訊息的顯示樣式' };
const zhReport = { title: '匯出每月財報', description: '為財務部門產生每月 CSV 匯出檔' };
const zhPerf = { title: '首頁載入效能優化', description: '把首頁圖片改成延遲載入以加快初次渲染' };
const zhNotify = { title: '推播通知設定', description: '使用者可以在個人設定關閉推播通知' };

// ── 基本形狀 ──

test('空輸入回空計畫', async () => {
  const plan = await planner.plan([]);
  assert.deepEqual(plan.groups, []);
  assert.deepEqual(plan.schedule, []);
});

test('單一任務自成一群，footprint 取 docRef 檔名、rationale 標示獨立', async () => {
  const plan = await planner.plan([makeTask({ id: 'T-1', docRefs: ['spec/a.md#§1'] })]);
  assert.equal(plan.groups.length, 1);
  const g = plan.groups[0]!;
  assert.deepEqual(g.taskIds, ['T-1']);
  assert.equal(g.repo, 'acme/web');
  assert.deepEqual(g.footprint, ['spec/a.md']);
  assert.equal(g.rationale, '獨立任務（無關聯）');
});

// ── 分群條件 ──

test('共用 docRef 檔案（不同 section）→ 同群，即使文字毫不相干', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'A', docRefs: ['spec/auth.md#登入'], ...unrelated }),
    makeTask({ id: 'B', docRefs: ['spec/auth.md#登出'], ...nearA }),
  ]);
  assert.equal(plan.groups.length, 1);
  assert.deepEqual(plan.groups[0]!.taskIds.sort(), ['A', 'B']);
  assert.deepEqual(plan.groups[0]!.footprint, ['spec/auth.md']);
});

test('不同 docRef 檔案且文字不相似 → 分開成兩群', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'A', docRefs: ['spec/auth.md#登入'], ...unrelated }),
    makeTask({ id: 'B', docRefs: ['spec/billing.md#請款'], ...nearA }),
  ]);
  assert.equal(plan.groups.length, 2);
  assert.equal(sameGroup(plan.groups, 'A', 'B'), false);
});

test('關鍵字高度相似（無 docRef）→ 同群', async () => {
  const plan = await planner.plan([makeTask({ id: 'A', ...nearA }), makeTask({ id: 'B', ...nearB })]);
  assert.equal(plan.groups.length, 1);
  assert.match(plan.groups[0]!.rationale, /關鍵字相似/);
});

test('只是主題相關但相似度未達門檻 → 不合併（避免把不同工作綁在一條分支）', async () => {
  const plan = await planner.plan([makeTask({ id: 'A', ...related }), makeTask({ id: 'B', ...relatedB })]);
  assert.equal(plan.groups.length, 2, '0.23 的 Jaccard 不該達到 0.5 門檻');
});

// ── 中文分詞（Intl.Segmenter）──
// 舊 tokenizer 用字元類別切字，整串 CJK 會變成單一 token，中文任務永遠零交集。

test('中文相似任務會合併（深色模式切換兩張卡）', async () => {
  const plan = await planner.plan([makeTask({ id: 'A', ...zhDark }), makeTask({ id: 'B', ...zhDarkB })]);
  assert.equal(plan.groups.length, 1, '中文必須先斷詞才可能有交集');
  assert.match(plan.groups[0]!.rationale, /關鍵字相似/);
});

test('中文相似任務會合併（繁體複合詞：登入表單驗證訊息）', async () => {
  const plan = await planner.plan([makeTask({ id: 'A', ...zhLogin }), makeTask({ id: 'B', ...zhLoginB })]);
  assert.equal(plan.groups.length, 1);
});

test('中文無關任務不合併（同語言不等於同主題）', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'A', ...zhDark }),
    makeTask({ id: 'B', ...zhReport }),
    makeTask({ id: 'C', ...zhPerf }),
    makeTask({ id: 'D', ...zhNotify }),
  ]);
  assert.equal(plan.groups.length, 4, '四張互不相干的中文卡應各自成群');
});

test('中文只共用套語（新增/調整/頁面）不足以合併', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'A', title: '新增匯率換算頁面', description: '調整頁面版面並新增匯率換算欄位' }),
    makeTask({ id: 'B', title: '新增權限設定頁面', description: '調整頁面版面並新增權限設定欄位' }),
  ]);
  assert.equal(plan.groups.length, 2, '「新增/調整/頁面/欄位」是任務板套語，無鑑別度');
});

test('中英混寫的任務也能斷詞比對（中文段落與英文識別字都要進 token）', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'A', title: '深色模式切換 dark mode', description: '設定頁的深色模式切換開關 toggle' }),
    makeTask({ id: 'B', title: '深色模式切換預設開啟 dark mode', description: '深色模式切換開關 toggle 預設為開啟狀態' }),
  ]);
  assert.equal(plan.groups.length, 1);
});

test('稀疏文字即使完全相同也不合併（防止「fix / bug」這種空洞描述互相吸附）', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'A', title: 'fix', description: 'bug' }),
    makeTask({ id: 'B', title: 'fix', description: 'bug' }),
  ]);
  assert.equal(plan.groups.length, 2);
});

test('相似性具傳遞性：A~B（關鍵字）、B~C（共用規格）→ 三者同群', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'A', ...nearA }),
    makeTask({ id: 'B', ...nearB, docRefs: ['spec/theme.md#tokens'] }),
    makeTask({ id: 'C', ...unrelated, docRefs: ['spec/theme.md#palette'] }),
  ]);
  assert.equal(plan.groups.length, 1);
  assert.deepEqual(plan.groups[0]!.taskIds.sort(), ['A', 'B', 'C']);
  assert.deepEqual(plan.groups[0]!.footprint, ['spec/theme.md']);
});

test('footprint 去重且只保留 # 之前的檔名', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'A', docRefs: ['spec/a.md#一', 'spec/a.md#二', 'prd/b.md'], ...unrelated }),
  ]);
  assert.deepEqual(plan.groups[0]!.footprint, ['spec/a.md', 'prd/b.md']);
});

// ── 依賴與排序 ──

test('同 repo 內的依賴會把任務併成一群，並依拓樸排序輸出', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'C', dependencies: ['B'], ...unrelated }),
    makeTask({ id: 'B', dependencies: ['A'], ...related }),
    makeTask({ id: 'A', ...nearA }),
  ]);
  assert.equal(plan.groups.length, 1);
  assert.deepEqual(plan.groups[0]!.taskIds, ['A', 'B', 'C'], '上游必須排在下游之前');
  assert.deepEqual(plan.schedule, [], '同群內的依賴不需要群間序列邊');
});

test('無依賴的成員維持輸入順序', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'X', docRefs: ['spec/s.md'], ...unrelated }),
    makeTask({ id: 'Y', docRefs: ['spec/s.md'], ...related }),
    makeTask({ id: 'Z', docRefs: ['spec/s.md'], ...nearA }),
  ]);
  assert.deepEqual(plan.groups[0]!.taskIds, ['X', 'Y', 'Z']);
});

test('依賴形成環時不遺漏任何任務（Kahn 排不掉的補回尾端）', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'A', dependencies: ['B'], ...nearA }),
    makeTask({ id: 'B', dependencies: ['A'], ...unrelated }),
  ]);
  assert.equal(plan.groups.length, 1);
  assert.deepEqual(plan.groups[0]!.taskIds.sort(), ['A', 'B']);
});

test('指向不存在任務的依賴被忽略，不影響分群也不產生排程邊', async () => {
  const plan = await planner.plan([makeTask({ id: 'A', dependencies: ['已完成的舊任務'], ...unrelated })]);
  assert.equal(plan.groups.length, 1);
  assert.deepEqual(plan.groups[0]!.taskIds, ['A']);
  assert.deepEqual(plan.schedule, []);
});

// ── 多 repo ──

test('不同 repo 絕不合併，即使內容完全相同', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'W', repo: 'acme/web', ...nearA }),
    makeTask({ id: 'P', repo: 'acme/api', ...nearA }),
  ]);
  assert.equal(plan.groups.length, 2);
  assert.equal(groupWith(plan.groups, 'W').repo, 'acme/web');
  assert.equal(groupWith(plan.groups, 'P').repo, 'acme/api');
});

test('跨 repo 依賴 → 產生 reason=dep 的群間序列邊（上游群 → 下游群）', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'W', repo: 'acme/web', dependencies: ['P'], ...nearA }),
    makeTask({ id: 'P', repo: 'acme/api', ...unrelated }),
  ]);
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.schedule.length, 1);

  const edge = plan.schedule[0]!;
  assert.equal(edge.reason, 'dep');
  // fromGroup/toGroup 是 groups 陣列的索引字串
  assert.equal(plan.groups[Number(edge.fromGroup)], groupWith(plan.groups, 'P'));
  assert.equal(plan.groups[Number(edge.toGroup)], groupWith(plan.groups, 'W'));
});

test('多 repo 混合時，各 repo 內部照常依相似性分群', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'W1', repo: 'acme/web', ...nearA }),
    makeTask({ id: 'W2', repo: 'acme/web', ...nearB }),
    makeTask({ id: 'A1', repo: 'acme/api', ...unrelated }),
    makeTask({ id: 'A2', repo: 'acme/api', ...related }),
  ]);
  assert.equal(plan.groups.length, 3);
  assert.equal(sameGroup(plan.groups, 'W1', 'W2'), true);
  assert.equal(sameGroup(plan.groups, 'A1', 'A2'), false);
});

// ── rationale ──

test('rationale 說明分群依據（共用規格 / 前後依賴）', async () => {
  const plan = await planner.plan([
    makeTask({ id: 'A', docRefs: ['spec/x.md#§1'], ...unrelated }),
    makeTask({ id: 'B', docRefs: ['spec/x.md#§2'], dependencies: ['A'], ...related }),
  ]);
  const r = plan.groups[0]!.rationale;
  assert.match(r, /^2 個任務歸為一群/);
  assert.match(r, /共用規格 spec\/x\.md/);
  assert.match(r, /存在前後依賴/);
});

// ── 真實檔案足跡 ──

/** 依任務標題回傳固定足跡的假掃描器；記錄收到的輸入供斷言。 */
function fakeScanner(byTitle: Record<string, string[]>): FootprintScannerLike & { seen: FootprintScanInput[] } {
  const seen: FootprintScanInput[] = [];
  return {
    seen,
    async scan(input): Promise<Footprint> {
      seen.push(input);
      const files = byTitle[input.title ?? ''] ?? [];
      return { files, dirs: toDirs(files), hints: { paths: [], symbols: [] } };
    },
  };
}

const withScanner = (scanner: FootprintScannerLike, repoPath: string | undefined = '/repos/web'): Planner =>
  new Planner({ resolveRepoPath: (): string | undefined => repoPath, scanner });

/** 沒有本地 checkout 的 Planner（resolveRepoPath 回 undefined）。 */
const withoutRepoPath = (scanner: FootprintScannerLike): Planner =>
  new Planner({ resolveRepoPath: () => undefined, scanner });

test('有 repo 路徑時，footprint 用實際程式碼檔案（含所屬目錄）取代 docRef 代理', async () => {
  const scanner = fakeScanner({ 甲: ['src/a/x.ts'] });
  const plan = await withScanner(scanner).plan([makeTask({ id: 'A', title: '甲', docRefs: ['spec/s.md#§1'] })]);

  assert.deepEqual(plan.groups[0]!.footprint, ['src/a/x.ts', 'src/a']);
  assert.equal(plan.groups[0]!.footprint.includes('spec/s.md'), false, 'spec 不該再混進足跡');
});

test('不把 docRefs 餵給掃描器（否則 spec 路徑會被掃成命中檔案，代理又回來了）', async () => {
  const scanner = fakeScanner({});
  await withScanner(scanner).plan([makeTask({ id: 'A', title: '甲', description: '乙', docRefs: ['spec/s.md#§1'] })]);

  assert.equal(scanner.seen.length, 1);
  assert.equal(scanner.seen[0]!.docRefs, undefined);
  assert.equal(scanner.seen[0]!.repoPath, '/repos/web');
});

test('共用同一份 spec 但動不同檔案 → 仍同群（規格相關），但足跡是各自的真實檔案', async () => {
  const scanner = fakeScanner({ 甲: ['src/a/x.ts'], 乙: ['src/b/y.ts'] });
  const plan = await withScanner(scanner).plan([
    makeTask({ id: 'A', title: '甲', docRefs: ['spec/s.md#一'] }),
    makeTask({ id: 'B', title: '乙', docRefs: ['spec/s.md#二'] }),
  ]);

  assert.equal(plan.groups.length, 1);
  assert.deepEqual(plan.groups[0]!.footprint, ['src/a/x.ts', 'src/a', 'src/b/y.ts', 'src/b']);
});

test('不同群但真實足跡重疊 → 產生 file-overlap 序列邊（不誤判並行）', async () => {
  const scanner = fakeScanner({ 甲: ['src/shared/util.ts'], 乙: ['src/shared/util.ts'] });
  const plan = await withScanner(scanner).plan([
    makeTask({ id: 'A', title: '甲', ...{ description: unrelated.description } }),
    makeTask({ id: 'B', title: '乙', ...{ description: zhPerf.description } }),
  ]);

  assert.equal(plan.groups.length, 2, '文字不相似、無共用規格 → 本來就是兩群');
  assert.deepEqual(plan.schedule, [{ fromGroup: '0', toGroup: '1', reason: 'file-overlap' }]);
});

test('足跡只在同 repo 內比較，不同 repo 的相同路徑不算重疊', async () => {
  const scanner = fakeScanner({ 甲: ['src/x.ts'], 乙: ['src/x.ts'] });
  const plan = await new Planner({ resolveRepoPath: () => '/repos/any', scanner }).plan([
    makeTask({ id: 'A', repo: 'acme/web', title: '甲', ...{ description: unrelated.description } }),
    makeTask({ id: 'B', repo: 'acme/api', title: '乙', ...{ description: zhPerf.description } }),
  ]);

  assert.equal(plan.groups.length, 2);
  assert.deepEqual(plan.schedule, []);
});

test('沒有 repo 路徑 → 整個退回 docRef 代理，掃描器完全不被呼叫', async () => {
  const scanner = fakeScanner({ 甲: ['src/a/x.ts'] });
  const plan = await withoutRepoPath(scanner).plan([makeTask({ id: 'A', title: '甲', docRefs: ['spec/s.md#§1'] })]);

  assert.deepEqual(plan.groups[0]!.footprint, ['spec/s.md']);
  assert.deepEqual(scanner.seen, []);
});

test('掃描拋錯 → 該任務優雅退回 docRef 代理，plan 不中斷', async () => {
  const scanner: FootprintScannerLike = {
    async scan(input) {
      if (input.title === '甲') throw new Error('git ls-files 掛了');
      return { files: ['src/b/y.ts'], dirs: ['src/b'], hints: { paths: [], symbols: [] } };
    },
  };
  const plan = await withScanner(scanner).plan([
    makeTask({ id: 'A', title: '甲', docRefs: ['spec/s.md#§1'], ...{ description: unrelated.description } }),
    makeTask({ id: 'B', title: '乙', ...{ description: zhPerf.description } }),
  ]);

  assert.equal(plan.groups.length, 2);
  assert.deepEqual(groupWith(plan.groups, 'A').footprint, ['spec/s.md']);
  assert.deepEqual(groupWith(plan.groups, 'B').footprint, ['src/b/y.ts', 'src/b']);
});

test('掃不到任何檔案（無線索）→ 該任務退回 docRef 代理，而不是留空足跡', async () => {
  const scanner = fakeScanner({});
  const plan = await withScanner(scanner).plan([makeTask({ id: 'A', title: '甲', docRefs: ['spec/s.md#§1'] })]);

  assert.deepEqual(plan.groups[0]!.footprint, ['spec/s.md'], '空足跡會被 Dispatcher 當成可並行，太樂觀');
});

test('同目錄的不同檔案也算重疊（掃描必然漏檔，寧可保守序列化）', async () => {
  const scanner = fakeScanner({ 甲: ['src/cart/list.ts'], 乙: ['src/cart/item.ts'] });
  const plan = await withScanner(scanner).plan([
    makeTask({ id: 'A', title: '甲', ...{ description: unrelated.description } }),
    makeTask({ id: 'B', title: '乙', ...{ description: zhPerf.description } }),
  ]);

  assert.equal(plan.groups.length, 2);
  assert.deepEqual(plan.schedule, [{ fromGroup: '0', toGroup: '1', reason: 'file-overlap' }]);
});

test('足跡完全不相干的群不會被加上序列邊（不過度序列化）', async () => {
  const scanner = fakeScanner({ 甲: ['src/a/x.ts'], 乙: ['src/b/y.ts'] });
  const plan = await withScanner(scanner).plan([
    makeTask({ id: 'A', title: '甲', ...{ description: unrelated.description } }),
    makeTask({ id: 'B', title: '乙', ...{ description: zhPerf.description } }),
  ]);

  assert.equal(plan.groups.length, 2);
  assert.deepEqual(plan.schedule, []);
});
