import { execa } from 'execa';
import { copyFileSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { WorktreeManager } from '../git/worktree.js';
import { Worker } from '../worker/worker.js';
import { ProgressMonitor } from '../worker/progress.js';
import { MergeGuard, type BaseFreshness, type DriftJudgeLike, type MergeGuardInput, type MergeGuardOptions } from '../pr/merge-guard.js';
import { PrManager } from '../pr/pr-manager.js';
import { generatePrBody, narrativeFromSummaries, type AgentSummary } from '../pr/pr-body.js';
import { formatFeedback, type FeedbackSource, type ReviewFeedback } from '../pr/review-watcher.js';
import { readDiffStat, type PolicyInput } from '../policy/policy-engine.js';
import type { MergeRiskVerdict } from './merge-risk-judge.js';
import { gitDiffHash } from '../git/status.js';
import { resolveBaseFreshness } from '../git/base-freshness.js';
import { syncTaskCard } from './card-status.js';
import { gitHeadRef, taskHintOf } from '../worker/verifier.js';
import { resolveVisualDirs } from '../worker/verifier.js';
import type { AgentLike, McpTaskClient, Notifier, ReviewerLike, VerifierLike, TaskCardStatus } from '../contracts.js';
import type { IterateInput, IterateResult } from '../worker/agent-runtime.js';
import type { NoChangePolicy, TaskOutcome } from '../worker/worker.js';
import type { VerifierConfig } from '../worker/verifier.js';
import type { Ledger } from '../store/ledger.js';
import type { Logger } from '../observability/logger.js';
import type { GateReport, Group, GroupState, MergeVerdict, PullRequest, Task, TaskDetail, TaskState } from '../types.js';
import { withActivity } from '../observability/activity.js';
import { withFetchLock } from '../git/fetch-lock.js';

/** 一個專案在執行期需要的東西（由 registry 解析）。 */
/** 與 MergeGuard 相同的 git 執行方式（reject:false，讓呼叫端自己判 exitCode）。 */
async function gitExec(
  repoPath: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const r = await execa('git', ['-C', repoPath, ...args], {
    reject: false,
    ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export interface ProjectRuntime {
  /** MCP 任務的 repo 識別（owner/name）——必須與任務板上的 `task.repo` 一致。 */
  repo: string;
  /**
   * GitHub 操作（開 PR／合併）的目標 repo。**未設 → 等同 repo**。
   *
   * 為什麼要能分開：測試時常見「任務來自正式專案的任務板，但程式碼改在複本 repo」。
   * 此時 `repo` 必須維持正式名稱（否則對不上任務），可是 PR 絕不能開到正式 repo——
   * 沒有這個欄位，`gh pr create --repo` 會直接把 PR 開到正式專案。
   */
  repoPath: string; // 本地 clone
  baseBranch: string;
  verifierConfig: VerifierConfig;
  mcp: McpTaskClient; // Worker 用（start/complete/loadDocs）

  /** 取最新 base 的 remote 名稱（Merge Guard 用）。未給 → 'origin'。 */
  remote?: string;
  /**
   * 要從主 clone 帶進 worktree 的本機設定檔（被 gitignore、所以 worktree 拿不到的那些）。
   * 未給 → DEFAULT_LOCAL_FILES。給空陣列 → 不帶任何檔案（有敏感內容的專案這樣設）。
   */
  localFiles?: string[];
}

// ── 可注入的協作者（正式環境用預設實作；測試注入假件，不碰真實 repo） ──

/** WorktreeManager 的結構介面。 */
export interface WorktreeLike {
  create(repoPath: string, branch: string, opts?: { base?: string }): Promise<{ path: string; branch: string }>;
  remove(repoPath: string, worktreePath: string): Promise<void>;
}

/** PrManager 的結構介面。 */
export interface PrManagerLike {
  commitAll(repoPath: string, message: string): Promise<boolean>;
  openPr(input: {
    repoPath: string; repo: string; branch: string; base: string; title: string; body: string; draft?: boolean;
  }): Promise<PullRequest>;
  /**
   * 合併 PR。政策放行且 PR 已開時走這條——本地合併會留下孤兒 PR。
   * 可選是為了讓既有測試的假件不必實作；沒有它就退回「停在 pr_open 等人」。
   */
  merge?(input: {
    repo: string; prNumber: number; approvedBy: string; deleteBranch?: boolean; cwd?: string;
  }): Promise<{ ok: boolean; detail: string }>;
}

/** MergeGuard 的結構介面。 */
export interface MergeGuardLike {
  attempt(input: MergeGuardInput): Promise<MergeVerdict>;
  postMergeCheck(repoPath: string, base: string, config: VerifierConfig): Promise<MergeVerdict>;
}


export interface GitResult { exitCode: number; stdout: string; stderr: string }
export type GitRunner = (cwd: string, args: string[]) => Promise<GitResult>;

/** 任務卡輸入（結構對映 slack/blocks.ts 的 TaskCardInput，避免反向相依 Slack 模組）。 */
export interface TaskCardLike {
  id: string;
  title: string;
  repo: string;
  category: string;
  description?: string;
  docRefs?: string[];
  dependencies?: string[];
}

/**
 * 「會貼任務卡」的通知端（HumanGateway 結構上即滿足）。
 * contracts.Notifier 只保證有 event()，所以貼卡一律走可選能力偵測（見 canPostTaskCard）。
 */
export interface TaskCardPoster {
  postTaskCard(task: TaskCardLike): Promise<string | undefined>;
}

/** notifier 是否具備貼任務卡的能力（不改 contracts.ts 的可選能力偵測）。 */
export function canPostTaskCard(n: Notifier): n is Notifier & TaskCardPoster {
  return typeof (n as Partial<TaskCardPoster>).postTaskCard === 'function';
}

/** 合併核准請求的輸入（結構對映 slack/blocks.ts 的 MergeApprovalInput）。 */
export interface MergeApprovalAsk {
  groupId: string;
  branch: string;
  repo: string;
  taskTitles: string[];
  prUrl?: string;
  reasons?: string[];
}

/**
 * 「會發合併核准請求」的通知端（HumanGateway 結構上即滿足）。
 *
 * 為什麼要有這個介面：政策判定 needs_human 時只發一則文字事件，人收到的是
 * 「⚠️ 需人工核准才能合併：…」**卻沒有任何核准按鈕**——需求「人核准後合併」
 * 在真實路徑上等於不可達（實跑證實 askMergeApproval 被呼叫 0 次）。
 */
export interface MergeApprovalAsker {
  askMergeApproval(threadTs: string | undefined, group: MergeApprovalAsk): Promise<void>;
}

/** notifier 是否具備發合併核准請求的能力（沒有就降級成純文字通知）。 */
export function canAskMergeApproval(n: Notifier): n is Notifier & MergeApprovalAsker {
  return typeof (n as Partial<MergeApprovalAsker>).askMergeApproval === 'function';
}

/**
 * 審查意見暫存區的結構介面（ReviewFeedbackStore 結構上即滿足）。
 *
 * 契約（由 review-loop 側定義，見 review-watcher.ts 的 ReviewFeedbackStore 檔頭）：
 * 收到群組時先 `peek`，有值代表這是「帶著 reviewer 意見重做」；意見**真的交給 agent 之後**
 * 才 `take()` 清掉——先清會讓中途失敗的群組永遠拿不回那些意見（等於意見遺失）。
 */
export interface FeedbackStoreLike {
  peek(groupId: string): ReviewFeedback | undefined;
  take(groupId: string): ReviewFeedback | undefined;
  /**
   * Merge Guard 擋下時，把判決寫成一則意見交回 agent。
   * 可選是為了讓測試假件不必實作；沒有 save 就退回「標失敗」（見該處說明）。
   */
  save?(input: { groupId: string; comments: string[]; source: FeedbackSource }): unknown;
}

export interface GroupRunnerDeps {
  ledger: Ledger;
  log: Logger;
  worktreeBase: string;
  resolveProject: (repo: string) => ProjectRuntime | undefined;
  agent: AgentLike;
  makeVerifier: () => VerifierLike;
  progressRounds: number;
  notifier: Notifier;
  /**
   * 自動合併：Merge Guard 通過後直接合併那個 PR，不等人審查。
   * 預設 false——每個 PR 都停下來等人。合併會動到 base 分支，那是唯一不可逆的動作。
   */
  allowLocalMerge?: boolean;
  /**
   * 合併風險判斷者。只在 allowLocalMerge 開著時會被呼叫：
   * 使用者說了「一般改動不必問我」，這一關只攔「做錯了救不回來」的那種。
   * 未注入 ⇒ 一律當成要問人（無法確認安全 ≠ 確認安全）。
   */
  mergeRiskJudge?: { judge(input: { cwd: string; baseRef: string; taskTitles: string[]; taskDescriptions?: string[] }): Promise<MergeRiskVerdict> };
  /** 保留 worktree 不清理（除錯用）。預設 false：成功即清、失敗保留。 */
  keepWorktree?: boolean;
  /**
   * 獨立 reviewer（DESIGN §5）。**可選**：未注入 → DoD 綠燈即完成（M1/M2 行為）。
   * 注入後 reviewer 自身也會降級（無金鑰/失敗 → skipped，不阻擋）。
   */
  reviewer?: ReviewerLike;
  /** agent 宣告「本任務無需改動」時的處置政策（轉交 Worker）。未設 → 一律交人確認。 */
  noChangePolicy?: NoChangePolicy;
  /** 工作區變更指紋（Worker 無進展偵測用）。預設 git/status.gitDiffHash。 */
  diffHash?: (cwd: string) => Promise<string>;
  /** 取本次變更的檔案清單與統計（政策判定用）。預設 policy/readDiffStat。 */
  readDiff?: (cwd: string, baseRef: string) => Promise<PolicyInput>;
  /** 取某任務的截圖路徑（PR 內文用）。預設掃 Verifier 的截圖目錄。 */
  screenshotsFor?: (input: { taskId: string; cwd: string; config: VerifierConfig }) => string[];
  /** node_modules 準備策略所用的環境（測試注入假件）。 */
  nodeModulesEnv?: NodeModulesEnv;
  /**
   * 共用的審查意見暫存區。**可選**：未注入 → 每個群組都當成全新群組（既有行為）。
   * 注入時必須與 Orchestrator 用**同一個實例**，否則 orchestrator 存的意見這裡讀不到
   * （它有安全互鎖：讀不到就不派工，見 orchestrator.ts 的 requeue 階段）。
   */
  feedback?: FeedbackStoreLike;
  /**
   * 語意飄移的判斷層（rebase 成功且測試綠之後才跑）。未注入就不跑——
   * 事實層（衝突、紅燈）不受影響。
   */
  driftJudge?: DriftJudgeLike;
  /**
   * 「群內任務都已 done 的 rework」最多重做幾輪就交人。預設 3。
   *
   * 為什麼這裡有上限、Worker 的主迴圈卻沒有（§D10）：主迴圈的任務已在 MCP 上被認領，
   * 停下來等於任務卡死，所以只能一直做；而 rework 是**已完成成果的追加修正**，
   * 收不斂時 park 給人看不會遺失任何東西，卻能避免無止境地重打 API。
   */
  reworkRounds?: number;
  /** 覆寫內部協作者（測試注入假件）。 */
  worktrees?: WorktreeLike;
  prManager?: PrManagerLike;
  makeMergeGuard?: (verifier: VerifierLike, options: MergeGuardOptions) => MergeGuardLike;
  git?: GitRunner;
}

/** rework 迴圈的預設輪數上限。 */
const DEFAULT_REWORK_ROUNDS = 3;

// ── 群組狀態契約（給 orchestrator / dispatcher 側的 requeue 路徑） ──

/**
 * **可重新派工**的群組狀態。Dispatcher/Orchestrator 只會撿 'ready' 的群，
 * 所以任何「之後還要再跑」的群最終都必須回到這個狀態，否則就永久遺失。
 */
export const DISPATCHABLE_GROUP_STATE: GroupState = 'ready';

/**
 * 「等人給輸入、之後可恢復」的群組狀態（park）。
 *
 * GroupState 沒有專門的 parked，選 'changes_requested' 的理由：
 *  1. 它不是終態（終態是 'merged'/'failed'），語意也對——要有人回覆才能繼續；
 *  2. reconciler 的 GROUP_ALIVE 已包含它 → worktree 不會被當孤兒掃掉，
 *     agent 未提交的工作因此得以保留，人回覆後可以接著做。
 */
export const PARKED_GROUP_STATE: GroupState = 'changes_requested';

/** 群組「還在流程中」的狀態：例外收斂時只有這些可以被覆寫成 failed。 */
/**
 * 因 daemon 停止而中斷（不是崩潰）。
 *
 * 有這個事件的群組：狀態原樣保留、不消耗重派預算、下次開機由對帳接手；
 * 而且對帳**不可以走清理路徑**——那會刪掉被中斷 agent 尚未 commit 的工作。
 */
export const GROUP_ABORTED_EVENT = 'group_aborted';

const IN_FLIGHT_GROUP_STATES: GroupState[] = ['forming', 'ready', 'merge_guard'];

/**
 * park 的稽核事件（等人回覆／等人裁決）。orchestrator 靠它與下面的 deps 事件**分辨這次 park 的原因**
 * ——兩者都停在 PARKED_GROUP_STATE，狀態本身分不出來（比事件 id 誰新即可）。
 */
export const GROUP_PARKED_EVENT = 'group_parked';

/**
 * 「等上游依賴」的稽核事件。這是 orchestrator 退避計時器的唯一觸發訊號：
 * 每多一次受阻就多一格指數退避，沒有它就只能每輪盲目重派。
 */
export const GROUP_DEPS_BLOCKED_EVENT = 'group_deps_blocked';

/**
 * requeue 契約（orchestrator 側實作，這裡提供判定）：
 * 群組被 park 在 PARKED_GROUP_STATE，且群內已經沒有 blocked 任務
 * （人已回覆 → InboundRouter 把任務 clearBlock 回 queued）→ 轉回 DISPATCHABLE_GROUP_STATE 重新派工。
 *
 * 注意這裡只管「還有事情要做」的情況。群內任務**全部 done** 的 park 群另有出路
 * （orchestrator 的 A2：沒開過 PR 就重派去收尾），因為那要看群組有沒有走到審查階段才能判斷，
 * 而這個判定函式只拿得到任務狀態。
 */
export function shouldRequeueGroup(
  group: { state: GroupState },
  tasks: { state: TaskState }[],
): boolean {
  if (group.state !== PARKED_GROUP_STATE) return false;
  if (tasks.length === 0) return false;
  if (tasks.some((t) => t.state === 'blocked')) return false; // 還在等人
  return tasks.some((t) => t.state !== 'done');
}

// ── worktree 的 node_modules ──

/** node_modules 準備結果：cow=寫時複製、symlink=連回主 clone（有污染風險）。 */
export type NodeModulesStrategy = 'none' | 'reused' | 'cow' | 'symlink';

/** 準備 node_modules 需要的環境操作（測試注入假件，不碰真實檔案系統）。 */
export interface NodeModulesEnv {
  exists(path: string): boolean;
  /** 寫時複製整個目錄（macOS APFS clonefile）。成功 true；不支援/失敗 false。 */
  cloneDir(src: string, dst: string): Promise<boolean>;
  symlink(src: string, dst: string): void;
  removeDir(path: string): void;
  platform: NodeJS.Platform;
}

export const defaultNodeModulesEnv: NodeModulesEnv = {
  exists: (p) => existsSync(p),
  async cloneDir(src, dst) {
    // -c = clonefile（APFS 寫時複製）：不實際搬資料，幾乎不花時間也不佔空間。
    // 非 APFS / 其他平台會直接失敗，由呼叫端退回 symlink。
    const r = await execa('cp', ['-Rc', src, dst], { reject: false });
    return r.exitCode === 0;
  },
  symlink: (src, dst) => symlinkSync(src, dst, 'dir'),
  removeDir: (p) => rmSync(p, { recursive: true, force: true }),
  platform: process.platform,
};

/**
 * 把依賴帶進 worktree（worktree 不含未追蹤的 node_modules）。
 *
 * 為什麼不直接 symlink：symlink 會讓 agent 在 worktree 執行 `npm install`
 * 直接寫進**使用者真實 clone** 的 node_modules（升版、刪套件都會生效），這是破壞使用者環境。
 * 為什麼不完整複製：node_modules 動輒數萬檔案，每個群複製一份太慢。
 * 折衷：macOS APFS 的 clonefile（`cp -Rc`）——寫時複製，建立成本接近 symlink，
 * 但 agent 之後的寫入只會落在副本上。clonefile 不可用時才退回 symlink，並**明確警告風險**。
 */
/**
 * 本機設定檔的預設清單。
 *
 * 選這幾個是因為它們都是**開發環境設定**、而且慣例上被 gitignore——正因為被 ignore，
 * `git worktree add` 不會帶過去，於是 worktree 變成一個「跑不起來的專案」。
 */
export const DEFAULT_LOCAL_FILES = ['.env', '.env.local', '.env.development', '.npmrc'];

/**
 * 把主 clone 的本機設定檔帶進 worktree。
 *
 * 為什麼需要：一個 worktree 應該是**能動的開發環境**——人類開發者 clone 完之後有什麼，
 * 它就該有什麼。相依套件已經用 clonefile 帶進來了，但本機設定檔沒有。
 * 少了它，dev server 起得來、app 卻掛不起來（例：Firebase 少了 apiKey 會整個不掛載），
 * 於是截圖是空白頁、視覺驗證變成在驗證一個根本沒渲染的畫面。
 *
 * 這不只影響視覺驗證——寫程式的 agent 想自己跑起來看，一樣會撞到。
 *
 * 安全性：這些是**開發用設定**（例如 VITE_ 前綴的值本來就會被打包進瀏覽器），
 * 不是伺服器密鑰；而且 agent 本來就能用 Bash 讀主 clone 的同一份檔案。
 * 真正的防線在別處：GitHub token 從 agent 環境整個剝除、部署指令一律擋下、
 * 保護路徑不可刪改。真有敏感內容的專案，就在設定裡不列那個檔案。
 *
 * 檔案不存在就跳過（多數專案不會四個都有），複製而非 symlink——
 * symlink 會讓 agent 的寫入直接改到使用者的主 clone。
 */
export async function prepareLocalFiles(
  repoPath: string,
  wtPath: string,
  log: Logger,
  files: string[] = DEFAULT_LOCAL_FILES,
  io: { exists: (p: string) => boolean; copy: (a: string, b: string) => void } = {
    exists: existsSync,
    copy: (a, b) => copyFileSync(a, b),
  },
): Promise<string[]> {
  const copied: string[] = [];
  for (const rel of files) {
    const src = join(repoPath, rel);
    const dst = join(wtPath, rel);
    if (!io.exists(src) || io.exists(dst)) continue;
    try {
      io.copy(src, dst);
      copied.push(rel);
    } catch (e) {
      // 少一個設定檔只是那個專案的驗證會失敗並講明原因，不該讓整個群組跑不起來
      log.warn({ rel, err: e instanceof Error ? e.message : String(e) }, '本機設定檔複製失敗（略過）');
    }
  }
  if (copied.length > 0) log.info({ wtPath, files: copied }, '本機設定檔已帶入 worktree');
  return copied;
}

export async function prepareNodeModules(
  repoPath: string,
  wtPath: string,
  log: Logger,
  env: NodeModulesEnv = defaultNodeModulesEnv,
): Promise<NodeModulesStrategy> {
  const src = join(repoPath, 'node_modules');
  const dst = join(wtPath, 'node_modules');
  if (!env.exists(src)) return 'none';
  if (env.exists(dst)) return 'reused';

  if (env.platform === 'darwin') {
    let cloned = false;
    try {
      cloned = await env.cloneDir(src, dst);
    } catch (e) {
      log.warn({ err: String(e) }, 'node_modules 寫時複製擲錯');
    }
    if (cloned) {
      log.info({ wtPath }, 'node_modules 已以寫時複製（clonefile）帶入 worktree');
      return 'cow';
    }
    // 失敗可能留下半套目錄，清掉再退回 symlink，免得 build 讀到殘缺依賴
    try {
      env.removeDir(dst);
    } catch (e) {
      log.warn({ err: String(e), dst }, '清理半套 node_modules 失敗');
    }
  }

  try {
    env.symlink(src, dst);
    log.warn(
      { repoPath, wtPath },
      '⚠ worktree 的 node_modules 是指向主 clone 的 symlink：agent 若在 worktree 執行 npm install/uninstall 會直接改到使用者的真實 clone',
    );
    return 'symlink';
  } catch (e) {
    log.warn({ err: String(e) }, 'node_modules 連結失敗（build 可能需先安裝依賴）');
    return 'none';
  }
}

const defaultGit: GitRunner = async (cwd, args) => {
  const r = await execa('git', ['-C', cwd, ...args], { reject: false });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout, stderr: r.stderr };
};

/** PR 內文最多嵌入幾張截圖（避免一個視覺群把 PR 內文灌爆）。 */
const MAX_PR_SCREENSHOTS = 12;
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

/**
 * 掃某任務的截圖目錄（Verifier 把截圖寫在 `<screenshotRoot>/<taskId>/`）。
 *
 * 為什麼用掃目錄而不是接 GateReport.screenshots：Worker 只回傳 status，
 * 關卡報告（含 screenshots）在它內部就被丟棄了；改 worker.ts 不在本模組職責內，
 * 而截圖路徑本來就是**可預測**的，掃目錄同樣拿得到，且進程重啟後依然有效。
 */
export function defaultScreenshotsFor(input: { taskId: string; cwd: string; config: VerifierConfig }): string[] {
  const { screenshotDir } = resolveVisualDirs({ cwd: input.cwd, config: input.config.visual ?? {}, key: input.taskId });
  try {
    if (!existsSync(screenshotDir)) return [];
    return readdirSync(screenshotDir)
      .filter((f) => IMAGE_RE.test(f))
      .sort()
      .map((f) => join(screenshotDir, f));
  } catch {
    return []; // 截圖只是加分項，取不到絕不能讓開 PR 失敗
  }
}

/**
 * 側錄 agent 每輪的最終總結。
 *
 * Worker.runTask 只回傳 status，IterateResult.resultText 會被丟棄；但 PR 內文的敘事段
 * （做了什麼/怎麼做/架構…）正是要用它。這裡以「包一層 AgentLike」在不改 worker.ts 的
 * 前提下取得總結——比從 ledger 反查更直接，且對任何 AgentLike 實作都成立。
 */
export class SummaryRecorder implements AgentLike {
  private byTask = new Map<string, string>();

  constructor(private inner: AgentLike, private onCapture?: (taskId: string, text: string) => void) {}

  async iterate(input: IterateInput): Promise<IterateResult> {
    const r = await this.inner.iterate(input);
    // 只留「成功那輪」的總結；失敗輪的文字多半是錯誤訊息，寫進 PR 只會誤導
    if (!r.isError && r.resultText.trim()) {
      this.byTask.set(input.task.id, r.resultText);
      this.onCapture?.(input.task.id, r.resultText);
    }
    return r;
  }

  get(taskId: string): string | undefined {
    return this.byTask.get(taskId);
  }
}

/** 回灌意見在 GateReport 裡的關卡名稱（agent prompt 會列出這一項）。 */
export const REVIEW_FEEDBACK_CHECK = 'review_feedback';

/**
 * 把審查意見包成 GateReport。
 *
 * 為什麼借用 GateReport：agent 的 prompt 組裝（buildAgentPrompt）本來就會把
 * `feedback` 裡「未通過的關卡」列成「上一輪驗證未通過，請修正後再完成」。
 * 走這條既有管道，意見就能原封不動送到 agent 面前，不必改 Worker/AgentRuntime 的介面。
 * signature 固定不含時間等浮動值，才不會破壞無進展偵測（§D11）。
 */
/** 從 git 的 rebase 輸出裡挑出真正衝突的檔案（`CONFLICT (...): Merge conflict in <file>`）。 */
export function conflictedFiles(gitOutput: string): string[] {
  const out = new Set<string>();
  for (const line of gitOutput.split('\n')) {
    const m = /Merge conflict in (.+?)\s*$/.exec(line) ?? /^CONFLICT \([^)]*\): (.+?)\s*$/.exec(line);
    if (m?.[1]) out.add(m[1].trim());
  }
  return [...out];
}

/**
 * Merge Guard 的判決 → 一則交給 agent 的意見。
 *
 * 寫法上刻意做三件事：講清楚**發生什麼事實**、點名**哪些檔案**、說明**要往哪個方向修**。
 * 只丟一句「合併守衛擋下」等於要 agent 猜謎；而最容易猜錯的方向是「把對方的變更蓋掉
 * 讓衝突消失」——那會安靜地弄丟別人剛合併進 base 的功能，所以必須明講不准。
 */
export function mergeGuardFeedback(
  verdict: { reason?: string; detail?: string },
  caveats: string[] = [],
): string {
  const detail = verdict.detail?.trim() ?? '';
  const parts: string[] = [];

  if (verdict.reason === 'code_conflict') {
    const files = conflictedFiles(detail);
    parts.push(
      '你的分支要合併回目標分支，但**目標分支在你動工之後已經有新的變更**，rebase 產生了衝突。',
      files.length > 0 ? `衝突檔案：${files.join('、')}` : '衝突檔案：見下方 git 輸出。',
      '',
      '請這樣處理：',
      '1. 先看目標分支上那些新變更做了什麼（例如 `git log`、`git diff` 對照最新的 base）。',
      '2. 在**最新的 base 之上**重做你這份改動，讓兩邊的意圖都保留下來。',
      '3. **不可以**為了消掉衝突就把對方的變更刪掉或改回去——那會安靜地弄壞別人剛完成的功能。',
      '4. 如果兩邊的需求真的互斥、無法同時成立，用 ask_human 說明衝突點，不要自己選一邊。',
    );
  } else if (verdict.reason === 'semantic_drift') {
    // **不要用 reason 這個代碼去推論原因。** semantic_drift 現在有兩種來源：
    // 合併後 build/test 紅（確實是「依賴被改掉」），以及 DoD 裡的介面判斷紅
    // （跟依賴毫無關係）。先前這裡寫死了前者的敘述，於是判斷者說「按鈕太小」時，
    // agent 收到的開頭卻是「找出你用到的哪個函式被改了」——一段會把它引去錯方向的診斷。
    //
    // 正確做法：不編故事，直接講**實際失敗的是什麼**（就在下面的原始輸出裡），
    // 只補上這個判決共通的前提與紅線。
    parts.push(
      '你的改動單獨看是好的，但**跟目標分支的最新狀態合併之後，下面列的關卡沒過**。',
      '',
      '請這樣處理：',
      '1. 先看清楚下面「原始輸出」裡**實際失敗的是哪一項**，照那一項的內容處理。',
      '2. 如果是依賴被改掉（函式／元件／型別不見了或換了介面），讓你的改動適配新的介面，',
      '   **不要**把對方的改動還原。',
      '3. 如果是畫面或行為的問題，依照該項的建議修，修完要能通過所有關卡。',
    );
  } else if (verdict.reason === 'post_merge_red') {
    parts.push('合併之後在目標分支上重跑驗證是紅的，改動已被還原。請找出原因並修正後重來。');
  } else {
    parts.push(`合併前置檢查未通過（${verdict.reason ?? '未知原因'}）。`);
  }

  if (caveats.length > 0) parts.push('', `⚠ 但書：${caveats.join('；')}`);
  // **給 agent 全文，不要替它挑。** 它需要哪一行只有它自己知道——挑錯就是無聲地
  // 拿掉它需要的資訊。只清 ANSI 色碼：那在純文字裡沒有意義，還會讓 ✓ 和 ✗ 難分辨。
  if (detail) parts.push('', '── 原始輸出 ──', stripAnsi(detail));
  return parts.join('\n');
}

/**
 * 清掉測試框架的 ANSI 色碼。
 *
 * 只做這一件事。**不挑行、不截斷**——哪幾行有用是讀的人（agent 或你）才判斷得出來的，
 * 程式挑錯就是無聲地拿掉需要的資訊，而症狀會是「它看了輸出卻修錯方向」。
 */
export function stripAnsi(raw: string): string {
  return raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
}

export function reviewFeedbackGate(fb: ReviewFeedback): GateReport {
  return {
    green: false,
    checks: [{ name: REVIEW_FEEDBACK_CHECK, ok: false, detail: formatFeedback(fb) }],
    signature: `review-feedback:${fb.source}:${fb.comments.length}`,
  };
}

/** 合併兩份關卡報告的失敗項（審查意見 + 本輪 DoD 失敗，agent 要一次看到全部）。 */
function mergeGates(a: GateReport, b: GateReport | undefined): GateReport {
  if (!b) return a;
  return { green: false, checks: [...a.checks, ...b.checks], signature: `${a.signature}+${b.signature}` };
}

/**
 * 把審查意見注入 agent 的第一輪輸入（rework 模式）。
 *
 * 只注入第一輪：之後的輪次是同一個 session（resume），agent 仍記得那些意見；
 * 每輪都重貼反而會蓋掉「本輪 DoD 為什麼紅」這個更即時的資訊。
 * `onDelivered` 在**確定送達**（agent 沒有回報執行錯誤）後才呼叫——呼叫端據此 take() 清掉
 * 暫存；若在送達前就清掉，API 掛掉的那一輪會讓意見人間蒸發。
 */
export class ReworkFeedbackInjector implements AgentLike {
  private delivered = false;

  constructor(private inner: AgentLike, private gate: GateReport, private onDelivered: () => void) {}

  async iterate(input: IterateInput): Promise<IterateResult> {
    if (this.delivered) return await this.inner.iterate(input);

    const r = await this.inner.iterate({ ...input, feedback: mergeGates(this.gate, input.feedback) });
    if (!r.isError) {
      this.delivered = true;
      this.onDelivered();
    }
    return r;
  }
}

/** 一次群組執行的結果：是否走完、要不要保留 worktree、以及原因（寫進 log）。 */
interface RunOutcome {
  ok: boolean;
  /** 保留 worktree（失敗現場，或 park 時要保住 agent 未提交的工作）。 */
  keep: boolean;
  reason: string;
}

const SUCCESS: RunOutcome = { ok: true, keep: false, reason: '' };

/**
 * 群組處理（DESIGN §3 步驟 5-8）：群內依 taskIds 順序逐一 Worker 完成 → 提交 →
 * Merge Guard 把關 → 政策引擎判定能否自動合併 →（開啟時）本地合併 + 合併後檢查 + 紅燈 revert。
 *
 * 安全預設：實際合併（allowLocalMerge）預設關閉，
 * 沒設定就只跑到「本地驗證 + 判定」，對真實專案不產生任何外部副作用。
 */
import { withRepoLock } from './repo-lock.js';
export { withRepoLock } from './repo-lock.js';

export class GroupRunner {
  private wm: WorktreeLike;
  private pr: PrManagerLike;
  private git: GitRunner;
  /** taskId → Slack thread_ts（群層事件掛在群內第一個任務的 thread）。 */
  private threads = new Map<string, string>();

  constructor(private deps: GroupRunnerDeps) {
    this.wm = deps.worktrees ?? new WorktreeManager(deps.worktreeBase, deps.log);
    this.pr = deps.prManager ?? new PrManager(deps.log);
    this.git = deps.git ?? defaultGit;
  }

  /** 同一件事只吵一次（例如專案被停用期間，每 15 秒都會撞到同一個狀況）。 */
  private readonly warnedOnce = new Set<string>();

  private warnOnce(key: string, ctx: Record<string, unknown>, msg: string): void {
    if (this.warnedOnce.has(key)) return;
    this.warnedOnce.add(key);
    this.deps.log.warn(ctx, msg);
  }

  /**
   * @param signal daemon 收到 SIGTERM 時傳下來。一路交給 worker → agent → DoD 指令，
   *   讓它們真的停下來並收掉子行程。沒有它的話 `stop` 只是「不再排新工作」，
   *   正在跑的 agent 完全不知情，寬限逾時後被強制殺掉——它用 Bash 起的
   *   dev server／watch 就成了孤兒（實跑：三個埠被佔了一個多小時，沒人看得到）。
   */
  run = async (group: Group, signal?: AbortSignal): Promise<void> => {
    const { ledger, log } = this.deps;
    const proj = this.deps.resolveProject(group.repo);
    if (!proj) {
      // **不可以標 failed。**
      //
      // 「查不到專案」有很多原因——使用者在控制台停用了它、正在編輯、MCP 一時連不上——
      // 每一種都會自己好。標 failed 會讓 Orchestrator 走重新派工的路，
      // 而每 15 秒重試一次、連錯 3 次就永久停手：只要停用超過 45 秒，那一群就死了。
      //
      // 實跑撞到：使用者建立專案後停用去檢查設定，回來時 3 個群組（13 個任務）
      // 已經 requeue_exhausted 停在那裡，而且成果是零——純粹是被系統自己判死的。
      //
      // 退回 ready 等下一輪。專案回來就自動繼續，也不消耗任何重試預算。
      // （崩潰對帳那邊本來就是這個原則：「不知道 repoPath 無法安全清理，更不能標 failed」，
      //   這條路先前完全相反。）
      this.warnOnce(
        `noproj:${group.id}`,
        { group: group.id, repo: group.repo },
        '查不到專案（可能被停用或正在編輯），群組退回 ready 等下一輪，不消耗重試預算',
      );
      ledger.updateGroupState(group.id, 'ready');
      return;
    }

    ledger.updateGroupState(group.id, 'forming');

    // 開工前先把 base 拉到最新。沒有這一步，本機 clone 停在三天前的話，agent 會在
    // 過期的程式碼上實作——重做別人做過的東西、對著已經被改掉的 API 寫、驗證全綠卻一
    // rebase 就爆。這種問題要到 PR 階段才會發現，整群的工都要重來。
    // 取不到最新版不讓流程停（離線／無 remote 也要能跑），但但書要留在稽核軌跡裡。
    const fresh = await this.freshBase(proj, group.id);
    if (fresh.caveat) {
      ledger.logEvent('group', group.id, 'base_stale', fresh.caveat);
      log.warn({ group: group.id, base: proj.baseBranch, caveat: fresh.caveat }, '開工的 base 不保證是最新的');
    }
    await this.rememberBaseSha(group, proj, fresh);

    let wt: { path: string };
    try {
      wt = await this.wm.create(proj.repoPath, group.branch, { base: fresh.ref });
    } catch (e) {
      // 建 worktree 就失敗：群組不能留在 forming，否則 daemon 不重啟就再也不會被派工
      const msg = e instanceof Error ? e.message : String(e);
      log.error({ group: group.id, err: msg }, '建立 worktree 失敗，群組標記 failed');
      ledger.logEvent('group', group.id, 'worktree_create_failed', msg);
      ledger.updateGroupState(group.id, 'failed');
      return;
    }
    await prepareNodeModules(proj.repoPath, wt.path, log, this.deps.nodeModulesEnv);
    // 相依套件之外，本機設定檔也要帶——否則 worktree 是個「跑不起來的專案」，
    // dev server 起得來但 app 掛不起來，畫面驗證等於在驗證一張空白頁。
    await prepareLocalFiles(proj.repoPath, wt.path, log, proj.localFiles);

    // 例外一律收斂到明確狀態（見 catch）；details 由 runGroup 邊跑邊填，通知才有載體
    const details: TaskDetail[] = [];
    let outcome: RunOutcome = { ok: false, keep: true, reason: '執行中擲出例外' };
    try {
      outcome = await this.runGroup(group, proj, wt.path, details, signal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      
      // **被停止不是崩潰。** daemon 收到 SIGTERM 時中止訊號一路傳到 agent 與 DoD 指令，
      // 它們擲出的例外落到這裡，而 SDK 的訊息是「Claude Code process aborted by user」——
      // 看起來像使用者做錯什麼，實際上就是正常關機。
      //
      // 判準用 `signal.aborted` 而不是比對訊息：同一次 abort，SDK 在不同路徑會擲出
      // 不同的英文字串，比對字串等於把恢復邏輯綁在別人的文案上。
      //
      // 這條路**完全不覆寫群組狀態**：abort 可能發生在 forming／merge_guard／pr_open
      // 任何一個階段，寫成 failed 是終態，會讓開機對帳的恢復決策樹整個失效
      //（failed 不在 GROUP_LIMBO，對帳根本不看它），於是每次重啟都要人一個一個按重試。
      if (signal?.aborted) {
        const state = ledger.getGroup(group.id)?.state;
        ledger.logEvent('group', group.id, GROUP_ABORTED_EVENT, `${state ?? '?'}：${msg}`);
        log.info({ group: group.id, state }, '收到停止訊號，中途停下（狀態原樣保留，交下次開機對帳接手）');
        outcome = { ok: false, keep: true, reason: '收到停止訊號，中途停下' };
        return;
      }
      
      log.error({ group: group.id, err: msg }, '群組執行擲出例外');
      ledger.logEvent('group', group.id, 'group_crashed', msg);
      this.notify(details, { type: 'failed', detail: `群組執行擲出例外：${msg}` });
      this.cards(details, 'failed', group.id);
      this.markFailedIfInFlight(group, msg);
      outcome = { ok: false, keep: true, reason: `例外：${msg}` };
    } finally {
      await this.cleanupAfterRun(proj.repoPath, wt.path, outcome);
    }
  };

  /**
   * 例外收斂：只有還在流程中的群才覆寫成 failed。
   * 已經是 merged/pr_open/in_review/changes_requested 的群代表流程已有明確結論，
   * 覆寫會製造假失敗（例如合併已完成、只是收尾時擲錯）。
   */
  /**
   * 開工用的 base ref：先 fetch，拿得到 remote 最新版就用它。
   * 失敗一律降級成本地 base（附但書），不讓「連不到網路」變成「整群做不了」。
   */
  private async freshBase(proj: ProjectRuntime, groupId: string): Promise<BaseFreshness> {
    try {
      return await resolveBaseFreshness(proj.repoPath, proj.baseBranch, {
        git: gitExec,
        ...(proj.remote ? { remote: proj.remote } : {}),
      });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.deps.log.warn({ group: groupId, err: why }, 'base 新鮮度檢查失敗，改用本地 base');
      return { ref: proj.baseBranch, fetched: false, caveat: `新鮮度檢查失敗（${why}），基於本地狀態` };
    }
  }

  /**
   * 記下這一群「從哪裡開工」——**只有第一次會寫進去**。
   *
   * ── 為什麼要 rev-parse ──
   *
   * `freshBase` 回的是 `BaseFreshness.ref`，那是一個**名字**（`origin/main`），不是 commit。
   * 直接存名字等於欄位裡放一個會飄的東西：三天後再讀它，指到的是三天後的 main，
   * 而這個欄位存在的全部意義就是「我們從哪裡分岔出來」這個**不會變的事實**。
   * 這正是它要修的那個 bug 的形狀（基準每次重新推導 → 每次得到不同答案）。
   *
   * ── 為什麼要 first-write-wins ──
   *
   * `run()` 每次派工都會進來一次（requeue、park 復活、崩潰重排）。沒有這個條件，
   * 第二次派工就會把基準改成「現在的 base」，所有以它為準的比較全部偏移。
   * 條件在 SQL 裡（`WHERE base_sha IS NULL`），所以是原子的。
   *
   * 解不開 ref 就不寫，只留 warn：這是記帳，不該讓派工停下來。
   */
  private async rememberBaseSha(group: Group, proj: ProjectRuntime, fresh: BaseFreshness): Promise<void> {
    const { ledger, log } = this.deps;
    if (ledger.getGroup(group.id)?.baseSha) return; // 已經有了就不必付一次 rev-parse
    const r = await gitExec(proj.repoPath, ['rev-parse', fresh.ref]);
    const sha = r.exitCode === 0 ? r.stdout.trim() : '';
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      log.warn({ group: group.id, ref: fresh.ref, out: sha.slice(0, 80) }, '解不開開工 base 的 sha，這一群不記基準');
      return;
    }
    if (ledger.setGroupBaseSha(group.id, sha)) {
      log.info({ group: group.id, ref: fresh.ref, baseSha: sha.slice(0, 8) }, '記下這一群的開工基準（之後不再重算）');
    }
  }

  private markFailedIfInFlight(group: Group, why: string): void {
    const { ledger, log } = this.deps;
    const cur = ledger.getGroup(group.id)?.state;
    if (cur && !IN_FLIGHT_GROUP_STATES.includes(cur)) {
      log.warn({ group: group.id, state: cur, err: why }, '例外發生在群組已有明確狀態之後，不覆寫狀態');
      return;
    }
    ledger.updateGroupState(group.id, 'failed');
  }

  /** 群組主流程；回傳執行結果（是否成功、worktree 去留）。 */
  private async runGroup(group: Group, proj: ProjectRuntime, wtPath: string, details: TaskDetail[], signal?: AbortSignal): Promise<RunOutcome> {
    const { ledger, log } = this.deps;

    const recorder = new SummaryRecorder(this.deps.agent, (taskId, text) => {
      // 稽核用：總結同時落 ledger events，之後即使進程重啟也查得到當時 agent 說了什麼
      ledger.logEvent('task', taskId, 'agent_summary', text);
    });

    // rework 模式：暫存區裡有這個群組的意見 = orchestrator 帶著 reviewer 意見把它派回來了。
    // peek 不清除；意見真的送到 agent 面前（injector 回報 delivered）才 take()。
    const pending = this.deps.feedback?.peek(group.id);
    const reworkGate = pending ? reviewFeedbackGate(pending) : undefined;
    const agent: AgentLike =
      reworkGate && pending
        ? new ReworkFeedbackInjector(recorder, reworkGate, () => {
            this.deps.feedback?.take(group.id);
            ledger.logEvent('group', group.id, 'review_feedback_delivered', `${pending.source}：${pending.comments.length} 則意見已交給 agent`);
            log.info({ group: group.id, source: pending.source }, '審查意見已交給 agent，暫存區清空');
          })
        : recorder;
    if (pending) {
      log.info({ group: group.id, source: pending.source, comments: pending.comments.length }, '帶著審查意見重做（rework）');
    }

    const worker = new Worker({
      mcp: proj.mcp,
      agent,
      verifier: this.deps.makeVerifier(),
      progress: new ProgressMonitor(ledger, this.deps.progressRounds),
      ledger,
      notifier: this.deps.notifier,
      diffHash: this.deps.diffHash ?? gitDiffHash,
      log,
      ...(this.deps.reviewer ? { reviewer: this.deps.reviewer } : {}),
      ...(this.deps.noChangePolicy ? { noChangePolicy: this.deps.noChangePolicy } : {}),
    });

    let ran = 0;
    for (const taskId of group.taskIds) {
      const t = ledger.getTask(taskId);
      if (!t) continue;
      const detail: TaskDetail = {
        id: t.id, title: t.title, status: 'todo', repo: t.repo,
        category: t.category, description: t.description, dependencies: t.dependencies, docRefs: t.docRefs,
      };
      details.push(detail); // 已完成的任務也要進 details：PR 的「涵蓋任務」是整群，不是本輪跑過的那些

      // 重新派工（requeue／rework）時，群內可能已有上一輪完成的任務。**絕不能重跑**：
      // Worker 的第一步是 start_task，而 MCP 對已 done 的任務會拒絕認領（D2/D4，且無反 done 工具），
      // 那個錯誤會讓整群被判 failed（終態）——恢復路徑就是這樣斷掉的。
      if (t.state === 'done') {
        if (t.slackThreadTs) this.threads.set(t.id, t.slackThreadTs); // 事件仍要掛回原 thread
        log.info({ group: group.id, taskId }, '任務上一輪已完成，跳過重跑（仍列入 PR 的涵蓋任務）');
        ledger.logEvent('task', t.id, 'skipped_already_done', `群組 ${group.id} 重新派工`);
        continue;
      }

      ran += 1;
      // 任務卡是 thread root：沒有它，之後所有事件與入站回覆都沒有 thread 可掛（§8）
      const threadTs = await this.ensureTaskThread(t, detail);
      // 包一層「現在在做什麼」：一個任務可能跑幾十分鐘，期間任務狀態只在
      // in_progress／verifying 之間跳，看不出它到底在寫程式、跑測試、還是在被審。
      const outcome = await withActivity(
        ledger,
        { id: `task:${t.id}`, kind: 'code', repo: group.repo, refId: t.id, title: `${t.id}　${t.title}`, detail: '準備中' },
        (update) =>
          worker.runTask({
            task: detail, cwd: wtPath, verifierConfig: proj.verifierConfig, threadTs, groupId: group.id,
              ...(signal ? { signal } : {}),
            // 給介面判斷者的比較基準：它要靠這個查出「這次改了什麼」，
            // 才不會把整個頁面的既有毛病都算到這次頭上
            baseRef: `${proj.remote ?? 'origin'}/${proj.baseBranch}`,
            // 規劃階段查出來的線索。它讀完整個 repo 才得出這個判斷（實測 13 分鐘），
            // 先前只寫 log 就丟掉，agent 在新 worktree 從零再讀一次同一批檔案
            planHint: { rationale: group.rationale, files: group.footprint },
            onPhase: update,
          }),
      );
      if (outcome.status !== 'done') {
        return this.handleUnfinished(group, taskId, outcome);
      }
      await this.pr.commitAll(wtPath, `feat(${t.id}): ${t.title}`);
    }

    if (details.length === 0) {
      log.error({ group: group.id }, '群內找不到任何任務（ledger 不一致）');
      ledger.updateGroupState(group.id, 'failed');
      return { ok: false, keep: true, reason: '群內找不到任何任務' };
    }

    // 群內任務都已完成、卻帶著審查意見回來 → 意見還沒有人處理。
    // 這時沒有任何 Worker 會跑，必須自己驅動一輪修正（見 reworkDoneTasks 的說明）。
    if (ran === 0 && reworkGate) {
      const parked = await this.reworkDoneTasks(group, proj, wtPath, details, agent, reworkGate);
      if (parked) return parked;
    }

    // ── 從這裡到合併為止，同一個 repo 一次只能有一群在跑 ──
    //
    // Merge Guard 的意義是「rebase 到**最新的 base** 上重跑完整驗證」，而那個保證只有在
    // 「驗的 base ＝ 合併落地的 base」時才成立。中間只要有別的群先合併進去，最終落地的
    // 組合就沒有人驗過——語意飄移正是從這個縫隙溜過去的（文字衝突 GitHub 自己會擋，
    // 「我依賴的函式被別人改掉了」不會）。而且它壞掉的方式特別難查：下一群的守衛會撞到
    // 紅燈，但帳會算到**下一群**頭上，無辜的那群被退回重做，真兇已經在 base 裡了。
    //
    // 為什麼不是「合併前發現 base 變了就重跑」：那會退化成 O(N²)——三群同時完成，
    // G1 合併後 G2、G3 都要重跑，G2 合併後 G3 又要再跑一次，而守衛是整套裡最貴的操作。
    // 序列化則是每群剛好跑一次，且每次驗的都是它真正會落地的 base。
    //
    // 鍵是 repo：**不同專案完全並行**，只有同一個 repo 的群互相排隊。
    // 代價是同 repo 的守衛不再並行——但那本來就不該並行（三份 build+test+瀏覽器
    // 同時跑在一台機器上，本身就是互相拖慢與搶埠的來源）。
    return withRepoLock(proj.repoPath, async (): Promise<RunOutcome> => {
      // Merge Guard（本地 rebase + 重測 + 語意飄移）
      ledger.updateGroupState(group.id, 'merge_guard');
      // 但書載體：沒 fetch 到最新 base 的綠燈是「有但書的綠燈」（§9 前置），
      // 這件事必須被看見——寫進 ledger event、通知，並列進 PR 的「假設與待確認」。
      const caveats: string[] = [];
      const guardOptions: MergeGuardOptions = {
        ...(proj.remote ? { remote: proj.remote } : {}),
        ...(this.deps.driftJudge ? { driftJudge: this.deps.driftJudge } : {}),
        onBaseFreshness: (f: BaseFreshness) => {
          if (!f.caveat) return;
          caveats.push(f.caveat);
          ledger.logEvent('group', group.id, 'merge_guard_caveat', f.caveat);
          log.warn({ group: group.id, ref: f.ref, caveat: f.caveat }, 'Merge Guard 的 base 新鮮度有但書');
          this.notify(details, { type: 'problem', detail: `⚠ 合併守衛有但書：${f.caveat}` });
        },
      };
      const guard = this.deps.makeMergeGuard?.(this.deps.makeVerifier(), guardOptions) ?? new MergeGuard(this.deps.makeVerifier(), log, guardOptions);
      const verdict = await guard.attempt({
        repoPath: wtPath,
        branch: group.branch,
        base: proj.baseBranch,
        verifierConfig: proj.verifierConfig,
        // 給語意飄移判斷當背景：它要知道本群「想做什麼」才判斷得出意圖有沒有打架
        taskTitles: details.map((d) => d.title),
        // 重跑 DoD 時的任務資訊。用 taskHintOf 一次組好，不要自己拼欄位。
        ...(details[0] ? { task: taskHintOf(details[0], proj) } : {}),
      });
      if (!verdict.ok) {
        log.warn({ group: group.id, reason: verdict.reason }, 'Merge Guard 擋下');
        ledger.logEvent('group', group.id, 'merge_guard_blocked', `${verdict.reason}: ${stripAnsi(verdict.detail ?? '')}`);

        // 把判決**交回 agent 修**，而不是宣告失敗。
        //
        // rebase 衝突與「rebase 後測試紅」都是 agent 看得懂、也修得動的問題：它需要的是
        // 完整事實（哪些檔案衝突、衝突長什麼樣、哪個關卡紅了），不是一個 failed 標記。
        // 系統本來就有這條回灌迴圈（DoD 紅燈、reviewer 退回都走它），只是這裡沒接上——
        // 於是實跑時兩個任務改到同一個檔案，後完成的那個整組報銷，17 分鐘的成果直接丟掉。
        //
        // 重試次數由 orchestrator 的 requeue 預算控管，用完會交給人，不會無限重跑。
        const save = this.deps.feedback?.save?.bind(this.deps.feedback);
        if (save) {
          save({ groupId: group.id, comments: [mergeGuardFeedback(verdict, caveats)], source: 'merge_guard' });
          ledger.updateGroupState(group.id, PARKED_GROUP_STATE);
          this.notify(details, { type: 'problem', detail: `Merge Guard 擋下（${verdict.reason}）→ 帶著原因交回 agent 修` });
          this.cards(details, 'reworking', group.id);
          // 成果都已 commit 在分支上，worktree 重做時會重建，不必保留現場
          return { ok: false, keep: false, reason: `Merge Guard 擋下（${verdict.reason}）→ 交回 agent` };
        }

        // 沒有共用的意見暫存區 ⇒ 意見送不到 agent 手上。此時派回去只會讓它盲改，
        // 寧可停著等人（與 orchestrator 的 sharedFeedback 互鎖同一個理由）。
        log.warn({ group: group.id }, '沒有可寫入的審查意見暫存區 → 無法交回 agent，標為失敗等人處理');
        this.notify(details, { type: 'failed', detail: `Merge Guard 擋下（${verdict.reason}）` });
        this.cards(details, 'failed', group.id);
        ledger.updateGroupState(group.id, 'failed');
        return { ok: false, keep: true, reason: `Merge Guard 擋下（${verdict.reason}）` };
      }

      const diff = await this.readDiff(wtPath, proj.baseBranch);
      const tasks = group.taskIds.map((id) => ledger.getTask(id)).filter((t): t is Task => t !== undefined);

      // ── 這一群要不要先讓人看一眼 ──
      //
      // 開關關著＝每個 PR 都等人審，沒有什麼好判的，直接跳過（也省下一次判斷成本）。
      // 開著＝使用者已經表明「一般改動不必問我」，這時唯一還值得攔一次的，
      // 是**做錯了救不回來**的那種——而那要看得懂這個 repo 才判得出來，
      // 不是比對一組寫死的檔案路徑（見 merge-risk-judge.ts）。
      const risk = this.deps.allowLocalMerge
        ? await this.judgeMergeRisk(group, proj, wtPath, details, tasks)
        : { needsHuman: true as const, risks: [{ what: '自動合併未開啟', why: '每個 PR 都由人審查' }] };
      ledger.logEvent(
        'group', group.id,
        risk.needsHuman ? 'merge_risk_needs_human' : 'merge_risk_clear',
        risk.needsHuman ? risk.risks.map((r) => `${r.what}：${r.why}${r.evidence ? `（${r.evidence}）` : ''}`).join('\n') : risk.notes.join('\n'),
      );

      // PR 內文（敘事來自 agent 總結，機器事實由調度器補）
      const body = this.buildBody(details, recorder, diff, proj, wtPath, caveats);

      // 記在區域變數：`group` 是進入函式時的快照，updateGroupState 不會回寫它的 prNumber，
      // 後面「已開 PR 就不本地合併」的判斷若讀 group.prNumber 會永遠是 undefined（踩過）。
      // 開 PR 沒有開關：一群做完只有這一條出口，而審查是掛在 PR 上的。
      const pr = await this.pr.openPr({
        repoPath: wtPath, repo: proj.repo, branch: group.branch, base: proj.baseBranch,
        title: `${details.map((d) => d.title).join('、')}`, body, draft: true,
      });
      const openedPrNumber: number | undefined = pr.number;
      ledger.updateGroupState(group.id, 'pr_open', { prUrl: pr.url, prNumber: pr.number });
      this.notify(details, { type: 'pr_open', url: pr.url });
      this.cards(details, 'pr_open', group.id);

      if (risk.needsHuman) {
        // 等人核准：狀態停在 in_review，絕不自動合併
        const reasons = risk.risks.map((r) => `${r.what}${r.why ? `——${r.why}` : ''}${r.evidence ? `\n   證據：${r.evidence}` : ''}`);
        log.warn({ group: group.id, risks: risk.risks.map((r) => r.what) }, '合併前需人工確認');
        this.notify(details, { type: 'problem', detail: `需人工確認才能合併：${reasons.join('；')}` });
        // 核准鈕直接出現在任務卡上，人不必去頻道別處翻那張核准卡
        this.cards(details, 'awaiting_merge', group.id);
        // 文字通知只是「告知」；真正讓需求成立的是**有按鈕可按**的核准請求（見 askMergeApproval）
        this.askMergeApproval(group, details, reasons);
        this.deps.ledger.updateGroupState(group.id, 'in_review');
        return SUCCESS;
      }

      // 走到這裡＝自動合併開著、且風險判斷者沒有攔下來 → 合併那個 PR。
      //
      // 一定是合併 PR，不是本地合併：本地把分支併進 base 之後，那個 PR 的變更已經在 base 裡，
      // 但 PR 本身永遠不會被關閉或合併，成為孤兒（審查者面對一個「看起來還沒合併、實際已生效」的 PR）。
      const prNumber = openedPrNumber ?? group.prNumber;
      if (prNumber === undefined) {
        // 走不到這裡：開 PR 沒有開關，prNumber 必然存在。
        // 保留成明確的錯誤而不是靜默往下掉——真的走到了代表上面的假設壞了。
        throw new Error(`群 ${group.id} 要自動合併卻沒有 PR 編號——開 PR 是必經之路，這代表流程有洞`);
      }
      if (!this.pr.merge) {
        throw new Error(`群 ${group.id} 要自動合併卻沒有 PR 合併能力（prManager.merge 未接線）`);
      }
      // 合併前再確認一次 base 沒被動過。同 repo 的合併有鎖序列化，所以我們自己不會
      // 製造這種情況——這一項擋的是**鎖看不到的合併**：人在 GitHub 上自己按、
      // 或別的工具合併。base 變了就代表守衛驗的世界已經不存在，退回下一輪重跑。
      const moved = await this.baseMovedSince(proj, verdict.ok ? verdict.baseSha : undefined);
      if (moved) {
        log.warn({ group: group.id, ...moved }, 'base 在守衛通過後被外部動過 → 不合併，下一輪重跑守衛');
        ledger.logEvent('group', group.id, 'base_moved', `守衛驗的是 ${moved.verified}，現在是 ${moved.current}`);
        ledger.updateGroupState(group.id, PARKED_GROUP_STATE);
        return { ok: false, keep: false, reason: 'base 被外部動過，重跑守衛' };
      }

      log.info({ group: group.id, pr: prNumber }, '自動合併已開啟且無不可逆風險 → 合併該 PR');
      ledger.logEvent('group', group.id, 'auto_merge_pr', `PR #${prNumber}：自動合併（無不可逆風險）`);
      const merged = await this.mergeOpenPr(group, proj, prNumber, details);
      return merged ? SUCCESS : { ok: false, keep: true, reason: `自動合併 PR #${prNumber} 未成功` };
    });
  }

  /**
   * base 在守衛通過之後有沒有被動過。
   *
   * 回 undefined＝沒動（或無從得知，例如沒有 remote 的本地 repo——那種情況
   * 本來就沒有「別人也在合併」的可能，不必攔）。
   */
  private async baseMovedSince(
    proj: ProjectRuntime,
    verifiedSha: string | undefined,
  ): Promise<{ verified: string; current: string } | undefined> {
    if (!verifiedSha) return undefined;
    const ref = `${proj.remote ?? 'origin'}/${proj.baseBranch}`;
    const fetched = await withFetchLock(proj.repoPath, () =>
      this.git(proj.repoPath, ['fetch', '--quiet', proj.remote ?? 'origin', proj.baseBranch]));
    if (fetched.exitCode !== 0) return undefined; // 取不到最新狀態就不亂擋（守衛自己已標但書）
    const now = (await this.git(proj.repoPath, ['rev-parse', ref])).stdout.trim();
    if (!now || now === verifiedSha) return undefined;
    return { verified: verifiedSha.slice(0, 8), current: now.slice(0, 8) };
  }

  /**
   * 「這個改動要是做錯了，救得回來嗎？」
   *
   * 沒接判斷者就一律當成要問人：**無法確認安全 ≠ 確認安全**。
   * 這跟視覺關卡沒接判斷者就是紅燈是同一條原則。
   */
  private async judgeMergeRisk(
    group: Group,
    proj: ProjectRuntime,
    wtPath: string,
    details: TaskDetail[],
    tasks: Task[],
  ): Promise<MergeRiskVerdict> {
    const judge = this.deps.mergeRiskJudge;
    if (!judge) {
      return {
        needsHuman: true,
        risks: [{ what: '沒有接上合併風險判斷者', why: '自動合併開著但沒有人判斷這個改動可不可逆，不能就這樣合併下去' }],
      };
    }
    const descriptions = tasks.map((t) => t.description).filter((d): d is string => typeof d === 'string' && d.trim() !== '');
    return judge.judge({
      cwd: wtPath,
      baseRef: `${proj.remote ?? 'origin'}/${proj.baseBranch}`,
      taskTitles: details.map((d) => d.title),
      ...(descriptions.length ? { taskDescriptions: descriptions } : {}),
    });
  }

  /**
   * 任務沒做完時決定群組的去向。核心原則：**能恢復的絕不標 failed**——
   * failed 是終態，沒有任何路徑會再派工，等於任務永久遺失（那才是最糟的結果）。
   */
  private handleUnfinished(group: Group, taskId: string, outcome: TaskOutcome): RunOutcome {
    const { ledger, log } = this.deps;

    // 依賴未完成：不是失敗，是「還沒輪到」。
    if (outcome.status === 'blocked' && outcome.reason === 'deps') {
      return this.parkForDeps(group, taskId, outcome.detail ?? '依賴未完成');
    }

    // park：等人回答澄清 / 等人解除（needs_human）。標成可恢復狀態並保留 worktree，
    // 人回覆後由 orchestrator 依 shouldRequeueGroup 轉回 ready 續做（見上方契約）。
    if (outcome.status === 'parked' || outcome.status === 'blocked') {
      const why = outcome.status === 'parked' ? outcome.clarification.question : (outcome.detail ?? outcome.reason);
      log.warn({ group: group.id, taskId, status: outcome.status }, '任務等待人工輸入，群組 park（可恢復）');
      ledger.logEvent('group', group.id, GROUP_PARKED_EVENT, `${taskId}: ${why}`);
      ledger.updateGroupState(group.id, PARKED_GROUP_STATE);
      return { ok: false, keep: true, reason: '任務等待人工輸入（保留未提交的工作）' };
    }

    const why = outcome.status === 'error' ? outcome.detail : outcome.status;
    log.warn({ taskId, status: outcome.status }, '任務未完成，群組中止');
    ledger.logEvent('group', group.id, 'group_failed', `${taskId}: ${why}`);
    ledger.updateGroupState(group.id, 'failed');
    return { ok: false, keep: true, reason: `任務 ${taskId} 失敗` };
  }

  /**
   * 依賴未完成 → park 等上游（**不是** failed，也**不再**直接寫回 ready）。
   *
   * 為什麼不能直接寫 ready（實跑量到的緊迴圈）：ready 是 Dispatcher 的唯一輸入，
   * 自己寫回去等於繞過 orchestrator 的統一 requeue 通道 —— 計數（maxRequeuePerGroup）
   * 與退避都套不上去。實測結果是每一輪都完整重跑
   * 「worktree add → 複製整包 node_modules → 認領被拒 → worktree remove」，
   * 預設 30 秒一輪＝每天 2880 次，而且永遠不會停。
   * 改成 park 在可恢復狀態並留下 GROUP_DEPS_BLOCKED_EVENT，由 orchestrator 依事件
   * 套指數退避後才把它送回 ready（見 orchestrator 的 requeue 階段）。
   *
   * **保留 worktree**：認領被擋時 agent 確實還沒動過工作區，但保留的目的不是保成果，
   * 而是讓下一次重派可以直接沿用（WorktreeManager.create 是冪等的），
   * 省掉每次重派的 worktree add ＋ node_modules 複製 —— 受阻期間的成本因此趨近於零。
   */
  private parkForDeps(group: Group, taskId: string, why: string): RunOutcome {
    const { ledger, log } = this.deps;
    log.info({ group: group.id, taskId }, '任務依賴未完成，群組 park 等上游（由 orchestrator 退避後重派）');
    ledger.logEvent('group', group.id, GROUP_DEPS_BLOCKED_EVENT, `${taskId}: ${why}`);
    ledger.updateGroupState(group.id, PARKED_GROUP_STATE);
    return { ok: false, keep: true, reason: '依賴未完成，等上游完成後由 orchestrator 重派（保留 worktree 以免每輪重建）' };
  }

  /**
   * 「群內任務都已 done、但有審查意見要處理」的重做迴圈。
   *
   * 為什麼不能走 Worker：Worker 的第一步是 `start_task`、最後一步是 `complete_task`，
   * 而這些任務在 MCP 上已經是 done——再呼叫一次會被拒絕，也會污染任務板（D2/D4）。
   * 所以這裡只驅動「agent → DoD → 回灌」這一段，**完全不碰 MCP**：修正的是同一條群組分支，
   * 任務本身的完成狀態不變（它們確實已經完成過）。
   *
   * 回 undefined = 修好了，繼續走 Merge Guard；回 RunOutcome = 已 park 交人（可恢復、保留 worktree）。
   */
  private async reworkDoneTasks(
    group: Group,
    proj: ProjectRuntime,
    wtPath: string,
    details: TaskDetail[],
    agent: AgentLike,
    gate: GateReport,
  ): Promise<RunOutcome | undefined> {
    const { ledger, log } = this.deps;
    const max = Math.max(1, this.deps.reworkRounds ?? DEFAULT_REWORK_ROUNDS);
    const task = reworkTaskOf(group, details);
    const verifier = this.deps.makeVerifier();

    // 規格仍要在手上：修意見時同樣不能違反 docRefs。取不到就繼續（降級，不擋修正）
    let docs: Awaited<ReturnType<McpTaskClient['loadDocs']>> = [];
    try {
      if (task.docRefs.length > 0) docs = await proj.mcp.loadDocs(task.docRefs);
    } catch (e) {
      log.warn({ group: group.id, err: e instanceof Error ? e.message : String(e) }, '重做時載入 docRefs 失敗（略過規格，照常修正）');
    }

    // agent 有 git commit 權限，重做時它常常自己就 commit 了。此時 commitAll 沒東西可 staged
    // 會回 false——若只看那個回傳值，會把「已經照做並自行提交」誤判成「意見沒被處理」而 park。
    // 所以另外記下重做開始時的 HEAD，用「分支有沒有往前」當作真正的判準。
    const headBefore = await gitHeadRef(wtPath).catch(() => undefined);

    // **續接同一個 session。**
    //
    // 先前這裡是 undefined 起手，也就是每次被 reviewer／Merge Guard 打回來重做，
    // agent 都是用**全新對話**在修。審查意見會透過 feedback 進提示詞，所以它知道
    // 「要修什麼」，但不知道自己上一輪為什麼那樣寫、試過哪些方向、哪條路已經撞牆。
    // 等於每次被退回都重新認識這個任務一次。
    //
    // 能力本來就有：agent_sessions 存了 session_id，iterate 吃 resumeSessionId，
    // 連 session 過期的降級路徑都寫好了（開新的，不讓整輪報銷）。只是沒去撈。
    let session: string | undefined = this.deps.ledger.latestAgentSession(task.id)?.sessionId;
    let feedback: GateReport | undefined = gate;
    let committedAny = false;

    for (let round = 1; round <= max; round += 1) {
      log.info({ group: group.id, round, max }, '依審查意見重做');
      const r = await agent.iterate({
        cwd: wtPath,
        task,
        docs,
        ...(feedback ? { feedback } : {}),
        ...(session ? { resumeSessionId: session } : {}),
      });
      session = r.sessionId ?? session;

      if (r.askedClarification) {
        return this.parkGroup(group, details, `重做時提出不可逆歧義，等人回覆：${r.askedClarification.question}`);
      }
      if (r.reportedNoChange) {
        // agent 認為審查意見不需要改動。這是「人的意見」與「agent 的判斷」衝突，必須交人裁決
        return this.parkGroup(group, details, `agent 判定審查意見無需改動（${r.reportedNoChange.category}）：${r.reportedNoChange.reason}`);
      }
      if (r.isError) {
        // 執行錯誤（API/SDK）不算一次有效嘗試，但仍佔用輪數上限 → 不會變成無節制的熱迴圈
        log.warn({ group: group.id, round }, '重做時 agent 執行錯誤，續下一輪');
        continue;
      }

      // **任務資訊要完整。** 只傳 id/category 的話，介面判斷者拿不到 baseRef → 沒有唯讀 git
      // → 分不出「這次弄的」與「本來就有的」；也拿不到標題／描述，判斷不了畫面有沒有達成目的。
      // 這是第三個漏傳的呼叫點（前兩個是 group-runner 的 Merge Guard 與 orchestrator 的合併路徑）。
      const report = await verifier.check({ cwd: wtPath, config: proj.verifierConfig, task: taskHintOf(task, proj) });
      if (!report.green) {
        feedback = report; // 具體失敗回灌下一輪
        continue;
      }

      // DoD 綠燈：把修正提交進群組分支。
      // 一行都沒改卻「綠燈」是必然的（上一輪本來就綠），那代表意見根本沒被處理 → 交人，不可當成修好了。
      committedAny = (await this.pr.commitAll(wtPath, `fix(${group.id}): 依審查意見修正`)) || committedAny;
      const headNow = await gitHeadRef(wtPath).catch(() => undefined);
      if (!reworkProducedChanges(committedAny, headBefore, headNow)) {
        return this.parkGroup(group, details, '重做後沒有產生任何變更：審查意見並未被實際處理');
      }
      ledger.logEvent('group', group.id, 'rework_done', `第 ${round} 輪通過 DoD`);
      log.info({ group: group.id, round }, '審查意見已處理完並通過 DoD');
      return undefined;
    }

    return this.parkGroup(group, details, `依審查意見重做 ${max} 輪仍未通過 DoD，交人處理（成果與 worktree 都保留）`);
  }

  /** 把群組 park 在可恢復狀態並通知（保留 worktree，成果不丟）。 */
  private parkGroup(group: Group, details: TaskDetail[], why: string): RunOutcome {
    const { ledger, log } = this.deps;
    log.warn({ group: group.id }, `群組 park：${why}`);
    ledger.logEvent('group', group.id, GROUP_PARKED_EVENT, why);
    ledger.updateGroupState(group.id, PARKED_GROUP_STATE);
    this.notify(details, { type: 'problem', detail: `需要人工處理：${why}` });
    this.cards(details, 'awaiting_human', group.id);
    return { ok: false, keep: true, reason: why };
  }

  /**
   * 貼任務卡取得 thread_ts 並寫回 ledger（§8：一任務一 thread）。
   * 全程優雅降級：notifier 沒有這個能力、貼卡失敗、ledger 寫入失敗，都只記 log，不擋任務。
   */
  private async ensureTaskThread(task: Task, detail: TaskDetail): Promise<string | undefined> {
    const { ledger, log, notifier } = this.deps;
    if (task.slackThreadTs) {
      this.threads.set(task.id, task.slackThreadTs);
      return task.slackThreadTs;
    }
    if (!canPostTaskCard(notifier)) return undefined;

    try {
      const ts = await notifier.postTaskCard({
        id: detail.id,
        title: detail.title,
        repo: detail.repo,
        category: String(detail.category),
        description: detail.description,
        docRefs: detail.docRefs,
        dependencies: detail.dependencies,
      });
      if (!ts) return undefined;
      this.threads.set(task.id, ts);
      // 寫回 ledger：thread_ts↔task 的映射是入站（澄清答覆/控制指令）唯一的反查依據
      ledger.updateTaskState(task.id, task.state, { slackThreadTs: ts });
      ledger.logEvent('task', task.id, 'slack_thread', ts);
      return ts;
    } catch (e) {
      log.warn({ taskId: task.id, err: e instanceof Error ? e.message : String(e) }, '貼任務卡失敗（忽略，任務照跑）');
      return undefined;
    }
  }

  /**
   * 本地合併 + 合併後檢查 + 紅燈自動 revert（DESIGN §9c）。
   * 合併發生在主 clone（base 分支所在處），不是群組 worktree——worktree 已被群組分支佔用。
   * 主 clone 同時是**使用者天天在用的工作區**，所以整段都在互斥鎖內，且以「保住使用者資料」為最高優先。
   */
  /**
   * 政策放行時直接合併那個 PR。
   *
   * 與 mergeAndVerify（本地合併）的差別：這裡是「合併 GitHub 上已存在的 PR」，
   * 所以不會產生孤兒 PR，也不必自己動 base 分支。
   * approvedBy 明確標成政策來源——合併永遠要說得出是誰批准的。
   */
  private async mergeOpenPr(
    group: Group,
    proj: ProjectRuntime,
    prNumber: number,
    details: TaskDetail[],
  ): Promise<boolean> {
    const { ledger, log } = this.deps;
    const res = await this.pr.merge!({
      repo: group.repo,
      prNumber,
      approvedBy: 'policy:auto_merge',
      deleteBranch: true,
      cwd: proj.repoPath,
    });
    if (!res.ok) {
      log.error({ group: group.id, pr: prNumber, detail: res.detail }, '政策自動合併 PR 失敗');
      ledger.logEvent('group', group.id, 'merge_failed', res.detail);
      this.notify(details, { type: 'failed', detail: `自動合併 PR #${prNumber} 失敗：${res.detail}` });
      return false;
    }
    ledger.updateGroupState(group.id, 'merged');
    ledger.logEvent('group', group.id, 'merged', `PR #${prNumber}（政策自動合併）`);
    this.notify(details, { type: 'merged' });
    this.cards(details, 'merged', group.id);
    log.info({ group: group.id, pr: prNumber }, '🔀 PR 已自動合併（政策放行）');
    return true;
  }

  /** 組 PR 內文：敘事取自 agent 總結，取不到時退回任務標題（絕不讓內文變空）。 */
  private buildBody(
    details: TaskDetail[],
    recorder: SummaryRecorder,
    diff: PolicyInput,
    proj: ProjectRuntime,
    wtPath: string,
    caveats: string[] = [],
  ): string {
    const summaries: AgentSummary[] = details.flatMap((d) => {
      const text = recorder.get(d.id);
      return text ? [{ taskId: d.id, title: d.title, text }] : [];
    });
    const { narrative, assumptions } = narrativeFromSummaries(summaries);
    if (summaries.length === 0) {
      this.deps.log.debug('沒有任何 agent 總結，PR 敘事段落將標「（待補）」');
    }

    // 截圖：只有真正能被 GitHub 取得的 URL 才當圖片嵌入；本機路徑改列成文字清單。
    // 嵌入 `![](/Users/...)` 在 GitHub 上是**壞掉的圖片**，會讓審查者以為截圖遺失
    // （真正上傳到 GitHub 需要另外的機制，不在本次範圍）。
    const shots = this.collectScreenshots(details, proj, wtPath);
    const remote = shots.filter(isRemoteUrl);
    const local = shots.filter((s) => !isRemoteUrl(s));
    const ui = [narrative.ui, localScreenshotNote(local)].filter((s): s is string => Boolean(s?.trim())).join('\n\n');

    return generatePrBody({
      tasks: details,
      // 有沒有 agent 總結決定「缺席的敘事段」怎麼呈現：有總結 → 缺席代表不適用（省略）；
      // 沒總結 → 下面的 what 只是用任務標題補的，其餘段落是真的沒寫，要留（待補）
      agentSummarized: summaries.length > 0,
      narrative: {
        ...narrative,
        what: narrative.what ?? details.map((d) => d.title).join('、'),
        ...(ui ? { ui } : {}),
      },
      diff: { files: diff.files, additions: diff.additions, deletions: diff.deletions },
      verification: [
        { name: '每任務 DoD 全綠', ok: true },
        {
          name: caveats.length
            ? `Merge Guard（rebase 後重測）— ⚠ 有但書：${caveats.join('；')}`
            : 'Merge Guard（rebase 後重測）',
          ok: true,
        },
      ],
      // 但書＝「這個綠燈成立的前提」，放進「假設與待確認」讓審查者一定看得到
      assumptions: [...assumptions, ...caveats.map((c) => `⚠ ${c}`)],
      ...(remote.length ? { screenshots: remote } : {}),
    });
  }

  /** 收集群內所有任務的截圖（去重、限量）。取不到就當沒有，絕不擋開 PR。 */
  private collectScreenshots(details: TaskDetail[], proj: ProjectRuntime, wtPath: string): string[] {
    const read = this.deps.screenshotsFor ?? defaultScreenshotsFor;
    const all: string[] = [];
    for (const d of details) {
      try {
        all.push(...read({ taskId: d.id, cwd: wtPath, config: proj.verifierConfig }));
      } catch (e) {
        this.deps.log.warn({ taskId: d.id, err: e instanceof Error ? e.message : String(e) }, '讀取截圖失敗（PR 內文略過截圖）');
      }
    }
    const unique = [...new Set(all)];
    if (unique.length > MAX_PR_SCREENSHOTS) {
      this.deps.log.info({ total: unique.length, kept: MAX_PR_SCREENSHOTS }, '截圖過多，PR 內文只嵌入前幾張');
    }
    return unique.slice(0, MAX_PR_SCREENSHOTS);
  }

  private async readDiff(wtPath: string, base: string): Promise<PolicyInput> {
    const read = this.deps.readDiff ?? readDiffStat;
    try {
      return await read(wtPath, base);
    } catch (e) {
      // 取不到 diff 不該讓群組崩掉：回空 → 政策保守判定為「不自動合併」
      this.deps.log.warn({ err: e instanceof Error ? e.message : String(e) }, '讀取 diff 失敗，政策改走保守路徑');
      return { files: [], deleted: [], additions: 0, deletions: 0 };
    }
  }

  private fail(group: Group, details: TaskDetail[], detail: string): void {
    this.notify(details, { type: 'failed', detail });
    this.deps.ledger.updateGroupState(group.id, 'failed');
  }

  /**
   * 政策判定 needs_human → **真的去問人**（Slack 核准按鈕），而不只是貼一則文字事件。
   *
   * 兩邊怎麼接起來：人按下核准 → gateway.onMergeDecision → Orchestrator.onMergeDecision
   * 記下核准憑證（D17）＋ InboundRouter 把群組推進 merge_guard → Orchestrator 的合併佇列
   * 重跑守衛與政策後合併。少了這一步，憑證永遠不會產生，群組會停在 in_review 等一個
   * 沒有人按得下去的按鈕。
   *
   * 降級（D19：這是環境缺件，不是執行期錯誤）：notifier 沒有這個能力（例如 ConsoleNotifier）
   * → 只留文字通知與 ledger 事件，不擋流程；發送失敗同樣只記 log。
   */
  private askMergeApproval(group: Group, details: TaskDetail[], reasons: string[]): void {
    const { ledger, log, notifier } = this.deps;
    ledger.logEvent('group', group.id, 'merge_needs_human', reasons.join('\n'));
    if (!canAskMergeApproval(notifier)) {
      log.warn(
        { group: group.id },
        'notifier 不支援合併核准請求（askMergeApproval），已降級為純文字通知：人必須自行到 Slack／CLI 核准',
      );
      return;
    }
    // prUrl 在 pr_open 時才寫進 ledger，要用最新的那份（傳進來的 group 是派工當下的快照）
    const prUrl = ledger.getGroup(group.id)?.prUrl ?? group.prUrl;
    const threadTs = details[0] ? this.threads.get(details[0].id) : undefined;
    void Promise.resolve(
      notifier.askMergeApproval(threadTs, {
        groupId: group.id,
        branch: group.branch,
        repo: group.repo,
        taskTitles: details.map((d) => d.title),
        ...(prUrl ? { prUrl } : {}),
        reasons,
      }),
    ).catch((e) =>
      log.warn({ group: group.id, err: e instanceof Error ? e.message : String(e) }, '發送合併核准請求失敗（忽略，不影響群組流程）'),
    );
  }

  /** 以群內第一個任務當通知載體（一任務一 thread；群層事件掛在首個任務的 thread）。 */
  /**
   * 更新群內每張任務卡的狀態。
   *
   * 沒有這一步，卡片會永遠停在剛貼出去的樣子——人看不出任務做完沒、在等什麼。
   * 失敗一律吞掉：卡片更新是介面問題，不該影響群組流程。
   */
  private cards(details: TaskDetail[], status: TaskCardStatus, groupId?: string): void {
    const update = this.deps.notifier.updateTaskCard;
    if (!update) return;
    for (const d of details) {
      void Promise.resolve(update.call(this.deps.notifier, d.id, status, groupId ? { groupId } : {})).catch((e) =>
        this.deps.log.warn({ taskId: d.id, err: e instanceof Error ? e.message : String(e) }, '任務卡更新失敗（忽略）'),
      );
    }
  }

  private notify(details: TaskDetail[], event: Parameters<Notifier['event']>[1]): void {
    const head = details[0];
    if (!head) return;
    const threadTs = this.threads.get(head.id);
    void Promise.resolve(this.deps.notifier.event(threadTs, event, head)).catch((e) =>
      this.deps.log.warn({ err: e instanceof Error ? e.message : String(e) }, '通知失敗（忽略，不影響群組流程）'),
    );
    // 事件寫進 thread 的同時，卡片一定要跟著反映當下狀態。
    // 逐點手動接線漏過十二個地方（連 merged 都漏了），所以改成一律從 ledger 推導。
    this.syncCards(details);
  }

  /**
   * 依 ledger 的真實狀態同步整群的卡片。狀態沒變時 gateway 端會自行跳過。
   *
   * **整段包在 try 裡**：這是介面更新，任何失敗都不該讓群組流程受影響。
   * 沒包的話（實際犯過）ledger 查詢一擲錯就會冒到 runGroup 的外層 catch，
   * 群組直接被標成 failed——因為畫個卡片失敗而讓一整群的工作報銷。
   */
  private syncCards(details: TaskDetail[]): void {
    try {
      this.syncCardsUnsafe(details);
    } catch (e) {
      this.deps.log.warn({ err: e instanceof Error ? e.message : String(e) }, '任務卡同步失敗（忽略）');
    }
  }

  private syncCardsUnsafe(details: TaskDetail[]): void {
    for (const d of details) {
      syncTaskCard(this.deps.ledger, this.deps.notifier, d.id, (e) =>
        this.deps.log.warn({ taskId: d.id, err: e instanceof Error ? e.message : String(e) }, '任務卡更新失敗（忽略）'),
      );
    }
  }

  /** 成功即清 worktree（避免無限累積）；需要保留現場時說明原因。 */
  private async cleanupAfterRun(repoPath: string, wtPath: string, outcome: RunOutcome): Promise<void> {
    const { log } = this.deps;
    if (this.deps.keepWorktree) {
      log.info({ wtPath }, 'keepWorktree=true，保留 worktree（除錯模式）');
      return;
    }
    if (outcome.keep) {
      log.warn({ wtPath, reason: outcome.reason || '執行中擲出例外' }, '保留 worktree 供診斷（失敗現場）');
      return;
    }
    try {
      await this.wm.remove(repoPath, wtPath);
    } catch (e) {
      // 清不掉只是會殘留目錄，reconciler 之後會掃孤兒；不該讓群組結果變失敗
      log.warn({ wtPath, err: e instanceof Error ? e.message : String(e) }, 'worktree 清理失敗（交給 reconciler 掃孤兒）');
    }
  }

  /** 供 dispatcher / 外部診斷使用的手動清理。 */
  async cleanupWorktree(repoPath: string, wtPath: string): Promise<void> {
    await this.wm.remove(repoPath, wtPath);
  }
}

function tail(s: string, n = 10): string {
  return s.split('\n').slice(-n).join('\n').trim();
}

/** 只有 http(s) 才可能被 GitHub 取得並 render 成圖片。 */
function isRemoteUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** 本機截圖的文字區塊：明講「在本機」，不假裝是可顯示的圖片。 */
function localScreenshotNote(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined;
  return [
    `📸 已產生 ${paths.length} 張截圖，但它們在**調度器本機**，GitHub 無法顯示；請到下列路徑檢視：`,
    ...paths.map((p) => `- \`${p}\``),
  ].join('\n');
}

/**
 * rework 用的合成任務：把整群的任務併成一份「要修什麼」的描述。
 *
 * 刻意沿用群內第一個任務的 id：agent 總結因此仍會被 SummaryRecorder 記在該任務底下
 * （PR 敘事拿得到最新內容），ledger 事件也掛得回既有的任務／Slack thread。
 */
function reworkTaskOf(group: Group, details: TaskDetail[]): TaskDetail {
  const head = details[0]!;
  return {
    id: head.id,
    title: `依審查意見修正：${details.map((d) => d.title).join('、')}`,
    status: 'in_progress',
    repo: head.repo,
    category: head.category,
    description: [
      `這個群組（分支 ${group.branch}）的任務都已完成，但審查後被要求修改。`,
      '請依下方回灌的意見修正**既有實作**（不要重做已完成的功能），改完要能通過原本的 DoD。',
      '',
      '涵蓋任務：',
      ...details.map((d) => `- [${d.id}] ${d.title}：${d.description}`),
    ].join('\n'),
    dependencies: [],
    docRefs: [...new Set(details.flatMap((d) => d.docRefs))],
  };
}

/**
 * 重做這一輪有沒有真的產生變更。
 *
 * 不能只看 `commitAll` 的回傳值：agent 有 git commit 權限，重做時常常自己就 commit 了，
 * 此時 commitAll 沒東西可 staged 會回 false。實跑撞到——使用者寫「要有確認按鈕」，
 * agent 確實加了 ConfirmDialog 並自行 commit，系統卻回報「審查意見並未被實際處理」
 * 而 park，PR 也沒更新。人的意見明明被執行了，卻被判成沒做事（D18：誤判比漏抓更糟）。
 *
 * 量不到 HEAD（git 指令失敗）時退回只看 commitAll：寧可少擋一次，也不要因為量不到而誤殺。
 */
export function reworkProducedChanges(
  committedAny: boolean,
  headBefore: string | undefined,
  headNow: string | undefined,
): boolean {
  if (committedAny) return true;
  if (headBefore === undefined || headNow === undefined) return false;
  return headNow !== headBefore;
}
