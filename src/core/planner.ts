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
  /**
   * 規劃 agent。**注入之後就是唯一路徑**：它失敗就整批規劃失敗，不退回啟發式。
   * 理由見 plan-agent.ts——規劃 agent 不通代表寫程式的 agent 也不通，
   * 退回猜測式分群只會製造下一次撞車。
   * 沒注入時（單元測試、無金鑰環境）才走既有的啟發式路徑。
   */
  /** 分群的唯一實作。沒有它 plan() 會明確擲錯——不再有啟發式退路。 */
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

    // **沒有規劃 agent 就不開工。**
    //
    // 這裡原本有一條啟發式退路：中文分詞 ＋ Jaccard 關鍵字相似度 ＋ docRef 共用檔案，
    // 用聯集查找把任務併成群。它的問題不是「不夠準」，是**換一個專案就整個失效而且沒人會知道**：
    // 「深色模式切換開關」與「深色模式切換預設」在分詞後永遠零交集；停用詞表是照著
    // 某一塊任務板的高頻套語調出來的；門檻 0.5 是拿當時的語料校準的。
    // 換一塊任務板、換一種寫卡片的習慣，它會安靜地把不相干的東西併成一群、
    // 或把該一起做的拆開——而**分群錯了的症狀要到合併衝突那一刻才看得到**。
    //
    // 分群是「讀完整個 repo 才判斷得出誰會撞誰」的工作（實測十幾分鐘），那是 agent 的事。
    // 沒有它就明確停手（呼叫端會開一張交接單），比拿一個會壞的啟發式硬跑好。
    if (!this.deps.planAgent) {
      throw new Error(
        '沒有規劃 agent（多半是 Claude 認證失效或未設定），無法分群。'
        + '分群要讀完整個 repo 才判斷得出哪些任務會動到同一批檔案，'
        + '硬用關鍵字相似度湊出來的群會等到合併時才炸開。請先修好認證再開工。',
      );
    }
    for (const [repo, tasks] of byRepo) groups.push(...(await this.planWithAgent(repo, tasks, signal)));
    return { groups, schedule: scheduleFromStages(groups) };
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

}

// ── helpers ──

const NOOP_LOG = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;









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
