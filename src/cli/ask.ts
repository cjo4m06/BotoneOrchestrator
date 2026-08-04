/**
 * 本機互動 CLI：不透過 Slack 也能回覆 daemon 的提問。
 *
 * 為什麼需要它：Slack 原本是**唯一**的人機介面，沒設定 Slack 時 ConsoleGateway 只會寫 log，
 * 入站回呼永遠不會被觸發 —— 任何需要澄清／確認的任務都會永久 park。這條 CLI 補上第二個入口。
 *
 * 關鍵設計：**不是第二套邏輯**。所有裁決都走與 Slack 相同的 InboundRouter
 * （handleAnswer / handleControl / handleMergeDecision），差別只在入口。
 * CLI 直接讀寫 ledger（SQLite WAL 支援多進程），daemon 下一輪 tick 就會撿到，
 * 因此 **daemon 不需要在跑** 也能先把答案填好。
 *
 * 用法：
 *   npm run ask                    列出所有等人處理的事項
 *   npm run ask -- status          現在在做什麼（任務/群組狀態、靜置期倒數）
 *   npm run ask -- cost            花了多少（今天／近 7 天／全部＋最貴的任務）
 *   npm run ask -- 1 固定底部       回答第 1 項（澄清）
 *   npm run ask -- T-1287 固定底部  也可以直接用 id（清單變動時較安全）
 *   npm run ask -- 1 --default     採用 agent 建議的預設
 *   npm run ask -- 2 confirm       確認「這張卡確實不用做」→ complete_task（不可逆，會再問一次）
 *   npm run ask -- 2 reject        你誤判了，回去做
 *   npm run ask -- 3 approve       核准合併
 *   npm run ask -- 3 deny          退回
 *   npm run ask -- 4 retry|abort   對卡住的任務下控制指令
 *   加 --yes 跳過不可逆操作的二次確認（腳本用）
 */
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { loadBootstrap } from '../config/bootstrap.js';
import { createMcpClient } from '../main.js';
import type { AppConfig, ProjectConfig } from '../config/index.js';
import { ConfigStore } from '../config/store.js';
import { loadEnv } from '../config/env.js';
import { Ledger } from '../store/ledger.js';
import { createLogger } from '../observability/logger.js';
import { PmmMcpClient, mcpResilienceFromEnv } from '../mcp/mcp-client.js';
import {
  InboundRouter,
  NO_CHANGE_BLOCK_PREFIX,
  NO_CHANGE_CATEGORY_LABEL,
  type CompleteTaskFn,
  type ExtendedControlCommand,
} from '../notify/notifier.js';
import type { Logger } from '../observability/logger.js';
import type { NoChangeCategory } from '../worker/agent-runtime.js';
import { DEFAULT_QUIET_MINUTES } from '../core/quiet-period.js';
import { evaluateBudget, periodLabel } from '../core/budget.js';
import {
  GROUP_STATES,
  TASK_STATES,
  formatCost,
  formatStatus,
  startOfToday,
  type CostInput,
  type StatusInput,
} from './report.js';
import type { RepoCost } from '../store/ledger.js';
import type { Group, Task } from '../types.js';

// 待處理事項的定義搬到 core/pending.ts（CLI／控制台／Slack 提醒共用同一份）
export { collectPending, type PendingItem, type PendingKind, type AskLedger } from '../core/pending.js';
import { collectPending, type PendingItem, type PendingKind } from '../core/pending.js';
import { FRICTION_EVENT, summarizeFriction, type FrictionSummary } from '../worker/friction.js';
export { summarizeFriction, type FrictionSummary } from '../worker/friction.js';

const ICON: Record<PendingKind, string> = {
  clarification: '❓',
  no_change: '🤔',
  reclaim_blocked: '🪪',
  needs_human: '🚧',
  merge_approval: '🔒',
  stuck_group: '⚠️',
};

const KIND_LABEL: Record<PendingKind, string> = {
  clarification: '澄清',
  no_change: '無需改動',
  reclaim_blocked: '認領不回來',
  needs_human: '待人工',
  merge_approval: '待核准',
  stuck_group: '卡住',
};

/** ledger 的唯讀子集（測試可注入假件）。 */

export function formatPending(items: PendingItem[]): string {
  if (items.length === 0) return '✅ 目前沒有需要你處理的事項。';
  const lines = [`共 ${items.length} 項等你處理：`, ''];
  items.forEach((it, i) => {
    const cat = it.category ? `${NO_CHANGE_CATEGORY_LABEL[it.category]} — ` : '';
    lines.push(`[${i + 1}] ${ICON[it.kind]} ${KIND_LABEL[it.kind]}  ${it.id}  ${it.title}`);
    lines.push(`    ${cat}${oneLine(it.detail)}`);
    if (it.evidence) lines.push(`    依據：${oneLine(it.evidence)}`);
    if (it.suggestion) lines.push(`    建議：${it.suggestion}`);
    lines.push(`    可用：${it.actions.join(' / ')}`);
    lines.push('');
  });
  lines.push('用法：npm run ask -- <編號或 id> <動作或答案>');
  lines.push('（daemon 在跑時清單會變動，用 id 指定較安全）');
  return lines.join('\n');
}

function oneLine(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 解析後的一次操作。 */
export interface AskAction {
  item: PendingItem;
  /** 標準化後的動作；freeText 代表「這是澄清的答案」。 */
  verb: 'answer' | 'confirm' | 'reject' | 'approve' | 'deny' | 'retry' | 'abort' | 'pause' | 'land-anyway';
  answer?: string;
}

/**
 * 把命令列參數對應到一個動作；不合法時回錯誤訊息（純函式，好測）。
 *
 * 目標可以是**編號**或**任務/群組 id**。id 優先且較安全：編號是列表當下的序位，
 * daemon 仍在跑時清單隨時會變，你看到的 [2] 可能在下指令那一刻已經是別的東西——
 * 這個誤操作在實測中真的發生過（本要處理某任務，卻核准了另一個群組的合併）。
 */
export function resolveAction(items: PendingItem[], target: string, rest: string[]): AskAction | string {
  const byId = items.find((it) => it.id === target);
  const idx = Number(target);
  const item =
    byId ??
    (Number.isInteger(idx) && idx >= 1 && idx <= items.length ? items[idx - 1] : undefined);
  if (!item) {
    return `找不到目標「${target}」——請用編號 1..${items.length} 或直接用 id（較安全，清單變動也不會指錯）`;
  }
  const raw = rest.join(' ').trim();

  if (raw === '--default' || raw === '') {
    if (item.kind !== 'clarification') return `${item.id} 需要明確動作：${item.actions.join(' / ')}`;
    if (!item.suggestion) return `${item.id} 沒有可用的建議預設，請直接打上你的答案`;
    return { item, verb: 'answer', answer: item.suggestion };
  }

  const known = ['confirm', 'reject', 'approve', 'deny', 'retry', 'abort', 'pause', 'land-anyway'] as const;
  const verb = known.find((k) => k === raw);
  if (verb) {
    if (!item.actions.includes(verb)) {
      return `${item.id} 不支援「${verb}」，可用：${item.actions.join(' / ')}`;
    }
    return { item, verb };
  }

  // `deny <要改什麼>`：退回並附上修改意見。沒有意見的退回等於只跟 agent 說「不行」
  // 卻不說哪裡不行，它下一輪多半原樣再送一次。
  // 只在這個項目**真的支援 deny** 時才攔截；否則「deny 開頭的自由文字」
  // （例如澄清的答案剛好以 deny 起頭）會被誤判成退回指令。
  const [head, ...tail] = raw.split(/\s+/);
  if (head === 'deny' && tail.length > 0 && item.actions.includes('deny')) {
    return { item, verb: 'deny', answer: tail.join(' ') };
  }
  // `land-anyway <為什麼這個紅不是這一群造成的>`。同樣只在支援時才攔截。
  if (head === 'land-anyway' && tail.length > 0 && item.actions.includes('land-anyway')) {
    return { item, verb: 'land-anyway', answer: tail.join(' ') };
  }

  // 其餘視為澄清答案
  if (item.kind !== 'clarification') {
    return `${item.id} 需要動作而非自由文字，可用：${item.actions.join(' / ')}`;
  }
  return { item, verb: 'answer', answer: raw };
}

/** 執行動作所需的協作者（測試可全部注入）。 */
export interface ApplyDeps {
  router: {
    handleAnswer(a: { taskId: string; threadTs: string; optionId?: string; freeText?: string }): void;
    handleControl(c: ExtendedControlCommand): Promise<void> | void;
    handleMergeDecision(d: { groupId: string; approved: boolean; userId?: string }): void;
    /** 把 failed 的群組放回待派工。沒有它的話 stuck_group 的 retry 是空操作。 */
    reviveGroup?(input: { groupId: string; userId?: string }): Promise<boolean>;
    /** 定案③：帶著一個已知的、非本群造成的紅落地。 */
    landAnyway?(input: { groupId: string; userId?: string; note: string }): Promise<boolean>;
  };
  /**
   * 回報動作後的實際狀態。InboundRouter 吞掉自己的錯誤（Slack 回呼不能 throw），
   * 所以呼叫端無法從回傳值得知成敗——不查證就印「已完成」會在 MCP 拒絕時**謊報成功**
   * （實測踩過：任務其實還 blocked，畫面卻說標記完成了）。
   */
  readTaskState?: (id: string) => { state: string; blockDetail?: string } | undefined;
  log: Logger;
}

/** 由誰下的指令（稽核用）。CLI 一律標成本機操作者。 */
const CLI_USER = 'cli';

/** 套用一個動作。回傳給使用者看的結果訊息。 */
export async function applyAction(action: AskAction, deps: ApplyDeps): Promise<string> {
  const { router } = deps;
  const { item, verb } = action;

  switch (verb) {
    case 'answer':
      // threadTs 用本機標記：Slack 那側靠它反查 thread，CLI 沒有 thread，但稽核仍要留下來源
      router.handleAnswer({ taskId: item.id, threadTs: `cli:${item.id}`, freeText: action.answer ?? '' });
      return `✅ 已回覆 ${item.id}：${action.answer}（任務回到排隊，daemon 下一輪會重跑）`;
    case 'confirm': {
      await router.handleControl({ type: 'confirm_no_change', taskId: item.id, userId: CLI_USER });
      // 查證實際結果再回報：MCP 可能拒絕（任務不存在／已被別人動過），此時任務會留在 blocked
      const after = deps.readTaskState?.(item.id);
      if (!after) return `✅ 已送出確認 ${item.id}（無法查證最終狀態，請用 npm run ask 再看一次）`;
      if (after.state === 'done') return `✅ 已確認 ${item.id} 無需改動 → complete_task 成功，任務已標記完成`;
      return (
        `❌ 確認未完成：${item.id} 仍是「${after.state}」\n` +
        `   原因：${after.blockDetail ?? '未知（請看 log）'}\n` +
        `   任務板上的卡沒有被關掉，狀態維持等待處理——修正後可再執行一次 confirm。`
      );
    }
    case 'reject':
      await router.handleControl({ type: 'retry', taskId: item.id, userId: CLI_USER, source: 'no_change_rejected' });
      return `✅ 已退回 ${item.id}：agent 會重新執行這個任務`;
    case 'approve':
      router.handleMergeDecision({ groupId: item.id, approved: true, userId: CLI_USER });
      return `✅ 已核准群組 ${item.id} 合併（daemon 會重跑 Merge Guard 後才實際合併）`;
    case 'deny':
      // 退回一定要帶理由：沒有的話 agent 只知道被退回，下一輪多半原樣再送一次
      router.handleMergeDecision({
        groupId: item.id, approved: false, userId: CLI_USER,
        ...(action.answer ? { reason: action.answer } : {}),
      });
      return action.answer
        ? `✅ 已退回群組 ${item.id}，意見已交給 agent：${action.answer}`
        : `⚠️ 已退回群組 ${item.id}，但沒有附意見 — agent 不知道要改什麼，很可能原樣再送一次。\n   下次請用：npm run ask -- ${item.id} deny <要改什麼>`;
    case 'land-anyway':
      // 定案③：「我知道這個紅，但它不是這一群造成的，照樣落地」。
      //
      // 為什麼要有這顆：系統**沒有修 base 的權力**。裁定「這是 base 的測試本來就不穩」
      // 之後這一群依然落不了地——會累積一批「已裁定非我方責任、但卡著」的群，
      // 堵住的張數與誤判時一模一樣，只是這次系統是對的。
      //
      // 這是**人的決定**（要不要帶著一個已知的紅上線），系統的職責是把證據攤在面前、
      // 按完之後留下痕跡，不是替人決定、也不是無限期堵著等人自己想起來。
      if (item.kind !== 'stuck_group') return `⚠️ 「照樣落地」只適用於卡住的群組`;
      {
        const ok = await router.landAnyway?.({
          groupId: item.id,
          userId: CLI_USER,
          note: action.answer ?? '（未附說明）',
        });
        return ok
          ? `✅ 群組 ${item.id} 已標記「知道這個紅、照樣落地」，理由與實驗證據已記進 ledger 與 PR 內文`
          : `⚠️ 這個環境沒有接上「照樣落地」（需要 daemon 在同一行程）`;
      }
    case 'retry':
      // **群組層級的失敗要用群組層級的復活。**
      //
      // stuck_group 的 id 是群組 id，而 handleControl 的 retry 做的是
      // `clearBlock(taskId, 'queued')`——對「任務都 done、只是收尾失敗」的群組
      // 完全無效（實跑撞到：待處理清單提供 retry，按了什麼都沒發生）。
      // 提供一個沒用的動作，比不提供更糟：人以為處理過了，實際上群組還躺在那裡。
      if (item.kind === 'stuck_group') {
        const ok = await router.reviveGroup?.({ groupId: item.id, userId: CLI_USER });
        return ok
          ? `✅ 群組 ${item.id} 已回到待派工，daemon 下一輪會重新收尾`
          : `❌ 無法復活群組 ${item.id}（可能已被清掉或狀態已改變），請用 npm run ask 再看一次`;
      }
      await router.handleControl({ type: verb, taskId: item.id, userId: CLI_USER });
      return `✅ 已對 ${item.id} 下達「${verb}」`;
    case 'abort':
    case 'pause':
      await router.handleControl({ type: verb, taskId: item.id, userId: CLI_USER });
      return `✅ 已對 ${item.id} 下達「${verb}」`;
  }
}

/** 需要二次確認的動作（不可逆）。 */
export function needsConfirmation(action: AskAction): boolean {
  // confirm 會呼叫 complete_task；MCP 沒有反 done 的工具（D4），誤按無法復原
  return action.verb === 'confirm';
}

/**
 * agent 回報的系統摩擦。
 *
 * 這是唯讀報表，**不做任何自動處置**：這些是 agent 的自我回報，可能是對的，
 * 也可能只是它不想做某件事。要不要動程式碼，由人看過證據再決定。
 * 讓 agent 自動改調度器是最容易「靜默地弄壞一切」的方向。
 */
export function frictionInput(
  ledger: { listEvents(q: { scope: 'task'; kind?: string; limit?: number }): { refId: string | null; detail?: string }[] },
  limit = 200,
): { taskId: string; detail?: string }[] {
  return ledger
    .listEvents({ scope: 'task', kind: FRICTION_EVENT, limit })
    .map((e) => ({ taskId: e.refId ?? '(unknown)', ...(e.detail ? { detail: e.detail } : {}) }));
}

export function formatFriction(s: FrictionSummary): string {
  if (s.total === 0) return '目前沒有任何 agent 回報系統摩擦。';
  const lines = [
    `agent 回報 ${s.total} 則（其中 ${s.blocked} 則實際擋住了工作）`,
    '',
    '分類：' + Object.entries(s.byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('  '),
    '',
  ];
  for (const r of s.recent) {
    lines.push(`${r.blocked ? '🚫' : '·'} [${r.kind}] ${r.taskId}${r.source ? ` (${r.source})` : ''}`);
    lines.push(`    ${oneLine(r.what)}`);
    if (r.evidence) lines.push(`    證據：${oneLine(r.evidence)}`);
    if (r.suggestion) lines.push(`    建議：${oneLine(r.suggestion)}`);
  }
  return lines.join('\n');
}

// ── 唯讀報表的取數（把 ledger 查詢與純函式格式化分開，格式化才測得到） ──

/** status 需要的全部資料。 */
export function statusInput(
  ledger: Pick<Ledger, 'listTasksByState' | 'listGroupsByState'>,
  config: { projects: { id?: string; repo: string; quietPeriodMinutes?: number }[] },
  now: number,
  costToday?: RepoCost[],
): StatusInput {
  const tasksByState = Object.fromEntries(
    TASK_STATES.map((s) => [s, ledger.listTasksByState(s)]),
  ) as StatusInput['tasksByState'];
  const groupsByState = Object.fromEntries(
    GROUP_STATES.map((s) => [s, ledger.listGroupsByState(s)]),
  ) as StatusInput['groupsByState'];
  return {
    tasksByState,
    groupsByState,
    quietMinutesOf: (repo) => {
      const p = config.projects.find((x) => x.repo === repo);
      return typeof p?.quietPeriodMinutes === 'number' ? p.quietPeriodMinutes : DEFAULT_QUIET_MINUTES;
    },
    projects: config.projects.map((p) => ({ repo: p.repo, ...(p.id ? { label: p.id } : {}) })),
    ...(costToday ? { costToday } : {}),
    now,
  };
}

/** cost 需要的全部資料。 */
export function costInput(
  ledger: Pick<Ledger, 'costSummary' | 'costByTask' | 'getTask'>,
  now: number,
  budget?: CostInput['budget'],
): CostInput {
  return {
    total: ledger.costSummary(),
    today: ledger.costSummary(startOfToday(now)),
    last7d: ledger.costSummary(now - 7 * 24 * 60 * 60 * 1000),
    topTasks: ledger.costByTask(10),
    titleOf: (id) => ledger.getTask(id)?.title,
    ...(budget ? { budget } : {}),
  };
}

// ── 進入點 ──

async function main(): Promise<void> {
  // CLI 是互動工具：daemon 的 info log 會把待辦清單沖散。預設只留 error，
  // 需要診斷時用 LOG_LEVEL=info 打開。
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
  const log = createLogger();
  loadEnv();
  // 與 daemon 讀同一個 DB（SQLite WAL 支援多程序），所以 daemon 沒跑也能先把答案填好
  const boot = loadBootstrap();
  const store = new ConfigStore(boot.ledgerPath);
  const config = store.appConfig();
  const ledger = new Ledger(boot.ledgerPath, log);
  ledger.init();

  const args = process.argv.slice(2).filter((a) => a !== '--yes');
  const skipConfirm = process.argv.includes('--yes');

  // 唯讀報表：不需要 MCP、不會改任何狀態，所以放在 collectPending 之前直接回。
  if (args[0] === 'status') {
    const now = Date.now();
    console.log(formatStatus(statusInput(ledger, config, now, ledger.costByRepo(startOfToday(now)))));
    ledger.close();
    return;
  }
  if (args[0] === 'friction') {
    // agent 回報的系統摩擦。唯讀——要不要據以改東西，人看過證據再決定。
    console.log(formatFriction(summarizeFriction(frictionInput(ledger))));
    ledger.close();
    return;
  }
  if (args[0] === 'cost') {
    const now = Date.now();
    const v = evaluateBudget({
      limits: config.orchestrator.budget,
      spentSince: (since) => ledger.costSummary(since),
      now,
    });
    console.log(formatCost(costInput(ledger, now, v.all.map((u) => ({ ...u, label: periodLabel(u.period) })))));
    ledger.close();
    return;
  }

  const items = collectPending(ledger);

  if (args.length === 0) {
    console.log(formatPending(items));
    ledger.close();
    return;
  }

  const action = resolveAction(items, args[0]!, args.slice(1));
  if (typeof action === 'string') {
    console.error(`❌ ${action}`);
    ledger.close();
    process.exit(2);
  }

  if (needsConfirmation(action) && !skipConfirm) {
    console.log(`\n⚠️  這個操作不可逆：會呼叫 MCP 的 complete_task 把任務標成 done，之後無法反悔。`);
    console.log(`   任務：${action.item.id}　${action.item.title}`);
    console.log(`   agent 的理由：${action.item.detail}`);
    if (action.item.evidence) console.log(`   依據：${action.item.evidence}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const yn = (await rl.question('\n確定要標記完成嗎？(yes/N) ')).trim().toLowerCase();
    rl.close();
    if (yn !== 'yes' && yn !== 'y') {
      console.log('已取消。');
      ledger.close();
      return;
    }
  }

  // confirm 需要真的呼叫 MCP；其餘動作只動 ledger，不必連線（也因此 daemon 沒跑也能用）
  const clients: PmmMcpClient[] = [];
  const completeTask = action.verb === 'confirm' ? await buildCompleteTask(config, ledger, log, clients) : undefined;

  const router = new InboundRouter({ ledger, log, ...(completeTask ? { completeTask } : {}) });
  const msg = await applyAction(action, {
    router,
    log,
    readTaskState: (id) => {
      const t = ledger.getTask(id);
      return t ? { state: t.state, ...(t.block?.detail ? { blockDetail: t.block.detail } : {}) } : undefined;
    },
  });
  console.log(msg);

  for (const c of clients) await c.close().catch(() => {});
  ledger.close();
}

/** 只在需要時才連 MCP：依任務的 repo 找對應專案的 client。 */
export async function buildCompleteTask(
  config: AppConfig,
  ledger: Ledger,
  log: Logger,
  clients: PmmMcpClient[],
): Promise<CompleteTaskFn | undefined> {
  const resilience = mcpResilienceFromEnv();
  const byRepo = new Map<string, PmmMcpClient>();
  for (const p of config.projects) {
    try {
      // **一定要用 createMcpClient**，不要自己拼設定。
      //
      // 這裡原本自己組了一個 `{ url: '', token: '', stdio: {...} }`——但 McpClientConfig
      // 根本沒有 stdio 這個欄位（stdio 是用 createTransport 注入的）。那個物件會被當成
      // 「連 url='' 的 HTTP」，於是**對任何 stdio 任務板都必定連不上**，
      // confirm / reject 這條路整個是死的：agent 回報「無需改動」之後，
      // 人想確認也確認不了，任務永遠停在 blocked。
      const client = createMcpClient(p, log, resilience);
      if (!client) continue; // 設定不全，createMcpClient 已記錯
      await client.connect();
      clients.push(client);
      byRepo.set(p.repo, client);
    } catch (e) {
      log.warn({ id: p.id, err: e instanceof Error ? e.message : String(e) }, 'MCP 連線失敗（該專案無法確認完成）');
    }
  }
  if (byRepo.size === 0) {
    console.error('❌ 無法連上任何 MCP，無法執行 complete_task。請檢查 config/projects.yaml 與網路。');
    return undefined;
  }
  return async (taskId, opts) => {
    const task = ledger.getTask(taskId);
    const client = task ? byRepo.get(task.repo) : undefined;
    if (!client) return { ok: false, kind: 'permanent', detail: `找不到 ${task?.repo ?? '?'} 的 MCP` };
    return client.completeTask(taskId, opts);
  };
}

/** 把專案的 mcp 設定轉成 PmmMcpClient 的設定（與 main.ts 同義）。 */


// 直接執行時才跑 main（被 import 當函式庫測試時不執行）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
