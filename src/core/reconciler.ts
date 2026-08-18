// 崩潰恢復對帳（DESIGN.md §6 末段）+ 長期常駐的保留策略（M6 韌性）。
//
// 預期整合點（本檔不主動接線，由協調者在 main.ts 決定）：
//   1. daemon 啟動後、Orchestrator.run() 之前呼叫一次 reconcile()；
//      它會把上次崩潰時卡在中間狀態的任務/群組收斂到可重跑的狀態，並清掉孤兒 worktree。
//      前提：呼叫時「本機沒有任何 worker 在跑」——main.ts 保證這點；
//      日後若加上單一實例鎖，語意不變（拿到鎖 = 沒有別的實例在動這些 worktree），
//      因此「進行中狀態一律視為崩潰殘留」的推論仍然成立。
//   2. 依賴全部可注入：ledger（結構上相容 store/ledger.ts 的 Ledger）、fs/git 探針、
//      resolveProject（沿用 group-runner.ts 的 ProjectRuntime 解析）、可選的 MCP 讀取端。
//      正式環境用 createFsProbe() / createGitProbe()；測試注入假件。
//   3. dryRun: true 可先看決策不動手（給 CLI/dashboard 診斷用）。
//
// ★ 兩條不可違背的安全原則（審查血淚）：
//   A. 證據不足時一律保守：拿不到 MCP／解析不到專案 runtime，就**不做破壞性決策**
//      （不刪 worktree、不刪分支、不標 failed），改成延後到下次對帳並記事件。
//   B. 已 commit 的成果永不丟：只有「分支上沒有任何 commit」時才會刪分支；
//      判定為 unrecoverable 的群組保留 worktree 與分支，讓人有現場可搶救。

import { execa } from 'execa';
import type { HandoffInput } from '../store/ledger.js';
import { openStuckGroupHandoff } from './handoff.js';
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Group, GroupState, Task, TaskBrief, TaskState } from '../types.js';
import type { Logger } from '../observability/logger.js';
import { preferRemoteRef, type GitRunner } from '../git/base-freshness.js';
import { GROUP_ABORTED_EVENT } from './group-runner.js';

// ── 可注入的相依 ──

/**
 * Reconciler 需要的 ledger 子集（store/ledger.ts 的 Ledger 結構上即滿足）。
 * prune* 為可選能力：Ledger 尚未提供時自動略過保留策略（優雅降級，不影響對帳）。
 */
export interface ReconcilerLedger {
  /** 停手交人時要開交接單——停手與說話是同一個寫入動作（見 core/handoff.ts）。 */
  openHandoff(input: HandoffInput): string;
  getTask(id: string): Task | undefined;
  listTasksByState(state: TaskState): Task[];
  listGroupsByState(state: GroupState): Group[];
  getGroup(id: string): Group | undefined;
  updateTaskState(id: string, state: TaskState, extra?: { lastError?: string; groupId?: string; incAttempts?: boolean }): void;
  updateGroupState(id: string, state: GroupState, extra?: { prUrl?: string; prNumber?: number }): void;
  logEvent(scope: 'task' | 'group' | 'system', refId: string | null, kind: string, detail?: string): void;
  /**
   * 查最近一筆事件。用來認出「上次是被停止而中斷的」——那種群組的 worktree 裡
   * 有未 commit 的工作，絕不可以走清理路徑。
   */
  latestEvent?(scope: 'task' | 'group' | 'system', refId: string | null, kind: string): { detail?: string } | undefined;
  /**
   * 可選：把某群未消化的單收掉。**推進了就要收單**，否則清單上會留著一張
   * 「這群卡住了」，而它其實已經回到待派工——人會再按一次、再一次。
   */
  consumeHandoffsFor?(q: { groupId: string; toRole?: string; kind?: string }): number;
  /** 可選：查交接單（用來認出「已經進終態卻還掛著單」的群）。 */
  listHandoffs?(q: { groupId?: string; toRole?: string; kind?: string; unconsumedOnly?: boolean; limit?: number }): unknown[];
  /** 可選：刪除 created_at 早於 cutoffMs 的稽核事件，回傳刪除筆數。 */
  pruneEvents?(cutoffMs: number): number;
  /** 可選：刪除 at 早於 cutoffMs 的工具呼叫紀錄，回傳刪除筆數。 */
  pruneToolCalls?(cutoffMs: number): number;
  /** 可選：刪除 created_at 早於 cutoffMs 的迭代紀錄，但每個任務至少保留 keepPerTask 筆。 */
}

/** 檔案系統探針（worktree 是否還在、掃孤兒目錄、判定目錄新舊）。 */
export interface FsProbe {
  dirExists(path: string): Promise<boolean>;
  /** 列出 base 底下的第一層目錄（絕對路徑）。base 不存在時回空陣列。 */
  listDirs(base: string): Promise<string[]>;
  removeDir(path: string): Promise<void>;
  /** 目錄最後異動時間（epoch ms）；取不到回 undefined —— 呼叫端必須當成「無法判定 → 保留」。 */
  dirMtimeMs(path: string): Promise<number | undefined>;
}

/** git 探針（分支/commit 狀態、清 worktree）。 */
export interface GitProbe {
  branchExists(repoPath: string, branch: string): Promise<boolean>;
  /** branch 相對 base 領先幾個 commit；分支不存在或算不出來回 0。 */
  commitsAhead(repoPath: string, branch: string, base: string): Promise<number>;
  removeWorktree(repoPath: string, worktreePath: string): Promise<void>;
  deleteBranch(repoPath: string, branch: string): Promise<void>;
  /** 清掉已消失目錄留下的 worktree 登記。 */
  prune(repoPath: string): Promise<void>;
}

/** Reconciler 只需要專案的本地路徑與基底分支（ProjectRuntime 的子集）。 */
export interface ReconcilerProject {
  repoPath: string;
  baseBranch: string;
}

/** 可選：與 MCP 對帳（DESIGN §6：list_tasks({mine, in_progress}) ∩ ledger）。 */
export interface ReconcilerMcp {
  listTasks(q: { repo?: string; mine?: boolean; status?: 'todo' | 'in_progress' | 'done' }): Promise<TaskBrief[]>;
  /**
   * 可選：多專案聚合器用來回報「這次有幾個來源失敗」。
   * 有實作時，只要任一來源失敗就視為證據不完整 → 對帳自動退回保守模式。
   * 沒實作時只能靠「整個查詢是否丟例外」判斷（聚合器吞掉個別失敗會看不出來）。
   */
  listTasksDetailed?(q: { repo?: string; mine?: boolean; status?: 'todo' | 'in_progress' | 'done' }): Promise<{
    tasks: TaskBrief[];
    failedSources: number;
  }>;
}

/** 長期常駐的保留策略（避免 worktree/截圖/稽核紀錄無限成長）。 */
export interface RetentionPolicy {
  /** 終態群組（merged/failed）的 worktree 保留天數——期間內保留現場供人工診斷。 */
  terminalWorktreeDays: number;
  /** agent 暫存／截圖保留天數；只清「ledger 查無此任務或任務已 done」的目錄。 */
  screenshotDays: number;
  /** events 稽核紀錄保留天數。 */
  eventDays: number;
  /**
   * 工具呼叫紀錄保留天數。
   *
   * 與 eventDays 分開：這張表的成長是別人的一到兩個數量級（實跑一張卡 47 次呼叫）。
   * 但預設仍給滿 30 天——它存在的理由就是「事後才發現要查」，
   * 而工作區被清空那次是隔了兩天才有人看到那筆回報。
   */
  toolCallDays: number;
  /** task_iterations 保留天數。 */
  iterationDays: number;
  /** 不論多舊，每個任務至少保留這麼多筆迭代紀錄（保住最後現場）。 */
  keepIterationsPerTask: number;
}

/** 預設保留期刻意偏長：磁碟便宜，診斷現場很貴。 */
export const DEFAULT_RETENTION: RetentionPolicy = {
  terminalWorktreeDays: 7,
  screenshotDays: 14,
  eventDays: 30,
  toolCallDays: 30,
  iterationDays: 30,
  keepIterationsPerTask: 20,
};

export interface ReconcilerDeps {
  ledger: ReconcilerLedger;
  fs: FsProbe;
  git: GitProbe;
  log: Logger;
  /** 與 GroupRunner 共用的 worktree 根目錄。 */
  worktreeBase: string;
  resolveProject: (repo: string) => ReconcilerProject | undefined;
  /** 已知的所有本地 repo 路徑；清完孤兒目錄後逐一 prune。 */
  knownRepoPaths?: () => string[];
  mcp?: ReconcilerMcp;
  /** 覆寫 worktree 路徑推導（預設與 WorktreeManager 相同規則）。 */
  worktreePathFor?: (group: Group) => string;
  /** agent 的暫存／截圖根目錄（＝ browserOutputRoot）；未提供則不清。 */
  screenshotRoot?: string;
  /** 覆寫保留策略（只填想改的欄位）。 */
  retention?: Partial<RetentionPolicy>;
  /** 可注入時鐘（測試用）。 */
  clock?: () => number;
}

// ── 報告型別 ──

export type ReconcileDecision =
  | 'resume'          // 分支有 commit → 保留分支續做
  | 'restart'         // 狀態不明且無成果 → 清乾淨重做
  | 'unrecoverable'   // 已回報 done 的成果遺失 → 標 failed 交人處理（現場保留）
  | 'needs_human'     // 成果完好但沒有可自動續跑的入口 → 交人處理，完全不動手
  | 'deferred'        // 證據不足（MCP/專案 runtime 拿不到）→ 什麼都不做，等下次對帳
  | 'requeued'        // 單一任務回到 queued
  | 'synced_done'     // MCP 已 done，ledger 補記
  | 'orphan_removed'  // 孤兒 worktree 清除
  | 'pruned'          // 逾保留期的資料清除
  | 'skipped';

export interface ReconcileAction {
  scope: 'task' | 'group' | 'worktree' | 'retention';
  ref: string;
  decision: ReconcileDecision;
  detail: string;
}

export interface ReconcileReport {
  actions: ReconcileAction[];
  groupsResumed: number;
  groupsRestarted: number;
  groupsFailed: number;
  /** 需人工介入（成果保留，系統不動手）。 */
  groupsNeedsHuman: number;
  /** 證據不足而延後處理（下次對帳再看）。 */
  groupsDeferred: number;
  tasksRequeued: number;
  tasksSyncedDone: number;
  orphanWorktreesRemoved: number;
  /** 在保留期內、刻意不刪的 worktree 數。 */
  worktreesRetained: number;
  eventsPruned: number;
  iterationsPruned: number;
  screenshotDirsRemoved: number;
}

/** 任務層的中間狀態：daemon 崩潰時只可能卡在這些狀態。 */
const TASK_LIMBO: TaskState[] = ['in_progress', 'verifying'];

/** 群組終態：不會再有任何機器流程推進它（worktree 可進入保留期倒數）。 */
const GROUP_TERMINAL: GroupState[] = ['merged', 'failed', 'closed'];

/** 「群內任務正在跑」的狀態：崩潰殘留，需要重排任務。 */
const GROUP_RUNNING: GroupState[] = ['forming'];

/**
 * 成果已全部 commit、流程停在後段的狀態。
 * 這些狀態在崩潰後**不能**退回 ready 重跑：GroupRunner 會對已 done 的任務再 start_task，
 * MCP 會拒絕 → 群組反而被標 failed，等於毀掉已完成的成果。所以一律「保留現場 + 交人工/等外部」。
 */
const GROUP_POST_WORK: GroupState[] = ['merge_guard', 'pr_open', 'in_review', 'changes_requested'];

/** 對帳要逐一檢視的群組狀態（ready = 正常排隊中，無需動作）。 */
const GROUP_LIMBO: GroupState[] = [...GROUP_RUNNING, ...GROUP_POST_WORK];

/** 這些狀態的群組仍持有合法 worktree，掃孤兒時不可誤刪。 */
const GROUP_ALIVE: GroupState[] = ['forming', 'ready', 'pr_open', 'in_review', 'changes_requested', 'merge_guard'];

const DAY_MS = 24 * 60 * 60 * 1000;

/** 分支名 → worktree 目錄名。必須與 git/worktree.ts 的 slug() 一致。 */
export function worktreeDirName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, '-');
}

// ── 預設探針實作 ──

export function createFsProbe(): FsProbe {
  return {
    async dirExists(path) {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    async listDirs(base) {
      try {
        const entries = await readdir(base, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => join(resolve(base), e.name));
      } catch {
        return [];
      }
    },
    async removeDir(path) {
      await rm(path, { recursive: true, force: true });
    },
    async dirMtimeMs(path) {
      try {
        return (await stat(path)).mtimeMs;
      } catch {
        // 取不到就回 undefined，讓呼叫端保守處理（保留）
        return undefined;
      }
    },
  };
}

export function createGitProbe(log: Logger): GitProbe {
  const git = async (repoPath: string, args: string[]): Promise<string> => {
    const res = await execa('git', ['-C', repoPath, ...args], { reject: false });
    return res.stdout.trim();
  };
  const runner: GitRunner = async (repoPath, args) => {
    const res = await execa('git', ['-C', repoPath, ...args], { reject: false });
    return { exitCode: res.exitCode ?? 1, stdout: res.stdout, stderr: res.stderr };
  };
  return {
    async branchExists(repoPath, branch) {
      const res = await execa('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { reject: false });
      return res.exitCode === 0;
    },
    async commitsAhead(repoPath, branch, base) {
      // 基準必須是 remote-tracking 版本。本地 base 是舊的（daemon 只 fetch，不 checkout 更新它），
      // 拿它比的話，「別的群組已經合併進 origin 的 commit」會被算成這個分支的成果。
      //
      // 實跑撞到：崩潰後對帳，把一個 agent 連一行都還沒 commit 的群組判成
      // 「可續（領先 5 個 commit）」——那 5 個是 origin/main 領先本地 main 的量。
      // 這個數字是三條決策路徑的分岔點（hasCommits），算錯的話
      // 「成果遺失 → 交人工」與「什麼都沒有 → 清理重做」兩條路等於永遠走不到。
      const ref = await preferRemoteRef(runner, repoPath, base);
      const out = await git(repoPath, ['rev-list', '--count', `${ref}..${branch}`]);
      const n = Number.parseInt(out, 10);
      return Number.isFinite(n) ? n : 0;
    },
    async removeWorktree(repoPath, worktreePath) {
      await git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
      await git(repoPath, ['worktree', 'prune']);
    },
    async deleteBranch(repoPath, branch) {
      const res = await execa('git', ['-C', repoPath, 'branch', '-D', branch], { reject: false });
      if (res.exitCode !== 0) log.warn({ branch, err: res.stderr }, '刪分支失敗（可能已不存在）');
    },
    async prune(repoPath) {
      await git(repoPath, ['worktree', 'prune']);
    },
  };
}

/** 本輪對帳掌握到的 MCP 證據品質。 */
interface McpEvidence {
  /** MCP 有回應且涵蓋所有來源。 */
  complete: boolean;
  /**
   * MCP 有設定但這次拿不到（連不上／部分來源失敗）。
   * true 代表「暫時性的資訊缺口」→ 破壞性決策必須延後，不可當成證據來源本來就不存在。
   */
  degraded: boolean;
  detail: string;
}

// ── Reconciler ──

/**
 * daemon 重啟時的對帳器。
 * 原則：ledger 是細狀態的事實源，但磁碟/git 才是「實際做到哪」的證據；
 * 兩者不一致時收斂到「可重跑」而非「假裝還在跑」——但只在證據充分時才動手，
 * 資訊不全寧可卡著等人，也不刪任何可能是成果的東西。
 */
export class Reconciler {
  private readonly retention: RetentionPolicy;
  /** 這一輪要不要留下人看得見的痕跡（只有純診斷的 dryRun 才閉嘴）。 */
  private speak = true;

  constructor(private deps: ReconcilerDeps) {
    this.retention = { ...DEFAULT_RETENTION, ...deps.retention };
  }

  /**
   * `conservative` 與 `dryRun` 是**兩件事**，先前它們共用同一個旗標。
   *
   * 保守開機（上次收尾未完成、worktree 可能還有 agent 在寫）＝ 不動手；
   * 但它幾乎每次非正常重啟都會發生，而折進 dryRun 之後那一輪連單都不開
   * ⇒ 最需要人接手的那次，畫面上一個字都沒有，群組就這樣停著。
   *
   * 所以現在：conservative ＝ 不動手但照樣把該給人的單開出來；
   * dryRun ＝ 純診斷（CLI／dashboard 用），一個字都不寫。
   */
  async reconcile(opts: { dryRun?: boolean; conservative?: boolean } = {}): Promise<ReconcileReport> {
    const dryRun = opts.dryRun === true;
    // 傳給各分支的 `dryRun` 參數語意是「不要動手」——保守開機也不動手
    const mutate = !dryRun && opts.conservative !== true;
    this.speak = !dryRun;
    const report: ReconcileReport = {
      actions: [], groupsResumed: 0, groupsRestarted: 0, groupsFailed: 0,
      groupsNeedsHuman: 0, groupsDeferred: 0,
      tasksRequeued: 0, tasksSyncedDone: 0, orphanWorktreesRemoved: 0, worktreesRetained: 0,
      eventsPruned: 0, iterationsPruned: 0, screenshotDirsRemoved: 0,
    };
    this.deps.log.info({ dryRun, conservative: opts.conservative === true }, '崩潰恢復對帳開始');

    const evidence = await this.syncWithMcp(report, !mutate);
    // 本輪動過（或刻意不動）的群組 worktree：不管最後狀態變成什麼，這一輪都不清，
    // 避免「剛標 failed → 同一輪就被孤兒清掃 rm -rf」把還沒 commit 的成果一起帶走。
    const touched = new Set<string>();
    for (const state of GROUP_LIMBO) {
      for (const group of this.deps.ledger.listGroupsByState(state)) {
        touched.add(this.worktreePath(group));
        await this.reconcileGroup(group, evidence, report, !mutate);
      }
    }
    this.sweepTerminalHandoffs(!mutate);
    this.requeueStrayTasks(report, !mutate);
    await this.sweepOrphanWorktrees(report, dryRun, touched);
    await this.applyRetention(report, !mutate);

    this.deps.log.info(
      {
        resumed: report.groupsResumed, restarted: report.groupsRestarted, failed: report.groupsFailed,
        needsHuman: report.groupsNeedsHuman, deferred: report.groupsDeferred,
        requeued: report.tasksRequeued, orphans: report.orphanWorktreesRemoved, retained: report.worktreesRetained,
      },
      '崩潰恢復對帳完成',
    );
    if (this.speak) this.deps.ledger.logEvent('system', null, 'reconcile', JSON.stringify(report.actions));
    return report;
  }

  /**
   * MCP 對帳：崩潰點可能落在 complete_task 之後、ledger 寫入之前。
   * MCP 說 done 就是 done（它才是任務的事實源），ledger 補記，避免重做已完成的任務。
   * 同時回報「這次證據夠不夠完整」，供後續決策決定要不要保守。
   */
  private async syncWithMcp(report: ReconcileReport, dryRun: boolean): Promise<McpEvidence> {
    const { mcp, ledger, log } = this.deps;
    // 沒設定 MCP 讀取端 = 這套部署本來就只有本地證據，不是「暫時拿不到」，
    // 因此不算 degraded，否則正常流程會永遠停在延後狀態。
    if (!mcp) return { complete: false, degraded: false, detail: '未設定 MCP 讀取端（僅本地證據）' };

    let remote: TaskBrief[];
    let failedSources = 0;
    try {
      if (mcp.listTasksDetailed) {
        const res = await mcp.listTasksDetailed({ mine: true, status: 'done' });
        remote = res.tasks;
        failedSources = res.failedSources;
      } else {
        remote = await mcp.listTasks({ mine: true, status: 'done' });
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log.warn({ err: detail }, 'MCP 對帳失敗：本輪不做任何破壞性決策');
      return { complete: false, degraded: true, detail: `MCP 查詢失敗：${detail}` };
    }

    const doneIds = new Set(remote.map((t) => t.id));
    for (const t of TASK_LIMBO.flatMap((s) => ledger.listTasksByState(s))) {
      if (!doneIds.has(t.id)) continue;
      if (!dryRun) ledger.updateTaskState(t.id, 'done');
      report.tasksSyncedDone += 1;
      report.actions.push({ scope: 'task', ref: t.id, decision: 'synced_done', detail: 'MCP 已標記 done，ledger 補記' });
    }

    if (failedSources > 0) {
      log.warn({ failedSources }, '部分 MCP 來源查詢失敗：證據不完整，本輪保守處理');
      return { complete: false, degraded: true, detail: `${failedSources} 個 MCP 來源查詢失敗` };
    }
    return { complete: true, degraded: false, detail: 'MCP 證據完整' };
  }

  /** 依群組狀態分流：跑到一半的（forming）vs 成果已 commit 的後段狀態。 */
  private async reconcileGroup(group: Group, evidence: McpEvidence, report: ReconcileReport, dryRun: boolean): Promise<void> {
    if (GROUP_POST_WORK.includes(group.state)) {
      this.reconcilePostWorkGroup(group, report, dryRun);
      return;
    }
    await this.reconcileRunningGroup(group, evidence, report, dryRun);
  }

  /**
   * 成果已 commit 的後段狀態（merge_guard / pr_open / in_review / changes_requested）。
   * 共同點：群內任務都已 done，成果在分支上，**任何自動清理都是在毀成果**，所以一律不動手。
   *   - merge_guard：崩潰在守衛中途。守衛本身冪等可重跑，但目前沒有「只重跑守衛」的入口
   *     （退回 ready 會讓 GroupRunner 對已 done 任務重新 start_task）→ 交人工。
   *   - changes_requested：需要照審查意見回頭改，目前沒有自動回步驟 5 的路徑 → 交人工。
   *   - pr_open / in_review：本來就在等外部（人/GitHub）事件，daemon 不在也不算殘留 → 略過。
   */
  private reconcilePostWorkGroup(group: Group, report: ReconcileReport, dryRun: boolean): void {
    const { ledger, log } = this.deps;
    const needsHuman = group.state === 'merge_guard' || group.state === 'changes_requested';
    if (!needsHuman) {
      report.actions.push({
        scope: 'group', ref: group.id, decision: 'skipped',
        detail: `狀態 ${group.state}：等待外部事件，非崩潰殘留（分支與 worktree 一律保留）`,
      });
      return;
    }

    const detail =
      group.state === 'merge_guard'
        ? '崩潰於 Merge Guard 進行中：成果已 commit 於分支，但沒有「只重跑守衛」的自動入口，需人工續跑'
        : '審查要求修改：目前沒有自動回頭改的路徑，需人工處理';
    // 刻意不改群組狀態：維持非終態才能讓孤兒清掃認得它、保住 worktree 現場
    if (!dryRun) {
      ledger.logEvent('group', group.id, 'reconcile_needs_human', detail);
      // 「沒有自動路徑」與「重試用完」是不同的處境（後者按重試還有意義，前者沒有），
      // 但兩者都要出現在清單上——先前兩者都靠推論，而推論漏了 changes_requested。
      openStuckGroupHandoff(ledger, log, { groupId: group.id, repo: group.repo, why: detail });
    }
    report.groupsNeedsHuman += 1;
    report.actions.push({ scope: 'group', ref: group.id, decision: 'needs_human', detail });
    log.error({ group: group.id, state: group.state, branch: group.branch }, '群組需人工介入（成果保留，系統不動手）');
  }

  /**
   * 已經進終態、卻還掛著「這一群卡住了」的單 → 收掉。
   *
   * 寫入端（Ledger.updateGroupState）現在會在群組進 merged／closed 時收，但那只對
   * **之後**的狀態變化有效——已經卡在庫裡的舊單沒有任何人會再碰它，因為那個群組
   * 不會再有下一次狀態變更。而它在畫面上是最糟的形狀：講著已經不成立的事，
   * 又因為終態不是可復活狀態而連一顆按鈕都沒有。
   */
  private sweepTerminalHandoffs(dryRun: boolean): void {
    const { ledger, log } = this.deps;
    if (!ledger.listHandoffs || !ledger.consumeHandoffsFor) return;
    for (const st of ['merged', 'closed'] as const) {
      for (const g of ledger.listGroupsByState(st)) {
        if (ledger.listHandoffs({ groupId: g.id, toRole: 'human', kind: 'stuck_group', unconsumedOnly: true, limit: 1 }).length === 0) continue;
        if (dryRun) continue;
        const n = ledger.consumeHandoffsFor({ groupId: g.id, toRole: 'human', kind: 'stuck_group' });
        ledger.logEvent('group', g.id, 'stale_handoff_consumed', `群組已是 ${st}，收掉 ${n} 張過期的「卡住」單`);
        log.info({ group: g.id, state: st, consumed: n }, '群組已進終態，收掉過期的卡住單');
      }
    }
  }

  /**
   * **這一輪沒有推進這個群組 → 一定留下一張人看得見的單。**
   *
   * log.warn／logEvent 不算數：畫面只讀未消化的 human 單。先前對帳的三條路都只寫事件，
   * 而它們落地的狀態（forming）既按不動重試、也不在任何 requeue 規則裡
   * ⇒ 每次重啟只是把同一筆事件再寫一遍（實跑停了 55 小時）。
   */
  private stall(group: Group, why: string, eventKind: string, report: ReconcileReport): void {
    const { ledger, log } = this.deps;
    report.groupsDeferred += 1;
    report.actions.push({ scope: 'group', ref: group.id, decision: 'deferred', detail: why });
    if (!this.speak) return;
    ledger.logEvent('group', group.id, eventKind, why);
    // forming 現在按得動重試（見 handoff.ts 的 STUCK_GROUP_STATES），所以這顆鈕是實的
    openStuckGroupHandoff(ledger, log, { groupId: group.id, repo: group.repo, why, options: ['retry'] });
  }

  /** forming 群組（崩潰時群內任務正在跑）的恢復決策。 */
  private async reconcileRunningGroup(group: Group, evidence: McpEvidence, report: ReconcileReport, dryRun: boolean): Promise<void> {
    const { ledger, fs, git, log } = this.deps;
    const proj = this.deps.resolveProject(group.repo);
    if (!proj) {
      // 專案設定被移除、或該專案的 MCP 這次連不上（main.ts 連不上就不註冊 runtime）。
      // 兩種都代表「我們對這個群組一無所知」：不知道 repoPath 無法安全清理，
      // 更不能標 failed——failed 會讓孤兒清掃把 worktree（含未 commit 的成果）整個刪掉。
      // 因此維持原狀、只記事件，等專案回來或人來處理。
      const detail = `找不到專案 runtime：${group.repo}（MCP 連不上／專案被停用／設定被移除）。`
        + '不知道 repoPath，任何清理都可能誤刪成果，所以這次對帳完全沒有動這一群；'
        + `它停在 ${group.state} 不會被派工，而**下一次對帳＝下一次重啟 daemon**。\n`
        + `下一步：確認專案 ${group.repo} 還在、已啟用、MCP 連得上，然後按「重試」。`;
      this.stall(group, detail, 'reconcile_deferred', report);
      log.warn({ group: group.id, repo: group.repo }, '專案 runtime 不可解析，群組延後處理（不做任何破壞性動作）');
      return;
    }

    const wtPath = this.worktreePath(group);
    const [wtAlive, branchAlive] = await Promise.all([fs.dirExists(wtPath), git.branchExists(proj.repoPath, group.branch)]);
    const ahead = branchAlive ? await git.commitsAhead(proj.repoPath, group.branch, proj.baseBranch) : 0;
    const tasks = group.taskIds.map((id) => ledger.getTask(id)).filter((t): t is Task => t !== undefined);
    const doneTasks = tasks.filter((t) => t.state === 'done');
    const pendingTasks = tasks.filter((t) => t.state !== 'done');
    // commit 是唯一可靠的「成果還在」證據；worktree 目錄在不在只影響要不要 prune
    const hasCommits = branchAlive && ahead > 0;

    // 1) 全部任務都 done 且成果已 commit：崩潰在「最後一個 complete_task 之後、進 Merge Guard 之前」。
    if (hasCommits && tasks.length > 0 && pendingTasks.length === 0) {
      // ── 這裡先前寫「沒有自動續跑入口，需人工接手」，那句話已經過期 ──
      //
      // GroupRunner 對 state==='done' 的任務會直接 skipped_already_done、不重新 start_task
      //（group-runner.ts 的派工迴圈），worktree 已存在時 WorktreeManager 是沿用
      //（不重設分支、不丟 commit），openPr 也是冪等的。
      // 所以送回 ready 就會走完收尾——這是**推進**，不是丟給人。
      //
      // 而先前那條路的實際下場是：停在 forming，而 forming 既不在可復活狀態
      //（重試鈕按不動）、也不在 requeue 的任何規則裡（那些規則要求群內有 queued 任務，
      // 這裡全是 done）⇒ 每次重啟只是把同一筆事件再寫一遍。實跑停了 55 小時。
      //
      // **不刪 worktree**：崩潰點多半是「最後一個任務已 done、commitAll 還沒跑完」，
      // 裡面可能有已過 DoD 卻還沒 commit 的成果。
      const detail = `群內 ${tasks.length} 個任務皆已完成、分支 ${group.branch} 領先 ${ahead} 個 commit`
        + ' → 送回待派工做收尾（開 PR／守衛；已完成的任務不會重跑）';
      if (dryRun) {
        // 不動手的那一輪（保守開機／純診斷）：至少要讓人看得見它停在哪裡
        this.stall(group, `${detail}。這一輪沒有動手（保守開機），按「重試」就會續跑。`, 'reconcile_held', report);
        log.warn({ group: group.id, ahead }, '群組成果完整，但這一輪不動手 → 交人');
        return;
      }
      if (!wtAlive) await git.prune(proj.repoPath);
      ledger.updateGroupState(group.id, 'ready');
      ledger.consumeHandoffsFor?.({ groupId: group.id, toRole: 'human', kind: 'stuck_group' });
      ledger.logEvent('group', group.id, 'reconcile_resumed', detail);
      report.groupsRestarted += 1;
      report.actions.push({ scope: 'group', ref: group.id, decision: 'restart', detail });
      log.info({ group: group.id, ahead }, '群組成果完整 → 送回待派工做收尾');
      return;
    }

    // 2) 可續：分支上有已 commit 的成果 → 保留分支，只重建 worktree
    //    （agent session 無法跨行程續接，重建 worktree 才是乾淨起點；未 commit 的變更本來就沒過 DoD）
    if (hasCommits) {
      if (!dryRun) {
        if (wtAlive) await git.removeWorktree(proj.repoPath, wtPath);
        else await git.prune(proj.repoPath);
      }
      const requeued = this.requeueGroupTasks(tasks, report, dryRun, '群組可續，未完成任務重排');
      if (!dryRun) ledger.updateGroupState(group.id, 'ready');
      report.groupsResumed += 1;
      report.actions.push({
        scope: 'group', ref: group.id, decision: 'resume',
        detail: `分支 ${group.branch} 領先 ${ahead} 個 commit，保留分支續做（重排 ${requeued} 個任務）`,
      });
      log.info({ group: group.id, ahead, requeued }, '群組可續');
      return;
    }

    // 3) 成果遺失但已有回報 done 的任務：重做也無法再 start_task，必須讓人介入。
    //    絕不刪 worktree／分支——那可能是 agent 尚未 commit 的成果，是這裡唯一的搶救現場。
    if (doneTasks.length > 0) {
      if (!dryRun) {
        ledger.updateGroupState(group.id, 'failed');
        ledger.logEvent(
          'group', group.id, 'reconcile_unrecoverable',
          `done=${doneTasks.map((t) => t.id).join(',')} worktree=${wtAlive} branch=${branchAlive} ahead=${ahead}`,
        );
      }
      report.groupsFailed += 1;
      report.actions.push({
        scope: 'group', ref: group.id, decision: 'unrecoverable',
        detail: `已回報完成 ${doneTasks.length} 個任務，但分支成果不存在（branch=${branchAlive}, ahead=${ahead}）；`
          + `worktree${wtAlive ? '保留供人工搶救' : '已不存在'}，需人工處理`,
      });
      log.error({ group: group.id, done: doneTasks.map((t) => t.id), wtPath }, '群組成果遺失，標記 failed（現場保留）');
      return;
    }

    // 4) 沒有任何 commit、也沒有已完成任務 → 清乾淨重做。
    //    但這一步會刪掉 worktree 裡未 commit 的東西：MCP 證據暫時拿不到時（可能有任務其實已 done）
    //    先延後，等下次對帳資訊齊全再決定。沒設定 MCP 的部署不受影響（degraded=false）。
    // **上次是被停止而中斷的，一律不清理。** agent 做到一半被 SIGTERM 打斷，
    // 成果就在 worktree 裡而且還沒 commit——「沒有 commit」在這個情境下代表
    // 「工作還在進行中」，不是「什麼都沒做」。清掉等於每次重啟都把進行中的工作丟掉。
    if (wtAlive && ledger.latestEvent?.('group', group.id, GROUP_ABORTED_EVENT)) {
      const requeued = this.requeueGroupTasks(tasks, report, dryRun, '上次被停止而中斷，接回去重跑');
      if (!dryRun) ledger.updateGroupState(group.id, 'ready');
      report.groupsRestarted += 1;
      report.actions.push({
        scope: 'group', ref: group.id, decision: 'restart',
        detail: `上次因 daemon 停止而中斷 → 保留 worktree 直接接回去（重排 ${requeued} 個任務）`,
      });
      log.info({ group: group.id }, '上次被停止而中斷 → 保留現場接回去跑（不清理）');
      return;
    }

    if (evidence.degraded && wtAlive) {
      const detail = `證據不完整（${evidence.detail}）：不敢清理 worktree，這一群這一輪完全沒動。`
        + '而「下次對帳」＝下次重啟 daemon，不是幾分鐘後。\n'
        + '下一步：確認任務板（MCP）連得上，再按「重試」讓它重跑。';
      this.stall(group, detail, 'reconcile_deferred', report);
      log.warn({ group: group.id }, 'MCP 證據不足，群組延後處理（保留 worktree）');
      return;
    }

    if (!dryRun) {
      if (wtAlive) await git.removeWorktree(proj.repoPath, wtPath);
      else await git.prune(proj.repoPath);
      // 只有確定分支上沒有任何 commit 才刪分支（hasCommits === false 已保證）
      if (branchAlive) await git.deleteBranch(proj.repoPath, group.branch);
    }
    const requeued = this.requeueGroupTasks(tasks, report, dryRun, '群組重做');
    if (!dryRun) ledger.updateGroupState(group.id, 'ready');
    report.groupsRestarted += 1;
    report.actions.push({
      scope: 'group', ref: group.id, decision: 'restart',
      detail: `worktree=${wtAlive}, branch=${branchAlive}, ahead=${ahead} → 清理後重做（重排 ${requeued} 個任務）`,
    });
    log.warn({ group: group.id, wtAlive, branchAlive, ahead }, '群組狀態不明，清理重做');
  }

  /** 把群內非 done 的任務推回 queued；done 的保留（MCP 那邊已完成，不可重做）。 */
  private requeueGroupTasks(tasks: Task[], report: ReconcileReport, dryRun: boolean, reason: string): number {
    let n = 0;
    for (const t of tasks) {
      if (t.state === 'done' || t.state === 'queued') continue;
      // blocked:needs_clarification 是等人回答，不是崩潰殘留，保持原狀
      if (t.state === 'blocked' && t.block?.reason !== 'deps') continue;
      if (!dryRun) this.deps.ledger.updateTaskState(t.id, 'queued', { lastError: reason });
      report.tasksRequeued += 1;
      report.actions.push({ scope: 'task', ref: t.id, decision: 'requeued', detail: reason });
      n += 1;
    }
    return n;
  }

  /**
   * 中間態但沒有「正在跑的群組」的任務：沒有 runner 會撿它，推回 queued。
   * 只跳過 forming 群組的任務（那些已由 reconcileRunningGroup 決定去留）；
   * 後段狀態（pr_open…）的殘留中間態任務屬於資料不一致，收斂回 queued 較安全。
   */
  private requeueStrayTasks(report: ReconcileReport, dryRun: boolean): void {
    const { ledger } = this.deps;
    for (const state of TASK_LIMBO) {
      for (const t of ledger.listTasksByState(state)) {
        const group = t.groupId ? ledger.getGroup(t.groupId) : undefined;
        if (group && GROUP_RUNNING.includes(group.state)) continue; // 已由 reconcileRunningGroup 處理
        if (!dryRun) ledger.updateTaskState(t.id, 'queued', { lastError: '崩潰殘留：無進行中的群組' });
        report.tasksRequeued += 1;
        report.actions.push({ scope: 'task', ref: t.id, decision: 'requeued', detail: '崩潰殘留：無進行中的群組' });
      }
    }
  }

  /**
   * 清 worktree 目錄。分三類：
   *   a. 非終態群組（含被延後處理的）、以及本輪對帳處理過的群組 → 一律保留，絕不碰。
   *   b. 終態群組（merged/failed）→ 保留 terminalWorktreeDays 天供診斷，逾期才清。
   *   c. ledger 完全查無對應群組 → 真孤兒，直接清
   *      （worktree 一定在群組寫入 ledger 之後才建立，所以「查無群組」不會是進行中的工作）。
   */
  private async sweepOrphanWorktrees(report: ReconcileReport, dryRun: boolean, touched: ReadonlySet<string>): Promise<void> {
    const { ledger, fs, log } = this.deps;
    const dirs = await fs.listDirs(this.deps.worktreeBase);
    if (dirs.length === 0) return;

    const alive = new Set<string>(touched);
    for (const state of GROUP_ALIVE) {
      for (const g of ledger.listGroupsByState(state)) alive.add(this.worktreePath(g));
    }
    const terminal = new Map<string, Group>();
    for (const state of GROUP_TERMINAL) {
      for (const g of ledger.listGroupsByState(state)) terminal.set(this.worktreePath(g), g);
    }

    const cutoff = this.now() - this.retention.terminalWorktreeDays * DAY_MS;
    let removed = 0;
    for (const dir of dirs) {
      if (alive.has(dir)) continue;

      const owner = terminal.get(dir);
      if (owner) {
        // 終態群組的現場：更新時間或目錄時間任一還新，就再留一陣子
        const mtime = await fs.dirMtimeMs(dir);
        const last = Math.max(owner.updatedAt, mtime ?? 0);
        if (last > cutoff) {
          report.worktreesRetained += 1;
          report.actions.push({
            scope: 'worktree', ref: dir, decision: 'skipped',
            detail: `群組 ${owner.id}（${owner.state}）仍在 ${this.retention.terminalWorktreeDays} 天保留期內，保留現場`,
          });
          continue;
        }
      }

      if (!dryRun) await fs.removeDir(dir);
      removed += 1;
      report.orphanWorktreesRemoved += 1;
      report.actions.push({
        scope: 'worktree', ref: dir, decision: 'orphan_removed',
        detail: owner ? `群組 ${owner.id}（${owner.state}）已逾保留期` : 'ledger 無對應群組',
      });
      log.warn({ dir, group: owner?.id }, '清除 worktree');
    }

    // 目錄被直接刪掉，git 那邊還留著登記，逐一 prune 才不會擋住之後的 worktree add
    if (removed > 0 && !dryRun) {
      for (const repoPath of this.deps.knownRepoPaths?.() ?? []) {
        await this.deps.git.prune(repoPath).catch((e) => log.warn({ repoPath, err: String(e) }, 'prune 失敗'));
      }
    }
  }

  /**
   * 保留策略：截圖 / 稽核事件 / 迭代紀錄。
   * 全部只清「明確可判定為過期且非進行中」的東西；任何判不準的一律留著。
   * dryRun 不執行（刪除筆數要真的下手才知道，硬猜反而誤導）。
   */
  private async applyRetention(report: ReconcileReport, dryRun: boolean): Promise<void> {
    if (dryRun) return;
    const { ledger, log } = this.deps;
    const now = this.now();

    await this.pruneScreenshots(report, now);

    if (ledger.pruneEvents) {
      const n = ledger.pruneEvents(now - this.retention.eventDays * DAY_MS);
      if (n > 0) {
        report.eventsPruned = n;
        report.actions.push({ scope: 'retention', ref: 'events', decision: 'pruned', detail: `清除 ${n} 筆逾 ${this.retention.eventDays} 天的稽核事件` });
      }
    }
    if (ledger.pruneToolCalls) {
      const n = ledger.pruneToolCalls(now - this.retention.toolCallDays * DAY_MS);
      if (n > 0) {
        report.actions.push({ scope: 'retention', ref: 'tool_calls', decision: 'pruned', detail: `清除 ${n} 筆逾 ${this.retention.toolCallDays} 天的工具紀錄` });
      }
    }
    // task_iterations 的保留策略隨整張表一起退場（第 15 片）。
    if (!ledger.pruneEvents) {
      log.debug('ledger 未提供 prune 能力，略過 events 保留策略');
    }
  }

  /** 目錄結構為 <root>/<taskId>/…（見 agent-runtime 的 scratchDirFor）。 */
  private async pruneScreenshots(report: ReconcileReport, now: number): Promise<void> {
    const root = this.deps.screenshotRoot;
    if (!root) return;
    const { ledger, fs, log } = this.deps;
    const cutoff = now - this.retention.screenshotDays * DAY_MS;

    for (const dir of await fs.listDirs(root)) {
      const task = ledger.getTask(basename(dir));
      // 任務還沒 done → 截圖可能還要進 PR 內文/Slack，不清
      if (task && task.state !== 'done') continue;
      const mtime = await fs.dirMtimeMs(dir);
      if (mtime === undefined || mtime > cutoff) continue; // 判不準就留著
      await fs.removeDir(dir);
      report.screenshotDirsRemoved += 1;
      report.actions.push({
        scope: 'retention', ref: dir, decision: 'pruned',
        detail: `截圖逾 ${this.retention.screenshotDays} 天${task ? '（任務已完成）' : '（ledger 查無此任務）'}`,
      });
      log.info({ dir }, '清除逾期截圖');
    }
  }

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  private worktreePath(group: Group): string {
    if (this.deps.worktreePathFor) return this.deps.worktreePathFor(group);
    return join(resolve(this.deps.worktreeBase), worktreeDirName(group.branch));
  }
}
