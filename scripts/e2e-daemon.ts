/**
 * 完整 daemon 端到端 harness（診斷用）。
 *
 * 既有的 e2e-trunk 只驗 Worker 主幹；本檔驗**整條 daemon 鏈路**：
 *   Orchestrator.tick → Poller → Planner → 建群 → Dispatcher → GroupRunner → Worker
 *     → Verifier(DoD) → Merge Guard → 政策閘門 → PR → 人工核准 → Orchestrator 合併佇列
 *   以及 park（ask_human / report_no_change）→ 人回覆 → requeue → 重新派工 的恢復路徑。
 *
 * 只有兩件事是假的（其餘全部是 src/ 下的真實模組）：
 *   1. MCP（FakeMcp：listTasks/getTask/startTask/completeTask/loadDocs，含依賴檢查）
 *   2. agent（ScriptedAgent：真的在 worktree 寫檔，讓 Verifier 有東西可驗）
 *   另外 PR 的外部動作（gh pr create / gh pr merge）以假件取代——不對外產生副作用。
 *
 * 目標 repo 是 /tmp 下自建的最小 git repo（**不碰** data/repos 的沙盒）。
 * 可重複執行：每次啟動先清掉整個 /tmp 工作目錄。
 *
 *   npx tsx scripts/e2e-daemon.ts            # 跑完整流程並印摘要
 *   npx tsx scripts/e2e-daemon.ts --keep     # 保留 /tmp 現場供事後檢視
 *   LOG_LEVEL=debug npx tsx scripts/e2e-daemon.ts
 */
import { execa } from 'execa';
import { createCheckRecorder, type CheckContext } from '../src/worker/check-recorder.js';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createLogger } from '../src/observability/logger.js';
import { Ledger } from '../src/store/ledger.js';
import { Poller, type PollSource } from '../src/core/poller.js';
import { Planner, type PlanAgentLike } from '../src/core/planner.js';

/**
 * 假的規劃 agent：**依共用的規格檔分群，依賴的併進同一群**。
 *
 * 這條規則以前寫在 planner 裡（關鍵字相似度 ＋ 共用 docRef 的啟發式），第 15 片刪掉了
 * ——分群現在完全是 agent 的判斷，而這支 e2e 是刻意不碰網路的（沒有 Claude 認證）。
 * 這裡把它做成假件，因為 e2e 驗的是**整條鏈的接線**，不是分群本身的品質。
 */
function fakePlanAgent(): PlanAgentLike {
  return {
    async plan(tasks) {
      const keyOf = (id: string): string => {
        const t = tasks.find((x) => x.id === id);
        return (t?.docRefs[0] ?? id).split('#')[0]!;
      };
      const byKey = new Map<string, string[]>();
      for (const t of tasks) {
        // 有宣告依賴的任務跟著上游走（同一群才有「前一個任務的成果看得到」的語意）
        const dep = t.dependencies.find((d) => tasks.some((x) => x.id === d));
        const key = dep ? keyOf(dep) : keyOf(t.id);
        byKey.set(key, [...(byKey.get(key) ?? []), t.id]);
      }
      const groups = [...byKey.entries()].map(([file, taskIds], i) => ({
        id: `g${i + 1}`, taskIds, files: [file], why: `共用 ${file}`,
      }));
      return { groups, stages: [groups.map((g) => g.id)] };
    },
  };
}
import { Dispatcher } from '../src/core/dispatcher.js';
import { GroupRunner, type PrManagerLike, type ProjectRuntime } from '../src/core/group-runner.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { Verifier } from '../src/worker/verifier.js';
import { MergeGuard } from '../src/pr/merge-guard.js';
import { PrManager } from '../src/pr/pr-manager.js';
import { ReviewFeedbackStore } from '../src/pr/review-watcher.js';
import { InboundRouter, summarizeEvent } from '../src/notify/notifier.js';
import type { ExtendedControlCommand } from '../src/notify/notifier.js';
import { createMergePipeline } from '../src/main.js';
import type { AgentLike, McpReadClient, McpTaskClient, Notifier } from '../src/contracts.js';
import type { IterateInput, IterateResult, LoadedDoc } from '../src/worker/agent-runtime.js';
import type {
  ClarificationAnswer,
  ControlCommand,
  Group,
  GroupState,
  LifecycleEvent,
  McpOut,
  PullRequest,
  TaskBrief,
  TaskDetail,
} from '../src/types.js';

const KEEP = process.argv.includes('--keep');
const MAX_TICKS = Number(process.env.E2E_MAX_TICKS ?? 14);
const IDLE_TIMEOUT_MS = Number(process.env.E2E_IDLE_TIMEOUT_MS ?? 180_000);

const log = createLogger();

const ROOT = '/tmp/orch-e2e-daemon';
const REPO_PATH = join(ROOT, 'repo');
const WORKTREE_BASE = join(ROOT, 'worktrees');
const MERGE_WORKTREE_BASE = join(ROOT, 'merge-worktrees');
const DB_PATH = join(ROOT, 'ledger.db');
const REPO = 'local/e2e-daemon';
const BASE_BRANCH = 'main';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────────────────
// 1) fixture：/tmp 下的最小 node repo（不是 data/repos 的沙盒）
// ────────────────────────────────────────────────────────────────────────

async function makeFixture(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(REPO_PATH, { recursive: true });

  writeFileSync(
    join(REPO_PATH, 'package.json'),
    JSON.stringify(
      {
        name: 'e2e-daemon-fixture',
        version: '0.0.0',
        private: true,
        scripts: {
          build: "node -e \"console.log('build ok')\"",
          test: 'node --test',
          lint: "node -e \"console.log('lint ok')\"",
        },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(REPO_PATH, 'README.md'), '# e2e-daemon fixture\n\n這是端到端 harness 用的假專案。\n');
  writeFileSync(join(REPO_PATH, 'sum.js'), 'function sum(a, b) {\n  return a + b;\n}\nmodule.exports = { sum };\n');
  writeFileSync(
    join(REPO_PATH, 'sum.test.js'),
    "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\n\ntest('sum adds', () => {\n  assert.equal(sum(1, 2), 3);\n});\n",
  );

  const git = (args: string[]) => execa('git', ['-C', REPO_PATH, ...args]);
  await git(['init', '-q', '-b', BASE_BRANCH]);
  await git(['config', 'user.email', 'e2e@local']);
  await git(['config', 'user.name', 'e2e']);
  await git(['add', '-A']);
  await git(['commit', '-qm', 'init fixture']);
  log.info({ REPO_PATH }, 'fixture 就緒');
}

// ────────────────────────────────────────────────────────────────────────
// 2) 假 MCP（含依賴檢查與「稍後才出現的任務」）
// ────────────────────────────────────────────────────────────────────────

interface FakeTask extends TaskDetail {
  /** 第幾輪 tick 之後才會出現在 list_tasks（模擬任務板陸續派卡）。 */
  revealAtTick: number;
}

const TASKS: FakeTask[] = [
  {
    id: 'T-1',
    title: '新增 alpha 模組的加總計算',
    status: 'todo',
    repo: REPO,
    category: 'dev',
    description:
      '在 alpha.js 新增 alphaSum(list) 回傳陣列總和，以 module.exports 匯出；另新增 alpha.test.js 撰寫測試。',
    dependencies: [],
    docRefs: ['spec/alpha.md#sum'],
    revealAtTick: 1,
  },
  {
    id: 'T-2',
    title: 'alpha 模組補上空陣列的邊界處理',
    status: 'todo',
    repo: REPO,
    category: 'dev',
    description: '在 alpha.js 的 alphaSum 補上空陣列回傳 0 的邊界處理，並於 alpha.test.js 增加對應測試。',
    dependencies: ['T-1'],
    docRefs: ['spec/alpha.md#edge'],
    revealAtTick: 1,
  },
  {
    id: 'T-3',
    title: '更新 README 的安裝說明',
    status: 'todo',
    repo: REPO,
    category: 'improvement',
    description: '在 README.md 補上安裝與執行測試的說明段落。',
    dependencies: [],
    docRefs: ['spec/readme.md#install'],
    revealAtTick: 1,
  },
  {
    id: 'T-4',
    title: '新增 gamma 彙整函式',
    status: 'todo',
    repo: REPO,
    category: 'dev',
    description: '新增 gamma.js 匯出 gammaAll(list)（以 sum 逐項累加），並新增 gamma.test.js。',
    dependencies: ['T-2'],
    docRefs: ['spec/gamma.md#export'],
    revealAtTick: 2,
  },
  {
    // 探針：一張「真的不需要改動」的卡（§7b 的合法零 diff）。agent 每一輪都宣告 no_change，
    // 人也照 Slack 能做的方式回覆（retry/用你的預設）。要驗的是：這張卡有沒有**出口**。
    id: 'T-5',
    title: '確認 delta 設定已停用',
    status: 'todo',
    repo: REPO,
    category: 'improvement',
    description: '確認專案已停用 delta 設定；若已停用則無需改動。',
    dependencies: [],
    docRefs: ['spec/delta.md#disabled'],
    revealAtTick: 6,
  },
];

/** 探針任務：一張「真的不需要改動」的卡，用來驗 §7b 出口。 */
const PROBE_TASK_ID = 'T-5';

/** 最後一張卡出現的輪次（迴圈至少要跑到這之後，探針才有機會執行）。 */
const LAST_REVEAL_TICK = Math.max(...TASKS.map((t) => t.revealAtTick));

class FakeMcp implements McpReadClient, McpTaskClient {
  tick = 0;
  readonly doneIds = new Set<string>();
  readonly startCalls: { id: string; ok: boolean; kind?: string }[] = [];
  readonly completeCalls: { id: string; summary?: string }[] = [];

  private find(id: string): FakeTask | undefined {
    return TASKS.find((t) => t.id === id);
  }

  async listTasks(q: { repo?: string; status?: string }): Promise<TaskBrief[]> {
    return TASKS.filter(
      (t) => t.revealAtTick <= this.tick && (!q.repo || q.repo === t.repo) && !this.doneIds.has(t.id),
    ).map(({ revealAtTick: _r, ...b }) => ({ ...b }));
  }

  async getTask(id: string): Promise<TaskDetail> {
    const t = this.find(id);
    if (!t) throw new Error(`未知任務 ${id}`);
    const { revealAtTick: _r, ...detail } = t;
    return { ...detail };
  }

  /** D2：認領是原子的，且 MCP 會檢查依賴完成（未完 → kind:'signal'）。 */
  async startTask(id: string): Promise<McpOut<TaskDetail>> {
    const t = this.find(id);
    if (!t) {
      this.startCalls.push({ id, ok: false, kind: 'permanent' });
      return { ok: false, kind: 'permanent', detail: `未知任務 ${id}` };
    }
    if (this.doneIds.has(id)) {
      // 真實 MCP 對已 done 的任務會拒絕認領（D4：無反 done 工具）
      this.startCalls.push({ id, ok: false, kind: 'permanent' });
      return { ok: false, kind: 'permanent', detail: `任務 ${id} 已經是 done，不可再認領` };
    }
    const unmet = t.dependencies.filter((d) => !this.doneIds.has(d));
    if (unmet.length > 0) {
      this.startCalls.push({ id, ok: false, kind: 'signal' });
      return { ok: false, kind: 'signal', detail: `依賴未完成：${unmet.join(', ')}` };
    }
    this.startCalls.push({ id, ok: true });
    const { revealAtTick: _r, ...detail } = t;
    return { ok: true, value: { ...detail, status: 'in_progress' } };
  }

  async completeTask(id: string, opts?: { summary?: string }): Promise<McpOut<void>> {
    if (this.doneIds.has(id)) return { ok: false, kind: 'permanent', detail: `任務 ${id} 已經是 done` };
    this.doneIds.add(id);
    this.completeCalls.push({ id, ...(opts?.summary ? { summary: opts.summary } : {}) });
    return { ok: true, value: undefined };
  }

  async loadDocs(refs: string[]): Promise<LoadedDoc[]> {
    return refs.map((ref) => ({ ref, content: `# ${ref}\n\n（harness 假規格）依任務描述實作即可。` }));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 3) 假 agent：真的在 worktree 寫檔；並可依腳本觸發 ask_human / report_no_change
// ────────────────────────────────────────────────────────────────────────

type Step = (input: IterateInput) => IterateResult;

const writeAlpha = (cwd: string, withEdge: boolean): void => {
  writeFileSync(
    join(cwd, 'alpha.js'),
    withEdge
      ? 'function alphaSum(list) {\n  if (!Array.isArray(list) || list.length === 0) return 0;\n  return list.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { alphaSum };\n'
      : 'function alphaSum(list) {\n  return list.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { alphaSum };\n',
  );
  writeFileSync(
    join(cwd, 'alpha.test.js'),
    "const test = require('node:test');\nconst assert = require('node:assert');\nconst { alphaSum } = require('./alpha');\n\ntest('alphaSum sums', () => {\n  assert.equal(alphaSum([1, 2, 3]), 6);\n});\n" +
      (withEdge
        ? "\ntest('alphaSum handles empty', () => {\n  assert.equal(alphaSum([]), 0);\n});\n"
        : ''),
  );
};

/**
 * 腳本化的假 agent。每個任務有一串步驟，依呼叫次序消耗；用盡後重複最後一步。
 * 刻意讓 T-2 走 ask_human、T-3 走 report_no_change —— 這兩條就是要驗的 park 路徑。
 */
class ScriptedAgent implements AgentLike {
  readonly calls: { taskId: string; step: number }[] = [];
  /** 每一輪收到的續跑資訊（探針 ㉕：人回覆有沒有真的送到 agent 手上）。 */
  readonly resumes: { taskId: string; step: number; resume?: string; answer?: string }[] = [];
  private counters = new Map<string, number>();

  private readonly scripts: Record<string, Step[]> = {
    'T-1': [
      (i) => {
        writeAlpha(i.cwd, false);
        return { sessionId: 'sess-T1', resultText: '', isError: false, toolCalls: {}, summary: { what: '新增 alpha.js 的 alphaSum 與測試。' } };
      },
    ],
    'T-2': [
      // 第一輪：提出不可逆歧義 → 應該 park 整個群組（worktree 保留）
      () => ({
        sessionId: 'sess-T2',
        resultText: '需要澄清',
        isError: false,
        toolCalls: {},
        askedClarification: {
          question: '空陣列要回傳 0 還是丟例外？這會改變既有呼叫端的行為。',
          rationale: '回傳值語意不可逆，錯了會影響下游',
          options: ['回傳 0', '丟例外'],
        },
      }),
      // 第二輪（人已回覆後）：實際修改
      (i) => {
        writeAlpha(i.cwd, true);
        return { sessionId: 'sess-T2', resultText: '', isError: false, toolCalls: {}, summary: { what: 'alphaSum 補上空陣列回傳 0 的邊界處理。' } };
      },
    ],
    'T-3': [
      // 第一輪：宣告「本任務無需改動」（§7b 的合法零 diff 出口）
      () => ({
        sessionId: 'sess-T3',
        resultText: '判定無需改動',
        isError: false,
        toolCalls: {},
        reportedNoChange: {
          category: 'already_satisfied' as const,
          reason: 'README 已有安裝說明段落',
          evidence: 'README.md 第 1-3 行',
        },
      }),
      // 第二輪（人要求照做後）：真的改
      (i) => {
        writeFileSync(
          join(i.cwd, 'README.md'),
          '# e2e-daemon fixture\n\n這是端到端 harness 用的假專案。\n\n## 安裝\n\n```\nnpm install\n```\n\n## 測試\n\n```\nnpm test\n```\n',
        );
        return { sessionId: 'sess-T3', resultText: '', isError: false, toolCalls: {}, summary: { what: 'README 補上安裝與測試說明。' } };
      },
    ],
    // 探針：**每一輪**都宣告無需改動（模擬一張確實不用做的卡）
    'T-5': [
      () => ({
        sessionId: 'sess-T5',
        resultText: '確認過了，不需要改動',
        isError: false,
        toolCalls: {},
        reportedNoChange: {
          category: 'already_satisfied' as const,
          reason: 'delta 設定本來就沒有啟用，沒有任何檔案需要改',
          evidence: 'config 目錄下沒有 delta 相關設定',
        },
      }),
    ],
    'T-4': [
      (i) => {
        writeFileSync(
          join(i.cwd, 'gamma.js'),
          "const { sum } = require('./sum');\n\nfunction gammaAll(list) {\n  return list.reduce((acc, n) => sum(acc, n), 0);\n}\nmodule.exports = { gammaAll };\n",
        );
        writeFileSync(
          join(i.cwd, 'gamma.test.js'),
          "const test = require('node:test');\nconst assert = require('node:assert');\nconst { gammaAll } = require('./gamma');\n\ntest('gammaAll sums', () => {\n  assert.equal(gammaAll([1, 2, 3]), 6);\n});\n",
        );
        return { sessionId: 'sess-T4', resultText: '', isError: false, toolCalls: {}, summary: { what: '新增 gamma.js 與測試。' } };
      },
    ],
  };

  async iterate(input: IterateInput): Promise<IterateResult> {
    const id = input.task.id;
    const n = this.counters.get(id) ?? 0;
    this.counters.set(id, n + 1);
    this.calls.push({ taskId: id, step: n + 1 });
    this.resumes.push({
      taskId: id,
      step: n + 1,
      ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
      ...(input.answer ? { answer: input.answer.answer } : {}),
    });

    const steps = this.scripts[id];
    if (!steps || steps.length === 0) {
      return { sessionId: 'x', resultText: `沒有腳本可跑（${id}）`, isError: true, toolCalls: {} };
    }
    const step = steps[Math.min(n, steps.length - 1)]!;
    log.info({ taskId: id, step: n + 1, feedback: input.feedback?.checks.filter((c) => !c.ok).map((c) => c.name).join('、') }, '🤖 假 agent 執行一輪');
    return step(input);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 4) 假人機介面（Slack 替身）：出站事件 + 入站回呼（澄清答覆／控制指令／合併裁決）
// ────────────────────────────────────────────────────────────────────────

interface MergeDecision {
  groupId: string;
  approved: boolean;
  threadTs?: string;
  userId?: string;
}

class FakeGateway implements Notifier {
  readonly events: { threadTs?: string; text: string; taskId: string }[] = [];
  readonly approvalRequests: { groupId: string; reasons?: string[] }[] = [];
  private answerCbs: ((a: ClarificationAnswer) => void)[] = [];
  private controlCbs: ((c: ExtendedControlCommand) => void)[] = [];
  private mergeCbs: ((d: MergeDecision) => void)[] = [];

  event(threadTs: string | undefined, event: LifecycleEvent, task: TaskDetail): void {
    const text = summarizeEvent(event);
    this.events.push({ ...(threadTs ? { threadTs } : {}), text, taskId: task.id });
    log.info({ taskId: task.id, threadTs }, text);
  }

  /** §8 一任務一 thread：貼卡取得 thread_ts（GroupRunner 會寫回 ledger）。 */
  async postTaskCard(task: { id: string }): Promise<string> {
    return `ts-${task.id}`;
  }

  async askMergeApproval(
    _threadTs: string | undefined,
    g: { groupId: string; reasons?: string[] },
  ): Promise<void> {
    this.approvalRequests.push({ groupId: g.groupId, ...(g.reasons ? { reasons: g.reasons } : {}) });
    log.warn({ group: g.groupId, reasons: g.reasons }, '🔐 （假 Slack）請求人工核准合併');
  }

  onAnswer(cb: (a: ClarificationAnswer) => void): void {
    this.answerCbs.push(cb);
  }
  onControl(cb: (c: ExtendedControlCommand) => void): void {
    this.controlCbs.push(cb);
  }
  onMergeDecision(cb: (d: MergeDecision) => void): void {
    this.mergeCbs.push(cb);
  }

  emitAnswer(a: ClarificationAnswer): void {
    for (const cb of this.answerCbs) cb(a);
  }
  emitControl(c: ExtendedControlCommand): void {
    for (const cb of this.controlCbs) cb(c);
  }
  emitMergeDecision(d: MergeDecision): void {
    for (const cb of this.mergeCbs) cb(d);
  }
}

/** 只把 openPr 換成假件（commitAll 仍是真的 git commit）。 */
class FakePrManager implements PrManagerLike {
  readonly opened: { branch: string; number: number }[] = [];
  private seq = 0;
  private real = new PrManager(log);

  commitAll(repoPath: string, message: string): Promise<boolean> {
    return this.real.commitAll(repoPath, message);
  }
  async openPr(input: { branch: string }): Promise<PullRequest> {
    this.seq += 1;
    this.opened.push({ branch: input.branch, number: this.seq });
    log.info({ branch: input.branch, number: this.seq }, '（假件）開 PR');
    return { url: `https://example.invalid/pr/${this.seq}`, number: this.seq };
  }
}

// ────────────────────────────────────────────────────────────────────────
// 5) 觀測與摘要
// ────────────────────────────────────────────────────────────────────────

interface Stage {
  name: string;
  ok: boolean;
  detail: string;
}

const stages: Stage[] = [];
const note = (name: string, ok: boolean, detail: string): void => {
  stages.push({ name, ok, detail });
};

/** 事後檢視用的觀測紀錄。 */
const obs = {
  ticks: 0,
  dispatched: [] as { tick: number; groupId: string }[],
  groupStateTrail: new Map<string, string[]>(),
  taskStateTrail: new Map<string, string[]>(),
  parkedWorktreeSeen: new Map<string, boolean>(),
};

/**
 * 觀測用：攔截 ledger 的狀態更新，取得**每一次**轉移（每輪快照會漏掉暫態）。
 * 只包一層記錄再委派原方法，不改變任何行為。
 */
function instrumentLedger(ledger: Ledger): void {
  const origGroup = ledger.updateGroupState.bind(ledger);
  ledger.updateGroupState = ((id: string, state: GroupState, extra?: { prUrl?: string; prNumber?: number }) => {
    const trail = obs.groupStateTrail.get(id) ?? [];
    if (trail[trail.length - 1] !== `t${obs.ticks}:${state}`) trail.push(`t${obs.ticks}:${state}`);
    obs.groupStateTrail.set(id, trail);
    return origGroup(id, state, extra);
  }) as Ledger['updateGroupState'];

  const pushTask = (id: string, label: string): void => {
    const trail = obs.taskStateTrail.get(id) ?? [];
    if (trail[trail.length - 1] !== `t${obs.ticks}:${label}`) trail.push(`t${obs.ticks}:${label}`);
    obs.taskStateTrail.set(id, trail);
  };
  const origTask = ledger.updateTaskState.bind(ledger);
  ledger.updateTaskState = ((id: string, state: never, extra?: never) => {
    pushTask(id, state);
    return origTask(id, state, extra);
  }) as Ledger['updateTaskState'];
  const origBlock = ledger.setBlock.bind(ledger);
  ledger.setBlock = ((id: string, reason: never, detail?: string) => {
    pushTask(id, `blocked:${reason}`);
    return origBlock(id, reason, detail);
  }) as Ledger['setBlock'];
  const origClear = ledger.clearBlock.bind(ledger);
  ledger.clearBlock = ((id: string, next: never) => {
    pushTask(id, `${next}(unblocked)`);
    return origClear(id, next);
  }) as Ledger['clearBlock'];
}

const TERMINAL: GroupState[] = ['merged', 'failed'];
/** 「本輪不會再自己前進」的狀態（沒有 ReviewWatcher/人再介入就停住）。 */
const SETTLED: GroupState[] = ['merged', 'failed', 'in_review', 'pr_open'];

// ────────────────────────────────────────────────────────────────────────
// 6) 主流程
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await makeFixture();

  const ledger = new Ledger(DB_PATH, log);
  ledger.init();
  instrumentLedger(ledger);

  const mcp = new FakeMcp();
  const agent = new ScriptedAgent();
  const gateway = new FakeGateway();
  const fakePr = new FakePrManager();
  const feedback = new ReviewFeedbackStore(ledger);

  const verifierConfig = { typecheck: undefined, lint: 'npm run lint', build: 'npm run build', test: 'npm test' };
  const runtime: ProjectRuntime = {
    repo: REPO,
    repoPath: REPO_PATH,
    baseBranch: BASE_BRANCH,
    verifierConfig,
    mcp,
  };
  const runtimes = new Map<string, ProjectRuntime>([[REPO, runtime]]);

  // 入站路由（Slack → ledger）：真件
  // 注入 completeTask：confirm_no_change 必須真的關掉任務板上的卡，否則出口只是清本機 block，
  // 下一輪又被撿回來重跑（正是 ㉓ 要驗的東西）。正式環境由 main.ts 的 completeTaskFor 提供。
  new InboundRouter({ ledger, log, completeTask: (id, opts) => mcp.completeTask(id, opts) }).attach(gateway);

  const groupRunner = new GroupRunner({
    ledger,
    log,
    worktreeBase: WORKTREE_BASE,
    resolveProject: (repo) => runtimes.get(repo),
    agent,
    makeVerifier: (ctx?: CheckContext) => new Verifier(log, {
      checkRecorder: createCheckRecorder({ ledger, log }),
      ...(ctx ? { checkContext: ctx } : {}),
    }),
    progressRounds: 3,
    notifier: gateway,
    allowLocalMerge: true, // 只動 /tmp 的 fixture
    prManager: fakePr,
    feedback,
  });

  // Dispatcher 用真件；包一層 runner 只為了觀測「哪一輪派出了哪個群」
  const dispatcher = new Dispatcher(
    2,
    async (g: Group) => {
      obs.dispatched.push({ tick: obs.ticks, groupId: g.id });
      await groupRunner.run(g);
    },
    log,
  );

  // 合併管線：用 main.ts 的真實工廠（含 ensureMergeWorkspace / MergeGuard / readDiffStat），
  // 只把「真的去 GitHub 合併 PR」換成假件。
  const mergedPrs: { repo: string; prNumber: number; approvedBy: string }[] = [];
  const mergePipeline = await createMergePipeline({
    projects: [{ id: 'e2e', runtime }],
    actions: { allowLocalMerge: true },
    log,
    worktreeBase: MERGE_WORKTREE_BASE,
    pr: {
      async merge(i) {
        mergedPrs.push({ repo: i.repo, prNumber: i.prNumber, approvedBy: i.approvedBy });
        log.info({ pr: i.prNumber, by: i.approvedBy }, '（假件）合併 PR');
        return { ok: true, detail: '（假件）合併成功' };
      },
    },
  });
  note('合併管線接線', mergePipeline !== undefined, mergePipeline ? '已建立合併專用 worktree' : 'createMergePipeline 回 undefined');

  const sources: PollSource[] = [{ client: mcp, repo: REPO, mine: false }];
  const orch = new Orchestrator(
    {
      poller: new Poller(sources, ledger, log),
      planner: new Planner({ resolveRepoPath: (repo) => runtimes.get(repo)?.repoPath, log, planAgent: fakePlanAgent() }),
      dispatcher,
      ledger,
      log,
      feedback,
      gateway,
      notifier: gateway,
      ...(mergePipeline ? { merge: { ...mergePipeline, guardFor: () => new MergeGuard(new Verifier(log), log) } } : {}),
      // 靜置期關閉：harness 是現場建任務馬上跑，預設 15 分鐘會讓整個測試乾等。
      // 靜置期本身由 quiet-period / orchestrator 的單元測試覆蓋。
      quietMinutesOf: () => 0,
      // 刻意不注入 reviewWatcher：本地模式沒有 gh，藉此觀察「沒有推進者」會不會被點名
    },
    1,
  );

  // ── tick 迴圈 ────────────────────────────────────────────────────────
  /** 每個任務最多模擬回覆幾次（探針 T-5 需要反覆回覆才看得出有沒有出口）。 */
  const MAX_HUMAN_REPLIES = 6;
  const answered = new Map<string, number>();
  let approvedOnce = false;

  for (let t = 1; t <= MAX_TICKS; t += 1) {
    obs.ticks = t;
    mcp.tick = t;
    log.info({ tick: t }, `═══════════ tick ${t} ═══════════`);

    await orch.tick();
    // 規劃是背景跑的（見 orchestrator 的 startPlanning）。這個腳本要驗的是
    // 「一輪走完會發生什麼」，所以每輪都等它收尾——不等的話建群會落在下一輪，
    // 而且腳本結束時 ledger 已經關掉，背景規劃會撞到 "database is not open"。
    await orch.settlePlanning();
    const idle = await waitIdle(dispatcher, IDLE_TIMEOUT_MS);
    if (!idle) {
      note('tick 迴圈不卡住', false, `tick ${t}：dispatcher 在 ${IDLE_TIMEOUT_MS}ms 內沒有釋放 slot`);
      break;
    }

    const groups = allGroups(ledger);

    // 觀測：park 時 worktree 是否保留（agent 未提交的成果不能被清掉）
    for (const g of groups) {
      if (g.state === 'changes_requested' && !obs.parkedWorktreeSeen.has(g.id)) {
        obs.parkedWorktreeSeen.set(g.id, existsSync(worktreePathOf(g.branch)));
      }
    }

    // 模擬「人回覆」：等澄清 → 送答覆；等人確認（no_change/needs_human）→ 送 retry 控制指令。
    // 刻意延到第 2 輪之後才回覆：讓 T-4（依賴 T-2）在 T-2 尚未完成時被派工一次，
    // 才驗得到「start_task 回 signal → 群回 ready 等重派」這條 §6 的 signal 路徑。
    if (t < 2) {
      log.info({ tick: t }, '（模擬）人還沒回覆，本輪先不處理 blocked 任務');
    }
    for (const task of t < 2 ? [] : blockedTasks(ledger)) {
      const used = answered.get(task.id) ?? 0;
      if (used >= MAX_HUMAN_REPLIES) continue;
      if (task.block?.reason === 'needs_clarification') {
        answered.set(task.id, used + 1);
        log.warn({ taskId: task.id }, '🧑 （模擬）人在 Slack 回答了澄清');
        gateway.emitAnswer({ taskId: task.id, threadTs: `ts-${task.id}`, optionId: '回傳 0' });
      } else if (task.block?.reason === 'needs_human') {
        answered.set(task.id, used + 1);
        // 「無需改動」的卡有專屬出口：confirm_no_change → complete_task 結案。
        // 先前這裡一律送 retry，等於逼 agent 再跑一輪、再宣告一次，永遠繞不出去（㉓）。
        // 真人在 Slack 按 [確認不用做]、或用 `npm run ask -- <id> confirm` 走的都是這條。
        // 「無需改動」有兩個合法出口，兩條都要驗：
        //   - 探針 T-5 是真的不用做 → 人按「確認不用做」→ complete_task 結案
        //   - T-3 其實該做（agent 誤判）→ 人按「請你去做」→ 回 queued 重跑，這輪才會真的改 README
        //     （⑫ 的「docs → 自動合併」要靠這條路徑才產生得出純文件變更）
        const isNoChange = (task.block.detail ?? '').startsWith('無需改動');
        if (isNoChange && task.id === PROBE_TASK_ID) {
          log.warn({ taskId: task.id, nth: used + 1 }, '🧑 （模擬）人確認「這張卡確實不用做」');
          gateway.emitControl({ type: 'confirm_no_change', taskId: task.id, userId: 'U-HUMAN' });
        } else if (isNoChange) {
          log.warn({ taskId: task.id, nth: used + 1 }, '🧑 （模擬）人判定 agent 誤判 → 請它去做');
          gateway.emitControl({ type: 'retry', taskId: task.id, userId: 'U-HUMAN', source: 'no_change_rejected' });
        } else {
          log.warn({ taskId: task.id, nth: used + 1 }, '🧑 （模擬）人在 Slack 下 retry / 用你的預設');
          gateway.emitControl({ type: 'retry', taskId: task.id });
        }
      }
    }

    // 探針 B（第 12 輪）：對一個**正在 park（changes_requested）** 的群送出合併核准。
    // 想驗的是：InboundRouter.handleMergeDecision 不看群組現在的狀態就寫 merge_guard，
    // 這會不會把「等人回覆、可恢復」的 park 狀態直接毀掉（park 的成果從此無法恢復）。
    if (t === 12) {
      const parked = allGroups(ledger).find((g) => g.state === 'changes_requested');
      if (parked) {
        strayApproval.before = parked.state;
        strayApproval.groupId = parked.id;
        log.warn({ group: parked.id, state: parked.state }, '🧑 （模擬）人對一個 park 中的群按了「核准合併」');
        gateway.emitMergeDecision({ groupId: parked.id, approved: true, userId: 'U-STRAY' });
      }
    }

    // 模擬「人核准合併」：政策判定需人工的群，第一次被問到就核准。
    // 條件必須是「已經有核准請求」——寫成 ===0 會讓這段永遠不執行（那時還沒有群在等核准），
    // 於是 ⑭/⑳ 會誤報成「合併鏈路壞掉」，其實是 harness 自己沒按下核准。
    // 核准「所有」在等的群：真實環境是 ReviewWatcher 或人逐一處理，只核准一次會讓其餘的
    // 群永遠停在 in_review，⑳ 就會把 harness 的模擬不足誤報成產品缺陷。
    if (gateway.approvalRequests.length > 0) {
      // pr_open 也要核准：真實環境由 ReviewWatcher 或人推進；只認 in_review 的話
      // 「已開 PR 等審查」的群會永遠停著，被 ⑳ 誤報成產品缺陷（其實是模擬不足）
      const waiting = groups.find((g) => (g.state === 'in_review' || g.state === 'pr_open') && g.prNumber !== undefined);
      if (waiting) {
        approvedOnce = true;
        log.warn({ group: waiting.id }, '🧑 （模擬）人在 Slack 核准了合併');
        gateway.emitMergeDecision({ groupId: waiting.id, approved: true, userId: 'U-HUMAN' });
      }
    }

    // 只有在「所有卡都已派發過」之後才允許提早收工，否則探針任務永遠不會被跑到
    if (
      t > LAST_REVEAL_TICK + 1 &&
      groups.length > 0 &&
      groups.every((g) => SETTLED.includes(g.state)) &&
      dispatcher.activeCount() === 0
    ) {
      log.info({ tick: t }, '所有群組皆進入停止狀態，結束迴圈');
      break;
    }
  }

  answeredSnapshot = answered;
  await evaluate(ledger, mcp, agent, gateway, fakePr, mergedPrs);
  await report(ledger);

  ledger.close();
  if (!KEEP) {
    // 自我清理：先移除 worktree 登記，再刪整個 /tmp 工作目錄
    await execa('git', ['-C', REPO_PATH, 'worktree', 'prune'], { reject: false });
    rmSync(ROOT, { recursive: true, force: true });
  } else {
    log.warn({ ROOT }, '--keep：保留現場');
  }

  const failed = stages.filter((s) => !s.ok).length;
  process.exit(failed === 0 ? 0 : 1);
}

// ── 小工具 ──────────────────────────────────────────────────────────────

function allGroups(ledger: Ledger): Group[] {
  const states: GroupState[] = ['forming', 'ready', 'pr_open', 'in_review', 'changes_requested', 'merge_guard', 'merged', 'failed'];
  return states.flatMap((s) => ledger.listGroupsByState(s));
}

function blockedTasks(ledger: Ledger) {
  return ledger.listTasksByState('blocked');
}

function worktreePathOf(branch: string): string {
  return join(resolve(WORKTREE_BASE), branch.replace(/[^a-zA-Z0-9._-]/g, '-'));
}

async function waitIdle(dispatcher: Dispatcher, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (dispatcher.activeCount() > 0) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(200);
  }
  return true;
}

// ── 評估 ────────────────────────────────────────────────────────────────

async function evaluate(
  ledger: Ledger,
  mcp: FakeMcp,
  agent: ScriptedAgent,
  gateway: FakeGateway,
  fakePr: FakePrManager,
  mergedPrs: { prNumber: number; approvedBy: string }[],
): Promise<void> {
  const PROBE = PROBE_TASK_ID;
  const MAIN_TASKS = TASKS.filter((t) => t.id !== PROBE);
  const probeGroupId = ledger.getTask(PROBE)?.groupId;
  const groups = allGroups(ledger).filter((g) => g.id !== probeGroupId);
  const tasks = TASKS.map((t) => ledger.getTask(t.id));

  // 1) poll
  const discovered = tasks.filter((t) => t !== undefined).length;
  note('① poll → 任務落地 ledger', discovered === TASKS.length, `ledger 有 ${discovered}/${TASKS.length} 個任務`);

  // 2) plan / 建群
  const groupOf = (id: string) => ledger.getTask(id)?.groupId;
  const sameGroup = groupOf('T-1') !== undefined && groupOf('T-1') === groupOf('T-2');
  const t3Alone = groupOf('T-3') !== undefined && groupOf('T-3') !== groupOf('T-1');
  note(
    '② plan → 分群（依賴/共用規格同群、無關者分群）',
    sameGroup && t3Alone,
    `T-1=${groupOf('T-1')} T-2=${groupOf('T-2')} T-3=${groupOf('T-3')} T-4=${groupOf('T-4')}；共 ${groups.length} 群`,
  );

  // 3) dispatch
  note('③ dispatch → 群被派出', obs.dispatched.length > 0, `共派出 ${obs.dispatched.length} 次：${obs.dispatched.map((d) => `t${d.tick}:${d.groupId}`).join(', ')}`);

  // 4) worker + DoD + complete_task
  const doneTasks = MAIN_TASKS.filter((t) => ledger.getTask(t.id)?.state === 'done').map((t) => t.id);
  // 每個主線任務都要被 complete 一次；探針 T-5 由人 confirm_no_change 結案，
  // 那也會走 complete_task（合法且必要——否則任務板上的卡永遠關不掉），故只要求「不少於」。
  const mainCompleted = new Set(mcp.completeCalls.map((c) => c.id).filter((id) => MAIN_TASKS.some((t) => t.id === id)));
  note(
    '④ Worker → DoD 綠燈 → complete_task',
    mainCompleted.size === MAIN_TASKS.length,
    `主線 complete_task ${mainCompleted.size}/${MAIN_TASKS.length}（全部呼叫：${mcp.completeCalls.map((c) => c.id).join(', ')}）；ledger done=${doneTasks.join(', ')}`,
  );

  // 5) park：ask_human
  const t2Parked = ledger.listEvents({ scope: 'group', kind: 'group_parked', limit: 50 });
  const askedParked = t2Parked.some((e) => (e.detail ?? '').includes('T-2'));
  note('⑤ park（ask_human）→ 群組進入可恢復狀態', askedParked, t2Parked.map((e) => e.detail).join(' | ') || '（沒有 group_parked 事件）');

  // 6) park：report_no_change
  const noChangeReported = ledger.listEvents({ scope: 'task', kind: 'no_change_reported', limit: 20 });
  const noChangeParked = t2Parked.some((e) => (e.detail ?? '').includes('T-3'));
  note(
    '⑥ park（report_no_change）→ 不自動 complete，交人確認',
    noChangeReported.length > 0 && noChangeParked,
    `no_change_reported=${noChangeReported.length}；park 事件含 T-3=${noChangeParked}`,
  );

  // 7) park 時 worktree 必須保留
  const keptAll = [...obs.parkedWorktreeSeen.values()];
  note(
    '⑦ park 時保留 worktree（未提交成果不遺失）',
    keptAll.length > 0 && keptAll.every(Boolean),
    `觀測 ${keptAll.length} 個 park 群組，worktree 存在=${JSON.stringify([...obs.parkedWorktreeSeen])}`,
  );

  // 8) 人回覆 → requeue → 重新派工
  const requeued = ledger.listEvents({ scope: 'group', kind: 'requeued', limit: 50 });
  note(
    '⑧ 人回覆 → requeue → 群組重新派工',
    requeued.length > 0,
    requeued.map((e) => `${e.refId}:${e.detail}`).join(' | ') || '（沒有 requeued 事件 → park 的任務永久遺失）',
  );

  // 9) 重新派工時不重跑已完成的任務
  const skipped = ledger.listEvents({ scope: 'task', kind: 'skipped_already_done', limit: 20 });
  const doubleStart = mcp.startCalls.filter((c) => !c.ok && c.kind === 'permanent');
  note(
    '⑨ 重派時不重跑已 done 的任務',
    skipped.length > 0 && doubleStart.length === 0,
    `skipped_already_done=${skipped.length}；被 MCP 拒絕的重複認領=${doubleStart.length}`,
  );

  // 10) 依賴未完成 → 不派工，等前置的成果真的進 base 之後才做
  //
  //     擋點從「MCP 拒絕認領」往前移到「派工前」了：現在會先看前置任務所在的群組
  //     有沒有 merged，沒有就不派這一群。這比原本乾淨——不會白建 worktree、白啟 agent，
  //     也補上了原本的漏洞：MCP 認定 done 的時機是 agent 呼叫 complete_task，
  //     那時 PR 才剛開、成果**還不在 base 裡**，下游卻已經被放行。
  //
  //     MCP 的 signal 機制仍然在（處理「前置任務不在本調度器範圍內」的情況），
  //     只是這個劇本的兩個任務都在範圍內，所以走的是新的擋點。
  const depSignals = mcp.startCalls.filter((c) => c.kind === 'signal');
  const t4Done = ledger.getTask('T-4')?.state === 'done';
  note(
    '⑩ 依賴未完成 → 等前置進 base 後才做（T-4 依賴 T-2）',
    t4Done,
    `T-4 最終=${ledger.getTask('T-4')?.state}；MCP signal ${depSignals.length} 次（新擋點在派工前，signal=0 是正常的）`,
  );

  // 11) Merge Guard
  const guardBlocked = ledger.listEvents({ scope: 'group', kind: 'merge_guard_blocked', limit: 20 });
  const caveats = ledger.listEvents({ scope: 'group', kind: 'merge_guard_caveat', limit: 20 });
  note('⑪ Merge Guard 通過（無阻擋）', guardBlocked.length === 0, `blocked=${guardBlocked.length}；但書=${caveats.length}（${caveats[0]?.detail ?? '無'}）`);

  // 12) 合併決策：自動合併關著時，每一群都要走到「等人核准」
  //     （政策引擎已移除——它靠比對檔案路徑猜「這個改動危不危險」，
  //      那是在猜別人的 repo 長什麼樣。現在是一個開關 ＋ 一個看得懂 repo 的判斷者。）
  const clearEvents = ledger.listEvents({ scope: 'group', kind: 'merge_risk_clear', limit: 20 });
  const humanEvents = ledger.listEvents({ scope: 'group', kind: 'merge_risk_needs_human', limit: 20 });
  note(
    '⑫ 合併決策（自動合併關著 → 一律等人核准）',
    humanEvents.length > 0,
    `needs_human=${humanEvents.length}、clear=${clearEvents.length}`,
  );

  // 13) GroupRunner 本地合併
  const localMerged = ledger.listEvents({ scope: 'group', kind: 'merged', limit: 20 });
  note('⑬ 有群組真的被合併', localMerged.length > 0, localMerged.map((e) => `${e.refId}:${e.detail}`).join(' | ') || '（沒有任何群組被合併）');

  // 14) 人工核准 → Orchestrator 合併佇列 → 合併 PR
  note(
    '⑭ 人工核准 → Merge Guard → 合併 PR',
    mergedPrs.length > 0,
    mergedPrs.length > 0
      ? `合併 PR #${mergedPrs.map((m) => m.prNumber).join(',')}（核准者 ${mergedPrs.map((m) => m.approvedBy).join(',')}）`
      : `未合併任何 PR；核准請求=${gateway.approvalRequests.length}、開過的 PR=${fakePr.opened.length}`,
  );

  // 15) 終態
  const stuck = groups.filter((g) => !SETTLED.includes(g.state));
  note(
    '⑮ 所有群組進入終態/停止狀態（不卡住）',
    stuck.length === 0,
    groups.map((g) => `${g.id}=${g.state}`).join(', '),
  );

  // 16) 殘留
  const wtList = await execa('git', ['-C', REPO_PATH, 'worktree', 'list', '--porcelain'], { reject: false });
  const leftovers = wtList.stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .filter((p) => resolve(p) !== resolve(REPO_PATH));
  const expectMergeWorkspace = leftovers.filter((p) => p.includes('merge-worktrees'));
  const groupLeftovers = leftovers.filter((p) => p.includes(join('worktrees')) && !p.includes('merge-worktrees'));
  note(
    '⑯ 無殘留（群組 worktree 已清理）',
    groupLeftovers.length === 0,
    `群組 worktree 殘留=${groupLeftovers.length}${groupLeftovers.length ? `（${groupLeftovers.join(', ')}）` : ''}；合併專用 worktree=${expectMergeWorkspace.length}（設計上會保留）`,
  );

  // 17) agent 不被逼著亂改（no_change 不該直接 complete）
  const overridden = ledger.listEvents({ scope: 'task', kind: 'no_change_overridden', limit: 20 });
  note(
    '⑰ 零 diff 出口沒有誤殺（no_change 不自動結案、也沒被作廢）',
    overridden.length === 0,
    `no_change_overridden=${overridden.length}`,
  );

  // 18) PR 與合併的一致性：開了 PR 卻走本地合併 → PR 變孤兒（分支已進 base，PR 仍開著）
  const localMergeGroups = ledger
    .listEvents({ scope: 'group', kind: 'merged', limit: 50 })
    .filter((e) => (e.detail ?? '').startsWith('commit '))
    .map((e) => e.refId);
  const orphanPrs = localMergeGroups
    .map((gid) => (gid ? ledger.getGroup(gid) : undefined))
    .filter((g): g is Group => g !== undefined && g.prNumber !== undefined);
  note(
    '⑱ PR 與合併一致（沒有「開了 PR 又本地合併」的孤兒 PR）',
    orphanPrs.length === 0,
    orphanPrs.length === 0
      ? `開過 ${fakePr.opened.length} 個 PR、遠端合併 ${mergedPrs.length} 個、本地合併 ${localMergeGroups.length} 個`
      : `${orphanPrs.length} 個群組開了 PR（#${orphanPrs.map((g) => g.prNumber).join(',')}）卻走本地合併，PR 永遠不會被關閉/合併`,
  );

  // 19) Slack thread 映射寫回 ledger（入站回覆的唯一反查依據）
  const withThread = TASKS.filter((t) => ledger.getTask(t.id)?.slackThreadTs).length;
  note('⑲ 任務 thread_ts 寫回 ledger（一任務一 thread）', withThread === TASKS.length, `${withThread}/${TASKS.length} 個任務有 slack_thread_ts`);

  // 19b) 政策判定 needs_human 時，人到底有沒有被「問到」（Slack 核准閘門）
  note(
    '⑲b 需人工核准 → 有發出 Slack 核准請求',
    gateway.approvalRequests.length > 0,
    `policy_needs_human=${humanEvents.length} 次，但 askMergeApproval 只被呼叫 ${gateway.approvalRequests.length} 次`,
  );

  // 20) 卡在無推進者的狀態（pr_open/in_review 沒接 ReviewWatcher）
  const awaiting = groups.filter((g) => g.state === 'pr_open' || g.state === 'in_review');
  note(
    '⑳ 沒有群組永久卡在「等審查但無推進者」',
    awaiting.length === 0,
    awaiting.length === 0 ? '無' : `${awaiting.map((g) => `${g.id}=${g.state}`).join(', ')}（未接 ReviewWatcher 時只能靠人工核准）`,
  );

  // 21) agent 呼叫次數（是否有非預期的重跑/空轉）
  const perTask = new Map<string, number>();
  for (const c of agent.calls) perTask.set(c.taskId, (perTask.get(c.taskId) ?? 0) + 1);
  const expected: Record<string, number> = { 'T-1': 1, 'T-2': 2, 'T-3': 2, 'T-4': 1 };
  const extra = [...perTask.entries()].filter(([id, n]) => id !== PROBE && n > (expected[id] ?? 1));
  note(
    '㉑ 無多餘迭代（agent 呼叫次數符合腳本）',
    extra.length === 0,
    `每任務呼叫次數 ${JSON.stringify(Object.fromEntries(perTask))}（預期 ${JSON.stringify(expected)}）`,
  );

  // 22) 空轉：同一個群被反覆派出卻沒有進展（deps 未解時每輪重建/刪除 worktree）
  const perGroup = new Map<string, number>();
  for (const d of obs.dispatched) perGroup.set(d.groupId, (perGroup.get(d.groupId) ?? 0) + 1);
  const spinning = [...perGroup.entries()].filter(([id, n]) => n > 3 && id !== probeGroupId);
  note(
    '㉒ 沒有群組空轉（派工次數合理）',
    spinning.length === 0,
    `每群派工次數 ${JSON.stringify(Object.fromEntries(perGroup))}（探針群 ${probeGroupId} 不計）`,
  );

  // 23) 探針：一張「真的不需要改動」的卡有沒有出口（§7b / D18 的誤殺風險）
  const probeTask = ledger.getTask(PROBE);
  const probeGroup = probeGroupId ? ledger.getGroup(probeGroupId) : undefined;
  const probeRequeues = ledger
    .listEvents({ scope: 'group', refId: probeGroupId ?? null, kind: 'requeued', limit: 50 })
    .length;
  const probeAgentCalls = agent.calls.filter((c) => c.taskId === PROBE).length;
  const probeSettled = probeTask?.state === 'done' || probeGroup?.state === 'merged' || probeGroup?.state === 'failed';
  note(
    '㉓ 探針：合法「無需改動」的卡有出口（不會永久卡住）',
    probeSettled,
    `T-5 state=${probeTask?.state}/${probeTask?.block?.reason ?? '-'}；群 ${probeGroupId}=${probeGroup?.state}；` +
      `人回覆 ${answeredCount(PROBE)} 次、群被 requeue ${probeRequeues} 次、agent 跑了 ${probeAgentCalls} 輪，仍未結案`,
  );

  // 23b) 探針 B：對 park 中的群送核准，park 狀態會不會被毀掉
  if (strayApproval.groupId) {
    const after = ledger.getGroup(strayApproval.groupId)?.state;
    const recoverable = after === 'changes_requested';
    note(
      '㉓b 探針：對 park 中的群誤按「核准合併」不會毀掉可恢復狀態',
      recoverable,
      `群 ${strayApproval.groupId}：${strayApproval.before} → ${after}` +
        (recoverable ? '' : '（離開 changes_requested ⇒ shouldRequeueGroup 再也不成立，park 的成果無法恢復）'),
    );
  }

  // 25) 人回覆之後，agent 那一輪要**真的收到答案**並接回原 session。
  //     這條是最容易靜默壞掉的一段：答覆只寫進 ledger、沒送回 agent 時，
  //     整條鏈路看起來照常運作（任務會完成），但真實 agent 會再問一次同樣的問題。
  const t2Rounds = agent.resumes.filter((r) => r.taskId === 'T-2');
  const resumed = t2Rounds.find((r) => r.answer !== undefined);
  note(
    '㉕ 人回覆有送到 agent 手上（注入答覆 + 接回原 session）',
    resumed !== undefined && resumed.resume === 'sess-T2',
    resumed
      ? `第 ${resumed.step} 輪：resume=${resumed.resume ?? '(無)'}　答覆=「${resumed.answer}」`
      : `T-2 共 ${t2Rounds.length} 輪，沒有任何一輪收到人的答覆（答案掉了）`,
  );

  // 26) 每一次 agent 執行都要留下 task_id ↔ session_id 的對照（含沒有互動的）
  const withSession = TASKS.map((t) => ({ id: t.id, s: ledger.latestAgentSession(t.id) })).filter((x) => x.s);
  const ranTasks = new Set(agent.calls.map((c) => c.taskId));
  note(
    '㉖ 每個跑過 agent 的任務都有 session 紀錄（事後查 log 的唯一對照鍵）',
    withSession.length === ranTasks.size,
    `跑過 agent 的任務 ${ranTasks.size} 個，有 session 紀錄 ${withSession.length} 個`
      + `（${withSession.map((x) => `${x.id}=${x.s!.sessionId}/${x.s!.rounds}輪`).join(', ')}）`,
  );

  // 27) 每一次關卡執行都要進 check_runs。
  //
  // 這條探針的存在理由：記帳是**旁路**，接錯了不會有任何症狀——typecheck 綠、
  // 測試綠、daemon 照跑，只是那張表永遠是空的。而空表看起來就像「這個關卡從來沒跑過」。
  const runs = ledger.listCheckRuns({ limit: 500 });
  const kinds = new Set(runs.map((r) => r.workspaceKind));
  const withOutput = runs.filter((r) => (r.output ?? '') !== '').length;
  note(
    '㉗ 每一次關卡執行都留下 check_runs（含全文輸出與 exit code）',
    runs.length > 0 && runs.every((r) => r.command !== '' && r.requestedBy !== undefined),
    runs.length === 0
      ? '一列都沒有——記帳沒接上（症狀只有這張表是空的，其他全綠）'
      : `${runs.length} 列，工作區種類 ${[...kinds].join('/')}，有輸出的 ${withOutput} 列`,
  );

  // 28) 工具計數要累到任務層級（協定一致性檢查唯一的資料源）。
  // 假件 agent 不會產生真的工具呼叫，所以這裡驗的是**管道有沒有通**：
  // 跑過 agent 的任務都要有 toolCalls 這個欄位（就算是空物件），
  // 因為「跑了一輪什麼都沒用」與「從來沒跑過」是不同的事實。
  const ranIds = [...new Set(agent.calls.map((c) => c.taskId))];
  const counted = ranIds.filter((id) => ledger.getTask(id)?.toolCalls !== undefined);
  note(
    '㉘ 跑過 agent 的任務都有累計的工具計數（管道通了，不是靜默的 undefined）',
    counted.length === ranIds.length,
    `跑過 ${ranIds.length} 個，有計數 ${counted.length} 個`,
  );

  // 29) 群內共用 session ＋ 交付說明落 DB。
  //
  // 兩件事一起驗，因為它們互為前提：共用 session 讓 context 跨任務連貫，
  // 而 context 會被自動壓縮——關鍵決策靠交付說明保住（壓縮壓不掉 DB）。
  // 只做其中一件的話，要嘛第二個任務是全新 context（等於沒有一起做），
  // 要嘛存了沒人讀。
  const deliveries = ledger.listHandoffs({ kind: 'delivery' });
  const multi = [...new Set(TASKS.map((t) => ledger.getTask(t.id)?.groupId).filter(Boolean))]
    .map((g) => ledger.getGroup(g as string))
    .filter((g) => g && g.taskIds.length > 1);
  note(
    '㉙ 每個跑過 agent 的任務都留下交付說明（下一個任務靠它接脈絡，不靠記憶）',
    deliveries.length > 0 && deliveries.every((h) => h.body.trim() !== '' && h.blocking === false),
    deliveries.length === 0
      ? '一張都沒有——交付說明沒接上，群內第二個任務會是全新 context'
      : `${deliveries.length} 張（多任務群 ${multi.length} 個），全部有內容且不擋流程`,
  );

  // 24) done 的任務不該還掛著 block_reason（狀態資料一致性）
  const staleBlocks = TASKS.map((t) => ledger.getTask(t.id)).filter((t) => t?.state === 'done' && t.block !== undefined);
  note(
    '㉔ done 的任務沒有殘留的 block 標記',
    staleBlocks.length === 0,
    staleBlocks.length === 0 ? '無' : staleBlocks.map((t) => `${t!.id}:block=${t!.block?.reason}`).join(', '),
  );
}

/** 供 ㉓ 使用：harness 對某任務模擬了幾次人工回覆。 */
let answeredSnapshot = new Map<string, number>();
const answeredCount = (id: string): number => answeredSnapshot.get(id) ?? 0;

/** 探針 B：對 park 中的群送出合併核准前後的狀態。 */
const strayApproval: { groupId?: string; before?: string } = {};

async function report(ledger: Ledger): Promise<void> {
  console.log('\n════════════ 完整 daemon e2e 摘要 ════════════');
  console.log(`tick 數：${obs.ticks}（上限 ${MAX_TICKS}）`);
  console.log('❌ 代表「真實鏈路的問題」，不是 harness 沒接好——每一項的 detail 就是證據。\n');

  for (const s of stages) {
    console.log(`${s.ok ? '✅' : '❌'} ${s.name}`);
    console.log(`     ${s.detail}`);
  }

  console.log('\n──── 群組狀態轉移軌跡（tN = 第 N 輪 tick）────');
  for (const [id, trail] of obs.groupStateTrail) {
    const g = ledger.getGroup(id);
    console.log(`  ${id}  [${g?.taskIds.join(',')}]`);
    console.log(`     ${trail.join(' → ')}`);
  }

  console.log('\n──── 任務狀態轉移軌跡 ────');
  for (const t of TASKS) {
    const row = ledger.getTask(t.id);
    console.log(`  ${t.id}  最終 state=${row?.state} block=${row?.block?.reason ?? '-'} group=${row?.groupId ?? '-'} attempts=${row?.attempts}`);
    console.log(`     ${(obs.taskStateTrail.get(t.id) ?? []).join(' → ')}`);
  }

  const bad = stages.filter((s) => !s.ok);
  console.log(`\n結論：${bad.length === 0 ? '✅ 完整 daemon 鏈路端到端通過' : `❌ ${bad.length} 個階段未達成：${bad.map((b) => b.name).join('、')}`}`);
}

main().catch((e) => {
  log.error({ err: e instanceof Error ? e.stack : String(e) }, 'e2e-daemon 失敗');
  console.log('\n════════════ 中斷前已完成的階段 ════════════');
  for (const s of stages) console.log(`${s.ok ? '✅' : '❌'} ${s.name} — ${s.detail}`);
  process.exit(1);
});
