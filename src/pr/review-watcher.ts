import { createHash } from 'node:crypto';
import { z } from 'zod';
import { execaRunner, type CommandRunner } from './pr-manager.js';
import type { Group, GroupState, ReviewEvent } from '../types.js';
import type { Logger } from '../observability/logger.js';

/**
 * Review Watcher 需要的 ledger 子集（DESIGN §12：`poll(): Promise<ReviewEvent[]>`）。
 * 只宣告真正用到的方法，方便測試注入假件；真實 Ledger 結構上即相容。
 */
export interface ReviewLedgerLike {
  listGroupsByState(state: GroupState): Group[];
  updateGroupState(id: string, state: GroupState, extra?: { prUrl?: string; prNumber?: number }): void;
  logEvent(scope: 'task' | 'group' | 'system', refId: string | null, kind: string, detail?: string): void;
  /**
   * 可選能力：若 ledger 提供 events 查詢，就用它做「跨重啟去重」。
   * 沒有也能運作（退化成單一 process 內的記憶體去重）——不為了去重去改 schema。
   */
  hasEvent?(scope: 'task' | 'group' | 'system', refId: string | null, kind: string, detail?: string): boolean;
}

export interface ReviewWatcherDeps {
  ledger: ReviewLedgerLike;
  log: Logger;
  /** 外部指令執行器（測試注入假 gh）。 */
  run?: CommandRunner;
  /** gh 不可用後，隔多久再探一次（預設 10 分鐘）。 */
  unavailableBackoffMs?: number;
  /** 時間來源（測試可控）。 */
  now?: () => number;
  /**
   * 共用的審查意見暫存區。注入後，changes_requested 的意見會存成可回灌 agent 的
   * feedback（否則意見只會躺在 events 表裡，沒有人讀得到 → changes_requested 變死狀態）。
   */
  feedback?: ReviewFeedbackStore;
}

/** 已處理過的 review/comment 記在 events 表的這個 kind 下（detail = 去重 key）。 */
export const SEEN_EVENT_KIND = 'review_seen';

/** 可回灌 agent 的審查意見寫進 events 表的這個 kind 下（detail = JSON 的 ReviewFeedback）。 */
export const FEEDBACK_EVENT_KIND = 'review_feedback';

// gh pr view --json 要拿的欄位。mergeable 只作為記錄/告警用——真正的合併把關是 Merge Guard。
const PR_FIELDS = 'number,state,mergeable,reviewDecision,isDraft,url,reviews,comments';

const AuthorSchema = z.object({ login: z.string().optional() }).nullish();

const ReviewSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  author: AuthorSchema,
  body: z.string().optional(),
  state: z.string().optional(),
  submittedAt: z.string().optional(),
});

const CommentSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  author: AuthorSchema,
  body: z.string().optional(),
  createdAt: z.string().optional(),
});

const PrViewSchema = z.object({
  number: z.number().optional(),
  state: z.string().optional(),
  mergeable: z.string().optional(),
  reviewDecision: z.string().optional(),
  isDraft: z.boolean().optional(),
  url: z.string().optional(),
  reviews: z.array(ReviewSchema).optional(),
  comments: z.array(CommentSchema).optional(),
});

export type PrView = z.infer<typeof PrViewSchema>;
type ReviewItem = z.infer<typeof ReviewSchema>;
type CommentItem = z.infer<typeof CommentSchema>;

// ── 可回灌的審查意見（changes_requested 的產物） ────────────────────────

/** 意見從哪來。決定回灌給 agent 時的措辭，也讓稽核看得出是誰要求改的。 */
export type FeedbackSource =
  | 'github_review' // GitHub 上審查人員按了 Request changes
  | 'merge_guard' // 合併守衛擋下（rebase 衝突／語意飄移）
  | 'human_reject'; // 人在 Slack 的合併閘門按了「退回」

/** 一次「要求修改」留下的、可直接塞進 agent prompt 的意見。 */
export interface ReviewFeedback {
  groupId: string;
  /** 逐條意見（GitHub 來源已含 `@作者:` 前綴）。可能為空（審查者沒留字）。 */
  comments: string[];
  source: FeedbackSource;
  at: number;
}

/** Store 需要的 ledger 子集（只要能寫稽核事件即可；不給也能運作）。 */
export interface FeedbackLedgerLike {
  logEvent(scope: 'task' | 'group' | 'system', refId: string | null, kind: string, detail?: string): void;
}

/**
 * 審查意見暫存區——**changes_requested 從死狀態變成可回灌的關鍵**。
 *
 * 為什麼需要它：ReviewWatcher 產生意見、Orchestrator 決定重新派工、GroupRunner 才真正
 * 把意見交給 agent，三者不在同一個呼叫堆疊上。ledger 目前沒有「讀事件」的 API
 * （events 只能寫），所以跨模組傳遞就靠這個共用實例；同時一律寫一份到 events 表當稽核軌跡。
 *
 * **接線契約**：daemon 必須建立**一個**實例，同時注入 Orchestrator 與 GroupRunner。
 * Orchestrator 只有在拿到共用實例時才會把 changes_requested 群組重新派工——
 * 沒有人接得住意見就派回去，只會讓 agent 不知道要改什麼（見 orchestrator.ts 的 requeue 階段）。
 *
 * 生命週期：程序內記憶體。daemon 重啟後意見會遺失，屆時群組留在 changes_requested
 * 等下一次審查活動（保守：寧可停著等人，也不要讓 agent 盲改）。
 */
export class ReviewFeedbackStore {
  private readonly byGroup = new Map<string, ReviewFeedback>();

  constructor(private readonly ledger?: FeedbackLedgerLike, private readonly now: () => number = Date.now) {}

  /** 覆寫式寫入：同一群組只保留最新一次的要求（舊意見多半已被新意見取代）。 */
  save(input: { groupId: string; comments: string[]; source: FeedbackSource }): ReviewFeedback {
    const fb: ReviewFeedback = { ...input, comments: [...input.comments], at: this.now() };
    this.byGroup.set(fb.groupId, fb);
    // 稽核：即使程序重啟後記憶體沒了，events 表仍查得到當時審查者要求改什麼
    this.ledger?.logEvent('group', fb.groupId, FEEDBACK_EVENT_KIND, JSON.stringify(fb));
    return fb;
  }

  has(groupId: string): boolean {
    return this.byGroup.has(groupId);
  }

  /** 讀但不清除（Orchestrator 判斷「能不能重新派工」用）。 */
  peek(groupId: string): ReviewFeedback | undefined {
    return this.byGroup.get(groupId);
  }

  /** 讀走（GroupRunner 真的把意見交給 agent 之後呼叫，避免下一輪重複回灌）。 */
  take(groupId: string): ReviewFeedback | undefined {
    const fb = this.byGroup.get(groupId);
    this.byGroup.delete(groupId);
    return fb;
  }

  clear(groupId: string): void {
    this.byGroup.delete(groupId);
  }

  /** 直接產生可塞進 agent prompt 的文字；沒有意見時回 undefined。 */
  promptFor(groupId: string): string | undefined {
    const fb = this.byGroup.get(groupId);
    return fb ? formatFeedback(fb) : undefined;
  }
}

/**
 * 本模組回報的事件。
 *
 * 型別上刻意比 types.ts 的 `ReviewEvent` 多帶 `approvedBy`／`prNumber`：
 * **approvedBy 是合併的安全機制**（PrManager.merge 拒收空值），合併路徑必須知道
 * 「是誰核准的」才能留下不可偽造的稽核紀錄。types.ts 是唯讀契約，故以結構擴充
 * （多帶可選欄位）而非改動它——`WatchedReviewEvent[]` 仍可指派給 `ReviewEvent[]`。
 */
export type WatchedReviewEvent =
  | { type: 'approved'; group: string; approvedBy?: string; prNumber?: number }
  | { type: 'changes_requested'; group: string; comments: string[] };

/**
 * Review Watcher（DESIGN §3 步驟 7 / D13）：週期性以 `gh` 查看處於 pr_open / in_review 的
 * 群組 PR，把 GitHub 上的審查結果轉成 ReviewEvent 回報給呼叫端。
 *
 *   approved          → 回報事件（**帶上核准者**，由呼叫端交給 Merge Guard；本模組**不會**自己合併）
 *   changes_requested → 群組轉 changes_requested，並把 reviewer 意見整理成可回灌 agent 的 feedback
 *                       （存進共用的 ReviewFeedbackStore，Orchestrator 據此把群組重新派工）
 *
 * 三個不可妥協的性質：
 *   1. **去重**：同一則 review/comment 只會觸發一次（key 記進 ledger events）。
 *   2. **優雅降級**：沒裝 gh、沒登入、PR 不存在、輸出解析不了 → 記 log 跳過，daemon 照常跑。
 *   3. **只讀不寫 GitHub**：本模組永遠不呼叫任何會改變 PR 的 gh 子指令。
 */
export class ReviewWatcher {
  private readonly ledger: ReviewLedgerLike;
  private readonly log: Logger;
  private readonly run: CommandRunner;
  private readonly backoffMs: number;
  private readonly now: () => number;
  private readonly feedback: ReviewFeedbackStore | undefined;

  /** gh 不可用時的「靜默到」時間戳；0 = 目前視為可用。 */
  private unavailableUntil = 0;
  /** 單一 process 內的去重快取（ledger 無查詢能力時就靠它）。 */
  private readonly memorySeen = new Set<string>();

  constructor(deps: ReviewWatcherDeps) {
    this.ledger = deps.ledger;
    this.log = deps.log;
    this.run = deps.run ?? execaRunner;
    this.backoffMs = deps.unavailableBackoffMs ?? 10 * 60_000;
    this.now = deps.now ?? Date.now;
    this.feedback = deps.feedback;
  }

  /** 掃一輪所有待審群組，回傳本輪新產生的審查事件（沒有就是空陣列）。 */
  async poll(): Promise<WatchedReviewEvent[]> {
    const groups = [...this.ledger.listGroupsByState('pr_open'), ...this.ledger.listGroupsByState('in_review')];
    if (groups.length === 0) return [];

    if (this.now() < this.unavailableUntil) {
      this.log.debug({ groups: groups.length }, 'Review Watcher：gh 暫時不可用，本輪跳過');
      return [];
    }

    const events: WatchedReviewEvent[] = [];
    for (const group of groups) {
      try {
        const ev = await this.pollGroup(group);
        if (ev) events.push(ev);
      } catch (e) {
        // 單一群組出錯不能拖垮整輪——其他群組還在等，daemon 必須繼續跑
        this.log.warn({ group: group.id, err: String(e) }, 'Review Watcher：群組檢查失敗，略過');
      }
      if (this.now() < this.unavailableUntil) break; // gh 整體不可用 → 沒必要再問下一個群組
    }
    return events;
  }

  private async pollGroup(group: Group): Promise<WatchedReviewEvent | undefined> {
    if (!group.prNumber) {
      // 本地模式（openPr=false）沒有 PR 編號可追；這是正常狀態，不是錯誤
      this.log.debug({ group: group.id }, 'Review Watcher：群組沒有 PR 編號，略過');
      return undefined;
    }

    const view = await this.fetchPr(group.repo, group.prNumber);
    if (!view) return undefined;

    // PR 已離開審查中 → 收斂群組狀態，否則會被無止境地輪詢下去
    const prState = (view.state ?? '').toUpperCase();
    if (prState === 'MERGED') {
      this.ledger.updateGroupState(group.id, 'merged');
      this.ledger.logEvent('group', group.id, 'pr_merged', view.url ?? String(group.prNumber));
      this.log.info({ group: group.id, pr: group.prNumber }, 'PR 已在 GitHub 上被合併，群組收斂為 merged');
      return undefined;
    }
    if (prState === 'CLOSED') {
      this.ledger.updateGroupState(group.id, 'failed');
      this.ledger.logEvent('group', group.id, 'pr_closed', view.url ?? String(group.prNumber));
      this.log.warn({ group: group.id, pr: group.prNumber }, 'PR 已被關閉（人為否決），群組標記 failed');
      return undefined;
    }

    const reviews = view.reviews ?? [];
    const comments = view.comments ?? [];

    // pr_open → in_review：有任何審查活動就代表人已經在看了
    if (group.state === 'pr_open' && (reviews.length > 0 || comments.length > 0)) {
      this.ledger.updateGroupState(group.id, 'in_review');
      this.ledger.logEvent('group', group.id, 'in_review', view.url ?? String(group.prNumber));
      this.log.info({ group: group.id, pr: group.prNumber }, '審查已開始（in_review）');
    }

    const unseenReviews = reviews.filter((r) => !this.isSeen(group.id, reviewKey(r)));
    const unseenComments = comments.filter((c) => !this.isSeen(group.id, commentKey(c)));

    // 決定本輪結論的是「最新一則有決定性的 review」。純 COMMENTED / 一般留言不下結論——
    // 它們會留著不標記已處理，等真的出現 changes_requested 時一起回灌給 agent 當上下文。
    const decisive = unseenReviews
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => isDecisive(r.state))
      .sort((a, b) => timeOf(a.r.submittedAt) - timeOf(b.r.submittedAt) || a.i - b.i)
      .pop()?.r;
    if (!decisive) return undefined;

    const markAll = (): void => {
      for (const r of unseenReviews) this.markSeen(group.id, reviewKey(r));
      for (const c of unseenComments) this.markSeen(group.id, commentKey(c));
    };

    if (norm(decisive.state) === 'CHANGES_REQUESTED') {
      const feedback = [
        ...unseenReviews.filter((r) => norm(r.state) !== 'APPROVED').map(formatBody),
        ...unseenComments.map(formatBody),
      ].filter((s): s is string => s !== undefined);
      markAll();
      this.ledger.updateGroupState(group.id, 'changes_requested');
      this.ledger.logEvent('group', group.id, 'review_changes_requested', JSON.stringify(feedback));
      // 存成可回灌的 feedback：沒有這一步，changes_requested 就只是個沒人讀的死狀態
      this.feedback?.save({ groupId: group.id, comments: feedback, source: 'github_review' });
      this.log.info(
        { group: group.id, pr: group.prNumber, count: feedback.length, stored: this.feedback !== undefined },
        '審查要求修改 → 群組轉 changes_requested',
      );
      return { type: 'changes_requested', group: group.id, comments: feedback };
    }

    // APPROVED：只回報事件，交由呼叫端接 Merge Guard（本模組絕不自己合併）。
    // 核准者身分要一路帶到 PrManager.merge 的 approvedBy——它是「這次合併有人負責」的
    // 唯一憑證，不可在中途遺失、更不可由下游自己編一個。
    markAll();
    const approver = authorOf(decisive);
    this.ledger.logEvent('group', group.id, 'review_approved', approver ?? '');
    this.log.info(
      { group: group.id, pr: group.prNumber, by: approver, mergeable: view.mergeable },
      '審查通過（approved）→ 交由呼叫端執行 Merge Guard',
    );
    if (view.mergeable && view.mergeable.toUpperCase() === 'CONFLICTING') {
      this.log.warn({ group: group.id, pr: group.prNumber }, 'PR 目前與 base 衝突，Merge Guard 會擋下');
    }
    // approvedBy 只在 GitHub 真的給了 login 時才帶；帶不到就讓下游自己標示來源不明，
    // 絕不編造一個看起來像人的名字（那會讓稽核紀錄失去意義）。
    return {
      type: 'approved',
      group: group.id,
      ...(approver ? { approvedBy: approver } : {}),
      ...(group.prNumber ? { prNumber: group.prNumber } : {}),
    };
  }

  /** 查 PR。任何失敗都回 undefined（呼叫端一律當「這輪沒事發生」）。 */
  private async fetchPr(repo: string, prNumber: number): Promise<PrView | undefined> {
    const r = await this.run('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', PR_FIELDS]);
    if (r.exitCode !== 0) {
      const detail = `${r.stderr}\n${r.stdout}`.trim();
      if (isGhUnusable(r.exitCode, detail)) {
        // 沒裝 gh / 沒登入：這是環境問題，不是這個 PR 的問題 → 整體靜默一段時間再探
        this.unavailableUntil = this.now() + this.backoffMs;
        this.log.warn(
          { detail: tail(detail), retryInMs: this.backoffMs },
          'gh 不可用（未安裝或未登入），Review Watcher 暫停；其餘流程照常運作',
        );
        return undefined;
      }
      this.log.warn({ repo, pr: prNumber, detail: tail(detail) }, 'gh pr view 失敗（PR 不存在或無權限），略過');
      return undefined;
    }

    const parsed = PrViewSchema.safeParse(safeJson(r.stdout));
    if (!parsed.success) {
      this.log.warn({ repo, pr: prNumber }, 'gh pr view 輸出無法解析，略過');
      return undefined;
    }
    return parsed.data;
  }

  private isSeen(groupId: string, key: string): boolean {
    if (this.memorySeen.has(`${groupId}:${key}`)) return true;
    return this.ledger.hasEvent?.('group', groupId, SEEN_EVENT_KIND, key) ?? false;
  }

  private markSeen(groupId: string, key: string): void {
    this.memorySeen.add(`${groupId}:${key}`);
    // 一律寫進 events：即使目前 ledger 沒有查詢能力，這也是稽核軌跡；
    // 之後 ledger 補上 hasEvent 就自動變成跨重啟去重。
    this.ledger.logEvent('group', groupId, SEEN_EVENT_KIND, key);
  }
}

/** 把 changes_requested 事件整理成可直接塞進 agent prompt 的回灌文字。 */
export function formatReviewFeedback(event: Extract<ReviewEvent, { type: 'changes_requested' }>): string {
  if (event.comments.length === 0) return '審查人員要求修改，但未留下具體意見；請自行檢查 PR 內容並補強。';
  return [
    '審查人員在 GitHub PR 上要求修改，請逐條處理下列意見（改完要能通過原本的 DoD）：',
    ...event.comments.map((c, i) => `${i + 1}. ${c}`),
  ].join('\n');
}

/** 不同來源的開場白。措辭要讓 agent 知道「誰在要求」以及「改完要達到什麼」。 */
const FEEDBACK_HEADER: Record<FeedbackSource, string> = {
  github_review: '審查人員在 GitHub PR 上要求修改，請逐條處理下列意見（改完要能通過原本的 DoD）：',
  merge_guard: '合併守衛在「合併後狀態」擋下了這個群組，請依下列失敗細節修正（改完要能通過原本的 DoD）：',
  human_reject: '人工合併閘門退回了這個群組，請依下列說明修正（改完要能通過原本的 DoD）：',
};

const FEEDBACK_EMPTY: Record<FeedbackSource, string> = {
  github_review: '審查人員要求修改，但未留下具體意見；請自行檢查 PR 內容並補強。',
  merge_guard: '合併守衛擋下了這個群組，但沒有留下細節；請自行重跑建置與測試找出問題。',
  human_reject: '人工退回了這次合併，但沒有留下理由；請自行檢查 PR 內容並補強。',
};

/** 把任一來源的 feedback 整理成可直接塞進 agent prompt 的回灌文字。 */
export function formatFeedback(fb: ReviewFeedback): string {
  if (fb.comments.length === 0) return FEEDBACK_EMPTY[fb.source];
  return [FEEDBACK_HEADER[fb.source], ...fb.comments.map((c, i) => `${i + 1}. ${c}`)].join('\n');
}

function norm(state: string | undefined): string {
  return (state ?? '').toUpperCase();
}

/** 只有 APPROVED / CHANGES_REQUESTED 會改變群組去向；COMMENTED、DISMISSED、PENDING 不算。 */
function isDecisive(state: string | undefined): boolean {
  const s = norm(state);
  return s === 'APPROVED' || s === 'CHANGES_REQUESTED';
}

function authorOf(item: ReviewItem | CommentItem): string | undefined {
  return item.author?.login;
}

/** 「@作者: 內容」；沒有內容的（如空 body 的 approve）不值得回灌，回 undefined。 */
function formatBody(item: ReviewItem | CommentItem): string | undefined {
  const body = item.body?.trim();
  if (!body) return undefined;
  const who = authorOf(item);
  return who ? `@${who}: ${body}` : body;
}

/**
 * 去重 key：優先用 GitHub 的 id；沒有 id（舊版 gh 或非預期輸出）就用內容雜湊，
 * 確保「同一則意見」在任何情況下都只會被觸發一次。
 */
function reviewKey(r: ReviewItem): string {
  return `review:${r.id ?? fingerprint([authorOf(r), r.submittedAt, r.state, r.body])}`;
}

function commentKey(c: CommentItem): string {
  return `comment:${c.id ?? fingerprint([authorOf(c), c.createdAt, c.body])}`;
}

function fingerprint(parts: (string | undefined)[]): string {
  return createHash('sha1').update(parts.map((p) => p ?? '').join('\u0000')).digest('hex').slice(0, 16);
}

function timeOf(iso: string | undefined): number {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? 0 : t;
}

/** 環境層級的不可用（沒裝 / 沒登入），相對於「這個 PR 查不到」這種單點問題。 */
function isGhUnusable(exitCode: number, detail: string): boolean {
  if (exitCode === -1) return true; // spawn 失敗（多半是沒安裝）
  if (exitCode === 4) return true; // gh 的認證錯誤退出碼
  return /ENOENT|command not found|not found: gh|gh auth login|not logged in|authentication/i.test(detail);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function tail(s: string, n = 10): string {
  return s.split('\n').slice(-n).join('\n').trim();
}
