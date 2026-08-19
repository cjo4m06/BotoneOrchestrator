import { createHash } from 'node:crypto';
import type { McpReadClient } from '../contracts.js';
import type { Ledger } from '../store/ledger.js';
import type { Logger } from '../observability/logger.js';
import type { Task, TaskDetail } from '../types.js';
import { RECLAIM_BLOCK_PREFIX } from '../notify/notifier.js';

export interface PollSource {
  client: McpReadClient;
  repo: string;
  mine?: boolean;
}

/** 任務去重指紋：內容變動才視為需重排（DESIGN §D8 的 payloadHash）。 */
export function payloadHash(t: TaskDetail): string {
  const basis = JSON.stringify({
    title: t.title,
    description: t.description,
    category: t.category,
    dependencies: [...t.dependencies].sort(),
    docRefs: [...t.docRefs].sort(),
  });
  return createHash('sha1').update(basis).digest('hex');
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** MCP 端最後活動時間 = max(createdAt, updatedAt)；兩者皆無 → undefined。 */
export function sourceUpdatedAt(t: Pick<TaskDetail, 'createdAt' | 'updatedAt'>): number | undefined {
  const vals = [t.createdAt, t.updatedAt].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return vals.length ? Math.max(...vals) : undefined;
}

/**
 * 輪詢各來源的 todo 任務，去重後落地 ledger（DESIGN §3 步驟 1-2）。
 * MCP 會重複派發（含做過的）；靠 ledger 的 id+payloadHash 去重，只回傳「新任務」。
 */
export class Poller {
  /**
   * sources 可以是**函式**：每輪重新取得，讓控制台新增／停用專案能立刻生效。
   * 傳陣列則是固定清單（測試與舊呼叫端用）。
   *
   * 這個區別很重要：收一份陣列留著，就是熱重載失效的地方，而且失效得很安靜——
   * 控制台顯示「已儲存」，daemon 卻還在輪詢舊的專案清單。
   */
  constructor(
    private sources: PollSource[] | (() => PollSource[]),
    private ledger: Ledger,
    private log: Logger,
    /**
     * 專案健康度計數器。**未注入 → 只留 log（舊行為）**。
     * 注入之後，任務板連不上會升級成一張人看得見的單（見 core/project-health.ts）。
     */
    private health?: { fail(f: { repo: string; reason: string; fix: string; retryable?: boolean }, now: number): void; ok(repo: string): void },
  ) {}

  private currentSources(): PollSource[] {
    return typeof this.sources === 'function' ? this.sources() : this.sources;
  }

  async pollOnce(): Promise<Task[]> {
    const fresh: Task[] = [];
    for (const src of this.currentSources()) {
      let briefs;
      try {
        briefs = await src.client.listTasks({ repo: src.repo, status: 'todo', mine: src.mine });
      } catch (e) {
        this.log.warn({ repo: src.repo, err: msg(e) }, 'listTasks 失敗，略過本輪該來源');
        // **這是主要的那一半。** registry 指紋沒變就不會重建 runtime，所以
        // 「跑三天後 MCP 掛掉／token 過期／任務板改權限」只有這裡看得到。
        // 先前只有一行 warn ⇒ 該專案的群組全部靜默停住，畫面顯示綠色「啟用中」。
        this.health?.fail({
          repo: src.repo,
          reason: `向任務板要任務失敗（listTasks）：${msg(e)}`,
          fix: '任務板連線或權限變了：到控制台「專案」分頁按「測試連線」看實際錯誤',
        }, Date.now());
        continue;
      }
      this.health?.ok(src.repo);

      for (const b of briefs) {
        let detail: TaskDetail;
        try {
          detail = await src.client.getTask(b.id);
        } catch (e) {
          this.log.warn({ id: b.id, err: msg(e) }, 'getTask 失敗，略過該任務');
          // 權限只擋單張卡時走這條（listTasks 會過、getTask 會炸）
          this.health?.fail({
            repo: src.repo,
            reason: `讀任務內容失敗（getTask ${b.id}）：${msg(e)}`,
            fix: '多半是任務板的單卡權限：到控制台「專案」分頁按「測試連線」，或確認該卡的存取權',
          }, Date.now());
          continue;
        }
        const res = this.ledger.upsertDiscoveredTask({
          id: detail.id,
          payloadHash: payloadHash(detail),
          repo: detail.repo,
          category: detail.category,
          title: detail.title,
          description: detail.description,
          dependencies: detail.dependencies,
          docRefs: detail.docRefs,
          // 靜置期看的是「MCP 端最後有動作是什麼時候」：建立與更新取大者。
          ...(sourceUpdatedAt(detail) !== undefined ? { sourceUpdatedAt: sourceUpdatedAt(detail)! } : {}),
        });
        // ── 卡片回到「待辦」，而本機還停在「認領不回來」⇒ 人已經去任務板改好了 ──
        //
        // 這條路先前是死的：worker 認領被拒時會 setBlock('needs_human') 並開一張
        // reclaim_blocked 單，而那張單的動作是**空的**（`HANDOFF_ACTIONS.reclaim_blocked = []`）
        // ——因為卡片還停在「進行中」時按重試確實永遠沒用（實跑：使用者按了 4 次）。
        //
        // 但單子的內文寫著「改完再按重試」，而畫面上沒有那顆按鈕。於是人做完唯一能做的事
        //（去任務板改回待辦）之後，**沒有任何介面可以告訴系統**：任務停在 blocked、
        // 那張單永遠掛著、群組等一個不會來的推進（實跑 2026-08-19，maFet_gXpQVJ）。
        //
        // 這裡不需要人再按什麼：`listTasks` 抓的就是 `status:'todo'`，卡片出現在這份清單裡
        // 就等於「任務板說它可以被認領了」——那是機械事實，不是判斷。所以自己接回去。
        // clearBlock 會順手把那張單標成已處理（見 Ledger.clearBlock）。
        const local = this.ledger.getTask(detail.id);
        if (local?.state === 'blocked' && (local.block?.detail ?? '').startsWith(RECLAIM_BLOCK_PREFIX)) {
          this.ledger.clearBlock(detail.id, 'queued');
          this.ledger.logEvent('task', detail.id, 'reclaim_unblocked',
            '任務板上的卡片已回到「待辦」→ 解除受阻、重新排隊（不需要人再按什麼）');
          this.log.info({ taskId: detail.id }, '卡片已回到待辦 → 自動解除「認領不回來」');
        }

        if (res === 'inserted') {
          const task = this.ledger.getTask(detail.id);
          if (task) {
            fresh.push(task);
            this.ledger.logEvent('task', detail.id, 'discovered', detail.title);
          }
        }
      }
    }
    if (fresh.length) this.log.info({ count: fresh.length }, 'poll：發現新任務');
    return fresh;
  }
}
