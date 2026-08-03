import type { ActivityInput } from '../store/ledger.js';

/**
 * 「現在誰在做什麼」的登記口。
 *
 * ── 為什麼需要 ──
 *
 * 這個系統花時間最久的幾件事，期間 ledger 完全靜止：規劃 agent 讀完整個 repo 再分群
 * （實測單次 6 分鐘）、reviewer 在審、介面判斷者開瀏覽器量版面、合併把關比對 diff。
 * 那幾分鐘裡任務狀態沒變、群組狀態沒變、事件表沒有新列——控制台看起來就是停擺。
 * 使用者的原話：「我以為整個專案都在停擺」。
 *
 * 所以會跑很久的東西一律包一層 withActivity，讓畫面上有東西可看。
 *
 * ── 為什麼一定要用 finally ──
 *
 * 沒清掉的話畫面會永遠掛著一件假的「進行中」，比沒有這個功能更糟——
 * 使用者會學會不相信這塊畫面。擲錯、中止、正常結束都要刪。
 */

export interface ActivitySink {
  startActivity(a: ActivityInput): void;
  touchActivity(id: string, detail?: string): void;
  endActivity(id: string): void;
}

/** 心跳間隔。畫面用「心跳幾秒前」分辨「還在跑」與「daemon 死了留下的殘列」。 */
export const HEARTBEAT_MS = 10_000;

/** 超過這個沒心跳就當它死了（心跳間隔的數倍，避免忙碌時誤判）。 */
export const STALE_AFTER_MS = 90_000;

/**
 * 包一件會跑一段時間的事。
 *
 * @param setInterval_ 可注入（測試不必真的等時間過去）
 */
export async function withActivity<T>(
  sink: ActivitySink,
  spec: ActivityInput,
  fn: (update: (detail: string) => void) => Promise<T>,
  timers: {
    setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
    clearInterval?: (h: never) => void;
  } = {},
): Promise<T> {
  sink.startActivity(spec);
  const si = timers.setInterval ?? ((f, ms) => globalThis.setInterval(f, ms));
  const ci = timers.clearInterval ?? ((h: never) => globalThis.clearInterval(h));

  const handle = si(() => {
    try {
      sink.touchActivity(spec.id);
    } catch {
      // 心跳寫不進去不該讓正在做的事掛掉——它只是給畫面看的
    }
  }, HEARTBEAT_MS);
  // daemon 收到停止訊號時，不該被這個計時器拖著不結束
  (handle as { unref?: () => void }).unref?.();

  try {
    return await fn((detail) => {
      try {
        sink.touchActivity(spec.id, detail);
      } catch {
        // 同上
      }
    });
  } finally {
    ci(handle as never);
    try {
      sink.endActivity(spec.id);
    } catch {
      // 刪不掉的話會留一列殘的，由 clearStaleActivities 靠心跳年齡收
    }
  }
}
