/**
 * 主幹端到端 harness：mock MCP → worktree → agent → Verifier(真跑 npm test) → complete_task。
 *
 *   npx tsx scripts/e2e-trunk.ts --dry    # 假 agent（真寫檔），無需 token，驗證整條主幹接線
 *   npx tsx scripts/e2e-trunk.ts          # 真 AgentRuntime（需 .env 的 ANTHROPIC_AUTH_TOKEN/BASE_URL）
 */
import { execa } from 'execa';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/config/env.js';
import { createLogger } from '../src/observability/logger.js';
import { Ledger } from '../src/store/ledger.js';
import { WorktreeManager } from '../src/git/worktree.js';
import { Verifier } from '../src/worker/verifier.js';
import { AgentRuntime } from '../src/worker/agent-runtime.js';
import { ProgressMonitor } from '../src/worker/progress.js';
import { ConsoleNotifier } from '../src/notify/notifier.js';
import { gitDiffHash } from '../src/git/status.js';
import { Worker } from '../src/worker/worker.js';
import type { AgentLike, McpTaskClient } from '../src/contracts.js';
import type { McpOut, TaskDetail } from '../src/types.js';

const DRY = process.argv.includes('--dry');
const log = createLogger();
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(repoRoot, 'data/fixtures/sample-project');

// mock MCP：派一個「在 sample-project 新增 subtract(a,b) 並補測試」的任務
const mockTask: TaskDetail = {
  id: 'E2E-1',
  title: '新增 subtract 函式',
  status: 'todo',
  repo: 'local/sample-project',
  category: 'dev',
  description:
    '在 sample-project 新增一個 subtract(a, b) 函式（回傳 a - b），放在 subtract.js 並以 module.exports 匯出；' +
    '另新增 subtract.test.js 用 node:test 撰寫一個會通過的測試。不要更動既有的 sum。',
  dependencies: [],
  docRefs: [],
};

class MockMcp implements McpTaskClient {
  completed: { id: string; summary?: string }[] = [];
  async startTask(id: string): Promise<McpOut<TaskDetail>> {
    log.info({ id }, 'mock MCP：start_task');
    return { ok: true, value: mockTask };
  }
  async completeTask(id: string, opts?: { summary?: string }): Promise<McpOut<void>> {
    this.completed.push({ id, summary: opts?.summary });
    log.info({ id }, 'mock MCP：complete_task');
    return { ok: true, value: undefined };
  }
  async loadDocs() {
    return [];
  }
}

// 假 agent（--dry）：真的把檔案寫進 worktree，讓 Verifier 有東西可驗
const dryAgent: AgentLike = {
  async iterate(input) {
    writeFileSync(
      join(input.cwd, 'subtract.js'),
      'function subtract(a, b) {\n  return a - b;\n}\nmodule.exports = { subtract };\n',
    );
    writeFileSync(
      join(input.cwd, 'subtract.test.js'),
      "const test = require('node:test');\nconst assert = require('node:assert');\nconst { subtract } = require('./subtract');\n\ntest('subtract subtracts', () => {\n  assert.equal(subtract(5, 3), 2);\n});\n",
    );
    return { sessionId: 'dry', resultText: '已新增 subtract 與測試', isError: false };
  },
};

async function main() {
  const auth = loadEnv();
  log.info({ mode: DRY ? 'dry（假 agent）' : 'live（真 AgentRuntime）', auth: auth.method }, '啟動 e2e');
  if (!DRY && auth.method === 'none') {
    log.error('live 模式需要 .env 的 ANTHROPIC_AUTH_TOKEN（或 ANTHROPIC_API_KEY）。可先用 --dry。');
    process.exit(2);
  }

  // 1) 重建 fixture
  await execa('bash', [join(repoRoot, 'scripts/make-fixture.sh')], { cwd: repoRoot });

  // 2) 開群組 worktree
  const scratch = mkdtempSync(join(tmpdir(), 'orch-e2e-'));
  const wm = new WorktreeManager(join(scratch, 'worktrees'), log);
  const wt = await wm.create(fixture, 'group/e2e');

  // 3) 組裝 Worker（除 agent 外皆真件）
  const ledger = new Ledger(join(scratch, 'ledger.db'), log);
  ledger.init();
  ledger.upsertDiscoveredTask({
    id: mockTask.id, payloadHash: 'h', repo: mockTask.repo, category: mockTask.category,
    title: mockTask.title, description: mockTask.description, dependencies: [], docRefs: [],
  });

  const mcp = new MockMcp();
  const worker = new Worker({
    mcp,
    agent: DRY ? dryAgent : new AgentRuntime(log),
    verifier: new Verifier(log),
    progress: new ProgressMonitor(ledger, 3),
    ledger,
    notifier: new ConsoleNotifier(log),
    diffHash: gitDiffHash,
    log,
  });

  // 4) 跑
  const outcome = await worker.runTask({
    task: mockTask,
    cwd: wt.path,
    verifierConfig: { build: 'npm run build', test: 'npm test', lint: 'npm run lint' },
  });

  // 5) 檢查結果
  log.info({ outcome }, 'e2e 結果');
  const producedFile = existsSync(join(wt.path, 'subtract.js'));
  const testRan = (await execa('npm', ['test'], { cwd: wt.path, reject: false })).stdout.includes('subtract');
  const ok = outcome.status === 'done' && mcp.completed.length === 1 && producedFile;

  console.log('\n──────── e2e 摘要 ────────');
  console.log(`模式         : ${DRY ? 'dry' : 'live'}`);
  console.log(`outcome      : ${outcome.status}`);
  console.log(`complete_task: ${mcp.completed.length} 次`);
  console.log(`subtract.js  : ${producedFile ? '已產生' : '未產生'}`);
  console.log(`ledger 狀態  : ${ledger.getTask('E2E-1')?.state}`);
  console.log(`結論         : ${ok ? '✅ 主幹端到端通過' : '❌ 未達成'}`);

  // 6) 清理
  ledger.close();
  await wm.remove(fixture, wt.path);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  log.error({ err: e instanceof Error ? e.message : String(e) }, 'e2e 失敗');
  process.exit(1);
});
