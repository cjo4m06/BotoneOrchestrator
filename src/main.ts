import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createCheckRecorder, type CheckContext } from './worker/check-recorder.js';
import type { DocsSource } from './worker/docs-server.js';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type AppConfig, type OrchestratorConfig, type ProjectConfig } from './config/index.js';
import { DEFAULT_DATA_ROOT, loadBootstrap } from './config/bootstrap.js';
import { ConfigStore } from './config/store.js';
import { migrateYamlIfPresent } from './config/migrate.js';
import { promoteSecrets } from './config/promote-secrets.js';
import { ConsoleServer } from './console/server.js';
import { loadEnv } from './config/env.js';
import { Ledger } from './store/ledger.js';
import { backupLedger } from './store/backup.js';
import { createLogger } from './observability/logger.js';
import { PmmMcpClient, mcpResilienceFromEnv, normalizeDocType, type McpResilienceOptions } from './mcp/mcp-client.js';
import { Poller, type PollSource } from './core/poller.js';
import { ProjectRegistry, type ProjectLookup, type RegisteredProject } from './core/project-registry.js';
import { DEFAULT_QUIET_MINUTES } from './core/quiet-period.js';
import { evaluateBudget, type BudgetVerdict } from './core/budget.js';
import { Planner } from './core/planner.js';
import { Dispatcher } from './core/dispatcher.js';
import { Orchestrator, type MergePipelineDeps, type MergeGuardLike, type MergeProject, type PrMergeLike, TICK_FAILED_EVENT } from './core/orchestrator.js';
import { GroupRunner, prepareLocalConfig, type GroupRunnerDeps, type ProjectRuntime } from './core/group-runner.js';
import { Reconciler, createFsProbe, createGitProbe, type ReconcilerDeps, type ReconcilerMcp } from './core/reconciler.js';
import { AgentRuntime, agentAuthEnv } from './worker/agent-runtime.js';
import { Verifier } from './worker/verifier.js';
import { Reviewer } from './worker/reviewer.js';
import { MergeGuard } from './pr/merge-guard.js';
import { PrManager, type CommandRunner } from './pr/pr-manager.js';
import { ReviewFeedbackStore, ReviewWatcher } from './pr/review-watcher.js';
import { syncTaskCard } from './core/card-status.js';
import { browserServerConfig } from './worker/agent-runtime.js';
import { PlanAgent, type InFlightGroup } from './core/plan-agent.js';
import { MergeRiskJudge } from './core/merge-risk-judge.js';
import { DriftJudge } from './pr/drift-judge.js';
import { hasClaudeAuth } from './worker/reviewer.js';
import { withFetchLock } from './git/fetch-lock.js';
import { InboundRouter, type CompleteTaskFn } from './notify/notifier.js';
import { createNotifier, slackHandlesOf, type HumanGateway } from './slack/gateway.js';
import { AppHome } from './slack/app-home.js';
import type { HomeInput } from './slack/home.js';
import { collectPending, costInput, formatPending, statusInput } from './cli/ask.js';
import { formatCost, formatStatus, quietWaits, startOfToday } from './cli/report.js';
import type { Logger } from './observability/logger.js';
import type { McpTaskClient, VerifierLike } from './contracts.js';
import type { TaskBrief } from './types.js';
import type { VerifierConfig, VerifierDeps } from './worker/verifier.js';
import { projectPurgerOf } from './core/project-purge.js';
import { STALE_AFTER_MS } from './observability/activity.js';
import type { UsageSink } from './core/agent-usage.js';

/**
 * 執行期產出的目錄，**全部掛在該 profile 的 dataRoot 底下**。
 *
 * 原本這些是寫死的 './data/...'，只有 ledger 與鎖檔分 profile——於是跑一次測試
 * 就把 worktree 建進正式那份目錄，截圖與備份也混進去。事後分不出哪些是真的，
 * 要清理也不敢下手。分 profile 的意義是「兩邊完全不相見」，不是只有資料庫。
 */
export const worktreeBaseOf = (dataRoot: string): string => join(dataRoot, 'worktrees');

/**
 * 合併路徑專用的 worktree 根目錄。**刻意不放在 worktreeBase 底下**：
 * Reconciler 會把 worktreeBase 第一層中「沒有對應群組」的目錄當孤兒刪除，
 * 合併工作區沒有群組，放進去就會在每次開機對帳時被清掉。
 */
export const mergeWorktreeBaseOf = (dataRoot: string): string => join(dataRoot, 'merge-worktrees');

/** 設定 → DoD 關卡指令。未設的關卡不會跑（不是綠燈，是整段跳過）。 */
export function verifierConfigOf(p: ProjectConfig): VerifierConfig {
  return {
    // typecheck 是最便宜也最早失敗的關卡（DESIGN §5 的第一關），一定要映射到，
    // 否則生產路徑永遠跑不到它，只有測試手寫的 VerifierConfig 看起來有
    typecheck: p.commands.typecheck,
    build: p.commands.build,
    test: p.commands.test,
    lint: p.commands.lint,
    // 每專案的指令逾時覆寫；未設 → 交給 VerifierDeps.commandTimeoutMs（全域）或內建預設
    ...(p.commandTimeoutSec !== undefined && p.commandTimeoutSec > 0
      ? { timeoutMs: p.commandTimeoutSec * 1000 }
      : {}),
  };
}

/**
 * 全域的 Verifier 相依（目前只有指令逾時）。
 *
 * 為什麼要接：verifier 內建 10 分鐘上限，但那是寫死的常數；沒有設定欄位的話，
 * build/test 比 10 分鐘久的專案會**每一輪都被判成逾時紅燈**，而回灌給 agent 的訊息是
 * 「指令逾時」——agent 只會不停改程式碼去追一個時間問題。非正數視為未設（不接受關閉逾時：
 * 沒有逾時的 hang 會把單執行緒的監督迴圈永久凍住）。
 */
/**
 * 瀏覽器工具暫存輸出的根目錄。**一定要在任何 worktree 之外**——
 * Playwright MCP 預設寫在當下工作目錄，落進 worktree 就會污染 PR 的 diff，
 * 也會讓「diff 非空」的 DoD 判定被垃圾檔滿足。
 */
export const browserOutputRootOf = (dataRoot: string): string => join(dataRoot, 'browser-tmp');

/** 關卡全文太長時的落地目錄。跟截圖一樣掛在 dataRoot 底下，絕不寫進 worktree。 */
export function checkOutputRootOf(dataRoot: string): string {
  return join(dataRoot, 'check-outputs');
}

export function verifierDepsOf(
  orch: Pick<OrchestratorConfig, 'commandTimeoutSec' | 'agent'>,
  log?: Logger,
  browserOutputRoot?: string,
  frictionSink?: { logEvent(scope: 'task', refId: string, kind: string, detail?: string): void },
  /** 記帳出口。介面判斷者會開瀏覽器跑很多輪，先前它的花費完全沒被記。 */
  usage?: UsageSink,
): VerifierDeps {
  // 介面判斷者（UiJudge）與整套截圖量測堆疊已於第 15 片退場——畫面由審查者
  // 自己開瀏覽器看，放行時必須填 uiChecked。驗證器現在只剩「跑指令、記帳」。
  const sec = orch.commandTimeoutSec;
  return {
    ...(sec > 0 ? { commandTimeoutMs: sec * 1000 } : {}),
  };
}


/**
 * 這個專案輪詢時要不要只看「指派給我」的任務。
 * 預設 true：撿到指派給別人的任務會 start_task 失敗（MCP 擋認領），
 * 該任務所在的群組就永遠推不動，等於一顆別人的任務癱瘓我們一整群。
 */
export function pollMineOf(orch: Pick<OrchestratorConfig, 'poll'>, p: Pick<ProjectConfig, 'pollMine'>): boolean {
  return p.pollMine ?? orch.poll.mine;
}

/** 一個專案的輪詢來源（含 mine 過濾）。 */
export function pollSourceOf(
  orch: Pick<OrchestratorConfig, 'poll'>,
  p: Pick<ProjectConfig, 'repo' | 'pollMine'>,
  client: PollSource['client'],
): PollSource {
  return { client, repo: p.repo, mine: pollMineOf(orch, p) };
}

/**
 * 設定 → 專案執行期資料。base 分支在這裡定案（不再硬寫 'main'），
 * DoD 指令與自動合併政策也一併帶上。
 */
export async function projectRuntimeOf(
  p: ProjectConfig,
  deps: { mcp: McpTaskClient; git?: GitRun; log?: Logger },
): Promise<ProjectRuntime> {
  return {
    repo: p.repo,
    repoPath: p.repoPath,
    baseBranch: await resolveBaseBranch(p, deps),
    verifierConfig: verifierConfigOf(p),
    mcp: deps.mcp,
  };
}

/**
 * 唯一會對真實 repo 產生不可逆副作用的開關：系統可不可以自己合併。
 * 設定檔是唯一真來源——過去只認環境變數，而出貨的 launchd plist 沒有它，
 * 照文件安裝的人永遠等不到動作。環境變數保留為臨時覆寫。
 *
 * 推分支與開 PR 不再有開關：那是流程的必經之路（沒有 PR 就沒有審查），
 * 要用複本測試就把專案的 repo 與 repoPath 都指向複本。
 */
export function externalActionFlags(
  orch: Pick<OrchestratorConfig, 'allowLocalMerge'>,
  env: NodeJS.ProcessEnv,
  log?: Logger,
): { allowLocalMerge: boolean } {
  return {
    allowLocalMerge: resolveFlag(env, 'ORCH_LOCAL_MERGE', orch.allowLocalMerge, log),
  };
}

/**
 * 布林開關：設定檔為準，環境變數可覆寫（除錯/一次性實驗用）。
 * 認得 1/0、true/false、yes/no、on/off；看不懂的值一律忽略並警告——
 * 這些開關控制的是「會不會對真實 repo 產生外部副作用」，猜錯方向的代價太高。
 */
export function resolveFlag(env: NodeJS.ProcessEnv, key: string, fromConfig: boolean, log?: Logger): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fromConfig;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  log?.warn({ key, value: raw, used: fromConfig }, '無法解析的布林環境變數，改用設定檔的值');
  return fromConfig;
}

/**
 * 把 orchestrator.github.token 灌給 gh 子行程（開 PR / 讀審查都靠 gh）。
 * 已有環境變數時不覆蓋：外部注入（launchd / shell）應優先於設定檔。
 * 回傳只描述動作，永遠不回傳 token 本身，避免被記進 log。
 */
/**
 * 檢查目前的 gh 認證能不能存取這些 repo；不能、而 gh 自己的認證可以的話，
 * **把設定裡的 token 收回去**。
 *
 * ── 為什麼要收回去，而不是只警告 ──
 *
 * `GH_TOKEN` 一旦被設定，gh 就**完全不看自己的認證**（keyring／`gh auth login`）。
 * 所以一顆權限不足的 token 不只是「沒幫上忙」——它會把原本可用的認證蓋掉，
 * 讓一個本來會動的系統壞掉。
 *
 * 實跑撞到（21:28）：控制台設了一顆 fine-grained PAT，resource owner 是個人帳號，
 * 而專案的 repo 屬於某個 organization——**resource owner 選個人帳號的 fine-grained
 * PAT 看不到任何 organization 的 repo**，那是 GitHub 的規則，不是設定漏了什麼。
 * 於是每一次 gh 呼叫都失敗，而 GitHub 對「有效 token 但無權限的私有 repo」
 * 回的是 `Not Found` 不是 403（避免洩漏私有 repo 是否存在），錯誤長這樣：
 *
 *   GraphQL: Could not resolve to a Repository with the name 'org/repo'
 *
 * 看起來像 repo 打錯或不存在，實際上是權限。而使用者的 keyring 裡本來就有一顆
 * 看得到那個 repo 的 token——只是被設定裡那顆蓋掉了。
 *
 * 這個檢查放在啟動時，問題就在啟動時講清楚，而不是等某一群跑了一小時、
 * 要開 PR 時才炸，還留下一句看不懂的錯誤訊息。
 */
export async function verifyGhAccess(
  repos: string[],
  log: Logger,
  deps: { run?: (args: string[]) => Promise<{ exitCode: number }>; env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: string[]; denied: string[]; revoked: boolean }> {
  const env = deps.env ?? process.env;
  // **env 一定要明確傳給子行程。** 不傳的話 execa 用 process.env，而我們動的是
  // deps.env——正式環境兩者剛好是同一個物件所以會動，但那是巧合，不是設計。
  // 而且「收回 token 之後再試一次」這件事若沒真的作用在子行程上，
  // 整個判斷就是假的（測試會綠、實際沒生效）。
  const run =
    deps.run ??
    (async (args: string[]) => ({
      exitCode: (await execa('gh', args, { reject: false, env, extendEnv: false })).exitCode ?? -1,
    }));
  const canSee = async (repo: string): Promise<boolean> =>
    (await run(['api', `repos/${repo}`, '--jq', '.full_name'])).exitCode === 0;

  const ok: string[] = [];
  const denied: string[] = [];
  for (const repo of [...new Set(repos)]) ((await canSee(repo)) ? ok : denied).push(repo);
  if (denied.length === 0) return { ok, denied, revoked: false };

  const settingsToken = (env.GH_TOKEN ?? '').trim();
  if (settingsToken === '') {
    log.error(
      { denied },
      'gh 存取不到這些 repo。私有 repo 沒權限時 GitHub 回的是 Not Found（不是 403），'
        + '所以錯誤訊息會長得像「repo 不存在」。請確認 gh 的認證涵蓋這些 repo。',
    );
    return { ok, denied, revoked: false };
  }

  // 把設定裡的 token 收掉，讓 gh 退回用自己的認證再試一次
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const rescued: string[] = [];
  for (const repo of denied) if (await canSee(repo)) rescued.push(repo);

  if (rescued.length > 0) {
    log.error(
      { 設定的token看不到: denied, 收回後可存取: rescued },
      '⚠️ 控制台設定的 GitHub token 看不到這些 repo，但 gh 自己的認證看得到 → '
        + '**已忽略設定裡的 token**，改用 gh 自己的（gh auth login／keyring）。'
        + '最常見原因：fine-grained PAT 的 resource owner 選了個人帳號，而 repo 屬於 organization——'
        + '那種 token 看不到任何 organization 的 repo。要用設定裡那顆的話，'
        + 'resource owner 必須選該 organization（可能還需要組織核准）。',
    );
    return { ok: [...ok, ...rescued], denied: denied.filter((d) => !rescued.includes(d)), revoked: true };
  }

  // 兩邊都不行：token 放回去（維持原本行為），但要吵得夠大聲
  env.GH_TOKEN = settingsToken;
  env.GITHUB_TOKEN = settingsToken;
  log.error(
    { denied },
    '⚠️ gh 存取不到這些 repo（設定裡的 token 與 gh 自己的認證都不行）。'
      + '開 PR、讀審查、合併全部會失敗。私有 repo 沒權限時 GitHub 回 Not Found 不是 403，'
      + '所以錯誤會長得像「repo 不存在」。',
  );
  return { ok, denied, revoked: false };
}

/**
 * 把 DB 裡的 Claude 認證套進**本行程的** process.env。
 *
 * ── 為什麼需要，以及少了它會發生什麼 ──
 *
 * 寫程式的 agent 走 AgentRuntime，認證是**注入子行程環境**的（envOverrides），
 * 所以它不看 process.env 也能跑。但 reviewer、分群 agent、介面判斷者、語意飄移判斷者、
 * 合併風險判斷者全都是**在 daemon 自己的行程裡**直接呼叫 query()——它們只看 process.env。
 *
 * launchd 的環境沒有 ANTHROPIC_*（那是刻意的：金鑰不該寫進 plist），於是實跑變成：
 *   · reviewer     → 「未設定 Claude 認證」直接略過（DoD 綠燈但沒人審過）
 *   · 分群 agent    → 沒接線 → 退回啟發式分群 → 足跡混進整個目錄
 *                    （實跑：一群 4 個任務、描述只指名 5 個檔案，足跡卻宣稱 131 個，
 *                      裡面有 apps/web/components、docs 這種目錄項——於是任何兩群
 *                      都重疊，併發調到 3 也永遠只跑得動一群）
 *   · 介面判斷者    → 略過（視覺關卡會因此判紅，那個至少會吵）
 *
 * 最糟的是**它們全部安靜地降級**：日誌只有一行 WARN，而 DoD 照樣綠燈。
 * 「Claude 認證已載入」那行也騙人——它只表示「讀得到設定」，不代表用得到。
 *
 * 回傳實際套用了哪些變數，讓呼叫端把它印出來（看得到才知道有沒有生效）。
 */
export function applyClaudeAuth(
  cfg: { authToken?: string; apiKey?: string; baseUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const applied: string[] = [];
  const set = (key: string, value: string | undefined): void => {
    const v = value?.trim();
    if (!v) return;
    // 環境變數優先：使用者用 .env 或 launchd 明確指定時，不該被 DB 蓋掉
    if (env[key]?.trim()) return;
    env[key] = v;
    applied.push(key);
  };
  set('ANTHROPIC_AUTH_TOKEN', cfg.authToken);
  set('ANTHROPIC_API_KEY', cfg.apiKey);
  set('ANTHROPIC_BASE_URL', cfg.baseUrl);
  return applied;
}

export function applyGithubToken(token: string | undefined, env: NodeJS.ProcessEnv, log?: Logger): 'set' | 'kept' | 'absent' {
  return createGithubTokenApplier(env, log)(token);
}

/**
 * GitHub token 的套用器（**有狀態**，讓控制台改完不必重啟）。
 *
 * `gh` 是子行程，token 靠 process.env 傳給它。只在啟動時套一次的話，
 * 控制台改了 token 要重啟才生效——而控制台的整個意義就是不必重啟。
 *
 * 「外部注入優先」的規則仍然成立，但要分得出誰是外部的：
 * 只有**我們自己上次寫進去的那個值**才可以被新設定覆蓋。launchd／export 設的
 * （我們沒寫過的值）一律沿用，否則部署時注入的憑證會被資料庫裡的舊值蓋掉。
 */
export function createGithubTokenApplier(
  env: NodeJS.ProcessEnv,
  log?: Logger,
): (token: string | undefined) => 'set' | 'kept' | 'absent' {
  let applied: string | undefined; // 我們上次寫進 env 的值

  return (token) => {
    const next = (token ?? '').trim();
    if (next === '') return 'absent';

    const current = (env.GH_TOKEN ?? '').trim() || (env.GITHUB_TOKEN ?? '').trim();
    const ours = applied !== undefined && current === applied;
    if (current !== '' && !ours) {
      log?.debug('環境已有外部注入的 GitHub token，沿用（不以設定覆蓋）');
      return 'kept';
    }
    if (current === next) return 'kept'; // 沒變就不寫，也不重複記 log

    env.GH_TOKEN = next;
    env.GITHUB_TOKEN = next;
    applied = next;
    log?.info(applied === undefined ? '已從設定載入 GitHub token' : '已套用新的 GitHub token（供 gh 子行程使用）');
    return 'set';
  };
}

// ── base 分支解析 ──

export interface GitOut {
  exitCode: number;
  stdout: string;
  /** 失敗訊息（可省略；只用於 log，判定一律看 exitCode）。 */
  stderr?: string;
}
export type GitRun = (repoPath: string, args: string[]) => Promise<GitOut>;

/**
 * 這個 repo 有沒有指定的 remote。
 *
 * 判斷刻意只看「remote 有沒有設定」，不去連線：離線、憑證過期、GitHub 掛掉
 * 都不該讓 daemon 拒絕登錄一個設定正確的專案。這裡要擋的是**結構上走不通**
 * 的專案（根本沒有 remote），不是暫時連不上的專案。
 *
 * git 查不到（指令失敗、目錄不存在）時回 true——放行後續流程去報真正的錯，
 * 比在這裡用一個模稜兩可的訊號把專案擋掉好。
 */
export async function hasRemote(repoPath: string, remote: string, git: GitRun = defaultGitRun): Promise<boolean> {
  const r = await git(repoPath, ['remote']);
  if (r.exitCode !== 0) return true;
  return r.stdout.split('\n').map((x) => x.trim()).includes(remote);
}

/** 「成果還沒進 base」的群組狀態——除了 merged 以外全部算。 */
const IN_FLIGHT_STATES = ['ready', 'forming', 'pr_open', 'in_review', 'changes_requested', 'merge_guard', 'failed'] as const;

/**
 * 該 repo 目前成果還沒進 base 的群組，給規劃 agent 判斷跨批次依賴用。
 *
 * 為什麼 failed 也列：那批東西確實存在（分支上有），只是卡住等人。
 * 讓 agent 知道它存在，才不會重做一次；至於要不要依賴它，由 agent 看狀態自己判斷。
 */
export function inFlightGroupsOf(
  ledger: Pick<Ledger, 'listGroupsByState' | 'getTask'>,
  repo: string,
): InFlightGroup[] {
  const out: InFlightGroup[] = [];
  for (const state of IN_FLIGHT_STATES) {
    for (const g of ledger.listGroupsByState(state)) {
      if (g.repo !== repo) continue;
      out.push({
        id: g.id,
        state,
        tasks: g.taskIds.map((id) => {
          const t = ledger.getTask(id);
          return { id, title: t?.title ?? '（讀不到標題）' };
        }),
        files: g.footprint,
        ...(g.prUrl ? { prUrl: g.prUrl } : {}),
      });
    }
  }
  return out;
}

const defaultGitRun: GitRun = async (repoPath, args) => {
  try {
    const r = await execa('git', ['-C', repoPath, ...args], { reject: false });
    return { exitCode: r.exitCode ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch {
    // git 不存在 / 目錄不存在都不該讓 daemon 起不來，交給後續的退回鏈
    return { exitCode: -1, stdout: '', stderr: '' };
  }
};

/**
 * 決定群組分支要從哪裡長出來、PR 要發往哪裡。
 *
 * 硬寫死 'main' 會讓預設分支叫 master/develop 的專案連 worktree 都建不起來
 * （群組永遠卡在 forming）。順序：
 *   1. projects.yaml 明寫的 baseBranch（最可信，永不猜）
 *   2. origin/HEAD（remote 的預設分支）
 *   3. 本地存在的 main / master
 *   4. 目前 checkout 的分支（本地 repo 沒有 remote 時的最後依據）
 *   5. 'main' + 警告（優雅降級：寧可保留舊行為並吵一聲，也不要讓啟動失敗）
 */
export async function resolveBaseBranch(
  p: { id?: string; baseBranch?: string; repoPath: string },
  deps: { git?: GitRun; log?: Logger } = {},
): Promise<string> {
  const explicit = p.baseBranch?.trim();
  if (explicit) return explicit;

  const git = deps.git ?? defaultGitRun;
  const log = deps.log;

  const head = await git(p.repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const remote = head.exitCode === 0 ? head.stdout.trim() : '';
  if (remote) {
    // "origin/main" → "main"；分支名本身可能含 '/'（feature/x），只切第一段
    const name = remote.startsWith('origin/') ? remote.slice('origin/'.length) : remote;
    if (name) {
      log?.info({ id: p.id, baseBranch: name }, '由 origin/HEAD 偵測 base 分支');
      return name;
    }
  }

  for (const candidate of ['main', 'master']) {
    const r = await git(p.repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (r.exitCode === 0) {
      log?.info({ id: p.id, baseBranch: candidate }, '由本地分支推定 base 分支');
      return candidate;
    }
  }

  const cur = await git(p.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const curName = cur.exitCode === 0 ? cur.stdout.trim() : '';
  if (curName && curName !== 'HEAD') {
    log?.warn({ id: p.id, baseBranch: curName }, '找不到 origin/HEAD 與 main/master，改用目前分支當 base');
    return curName;
  }

  log?.warn({ id: p.id, repoPath: p.repoPath }, '無法偵測 base 分支，退回 main（若不正確請在 projects.yaml 設 baseBranch）');
  return 'main';
}

// ── 合併閉環（需求 7：審查人員回覆 → 把關 → 合併 PR） ──────────────────────

/** 專案 id → 合併工作區目錄名（避免奇怪字元跑進路徑）。 */
function mergeWorkspaceSlug(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '-');
}

export interface EnsureMergeWorkspaceInput {
  /** 使用者的主 clone（worktree 由它長出來）。 */
  repoPath: string;
  /** 要建立/沿用的合併工作區路徑。 */
  path: string;
  /** 建立時的起始 ref（detached，不佔用任何分支名）。 */
  base: string;
  git?: GitRun;
  log?: Logger;
}

export type EnsureMergeWorkspace = (input: EnsureMergeWorkspaceInput) => Promise<string | undefined>;

/**
 * 準備「合併專用」的獨立 worktree，**絕不讓合併路徑碰使用者的主 clone**。
 *
 * 為什麼非做不可：Merge Guard 的第一步是 `git checkout <群組分支>`（見 merge-guard.ts §0），
 * repoPath 指向主 clone 的話，使用者正在編輯的工作區會被切走；後續 rebase 失敗還會
 * 留下 rebase 中斷狀態。DESIGN §9 的「動到真實 clone 的安全前提」講的就是這件事。
 *
 * `--detach`：不佔用分支名，之後 Merge Guard 才能自由 checkout 任何群組分支。
 * 任何一步失敗都回 undefined —— 呼叫端會**不接線該專案的合併路徑**（寧可不合併，
 * 也不要退而求其次去動主 clone）。
 */
export const ensureMergeWorkspace: EnsureMergeWorkspace = async (input) => {
  const git = input.git ?? defaultGitRun;
  const log = input.log;
  const path = resolve(input.path);

  // 已登記過就直接沿用（daemon 重啟不必重建）
  const listed = await git(input.repoPath, ['worktree', 'list', '--porcelain']);
  if (listed.exitCode === 0 && listedWorktrees(listed.stdout).some((p) => samePath(p, path))) {
    log?.info({ repoPath: input.repoPath, path }, '沿用既有的合併工作區');
    return path;
  }

  mkdirSync(dirname(path), { recursive: true });
  const add = await git(input.repoPath, ['worktree', 'add', '--detach', path, input.base]);
  if (add.exitCode === 0) {
    log?.info({ repoPath: input.repoPath, path, base: input.base }, '已建立合併專用 worktree（合併不會動到你的主 clone）');
    return path;
  }

  // 目錄被手動刪掉但 git 還留著登記時，add 會失敗；prune 後再試一次
  await git(input.repoPath, ['worktree', 'prune']);
  const retry = await git(input.repoPath, ['worktree', 'add', '--detach', path, input.base]);
  if (retry.exitCode === 0) {
    log?.info({ repoPath: input.repoPath, path }, 'prune 後已建立合併專用 worktree');
    return path;
  }
  log?.error(
    { repoPath: input.repoPath, path, detail: (retry.stderr || retry.stdout || add.stderr || '').split('\n').slice(-3).join('\n') },
    '無法建立合併專用 worktree → 本專案不接線合併路徑（已核准的 PR 需人工合併）',
  );
  return undefined;
};

/** 解析 `git worktree list --porcelain` 的 worktree 行。 */
function listedWorktrees(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim());
}

/** 路徑比較：macOS 的 /var 與 /private/var 是同一處，存在時以 realpath 為準。 */
function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** 一個要接進合併管線的專案（id 決定合併工作區的目錄名）。 */
export interface MergeProjectSpec {
  id: string;
  runtime: ProjectRuntime;
}

export interface CreateMergePipelineInput {
  projects: MergeProjectSpec[];
  /** 這個 profile 的資料根目錄；合併工作區建在它底下。 */
  dataRoot?: string;
  /** 已不再用於接線與否（保留給呼叫端記錄用途）。 */
  actions?: { allowLocalMerge: boolean };
  log: Logger;
  /** 合併工作區的根目錄（預設 MERGE_WORKTREE_BASE）。 */
  worktreeBase?: string;
  git?: GitRun;
  /** DoD 驗證器工廠（Merge Guard 在「合併後狀態」重跑用）。 */
  makeVerifier?: (ctx?: CheckContext) => VerifierLike;
  /** 測試注入：預設 ensureMergeWorkspace。 */
  ensureWorkspace?: EnsureMergeWorkspace;
  guard?: MergeGuardLike;
  pr?: PrMergeLike;
}

/**
 * 建立 Orchestrator 的合併管線（需求 7 的最後一哩：審查通過 → 系統合併）。
 *
 * **這條管線永遠接線。** 它原本被 allowLocalMerge 關掉，但那造成一個矛盾：
 * 開關關著時每個群組都會停在 in_review 等人核准，人按了核准卻沒有東西可以執行合併——
 * 群組直接走進死路。開關的意思是「**要不要等人**」，不是「要不要有合併能力」。
 *
 * 真正的把關在別處，而且更嚴格：
 *  1. **核准憑證**：沒有 approvedBy 就不合併。憑證只能來自人（Slack/CLI）或 GitHub 審查，
 *     本檔不會、也不能代為編造。這比一個全域開關精確——它是**逐次**的同意。
 *  2. **Merge Guard**：合併前一定在最新的 base 上 rebase 重測一次。
 *  3. **獨立工作區**：守衛會 checkout 群組分支，只在專用 worktree 內進行，
 *     拿不到工作區的專案不接線（見 ensureMergeWorkspace）。
 *
 * 回 undefined = 沒有任何專案拿得到合併工作區（環境問題），不是設定選擇。
 */
/**
 * 合併工作區用完之後放掉群組分支。
 *
 * **必須 detach，不能 checkout 分支。** git 不允許同一條分支同時被兩個 worktree 檢出，
 * 而 base 分支正被使用者的主 checkout 佔著：
 *
 *   fatal: 'main' is already used by worktree at '/Users/…/work/Dinosaur'
 *
 * 合併工作區建立時本來就是 `worktree add --detach`，釋放時卻去 checkout 一條分支，
 * 是當初寫得不一致。這個失敗被上層 catch 成 warn，看起來無害——但它代表群組分支
 * **從來沒被放掉**，那一群要重做時 `worktree add` 就會失敗，整組 failed。
 * 實跑每次合併完都噴一次。
 */
export async function releaseMergeWorktreeBranch(
  repoPath: string,
  baseBranch: string,
  git: GitRun = defaultGitRun,
): Promise<void> {
  // 優先 detach 到遠端的 base（合併後最新的位置）；沒有 remote 就用本地那條
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    if ((await git(repoPath, ['checkout', '--detach', ref])).exitCode === 0) return;
  }
  // 都不行就退回 HEAD——目的只是「不要再佔著群組分支」，停在哪個 commit 不重要
  const fallback = await git(repoPath, ['checkout', '--detach', 'HEAD']);
  if (fallback.exitCode !== 0) {
    throw new Error(`釋放合併工作區失敗：${(fallback.stderr || fallback.stdout).trim()}`);
  }
}

export async function createMergePipeline(input: CreateMergePipelineInput): Promise<MergePipelineDeps | undefined> {
  const { log } = input;

  const ensure = input.ensureWorkspace ?? ensureMergeWorkspace;
  const base = input.worktreeBase ?? mergeWorktreeBaseOf(input.dataRoot ?? DEFAULT_DATA_ROOT);
  const git = input.git ?? defaultGitRun;

  const byRepo = new Map<string, MergeProject>();
  /** 合併工作區路徑 → 專案 runtime（守衛的 prepareTree 要靠它拿 localFiles）。 */

  /** 重建某個 repo 的合併工作區（含 node_modules 與本機設定檔）。 */
  const rebuildMergeWorkspace = async (repo: string, proj: MergeProject): Promise<void> => {
    const entry = input.projects.find((p) => p.runtime.repo === repo);
    if (!entry) return;
    const path = await ensure({
      repoPath: entry.runtime.repoPath,
      path: proj.repoPath,
      base: entry.runtime.baseBranch,
      git,
      log,
    });
    if (!path) return;
    await prepareLocalConfig(entry.runtime.repoPath, path, log).catch(() => undefined);
    log.info({ repo, path }, '合併工作區已重建');
  };

  for (const { id, runtime } of input.projects) {
    const path = await ensure({
      repoPath: runtime.repoPath,
      path: join(resolve(base), mergeWorkspaceSlug(id)),
      base: runtime.baseBranch,
      git,
      log,
    });
    if (!path) continue;
    // 依賴由專案自己的驗收指令負責；本機設定檔沒有版控對照物，只能從主 clone 帶
    await prepareLocalConfig(runtime.repoPath, path, log).catch((e) =>
      log.warn({ path, err: e instanceof Error ? e.message : String(e) }, '合併工作區的本機設定檔準備失敗'),
    );

    byRepo.set(runtime.repo, {
      // 合併路徑的工作目錄＝專用 worktree，不是 runtime.repoPath（使用者的主 clone）
      repoPath: path,
      // 合併目標必須跟開 PR 的 repo 一致，否則會去合併正式專案上的同號 PR
      baseBranch: runtime.baseBranch,
      verifierConfig: runtime.verifierConfig,
    });
  }

  if (byRepo.size === 0) {
    log.error('沒有任何專案取得合併專用工作區 → 合併管線不接線（已核准的 PR 需人工合併）');
    return undefined;
  }

  log.info({ repos: [...byRepo.keys()] }, '✅ 合併閉環已接線：審查通過 → Merge Guard → 政策閘門 → 合併 PR');
  return {
    // **每次要用時都確認工作區還在。**
    //
    // 合併工作區先前只在啟動時建立一次。它一旦消失（被清理腳本掃掉、磁碟工具刪掉、
    // 人手動 rm），daemon 永遠不會重建，之後每一次合併都倒在
    // `fatal: cannot change to '.../merge-worktrees/live': No such file or directory`，
    // 判成 precondition_failed → 群組 failed。實跑撞到（我自己的清理刪掉了它）。
    //
    // ensureMergeWorkspace 本來就能處理「登記還在但目錄不見了」（prune 後重建），
    // 缺的只是「在用之前再問一次」。
    resolveProject: (repo) => {
      const proj = byRepo.get(repo);
      if (!proj) return undefined;
      if (!existsSync(proj.repoPath)) {
        // 同步路徑不能 await，所以這裡只標記；實際重建在下一輪由 rebuild 完成。
        // 立刻回 undefined 比讓它倒在 git 指令上好：後者的錯誤訊息完全看不出根因。
        log.error(
          { repo, path: proj.repoPath },
          '合併工作區不見了 → 本輪不合併（下一輪會重建）。已核准的憑證會保留，不必重新核准。',
        );
        void rebuildMergeWorkspace(repo, proj).catch((e) =>
          log.warn({ repo, err: e instanceof Error ? e.message : String(e) }, '重建合併工作區失敗'),
        );
        return undefined;
      }
      return proj;
    },
    // **第二個 Merge Guard 呼叫點（核准之後的那次）。**
    //
    // 這裡先前要塞 prepareTree 把 node_modules 帶進拋棄式驗收樹，因為第 10 片把守衛
    // 改成「在 /tmp 的樹上驗」之後樹不再自帶依賴——實跑（2026-08-05，g_da31b3e8c2ac）
    // 少了它就 `Cannot find package 'tsx'` → 判 semantic_drift → 憑證作廢、42 則
    // 「build 紅了」回灌給改不動它的 agent，**任何需要建置的專案都合併不了**。
    //
    // 複製依賴那條路現在整個拆了（見 group-runner 的說明：清單猜不對，而且就算猜對，
    // 複製來的版本也不對）。同一個坑改由**專案自己的驗收指令**負責——
    // 要安裝就寫成 `npm ci && npm run build`，那棵樹才會裝到它自己那顆 lockfile 的版本。
    guard: input.guard ?? new MergeGuard(input.makeVerifier?.() ?? new Verifier(log), log, {
      // 依賴不帶（複製來的版本對不上這棵樹），但本機設定檔要帶——它沒有版控對照物
      prepareTree: (treePath, repoPath) => prepareLocalConfig(repoPath, treePath, log).then(() => undefined),
    }),
    pr: input.pr ?? new PrManager(log),
    // 合併前確認 base 沒被外部動過（人在 GitHub 上自己按合併、或別的工具）
    currentBaseSha: async (repoPath, baseBranch, remote) => {
      const f = await withFetchLock(repoPath, () => git(repoPath, ['fetch', '--quiet', remote, baseBranch]));
      if (f.exitCode !== 0) return undefined; // 取不到最新狀態就不亂擋
      const r = await git(repoPath, ['rev-parse', `${remote}/${baseBranch}`]);
      const sha = r.stdout.trim();
      return r.exitCode === 0 && sha ? sha : undefined;
    },
    fetchBase: async (repoPath, baseBranch) => {
      // 沒有 remote 的本地 repo 不算錯誤（Merge Guard 會自己標「但書」）
      const remotes = await git(repoPath, ['remote']);
      if (remotes.exitCode !== 0 || !remotes.stdout.split('\n').map((s) => s.trim()).includes('origin')) return;
      const r = await withFetchLock(repoPath, () => git(repoPath, ['fetch', '--quiet', 'origin', baseBranch]));
      if (r.exitCode !== 0) throw new Error(`git fetch origin ${baseBranch} 失敗：${(r.stderr || r.stdout).trim()}`);
    },
    // 合併工作區用完要放掉群組分支（見 releaseMergeWorktreeBranch）
    releaseBranch: (repoPath, baseBranch) => releaseMergeWorktreeBranch(repoPath, baseBranch, git),
  };
}

// ── MCP client 建構（http 與 stdio 都要能用） ──

/**
 * stdio transport 的工廠；http 回 undefined（PmmMcpClient 內建 Streamable HTTP）。
 * 需求 2 要「多專案、不同 MCP」，而範例設定用的正是 stdio——不支援等於照範例設定的人拿到空轉的 daemon。
 */
export function mcpTransportFactory(p: Pick<ProjectConfig, 'mcp'>): (() => Transport) | undefined {
  if (p.mcp.transport !== 'stdio') return undefined;
  const command = p.mcp.command;
  if (!command) return undefined; // schema 已擋；這裡只是型別上的防禦
  const args = p.mcp.args ?? [];
  const extraEnv = p.mcp.env ?? {};
  return () =>
    new StdioClientTransport({
      command,
      args,
      // 只帶 SDK 的安全預設環境（PATH/HOME…）＋專案自己宣告的變數：
      // daemon 自己的 ANTHROPIC/SLACK/GITHUB 金鑰沒必要全數交給第三方 MCP 子行程
      env: { ...getDefaultEnvironment(), ...extraEnv },
    });
}

/** 依 transport 建 MCP client；不支援/設定不全時回 undefined（呼叫端略過該專案並記錯）。 */
export function createMcpClient(p: ProjectConfig, log: Logger, resilience: McpResilienceOptions = {}): PmmMcpClient | undefined {
  if (p.mcp.transport === 'http') {
    if (!p.mcp.url) {
      log.error({ id: p.id }, 'http transport 缺少 mcp.url，略過該專案');
      return undefined;
    }
    return new PmmMcpClient({ url: p.mcp.url, token: p.mcp.token ?? '' }, log, resilience);
  }

  const createTransport = mcpTransportFactory(p);
  if (!createTransport) {
    log.error({ id: p.id, transport: p.mcp.transport }, '不支援的 MCP transport（或 stdio 缺 command），略過該專案');
    return undefined;
  }
  // stdio 沒有 host 可當熔斷器名稱，用專案 id 讓 log 看得出是誰
  return new PmmMcpClient({ url: '', token: '', label: `mcp:${p.id}`, createTransport }, log, resilience);
}

// ── 單一實例鎖 ──

export class InstanceLockedError extends Error {
  constructor(message: string, public holderPid?: number) {
    super(message);
    this.name = 'InstanceLockedError';
  }
}

/**
 * 「上次沒收乾淨」標記（寫在鎖檔內）。
 *
 * 語意**不是**「有實例正在跑」，而是「上一個實例在還有進行中工作時就結束了，
 * 那些 worktree 可能還有人在動（被 orphan 的 agent 子行程）」。
 * 下一個實例**可以**啟動（不然 daemon 會從此起不來），但必須跳過破壞性對帳。
 */
export interface UncleanShutdownMark {
  /** 標記寫入時間（epoch ms）。 */
  at: number;
  /** 逾時當下仍在進行中的群組數。 */
  remaining: number;
  /** 人可讀的原因（會出現在下次啟動的 error log 裡）。 */
  detail?: string;
}

/** 鎖檔內容（JSON）。舊格式（純 pid 文字）仍讀得懂，只是沒有啟動時間可比對。 */
export interface LockFileContent {
  pid: number;
  /**
   * 持有者行程的**啟動時間**（epoch ms）。
   * 只有 pid 的話，pid 被作業系統回收給別的程序時會被誤判成「實例還活著」，
   * daemon 從此永遠起不來；有啟動時間才能分辨「同一個 pid 但不是同一個行程」。
   */
  startedAtMs?: number;
  acquiredAtMs?: number;
  unclean?: UncleanShutdownMark;
}

export interface InstanceLock {
  path: string;
  pid: number;
  /**
   * 接管殘留鎖時，前一位持有者留下的「沒收乾淨」標記。
   * 有值 ⇒ 本次啟動要保守（不做破壞性對帳）。
   */
  previousUnclean?: UncleanShutdownMark;
  /**
   * 標記「本次收尾沒收乾淨」，並**刻意保留鎖檔**（不釋放）。
   * 釋放了才是災難：下一個實例會把還在被寫入的 worktree `remove --force` 掉。
   */
  markUnclean(info: { remaining: number; detail?: string }): void;
  release(): void;
}

/** 預設存活判定：EPERM 代表行程存在但不屬於我們 → 保守視為活著。 */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 取得某個 pid 的行程啟動時間（epoch ms）；問不到回 undefined。
 * `ps -o lstart=` 在 macOS 與 Linux 都有，只是格式不同——一律交給 Date.parse，
 * 解析不了就當「問不到」（呼叫端必須保守處理，見 isHolderAlive）。
 */
export function defaultProcessStartMs(pid: number): number | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return undefined;
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

/** pid 回收判定的容忍值：紀錄來源（ps／process.uptime）之間本來就有秒級誤差。 */
const PID_REUSE_TOLERANCE_MS = 5000;

/**
 * 判斷「鎖檔記錄的持有者」是不是還活著。
 *
 * ★ 誤判方向決定寫法（D18）：
 *   - 誤判成「已死」→ 接管鎖 → 對還在跑的 worktree 做 `remove --force`／`branch -D`。災難。
 *   - 誤判成「活著」→ 本次拒絕啟動，人看 log 手動處理。可回復。
 * 所以只有在**握有正面證據**（雙方都拿得到啟動時間、且明顯不同）時才敢說「pid 被回收了」，
 * 其他情況（舊格式沒有啟動時間、ps 問不到）一律當成活著。
 */
export function isHolderAlive(
  holder: LockFileContent,
  deps: { isAlive: (pid: number) => boolean; processStartMs: (pid: number) => number | undefined; log?: Logger },
): boolean {
  if (!deps.isAlive(holder.pid)) return false;
  if (holder.startedAtMs === undefined) return true; // 舊格式鎖檔：沒有證據可比，保守視為活著

  const actual = deps.processStartMs(holder.pid);
  if (actual === undefined) return true; // 問不到啟動時間：保守視為活著

  // ps 的 lstart 只到「秒」，我方紀錄可能來自 uptime 推算，容忍幾秒的落差
  if (Math.abs(actual - holder.startedAtMs) <= PID_REUSE_TOLERANCE_MS) return true;
  deps.log?.warn(
    { pid: holder.pid, lockStartedAtMs: holder.startedAtMs, actualStartedAtMs: actual },
    '鎖檔的 pid 目前屬於另一個行程（啟動時間對不上）→ 視為殘留鎖',
  );
  return false;
}

/**
 * 取得單一實例鎖（檔案內容為 JSON：pid + 行程啟動時間 + 可選的 unclean 標記）。
 *
 * 為什麼一定要有：第二個 daemon 開機時會跑崩潰對帳，而對帳會 `worktree remove --force`
 * 與 `branch -D` 掉它認為是孤兒的東西——那些正是第一個實例正在用的 worktree 與分支。
 * 拿不到鎖就明確失敗，絕不硬跑。
 *
 * 殘留鎖（上次被 kill -9、或收尾逾時刻意保留）不該讓 daemon 從此起不來：
 * 持有者已死／內容損毀 → 接管，但**把上一位留下的 unclean 標記帶出來**（previousUnclean），
 * 讓呼叫端知道這次要保守。
 */
export function acquireInstanceLock(input: {
  path: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  /** 查某 pid 的行程啟動時間（測試注入用）。 */
  processStartMs?: (pid: number) => number | undefined;
  /** 本行程的啟動時間；未給時自動偵測（只在 pid 就是本行程時才推算）。 */
  startedAtMs?: number;
  now?: () => number;
  log?: Logger;
}): InstanceLock {
  const path = resolve(input.path);
  const pid = input.pid ?? process.pid;
  const isAlive = input.isAlive ?? defaultIsAlive;
  const processStartMs = input.processStartMs ?? defaultProcessStartMs;
  const now = input.now ?? Date.now;
  const log = input.log;
  const startedAtMs = input.startedAtMs ?? (pid === process.pid ? selfStartMs(processStartMs, now) : undefined);

  mkdirSync(dirname(path), { recursive: true });

  let previousUnclean: UncleanShutdownMark | undefined;

  // 最多兩輪：第一輪撞到殘留鎖 → 清掉 → 第二輪重取。再撞就是真的有人在搶，不再迴圈。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // 'wx' = 原子性「不存在才建立」，兩個實例同時啟動只會有一個成功
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, serializeLock({ pid, ...(startedAtMs !== undefined ? { startedAtMs } : {}), acquiredAtMs: now() }));
      } finally {
        closeSync(fd);
      }
      log?.info({ path, pid, startedAtMs }, '取得單一實例鎖');
      return {
        path,
        pid,
        ...(previousUnclean ? { previousUnclean } : {}),
        markUnclean: (info) => markLockUnclean(path, pid, startedAtMs, { ...info, at: now() }, log),
        release: () => releaseLock(path, pid, log),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;

      const holder = readLockFile(path);
      if (holder && holder.pid !== pid && isHolderAlive(holder, { isAlive, processStartMs, log })) {
        throw new InstanceLockedError(`另一個 orchestrator 實例（pid ${holder.pid}）正持有 ${path}`, holder.pid);
      }
      // 上一位留下的「沒收乾淨」標記要帶到新的鎖之外交給呼叫端（不寫進新鎖檔，
      // 否則標記會一路黏著永遠清不掉；它只影響「接管後的這一次啟動」）
      if (holder?.unclean) previousUnclean = holder.unclean;
      log?.warn({ path, holder: holder?.pid, unclean: holder?.unclean }, '偵測到殘留的實例鎖（持有者已不存在），接管');
      try {
        unlinkSync(path);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
      }
    }
  }
  throw new InstanceLockedError(`無法取得實例鎖 ${path}（重試後仍被占用）`);
}

/** 本行程的啟動時間：優先用 ps（與比對時同一個來源，誤差最小），問不到才用 uptime 推算。 */
function selfStartMs(processStartMs: (pid: number) => number | undefined, now: () => number): number {
  return processStartMs(process.pid) ?? Math.round(now() - process.uptime() * 1000);
}

function serializeLock(c: LockFileContent): string {
  return `${JSON.stringify(c)}\n`;
}

/** 讀鎖檔。相容舊的「純 pid」格式；讀不懂一律回 undefined（＝殘留鎖，可接管）。 */
export function readLockFile(path: string): LockFileContent | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
  if (raw === '') return undefined;

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Partial<LockFileContent>;
      if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
        return {
          pid: parsed.pid,
          ...(typeof parsed.startedAtMs === 'number' ? { startedAtMs: parsed.startedAtMs } : {}),
          ...(typeof parsed.acquiredAtMs === 'number' ? { acquiredAtMs: parsed.acquiredAtMs } : {}),
          ...(parsed.unclean && typeof parsed.unclean.at === 'number' ? { unclean: parsed.unclean } : {}),
        };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? { pid: n } : undefined;
}

/**
 * 寫入「沒收乾淨」標記且**保留鎖檔**。
 * 一樣只動自己的鎖：已被別人接管時不覆寫（那會把別人的 pid 蓋掉）。
 */
function markLockUnclean(
  path: string,
  pid: number,
  startedAtMs: number | undefined,
  unclean: UncleanShutdownMark,
  log?: Logger,
): void {
  const cur = readLockFile(path);
  if (cur?.pid !== pid) {
    log?.warn({ path }, '實例鎖已不屬於本行程，不寫入未收乾淨標記');
    return;
  }
  try {
    writeFileSync(path, serializeLock({ ...cur, pid, ...(startedAtMs !== undefined ? { startedAtMs } : {}), unclean }));
    log?.error(
      { path, remaining: unclean.remaining, detail: unclean.detail },
      '已在實例鎖寫入「上次沒收乾淨」標記並保留鎖檔：下次啟動會跳過破壞性對帳（不清 worktree／不刪分支）',
    );
  } catch (e) {
    log?.error({ path, err: String(e) }, '寫入未收乾淨標記失敗：下次啟動可能會對仍在使用中的 worktree 做清理，請人工確認');
  }
}

/** 只刪自己寫的鎖：接管者已改寫內容時不能把別人的鎖刪掉。 */
function releaseLock(path: string, pid: number, log?: Logger): void {
  if (readLockFile(path)?.pid !== pid) {
    log?.warn({ path }, '實例鎖已不屬於本行程，不刪除');
    return;
  }
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log?.warn({ path, err: String(e) }, '釋放實例鎖失敗（忽略）');
  }
}

// ── 優雅停止 ──

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 等待進行中的群組收尾（DESIGN §6 的狀態一致性）。
 * 沒等就關 ledger / MCP，正在寫入的 worker 會擲例外，任務狀態卡在半途、下次開機還得靠對帳猜。
 * 有上限：逾時只記警告然後照樣關閉——停不下來的 daemon 比狀態遺失更糟（launchd 會直接 SIGKILL）。
 */
export async function waitForInFlight(input: {
  activeCount: () => number;
  timeoutMs: number;
  log?: Logger;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<{ drained: boolean; remaining: number }> {
  const { activeCount, timeoutMs } = input;
  const log = input.log;
  const pollMs = input.pollMs ?? 250;
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? Date.now;

  if (activeCount() === 0) return { drained: true, remaining: 0 };
  log?.info({ active: activeCount(), timeoutMs }, '等待進行中群組收尾後再關閉');

  const deadline = now() + Math.max(0, timeoutMs);
  while (activeCount() > 0 && now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }

  const remaining = activeCount();
  if (remaining > 0) {
    log?.warn({ remaining }, '等待逾時，仍有群組進行中；將直接關閉（其狀態交由下次開機對帳恢復）');
    return { drained: false, remaining };
  }
  log?.info('進行中群組皆已收尾');
  return { drained: true, remaining: 0 };
}

/** 收尾結果。drained=false ⇒ 逾時仍有進行中工作，鎖已標記且**沒有釋放**。 */
export interface ShutdownResult {
  drained: boolean;
  remaining: number;
}

/**
 * 收尾程序。順序是重點：**先等進行中的群組收尾，才關資源**。
 * 反過來（舊行為）會讓 worker 對已關閉的 ledger 寫入而擲例外，任務狀態卡在半途。
 *
 * ★ 逾時（drained=false）時的行為是本檔最關鍵的安全決策：
 *   舊行為是「照樣 ledger.close() + lock.release()」，而 D10 明訂不設 turn／token 上限，
 *   一次 agent 執行超過 shutdownGraceSec 是**常態**，所以幾乎每次重啟都會走到這裡。後果：
 *     1. 進行中的 worker 之後寫 ledger → `The database connection is not open`；
 *     2. 鎖被釋放 → 新實例立刻接管 → 開機對帳把「還在被寫入」的 worktree
 *        `worktree remove --force`、分支 `branch -D` 掉（Reconciler 的前提是
 *        「拿到鎖 = 沒有別的實例在動這些 worktree」，而釋放鎖等於親手打破這個前提）。
 *   現在改成：**不關 ledger、不釋放鎖**，改在鎖檔寫入「上次沒收乾淨」標記。
 *   下一個實例仍然能啟動（接管殘留鎖），但會看到標記而跳過破壞性對帳。
 *
 *   為什麼 gateway/MCP 照樣關：它們持有 socket 與 stdio 子行程，不關行程根本退不出去
 *   （launchd 只會 SIGKILL 得更難看）；而它們是「對外連線」，斷掉頂多讓 in-flight 呼叫
 *   拿到錯誤。ledger 不同——它是本機狀態的事實源，且行程結束時 OS 會關檔，
 *   better-sqlite3 的 WAL 本來就耐得住行程被砍，留著開遠比提前關掉安全。
 */
export function createShutdown(deps: {
  dispatcher: { activeCount(): number };
  gateway: { stop(): Promise<void> };
  clients: { close(): Promise<void> }[];
  /** 其他要在收尾時關掉的東西（例如控制台的 HTTP server）。失敗只忽略，不擋收尾。 */
  extraClose?: (() => Promise<void>)[];
  /** logEvent 為可選：有的話會把未收乾淨留成稽核紀錄（ledger 此時仍開著）。 */
  ledger: { close(): void; logEvent?(scope: 'system', refId: null, kind: string, detail?: string): void };
  lock: { release(): void; markUnclean?(info: { remaining: number; detail?: string }): void };
  graceMs: number;
  log: Logger;
  /** 測試注入假時鐘用。 */
  wait?: typeof waitForInFlight;
}): () => Promise<ShutdownResult> {
  const wait = deps.wait ?? waitForInFlight;
  return async () => {
    const { drained, remaining } = await wait({
      activeCount: () => deps.dispatcher.activeCount(),
      timeoutMs: deps.graceMs,
      log: deps.log,
    });

    if (!drained) {
      // 先趁 ledger 還開著留下稽核紀錄，人才追得到「為什麼下次啟動變保守」
      const detail = `收尾逾時（grace ${Math.round(deps.graceMs / 1000)}s），仍有 ${remaining} 個群組進行中`;
      try {
        deps.ledger.logEvent?.('system', null, 'shutdown_unclean', detail);
      } catch (e) {
        deps.log.warn({ err: String(e) }, '未收乾淨事件寫入失敗（忽略）');
      }
      deps.log.error(
        { remaining, graceSec: Math.round(deps.graceMs / 1000) },
        '❌ 優雅停止逾時：仍有群組進行中。不關閉 ledger（避免進行中的寫入擲 "database connection is not open"）、' +
          '不釋放實例鎖（避免下一個實例把還在被寫入的 worktree force-remove 掉）。' +
          '下次啟動會看到鎖檔的 unclean 標記並跳過破壞性對帳。',
      );
      deps.lock.markUnclean?.({ remaining, detail });
    }

    await deps.gateway.stop();
    for (const c of deps.clients) {
      await c.close().catch((e) => deps.log.warn({ err: String(e) }, 'MCP 關閉失敗（忽略）'));
    }
    for (const close of deps.extraClose ?? []) {
      await close().catch((e) => deps.log.warn({ err: String(e) }, '附加資源關閉失敗（忽略）'));
    }

    if (drained) {
      deps.ledger.close();
      deps.lock.release();
    }
    return { drained, remaining };
  };
}

/**
 * 最後保險：行程若在 sec 秒後還沒自然結束（in-flight 的 agent 把事件迴圈撐著），強制退出。
 * `unref()` 讓這個計時器本身**不會**延長行程壽命——能自然結束時它不會有任何影響。
 * 這麼做是安全的，因為此時鎖已標記 unclean 且沒有釋放：被強制結束不會讓下一個實例做破壞性清理。
 * sec <= 0 = 不強制（願意讓行程掛著等 launchd 的 SIGKILL）。
 */
export function scheduleForceExit(
  sec: number,
  log: Logger,
  exit: (code: number) => void = (code) => process.exit(code),
): NodeJS.Timeout | undefined {
  if (!(sec > 0)) return undefined;
  const timer = setTimeout(() => {
    log.error({ sec }, '收尾逾時後行程仍未結束，強制退出（實例鎖已保留並標記 unclean）');
    exit(1);
  }, sec * 1000);
  timer.unref();
  return timer;
}

/** 聚合器的查詢型別（與 ReconcilerMcp 一致）。 */
export type ReconcileTaskQuery = Parameters<ReconcilerMcp['listTasks']>[0];

/** 聚合器只需要「能查任務」的來源（PmmMcpClient 結構上即滿足）。 */
export interface McpListSource {
  listTasks(q: ReconcileTaskQuery): Promise<TaskBrief[]>;
}

/**
 * 多專案的 MCP 讀取聚合器（Reconciler 用）。
 * Reconciler 只問一次「我的 done 任務有哪些」，但我們每個專案各有一個 client，所以在這裡扇出併合。
 *
 * **關鍵安全性**：單一來源查詢失敗時，把「查不到」和「確定沒有」混為一談是危險的——
 * Reconciler 會據此判定「這個任務不在 done 清單」而做出破壞性決策（清 worktree、標 failed），
 * 那會刪掉 agent 已寫好但尚未 commit 的成果（DESIGN §D15）。
 * 因此除了相容用的 `listTasks`（照舊吞下個別失敗）之外，一定要提供 `listTasksDetailed`
 * 回報「有幾個來源失敗」，讓對帳在證據不完整時自動轉保守。
 */
/**
 * 依任務所屬 repo 解析出正確的 MCP client 來標完成（多專案各有各的 MCP）。
 * 供 InboundRouter 的 confirm_no_change 與本機 CLI 共用——兩個入口必須走同一條路，
 * 否則會變成兩套語意不同的「確認」。
 */
export function completeTaskFor(
  ledger: Pick<Ledger, 'getTask'>,
  projects: { runtimeOf(repo: string): { mcp: McpTaskClient } | undefined },
  log: Logger,
): CompleteTaskFn {
  return async (taskId, opts) => {
    const task = ledger.getTask(taskId);
    if (!task) return { ok: false, kind: 'permanent', detail: `ledger 沒有任務 ${taskId}` };
    const rt = projects.runtimeOf(task.repo);
    if (!rt) {
      log.error({ taskId, repo: task.repo }, 'confirm 無法完成：找不到該 repo 的 MCP client');
      return { ok: false, kind: 'permanent', detail: `找不到 repo ${task.repo} 的 MCP 設定` };
    }
    return rt.mcp.completeTask(taskId, opts);
  };
}

export function aggregateMcp(clients: McpListSource[], log: Logger): ReconcilerMcp {
  const fanOut = async (q: ReconcileTaskQuery): Promise<{ tasks: TaskBrief[]; failedSources: number }> => {
    const tasks: TaskBrief[] = [];
    let failedSources = 0;
    for (const c of clients) {
      try {
        tasks.push(...(await c.listTasks(q)));
      } catch (e) {
        failedSources += 1;
        log.warn({ err: e instanceof Error ? e.message : String(e) }, '對帳時某個 MCP 查詢失敗（證據不完整，對帳將轉保守）');
      }
    }
    return { tasks, failedSources };
  };

  return {
    async listTasks(q) {
      return (await fanOut(q)).tasks;
    },
    listTasksDetailed: fanOut,
  };
}

// ── 主鏈路組裝（需求 7 的共用 feedback 實例在這裡定案） ──────────────────

/**
 * GroupRunner 的相依，且把 `feedback` 收斂成**具體的** ReviewFeedbackStore。
 *
 * GroupRunner 只要求結構介面（FeedbackStoreLike），但 main 的職責是保證
 * ReviewWatcher／Orchestrator／GroupRunner 拿到的是**同一個實例**；型別收斂讓這件事
 * 在測試裡可以直接比對（不同實例 = 審查意見誰都讀不到，changes_requested 永遠不動）。
 */
export type GroupRunnerDepsWithFeedback = GroupRunnerDeps & { feedback?: ReviewFeedbackStore };

export interface PipelineInput {
  config: AppConfig;
  ledger: Ledger;
  log: Logger;
  gateway: HumanGateway;
  /** repo → 專案執行期資料。 */
  /** 執行中的專案集合（可熱重載）。所有讀取都要走它，不要另外留快照。 */
  registry: ProjectRegistry;
  /** 傳函式 = 每輪現拿（控制台調整立即生效）；未給則用 config 的靜態值。 */
  pollIntervalSec?: number | (() => number);
  maxWorkers?: number | (() => number);
  /** 每輪 tick 前的設定同步（見 OrchestratorDeps.beforeTick）。 */
  beforeTick?: () => Promise<void>;
  /** agent 子行程的認證環境變數（現拿，見 AgentRuntimeDeps.envOverrides）。 */
  agentEnv?: () => Record<string, string | undefined>;
  /** 花費上限檢查（現算）。 */
  budget?: () => BudgetVerdict;
  /** 合併管線（createMergePipeline 的結果）。未給 ⇒ 不會有任何合併動作。 */
  merge?: MergePipelineDeps;
  /** 這個 profile 的資料根目錄；worktree 與瀏覽器暫存都建在它底下。 */
  dataRoot?: string;
  allowLocalMerge: boolean;
  /** 共用的審查意見暫存區；未給則自建（見 buildPipeline 內的說明）。 */
  feedback?: ReviewFeedbackStore;
  worktreeBase?: string;
  /** 測試注入假 gh（ReviewWatcher 讀 PR 審查用）。 */
  commandRunner?: CommandRunner;
}

export interface Pipeline {
  feedback: ReviewFeedbackStore;
  reviewWatcher: ReviewWatcher;
  /** 實際交給 GroupRunner 的相依（測試據此驗證共用實例真的送到位）。 */
  groupRunnerDeps: GroupRunnerDepsWithFeedback;
  groupRunner: GroupRunner;
  dispatcher: Dispatcher;
  orchestrator: Orchestrator;
}

/**
 * 組裝主鏈路：Poller/Planner/Dispatcher/GroupRunner/ReviewWatcher/Orchestrator。
 *
 * **需求 7 的閉環在這裡成立**（「審查人員在 GitHub 回覆 → 合併 PR」）：
 *   ReviewWatcher（產生審查意見／核准事件）
 *     → Orchestrator（決定重新派工或進合併佇列）
 *       → GroupRunner（把意見交給 agent 重做）
 * 三者必須共用**同一個** ReviewFeedbackStore：不同實例 = 誰都讀不到別人寫的意見，
 * changes_requested 的群組會永遠停在原地（Orchestrator 有安全互鎖，寧可不派也不讓 agent 盲改）。
 * gateway 同時提供合併核准閘門與人工裁決（onMergeDecision → 核准憑證）。
 */
export function buildPipeline(input: PipelineInput): Pipeline {
  const { config, ledger, log, gateway, registry } = input;

  // **認證必須在建判斷者之前套進本行程的 env。**
  //
  // 放在這裡而不是 main()：下面每一個 `hasClaudeAuth() ? ... : {}` 都是靠 process.env
  // 決定要不要接線。認證只在 DB 裡（正式資料夾是全新 clone，沒有 .env）的話，
  // 它們會全部安靜地不接——reviewer 略過、分群退回啟發式，而 DoD 照樣綠燈。
  //
  // main() 也呼叫一次是無害的（applyClaudeAuth 不覆寫既有環境變數）；
  // 但真正的保證在這裡：**要建 pipeline 就一定先套過認證**，不會有人忘了接。
  applyClaudeAuth(config.orchestrator.agent, process.env);
  // 各角色的模型（別名，不帶版本號 → 永遠是最新版）。未設就用 SDK 預設。
  // `?? {}`：schema 的 prefault 保證正式路徑一定有，但呼叫端手動組 config 時可能沒有
  const models = config.orchestrator.agent.models ?? {};
  if (!hasClaudeAuth()) {
    log.error(
      'Claude 認證不可用：reviewer 與分群／介面／飄移／風險判斷者**全部不會接線**，'
        + '而 DoD 仍會綠燈。請檢查「設定 → Claude 認證」或 .env 的 ANTHROPIC_AUTH_TOKEN／API_KEY。',
    );
  }

  // ★ 需求 7 的接線核心：整個 daemon 只有這一個實例。
  //   可由外部注入，因為 InboundRouter 比 buildPipeline 更早建立，而人在 Slack／CLI
  //   退回時附的意見要寫進**同一個** store 才有人讀得到。
  const feedback = input.feedback ?? new ReviewFeedbackStore(ledger);

  /**
   * 規格文件的來源——**每一個角色都用同一份**。
   *
   * 程式不預抓內容：docRef 字串對不上（實跑：issues/ vs issue）就整份讀不到，
   * 而預抓的那份是「開工那一刻的快照」，規格在任務進行中被更新時拿著它的人不會知道。
   *
   * 抽成具名函式而不是每個角色各寫一份：commit e2820a9 就是只接給寫程式的 agent，
   * 審查者的工作是「規格逐條 vs diff」卻不能搜規格。一份來源、所有角色一起接。
   */
  const docsSourceOf = (repo: string): DocsSource | undefined => {
    const mcp = registry.runtimeOf(repo)?.mcp;
    // 任務板沒有這些能力就不掛（角色只會拿到提示詞裡的那份，行為與先前一致）
    if (!mcp?.listDocs || !mcp.searchDocs || !mcp.readDoc) return undefined;
    const { listDocs, searchDocs, readDoc } = mcp;
    return {
      listDocs: () => listDocs.call(mcp),
      searchDocs: (q: string) => searchDocs.call(mcp, q),
      // agent 若照任務裡的 issues/ 寫成複數，這裡一併正規化（同 parseDocRef）
      readDoc: (t: string, f: string, sec?: string) => readDoc.call(mcp, normalizeDocType(t), f, sec),
    };
  };

  const reviewWatcher = new ReviewWatcher({
    ledger,
    log,
    feedback,
    ...(input.commandRunner ? { run: input.commandRunner } : {}),
  });

  const groupRunnerDeps: GroupRunnerDepsWithFeedback = {
    ledger,
    log,
    worktreeBase: input.worktreeBase ?? worktreeBaseOf(input.dataRoot ?? DEFAULT_DATA_ROOT),
    resolveProject: (repo) => registry.runtimeOf(repo),
    agent: new AgentRuntime(log, {
      ...(models.coder ? { model: models.coder } : {}),
      // 現拿：控制台換 Claude token／端點，下一輪 agent 執行就套用（不必重啟）
      ...(input.agentEnv ? { envOverrides: input.agentEnv } : {}),
      // 給 agent 一個瀏覽器：做 UI 卻看不到畫面，等於閉著眼睛做。
      // 輸出根目錄一定在 worktree 之外，否則截圖會被 git add -A 吃進 PR。
      browserOutputRoot: browserOutputRootOf(input.dataRoot ?? DEFAULT_DATA_ROOT),
      // 摩擦回報寫進 ledger events，之後才彙總得起來
      frictionSink: ledger,
      // 每一次工具呼叫的全文。次數答不了「它到底跑了什麼」——工作區被清空那次
      // 就是死在這上面（見 tool-audit.ts）。
      toolAudit: ledger,
      // 規格文件讓 agent 自己找：程式只能照 docRef 字串比對，檔案改名／章節改名／
      // docType 對不上就整份讀不到（實跑：issues/ vs issue，每個帶 issue 規格的任務
      // 都是沒看過規格就做的）。搜尋是語意的、會回不相干的東西，所以要它自己判斷。
      docs: docsSourceOf,
    }),
    // 規格文件讓 **每一個角色**自己去找。
    //
    // 程式只能照 docRef 字串比對，檔案改名／章節改名／docType 對不上就整份讀不到
    // （實跑：issues/ vs issue，每個帶 issue 規格的任務都是沒看過規格就做的）；
    // 而且預抓的那份是**開工那一刻的快照**——規格在任務進行中被更新時，
    // 拿著它的人不會知道自己看的是舊的。
    //
    // **抽成具名工廠而不是每個角色各寫一份**：commit e2820a9 就是只接給寫程式的 agent，
    // 審查者的工作是「規格逐條 vs diff」卻不能搜規格。一份來源、四個角色一起接，
    // 下次加角色時漏掉會很明顯。
    recordCheck: (i) => createCheckRecorder({ ledger, log }).record(i),
    // 指令逾時：全域預設在這裡注入，每專案覆寫走 verifierConfigOf 的 timeoutMs
    makeVerifier: (ctx?: CheckContext) => new Verifier(log, {
      ...verifierDepsOf(config.orchestrator, log, browserOutputRootOf(input.dataRoot ?? DEFAULT_DATA_ROOT), ledger, ledger),
      checkRecorder: createCheckRecorder({ ledger, log, outputRoot: checkOutputRootOf(input.dataRoot ?? DEFAULT_DATA_ROOT) }),
      ...(ctx ? { checkContext: ctx } : {}),
    }),
    progressRounds: config.orchestrator.noProgress.rounds,
    notifier: gateway,
    // 合併會動到 base 分支，安全優先：必須明確開啟
    allowLocalMerge: input.allowLocalMerge,
    // 只在自動合併開著時才會被呼叫：使用者說了「一般改動不必問我」，
    // 這一關只攔「做錯了救不回來」的那種。沒有認證時判斷者自己會回「要問人」。
    ...(hasClaudeAuth() ? { mergeRiskJudge: new MergeRiskJudge({ log, usage: ledger, toolAudit: ledger, docs: docsSourceOf, ...(models.riskJudge ? { model: models.riskJudge } : {}) }) } : {}),
    // 獨立 reviewer：無金鑰時自身降級為 skipped，不阻擋流程
    // **審查者要有自己的瀏覽器暫存區。** 先前它的工具清單一直列著唯讀瀏覽器，
    // 但 server 從來沒被掛上——「自己開瀏覽器看畫面」在清單上成立、實際叫不動，
    // 而放行書填「沒看」完全合法，閘門照樣綠燈。key 用 review-<taskId>，多群同審不互相覆蓋。
    reviewer: new Reviewer({
      log, usage: ledger, toolAudit: ledger, docs: docsSourceOf,
      browserOutputRoot: browserOutputRootOf(input.dataRoot ?? DEFAULT_DATA_ROOT),
      ...(models.reviewer ? { model: models.reviewer } : {}),
    }),
    // agent 宣告「無需改動」時的處置（預設全 ask：交人確認，不自動結案）
    noChangePolicy: config.orchestrator.noChange,
    // 審查意見回灌：與 Orchestrator／ReviewWatcher 共用同一個實例
    feedback,
    // 語意飄移的判斷層：事實層（衝突、rebase 後紅燈）之外，再問一次
    // 「兩邊的意圖有沒有打架」。無金鑰時自身降級為 skipped，不阻擋流程。
    driftJudge: new DriftJudge({ log, usage: ledger, toolAudit: ledger, docs: docsSourceOf, ...(models.driftJudge ? { model: models.driftJudge } : {}) }),
  };
  const groupRunner = new GroupRunner(groupRunnerDeps);

  // 傳函式：控制台調整併發數／輪詢週期後，下一輪就生效（不必重啟）
  const dispatcher = new Dispatcher(
    input.maxWorkers ?? config.orchestrator.maxConcurrentWorkers,
    groupRunner.run,
    log,
    // 「已結束」＝**成果真的進了 base**，也就是 merged。
    //
    // 這裡原本連 failed 也放行，理由是「否則前一階段一失敗，後面就永遠卡死」。
    // 那是錯的：afterGroups 只有在**確實有依賴**時才會有值——分群 agent 判定
    // 「B 必須等 A」是因為 B 的內容以 A 的成果為前提。A 失敗代表那個前提不存在，
    // 這時放行 B 只會產出建立在假設上的東西（實跑的例子：D2-2 要列出「目前所有
    // 匯出的函式」，而新增那些匯出的 D2-1 沒進 base——照做就是一份寫著不存在
    // 函式的 README，而且它自己的 DoD 還會全綠）。
    //
    // 「永遠卡死」的顧慮現在也不成立了：failed 群組會出現在待處理清單並帶 retry，
    // 等下去是**看得見的等**，不是靜默死鎖。把 A 修好，B 自然就動了。
    //
    // 群組記錄整個不見時仍視為結束——那是資料異常，不該讓後面的群陪葬。
    (groupId) => {
      const g = ledger.getGroup(groupId);
      return g === undefined || g.state === 'merged';
    },
  );
  const orchestrator = new Orchestrator(
    {
      // 傳函式而不是陣列：控制台新增／停用專案，下一輪輪詢就生效
      poller: new Poller(() => registry.sources(), ledger, log),
      // 有本地 checkout 才掃得到真實檔案足跡；掃不到會自動退回 docRef 代理
      planner: new Planner({
        resolveRepoPath: (repo) => registry.runtimeOf(repo)?.repoPath,
        // 分群與排序交給 agent：判準是「這幾個任務會不會動到同一批程式碼」，
        // 那要看懂任務在講什麼再對應到 repo。
        //
        // 沒有 Claude 認證時**不接**，而 Planner 沒有 planAgent 就會明確擲錯，
        // Orchestrator 據此開一張交接單。先前這裡會退回一套關鍵字相似度的啟發式——
        // 那是「換一塊任務板就安靜地分錯群，而症狀要到合併衝突才看得到」。
        ...(hasClaudeAuth() ? { planAgent: new PlanAgent({ log, usage: ledger, toolAudit: ledger, docs: docsSourceOf, frictionSink: ledger, ...(models.planner ? { model: models.planner } : {}) }) } : {}),
        // 規劃 agent 看得到「成果還沒進 base」的群組，才有辦法處理跨批次的依賴。
        // 任務是一批一批進來的：第二批規劃時，第一批可能已經做完開了 PR 但還沒合併——
        // 那些改動**不在 repo 裡**，agent 用 Read/Grep 是看不到的。
        inFlightGroups: (repo) => inFlightGroupsOf(ledger, repo),
        // 規劃一次要跑好幾分鐘，期間 ledger 完全靜止。沒有這個，控制台看起來就是停擺
        activity: ledger,
        log,
      }),
      dispatcher,
      ledger,
      log,
      // 專案被停用／正在編輯／MCP 連不上時就不派工（狀態不動，恢復後自動繼續）
      isProjectAvailable: (repo) => registry.runtimeOf(repo) !== undefined,
      reviewWatcher,
      feedback,
      // 合併核准閘門（政策要求人工時發問）＋ 人在 Slack 的裁決 → 核准憑證
      gateway,
      notifier: gateway,
      // 靜置期：每個專案（=一個 MCP 任務板）自己的分鐘數，未設用 15
      quietMinutesOf: (repo: string) => {
        const p = registry.configOf(repo); // 走 registry ⇒ 控制台改分鐘數立刻生效
        return typeof p?.quietPeriodMinutes === 'number' ? p.quietPeriodMinutes : DEFAULT_QUIET_MINUTES;
      },
      ...(input.beforeTick ? { beforeTick: input.beforeTick } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      pendingReminderMs: config.orchestrator.pendingReminderMinutes * 60_000,
      ...(input.merge ? { merge: input.merge } : {}),
    },
    input.pollIntervalSec ?? config.orchestrator.pollIntervalSec,
  );

  return { feedback, reviewWatcher, groupRunnerDeps, groupRunner, dispatcher, orchestrator };
}

/**
 * 接上 App Home 與 slash command。
 *
 * 快照每次都重新查 ledger（不快取）：面板存在的意義就是「現在」，
 * 顯示一份幾分鐘前的舊資料比不顯示更糟——人會照著它做決定。
 */
function attachAppHome(
  gateway: HumanGateway,
  ledger: Ledger,
  config: AppConfig,
  log: Logger,
  quick?: NonNullable<ConstructorParameters<typeof AppHome>[0]['actions']>,
): void {
  const { views, socket } = slackHandlesOf(gateway);
  if (!views || !socket) return; // console 降級或沒有 app token → 沒有 App Home 可言

  const snapshot = (): HomeInput => {
    const now = Date.now();
    const st = statusInput(ledger, config, now);
    return {
      pending: collectPending(ledger),
      tasksByState: st.tasksByState,
      groupsByState: st.groupsByState,
      cost: { today: ledger.costSummary(startOfToday(now)), total: ledger.costSummary() },
      costToday: ledger.costByRepo(startOfToday(now)),
      projects: config.projects.map((p) => ({ repo: p.repo, label: p.id, id: p.id, enabled: true })),
      quietWaits: quietWaits(st),
      // 「現在在做什麼」與「上一輪失敗了嗎」——控制台上有的，Slack 也要有。
      // 兩邊給不一樣的東西，人就得兩邊都開才敢下判斷
      activities: ledger.listActivities().map((a) => ({
        kind: a.kind, title: a.title, startedAt: a.startedAt,
        stale: now - a.heartbeatAt > STALE_AFTER_MS,
        ...(a.repo ? { repo: a.repo } : {}),
        ...(a.detail ? { detail: a.detail } : {}),
      })),
      ...(tickFailure(ledger, now) ? { lastFailure: tickFailure(ledger, now)! } : {}),
      now,
    };
  };

  new AppHome({
    views,
    socket,
    log,
    snapshot,
    render: {
      status: () => { const n = Date.now(); return formatStatus(statusInput(ledger, config, n, ledger.costByRepo(startOfToday(n)))); },
      cost: () => formatCost(costInput(ledger, Date.now())),
      pending: () => formatPending(collectPending(ledger)),
    },
    ...(quick ? { actions: quick } : {}),
  }).attach();
}

/** 最近一小時內的整輪失敗（超過就不再顯示——舊的紅字只會讓人麻痺）。 */
function tickFailure(ledger: Ledger, now: number): { at: number; detail: string } | undefined {
  const e = ledger.latestEvent('system', null, TICK_FAILED_EVENT);
  if (!e || now - e.createdAt > 60 * 60_000) return undefined;
  return { at: e.createdAt, detail: e.detail ?? '（沒有細節）' };
}

/**
 * daemon 進入點（launchd 啟這個）。config 驅動：
 * 單一實例鎖 → 連 MCP → 人機介面(Slack/console) → 崩潰對帳 → Poller/Planner/Dispatcher/GroupRunner → 主控迴圈。
 *
 * `--once` 只跑一輪即結束（除錯/驗證用）。
 * 推分支與開 PR 是流程的必經之路（沒有 PR 就沒有審查），「別動到正式 repo」由專案的
 * 開關只有 allowLocalMerge（系統可不可以自己合併），預設關閉；
 * 環境變數 ORCH_LOCAL_MERGE（1/0）可臨時覆寫。
 * 需求 7 的合併閉環（審查通過 → Merge Guard → 政策閘門 → 合併 PR）需要兩個開關都打開，
 * 且合併只在 MERGE_WORKTREE_BASE 下的專用 worktree 內進行（不會動使用者主 clone 的分支）。
 * 其他環境變數：ORCH_SKIP_RECONCILE=1 跳過崩潰對帳、ORCH_RECONCILE_DRY_RUN=1 只看決策不動手、
 * ORCH_FORCE_RECONCILE=1 即使上次沒收乾淨也照做完整（含破壞性）對帳。
 */
export async function main(): Promise<void> {
  const log = createLogger();
  log.info('orchestrator 啟動中…');

  // 最後一道保險：任何沒被接住的 rejection／例外都不該殺掉常駐行程。
  // 實跑撞過——一個「提醒訊息沒送出去」等級的錯誤，因為是 async rejection 而不是
  // 同步擲錯，繞過了 tick 的 try/catch，直接讓整個 daemon 掛掉，任務停在半路。
  // 這裡只記錄不退出：真正該停的情況（拿不到鎖、設定壞掉）都在啟動時就擋掉了。
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason instanceof Error ? reason.stack : String(reason) }, '未處理的 rejection（daemon 續跑）');
  });
  process.on('uncaughtException', (err) => {
    log.error({ err: err.stack ?? String(err) }, '未捕捉的例外（daemon 續跑）');
  });

  const auth = loadEnv(); // 只載 .env 進 process.env；認證是否齊備要等讀完設定才知道

  // 設定的事實源是 SQLite（見 config/store.ts）。只有「DB 在哪、鎖在哪」來自環境變數——
  // 那兩個值必須在開 DB 之前就知道，而設定本身就住在那個 DB 裡。
  const boot = loadBootstrap();
  const store = new ConfigStore(boot.ledgerPath);
  migrateYamlIfPresent(store, log); // 舊安裝的 yaml 一次性匯入，之後改名不再讀
  // 殘留的 ${VAR} 參照寫死進 DB：否則值其實還在 .env，而 .env 改了要重啟才生效
  promoteSecrets(store, log);
  const config = store.appConfig();
  const applyGh = createGithubTokenApplier(process.env, log);
  applyGh(config.orchestrator.github.token);
  // 在這裡驗，不要等某一群跑了一小時、要開 PR 時才炸。
  // 設定裡的 token 若看不到專案的 repo，會把 gh 自己的認證蓋掉（見 verifyGhAccess）。
  await verifyGhAccess(config.projects.map((p) => p.repo), log);
  log.info(
    { profile: boot.profile, ledger: boot.ledgerPath, projects: config.projects.length },
    boot.profile === 'test'
      ? '設定已載入（**測試 profile**，用的是測試資料庫，不會動到正式資料）'
      : '設定已載入（來源：資料庫；用控制台修改）',
  );

  // 認證可能來自資料庫（控制台設的）或行程環境（.env / launchd）。
  // 只看環境變數的話，把 token 搬進 DB 之後每次啟動都會噴一個假警告——
  // 假警告比沒有警告更糟，因為它會讓人學會忽略這一行。
  const agentCfg = config.orchestrator.agent;
  // **一定要套進本行程的 env**：reviewer 與所有判斷者（分群／介面／飄移／風險）
  // 都是 in-process 呼叫 query()，只看 process.env。少了這一步它們會全部安靜地略過。
  const appliedAuth = applyClaudeAuth(agentCfg, process.env);
  const authed = Boolean(agentCfg.authToken || agentCfg.apiKey) || auth.method !== 'none';
  if (!authed) log.warn('未設定 Claude 認證（控制台「設定 → Claude 認證」或環境變數）；agent 實跑會失敗');
  else {
    log.info(
      {
        source: agentCfg.authToken || agentCfg.apiKey ? '資料庫' : '環境變數',
        baseUrl: agentCfg.baseUrl || auth.baseUrl || '(預設)',
          // 印出來才看得到「有沒有真的生效」——先前只印「已載入」，而那只表示讀得到設定
          套進本行程: appliedAuth.length ? appliedAuth.join(', ') : '（沿用既有環境變數）',
          審查者與判斷者可用: hasClaudeAuth(process.env),
      },
      'Claude 認證已載入',
    );
  }

  // 鎖必須在碰 ledger / worktree / 對帳之前拿到：對帳會 force-remove 別人的工作區
  let lock: InstanceLock;
  try {
    lock = acquireInstanceLock({ path: boot.lockPath, log });
  } catch (e) {
    if (e instanceof InstanceLockedError) {
      log.error({ detail: e.message }, '已有另一個 orchestrator 實例在執行，拒絕啟動（避免互相刪除 worktree/分支）');
      process.exitCode = 1;
      return;
    }

  // 認證讀得到卻套不進本行程 = reviewer 與所有判斷者全部略過，而 DoD 照樣綠燈。
  // 這是「靜默地少做事」，必須吵出來。
  if (authed && !hasClaudeAuth(process.env)) {
    log.error(
      '⚠️ Claude 認證讀得到但套不進本行程環境：reviewer 與分群／介面／飄移／風險判斷者'
        + '**全部會被略過**，而 DoD 仍會綠燈。請檢查「設定 → Claude 認證」的 Auth Token / API Key。',
    );
  }
    throw e;
  }

  // 備份在開 ledger 之前：DB 是唯一事實源（含所有密鑰），誤刪等於全部重來。
  // 失敗只記 log——沒備份成功不該讓 daemon 起不來。
  backupLedger(boot.ledgerPath, log);

  const ledger = new Ledger(boot.ledgerPath, log);
  ledger.init();
  // 上一次是被 kill 掉還是當掉的話，activity 表裡會留著幾件永遠做不完的假工作。
  // 開機時無條件清掉——這一刻確定沒有任何事情在進行。
  const ghosts = ledger.clearStaleActivities(0);
  if (ghosts > 0) log.info({ count: ghosts }, '清掉上次沒收乾淨的進行中項目');
  ledger.logEvent('system', null, 'boot', 'daemon 啟動');

  // 人機介面：未啟用/缺 token → createNotifier 自動降級 ConsoleGateway（永不 throw）。
  // 註：resolveTaskByThread（thread_ts → taskId 的跨重啟反查）需要 ledger 提供依 slack_thread_ts
  //     查任務的方法，Ledger 目前尚未開放，因此重啟後只認得本次程序貼過的 thread。
  const gateway: HumanGateway = createNotifier(config.orchestrator, log, {
    // 跨重啟重建任務卡：卡片狀態只在記憶體的話，daemon 一重啟（改設定、修 bug 都會）
    // 之前貼出去的卡就再也更新不到，永遠停在重啟前的樣子。
    resolveCard: (taskId) => {
      const t = ledger.getTask(taskId);
      if (!t?.slackThreadTs) return undefined;
      return {
        ts: t.slackThreadTs,
        card: {
          id: t.id, title: t.title, repo: t.repo, category: t.category,
          description: t.description, docRefs: t.docRefs, dependencies: t.dependencies,
        },
      };
    },
    // 裁決後要更新整群的卡片；跨重啟時記憶體沒有對應關係，改問 ledger
    resolveGroupTasks: (groupId) => ledger.getGroup(groupId)?.taskIds ?? [],
  });
  await gateway.start();

  // 每個專案：連 MCP，建 PollSource 與 ProjectRuntime
  const resilience = mcpResilienceFromEnv();

  // 專案的建立流程收斂成一個工廠，registry 才能在執行期反覆呼叫它（新增／改設定／重連）
  const buildProject = async (p: ProjectConfig): Promise<Omit<RegisteredProject, 'fingerprint'> | undefined> => {
    const client = createMcpClient(p, log, resilience);
    if (!client) return undefined;
    try {
      // 連線已內建退避重試；重試完仍連不上就略過該專案，其他專案照常運作
      await client.connect();
    } catch (e) {
      log.error({ id: p.id, err: e instanceof Error ? e.message : String(e) }, 'MCP 連線失敗，略過該專案');
      return undefined;
    }
    // ── 這個專案有沒有辦法走完整條路？ ──
    //
    // 一群做完之後只有一個出口：推分支 → 開 PR → 審查 → 合併。沒有 remote 的 repo
    // 一步都走不了，它產出的每一群最後都會停在「做完了但無處可去」。
    //
    // 這條檢查是實跑撞出來的：我把一個純本地的測試專案（沒有 remote）接進來，
    // 它一路跑到「政策判定需人工核准 → 人按了核准」，然後**沒有任何程式路徑可以合併**——
    // 群組永遠停在那裡，還把依賴它的下一群一起卡住。錯不在最後那一步沒寫，
    // 錯在這種專案根本不該被登錄起來跑。前面全綠、最後才發現走不通，是最浪費的失敗。
    const remote = 'origin';
    const remoteOk = await hasRemote(p.repoPath, remote);
    if (!remoteOk) {
      log.error(
        { id: p.id, repoPath: p.repoPath, remote },
        '專案的 repo 沒有 remote，走不了「開 PR → 審查 → 合併」這條唯一的出口，不予登錄'
          + '（要嘛替它設好 remote，要嘛把這個專案停用）',
      );
      await client.close?.();
      return undefined;
    }

    const runtime = await projectRuntimeOf(p, { mcp: client, log });
    log.info({ id: p.id, repo: p.repo, repoPath: p.repoPath, baseBranch: runtime.baseBranch }, '登錄專案');
    return { config: p, client, source: pollSourceOf(store.settings(), p, client), runtime };
  };

  const registry = new ProjectRegistry(buildProject, log);
  await registry.sync(config.projects);

  if (registry.size() === 0) {
    log.warn('無可用專案（用控制台新增）。daemon 仍會啟動但無事可做。');
  }

  // 入站互動要在 runtimes 填好之後才接：confirm_no_change（人工確認「這張卡不用做」）
  // 得呼叫該任務所屬專案的 MCP completeTask。沒有這個注入，出口只會清掉本機 block，
  // 任務板上的卡永遠關不掉——人就只能一直 retry，agent 一直重跑（實測會這樣繞死）。
  // 審查意見暫存區：ReviewWatcher（GitHub 意見）、InboundRouter（Slack／CLI 退回的意見）、
  // GroupRunner（把意見交給 agent）三者必須共用同一個實例，否則誰都讀不到別人寫的意見。
  const feedback = new ReviewFeedbackStore(ledger);
  const router = new InboundRouter({
    ledger, log,
    completeTask: completeTaskFor(ledger, registry, log),
    feedback,
  });
  router.attach(gateway);

  // 卡片跟著 **ledger 的狀態**走，而不是跟著「有沒有發通知事件」走。
  // 差別在實跑時看得出來：`verifying` 改完狀態就直接去跑幾分鐘的測試指令，中間不發任何事件，
  // 掛在事件上的話這個狀態一次都不會出現在卡片上（實測確實從未顯示過）。
  ledger.onTaskChanged((taskId) =>
    syncTaskCard(ledger, gateway, taskId, (e) =>
      log.warn({ taskId, err: e instanceof Error ? e.message : String(e) }, '任務卡同步失敗（忽略）'),
    ),
  );

  // 本機控制台。只綁 loopback；帶上 router ⇒ 網頁上的裁決走與 Slack／CLI 相同的那一條路。
  const consoleServer = new ConsoleServer({
    store, ledger, log, router, inProcess: true,
    port: boot.consolePort,
    // 讓按鈕講得出「最多等多久才會真的動」（設定改了也會跟著變，不必重啟）
    pollIntervalSec: () => store.settings().pollIntervalSec ?? 0,
    // 停用專案＝清乾淨。留著的話下次啟用是拿舊快照在跑，而且停用期間每一輪 tick
    // 都會在規劃那一步擲錯，連帶讓整個 tick 的後半段全部跳過。
    purgeProject: projectPurgerOf({ store, ledger, worktreeBase: worktreeBaseOf(boot.dataRoot), log }),
  });
  try {
    await consoleServer.start();
  } catch (e) {
    // 埠被佔用不該讓 daemon 起不來——它的本業是跑任務，控制台只是介面
    log.warn({ err: e instanceof Error ? e.message : String(e) }, '控制台啟動失敗（daemon 照常運作）');
  }

  // App Home（常駐面板）與 /orch slash command：純唯讀，與 CLI 共用同一批 formatter。
  // Slack 未啟用、沒有 app token、或 Slack app 沒開 Home Tab，都只是不生效，不影響任何任務。
  // App Home 的快捷操作。**與控制台走同一條路**：停用一樣會清乾淨、
  // 重新派工一樣走 reviveGroup——兩個介面給不一樣的行為是最難查的那種問題。
  attachAppHome(gateway, ledger, config, log, {
    async setProjectEnabled(projectId, enabled) {
      const proj = store.allProjects().find((p) => p.config.id === projectId);
      if (!proj) return `找不到專案 ${projectId}`;
      if (!store.setProjectEnabled(projectId, enabled)) return `專案 ${projectId} 狀態沒改到`;
      if (enabled) return `已啟用 ${projectId}（下一輪起開始輪詢）`;

      const purge = projectPurgerOf({ store, ledger, worktreeBase: worktreeBaseOf(boot.dataRoot), log });
      const r = await purge(proj.config.repo);
      const claimed = r.claimed.length
        // 任務板那一側清不掉（MCP 沒有取消認領的工具），不講的話那幾張卡永遠沒人碰
        ? `　注意：${r.claimed.map((c) => c.id).join('、')} 已在任務板上認領過，請去改回 todo`
        : '';
      return `已停用 ${projectId}，清除 ${r.tasks} 個任務、${r.groups} 個群組${claimed}`;
    },
    async retryGroup(groupId) {
      const ok = await router.reviveGroup({ groupId });
      return ok ? `已把 ${groupId} 送回待派工` : `${groupId} 現在的狀態不能重新派工`;
    },
  });

  // 崩潰對帳：必須在主控迴圈開始前跑完，否則上次殘留的 in_progress 任務永遠沒人撿。
  // 上次沒收乾淨（鎖檔帶 unclean 標記）時自動轉保守：那些 worktree 可能還有被 orphan 的
  // agent 子行程在寫，此時做破壞性清理正是「把正在跑的東西清掉」。
  const mode = bootReconcileMode({
    ...(lock.previousUnclean ? { unclean: lock.previousUnclean } : {}),
    setting: config.orchestrator.reconcileAfterUncleanShutdown,
    env: process.env,
    log,
  });
  await reconcileOnBoot({
    ledger, log, registry,
    clients: registry.clients() as PmmMcpClient[],
    // agent 的暫存／截圖目錄（＝ browserOutputRoot）。先前指的是 visual.screenshotRoot——
    // 那個目錄根本沒有東西寫進去，於是 browser-tmp 從來沒被清過（正式機躺著 114 個任務目錄）。
    screenshotRoot: browserOutputRootOf(boot.dataRoot),
    dataRoot: boot.dataRoot,
    mode,
  });

  // 需求 4「完成一群就發 PR」：設定驅動（預設關），環境變數僅供臨時覆寫
  const actions = externalActionFlags(config.orchestrator, process.env, log);
  log.info(actions, '外部動作開關');

  // 需求 7「審查通過後合併 PR」：合併只在專用 worktree 內進行（不會動使用者主 clone 的分支）
  const merge = await createMergePipeline({
    projects: registry.list().map((x) => ({ id: x.config.id, runtime: x.runtime })),
    actions,
    log,
    dataRoot: boot.dataRoot,
    makeVerifier: (ctx?: CheckContext) => new Verifier(log, {
      ...verifierDepsOf(config.orchestrator, log, browserOutputRootOf(boot.dataRoot), ledger, ledger),
      checkRecorder: createCheckRecorder({ ledger, log, outputRoot: checkOutputRootOf(boot.dataRoot) }),
      ...(ctx ? { checkContext: ctx } : {}),
    }),
  });

  const { dispatcher, orchestrator } = buildPipeline({
    config,
    feedback,
    ledger,
    log,
    gateway,
    registry,
    // 這個 profile 的資料根目錄：worktree、合併工作區、瀏覽器暫存全掛在它底下，
    // 測試與正式因此完全不相見（見 bootstrap.ts 的 dataRoot）
    dataRoot: boot.dataRoot,
    // 現拿：控制台改了輪詢週期／併發數，下一輪生效
    pollIntervalSec: () => store.settings().pollIntervalSec,
    maxWorkers: () => store.settings().maxConcurrentWorkers,
    // 每輪把 DB 的專案清單與 GitHub token 套用一次：控制台（含獨立行程）改完，下一輪就生效
    beforeTick: async () => {
      applyGh(store.settings().github.token);
      await registry.sync(store.projects());
    },
    // Claude 認證同樣現拿（設定留空時沿用行程環境，既有安裝不受影響）
    agentEnv: () => agentAuthEnv(store.settings().agent),
    // 花費上限：每輪現算（控制台調整立刻生效）
    budget: () => evaluateBudget({
      limits: store.settings().budget,
      spentSince: (since) => ledger.costSummary(since),
      now: Date.now(),
    }),
    allowLocalMerge: actions.allowLocalMerge,
    ...(merge ? { merge } : {}),
  });

  // 收尾：等進行中群組 → Slack socket → MCP 連線 → ledger → 實例鎖
  const shutdown = createShutdown({
    dispatcher,
    gateway,
    // 控制台的 HTTP server 會讓事件迴圈一直活著：不關的話 --once 跑完一輪也退不出去
    // （實測：整整卡到逾時才被殺，看起來像 daemon 當掉，其實只是沒人關 socket）
    extraClose: [async () => consoleServer.stop().catch(() => {})],
    // 收尾時現拿：熱重載期間清單會變，開機時的快照可能已經對不上了
    clients: [{ close: () => registry.closeAll() }],
    ledger,
    lock,
    graceMs: config.orchestrator.shutdownGraceSec * 1000,
    log,
  });

  /** 收尾＋逾時後的處置（非零退出碼 + 最後保險的強制結束）。 */
  const finish = async (): Promise<void> => {
    const result = await shutdown();
    if (result.drained) return;
    // 非零退出碼：launchd／人從 exit code 就看得出「上次沒收乾淨」，不必翻 log
    process.exitCode = 1;
    scheduleForceExit(config.orchestrator.shutdownForceExitSec, log);
  };

  if (process.argv.includes('--once')) {
    log.info('--once：執行一輪 tick 後結束');
    await orchestrator.tick();
    // 規劃改成背景執行之後（見 orchestrator 的 startPlanning），tick() 回來時
    // 通常還沒建群。不等它有兩個後果：(a) --once 什麼群都不會建，
    // (b) finish() 會關掉 ledger，而背景規劃回來時撞上已關閉的 DB，
    // 行程還被規劃子行程吊著十幾分鐘（鎖已經放掉，看起來像當掉）。
    await orchestrator.settlePlanning();
    // 再跑一輪才派得出去：dispatch 是第 4 步，規劃收尾發生在它之後
    await orchestrator.tick();
    await finish();
    return;
  }

  // 常駐 + 優雅停止
  //
  // 這個 signal **一路串到底**（那幾條接線已經完成，清單留著是為了讓人知道要檢查哪裡）：
  //   dispatcher.dispatch(ready, signal) → 每個 job
  //   group-runner.runGroup(..., signal) → worker 迴圈
  //   worker → agent.iterate({ signal })  → SDK query 的 AbortController
  //   worker → verifier.check({ signal }) → execa 的 cancelSignal（+ forceKillAfterDelay 5s）
  //
  // 所以 SIGTERM 之後：進行中的 agent 會被中止、關卡的子行程會被殺掉，
  // 已 commit 的成果留在群分支上、未提交的留在 worktree 裡（park 不刪現場）。
  // 重啟後對帳把 in_progress 推回 queued 重跑，而**已完成的任務不會重跑、
  // 已認領的卡不會重新認領**。代價只有「中止那一輪的 token」。
  //
  // 「收尾逾時保留鎖 + 標記 unclean」仍然留著：中止不保證秒退（SDK 可能正在等 API），
  // 逾時就寧可留下鎖讓下一個實例知道上一位走得不乾淨，也不要讓它誤刪還在用的現場。
  const abort = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log.info({ sig }, '收到停止訊號');
      abort.abort();
    });
  }
  await orchestrator.run(abort.signal);
  await finish();
}

export interface ReconcileBootInput {
  ledger: Ledger;
  log: Logger;
  registry: ProjectLookup;
  clients: McpListSource[];
  /** 截圖保留策略的根目錄；未給就完全不清截圖（磁碟會無限成長）。 */
  screenshotRoot?: string;
  worktreeBase?: string;
  /** 這個 profile 的資料根目錄；worktree 掛在它底下。 */
  dataRoot?: string;
  /** 上次沒收乾淨時的保守模式（bootReconcileMode 的結果）。 */
  mode?: BootReconcileMode;
  /** 測試注入：預設 new Reconciler(reconcilerDepsOf(...))。 */
  reconciler?: { reconcile(opts: { dryRun?: boolean }): Promise<{ actions: unknown[] }> };
}

/** 開機對帳的模式。conservative ⇒ 只看不動手（dryRun），不刪任何 worktree／分支。 */
export interface BootReconcileMode {
  conservative: boolean;
  reason?: string;
}

/**
 * 決定這次開機的對帳模式。
 *
 * 上一個實例在還有進行中工作時就結束了（鎖檔帶 unclean 標記）＝ 那些 worktree
 * 可能還有被 orphan 的 agent 子行程在寫；此時做破壞性對帳就是使用者最怕的
 * 「把正在跑的東西清掉」。所以預設轉保守：對帳照跑但走 dryRun，只記錄不動手。
 *
 * ★ 合法例外的出口（D18）：保守會讓上一輪的殘留狀態這一輪收不回來，
 *   確定沒有殘留行程時（例如整台機器重開過）要能立刻恢復完整對帳——
 *   `reconcileAfterUncleanShutdown: full` 或 `ORCH_FORCE_RECONCILE=1` 都可以。
 */
export function bootReconcileMode(input: {
  unclean?: UncleanShutdownMark;
  setting: 'conservative' | 'full';
  env: NodeJS.ProcessEnv;
  log?: Logger;
}): BootReconcileMode {
  if (!input.unclean) return { conservative: false };

  const at = new Date(input.unclean.at).toISOString();
  const base = `上次收尾未完成（${at}，仍有 ${input.unclean.remaining} 個群組進行中）`;

  if (resolveFlag(input.env, 'ORCH_FORCE_RECONCILE', input.setting === 'full', input.log)) {
    input.log?.warn({ at, remaining: input.unclean.remaining }, `${base}，但設定要求完整對帳 → 照常執行破壞性清理（請自行確認沒有殘留的 agent 行程）`);
    return { conservative: false };
  }
  return { conservative: true, reason: `${base}；worktree 可能仍有人在動，本次跳過破壞性清理` };
}

/**
 * 崩潰對帳的相依組裝（抽出來才驗得到「設定真的有接上」——
 * 沒接 screenshotRoot 時截圖永遠不會被清、沒接 mcp 時只有本地證據）。
 */
export function reconcilerDepsOf(input: ReconcileBootInput): ReconcilerDeps {
  const { ledger, log, registry, clients } = input;
  return {
    ledger,
    fs: createFsProbe(),
    git: createGitProbe(log),
    log,
    worktreeBase: input.worktreeBase ?? worktreeBaseOf(input.dataRoot ?? DEFAULT_DATA_ROOT),
    resolveProject: (repo) => registry.runtimeOf(repo),
    knownRepoPaths: () => registry.repoPaths(),
    // 截圖保留策略（projects[].visual.screenshotRoot）；未接 = 截圖永遠不會被清理
    ...(input.screenshotRoot ? { screenshotRoot: input.screenshotRoot } : {}),
    ...(clients.length > 0 ? { mcp: aggregateMcp(clients, log) } : {}),
  };
}

/**
 * 崩潰恢復對帳（DESIGN §6 末段）。對帳本身失敗不可擋住 daemon 啟動，寧可少恢復也要跑起來。
 *
 * mode.conservative（上次沒收乾淨）時走 dryRun：Reconciler 目前只有 dryRun 這一個
 * 「不動手」開關，所以保守＝整輪只產生決策與事件，不刪 worktree、不刪分支、不改狀態。
 * 代價是殘留狀態這一輪不會被收回（下一次乾淨啟動才會），這比刪掉還在被寫入的成果好得多。
 */
export async function reconcileOnBoot(deps: ReconcileBootInput): Promise<void> {
  const { log, ledger } = deps;
  if (process.env.ORCH_SKIP_RECONCILE === '1') {
    log.warn('ORCH_SKIP_RECONCILE=1：跳過崩潰對帳');
    return;
  }
  const conservative = deps.mode?.conservative === true;
  if (conservative) {
    const detail = deps.mode?.reason ?? '上次收尾未完成';
    log.error({ detail }, '⚠️ 保守開機對帳：只記錄決策、不做任何破壞性清理（不清 worktree／不刪分支／不改狀態）。' +
      '確認沒有殘留的 agent 行程後，可用 ORCH_FORCE_RECONCILE=1 或設定 reconcileAfterUncleanShutdown: full 恢復完整對帳');
    try {
      ledger.logEvent('system', null, 'reconcile_conservative', detail);
    } catch (e) {
      log.warn({ err: String(e) }, '保守對帳事件寫入失敗（忽略）');
    }
  }

  const reconciler = deps.reconciler ?? new Reconciler(reconcilerDepsOf(deps));
  try {
    const report = await reconciler.reconcile({ dryRun: conservative || process.env.ORCH_RECONCILE_DRY_RUN === '1' });
    if (report.actions.length > 0) {
      log.info({ actions: report.actions.length, conservative }, conservative ? '保守對帳只記錄了決策（未執行）' : '崩潰對帳有動作，詳見 events 表');
    }
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, '崩潰對帳失敗（daemon 續行）');
  }
}

/** 只有「被直接執行」時才啟動 daemon；被測試 import 時不可有副作用。 */
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
