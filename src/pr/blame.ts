import { createMergeTree, type GitRun } from './merge-verify.js';
import type { Logger } from '../observability/logger.js';
import type { CheckRunInput } from '../store/ledger.js';

/**
 * 「這個紅是誰造成的」——用**實驗**回答，不用猜。
 *
 * ── 為什麼需要 ──
 *
 * 實跑（2026-08-04）：PR #54 只新增 6 個檔（AvatarCropModal），被一個完全無關的
 * 後端測試（`schedule-engine.test.ts`）擋下。程式只跑一次測試，紅了就斷定
 * `semantic_drift`（＝這一群造成的），把它回灌給 agent 修——而 agent 根本改不到
 * 那個檔，三輪必然修不好，重試預算用完，16 個任務堵住，最後丟給人手動合併。
 *
 * 事後查證只花了兩個實驗就看得出來：
 * · 同一條分支 9 分鐘前才通過同一道關卡（check_runs 現在查得到）
 * · 四次失敗有四個不同的失敗指紋（＝每次紅的測試都不一樣）
 *
 * 這個模組把那兩個實驗變成程式**跑得起來**的東西。它只產生事實，不下結論——
 * 「所以這是誰的錯」由合併者讀完這些原始輸出自己判斷。
 *
 * ── 這裡刻意不做什麼 ──
 *
 * 不比對輸出內容、不算相似度、不判斷「像不像同一個失敗」。那些都是**猜**：
 * 換一個測試框架、換一種輸出格式就全錯，而且錯了沒有人會知道。
 * 只回報 exit code 與全文，剩下的交給讀得懂的人。
 */

export interface ExperimentSpec {
  /** 在哪一顆 commit 上跑（40 位 sha 或任何 git 解得開的 ref）。 */
  ref: string;
  /** 跑幾次。**不穩定的測試要跑多次才看得出來**——跑一次只知道這一次紅不紅。 */
  times: number;
  /** 給人／agent 看的一句話：這個實驗在問什麼。 */
  question: string;
}

export interface ExperimentRun {
  attempt: number;
  exitCode?: number;
  output: string;
  startedAt: number;
  endedAt: number;
}

export interface ExperimentResult {
  spec: ExperimentSpec;
  /** 實際跑起來的那幾次。長度可能小於 `times`（配額用完、樹建不起來）。 */
  runs: ExperimentRun[];
  /** 沒跑滿時的原因。**一定要講**——「只跑了一次」與「跑了三次都紅」是不同的證據強度。 */
  incomplete?: string;
}

export interface ExperimentBudget {
  /** 總共還能跑幾次。用完時明講，不靜默降級。 */
  runsLeft: number;
  /** 總時間上限（毫秒）。 */
  msLeft: number;
}

export interface RunExperimentInput {
  repoPath: string;
  /** 群分支——實驗跑在它的拋棄式副本上，**不會動到它**。 */
  branch: string;
  spec: ExperimentSpec;
  /** 實際跑關卡的東西（注入，方便測試）。 */
  runCheck: (cwd: string) => Promise<{ exitCode?: number; output: string }>;
  budget: ExperimentBudget;
  log: Logger;
  git?: GitRun;
  prepare?: (treePath: string) => Promise<void>;
  /** 拋棄式樹的根目錄（與守衛同一個；未給 → 系統暫存目錄）。 */
  treeRoot?: string;
  now?: () => number;
  /** 記帳出口：每一次實驗都要進 check_runs（那是事後查證的唯一依據）。 */
  record?: (input: CheckRunInput) => void;
  repo?: string;
}

/**
 * 在指定的 commit 上跑 N 次關卡，回傳 N 份原始輸出。
 *
 * 樹是拋棄式的、用裸 git 建（`withRepoLock` 不可重入，合併路徑持著它——
 * 走 WorktreeManager 會永久死鎖，見 merge-verify.ts 的說明）。
 */
export async function runExperiment(input: RunExperimentInput): Promise<ExperimentResult> {
  const { spec, budget, log } = input;
  const now = input.now ?? Date.now;
  const runs: ExperimentRun[] = [];

  const times = Math.min(spec.times, Math.max(0, budget.runsLeft));
  if (times === 0) {
    return {
      spec,
      runs: [],
      // **用完就明講**。靜默降級成「跑 0 次」會讓下游把「沒查」當成「查過沒事」。
      incomplete: `實驗配額已用完（還想跑 ${spec.times} 次）。請就現有證據判斷，或交給人。`,
    };
  }

  const built = await createMergeTree({
    repoPath: input.repoPath,
    branch: input.branch,
    // 實驗要跑在**指定的那一顆 commit** 上。這裡借用 merge tree 的機制：
    // detach 到分支 sha 再併入 ref——當 ref 就是 base 時，得到的正是「合併後狀態」；
    // 當 ref 是分支自己的祖先時，併是 no-op，得到的就是那顆 commit 本身。
    baseRef: spec.ref,
    log,
    ...(input.git ? { git: input.git } : {}),
    ...(input.treeRoot ? { root: input.treeRoot } : {}),
    ...(input.prepare ? { prepare: input.prepare } : {}),
  });
  if (!built.ok) {
    return { spec, runs: [], incomplete: `實驗環境建不起來（${built.reason}）：${built.output.slice(0, 400)}` };
  }

  const deadline = now() + budget.msLeft;
  try {
    for (let i = 0; i < times; i += 1) {
      if (now() > deadline) {
        return { spec, runs, incomplete: `時間配額用完，只跑了 ${runs.length}/${spec.times} 次` };
      }
      const startedAt = now();
      const r = await input.runCheck(built.tree.path);
      const endedAt = now();
      runs.push({ attempt: i + 1, ...(r.exitCode === undefined ? {} : { exitCode: r.exitCode }), output: r.output, startedAt, endedAt });
      input.record?.({
        repo: input.repo ?? '',
        branch: input.branch,
        workspaceKind: 'verify_tree',
        command: `實驗 #${i + 1}：${spec.question}`,
        headSha: built.tree.headSha,
        verifiedBaseSha: built.tree.verifiedBaseSha,
        ...(r.exitCode === undefined ? {} : { exitCode: r.exitCode }),
        output: r.output,
        requestedBy: 'merger',
        startedAt,
        endedAt,
      });
      budget.runsLeft -= 1;
    }
  } finally {
    await built.tree.dispose();
  }

  log.info(
    { branch: input.branch, ref: spec.ref, runs: runs.length, exitCodes: runs.map((r) => r.exitCode) },
    `實驗完成：${spec.question}`,
  );
  return { spec, runs };
}

/**
 * 把實驗結果整理成給合併者看的文字。
 *
 * **只陳述事實**：跑了幾次、每次的 exit code、原始輸出。
 * 不寫「所以這是不穩定的測試」之類的結論——那是讀的人的判斷，
 * 而程式一旦開始下這種結論，就會長出下一個 `semantic_drift`。
 */
export function formatExperiments(results: ExperimentResult[]): string {
  const parts: string[] = [];
  for (const r of results) {
    parts.push(`\n### 實驗：${r.spec.question}`);
    parts.push(`在 \`${r.spec.ref}\` 上跑 ${r.runs.length} 次` + (r.incomplete ? `（${r.incomplete}）` : ''));
    if (r.runs.length === 0) continue;
    // **只列 exit code，不貼輸出。**
    //
    // 先前這裡把每一次的 stdout 全文都印出來（實驗最多跑 3 次，等於三份完整的
    // build/test 輸出），接在判決後面一起回灌給 coder——那正是「塞一堆垃圾訊息」。
    // 全文已經完整落在 check_runs（runExperiment 每一次都 record），
    // 要看的人去那裡看；要判斷的 agent 自己在同一棵樹上重跑就有。
    parts.push(`exit code：${r.runs.map((x) => x.exitCode ?? '沒跑起來').join(' / ')}`);
  }
  return parts.join('\n');
}
