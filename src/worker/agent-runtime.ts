import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { DOCS_TOOLS, createDocsServer, type DocsSource } from './docs-server.js';
import { z } from 'zod';
import type { Logger } from '../observability/logger.js';
import type { GateReport, TaskDetail } from '../types.js';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { workingTreeChanged } from '../git/status.js';
import {
  createFrictionHandler,
  FRICTION_KINDS,
  FRICTION_TOOL_DESCRIPTION,
  type FrictionSink,
} from './friction.js';

/** 沒接 sink 時的去處：什麼都不做，但不讓呼叫端崩掉。 */
const NOOP_SINK: FrictionSink = { logEvent: () => {} };
import { matchGlob } from '../policy/policy-engine.js';

export interface LoadedDoc {
  ref: string; // "path#section"
  content: string;
}

export interface IterateInput {
  cwd: string;
  task: TaskDetail;
  docs: LoadedDoc[];
  feedback?: GateReport; // 上一輪 DoD 失敗細節（回灌）
  resumeSessionId?: string; // 續接同一 session
  /**
   * 中止訊號。daemon 收到 SIGTERM 時一路傳到這裡，讓 SDK 停止查詢並收掉子行程。
   *
   * 沒有它的後果實跑過：`stop` 之後 agent 完全不知道要停，繼續寫程式到寬限逾時，
   * 然後行程被強制結束——它用 Bash 起的 `npm run dev` 就成了孤兒，
   * 佔著 8843/8880/8888 三個埠活了一個多小時，而沒有任何地方看得到。
   */
  signal?: AbortSignal;
  answer?: { question: string; answer: string }; // 澄清答覆注入
  /**
   * 規劃階段查出來的線索（群層級，不是任務層級）。
   *
   * 規劃 agent 讀完整個 repo 才得出這些判斷（實測 13 分鐘），先前全部丟掉——
   * 寫程式的 agent 在新 worktree 從零把同一批檔案再讀一次。同一件調查付兩次錢。
   */
  planHint?: { rationale: string; files: string[] };
  /**
   * 本任務起點 sha（＝DoD diff 關卡與 reviewer 同一枚）。
   * Stop hook 用它判「這一輪到底做了沒」；未給 → 退回 porcelain，
   * 那只看得到未 commit 的東西，agent 自行 commit 後會被誤判成什麼都沒做。
   */
  baseRef?: string;
}

export interface ClarificationCapture {
  question: string;
  rationale?: string;
  options?: string[];
}

/**
 * agent 宣告「這個任務不需要任何程式碼變更」的分類。
 *
 * 為什麼需要這個出口：DoD 有「diff 非空」關卡（否則 agent 什麼都沒做也會被判完成，
 * 而 complete_task 不可逆）。但**合法的零 diff 確實存在**——功能早就做過了、任務描述與
 * 現況不符、缺外部依賴做不下去。沒有出口的話，agent 面對這種任務只會為了讓關卡變綠而
 * 亂改程式碼，那比漏抓更糟。
 */
export type NoChangeCategory =
  | 'already_satisfied' // 現況已符合需求（功能已存在／別人做過了）
  | 'not_applicable' // 任務描述與現況不符、需求矛盾，不該照做
  | 'blocked_externally' // 缺外部依賴/權限/資料，無法進行
  | 'spec_unclear'; // 規格不足以判斷要改什麼（實質等同澄清）

export interface NoChangeCapture {
  category: NoChangeCategory;
  reason: string;
  /** agent 查證過什麼（例如讀了哪些檔案、既有實作在哪）——人要靠這個判斷它有沒有誤判。 */
  evidence?: string;
}

export interface IterateResult {
  sessionId?: string;
  resultText: string;
  /** 錯誤處置分類（isError 時才有）：permanent 不該重試，capacity 要調設定。 */
  errorKind?: AgentErrorKind;
  /** SDK 錯誤語意碼與 HTTP 狀態碼（診斷/通知用）。 */
  sdkError?: SdkErrorCode;
  httpStatus?: number;
  /** SDK 內部已做的重試次數（>0 代表這輪其實撞過限流/過載）。 */
  sdkRetries?: number;
  /** 本輪用量與花費（記進 ledger 的 agent_sessions）。 */
  usage?: AgentUsage;
  askedClarification?: ClarificationCapture;
  /** agent 宣告本任務無需改動（處置由 Worker 依政策決定，見 NoChangeCategory）。 */
  reportedNoChange?: NoChangeCapture;
  isError: boolean;
}

/** 本輪從自訂工具收集到的訊號（工具處理器寫入，iterate 結束時讀出）。 */
export interface CapturedSignals {
  clar?: ClarificationCapture;
  noChange?: NoChangeCapture;
}

/**
 * 寫程式的 agent 能用的瀏覽器工具：**預設全開，只擋列在下面的**。
 *
 * 為什麼要給瀏覽器：先前 agent 做 UI 是**閉著眼睛做**——改完 CSS 只能靠 build 過了
 * 就當沒事，畫面長怎樣它看不到。有瀏覽器之後它能邊做邊看、而且**點得下去**
 * （做深色模式切換就真的按一下再看結果），這是靜態截圖給不了的。
 *
 * ── 為什麼從白名單改成黑名單 ──
 *
 * 白名單是錯的機制，因為這個角色**同一個 session 裡已經有 Bash + Write + Edit**。
 * 擋掉一個關在瀏覽器分頁裡的工具，攔不到任何一條它用 Bash 走不通的路——
 * 只攔得到它自己的 DoD 驗證。而代價是：我沒想到的能力會被默默擋下，
 * 症狀只有一行 WARN，閘門照樣綠燈。
 *
 * 這已經真的發生過兩次（實跑 log）：
 * · `browser_find` 是 Playwright 後來才加的工具，我的清單寫在那之前 → 想在畫面上
 *   找元素就被自己的閘門擋下。
 * · `browser_drag` 沒列 → 有一群的 DoD 是「圖片拖超出邊界要被夾住」，它先試
 *   `run_code_unsafe` 被擋、改用 `browser_drag` 又被擋，那條 DoD **完全無路可驗**，
 *   整群卡死。
 *
 * 黑名單則相反：Playwright 明天加新工具，預設可用。這對一個已經有 Bash 的角色
 * 是正確的預設。
 */
const DENIED_BROWSER_TOOLS = new Set([
  /**
   * 唯一擋的一個，而且理由跟「危不危險」無關，跟**它繞過哪道檢查**有關。
   *
   * 它在 Playwright server 的 **Node 行程**裡執行任意 JavaScript（官方 README 原文：
   * "executes arbitrary JavaScript in the Playwright server process and is
   * RCE-equivalent"），不是在瀏覽器分頁裡。而這個檔案的部署紅線
   * （`evaluateCommandRedline`：firebase deploy / npm run deploy / 強推 main）
   * **只掛在 Bash 上**——瀏覽器工具這條分支從來不看參數內容。
   *
   * 所以放行它 ≠ 給它一個它已經有的能力，而是 = 讓
   * `await import('node:child_process')` 成為繞過部署紅線的正門。
   * 專案的 CLAUDE.md 把那條紅線寫成「硬邊界，不是提示詞」——這個常數就是那句話的實作。
   *
   * 它實際被拿來做的三件事都有替代（實跑 log 統計）：
   * 設 viewport → `browser_resize`；帶 cookie 登入 → `browser_evaluate` 或走登入頁；
   * 精細拖曳 → `browser_drag` / `browser_drop`。
   */
  'mcp__playwright__browser_run_code_unsafe',
]);

/**
 * 交給 SDK `allowedTools` 的瀏覽器工具名單（**建議性質**）。
 *
 * 實測 SDK 的 allowedTools 對 MCP 工具不具強制力——agent 成功呼叫過沒列進去的
 * `browser_run_code_unsafe`。真正生效的是下面 `evaluateToolPolicy` 裡的
 * `DENIED_BROWSER_TOOLS` 檢查。這份存在只是為了讓 SDK 少提示一次。
 *
 * 這裡只能列舉（SDK 不吃萬用字元），所以列出目前已知的全部瀏覽器工具，
 * 扣掉黑名單。漏列的新工具**不會**被擋——強制那一層是黑名單。
 */
const BROWSER_TOOLS = [
  'mcp__playwright__browser_navigate',
  'mcp__playwright__browser_navigate_back',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_find',
  'mcp__playwright__browser_take_screenshot',
  'mcp__playwright__browser_click',
  'mcp__playwright__browser_type',
  'mcp__playwright__browser_fill_form',
  'mcp__playwright__browser_select_option',
  'mcp__playwright__browser_hover',
  'mcp__playwright__browser_press_key',
  'mcp__playwright__browser_drag',
  'mcp__playwright__browser_drop',
  'mcp__playwright__browser_resize',
  'mcp__playwright__browser_tabs',
  // 沒有它，頁面一跳 confirm()/alert() 整個 session 就永久卡在那裡，而且沒有人看得到。
  // 「可能自動確認破壞性對話框」不成立：它本來就能點頁面上任何一顆刪除按鈕。
  'mcp__playwright__browser_handle_dialog',
  'mcp__playwright__browser_file_upload',
  'mcp__playwright__browser_wait_for',
  'mcp__playwright__browser_console_messages',
  'mcp__playwright__browser_network_requests',
  // 頁面本來就能 fetch（browser_evaluate 給得出來），擋這個只是假的安全感。
  'mcp__playwright__browser_network_request',
  'mcp__playwright__browser_evaluate',
  'mcp__playwright__browser_close',
].filter((t) => !DENIED_BROWSER_TOOLS.has(t));

/**
 * 唯讀角色（介面判斷者）能用的瀏覽器工具。
 *
 * 這裡**維持白名單**，而且理由跟寫程式的 agent 相反：判斷者沒有 Bash、沒有
 * Write/Edit，這份清單是「唯讀」這兩個字唯一的實作。放行一個能碰到本機檔案的
 * 工具，那個邊界就不存在了。
 *
 * 扣掉的兩個：
 * · `run_code_unsafe` — Node 行程任意程式碼，唯讀邊界直接歸零。
 * · `file_upload`     — 由 Playwright server 讀本機檔案送出去。這個是**真的**增量：
 *                       判斷者沒有 Bash，`browser_evaluate` 也碰不到檔案系統。
 *
 * 其餘全給，包含互動類（drag/drop/handle_dialog/fill_form…）與診斷類
 * （console_messages/network_requests）——判斷者要真的操作得動畫面才判斷得出東西，
 * 而且它先前連 console 錯誤都看不到。
 */
export const READONLY_BROWSER_TOOLS = BROWSER_TOOLS.filter(
  (t) => t !== 'mcp__playwright__browser_file_upload',
);

// 允許 agent 使用的工具（allow-list）。ask_human / report_no_change 為自訂 in-process 工具。
export const ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'mcp__ask__ask_human',
  'mcp__ask__report_no_change',
  // 「這個系統擋到我了」的回報出口。不影響任務結果，純粹留紀錄——
  // 今天好幾個真 bug 是從 agent 順口說的話裡撿到的，那些不該只靠碰巧被讀到。
  'mcp__ask__report_friction',
  // 規格文件：讓 agent 自己找。程式只能照 docRef 字串比對，對不上就整份讀不到
  // （實跑：docType 單複數不一致，每個帶 issue 規格的任務都是沒看過規格就做的）。
  ...DOCS_TOOLS,
  ...BROWSER_TOOLS,
];

/**
 * 瀏覽器 MCP 的啟動設定。未指定輸出根目錄就回 undefined（＝不掛瀏覽器）——
 * 寧可沒有瀏覽器，也不要讓它把暫存檔寫進 worktree。
 *
 * 每個旗標的理由：
 * · `--output-dir`  截圖／快照／log 一律寫到 worktree 外（見 browserOutputRoot 的說明）
 * · `--output-mode stdout`  能不落地就不落地，output-dir 只是最後的去處
 * · `--isolated`    瀏覽器 profile 只留在記憶體，不在磁碟累積
 * · `--headless`    這是常駐 daemon，預設的 headed 會嘗試開視窗
 * · `--no-sandbox`  在無 GUI session 下啟動 Chromium 常因沙箱失敗
 */
export function browserServerConfig(
  outputRoot: string | undefined,
  taskId: string,
): { command: string; args: string[] } | undefined {
  if (!outputRoot?.trim()) return undefined;
  // 一任務一目錄：多個 worktree 並行時互不覆蓋，清理也好對應
  const dir = join(outputRoot, sanitizeSegment(taskId));
  mkdirSync(dir, { recursive: true });
  return {
    command: 'npx',
    args: [
      '-y',
      '@playwright/mcp@latest',
      '--headless',
      '--isolated',
      '--no-sandbox',
      '--output-mode', 'stdout',
      '--output-dir', dir,
    ],
  };
}

/** 任務 id 直接當目錄名不安全（可能含 / 或 ..）。 */
function sanitizeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'task';
}

/** 同一輪內 Stop hook 最多擋幾次（擋太多次會和外層 DoD 迴圈疊成活鎖）。 */
const MAX_STOP_BLOCKS = 2;

/**
 * 給 agent 子行程用的空 gh 設定目錄。
 *
 * 指令字串比對永遠擋不完：agent 可以先 `Write` 一個腳本再 `bash script.sh`，
 * 也可以 base64、用 python subprocess、或動態組字串——那是圖靈完備的問題，靜態掃描贏不了。
 * **真正可靠的是切斷認證**：gh 找不到登入狀態就什麼都做不了，不管它是被怎麼呼叫的。
 */
const AGENT_GH_CONFIG_DIR = join(tmpdir(), 'orch-agent-gh-empty');

/**
 * agent 子行程的環境：在繼承 process.env 的基礎上**移除 GitHub 認證**。
 *
 * SDK 的 options.env 若有設就會完全取代子行程環境，所以必須先展開 process.env
 * （PATH/HOME/ANTHROPIC_AUTH_TOKEN 等都還要留著，agent 自己得靠它們運作）。
 *
 * 這是深度防禦的最底層：就算紅線比對被繞過（先寫腳本再執行），
 * gh 也是未登入狀態、git push 也拿不到憑證，外部副作用依然發生不了。
 */
export function buildAgentEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  mkdirSync(AGENT_GH_CONFIG_DIR, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    // gh 的 token 認證：一律不傳給 agent
    if (k === 'GH_TOKEN' || k === 'GITHUB_TOKEN' || k === 'GH_ENTERPRISE_TOKEN' || k === 'GITHUB_ENTERPRISE_TOKEN') continue;
    env[k] = v;
  }
  // gh 的檔案/keyring 認證：指到空目錄 ⇒ gh 變成「未登入」
  env.GH_CONFIG_DIR = AGENT_GH_CONFIG_DIR;
  // git 認證：不要跳互動提示（非互動環境會卡住），也不要用 askpass 去要密碼
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = '/bin/false';

  // 來自設定（資料庫）的覆寫，**每次執行都重新取**：換 Claude token 或端點不必重啟 daemon。
  // 空字串視為未設，才不會用一個空 token 覆蓋掉行程環境裡本來可用的那個。
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === 'string' && v.trim() !== '') env[k] = v;
  }
  return env;
}

/** 設定 → agent 子行程的認證環境變數（留空的欄位不覆寫，沿用行程環境）。 */
export function agentAuthEnv(cfg: {
  authToken?: string;
  apiKey?: string;
  baseUrl?: string;
}): Record<string, string | undefined> {
  return {
    ANTHROPIC_AUTH_TOKEN: cfg.authToken,
    ANTHROPIC_API_KEY: cfg.apiKey,
    ANTHROPIC_BASE_URL: cfg.baseUrl,
  };
}

export interface AgentRuntimeDeps {
  /** 模型別名（opus / sonnet / haiku）。未給 → SDK 預設。 */
  model?: string;
  /**
   * 依 repo 解析任務板的文件來源（MCP 是每個專案各自的）。
   * 給了才會把 list_docs／search_docs／read_doc 掛給 agent，
   * 讓它在規格讀不到時自己去找（見 docs-server.ts）。
   */
  docs?: (repo: string) => DocsSource | undefined;
  /** 工作區是否有變更（Stop hook 判斷用）。預設 git/status，可注入假件測試。 */
  workingTreeChanged?: (cwd: string, baseRef?: string) => Promise<boolean>;
  /** 工具紅線的保護路徑覆寫（來自專案設定）。未給時用安全預設。 */
  toolPolicy?: ToolPolicyOptions;
  /**
   * agent 子行程的環境變數覆寫，**每輪執行時才呼叫**（見 buildAgentEnv）。
   * 傳函式而不是物件：Claude 的 token／端點存在資料庫，控制台改完要立刻生效，
   * 收一份快照留著就又變成「改了要重啟」。
   */
  envOverrides?: () => Record<string, string | undefined>;
  /**
   * 瀏覽器暫存輸出的根目錄（**必須在 worktree 之外**）。未給就不掛瀏覽器。
   *
   * 為什麼一定要指定：Playwright MCP 預設把截圖／快照／log 寫在「當下工作目錄」，
   * 也就是 agent 的 worktree 裡。那會被 `git add -A` 吃進 commit，污染 PR 的 diff，
   * 更糟的是讓「diff 非空」的 DoD 判定失真——光靠垃圾檔就能滿足「有做事」。
   * 這個 repo 自己已經被吃進三個 commit，不是理論風險。
   */
  browserOutputRoot?: string;
  /**
   * agent 的摩擦回報要寫到哪（Ledger 結構上即滿足）。未注入就只留 log——
   * 回報永遠不該因為缺少接線而讓任務失敗。
   */
  frictionSink?: FrictionSink;
}

/**
 * Agent SDK 串接（DESIGN.md §13）。單一「iterate」= 跑一輪 query()：
 * 帶入任務/規格/上輪失敗回饋，回傳 sessionId（供 resume）、最終文字、是否提出澄清。
 * DoD 判定不在此處——由 Worker 於 iterate 後跑 Verifier（外層監督迴圈）。
 */
export class AgentRuntime {
  constructor(private log: Logger, private deps: AgentRuntimeDeps = {}) {}

  async iterate(input: IterateInput): Promise<IterateResult> {
    const first = await this.runOnce(input);
    // resume 失敗（session 不存在／已過期）不該讓這一輪整個報銷：
    // session 是**加速用**的上下文，不是任務的必要條件。降級成全新 session 重跑一次，
    // 答覆本來就會另外注入 prompt，所以資訊不會掉。
    if (input.resumeSessionId && isResumeFailure(first)) {
      this.log.warn(
        { taskId: input.task.id, sessionId: input.resumeSessionId, sdkError: first.sdkError },
        '無法續接原 session → 改用全新 session 重跑本輪',
      );
      const { resumeSessionId: _drop, ...withoutResume } = input;
      return this.runOnce(withoutResume);
    }
    return first;
  }

  private async runOnce(input: IterateInput): Promise<IterateResult> {
    const captured: CapturedSignals = {};
    const askServer = this.buildAskServer(captured, input.task.id);
    // 有任務板連線才掛：沒有的話 agent 只能用提示詞裡程式先讀好的那份
    const docsSource = this.deps.docs?.(input.task.repo);
    const docsServer = docsSource ? createDocsServer(docsSource, this.log) : undefined;
    const browser = browserServerConfig(this.deps.browserOutputRoot, input.task.id);
    const stopState = { blocks: 0 };
    const toolsUsed = new Map<string, number>();

    // SDK 吃的是 AbortController 而不是 AbortSignal，所以把上游的 signal 接過來。
    // 已經是 aborted 就不要開始——省下一次白跑的查詢。
    const abortController = input.signal ? new AbortController() : undefined;
    if (abortController && input.signal) {
      if (input.signal.aborted) abortController.abort();
      else input.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const stream = query({
      prompt: buildAgentPrompt(input),
      options: {
        // 中止：SDK 會停止查詢並收掉它自己的子行程樹
        ...(abortController ? { abortController } : {}),
        // 模型別名（opus / sonnet / haiku）。未設 → SDK 預設。
        ...(this.deps.model ? { model: this.deps.model } : {}),
        cwd: input.cwd,
        resume: input.resumeSessionId,
        permissionMode: 'acceptEdits',
        mcpServers: {
          ask: askServer,
          ...(docsServer ? { docs: docsServer } : {}),
          ...(browser ? { playwright: browser } : {}),
        },
        allowedTools: ALLOWED_TOOLS,
        // 深度防禦：即使指令層紅線被繞過（先寫腳本再執行），agent 也拿不到 GitHub 認證
        env: buildAgentEnv(process.env, this.deps.envOverrides?.() ?? {}),
        hooks: {
          PreToolUse: [{ hooks: [this.preToolUseGuard(toolsUsed)] }],
          Stop: [{ hooks: [this.stopHook(input, captured, stopState)] }],
        },
      },
    });

    const outcome = await collectStreamOutcome(stream as AsyncIterable<unknown>);
    const { sessionId, resultText, isError } = outcome;

    // 這一輪實際用了哪些工具。**瀏覽器單獨列出**：UI 任務有沒有真的去看畫面，
    // 是判斷「它在做事還是在猜」的關鍵，而 agent 的自我宣稱不能當證據。
    if (toolsUsed.size > 0) {
      const browserCalls = [...toolsUsed.entries()]
        .filter(([n]) => n.startsWith('mcp__playwright__'))
        .reduce((sum, [, n]) => sum + n, 0);
      this.log.info(
        {
          taskId: input.task.id,
          tools: Object.fromEntries([...toolsUsed].sort((a, b) => b[1] - a[1]).slice(0, 12)),
          browserCalls,
        },
        browserCalls > 0 ? '本輪工具使用（含瀏覽器）' : '本輪工具使用（未使用瀏覽器）',
      );
    }

    // SDK 內部撞過限流/過載也要留痕：外層看到「這輪很慢」時才知道是 API 在退避，不是 agent 卡住
    if (outcome.retries?.length) {
      this.log.warn(
        { taskId: input.task.id, retries: outcome.retries.length, lastStatus: outcome.httpStatus, error: outcome.sdkError },
        'SDK 於本輪重試過 API 請求（限流/過載/伺服器錯誤）',
      );
    }
    if (isError) {
      this.log.error(
        { taskId: input.task.id, kind: outcome.errorKind, sdkError: outcome.sdkError, status: outcome.httpStatus },
        'agent 本輪以錯誤結束',
      );
    }

    if (captured.clar) this.log.info({ taskId: input.task.id }, 'agent 於本輪提出澄清');
    if (captured.noChange) {
      this.log.info(
        { taskId: input.task.id, category: captured.noChange.category },
        'agent 宣告本任務無需改動',
      );
    }
    return {
      sessionId,
      resultText,
      askedClarification: captured.clar,
      reportedNoChange: captured.noChange,
      isError,
      ...(outcome.errorKind ? { errorKind: outcome.errorKind } : {}),
      ...(outcome.sdkError ? { sdkError: outcome.sdkError } : {}),
      ...(outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {}),
      ...(outcome.retries?.length ? { sdkRetries: outcome.retries.length } : {}),
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    };
  }

  /** PreToolUse 政策閘門（紅線）：擋強制推送/危險刪除等（DESIGN.md §10）。 */
  private preToolUseGuard(used: Map<string, number>) {
    // 記下每個工具用了幾次。存在的理由：agent 會在總結裡宣稱「已通過瀏覽器驗證」，
    // 但它在**還沒有瀏覽器工具**的時候也寫過同一句話——自我宣稱不是證據。
    // 工具呼叫都會經過這個閘門，這裡是唯一能拿到事實的地方。
    return createPreToolUseGuard(this.log, this.deps.toolPolicy, (name) =>
      used.set(name, (used.get(name) ?? 0) + 1),
    );
  }

  /**
   * Stop hook（DESIGN.md §13）：攔截 agent「我做完了」的收工動作。
   * DoD 由外層調度器判（§D14），所以這裡只擋一件事——**明顯沒做事就想結束**（工作區零變更）。
   * 擋滿 MAX_STOP_BLOCKS 次就放行，讓外層 DoD 迴圈接手，避免 hook 與 agent 互推成活鎖。
   */
  private stopHook(input: IterateInput, captured: CapturedSignals, state: { blocks: number }) {
    return createStopHook({
      log: this.log,
      cwd: input.cwd,
      taskId: input.task.id,
      captured,
      state,
      maxBlocks: MAX_STOP_BLOCKS,
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      workingTreeChanged: this.deps.workingTreeChanged ?? workingTreeChanged,
    });
  }

  /**
   * agent 的兩個「出口」工具。
   * ask_human：規格有不可逆歧義時提問（M1–M3 不阻塞；M4 改為貼 Slack 等答覆）。
   * report_no_change：宣告本任務無需程式碼改動——沒有這個出口，DoD 的 diff 關卡
   * 會逼 agent 為了讓關卡變綠而亂改程式（見 NoChangeCategory 註解）。
   */
  private buildAskServer(captured: CapturedSignals, taskId: string) {
    return createSdkMcpServer({
      name: 'ask',
      version: '1.0.0',
      tools: [
        tool(
          'report_no_change',
          '當你確認這個任務「不需要任何程式碼改動」時呼叫（例如功能已存在、任務描述與現況不符、' +
            '缺外部依賴無法進行）。請務必附上查證依據。' +
            '**不要為了讓驗證通過而亂改程式碼**——沒有該做的改動時，用這個工具說明比硬寫更正確。',
          {
            category: z
              .enum(['already_satisfied', 'not_applicable', 'blocked_externally', 'spec_unclear'])
              .describe(
                'already_satisfied=現況已符合需求；not_applicable=描述與現況不符或需求矛盾；' +
                  'blocked_externally=缺外部依賴/權限；spec_unclear=規格不足以判斷',
              ),
            reason: z.string().describe('為什麼不需要改動，具體說明'),
            evidence: z.string().optional().describe('你查證了什麼（檔案、既有實作位置、指令輸出）'),
          },
          createNoChangeHandler(captured, this.log, taskId),
        ),
        tool(
          'report_friction',
          FRICTION_TOOL_DESCRIPTION,
          {
            kind: z
              .enum(FRICTION_KINDS)
              .describe(
                'system_limitation=工具/權限/資訊不足；spec_problem=規格本身有問題；' +
                  'gate_false_positive=關卡誤判；gate_missed=關卡該擋沒擋；workflow=流程建議；other=其他',
              ),
            what: z.string().describe('一句話說明遇到什麼'),
            evidence: z.string().optional().describe('證據：檔案與行號、指令輸出、量測數字'),
            suggestion: z.string().optional().describe('建議怎麼改（可選）'),
            blocked: z.boolean().optional().describe('這件事有沒有實際擋住你'),
          },
          createFrictionHandler(this.deps.frictionSink ?? NOOP_SINK, this.log, taskId, 'coder'),
        ),
        tool(
          'ask_human',
          '僅在遇到「不可逆或高風險」且無法從規格/程式碼判斷的歧義時提問。可逆的小決定請自行採合理預設並在總結記錄假設。',
          {
            question: z.string(),
            rationale: z.string().optional(),
            options: z.array(z.string()).optional(),
          },
          createAskHumanHandler(captured, this.log, taskId),
        ),
      ],
    });
  }
}

/**
 * ask_human 之後回給 agent 的指示。
 *
 * 這句話從「自己選個預設繼續做」改成「立刻停下」，是為了對齊調度器**實際**的行為：
 * Worker 收到澄清就把任務 park 起來等人回覆。舊寫法會讓 agent 基於猜測動手改一堆東西，
 * 然後那一輪照樣被 park——人回覆時，程式碼已經照著錯誤的假設改過了，答案反而更難收拾。
 *
 * 人回覆後會 resume 同一個 session 並把答覆貼進來，所以停下來不會損失任何上下文。
 */
export const ASK_HUMAN_FALLBACK =
  '問題已轉給負責的人。**請立刻結束本輪，不要基於猜測動手修改程式碼。**'
  + '對方回覆後，系統會接回這個 session 並把答覆交給你，你再從那裡繼續即可。';

// ── SDK 串接層（抽成純工廠函式，讓 hook / 工具 / 訊息解析都能單元測試） ──
//
// 這些是「紅線與 DoD 真正生效的地方」。放在 class 私有方法裡等於沒有測試覆蓋，
// 一旦形狀寫錯（例如 permissionDecision 拼錯）紅線會整段失效而測試全綠。

/**
 * PreToolUse 政策閘門 hook。回傳 SDK 約定的 hookSpecificOutput：
 * deny 時必須帶 hookEventName/permissionDecision/permissionDecisionReason，缺一不可。
 */
export function createPreToolUseGuard(
  log: Logger,
  toolPolicy?: ToolPolicyOptions,
  /** 每次工具呼叫回報一次（觀察用）。不影響放行與否。 */
  onTool?: (toolName: string) => void,
) {
  return async (hookInput: Record<string, unknown>) => {
    const toolName = String(hookInput.tool_name ?? '');
    onTool?.(toolName);
    const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
    // hookInput.cwd 讓「讀被執行的腳本內容」能解析相對路徑
    const cwd = typeof hookInput.cwd === 'string' ? hookInput.cwd : undefined;
    const verdict = evaluateToolPolicy(toolName, toolInput, toolPolicy, cwd);
    if (verdict.deny) {
      log.warn({ toolName, reason: verdict.reason }, '政策閘門擋下工具呼叫');
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: verdict.reason ?? '政策拒絕',
        },
      };
    }
    return {};
  };
}

export interface StopHookArgs {
  log: Logger;
  cwd: string;
  taskId: string;
  captured: CapturedSignals;
  state: { blocks: number };
  maxBlocks: number;
  /**
   * 本任務起點 sha（＝DoD diff 關卡與 reviewer 同一枚）。
   *
   * 沒有它就只看得到「未 commit 的東西」，而 agent 有 commit 的能力——
   * 它做完並提交之後會被當面告知「你什麼都沒做」（實跑撞到，見 git/status.ts）。
   */
  baseRef?: string;
  workingTreeChanged: (cwd: string, baseRef?: string) => Promise<boolean>;
}

/** Stop hook：判定見 evaluateStopHook；此處只負責取狀態、計數與回傳 SDK 形狀。 */
export function createStopHook(args: StopHookArgs) {
  return async (hookInput: Record<string, unknown>) => {
    let treeChanged = true; // 取不到就當有變更（寧可放行，也不要因 git 失敗把 agent 關在迴圈裡）
    try {
      treeChanged = await args.workingTreeChanged(args.cwd, args.baseRef);
    } catch (e) {
      args.log.debug({ err: e instanceof Error ? e.message : String(e) }, 'Stop hook：無法取得工作區狀態，放行');
    }

    const decision = evaluateStopHook({
      workingTreeChanged: treeChanged,
      askedClarification: args.captured.clar !== undefined,
      reportedNoChange: args.captured.noChange !== undefined,
      blocksSoFar: args.state.blocks,
      maxBlocks: args.maxBlocks,
      stopHookActive: hookInput.stop_hook_active === true,
    });

    if (!decision.block) return {};
    args.state.blocks += 1;
    args.log.warn({ taskId: args.taskId, blocks: args.state.blocks, reason: decision.reason }, 'Stop hook 擋下收工，要求續做');
    return { continue: true, systemMessage: decision.reason };
  };
}

/** ask_human 工具處理函式：把提問捕捉到 captured（供 Worker park），並回覆 agent 續做指示。 */
export function createAskHumanHandler(captured: CapturedSignals, log: Logger, taskId: string) {
  return async (args: { question: string; rationale?: string; options?: string[] }) => {
    captured.clar = { question: args.question, rationale: args.rationale, options: args.options };
    log.info({ taskId, question: args.question }, 'ask_human 被呼叫（M1–3 暫用預設策略）');
    return { content: [{ type: 'text' as const, text: ASK_HUMAN_FALLBACK }] };
  };
}

/**
 * 這一輪的失敗是不是「續接不到 session」造成的？
 *
 * 只認**明確指向 session/conversation/resume 的錯誤訊息**。放寬條件會很貴：
 * 任何一輪失敗都重跑一次 = 每個真實故障都付兩份錢，而且看起來像系統在亂重試。
 */
export function isResumeFailure(r: { isError: boolean; sdkError?: string; resultText?: string }): boolean {
  if (!r.isError) return false;
  const text = `${r.sdkError ?? ''} ${r.resultText ?? ''}`.toLowerCase();
  if (text === ' ') return false;
  const mentionsSession = /session|conversation|resume/.test(text);
  const mentionsMissing = /not found|no such|unknown|invalid|expired|does not exist|missing|已過期|不存在/.test(text);
  return mentionsSession && mentionsMissing;
}

export const NO_CHANGE_ACK =
  '已記錄你的判斷。請直接結束本輪，不要為了讓驗證通過而修改程式碼——' +
  '調度器會依政策決定是交人確認還是直接結案。';

/**
 * report_no_change 的處理器。這裡只**記錄宣告**；真正的處置（park 等人確認／自動結案）
 * 由 Worker 依政策決定——因為 complete_task 不可逆，這個決定不能交給 agent 自己下。
 */
export function createNoChangeHandler(captured: CapturedSignals, log: Logger, taskId: string) {
  return async (args: { category: NoChangeCategory; reason: string; evidence?: string }) => {
    captured.noChange = { category: args.category, reason: args.reason, evidence: args.evidence };
    log.info({ taskId, category: args.category, reason: args.reason }, 'report_no_change 被呼叫');
    return { content: [{ type: 'text' as const, text: NO_CHANGE_ACK }] };
  };
}

export interface StreamOutcome {
  sessionId?: string;
  resultText: string;
  isError: boolean;
  /** 錯誤處置分類（isError 時才有）。 */
  errorKind?: AgentErrorKind;
  /** SDK 給的錯誤語意碼。 */
  sdkError?: SdkErrorCode;
  /** 最後一次 API 失敗的 HTTP 狀態碼（連線錯誤時 SDK 給 null，此處省略）。 */
  httpStatus?: number;
  /** SDK 自己做過的重試（觀測用；不要在外層重複退避）。 */
  retries?: ApiRetryInfo[];
  /** 本輪的用量與花費（SDK 在 result 訊息給的實際數字，不是估算）。 */
  usage?: AgentUsage;
}

/**
 * 一輪 agent 執行的用量。
 * SDK 的 result 訊息直接給 `total_cost_usd` 與各模型的 token 數，所以這裡是**實際值**；
 * 沒有它就答不出「這個任務花了多少錢」——那是常駐系統最基本的安全感。
 */
export interface AgentUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  models: string[];
  numTurns?: number;
  durationMs?: number;
}

/**
 * 解析 SDK 訊息串流：取 sessionId（init 與 result 都可能帶）、成功時取 result 文字，
 * 非 success 的 result 一律視為錯誤（由外層 DoD 迴圈決定要不要重跑）。
 */
export async function collectStreamOutcome(stream: AsyncIterable<unknown>): Promise<StreamOutcome> {
  let sessionId: string | undefined;
  let resultText = '';
  let isError = false;
  let errorKind: AgentErrorKind | undefined;
  let lastSdkError: SdkErrorCode | undefined;
  let lastStatus: number | null | undefined;
  let usage: AgentUsage | undefined;
  const retries: ApiRetryInfo[] = [];

  // 註：SDK 訊息為 discriminated union，欄位以 discriminant 保護後存取；
  // 以最小轉型對接外部 SDK，避免版本間型別漂移導致編譯失敗。
  for await (const msg of stream) {
    const m = (msg ?? {}) as {
      type?: string;
      subtype?: string;
      session_id?: string;
      result?: string;
      error?: string;
      error_status?: number | null;
      attempt?: number;
      max_retries?: number;
      retry_delay_ms?: number;
      errors?: unknown;
    };

    if (m.type === 'system' && m.subtype === 'init') {
      sessionId = m.session_id ?? sessionId;
      continue;
    }

    // SDK 自己在重試可重試的錯誤時會發這個訊息，附帶**真正的 HTTP 狀態碼**。
    // 這是我們唯一能看到 429/529 的地方（SDK 內部重試成功的話最終結果會是 success），
    // 拿來做觀測與升級通知——不要在這裡自行重試，會和 SDK 的重試疊成雙重退避。
    if (m.type === 'system' && m.subtype === 'api_retry') {
      lastSdkError = asSdkError(m.error);
      lastStatus = m.error_status;
      retries.push({
        attempt: m.attempt ?? 0,
        maxRetries: m.max_retries ?? 0,
        delayMs: m.retry_delay_ms ?? 0,
        status: m.error_status ?? null,
        ...(lastSdkError ? { error: lastSdkError } : {}),
      });
      continue;
    }

    // assistant 訊息也可能帶 error（例如串到一半失敗）
    if (m.type === 'assistant' && m.error) lastSdkError = asSdkError(m.error) ?? lastSdkError;

    if (m.type === 'result') {
      sessionId = m.session_id ?? sessionId;
      usage = parseUsage(msg) ?? usage;
      if (m.subtype === 'success') {
        resultText = m.result ?? '';
      } else {
        isError = true;
        // result 的 errors 是字串陣列，裡面常含最後一次的錯誤描述
        const texts = Array.isArray(m.errors) ? m.errors.filter((e): e is string => typeof e === 'string') : [];
        errorKind = classifyAgentError({
          ...(lastSdkError ? { sdkError: lastSdkError } : {}),
          ...(m.subtype ? { resultSubtype: m.subtype } : {}),
          ...(lastStatus !== undefined && lastStatus !== null ? { status: lastStatus } : {}),
          texts,
        });
      }
    }
  }

  return {
    sessionId,
    resultText,
    isError,
    ...(errorKind ? { errorKind } : {}),
    ...(lastSdkError ? { sdkError: lastSdkError } : {}),
    ...(lastStatus !== undefined && lastStatus !== null ? { httpStatus: lastStatus } : {}),
    ...(retries.length > 0 ? { retries } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * 從 result 訊息取出用量。錯誤結束的 result 也帶這些欄位（跑了就是花了錢），所以一律解析。
 * modelUsage 是 `{ [模型名]: ModelUsage }`，逐一加總才拿得到整輪的 token 數。
 */
export function parseUsage(msg: unknown): AgentUsage | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined;
  const m = msg as {
    total_cost_usd?: unknown;
    num_turns?: unknown;
    duration_ms?: unknown;
    modelUsage?: unknown;
  };
  const perModel = typeof m.modelUsage === 'object' && m.modelUsage !== null
    ? (m.modelUsage as Record<string, Partial<Record<'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'costUSD', number>>>)
    : {};
  const models = Object.keys(perModel);
  const cost = typeof m.total_cost_usd === 'number'
    ? m.total_cost_usd
    : models.reduce((sum, k) => sum + (perModel[k]?.costUSD ?? 0), 0);
  if (models.length === 0 && typeof m.total_cost_usd !== 'number') return undefined;

  const sum = (field: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens'): number =>
    models.reduce((acc, k) => acc + (perModel[k]?.[field] ?? 0), 0);

  return {
    costUsd: cost,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadInputTokens'),
    models,
    ...(typeof m.num_turns === 'number' ? { numTurns: m.num_turns } : {}),
    ...(typeof m.duration_ms === 'number' ? { durationMs: m.duration_ms } : {}),
  };
}

/** SDK 的錯誤語意碼（對映 SDKAssistantMessageError）。 */
export type SdkErrorCode =
  | 'authentication_failed'
  | 'oauth_org_not_allowed'
  | 'billing_error'
  | 'rate_limit'
  | 'overloaded'
  | 'invalid_request'
  | 'model_not_found'
  | 'server_error'
  | 'max_output_tokens'
  | 'unknown';

const SDK_ERROR_CODES = new Set<string>([
  'authentication_failed', 'oauth_org_not_allowed', 'billing_error', 'rate_limit',
  'overloaded', 'invalid_request', 'model_not_found', 'server_error', 'max_output_tokens', 'unknown',
]);

function asSdkError(v: unknown): SdkErrorCode | undefined {
  return typeof v === 'string' && SDK_ERROR_CODES.has(v) ? (v as SdkErrorCode) : undefined;
}

/**
 * agent 執行錯誤的處置分類。
 *
 * 為什麼要分：先前一律當成「可重試」丟進退避迴圈——但認證失敗、餘額不足、參數錯誤
 * **再重試一萬次也不會好**，只會安靜地燒時間，而人完全不知道要去修設定。
 */
export type AgentErrorKind =
  | 'transient' // 限流/過載/伺服器錯誤/逾時 → 退避後重試（SDK 通常已先重試過）
  | 'permanent' // 認證/授權/帳務/參數/模型不存在 → 立刻交人，重試無意義
  | 'capacity' // 輸出長度、預算、turn 上限 → 要調整任務或設定，不是等它自己好
  | 'unknown'; // 分不出來 → 保守當可重試（但呼叫端會計次升級）

export interface ApiRetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  /** 連線錯誤（逾時等）沒有 HTTP 回應時為 null。 */
  status: number | null;
  error?: SdkErrorCode;
}

/** 依 SDK 給的語意碼、result subtype 與 HTTP 狀態碼決定處置（純函式，好測）。 */
export function classifyAgentError(input: {
  sdkError?: SdkErrorCode;
  resultSubtype?: string;
  status?: number;
  texts?: string[];
}): AgentErrorKind {
  switch (input.sdkError) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'billing_error':
    case 'invalid_request':
    case 'model_not_found':
      return 'permanent';
    case 'rate_limit':
    case 'overloaded':
    case 'server_error':
      return 'transient';
    case 'max_output_tokens':
      return 'capacity';
    default:
      break;
  }

  // SDK 沒給語意碼時退回 HTTP 狀態碼：4xx 多半是我方問題（重試無用），5xx/429 才值得等
  if (typeof input.status === 'number') {
    if (input.status === 429) return 'transient';
    if (input.status >= 500) return 'transient';
    if (input.status >= 400) return 'permanent';
  }

  // result 的 subtype 也帶資訊：撞到上限屬於「要改設定」而不是「等它好」
  if (input.resultSubtype === 'error_max_turns') return 'capacity';
  if (input.resultSubtype === 'error_max_budget_usd') return 'capacity';
  if (input.resultSubtype === 'error_max_structured_output_retries') return 'capacity';

  const text = (input.texts ?? []).join(' ').toLowerCase();
  if (/\b(401|403)\b|unauthor|forbidden|invalid api key|authentication/.test(text)) return 'permanent';
  if (/\b(429|529|500|502|503|504)\b|overload|rate.?limit|timed? ?out|timeout|econnreset/.test(text)) return 'transient';
  return 'unknown';
}

// ── 純函式（可無金鑰單元驗證） ──

/** 依任務/規格/回饋組裝 agent prompt。 */
export function buildAgentPrompt(input: IterateInput): string {
  const p: string[] = [];
  p.push(`# 任務 ${input.task.id}：${input.task.title}`);
  p.push(`類別：${input.task.category}｜repo：${input.task.repo}`);
  p.push(`\n## 任務描述\n${input.task.description}`);

  if (input.docs.length > 0) {
    p.push(`\n## 規格文件（docRefs，務必逐段遵循）`);
    for (const d of input.docs) p.push(`\n### ${d.ref}\n${d.content}`);
  }

  // 規劃階段的線索。**措辭是關鍵**：它是讀完整個 repo 後的判斷（實測 13 分鐘），
  // 很有參考價值，但如果讓 agent 當成事實，它會只改那幾個檔案就收工——
  // 那比沒有這段更糟。所以明講「不完整、要自己確認」。
  if (input.planHint && (input.planHint.rationale || input.planHint.files.length > 0)) {
    p.push(`\n## 規劃階段的線索（**參考用，不是事實**）`);
    p.push(
      '這是分群時的判斷，它沒有看過你要寫的程式碼，也可能漏掉或看錯。'
      + '拿它當起點省去重新摸索，但**該改哪些檔案由你自己查證決定**——'
      + '不要因為某個檔案不在下面就不去改它。',
    );
    if (input.planHint.rationale) p.push(`\n為什麼這幾個任務分在同一組：${input.planHint.rationale}`);
    if (input.planHint.files.length > 0) {
      p.push(`\n規劃時預期會動到（整組共用，不是只有這個任務）：\n${input.planHint.files.map((f) => `- ${f}`).join('\n')}`);
    }
  }

  if (input.answer) {
    p.push(`\n## 澄清答覆\n問題：${input.answer.question}\n答覆：${input.answer.answer}`);
  }

  // 只有真的有失敗關卡才輸出這段：全綠卻掛「未通過」標題會讓 agent 去猜哪裡錯、
  // 反而動到不該動的東西（reviewer 回灌的 GateReport 有可能所有 checks 都是 ok）。
  const failed = input.feedback?.checks.filter((c) => !c.ok) ?? [];
  if (failed.length > 0) {
    p.push(`\n## 上一輪驗證未通過，請修正後再完成`);
    for (const c of failed) {
      const ids = c.failingIds?.length ? `（失敗項：${c.failingIds.join(', ')}）` : '';
      p.push(`- [${c.name}] ${c.detail}${ids}`);
    }
  }

  p.push(
    `\n## 完成要求\n` +
      `- 實作需符合上述規格的每一段。\n` +
      `- 完成後調度器會實跑 lint/build/test 驗證，並檢查「確實有程式碼變更」；請確保這些會通過。\n` +
      `- 可逆的小決定自行採合理預設並記錄假設；僅在不可逆/高風險時使用 ask_human。\n` +
      `- **若查證後確認本任務不需要任何程式碼改動**（功能已存在、任務描述與現況不符、` +
      `缺外部依賴無法進行），請呼叫 report_no_change 說明分類與依據。` +
      `這是正當的結果，調度器會交人確認。**絕對不要為了讓驗證通過而寫無意義的改動。**`,
  );

  p.push(EXTERNAL_ACTION_RULE);

  p.push(SUMMARY_FORMAT);
  return p.join('\n');
}

/**
 * 外部動作的禁令。
 *
 * 這一段是**第三層**防護，不是主要防線：工具層已經硬擋（PreToolUse）、環境層已經切斷認證
 * （buildAgentEnv）。寫在 prompt 裡的目的只是讓 agent 知道「為什麼被擋」，
 * 免得它把被拒絕的工具呼叫當成環境故障而反覆重試、或去找繞路的寫法。
 * 單靠這段話是不安全的——prompt 可以被忽略，也可能被任務描述帶偏。
 */
const EXTERNAL_ACTION_RULE = `
## 你不能做的事（會被系統擋下，請不要嘗試繞過）
- **不要使用 \`gh\`（GitHub CLI）做任何事**：開 PR、合併、改設定都由調度器負責。
- **不要 \`git push\`，也不要改動 git remote**：推送分支同樣由調度器負責。
- 上面兩點在工具層會被直接拒絕，而且執行環境**沒有 GitHub 認證**，
  寫成腳本再執行、或換個包裝方式一樣不會成功——請不要把時間花在這上面。
- 你該做的是：在工作目錄內修改程式碼、執行本地驗證（build/test/lint）。
  git add / commit / status / diff 這些本地操作是允許的。`;

/**
 * 最終總結的格式要求。
 *
 * 為什麼要明講：PR 內文的敘事段（做了什麼/怎麼做/架構/畫面/操作/核心技術）是直接從
 * agent 的最終總結解析出來的。先前 prompt 完全沒提這件事，agent 自然只寫一兩句話，
 * 於是 PR 上大半段落都是「（待補）」——需求「讓審查人員快速了解」等於沒有兌現。
 *
 * 刻意要求「不適用就整段省略」而不是填「無」：硬湊段落只會讓審查者讀到廢話，
 * 也會讓「（待補）」失去它原本的意義（真的沒寫 vs 不適用）。
 */
const SUMMARY_FORMAT = `
## 最終總結的格式（會被放進 PR 給人審查，請務必照做）
完成後，請以下列標題輸出總結。**不適用的段落整段省略**（不要寫「無」或「待補」）：

## 做了什麼
一到三句說明這次的成果。

## 怎麼做
實作方式與關鍵決策；為什麼這樣做而不是別的做法。

## 架構
模組、資料流或介面的變動。純粹的小修改沒有結構性變動時，省略本段。

## 畫面設計
只有動到畫面時才寫：版面、狀態、響應式行為、與既有設計語彙的關係。

## 操作形式
使用者實際怎麼操作、走完流程會看到什麼。沒有使用者可見行為時省略。

## 核心技術
用到的關鍵技術、API 或模式（例如某個瀏覽器 API、演算法、框架特性）。

## 假設
你自行採用的可逆預設，每行一條，附上依據。沒有就省略整段。`;

export interface StopDecisionInput {
  /** 工作區相對 HEAD 是否有任何變更。 */
  workingTreeChanged: boolean;
  /** 本輪是否呼叫過 ask_human（park 等答覆是正當的收工理由，不可擋）。 */
  askedClarification: boolean;
  /**
   * 本輪是否呼叫過 report_no_change。零變更收工在這種情況下是**正當的**——
   * 不放行的話，agent 會被 Stop hook 與 DoD 兩頭夾殺，只能亂改程式來脫身。
   */
  reportedNoChange?: boolean;
  /** 本輪已擋過幾次。 */
  blocksSoFar: number;
  maxBlocks: number;
  /** SDK 告知「本次收工已是 Stop hook 續跑後的結果」。 */
  stopHookActive?: boolean;
}

export interface StopDecision {
  block: boolean;
  /** block=true 時回給 agent 的續做指示。 */
  reason?: string;
}

/**
 * Stop hook 判定（純函式，供 hook 與單元測試共用）。
 * 只有「沒提澄清、工作區零變更、且還沒擋滿」才擋；其餘一律放行交給外層 DoD。
 */
export function evaluateStopHook(input: StopDecisionInput): StopDecision {
  if (input.askedClarification) return { block: false };
  if (input.reportedNoChange) return { block: false };
  if (input.workingTreeChanged) return { block: false };
  // stopHookActive = 這次收工已是被 hook 續跑後的結果；計數器若因故歸零，靠它當下限避免無限重擋
  const effectiveBlocks = Math.max(input.blocksSoFar, input.stopHookActive ? 1 : 0);
  if (effectiveBlocks >= input.maxBlocks) return { block: false };
  return {
    block: true,
    reason:
      '工作區沒有任何檔案變更，代表這個任務還沒被實作。請繼續完成：' +
      '先讀規格與相關程式碼，實際寫入 / 修改檔案。' +
      '若規格有不可逆的歧義而無法動手，請用 ask_human 提問；' +
      '若你查證後確認這個任務本來就不需要任何程式碼改動（功能已存在／描述與現況不符／' +
      '缺外部依賴），請用 report_no_change 說明理由。不要直接結束，也不要為了讓驗證通過而亂改程式碼。' +
        // 實跑撞到：agent 做完並 commit 之後被這句話告知「你什麼都沒做」，
        // 它的反應是 git reset HEAD~1 把 commit 退掉讓變更「重新出現」。
        // 量測端已經修好（Stop hook 現在比對任務起點），但這條路要明擋——
        // 因為下一個量測缺陷出現時，它還是會想到同一招。
        '\n\n**如果你已經把變更 commit 了，那些變更本來就算數**——' +
        '不要用 reset／amend／rebase 去讓變更「重新出現」。' +
        '真的看不到你的變更時那是量測端的問題，請用 report_friction 回報。',
  };
}

export interface PolicyVerdict {
  deny: boolean;
  reason?: string;
}

// ── 保護路徑（DESIGN §10「刪保護路徑 / 改 CI 設定」的工具層落實） ──
//
// 這裡是**當場擋下**的紅線，誤擋會直接讓 agent 做不完任務，所以清單刻意窄：
// 只放「正常開發流程本來就不該由 agent 自行改動」的東西（CI/部署設定、憑證、git 內部）。
// 依賴、migration、原始碼一律放行——那些屬於「可以改，但 PR 要人工核准」，
// 由 PolicyEngine（src/policy/policy-engine.ts）在合併閘門處理。
// DESIGN §10 還提到「改帳單相關」，但帳單程式碼的位置因專案而異（如 src/billing/**），
// 無法內建猜測；專案自行用 ToolPolicyOptions.protectedPaths 補上。

export type ProtectedPathCategory = 'ci' | 'deploy' | 'secrets' | 'git';

/** 保護路徑 glob。一律以 `**\/` 開頭，這樣相對路徑與絕對路徑（worktree 前綴）都能命中。 */
const PROTECTED_PATHS: Record<ProtectedPathCategory, string[]> = {
  ci: [
    '**/.github/workflows/**',
    '**/.github/actions/**',
    '**/.gitlab-ci.yml',
    '**/.circleci/**',
    '**/Jenkinsfile',
    '**/azure-pipelines.yml',
    '**/.buildkite/**',
  ],
  deploy: [
    '**/firebase.json',
    '**/.firebaserc',
    '**/vercel.json',
    '**/netlify.toml',
    '**/wrangler.toml',
    '**/wrangler.jsonc',
    '**/fly.toml',
  ],
  secrets: [
    '**/.env',
    '**/.env.*',
    '**/*.pem',
    '**/*.key',
    '**/*.p12',
    '**/*.pfx',
    '**/*.keystore',
    '**/id_rsa*',
    '**/.npmrc',
    '**/serviceAccount*.json',
  ],
  git: ['**/.git/**'],
};

const PROTECTED_LABEL: Record<ProtectedPathCategory, string> = {
  ci: 'CI 設定',
  deploy: '部署設定',
  secrets: 'secrets/憑證',
  git: 'git 內部檔',
};

/**
 * 例外白名單（優先於保護路徑）。範本/範例檔本來就是要給人改的，
 * 例如 .env.example、firebase.example.json——擋這些純粹是妨礙開發。
 */
const DEFAULT_ALLOW_PATHS = ['**/*.example', '**/*.example.*', '**/*.sample', '**/*.template', '**/*.dist'];

export interface ToolPolicyOptions {
  /** 取代內建保護路徑（給定時完全取代，未給則用內建安全預設）。 */
  protectedPaths?: string[];
  /** 追加例外（永遠疊在內建例外之上——移除內建例外只會製造誤擋）。 */
  allowPaths?: string[];
  /**
   * `'readonly'` ＝ 只判斷、不動手的角色（規劃者、reviewer、各判斷者）。
   *
   * 為什麼需要：這些角色的 cwd 是**使用者真正的 checkout**，不是 worktree
   * （規劃 agent 要看 repo 實際結構才判斷得出誰會撞誰）。而 SDK 的 allowedTools
   * 對工具**不具強制力**——實跑證實規劃 agent 用了 9 次 Bash，儘管 allowedTools
   * 只列了 Read/Glob/Grep。唯一可靠的邊界是這個 PreToolUse hook。
   *
   * 未給 → `'write'`，行為與加這個欄位之前一位元不變。
   */
  mode?: 'write' | 'readonly';
  /**
   * 工具名白名單。給定時，不在清單內的工具一律擋。
   * 這是 allowedTools 的**強制版**——SDK 那份只是建議。
   */
  allowTools?: string[];
}

interface ProtectedRule {
  pattern: string;
  label: string;
}

export interface ResolvedToolPolicy {
  protectedRules: ProtectedRule[];
  allowPaths: string[];
  mode: 'write' | 'readonly';
  allowTools?: Set<string>;
}

/**
 * 由保護 glob 推導出「目錄本身」的形式。
 * `**\/.github/workflows/**` 只匹配「目錄底下的檔案」，所以 `rm -rf .github/workflows`
 * 或 `rm -rf .git`（整個目錄刪掉）原本完全不會命中——刪目錄比刪單檔更嚴重，必須一起擋。
 * 只往上收「不含萬用字元」的段落：`**\/*.pem` 推不出（也不該推）目錄形式。
 */
export function directoryFormsOf(pattern: string): string[] {
  const segs = pattern.split('/');
  const forms: string[] = [];
  for (let i = segs.length - 1; i >= 1; i -= 1) {
    const last = segs[i - 1]!;
    if (last === '' || last.includes('*') || last.includes('?')) continue;
    forms.push(segs.slice(0, i).join('/'));
  }
  return forms;
}

/** 展開保護路徑設定。未給覆寫時回內建預設（安全優先）。 */
export function resolveToolPolicy(options?: ToolPolicyOptions): ResolvedToolPolicy {
  const builtin: ProtectedRule[] = (Object.keys(PROTECTED_PATHS) as ProtectedPathCategory[]).flatMap((cat) =>
    PROTECTED_PATHS[cat].map((pattern) => ({ pattern, label: PROTECTED_LABEL[cat] })),
  );
  const base = options?.protectedPaths?.length
    ? options.protectedPaths.map((pattern) => ({ pattern, label: '專案保護路徑' }))
    : builtin;
  const dirRules = base.flatMap((r) => directoryFormsOf(r.pattern).map((pattern) => ({ pattern, label: r.label })));
  const seen = new Set<string>();
  const protectedRules = [...base, ...dirRules].filter((r) => {
    if (seen.has(r.pattern)) return false;
    seen.add(r.pattern);
    return true;
  });
  return {
    protectedRules,
    allowPaths: [...DEFAULT_ALLOW_PATHS, ...(options?.allowPaths ?? [])],
    mode: options?.mode ?? 'write',
    ...(options?.allowTools ? { allowTools: new Set(options.allowTools) } : {}),
  };
}

/**
 * 唯讀角色可以執行的指令。
 *
 * 白名單而非黑名單：黑名單永遠列不完（`node -e`、`python -c`、`perl -pi`、
 * `tee`、`dd`、`install`…每一個都能寫檔），而唯讀角色實際需要的東西很少。
 *
 * 刻意**不放行** npm／node／python：`npm run <任意 script>`、`node -e` 都能寫檔，
 * 要靠子指令白名單擋的複雜度遠高於它們帶來的價值——查 repo 結構用不到它們。
 */
const READONLY_COMMANDS = new Set([
  'grep', 'rg', 'egrep', 'fgrep', 'find', 'ls', 'cat', 'head', 'tail', 'wc',
  'sort', 'uniq', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'file', 'stat', 'echo', 'true',
  // pwd 沒有任何寫入形式，卻被擋過（正式 log）。誤擋的代價不是「安全一點」，
  // 是判斷者少一次定位自己在哪，然後憑猜的去讀檔案。
  'pwd',
]);

/**
 * 取出所有命令替換的內容。
 *
 * **括號要用數的，不能用正則。** `/\$\(([^()]*)\)/` 的字元集排除括號，
 * 遇到 `$(echo $(rm -rf x))` 時只匹配得到最內層那一個，外層那段從未被檢查。
 */
export function extractSubstitutions(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end < 0) break;
      const inner = text.slice(i + 1, end).trim();
      if (inner) out.push(inner);
      i = end;
      continue;
    }
    if (text[i] !== '$' || text[i + 1] !== '(') continue;
    let depth = 1;
    let j = i + 2;
    for (; j < text.length && depth > 0; j += 1) {
      if (text[j] === '(') depth += 1;
      else if (text[j] === ')') depth -= 1;
    }
    if (depth !== 0) break; // 括號不對稱：交給下面的白名單擋，這裡不猜
    const inner = text.slice(i + 2, j - 1).trim();
    if (inner) out.push(inner);
    i = j - 1;
  }
  return out;
}

/** `$(` 的括號有沒有對稱。不對稱代表我們拆不出裡面有什麼。 */
function unbalancedSubstitution(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '$' && text[i + 1] === '(') { depth += 1; i += 1; }
    else if (text[i] === ')' && depth > 0) depth -= 1;
  }
  if (depth !== 0) return true;
  // 反引號要成對
  return (text.match(/`/g) ?? []).length % 2 !== 0;
}

/** shell 語法關鍵字：不是指令，剝掉之後才看得到真正要跑的東西。 */
const SHELL_KEYWORDS = new Set([
  'for', 'do', 'done', 'while', 'until', 'if', 'then', 'else', 'elif', 'fi',
  'case', 'esac', 'in', 'select', 'time', 'command', 'builtin',
]);

/** 剝掉開頭的語法關鍵字與 `for x in …` 的變數／清單部分。 */
function stripShellKeywords(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && SHELL_KEYWORDS.has(tokens[i]!)) {
    // `for f in a b c` → 跳過 for、變數名，以及 in 之後到段尾的清單
    if (tokens[i] === 'for' || tokens[i] === 'select') {
      const inAt = tokens.indexOf('in', i);
      return inAt >= 0 ? [] : tokens.slice(i + 2); // in 之後整段都是資料，沒有指令
    }
    i += 1;
  }
  return tokens.slice(i);
}

/**
 * 白名單裡的指令**自己就能寫檔**的旗標。
 *
 * 「這個指令在白名單裡」不等於「這次呼叫是唯讀的」——實測全部繞得過去：
 *   find . -name x -delete          刪檔
 *   find . -name x -exec rm {} +    執行任意指令
 *   sort -o out.txt in.txt          寫檔（不用重導向）
 * 白名單擋的是「哪個程式」，這一層擋的是「它被要求做什麼」。
 */
const WRITE_CAPABLE_FLAGS: Record<string, string[]> = {
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprint', '-fprint0', '-fprintf'],
  sort: ['-o', '--output'],
  grep: ['--devices', '--directories'],
};

/** git 的唯讀子指令。git 本身既能讀也能寫，所以要看第一個子指令。 */
const READONLY_GIT_SUBCOMMANDS = new Set([
  'log', 'diff', 'show', 'status', 'ls-files', 'ls-tree', 'cat-file', 'rev-parse',
  'rev-list', 'blame', 'grep', 'branch', 'describe', 'shortlog', 'config',
]);

/**
 * 唯讀模式下這條 Bash 指令能不能跑。
 *
 * 逐段判定（decomposeShellCommand 已處理 `&&`／`;`／`|`／`$(...)`／巢狀 `-c`），
 * **每一段都要在白名單內**——一段不合格就整條擋掉。
 */
export function evaluateReadonlyCommand(cmd: string, depth = 0): PolicyVerdict {
  const { commands, sources } = decomposeShellCommand(cmd);
  if (commands.length === 0) return { deny: false };

  // 重導向會寫檔，而它不是「指令」——要在字串層擋
  for (const src of sources) {
    if (/(^|[^0-9<>&])>{1,2}(?![&|])/.test(src)) {
      return { deny: true, reason: '紅線：唯讀角色不可以用重導向寫檔（> 或 >>）。你的職責是判斷，不是動手改東西。' };
    }
  }

  // **拆不下去就擋，不要當成「沒東西」。** 這是整個唯讀判定的骨幹原則：
  // 看不懂一條指令時，唯一安全的答案是拒絕——唯讀角色只需要簡單的查詢，
  // 寫得出巢狀反引號或不對稱括號的，本來就不該是它要跑的東西。
  if (/\\`/.test(cmd) || unbalancedSubstitution(cmd)) {
    return {
      deny: true,
      reason: '紅線：這條指令的巢狀結構解析不出來（跳脫的反引號／括號不對稱），唯讀角色不接受看不懂的指令。'
        + '請改用單純的查詢寫法。',
    };
  }

  // 命令替換：`echo $(rm -rf x)` 的第一個 token 是 echo，逐段掃描看不到裡面。
  // 巢狀深度設限，避免病態輸入。
  if (depth < 3) {
    for (const src of sources) {
      for (const inner of extractSubstitutions(src)) {
        const v = evaluateReadonlyCommand(inner, depth + 1);
        if (v.deny) return v;
      }
    }
  }

  for (const raw of commands) {
    // for/do/if/then… 是語法關鍵字不是指令。整條擋掉的話，
    // `for f in a b; do grep x "$f"; done` 這種批次查詢就不能用了，
    // 而那正是保留 Bash 的理由。剝掉關鍵字之後看真正的指令。
    const tokens = stripShellKeywords(raw);
    if (tokens.length === 0) continue;
    const bin = (tokens[0] ?? '').split('/').pop() ?? '';
    if (bin === 'git') {
      // 跳過 -C <path> 這類全域選項，找出真正的子指令
      let i = 1;
      while (i < tokens.length && tokens[i]!.startsWith('-')) i += tokens[i] === '-C' || tokens[i] === '-c' ? 2 : 1;
      const sub = tokens[i] ?? '';
      // --output=/path 幾乎每個 git 查詢子指令都吃，而它會寫檔
      const gitWrite = tokens.slice(i).find((t) => t === '--output' || t.startsWith('--output='));
      if (gitWrite) {
        return { deny: true, reason: `紅線：唯讀角色不可以用 \`${gitWrite}\` 把輸出寫進檔案。` };
      }
      if (!READONLY_GIT_SUBCOMMANDS.has(sub)) {
        return { deny: true, reason: `紅線：唯讀角色只能用 git 的查詢子指令，不能用 \`git ${sub || '(未知)'}\`。` };
      }
      // git config 只能讀。帶值是在寫，而 --unset / --add / --edit 這些**不帶值也在寫**
      const CONFIG_WRITE = ['--unset', '--unset-all', '--add', '--replace-all', '--edit', '-e', '--rename-section', '--remove-section'];
      if (sub === 'config') {
        const flag = tokens.slice(i + 1).find((t) => CONFIG_WRITE.includes(t));
        if (flag) return { deny: true, reason: `紅線：唯讀角色不可以用 \`git config ${flag}\` 改設定。` };
        if (tokens.slice(i + 1).filter((t) => !t.startsWith('-')).length > 1) {
          return { deny: true, reason: '紅線：唯讀角色不可以寫 git 設定。' };
        }
      }
      // git branch 列出來是唯讀的，但 -d/-D/-m/-M/-c/-C 會刪或改分支
      const BRANCH_WRITE = ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream'];
      if (sub === 'branch') {
        const flag = tokens.slice(i + 1).find((t) => BRANCH_WRITE.includes(t) || t.startsWith('--set-upstream-to='));
        if (flag) return { deny: true, reason: `紅線：唯讀角色不可以用 \`git branch ${flag}\` 改動分支。` };
      }
      continue;
    }
    // 白名單裡的指令也可能被要求去寫東西
    const bad = (WRITE_CAPABLE_FLAGS[bin] ?? []).find((f) => tokens.includes(f) || tokens.some((t) => t.startsWith(`${f}=`)));
    if (bad) {
      return { deny: true, reason: `紅線：\`${bin} ${bad}\` 會寫入或執行其他指令，唯讀角色不可以用。` };
    }
    if (!READONLY_COMMANDS.has(bin)) {
      return {
        deny: true,
        reason:
          `紅線：唯讀角色不可以執行 \`${bin || cmd.slice(0, 40)}\`。`
          + `可用的是查詢類指令（grep/rg/find/ls/cat/head/tail/wc、git 的查詢子指令）。`
          + `你的職責是判斷，不是動手改東西。`,
      };
    }
  }
  return { deny: false };
}

/** 路徑是否落在保護路徑內（回命中的規則；例外白名單優先）。 */
function findProtectedHit(rawPath: string, policy: ResolvedToolPolicy): ProtectedRule | undefined {
  const path = rawPath.replace(/^\.\//, '').replace(/\/+$/, '');
  if (path === '') return undefined;
  if (policy.allowPaths.some((p) => matchGlob(path, p))) return undefined;
  return policy.protectedRules.find((r) => matchGlob(path, r.pattern));
}

/** 會實際寫入檔案的工具。它們的 file_path 要過保護路徑檢查。 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** 取出寫入類工具的目標路徑（NotebookEdit 用 notebook_path）。非字串一律當「取不到」，不誤擋。 */
function writeTargetPath(toolInput: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'notebook_path']) {
    const v = toolInput[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

/**
 * 從 shell 指令抽出「會刪除或覆寫檔案」的目標路徑。
 * 只看 rm / git rm / mv 的參數與輸出重導向（> >> tee）——刻意不解析整條指令，
 * 寧可漏抓也不要把 `cat .env` 這種唯讀操作當成寫入而誤擋。
 * （cp 刻意不列：`cp .env.example .env.local.bak` 這種備份是正常操作。）
 */
function bashWriteTargets(cmd: string): string[] {
  const targets: string[] = [];
  for (const m of cmd.matchAll(/\b(?:git\s+)?(?:rm|unlink|mv)\b([^\n;&|]*)/g)) {
    for (const tok of (m[1] ?? '').split(/\s+/)) {
      if (tok !== '' && !tok.startsWith('-')) targets.push(tok);
    }
  }
  // `2>&1` 這種不會被抓到（& 不在字元集內），/dev/null 也不會命中保護路徑
  for (const m of cmd.matchAll(/(?:>>?|\btee\b(?:\s+-a)?)\s*([^\s;&|<>]+)/g)) {
    if (m[1]) targets.push(m[1]);
  }
  return targets.map((t) => t.replace(/^['"]|['"]$/g, '')).filter((t) => t !== '');
}

// ── shell 指令拆解（紅線比對前的正規化） ──
//
// 只做字面比對的紅線太好繞：`bash -c "npm run deploy"`、`env X=1 firebase deploy`、
// `npm run build && vercel deploy`、`yarn deploy`（沒有 run）全都能穿過。
// 所以先把指令列拆成「實際會被執行的一段一段指令」，再逐段用 token 判定。
// 反過來也要顧誤擋：用 token 判定（而非整串 regex）可避免把
// `git push origin x && rm -f tmp` 誤看成 `git push -f`。

/** 指令分隔符：; && || | 換行，以及非重導向用途的單一 &（`2>&1`、`&>` 不算）。 */
const SEGMENT_SPLIT = /&&|\|\||;|\||\r?\n|(?<![>&\d])&(?![>&])/;

/** 無害的前綴包裝字，去掉後才看得到真正要執行的指令。 */
const WRAPPER_WORDS = new Set(['sudo', 'doas', 'command', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'npx', 'bunx']);
/** `<shell> -c "…"` 會把整條危險指令藏在字串裡，要拆開往內看。 */
const SHELL_WORDS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'ash']);

/** 取指令名（去掉路徑與引號）：`/usr/bin/sudo` → `sudo`。 */
function commandName(token: string | undefined): string {
  const t = (token ?? '').replace(/^['"]|['"]$/g, '');
  const i = t.lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) : t;
}

/** 極簡 shell 斷詞：處理單/雙引號與反斜線跳脫，回傳去引號後的 token。 */
export function tokenizeShell(segment: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i]!;
    if (quote !== undefined) {
      if (c === quote) {
        quote = undefined;
      } else if (quote === '"' && c === '\\' && i + 1 < segment.length) {
        cur += segment[++i]!;
      } else {
        cur += c;
      }
      started = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === '\\' && i + 1 < segment.length) {
      cur += segment[++i]!;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) tokens.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) tokens.push(cur);
  return tokens.filter((t) => t !== '');
}

/** 去掉子 shell 的括號殘渣：`(cd x` / `rm -rf /)`。 */
function stripGrouping(tokens: string[]): string[] {
  const out = [...tokens];
  if (out.length > 0) out[0] = out[0]!.replace(/^[({]+/, '');
  if (out.length > 0) out[out.length - 1] = out[out.length - 1]!.replace(/[)}]+$/, '');
  return out.filter((t) => t !== '');
}

/** 剝掉前綴包裝；遇到 `sh -c "…"` 則回傳內層字串交給呼叫端遞迴拆解。 */
function unwrapPrefixes(input: string[]): { tokens: string[]; inner?: string } {
  let tokens = [...input];
  for (let guard = 0; guard < 12 && tokens.length > 0; guard += 1) {
    const head = tokens[0]!;
    const name = commandName(head);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      tokens = tokens.slice(1); // `FOO=1 <cmd>` 的環境變數前綴
      continue;
    }
    if (name === 'env') {
      tokens = tokens.slice(1);
      while (tokens.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!) || tokens[0]!.startsWith('-'))) {
        tokens = tokens.slice(1);
      }
      continue;
    }
    if (SHELL_WORDS.has(name)) {
      // -c 可能與其他短旗標併寫（-lc、-ec）
      const ci = tokens.findIndex((t) => /^-[a-zA-Z]*c$/.test(t));
      const payload = ci >= 0 ? tokens[ci + 1] : undefined;
      if (payload !== undefined) return { tokens: [], inner: payload };
      break; // `bash script.sh` 不是包裝，照原樣判
    }
    if (WRAPPER_WORDS.has(name)) {
      tokens = tokens.slice(1);
      continue;
    }
    if (name === 'npm' && tokens[1] === 'exec') {
      tokens = tokens.slice(2);
      while (tokens[0] === '--') tokens = tokens.slice(1);
      continue;
    }
    break;
  }
  return { tokens };
}

export interface ShellBreakdown {
  /** 每一段實際會執行的指令（已去包裝、去引號的 token 陣列）。 */
  commands: string[][];
  /** 原始字串與所有 `-c` 內層字串，供以字串為單位的掃描（rm/重導向目標）使用。 */
  sources: string[];
}

/** 把一條 shell 指令列拆成可逐段判定的形式。 */
export function decomposeShellCommand(cmd: string): ShellBreakdown {
  const commands: string[][] = [];
  const sources: string[] = [];
  const walk = (text: string, depth: number): void => {
    if (depth > 3) return; // 巢狀 -c 包裝到這個深度已無實務意義，避免病態輸入
    sources.push(text);
    for (const rawSeg of text.split(SEGMENT_SPLIT)) {
      const seg = (rawSeg ?? '').trim();
      if (seg === '') continue;
      const tokens = stripGrouping(tokenizeShell(seg));
      if (tokens.length === 0) continue;
      const { tokens: unwrapped, inner } = unwrapPrefixes(tokens);
      if (inner !== undefined) {
        walk(inner, depth + 1);
        continue;
      }
      if (unwrapped.length > 0) commands.push(unwrapped);
    }
  };
  walk(cmd, 0);
  return { commands, sources };
}

// ── 指令紅線判定 ──

const PACKAGE_MANAGERS = new Set(['npm', 'yarn', 'pnpm', 'bun']);
/** 帶 deploy/publish 參數才算部署的 CLI。 */
const DEPLOY_CLIS = new Set([
  'vercel',
  'netlify',
  'wrangler',
  'fly',
  'flyctl',
  'serverless',
  'sls',
  'gcloud',
  'eb',
  'now',
  'amplify',
  'cap',
  'heroku',
  'aws',
  'expo',
  'eas',
  'kamal',
  'dokku',
  'ansible-playbook',
]);
/** 本身就是「執行即部署」的 CLI，帶什麼參數都擋。 */
const ALWAYS_DEPLOY_CLIS = new Set(['gh-pages', 'surge']);
const PUBLISH_WORDS = new Set(['publish', 'promote', 'release']);
/** 會把後面那個檔案當程式執行的直譯器（用來擋 `bash scripts/deploy.sh`）。 */
const SCRIPT_RUNNERS = new Set(['sh', 'bash', 'zsh', 'node', 'tsx', 'ts-node', 'python', 'python3', 'ruby', 'deno']);

/** 腳本內容掃描的最大遞迴深度（腳本執行腳本；再深就交給環境隔離兜底）。 */
const MAX_SCRIPT_SCAN_DEPTH = 2;
/** 只讀合理大小的腳本，避免把大檔整個吞進記憶體。 */
const MAX_SCRIPT_SCAN_BYTES = 256 * 1024;

/**
 * `bash foo.sh` / `node tool.js` → 讀出那個檔案的內容供掃描。
 * 讀不到（不存在、太大、動態產生）就回 undefined —— 不擋，交給環境隔離那層。
 */
function readScriptTarget(tokens: string[], cwd?: string): string | undefined {
  const head = commandName(tokens[0]);
  if (!SCRIPT_RUNNERS.has(head)) return undefined;
  const target = tokens.slice(1).find((t) => !t.startsWith('-'));
  if (!target) return undefined;
  const path = isAbsolute(target) ? target : cwd ? join(cwd, target) : undefined;
  if (!path) return undefined;
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_SCRIPT_SCAN_BYTES) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined; // 讀不到就算了：這只是次防線
  }
}

/** script 名稱是否是部署用途：`deploy` / `deploy:prod` / `build:deploy` 算，`predeploy` 不算。 */
export function isDeployScriptName(name: string): boolean {
  const n = name.trim().replace(/^['"]|['"]$/g, '');
  if (n === '') return false;
  return n.split(':').includes('deploy') || /^deploy([^a-z].*)?$/i.test(n);
}

/** token 是否含 deploy 子指令（涵蓋 `hosting:channel:deploy` 這種冒號串接）。 */
const hasDeployWord = (t: string): boolean => !t.startsWith('-') && t.split(':').includes('deploy');

/** 取 npm/yarn/pnpm/bun 實際要跑的 script 名（`yarn deploy` 沒有 run 也算）。 */
function packageManagerScript(tokens: string[]): string | undefined {
  const args = tokens.slice(1);
  const runIdx = args.findIndex((t) => t === 'run' || t === 'run-script');
  const rest = runIdx >= 0 ? args.slice(runIdx + 1) : args;
  return rest.find((t) => !t.startsWith('-'));
}

/** git 的子指令（跳過 `-C dir`、`-c k=v` 這類全域旗標）。 */
function gitSubcommand(tokens: string[]): { sub?: string; args: string[] } {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--exec-path') {
      i += 2;
      continue;
    }
    if (t.startsWith('-')) {
      i += 1;
      continue;
    }
    break;
  }
  return { sub: tokens[i], args: tokens.slice(i + 1) };
}

/** 強制推送的各種寫法：--force / -f / 併寫短旗標 / `+refspec`（refspec 前綴 + 就是強推）。 */
function isForcePushArg(a: string): boolean {
  if (a === '--force' || a.startsWith('--force-with-lease') || a.startsWith('--force-if-includes')) return true;
  if (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) return true;
  return /^\+\S+/.test(a);
}

const isMainRef = (a: string): boolean => /^\+?(?:[^:]*:)?(?:refs\/heads\/)?(?:main|master)$/.test(a);
const isRemoteRef = (a: string): boolean => /^[\w.-]+\/[\w.\/-]+$/.test(a) && !a.startsWith('./') && !a.startsWith('../');

/** `rm -r -f` 且目標是絕對路徑/家目錄。 */
function isDangerousRm(tokens: string[]): boolean {
  const flags = tokens.filter((t) => t.startsWith('-'));
  const recursive = flags.some((f) => f === '--recursive' || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(f));
  const force = flags.some((f) => f === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f));
  if (!recursive || !force) return false;
  return tokens.slice(1).some((t) => !t.startsWith('-') && /^(?:\/|~|\$\{?HOME\}?)/.test(t));
}

const isDeployScriptFile = (t: string | undefined): boolean =>
  t !== undefined && /(?:^|\/)deploy[\w.-]*\.(?:sh|bash|zsh|py|rb|js|mjs|cjs|ts)$/i.test(t);

/** 單段指令的紅線判定（token 化後）。 */
/**
 * 「這是外部副作用，不歸 agent 管」的統一說法。
 *
 * 為什麼要在**工具層**擋而不是寫在 prompt：prompt 是軟約束——agent 可能忽略它，
 * 也可能被任務描述帶偏（例如任務寫著「請開 PR」）。外部副作用一旦發生就不可逆
 * （合併、刪 repo、推 main），只有 PreToolUse hook 這種程式層的硬擋才算數。
 */
const EXTERNAL_ACTION_REASON = '外部動作一律由調度器執行，agent 不得直接操作 GitHub 或推送';

/** git remote 的變更型子指令（唯讀的 -v / show / get-url 不受影響）。 */
const REMOTE_MUTATIONS = new Set(['add', 'set-url', 'remove', 'rm', 'rename', 'prune', 'set-branches', 'set-head']);

function evaluateCommandTokens(tokens: string[]): PolicyVerdict {
  const head = commandName(tokens[0]);
  const args = tokens.slice(1);

  // GitHub CLI 一律禁止（DESIGN §D20）。agent 沒有任何正當理由需要它：
  // 開 PR、合併、改設定全是調度器的職責，而 gh 能做的事全都是不可逆的外部副作用
  // —— `gh pr merge` 可直接繞過 Merge Guard、`gh repo delete` 能刪掉整個 repo。
  if (head === 'gh') {
    return { deny: true, reason: `紅線：${EXTERNAL_ACTION_REASON}（gh 由調度器執行，你不需要也不可以用）` };
  }

  if (head === 'git') {
    const git = gitSubcommand(tokens);
    // push 是外部副作用：分支要不要推、什麼時候推，由 PrManager 決定。
    // 開放給 agent 的話，它可以直接 `git push origin main` 把整條 PR/守衛流程跳過。
    if (git.sub === 'push') {
      return { deny: true, reason: `紅線：${EXTERNAL_ACTION_REASON}（git push 由調度器執行）` };
    }
    // 改 remote 等於把成果推去別的地方（或讓後續 push 指向非預期的 repo）
    if (git.sub === 'remote' && git.args.some((a) => REMOTE_MUTATIONS.has(a))) {
      return { deny: true, reason: '紅線：禁止變更 git remote（會讓成果被推往非預期的 repo）' };
    }
    if (git.sub === 'reset' && git.args.includes('--hard') && git.args.some(isRemoteRef)) {
      return { deny: true, reason: '紅線：禁止 hard reset 到遠端（可能丟失工作）' };
    }
  }

  if (head === 'rm' && isDangerousRm(tokens)) {
    return { deny: true, reason: '紅線：禁止對絕對/家目錄執行 rm -rf' };
  }

  // 部署紅線：專案綁部署，嚴禁任何實際部署指令
  if (head === 'firebase' && args.some(hasDeployWord)) {
    return { deny: true, reason: '紅線：禁止 firebase deploy（專案綁部署）' };
  }
  if (PACKAGE_MANAGERS.has(head)) {
    const script = packageManagerScript(tokens);
    if (script !== undefined && PUBLISH_WORDS.has(script)) {
      return { deny: true, reason: `紅線：禁止發布套件（${head} ${script}）` };
    }
    if (script !== undefined && isDeployScriptName(script)) {
      return { deny: true, reason: `紅線：禁止執行 deploy script（專案綁部署）：${head} ${script}` };
    }
  }
  if (ALWAYS_DEPLOY_CLIS.has(head)) {
    return { deny: true, reason: `紅線：禁止雲端部署指令（${head}）` };
  }
  if (DEPLOY_CLIS.has(head)) {
    const deployish =
      args.some(hasDeployWord) ||
      args.some((a) => PUBLISH_WORDS.has(a)) ||
      args.includes('--prod') ||
      args.includes('--production');
    // 裸跑 vercel 等同 `vercel deploy`
    if (deployish || (head === 'vercel' && args.length === 0)) {
      return { deny: true, reason: `紅線：禁止雲端部署指令（${head}）` };
    }
  }
  if (head === 'make' && args.some((a) => !a.startsWith('-') && isDeployScriptName(a))) {
    return { deny: true, reason: '紅線：禁止執行 deploy target（make deploy）' };
  }
  if (isDeployScriptFile(tokens[0]) || (SCRIPT_RUNNERS.has(head) && isDeployScriptFile(tokens[1]))) {
    return { deny: true, reason: `紅線：禁止執行部署腳本（${tokens[0]} ${tokens[1] ?? ''}）`.trim() };
  }

  return { deny: false };
}

/**
 * 一整條 shell 指令列的紅線判定（拆段 → 逐段 token 判定 → 保護路徑目標）。
 * 也給 package.json script 內容檢查重用（那些字串最終也是被 shell 執行的）。
 */
export function evaluateCommandRedline(
  cmd: string,
  policy: ResolvedToolPolicy = resolveToolPolicy(),
  cwd?: string,
): PolicyVerdict {
  return scanCommand(cmd, policy, true, cwd);
}

/**
 * @param checkManifestWrites 是否連「用 shell 覆寫 package.json」也檢查 script 內容。
 *   由 evaluateManifestWrite 內部呼叫時關掉，避免兩者互相遞迴。
 */
function scanCommand(
  cmd: string,
  policy: ResolvedToolPolicy,
  checkManifestWrites: boolean,
  cwd?: string,
  depth = 0,
): PolicyVerdict {
  if (cmd.trim() === '') return { deny: false };
  const { commands, sources } = decomposeShellCommand(cmd);
  for (const tokens of commands) {
    const verdict = evaluateCommandTokens(tokens);
    if (verdict.deny) return verdict;

    // 「先寫腳本再執行」的直接情形：`bash deploy.sh` 這串字面上沒有任何紅線關鍵字，
    // 但檔案內容有。讀得到就用同一套規則掃一次。
    // 注意這**擋不完**（內容可動態產生、可 base64、可再包一層），真正的底線是
    // agent 子行程根本拿不到 GitHub 認證（見 buildAgentEnv）——這裡只是提高門檻。
    if (depth < MAX_SCRIPT_SCAN_DEPTH) {
      const content = readScriptTarget(tokens, cwd);
      if (content !== undefined) {
        const inner = scanCommand(content, policy, checkManifestWrites, cwd, depth + 1);
        if (inner.deny) return { deny: true, reason: `${inner.reason}（來自被執行的腳本內容）` };
      }
    }
  }
  // 繞過 Write/Edit 走 shell 刪除或覆寫保護路徑（如 `rm .env`、`echo x > .github/workflows/ci.yml`）
  for (const source of sources) {
    for (const target of bashWriteTargets(source)) {
      const hit = findProtectedHit(target, policy);
      if (hit) return { deny: true, reason: `紅線：禁止以指令刪除/覆寫保護路徑（${hit.label}）：${target}` };
      // `echo '{...}' > package.json` 一樣能塞部署指令進 script，走 Write/Edit 以外的路也要檢查
      if (checkManifestWrites && isManifestPath(target)) {
        const verdict = evaluateManifestWrite(target, { content: source }, false);
        if (verdict.deny) return verdict;
      }
    }
  }
  return { deny: false };
}

// ── package.json script 紅線（DoD 驗證器會以 shell 實跑這些 script） ──
//
// 失敗情境：agent 把 `build` 改成 `vite build && firebase deploy`，Verifier 跑 `npm run build`
// 就觸發真實部署——工具層的部署紅線被整個繞過。所以寫入 package.json 時要看 script 內容。
// 只檢查「非 deploy 名稱」的 script：專案本來就有的 `deploy` script 不會被 Verifier 執行，
// 擋它只會妨礙正常維護；被塞進 build/test/prepare 這類會被跑到的 script 才是攻擊面。

const MANIFEST_GLOBS = ['**/package.json'];

/** 從工具輸入取出「這次會寫進 package.json 的 name → command」候選。 */
function collectScriptChanges(toolInput: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const content = toolInput.content;
  if (typeof content === 'string') {
    const parsed = tryParseJson(content);
    if (parsed !== undefined) {
      const scripts = parsed.scripts;
      if (typeof scripts === 'object' && scripts !== null) {
        for (const [k, v] of Object.entries(scripts as Record<string, unknown>)) {
          if (typeof v === 'string') out.push([k, v]);
        }
      }
      return out; // 合法 JSON：只有 scripts 會被 Verifier 執行，其餘欄位不必掃
    }
    // JSON 壞掉（agent 寫到一半/含註解）就退回字面掃描，不能因為解析失敗就放行
    return extractJsonPairs(content);
  }

  const edits: unknown[] = Array.isArray(toolInput.edits) ? toolInput.edits : [];
  const news = [toolInput.new_string, ...edits.map((e) => (e as Record<string, unknown> | null)?.new_string)];
  for (const n of news) {
    if (typeof n !== 'string' || n.trim() === '') continue;
    const pairs = extractJsonPairs(n);
    // 片段裡看不到 "key": "value" 時（例如只改 value），整段當成指令內容檢查
    if (pairs.length > 0) out.push(...pairs);
    else out.push(['', n]);
  }
  return out;
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** 從 JSON 片段抽 `"key": "value"` 配對（value 會還原跳脫）。 */
function extractJsonPairs(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of text.matchAll(/"([\w.:@/-]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const key = m[1]!;
    const raw = m[2]!;
    let value = raw;
    try {
      value = JSON.parse(`"${raw}"`) as string;
    } catch {
      /* 還原失敗就用原字串，反正只是拿去比對 */
    }
    out.push([key, value]);
  }
  return out;
}

const isManifestPath = (p: string): boolean => MANIFEST_GLOBS.some((g) => matchGlob(p.replace(/^\.\//, ''), g));

/** 寫入 package.json 時的 script 內容紅線。非 package.json 一律放行。 */
export function evaluateManifestWrite(
  target: string,
  toolInput: Record<string, unknown>,
  checkManifestWrites = true,
): PolicyVerdict {
  const path = target.replace(/^\.\//, '');
  if (!isManifestPath(path)) return { deny: false };

  for (const [name, command] of collectScriptChanges(toolInput)) {
    if (isDeployScriptName(name)) continue; // 既有的 deploy script 不是攻擊面（Verifier 不會跑它）
    const verdict = scanCommand(command, resolveToolPolicy(), checkManifestWrites);
    if (!verdict.deny) continue;
    const where = name === '' ? 'script' : `"${name}" script`;
    return {
      deny: true,
      reason: `紅線：禁止在 ${path} 的 ${where} 中植入危險指令（${verdict.reason?.replace(/^紅線：/, '') ?? '危險指令'}）：${command}`,
    };
  }
  return { deny: false };
}

/** 工具政策判定（紅線 deny-list）。純函式，供 PreToolUse hook 與單元測試共用。 */
export function evaluateToolPolicy(
  toolName: string,
  toolInput: Record<string, unknown>,
  options?: ToolPolicyOptions,
  cwd?: string,
): PolicyVerdict {
  const policy = resolveToolPolicy(options);

  // 工具白名單。SDK 的 allowedTools 對工具不具強制力（實跑證實規劃 agent
  // 用了 9 次 Bash，儘管 allowedTools 只列 Read/Glob/Grep），所以要在這裡強制。
  if (policy.allowTools && !policy.allowTools.has(toolName)) {
    return { deny: true, reason: `紅線：這個工具不在允許清單內：${toolName}。` };
  }

  // 唯讀角色：判斷者不該有改東西的能力。它們的 cwd 是使用者真正的 checkout。
  if (policy.mode === 'readonly') {
    if (WRITE_TOOLS.has(toolName)) {
      return { deny: true, reason: `紅線：唯讀角色不可以修改檔案（${toolName}）。你的職責是判斷，不是動手改東西。` };
    }
    if (toolName === 'Bash') {
      const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
      const ro = evaluateReadonlyCommand(cmd);
      if (ro.deny) return ro;
      // 通過唯讀白名單之後，仍要走既有的紅線（部署、強推 main…）——那些是硬邊界
      return evaluateCommandRedline(cmd, policy, cwd);
    }
  }

  if (WRITE_TOOLS.has(toolName)) {
    const target = writeTargetPath(toolInput);
    if (target === undefined) return { deny: false }; // 沒有路徑就沒得判，交給 SDK 自己報錯
    const hit = findProtectedHit(target, policy);
    if (hit) return { deny: true, reason: `紅線：禁止修改保護路徑（${hit.label}）：${target}` };
    return evaluateManifestWrite(target, toolInput);
  }

  if (toolName === 'Bash') {
    const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
    return evaluateCommandRedline(cmd, policy, cwd);
  }

  // 瀏覽器工具的紅線。
  //
  // **不能依賴 SDK 的 allowedTools。** 實跑證實：`browser_run_code_unsafe` 沒有列進
  // allowedTools，agent 照樣呼叫成功了（工具使用紀錄裡看得到）。也就是說那份清單
  // 對 MCP 工具是**建議而非強制**。唯一可靠的攔截點是這個 PreToolUse hook——
  // 它在工具真正執行前被呼叫，而且是我們自己的程式碼。
  //
  // 這裡是 **deny-list**：只擋 DENIED_BROWSER_TOOLS 列的，其餘（含 Playwright
  // 日後新增的）一律放行。理由見那個常數的說明——這個角色已經有 Bash，
  // 白名單擋不到實質東西，只會默默擋掉它的 DoD 驗證。
  if (toolName.startsWith('mcp__playwright__')) {
    if (DENIED_BROWSER_TOOLS.has(toolName)) {
      return {
        deny: true,
        reason:
          `紅線：${toolName} 在 Playwright server 的 Node 行程裡執行任意程式碼` +
          `（官方標示 RCE-equivalent），會整個繞過部署紅線與指令層檢查。` +
          `要設 viewport 用 browser_resize、要帶 cookie 用 browser_evaluate、` +
          `要拖曳用 browser_drag / browser_drop。`,
      };
    }
    const url = typeof toolInput.url === 'string' ? toolInput.url : '';
    if (/^\s*file:/i.test(url)) {
      return { deny: true, reason: `紅線：禁止用瀏覽器開啟本機檔案：${url}` };
    }
  }
  return { deny: false };
}
