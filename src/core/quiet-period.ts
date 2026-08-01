import type { Task } from '../types.js';

/**
 * 靜置期（quiet period）：專案的任務板要「安靜」夠久，才准分群開工。
 *
 * 要解決的問題（實務上一定會發生）：
 *   人在任務板上建立同一系列的 5 個任務，中間隔了幾分鐘。輪詢每 30 秒跑一次，
 *   於是我們在第 2 個任務剛建好時就抓到「全部（其實只有 2 個）」→ 分群 → 開工 →
 *   做出半套功能、開一個殘缺的 PR，剩下 3 個任務之後又變成第二個群、第二個 PR。
 *   對審查的人來說這是最糟的形態：兩個 PR 都看不懂，而且互相依賴。
 *
 * 判準：以**專案（repo，即一個 MCP server 的任務板）**為單位，
 * 取該專案所有待分群任務的「最後活動時間」，最新的那筆距今 ≥ quietMinutes 才放行。
 * 只要有一個任務是 3 分鐘前建立/編輯的，整個專案這輪都不動——寧可晚 15 分鐘開工，
 * 也不要做出半成品（DESIGN D18：誤判的代價遠高於慢一點）。
 *
 * 「最後活動時間」優先用 MCP 給的 createdAt/updatedAt（那才是真的任務板動態），
 * MCP 沒給時間戳就退回 ledger 的發現時間 createdAt（輪詢間隔的精度，夠用）。
 *
 * 注意這裡只看 discovered（還沒分群）的任務：已經開工的任務會被我們自己的
 * start_task/complete_task 改到 updatedAt，若把它們算進來，專案永遠不會靜置。
 */

/** 預設靜置分鐘數（使用者指定）。 */
export const DEFAULT_QUIET_MINUTES = 15;

export interface QuietDecision {
  repo: string;
  quiet: boolean;
  /** 該專案最後一次任務板活動（毫秒）。 */
  lastActivityAt: number;
  /** 還要等多久才靜置（毫秒），已靜置為 0。 */
  waitMs: number;
  taskCount: number;
  quietMinutes: number;
}

export interface QuietSplit {
  /** 已靜置、可以進 planner 的任務。 */
  ready: Task[];
  /** 專案還在活動中，本輪先不動的任務。 */
  waiting: Task[];
  /** 每個專案的判定（記錄/觀測用）。 */
  decisions: QuietDecision[];
}

/** 單一任務的「最後活動時間」。 */
export function taskActivityAt(t: Task): number {
  return t.sourceUpdatedAt ?? t.createdAt;
}

/**
 * 依專案切分待分群任務。
 *
 * @param quietMinutesOf 給 repo 回傳該專案設定的分鐘數；≤0 代表關閉靜置期（立即放行）。
 */
export function splitByQuietPeriod(
  tasks: Task[],
  quietMinutesOf: (repo: string) => number,
  now: number,
): QuietSplit {
  const byRepo = new Map<string, Task[]>();
  for (const t of tasks) {
    const list = byRepo.get(t.repo);
    if (list) list.push(t);
    else byRepo.set(t.repo, [t]);
  }

  const ready: Task[] = [];
  const waiting: Task[] = [];
  const decisions: QuietDecision[] = [];

  for (const [repo, list] of byRepo) {
    const quietMinutes = quietMinutesOf(repo);
    const lastActivityAt = Math.max(...list.map(taskActivityAt));
    // 未來時間戳（時鐘不同步）不該讓專案永遠等下去：idle 夾到 0，等滿一個完整靜置期就好。
    const idleMs = Math.max(0, now - lastActivityAt);
    const windowMs = quietMinutes > 0 ? quietMinutes * 60_000 : 0;
    const quiet = idleMs >= windowMs;
    decisions.push({
      repo,
      quiet,
      lastActivityAt,
      waitMs: quiet ? 0 : windowMs - idleMs,
      taskCount: list.length,
      quietMinutes,
    });
    if (quiet) ready.push(...list);
    else waiting.push(...list);
  }

  return { ready, waiting, decisions };
}
