/**
 * 「這個上游永遠不會進 base，但下游可以走了」——由**人**做的那個決定。
 *
 * ── 為什麼需要它 ──
 *
 * `closed`（這一群沒有東西要交付：分支零 commit）是終態，永遠不會變 `merged`。
 * 而「上游結束了沒」全 repo 有兩個判斷點，兩個都只認 `merged`：
 *
 *   · Dispatcher 的 isFinished（main.ts）——群層級的 afterGroups
 *   · Orchestrator.depsInBase——任務層級的 task.dependencies
 *
 * ⇒ 等它的群組會**永遠**排下去，而且畫面上長得跟正常排隊一模一樣。
 *
 * ── 為什麼不讓程式自己放行 ──
 *
 * `closed` 的意思是「群內任務都判定不需要改動」。agent 判的是**它自己那張卡**不用改，
 * **不是**「下游的前提成立」。後者要看懂下游想做什麼、再對照 base 現況——那是判斷，
 * 不是資料。程式自動放行 ＝ 讓下游在一個沒人確認過的前提上開工，而它自己的 DoD 會全綠。
 *
 * 所以這裡只做記帳：把人按下的那一下記成一筆事件，兩個判斷點都讀它。
 *
 * ── 為什麼是事件，不是改 afterGroups ──
 *
 * 依賴關係是規劃當下的事實，改掉它等於偽造歷史（事後查「為什麼 B 沒等 A」會查不到）。
 * 事件是**疊加**的：依賴仍在，只是多了一筆「人在某時放行過」。
 */

export const DEPS_RELEASED_EVENT = 'group_deps_released';

/**
 * 判斷點只需要**讀**。刻意跟寫入端分開：清單那類唯讀路徑不應該為了問一句
 * 「放行了嗎」而被迫宣告自己寫得了 ledger。
 */
export interface DepsReleaseReader {
  latestEvent?(scope: 'task' | 'group' | 'system', refId: string | null, kind: string): { detail?: string } | undefined;
}

/** 記下人按的那一下。 */
export interface DepsReleaseWriter {
  logEvent(scope: 'task' | 'group' | 'system', refId: string | null, kind: string, detail?: string): void;
}

/**
 * 這個上游有沒有被人放行過。
 *
 * **兩個判斷點都要問這一句**——只接一邊的話，群層級放行了、任務層級照樣擋著
 *（或反過來），而症狀是「按了放行，畫面上還是不動」。這正是這個 repo 反覆踩到的形狀。
 */
export function isDepsReleased(ledger: DepsReleaseReader, groupId: string): boolean {
  return ledger.latestEvent?.('group', groupId, DEPS_RELEASED_EVENT) !== undefined;
}

/** 上游算不算「結束了，下游可以走」＝ 成果真的進了 base，或人放行過。 */
export function upstreamSettled(
  ledger: DepsReleaseReader,
  group: { id: string; state: string } | undefined,
): boolean {
  // 群組記錄整個不見 ＝ 資料異常，不該讓後面的群陪葬
  if (!group) return true;
  if (group.state === 'merged') return true;
  return isDepsReleased(ledger, group.id);
}

/**
 * 記下這個決定。回傳被放行的下游 id（給回覆文字用——人要看到自己剛剛放行了誰）。
 *
 * `failed` 也允許放行：它有重試鈕沒錯，但「這個上游我不打算修了，讓後面先走」
 * 同樣是人的決定，而先前那條路只能靠人手動去任務板改依賴。
 * `merged` 不放行（本來就通了，多記一筆只會讓事後查帳更難讀）。
 */
export function releaseDeps(
  ledger: DepsReleaseWriter,
  input: { groupId: string; state: string; blocked: string[]; userId?: string; reason?: string },
): void {
  const who = input.userId ?? 'unknown';
  const detail = `由 ${who} 放行：上游 ${input.groupId}（${input.state}）不會進 base，`
    + `下游 ${input.blocked.length > 0 ? input.blocked.join('、') : '（目前沒有等它的群）'} 不再等它。`
    + (input.reason ? `理由：${input.reason}` : '');
  ledger.logEvent('group', input.groupId, DEPS_RELEASED_EVENT, detail);
  // 也記在下游身上：事後查「B 為什麼沒等 A」時，人是從 B 開始查的
  for (const id of input.blocked) {
    ledger.logEvent('group', id, 'deps_released_upstream', `上游 ${input.groupId} 已由 ${who} 放行，不再等它`);
  }
}
