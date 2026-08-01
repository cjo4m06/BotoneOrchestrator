import { createHash } from 'node:crypto';
import type { McpReadClient } from '../contracts.js';
import type { Ledger } from '../store/ledger.js';
import type { Logger } from '../observability/logger.js';
import type { Task, TaskDetail } from '../types.js';

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
        continue;
      }

      for (const b of briefs) {
        let detail: TaskDetail;
        try {
          detail = await src.client.getTask(b.id);
        } catch (e) {
          this.log.warn({ id: b.id, err: msg(e) }, 'getTask 失敗，略過該任務');
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
