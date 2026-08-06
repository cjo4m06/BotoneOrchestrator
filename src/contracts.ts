// 服務契約（行為介面）——讓 Worker 等模組以介面相依，便於注入假件測試、
// 也讓 MCP/Slack 具體實作可延後（等你的回應格式）。對映 DESIGN.md §12。

import type { McpOut, TaskBrief, TaskDetail, LifecycleEvent, GateReport, DocType } from './types.js';
import type { IterateInput, IterateResult, LoadedDoc } from './worker/agent-runtime.js';
import type { VerifierConfig } from './worker/verifier.js';
import type { ReviewOutcome } from './worker/reviewer.js';

/** Poller 需要的 MCP 讀取子集。 */
export interface McpReadClient {
  listTasks(q: { repo?: string; mine?: boolean; status?: 'todo' | 'in_progress' | 'done'; assigneeId?: string }): Promise<TaskBrief[]>;
  getTask(id: string): Promise<TaskDetail>;
}

/**
 * Worker 需要的 MCP 子集。
 *
 * **繼承 McpReadClient 是必要的，不是順手。** Worker 在認領被拒時要用 `getTask`
 * 查任務板現況，才分得出「這張卡本來就是我們認領的」與「它已經是別人的」——
 * 而那個判斷寫錯的後果是兩個人做同一張卡。設成可選的話漏接不會有任何症狀。
 */
export interface McpTaskClient extends McpReadClient {
  startTask(id: string): Promise<McpOut<TaskDetail>>;
  completeTask(id: string, opts?: { summary?: string }): Promise<McpOut<void>>;
  /** 依 docRefs（"path#section"）載入規格內容。 */
  loadDocs(refs: string[]): Promise<LoadedDoc[]>;
  /**
   * 文件查找工具，會被掛給 agent 自己用（見 worker/docs-server.ts）。
   * 可選：沒有這些能力的任務板照樣能跑，只是 agent 少了「規格讀不到時自己找」的路。
   */
  listDocs?(): Promise<string>;
  searchDocs?(query: string): Promise<string>;
  readDoc?(docType: DocType, fileName: string, section?: string): Promise<string>;
}


/** AgentRuntime 的結構介面（供注入假件）。 */
export interface AgentLike {
  iterate(input: IterateInput): Promise<IterateResult>;
}

/** Verifier 的結構介面（供注入假件）。 */
export interface VerifierLike {
  // task 為可選提示：視覺關卡靠它做類別篩選與截圖分目錄；不帶則視為「需要驗」。
  check(input: { cwd: string; config: VerifierConfig; signal?: AbortSignal }): Promise<GateReport>;
}

/**
 * 獨立 reviewer 的結構介面（供注入假件）。對映 DESIGN.md §5：DoD 綠燈後，
 * 用全新 context 拿 docRefs 規格對 diff 審查。Worker 以**可選**依賴持有它——
 * 沒注入就跳過審查，維持 M1/M2 既有行為。
 */
export interface ReviewerLike {
  check(
    task: TaskDetail,
    docs: LoadedDoc[],
    cwd: string,
    opts: {
      /**
       * 比較基準＝**本任務開始時的 HEAD sha**，與 DoD「diff 非空」關卡同一枚。
       * `undefined` ＝ 取不到基準 → reviewer 回 skipped（不是判「沒有實作」）。
       *
       * **必填鍵、可為 undefined**（不是 optional key）：optional 的話漏傳照樣編得過，
       * 而漏傳正是這個 bug 的成因——reviewer 退回預設的 `'HEAD'`，
       * agent 一 commit 就被判成「看不到任何實作」。
       */
      baseRef: string | undefined;
      /**
       * 人已經拍板的決定。規格上懸而未決的地方，reviewer 需要知道它已經有答案了，
       * 否則會把一個解決過的問題重新提出來退回（實跑撞到，白費一輪）。
       */
      decisions?: { question: string; answer: string }[];
      /**
       * 續接同一群的審查 session（群內同階段共用一條線）。
       * 與 coder 的 session 始終隔離——審查者不能繼承寫程式的人的想法。
       */
      resumeSessionId?: string;
      /** 所屬群組。 */
      groupId?: string;
    },
  ): Promise<ReviewOutcome>;
}

/** 通知抽象。M1–M3 用 ConsoleNotifier；M4 換 SlackNotifier（Socket Mode）。 */
export interface Notifier {
  event(threadTs: string | undefined, event: LifecycleEvent, task: TaskDetail): Promise<void> | void;
  /**
   * 系統層通知（不屬於任何單一任務）：待處理事項提醒、花費上限告警之類。
   *
   * 刻意獨立成一個方法而不是重用 `event`：`event` 需要一個 TaskDetail 來決定要貼到
   * 哪條 thread，系統層訊息沒有那個東西。硬塞 undefined 進去會在 `task.id` 炸掉——
   * 而且因為 event 是 async，同步的 try/catch 接不到，會變成 unhandled rejection
   * 直接殺掉整個 daemon（實跑撞過）。
   */
  notice?(text: string): Promise<void> | void;
  /**
   * 更新任務卡的狀態。
   *
   * 沒有這個，卡片會永遠停在剛貼出去的樣子——任務做完了、PR 開了、在等人核准，
   * 卡片上還是同樣三顆按鈕，人看不出它在等自己。可選是因為並非所有介面都有
   * 「可更新的訊息」這個概念（console 就沒有）。
   */
  updateTaskCard?(taskId: string, status: TaskCardStatus, extra?: TaskCardExtra): Promise<void> | void;
}

/**
 * 更新卡片時的附加資訊。
 *
 * 為什麼需要：**所有操作都要在卡片上**，而澄清的選項按鈕、「不用做」的確認按鈕
 * 都需要當下的內容（問題是什麼、有哪些選項）。沒有這些，那些操作就只能留在
 * thread 的獨立訊息上——而 thread 是收合的，人根本看不到有事要處理。
 */
export interface TaskCardExtra {
  groupId?: string;
  /** 要顯示在卡片上的問題／理由（澄清問題、無需改動的依據）。 */
  prompt?: string;
  /** 澄清的選項（會變成卡片上的按鈕）。 */
  options?: string[];
  /**
   * 進度：現在第幾輪、已經跑多久、上一輪的結果。
   *
   * 沒有這些，卡片就只在「執行中／驗證中／審查中」之間跳，人分不出它是在做事還是死了。
   * 實跑時一個任務跑了 17 分鐘，thread 一則訊息都沒有、卡片也看不出輪數——
   * 那段時間裡「正常」與「卡住」在畫面上長得一模一樣。
   */
  progress?: TaskCardProgress;
}

export interface TaskCardProgress {
  /** 目前第幾輪（1 起算）。 */
  round?: number;
  /** 這個任務從開工到現在的毫秒數。 */
  elapsedMs?: number;
  /** 上一輪發生什麼（關卡結果摘要、reviewer 退回理由…）。 */
  lastOutcome?: string;
  /** 工作區目前改了幾個檔案。 */
  changedFiles?: number;
}

/** 任務卡狀態（定義在 slack/blocks.ts，這裡只引用型別，避免 contracts 依賴 Slack）。 */
export type TaskCardStatus =
  | 'working' | 'verifying' | 'reviewing' | 'awaiting_reply' | 'awaiting_human'
  // 等上游任務完成——不需要人動手，必須跟「等你處理」分開，否則人會去看一張其實不用他管的卡
  | 'blocked_deps'
  | 'pr_open' | 'awaiting_merge'
  // 人按下裁決之後的即時回饋。沒有這兩個狀態，按鈕會一直留在卡片上，
  // 人不知道有沒有按到，於是重複點——重複核准會重複寫憑證、重複觸發把關。
  | 'merge_checking' | 'reworking'
  // 「這張卡不用做」等人確認：與一般的 awaiting_human 按鈕完全不同，必須分開
  | 'awaiting_no_change'
  | 'merged' | 'done' | 'failed';
