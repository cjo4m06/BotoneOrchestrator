import { z } from 'zod';
import { DOCS_TOOLS, createDocsServer, type DocsSource } from '../worker/docs-server.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../observability/logger.js';
import { createGitInspectServer } from '../worker/git-inspect.js';
import { createPreToolUseGuard } from '../worker/agent-runtime.js';
import { recordAgentUsage, type UsageSink } from './agent-usage.js';

/**
 * 合併風險判斷者：「這個改動要不要先讓人看一眼？」
 *
 * ── 為什麼不是一組規則 ──
 *
 * 這件事原本由一個規則引擎做：比對檔案路徑，命中 `**\/migrations\/**`、
 * `.github/workflows/**`、`**\/*.rules` 之類的 glob 就轉人工。
 *
 * 那是在**猜別人的 repo 長什麼樣**。換一個把 migration 放在 `db/schema/` 的專案、
 * 或用別的 CI、或根本沒有 `.rules` 檔的專案，就同時做錯兩件事：該擋的沒擋、
 * 不該擋的亂擋。secrets 那組更是裝飾品——它只抓得到「檔名叫 .env」，
 * 而真正會發生的是「把 API key 貼進 src/config.ts」，檔名比對完全看不到
 * （何況 agent 本來就碰不到 .env，那是 PreToolUse hook 的硬邊界，不是這裡的事）。
 *
 * 判斷者人在那個 repo 裡，看得到實際結構與檔案內容，它判「這是不是 DB migration」
 * 本來就比一組寫死的 glob 準。
 *
 * ── 它只在「自動合併」開著時才跑 ──
 *
 * 開關關著＝每一個 PR 都等人審，那就沒有什麼好判的。開著＝使用者已經表明
 * 「一般改動不必問我」，這時唯一還值得攔一次的，是**做錯了救不回來**的那種。
 *
 * ── 判不出來就當要問人 ──
 *
 * 呼叫失敗、回應解析不出、沒有認證——一律回 needs_human。
 * 「無法確認安全」與「確認安全」是兩件事，不可以混為一談。
 */

export interface MergeRiskInput {
  /** 工作區（群組分支已 checkout 在這裡）。 */
  cwd: string;
  /** 比較基準，如 origin/main。 */
  baseRef: string;
  /** 這一群在做什麼——判斷「改動有沒有超出任務範圍」需要知道意圖。 */
  taskTitles: string[];
  taskDescriptions?: string[];
  /** 所屬 repo——判斷者要靠它去任務板查規格（程式不預抓）。 */
  repo?: string;
}

export interface MergeRisk {
  what: string;
  /** 為什麼救不回來／為什麼值得人看一眼。 */
  why: string;
  /** 具體證據：檔案與行號、diff 片段。 */
  evidence?: string;
}

export type MergeRiskVerdict =
  | { needsHuman: false; notes: string[] }
  | { needsHuman: true; risks: MergeRisk[] };

const RiskSchema = z.object({
  what: z.string().min(1),
  why: z.string().default(''),
  evidence: z.string().optional(),
});
const VerdictSchema = z.union([
  z.object({ needsHuman: z.literal(false), notes: z.array(z.string()).default([]) }),
  z.object({ needsHuman: z.literal(true), risks: z.array(RiskSchema).min(1) }),
]);

/** 判斷者只能看，不能動。跟其他判斷者同一個原則：判斷交給 agent，邊界由程式守住。 */
export const RISK_JUDGE_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'mcp__git__git_changed_files', 'mcp__git__git_diff', 'mcp__git__git_log', 'mcp__git__git_blame', ...DOCS_TOOLS];

const SYSTEM_PROMPT =
  '你是合併前的最後一道人工判斷。你的唯一問題是：**這個改動要是做錯了，救得回來嗎？**'
  + '救得回來的一律放行——使用者已經開了自動合併，表示一般改動不必問他。'
  + '你不是在做程式碼審查（那已經有人做過了），也不是在評價實作品質。';

export type RiskQueryFn = (args: { prompt: string; cwd: string }) => AsyncIterable<Record<string, unknown>>;

export interface MergeRiskJudgeDeps {
  /**
   * 任務板的文件來源。**未注入 → 這個角色查不到規格**（只能用提示詞裡程式先讀好的那份）。
   *
   * 為什麼每個角色都要有：程式預抓規格有兩個無聲的失效模式，兩個都實際發生過——
   * (1) docRef 字串對不上（實跑：docType 單複數不一致）→ 整份讀不到，只留一行 warn，
   *     而 build/test 全綠看起來完全正常；
   * (2) **規格在任務進行中被更新** → 手上是開工那一刻的快照，而且不知道自己拿的是舊的。
   *
   * commit e2820a9 已經做過一次，但**只接給寫程式的 agent**——審查者的工作就是
   * 「規格逐條 vs diff」，卻不能搜規格。
   */
  docs?: (repo: string) => DocsSource | undefined;
  /**
   * 記帳出口。未注入 → 不記（測試與無 ledger 的情境）。
   * 先前這個角色的花費完全沒被記，而預算閘門用的是同一份數字。
   */
  usage?: UsageSink;
  log: Logger;
  /** 模型別名（opus / sonnet / haiku）。未給 → SDK 預設。 */
  model?: string;
  queryFn?: RiskQueryFn;
  hasAuth?: () => boolean;
}

export class MergeRiskJudge {
  constructor(private deps: MergeRiskJudgeDeps) {}

  async judge(input: MergeRiskInput): Promise<MergeRiskVerdict> {
    const hasAuth = this.deps.hasAuth ?? (() => true);
    if (!hasAuth()) {
      return { needsHuman: true, risks: [{ what: '無法判斷合併風險', why: '沒有 Claude 認證，判斷者跑不起來——無法確認安全就不能當成安全' }] };
    }

    let text: string;
    try {
      text = await this.runQuery(buildRiskPrompt(input), input.cwd, input.baseRef, input.repo);
    } catch (e) {
      const why = `判斷呼叫失敗：${e instanceof Error ? e.message : String(e)}`;
      this.deps.log.warn({ err: why }, '合併風險判斷失敗，保守轉人工');
      return { needsHuman: true, risks: [{ what: '無法判斷合併風險', why }] };
    }

    const verdict = parseRiskResponse(text);
    if (!verdict) {
      this.deps.log.warn({ preview: text.slice(0, 200) }, '合併風險判斷回應無法解析，保守轉人工');
      return { needsHuman: true, risks: [{ what: '無法判斷合併風險', why: '判斷者的回應解析不出結構化判定' }] };
    }
    this.deps.log.info(
      { needsHuman: verdict.needsHuman, risks: verdict.needsHuman ? verdict.risks.length : 0 },
      '合併風險判斷完成',
    );
    return verdict;
  }

  private async runQuery(prompt: string, cwd: string, baseRef: string, repo?: string): Promise<string> {
    // 這個角色自己去查規格。程式**不預抓內容**——docRef 字串對不上、
    // 或規格在任務進行中被更新，預抓的那份都會靜靜地是錯的。
    const docsSource = repo ? this.deps.docs?.(repo) : undefined;
    const docsServer = docsSource ? createDocsServer(docsSource, this.deps.log) : undefined;

    const gitServer = createGitInspectServer({ cwd, baseRef, log: this.deps.log });
    const q: RiskQueryFn =
      this.deps.queryFn ??
      ((args) =>
        query({
          prompt: args.prompt,
          options: {
            ...(this.deps.model ? { model: this.deps.model } : {}),
            cwd: args.cwd,
            permissionMode: 'acceptEdits', // 工具已限制唯讀
            allowedTools: RISK_JUDGE_TOOLS,
            systemPrompt: SYSTEM_PROMPT,
            mcpServers: { git: gitServer, ...(docsServer ? { docs: docsServer } : {}) } as never,
            // **邊界由這裡守，不是 allowedTools。** SDK 的 allowedTools 對工具不具強制力
            // （實跑證實規劃 agent 用了 9 次沒列進去的 Bash）。判斷者只看不動。
            hooks: { PreToolUse: [{ hooks: [createPreToolUseGuard(this.deps.log, { mode: 'readonly', allowTools: RISK_JUDGE_TOOLS })] }] },
          },
        }) as AsyncIterable<Record<string, unknown>>);

    let out = '';
    for await (const raw of q({ prompt, cwd })) {
      const m = raw as { type?: string; subtype?: string; result?: string };
      if (m.type === 'result') {
        recordAgentUsage(this.deps.usage, this.deps.log, { kind: 'merge_risk_judge' }, raw);
        if (m.subtype === 'success') out = m.result ?? '';
        else throw new Error(`判斷回傳錯誤結果：${m.subtype ?? 'unknown'}`);
      }
    }
    return out;
  }
}

export function buildRiskPrompt(input: MergeRiskInput): string {
  const p: string[] = [];
  p.push('# 這個改動合併下去，做錯了救得回來嗎？');
  p.push(
    '\n使用者已經開啟自動合併——一般的改動不必問他。'
      + '你要攔下來的**只有一種**：合併之後就回不去、或是回去的代價很高的改動。',
  );

  p.push(`\n## 這一群在做什麼\n${input.taskTitles.map((t) => `- ${t}`).join('\n')}`);
  if (input.taskDescriptions?.length) {
    p.push(input.taskDescriptions.filter((d) => d.trim()).join('\n\n'));
  }

  p.push(
    '\n## 先看改了什麼\n'
      + '你有唯讀的 git 工具，**判斷之前一定要用**：\n'
      + '- `git_changed_files` 這次動到哪些檔案\n'
      + '- `git_diff` 看實際內容（不要只看檔名猜——檔名不代表用途）\n'
      + '- `Read`/`Grep` 看清楚這個 repo 實際怎麼組織，那個檔案在這個專案裡是什麼角色',
  );

  p.push(
    '\n## 什麼算「救不回來」\n'
      + '判準是**後果**，不是檔案放在哪個目錄。同樣叫 migration 的檔案，在這個專案裡可能只是\n'
      + '一段還沒被執行的 SQL，也可能一合併就會被 CI 自動套用到正式資料庫——你要看得出差別。\n\n'
      + '典型（但不限於）：\n'
      + '- **資料會被破壞**：schema 變更、資料遷移、刪欄位／改型別，尤其是會被自動執行的\n'
      + '- **憑證外洩**：diff 裡出現看起來像真的 API key、token、私鑰、連線字串。\n'
      + '  一旦進了 git 歷史就撤不回來。注意是**看內容**，不是看檔名——\n'
      + '  貼在一般程式碼裡的 key 才是真正會發生的情況\n'
      + '- **權限被放寬**：授權規則、存取控制、CORS、公開讀寫的設定\n'
      + '- **會自動觸發外部動作**：CI/CD 設定、部署腳本、排程任務——合併就會跑起來\n'
      + '- **大量刪除**：整批檔案或整個模組被移除，而任務並沒有要求這件事\n'
      + '- **超出任務範圍的改動**：這一群該做的事跟實際改的東西對不上\n\n'
      + '**不要**攔這些：一般的功能與修錯、樣式、文件、測試、重構、'
      + '新增依賴（除非那個依賴本身可疑）、你覺得寫得不夠好的地方。\n'
      + '那些做錯了改回來就好，而且已經有 DoD 與審查者看過了。',
  );

  p.push(
    '\n## 輸出格式（只輸出一個 JSON 程式碼區塊，不要其他文字）\n'
      + '沒有不可逆的風險：\n'
      + '```json\n{"needsHuman": false, "notes": ["一句話說明你看了什麼、為什麼判定安全"]}\n```\n'
      + '有：\n'
      + '```json\n{"needsHuman": true, "risks": [{"what": "發生什麼", "why": "為什麼救不回來", "evidence": "檔案:行號 或 diff 片段"}]}\n```\n'
      + '**每一項都要附證據**（檔案與行號、diff 片段）。沒有證據的攔截只是浪費人的時間。\n'
      + '判不出來就回 needsHuman: true 並說明你卡在哪裡——猜一個「安全」比擋一次糟糕得多。',
  );
  return p.join('\n');
}

export function parseRiskResponse(text: string): MergeRiskVerdict | undefined {
  const json = extractJson(text);
  if (json === undefined) return undefined;
  const parsed = VerdictSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** 從回應裡挑出 JSON：優先 ```json 圍欄，其次第一個完整的大括號區塊。 */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], sliceBraces(text)].filter((c): c is string => typeof c === 'string');
  for (const c of candidates) {
    try {
      return JSON.parse(c) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
}

function sliceBraces(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}
