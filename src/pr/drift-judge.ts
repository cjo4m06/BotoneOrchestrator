import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Logger } from '../observability/logger.js';
import { createPreToolUseGuard } from '../worker/agent-runtime.js';
import { recordAgentUsage, type UsageSink } from '../core/agent-usage.js';

/**
 * 語意飄移判斷（需求 7 的第二層）。
 *
 * Merge Guard 的既有兩層是**事實**：rebase 有沒有文字衝突、合併後 build/test 紅不紅。
 * 那兩層抓得到「別的 PR 刪改了你依賴的東西 → 合併後爆掉」。
 *
 * 但抓不到「能編譯、測試也綠，可是兩邊的意圖打架」——例如 A 把某個按鈕改成需要二次確認，
 * B 同時把同一條流程改成一鍵完成；各自的測試都過，合起來卻是自相矛盾的產品行為。
 * 這種只有讀得懂程式碼與意圖的人（或 agent）判斷得出來，量不出來。
 *
 * 所以這裡是**判斷層**：把「base 這段期間進來的變更」與「本群的變更」一起給 agent，
 * 問它兩邊的意圖有沒有互相抵消或矛盾。
 *
 * 保守方向刻意與其他關卡相反：**判不出來就放行**。這一層是在所有事實層都綠之後才跑的
 * 額外保險，讓它在不確定時擋下來，等於用一個主觀判斷去否決一組客觀證據。
 */

export interface DriftFinding {
  /** 衝突發生在哪（檔案或功能名）。 */
  where: string;
  /** base 那邊的意圖。 */
  baseIntent: string;
  /** 本群的意圖。 */
  groupIntent: string;
  /** 為什麼兩者不能同時成立。 */
  why: string;
}

export type DriftVerdict =
  | { status: 'clean'; notes: string[] }
  | { status: 'conflict'; findings: DriftFinding[] }
  | { status: 'skipped'; reason: string };

export interface DriftJudgeInput {
  /** 工作區（已 rebase 到最新 base 的狀態）。 */
  cwd: string;
  /** base 在本群動工之後多出來的變更。 */
  baseChanges: string;
  /** 本群相對 base 的變更。 */
  groupChanges: string;
  /** 本群在做什麼（任務標題，給判斷者背景）。 */
  taskTitles: string[];
}

const FindingSchema = z.object({
  where: z.string().default(''),
  baseIntent: z.string().default(''),
  groupIntent: z.string().default(''),
  why: z.string().default(''),
});
const VerdictSchema = z.union([
  z.object({ status: z.literal('clean'), notes: z.array(z.string()).default([]) }),
  z.object({ status: z.literal('conflict'), findings: z.array(FindingSchema).min(1) }),
]);

export type DriftQueryFn = (args: { prompt: string; cwd: string }) => AsyncIterable<Record<string, unknown>>;

export interface DriftJudgeDeps {
  /**
   * 記帳出口。未注入 → 不記（測試與無 ledger 的情境）。
   * 先前這個角色的花費完全沒被記，而預算閘門用的是同一份數字。
   */
  usage?: UsageSink;
  log: Logger;
  /** 模型別名（opus / sonnet / haiku）。未給 → SDK 預設。 */
  model?: string;
  queryFn?: DriftQueryFn;
  hasAuth?: () => boolean;
}

/** 判斷者只讀不寫：它的職責是判斷，不是順手把問題改掉。 */
const JUDGE_TOOLS = ['Read', 'Glob', 'Grep'];

const SYSTEM_PROMPT =
  '你在判斷兩份各自正確的變更合併之後，產品行為會不會自相矛盾。' +
  '建置與測試都已經通過了，所以不要回報編譯或測試層面的問題——那些已經被檢查過。' +
  '你要找的是「意圖打架」：兩邊對同一個行為做了不能同時成立的決定。' +
  '找不到這種矛盾就回 clean。寧可放行也不要為了顯得有用而挑毛病。只輸出要求的 JSON。';

const DEFAULT_MAX_DIFF_CHARS = 40_000;

export class DriftJudge {
  constructor(private deps: DriftJudgeDeps) {}

  async judge(input: DriftJudgeInput): Promise<DriftVerdict> {
    const hasAuth = this.deps.hasAuth ?? defaultHasAuth;
    if (!hasAuth()) return { status: 'skipped', reason: '未設定 Claude 認證' };
    if (!input.baseChanges.trim()) {
      // base 沒動過就沒有「兩邊」可言，這一層不適用
      return { status: 'skipped', reason: 'base 在本群動工後沒有新變更' };
    }
    if (!input.groupChanges.trim()) return { status: 'skipped', reason: '本群沒有變更' };

    let text: string;
    try {
      text = await this.runQuery(buildDriftPrompt(input), input.cwd);
    } catch (e) {
      // 判斷層失敗不該擋住一組已經全綠的證據
      this.deps.log.warn({ err: msg(e) }, '語意飄移判斷呼叫失敗，略過（不阻斷合併）');
      return { status: 'skipped', reason: `判斷呼叫失敗：${msg(e)}` };
    }

    const verdict = parseDriftResponse(text);
    if (!verdict) {
      this.deps.log.warn({ preview: text.slice(0, 200) }, '語意飄移判斷回應無法解析，視為略過');
      return { status: 'skipped', reason: '回應無法解析' };
    }
    this.deps.log.info(
      { status: verdict.status, findings: verdict.status === 'conflict' ? verdict.findings.length : 0 },
      '語意飄移判斷完成',
    );
    return verdict;
  }

  private async runQuery(prompt: string, cwd: string): Promise<string> {
    const q: DriftQueryFn =
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
            // **邊界由這裡守，不是 allowedTools。** SDK 的 allowedTools 對工具不具強制力
            // （實跑證實規劃 agent 用了 9 次沒列進去的 Bash）。飄移判斷者只判斷、不動手，
            // 而它的 cwd 是實際的工作區——沒有這道 hook，唯一擋著它的只有提示詞。
            hooks: { PreToolUse: [{ hooks: [createPreToolUseGuard(this.deps.log, { mode: 'readonly', allowTools: JUDGE_TOOLS })] }] },
          },
        }) as AsyncIterable<Record<string, unknown>>);

    let out = '';
    for await (const raw of q({ prompt, cwd })) {
      const m = raw as { type?: string; subtype?: string; result?: string };
      if (m.type === 'result') {
        recordAgentUsage(this.deps.usage, this.deps.log, { kind: 'drift_judge' }, raw);
        if (m.subtype === 'success') out = m.result ?? '';
        else throw new Error(`語意飄移判斷回傳錯誤結果：${m.subtype ?? 'unknown'}`);
      }
    }
    return out;
  }
}

// ── 純函式 ──

export function buildDriftPrompt(input: DriftJudgeInput, maxChars = DEFAULT_MAX_DIFF_CHARS): string {
  const p: string[] = [];
  p.push('# 判斷這次合併後產品行為會不會自相矛盾');
  p.push(
    '\n這個分支已經 rebase 到最新的目標分支，**建置與測試都通過了**。' +
      '所以編譯層面的問題不用看——你要判斷的是兩邊的「意圖」有沒有打架。',
  );
  p.push(`\n## 本群在做什麼\n${input.taskTitles.map((t) => `- ${t}`).join('\n')}`);
  p.push(`\n## 目標分支在本群動工之後多出來的變更\n\`\`\`diff\n${truncate(input.baseChanges, maxChars)}\n\`\`\``);
  p.push(`\n## 本群的變更\n\`\`\`diff\n${truncate(input.groupChanges, maxChars)}\n\`\`\``);
  p.push(
    `\n## 你要找的東西\n` +
      `兩邊對**同一個行為**做了不能同時成立的決定。例如：\n` +
      `- 一邊把某個操作改成需要二次確認，另一邊把同一條流程改成一鍵完成\n` +
      `- 一邊把某個狀態改成由 A 管理，另一邊仍然在 B 裡各自維護一份\n` +
      `- 一邊移除了某個入口，另一邊新增了指向那個入口的連結\n\n` +
      `不算矛盾的：兩邊各做各的、只是碰巧在同一個檔案；風格不一致；` +
      `你覺得可以寫得更好但兩者並不衝突。必要時用 Read/Grep 看合併後的實際程式碼確認。`,
  );
  p.push(
    `\n## 輸出格式（只輸出一個 JSON 程式碼區塊，不要其他文字）\n` +
      '```json\n' +
      `{ "status": "clean", "notes": ["你確認過但判定不衝突的點"] }\n` +
      '```\n或\n```json\n' +
      `{ "status": "conflict", "findings": [\n` +
      `  { "where": "哪個檔案或功能", "baseIntent": "目標分支想做什麼",\n` +
      `    "groupIntent": "本群想做什麼", "why": "為什麼兩者不能同時成立" }\n` +
      `] }\n` +
      '```',
  );
  return p.join('\n');
}

export function parseDriftResponse(text: string): DriftVerdict | undefined {
  const json = extractJson(text);
  if (json === undefined) return undefined;
  const parsed = VerdictSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** 把判定轉成交給 agent 的意見（沿用 Merge Guard 那條回灌路徑）。 */
export function driftFeedback(findings: DriftFinding[]): string {
  const p: string[] = [
    '你的改動和目標分支上的新變更**單獨看都沒問題、建置與測試也都過了**，',
    '但合併之後產品行為會自相矛盾：',
    '',
  ];
  findings.forEach((f, i) => {
    p.push(`${i + 1}. ${f.where}`);
    p.push(`   目標分支：${f.baseIntent}`);
    p.push(`   你這邊：${f.groupIntent}`);
    p.push(`   衝突點：${f.why}`);
  });
  p.push(
    '',
    '請調整你的實作，讓兩邊的意圖能一致並存。',
    '**不可以**把目標分支的變更改掉或還原——那不是解決衝突，是把別人的成果弄掉。',
    '如果兩邊的需求真的互斥、無法同時成立，用 ask_human 說明衝突點，不要自己選一邊。',
  );
  return p.join('\n');
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

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…（過長已截斷，需要細節請用 Read/Grep 看實際檔案）`;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function defaultHasAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);
}
