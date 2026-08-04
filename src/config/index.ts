import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { VisualGateConfig } from '../worker/verifier.js';

// ── Schema（對映 config/*.example.yaml） ──
// 註：這裡的每個欄位都必須有人讀。設定「存在但沒人讀」比沒有設定更糟——
//     使用者會以為自己已經設定好了（例如 commands.install / reviewers 就是因此被移除）。
const CommandsSchema = z
  .object({
    // DoD 的 typecheck 關卡（DESIGN §5）。未設 → 該關卡整段跳過（不是綠燈，是沒跑）
    typecheck: z.string().optional(),
    build: z.string().optional(),
    test: z.string().optional(),
    lint: z.string().optional(),
    devServer: z.string().optional(),
    devPort: z.number().optional(),
  })
  .prefault({}); // zod v4：prefault 才會套用內層欄位預設（default 會短路）

// 視覺驗證（DoD 的視覺關卡）。dev server 指令/埠沿用 commands.devServer/devPort，
// 這裡只描述「要驗哪些頁面、用什麼門檻、截圖放哪」。
const VisualBreakpointSchema = z.object({
  name: z.string(),
  width: z.number(),
  height: z.number(),
});
const VisualSchema = z
  .object({
    // 空陣列 = 這個專案不做視覺驗證（完全不啟瀏覽器）
    routes: z.array(z.string()).default([]),
    when: z.enum(['auto', 'always', 'never']).default('auto'),
    categories: z.array(z.string()).default(['design']),
    breakpoints: z.array(VisualBreakpointSchema).optional(),
    // 截圖/基準都必須放 worktree 外，否則會被算進 git diff 污染 PR
    screenshotRoot: z.string().default('./data/screenshots'),
    baselineRoot: z.string().optional(),
    browserChannel: z.string().optional(),
    serverReadyTimeoutMs: z.number().optional(),
    navTimeoutMs: z.number().optional(),
    settleMs: z.number().optional(),
    // 量測用的旋鈕（maxDiffRatio / pixelTolerance / updateBaseline / maxElements /
    // thresholds）隨截圖比對與版面稽核堆疊一起退場（第 15 片）。它們從來沒有出現在
    // 控制台的表單上，只有量測程式在讀——那些程式已經不存在了。
  })
  .prefault({});

/**
 * MCP 端點。支援 stdio（spawn 子行程）與 http（Streamable HTTP）。
 *
 * 這裡刻意在 schema 層就把「設了但不可能運作」的組合擋掉並丟出清楚訊息：
 * 過去 stdio 會在 main 被靜默略過、http 少了 url 也只留一行 warn，
 * 結果是「照範例設定卻得到空轉的 daemon」——設定錯誤必須吵，不能安靜。
 */
const McpSchema = z
  .object({
    transport: z.enum(['stdio', 'sse', 'http']).default('stdio'),
    command: z.string().optional(), // stdio：要執行的程式
    args: z.array(z.string()).optional(),
    url: z.string().optional(), // http：端點 URL
    token: z.string().optional(), // http transport 的 Bearer token
    env: z.record(z.string(), z.string()).optional(), // zod v4：record 需 (key, value)
  })
  .superRefine((m, ctx) => {
    if (m.transport === 'sse') {
      ctx.addIssue({
        code: 'custom',
        path: ['transport'],
        message: 'mcp.transport: 尚未支援 sse，請改用 http（Streamable HTTP）或 stdio',
      });
      return;
    }
    if (m.transport === 'http' && !m.url) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'mcp.transport=http 必須設定 mcp.url' });
    }
    if (m.transport === 'stdio' && !m.command) {
      ctx.addIssue({ code: 'custom', path: ['command'], message: 'mcp.transport=stdio 必須設定 mcp.command' });
    }
  });

export const ProjectSchema = z.object({
  id: z.string(),
  repo: z.string(), // owner/name，必須與任務板上的 task.repo 一致
  repoPath: z.string(),
  /**
   * 群組分支要從哪條分支長出來、PR 要發往哪裡。
   * 未設 → 啟動時偵測 remote HEAD（origin/HEAD），偵測不到再退回 main/master/目前分支。
   * 寫死 'main' 會讓預設分支不是 main 的專案連 worktree 都建不起來，整群永遠卡在 forming。
   */
  baseBranch: z.string().optional(),
  /** 覆寫 orchestrator.poll.mine（有些 MCP 的「指派」語意不同時才需要）。 */
  pollMine: z.boolean().optional(),
  /**
   * 要從主 clone 帶進每個 worktree 的本機設定檔。
   *
   * 為什麼需要：`git worktree add` 只帶版控裡的檔案，而本機設定檔（`.env` 之類）
   * 依慣例被 gitignore——於是 worktree 是個「跑不起來的專案」：dev server 起得來，
   * app 卻掛不起來，畫面驗證變成在驗證一張空白頁，agent 想自己跑起來看也一樣撞牆。
   *
   * 未設 → 用預設清單（.env / .env.local / .env.development / .npmrc），不存在的自動略過。
   * **設成空陣列 → 一個都不帶**：真的把伺服器密鑰放在開發用 .env 的專案這樣設，
   * 代價是那個專案的視覺驗證會失敗並講明原因（比靜默用空白頁驗證誠實）。
   */
  localFiles: z.array(z.string()).optional(),
  /**
   * 覆寫 orchestrator.commandTimeoutSec：這個專案的 DoD 關卡指令最多能跑多久。
   * 大型 monorepo 的 build/test 常比預設久，逾時會讓關卡判紅並回灌「逾時」給 agent，
   * agent 只會白費力氣改程式（問題其實在時間不夠）。非正數視為未設。
   */
  commandTimeoutSec: z.number().optional(),
  /**
   * 靜置期分鐘數：這個專案的任務板要多久沒有新增/編輯任務，才開始分群開工。
   * 未設 → 15 分鐘（DEFAULT_QUIET_MINUTES）。設 0 → 關閉（抓到就做）。
   *
   * 存在的理由：人建立同系列任務會有時間差，沒有這段等待就會抓到半套任務做出半成品 PR。
   */
  quietPeriodMinutes: z.number().optional(),
  mcp: McpSchema,
  commands: CommandsSchema,
  visual: VisualSchema,
});

/** 「無需改動」宣告的處置：ask=park 等人確認（安全預設）、auto_complete=直接結案。 */
const NoChangeDisposition = z.enum(['ask', 'auto_complete']);

/**
 * 模型別名。**刻意不接受版本號**：寫 opus 就永遠是最新的 opus，
 * 寫 claude-opus-5 的話出了新版還會停在舊的，而且沒有任何地方會提醒你。
 */
export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku'] as const;
export type ModelAliasName = (typeof MODEL_ALIASES)[number];
const ModelAlias = z.enum(MODEL_ALIASES);

/**
 * 調度器設定。**ledgerPath 與 lockPath 不在這裡**——它們必須在開 DB 之前就知道，
 * 而這份設定就住在那個 DB 裡（見 config/bootstrap.ts）。其餘全部由控制台管理。
 */
export const OrchestratorSchema = z.object({
  pollIntervalSec: z.number().default(30),
  maxConcurrentWorkers: z.number().default(3),
  /**
   * 收到停止訊號後，最多等進行中群組收尾幾秒。
   *
   * 逾時的處置**不是**「照樣關閉」：ledger 不關、實例鎖不釋放，改在鎖檔寫入 unclean 標記
   * （見 main.ts 的 createShutdown）。因為 D10 不設 turn 上限，一次 agent 執行超過這個秒數
   * 是常態，若釋放了鎖，下一個實例會把還在被寫入的 worktree force-remove 掉。
   */
  shutdownGraceSec: z.number().default(120),
  /**
   * 收尾逾時後，行程若還沒自然結束（被 in-flight 的 agent 撐著），最多再等幾秒就強制退出。
   * 0 或負數 = 不強制（等 launchd 的 SIGKILL）。此時鎖已標記且保留，強制退出不會造成誤刪。
   */
  shutdownForceExitSec: z.number().default(15),
  /**
   * 上次收尾沒收乾淨（鎖檔留有 unclean 標記）時，這次開機的對帳要多保守。
   *   conservative（預設）＝ 只記錄決策不動手：那些 worktree 可能還有被 orphan 的 agent 在寫，
   *                          破壞性清理會刪掉還沒 commit 的成果（D15／D18）。
   *   full               ＝ 照常完整對帳。**確定沒有殘留 agent 行程時**（例如整台機器重開過）
   *                          才該用；也可用環境變數 ORCH_FORCE_RECONCILE=1 一次性覆寫。
   */
  reconcileAfterUncleanShutdown: z.enum(['conservative', 'full']).default('conservative'),
  /**
   * DoD 關卡指令（typecheck/lint/build/test）的執行逾時，全域預設 10 分鐘。
   * 沒有逾時的話，一個 hang 住的 test/build（等待輸入、watch 模式、等不到的 port）
   * 會永遠凍住監督迴圈，而且沒有任何人會來救它。每專案可用 commandTimeoutSec 覆寫。
   */
  commandTimeoutSec: z.number().default(600),
  /** 輪詢行為。mine 預設 true：撿到別人的任務會因為認領不到而拖垮整群。 */
  poll: z.object({ mine: z.boolean().default(true) }).prefault({}),
  /**
   * 系統可不可以自己合併（需求 7 的最後一哩）。
   *
   * 關掉＝一群做完照樣推分支、開 PR、跑 Merge Guard，只是最後那一步等你自己按。
   * 打開＝審查通過且政策放行後由系統合併。預設關閉：合併會改動 base 分支，
   * 那是唯一不可逆的動作，要明示同意。
   * 環境變數 ORCH_LOCAL_MERGE（1/0）可臨時覆寫，方便除錯。
   *
   * ── 為什麼沒有「不開 PR」的開關 ──
   * 這裡原本還有一個 openPr。它想給的安全（別動到正式 repo）用「專案本身就指向複本」
   * 就達成了（repo 與 repoPath 都指複本），所以它是重複的保險；而它的代價是一整條
   * 「跑完全部關卡卻無處可去」的路：實跑撞到過——一個 openPr=false 的專案
   * 一路跑到「人按了核准」，然後沒有任何程式路徑可以合併，群組永遠停在那裡，
   * 連帶把依賴它的下一群一起卡住。不開 PR 就沒有審查（審查是掛在 PR 上的），
   * 那條路本來就走不完，不該存在。
   */
  allowLocalMerge: z.boolean().default(false),
  noProgress: z.object({ rounds: z.number().default(3) }).prefault({}),
  /**
   * agent 宣告「本任務無需改動」時的處置（見 worker.ts 的 NoChangePolicy）。
   * 預設全 ask：complete_task 不可逆，而且「這任務不用做」通常是任務板有問題的訊號，
   * 該讓人看到而不是自動吞掉。
   */
  noChange: z
    .object({
      already_satisfied: NoChangeDisposition.default('ask'),
      not_applicable: NoChangeDisposition.default('ask'),
      blocked_externally: NoChangeDisposition.default('ask'),
      spec_unclear: NoChangeDisposition.default('ask'),
    })
    .prefault({}),
  slack: z
    .object({
      enabled: z.boolean().default(false),
      botToken: z.string().optional(),
      appToken: z.string().optional(),
      channel: z.string().default('#dev-orchestrator'),
    })
    .prefault({}),
  /**
   * Claude 認證。放這裡而不是只讀環境變數的理由與其他設定相同：控制台要改得動，
   * 而且改完要立刻生效——agent 每次執行都會現拿，所以換 token 不必重啟 daemon。
   * 留空則沿用行程環境變數（ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL），
   * 既有安裝不會因為這個欄位出現而突然失去認證。
   */
  /**
   * 花費上限（美金）。0 或未設 = 不限制。
   *
   * 為什麼需要：這個系統設計上不限制單次執行的 turn／token（D10），所以「跑掉了」
   * 的代價不是一次貴，而是**沒有人踩煞車**。半夜一個迴圈可以燒掉一整天的預算。
   * 上限是硬煞車，warnAtPercent 是提早喊的那一聲。
   */
  /**
   * 待處理事項的提醒間隔（分鐘）。0 = 關閉。
   *
   * 為什麼需要：核准請求、澄清問題都是**發生當下推一次**。那一則沒被看到
   * （Slack 剛好斷線、daemon 在那一秒重啟、人當下沒注意），就再也沒有人會提起——
   * 群組安靜地卡住，而卡住的東西不會自己叫。這是這個系統最該避免的失敗形態。
   */
  pendingReminderMinutes: z.number().default(30),
  budget: z
    .object({
      dailyUsd: z.number().optional(),
      weeklyUsd: z.number().optional(),
      monthlyUsd: z.number().optional(),
      /** 用到幾成時發通知（預設 80）。同一個週期同一個門檻只會通知一次。 */
      warnAtPercent: z.number().default(80),
    })
    .prefault({}),
  agent: z
    .object({
      authToken: z.string().optional(),
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
        /**
         * 各角色用哪個模型。**只寫別名、不帶版本號**（opus / sonnet / haiku）——
         * 帶版本的話每次出新版都要回來改設定，而且會靜靜地停在舊模型上。
         * 留空＝用 SDK 預設。
         *
         * 為什麼分角色：六種 agent 的工作難度差很多。寫程式與 reviewer 要讀懂整份規格
         * 與 diff；合併風險判斷者只回答「這個改動可不可逆」。全部跑同一個最貴的模型，
         * 成本會花在判斷不出差別的地方。
         */
        models: z
          .object({
            coder: ModelAlias.optional(),
            reviewer: ModelAlias.optional(),
            planner: ModelAlias.optional(),
            driftJudge: ModelAlias.optional(),
            riskJudge: ModelAlias.optional(),
            /**
             * @deprecated 介面判斷者已於第 15 片退場（畫面改由審查者自己開瀏覽器判斷）。
             *
             * 欄位**保留**而不是刪掉：正式 DB 的 settings JSON 裡已經有這個鍵，
             * zod 預設會把未知欄位剝掉，於是「使用者設過的值」在下一次存檔時被靜默丟棄。
             * 留著讓它原樣進出，沒有人讀它——比「悄悄改掉使用者的設定」好。
             */
            uiJudge: ModelAlias.optional(),
          })
          .prefault({}),
    })
    .prefault({}),
  // 啟動時灌進 GH_TOKEN/GITHUB_TOKEN，供 gh 子行程（開 PR / 讀審查）使用；
  // 環境變數已有值時不覆蓋（外部注入優先）。
  github: z.object({ token: z.string().optional() }).prefault({}),
});

export type ProjectConfig = z.infer<typeof ProjectSchema>;
export type OrchestratorConfig = z.infer<typeof OrchestratorSchema>;
export interface AppConfig {
  orchestrator: OrchestratorConfig;
  projects: ProjectConfig[];
}

/**
 * 專案設定 → Verifier 的視覺關卡設定。
 * 沒設 commands.devServer 就回 undefined（VerifierConfig.visual 留空 = 永不啟瀏覽器）。
 */
export function visualGateConfigOf(p: ProjectConfig): VisualGateConfig | undefined {
  if (!p.commands.devServer) return undefined;
  const v = p.visual;
  // 量測用的旋鈕（maxDiffRatio / pixelTolerance / updateBaseline / maxElements）
  // 隨截圖比對堆疊一起退場（第 15 片）。留下的都是「審查者要導到哪裡、看多寬」。
  return {
    devServer: p.commands.devServer,
    ...(p.commands.devPort === undefined ? {} : { devPort: p.commands.devPort }),
    ...(v.routes ? { routes: v.routes } : {}),
    ...(v.when ? { when: v.when } : {}),
    ...(v.categories ? { categories: v.categories } : {}),
    ...(v.breakpoints ? { breakpoints: v.breakpoints } : {}),
    ...(v.screenshotRoot ? { screenshotRoot: v.screenshotRoot } : {}),
    ...(v.baselineRoot ? { baselineRoot: v.baselineRoot } : {}),
  };
}

/** 將 YAML 內的 ${ENV_VAR} 以環境變數展開（缺值則為空字串）。 */
function interpolateEnv(raw: string): string {
  return raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => process.env[key] ?? '');
}

/** 遞迴移除 null 值（環境變數缺值時 `key: ${MISSING}` 會被 YAML 解析成 null，視為未設）。 */
function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null) continue;
      out[k] = stripNulls(val);
    }
    return out;
  }
  return v;
}

function loadYaml(path: string): unknown {
  return stripNulls(parseYaml(interpolateEnv(readFileSync(path, 'utf8'))));
}

/**
 * 不展開 `${VAR}` 的原始讀取。給 yaml→DB 遷移用。
 *
 * 為什麼遷移**不能**用展開後的值：那會把 .env 裡的密鑰複製一份到 DB。
 * 一來使用者沒要求把密鑰搬家，二來遷移當下若沒載入 .env，展開的結果會是空字串——
 * 於是 token 悄悄變成空的，daemon 下次啟動才會以「連不上 MCP」的形式爆出來。
 * 保留 `${VAR}` 字面值，讀取時再展開，行為與原本完全相同。
 */
export function loadRawConfig(baseDir = process.cwd()): { orchestrator: unknown; projects: unknown[] } {
  const orchPath = resolve(baseDir, 'config/orchestrator.yaml');
  const projPath = resolve(baseDir, 'config/projects.yaml');
  const raw = (p: string): unknown => stripNulls(parseYaml(readFileSync(p, 'utf8')));
  const orchestrator = existsSync(orchPath) ? raw(orchPath) : {};
  const parsed = existsSync(projPath) ? (raw(projPath) as { projects?: unknown[] }) : undefined;
  return { orchestrator: orchestrator ?? {}, projects: parsed?.projects ?? [] };
}

/**
 * 從 config/*.yaml 載入設定。
 *
 * **已不是執行期路徑**：設定的事實源是 SQLite（見 config/store.ts）。
 * 這個函式只剩一個用途——把舊安裝的 yaml 一次性匯入 DB（migrateYamlIfPresent），
 * 匯入後 yaml 就會被刪掉。保留它是為了不讓既有使用者的設定憑空消失。
 */
export function loadConfig(baseDir = process.cwd()): AppConfig {
  const orchPath = resolve(baseDir, 'config/orchestrator.yaml');
  const projPath = resolve(baseDir, 'config/projects.yaml');

  const orchestrator = OrchestratorSchema.parse(existsSync(orchPath) ? loadYaml(orchPath) : {});

  let projects: ProjectConfig[] = [];
  if (existsSync(projPath)) {
    const parsed = loadYaml(projPath) as { projects?: unknown[] } | undefined;
    projects = z.array(ProjectSchema).parse(parsed?.projects ?? []);
  }

  return { orchestrator, projects };
}
