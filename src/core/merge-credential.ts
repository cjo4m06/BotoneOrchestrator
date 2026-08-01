/**
 * 合併核准憑證的事件種類。
 *
 * 單獨一個模組是為了避免循環相依：Orchestrator 與 InboundRouter 都要用它，
 * 而 Orchestrator 本來就會 import notifier 的型別。
 *
 * 為什麼憑證要落在 ledger 而不是只放記憶體（D17 的補充）：
 *   · CLI（`npm run ask -- g_x approve`）是另一個行程，記憶體傳不過去
 *   · 獨立執行的控制台同理
 *   · daemon 重啟 ⇒ 重啟前的核准全部消失，群組退回「沒有推進者」
 * 三種情況都會讓人「以為核准了」但什麼都沒發生——最難察覺的那種故障。
 *
 * D17 本身不變：憑證是**明確寫下的一筆事件**，不是從 merge_guard 狀態推論出來的。
 * 作廢事件用來抵銷舊憑證，否則一次核准可以被拿去合併第二次。
 */
export const MERGE_CREDENTIAL_EVENT = 'merge_credential';
export const MERGE_CREDENTIAL_CLEARED_EVENT = 'merge_credential_cleared';
