/**
 * 專案「連不連得上」的單一計數器。
 *
 * ── 為什麼需要它 ──
 *
 * 專案 runtime 建不起來（MCP 連不上、token 過期、repo 沒有 remote、repoPath 被搬走）時，
 * orchestrator 只會 `warnOnce` 然後把該專案的 ready 群組整批靜默過濾掉。群組停在 ready、
 * 任務停在 queued，而控制台對 enabled 的專案一律印綠色「啟用中」——
 * **連不上的專案和健康的專案長得一模一樣**，而佇列一動也不動。
 *
 * ── 為什麼是計數器，不是「一失敗就開單」──
 *
 * 多數失敗會自己好（MCP 重連、網路抖動）。第一次就吵等於製造雜訊，而雜訊會讓人不看清單。
 * 所以要**兩個條件同時成立**才升級成一張單：連續失敗次數夠多、而且已經持續夠久。
 *
 * ── 為什麼 key 是 repo ──
 *
 * 「哪些群組被擋住」是用 repo 判斷的（orchestrator 的 projectAvailable、
 * poller 的 source）。用 projectId 當 key 的話，同一個 repo 換過 project 設定就對不起來。
 *
 * ── 程式不解析 reason／fix ──
 *
 * 兩者都是**失敗發生的那一行自己寫的原話**。特別是 `fix`：
 * 「repo 沒有 remote」的解法是去機器上 `git remote add`，而不是到控制台按「測試連線」
 *（那顆只測 MCP，按了會拿到綠燈、問題還在）。由發生點自己寫，才不會給出按得動但沒用的指示。
 */

export const PROJECT_DOWN_KIND = 'env_blocked';

/** 連續失敗幾次才算真的壞了（低於這個數多半是抖動）。 */
export const PROJECT_DOWN_MIN_FAILURES = 2;

/** 而且要持續這麼久。**兩個條件同時成立**才開單。 */
export const PROJECT_DOWN_GRACE_MS = 5 * 60_000;

export interface ProjectFailure {
  repo: string;
  projectId?: string;
  /** 失敗那一行自己寫的原話。 */
  reason: string;
  /** 失敗那一行自己寫的「該去哪裡做什麼」。 */
  fix: string;
  /** false ＝ 重試不會有用（設定錯、缺 remote），畫面上不該給重試鈕。 */
  retryable?: boolean;
}

export interface ProjectDown extends ProjectFailure {
  since: number;
  failures: number;
  lastAt: number;
}

/**
 * 唯一的失敗計數器。**兩個產生端都餵它**：
 *  · registry.sync（建 runtime／連 MCP）
 *  · poller（listTasks／getTask）——這是主要的那一半：
 *    registry 的指紋沒變就不會重建 runtime，所以「跑三天後 MCP 掛掉」registry 完全看不到。
 */
export class ProjectHealthTracker {
  private readonly downs = new Map<string, ProjectDown>();

  fail(f: ProjectFailure, now: number): void {
    const prev = this.downs.get(f.repo);
    this.downs.set(f.repo, {
      ...f,
      since: prev?.since ?? now,
      failures: (prev?.failures ?? 0) + 1,
      lastAt: now,
    });
  }

  /** 成功一次就清零。**修好了就要能收單**，否則清單上會留著一張沒人收得掉的。 */
  ok(repo: string): void {
    this.downs.delete(repo);
  }

  snapshot(): ProjectDown[] {
    return [...this.downs.values()];
  }

  /** 已經壞到該讓人看見的（兩個條件同時成立）。 */
  blocked(now: number): ProjectDown[] {
    return this.snapshot().filter(
      (d) => d.failures >= PROJECT_DOWN_MIN_FAILURES && now - d.since >= PROJECT_DOWN_GRACE_MS,
    );
  }
}

/** 回報用的 ledger 子集（測試可注入假件）。 */
export interface HealthLedger {
  openHandoff(input: {
    repo?: string; fromRole: 'program'; toRole: 'human'; kind: 'env_blocked';
    title: string; body: string; options?: string[]; ifIgnored?: string;
  }): string;
  listHandoffs(q: { toRole?: string; kind?: string; repo?: string; unconsumedOnly?: boolean; limit?: number }):
    { id: string; repo?: string }[];
  consumeHandoff(id: string): boolean;
  logEvent(scope: 'system', refId: string | null, kind: string, detail?: string): void;
}

/**
 * 把當下的「連不上」清單同步成交接單。
 *
 * ── 為什麼收單要用對帳，不用記憶體差集 ──
 *
 * 「這一輪剛恢復的專案」用記憶體算得出來，但那會漏掉：daemon 停著時人在**獨立行程**的
 * 控制台把專案停用／刪掉、或別的行程改了設定。對帳（拿現在的清單去比 DB 裡未消化的單）
 * 涵蓋全部情況，而且重啟後照樣正確。
 */
export function reportProjectHealth(i: {
  ledger: HealthLedger;
  log: { warn(o: unknown, m: string): void; info(o: unknown, m: string): void };
  now: number;
  downs: ProjectDown[];
}): void {
  const { ledger, log, downs } = i;
  const downRepos = new Set(downs.map((d) => d.repo));

  for (const d of downs) {
    // 已經有一張就不再開（去重；內容會隨下一次恢復再重開）
    if (ledger.listHandoffs({ toRole: 'human', kind: PROJECT_DOWN_KIND, repo: d.repo, unconsumedOnly: true, limit: 1 }).length) continue;
    ledger.openHandoff({
      repo: d.repo,
      fromRole: 'program',
      toRole: 'human',
      kind: PROJECT_DOWN_KIND,
      title: `專案 ${d.repo} 連不上，這個專案的工作全部停著`,
      body: `${d.reason}\n\n怎麼修：${d.fix}\n\n`
        + `已經連續失敗 ${d.failures} 次、持續 ${Math.round((i.now - d.since) / 60_000)} 分鐘。`
        + '在修好之前，這個專案的群組會停在排隊中不動——而它們看起來跟正常排隊一模一樣。',
      // **沒有可按的動作**：解法在機器上，這個系統按什麼都沒用（與「認領不回來」同一個形狀）
      options: [],
      ifIgnored: '這個專案的所有群組都不會被派工，而且畫面上看起來像正常排隊。',
    });
    log.warn({ repo: d.repo, failures: d.failures, reason: d.reason }, '🔌 專案連不上，已開單');
  }

  // 恢復／停用／刪除 → 收單
  for (const h of ledger.listHandoffs({ toRole: 'human', kind: PROJECT_DOWN_KIND, unconsumedOnly: true, limit: 200 })) {
    if (!h.repo || downRepos.has(h.repo)) continue;
    ledger.consumeHandoff(h.id);
    ledger.logEvent('system', h.repo, 'project_up', '已恢復／已停用／已刪除，收掉這張單');
    log.info({ repo: h.repo }, '🔌 專案恢復，收掉那張單');
  }
}
