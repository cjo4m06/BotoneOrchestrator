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
  type VisualVerifierLike,
} from '../src/worker/verifier.js';
import { VisualEnvironmentError, type VisualConfig, type VisualResult } from '../src/worker/visual.js';
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

  describe('failingIds 抽取與正規化', () => {
    it('抽出 TAP / 符號標記 / FAIL 三種格式', async () => {
      const gate = await verifier.check({
        cwd: dir.path,
        config: {
          test: fail(['not ok 1 - tap 案例', '✖ mark 案例', 'FAIL src/foo.test.ts']),
        },
      });

      const ids = gate.checks[0]?.failingIds ?? [];
      assert.deepEqual([...ids].sort(), ['mark 案例', 'src/foo.test.ts', 'tap 案例'].sort());
    });

    it('去掉耗時雜訊 (0.85ms) / (1.2s)，並濾掉區段標題', async () => {
      const gate = await verifier.check({
        cwd: dir.path,
        config: {
          test: fail(['✖ failing tests:', 'not ok 1 - alpha (0.85ms)', '✖ beta (1.2s)']),
        },
      });

      const ids = gate.checks[0]?.failingIds ?? [];
      assert.deepEqual([...ids].sort(), ['alpha', 'beta']);
      assert.ok(!ids.includes('failing tests:'), '區段標題不該被當成失敗項');
    });

    it('重複出現的同一失敗只計一次', async () => {
      const gate = await verifier.check({
        cwd: dir.path,
        config: { test: fail(['not ok 1 - alpha (1ms)', 'not ok 2 - alpha (9ms)']) },
      });
      assert.deepEqual(gate.checks[0]?.failingIds, ['alpha']);
    });

    it('通過的關卡不帶 failingIds', async () => {
      const gate = await verifier.check({ cwd: dir.path, config: { lint: OK } });
      assert.equal(gate.checks[0]?.failingIds, undefined);
    });
  });

  describe('結果簽章（無進展偵測的基礎）', () => {
    it('同一批失敗、只有耗時不同 → 簽章相同', async () => {
      const a = await verifier.check({
        cwd: dir.path,
        config: { test: fail(['not ok 1 - alpha (0.85ms)', 'not ok 2 - beta (3.10ms)']) },
      });
      const b = await verifier.check({
        cwd: dir.path,
        config: { test: fail(['not ok 1 - alpha (91.4ms)', 'not ok 2 - beta (1.2s)']) },
      });

      assert.equal(a.green, false);
      assert.equal(a.signature, b.signature);
    });

    it('失敗項順序不同 → 簽章仍相同（有排序正規化）', async () => {
      const a = await verifier.check({
        cwd: dir.path,
        config: { test: fail(['not ok 1 - alpha', 'not ok 2 - beta']) },
      });
      const b = await verifier.check({
        cwd: dir.path,
        config: { test: fail(['not ok 1 - beta', 'not ok 2 - alpha']) },
      });
      assert.equal(a.signature, b.signature);
    });

    it('失敗內容改變 → 簽章改變（代表有進展）', async () => {
      const a = await verifier.check({ cwd: dir.path, config: { test: fail(['not ok 1 - alpha']) } });
      const b = await verifier.check({ cwd: dir.path, config: { test: fail(['not ok 1 - gamma']) } });
      assert.notEqual(a.signature, b.signature);
    });

    it('同一批失敗但發生在不同關卡 → 簽章不同', async () => {
      const a = await verifier.check({ cwd: dir.path, config: { lint: fail(['not ok 1 - alpha']) } });
      const b = await verifier.check({ cwd: dir.path, config: { test: fail(['not ok 1 - alpha']) } });
      assert.notEqual(a.signature, b.signature);
    });

    it('由紅轉綠 → 簽章改變', async () => {
      const red = await verifier.check({ cwd: dir.path, config: { test: fail(['not ok 1 - alpha']) } });
      const green = await verifier.check({ cwd: dir.path, config: { test: OK } });
      assert.notEqual(red.signature, green.signature);
    });
  });

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

  it('零變更兩輪 → 簽章相同（無進展偵測抓得到空轉）', async () => {
    const cfg = cfgWith(repo.head());
    const a = await verifier.check({ cwd: repo.path, config: cfg });
    const b = await verifier.check({ cwd: repo.path, config: cfg });
    assert.equal(a.signature, b.signature);
    // 與「測試紅」要區分得開
    const redGate = await verifier.check({ cwd: repo.path, config: { test: fail(['not ok 1 - alpha']) } });
    assert.notEqual(a.signature, redGate.signature);
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

// ── 視覺關卡整合（一律注入假 VisualVerifier：單元測試不開瀏覽器、不啟 dev server） ──

function visualResult(over: Partial<VisualResult> = {}): VisualResult {
  return { status: 'ok', checks: [], screenshots: [], metrics: [], diffs: [], ...over };
}

/** 模擬 VisualVerifier 因環境缺件而跳過（附一條 ok:true 的說明 check）。 */
function skippedVisual(reason = '瀏覽器無法啟動'): VisualResult {
  return visualResult({
    status: 'skipped',
    skipReason: reason,
    checks: [{ name: 'visual', ok: true, detail: `跳過：${reason}` }],
  });
}

function failedVisual(checks: CheckResult[], screenshots: string[] = []): VisualResult {
  return visualResult({ status: 'failed', checks, screenshots });
}

interface FakeVisual extends VisualVerifierLike {
  calls: Array<{ cwd: string; config: VisualConfig }>;
}

function fakeVisual(result: VisualResult | (() => Promise<VisualResult>)): FakeVisual {
  const calls: Array<{ cwd: string; config: VisualConfig }> = [];
  return {
    calls,
    async verify(input) {
      calls.push(input);
      return typeof result === 'function' ? await result() : result;
    },
  };
}

const OK_CMDS = { typecheck: OK, test: OK };
const VISUAL: VisualGateConfig = { devServer: 'npm run dev', routes: ['/'] };

describe('Verifier — 視覺關卡整合', () => {
  let dir: TmpDir;
  before(() => { dir = createTmpDir('botone-verifier-visual-'); });
  after(() => dir.cleanup());

  const build = (
    result: VisualResult | (() => Promise<VisualResult>) = visualResult(),
    onVisualError?: VerifierDeps['onVisualError'],
  ) => {
    const visual = fakeVisual(result);
    return { visual, verifier: new Verifier(createSilentLogger(), { visual, onVisualError }) };
  };

  describe('觸發判定（沒需要就完全不啟瀏覽器）', () => {
    it('未設定 visual → 不呼叫視覺驗證，報告與純指令關卡相同', async () => {
      const { visual, verifier } = build();
      const gate = await verifier.check({ cwd: dir.path, config: OK_CMDS });

      assert.equal(visual.calls.length, 0);
      assert.deepEqual(gate.checks.map((c) => c.name), ['typecheck', 'test']);
      assert.equal(gate.green, true);
      assert.equal(gate.screenshots, undefined);
    });

    it('有 devServer 但沒列 routes → 跳過（專案沒 opt-in 視覺驗證）', async () => {
      const { visual, verifier } = build();
      const gate = await verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: { devServer: 'npm run dev' } } });
      assert.equal(visual.calls.length, 0);
      assert.equal(gate.green, true);
    });

    it('when=never → 跳過；when=always → 不看任務類別都跑', async () => {
      const never = build();
      await never.verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: { ...VISUAL, when: 'never' } } });
      assert.equal(never.visual.calls.length, 0);

      const always = build();
      await always.verifier.check({
        cwd: dir.path,
        config: { ...OK_CMDS, visual: { ...VISUAL, when: 'always' } },
        task: { id: 'T-1', category: 'bug' },
      });
      assert.equal(always.visual.calls.length, 1);
    });

    it('when=auto：design 任務才跑，其他類別略過', async () => {
      const design = build();
      await design.verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL }, task: { id: 'T-1', category: 'design' } });
      assert.equal(design.visual.calls.length, 1);

      const bug = build();
      await bug.verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL }, task: { id: 'T-2', category: 'bug' } });
      assert.equal(bug.visual.calls.length, 0);
    });

    it('誤殺豁免設定（ignoreSelectors/thresholds/animationSettleMs）會原封不動送到 VisualVerifier', async () => {
      // 這些旋鈕是「不改被驗專案原始碼也能豁免」的唯一出口（D18）。
      // stripGateOnly 只該拿掉 Verifier 專用欄位，把它們一起刪掉會讓豁免默默失效。
      const { visual, verifier } = build();
      await verifier.check({
        cwd: dir.path,
        config: {
          ...OK_CMDS,
          visual: {
            ...VISUAL,
            ignoreSelectors: ['.legacy-widget'],
            animationSettleMs: 5000,
            thresholds: { strictStyleChecks: true, maxOverlapRatio: 0.7 },
            when: 'always',
          },
        },
      });
      const cfg = visual.calls[0]?.config;
      assert.ok(cfg);
      assert.deepEqual(cfg.ignoreSelectors, ['.legacy-widget']);
      assert.equal(cfg.animationSettleMs, 5000);
      assert.deepEqual(cfg.thresholds, { strictStyleChecks: true, maxOverlapRatio: 0.7 });
      // 反過來，Verifier 專用欄位不該外洩給 VisualVerifier
      assert.equal((cfg as Record<string, unknown>)['when'], undefined);
    });

    it('when=auto 且呼叫端沒帶任務（Merge Guard 重測）→ 仍會跑', async () => {
      const { visual, verifier } = build();
      await verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });
      assert.equal(visual.calls.length, 1);
    });

    it('指令關卡已經紅了 → 不跑視覺（dev server 多半也起不來，先修該修的）', async () => {
      const { visual, verifier } = build();
      const gate = await verifier.check({
        cwd: dir.path,
        config: { typecheck: fail(['not ok 1 - alpha']), visual: VISUAL },
      });
      assert.equal(visual.calls.length, 0);
      assert.equal(gate.green, false);
      assert.deepEqual(gate.checks.map((c) => c.name), ['typecheck']);
    });

    it('decideVisualGate 的純規則（免跑指令）', () => {
      assert.equal(decideVisualGate(undefined).run, false);
      assert.equal(decideVisualGate({ routes: ['/'] }).run, false, '沒 devServer 不跑');
      assert.equal(decideVisualGate({ devServer: 'x', routes: [] }).run, false, '沒 routes 不跑');
      assert.equal(decideVisualGate(VISUAL).run, true);
      assert.equal(decideVisualGate(VISUAL, { category: 'design' }).run, true);
      assert.equal(decideVisualGate(VISUAL, { category: 'dev' }).run, false);
      assert.equal(decideVisualGate({ ...VISUAL, categories: ['dev', 'design'] }, { category: 'dev' }).run, true);
    });
  });

  describe('結果併入 GateReport', () => {
    it('視覺全綠 → checks 併在指令關卡之後，screenshots 填入報告', async () => {
      const shots = ['/data/screenshots/T-1/mobile-root.png', '/data/screenshots/T-1/desktop-root.png'];
      const { verifier } = build(
        visualResult({
          checks: [
            { name: 'visual:navigate', ok: true, detail: '3 個頁面皆成功載入' },
            { name: 'visual:overflow-x', ok: true, detail: '無橫向溢出' },
          ],
          screenshots: shots,
        }),
      );

      const gate = await verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL }, task: { id: 'T-1', category: 'design' } });

      assert.deepEqual(gate.checks.map((c) => c.name), ['typecheck', 'test', 'visual:navigate', 'visual:overflow-x']);
      assert.equal(gate.green, true);
      assert.deepEqual(gate.screenshots, shots);
    });

    it('頁面爆版 → green 轉紅，失敗細節可回灌給 agent', async () => {
      const { verifier } = build(
        failedVisual([
          { name: 'visual:navigate', ok: true, detail: 'ok' },
          { name: 'visual:overflow-x', ok: false, detail: 'mobile/ 橫向溢出 145px', failingIds: ['mobile/::document'] },
        ]),
      );

      const gate = await verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });

      assert.equal(gate.green, false, '指令關卡全綠但版面爆掉 → 不算完成');
      assert.match(gate.checks.find((c) => c.name === 'visual:overflow-x')?.detail ?? '', /橫向溢出/);
    });

    it('環境缺件（skipped）→ 併入說明 check 但 DoD 不變紅', async () => {
      const { verifier } = build(skippedVisual('playwright 未安裝'));
      const gate = await verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });

      assert.equal(gate.green, true);
      assert.match(gate.checks.at(-1)?.detail ?? '', /playwright 未安裝/);
    });

    // 這組取代原本「視覺驗證丟例外 → 一律視為跳過（綠）」的案例。原行為是把「量測端壞掉」
    // 誤判成通過的放大器：爆版頁面只要讓量測程式丟例外就能過關，所以那個斷言必須改。
    describe('視覺關卡丟例外：環境缺件 vs 執行期例外', () => {
      it('量測端自己爆炸（一般例外）→ 判紅，絕不靜默綠燈', async () => {
        const { verifier } = build(async () => { throw new Error('量測腳本回傳 undefined'); });
        const gate = await verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });

        assert.equal(gate.green, false, '沒驗到任何頁面就不能算通過');
        const last = gate.checks.at(-1);
        assert.equal(last?.ok, false);
        assert.match(last?.detail ?? '', /量測腳本回傳 undefined/);
        assert.match(last?.detail ?? '', /不是頁面本身的問題/, '要講清楚不是專案程式碼的錯，別讓 agent 亂改');
        assert.deepEqual(last?.failingIds, ['visual-error'], 'failingIds 必須固定，否則無進展偵測抓不到');
      });

      it('執行期例外會通知（這種故障 agent 修不好，要讓人知道）', async () => {
        const seen: Array<{ cwd: string; detail: string }> = [];
        const { verifier } = build(async () => { throw new Error('chromium 崩潰'); }, (info) => { seen.push(info); });
        await verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });

        assert.equal(seen.length, 1);
        assert.equal(seen[0]?.cwd, dir.path);
        assert.match(seen[0]?.detail ?? '', /chromium 崩潰/);
      });

      it('沒注入通知鉤子 / 鉤子自己丟錯 → 判定不受影響（優雅降級）', async () => {
        const noHook = await build(async () => { throw new Error('boom'); }).verifier.check({
          cwd: dir.path,
          config: { ...OK_CMDS, visual: VISUAL },
        });
        assert.equal(noHook.green, false);

        const badHook = build(async () => { throw new Error('boom'); }, () => { throw new Error('slack 掛了'); });
        const gate = await badHook.verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });
        assert.equal(gate.green, false);
        assert.equal(gate.checks.at(-1)?.ok, false);
      });

      it('環境缺件例外（VisualEnvironmentError）→ 跳過且不變紅，detail 標明是環境', async () => {
        const { verifier } = build(async () => { throw new VisualEnvironmentError('這台機器沒有瀏覽器'); });
        const gate = await verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });

        assert.equal(gate.green, true, '沒有瀏覽器的環境不該被誤殺');
        const last = gate.checks.at(-1);
        assert.equal(last?.ok, true);
        assert.match(last?.detail ?? '', /環境缺件/);
        assert.match(last?.detail ?? '', /這台機器沒有瀏覽器/);
      });

      it('訊息看得出是環境缺件（沒下載瀏覽器）→ 也跳過', async () => {
        const { verifier } = build(async () => { throw new Error("Executable doesn't exist at /ms-playwright/chromium"); });
        const gate = await verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });
        assert.equal(gate.green, true);
        assert.equal(gate.checks.at(-1)?.ok, true);
      });

      it('環境缺件不通知（那不是故障，只是這台機器沒裝）', async () => {
        let notified = 0;
        const { verifier } = build(async () => { throw new VisualEnvironmentError('playwright 未安裝'); }, () => { notified += 1; });
        await verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });
        assert.equal(notified, 0);
      });

      it('執行期例外反覆發生 → 簽章相同，且與「頁面爆版」的簽章不同', async () => {
        const a = await build(async () => { throw new Error('崩潰 A'); }).verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });
        const b = await build(async () => { throw new Error('崩潰 B（訊息不同）'); }).verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });
        assert.equal(a.signature, b.signature, '錯誤訊息不可進簽章，否則無進展偵測失效');

        const overflow = await build(
          failedVisual([{ name: 'visual:overflow-x', ok: false, detail: 'x', failingIds: ['mobile/::document'] }]),
        ).verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });
        assert.notEqual(a.signature, overflow.signature);
      });
    });

    it('視覺回報 failed 卻沒給任何失敗明細 → 補一條紅（契約不一致不可靜默通過）', async () => {
      const { verifier } = build(failedVisual([{ name: 'visual:navigate', ok: true, detail: 'ok' }]));
      const gate = await verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });

      assert.equal(gate.green, false, '說失敗就不能算通過，哪怕明細是空的');
      assert.equal(gate.checks.at(-1)?.ok, false);
      assert.deepEqual(gate.checks.at(-1)?.failingIds, ['visual-error']);
    });

    it('只有視覺且被跳過 → 仍視為未綠（空驗證不算通過），並附上設定缺漏說明', async () => {
      const { verifier } = build(skippedVisual());
      const gate = await verifier.check({ cwd: dir.path, config: { visual: VISUAL } });
      assert.equal(gate.green, false);
      // 視覺跳過的說明 check + 「沒有任何可執行關卡」的設定回饋
      assert.deepEqual(gate.checks.map((c) => c.name), ['visual', 'config']);
      assert.equal(gate.checks[1]?.ok, false);
    });

    it('只有視覺但真的跑起來且全綠 → 算綠（有實際驗到東西）', async () => {
      const { verifier } = build(visualResult({ checks: [{ name: 'visual:navigate', ok: true, detail: 'ok' }] }));
      const gate = await verifier.check({ cwd: dir.path, config: { visual: VISUAL } });
      assert.equal(gate.green, true);
    });
  });

  describe('簽章穩定性（無進展偵測的基礎）', () => {
    const overflow = (detail: string): VisualResult =>
      failedVisual([{ name: 'visual:overflow-x', ok: false, detail, failingIds: ['mobile/::document'] }]);

    it('同一批視覺問題、detail 的像素/百分比不同 → 簽章相同', async () => {
      const a = await build(overflow('溢出 145px')).verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });
      const b = await build(overflow('溢出 146.4px（差異 3.71%）')).verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });

      assert.equal(a.green, false);
      assert.equal(a.signature, b.signature);
    });

    it('視覺失敗項改變 → 簽章改變（代表有進展）', async () => {
      const a = await build(overflow('x')).verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });
      const b = await build(
        failedVisual([{ name: 'visual:overflow-x', ok: false, detail: 'x', failingIds: ['desktop/::document'] }]),
      ).verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });
      assert.notEqual(a.signature, b.signature);
    });

    it('視覺紅 vs 只有指令紅 → 簽章不同（簽章確實吃到視覺結果）', async () => {
      const withVisual = await build(overflow('x')).verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });
      const cmdOnly = await build().verifier.check({ cwd: dir.path, config: OK_CMDS });
      assert.notEqual(withVisual.signature, cmdOnly.signature);
    });

    it('跳過的視覺說明 check 不影響簽章', async () => {
      const skipped = await build(skippedVisual()).verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });
      const none = await build().verifier.check({ cwd: dir.path, config: OK_CMDS });
      assert.equal(skipped.signature, none.signature);
    });
  });

  describe('截圖目錄（不可落在 worktree 內）', () => {
    it('預設目錄在 worktree 外，並依任務 id 分層', async () => {
      const { visual, verifier } = build();
      await verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL }, task: { id: 'T-42', category: 'design' } });

      const passed = visual.calls[0]?.config.screenshotDir ?? '';
      assert.ok(isAbsolute(passed), `截圖目錄必須是絕對路徑：${passed}`);
      assert.ok(passed.endsWith('T-42'), passed);
      assert.ok(relative(dir.path, passed).startsWith('..'), `截圖不可寫進 worktree：${passed}`);
    });

    it('設定不慎指進 worktree → 自動改導到 worktree 外', () => {
      const dirs = resolveVisualDirs({
        cwd: dir.path,
        config: { ...VISUAL, screenshotRoot: dir.join('shots'), baselineRoot: dir.join('baseline') },
        key: 'T-1',
      });
      assert.ok(relative(dir.path, dirs.screenshotDir).startsWith('..'), dirs.screenshotDir);
      assert.ok(relative(dir.path, dirs.baselineDir ?? '').startsWith('..'), dirs.baselineDir);
    });

    it('未設 baselineRoot → 不傳 baselineDir（等於不做視覺回歸）', async () => {
      const { visual, verifier } = build();
      await verifier.check({ cwd: dir.path, config: { ...OK_CMDS, visual: VISUAL } });
      assert.equal(visual.calls[0]?.config.baselineDir, undefined);
    });

    it('baselineRoot 不依任務分層（基準要跨任務沿用），且 Verifier 專用欄位不外流', async () => {
      const { visual, verifier } = build();
      await verifier.check({
        cwd: dir.path,
        config: { ...OK_CMDS, visual: { ...VISUAL, screenshotRoot: '/tmp/botone-shots', baselineRoot: '/tmp/botone-base', maxDiffRatio: 0.05 } },
        task: { id: 'T-7', category: 'design' },
      });

      const cfg = visual.calls[0]?.config as (VisualConfig & Record<string, unknown>) | undefined;
      assert.equal(cfg?.baselineDir, '/tmp/botone-base');
      assert.equal(cfg?.screenshotDir, '/tmp/botone-shots/T-7');
      assert.equal(cfg?.maxDiffRatio, 0.05, '一般旋鈕要原樣傳給 VisualVerifier');
      for (const k of ['screenshotRoot', 'baselineRoot', 'when', 'categories']) {
        assert.ok(!(k in (cfg ?? {})), `${k} 是 Verifier 專用欄位，不該傳進 VisualVerifier`);
      }
    });
  });
});

// ── taskHintOf：把「別漏傳欄位」變成型別能保證的事 ──

/**
 * 同一個疏漏犯過三次（group-runner 的 Merge Guard、orchestrator 的合併路徑、重做迴圈），
 * 每次都是自己拼 task 欄位時漏掉 baseRef，症狀都一樣難查：
 * 介面判斷者沒有唯讀 git → 分不出新舊問題 → 把既有瑕疵算到這次頭上。
 * 集中成一個函式，呼叫端就沒有漏的機會。
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
