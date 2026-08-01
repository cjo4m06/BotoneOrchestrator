/**
 * 完整流程 e2e（**真實 GitHub**）：每次建一個臨時 repo，跑完整條鏈路，測完刪掉。
 *
 * 與 e2e-daemon 的差別：那支用本地 git repo + 假 PrManager，驗的是調度邏輯；
 * 這支用**真的 GitHub repo**，因此連 `gh pr create` / `gh pr merge` / Review Watcher
 * 這些只有對著真實 GitHub 才會暴露的問題（權限、分支保護、PR 狀態機）都會被驗到。
 *
 * 只有「任務來源」是假的（FakeMcp，照真實 pmm MCP 的回應格式），其餘全是 src/ 的真實模組。
 *
 *   npm run test:e2e                 # scripted agent（真的寫檔）——快、免費、可重複
 *   npm run test:e2e -- --live       # 真 AgentRuntime（需 .env 的 Claude 認證）
 *   npm run test:e2e -- --ephemeral  # 每次建/刪臨時 repo（需 delete_repo 權限）
 *   npm run test:e2e -- --keep       # 保留本地工作目錄供事後檢視
 *
 * 前置：`gh auth status` 要是已登入狀態，token 有 `repo` 權限即可。
 *
 * **預設用固定 repo（orch-e2e-fixture，可用 ORCH_E2E_REPO 覆寫）**，每次跑之前重置：
 * 關掉殘留 PR、刪掉殘留分支、force push 覆寫 main。這樣不會累積垃圾 repo，
 * 也不必把 `delete_repo`（能刪掉你**任何** repo）留在 token 上。
 */
import { execa } from 'execa';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../src/observability/logger.js';
import { loadEnv } from '../src/config/env.js';
import { Ledger } from '../src/store/ledger.js';
import { Poller, type PollSource } from '../src/core/poller.js';
import { Planner } from '../src/core/planner.js';
import { Dispatcher } from '../src/core/dispatcher.js';
import { GroupRunner, type ProjectRuntime } from '../src/core/group-runner.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { Verifier } from '../src/worker/verifier.js';
import { AgentRuntime } from '../src/worker/agent-runtime.js';
import { PrManager } from '../src/pr/pr-manager.js';
import { MergeGuard } from '../src/pr/merge-guard.js';
import { ReviewFeedbackStore, ReviewWatcher } from '../src/pr/review-watcher.js';
import { InboundRouter, ConsoleNotifier } from '../src/notify/notifier.js';
import { PolicyEngine, readDiffStat } from '../src/policy/policy-engine.js';
import type { AgentLike, McpReadClient, McpTaskClient } from '../src/contracts.js';
import type { IterateInput, IterateResult, LoadedDoc } from '../src/worker/agent-runtime.js';
import type { ClarificationAnswer, McpOut, TaskBrief, TaskDetail } from '../src/types.js';
import type { ExtendedControlCommand } from '../src/notify/notifier.js';

const LIVE = process.argv.includes('--live');
const KEEP = process.argv.includes('--keep');

/**
 * 目標 repo 的取得方式：
 *   預設（推薦）＝**重複使用一個固定 repo，每次跑之前重置**。只需要 `repo` 權限，
 *     不會累積垃圾 repo，也不必把 `delete_repo` 這種能刪掉你任何 repo 的權限留在 token 上。
 *   --ephemeral ＝每次建一個臨時 repo、測完刪掉（需要 `delete_repo`）。
 *
 * 固定 repo 名稱可用 ORCH_E2E_REPO 覆寫（給 owner/name 或只給 name）。
 */
const EPHEMERAL = process.argv.includes('--ephemeral');
const FIXED_REPO = process.env.ORCH_E2E_REPO ?? 'orch-e2e-fixture';
/**
 * 整體時間上限（毫秒）。**不用 tick 數當上限**：真 agent 跑一個任務要數分鐘，
 * 而 tick 本身很快，用次數當上限會在任務還沒 park／還沒被回覆時就停止模擬人，
 * 把「agent 正確判定無需改動、等人確認」這種合法情境誤判成測試失敗（實測撞到）。
 */
const DEADLINE_MS = Number(process.env.E2E_DEADLINE_MS ?? (LIVE ? 20 * 60_000 : 5 * 60_000));

const log = createLogger();
const ROOT = `/tmp/orch-live-e2e-${process.pid}`;
const BASE_BRANCH = 'main';

/** 臨時 repo 名稱：帶時間戳避免撞名，前綴固定方便人工清理。 */
const REPO_NAME = `orch-e2e-${Date.now().toString(36)}`;

// ────────────────────────────────────────────────────────────────────────
// 驗證結果收集
// ────────────────────────────────────────────────────────────────────────

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function note(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  log[ok ? 'info' : 'error']({ detail }, `${ok ? '✅' : '❌'} ${name}`);
}

// ────────────────────────────────────────────────────────────────────────
// 1) 臨時 GitHub repo
// ────────────────────────────────────────────────────────────────────────

interface TempRepo {
  /** owner/name */
  full: string;
  localPath: string;
  /**
   * 開始跑之前 repo 上的最大 PR 編號。
   * 固定 repo 會累積歷史 PR（關掉的、已合併的都還在），驗收若用 `--state all` 全撈，
   * 會把前幾次執行的 PR 算成這次的成果（實測看到 PR 數=11）。
   */
  prBaseline: number;
}

const gh = (args: string[], cwd?: string) => execa('gh', args, { ...(cwd ? { cwd } : {}), reject: false });
const git = (cwd: string, args: string[]) => execa('git', ['-C', cwd, ...args], { reject: false });

/**
 * 需要對 GitHub 認證的 git 操作（push / ls-remote）。
 *
 * 用 `-c credential.helper='!gh auth git-credential'` 借用 gh 已經有的登入狀態，
 * **只在這一次指令生效**——不像 `gh auth setup-git` 會改動使用者的 git 全域設定。
 * 不這樣做的話，https remote 在沒有 credential helper 的環境會直接卡在
 * 「could not read Username」（實測撞到兩次）。
 */
const gitAuthed = (cwd: string, args: string[]) =>
  execa('git', ['-C', cwd, '-c', 'credential.helper=!gh auth git-credential', ...args], { reject: false });

async function ghOwner(): Promise<string> {
  const r = await gh(['api', 'user', '--jq', '.login']);
  if (r.exitCode !== 0) throw new Error(`取不到 GitHub 帳號（gh 未登入？）：${r.stderr}`);
  return r.stdout.trim();
}

/** 準備目標 repo：固定模式會重置既有 repo（不存在就建），臨時模式每次建新的。 */
async function prepareRepo(): Promise<TempRepo> {
  const owner = await ghOwner();
  const full = EPHEMERAL
    ? `${owner}/${REPO_NAME}`
    : FIXED_REPO.includes('/')
      ? FIXED_REPO
      : `${owner}/${FIXED_REPO}`;
  const localPath = join(ROOT, 'repo');
  mkdirSync(localPath, { recursive: true });

  writeFileSync(
    join(localPath, 'package.json'),
    `${JSON.stringify(
      {
        name: 'orch-e2e-fixture',
        version: '0.0.0',
        private: true,
        scripts: {
          build: "node -e \"console.log('build ok')\"",
          test: 'node --test',
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(localPath, 'README.md'), '# orch e2e fixture\n\n臨時測試專案，測完會被刪除。\n');
  writeFileSync(join(localPath, 'sum.js'), 'function sum(a, b) {\n  return a + b;\n}\nmodule.exports = { sum };\n');
  writeFileSync(
    join(localPath, 'sum.test.js'),
    "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\n\ntest('sum adds', () => {\n  assert.equal(sum(1, 2), 3);\n});\n",
  );

  await git(localPath, ['init', '-q', '-b', BASE_BRANCH]);
  await git(localPath, ['config', 'user.email', 'orch-e2e@local']);
  await git(localPath, ['config', 'user.name', 'orch-e2e']);
  await git(localPath, ['add', '-A']);
  await git(localPath, ['commit', '-qm', 'init fixture']);

  const exists = (await gh(['repo', 'view', full, '--json', 'name'])).exitCode === 0;
  if (!exists) {
    // --source 會一併設定 remote 並推送
    const created = await gh(['repo', 'create', full, '--private', '--source', localPath, '--push']);
    if (created.exitCode !== 0) throw new Error(`建立 repo 失敗：${created.stderr}`);
    // 打上身分標記：重置（force push / 刪分支）前會驗它，確保只動我們自己建的測試 repo
    const marked = await gh(['repo', 'edit', full, '--add-topic', MARKER_TOPIC, '--description', MARKER_DESC]);
    if (marked.exitCode !== 0) {
      throw new Error(
        `無法為測試 repo 打上標記（${MARKER_TOPIC}）：${marked.stderr}\n` +
          '沒有標記的話，之後的重置無法確認「這確實是測試 repo」，為安全起見中止。',
      );
    }
    log.info({ repo: full, mode: EPHEMERAL ? 'ephemeral' : 'fixed' }, '已建立並標記 GitHub repo');
    return { full, localPath, prBaseline: 0 };
  }

  // 既有 repo：**必須**帶著我們的標記才准動它
  await assertIsTestRepo(full);

  // 既有 repo（固定模式）：重置成乾淨的初始狀態。
  // 只用得到 `repo` 權限——關掉 PR、刪分支、force push 覆蓋 main，全都不需要 delete_repo。
  await resetRepo(full, localPath);
  return { full, localPath, prBaseline: await maxPrNumber(full) };
}

/** 目前 repo 上的最大 PR 編號（含已關閉/已合併）；沒有 PR 回 0。 */
async function maxPrNumber(full: string): Promise<number> {
  const r = await gh(['pr', 'list', '--repo', full, '--state', 'all', '--json', 'number', '--limit', '100']);
  if (r.exitCode !== 0) return 0;
  const nums = (JSON.parse(r.stdout || '[]') as { number: number }[]).map((p) => p.number);
  return nums.length > 0 ? Math.max(...nums) : 0;
}

/**
 * 測試 repo 的身分標記。重置會做 force push 與刪分支，**在錯的 repo 上執行等於毀掉別人的工作**
 * （遠端被 force push 覆蓋掉的 commit 沒有 reflog 可救）。
 * 光靠名稱像不像測試 repo 不夠——名稱可以打錯、也可能撞名，所以改成驗證「這是我們建的」：
 * 建立時打 topic，重置前確認 topic 存在，否則一律中止。
 */
const MARKER_TOPIC = 'orch-e2e-fixture';
const MARKER_DESC = '自動化測試用的臨時 repo（orchestrator e2e）。內容會被每次測試覆寫。';

/** 沒有標記就拒絕動它——這是 force push 前的最後一道防線。 */
async function assertIsTestRepo(full: string): Promise<void> {
  const r = await gh(['repo', 'view', full, '--json', 'repositoryTopics,isPrivate,name']);
  if (r.exitCode !== 0) throw new Error(`無法讀取 repo 資訊：${r.stderr}`);
  const info = JSON.parse(r.stdout) as {
    repositoryTopics?: { name: string }[] | null;
    isPrivate?: boolean;
  };
  const topics = (info.repositoryTopics ?? []).map((t) => t.name);
  if (!topics.includes(MARKER_TOPIC)) {
    throw new Error(
      `拒絕操作 ${full}：找不到測試標記 topic「${MARKER_TOPIC}」。\n` +
        '重置會 force push 覆寫 main 並刪除分支，在非測試 repo 上執行會毀掉真實工作，因此中止。\n' +
        `若這確實是你要用的測試 repo，請先執行：gh repo edit ${full} --add-topic ${MARKER_TOPIC}`,
    );
  }
  if (info.isPrivate === false) {
    throw new Error(`拒絕操作 ${full}：測試 repo 必須是 private（避免誤用公開 repo）。`);
  }
  log.info({ repo: full }, '已確認是帶標記的測試 repo');
}

/** 依 gh 設定的協定組出可推送的 remote URL。 */
async function remoteUrl(full: string): Promise<string> {
  const proto = (await gh(['config', 'get', 'git_protocol'])).stdout.trim();
  return proto === 'ssh' ? `git@github.com:${full}.git` : `https://github.com/${full}.git`;
}

/** 把固定測試 repo 重置成「剛建好」的樣子：關掉舊 PR、刪掉舊分支、main 覆寫成初始 commit。 */
async function resetRepo(full: string, localPath: string): Promise<void> {
  log.info({ repo: full }, '重置既有測試 repo（關 PR、刪分支、覆寫 main）');

  // 1) 關掉所有還開著的 PR，否則下次跑會把上一輪的 PR 算進驗收
  const list = await gh(['pr', 'list', '--repo', full, '--state', 'open', '--json', 'number', '--limit', '50']);
  const open = list.exitCode === 0 ? (JSON.parse(list.stdout || '[]') as { number: number }[]) : [];
  for (const pr of open) {
    await gh(['pr', 'close', String(pr.number), '--repo', full, '--comment', '測試重置：關閉上一輪的 PR']);
  }
  if (open.length > 0) log.info({ closed: open.length }, '已關閉殘留的 PR');

  // remote URL 要照 gh 設定的協定：寫死 https 的話，沒設 credential helper 的環境會卡在
  // 「could not read Username」（實測撞到）。ssh 是 gh 的常見預設，https 則交給 gh 的 helper。
  await git(localPath, ['remote', 'add', 'origin', await remoteUrl(full)]);
  // force push 覆寫 main（本地已經是剛建好的初始 commit）
  const pushed = await gitAuthed(localPath, ['push', '--force', 'origin', `${BASE_BRANCH}:${BASE_BRANCH}`]);
  if (pushed.exitCode !== 0) throw new Error(`重置 main 失敗：${pushed.stderr}`);

  // 2) 刪掉上一輪留下的 orch/* 分支（PR 關掉後分支仍在）
  const branches = await gitAuthed(localPath, ['ls-remote', '--heads', 'origin']);
  const stale = branches.stdout
    .split('\n')
    .map((l) => l.split('refs/heads/')[1])
    .filter((b): b is string => Boolean(b) && b !== BASE_BRANCH);
  for (const b of stale) await gitAuthed(localPath, ['push', 'origin', '--delete', b]);
  if (stale.length > 0) log.info({ deleted: stale.length }, '已刪除殘留分支');
}

/** 只有臨時模式才刪 repo；固定模式留著給下次重置用。 */
async function cleanupRepo(repo: TempRepo): Promise<void> {
  if (!EPHEMERAL) {
    log.info({ repo: repo.full }, '固定模式：保留測試 repo（下次執行時會自動重置）');
    return;
  }
  await deleteTempRepo(repo);
}

/** 盡力刪除；沒有 delete_repo scope 時明確告知，不讓測試失敗。 */
async function deleteTempRepo(repo: TempRepo): Promise<void> {
  const r = await gh(['repo', 'delete', repo.full, '--yes']);
  if (r.exitCode === 0) {
    log.info({ repo: repo.full }, '已刪除臨時 GitHub repo');
    return;
  }
  log.warn(
    { repo: repo.full },
    '⚠️ 無法自動刪除臨時 repo（多半是 token 缺 delete_repo scope）。' +
      `請手動執行：gh repo delete ${repo.full} --yes` +
      '（或先 `gh auth refresh -h github.com -s delete_repo` 之後就能自動刪）',
  );
}

// ────────────────────────────────────────────────────────────────────────
// 2) 假 MCP（照真實 pmm 的回應語意：原子認領 + 依賴檢查）
// ────────────────────────────────────────────────────────────────────────

interface FakeTask extends TaskDetail {
  revealAtTick: number;
}

function tasksFor(repo: string): FakeTask[] {
  return [
    {
      id: 'E-1',
      title: '新增 multiply 乘法函式',
      status: 'todo',
      repo,
      category: 'dev',
      description:
        '新增 multiply.js 匯出 multiply(a, b) 回傳 a * b（使用 module.exports），' +
        '並新增 multiply.test.js 以 node:test 撰寫可通過的測試。',
      dependencies: [],
      docRefs: ['spec/math.md#multiply'],
      revealAtTick: 1,
    },
    {
      id: 'E-2',
      title: 'multiply 補上零與負數的測試',
      status: 'todo',
      repo,
      category: 'dev',
      description: '在 multiply.test.js 追加「乘以 0」與「負數相乘」兩個測試案例。不要改動 multiply.js 的行為。',
      dependencies: ['E-1'],
      docRefs: ['spec/math.md#edge'],
      revealAtTick: 1,
    },
    {
      id: 'E-3',
      title: '更新 README 說明可用函式',
      status: 'todo',
      repo,
      category: 'improvement',
      description: '在 README.md 補上一段「可用函式」，列出 sum 與 multiply 各自的用途。',
      dependencies: [],
      docRefs: ['spec/readme.md#functions'],
      revealAtTick: 2,
    },
  ];
}

const DOCS: Record<string, string> = {
  'spec/math.md#multiply': '## multiply\n\nmultiply(a, b) 回傳兩數相乘的結果，需以 module.exports 匯出。',
  'spec/math.md#edge': '## 邊界\n\n乘以 0 必須得到 0；負數相乘的正負號要正確。',
  'spec/readme.md#functions': '## 可用函式\n\nREADME 需列出目前提供的函式與用途，讓新加入的人能快速上手。',
};

class FakeMcp implements McpReadClient, McpTaskClient {
  tick = 0;
  readonly doneIds = new Set<string>();
  readonly startCalls: { id: string; ok: boolean }[] = [];
  readonly completeCalls: string[] = [];
  constructor(private tasks: FakeTask[]) {}

  private find(id: string): FakeTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  async listTasks(q: { repo?: string; status?: string }): Promise<TaskBrief[]> {
    return this.tasks
      .filter((t) => t.revealAtTick <= this.tick && (!q.repo || q.repo === t.repo) && !this.doneIds.has(t.id))
      .map(({ revealAtTick: _r, ...b }) => ({ ...b }));
  }

  async getTask(id: string): Promise<TaskDetail> {
    const t = this.find(id);
    if (!t) throw new Error(`未知任務 ${id}`);
    const { revealAtTick: _r, ...detail } = t;
    return { ...detail };
  }

  /** 真實 pmm 的語意：依賴未完成 → 帶內錯誤（我方 client 會歸成 signal）。 */
  async startTask(id: string): Promise<McpOut<TaskDetail>> {
    const t = this.find(id);
    if (!t) return { ok: false, kind: 'permanent', detail: `未知任務 ${id}` };
    if (this.doneIds.has(id)) return { ok: false, kind: 'permanent', detail: '任務已完成' };
    const pending = t.dependencies.filter((d) => !this.doneIds.has(d));
    if (pending.length > 0) {
      this.startCalls.push({ id, ok: false });
      return { ok: false, kind: 'signal', detail: `還有 ${pending.length} 個前置任務未完成：「${pending.join('、')}」(進行中)` };
    }
    this.startCalls.push({ id, ok: true });
    const { revealAtTick: _r, ...detail } = t;
    return { ok: true, value: { ...detail, status: 'in_progress' } };
  }

  async completeTask(id: string): Promise<McpOut<void>> {
    this.doneIds.add(id);
    this.completeCalls.push(id);
    return { ok: true, value: undefined };
  }

  async loadDocs(refs: string[]): Promise<LoadedDoc[]> {
    return refs.map((ref) => ({ ref, content: DOCS[ref] ?? `（沒有 ${ref} 的內容）` }));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 3) scripted agent（免費模式）：真的寫檔，讓 Verifier 有東西可驗
// ────────────────────────────────────────────────────────────────────────

function scriptedAgent(): AgentLike & { calls: string[] } {
  const calls: string[] = [];
  const scripts: Record<string, (i: IterateInput) => IterateResult> = {
    'E-1': (i) => {
      writeFileSync(join(i.cwd, 'multiply.js'), 'function multiply(a, b) {\n  return a * b;\n}\nmodule.exports = { multiply };\n');
      writeFileSync(
        join(i.cwd, 'multiply.test.js'),
        "const test = require('node:test');\nconst assert = require('node:assert');\nconst { multiply } = require('./multiply');\n\ntest('multiply', () => {\n  assert.equal(multiply(3, 4), 12);\n});\n",
      );
      return { sessionId: 's-E1', resultText: '## 做了什麼\n新增 multiply 與測試。\n## 怎麼做\n以 module.exports 匯出。', isError: false };
    },
    'E-2': (i) => {
      writeFileSync(
        join(i.cwd, 'multiply.test.js'),
        "const test = require('node:test');\nconst assert = require('node:assert');\nconst { multiply } = require('./multiply');\n\ntest('multiply', () => {\n  assert.equal(multiply(3, 4), 12);\n});\n\ntest('multiply by zero', () => {\n  assert.equal(multiply(5, 0), 0);\n});\n\ntest('negative', () => {\n  assert.equal(multiply(-2, 3), -6);\n});\n",
      );
      return { sessionId: 's-E2', resultText: '## 做了什麼\n補上零與負數測試。', isError: false };
    },
    'E-3': (i) => {
      writeFileSync(
        join(i.cwd, 'README.md'),
        '# orch e2e fixture\n\n臨時測試專案，測完會被刪除。\n\n## 可用函式\n\n- `sum(a, b)`：兩數相加\n- `multiply(a, b)`：兩數相乘\n',
      );
      return { sessionId: 's-E3', resultText: '## 做了什麼\nREADME 補上可用函式清單。', isError: false };
    },
  };
  return {
    calls,
    async iterate(i) {
      calls.push(i.task.id);
      const fn = scripts[i.task.id];
      if (!fn) return { sessionId: 'x', resultText: '（無腳本）', isError: false };
      return fn(i);
    },
  };
}

/** 非終態的群組狀態；全空才算收工。 */
const NON_TERMINAL = ['forming', 'ready', 'pr_open', 'in_review', 'changes_requested', 'merge_guard'] as const;

function settled(ledger: Ledger): boolean {
  const busy = NON_TERMINAL.flatMap((s) => ledger.listGroupsByState(s));
  const pending = ['discovered', 'queued'].flatMap((s) => ledger.listTasksByState(s as never));
  return busy.length === 0 && pending.length === 0;
}

// ────────────────────────────────────────────────────────────────────────
// 4) 主流程
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  if (LIVE && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    log.error('--live 需要 .env 的 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY');
    process.exit(2);
  }
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const repo = await prepareRepo();
  let exitCode = 1;
  try {
    exitCode = await runFlow(repo);
  } finally {
    if (KEEP) {
      log.warn({ root: ROOT, repo: repo.full }, '--keep：保留臨時 repo 與工作目錄');
    } else {
      await cleanupRepo(repo);
      rmSync(ROOT, { recursive: true, force: true });
    }
  }
  process.exit(exitCode);
}

async function runFlow(repo: TempRepo): Promise<number> {
  const ledger = new Ledger(join(ROOT, 'ledger.db'), log);
  ledger.init();

  const mcp = new FakeMcp(tasksFor(repo.full));
  const notifier = new ConsoleNotifier(log);
  const feedback = new ReviewFeedbackStore(ledger);
  const agent: AgentLike = LIVE ? new AgentRuntime(log) : scriptedAgent();
  const verifierConfig = { build: 'npm run build', test: 'npm test' };

  const runtime: ProjectRuntime = {
    repo: repo.full,
    repoPath: repo.localPath,
    baseBranch: BASE_BRANCH,
    verifierConfig,
    mcp,
  };

  const prManager = new PrManager(log);
  const groupRunner = new GroupRunner({
    ledger,
    log,
    worktreeBase: join(ROOT, 'worktrees'),
    resolveProject: (r) => (r === repo.full ? runtime : undefined),
    agent,
    makeVerifier: () => new Verifier(log),
    progressRounds: 3,
    notifier: Object.assign(notifier, { askMergeApproval: (ts: string | undefined, g: { groupId: string }) => gateway.askMergeApproval(ts, g) }),
    allowLocalMerge: false, // 有 PR 時一律走 PR 合併路徑（不本地合併，避免孤兒 PR）
    feedback,
    prManager,
  });

  // 最小合併閘門：政策判定 needs_human 時 GroupRunner 會呼叫 askMergeApproval，
  // 我們記下來並在下一輪以「審查者核准」回覆——等同真人在 Slack 按下核准。
  const approvalRequests: string[] = [];
  // **廣播**給所有訂閱者：Orchestrator 要記核准憑證、InboundRouter 要推進群組狀態，
  // 兩邊都得收到。用單一變數存 cb 的話後訂閱者會覆蓋前一個（憑證就永遠記不到）。
  const mergeCbs: ((d: { groupId: string; approved: boolean; userId?: string }) => void)[] = [];
  const emitMerge = (d: { groupId: string; approved: boolean; userId?: string }): void => {
    for (const cb of mergeCbs) cb(d);
  };
  const gateway = {
    async askMergeApproval(_ts: string | undefined, g: { groupId: string }): Promise<void> {
      approvalRequests.push(g.groupId);
      log.warn({ group: g.groupId }, '🔒 收到合併核准請求（等人裁決）');
    },
    onMergeDecision(cb: (d: { groupId: string; approved: boolean; userId?: string }) => void): void {
      mergeCbs.push(cb);
    },
  };

  const dispatcher = new Dispatcher(2, groupRunner.run, log);
  const orchestrator = new Orchestrator(
    {
      poller: new Poller([{ client: mcp, repo: repo.full } as PollSource], ledger, log),
      planner: new Planner({ resolveRepoPath: () => repo.localPath, log }),
      dispatcher,
      ledger,
      log,
      feedback,
      gateway,
      notifier,
      reviewWatcher: new ReviewWatcher({ ledger, log }),
      // 靜置期關閉：harness 是現場建任務馬上跑，預設 15 分鐘會讓整個測試乾等。
      // 靜置期本身由 quiet-period / orchestrator 的單元測試覆蓋。
      quietMinutesOf: () => 0,
      merge: {
        resolveProject: (r) => (r === repo.full ? { repoPath: repo.localPath, baseBranch: BASE_BRANCH, verifierConfig } : undefined),
        guard: new MergeGuard(new Verifier(log), log),
        pr: prManager,
        readDiff: readDiffStat,
        fetchBase: async (repoPath, base) => void (await git(repoPath, ['fetch', 'origin', base])),
      },
    },
    1,
  );
  // 人的回覆入口。原本掛空 hook ⇒ 任務一旦 park 就沒人救得了它，
  // 於是「agent 正確判定無需改動」這種**合法**結果會被算成測試失敗（實測撞到）。
  let emitControl: (c: ExtendedControlCommand) => void = () => {};
  let emitAnswer: (a: ClarificationAnswer) => void = () => {};
  new InboundRouter({ ledger, log, completeTask: (id) => mcp.completeTask(id) }).attach({
    onAnswer: (cb) => {
      emitAnswer = cb;
    },
    onControl: (cb) => {
      emitControl = cb;
    },
    onMergeDecision: (cb) => {
      mergeCbs.push(cb);
    },
  });

  // ── tick 迴圈：模擬「人審查後核准」 ──
  const approved = new Set<string>();
  const deadline = Date.now() + DEADLINE_MS;
  for (let t = 1; Date.now() < deadline; t += 1) {
    mcp.tick = t;
    await orchestrator.tick();

    // 模擬人處理 park 的任務：這是需求 §7b 的完整迴圈，沒有它任務會永遠停著
    for (const t of ledger.listTasksByState('blocked')) {
      const reason = t.block?.reason;
      const detail = t.block?.detail ?? '';
      if (reason === 'needs_clarification') {
        log.warn({ taskId: t.id }, '🧑 （模擬）人回答了澄清');
        emitAnswer({ taskId: t.id, threadTs: `ts-${t.id}`, freeText: '照你的建議做' });
      } else if (reason === 'needs_human' && detail.startsWith('無需改動')) {
        // agent 查證後認定這張卡不用做（例如需求已被前一個任務順帶完成）。
        // 人看過理由後確認 → confirm_no_change 會呼叫 complete_task 把卡關掉。
        log.warn({ taskId: t.id }, '🧑 （模擬）人確認「這張卡確實不用做」');
        emitControl({ type: 'confirm_no_change', taskId: t.id, userId: 'e2e-human' });
      }
    }

    // 模擬審查者：對已開 PR 的群組送出核准（真實情境是有人在 GitHub 按 Approve）
    for (const g of [...ledger.listGroupsByState('pr_open'), ...ledger.listGroupsByState('in_review')]) {
      if (approved.has(g.id) || g.prNumber === undefined) continue;
      approved.add(g.id);
      log.warn({ group: g.id, pr: g.prNumber }, '🧑 （模擬）審查者核准了這個 PR');
      emitMerge({ groupId: g.id, approved: true, userId: 'e2e-reviewer' });
    }

    // 收工條件：沒有任何群組還在非終態，且沒有 in-flight。
    // 注意 dispatcher 是**非同步派出**——GroupRunner 在背景跑（build/test/push/gh 都要時間），
    // 只看 tick 次數就退出的話，會在 PR 還沒開出來時就跑去驗收（第一版就是這樣誤判的）。
    if (settled(ledger) && dispatcher.activeCount() === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!settled(ledger) || dispatcher.activeCount() > 0) {
    log.warn({ active: dispatcher.activeCount() }, '⏱ 逾時仍未收斂，驗收結果可能不完整');
  }

  await evaluate(repo, ledger, mcp);
  ledger.close();

  const failed = checks.filter((c) => !c.ok);
  console.log('\n──────── 完整流程 e2e 摘要 ────────');
  console.log(`模式：${LIVE ? 'live（真 AgentRuntime）' : 'scripted（免 LLM）'}｜臨時 repo：${repo.full}`);
  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `\n     ${c.detail}` : ''}`);
  console.log(`\n結論：${failed.length === 0 ? '✅ 全部通過' : `❌ ${failed.length} 項未達成`}`);
  return failed.length === 0 ? 0 : 1;
}

async function evaluate(repo: TempRepo, ledger: Ledger, mcp: FakeMcp): Promise<void> {
  const tasks = tasksFor(repo.full);

  note('① 拉任務：全部落地 ledger', tasks.every((t) => ledger.getTask(t.id) !== undefined),
    `ledger 任務數=${tasks.filter((t) => ledger.getTask(t.id)).length}/${tasks.length}`);

  const groups = ['merged', 'failed', 'pr_open', 'in_review', 'changes_requested', 'ready', 'forming', 'merge_guard']
    .flatMap((s) => ledger.listGroupsByState(s as never));
  note('② 分群：有建立群組', groups.length > 0, `共 ${groups.length} 群：${groups.map((g) => `${g.id}[${g.taskIds.join(',')}]=${g.state}`).join(' ')}`);

  note('③ 派發 + 完成：所有任務 complete_task', mcp.completeCalls.length === tasks.length,
    `complete_task ${mcp.completeCalls.length}/${tasks.length}（${mcp.completeCalls.join(', ')}）`);

  note('④ 依賴檢查：E-2 曾因 E-1 未完成被擋下（signal 路徑）',
    mcp.startCalls.some((c) => c.id === 'E-2' && !c.ok) || ledger.getTask('E-2')?.state === 'done',
    `start_task 受阻次數=${mcp.startCalls.filter((c) => !c.ok).length}`);

  // 真實 GitHub：PR 是否真的被建立
  const prList = await gh(['pr', 'list', '--repo', repo.full, '--state', 'all', '--json', 'number,state,title,mergedAt', '--limit', '100']);
  const all = prList.exitCode === 0 ? (JSON.parse(prList.stdout || '[]') as { number: number; state: string; title: string; mergedAt: string | null }[]) : [];
  // 只算本次執行開出來的（編號大於開跑前的基準），否則固定 repo 的歷史 PR 會被算進來
  const prs = all.filter((p) => p.number > repo.prBaseline);
  note('⑤ 真的開出 GitHub PR', prs.length > 0, `PR 數=${prs.length}：${prs.map((p) => `#${p.number}[${p.state}]${p.title}`).join(' | ')}`);

  const merged = prs.filter((p) => p.state === 'MERGED');
  note('⑥ PR 真的被合併', merged.length > 0, `已合併 ${merged.length}/${prs.length}`);

  // base 上真的有那些檔案（合併確實生效，不只是 PR 狀態變了）
  await git(repo.localPath, ['fetch', 'origin', BASE_BRANCH]);
  const lsTree = await git(repo.localPath, ['ls-tree', '--name-only', `origin/${BASE_BRANCH}`]);
  const filesOnBase = lsTree.stdout.split('\n').filter(Boolean);
  note('⑦ 合併結果真的進到 base 分支', filesOnBase.includes('multiply.js'),
    `origin/${BASE_BRANCH} 檔案：${filesOnBase.join(', ')}`);

  note('⑧ 沒有孤兒 PR（開了卻既沒合併也沒關閉）',
    prs.every((p) => p.state !== 'OPEN'),
    prs.filter((p) => p.state === 'OPEN').map((p) => `#${p.number}`).join(', ') || '無');

  const stuck = ['ready', 'forming', 'changes_requested', 'merge_guard', 'pr_open', 'in_review']
    .flatMap((s) => ledger.listGroupsByState(s as never));
  note('⑨ 沒有群組卡在非終態', stuck.length === 0, stuck.map((g) => `${g.id}=${g.state}`).join(', ') || '無');
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.stack : String(err) }, 'live e2e 失敗');
  process.exit(1);
});
