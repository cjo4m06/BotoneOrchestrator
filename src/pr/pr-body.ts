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
}

const TBD = '（待補）';

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

/** 一個任務的 agent 最終總結（GroupRunner 側錄 IterateResult.resultText 得來）。 */
export interface AgentSummary {
  taskId: string;
  title: string;
  text: string;
}

/** 敘事欄位順序（同時決定多任務合併時的段落順序）。 */
const NARRATIVE_FIELDS = ['what', 'how', 'architecture', 'ui', 'ux', 'keyTech'] as const;

/**
 * 標題關鍵字 → 敘事欄位。順序即優先序：'畫面設計' 必須先被 ui 收走，
 * 否則會被之後的規則誤判（所以 architecture 只認「架構」，不認「設計」）。
 */
const FIELD_PATTERNS: { field: (typeof NARRATIVE_FIELDS)[number]; re: RegExp }[] = [
  { field: 'ui', re: /(畫面|介面|版面|^ui$|\bui\b)/i },
  { field: 'ux', re: /(操作|互動|使用流程|^ux$|\bux\b)/i },
  { field: 'keyTech', re: /(核心技術|關鍵技術|技術重點|技術選型|key\s*tech)/i },
  { field: 'architecture', re: /(架構|architecture)/i },
  { field: 'how', re: /(怎麼做|做法|實作|實做|變更內容|how)/i },
  { field: 'what', re: /(做了什麼|完成內容|變更摘要|摘要|總結|what|summary)/i },
];

/** 假設段的標題關鍵字（PR「假設與待確認」欄位）。 */
const ASSUMPTION_RE = /(假設|預設值|待確認|待釐清|assumption)/i;

/** 「其實沒有假設」的常見寫法，不該變成一條假設。 */
const EMPTY_RE = /^[（(]?\s*(無|沒有|none|n\/?a)\s*[）)]?[。.]?$/i;

/**
 * 解析單一 agent 總結：把 markdown 段落對映到 PR 敘事欄位與假設清單。
 * agent 的總結格式不受控（自由文字），所以採「寬鬆比對 + 保守放棄」：
 * 對不上的段落一律忽略，寧可讓 PR 標「（待補）」，也不要塞錯段落誤導審查者。
 */
export function parseAgentSummary(text: string): { narrative: PrNarrative; assumptions: string[] } {
  const narrative: PrNarrative = {};
  const assumptions: string[] = [];
  let preamble = '';

  for (const s of splitSections(text)) {
    const body = s.lines.join('\n').trim();
    if (!body) continue;
    if (!s.heading) {
      // 無標題前言：當「做了什麼」的後備（很多 agent 只寫一段話就交差）
      if (!preamble) preamble = body;
      continue;
    }
    if (ASSUMPTION_RE.test(s.heading)) {
      assumptions.push(...toItems(body));
      continue;
    }
    const hit = FIELD_PATTERNS.find((p) => p.re.test(s.heading));
    if (!hit) continue;
    if (!narrative[hit.field]) narrative[hit.field] = body; // 同欄位重複出現時取第一段
  }

  if (!narrative.what && preamble) narrative.what = preamble;
  // 沒有假設段時，退而掃全文條列中含「假設」字樣的行（agent 常把假設寫在結尾清單裡）
  if (assumptions.length === 0) {
    assumptions.push(...bulletsOf(text).filter((b) => ASSUMPTION_RE.test(b)));
  }
  return { narrative, assumptions: dedupe(assumptions) };
}

/**
 * 合併同一群多個任務的 agent 總結成一份 PR 敘事。
 * 多任務時每段以 `### 任務標題` 分小節，避免不同任務的敘述糊在一起；
 * 全部沒有內容的欄位不填（由 generatePrBody 標「（待補）」）。
 */
export function narrativeFromSummaries(
  summaries: AgentSummary[],
): { narrative: PrNarrative; assumptions: string[] } {
  const parsed = summaries
    .filter((s) => s.text.trim())
    .map((s) => ({ src: s, out: parseAgentSummary(s.text) }));
  const multi = parsed.length > 1;

  const narrative: PrNarrative = {};
  for (const field of NARRATIVE_FIELDS) {
    const parts = parsed.flatMap(({ src, out }) => {
      const v = out.narrative[field];
      return v ? [{ title: src.title, value: v }] : [];
    });
    if (parts.length === 0) continue;
    narrative[field] = multi
      ? parts.map((p) => `### ${p.title}\n\n${p.value}`).join('\n\n')
      : parts[0]!.value;
  }

  const assumptions = dedupe(
    parsed.flatMap(({ src, out }) => out.assumptions.map((a) => (multi ? `[${src.taskId}] ${a}` : a))),
  );
  return { narrative, assumptions };
}

interface RawSection {
  heading: string;
  lines: string[];
}

/**
 * 依標題切段。markdown `#` 標題一律開新段（未知標題也要切，否則後文會污染前一段）；
 * `**粗體標籤**：` 只有在對得上已知欄位時才視為標題，避免內文的粗體強調把段落切碎。
 */
function splitSections(text: string): RawSection[] {
  const sections: RawSection[] = [{ heading: '', lines: [] }];
  for (const raw of text.split('\n')) {
    const md = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(raw);
    if (md) {
      sections.push({ heading: cleanHeading(md[1]!), lines: [] });
      continue;
    }
    const bold = /^\s*(?:[-*+]\s+)?\*\*(.+?)\*\*\s*(?:[:：]\s*(.*))?$/.exec(raw);
    const boldTitle = bold ? cleanHeading(bold[1]!) : '';
    if (bold && isKnownHeading(boldTitle)) {
      const rest = bold[2]?.trim() ?? '';
      sections.push({ heading: boldTitle, lines: rest ? [rest] : [] });
      continue;
    }
    sections[sections.length - 1]!.lines.push(raw);
  }
  return sections;
}

const isKnownHeading = (h: string): boolean =>
  ASSUMPTION_RE.test(h) || FIELD_PATTERNS.some((p) => p.re.test(h));

const cleanHeading = (s: string): string => s.replace(/[*#`]/g, '').replace(/[:：]\s*$/, '').trim();

/** 段落 → 條列項目；沒有條列符號時整段視為一項（換行折成空白，才能塞進 `- ` 清單）。 */
function toItems(body: string): string[] {
  const bullets = bulletsOf(body);
  if (bullets.length > 0) return bullets;
  const flat = body.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  return flat && !EMPTY_RE.test(flat) ? [flat] : [];
}

function bulletsOf(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const item = m[1]!.replace(/^\[[ xX]\]\s*/, '').trim();
    if (item && !EMPTY_RE.test(item)) out.push(item);
  }
  return out;
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];
