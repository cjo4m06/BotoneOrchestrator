/**
 * 以 repo 為鍵的進程內互斥鎖。
 *
 * ── 為什麼合併必須序列化 ──
 *
 * Merge Guard 的意義是「把這一群 rebase 到**最新的 base** 上重跑一次完整驗證」。
 * 那個保證只有在「驗的 base ＝ 合併落地的 base」時才成立。中間只要有別的群先合併進去，
 * 最終落地的組合就沒有人驗過——而那正是語意飄移最容易溜過去的縫隙
 * （文字衝突 GitHub 自己會擋，「我依賴的函式被別人改掉了」不會）。
 *
 * 更麻煩的是它壞掉的方式：下一群的 Merge Guard 會撞到紅燈，但系統會把帳算到
 * **下一群**頭上，把無辜的那群退回重做，而真正的兇手已經在 base 裡了。
 *
 * ── 為什麼是鎖而不是「合併前檢查 SHA 變了就重跑」 ──
 *
 * 光靠重跑會退化成 O(N²)：三群同時完成，G1 合併後 G2、G3 都要重跑，
 * G2 合併後 G3 又要再跑一次。Merge Guard 是整套裡最貴的操作（實測分鐘級）。
 * 序列化則是每群**剛好跑一次**，而且每次驗的都是它真正會落地的 base——
 * 對著會變動的 base 做驗證，本質上就是序列的，這已經是最優。
 *
 * SHA 檢查仍然要做，但角色不同：它擋的是**鎖看不到的合併**（人在 GitHub 上自己按、
 * 或別的工具合併）。平常不會觸發。
 *
 * 鍵是 repo：**不同專案完全並行**，只有同一個 repo 的合併互相排隊。
 */

/** repo → 佇列尾端。 */
const queues = new Map<string, Promise<void>>();
/**
 * repo → 尚未完成的持有者數（**排隊中的也算**）。
 *
 * 刻意在 withRepoLock 被呼叫的當下就同步 +1，而不是等排到才算：
 * tryWithRepoLock 問的是「現在丟進去會不會排隊」，如果只算「正在執行」的，
 * 它就會在別人已經排隊、只是還沒輪到的那一瞬間誤判成「沒人用」，然後自己也去排隊——
 * 那正是它要避免的（主迴圈被卡住）。
 */
const holders = new Map<string, number>();

/** 這個 repo 現在有沒有人持有或正在排隊。 */
export function isRepoLocked(repoKey: string): boolean {
  return (holders.get(repoKey) ?? 0) > 0;
}

/** 排隊等鎖，拿到才執行。fn 擲錯照樣往外丟，但不會傳染給排在後面的人。 */
export function withRepoLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
  holders.set(repoKey, (holders.get(repoKey) ?? 0) + 1);
  const prev = queues.get(repoKey) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      return await fn();
    } finally {
      const n = (holders.get(repoKey) ?? 1) - 1;
      if (n > 0) holders.set(repoKey, n);
      else holders.delete(repoKey);
    }
  });
  // 存「已吞錯」的版本：前一段失敗不可以傳染給後面的人，也不可以變成 unhandled rejection
  queues.set(
    repoKey,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * 拿不到鎖就**不做**，回 undefined。
 *
 * 給「下一輪再試也沒差」的呼叫端用——主要是 Orchestrator 的合併佇列。
 * 它是在主迴圈裡 await 的，如果改成排隊等，一個正在跑 Merge Guard 的 worker
 * 就會把整個主迴圈卡住好幾分鐘：輪詢、規劃、派工、提醒全部停擺。
 * 15 秒後的下一輪再試就好。
 */
export async function tryWithRepoLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (isRepoLocked(repoKey)) return undefined;
  return withRepoLock(repoKey, fn);
}

/** 測試用：清掉所有鎖狀態。 */
export function resetRepoLocksForTest(): void {
  queues.clear();
  holders.clear();
}
