import { withRepoLock } from '../core/repo-lock.js';

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
 */
export function withFetchLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  return withRepoLock(`fetch:${repoPath}`, fn);
}
