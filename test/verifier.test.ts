import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import {
  Verifier,
  decideVisualGate,
  resolveVisualDirs,
  taskHintOf,
  DEFAULT_COMMAND_TIMEOUT_MS,
  evaluateGateCommandRedline,
  type VerifierDeps,
  type VisualGateConfig,
} from '../src/worker/verifier.js';
import type { CheckResult } from '../src/types.js';
import { createSilentLogger, createTmpDir, createTmpGitRepo, type TmpDir, type TmpGitRepo } from './helpers/index.js';

// DoD 關卡實跑 shell 指令，所以測試用真實但極簡的指令（exit 碼 + 假輸出）
// 來模擬各家測試框架的輸出格式，不依賴任何專案。
const OK = 'exit 0';
const fail = (lines: string[]): string => `printf '${lines.join('\\n')}\\n'; exit 1`;

describe('Verifier — DoD 關卡', () => {
  let dir: TmpDir;
  let verifier: Verifier;

  before(() => {
    dir = createTmpDir('botone-verifier-');
    verifier = new Verifier(createSilentLogger());
  });
  after(() => dir.cleanup());

  it('全部關卡綠 → green 為真，且依固定順序回報', async () => {
    const gate = await verifier.check({
      cwd: dir.path,
      config: { typecheck: OK, lint: OK, build: OK, test: OK },
    });

    assert.equal(gate.green, true);
    assert.deepEqual(gate.checks.map((c) => c.name), ['typecheck', 'lint', 'build', 'test']);
    assert.ok(gate.checks.every((c) => c.ok && c.detail === 'ok'));
    assert.ok(gate.checks.every((c) => c.failingIds === undefined));
  });

  it('未設定的關卡會被略過（只跑有設定的）', async () => {
    const gate = await verifier.check({ cwd: dir.path, config: { test: OK } });
    assert.deepEqual(gate.checks.map((c) => c.name), ['test']);
    assert.equal(gate.green, true);
  });

  it('單一關卡失敗 → green 為假，其餘關卡仍照跑', async () => {
    const gate = await verifier.check({
      cwd: dir.path,
      config: { typecheck: OK, test: fail(['not ok 1 - alpha']) },
    });

    assert.equal(gate.green, false);
    assert.equal(gate.checks.length, 2);
    assert.equal(gate.checks[0]?.ok, true);
    assert.equal(gate.checks[1]?.ok, false);
    // 失敗細節要帶回輸出，否則無法回灌給 agent
    assert.match(gate.checks[1]?.detail ?? '', /not ok 1 - alpha/);
  });

  // 原本此案例斷言 checks 為空陣列；那正是缺陷 3 的病灶——未綠又沒有任何回饋，
  // agent 收到空白只能亂猜，Worker 於是無限迴圈燒 token。現在要求「不綠 + 明確說出是設定問題」。
  it('無任何關卡可跑 → 視為未綠，且要明講問題出在設定（不能靜默）', async () => {
    const gate = await verifier.check({ cwd: dir.path, config: {} });
    assert.equal(gate.green, false);
    assert.equal(gate.checks.length, 1);
    assert.equal(gate.checks[0]?.name, 'config');
    assert.equal(gate.checks[0]?.ok, false);
    assert.match(gate.checks[0]?.detail ?? '', /設定問題/);
    assert.match(gate.checks[0]?.detail ?? '', /commands/);
    assert.deepEqual(gate.checks[0]?.failingIds, ['no-gates']);
    // 簽章仍需可計算且穩定（固定字串，不可帶變動內容）
    const again = await verifier.check({ cwd: dir.path, config: {} });
    assert.equal(gate.signature, again.signature);
  });

  /**
   * 「從輸出撈失敗的測試叫什麼」整段退場（第 14 片）。
   *
   * 那是一個只認得 TAP／node:test／jest 三種格式的正則。換一套工具鏈（vitest 的
   * 摘要、tsc 的錯誤、gradle 的 report）就靜默回空陣列，而下游還是用肯定句
   * 對 agent 說「失敗項：…」。讀得懂輸出的是 agent，不是這裡——現在整份原始輸出直接交給它。
   *
   * 保留下來的 failingIds 只剩**種類碼**（redline / timeout / exec-error /
   * no-changes / unavailable / no-gates）：那些由驗證器自己產生，是封閉的列舉，
   * 不是從輸出猜出來的語意。它們各自的測試在下面。
   */

  /**
   * 「結果簽章」整段退場（第 14 片）。
   *
   * 它是無進展偵測的資料源：失敗關卡名 ＋ 從輸出撈到的失敗測試名，雜湊起來比對。
   * 撈失敗測試名那一半只認得三種格式（見上方說明），其餘一律空陣列——
   * 簽章因此退化成「哪幾條關卡是紅的」，於是 agent 每輪都在修不同的東西也會被判成空轉。
   *
   * 取代它的是輪數上限：數得清楚、不必猜語意，撞到時保留全部現場交人。
   */


  it('指令在指定 cwd 執行', async () => {
    const sub = dir.join('sub');
    mkdirSync(sub, { recursive: true });
    const gate = await verifier.check({ cwd: sub, config: { test: 'test "$(basename "$PWD")" = sub' } });
    assert.equal(gate.green, true);
  });

  // ── 指令逾時（缺陷 4：hang 住的 test/build 會永久凍結整個 daemon） ──

  describe('指令逾時', () => {
    it('指令跑不完 → 逾時終止、該關卡失敗，detail 說明原因', async () => {
      const t0 = Date.now();
      const gate = await verifier.check({ cwd: dir.path, config: { test: 'sleep 30', timeoutMs: 200 } });
      const elapsed = Date.now() - t0;

      assert.ok(elapsed < 10_000, `逾時必須真的中斷指令（實際等了 ${elapsed}ms）`);
      assert.equal(gate.green, false);
      assert.equal(gate.checks[0]?.ok, false);
      assert.match(gate.checks[0]?.detail ?? '', /逾時/);
      assert.match(gate.checks[0]?.detail ?? '', /200ms/);
      // 固定 id：反覆逾時時簽章要一致，無進展偵測才抓得到
      assert.deepEqual(gate.checks[0]?.failingIds, ['timeout']);
    });

    it('逾時兩次 → 簽章相同（不含耗時等變動內容）', async () => {
      const cfg = { test: 'sleep 30', timeoutMs: 150 };
      const a = await verifier.check({ cwd: dir.path, config: cfg });
      const b = await verifier.check({ cwd: dir.path, config: cfg });
      assert.equal(a.signature, b.signature);
    });

    it('daemon 層可設預設逾時；專案設定優先', async () => {
      const daemonWide = new Verifier(createSilentLogger(), { commandTimeoutMs: 200 });
      const a = await daemonWide.check({ cwd: dir.path, config: { test: 'sleep 30' } });
      assert.match(a.checks[0]?.detail ?? '', /逾時/);

      const b = await daemonWide.check({ cwd: dir.path, config: { test: 'sleep 30', timeoutMs: 100 } });
      assert.match(b.checks[0]?.detail ?? '', /100ms/);
    });

    it('正常結束的指令不受逾時影響', async () => {
      const gate = await verifier.check({ cwd: dir.path, config: { test: OK, timeoutMs: 30_000 } });
      assert.equal(gate.green, true);
    });

    it('指令連跑都跑不起來（cwd 不存在）→ 判紅且說得出原因（回饋不能是一片空白）', async () => {
      const gate = await verifier.check({ cwd: '/definitely/not/here', config: { test: OK } });

      assert.equal(gate.green, false, '沒驗到任何東西就不能算通過');
      assert.equal(gate.checks[0]?.ok, false);
      assert.match(gate.checks[0]?.detail ?? '', /無法執行/);
      assert.deepEqual(gate.checks[0]?.failingIds, ['exec-error']);
    });

    it('有內建預設逾時（不允許無限期等待）', () => {
      assert.ok(DEFAULT_COMMAND_TIMEOUT_MS > 0);
      assert.ok(DEFAULT_COMMAND_TIMEOUT_MS <= 30 * 60_000, '預設不該長到形同沒有逾時');
    });
  });
});

// ── diff 非空關卡（DoD；缺陷 1：agent 一行都沒改也會判綠 → complete_task 不可逆） ──

describe('Verifier — diff 非空關卡', () => {
  let repo: TmpGitRepo;
  let verifier: Verifier;

  beforeEach(() => {
    repo = createTmpGitRepo({ files: { 'a.txt': 'v1\n', '.gitignore': 'ignored/\n' } });
    verifier = new Verifier(createSilentLogger());
  });
  afterEach(() => repo.cleanup());

  /** 只跑 diff 關卡 + 一個必定綠的指令關卡（模擬「未改動的 repo 當然綠」）。 */
  const cfgWith = (baseRef: string) => ({ test: OK, diff: { baseRef } });

  it('零變更 → 不綠，且回饋是「尚未實作」而非把任務判失敗', async () => {
    const gate = await verifier.check({ cwd: repo.path, config: cfgWith(repo.head()) });

    assert.equal(gate.green, false, 'agent 什麼都沒改就不可能算完成');
    assert.equal(gate.checks[0]?.name, 'diff');
    assert.equal(gate.checks[0]?.ok, false);
    assert.deepEqual(gate.checks[0]?.failingIds, ['no-changes'], 'failingIds 必須是固定字串，否則簽章不穩');
    assert.match(gate.checks[0]?.detail ?? '', /沒有任何變更/);
    assert.match(gate.checks[0]?.detail ?? '', /ask_human/, '要告訴 agent 該怎麼辦，而不是只說失敗');
    // 零變更時後面的關卡結果必然與上一輪相同，不該再燒幾分鐘去跑
    assert.deepEqual(gate.checks.map((c) => c.name), ['diff']);
  });

  it('零變更兩輪 → 兩輪都給同一個種類碼，且與「測試紅」分得開', async () => {
    const cfg = cfgWith(repo.head());
    const a = await verifier.check({ cwd: repo.path, config: cfg });
    const b = await verifier.check({ cwd: repo.path, config: cfg });

    // 種類碼是驗證器自己產生的封閉列舉（不是從輸出猜的），下游靠它分辨
    // 「這一輪什麼都沒改」與「改了但測試紅」——那兩件事的處置完全不同。
    assert.deepEqual(a.checks[0]?.failingIds, ['no-changes']);
    assert.deepEqual(b.checks[0]?.failingIds, ['no-changes']);

    const redGate = await verifier.check({ cwd: repo.path, config: { test: fail(['not ok 1 - alpha']) } });
    assert.notDeepEqual(redGate.checks[0]?.failingIds, ['no-changes']);
  });

  it('修改既有檔案 → 算變更，其餘關卡照跑', async () => {
    const base = repo.head();
    repo.dir.write('a.txt', 'v2\n');

    const gate = await verifier.check({ cwd: repo.path, config: cfgWith(base) });
    assert.equal(gate.green, true);
    assert.deepEqual(gate.checks.map((c) => c.name), ['diff', 'test']);
    assert.match(gate.checks[0]?.detail ?? '', /1 個檔案/);
  });

  it('未追蹤的新檔案也算變更（新增檔案就是變更）', async () => {
    const base = repo.head();
    repo.dir.write('src/new-feature.ts', 'export const x = 1;\n');

    const gate = await verifier.check({ cwd: repo.path, config: cfgWith(base) });
    assert.equal(gate.green, true);
  });

  it('agent 自己 commit 了也算變更（比的是任務起點 HEAD，不是工作區乾不乾淨）', async () => {
    const base = repo.head();
    repo.commit({ 'b.txt': 'new\n' }, 'agent 自己提交');

    const gate = await verifier.check({ cwd: repo.path, config: cfgWith(base) });
    assert.equal(gate.green, true, '工作區乾淨不代表沒做事');
  });

  it('群內第二個任務：基準是本任務起點，前一個任務的 commit 不會被誤算', async () => {
    const groupStart = repo.head();
    repo.commit({ 'task1.txt': '前一個任務的成果\n' }, 'feat(T-1)');
    const task2Start = repo.head();

    // 正確基準：第二個任務什麼都沒做 → 擋下
    const correct = await verifier.check({ cwd: repo.path, config: cfgWith(task2Start) });
    assert.equal(correct.green, false);
    assert.deepEqual(correct.checks[0]?.failingIds, ['no-changes']);

    // 若誤用群分支起點當基準，同樣的「沒做事」會被判成有變更 → 這正是要避免的誤判
    const wrong = await verifier.check({ cwd: repo.path, config: cfgWith(groupStart) });
    assert.equal(wrong.green, true);
  });

  it('worktree 外的截圖不會被算成變更', async () => {
    const base = repo.head();
    const outside = createTmpDir('botone-shots-');
    try {
      outside.write('T-1/mobile-root.png', 'fake-png');
      const gate = await verifier.check({ cwd: repo.path, config: cfgWith(base) });
      assert.equal(gate.green, false, '截圖在 worktree 外，不該讓「diff 非空」變成綠燈');
    } finally {
      outside.cleanup();
    }
  });

  it('node_modules（GroupRunner 連結進來的）不算變更', async () => {
    const base = repo.head();
    repo.dir.write('node_modules/left-pad/index.js', 'module.exports = 1;\n');

    const gate = await verifier.check({ cwd: repo.path, config: cfgWith(base) });
    assert.equal(gate.green, false, '依賴目錄不是任務的成果');
  });

  it('git 判定失敗（不是 git 工作區）→ 保守擋下並用固定 failingId', async () => {
    const plain = createTmpDir('botone-not-a-repo-');
    try {
      const gate = await verifier.check({ cwd: plain.path, config: cfgWith('HEAD') });
      assert.equal(gate.green, false, '判定不了就不能放行——complete_task 之後 MCP 的 done 不可逆');
      assert.deepEqual(gate.checks[0]?.failingIds, ['unavailable']);
      assert.match(gate.checks[0]?.detail ?? '', /無法判定/);
    } finally {
      plain.cleanup();
    }
  });

  it('未帶 diff 設定（Merge Guard 重測）→ 完全不跑此關卡', async () => {
    const gate = await verifier.check({ cwd: repo.path, config: { test: OK } });
    assert.equal(gate.green, true, '合併前重測時工作區本來就乾淨，不該被 diff 關卡擋下');
    assert.deepEqual(gate.checks.map((c) => c.name), ['test']);
  });

  // ── 缺陷 3：專案沒設任何驗證指令時，不能永遠不綠也不能靜默 ──

  it('只有 diff 關卡且有變更 → 算綠，但報告明確標示「僅檢查有變更」', async () => {
    const base = repo.head();
    repo.dir.write('a.txt', 'v2\n');

    const gate = await verifier.check({ cwd: repo.path, config: { diff: { baseRef: base } } });

    assert.equal(gate.green, true, '沒設驗證指令時不能讓任務永遠跑不完');
    const note = gate.checks.find((c) => c.name === 'config');
    assert.equal(note?.ok, true);
    assert.match(note?.detail ?? '', /未設定任何驗證指令/);
  });

  it('只有 diff 關卡但零變更 → 仍不綠（弱驗證不代表免驗證）', async () => {
    const gate = await verifier.check({ cwd: repo.path, config: { diff: { baseRef: repo.head() } } });
    assert.equal(gate.green, false);
  });
});

// ── 關卡指令的部署紅線（缺陷 2：Verifier 以 shell 實跑 npm script，繞過工具層紅線） ──
//
// 安全注意：這裡的「部署指令」一律帶 --help。萬一修復被還原、指令真的被執行到，
// 也只會印出說明而不會部署任何東西——測試本身絕不能變成一次真實部署。

describe('Verifier — 關卡指令的部署紅線', () => {
  let dir: TmpDir;
  let verifier: Verifier;

  beforeEach(() => {
    dir = createTmpDir('botone-verifier-redline-');
    verifier = new Verifier(createSilentLogger());
  });
  afterEach(() => dir.cleanup());

  /** 寫一份只有 scripts 的 package.json。 */
  const pkg = (scripts: Record<string, string>): void => {
    dir.write('package.json', JSON.stringify({ name: 'victim', version: '1.0.0', scripts }, null, 2));
  };
  /** 被執行過的證據：script 只要真的跑起來就會留下這個檔。 */
  const RAN = 'ran.txt';
  const mark = `printf ran > ${RAN}`;
  const ran = (): boolean => existsSync(dir.join(RAN));

  it('npm run <script> 的 script 內含部署 → 拒絕執行、該關卡判紅', async () => {
    pkg({ build: `${mark} && firebase deploy --help` });

    const gate = await verifier.check({ cwd: dir.path, config: { build: 'npm run build' } });

    assert.equal(ran(), false, '命中紅線的關卡指令連跑都不能跑');
    assert.equal(gate.green, false);
    assert.equal(gate.checks[0]?.name, 'build');
    assert.equal(gate.checks[0]?.ok, false);
    assert.deepEqual(gate.checks[0]?.failingIds, ['redline'], 'failingIds 要固定，無進展偵測才抓得到');
    assert.match(gate.checks[0]?.detail ?? '', /紅線/);
    assert.match(gate.checks[0]?.detail ?? '', /firebase/, 'detail 要指出是哪一段踩線');
    assert.match(gate.checks[0]?.detail ?? '', /package\.json script/);
  });

  it('乾淨的 script 照常執行（不可過度攔截）', async () => {
    pkg({ build: mark });
    const gate = await verifier.check({ cwd: dir.path, config: { build: 'npm run build' } });

    assert.equal(gate.green, true);
    assert.equal(ran(), true, '沒踩紅線的關卡指令必須照跑');
  });

  it('巢狀 script（build → bundle → 部署）也擋得到，並指出呼叫鏈', async () => {
    pkg({ build: 'npm run bundle', bundle: `${mark} && vercel deploy --help` });

    const gate = await verifier.check({ cwd: dir.path, config: { build: 'npm run build' } });
    assert.equal(ran(), false);
    assert.equal(gate.green, false);
    assert.match(gate.checks[0]?.detail ?? '', /build → bundle/);
  });

  it('npm 的 post 鉤子（postbuild）也算「會被跑到的 script」', async () => {
    pkg({ build: mark, postbuild: 'gh-pages --help' });

    const gate = await verifier.check({ cwd: dir.path, config: { build: 'npm run build' } });
    assert.equal(ran(), false);
    assert.deepEqual(gate.checks[0]?.failingIds, ['redline']);
  });

  it('yarn/pnpm 省略 run 的寫法也解析得到', async () => {
    pkg({ build: `${mark} && netlify deploy --help` });
    const gate = await verifier.check({ cwd: dir.path, config: { build: 'yarn build' } });
    assert.equal(ran(), false);
    assert.deepEqual(gate.checks[0]?.failingIds, ['redline']);
  });

  it('關卡指令本身就是部署指令 → 直接拒絕（不必經過 package.json）', async () => {
    const gate = await verifier.check({ cwd: dir.path, config: { build: 'firebase deploy --help' } });
    assert.equal(gate.green, false);
    assert.deepEqual(gate.checks[0]?.failingIds, ['redline']);
  });

  it('沒有 package.json（非 Node 專案）→ 照常執行（優雅降級）', async () => {
    const gate = await verifier.check({ cwd: dir.path, config: { test: OK } });
    assert.equal(gate.green, true);
  });

  it('package.json 壞掉 → 不因此判紅，仍照常執行', async () => {
    dir.write('package.json', '{ 這不是 JSON');
    const gate = await verifier.check({ cwd: dir.path, config: { test: OK } });
    assert.equal(gate.green, true);
  });

  it('紅線判定本身唯讀且會終止（script 互相呼叫不會無限迴圈）', async () => {
    pkg({ a: 'npm run b', b: 'npm run a' });
    const verdict = await evaluateGateCommandRedline('npm run a', dir.path);
    assert.equal(verdict.deny, false);
  });

  it('超過展開層數的深層 script 屬已知限制（不宣稱滴水不漏）', async () => {
    pkg({ l1: 'npm run l2', l2: 'npm run l3', l3: 'npm run l4', l4: 'npm run l5', l5: 'firebase deploy --help' });
    const shallow = await evaluateGateCommandRedline('npm run l1', dir.path);
    // 目前只追 MAX_SCRIPT_DEPTH 層；這個斷言是「已知限制」的存證，改深度時要一起改
    assert.equal(shallow.deny, false);
    assert.equal((await evaluateGateCommandRedline('npm run l3', dir.path)).deny, true);
  });

  it('npm ci / install 這類子指令不會被誤認成 script', async () => {
    pkg({ ci: 'firebase deploy --help', install: 'firebase deploy --help' });
    assert.equal((await evaluateGateCommandRedline('npm ci', dir.path)).deny, false);
    assert.equal((await evaluateGateCommandRedline('npm install', dir.path)).deny, false);
    // 但 npm test 是內建別名，真的會跑同名 script
    pkg({ test: 'firebase deploy --help' });
    assert.equal((await evaluateGateCommandRedline('npm test', dir.path)).deny, true);
  });
});

/**
 * 「視覺關卡整合」與「截圖目錄」整段退場（第 15 片）。
 *
 * 那套量測堆疊（起 dev server、逐斷點截圖、算像素差、跑版面稽核、再交給 UiJudge 判斷）
 * 已由**審查者自己開瀏覽器去看**取代：它拿唯讀的瀏覽器工具、自己導頁、自己判斷，
 * 而且放行時必須填 uiChecked，空白會被退回（見 test/reviewer.test.ts）。
 *
 * 保留下來的是 decideVisualGate 與 resolveVisualDirs——那兩個講的是
 * 「這個專案的畫面在哪裡、截圖該落在哪」，審查者需要它們。
 */

describe('taskHintOf', () => {
  it('組出完整的 hint，baseRef 一定有', () => {
    const h = taskHintOf(
      { id: 'T-1', category: 'feature', title: '加按鈕', description: '描述' },
      { baseBranch: 'main' },
    );
    assert.deepEqual(h, {
      id: 'T-1', category: 'feature', title: '加按鈕', description: '描述', baseRef: 'origin/main',
    });
  });

  it('自訂 remote', () => {
    assert.equal(taskHintOf({ id: 'T-1' }, { baseBranch: 'develop', remote: 'upstream' }).baseRef, 'upstream/develop');
  });

  it('缺少的可選欄位不會變成 undefined 混進去', () => {
    const h = taskHintOf({ id: 'T-1' }, { baseBranch: 'main' });
    assert.deepEqual(Object.keys(h).sort(), ['baseRef', 'id']);
  });
});

/**
 * DoD 指令也要能被中止。daemon 收到 SIGTERM 時，一個跑了半小時的 `npm test`
 * 不該撐到寬限逾時然後被強制殺掉——那正是孤兒行程的來源之一。
 */
describe('Verifier — 中止訊號會停掉 DoD 指令', () => {
  it('signal abort → 指令被殺掉，且不會判成綠燈', async () => {
    const ac = new AbortController();
    const v = new Verifier(createSilentLogger());
    // 一個會跑很久的指令；100ms 後中止
    setTimeout(() => ac.abort(), 100);
    const r = await v.check({
      cwd: process.cwd(),
      config: { test: 'sleep 30' },
      signal: ac.signal,
    });
    assert.equal(r.green, false, '被中止的關卡不可以算通過');
  });

  it('沒傳 signal 時行為不變', async () => {
    const v = new Verifier(createSilentLogger());
    const r = await v.check({ cwd: process.cwd(), config: { test: 'exit 0' } });
    assert.equal(r.green, true);
  });
});
