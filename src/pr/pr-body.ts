import type { TaskDetail, DiffStat } from '../types.js';

/** agent 提供的敘事段落（怎麼做/架構/畫面…由 agent 總結填入）。 */
export interface PrNarrative {
  what?: string;
  how?: string;
  architecture?: string;
  ui?: string;
  ux?: string;
  keyTech?: string;
}

export interface PrBodyInput {
  tasks: TaskDetail[];
  narrative?: PrNarrative;
  /**
   * narrative 是否真的來自 agent 的總結。
   *
   * 影響「缺席的敘事段要省略還是標（待補）」：agent 有總結卻沒寫某段 → 代表不適用，省略；
   * 完全沒總結（narrative 只是系統用任務標題補的）→ 那是真的沒寫，要留下（待補）讓人看見。
   * 未提供時退回「有沒有任何敘事欄位」來猜。
   */
  agentSummarized?: boolean;
  diff?: DiffStat;
  verification?: { name: string; ok: boolean }[];
  assumptions?: string[]; // agent 記錄的可逆預設
  screenshots?: string[]; // 截圖路徑或 URL（M4 視覺任務）
  rationale?: string; // planner 分群理由
  /**
   * 人工放行的紅燈（定案③）。有值就代表**這個 PR 帶著一個已知的失敗上線**。
   *
   * 這一段刻意放在最前面、用最大的字級（H2 ＋ ⚠）：它是整份 PR 裡唯一一件
   * 「審查者不主動找就不會知道、但一定要知道」的事。塞進「假設與待確認」的話，
   * 它會跟其他八條但書並排，看起來像例行公事。
   */
  knownRed?: { note: string; verdict: string };
}

const TBD = '（待補）';

/** 敘事欄位（順序即 PR 上的呈現順序）。 */
const NARRATIVE_FIELDS = ['what', 'how', 'architecture', 'ui', 'ux', 'keyTech'] as const;

/**
 * 產生 PR 內文（DESIGN.md §14 / 需求 5）：讓審查者快速掌握
 * 做了什麼／怎麼做／架構／畫面／操作／核心技術／驗證／假設／涵蓋任務。
 * 敘事段落由 agent 總結填入，機器事實（任務/diff/驗證/截圖）由調度器補上。
 */
export function generatePrBody(input: PrBodyInput): string {
  const n = input.narrative ?? {};
  const lines: string[] = [];
  const sec = (title: string, body?: string): void => {
    lines.push(`## ${title}`, '', body?.trim() ? body.trim() : TBD, '');
  };

  /**
   * 敘事段：**有內容才輸出**。
   *
   * agent 被明確要求「不適用的段落整段省略」（見 agent-runtime 的 SUMMARY_FORMAT），
   * 所以缺席多半代表「這個任務沒有這一項」——純文件變更本來就沒有架構/畫面/操作。
   * 一律印「（待補）」會讓審查者以為東西沒寫完，滿版的待補反而降低整份 PR 的可信度。
   *
   * 例外：agent 完全沒給總結時（下面的 hasNarrative 為 false），保留全部段落並標「（待補）」
   * ——那才是真的沒寫，審查者需要看到這個訊號。
   */
  const hasNarrative =
    input.agentSummarized ?? (NARRATIVE_FIELDS.some((f) => n[f]?.trim()) || (input.screenshots?.length ?? 0) > 0);
  const optionalSec = (title: string, body?: string): void => {
    if (body?.trim()) sec(title, body);
    else if (!hasNarrative) sec(title, undefined);
  };

  if (input.knownRed) {
    sec(
      '⚠ 帶著一個已知的失敗合併 (Known Red)',
      [
        `**人工放行理由**：${input.knownRed.note.trim()}`,
        '',
        '被放行的判決全文：',
        '',
        '```',
        input.knownRed.verdict.trim() || '（沒有留下判決內容）',
        '```',
      ].join('\n'),
    );
  }

  optionalSec('做了什麼 (What)', n.what);
  optionalSec('怎麼做 (How)', n.how);
  optionalSec('架構 (Architecture)', n.architecture);

  // 畫面設計：敘述 + 截圖（截圖以 markdown 圖片嵌入）
  const uiParts: string[] = [];
  if (n.ui?.trim()) uiParts.push(n.ui.trim());
  if (input.screenshots?.length) {
    uiParts.push(input.screenshots.map((s, i) => `![screenshot-${i + 1}](${s})`).join('\n'));
  }
  optionalSec('畫面設計 (UI)', uiParts.join('\n\n') || undefined);

  optionalSec('操作形式 (UX)', n.ux);
  optionalSec('核心關鍵技術 (Key Tech)', n.keyTech);

  // 驗證：關卡結果 + diff 統計
  const verLines: string[] = [];
  if (input.verification?.length) {
    for (const c of input.verification) verLines.push(`- ${c.ok ? '✅' : '❌'} ${c.name}`);
  }
  if (input.diff) {
    verLines.push(`- 變更檔案 ${input.diff.files.length} 個（+${input.diff.additions} / -${input.diff.deletions}）`);
  }
  sec('驗證 (Verification)', verLines.join('\n') || undefined);

  // 假設與待確認
  const asm = input.assumptions?.length ? input.assumptions.map((a) => `- ${a}`).join('\n') : '（無）';
  sec('假設與待確認 (Assumptions)', asm);

  // 涵蓋任務
  const taskBody = input.tasks
    .map((t) => {
      const refs = t.docRefs.length ? `（docRefs: ${t.docRefs.join(', ')}）` : '';
      return `- [${t.id}] ${t.title}${refs}`;
    })
    .join('\n');
  sec('涵蓋任務 (Tasks)', taskBody || TBD);

  if (input.rationale?.trim()) {
    lines.push('---', '', `> 分群理由：${input.rationale.trim()}`, '');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

// ── agent 總結 → PR 敘事 ──

/** 一個任務的結構化總結（agent 用 report_summary 交的）。 */
export interface AgentSummary {
  taskId: string;
  title: string;
  summary: {
    what?: string;
    how?: string;
    architecture?: string;
    ui?: string;
    ux?: string;
    keyTech?: string;
    assumptions?: string[];
  };
}

/**
 * 把多個任務的總結合成 PR 的敘事段。
 *
 * ── 這裡刻意不做什麼 ──
 *
 * 先前有六條中文關鍵字正則（`/(畫面|介面|版面|^ui$)/i` 之類）去猜 agent 散文裡的
 * markdown 標題屬於哪一欄，對不上就整段丟掉。agent 只要寫英文標題
 *（## Implementation / ## Changes）六條就全部落空、整份總結被丟光——
 * 而 PR 上是**一片空白不是一個警訊**（有文字所以 hasNarrative 為真，連「（待補）」都不印）。
 * 反過來也會錯配：講 UI 的總結只要標題裡有「架構」兩個字就被 architecture 收走。
 *
 * 荒謬的是資料一開始就是結構化的——提示詞規定了格式，程式卻讓 agent 渲染成散文、
 * 再用正則猜回來。現在它用 report_summary 直接交欄位，這裡只負責合併與搬運。
 *
 * 多個任務時各欄以「### 任務標題」分小節串接，不做摘要也不改寫。
 */
export function narrativeFromSummaries(
  summaries: AgentSummary[],
): { narrative: PrNarrative; assumptions: string[] } {
  const narrative: PrNarrative = {};
  const assumptions: string[] = [];
  const fields = ['what', 'how', 'architecture', 'ui', 'ux', 'keyTech'] as const;

  for (const f of fields) {
    const parts = summaries
      .map((s) => ({ title: s.title, text: s.summary[f]?.trim() }))
      .filter((x): x is { title: string; text: string } => Boolean(x.text));
    if (parts.length === 0) continue;
    narrative[f] = parts.length === 1
      ? parts[0]!.text
      : parts.map((x) => `### ${x.title}\n${x.text}`).join('\n\n');
  }
  for (const s of summaries) {
    for (const a of s.summary.assumptions ?? []) {
      if (a.trim()) assumptions.push(summaries.length > 1 ? `[${s.title}] ${a.trim()}` : a.trim());
    }
  }
  return { narrative, assumptions };
}
