import { MergeGuard, type DriftJudgeLike, type MergeGuardOptions } from './merge-guard.js';
import { prepareLocalConfig } from '../core/local-config.js';
import type { BaseFreshness } from '../git/base-freshness.js';
import type { CheckRunInput } from '../store/ledger.js';
import type { CheckContext } from '../worker/check-recorder.js';
import type { VerifierLike } from '../contracts.js';
import type { Logger } from '../observability/logger.js';
// 型別匯入（執行期不產生依賴）：守衛的最小介面定義在 orchestrator，測試會塞假件
import type { MergeGuardLike } from '../core/orchestrator.js';

/**
 * Merge Guard 的**唯一**建構點。
 *
 * 為什麼要有這個檔案：守衛有兩個呼叫點——開 PR 前那次（group-runner）與
 * **核准之後、真的要合併的那次**（main.ts 的合併管線）。先前前者接了六項選項，
 * 後者只接了 `prepareTree`，而兩者的判決長得一模一樣，沒有人看得出差別。
 *
 * 少掉的那五項各自的後果（實跑或程式碼可證）：
 *  · `driftJudge`      → merge-guard.ts 的 `if (!judge) return undefined`：語意飄移層**整層不跑、無 log**
 *  · `checkContext`    → verifier.ts 的 `if (recorder && ctx)`：那一輪關卡**一列 check_run 都不寫**
 *  · `experimentBudget`→ `if (!budget) return []`：紅燈時不跑歸咎實驗、靜默回空，
 *                        於是「base 上本來就紅」的證據不見了，核准憑證被作廢、
 *                        沒有 base 對照的紅燈被當 feedback 退回（＝ PR #54「16 個任務死結」重演）
 *  · `onBaseFreshness` → 但書只剩一行 daemon log，不進帳、不通知、不列 PR
 *  · `remote`          → 非 origin remote 的專案寫死 fetch origin，降級成「基於本地狀態」的但書綠燈
 *
 * 所以這裡把六項**全部在函式內組好**，呼叫端沒有「忘了傳」的餘地：
 * 差異只能透過 `MergeGuardWiring` 表達，而那份型別裡沒有可以整項省略的東西。
 */
export interface MergeGuardWiring {
  log: Logger;

  /**
   * 記帳脈絡。**不是可選的**：verifier.ts 的 recorder 是 `if (recorder && ctx)`，
   * 少了 ctx 就整輪不寫 check_runs——最需要事後查證的那一次，剛好是唯一沒有紀錄的。
   */
  ctx: CheckContext;

  /** 依 ctx 造 Verifier（呼叫端各自決定要掛哪些 deps）。 */
  makeVerifier: (ctx: CheckContext) => VerifierLike;

  /**
   * 本機設定檔（.env 之類）的來源＝**主 clone**。
   *
   * **不可以用守衛轉交的 `repoPath`**：merge-guard 把 `input.repoPath` 原封交給
   * `prepareTree`，而合併那條路的 `repoPath` 是合併工作區，不是主 clone。
   * 合併工作區的根目錄檔只在 daemon 開機時複製一次，而 prepareLocalConfig
   * 對已存在的檔直接跳過——所以那條路會永遠拿開機當下那份，`.env` 改了也傳不過去。
   */
  sourceRepoPath: string;

  /** 取最新 base 的 remote 名稱。未給 → 守衛自己退回 'origin'。 */
  remote?: string | undefined;

  /** 語意飄移判斷者。無 Claude 認證時呼叫端會給 undefined，那是明示的降級。 */
  driftJudge?: DriftJudgeLike | undefined;

  /** 關卡記帳出口。 */
  recordCheck?: ((input: CheckRunInput) => void) | undefined;

  /**
   * base 新鮮度的但書出口。**必填**——可以傳只寫 log 的實作，
   * 但要在呼叫端明寫出來，不能靠「沒傳就沒有」。
   */
  onBaseFreshness: (freshness: BaseFreshness) => void;

  /** 測試接縫：給假守衛。 */
  makeGuard?: ((verifier: VerifierLike, options: MergeGuardOptions) => MergeGuardLike) | undefined;
}

/**
 * 歸咎實驗的配額。**每一次守衛獨立**——一次跑爆不該影響下一次。
 * 用完時 runExperiment 會在文字裡明講「配額已用完」，不會靜默降級成「查過沒事」。
 */
export function blameExperimentBudget() {
  return { runsLeft: 3, msLeft: 10 * 60_000 };
}

export function createMergeGuard(w: MergeGuardWiring): MergeGuardLike {
  const options: MergeGuardOptions = {
    experimentBudget: blameExperimentBudget(),
    // 拋棄式驗收樹**沒有 agent**，本機設定檔只能由這裡帶
    //（依賴不帶：複製來的版本對不上這棵樹的 lockfile，那要寫進專案自己的驗收指令）
    prepareTree: async (treePath: string) => {
      await prepareLocalConfig(w.sourceRepoPath, treePath, w.log);
    },
    onBaseFreshness: w.onBaseFreshness,
    ...(w.remote ? { remote: w.remote } : {}),
    ...(w.driftJudge ? { driftJudge: w.driftJudge } : {}),
    ...(w.recordCheck ? { recordCheck: w.recordCheck } : {}),
  };
  const verifier = w.makeVerifier(w.ctx);
  return w.makeGuard?.(verifier, options) ?? new MergeGuard(verifier, w.log, options);
}
