import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Task } from '../types.js';
import type { Logger } from '../observability/logger.js';

/**
 * 規劃 agent：讀任務內容 + 實際的 repo，決定**分成哪幾群**與**群的執行順序**。
 *
 * 為什麼不是程式：分群的判準是「這幾個任務會不會動到同一批程式碼」，那需要看懂
 * 任務在講什麼、再對應到 repo 裡的哪些檔案。先前用關鍵字相似度 + 正規表示式抽路徑
 * 來猜，實跑時「在 /sandbox 頁面加上深色模式切換」與「在 /sandbox 頁面加上複製按鈕」
 * 兩個任務**一個檔案都沒掃到**——因為「/sandbox 頁面」既不像路徑也不像識別字——
 * 於是被判定互不相干而並行，最後撞在同一個 SandboxView.vue 上。
 * 人看一眼就知道那兩個會撞；規則看不出來。
 *
 * 失敗就是失敗：這裡**不做任何退化**。規劃 agent 呼叫不通，代表後面寫程式的 agent
 * 一樣不通，退回猜測式分群只會製造下一次撞車。
 */

export interface PlanAgentGroup {
  /** 群組代號（agent 自己取，只在這份計畫內有意義，如 "A"）。 */
  id: string;
  taskIds: string[];
  /** 預期會動到的檔案／目錄（repo 相對路徑）。 */
  files: string[];
  /** 為什麼這幾個放一起——要讓人看得懂，會顯示在卡片與控制台。 */
  why: string;
  /**
   * 這一群要等哪些**已經存在**的群組先進 base（真實群組 id，如 g_7c29f4e10efb）。
   *
   * 為什麼需要：任務是一批一批進來的。第二批規劃時，第一批可能還在跑、
   * 或者已經做完開了 PR 但還沒合併——那些成果**在 main 裡並不存在**。
   * 新任務若以它們為前提，就必須等。這件事沒辦法用「階段」表達，
   * 因為階段只排得了同一次規劃裡的群組。
   */
  afterExisting?: string[];
}

/** 規劃當下「成果還沒進 base」的群組——規劃 agent 判斷跨批次依賴的唯一依據。 */
export interface InFlightGroup {
  id: string;
  /** 群組狀態（pr_open / in_review 這兩個最關鍵：MCP 說任務 done，但 main 裡沒有）。 */
  state: string;
  tasks: { id: string; title: string }[];
  /** 這一群動到（或預期動到）哪些檔案。 */
  files: string[];
  prUrl?: string;
}

export interface PlanAgentResult {
  groups: PlanAgentGroup[];
  /** 執行階段：同一階段內可並行，階段之間依序。例：[["A"],["B","C"],["D"]]。 */
  stages: string[][];
}

const GroupSchema = z.object({
  id: z.string().min(1),
  taskIds: z.array(z.string().min(1)).min(1),
  files: z.array(z.string()).default([]),
  why: z.string().default(''),
  afterExisting: z.array(z.string().min(1)).default([]),
});
const ResultSchema = z.object({
  groups: z.array(GroupSchema).min(1),
  stages: z.array(z.array(z.string().min(1))).min(1),
});

/** SDK query 的最小結構介面，供注入假件（測試不需要金鑰）。 */
export type PlanQueryFn = (args: { prompt: string; cwd: string }) => AsyncIterable<Record<string, unknown>>;

export interface PlanAgentDeps {
  log: Logger;
  /** 模型別名（opus / sonnet / haiku）。未給 → SDK 預設。 */
  model?: string;
  queryFn?: PlanQueryFn;
  /** 規劃 agent 回應不合格時最多重問幾次（預設 1 次重問）。 */
  retries?: number;
}

/** 規劃 agent 只讀不寫：它的職責是判斷，不是動手改東西。 */
const PLAN_TOOLS = ['Read', 'Glob', 'Grep'];

const SYSTEM_PROMPT =
  '你是開發工作的排程規劃者。你的職責是決定「哪些任務該分在同一群」與「群之間的執行順序」，' +
  '判準是它們會不會動到同一批程式碼、以及有沒有先後依賴。' +
  '你可以用 Read/Glob/Grep 實際看 repo 來確認任務會落在哪些檔案，不要憑任務標題猜。' +
  '只輸出要求的 JSON。';

export class PlanAgent {
  constructor(private deps: PlanAgentDeps) {}

  /**
   * @throws 規劃失敗（呼叫不通、回應解析不出、內容不自洽）一律擲錯，由上層停下來報給人。
   */
  async plan(tasks: Task[], repoPath: string, inFlight: InFlightGroup[] = []): Promise<PlanAgentResult> {
    const attempts = 1 + Math.max(0, this.deps.retries ?? 1);
    let lastErr = '';
    for (let i = 1; i <= attempts; i += 1) {
      const prompt = buildPlanPrompt(tasks, inFlight, lastErr);
      const text = await this.runQuery(prompt, repoPath);
      const parsed = parsePlanResponse(text, tasks.map((t) => t.id), inFlight.map((g) => g.id));
      if (parsed.ok) {
        this.deps.log.info(
          { groups: parsed.value.groups.length, stages: parsed.value.stages.map((s) => s.length) },
          '規劃 agent 完成分群與排序',
        );
        return parsed.value;
      }
      lastErr = parsed.error;
      this.deps.log.warn({ attempt: i, of: attempts, err: parsed.error }, '規劃 agent 回應不合格');
    }
    throw new Error(`規劃 agent 無法產出可用的計畫（試了 ${attempts} 次）：${lastErr}`);
  }

  private async runQuery(prompt: string, cwd: string): Promise<string> {
    const q: PlanQueryFn =
      this.deps.queryFn ??
      ((args) =>
        query({
          prompt: args.prompt,
          options: {
            ...(this.deps.model ? { model: this.deps.model } : {}),
            cwd: args.cwd,
            permissionMode: 'acceptEdits', // 工具已限制唯讀，此處只為避免非互動環境卡在權限詢問
            allowedTools: PLAN_TOOLS,
            systemPrompt: SYSTEM_PROMPT,
          },
        }) as AsyncIterable<Record<string, unknown>>);

    let out = '';
    for await (const raw of q({ prompt, cwd })) {
      const m = raw as { type?: string; subtype?: string; result?: string };
      if (m.type === 'result') {
        if (m.subtype === 'success') out = m.result ?? '';
        else throw new Error(`規劃 agent 回傳錯誤結果：${m.subtype ?? 'unknown'}`);
      }
    }
    return out;
  }
}

// ── 純函式（可無金鑰完整單元驗證） ──

export function buildPlanPrompt(tasks: Task[], inFlight: InFlightGroup[] = [], previousError = ''): string {
  const p: string[] = [];
  p.push('# 規劃這批任務的分群與執行順序');
  p.push(
    '\n你在一個 git repo 的根目錄。請先用 Glob/Grep/Read 看清楚 repo 的實際結構，' +
      '判斷每個任務會動到哪些檔案，**不要只看標題猜**。',
  );

  p.push(`\n## 待辦任務（共 ${tasks.length} 個）`);
  for (const t of tasks) {
    p.push(`\n### ${t.id}｜${t.title}`);
    p.push(`類別：${t.category}`);
    if (t.dependencies.length > 0) p.push(`任務板宣告的前置任務：${t.dependencies.join('、')}`);
    if (t.docRefs.length > 0) p.push(`規格：${t.docRefs.join('、')}`);
    p.push(t.description);
  }

  if (inFlight.length > 0) {
    p.push(
      `\n## 已經在進行、但成果**還沒進 ${'`main`'}** 的群組（共 ${inFlight.length} 群）\n` +
        `任務是一批一批進來的，這些是上一批還沒收尾的。**它們的改動現在不在 repo 裡**——\n` +
        `你用 Read/Grep 看到的程式碼**沒有**這些內容。\n` +
        `特別注意 ${'`pr_open`'} 與 ${'`in_review`'}：那些任務在任務板上已經是「完成」，\n` +
        `但 PR 還沒合併，所以對新任務來說等同於**不存在**。`,
    );
    for (const g of inFlight) {
      p.push(`\n### ${g.id}（${g.state}）`);
      p.push(`任務：${g.tasks.map((t) => `${t.id} ${t.title}`).join('｜') || '（無）'}`);
      if (g.files.length > 0) p.push(`動到：${g.files.slice(0, 20).join('、')}`);
      if (g.prUrl) p.push(`PR：${g.prUrl}`);
    }
  }

  p.push(
    `\n## 判準\n` +
      `1. **同一群**：會動到同一批檔案、或內容高度相關而分開做只會互相打架的任務。\n` +
      `   同一群會在同一個工作區依序完成，最後合成一個 PR。\n` +
      `2. **不同群但同一階段**（可並行）：確定不會動到彼此的檔案。\n` +
      `3. **不同階段**（要排隊）：後者依賴前者的成果，或雖然不是同一群、但很可能改到\n` +
      `   同一個檔案。**判斷不準時一律排到不同階段**——並行撞車的代價遠高於多等一輪。\n` +
      `4. 任務板宣告的前置任務一定要被順序滿足。`
      + (inFlight.length > 0
        ? `\n5. **跨批次的依賴用 ${'`afterExisting`'}**：如果某一群的內容以上面那些尚未合併\n`
          + `   的群組成果為前提（例如要記錄某個新函式、要改某個還不存在的元件），\n`
          + `   就把那個群組 id 填進該群的 ${'`afterExisting`'}。它會等到那一群真的合併才開工。\n`
          + `   只是「可能動到同一個檔案」也可以填——那會序列化，避免衝突。`
        : ''),
  );

  p.push(
    `\n## 輸出格式（只輸出一個 JSON 程式碼區塊，不要其他文字）\n` +
      '```json\n' +
      `{\n` +
      `  "groups": [\n` +
      `    { "id": "A", "taskIds": ["T-1"], "files": ["src/views/Foo.vue"],\n` +
      `      "why": "為什麼這幾個一組（給人看的）", "afterExisting": [] }\n` +
      `  ],\n` +
      `  "stages": [["A"], ["B", "C"]]\n` +
      `}\n` +
      '```\n' +
      `規則：每個任務**剛好**出現在一個群裡；每個群**剛好**出現在一個階段裡；` +
      `stages 的順序就是執行順序，同一階段內並行。` +
      `afterExisting 只能填上面列出的既有群組 id（沒有就給空陣列）。`,
  );

  if (previousError) {
    p.push(`\n## 上一次回應不合格，請修正後重出\n${previousError}`);
  }
  return p.join('\n');
}

export type ParseResult =
  | { ok: true; value: PlanAgentResult }
  | { ok: false; error: string };

/**
 * 解析並**驗證計畫自洽**：任務不重不漏、群不重不漏。
 *
 * 檢查不是形式主義：少一個任務代表它永遠不會被做（而且沒有任何錯誤訊息），
 * 重複一個任務代表它會被兩個群同時實作 —— 這兩種都比「規劃失敗」難查得多。
 */
export function parsePlanResponse(text: string, taskIds: string[], inFlightIds: string[] = []): ParseResult {
  const json = extractJson(text);
  if (json === undefined) return { ok: false, error: '找不到可解析的 JSON 區塊' };

  const parsed = ResultSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `JSON 結構不符：${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}` };
  }
  const value = parsed.data;

  const planned = value.groups.flatMap((g) => g.taskIds);
  const dupTask = planned.filter((id, i) => planned.indexOf(id) !== i);
  if (dupTask.length > 0) return { ok: false, error: `這些任務被分到不只一個群：${uniq(dupTask).join('、')}` };

  const missing = taskIds.filter((id) => !planned.includes(id));
  if (missing.length > 0) return { ok: false, error: `這些任務沒有被分到任何群：${missing.join('、')}` };

  const unknown = planned.filter((id) => !taskIds.includes(id));
  if (unknown.length > 0) return { ok: false, error: `這些任務不在待辦清單裡：${uniq(unknown).join('、')}` };

  const groupIds = value.groups.map((g) => g.id);
  const dupGroup = groupIds.filter((id, i) => groupIds.indexOf(id) !== i);
  if (dupGroup.length > 0) return { ok: false, error: `群組代號重複：${uniq(dupGroup).join('、')}` };

  const staged = value.stages.flat();
  const dupStaged = staged.filter((id, i) => staged.indexOf(id) !== i);
  if (dupStaged.length > 0) return { ok: false, error: `這些群被排進不只一個階段：${uniq(dupStaged).join('、')}` };

  const unstaged = groupIds.filter((id) => !staged.includes(id));
  if (unstaged.length > 0) return { ok: false, error: `這些群沒有被排進任何階段：${unstaged.join('、')}` };

  const ghost = staged.filter((id) => !groupIds.includes(id));
  if (ghost.length > 0) return { ok: false, error: `階段裡出現不存在的群：${uniq(ghost).join('、')}` };

  // afterExisting 只能指向真實存在的既有群組。指錯一律當錯誤重問，不默默丟掉——
  // 丟掉的話那個依賴就永遠不存在，而它正是「B 需要 A 的成果」這種最要命的關係。
  const badAfter = uniq(value.groups.flatMap((g) => g.afterExisting).filter((id) => !inFlightIds.includes(id)));
  if (badAfter.length > 0) {
    return {
      ok: false,
      error:
        `afterExisting 指到不存在的群組：${badAfter.join('、')}。`
        + `只能填上面列出的既有群組 id${inFlightIds.length > 0 ? `（${inFlightIds.join('、')}）` : '（這次一個也沒有，請給空陣列）'}。`,
    };
  }

  return { ok: true, value };
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

const uniq = (xs: string[]): string[] => [...new Set(xs)];
