import type { Task, PlanResult, PlannedGroup, ScheduleEdge } from '../types.js';
import type { Logger } from '../observability/logger.js';
import type { InFlightGroup } from './plan-agent.js';
import {
  FootprintScanner,
  docFile,
  footprintOverlap,
  type Footprint,
  type FootprintScanInput,
} from '../worker/footprint.js';
import { withActivity, type ActivitySink } from '../observability/activity.js';

/** FootprintScanner 的最小介面（測試注入假件用，不必扛真實 IO 依賴）。 */
export interface FootprintScannerLike {
  scan(input: FootprintScanInput): Promise<Footprint>;
}

/** 規劃 agent 的最小介面（測試注入假件用）。 */
export interface PlanAgentLike {
  plan(
    tasks: Task[],
    repoPath: string,
    inFlight: InFlightGroup[],
    /** 回報進度給控制台（第幾次嘗試）。可不理會。 */
    onProgress?: (detail: string) => void,
    signal?: AbortSignal,
  ): Promise<{
    groups: { id: string; taskIds: string[]; files: string[]; why: string; afterExisting?: string[] }[];
    stages: string[][];
  }>;
}

export interface PlannerDeps {
  /**
   * 「現在在規劃」的登記口。規劃 agent 讀完整個 repo 再分群實測要跑好幾分鐘，
   * 那段時間 ledger 完全靜止——沒有這個，控制台看起來就是停擺（使用者實際回報過）。
   */
  activity?: ActivitySink;
  /**
   * repo（"owner/name"）→ 本地 checkout 路徑。可選：回 undefined（或整個不注入）
   * 代表這個 repo 沒得掃，該 repo 全退回 docRef 代理足跡。
   */
  resolveRepoPath?: (repo: string) => string | undefined;
  /** 足跡掃描器（測試可注入假件）；未給時在有 repoPath 的情況下自建預設實作。 */
  scanner?: FootprintScannerLike;
  /**
   * 規劃 agent。**注入之後就是唯一路徑**：它失敗就整批規劃失敗，不退回啟發式。
   * 理由見 plan-agent.ts——規劃 agent 不通代表寫程式的 agent 也不通，
   * 退回猜測式分群只會製造下一次撞車。
   * 沒注入時（單元測試、無金鑰環境）才走既有的啟發式路徑。
   */
  planAgent?: PlanAgentLike;
  /**
   * 該 repo 目前「成果還沒進 base」的群組。
   *
   * 沒有這份資訊時，規劃 agent 是瞎的：它只看得到這一批任務與**現在的 repo 內容**，
   * 而上一批做完但還沒合併的東西不在 repo 裡。實跑會變成——新任務以那些成果為前提
   * （例如要記錄某個新函式），卻在一個沒有它們的 base 上開工，做出來的東西是錯的，
   * 而且它自己的 build/test 全綠，沒有任何一道關卡擋得住。
   */
  inFlightGroups?: (repo: string) => InFlightGroup[];
  log?: Logger;
}

/** 關鍵字相似度門檻：達到就視為「相似/適合一起做」而歸同群。校準依據見 keywordSim。 */
const SIM_THRESHOLD = 0.5;

/**
 * Planner（DESIGN §D8/D9）：讀任務內容 + 檔案足跡自行判斷分群與排序。
 * MCP 的 dependencies 只當「順序提示」；另用「共用 docRef 檔案」「關鍵字相似」補出
 * 隱性關聯與「相似/適合一起做」的分群。正確性由 Merge Guard 兜底，故此處為啟發式。
 *
 * 足跡（footprint）決定「群與群能不能並行」（D7）。若注入 resolveRepoPath，就用
 * FootprintScanner 掃 repo 內**實際會動到的程式碼檔案**；沒有本地 checkout 或掃不到時，
 * 才退回舊的「docRef 檔名代理」。代理很粗糙：兩個引用同一份 spec 的任務即使動完全不同的檔案
 * 也會被判定重疊；更麻煩的是共用 spec 本來就會被歸進同一群，所以代理足跡幾乎不可能跨群相交
 * ——沒有真實掃描時，Dispatcher 的足跡序列化形同虛設。
 */
export class Planner {
  private readonly log: Logger;

  constructor(private deps: PlannerDeps = {}) {
    this.log = deps.log ?? NOOP_LOG;
  }

  async plan(pending: Task[], signal?: AbortSignal): Promise<PlanResult> {
    const groups: PlannedGroup[] = [];

    // 只在同 repo 內分群
    const byRepo = new Map<string, Task[]>();
    for (const t of pending) {
      const arr = byRepo.get(t.repo) ?? [];
      arr.push(t);
      byRepo.set(t.repo, arr);
    }

    if (this.deps.planAgent) {
      for (const [repo, tasks] of byRepo) groups.push(...(await this.planWithAgent(repo, tasks, signal)));
      return { groups, schedule: scheduleFromStages(groups) };
    }

    for (const [repo, tasks] of byRepo) {
      const prints = await this.scanRepo(repo, tasks);
      // 分詞成本不低（Intl.Segmenter），而下面是 O(n²) 兩兩比對 → 先算好一份
      const tokenized = new Map(tasks.map((t) => [t.id, tokens(t)] as const));

      const uf = new UnionFind();
      const ids = new Set(tasks.map((t) => t.id));
      for (const t of tasks) uf.find(t.id);

      // 依賴邊（只當提示，用於關聯）
      for (const t of tasks) for (const d of t.dependencies) if (ids.has(d)) uf.union(t.id, d);

      // 共用 docRef 檔案 / 關鍵字相似 → 視為同群（相似/適合一起做）
      // 注意：足跡重疊**不**併群——不相干的兩件事撞到同一個檔案，應該是「序列跑」而不是
      // 「塞進同一個 PR」，所以改用下面的 file-overlap 排程邊處理。
      for (let i = 0; i < tasks.length; i++) {
        for (let j = i + 1; j < tasks.length; j++) {
          const a = tasks[i]!;
          const b = tasks[j]!;
          const sim = keywordSim(tokenized.get(a.id)!, tokenized.get(b.id)!);
          if (sharesDocFile(a, b) || sim >= SIM_THRESHOLD) uf.union(a.id, b.id);
        }
      }

      // 收集連通分量 → 群
      const comp = new Map<string, Task[]>();
      for (const t of tasks) {
        const r = uf.find(t.id);
        const arr = comp.get(r) ?? [];
        arr.push(t);
        comp.set(r, arr);
      }
      for (const members of comp.values()) {
        const ordered = topoSort(members);
        // 逐任務退回：掃到真實檔案就用真實的，沒掃到的成員仍用 docRef 代理（寧可保守序列化）
        const footprint = uniq(members.flatMap((m) => prints.get(m.id) ?? m.docRefs.map(docFile)));
        groups.push({ repo, taskIds: ordered.map((t) => t.id), footprint, rationale: rationale(members), stageIndex: 0 });
      }
    }

    // 跨群依賴 → 群間序列邊（保險；正常情況依賴會被歸進同群）
    const schedule: ScheduleEdge[] = [];
    const groupOf = new Map<string, number>();
    groups.forEach((g, idx) => g.taskIds.forEach((id) => groupOf.set(id, idx)));
    for (const t of pending) {
      for (const d of t.dependencies) {
        const gi = groupOf.get(t.id);
        const gj = groupOf.get(d);
        if (gi != null && gj != null && gi !== gj) {
          schedule.push({ fromGroup: String(gj), toGroup: String(gi), reason: 'dep' });
        }
      }
    }

    // 同 repo 且足跡重疊的群 → file-overlap 序列邊（DESIGN §D7）。
    // Dispatcher 執行期本來就會擋，這裡明寫出來是為了讓「這兩群為何不並行」可被檢視/記錄；
    // 方向固定為索引小者先（誰先跑不影響正確性，重點是別同時跑），輸出才可預期。
    // 同 repo 的依賴一定已被併進同一群，所以這裡不會和上面的 dep 邊指到同一對群。
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i]!;
        const b = groups[j]!;
        if (a.repo !== b.repo) continue;
        const hit = footprintOverlap(a.footprint, b.footprint);
        if (hit.length === 0) continue;
        schedule.push({ fromGroup: String(i), toGroup: String(j), reason: 'file-overlap' });
        this.log.debug({ from: i, to: j, files: hit.slice(0, 5) }, '群間足跡重疊，安排序列');
      }
    }

    return { groups, schedule };
  }

  /**
   * 用規劃 agent 排這個 repo 的分群與階段。
   *
   * 失敗一律往上擲：這是刻意的。規劃 agent 呼叫不通，代表後面寫程式的 agent 也不通，
   * 此時退回啟發式分群只是把問題往後推——而且推成一個更難查的形態（並行撞車）。
   */
  private async planWithAgent(repo: string, tasks: Task[], signal?: AbortSignal): Promise<PlannedGroup[]> {
    const repoPath = this.deps.resolveRepoPath?.(repo);
    if (!repoPath) {
      throw new Error(`規劃 ${repo} 需要本地 checkout 路徑（規劃 agent 要實際看 repo 才判斷得出誰會撞誰）`);
    }
    const inFlight = this.deps.inFlightGroups?.(repo) ?? [];
    if (inFlight.length > 0) {
      this.log.info(
        { repo, inFlight: inFlight.map((g) => `${g.id}(${g.state})`) },
        '規劃時告知 agent：這些群組的成果還沒進 base',
      );
    }
    const plan = this.deps.activity
      ? await withActivity(
          this.deps.activity,
          {
            id: `plan:${repo}`,
            kind: 'plan',
            repo,
            title: `規劃 ${tasks.length} 個任務要怎麼分群`,
            detail: '讀 repo 判斷誰會動到同一批檔案',
          },
          (update) => this.deps.planAgent!.plan(tasks, repoPath, inFlight, update, signal),
        )
      : await this.deps.planAgent!.plan(tasks, repoPath, inFlight, undefined, signal);

    // 群代號 → 階段序號。parsePlanResponse 已保證每個群剛好出現在一個階段。
    const stageOf = new Map<string, number>();
    plan.stages.forEach((ids, i) => ids.forEach((id) => stageOf.set(id, i)));

    const out = plan.groups.map((g) => ({
      repo,
      taskIds: g.taskIds,
      footprint: g.files,
      rationale: g.why,
      stageIndex: stageOf.get(g.id) ?? 0,
      ...(g.afterExisting?.length ? { afterExisting: g.afterExisting } : {}),
    }));
    this.log.info(
      { repo, groups: out.length, stages: plan.stages.length },
      '規劃 agent 完成分群',
    );
    for (const g of out) {
      this.log.info(
        {
          repo, stage: g.stageIndex, tasks: g.taskIds, files: g.footprint.slice(0, 8), why: g.rationale,
          ...('afterExisting' in g ? { 等待既有群組: g.afterExisting } : {}),
        },
        '  群',
      );
    }
    return out;
  }

  /**
   * 掃描該 repo 全部任務的真實檔案足跡。回傳 Map<taskId, 足跡（檔案 + 所屬目錄）>；
   * 沒有本地路徑、掃描失敗或掃不到檔案的任務**不入表**，呼叫端據此退回 docRef 代理。
   */
  private async scanRepo(repo: string, tasks: Task[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const repoPath = this.deps.resolveRepoPath?.(repo);
    if (!repoPath) return out;

    const scanner = this.deps.scanner ?? new FootprintScanner({ log: this.log });
    for (const t of tasks) {
      try {
        // 刻意不傳 docRefs：spec 路徑會被掃成「命中檔案」，等於把想擺脫的代理又塞回足跡，
        // 讓引用同一份規格的群互相序列化。這裡只要任務文字推得出的**程式碼**檔案。
        const fp = await scanner.scan({ repoPath, title: t.title, description: t.description });
        // 目錄一起放進足跡：掃描是啟發式、必然漏檔，同目錄視為重疊可補回一些漏判（D9 保守優先）
        if (fp.files.length > 0) out.set(t.id, [...fp.files, ...fp.dirs]);
      } catch (e) {
        // 掃描是最佳化而非正確性來源 → 失敗就當作沒掃到，退回代理，絕不讓 plan 整個炸掉
        this.log.warn(
          { repo, task: t.id, err: e instanceof Error ? e.message : String(e) },
          '足跡掃描失敗，該任務退回 docRef 代理',
        );
      }
    }
    return out;
  }
}

// ── helpers ──

const NOOP_LOG = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let p = this.parent.get(x)!;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
}

function sharesDocFile(a: Task, b: Task): boolean {
  const filesA = new Set(a.docRefs.map(docFile));
  return b.docRefs.some((r) => filesA.has(docFile(r)));
}

/**
 * 停用詞：虛詞 + 任務板高頻套語（「新增」「調整」「支援」幾乎每張卡都有，沒有鑑別度）。
 * 中英對稱處理——中文有「新增」就對應濾掉英文的 add/create，否則兩種語言的相似度不同尺度。
 */
const STOP = new Set([
  // 中文虛詞（多為單字，主要靠長度過濾，這裡列出是為了讓它們能「切斷」單字合併，見 tokens）
  '的', '了', '在', '與', '和', '或', '及', '以', '其', '並', '就', '也', '但', '而', '等', '是', '有',
  '個', '這', '那', '要', '把', '為', '讓', '使', '時', '當', '後', '前', '上', '下', '中', '到', '從',
  '對', '於', '向', '被', '會', '能', '可', '再', '都', '很', '太', '用', '做', '給', '即', '則', '此',
  '該', '各', '每',
  // 任務板套語
  '新增', '加入', '建立', '頁面', '任務', '描述', '功能', '調整', '修改', '支援', '處理', '需要',
  '目前', '應該', '可以', '增加', '實作', '優化', '改成', '相關', '以及', '一個', '必須', '確認',
  // 英文
  'the', 'a', 'an', 'to', 'in', 'on', 'of', 'for', 'and', 'or', 'with', 'is', 'be', 'it', 'this',
  'that', 'from', 'by', 'at', 'as', 'add', 'create', 'new', 'update', 'support', 'make', 'when',
  'should', 'need', 'can',
]);

/** Intl.Segmenter 建構成本高，模組層建一次重複用。 */
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });
const HAN = /^\p{Script=Han}+$/u;

/**
 * 斷詞：中文靠 Intl.Segmenter（Node 24 內建 ICU），英數維持原本的處理。
 *
 * 為什麼要斷中文：舊版用 `split(/[^a-z0-9一-鿿]+/)` 切，整串 CJK 會變成**單一 token**，
 * 「深色模式切換開關」與「深色模式切換預設」永遠零交集 → 中文任務板的關鍵字相似度完全失效，
 * 實質上只剩 docRef 與 dependencies 能分群。
 *
 * 額外做「單字合併成 bigram」：ICU 的 zh 詞典偏簡體，繁體常見複合詞會被切成單字
 * （表/單、載/入、回/傳、財/報）。單字本身是雜訊必須濾掉，但連續單字接回來取二字窗
 * 就能救回這些詞；停用詞單字會切斷連續段，避免產生「單的」這種跨詞垃圾。
 */
function tokens(t: Task): Set<string> {
  const out = new Set<string>();
  let run: string[] = [];
  const flush = (): void => {
    if (run.length >= 2) {
      const s = run.join('');
      for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
    }
    run = [];
  };

  for (const seg of SEGMENTER.segment(`${t.title} ${t.description}`.toLowerCase())) {
    if (!seg.isWordLike) {
      flush(); // 標點/空白視為詞界，不可跨越合併
      continue;
    }
    const w = seg.segment;
    if (w.length === 1 && HAN.test(w)) {
      if (STOP.has(w)) flush();
      else run.push(w);
      continue;
    }
    flush();
    if (w.length < 2 || STOP.has(w)) continue; // 單字元英數是雜訊（T-1 的 t、1）
    out.add(w);
  }
  flush();

  for (const w of out) if (STOP.has(w)) out.delete(w); // bigram 也可能拼出套語
  return out;
}

/**
 * Jaccard 相似度。門檻 SIM_THRESHOLD = 0.5，以中英語料校準：
 *   合併側 — dark mode toggle 兩張 0.83、深色模式切換兩張 0.50、登入表單驗證訊息兩張 0.60
 *   不合併側 — payment/gateway/retry 兩張 0.30、深色模式 vs 推播通知 0.11、其餘互不相干者 0
 * 中文語料的分數普遍低於英文（描述短、詞數少），但 0.30 與 0.50 之間仍有明確落差，
 * 故沿用 0.5：**寧可少合併**——誤合會把不相干的改動塞進同一個分支/PR，代價比多開一群高。
 */
function keywordSim(ta: Set<string>, tb: Set<string>): number {
  // 文字太稀疏（如只有一兩個共通常用詞）不足以判定相似，避免過度合併
  if (ta.size < 3 || tb.size < 3) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** 群內依 dependencies 拓樸排序（Kahn）；無依賴者維持原順序。 */
function topoSort(members: Task[]): Task[] {
  const ids = new Set(members.map((m) => m.id));
  const indeg = new Map<string, number>();
  const next = new Map<string, string[]>();
  for (const m of members) indeg.set(m.id, 0);
  for (const m of members) {
    for (const d of m.dependencies) {
      if (ids.has(d)) {
        indeg.set(m.id, (indeg.get(m.id) ?? 0) + 1);
        next.set(d, [...(next.get(d) ?? []), m.id]);
      }
    }
  }
  const byId = new Map(members.map((m) => [m.id, m]));
  const queue = members.filter((m) => (indeg.get(m.id) ?? 0) === 0).map((m) => m.id);
  const out: Task[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    out.push(byId.get(id)!);
    for (const nx of next.get(id) ?? []) {
      indeg.set(nx, (indeg.get(nx) ?? 0) - 1);
      if ((indeg.get(nx) ?? 0) === 0) queue.push(nx);
    }
  }
  // 若有環（不應發生），把剩餘者補上
  for (const m of members) if (!out.includes(m)) out.push(m);
  return out;
}

function rationale(members: Task[]): string {
  if (members.length === 1) return '獨立任務（無關聯）';
  const files = uniq(members.flatMap((m) => m.docRefs.map(docFile)));
  const hasDeps = members.some((m) => m.dependencies.some((d) => members.some((x) => x.id === d)));
  const parts: string[] = [];
  if (files.length) parts.push(`共用規格 ${files.join(', ')}`);
  if (hasDeps) parts.push('存在前後依賴');
  return `${members.length} 個任務歸為一群（${parts.join('；') || '關鍵字相似'}）`;
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/**
 * 階段 → 群間序列邊。相鄰階段之間連邊即可：階段 k 的群都排在 k-1 之後，
 * 而 k-1 又排在 k-2 之後，遞移關係自然成立，不必連出 O(n²) 條邊。
 */
export function scheduleFromStages(groups: PlannedGroup[]): ScheduleEdge[] {
  const edges: ScheduleEdge[] = [];
  const idxOfStage = new Map<number, number[]>();
  groups.forEach((g, i) => idxOfStage.set(g.stageIndex, [...(idxOfStage.get(g.stageIndex) ?? []), i]));
  const stages = [...idxOfStage.keys()].sort((a, b) => a - b);
  for (let s = 1; s < stages.length; s++) {
    for (const from of idxOfStage.get(stages[s - 1]!) ?? []) {
      for (const to of idxOfStage.get(stages[s]!) ?? []) {
        edges.push({ fromGroup: String(from), toGroup: String(to), reason: 'file-overlap' });
      }
    }
  }
  return edges;
}
