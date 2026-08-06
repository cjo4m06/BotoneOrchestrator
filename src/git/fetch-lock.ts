import { withRepoLock } from '../core/repo-lock.js';

/**
 * `git fetch` 的看門狗上限（毫秒）。
 *
 * ── 為什麼鎖本身要有時限 ──
 *
 * 這把鎖是**序列佇列**（repo-lock）：卡住的那一個永遠不 settle，後面全部無限排隊。
 * 而五個 fetch 呼叫點裡只有 base-freshness 那個給了 git 指令逾時——也就是說
 * 另外四個之中隨便一個卡住，**連唯一有逾時的那個也會被卡在排隊階段**（計時器根本還沒開始）。
 *
 * 症狀特別難認：控制台顯示「執行中」而且心跳照打（activity 是另一條路），
 * orchestrator 只用 log.debug 記「本輪跳過」——預設 info 級別下一行 log 都不會多。
 * 這是跑在 macOS 筆電上的 launchd 服務，睡醒、VPN 斷線、TCP 黑洞都會製造半開連線，
 * 而 execa 的 timeout 預設是 0（停用）。
 *
 * 120 秒：大 repo 的第一次 fetch 可能要一分鐘以上，設太短會把正常操作誤殺成失敗；
 * 而呼叫端對 fetch 失敗本來就有降級路徑（守衛標「但書」、合併前檢查回 undefined 不亂擋）。
 */
export const FETCH_WATCHDOG_MS = 120_000;

/**
 * 單一 `git fetch` 指令的逾時（毫秒）。
 *
 * 與上面的看門狗分工：這個殺得掉子行程，看門狗只放得掉鎖。**兩個都要**——
 * 只有看門狗的話，卡住的 git 行程會累積；只有指令逾時的話，沒給逾時的呼叫點
 * 照樣能把整個佇列凍住（先前五個呼叫點只有 base-freshness 給了）。
 */
export const FETCH_TIMEOUT_MS = 60_000;


/**
 * 同一個 repo 的 `git fetch` 必須序列化。
 *
 * ── 為什麼 ──
 *
 * `git fetch` 更新 `refs/remotes/<remote>/<branch>` 時用的是 compare-and-swap：
 * 讀到舊值 → 寫新值，寫的時候確認舊值沒被動過。兩個 fetch 同時跑，後者的預期值
 * 已經被前者改掉了，於是：
 *
 *   error: cannot lock ref 'refs/remotes/origin/main':
 *          is at ebbce529… but expected 493e1cb6…
 *
 * 實跑撞到（22:36）。而這條路徑的呼叫端是「抓最新 base 來驗守衛」，失敗的後果是
 * **守衛驗的是過期的 base** —— 它會照樣放行，只是掛一個但書。也就是說這個競態
 * 不會讓流程停下來，它會讓一次合併把關悄悄降級。
 *
 * repo 裡有六個 fetch 呼叫點（merge guard、base freshness、PR 管理…），
 * 只要有兩個在不同群組裡同時跑就會撞，而併發度越高越容易。
 *
 * ── 為什麼用獨立的鎖鍵，而不是 withRepoLock(repoPath) ──
 *
 * `withRepoLock` 是**不可重入**的序列佇列，而 Merge Guard 已經持有 `repoPath` 那把鎖
 * （group-runner），它裡面又會 fetch —— 共用同一把鎖就是自己等自己，直接死鎖。
 *
 * 用 `fetch:<repoPath>` 這個獨立鍵之後，fetch 只跟其他 fetch 互斥。
 * 不會有循環等待：這把鎖裡面只跑 fetch 那一個指令，不會再去要別的鎖。
 *
 * ── 看門狗 ──
 *
 * 逾時**只放掉鎖，不保證子行程死掉**（那要靠呼叫端給 execa timeout）。
 * 這樣分工是刻意的：真正要防的是「一個卡住的 fetch 讓整個 repo 的合併全部凍住」，
 * 而那只需要鎖能被釋放。逾時會擲錯，走呼叫端既有的 fetch 失敗降級路徑。
 */
export function withFetchLock<T>(
  repoPath: string,
  fn: () => Promise<T>,
  opts: { watchdogMs?: number } = {},
): Promise<T> {
  const limit = opts.watchdogMs ?? FETCH_WATCHDOG_MS;
  return withRepoLock(`fetch:${repoPath}`, async () => {
    if (limit <= 0) return fn();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`git fetch 超過 ${Math.round(limit / 1000)} 秒沒有回應（${repoPath}）：放掉 fetch 鎖，本輪視為取不到最新 base`)),
            limit,
          );
          // 不要讓看門狗自己撐住事件迴圈：--once 跑完就該退得出去
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}
