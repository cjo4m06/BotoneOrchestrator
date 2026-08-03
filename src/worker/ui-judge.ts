import { query } from '@anthropic-ai/claude-agent-sdk';
import { createGitInspectServer } from './git-inspect.js';
import { createFrictionServer, type FrictionSink } from './friction-server.js';
import { z } from 'zod';
import type { CheckResult } from '../types.js';
import type { Logger } from '../observability/logger.js';

/**
 * 介面判斷：讓 agent **自己開瀏覽器看**，判斷畫面行不行。
 *
 * 為什麼量測不夠：既有的視覺關卡量得出「這個元素超出視窗 340px」「跟基準的像素差異
 * 12%」——那些是事實，也是對的。但畫面到底行不行，內容遠不只如此：
 * 好不好讀、字級與對比夠不夠、視覺層次對不對、按鈕看起來像不像可以點、
 * 深色模式下有沒有「深底配深字」這種讀不到的組合。這些沒有一項量得出來。
 *
 * 而先前的狀況更難看：截圖有拍、有做像素比對、有傳到 Slack、有定期清理，
 * **從頭到尾沒有任何 agent 看過那張圖**。
 *
 * 為什麼給它瀏覽器而不是只給截圖：靜態截圖只有「某個路由、某個斷點、某一瞬間」。
 * 判斷介面常常要**互動**才知道行不行——深色模式切換按下去之後長怎樣、表單填錯的提示、
 * hover 狀態、收合展開。這些在一張 PNG 上永遠看不到。
 *
 * 獨立性靠的是**全新的 context**（不 resume 寫程式那個 session），
 * 跟 reviewer.ts 同一個道理——不是靠「它是程式寫的」。自己驗自己不算驗。
 *
 * 保守方向與 DoD 那些關卡不同：**判不出來就放行**。這是主觀判斷，讓它擋下建置與
 * 測試都綠的成果，誤殺的代價比漏放高。真的很糟的畫面它會說得出具體哪裡糟。
 */

export interface UiIssue {
  /**
   * 這個問題是這次改動引入／惡化的，還是本來就有的。
   *
   * 存在的理由：判斷者看的是「畫面現在行不行」，而畫面上本來就有的毛病不該擋住
   * 一個只加了一顆按鈕的 PR——實跑撞到：任務是「加清空按鈕」，diff 卻長成 9 個檔案，
   * 因為判斷者一路挖出既有的觸控目標過小、深色模式沒覆蓋到浮層…全部被當成必須修。
   * 既有問題值得記錄，但擋的只該是這次弄出來的。
   */
  origin: 'introduced' | 'preexisting';
  /** 哪一張截圖（路徑或路由＋斷點）。 */
  shot: string;
  /** 問題類別，給人快速掃視用。 */
  kind: 'readability' | 'contrast' | 'layout' | 'hierarchy' | 'affordance' | 'spacing' | 'other';
  /** 具體哪裡有問題。 */
  problem: string;
  /** 建議怎麼改（會回灌給 agent）。 */
  suggestion?: string;
}

export type UiVerdict =
  | { status: 'ok'; notes: string[] }
  | { status: 'issues'; issues: UiIssue[] }
  | { status: 'skipped'; reason: string };

export interface UiJudgeInput {
  /** 工作區。 */
  cwd: string;
  /**
   * 比較基準（例如 'origin/main'）。有了它才會掛上唯讀 git 工具，
   * 判斷者才分得出「這次弄壞的」與「本來就有的」。
   */
  baseRef?: string;
  /** 任務 id（摩擦回報要掛在任務上）。 */
  taskId?: string;
  /**
   * 已跑起來的 dev server 位址。給了它就能自己導頁、互動、改視窗尺寸；
   * 沒給就只能看靜態截圖（例如 dev server 起不來的降級情況）。
   */
  baseUrl?: string;
  /** 要看的路由（配合 baseUrl）。 */
  routes?: string[];
  /**
   * 預先截圖用的視窗寬度。**判斷者原本不知道這件事**——它拿到的是一疊圖，
   * 不知道那些圖只涵蓋幾個固定寬度、也不知道中間那一大段完全沒人看過。
   * 實跑撞到：設定只有 390 與 1280 兩個斷點，一個只在 640～890px 出現的重疊
   * 就這樣過了 DoD 關卡（Merge Guard 重跑時判斷者自己 resize 了才抓到）。
   */
  capturedWidths?: number[];
  /** 已拍好的截圖檔案路徑（沒有 baseUrl 時的替代材料）。 */
  screenshots: string[];
  /**
   * 量測發現的可疑之處，當**線索**用。
   * 刻意只是線索不是結論：門檻值判得出「歪了 3px」，判不出「這排版讓人找不到重點」，
   * 也會把刻意的錯位設計誤判成破版。
   */
  hints?: string[];
  /** 這個任務在做什麼——判斷「畫面有沒有達成目的」需要知道目的。 */
  taskTitle: string;
  taskDescription?: string;
  /** 規格內容（有的話），讓它能對照「規格說要長這樣」。 */
  specs?: string[];
}

const IssueSchema = z.object({
  // 分不出來時保守當成 introduced：擋一次讓人看到，比放行一個真的被弄壞的畫面好
  origin: z.enum(['introduced', 'preexisting']).catch('introduced'),
  shot: z.string().default(''),
  // `.catch` 而不是 `.default`：default 只處理「欄位不存在」，值不合法時整份解析會失敗。
  // 實跑撞到——判斷者用了 "spacing" 這個我沒列進去的類別，於是一整份正確的判定
  // （對比 1.2:1、行框 9px、段距 4px，全部說中）被丟掉，變成「回應無法解析」。
  // 類別只是給人分類看的，不該有權力否決內容。
  kind: z
    .enum(['readability', 'contrast', 'layout', 'hierarchy', 'affordance', 'spacing', 'other'])
    .catch('other'),
  problem: z.string().min(1),
  suggestion: z.string().optional(),
});
const VerdictSchema = z.union([
  z.object({ status: z.literal('ok'), notes: z.array(z.string()).default([]) }),
  z.object({ status: z.literal('issues'), issues: z.array(IssueSchema).min(1) }),
]);

export type UiQueryFn = (args: { prompt: string; cwd: string }) => AsyncIterable<Record<string, unknown>>;

export interface UiJudgeDeps {
  log: Logger;
  /** 模型別名（opus / sonnet / haiku）。未給 → SDK 預設。 */
  model?: string;
  queryFn?: UiQueryFn;
  hasAuth?: () => boolean;
  /**
   * 瀏覽器 MCP 的設定（由呼叫端提供，輸出目錄必須在 worktree 之外）。
   * 未給就退化成只看靜態截圖。
   */
  browser?: { command: string; args: string[] };
  /** 摩擦回報的去處。未注入就不掛那個工具。 */
  frictionSink?: FrictionSink;

  /** 一次最多看幾張（避免一個多路由多斷點的專案把單輪成本吃爆）。 */
  maxShots?: number;
}

/**
 * 判斷者不改程式碼：沒有 Write/Edit/Bash。
 * Read 用來看截圖；瀏覽器工具用來自己導頁與互動。
 * 刻意不給 `browser_run_code_unsafe`——那能在頁面裡跑任意程式碼，判斷者不需要。
 */
const JUDGE_TOOLS = [
  'Read',
  'Glob',
  // Grep 是唯讀的，判斷者本來就該有——先前漏了，於是它去查程式碼時被自己的閘門擋下
  'Grep',
  // 唯讀 git：判斷者要能自己查「這次改了什麼」「這幾行上次是誰改的」，
  // 否則它分不出新舊，只能把整個頁面的毛病一起報上來（實跑撞到）。
  'mcp__git__git_changed_files',
  'mcp__git__git_diff',
  'mcp__git__git_log',
  'mcp__git__git_blame',
  'mcp__playwright__browser_navigate',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_find',
  'mcp__playwright__browser_take_screenshot',
  'mcp__playwright__browser_click',
  'mcp__playwright__browser_type',
  'mcp__playwright__browser_hover',
  'mcp__playwright__browser_press_key',
  'mcp__playwright__browser_resize',
  'mcp__playwright__browser_wait_for',
  'mcp__playwright__browser_evaluate',
  'mcp__playwright__browser_close',
];
const DEFAULT_MAX_SHOTS = 8;

const SYSTEM_PROMPT =
  '你是介面品質的審查者。你要判斷這個介面對使用者來說行不行。' +
  '**你必須真的看到畫面才能下判斷**：有瀏覽器就自己導頁去看、去操作；' +
  '只有截圖就用 Read 把每一張打開來看。不要憑檔名、路徑或程式碼猜。' +
  '你要看的是人眼看得出來的問題：讀不讀得下去、字級與對比夠不夠、版面有沒有破、' +
  '視覺層次對不對、可點的東西看起來像不像可點。' +
  '不要挑「我覺得可以更好看」這種偏好——只回報真的會妨礙使用的問題。' +
  '沒有這類問題就回 ok。只輸出要求的 JSON。';

/** 判斷者能用的工具（強制版）。理由見 runQuery 裡的說明。 */
const ALLOWED_JUDGE_TOOLS = new Set(JUDGE_TOOLS);

/**
 * 判斷者的工具閘門。
 * 它的職責是判斷，不是動手——所以連「寫檔」「跑指令」都不該有，
 * 更不用說在頁面裡執行任意程式碼。
 */
export function judgeToolGuard(log: Logger, onTool?: (name: string) => void) {
  return async (hookInput: Record<string, unknown>) => {
    const name = String(hookInput.tool_name ?? '');
    onTool?.(name);
    if (ALLOWED_JUDGE_TOOLS.has(name)) return {};
    log.warn({ tool: name }, '判斷者嘗試使用未允許的工具，已擋下');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason:
          `這個工具不在判斷者的允許清單內：${name}。你的職責是判斷，不是動手改東西。`,
      },
    };
  };
}

export class UiJudge {
  constructor(private deps: UiJudgeDeps) {}

  async judge(input: UiJudgeInput): Promise<UiVerdict> {
    const hasAuth = this.deps.hasAuth ?? defaultHasAuth;
    if (!hasAuth()) return { status: 'skipped', reason: '未設定 Claude 認證' };
    // 有瀏覽器就算沒截圖也能看；兩者皆無才真的沒有材料
    if (input.screenshots.length === 0 && !input.baseUrl) {
      return { status: 'skipped', reason: '沒有截圖也沒有可導頁的網址' };
    }

    const shots = input.screenshots.slice(0, this.deps.maxShots ?? DEFAULT_MAX_SHOTS);
    const dropped = input.screenshots.length - shots.length;
    if (dropped > 0) {
      // 靜默截斷會讓「全部看過了」變成假象，所以要留紀錄
      this.deps.log.warn({ total: input.screenshots.length, judged: shots.length }, '截圖過多，只判斷前幾張');
    }

    // 有 baseRef 才給 git 工具：沒有比較基準的話那些工具問不出有意義的東西
    const gitServer = input.baseRef
      ? createGitInspectServer({ cwd: input.cwd, baseRef: input.baseRef, log: this.deps.log })
      : undefined;
    const frictionServer =
      this.deps.frictionSink && input.taskId
        ? createFrictionServer(this.deps.frictionSink, this.deps.log, input.taskId, 'ui-judge')
        : undefined;

    const basePrompt = buildUiPrompt({ ...input, screenshots: shots });
    let run: { text: string; used: Map<string, number> };
    try {
      run = await this.runQuery(basePrompt, input.cwd, gitServer, frictionServer);
    } catch (e) {
      this.deps.log.warn({ err: msg(e) }, '介面判斷呼叫失敗，略過（不阻斷流程）');
      return { status: 'skipped', reason: `判斷呼叫失敗：${msg(e)}` };
    }

    let verdict = parseUiResponse(run.text);
    if (!verdict) {
      this.deps.log.warn({ preview: run.text.slice(0, 200) }, '介面判斷回應無法解析，視為略過');
      return { status: 'skipped', reason: '回應無法解析' };
    }

    // ── 深度下限：說 ok 之前，至少要真的改過視窗尺寸 ──
    //
    // 提示詞早就寫了「至少要看寬螢幕與窄螢幕兩種」，實跑照樣沒照做：同一份程式碼、
    // 同一段提示詞跑兩次，一次 6 個工具呼叫就說 ok，另一次 78 個（resize 6 次）
    // 抓到一個 640～890px 的重疊。變異這麼大，「淺一次」是常態而不是意外，
    // 而 Merge Guard 用的是**同一個**判斷者——它淺的時候一樣會放行。
    //
    // 所以這裡不判斷畫面好不好（那是它的事），只檢查**證據涵蓋了沒**：
    // 一個只看過幾張固定寬度靜態圖的 ok，涵蓋不到寬度縫隙，不該算數。
    const gap = unobservedWidthSpan(input.capturedWidths);
    if (verdict.status === 'ok' && input.baseUrl && gap && !usedResize(run.used)) {
      this.deps.log.warn({ gap }, '判斷者說 ok 但從未改過視窗尺寸 → 證據不涵蓋寬度縫隙，重問一次');
      try {
        run = await this.runQuery(
          `${retryNote(gap)}\n\n${basePrompt}`,
          input.cwd,
          gitServer,
          frictionServer,
        );
      } catch (e) {
        return { status: 'skipped', reason: `重問時判斷呼叫失敗：${msg(e)}` };
      }
      const second = parseUiResponse(run.text);
      if (!second) return { status: 'skipped', reason: '重問後回應無法解析' };
      if (second.status === 'ok' && !usedResize(run.used)) {
        // 兩次都沒看。與其吞下一個涵蓋不到的 ok，不如讓它變成紅燈給人看——
        // 這個系統最危險的失敗模式一直是「靜默地沒做某件事」。
        const reason = `判斷者兩次都沒有改過視窗尺寸，${gap[0]}～${gap[1]}px 之間沒有任何證據`;
        this.deps.log.error({ gap }, '介面判斷涵蓋不足，不採計為綠燈');
        return { status: 'skipped', reason };
      }
      verdict = second;
    }
    this.deps.log.info(
      { status: verdict.status, issues: verdict.status === 'issues' ? verdict.issues.length : 0, shots: shots.length },
      '介面判斷完成',
    );
    return verdict;
  }

  private async runQuery(
    prompt: string,
    cwd: string,
    gitServer?: unknown,
    frictionServer?: unknown,
  ): Promise<{ text: string; used: Map<string, number> }> {
    // 記下判斷者用了什麼。沒有這個就答不出「它到底有沒有去查 git」——
    // 而那正是它能不能分辨新舊問題的前提。實跑時因為缺這份紀錄，
    // 我無法判斷一次錯誤分類是「沒查」還是「查了但判斷不同」。
    const used = new Map<string, number>();
    const q: UiQueryFn =
      this.deps.queryFn ??
      ((args) =>
        query({
          prompt: args.prompt,
          options: {
            ...(this.deps.model ? { model: this.deps.model } : {}),
            cwd: args.cwd,
            permissionMode: 'acceptEdits', // 工具已限制唯讀
            allowedTools: JUDGE_TOOLS,
            systemPrompt: SYSTEM_PROMPT,
            // **allowedTools 對 MCP 工具不具強制力**（實跑證實：沒列進去的
            // browser_run_code_unsafe 照樣被呼叫成功）。判斷者能碰到的東西一樣要由
            // 自己的 hook 守住——它不該有執行任意程式碼或上傳檔案的能力。
            hooks: {
              PreToolUse: [{ hooks: [judgeToolGuard(this.deps.log, (n) => used.set(n, (used.get(n) ?? 0) + 1))] }],
            },
            mcpServers: {
              ...(this.deps.browser ? { playwright: this.deps.browser } : {}),
              ...(gitServer ? { git: gitServer as never } : {}),
              ...(frictionServer ? { friction: frictionServer as never } : {}),
            } as never,
          },
        }) as AsyncIterable<Record<string, unknown>>);

    let out = '';
    try {
      for await (const raw of q({ prompt, cwd })) {
        const m = raw as { type?: string; subtype?: string; result?: string };
        if (m.type === 'result') {
          if (m.subtype === 'success') out = m.result ?? '';
          else throw new Error(`介面判斷回傳錯誤結果：${m.subtype ?? 'unknown'}`);
        }
      }
    } finally {
      if (used.size > 0) {
        const gitCalls = [...used].filter(([n]) => n.startsWith('mcp__git__')).reduce((a, [, n]) => a + n, 0);
        this.deps.log.info(
          { tools: Object.fromEntries([...used].sort((a, b) => b[1] - a[1]).slice(0, 12)), gitCalls },
          gitCalls > 0 ? '判斷者工具使用（有查 git）' : '判斷者工具使用（**沒查 git**，分不出新舊問題）',
        );
      }
    }
    return { text: out, used };
  }
}

/** 判斷者到底有沒有改過視窗尺寸。 */
export function usedResize(used: Map<string, number>): boolean {
  return (used.get('mcp__playwright__browser_resize') ?? 0) > 0;
}

/**
 * 預截圖寬度之間「沒有任何人看過」的區間。
 * 只有一個寬度（或完全沒設定）時回 undefined——那種情況沒有「縫隙」可談，
 * 該補的是設定而不是在這裡瞎猜要看哪裡。
 */
export function unobservedWidthSpan(widths?: number[]): [number, number] | undefined {
  if (!widths || widths.length < 2) return undefined;
  const sorted = [...new Set(widths)].sort((a, b) => a - b);
  if (sorted.length < 2) return undefined;
  // 相鄰兩個寬度之間最大的那一段——最可能藏東西的地方
  let best: [number, number] | undefined;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const lo = sorted[i]!;
    const hi = sorted[i + 1]!;
    if (!best || hi - lo > best[1] - best[0]) best = [lo, hi];
  }
  return best;
}

function retryNote(gap: [number, number]): string {
  return (
    `# 先看這段（上一輪的判斷不算數）\n` +
    `你上一輪回答了「沒問題」，但**從頭到尾沒有改過一次視窗尺寸**——` +
    `你看到的只是幾張固定寬度的靜態圖。\n` +
    `${gap[0]}～${gap[1]}px 這一整段沒有任何證據，而 RWD 的問題幾乎都藏在這種縫隙裡。\n` +
    `請用 \`browser_resize\` 在這段裡取幾個寬度實際看過，再重新給結論。\n` +
    `真的看過之後仍然沒問題，就照樣回 ok——這不是要你硬找問題，是要你先看過。`
  );
}

// ── 純函式 ──

export function buildUiPrompt(input: UiJudgeInput): string {
  const p: string[] = [];
  p.push('# 判斷這個介面行不行');
  p.push(`\n## 這個任務在做什麼\n${input.taskTitle}`);
  if (input.taskDescription?.trim()) p.push(input.taskDescription.trim());
  if (input.specs?.length) {
    p.push(`\n## 規格（畫面應該符合這些）`);
    for (const s of input.specs) p.push(s);
  }

  if (input.baseUrl) {
    p.push(
      `\n## 你有瀏覽器，網站已經跑起來了：${input.baseUrl}\n` +
        `**請自己導頁去看**，不要只看別人拍好的圖。你可以：\n` +
        `- \`browser_navigate\` 開頁面、\`browser_snapshot\` 看結構、\`browser_take_screenshot\` 看畫面\n` +
        `- \`browser_resize\` 換視窗尺寸（至少要看寬螢幕與窄螢幕兩種）\n` +
        `- \`browser_click\` / \`browser_type\` **實際操作**——這個任務新增的互動要真的按下去看結果，\n` +
        `  切換、展開、送出之後的樣子，在靜態截圖上永遠看不到`,
    );
    if (input.routes?.length) p.push(`\n要看的路由：${input.routes.map((r) => `${input.baseUrl}${r}`).join('、')}`);
    const gap = unobservedWidthSpan(input.capturedWidths);
    if (gap) {
      p.push(
        `\n### 沒有人看過的寬度\n` +
          `預先截圖只涵蓋 ${input.capturedWidths!.join('、')}px 這幾個寬度，` +
          `**${gap[0]}～${gap[1]}px 之間完全沒有任何證據**。\n` +
          `RWD 的問題幾乎都藏在這種縫隙裡——固定定位的元素在某段寬度會壓到內容、` +
          `文字在某段寬度才開始溢出、選單在某段寬度才擠成兩行。\n` +
          `請自己 \`browser_resize\` 掃過這一段（至少取幾個中間值）再下結論。`,
      );
    }
  }

  if (input.screenshots.length > 0) {
    p.push(
      `\n## 已拍好的截圖（共 ${input.screenshots.length} 張${input.baseUrl ? '，可當參考' : '，**每一張都要用 Read 打開來看**'}）`,
    );
    for (const s of input.screenshots) p.push(`- ${s}`);
  }

  if (input.hints?.length) {
    p.push(
      `\n## 量測到的可疑之處（**線索，不是結論**）\n` +
        `這些是程式量出來的數字，只能指出「哪裡值得看一下」。是不是真的有問題由你判斷——\n` +
        `刻意的錯位設計也會被量成「歪斜」，改了顏色也會被量成「像素差異 100%」。`,
    );
    for (const h of input.hints) p.push(`- ${h}`);
  }

  p.push(
    `\n## 先搞清楚「這次改了什麼」\n` +
      `你有唯讀的 git 工具，**判斷之前先用它們查**：\n` +
      `- \`git_changed_files\` 這次動到哪些檔案\n` +
      `- \`git_diff\` 看某個檔案這次改了什麼\n` +
      `- \`git_blame\` 查某幾行**上次是誰、什麼時候改的**——` +
      `如果那幾行不在這次的改動裡，那就是本來就有的問題\n\n` +
      `每一個問題都要標 \`origin\`：\n` +
      `- \`introduced\`：這次引入、或這次讓它變嚴重的（例如這次加了深色模式卻沒覆蓋到某個浮層）\n` +
      `- \`preexisting\`：本來就那樣，跟這次改動無關\n\n` +
      `**只有 introduced 會擋下這次的改動**；preexisting 一樣要回報（值得修），但不擋。\n` +
      `分不出來就標 introduced——擋一次讓人看到，比放行一個真的被弄壞的畫面好。\n` +
      `不要為了湊數把既有問題硬說成 introduced。`,
  );

  p.push(
    `\n## 你要判斷的\n` +
      `1. **可讀性**：文字看得清楚嗎？字級會不會太小？行距與段落有沒有擠在一起？\n` +
      `2. **對比**：文字與背景的對比夠嗎？有沒有「深底配深字」「淺底配淺字」這種讀不到的組合？\n` +
      `3. **版面**：有沒有元素被截斷、重疊、跑出容器、或明顯歪掉？留白是否合理？\n` +
      `4. **層次**：主要資訊有沒有比次要資訊明顯？重點會不會被淹沒？\n` +
      `5. **可操作性**：按鈕、連結、輸入框看起來像不像可以互動的？點擊目標會不會太小？\n\n` +
      `**不要**回報：你個人的配色偏好、「可以更現代一點」這類意見、` +
      `或截圖以外的推測。只回報畫面上真的會妨礙使用的問題。`,
  );

  p.push(
    `\n## 輸出格式（只輸出一個 JSON 程式碼區塊，不要其他文字）\n` +
      '```json\n' +
      `{ "status": "ok", "notes": ["你看過並確認沒問題的重點"] }\n` +
      '```\n或\n```json\n' +
      `{ "status": "issues", "issues": [\n` +
      `  { "origin": "introduced", "shot": "截圖路徑", "kind": "contrast",\n` +
      `    "problem": "具體哪裡有問題（要能對照到畫面上的位置）",\n` +
      `    "suggestion": "建議怎麼改" }\n` +
      `] }\n` +
      '```',
  );
  return p.join('\n');
}

export function parseUiResponse(text: string): UiVerdict | undefined {
  const json = extractJson(text);
  if (json === undefined) return undefined;
  const parsed = VerdictSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** 轉成關卡結果，讓既有的回灌路徑把意見送回 agent。 */
export function uiCheck(verdict: UiVerdict): CheckResult {
  if (verdict.status === 'ok') {
    return { name: 'visual:judge', ok: true, detail: verdict.notes.join('；') || '畫面判斷通過' };
  }
  if (verdict.status === 'skipped') {
    // **判不出來就判紅**，方向與其他「主觀判斷」層相反，理由是這裡沒有第二道防線。
    //
    // 版面門檻與像素比對已經降級成線索（它們回答不了「好不好看、好不好讀」），
    // 所以視覺這一關**只剩判斷者一個把關者**。它不可用時若照舊放行，等於整個
    // 視覺驗證變成裝飾——而「靜默地變成裝飾」正是這個系統反覆出過的問題。
    return {
      name: 'visual:judge',
      ok: false,
      detail:
        `無法判斷畫面（${verdict.reason}）。視覺這一關沒有其他把關者，` +
        `所以不放行。請修好判斷者（多半是 Claude 認證或瀏覽器環境），或關掉這個專案的視覺關卡。`,
    };
  }
  // **只有這次引入的問題會擋**。既有問題照樣列出來（值得修），但不該讓一個
  // 只加了一顆按鈕的 PR 被整個頁面的歷史債擋住——實跑撞到過，diff 從一顆按鈕
  // 長成 9 個檔案，而且每輪都能再挖出新的既有問題，理論上永遠收斂不了。
  const fmt = (i: UiIssue): string =>
    `[${i.kind}] ${i.shot}：${i.problem}${i.suggestion ? `\n  建議：${i.suggestion}` : ''}`;
  const introduced = verdict.issues.filter((i) => i.origin !== 'preexisting');
  const preexisting = verdict.issues.filter((i) => i.origin === 'preexisting');
  const note =
    preexisting.length > 0
      ? `\n\n── 以下是既有問題，不擋這次的改動（記錄供日後處理）──\n${preexisting.map(fmt).join('\n')}`
      : '';

  if (introduced.length === 0) {
    return {
      name: 'visual:judge',
      ok: true,
      detail: `這次的改動沒有造成畫面問題。${note.trim() ? note : ''}`.trim(),
    };
  }
  return { name: 'visual:judge', ok: false, detail: introduced.map(fmt).join('\n') + note };
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const candidates = [fenced?.[1], start >= 0 && end > start ? text.slice(start, end + 1) : undefined];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    try {
      return JSON.parse(c) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function defaultHasAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);
}
