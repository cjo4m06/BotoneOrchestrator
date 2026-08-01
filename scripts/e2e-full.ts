/**
 * 完整合併週期 e2e（純本地，on 沙盒，不推送、不部署）：
 *   真實 spec → 真 agent 編程 → npm run build → Merge Guard(rebase+重測) → 本地合併 → 合併後 build → PR 內文
 *
 *   MCP_URL=.. MCP_TOKEN=.. npx tsx scripts/e2e-full.ts [taskId]
 *
 * 保護措施：start/complete_task 用安全樁（不動任務板）；loadDocs 為真實。全程本地，無 push/deploy。
 */
import { execa } from 'execa';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/config/env.js';
import { createLogger } from '../src/observability/logger.js';
import { Ledger } from '../src/store/ledger.js';
import { Verifier } from '../src/worker/verifier.js';
import { AgentRuntime } from '../src/worker/agent-runtime.js';
import { ProgressMonitor } from '../src/worker/progress.js';
import { ConsoleNotifier } from '../src/notify/notifier.js';
import { gitDiffHash } from '../src/git/status.js';
import { Worker } from '../src/worker/worker.js';
import { PmmMcpClient } from '../src/mcp/mcp-client.js';
import { PrManager } from '../src/pr/pr-manager.js';
import { MergeGuard } from '../src/pr/merge-guard.js';
import { generatePrBody } from '../src/pr/pr-body.js';
import type { McpTaskClient } from '../src/contracts.js';
import type { McpOut, TaskDetail } from '../src/types.js';

const TASK_ID = process.argv[2] ?? 'tKgVw3AuaWPO';
const log = createLogger();
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const SANDBOX = join(repoRoot, 'data/repos/Baolu-sandbox');
const BUILD = { build: 'npm run build' };

const git = (args: string[]) => execa('git', ['-C', SANDBOX, ...args], { reject: false });

/** 真實 loadDocs，但 start/complete 樁化以保護任務板。 */
class BoardSafeMcp implements McpTaskClient {
  constructor(private real: PmmMcpClient, private task: TaskDetail) {}
  async startTask(): Promise<McpOut<TaskDetail>> {
    log.info({ id: this.task.id }, '（demo 樁）start_task：跳過以保護任務板');
    return { ok: true, value: this.task };
  }
  async completeTask(): Promise<McpOut<void>> {
    log.info({ id: this.task.id }, '（demo 樁）complete_task：跳過以保護任務板');
    return { ok: true, value: undefined };
  }
  loadDocs(refs: string[]) {
    return this.real.loadDocs(refs);
  }
}

async function main() {
  const auth = loadEnv();
  if (auth.method === 'none') {
    log.error('需要 .env 的 ANTHROPIC_AUTH_TOKEN');
    process.exit(2);
  }

  const client = new PmmMcpClient({ url: process.env.MCP_URL!, token: process.env.MCP_TOKEN! }, log);
  await client.connect();
  const detail = await client.getTask(TASK_ID);
  log.info({ id: detail.id, title: detail.title, docRefs: detail.docRefs.length }, '取得真實任務');

  // 乾淨的 main 基準（保留 node_modules：clean 不帶 -x）
  await git(['checkout', '-q', 'main']);
  await git(['reset', '-q', '--hard']);
  await git(['clean', '-qfd']);
  const branch = `orch/e2e-${TASK_ID}`;
  await git(['branch', '-D', branch]).catch(() => {});
  await git(['checkout', '-q', '-B', branch]);

  // Worker（真 agent，board-safe MCP）
  const scratch = mkdtempSync(join(tmpdir(), 'orch-full-'));
  const ledger = new Ledger(join(scratch, 'l.db'), log);
  ledger.init();
  ledger.upsertDiscoveredTask({
    id: detail.id, payloadHash: 'h', repo: detail.repo, category: detail.category,
    title: detail.title, description: detail.description, dependencies: detail.dependencies, docRefs: detail.docRefs,
  });

  const worker = new Worker({
    mcp: new BoardSafeMcp(client, detail),
    agent: new AgentRuntime(log),
    verifier: new Verifier(log),
    progress: new ProgressMonitor(ledger, 3),
    ledger,
    notifier: new ConsoleNotifier(log),
    diffHash: gitDiffHash,
    log,
  });

  log.info('▶ 開始：真 agent 依 spec 編程 + build 驗證…');
  const outcome = await worker.runTask({ task: detail, cwd: SANDBOX, verifierConfig: BUILD });
  log.info({ outcome }, 'Worker 完成');

  const pr = new PrManager(log);
  const guard = new MergeGuard(new Verifier(log), log);
  let mergeState = 'skipped';
  let prBody = '';

  if (outcome.status === 'done') {
    // 提交 agent 變更到分支
    await pr.commitAll(SANDBOX, `feat(${TASK_ID}): ${detail.title}`);

    // Merge Guard：rebase + 重測
    const verdict = await guard.attempt({ repoPath: SANDBOX, branch, base: 'main', verifierConfig: BUILD });
    if (verdict.ok) {
      // 本地合併到 main + 合併後 build
      await git(['checkout', '-q', 'main']);
      await git(['merge', '--ff-only', branch]);
      const post = await guard.postMergeCheck(SANDBOX, 'main', BUILD);
      mergeState = post.ok ? 'merged+post-build-green' : `post-merge-red: ${post.ok === false ? post.reason : ''}`;
    } else {
      mergeState = `guard-blocked: ${verdict.ok === false ? verdict.reason : ''}`;
    }

    // 產生 PR 內文（示範需求 5；本 demo 不實際 push/開 PR）
    const files = (await git(['diff', '--name-only', 'main~1', 'main'])).stdout.split('\n').filter(Boolean);
    prBody = generatePrBody({
      tasks: [detail],
      narrative: { what: outcome.status === 'done' ? detail.title : '', how: '（由 agent 總結填入）' },
      diff: { files, additions: 0, deletions: 0 },
      verification: [{ name: 'build', ok: true }],
      assumptions: [],
    });
  }

  await client.close();
  ledger.close();
  rmSync(scratch, { recursive: true, force: true });

  console.log('\n──────── 完整週期摘要 ────────');
  console.log(`任務        : ${detail.id} / ${detail.title}`);
  console.log(`Worker      : ${outcome.status}`);
  console.log(`合併        : ${mergeState}`);
  console.log(`sandbox main: ${(await git(['log', '--oneline', '-1'])).stdout}`);
  if (prBody) {
    console.log('\n───── PR 內文（節錄前 24 行）─────');
    console.log(prBody.split('\n').slice(0, 24).join('\n'));
  }
  const ok = outcome.status === 'done' && mergeState.startsWith('merged');
  console.log(`\n結論        : ${ok ? '✅ 完整週期（含合併）通過' : '⚠️ 未完整達成，見上'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  log.error({ err: e instanceof Error ? e.stack : String(e) }, 'e2e-full 失敗');
  process.exit(1);
});
