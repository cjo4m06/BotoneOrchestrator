import type { ProjectConfig } from '../config/index.js';
import type { PollSource } from './poller.js';
import type { ProjectRuntime } from './group-runner.js';
import type { Logger } from '../observability/logger.js';
import type { McpTaskClient } from '../contracts.js';

/**
 * 執行中的專案集合，**可以在不重啟的情況下改變**。
 *
 * 沒有這一層的話，控制台就只是個很貴的文字編輯器：專案／MCP client／runtime 全都在
 * 啟動迴圈裡建好就固定了（Poller 的 sources 是 constructor 收的陣列），改完設定要重啟
 * 才生效——而重啟會中斷正在跑的 agent、丟掉 worktree 的進度。
 *
 * 設計上的兩個要點：
 *   1. **讀取端一律走 registry**（`sources()` / `runtimeOf()`），不要自己抓一份快照留著。
 *      留快照的地方就是熱重載失效的地方，而且失效得很安靜。
 *   2. **同步一次只做一個專案**：某個專案 MCP 連不上，不該讓其他專案跟著消失。
 */

/**
 * 讀取端只需要這麼多。抽成介面，呼叫端就不必知道 registry 有沒有熱重載能力
 * （測試也能塞一個簡單的假物件，不必造一整個 registry）。
 */
export interface ProjectLookup {
  runtimeOf(repo: string): ProjectRuntime | undefined;
  repoPaths(): string[];
}

export interface RegisteredProject {
  config: ProjectConfig;
  client: McpTaskClient & { connect?(): Promise<void>; close?(): Promise<void> };
  source: PollSource;
  runtime: ProjectRuntime;
  /** 用來判斷「設定有沒有真的變」的指紋；沒變就不重建 MCP 連線。 */
  fingerprint: string;
}

/** 建立一個專案的執行期物件（連 MCP、算出 baseBranch 等）。失敗回 undefined。 */
export type ProjectFactory = (p: ProjectConfig) => Promise<Omit<RegisteredProject, 'fingerprint'> | undefined>;

/**
 * 設定指紋。只涵蓋「改了就必須重建連線／runtime」的欄位——
 * 把整份設定 hash 進去的話，改一個無關的欄位（例如 visual 的截圖門檻）
 * 也會把 MCP 連線砍掉重連，正在跑的輪詢會無謂地中斷。
 */
export function projectFingerprint(p: ProjectConfig): string {
  return JSON.stringify({
    repo: p.repo,
    repoPath: p.repoPath,
    baseBranch: p.baseBranch,
    pollMine: p.pollMine,
    mcp: p.mcp,
  });
}

export class ProjectRegistry {
  private items = new Map<string, RegisteredProject>();

  constructor(private factory: ProjectFactory, private log: Logger) {}

  // ── 讀取端（每次都現拿，不要留快照） ──

  sources(): PollSource[] {
    return [...this.items.values()].map((x) => x.source);
  }

  /** 依 repo 找 runtime（GroupRunner／合併管線用）。 */
  runtimeOf(repo: string): ProjectRuntime | undefined {
    for (const x of this.items.values()) if (x.config.repo === repo) return x.runtime;
    return undefined;
  }

  /** 所有本地 clone 路徑（對帳掃孤兒 worktree 用）。 */
  repoPaths(): string[] {
    return [...new Set([...this.items.values()].map((x) => x.runtime.repoPath))];
  }

  configOf(repo: string): ProjectConfig | undefined {
    for (const x of this.items.values()) if (x.config.repo === repo) return x.config;
    return undefined;
  }

  list(): RegisteredProject[] {
    return [...this.items.values()];
  }

  ids(): string[] {
    return [...this.items.keys()];
  }

  size(): number {
    return this.items.size;
  }

  clients(): RegisteredProject['client'][] {
    return [...this.items.values()].map((x) => x.client);
  }

  // ── 同步 ──

  /**
   * 把執行中的集合對齊到 `desired`（控制台改完設定後呼叫）。
   *
   * @returns 這次實際做了什麼，供呼叫端寫 log／回報給控制台。
   */
  async sync(desired: ProjectConfig[]): Promise<{ added: string[]; updated: string[]; removed: string[]; failed: string[] }> {
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const failed: string[] = [];

    const wanted = new Map(desired.map((p) => [p.id, p]));

    // 先移除：被停用/刪掉的專案要立刻停止輪詢，否則會繼續認領任務
    for (const id of [...this.items.keys()]) {
      if (wanted.has(id)) continue;
      await this.drop(id);
      removed.push(id);
    }

    for (const [id, cfg] of wanted) {
      const existing = this.items.get(id);
      const fp = projectFingerprint(cfg);

      if (existing && existing.fingerprint === fp) {
        // 連線相關的欄位沒變 → 只換設定內容（commands／visual／靜置分鐘數之類），
        // 不動 MCP 連線。整份 hash 的話，改個截圖門檻也會把連線砍掉重連。
        //
        // 完全一樣則什麼都不算：sync 每輪都會被呼叫，把「沒變」也記成 updated
        // 會讓 log 每 15 秒噴一次「專案清單已更新」——真正的變更就淹沒在裡面了。
        if (JSON.stringify(existing.config) !== JSON.stringify(cfg)) {
          existing.config = cfg;
          updated.push(id);
        }
        continue;
      }

      if (existing) await this.drop(id); // 連線相關欄位變了 → 砍掉重建

      try {
        const built = await this.factory(cfg);
        if (!built) {
          failed.push(id);
          continue;
        }
        this.items.set(id, { ...built, fingerprint: fp });
        (existing ? updated : added).push(id);
      } catch (e) {
        // 單一專案失敗不能連累其他專案（其中一個 MCP 掛了，其餘照常運作）
        this.log.error({ id, err: e instanceof Error ? e.message : String(e) }, '專案載入失敗，略過');
        failed.push(id);
      }
    }

    if (added.length || updated.length || removed.length || failed.length) {
      this.log.info({ added, updated, removed, failed, total: this.items.size }, '專案清單已更新（熱重載）');
    }
    return { added, updated, removed, failed };
  }

  /** 關掉所有 MCP 連線（daemon 收尾用）。 */
  async closeAll(): Promise<void> {
    for (const id of [...this.items.keys()]) await this.drop(id);
  }

  private async drop(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    try {
      await item.client.close?.();
    } catch (e) {
      // 連線關不掉不該擋住重建（下一個 client 是獨立的連線）
      this.log.warn({ id, err: e instanceof Error ? e.message : String(e) }, 'MCP 連線關閉失敗（已從清單移除）');
    }
  }
}
