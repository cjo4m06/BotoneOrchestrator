/**
 * 「現拿」的值：可以是固定值，也可以是每次用時才呼叫的函式。
 *
 * 為什麼要有這個型別：這個系統的設定有兩個來源——開機讀進來的 config，
 * 以及控制台隨時會改的 DB。**收一份快照留著的地方，就是熱重載失效的地方，
 * 而且失效得很安靜**：存檔鈕顯示「已儲存」、欄位也會顯示新值（畫面回頭讀 DB），
 * 只有 daemon 還在用開機那份，沒有任何日誌會講。
 *
 * 實際踩過的（2026-08-06 稽核）：
 *  · `allowLocalMerge` 關掉想踩煞車 → 照舊自動合併（**不可逆的外部副作用**）
 *  · `commandTimeoutSec` 改大 → 仍用舊值判紅，agent 一直白改程式去追時間問題
 *  · 各角色的模型別名 → 改了對誰都不生效，而同一顆存檔鈕的提示寫著「不必重啟」
 *
 * 用法：欄位型別寫成 `Hot<T>`，使用點一律 `hotValue(...)`。
 * **不要直接把欄位當值用**——傳函式進來時它永遠是 truthy，等於永遠開著。
 */
export type Hot<T> = T | (() => T | undefined);

/** 取當下的值。傳函式就呼叫它，傳固定值就原樣回（未設 → undefined）。 */
export function hotValue<T>(v: Hot<T> | undefined): T | undefined {
  return typeof v === 'function' ? (v as () => T | undefined)() : v;
}
