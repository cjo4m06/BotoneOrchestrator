import type { Group } from '../types.js';
import type { Logger } from '../observability/logger.js';

export type GroupRunner = (group: Group, signal?: AbortSignal) => Promise<void>;

/**
 * 併發調度（DESIGN §3 步驟 4 / §D6-D7）：群間並行，但
 * (a) 不超過 maxConcurrent；(b) 同 repo 且檔案足跡重疊的群序列化；
 * (c) 規劃 agent 排出的階段順序（`afterGroups`）要等前一階段全部結束。
 * 群內序列由 Worker 依 taskIds 順序處理。
 *
 * (b) 與 (c) 互補：足跡擋的是「同時動到同一個檔案」，階段擋的是「檔案不同但先後
 * 有意義」——例如規劃者判斷兩個任務**很可能**會改到同一處但說不準是哪個檔案。
 * 實跑過的教訓：只靠足跡而足跡又猜錯時，兩個都改 SandboxView.vue 的任務會並行，
 * 後完成的那個必然撞 rebase 衝突。
 */
export class Dispatcher {
  private running = new Map<string, Group>();

  /**
   * maxConcurrent 可以是函式：控制台調整併發數後，下一輪派工就生效。
   * 已經在跑的群不會被砍——調小只是暫時不再派新的，直到降到新上限之下。
   */
  constructor(
    private maxConcurrent: number | (() => number),
    private runner: GroupRunner,
    private log: Logger,
    /**
     * 查某個群是否已經結束（不會再改動 base）。未注入時階段順序不生效——
     * 這是刻意的：沒有 ledger 就判斷不了前一階段的狀態，此時不該假裝有序。
     */
    private isFinished?: (groupId: string) => boolean,
  ) {}

  private cap(): number {
    const v = typeof this.maxConcurrent === 'function' ? this.maxConcurrent() : this.maxConcurrent;
    return Number.isFinite(v) && v > 0 ? v : 1;
  }

  activeCount(): number {
    return this.running.size;
  }
  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** 在併發上限內派出可跑的群；回傳本次新派出的數量。 */
  /**
   * @param signal 中止訊號，原樣交給每個被派出的群（見 GroupRunner 的說明）。
   */
  dispatch(ready: Group[], signal?: AbortSignal): number {
    let started = 0;
    for (const g of ready) {
      if (this.running.size >= this.cap()) break;
      if (this.running.has(g.id)) continue;
      if (this.overlapsRunning(g)) {
        this.log.debug({ group: g.id }, '足跡與進行中群重疊，稍後再派');
        continue;
      }
      const waitingFor = this.unfinishedPredecessors(g);
      if (waitingFor.length > 0) {
        this.log.debug({ group: g.id, waitingFor }, '前一階段尚未結束，稍後再派');
        continue;
      }
      this.running.set(g.id, g);
      started += 1;
      this.log.info({ group: g.id, repo: g.repo, active: this.running.size }, '派出群');
      this.launch(g, signal);
    }
    return started;
  }

  /**
   * 起跑一個群並保證 slot 一定會被釋放。
   * runner 必須**同步**呼叫（呼叫端與測試都預期 dispatch() 回來時群已經開始跑），
   * 但若 runner 不是 async 而是同步就 throw，例外會直接從 dispatch() 逸出、
   * 該群永遠留在 running map（slot 洩漏，池子最後會漏光）→ 這裡用 try/catch 兜住，
   * 並把同步/非同步兩種失敗收斂成同一條處理路徑。
   */
  private launch(g: Group, signal?: AbortSignal): void {
    const fail = (e: unknown): void =>
      this.log.error({ group: g.id, err: e instanceof Error ? e.message : String(e) }, '群執行失敗');
    try {
      // Promise.resolve 也順便容錯 runner 回傳非 Promise 的情況
      void Promise.resolve(this.runner(g, signal))
        .catch(fail)
        .finally(() => this.running.delete(g.id));
    } catch (e) {
      fail(e);
      this.running.delete(g.id);
    }
  }

  /**
   * 還沒結束的前置群。
   *
   * 「結束」＝不會再改動 base（合併完成、或已失敗而不會再合併）。用 isFinished 由
   * 呼叫端定義，Dispatcher 不直接碰 ledger。沒注入 isFinished 就一律視為可派——
   * 寧可退回舊行為，也不要因為查不到狀態而把所有群永遠卡住。
   */
  private unfinishedPredecessors(g: Group): string[] {
    const check = this.isFinished;
    if (!check || g.afterGroups.length === 0) return [];
    return g.afterGroups.filter((id) => this.running.has(id) || !check(id));
  }

  /** 同 repo 且與任一進行中群足跡重疊 → 需序列化。 */
  private overlapsRunning(g: Group): boolean {
    for (const r of this.running.values()) {
      if (r.repo === g.repo && r.footprint.some((f) => g.footprint.includes(f))) return true;
    }
    return false;
  }
}
