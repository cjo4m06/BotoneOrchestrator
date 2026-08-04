import type { GateReport } from '../types.js';

export interface StallVerdict {
  stalled: boolean;
  /** 本次執行已累積的簽章數（上限 = 設定的 N 輪）。 */
  rounds: number;
}

/**
 * ProgressMonitor 需要的 ledger 子集（store/ledger.ts 的 Ledger 結構上即滿足）。
 * 判定不再從 DB 讀回簽章——見下方 class 註解——ledger 只負責稽核落地。
 */
export interface IterationRecorder {
  recordIteration(taskId: string, round: number, signature: string, green: boolean, diffHash?: string): void;
  /**
   * 可選：回傳該任務目前已落地的最大 round。
   * 有實作時，序號會接續既有紀錄，重啟後的稽核紀錄才不會出現重複 round。
   * Ledger 尚未提供 → 從 0 起算（只影響稽核排序，不影響卡牆判定）。
   */
  maxIterationRound?(taskId: string): number;
}

/** 單一任務在「本程序」內的進度追蹤狀態。 */
interface TaskProgress {
  /** 呼叫端上一次傳進來的 round，用來偵測「呼叫端重新從 1 數」= 新一次執行。 */
  lastRound: number;
  /** 實際寫進 ledger 的單調遞增序號（跨重跑不重置）。 */
  seq: number;
  /** 本次執行的最近簽章（新到舊），最多保留 N 筆。 */
  recent: string[];
}

/**
 * 無進展偵測（DESIGN.md §D11）。
 * 記錄每輪「結果簽章」；當**本次執行**最近 N 輪簽章完全相同且仍未綠 → 判定卡牆。
 * 只回報，不中止任務（由呼叫端決定是否通知 Slack）。
 *
 * 為什麼判定用記憶體視窗而不是查 ledger：
 *   Worker.runTask 每次執行都從 round=1 重新計數（澄清後續跑、審查要求修改後重跑都會發生），
 *   而 ledger 的 recentSignatures 是 `ORDER BY round DESC`，只會撈到「上一次執行」留下的高 round 舊簽章。
 *   結果是本次執行第一輪就可能被誤判卡牆，而真正的卡牆反而看不到。
 *   因此：判定只看本次執行（呼叫端 round 回退 → 視窗清空），ledger 改寫入單調遞增序號供事後稽核。
 */
export class ProgressMonitor {
  private readonly tracks = new Map<string, TaskProgress>();

  constructor(private ledger: IterationRecorder, private rounds: number) {}

  record(taskId: string, round: number, gate: GateReport, diffHash?: string): StallVerdict {
    // rounds 設定成 0/負數時視為 1，否則 `length >= rounds` 會在沒有任何樣本時就成立
    const need = Math.max(1, this.rounds);

    let st = this.tracks.get(taskId);
    if (!st) {
      st = { lastRound: 0, seq: this.ledger.maxIterationRound?.(taskId) ?? 0, recent: [] };
      this.tracks.set(taskId, st);
    }
    // round 沒有前進 → 呼叫端開始了新一次執行：舊簽章不屬於這次，清空視窗
    if (round <= st.lastRound) st.recent = [];
    st.lastRound = round;
    st.seq += 1;

    // 第 14 片起 gate.signature 恆為 undefined（驗證器不再算簽章），
    // 這整個模組已無呼叫端，留到第 15 片與 task_iterations 一起刪。
    const signature = gate.signature ?? '';
    this.ledger.recordIteration(taskId, st.seq, signature, gate.green, diffHash);

    st.recent.unshift(signature);
    if (st.recent.length > need) st.recent.length = need;

    // 綠燈豁免：已達標就不該同時被標成卡牆
    const stalled = !gate.green && st.recent.length >= need && new Set(st.recent).size === 1;
    return { stalled, rounds: st.recent.length };
  }

  /** 任務結束後可主動釋放追蹤狀態（長壽 monitor 實例避免無限增長）。 */
  forget(taskId: string): void {
    this.tracks.delete(taskId);
  }
}
