import { DOCS_TOOLS } from './docs-server.js';

/**
 * **誰拿得到什麼能力——這是唯一的一份清單。**
 *
 * ── 為什麼要有這個檔 ──
 *
 * 這個 repo 被同一種病咬過五次：能力做好了、清單漏一項，症狀只有一行 WARN，
 * 而閘門照樣綠燈：
 *
 *   1. `DOCS_TOOLS` 只接給寫程式的 agent  → 審查者的工作是「規格逐條 vs diff」，卻搜不了規格
 *   2. `ReviewWatcher.poll()` 只掃兩種狀態 → 16 個任務永久死結
 *   3. `collectPending` 只掃 failed        → 群組停半小時，控制台說「沒有需要你處理的事項」
 *   4. `npm run typecheck` 沒跑 test/      → 81 個型別錯誤累積，假件與介面早就對不上
 *   5. `createFrictionServer` 零個呼叫端   → 規劃者是唯一看得到「兩張卡矛盾」的角色，卻沒有出口
 *   6. `settledDecisions` 只餵給審查者     → 而會重問同一個問題的正是寫程式的 agent
 *
 * 每一次的形狀都一樣：**能力是一份，接線是五份**，五個建構點各自手寫一次，
 * 漏掉的那一份不會編譯失敗、不會有測試紅、不會有錯誤 log。
 *
 * ── 這個檔怎麼讓它不再發生 ──
 *
 * · 加一個**能力**（新工具）→ 改 `CAPABILITY_TOOLS` 一處，所有宣告了該能力的角色自動拿到。
 * · 加一個**角色** → `Record<AgentRole, ...>` 是窮舉的，沒填就 typecheck 當場失敗。
 * · 角色宣告了能力卻沒被注入材料 → `serversFor` 把它列進 `missing`，呼叫端大聲 warn。
 *   那正是前五次「有能力、沒接線」的瞬間，現在它講得出自己少了什麼。
 *
 * ── 這裡刻意不做什麼 ──
 *
 * 不決定**邊界**。允不允許寫檔、能不能跑 shell，那是 policy 層（`createPreToolUseGuard`）
 * 的事，而且 SDK 的 `allowedTools` 對工具**不具強制力**（實跑證實規劃 agent 用了
 * 9 次沒列進清單的 Bash）。這裡只回答「這個角色的清單上該有哪些名字」。
 */

/** 系統裡所有會跑 agent 的角色。加角色時下面兩張表都會被 typecheck 逼著填。 */
export type AgentRole = 'coder' | 'reviewer' | 'planner' | 'drift_judge' | 'risk_judge';

/**
 * 一項能力 ＝ 一組工具 ＋（通常）一個要注入的 MCP server。
 *
 * `shell` 沒有對應的 server（Bash 是 SDK 內建），列成能力是為了讓
 * 「哪些角色查得動 git／grep」這件事也在同一張表上看得到——
 * 實跑撞過：把 allowTools 改成強制之後，少列 Bash 等於默默拿掉它們查證的能力。
 */
export type Capability =
  | 'shell'
  | 'edit'
  | 'docs'
  | 'friction'
  | 'ask'
  | 'browser_full'
  | 'browser_readonly'
  | 'git_readonly';

/** 讀檔與搜尋——每個角色都要有，所以不列成能力，直接併進結果。 */
const BASE_TOOLS = ['Read', 'Glob', 'Grep'] as const;

const GIT_READONLY_TOOLS = [
  'mcp__git__git_changed_files',
  'mcp__git__git_diff',
  'mcp__git__git_log',
  'mcp__git__git_blame',
] as const;

/**
 * 每項能力提供哪些工具名。**加工具改這裡一處**，所有宣告了該能力的角色自動拿到。
 *
 * 瀏覽器的兩個變體用 `[]` 佔位：實際清單在 agent-runtime.ts（`BROWSER_TOOLS` /
 * `READONLY_BROWSER_TOOLS`），因為它是從黑名單推導出來的、而那份黑名單與紅線政策綁在一起。
 * 由 `toolsFor` 的 `browserTools` 參數注入，避免這個檔反向相依 agent-runtime。
 */
export const CAPABILITY_TOOLS: Record<Capability, readonly string[]> = {
  shell: ['Bash'],
  edit: ['Write', 'Edit'],
  docs: DOCS_TOOLS,
  friction: ['mcp__friction__report_friction'],
  // 寫程式的 agent 的三個出口掛在同一個 `ask` server 底下
  ask: ['mcp__ask__ask_human', 'mcp__ask__report_no_change', 'mcp__ask__report_friction', 'mcp__ask__report_summary'],
  browser_full: [],
  browser_readonly: [],
  git_readonly: GIT_READONLY_TOOLS,
};

/**
 * **誰拿得到什麼。這是唯一的事實源。**
 *
 * 每一列後面的理由要寫清楚——尤其是「為什麼**沒有**某個能力」，
 * 因為那才是下一個人會想加回去的地方。
 */
export const ROLE_CAPABILITIES: Record<AgentRole, readonly Capability[]> = {
  // 寫程式的：唯一會改檔案的角色，三個出口都在它身上
  coder: ['shell', 'edit', 'docs', 'ask', 'browser_full'],

  // 審查者：規格逐條 vs diff，所以要 docs ＋ 唯讀 git（分得出「這次弄的」與「本來就有的」）；
  // 畫面也是它的職責（介面判斷者已併進來），拿唯讀瀏覽器——**不可以退回完整版**，
  // 差別只在 file_upload，而唯讀角色不該有辦法上傳檔案。
  reviewer: ['shell', 'docs', 'git_readonly', 'browser_readonly'],

  // 規劃者：**唯一一次看到整批任務**的角色，「兩張卡的要求彼此矛盾」只有它看得見
  //（coder 一次只做一張，結構上看不到），所以 friction 一定要有。
  // Bash 是刻意留的：`find -iname`、批次檢查一串檔案存不存在，比 Glob 有效率得多。
  planner: ['shell', 'docs', 'friction'],

  // 飄移判斷者：判「這一群的意圖有沒有跟 base 打架」，要查得動兩邊
  // 飄移判斷者：判「這一群的意圖有沒有跟 base 打架」。**自己查 diff**——
  // 先前是程式先算好兩份 diff、各砍到 40K（只留頭）貼進 prompt，
  // 它連「被砍掉的是什麼」都不知道。
  drift_judge: ['shell', 'docs', 'git_readonly'],

  // 合併風險判斷者：只回答「這個改動可不可逆」，要看得到 diff 與歷史
  risk_judge: ['shell', 'docs', 'git_readonly'],
};

/** 這個角色宣告了某項能力嗎。 */
export function hasCapability(role: AgentRole, cap: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(cap);
}

/**
 * 這個角色的工具清單。
 *
 * 瀏覽器清單要從外面注入（見 CAPABILITY_TOOLS 的說明）；沒注入就當這個角色
 * 這一輪沒有瀏覽器——那是既有的優雅降級（沒有輸出目錄就不掛瀏覽器）。
 */
export function toolsFor(
  role: AgentRole,
  browserTools?: { full?: readonly string[]; readonly?: readonly string[] },
): string[] {
  const out = new Set<string>(BASE_TOOLS);
  for (const cap of ROLE_CAPABILITIES[role]) {
    const extra =
      cap === 'browser_full' ? browserTools?.full ?? []
      : cap === 'browser_readonly' ? browserTools?.readonly ?? []
      : CAPABILITY_TOOLS[cap];
    for (const t of extra) out.add(t);
  }
  return [...out];
}

/**
 * 建 MCP server 的材料。呼叫端只給「這一輪拿得到的」，
 * `serversFor` 依角色宣告的能力挑要用哪幾個。
 *
 * 用工廠函式而不是現成的 server 物件：有些 server 建起來要花錢／開行程，
 * 角色沒宣告該能力就完全不該建。
 */
export interface ServerFactories {
  docs?: () => unknown;
  friction?: () => unknown;
  ask?: () => unknown;
  browser?: () => unknown;
  git?: () => unknown;
}

export interface ServersResult {
  /** 直接餵給 SDK 的 `mcpServers`。 */
  servers: Record<string, unknown>;
  /**
   * **角色宣告了這項能力，但沒有人給材料。**
   *
   * 這一格就是前五次事故的瞬間：能力在清單上、工具名也在 allowedTools 裡，
   * 但 server 根本沒掛——agent 呼叫時才失敗，而那時只剩一行 WARN。
   * 呼叫端拿到這個陣列要大聲講出來。
   */
  missing: Capability[];
}

/** 依角色宣告的能力組出 mcpServers；缺材料的能力列進 `missing`。 */
export function serversFor(role: AgentRole, f: ServerFactories): ServersResult {
  const servers: Record<string, unknown> = {};
  const missing: Capability[] = [];
  const add = (cap: Capability, name: string, make: (() => unknown) | undefined): void => {
    if (!hasCapability(role, cap)) return;
    if (!make) { missing.push(cap); return; }
    servers[name] = make();
  };
  add('docs', 'docs', f.docs);
  add('friction', 'friction', f.friction);
  add('ask', 'ask', f.ask);
  add('git_readonly', 'git', f.git);
  add('browser_full', 'playwright', f.browser);
  add('browser_readonly', 'playwright', f.browser);
  return { servers, missing };
}
