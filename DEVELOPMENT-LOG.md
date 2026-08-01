# 開發歷程（2026-07-29 ～ 2026-08-01）

> 原本的 git 歷史（101 個 commit）因為早期誤把控制台截圖與 Playwright 快照提交進去、
> 其中含有憑證明文，整份歷史已銷毀重建。這裡保留 commit 訊息作為紀錄——
> 每一則都寫了「為什麼」與實跑撞到什麼，那是這個系統多數設計決定的由來。

---

## chore: 初始化專案骨架與設計文件 (M0)

- DESIGN.md：定稿設計（決策記錄、狀態機、模組契約、SDK 串接、路線圖）
- 型別契約 (src/types.ts)、config 載入 (zod)、SQLite ledger、pino logger
- 可 build / typecheck 通過、M0 進入點可執行並初始化 ledger
- launchd plist、config 範例、README




---

## feat: git worktree 管理器與無進展偵測器 (M1/M2)

- WorktreeManager：每群一分支一 worktree 的建立/掛載/列出/移除（隔離並行）
- ProgressMonitor：結果簽章連續 N 輪相同且未綠 → 卡牆（只回報不中止）
- 皆對真實 git repo / 真實 ledger 驗證通過（create/branch/remove、卡牆/綠燈豁免）




---

## feat: Verifier（DoD 關卡）與 git 變更指紋 + 測試專案產生器

- Verifier：實跑專案 typecheck/lint/build/test 判定完成（非信任 agent 自稱），
  計算穩定「結果簽章」（正規化掉耗時等雜訊）供無進展偵測
- git/status：gitDiffHash（工作區指紋）、workingTreeChanged（diff 非空 DoD）
- scripts/make-fixture.sh：產生 throwaway 測試專案（獨立 git repo）
- 對 fixture 驗證：綠燈/紅燈/failingIds 抽取/簽章穩定/復原 皆通過




---

## feat: AgentRuntime — Claude Agent SDK 串接 (M1/M2)

- query() 串接：cwd/resume(session)/permissionMode/mcpServers/hooks，迭代訊息取 sessionId 與結果
- ask_human 自訂 in-process 工具（M1–3 暫用「合理預設+記錄假設」不阻塞策略，M4 接 Slack）
- PreToolUse 政策閘門（紅線 deny-list：強制推送/絕對路徑 rm -rf/hard reset 遠端）
- 純函式 buildAgentPrompt / evaluateToolPolicy 抽出，無金鑰單元驗證通過
- query 串接對真實 SDK 型別 typecheck 通過（zod 升級 v4 以符 SDK peer）




---

## feat: Worker 監督迴圈 — M2 監督閉環核心

- Worker.runTask：start_task → 讀 docRefs → (agent 迭代 → DoD 驗證 → 回饋回灌)迴圈 → complete_task
- 依賴注入設計（McpTaskClient/AgentLike/VerifierLike/Notifier 契約），可用假件單元驗證
- 澄清 park、無進展只通知不中止、bug 類帶 summary、依賴 signal → blocked:deps
- ConsoleNotifier（M4 換 SlackNotifier）+ 事件中文摘要
- 五情境以假件驗證通過：happy/clarification/stall/bug-summary/deps-signal
- 不設 turn/token 上限；完成 = DoD 綠燈而非 agent 自稱




---

## feat: Claude 認證改走 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL

- 新增 .env 載入（dotenv, quiet）：loadEnv() 解析認證方式並注入 process.env
- SDK 子行程繼承 process.env → AUTH_TOKEN(Bearer)/BASE_URL(自訂端點)生效，無需改 query()
- main 啟動時載入 .env 並偵測/警告認證缺失
- .env.example（gitignore 放行）、DESIGN/README 更新
- .env 載入 plumbing 驗證通過（auth_token/none 兩情境）




---

## feat: 主幹端到端 harness（e2e-trunk）+ --dry 全綠

- scripts/e2e-trunk.ts：mock MCP → worktree → agent → 真 Verifier(npm test) → complete_task
- --dry（假 agent 真寫檔）驗證整條主幹接線，無需 token；live 模式用真 AgentRuntime
- --dry 端到端通過：outcome=done、complete_task 1 次、subtract.js 產生、ledger done
- live 無 token 時優雅拒絕（exit 2），不空轉




---

## docs: 主幹 live 端到端驗證通過（真 agent 對 fixture 編程 → done）




---

## feat: PR 內文產生器（需求 5）

- generatePrBody：做了什麼/怎麼做/架構/畫面(含截圖)/操作/核心技術/驗證/假設/涵蓋任務 九段
- 敘事段落由 agent 總結填入，機器事實（tasks/diff/驗證/截圖/分群理由）由調度器補上
- 未提供段落標「（待補）」；截圖以 markdown 圖片嵌入
- 九段齊全與各欄位渲染 單元驗證通過




---

## feat: 真 MCP client（pmm, Streamable HTTP）+ 探索工具

- PmmMcpClient：對映真實回應（list_repos.rows / list_tasks.tasks / get_task.description,depIdList,docRefsList）
- 帶內錯誤解析：payload { ok:false, error, code }；start_task 失敗 → signal（依賴/認領受阻）
- loadDocs：解析 "spec/x.md#section" → read_doc({docType,fileName,section})
- 傳輸例外三分類（401/403 permanent，其餘 transient）
- scripts/explore-mcp.ts：唯讀探索工具（密鑰讀 env）
- 對真實 pmm 伺服器驗證通過：listRepos/listTasks/getTask/loadDocs/startTask-signal




---

## feat: Poller — 輪詢 MCP + 去重落地 (M1)

- Poller.pollOnce：listTasks(todo) → getTask 取詳情 → payloadHash 去重 → 落地 ledger discovered
- 只回傳新任務；MCP 重複派發靠 id+payloadHash 擋掉
- McpReadClient 契約
- 對真實 pmm 伺服器驗證：首輪發現 4 筆 todo、次輪去重 0 筆、in_progress 任務正確排除




---

## feat: 政策紅線加入部署防護

- 擋 firebase deploy / npm|yarn|pnpm run deploy / vercel|netlify|wrangler deploy
- 擋強制推送 main/master
- 因應 Baolu 綁 Firebase 部署，防 agent 誤觸實際部署
- deny-list 驗證通過




---

## feat: Planner — 內容感知分群 + 依賴拓樸排序 (M3)

- 啟發式分群（union-find）：依賴 ∪ 共用 docRef 檔案 ∪ 關鍵字相似 → 連通分量成群
- 群內以 dependencies 拓樸排序（Kahn）；跨群依賴轉群間序列邊
- dependencies 只當提示；正確性由 Merge Guard 兜底（D9）
- v1 未做 codebase 檔案足跡掃描（footprint 以 docRef 檔案代理），標為後續強化
- 對真實 Baolu DAG 驗證：5 個 sandbox 任務歸一群、route→counter→button 排序正確




---

## feat: Merge Guard — rebase + 重測 + 語意飄移偵測 (M5, 需求 7)

- attempt：checkout 分支 → rebase base（衝突→code_conflict）→ 合併後狀態重跑 DoD（紅→semantic_drift）
- postMergeCheck：合併後對 base 重測（紅→post_merge_red，供自動 revert）
- 本地三情境驗證：乾淨合併 ok / 語意飄移(依賴被刪無衝突→擋) / 同行 CODE 衝突→擋




---

## feat: PR Manager（gh CLI）

- ensureBranch/commitAll（本地）、openPr（push + gh pr create，外部動作，預設 draft）
- 合併週期的本地驗證不需外部步驟；openPr 供真實開 PR 用




---

## feat: 完整週期 e2e harness（沙盒 live 驗證含合併）

- scripts/e2e-full.ts：真 spec → 真 agent 編程 → build → Merge Guard → 本地合併 → 合併後 build → PR 內文
- board-safe MCP 樁（保護任務板）；loadDocs 為真實；全程本地無 push/deploy
- live 驗證通過：agent 建立 /sandbox 路由（沿用專案 Tailwind 設計 token、遵守 DoD），
  build 綠 → Merge Guard 通過 → 合併 → 合併後 build 綠
- README 里程碑更新（M1 完成、M3/M5 部分完成）




---

## feat: 常駐主控迴圈 daemon (M6) — poll→plan→dispatch→GroupRunner

- Orchestrator：tick(poll→plan 建群→dispatch) + run(依 interval 常駐, AbortSignal 優雅停止)
- Dispatcher：併發上限 + 同 repo 足跡重疊序列化（群間並行安全）
- GroupRunner：群內逐任務 Worker→提交→Merge Guard；外部 PR/合併預設關閉(openPr)保安全
- main.ts：config 驅動連 MCP，組裝全鏈路，--once 除錯、SIGINT/SIGTERM 優雅停止
- ledger.createGroup(冪等)/listGroupsByState；config 加 mcp.token
- Planner 修正：稀疏文字不套關鍵字相似（避免過度合併）
- 驗證：主控迴圈假件(建群/併發/足跡序列化) + 對真實 pmm 一輪 tick(poll→plan→建群，未派工)




---

## fix: live daemon run 發現的兩個修正

- config：stripNulls — 環境變數缺值時 `key: ${MISSING}` 會被 YAML 解析成 null，
  導致 optional string 欄位驗證失敗；解析後遞迴去除 null（視為未設）
- commitAll：排除 node_modules — worktree 的 node_modules 為 symlink，
  而 .gitignore `node_modules/`(尾斜線)只比對目錄不比對 symlink → 誤 commit 依賴；
  改用 pathspec 排除，並讓 agent 已自行 commit 時 no-op（同時解決雙 commit）
- 均以本地情境驗證




---

## feat: Phase 1 — 測試套件、視覺驗證、韌性、reviewer、政策、Slack

六個模組並行實作（447 個測試全綠、src+test typecheck 綠）：

- 測試套件（首次）：node:test + tsx，test/helpers（暫存 ledger/git repo/靜音 logger/工廠），
  13 個測試檔涵蓋 ledger/config/planner/progress/pr-body/agent-runtime/worker/verifier/
  dispatcher/orchestrator/merge-guard/poller/mcp-client
- 視覺驗證（需求 6）：src/worker/{visual,layout-audit}.ts — 多斷點截圖、爆版/文字裁切/
  重疊/零尺寸/遮蔽/基線歪斜/間距不一致偵測、像素級視覺回歸（自寫 PNG 解碼，無新影像庫）、
  環境缺件優雅降級。已用真實 Chrome 端到端驗證（broken.html 8 類問題全抓、good.html 零誤報）
- 韌性：src/core/{retry,reconciler}.ts — 三分類重試/退避/熔斷（假時鐘可測）、崩潰對帳恢復
- 智慧與治理：src/worker/reviewer.ts（獨立 context 規格審查）、agent-runtime Stop hook
  （防「沒做事就收工」，有活鎖保護）、src/policy/policy-engine.ts、src/worker/footprint.ts
- Slack：src/slack/{gateway,blocks}.ts — Socket Mode、任務卡 thread、澄清/核准按鈕、
  截圖上傳、噪音節流、未設定時降級為 ConsoleGateway

修正（來自 agents 誠實回報）：
- 【嚴重】merge-guard checkout 失敗未檢查 → 會在錯誤分支上 rebase+驗證並回綠燈，
  等於替從未檢出的分支背書。新增 MergeVerdict reason 'precondition_failed' 並於
  attempt/postMergeCheck 檢查 exitCode
- ConsoleGateway 的 onAnswer/onControl/onMergeDecision 補上 callback 參數以符介面




---

## feat: Phase 2 — 整合新模組進主鏈路 + 缺口修補（667 測試全綠）

七項並行整合：
- 視覺驗證接進 DoD：VerifierConfig.visual、Verifier 併入視覺 checks/screenshots、
  重算 green 與穩定 signature（只吃穩定 failingIds）、截圖強制落 worktree 外避免污染 diff、
  decideVisualGate 純函式決定何時啟瀏覽器（預設只對 design 類）
- Reviewer 接進 Worker：DoD 綠 → 獨立 context 規格審查 → 不合格回灌續做；
  防活鎖（累計否決上限後放行交人工）、否決簽章納入無進展偵測、無金鑰降級 skipped
- GroupRunner：政策閘門（needs_human 不自動合併）、SummaryRecorder 側錄 agent 總結餵 PR 敘事、
  本地合併+postMergeCheck+紅燈自動 revert（allowLocalMerge 預設關）、worktree 清理
- daemon 主線：Slack createNotifier（降級 ConsoleGateway）、開機崩潰對帳、
  MCP withRetry+CircuitBreaker（三分類語意不變）、InboundRouter 入站落 ledger
- Planner：Intl.Segmenter 中文斷詞（原本整串 CJK 是單一 token，中文任務相似度完全失效）、
  真實檔案足跡取代 docRef 代理、足跡重疊產生 file-overlap 排程邊
- ReviewWatcher（新）：gh 查 PR review → ReviewEvent，events 表去重、gh 不可用降級、只讀不寫
- 政策紅線擴充到 Write/Edit（保護 CI 設定/部署設定/secrets/.git），PolicyEngine 補 lockfile 等規則

協調者收尾接線：VerifierLike 契約加 task hint、Worker 傳 task、GroupRunner 傳 reviewer、
main 接 visual 設定/reviewer/allowLocalMerge/planner 足跡/ReviewWatcher、Orchestrator tick 加審查監看

冒煙驗證：daemon --once 對真實 MCP 跑通（認證→連線→登錄→對帳），
reconciler 正確清孤兒 worktree 但保留成果分支




---

## fix: Phase 4 — 修復審查確認的 57 個缺陷（995 測試全綠）

五個 critical：
- DoD 補「diff 非空」關卡：以「本任務開始時的 HEAD」為基準（群內多任務共用 worktree，
  不能用群分支起點），涵蓋未追蹤檔、排除 node_modules、failingIds 固定以維持簽章穩定；
  零變更短路跳過昂貴指令並回灌「尚未實作」
- 本地合併保護真實 clone：工作區非空一律拒絕合併、記錄並於 finally 切回原分支、
  reset --hard fallback 加雙重前提（工作區乾淨 + HEAD===mergeCommit）否則交人工
- 主 clone 互斥鎖 withRepoLock：涵蓋 status→checkout→merge→postMergeCheck→revert 整段；
  不再事後 rev-parse 認定 merge commit，改驗 HEAD^1===before

需求 7 接通（原本整段斷鏈）：
- approved → 重跑 Merge Guard（含 fetch）→ 政策閘門 → 需 approvedBy 憑證才合併
- changes_requested → 意見存入共用 ReviewFeedbackStore → requeue 回 ready 重新派工
- Orchestrator tick 新增 requeue 與 merge 階段；釐清 merge_guard 的兩種語意
  （暫態 vs 待合併，靠 dispatcher.isRunning 區分），無核准憑證一律不合併

Merge Guard 不再對過期 base 驗證：fetch 最新 base，離線/無 remote 時降級為
「有但書的綠燈」（BaseFreshness caveat 帶進報告）

其他：紅線強化（rename 繞過、yarn/pnpm/run-script deploy、指令串接拆解、保護目錄）、
Reconciler 涵蓋所有非終態且證據不足時不做破壞性決策、無進展偵測改用本次執行視窗、
agent isError 指數退避（不設上限，連續 N 次升級通知）、指令執行逾時、
node_modules 改 APFS clonefile 避免污染真實 clone、Slack 任務卡貼出使入站可達、
截圖進 PR、單一實例鎖、優雅停止等待 in-flight、stdio MCP 支援、
collectLayoutMetrics 補真實瀏覽器測試




---

## feat: report_no_change — 合法零 diff 的出口（1001 測試全綠）

問題：Phase 4 的「diff 非空」DoD 關卡會誤殺合法的零 diff（功能已存在、任務描述與現況
不符、缺外部依賴），把 agent 逼到「為了讓驗證通過而亂改程式碼」——比漏抓更糟。

解法：不靠猜「為什麼沒 diff」，給 agent 明示出口。
- report_no_change(category, reason, evidence) in-process MCP 工具，四種分類
- 判定優先序：有 diff → 宣告作廢照常驗證；零 diff + 宣告 → 依政策；零 diff 無宣告 → 回灌續做
- 預設一律 park 等人確認（blocked:needs_human，走 GroupRunner 既有的可恢復路徑），
  不自動 complete_task：done 不可逆，且「這張卡不用做」通常是任務板有問題的訊號
- 政策可由 orchestrator.yaml 的 noChange 覆寫（ask | auto_complete，逐分類設定）
- Stop hook 把宣告列為正當收工理由，避免 agent 被 Stop hook 與 DoD 兩頭夾殺
- agent prompt 明講此出口存在並強調「不要為了通過驗證而亂改」
- 宣告內容落 ledger events 供稽核
- DESIGN §7b 記錄此決策

測試：6 個新案例（park 不 complete / 宣告作廢 / auto_complete / 分類未列入仍要人 /
無基準保守處理 / 稽核落地），已驗證還原修復後會變紅（4 條）




---

## fix: Phase 5 — 修復恢復路徑斷點與接線缺口（1092 測試全綠）

兩個 CRITICAL（Phase 4 的修復本身留下的斷點）：
- worktree.create() 改為冪等：park 的群保留 worktree，重新派工時原本會因目錄已存在而擲錯
  → 被例外收斂標 failed → 恢復路徑實際上是斷的。改為「已登記且分支相符即沿用」，
  分支不符/非本 repo 的 worktree 一律擲錯且絕不自動刪（裡面可能有未提交成果）；
  路徑比對走 realpath（macOS /var 與 /private/var 差異會讓沿用永遠比對不到）
- GroupRunner 跳過已 done 的任務：requeue/rework 路徑上原本會對已完成任務再跑 worker.runTask
  → start_task 被 MCP 拒絕 → 群組 failed（且 Worker 會無限退避重試）

需求 7 的合併閉環真正接線（此前功能都在但 main.ts 沒接＝等於不存在）：
- 唯一的 ReviewFeedbackStore 實例同時注入 ReviewWatcher / Orchestrator / GroupRunner
- rework 模式：群組帶 feedback 被重新派工時，把 reviewer 意見注入 agent 的回灌管道；
  群內任務全 done 時走 reworkDoneTasks（不重複 start/complete_task）
- 合併管線用 `git worktree add --detach` 的專用 worktree，Merge Guard 的 checkout
  永遠不會動到使用者主 clone；openPr 與 allowLocalMerge 皆開才接線（預設全關）

其他：Merge Guard 的 base 新鮮度但書寫進 ledger/Slack/PR（假綠燈變成有但書的綠燈）、
ledger 補 events 讀取 API（審查意見跨重啟）與保留策略（只刪已收攤的）、
更新類方法統一為 false+warn 而非擲錯（避免過期 Slack 回呼打掛 daemon）、
視覺關卡區分「環境缺件→跳過」與「執行期例外→判紅+通知」（D19）、
Verifier 執行 npm script 前先解析 package.json 過紅線（擋既有的 deploy script）、
orchestrator sleep 可被 abort 中斷、指令逾時可設定、PR 截圖改為文字清單（不產生壞圖連結）

DESIGN.md 補 D15–D19 與 §4b 群組狀態語意表，並更新 §5/§6/§9 為實作後的真實樣貌




---

## docs: README 更新為實際現況（能力表、安全預設、e2e harness）




---

## fix: Phase 7 — 修復實跑診斷出的 5 個 critical（1228 測試全綠）

視覺誤殺率 56% → 0%（實跑 18 個正常頁面 × 3 斷點全綠，6 個真爆版頁面仍全數判紅）：
- element-overflow：祖先 overflow-x 非 visible → 內容根本畫不到 viewport 外，不算溢出
- text-clip：排除 text-overflow:ellipsis 與 -webkit-line-clamp（刻意截斷）
- overlap/obscured：改看「最近的刻意疊放祖先」而非元素自身 position；
  全螢幕遮罩與 fixed/sticky 浮層視為 modal backdrop/tab bar，不判紅；重疊門檻 0.1→0.5
- alignment/spacing 降級為 advisory（風格判斷不該擋 DoD，可用 strictStyleChecks 開啟）
- 量測前等動畫穩定（getAnimations 輪詢）+ 進行中動畫的元素排除
- 新增專案級 ignoreSelectors（不必改被驗專案的原始碼就能豁免）

failingId 穩定化：改用「最近具名祖先 + 語意標籤路徑」，不含 class 與同層序號。
原本改個 class 名簽章就變 → 無進展偵測在最該觸發時永不觸發（實測 4 次改動 4 個簽章）。

無限迴圈修復：
- startTask 不再把所有 MCP 錯誤當 signal：只有明確的依賴訊息才 signal，其餘 permanent
  （原本「已被認領/已完成/指派他人」都會無聲重試；崩潰恢復會變永久空轉）
- 監督迴圈加 maxRounds 兜底（預設 20，park 交人而非 failed，可設 0 停用）。
  還原此修復後測試會無限迴圈到需要 kill -9——正是「無聲無限迴圈」的實證
- deps 受阻改走統一 requeue 通道 + 指數退避（原本每 tick 重建 worktree、複製 node_modules）
- 連續受阻升級交人需「次數 + 持續時間」同時成立（只看次數會誤殺正常的上游等待）

其他：requeue 耗盡改為寫事件 + 通知 + 明確待人工狀態（原本只有一行 warn 靜默遺棄）、
政策 needs_human 會真的發出 Slack 核准請求（原本 askMergeApproval 呼叫 0 次）、
停止逾時未收乾淨時不釋放實例鎖（避免新實例清掉舊實例正在用的 worktree）、
新增 confirm_no_change 控制指令與 Slack 裁決按鈕




---

## feat: 本機互動 CLI（npm run ask）+ 三個接線修正（1250 測試全綠）

Slack 原本是唯一的人機介面：未啟用時 ConsoleGateway 只寫 log、入站回呼永不觸發，
任何需要澄清／確認的任務都會永久 park。新增本機 CLI 補上第二個入口。

- src/cli/ask.ts：列出待辦（澄清／無需改動／待人工／待核准／卡住的群組）並執行裁決。
  **不是第二套邏輯**——所有動作都走與 Slack 相同的 InboundRouter；直接讀寫 ledger
  （SQLite WAL 多進程安全），daemon 沒在跑也能先把答案填好，下輪 tick 自動撿到
- 支援用 id 指定目標：實測踩到編號是動態的，處理完一項後清單重新編號，
  「對第 2 項下指令」打到了另一個群組的合併核准
- confirm 會先顯示 agent 的理由與依據並要求二次確認（complete_task 不可逆）
- confirm 後查證 ledger 實際狀態再回報：InboundRouter 吞掉自己的錯誤，
  不查證就印「已完成」會在 MCP 拒絕時謊報成功（實測踩過）

接線修正：
- main.ts 注入 completeTask（依任務 repo 解析對應專案的 MCP）。沒有這個注入，
  confirm_no_change 只會清本機 block，任務板上的卡永遠關不掉 → 人只能一直 retry、
  agent 一直重跑（e2e 探針 ㉓ 實測會這樣繞死）
- 沒有 MCP 連線時 confirm 改為維持 needs_human，不再「只在本機標 done」：
  ledger 說完成而任務板還開著，會讓下游任務的 start_task 被以依賴未完成擋下，
  形成無解的不一致，人卻以為處理好了
- InboundRouter 拒絕對 park 中的群組套用合併核准（e2e 探針 ㉓b）：
  誤按會把它從 changes_requested 推到 merge_guard，shouldRequeueGroup 從此不成立，
  park 中未提交的成果永久無法恢復




---

## fix: 完整 daemon e2e 25/25 全綠（修 park 收尾卡死與孤兒 PR）

兩個真缺陷（實跑 e2e 抓到，非臆測）：
- park 的群被人結案後永久卡死：人用 confirm_no_change 把 park 中最後一張卡結案後，
  群內沒有「未做完的任務」→ 不重派 → 收尾（開 PR/Merge Guard/清 worktree）永遠不會發生，
  群組停在非終態且沒有任何人再碰它（實測 worktree 永久殘留）。
  修法沒有動 shouldRequeueGroup 的語意，而是在 orchestrator 的 A2 分支區分兩種來源：
  未開過 PR = park 等人 → 重派收尾；已開 PR = 審查要求修改但意見遺失 → 保守停著。
  （PARKED_GROUP_STATE 借用 changes_requested 承載兩種語意，prNumber 是唯一可靠的判別依據）
- 孤兒 PR：openPr 與 allowLocalMerge 同時開時，群組開了 PR 又本地合併，
  變更已進 base 但 PR 永遠不會被關閉。有 PR 時合併權責屬 PR 路徑（人核准 → 合併佇列）。
  另修：判斷寫成 group.prNumber 讀不到值——group 是進入函式時的快照，
  updateGroupState 不會回寫它，改用開 PR 當下的區域變數

harness 修正（先前把自己的模擬不足誤報成產品缺陷）：
- 核准條件寫反（approvalRequests.length === 0 時才核准，那時根本還沒有群在等）→ ⑭⑳ 誤報
- 只核准第一個群 → 其餘永遠停在 in_review
- 模擬的人一律送 retry，沒用上新的 confirm_no_change 出口 → ㉓ 誤報；
  現在兩條出口都驗：探針 T-5 confirm 結案、T-3 判定 agent 誤判要它去做
  （後者才會產生純文件變更，⑫ 的「docs → 自動合併」也因此驗得到）
- InboundRouter 未注入 completeTask → confirm 不會真的關掉任務板的卡
- ④ 的預期沒把「人 confirm 也會呼叫 complete_task」算進去




---

## feat: 分離 prRepo（GitHub 動作目標）與 repo（任務板識別）

安全隱患：gh pr create --repo 用的是 config 的 repo，而 repo 必須等於任務板上的
task.repo 才對得上任務。要用複本 repo 做 live 驗證時，PR 會被直接開到正式專案。

- ProjectRuntime/MergeProject 加 prRepo，開 PR 與合併 PR 都以它為準（未設才回退 repo）
- config schema + example 加欄位說明
- 測試釘住：設了 prRepo → PR 到複本且不碰正式；未設 → 沿用 repo（一般專案不受影響）




---

## feat: 用 SDK 提供的錯誤語意分類，permanent 不再無限重試

先前一律看 `subtype !== 'success'` 就當「可重試」丟進退避迴圈——對認證失效、餘額不足、
參數錯誤這種錯誤是災難：重試一萬次也不會好，只是安靜地燒時間，而人完全不知道要修設定。

SDK 其實給得很完整（不需要任何故障注入）：
- SDKAPIRetryMessage（system/api_retry）帶 error_status（真正的 HTTP 狀態碼）、
  error（語意碼）、attempt/max_retries/retry_delay_ms——SDK 對 429/529/5xx 會自己先重試
- SDKAssistantMessageError：authentication_failed / billing_error / rate_limit /
  overloaded / invalid_request / model_not_found / server_error / max_output_tokens…

改動：
- collectStreamOutcome 解析 api_retry 與 error 語意碼，回傳 errorKind/sdkError/httpStatus/retries
- classifyAgentError：語意碼 → HTTP 狀態碼 → result subtype → 錯誤文字，逐層退回判斷
  transient（等）/ permanent（重試無用）/ capacity（要調設定或拆任務）
- Worker 對 permanent 與 capacity 立刻 park 交人，並在 block detail 給**可照著修的提示**
  （token 過期→改 .env、餘額→帳號後台、超上限→拆小任務），不再無聲重試
- SDK 內部重試過會 log 出來，人才知道「這輪很慢」是 API 在退避而非 agent 卡住

測試餵的是真實 SDK 訊息形狀（529/429/401/400/404/5xx/連線逾時/error_status=null），
不是模擬注入的假故障




---

## feat: 完整流程 e2e（真實 GitHub 臨時 repo）+ 修好 draft PR 無法合併

新增 `npm run test:e2e`：每次建一個臨時 GitHub repo → 跑完整鏈路 → 測完刪掉。
只有任務來源是假的（FakeMcp，照真實 pmm 格式），其餘全是 src/ 的真實模組，
連 gh pr create / gh pr merge 都是真的打 GitHub。

兩種模式（正式測試不該每次都花 LLM 的錢）：
  npm run test:e2e            scripted agent（真的寫檔）——快、免費、可重複
  npm run test:e2e -- --live  真 AgentRuntime

驗收 9 項：拉任務→分群→派發→完成→真開 PR→真合併→變更真的進 base→無孤兒 PR→無卡住群組

抓到並修好兩個只有對真實 GitHub 才會暴露的缺陷：
- 【真缺陷】draft PR 不能被合併（GitHub GraphQL 直接擋 "still a draft"）。
  我們刻意用 draft 開 PR（代表機器產出、待人看），但人核准後就該轉正式——
  PrManager.merge 現在偵測到 draft 會自動 `gh pr ready` 再重試。
  沒這個修正，需求 7「核准後合併」在 draft PR 上 100% 失敗
- 【真缺陷】allowLocalMerge=false 時 GroupRunner 直接 return，群組被留在進守衛前設的
  merge_guard 暫態；processMergeQueue 會把「沒人在跑的 merge_guard」當成待合併，
  找不到憑證後每輪問人一次，群組就此卡死。改為明確離開該狀態，
  且「已開 PR 不本地合併」的判斷移到 allowLocalMerge 之前

其他：
- scripts/ 納入 typecheck 範圍——先前 harness 不受檢查，我用了不存在的方法才在執行期才炸
  （納入後立刻抓到 e2e-daemon 兩個既有型別錯誤）
- e2e-daemon 的模擬人也核准 pr_open 的群（只認 in_review 會把模擬不足誤報成產品缺陷）




---

## fix: PR 敘事段落不再是滿版「待補」

實際看真 agent 開出的 PR 時發現：架構/畫面/操作/核心技術大多是「（待補）」——
因為 **agent prompt 從來沒要求它產出這些段落**。PR 內文的敘事是從 agent 最終總結
解析出來的，prompt 不講，agent 自然只寫一兩句話，需求 5「讓審查人員快速了解」等於沒兌現。

- agent prompt 補上「最終總結的格式」：做了什麼/怎麼做/架構/畫面設計/操作形式/核心技術/假設，
  並明確要求「不適用的段落整段省略」（不要寫「無」或「待補」，硬湊只會讓審查者讀廢話）
- generatePrBody：有 agent 總結時，缺席的敘事段直接省略而不是印「（待補）」——
  純文件變更本來就沒有架構/畫面/操作，滿版待補反而降低整份 PR 的可信度；
  完全沒有總結時仍保留全部段落並標「（待補）」，那是「真的沒寫」的訊號，審查者需要看到
- 新增 agentSummarized 旗標區分這兩種情況（narrative 只有系統補的任務標題時不算有總結）

真 agent 驗證：修正後的 PR「怎麼做」寫出了為什麼用表格、為什麼不自己實作兄弟任務的檔案；
「假設與待確認」列出三條各自附依據




---

## security: agent 禁用 gh 與 git push；測試 repo 改固定+標記驗證

三個安全修補（使用者指出的真實漏洞）：

1) 【嚴重】agent 可以用 gh 做任何事——紅線只擋 git push --force，完全沒擋 gh。
   也就是說 agent 能 `gh pr merge`（直接繞過 Merge Guard）、`gh repo delete`、
   `gh api -X PATCH` 改分支保護。現在於 PreToolUse hook 硬擋整個 gh。
2) 【嚴重】agent 可以 `git push origin main`，跳過整條 PR/守衛流程。
   改為 push 一律禁止（不分 force），並擋 git remote 的變更型子指令
   （改 remote = 讓成果被推往非預期的 repo）。
   本地操作（add/commit/status/diff/log/checkout/stash、remote -v/show/get-url）照常放行。

   **刻意用工具層而非提示詞**：prompt 是軟約束，agent 可忽略、也可能被任務描述帶偏
   （例如任務寫「請開 PR」）；而外部副作用一旦發生就不可逆。

3) 測試 repo 從「每次建/刪臨時 repo」改成「固定一個 repo，每次重置」：
   不再需要 delete_repo 這種能刪掉**任何** repo 的權限，也不會累積垃圾 repo。
   但重置本身會 force push 覆寫 main + 刪分支，在錯的 repo 上執行等於毀掉真實工作
   （遠端被 force push 覆蓋的 commit 沒有 reflog 可救），所以加了身分驗證：
   建立時打上 topic 標記，重置前必須確認標記存在且 repo 為 private，否則中止。
   實測：未標記的 repo 確實被拒絕操作。
   （--ephemeral 仍可用舊的建/刪模式；認證改用 gh credential helper，只在單次指令生效，
   不改動使用者的 git 全域設定）




---

## security: 深度防禦——擋不住的字串比對，改用環境隔離切斷認證

使用者問「agent 先寫腳本再用 bash 執行能繞過嗎？」——**能**。
`bash x.sh` 這串字面上沒有任何紅線關鍵字，而指令字串比對只看得到字串。
更根本地說，靜態掃描贏不了圖靈完備：內容可動態產生、可 base64、可用 python subprocess。

所以改成三層，主防線不是字串比對：

1) 【環境隔離·主防線】agent 子行程拿不到 GitHub 認證
   - 移除 GH_TOKEN / GITHUB_TOKEN / GH_ENTERPRISE_TOKEN
   - GH_CONFIG_DIR 指向空目錄 ⇒ gh 變成「未登入」（實測：gh 直接要求 gh auth login）
   - GIT_TERMINAL_PROMPT=0、GIT_ASKPASS=/bin/false ⇒ 推送拿不到憑證也不會卡在互動
   - 保留 PATH/HOME/ANTHROPIC_AUTH_TOKEN 等 agent 自己要用的
   **不管指令怎麼包裝，外部副作用都發生不了**——這才是可靠的那一層。

2) 【腳本內容掃描·次防線】`bash foo.sh` 時讀出檔案內容，用同一套紅線掃一次
   （限深度 2、限 256KB；讀不到就放行，交給環境隔離兜底）

3) 【prompt·第三層】明講禁令。目的只是讓 agent 知道「為什麼被擋」，
   免得它把拒絕當成環境故障而反覆重試或去找繞路寫法。單靠這層不安全。

實測四種情境：直接 gh → 擋；先寫腳本再執行 → 擋（訊息標明來自腳本內容）；
正常腳本 → 放行（不誤殺）；讀不到檔案 → 放行（明確交給環境層）。




---

## fix: live e2e 的人工回覆迴圈（追查 E-2 卡住的結論：不是缺陷）

追查結果：E-2「補上零與負數的測試」卡住**不是產品缺陷**——
真 agent 做 E-1 時順手把那兩個測試一起寫了，輪到 E-2 便查證後呼叫 report_no_change：
  「git show --stat 顯示這三個測試在 E-1 的 commit 一次新增；npm test 實跑 4/4 通過；
    再加同語意的重複測試只會製造無意義的 diff」
系統照設計 park 等人確認（complete_task 不可逆）。判斷完全正確。

真正的問題在 harness，修了三處：
- InboundRouter 的入站 hook 掛的是空函式 ⇒ 任務一旦 park 就沒有人救得了它，
  「agent 正確判定無需改動」這種合法結果會被算成測試失敗
- 迴圈用 tick 次數當上限 ⇒ 真 agent 一個任務要好幾分鐘，24 tick（約 24 秒）根本不夠，
  在任務還沒 park／還沒被回覆時就停止模擬人。改用整體時間上限（live 20 分、scripted 5 分）
- 驗收用 `gh pr list --state all` 全撈 ⇒ 固定 repo 的歷史 PR 被算成本次成果（實測 PR 數=11）。
  改成只算「編號大於開跑前基準」的 PR
- 另修 emitMerge 被兩處賦值互相覆蓋（Orchestrator 收不到核准憑證）→ 改成廣播

真 agent 模式現在 9/9 全通過，且完整走完 §7b 的出口：
agent 判定無需改動 → park → 人確認 → complete_task → 群組收尾 → PR 合併（3/3）




---

## feat: 靜置期 + session 追蹤/成本歸屬 + 人回覆後接回原 session

三個獨立但相關的缺口，1348 測試全綠。

1. 靜置期（quiet period，src/core/quiet-period.ts）
   人建立同系列任務會有時間差，輪詢會抓到「一半的任務」→ 做出半成品 PR。
   改成以專案（MCP 任務板）為單位，最後一次任務板動作要滿 N 分鐘才准分群，
   yaml 可設 quietPeriodMinutes，預設 15、設 0 關閉。
   被擋的任務留在 discovered，下一輪再判（不是錯誤，是等待）。
   活動時間優先取 MCP 的 createdAt/updatedAt（pmm 回 ISO 字串），
   MCP 沒給就退回 ledger 的發現時間。

2. session 追蹤與成本歸屬（agent_sessions 表）
   每一輪 agent 執行都記 task_id ↔ session_id（**含完全沒有互動的**），
   並累加 SDK result 給的 total_cost_usd 與各模型 token。
   之後查 log／算成本才有對照。ledger 加欄位遷移（既有 DB 不必刪庫重建）。

3. 人回覆後接回原 session（src/worker/human-reply.ts）
   先前的行為：人的答覆只寫進 events，Worker 重跑時**沒有讀出來**，
   agent 大機率再問一次同樣的問題 → 問→答→再問的循環，每圈都在燒錢。
   現在續跑會注入答覆 + resume 原 session，並標記已消費（同一則只用一次）。
   resume 失敗（session 過期）降級成全新 session 重跑，資訊不掉。
   ask_human 的回覆語也從「自己選個預設繼續」改成「立刻停下等人」——
   對齊 Worker 實際會 park 的行為，避免 agent 照猜測改一堆再被 park。




---

## feat: CLI status/cost 報表 + 靜置期端到端驗證

- npm run ask -- status：任務/群組狀態、靜置期倒數、執行中、受阻清單
- npm run ask -- cost：今天／近 7 天／全部的花費與 token，最貴的任務排行
  取數與格式化分離（report.ts 全是純函式），每一行輸出都有測試——
  報表最糟的失敗是「數字看起來合理但算錯」，那種錯沒人會發現。
  補齊依顯示寬度計算（中文佔 2 欄），否則欄位會歪掉、看錯行。
- 兩個 e2e harness 關閉靜置期（現場建任務馬上跑，預設 15 分會讓測試乾等）
- 補「真實 Poller + MCP ISO 時間戳」的靜置期整合測試：
  先前只測到 fakePoller 直接寫欄位，跳過了最容易靜默失敗的解析那段
- e2e-daemon 25/25 全綠，1379 測試全綠




---

## fix: 移除重複的 Poller import（型別與值各匯入一次導致 tsc 紅）




---

## feat: Slack App Home + /orch slash command，並把新決策寫進 DESIGN

App Home（src/slack/home.ts + app-home.ts）
- app_home_opened → views.publish：待辦、進度、靜置期倒數、今日/累計成本
- 每次開啟重新取數（不快取——顯示幾分鐘前的舊狀態比不顯示更糟，人會照它做決定）
- 面板上只放安全動作（重試）；不可逆的「確認不用做」留在任務卡與 CLI（都有二次確認）
- 與 CLI 共用同一批 formatter，兩個介面不會給出不一樣的數字
- 收斂顯示（Slack view 上限 100 block，爆掉整頁會被退回 = 面板整個消失）
- 標題逃逸 mrkdwn 保留字元（任務標題來自任務板，是外部輸入）

/orch slash command：status / cost / pending，ephemeral 純文字、3 秒內 ack

接線
- SlackSocketLike 新增可選的 onHomeOpened / onSlashCommand；Slack app 沒設定就安靜跳過
- 共用 Gateway 那條 Socket Mode 連線（開兩條會讓同一個事件送達兩次，按鈕被處理兩遍）
- views.publish 失敗只留 warn，並指出最可能的原因（Home Tab 沒開）

DESIGN：新增 D20（靜置期）、D21（session/成本必記）、D22（人的回覆要注入 + resume），
資料模型補 sourceUpdatedAt 與 AgentSession，Slack 章節補 App Home / slash / CLI 對等入口。

1386 測試全綠、e2e-daemon 25/25、daemon --once 實跑正常（ledger 欄位遷移已在真實 DB 生效）。




---

## test: e2e 補兩條探針（人回覆是否真的送到 agent、session 是否每次都留）

㉕ 人回覆有送到 agent 手上：T-2 第 2 輪必須 resume=sess-T2 且帶到答覆「回傳 0」
㉖ 每個跑過 agent 的任務都有 session 紀錄

㉕ 這條特別重要：答覆只寫進 ledger、沒送回 agent 時，整條鏈路看起來完全正常
（任務照樣完成），但真實 agent 會再問一次同樣的問題。已用反向測試確認探針會紅
（把注入拿掉 → ❌「T-2 共 2 輪，沒有任何一輪收到人的答覆（答案掉了）」）。




---

## docs: Slack 申請步驟 + App Manifest（一次設好，不用點四個頁面）

config/slack-app-manifest.yaml：權限、事件訂閱、Home Tab、slash command 一份搞定。
手動勾選分散在四個頁面，漏一項的症狀是「某個功能靜靜地不會動」，很難查。

README 新增「Slack 設定」一節：建立 app → 兩個 token 各去哪拿 → 填 .env/yaml →
把 bot 加進頻道（沒加會 not_in_channel，症狀是一直 warn 但頻道什麼都沒有）→ 驗收指令。
順便補上 ask -- status / cost 兩個新指令。




---

## fix(docs): Slack manifest 的 bot display_name 改 ASCII

Slack 會把 bot_user.display_name 轉成 @username，中文轉不出來會被拒：
「the display_name cannot be converted to a username」。
改成 Orchestrator；display_information.name 仍是中文（那個才是顯示名稱，可以用中文）。
README 的 /invite 也一併更新。




---

## feat: App Home 與 CLI status 改成依專案分組（原本把多專案的數字加在一起）

問題：這個系統的核心形態就是一個 daemon 顧多個 MCP 任務板，但面板只有靜置期那行
帶了 repo，待辦與進度全部混在一起加總。看到「執行中 3」卻不知道是哪個專案在跑、
哪個卡住、哪個在燒錢——多專案時等於沒說。

- PendingItem 加 repo，每一列標出所屬專案
- ledger 加 costByRepo()：agent_sessions 只記 task_id，要 join tasks 才拿得到專案；
  對不到任務的 session 歸到 (unknown)，不靜靜消失（帳目短少比多一列難查）
- App Home：每個專案一段（執行中／排隊／受阻／完成／今日花費／PR／靜置期倒數），
  忙的排前面。沒有任務的專案也列出來——看不到它就分不清「很閒」和「根本沒載入」
  （設定寫錯、MCP 連不上都長這樣）。設定裡沒有但 ledger 有任務的 repo 也顯示，
  不讓被移除專案的任務變成孤兒。
- CLI status 同步改成逐專案分段，兩個介面講同一個故事
- 順手修掉沒有群組時仍印出「群組」空標題

1396 測試全綠。




---

## feat: 設定改存 SQLite，移除 config/*.yaml

設定的唯一事實源改成資料庫。理由不是「DB 比較潮」，是三件具體的事：
  1. 控制台要能改設定。程式改寫 YAML 很脆弱（註解、順序、重複鍵、引號），改壞了整個
     daemon 起不來。
  2. 改完要立刻生效。設定檔只在啟動時讀一次，寫完檔還要重啟——那控制台只是一個很貴的
     文字編輯器。
  3. 密鑰要能精準更新。UPDATE 是原子的，改一行 .env 不是。
密鑰放 DB 的保護等級與 .env 相同（同機器、同權限、data/ 已 gitignore）；原本「密鑰只放
.env」的理由是「設定檔會被複製貼出」，DB 不會進 git，那個理由對它不成立。

- config/bootstrap.ts：只有 ledgerPath / lockPath 來自環境變數。雞生蛋——設定住在 DB 裡，
  「DB 在哪」沒辦法從 DB 讀；鎖也必須在開 DB 前取得。
- config/store.ts：settings（單列 JSON）+ projects（一列一專案）兩張表。讀取一律過 zod，
  舊資料缺欄位自動補預設、壞資料在讀取當下就炸（而不是半小時後某個用到它的地方）。
  寫入先驗證再落地：寫進去才發現不合法的話，下次啟動會死在讀取，而使用者手上沒有任何
  工具改得回來。
- config/migrate.ts：舊 yaml 一次性匯入，只在 DB 完全沒設定時執行（每次重匯會把控制台的
  修改靜默蓋回去）。**保留 ${VAR} 字面值不展開**——實跑撞到的坑：存展開後的值而遷移當下
  沒載入 .env，token 會靜靜變成空字串，直到 daemon 下次啟動以「連不上 MCP」爆出來。
- 移除 config/*.yaml 與 *.example.yaml，gitignore 一併清掉。

已在真實 DB 完成遷移並驗證：daemon --once 從 DB 啟動、MCP 連上、專案登錄、Slack 接線。
1417 測試全綠。

註：這一版還沒有控制台，新增專案要直接寫 DB；控制台是下一步。




---

## feat: 專案與設定熱重載（沒有這層，控制台只是很貴的文字編輯器）

原本專案／MCP client／runtime 全在啟動迴圈建好就固定了（Poller 的 sources 是
constructor 收的陣列），改完設定要重啟才生效——而重啟會中斷正在跑的 agent、
丟掉 worktree 的進度。

- core/project-registry.ts：執行中的專案集合，可在不重啟的情況下增減與換設定。
  · 讀取端一律走 registry（sources() / runtimeOf()），不留快照——留快照的地方
    就是熱重載失效的地方，而且失效得很安靜（控制台顯示已儲存，daemon 照舊輪詢舊清單）。
  · 指紋只涵蓋「改了必須重連」的欄位；整份 hash 的話，改個截圖門檻也會把 MCP
    連線砍掉重連。
  · 單一專案失敗不連累其他專案（一個 MCP 掛掉，其餘照常運作）。
  · 移除時真的關掉連線，不是只從清單刪掉（否則連線會洩漏，而且它還在輪詢）。
- Poller.sources 可傳函式（每輪現拿）；Orchestrator 的輪詢間隔與 Dispatcher 的併發
  上限同樣可傳函式，直接讀 ConfigStore ⇒ 控制台改完下一輪生效。
- main.ts 的啟動迴圈收斂成一個 buildProject 工廠，registry 在執行期反覆呼叫它。
- 收尾改成 registry.closeAll()：熱重載期間清單會變，開機時的快照可能已對不上。

1429 測試全綠；daemon --once 實跑正常（MCP 連上、專案登錄、熱重載路徑走通）。




---

## feat: 本機控制台（127.0.0.1）— 專案與設定全部可從網頁管理

src/console/：node:http（不加框架，這是單頁工具，路由不到二十條）+ 單一 HTML。
只綁 loopback，且建構時就擋掉非 loopback 位址——這個介面能改 MCP token、
停用專案、核准合併，綁到外部位址是安全事故，不是設定選項。不做登入：
能連到它的就是坐在這台機器前面的人，加密碼只是多一個會忘記的密鑰。

功能
- 總覽：待辦（可直接回答／核准／重試）、執行中、群組、今日與累計花費、靜置期倒數
- 專案：新增／編輯／停用／刪除，含 MCP URL/token、repo、本機路徑、靜置分鐘數、驗收指令
  · **測試連線**按鈕：存檔前先確認 MCP 打得通。沒有它的話，設定寫錯的回饋要等到
    下一輪輪詢、而且只出現在 daemon 的 log 裡——使用者看到「儲存成功」但什麼都不會動
- 設定：輪詢週期、併發數、指令逾時、無進展輪數、開 PR／自動合併、Slack
- 事件：最近的稽核軌跡
- 裁決一律走 InboundRouter（與 Slack／CLI 同一條路，不是第二套邏輯）

npm run console 可獨立執行（daemon 沒跑也能改設定，下一輪 tick 自動套用）；
daemon 啟動時也會內建一份，埠被佔用只 warn 不影響本業。

瀏覽器實測（Playwright，照全域規則）抓到一個單元測試看不到的真 bug：
「測試連線」沒有展開 ${VAR}，於是把字面字串當 token 送出去回 401——
正好是我們建議的寫法測起來永遠失敗。已修並補上反向驗證（錯 token 確實會失敗）。
順手修掉 favicon 404（每次載入噴一個錯誤會淹沒真正的錯誤）與 registry 每輪都記
「專案清單已更新」的 log 噪音。

實測熱重載：daemon 跑著，從控制台停用專案 → 一輪內移除；重新啟用 → 一輪內加回；
UI 改輪詢間隔 → 落地 DB 且 daemon 套用，全程沒有重啟。

1431 測試全綠。DESIGN 補 D23／D24，README 改寫成以控制台為中心。




---

## fix: 開工前先取最新 base；控制台重做（專業圖示、可讀對比、modal、指令表格、路徑選擇器、分支下拉）

## 正確性

**開工前不 pull（回答提問 6）**：`createWorktree` 用的是 `opts.base ?? 'HEAD'`，
也就是本機 clone 當下的狀態——別人推了新 commit 也不知道。agent 會在過期的程式碼上
實作：重做別人做過的東西、對著已被改掉的 API 寫、驗證全綠卻一 rebase 就爆。
這種問題要到 PR 階段才發現，整群的工都要重來。

既有的新鮮度判斷（fetch、分歧處理、離線降級）本來只長在 MergeGuard 裡，
現在抽成 git/base-freshness.ts 讓兩邊共用——兩份實作遲早分歧，而分歧的症狀是
「守衛說 base 是最新的，agent 卻在舊碼上做」。取不到最新版一律降級成本地 base
並把但書寫進 ledger event，不讓「連不到網路」變成「整群做不了」。

**分支可選（回答提問 7）**：baseBranch 本來就存在，但只是一個要手打的欄位，
placeholder 寫「留空 = 自動偵測 origin/HEAD」——對 main 是正式站、dev 才是開發的
專案，等於預設踩在正式分支上。改成從實際 clone 讀出來的下拉選單，並在說明裡直接點名
這個情境。listBranches 修掉一個真 bug：refs/remotes/origin/HEAD 的 short form 是
**origin**（純 remote 名），只濾 /HEAD 的話「origin」會被當成分支列給使用者選。

## 控制台

1. 表情符號全部換成 inline SVG 圖示
2. 深色主題從 #0f1115 提到 #232830、文字與次要文字都拉高對比（原本白天根本讀不了）
3. 新增／編輯改用 <dialog> modal
4. 驗收指令從 JSON textarea 改成逐欄表格（typecheck/lint/build/test/devServer/devPort
   本來就是固定的幾個），每格附用途說明，並解釋這些指令的作用與留空的後果
5. clone 路徑加瀏覽器（瀏覽器拿不到真實路徑是安全限制，所以由伺服器端列目錄，
   並標出哪些資料夾是 git repo）

瀏覽器實測（深色＋淺色各一輪）：版面正確、零 console error。1442 測試全綠。




---

## fix: 密鑰真的搬進資料庫（原本 ${VAR} 的值還住在 .env，改了要重啟）

使用者指出的兩件事，答案不一樣：

**「為啥是 env」— 我的錯。** yaml→DB 遷移時我保留了 ${VAR} 字面值，理由是「不要把密鑰
複製到使用者沒要求的地方」。結果違背了「設定都在資料庫」，而且我還在 UI 把 ${VAR} 當成
推薦寫法。

**「每次改都要重啟嗎」— 不用，但我推薦的那條路要。** 填字面值走 DB，改完下一輪重連；
填 ${VAR} 的話值在 .env，而 .env 只在行程啟動時讀一次 ⇒ 只有那條路要重啟。
等於我推薦的寫法正好是唯一會害人重啟的。

- config/promote-secrets.ts：啟動時把設定裡的 ${VAR} 換成實際值寫進 DB。
  解析不出值的**維持原樣並警告**——用空字串蓋掉 token，症狀是「起得來但每次 401」，
  比留著參照難查得多。.env 不動，變成備援而非事實源。
- Claude 認證（ANTHROPIC_*）也進 DB，agent 每次執行現拿 ⇒ 換 token／端點不必重啟。
  留空則沿用行程環境，既有安裝不受影響。
- 啟動時的認證檢查改成同時看 DB 與環境變數。原本只看環境變數，把 token 搬進 DB 後
  每次啟動都會噴一個假警告——假警告比沒有警告更糟，它會讓人學會忽略那一行。
- UI 不再推薦 ${VAR}；仍是 ${VAR} 的欄位標黃框並註明「改了需要重啟」。

**順手修掉一個我自己引入的回歸**：控制台的 HTTP server 會讓事件迴圈一直活著，
收尾時沒關 ⇒ `--once` 跑完一輪也退不出去（實測卡到逾時，看起來像 daemon 當掉，
其實只是沒人關 socket）。createShutdown 加 extraClose。

實測：把 .env 整個移走，daemon 仍然 Slack 連上、MCP 連上、專案登錄、--once 正常結束。
1453 測試全綠。




---

## feat: 花費上限、prod/test 資料庫分離、資料庫備份、補齊測試覆蓋

## 花費上限（日/週/月）
系統刻意不限制單次執行的 turn／token（D10），代價是**沒有任何東西會自己踩煞車**——
一個迴圈半夜可以燒掉一整天預算，人是隔天看帳單才知道。

- 達上限 → 暫停派出新群組；**進行中的不動**（那些錢已經花了，砍掉只是丟錢還留半成品），
  下個週期自動恢復
- 警戒線（預設 80%）提早通知，同一週期同一門檻只發一次——去重鍵寫在 ledger events，
  所以跨重啟也不會重複吵（每輪都通知的話，人會在半小時內收到上百則然後把頻道靜音）
- 預算算不出來時**不擋**：監控壞掉就停產是最糟的失敗模式
- 控制台、CLI cost 都顯示目前用量

測試抓到自己的邏輯瑕疵：警戒比例夾到 100% 等於「永遠不警告」（100% 時已算超限），
與註解自相矛盾。改夾 99，保證撞牆前一定先喊一聲。

## prod / test 資料庫分離（ORCH_PROFILE）
跑一次 e2e、開一次 --once 除錯，都會在正式 ledger 留下 boot／reconcile／discovered
事件甚至測試群組，混進成本統計與對帳判斷，事後分不出來。
預設 prod（忘了設要落在「不會弄壞測試」那一邊）；NODE_ENV=test 也算測試。

## 資料庫備份
DB 是唯一事實源（含所有密鑰），誤刪等於全部重來還要重新申請 token。
啟動時 VACUUM INTO 一份一致快照（WAL 模式下直接 copy 會少掉還沒落盤的交易，
看起來成功、還原才發現少東西），保留最新 10 份。
**測試抓到真 bug**：mkdir 在 try 之外，備份目錄建不起來會把啟動整個炸掉——
備份失敗絕不能變成啟動失敗。

## 補齊測試覆蓋（原本三個檔案零覆蓋）
- console/server.ts：22 條。這是唯一能改密鑰與核准合併的介面，先前只有我手動點過
- config/env.ts、git/status.ts

**git/status.ts 的測試抓到一個真實缺陷**：porcelain 對未追蹤檔案只印檔名、
`git diff HEAD` 又看不到它們，所以「agent 新建檔案、之後每輪都在改」每輪簽章相同，
會被無進展偵測判成卡住——正在好好做事的任務反而被 park。已把未追蹤檔案內容納入指紋
（有檔數與大小上限，避免建置產物拖慢每一輪）。

1522 測試全綠；控制台深色模式瀏覽器實測、零 console error。




---

## fix: 核准憑證改存 ledger（CLI／控制台／重啟後的核准原本會憑空消失）+ CLI 端到端

## 新增 CLI 端到端（scripts/e2e-cli.ts，`npm run e2e:cli`）
使用者不在時 Slack 沒辦法互動測試，CLI 就是唯一能自動驗證的人機介面。
這條**真的 spawn `tsx src/cli/ask.ts`**——既有測試都在行程內直接呼叫函式，
驗不到參數解析、profile 選到哪個資料庫、退出碼、輸出格式。
11 條探針全綠，全程只碰測試資料庫。

## 它抓到的 bug：核准憑證只存在記憶體
D17「狀態不等於核准，合併需要核准憑證」是對的，但憑證原本放在 Orchestrator 的
記憶體 Map 裡，於是三條路都是壞的，而且壞得很安靜——**人以為核准了，什麼都不會發生**：
  · CLI 核准是另一個行程，憑證傳不到 daemon
  · 獨立執行的控制台同理
  · daemon 重啟 ⇒ 重啟前的核准全部消失，群組退回「沒有推進者」

改成憑證寫進 ledger（merge_credential 事件），讀取時記憶體優先、沒有就回 ledger 找。
D17 本身不變：憑證仍是**明確寫下的一筆事件**，不是從 merge_guard 狀態推論出來的。
另有作廢事件（merge_credential_cleared）抵銷舊憑證——否則一次核准可以拿去合併第二次。
壞掉／缺 approvedBy 的憑證一律視為未核准：合併不可逆，寧可再問一次人。

補 8 條回歸測試涵蓋：跨重啟、跨行程、作廢後不可重用、壞憑證、缺 approvedBy。

1529 測試全綠、e2e-daemon 27/27、e2e-cli 11/11。




---

## test: 視覺驗證端到端（真的啟 server + 開瀏覽器）

視覺模組有 150 條單元測試，但全部用假的 playwright——驗得到判斷邏輯，
驗不到真實瀏覽器的行為：選擇器、量測時機（動畫沉澱）、截圖寫不寫得出來、
dev server 起得來又收不收得掉。這是唯一會判 UI 好壞的東西，卻從沒真的跑過。

四條探針，兩個方向都驗（D18：誤判的代價高於漏抓）：
  ① 正常頁面（含省略號截斷這種曾被誤判的情境）判綠 — 誤判會逼 agent 去改沒壞的東西
  ② 截圖確實產出且檔案存在 — PR 的視覺證據，寫不出來等於沒有驗證
  ③ 明確破版（3000px 溢出）判紅並指出像素數與元素路徑 — 判綠等於這道關卡不存在
  ④ 桌機與手機兩個斷點都量到 — RWD 破版常常只在窄螢幕出現

內建極簡靜態 server（用 npx 下載套件太慢，會撐爆 dev server 的就緒逾時）。
瀏覽器不可用時走既有的優雅降級（skipped 而非判紅），探針會標明。

`npm run e2e:visual`，跑在測試 profile。




---

## feat: 控制台可設定 GitHub token，且改完不必重啟

使用者質疑得對：我把「測試期的限制」當成平台的設計，建議把 token 綁死在單一
sandbox repo——那等於廢掉這個多專案平台。

token 不是安全邊界：buildAgentEnv 會主動剝掉 GH_TOKEN/GITHUB_TOKEN 並把
GH_CONFIG_DIR 指到空目錄，**agent 的環境裡 gh 是未登入的**。token 只有 daemon
自己在用。真正控制「會不會動到正式專案」的是每個專案各自的 prRepo，加上 openPr／
allowLocalMerge 兩個開關與核准憑證。UI 的說明改成這個口徑。

- 設定分頁新增 GitHub 區塊
- **token 改成熱套用**：原本 applyGithubToken 只在啟動時跑一次，改了要重啟才生效，
  而控制台的整個意義就是不必重啟。改成有狀態的套用器，每輪 tick 重套一次。
  「外部注入優先」仍成立，但要分得出誰是外部的——只有我們自己上次寫進 env 的值
  才可以被新設定覆蓋，否則 launchd/export 注入的憑證會在第一輪 tick 就被蓋掉。
- baolu 的 prRepo 補上 cjo4m06/Baolu-orch-sandbox：原本沒設 ⇒ PR 會開到正式專案，
  但本機 clone 的 remote 是 sandbox。openPr 目前是關的所以沒出事，一打開就會踩到。
  這是每個專案的開關，確認品質後改回正式 repo 即可。

1533 測試全綠；控制台深色模式實測、零 console error。




---

## fix: 退回必須能帶意見；ReviewWatcher 查錯 repo（需求 7 主線曾整條斷掉）

## 真實跑一次抓到的兩個 bug

**① ReviewWatcher 用 group.repo 查 PR，但 PR 開在 prRepo**
實跑證據：`repo: "cjo4m06/Baolu"` → GraphQL "Could not resolve to a PullRequest
with the number of 1"。只要 prRepo ≠ repo（把 PR 導到複本 repo 驗證），審查結果
永遠讀不到 ——「審查者按 approve → 系統合併」整條路無聲斷掉，而且它每輪都在
輪詢使用者的正式專案。合併那一側本來就用 `proj.prRepo ?? group.repo`，只有
watcher 漏掉。修好後同一道查詢從 404 變成正常回傳。

**② 人工退回無法附意見**
使用者指出：「拒絕就沒意義了 agent 根本不知道錯在哪」。確實如此——退回只是把群組
轉成 changes_requested，agent 下一輪多半原封不動再送一次，人再退一次，純燒錢的迴圈。
ReviewFeedbackStore 早就定義了 `human_reject` 這個來源，只是從來沒有人寫進去。

- Slack：按「退回」先在 thread 問「要改什麼」，下一則文字就是意見（與澄清同一個手感）。
  回「無」代表只是先停下來，會明白告訴人 agent 不會知道要改什麼。
- CLI：`npm run ask -- <group> deny <要改什麼>`。只在該項目真的支援 deny 時才攔截
  ——否則澄清的答案剛好以 deny 開頭會被誤判成退回指令（測試抓到）。
- InboundRouter 與 ReviewWatcher／GroupRunner 共用同一個 ReviewFeedbackStore，
  所以人寫的意見走的是與 GitHub 審查意見完全相同的回灌管道。

## 另外記錄一個 GitHub 的硬限制

daemon 用使用者自己的 token 開 PR ⇒ **GitHub 不允許核准／要求變更自己開的 PR**。
單人使用時 GitHub 審查那條路整條用不了（只剩 Comment，而 Comment 依設計不下結論）。
所以 Slack／CLI／控制台才是單人情境的主要審查入口，這也是上面 ② 必須修的原因。

1541 測試全綠。




---

## fix: 系統層通知硬塞假 TaskDetail 導致 daemon 掛掉（實跑撞到）

我昨天加的待處理事項提醒寫了：
    notifier.event(undefined, { type: 'problem', detail: text }, undefined as never)
用 `as never` 把 undefined 塞進必填的 task 參數——等於用型別斷言把編譯器的警告消音。
實跑時在 `task.id` 炸掉，而且因為 `event()` 是 async，**同步的 try/catch 接不到**，
變成 unhandled rejection 直接殺掉整個 daemon，任務停在半路。

三層修正：
1. Notifier 加 `notice(text)`：系統層訊息（提醒、花費告警）有自己的 API，不再硬塞
   一個假的 TaskDetail。SlackGateway 貼到頻道（無 thread），ConsoleGateway 寫 log。
2. 通知一律走 `notify()` helper，**同時吞掉同步擲錯與非同步 rejection**。
   通知管道壞掉不該讓 daemon 停擺——那只是「訊息沒送出去」等級的問題。
3. main 加 unhandledRejection / uncaughtException 的最後保險：只記錄不退出。
   真正該停的情況（拿不到鎖、設定壞掉）都在啟動時就擋掉了。

**測試為什麼沒抓到**：原本的假 notifier 是 `{ event: (_ts, e) => events.push(e) }`
——它不碰 task，所以傳什麼都不會爆。假件與真實介面的形狀不一致時，測試驗的是
假件的行為，不是真實的行為。已把假件改成會用到 `task.id`，並加上會 reject 的
notice，兩種失敗形態都涵蓋。

1548 測試全綠。




---

## feat: 任務卡隨狀態更新（原本貼出去就不動，人看不出它在等自己）

使用者的原話：「為啥他明明做完了 按鈕還是暫停 中止 重試？也沒有狀態
根本不知道他需要我回饋啊」——完全正確，這是介面的根本缺陷。

任務卡在認領那一刻貼出去之後就再也不會變。不管後來是完成、開了 PR、還是正在等
人核准，卡片永遠是同樣三顆按鈕、沒有狀態。人得滑到頻道別的地方去找那張核准卡
才知道有事要做——而它通常早就被洗上去了。

- 卡片加狀態列，排在最前面（人第一眼要看到「現在怎樣」「要不要我做什麼」）
- **按鈕隨狀態變**：執行中只有暫停/中止（重試在執行中沒有意義）、
  等人處理才有重試、已合併與完成不放任何按鈕
- **等核准時把核准/退回鈕直接放在任務卡上**，不必再去翻那張核准卡
- 需要人動手的狀態會多一句「在等什麼」（例：等你回覆 — 請在這條 thread 回覆）
- Notifier 加可選的 updateTaskCard；GroupRunner／Worker／Orchestrator 在
  pr_open／awaiting_merge／awaiting_human／awaiting_reply／failed／merged
  各轉換點呼叫。失敗一律吞掉——卡片更新是介面問題，不該影響任務流程。
- 狀態沒變就不打 API（避免無意義的速率消耗）

1558 測試全綠、e2e-daemon 全數通過。




---

## fix: 任務卡連續更新會亂序互蓋，核准按鈕永遠不出現

實跑症狀：卡片停在「PR 已開」（無按鈕），但真正的狀態是「等你核准合併」——
於是核准按鈕永遠不會出現，人以為沒事要做。

成因是競態：pr_open 與 awaiting_merge 兩次更新在幾毫秒內發出，而卡片更新是
fire-and-forget（不 await，避免拖慢群組流程）。送出順序是對的，但 **Slack 回應的
順序沒有保證**——較早的那次晚落地就把較新的蓋掉了。

修法：每張卡一條 promise 鏈，更新依序落地；並且送出時讀「當下最新」的狀態，
排隊期間又變的話前面那次直接跳過（合併寫入，不重複打 API）。

**單元測試原本抓不到**：假的 chat.update 是同步 resolve 的，永遠不會亂序。
已讓假件可注入延遲，並用「第一次慢、第二次快」重現亂序。反向驗證過——把排隊
拿掉，這兩條測試立刻變紅。

1561 測試全綠。




---

## fix: 任務卡狀態撐不過 daemon 重啟（改從 ledger 重建）

卡片狀態只活在記憶體：daemon 一重啟——改設定、修 bug 都會重啟——之前貼出去的
卡就再也更新不到，永遠停在重啟前的樣子。而人是看卡片決定要不要動手的。

改成記憶體查不到時從 ledger 反查 slack_thread_ts 與任務內容重建。1563 測試全綠。




---

## fix: 合併工作區缺 node_modules（任何 PR 都合併不了）＋ 裁決後卡片沒回饋

實跑抓到的三個問題。

## ① Merge Guard 的「語意飄移」是誤判——合併功能等於不存在
任務工作區有 prepareNodeModules（clonefile 帶入依賴），**合併工作區沒有**。
Merge Guard 在那裡跑 `npm run build` 必然失敗（vite: command not found），
一律歸類成「語意飄移」擋下合併。症狀是任何 PR 都合併不了，而錯誤訊息還誤導成
「程式碼有語意衝突」——D18 說的「誤判比漏抓更糟」的教科書案例。

## ② 按下核准/退回之後卡片沒有任何反應
使用者原話：「我明明點了，但他狀態卡沒更新？這樣我不就可以一直重複點？」
按鈕留在卡片上 ⇒ 不知道有沒有按到 ⇒ 重複點 ⇒ 重複寫憑證、重複觸發把關。
現在按下去立刻把整群的卡片換成「🔍 已核准，合併把關中」／「🔧 依你的意見重做中」
並移除按鈕。跨重啟時記憶體沒有群組↔任務的對應，改問 ledger。

## ③ 卡片有長達八分鐘的空白
從認領到開 PR 中間跑了 build、reviewer 審查、被否決、重做、再 build、再審查、
Merge Guard，卡片全程停在「執行中」。八分鐘的沉默和「壞掉了」分不出來。
補上 verifying／reviewing 兩個狀態的接線。

1566 測試全綠、e2e-daemon 全數通過。




---

## feat: 卡片狀態改成從 ledger 集中推導 + 收工後可清除卡片

使用者的要求：「事件過程寫在留言，但所有狀態跟操作即時反應在卡片」。
稽核後發現遠遠沒做到，而且我上一輪宣稱修好是錯的。

## 稽核結果
- 會寫進 thread 的事件點有 24 個，**只有 8 個會更新卡片**
- 漏掉的包括 merged、failed、無需改動、無進展、等前置任務、重試無用交人處理
- 我上一輪加的 verifying 接線**根本沒生效**（編輯錨點沒對上，靜靜失敗）

## 改法：不再逐點手動接
core/card-status.ts 從 ledger 的 task/group 狀態集中推導卡片狀態，
GroupRunner.notify 與 Worker.say 在發 thread 事件時一併同步卡片。
只要 ledger 狀態是對的，卡片就一定是對的——逐點接線漏一個就是一段靜默的空白。

新增 blocked_deps 狀態：等上游任務與等人是完全不同的兩件事，混在一起
人會去看一張其實不需要他動手的卡。

## 收工後清除卡片
終態（merged／done）多一顆「🗑 清除這張卡」。實測確認 chat.delete 刪掉父訊息後
**thread 回覆仍然存在**（3 則全都讀得到），所以要先刪回覆再刪父訊息。
進行中的狀態絕不提供這顆——誤刪等於把進度與 thread 裡的稽核軌跡一起丟掉。

## 過程中自己犯的兩個錯（都已修並補測試）
1. syncCards 沒包 try/catch：ledger 查詢一擲錯就冒到 runGroup 的外層 catch，
   **整群被標成 failed**——因為畫個卡片失敗而讓一整群的工作報銷。
2. 用正規表示式批次改 notifier.event → this.say 時，把 say 自己內部那行也改掉了，
   造成無限遞迴。15 個測試同時變紅才發現。

1572 測試全綠、e2e-daemon 全數通過。




---

## feat: 所有操作移到卡片上；修好「agent 自行 commit 被誤判成沒做事」

## ① 重做時 agent 自己 commit → 被誤判成「意見沒被處理」
實跑撞到：使用者寫「要有確認按鈕」，agent 確實加了 ConfirmDialog 並**自行 commit**
（它有 git 權限，這是允許的）。於是 commitAll 沒東西可 staged 回 false，系統據此
回報「審查意見並未被實際處理」而 park，PR 也沒更新——人的意見明明被執行了，
卻被判成沒做事（D18：誤判比漏抓更糟）。

改成看「重做開始時的 HEAD 有沒有往前」。抽成 reworkProducedChanges 純函式，
量不到 HEAD 時退回只看 commitAll——寧可少擋一次，也不要因為量不到而誤殺。

## ② 所有操作都在卡片上（使用者的明確要求）
「事件過程寫在留言，但所有狀態跟操作即時反應在卡片」。原本澄清選項、「不用做」
的確認、合併核准都各自貼一則帶按鈕的 thread 訊息——**thread 是收合的**，
把可按的東西放在裡面等於人看不到有事要處理。

- 澄清：選項變成卡片上的按鈕，問題本身也顯示在卡片上（不必去 thread 翻）
- 「不用做」：確認／否決兩顆在卡片上，確認鍵標紅（會呼叫不可逆的 complete_task）
- 合併核准：先前已移上卡片
- thread 只留一句指路的文字，不再有任何按鈕
- 新增 awaiting_no_change 狀態：它的按鈕與一般 awaiting_human 完全不同，
  混在一起會讓人按到不該按的

1580 測試全綠、e2e-daemon 全數通過。




---

## fix: 實跑發現的四個缺陷（1601 測試全綠）

這四個都是單元測試抓不到、只有真的跑一次完整流程才會現形的問題。
共同成因：假物件把程式碼的錯誤假設一起複製了，於是測試與程式碼一致地錯。
每一項都用「拿掉修正 → 新測試變紅」反向驗證過。

1) 合併後不刪遠端分支 → 同組任務再跑必然 push 被拒
   群組 id 是 sha1(repo|任務清單)，同一組任務永遠同名分支；GitHub 合併後不刪
   來源分支。下一輪本地從新 base 長出分支，與遠端已合併的舊 tip 分歧 →
   non-fast-forward → 整群 failed。實跑撞到（PR #8 合併後的下一輪）。
   · 合併時帶 --delete-branch，從源頭消除
   · push 被拒時只在「遠端那顆已完全併入 base 且其上無開著的 PR」才刪除重推
   · 絕不 force push：條件不成立寧可失敗，把現場留給人

2) verifying 狀態永遠不會顯示在卡片上
   卡片同步掛在「有發通知事件」上，而 verifying 改完狀態就直接去跑幾分鐘的
   測試指令，中間沒有任何事件。狀態的唯一事實源是 ledger，訂閱的也該是 ledger：
   新增 Ledger.onTaskChanged，主程式接到卡片同步；觀察者擲錯只留 warn。

3) 每次按鈕都印「ack() has already been called」
   onAction 有兩個呼叫端（任務卡、App Home），各自向 Bolt 註冊 catch-all，
   同一則互動被兩個 listener 收到、各 ack 一次。改成 BoltSocket 內部扇出，
   全程只 ack 一次；單一訂閱者擲錯不影響其餘。
   原測試抓不到，因為假 socket 只存得下一個 handler。

4) 舊卡片的按鈕還能按
   頻道裡累積的殘卡按鈕外觀相同、value 帶的 id 也相同，點下去等於對「這一輪」
   下指令。最糟是核准合併：看著舊卡核准掉新的改動。改成比對 ledger 記錄的
   現行 thread；認不出任務時放行（寧可漏擋，不擋正常操作）。
   群層按鈕的 value 補上 taskId，否則 daemon 重啟後舊卡的核准鈕會變成無主。

驗證：1601 單元/整合測試、e2e-cli 11/11、e2e-daemon 28/28、e2e-visual 4/4。
本輪實跑亦驗證通過：退回→帶意見重做→agent 自行 commit 被正確認出→核准→合併
（PR #9，核准到合併 24 秒）。




---

## fix(launchd): 補上 PATH，否則 gh／npm 在常駐下全部 ENOENT

launchd 的預設 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，實測在那底下
node／gh／npm 都找不到（只有 git 在 /usr/bin）。daemon 本身起得來
（ProgramArguments 是絕對路徑），但 gh pr create 會 ENOENT ⇒ 開不了 PR，
worktree 裡跑 npm test／npx vite 也 ENOENT ⇒ DoD 關卡永遠紅燈。
從終端機手動跑一切正常，只有掛上 launchd 才壞——這是最難聯想的那種故障。

已用一個只做環境檢查的臨時 launchd agent 實際載入驗證：
node／gh／git／npm／npx 五個都解析得到。

順帶：
· 移除指向已刪除的 config/orchestrator.yaml 的過時註解（設定已全部進資料庫）
· 明確標上 ORCH_PROFILE=prod（測試請用 ORCH_PROFILE=test 從終端機跑）
· ThrottleInterval 30 秒：重啟太快會撞上前一個行程還沒放掉的單一實例鎖
· README 改用 bootstrap/bootout（load/unload 已過時），補上查狀態與看 log 的指令




---

## feat: launchd 一鍵安裝/移除腳本；修好常駐時控制台整個壞掉

scripts/launchd.sh —— install / uninstall / stop / restart / status / logs / plist。
plist 由腳本產生而非版控裡的固定檔：node 位置因安裝方式而異（Homebrew／nvm／官方
安裝檔），寫死一份遲早對不上，而症狀是「服務標成已載入但其實沒在跑」，很難查。

**寫腳本的過程本身抓到三個 bug，全部是實跑才會出現的：**

1) 控制台在常駐模式下整個是壞的（首頁回 400）
   tsc 只吐 .js，ui.html 從來沒進 dist/。開發時 tsx 直接跑 src 讀得到，
   所以永遠不會暴露；只有 launchd 跑 dist 才壞。
   · build 加上 build:assets 複製 ui.html
   · 伺服器端找不到就退回原始碼位置，兩邊都沒有才報錯並指名怎麼修
     （原本只會吐一句沒頭沒尾的 400）

2) restart 必定失敗：Bootstrap failed: 5: Input/output error
   launchctl bootout 是非同步的，回來時服務往往還在（SIGTERMed、pid 還在），
   緊接著 bootstrap 就撞在一起。加 wait_gone 等它真的消失。
   uninstall 之後 status 顯示殘影也是同一個原因。

3) install 成功訊息讓腳本中斷：LABEL，: unbound variable
   全形標點是多位元組字元，bash 會把它吃進變數名，set -u 下直接中斷。

其他：
· node 路徑用 command -v 而非 process.execPath——後者解到帶版號的 Cellar 路徑，
  brew upgrade 後失效，症狀是開機後服務靜靜地起不來
· PATH 由 command -v 推導（launchd 預設 PATH 找不到 node/gh/npm）
· install 預設要人確認（裝上去就會對真專案工作）；--yes 給自動化，--profile test 用測試庫
· 移除寫死路徑的 scripts/com.botone.orchestrator.plist

驗證：完整生命週期實跑（install → status → restart → status → uninstall → status
→ 重複 uninstall → 未安裝就 restart）全部符合預期；daemon 在 launchd 下確實啟動
（取得鎖、備份、Slack 已連線、MCP 已連上、合併閉環已接線）。
控制台以 Playwright 實測：1280 與 390 兩個寬度皆無橫向破版，設定值正確載入。
1601 測試全綠。




---

## fix: push 復原路徑對 squash 合併是死的（拿真實 repo 對照才發現）

上一版的復原條件只有「遠端那顆是 base 的祖先」。但預設的合併方式是 **squash**，
它把整條分支壓成 base 上的一顆新 commit，原本的 commits 一顆都不會是 base 的祖先。
所以對 squash 合併過的分支，祖先判斷永遠是否 ——「已經合併掉的分支」會被判成
「還有未合併的內容」，復原路徑等於從來不會生效。

拿沙盒 repo 的真實狀態一驗就現形：PR #9 squash 合併後，
`merge-base --is-ancestor origin/orch/... origin/main` 回 false。
單元測試抓不到，因為假的 git 是我照著自己的理解寫的，而我的理解就是錯的。

修法：安全性改成兩種證明，任一成立即可
  (a) 遠端那顆是 base 的祖先（merge / rebase 合併）
  (b) 該分支上有 **已合併的 PR**（squash 合併走這條）——GitHub 說進去了就是進去了
兩者皆不成立才擲錯，仍然絕不 force push。(a) 成立時不查 (b)，省一次 API。

驗證方式是重建事故現場，全程用真的 git + 真的 GitHub：
  ① 建分支 + commit → push
  ② 開 PR #11 → squash 合併 → 確認遠端分支還在、且不是 main 的祖先
  ③ 本地從新的 main 重建同名分支（daemon 下一輪會做的事）
  ④ 舊行為直接 push → `! [rejected] ... (non-fast-forward)` 完整重現
  ⑤ 修好的 openPr → why=merged:#11 → 刪除後重推 → 開出 PR #12
`why=merged` 而非 `ancestor`，正好證明只靠祖先判斷的版本在這裡會擲錯。
沙盒已清乾淨（驗證檔案移除、PR 關閉、分支刪除）。

1604 測試全綠、e2e-daemon 28/28、e2e-cli 11/11。




---

## fix: Merge Guard 擋下時交回 agent 修，不再整組報銷

實跑事故：兩個任務都改到 src/views/SandboxView.vue，先合併的那個改變了 base，
後完成的那個 rebase 撞衝突 → 整組標 failed，17 分鐘的成果直接丟掉。

問題不在偵測，在偵測完之後沒有任何 agent 被叫來。系統本來就有「把失敗事實回灌
給 agent 讓它修」的迴圈（DoD 紅燈、reviewer 退回都走它），只是 Merge Guard 這條
沒接上去；連 FeedbackSource 的 'merge_guard' 都早就定義好了，註解還寫著
「合併守衛擋下（rebase 衝突／語意飄移）」——型別留了位置，程式碼從沒用過。

改動：
· group-runner 的 Merge Guard 擋下分支：存成一則審查意見 + 轉 changes_requested，
  由既有的 requeue 路徑帶著意見重新派工。重試次數用既有預算控管，用完才交人。
· mergeGuardFeedback()：把判決寫成 agent 看得懂的意見——點名衝突檔案、說明要在
  最新 base 上重做、**明確禁止**為了消衝突把對方的變更蓋掉（那會安靜地弄丟別人
  剛合併的功能），附上 git 原始輸出。
· 沒有共用意見暫存區時仍退回標 failed：意見送不到 agent 手上就派回去只會盲改，
  與 orchestrator 的 sharedFeedback 互鎖同一個理由。

順手：review-watcher.ts 第 436 行有一個真正的 NUL 字元寫在字串裡，整個檔案被
file(1)/grep 當成二進位，對它的搜尋全部靜默回空。改成  跳脫，語意不變。

驗證：
· 新測試 2 條，反向驗證（停用新路徑 → 立刻變紅）
· 真實驗證：拿事故現場那個 worktree 跑真的 MergeGuard，判決 code_conflict，
  產出的意見正確點名 src/views/SandboxView.vue
· 1606 測試全綠




---

## feat: 分群與執行順序改由 agent 規劃，階段順序真的生效

實跑事故的根因：分群靠關鍵字相似度與正規表示式抽路徑。實測那兩個撞車的任務
「在 /sandbox 頁面加上深色模式切換」「在 /sandbox 頁面加上複製按鈕」
**一個檔案都沒掃到**——「/sandbox 頁面」既不像路徑也不像識別字——於是退回
用規格檔路徑當代理，兩份規格不同就判定不重疊、放行並行，最後兩個都改
src/views/SandboxView.vue，後完成的那個 rebase 撞衝突。

人看一眼就知道那兩個會撞；規則看不出來。所以判斷交給 agent。

· src/core/plan-agent.ts（新）
  讀任務內容 + 用 Read/Glob/Grep 實際看 repo，輸出「分成哪幾群」與「階段順序」。
  正確性由「計畫必須自洽」把關：任務不重不漏、群不重不漏——少一個任務代表它永遠
  不會被做，而且沒有任何錯誤訊息，比規劃失敗難查得多。不合格會帶著原因重問一次，
  仍不合格就擲錯。**不做任何退化**：規劃 agent 不通代表寫程式的 agent 也不通，
  退回猜測式分群只是製造下一次撞車。

· 階段順序過去是死的：PlanResult.schedule 從來沒有人讀，實際擋並行的只有
  dispatcher 的足跡比對。現在 groups 多一個 after_groups 欄位（含遷移），
  dispatcher 會等前一階段全部結束才派下一階段。「結束」＝不會再改動 base
  （已合併或已失敗）——失敗也算，否則前一階段一失敗後面就永遠卡死。

· 足跡與階段互補：足跡擋「同時動到同一個檔案」，階段擋「檔案不同但先後有意義」，
  例如規劃者判斷很可能會撞但說不準是哪個檔案。

真實驗證（真 agent、真 repo、含一個刻意放的干擾任務）：
  [A] LIVE-1 + LIVE-2 → 同一群
      「SandboxView.vue 目前只有 108 行的單一 template，兩者必然改到相鄰的
        template 與 script setup 區段…分開做一定互相打架」
  [B] LIVE-3 → 另一階段
      「LoginView.vue 全 repo grep 不到任何 password 欄位…落點不確定且高機率
        碰到 main.css，不與 A 併群也不同階段」
  執行順序 A → B
今天撞車的那兩個現在會被歸在同一群、同一個工作區依序做，不可能再撞。
而且它引用的是 repo 的實際內容（行數、色碼、grep 結果），不是看標題猜。

測試：新增 15 條 plan-agent、4 條 dispatcher 階段序列化，皆做過反向驗證。
1625 測試全綠、e2e-daemon 通過。




---

## feat: 語意飄移補上 agent 判斷層（需求 7 真正要的那一層）

Merge Guard 原本的兩層都是**事實**：rebase 有沒有文字衝突、合併後 build/test 紅不紅。
那兩層抓得到「別的 PR 刪改了你依賴的東西 → 合併後爆掉」——這種用程式量是對的，
讓 agent 去猜測試過了沒才荒謬。

抓不到的是「能編譯、測試也綠，但兩邊的意圖打架」：A 把某個操作改成需要二次確認，
B 同時把同一條流程改成一鍵完成，各自的測試都過，合起來卻是自相矛盾的產品行為。
那量不出來，只有讀得懂程式碼與意圖的判斷得出來。

· src/pr/drift-judge.ts（新）
  把「base 在本群動工之後多出來的變更」與「本群的變更」一起給 agent，
  問它兩邊的意圖有沒有互相抵消或矛盾。判定 conflict 時要逐項說明
  where / baseIntent / groupIntent / why，才回灌得回去讓 agent 修。

· 分岔點必須在 rebase **之前**取：rebase 會把分支接到 base 頂端，之後就再也
  算不出「base 這段期間多了什麼」——而那正是判斷的材料。

· 保守方向與其他關卡**相反**：判不出來就放行。這一層是在所有事實層都綠之後才跑的
  額外保險；讓它在不確定時擋下來，等於用一個主觀判斷去否決一組客觀證據。
  呼叫失敗、解析不出、沒有金鑰、base 沒新變更 → 一律 skipped，不阻斷合併。
  前兩層就擋下來時完全不呼叫（不白花錢）。

· 擋下來時走的是上一個 commit 剛接好的回灌路徑：交回 agent 修，不是標 failed。
  回灌的意見明講「不可以把對方的變更還原」，真的互斥要用 ask_human 交給人。

測試：drift-judge 13 條 + merge-guard 整合 5 條，做過反向驗證
（停用判斷層 → 立刻變紅）。1643 測試全綠。




---

## feat: 讓 agent 實際看截圖判斷版面（量測抓不到的那些）

先前的狀況：截圖有拍、有做像素比對、有傳到 Slack、有定期清理——
**從頭到尾沒有任何 agent 看過那張圖**。

量測抓得到「這個元素超出視窗 340px」「跟基準的像素差異 12%」，那些是事實，
用程式量是對的。但畫面到底行不行遠不只如此：好不好讀、字級與對比夠不夠、
視覺層次對不對、按鈕看起來像不像可以點、深色模式下有沒有「深底配深字」。
這些沒有一項量得出來。

· src/worker/screenshot-judge.ts（新）
  把截圖交給 agent，要求它**用 Read 把每張圖打開來看**（不是憑檔名猜），
  依五個面向判斷：可讀性／對比／版面／層次／可操作性。
  明講不要挑個人配色偏好，只回報真的會妨礙使用的問題。
· 接進 Verifier：量測結果之外多一條 visual:judge 關卡，紅燈會走既有的回灌
  路徑把逐項問題送回 agent 修。任務標題與描述一起帶過去——判斷「畫面有沒有
  達成目的」需要知道目的。
· 保守方向與 DoD 那些關卡**相反**：判不出來就放行。這是主觀判斷，讓它擋下
  建置與測試都綠的成果，誤殺的代價高於漏放。呼叫失敗／解析不出／沒金鑰／
  沒截圖一律 skipped。截圖過多時只看前幾張，而且**留下警告**——靜默截斷
  會讓「全部看過了」變成假象。

真實驗證（真 agent、真截圖）：
· 刻意做一個五種毛病都有的頁面（深底近黑字、9px 字級、行距擠、1600px 區塊
  撐爆版面、「儲存變更」只是個沒有按鈕外觀的 span）
  → 五類問題全部抓到，每條都給了具體數字：#ECECEC 以上、對比 4.5:1、
    點擊區至少 44px、max-width 720–800px。沒有一項是量測產得出來的。
· 同樣內容做成正常樣式再測一次 → ok，並逐項說明它看過什麼。
  **沒有誤殺**——證明它是在真的看圖判斷，不是無差別挑毛病。

測試：screenshot-judge 15 條。1658 測試全綠、e2e-visual 4/4。




---

## feat: 過程看得見——卡片顯示輪數/耗時/上輪結果，reviewer 退回理由留得下來

實跑時的體驗：一個任務跑了 17 分鐘，卡片只在「執行中／驗證中／審查中」之間跳，
thread 一則訊息都沒有。那段時間裡「正在做事」與「已經死了」在畫面上一模一樣，
人只能猜。而事後想追「它為什麼被 reviewer 退回」，更是無從查起——
退回原因 log 沒有、task_iterations 沒有、events 也沒有，只留下「rejections: 1」這個數字。

· 卡片加進度列：`第 3 輪 · 已跑 17 分鐘 · 改了 7 個檔案` ＋「上一輪：…」。
  每輪開頭同步一次，所以人隨時看得出它還活著、在第幾輪、上一輪卡在哪個關卡。
· 進度指紋**刻意不含經過時間**：時間每秒都在變，納入指紋等於每次同步都重打一次
  Slack API，而人也看不出秒級差異。輪數／檔案數／上輪結果變了才重畫。
· reviewer 每次退回都寫進 ledger events，並在 thread 留下完整理由。
  現在「它是在合理迭代還是鬼打牆」查得出來了。

測試：slack-blocks 進度 5 條、worker 退回理由 1 條（含「兩次回灌都要留下理由」）。
1663 測試全綠、e2e-daemon 與 e2e-cli 皆通過。




---

## fix: 忽略並移除 Playwright MCP 的暫存輸出

.playwright-mcp/ 是 Playwright MCP 在「當下工作目錄」留下的截圖／快照／log。
沒有忽略規則，git add -A 就會把它們吃進 commit——本 repo 已經被吃進三個 commit
（c604def / 8018e7d / da7888d），而且到現在都還在 HEAD 上。

這在 agent 的 worktree 裡更危險：
· 污染 PR 的 diff
· 讓「diff 非空」的 DoD 判定失真（光靠垃圾檔就能滿足）




---

## feat: 視覺驗證改由 agent 開瀏覽器判斷；門檻值降級成線索

先前是三個角色各做各的，而最需要看畫面的那個偏偏看不到：
· 寫程式的 agent —— 沒有瀏覽器。做完 UI 只能靠 build 過了就當沒事
· VisualVerifier —— 自己啟 dev server、跑 Playwright、量九個門檻值判紅綠
· 截圖判斷者 —— 只能 Read 別人拍好的靜態 PNG

那九個門檻（溢出幾 px、歪斜幾 px、重疊比例…）回答不了「這畫面好不好看、好不好讀」。
maxRowSkewPx 判得出「歪了 3px」，判不出「這排版讓人找不到重點」；刻意的錯位設計
反而會被它判紅。像素比對同理——改個顏色就是 100% 不同，那不代表變醜。

改成：程式只負責把瀏覽器與 dev server 弄起來、產生截圖與量測數據（事實），
紅綠一律由**看得到畫面的 agent** 判。獨立性靠全新 context（同 reviewer.ts），
不是靠「它是程式寫的」。

1) 寫程式的 agent 掛上 Playwright MCP
   能邊做邊看、能真的按下去。工具逐一列出而非萬用字元，才排除得掉
   browser_run_code_unsafe / file_upload / handle_dialog。
   另補一道紅線：禁止用瀏覽器開 file://（MCP 預設已擋，但那是旗標決定的）。

2) 判斷者也掛瀏覽器，並在 dev server 還活著時跑
   baseUrl 不能放進回傳值——server 在 verify 回傳前就被 finally 收掉了，
   那等於交出一個已失效的位址。改用 whileServerUp 回呼。

3) evaluateLayoutMetrics 與 evaluateScreenshotDiffs 降級成 hints
   不再決定紅綠，改當「哪裡值得看一下」的線索餵給判斷者。
   **附帶取捨（與其他主觀判斷層相反）**：判斷者不可用時判**紅**。
   因為門檻值降級後，視覺這關只剩它一個把關者；照舊放行等於整關變成裝飾。

4) 修 dev server 撞埠
   sniffPort 改為優先於設定的 devPort——伺服器自己印的才是事實。
   Vite 在埠被佔時會自動換一個並印出來，先前設定值優先，於是併行跑兩個 worktree
   時必然有一個死等錯的埠，60 秒後被判「環境缺件」→ **視覺驗證靜默跳過並放行**。
   sniffPort 也改成取最後一個 URL（重試時後印的才是真的）。

5) 隔離瀏覽器的暫存輸出（三層）
   Playwright MCP 預設寫在「當下工作目錄」。落進 worktree 會污染 PR 的 diff，
   更糟的是讓「diff 非空」的 DoD 被垃圾檔滿足。這不是理論風險——本 repo 已經被
   吃進三個 commit（見上一個 commit）。
   · --output-dir 指到 worktree 外，一任務一目錄
   · 建 worktree 時寫進 .git/info/exclude（**不是 .gitignore**——那是被追蹤的檔案，
     動它本身就是一筆 diff，會進 PR 也會被 DoD 當成「有做事」）
   · commitAll 的 pathspec 再排除一次

6) 未知的問題類別不再讓整份判定作廢
   zod 的 .default 只處理「欄位不存在」，值不合法時整份解析失敗。實跑撞到：
   判斷者用了 "spacing" 這個沒列進去的類別，於是一整份正確的判定
   （對比 1.2:1、行框 9px、段距 4px，全部說中）被丟成「回應無法解析」。
   改成 .catch('other')——類別只是給人分類看的，不該有權力否決內容。

真實驗證（真瀏覽器、真站台）：
· 五種毛病的頁面 → 全部抓到，而且**讀得到實際 CSS 值**：
  #1a1a1a vs #232323（對比 1.11:1）、font-size 9px、line-height 1.05、
  width 1600px、裸 <span> 且 border:none。這比看 PNG 強得多。
· 正常樣式的同一份內容 → ok，沒有誤殺。而且它：
  - **推翻了我故意餵的假線索**（「溢出 740px」→ 實測四種寬度皆為 0，回報為誤判）
  - **真的點了按鈕**（「點擊後畫面無變化，但規格未定義行為，不列為問題」）
  - 對灰色地帶誠實（按鈕對比 3.68:1 低於 AA 18%，判定「辨識無礙，屬可記錄的
    量測數據而非妨礙使用」）——沒有為了顯得有用就判紅

測試：browserServerConfig 3 條、瀏覽器紅線 3 條、ui-judge 15 條，
visual 既有測試依新語意改寫。1669 全綠、e2e-daemon 通過。




---

## fix: worktree 要是一個「能動的開發環境」——帶上本機設定檔

`git worktree add` 只帶版控裡的檔案，而本機設定檔（`.env` 之類）依慣例被 gitignore。
於是每個 worktree 都是一個**跑不起來的專案**：dev server 起得來，app 卻掛不起來
（實例：Firebase 少了 apiKey 會整個不掛載），截圖是空白頁——
視覺驗證變成在驗證一張沒渲染的畫面，而且它自己不知道。

這不是視覺驗證專屬的問題：寫程式的 agent 想自己跑起來看，一樣撞牆。
上一輪的 agent 就是自己塞假值繞過去的。

相依套件早就用 clonefile 帶進 worktree 了，只是這件事只做了一半。補上另一半：
· prepareLocalFiles：把主 clone 的本機設定檔複製進 worktree
  預設清單 .env / .env.local / .env.development / .npmrc，不存在的自動略過
· 專案設定新增 localFiles 可覆寫；**設成空陣列 → 一個都不帶**
· 複製而非 symlink——symlink 會讓 agent 的寫入直接改到使用者的主 clone
· worktree 已有的不覆蓋（沿用既有 worktree 時 agent 可能改過）
· 合併工作區同樣要帶：Merge Guard 在那裡重跑 build/test

安全性：這些是**開發用設定**（VITE_ 前綴的值本來就會被打包進瀏覽器），
不是伺服器密鑰；而且 agent 本來就能用 Bash 讀主 clone 的同一份檔案，
複製進去不是新增暴露，而是把既有事實變明確、且變成專案負責人控制得了的。
真正的防線在別處：GitHub token 從 agent 環境整個剝除、部署指令一律擋下、
保護路徑不可刪改。真把伺服器密鑰放在開發用 .env 的專案就設空陣列，
代價是那個專案的視覺驗證會失敗並講明原因——比靜默用空白頁驗證誠實。

測試 4 條。1673 全綠。




---

## fix: dev server 探測要含 IPv6；連不上判紅；記錄 agent 實際用了哪些工具

實跑第二次撞到視覺驗證靜默跳過，這次原因更隱蔽：
Vite 預設把 localhost 綁在 **IPv6 的 ::1**，不綁 127.0.0.1。
實測 curl 127.0.0.1:5173 回 000、curl localhost:5173 回 200——
而程式只抽埠號再自己組 http://127.0.0.1:<port>，於是永遠探不到，
等滿 60 秒判「環境缺件」→ 跳過並綠燈。DoD 顯示 visual:ok，其實一張圖都沒看。

· baseUrlCandidates：候選含伺服器印出的位址與 IPv4/IPv6 三種寫法，由 probe 決定哪個通
· **dev server 連不上改判紅，不是跳過**：沒裝 playwright 是環境缺件（跳過合理），
  「伺服器起了我們卻連不上」是我們自己的故障，不該讓需要視覺驗證的任務靜默通過
· 記錄每輪實際用了哪些工具，瀏覽器呼叫次數單獨列出——
  agent 會宣稱「已通過瀏覽器驗證」，但它在還沒有瀏覽器工具時也寫過同一句話，
  自我宣稱不是證據。被擋下的呼叫也要記，否則「它試了但被擋」查不到。

測試：baseUrlCandidates 4 條、工具回報 2 條，visual 既有測試依新語意改寫。1677 全綠。




---

## feat: 判斷者拿到唯讀 git，能分辨「這次弄的」與「本來就有的」

實跑撞到：任務是「在面板加一顆清空按鈕」，介面判斷者卻回報
「× 關閉鈕只有 36×20px」。那是事實——但那顆按鈕是既有的，不是這次弄的。

它不是判斷錯，是我給了它一間沒有窗戶的房間：它人就在 worktree 裡、git 歷史整份都在，
但工具只有 Read/Glob 與瀏覽器，**沒有任何能執行 git 的東西**。於是它只看得到
「這個頁面現在長什麼樣」，看不到「這次改了什麼」，只好把整個頁面的毛病一起報上來。
後果：diff 從一顆按鈕長成 9 個檔案 +223/-116，而且每輪都能再挖出新的既有問題，
理論上永遠收斂不了（這輪是撞上限前剛好過關，是運氣）。

· src/worker/git-inspect.ts（新）：給判斷者的唯讀 git 工具（in-process MCP）
  git_changed_files / git_diff / git_log / git_blame
  git_blame 是關鍵——「這幾行上次是誰改的」直接回答「這是不是這次弄的」。
  不給 Bash：判斷者不該有改東西的能力。邊界劃在工具層——白名單子指令、
  工作目錄鎖死、路徑參數不接受跳脫或看起來像旗標的字串。
· issue 加上 origin（introduced / preexisting）。**只有 introduced 會擋**；
  既有問題照樣列出來（值得修）但不擋一個只加了按鈕的 PR。
  分不出來就當 introduced——擋一次讓人看到，比放行一個真的被弄壞的畫面好。
· baseRef 從 group-runner 一路傳到判斷者，它才有比較基準。

另外修掉一個**我又用天真程式碼判斷**的地方：
mergeGuardFeedback 只看 reason 代碼就編故事。semantic_drift 現在有兩種來源
（合併後 build/test 紅、DoD 裡的介面判斷紅），程式卻寫死了前者的敘述，
於是判斷者說「按鈕太小」時，agent 收到的開頭是「找出你用到的哪個函式被改了」——
一段會把它引去錯方向的診斷。改成不編故事，直接指向實際失敗的那一項。

順帶：test/git-inspect.test.ts 裡我把 'a b' 誤植成含 NUL 的 'ab'，
於是「檔名有空白」的斷言變成在測 NUL、而且剛好通過，害我一度以為測試框架沒在跑。
已改用跳脫序列，並補一條「檔名有空白是合法的」。同時掃過全專案確認沒有殘留 NUL
（今天第二次被不可見字元絆倒，第一次是 review-watcher.ts 讓 grep 靜默回空）。
新增 test/zz-sanity.test.ts 常駐證明測試框架真的會執行斷言。

測試：origin 分類 3 條、prompt 2 條、路徑防呆 5 條、sanity 3 條。1691 全綠。




---

## fix: SDK 的 allowedTools 擋不住 MCP 工具，改由自己的 hook 強制

實跑抓到的安全漏洞：`browser_run_code_unsafe` **沒有**列在 allowedTools 裡，
agent 卻成功呼叫了它（工具使用紀錄裡看得到那一次）。也就是說
**SDK 的 allowedTools 對 MCP 工具是建議而非強制**——我先前寫的
「危險工具不在 allow-list 裡」根本不是保證。

那個工具會在頁面裡執行任意程式碼；同類還有 file_upload（能把保護檔案送出去）、
handle_dialog（可能自動確認破壞性對話框）。

唯一可靠的攔截點是 PreToolUse hook——它在工具真正執行前被呼叫，而且是我們自己的
程式碼。所以：
· evaluateToolPolicy 對 mcp__playwright__* 改成強制 allow-list，沒列進來一律擋
· 判斷者也補上自己的 hook（它先前根本沒有）——它的職責是判斷，
  連寫檔、跑指令都不該有，更不用說在頁面裡執行任意程式碼

這是今天反覆出現的同一個教訓：保證必須在自己控制的程式碼裡、在動作發生的當下攔截。
宣告式的設定只是意圖，不是邊界。

另外補上判斷者的工具使用紀錄。起因：這一輪它把一個**別人先前 commit 的**畫面瑕疵
標成了 introduced 而擋下 PR，但我查不出它究竟「沒去查 git」還是「查了但判斷不同」，
因為只有寫程式的 agent 有工具紀錄。缺了這份紀錄，下次同樣的錯誤還是查不動。
gitCalls 為 0 時 log 會明講「沒查 git，分不出新舊問題」。

測試：閘門強制 allow-list 2 條、判斷者工具閘門 2 條。1694 全綠。




---

## fix: Merge Guard 重跑 DoD 時漏傳任務資訊，判斷者在那一關是瞎的

新加的判斷者工具紀錄立刻付上用場。同一輪裡兩次介面判斷：

  任務關卡那次    gitCalls: 7   （git_blame 4 次）→ 有查
  Merge Guard 那次 gitCalls: 0                    → 沒查

而擋下 PR 的正是後者。根因：merge-guard.ts 呼叫 verifier.check 時
完全沒傳 task，判斷者拿不到 baseRef 就不會掛上唯讀 git，
於是分不出「這次弄的」與「本來就有的」，把別人先前 commit 的畫面瑕疵
算到這次頭上。上一輪那個「分類錯誤」有解釋了——不是它不查，是那條路上沒東西可查。

· merge-guard 的 attempt() 收 task 並帶給 verifier
· group-runner 呼叫時把 baseRef 一起帶上

順帶：判斷者的工具清單漏了 Grep（唯讀，它本來就該有），
實跑時它去查程式碼被自己的新閘門擋下。已補。
（閘門本身是對的——同一批紀錄裡它正確擋下了 Bash。）

測試：merge-guard 任務資訊透傳 1 條、Grep 放行 1 條。1695 全綠。




---

## fix: rebase 後更新自己的 PR（force-with-lease），不再死在 non-fast-forward

實跑撞到：群組開了 PR 之後又要重做時，Merge Guard 會 rebase 到最新 base
（改寫歷史），接著 push 必然 non-fast-forward。而分支上有開著的 PR，
先前的邏輯一律拒絕 → 群組直接 failed。

但那是每個開發者 rebase 後更新自己 PR 的日常，不是異常。我先前把
「絕不 force push」執行得過頭了——該禁止的是**蓋掉別人的東西**，
不是「更新自己的 PR」。

改用 --force-with-lease：只有遠端還停在**我們上次 fetch 到的那顆 commit**
時才覆寫，中間只要有人推了東西就中止並報錯。裸 --force 仍然永遠不用。

測試：force-with-lease 更新既有 PR 1 條、lease 失效時中止 1 條，
並保留「不可裸 force」的斷言。1697 全綠。




---

## fix: 合併路徑的兩個死結——判斷者沒 git、合併工作區占住分支

實跑第 9 輪，核准之後死在兩個地方：

① 合併路徑上還有第二個 Merge Guard 呼叫點（orchestrator.ts），
   同樣沒傳任務資訊。我上一個 commit 只修了 group-runner 那個。
   結果：這一關的介面判斷者沒有 baseRef → 沒有唯讀 git → 分不出新舊問題
   → 把既有瑕疵算到這次頭上，擋掉一個已經核准的合併。
   log 直接寫著「判斷者工具使用（**沒查 git**）」——新加的觀測一眼看出來。

② 守衛把合併工作區檢出到群組分支後就停在上面，占住了那條分支。
   git 不允許同一條分支同時被兩個 worktree 檢出，於是群組要重做時
   任務 worktree 建不起來：
     fatal: 'orch/...' is already used by worktree at '.../merge-worktrees/live'
   整組直接 failed。

   釋放的動作放在 orchestrator 而不是 MergeGuard：group-runner 是在**任務
   worktree** 裡跑守衛，那裡切回 base 會讓後續的 commit／開 PR 跑在 base 上，
   是更嚴重的錯誤。誰擁有工作區，誰負責收尾。
   （我一度把它寫進 MergeGuard，被既有測試擋下來——那批測試是對的。）

測試：釋放分支 2 條（通過與擋下都要釋放），做過反向驗證。1698 全綠。




---

## fix: browser_find 是唯讀工具，不該被閘門擋下

跟先前的 Grep 同一類疏漏：我在建強制白名單時，只把「明顯要用的」列進去，
漏掉了唯讀的頁面搜尋工具。實跑時 agent 想在畫面上找元素被自己的閘門擋下。

閘門本身是對的（同一批紀錄裡它正確擋下了 Bash），問題是白名單建得不夠完整。




---

## fix: 第三個漏傳任務資訊的呼叫點，改用 taskHintOf 集中組裝

重做迴圈的 verifier.check 只傳了 { id, category }——沒有 baseRef、沒有標題描述。
於是那一關的介面判斷者又沒有唯讀 git，log 直接寫著「沒查 git，分不出新舊問題」。

同一個疏漏這是第三次：
  ① group-runner 的 Merge Guard（完全沒傳 task）
  ② orchestrator 的合併路徑（同上）
  ③ 重做迴圈（只傳了兩個欄位）

三次症狀一模一樣、一樣難查。這不該靠人記得，所以：
· 新增 taskHintOf(task, proj) 一次組好完整的 hint，呼叫端不再自己拼欄位
· VisualTaskHint 的註解寫明每個欄位漏了會怎樣（都是靜默降級，不會報錯）

測試 3 條。1701 全綠。




---

## fix: reviewer 看不到人拍板的決定，會把解決過的問題重新退回

實跑撞到：規格明寫「主題要不要一併重設**沒有定論**」，agent 用 ask_human 問了、
人回答「不要，那是跨頁面偏好」、agent 照做——結果 reviewer 退回，理由是：

  「屬於必須先向需求方確認、由需求方拍板的開放問題，不該由實作端自行決定。
    實作直接單方面選了其中一種做法…讓一個規格明列為『未定且不可逆』的決策被靜默地定案」

reviewer 說得沒錯，就它看得到的東西而言——它只拿到規格與 diff，
**看不到人的答覆**。於是一個已經有答案的問題被重新提出來，白費一輪；
最壞情況三輪用完交人，而人只會困惑「我不是回答過了嗎」。

· human-reply 新增 settledDecisions()：讀出這個任務歷來所有已裁決的問題（不消費）
· reviewer 的 prompt 帶上這些決定，並明講「照這些決定實作是正確的，
  不要因為『規格沒寫』或『規格說沒定論』而回報違規」
· ReviewerLike 契約加上 opts.decisions

測試 2 條。1703 全綠。




---

## fix: 合併工作區消失後不會重建，之後每次合併都倒

合併工作區只在啟動時建立一次。它一旦消失（清理腳本掃掉、磁碟工具刪掉、人手動 rm），
daemon 永遠不會重建，之後每一次合併都倒在

  fatal: cannot change to '.../merge-worktrees/live': No such file or directory

被判成 precondition_failed → 群組 failed。而錯誤訊息完全看不出根因，
更看不出「這跟程式碼無關」。實跑撞到——我自己的清理腳本刪掉了它。

ensureMergeWorkspace 本來就能處理「登記還在但目錄不見了」（prune 後重建），
缺的只是「在用之前再問一次」：
· resolveProject 每次都確認工作區還在，不在就本輪不合併並觸發重建
· 錯誤訊息明講「已核准的憑證會保留，不必重新核准」——否則人會白跑一趟

測試 2 條（在／不在）。既有的 createMergePipeline 測試改成用真實存在的暫存目錄，
因為 resolveProject 現在會確認。1705 全綠。




---

## fix: 沒人看得到的失敗，比失敗本身更糟

實跑撞到：一個群組 failed 了半小時，控制台的待處理清單是空的。
系統悄悄放棄了一批工作，而沒有任何介面顯示這件事。

原因：待處理清單只列「重新派工已達上限」那一種 failed 群組
（）。其餘全部靜默——
執行中擲出例外、前置條件不成立、合併工作區不見、建 worktree 失敗……
都停在 failed，而 CLI、控制台、Slack 提醒三個介面一致地回報「沒事」。

改成任何 failed 群組都列出來，並帶上最後一則失敗原因的第一行
（merge_guard_blocked / worktree_create_failed / group_failed）。
連原因都沒留下時明講「請看 log」，而不是給一個空白的項目。

測試 3 條，做過反向驗證（退回  → 立刻變紅）。1708 全綠。




---

## fix: failed 群組救不回來——待處理清單提供的 retry 是空操作

上一個 commit 讓 failed 群組浮出來了，但它提供的唯一動作 retry
做的是 clearBlock(taskId, 'queued')——對「任務都 done、只是收尾失敗」的群組
完全無效。而那正是最常見的 failed 形態（Merge Guard 擋下、開 PR 失敗、
合併工作區不見）。實跑撞到：按了 retry，什麼都沒發生，群組永遠躺在 failed。

**提供一個沒用的動作，比不提供更糟**——人以為處理過了，實際上那批工作還躺在那裡。
而且 failed 是死路這件事，會讓「自主運行」在第一次失敗就結束。

· InboundRouter.reviveGroup()：把 failed 的群組轉回 ready 讓 Dispatcher 重新派。
  任務維持 done，所以 agent 不會重跑，只走收尾流程——那正是失敗的地方。
· CLI 與控制台的 retry 對 stuck_group（群組 id）改走復活，其餘維持原行為。
· 復活失敗要回報失敗，不能假裝成功。

測試 3 條。1711 全綠。




---

## fix: 政策說可以自動合併的 PR 反而永遠卡住

實跑撞到：PR #26 是純 README 變更，政策判定「安全、可自動合併」，
卻停在 pr_open 不動。

原因：政策放行但 PR 已開時，程式一律「交給 PR 合併路徑」然後停住——
而那條路徑等的是 GitHub 上的審查事件。單人專案根本產生不了那種事件
（GitHub 不允許核准自己的 PR），於是一個「不需要人」的 PR 卡在等人，
跟政策放行的意義完全相反。

原本的顧慮（本地合併會留下孤兒 PR）是成立的，但解法是**合併那個 PR**，
不是不合併。新增 mergeOpenPr：走 gh pr merge，approvedBy 標成 policy:auto_merge
（合併永遠要說得出是誰批准的），順便刪掉來源分支。

allowLocalMerge=false 時維持停在 pr_open——合併是需要明示同意的外部動作，
政策放行不能取代那個同意。

測試 3 條，做過反向驗證。1714 全綠。




---

## fix: 政策比的基準跟 Merge Guard 不一致，自動合併能力被廢掉

實跑撞到：一個**只改 README（+95/-0）**的 PR，政策判定
  「存在非純樣式/文件變更：useViewportWidth.js, formatTime.js, SandboxView.vue」
那三個檔案是**上一群剛合併的**，跟這個 PR 無關。

原因是兩邊比的不是同一個東西：
· Merge Guard 會 fetch 並 rebase 到 **origin/main**
· 政策讀 diff 卻用本地的 **main**，而本地 main 從沒被更新過
  （daemon 只 fetch，不會 checkout main），而且用的是兩點 diff

於是只要 main 動過，任何群組的 diff 都會混進「main 有但我沒有」的檔案——
也就是別人剛合併的東西。後果是政策的自動合併能力整個被廢掉：
每個 PR 都被判成需要人工核准，而理由指向一堆它根本沒碰的檔案。

resolveDiffBase：優先用 remote-tracking 的三點形式
（三點比的才是「這個分支相對分岔點做了什麼」）。取不到就退回原本行為，
離線或無 remote 的 repo 照樣能跑；'HEAD' 與已含 .. 的 ref 原樣使用。

測試 3 條。1717 全綠。




---

## feat: agent 的「這個系統擋到我了」回報出口

今天好幾個真 bug，是從 agent **順口說的話**裡撿到的：
· 「AppModal 被 teleport 到 body 之外，就算補 dark: 也不會生效」
  → 才知道那是 CSS 作用域問題，補 variant 沒用
· 「這個決策缺乏可查證出處」
  → 才發現 reviewer 看不到人透過 ask_human 拍板的決定
· 「規格的前提與實測結果不符，實測 5.55:1 已通過門檻」
  → 才知道是我的規格寫錯，不是它做錯

那些全都是**碰巧被讀到**的。沒讀到的洞察就消失了。

· src/worker/friction.ts：report_friction 工具。分類（系統限制／規格問題／
  關卡誤判／關卡漏抓／流程建議）＋ 一句話 ＋ **證據** ＋ 建議 ＋ 有沒有實際擋住。
· 寫程式的 agent 掛在既有的 ask server；判斷者用獨立的 friction server
  （它沒有 ask server）。source 標記讓彙總時分得出是誰回報的。
· CLI `npm run ask -- friction` 與控制台 /api/friction 列出彙總。

三個刻意的設計：
1. **工具說明明講「不影響本任務的結果」**。不講清楚的話，agent 會拿它當
   「做不完但想交差」的出口——那是 ask_human 與 report_no_change 的職責。
2. **一定要附證據**（檔案行號、指令輸出、量測數字）。沒有證據的抱怨沒有價值，
   維護者無法據以判斷。
3. **只做統計與列出，不做任何自動處置**。這些是自我回報，可能是對的，
   也可能只是它不想做某件事。要不要動程式碼，人看過證據再決定——
   讓 agent 自動改調度器是最容易「靜默地弄壞一切」的方向。

回報寫入失敗只留 warn，絕不影響任務；未知的 kind 退化成 other 而不是讓整筆作廢
（同 ui-judge 的教訓：分類只是給人看的，不該有權力否決內容）。

測試 8 條。1725 全綠、e2e-daemon 通過。




---

## fix: 崩潰對帳的「分支領先幾個 commit」比錯了基準

崩潰恢復實測抓到的：kill -9 daemon 後重啟，對帳把一個 agent **連一行都還沒
commit** 的群組判成「可續（分支領先 5 個 commit）」。那 5 個是 origin/main
領先本地 main 的量——daemon 只 fetch，從來不 checkout base 分支去更新它，
所以本地 main 永遠停在舊的地方，而群組分支是從 origin/main 長出來的。

實測數字：main..branch = 5，origin/main..branch = 0。

這個數字是 reconcileRunningGroup 三條路徑的分岔點（hasCommits）：
· 全 done + 有成果 → 交人工
· 有成果 → 保留分支續做
· 沒成果但有 done 任務 → unrecoverable，保留現場交人工
· 什麼都沒有 → 清乾淨重做
ahead 恆大於 0 的話，後兩條**永遠走不到**——也就是「成果遺失」這種最需要人看的
情況會被靜默地當成「可續」，而真正該清乾淨重做的群組會頂著一個沒用的分支重跑。

同一個坑今天踩第二次（第一次是政策閘門把「上一群剛合併的檔案」算成這個 PR 改的），
所以把「該挑哪個 ref 當基準」收進 base-freshness.ts 的 preferRemoteRef，
policy-engine 的 resolveDiffBase 也改成用它——兩邊不可能再各自飄走。
（與 resolveBaseFreshness 的分工：那個會連外 fetch 並回報但書，用在開工／合併前；
這個純本地解析，用在對帳與 diff 這種只是要挑對參照點的場合。）

測試補 3 條，用**真的 git repo**——上面所有對帳測試的 git 都是假件，
所以「ahead 到底怎麼算」從來沒被驗過。1728 全綠。




---

## fix: 介面判斷者說 ok 之前，至少要真的改過一次視窗尺寸

實跑抓到的：同一份程式碼、同一段提示詞連跑兩次，結論相反。

· DoD 那關：6 個工具呼叫 → status ok，issues 0 → 綠燈放行
· Merge Guard 重跑（rebase 是 no-op，程式碼一模一樣）：78 個工具呼叫
  （其中 browser_resize 6 次）→ 抓到浮動鈕在 640～890px 直接壓在卡片內文上，
  實測 640px 時膠囊寬 112px、left=504，內文欄右緣 591px，重疊 87px 約 6 個中文字，
  並指出成因是按鈕用 right-6 貼 viewport 而卡片是 max-w-2xl 置中

根因不是它判斷錯，是**證據有洞**：專案只設了 390 與 1280 兩個斷點，
中間 890px 完全沒有截圖。判斷者不知道這件事——它拿到的只是一疊圖，
不知道那些圖只涵蓋兩個寬度。深的那次是自己 resize 才看到的。

提示詞裡**早就寫了**「至少要看寬螢幕與窄螢幕兩種」，它照樣沒照做。
所以提示詞不夠，需要程式層的下限。6 vs 78 這種變異下「淺一次」是常態，
而 Merge Guard 用的是同一個判斷者——它淺的時候一樣會放行，沒有第二道防線。

兩件事：
1. 提示詞明講「預截圖只涵蓋 X、Y px，中間完全沒有證據」，並說明 RWD 的問題
   幾乎都藏在這種縫隙裡（固定定位元素壓內容、文字才開始溢出、選單才擠成兩行）。
2. 判定 ok 但**從未呼叫過 browser_resize** → 重問一次，提示詞點名沒看過的區間；
   第二次還是沒看就回 skipped（= 紅燈），不吞下一個涵蓋不到的 ok。
   只重問一次，不無限重試；判定 issues 不重問（那本來就會擋下來，不是靜默放行）。

刻意的邊界：這裡不判斷畫面好不好（那是判斷者的事），只檢查**證據涵蓋了沒**——
跟「視覺關卡被跳過就是紅燈」「沒接判斷者就是紅燈」同一個原則。
這個系統最危險的失敗模式一直是靜默地沒做某件事。

測試 8 條。1736 全綠。




---

## fix: 撞到花費上限後，別把事件表與日誌灌爆

預算上限實測：把 dailyUsd 從 20 降到 1（今日已花 $5.03），重啟後正確擋下派工——
任務停在 queued、群組停在 ready、沒有建 worktree、Slack 只通知一次。煞車本身是對的。

但它每輪輪詢都寫一筆 budget_blocked ＋ 一行 WARN。實測 2 分鐘就 8 筆；
15 秒一輪的話，撞到上限之後的剩餘時間就是約 5760 筆一模一樣的紀錄。
事件表是待辦清單與摩擦彙總在讀的地方，日誌是人判斷「它現在正不正常」的地方，
兩邊被同一句話灌爆等於把真正要看的東西藏起來。

· 事件：一個週期記一次。「今天撞到上限」是可稽核的事實，
  「每 15 秒都還在上限」不是。
· 日誌：每 30 分鐘重述一次。不能只講一次就沉默——撞到上限後系統本來就不會有
  任何動靜，日誌裡沒有理由的話，看起來就跟當掉一樣。

去重放在記憶體而非 ledger（跟通知不同）：重啟後多記一筆反而是想看到的，
「重啟時仍在上限」本身就值得留下。

測試 1 條，並確認它在還原成舊行為時真的會紅（3 筆 vs 1 筆）。




---

## fix: 人核准了、系統卻靜默不動——把這條死路變成看得見的失敗

多專案實測抓到的。一個本地專案（openPr=false, allowLocalMerge=true）跑完全部關卡、
政策判定需人工核准，人在 CLI 按了 approve 之後：

  [16:31:01] 從 ledger 取回核准憑證  group=g_7c29f4e10efb by=human:cli
  [16:31:01] WARN 群組已核准，但合併管線未接線（預設關閉），不執行合併

然後就沒有了。群組永遠停在 merge_guard——**不在待辦清單、沒合併、沒失敗**，
而排在它後面的那一群（分群 agent 正確判定 D2-2 要等 D2-1 的新匯出）也就一直等下去。
人按了核准，系統靜默地什麼都不做，而且沒有任何地方看得到。

兩條死路原本都只 warnOnce 就 return：
· 合併管線沒接線（openPr 與 allowLocalMerge 需同時為 true）
· 本地模式沒有 PR 可合併（政策需人工核准的群組，本地模式下沒有自動合併路徑）

改成標 failed ＋ 寫 merge_blocked 事件。標 failed 不是說這批工作壞掉——
它通過了所有關卡——而是「這條路走不下去、需要人決定」。failed 是唯一會進
待辦清單、且帶 retry 動作的狀態。原因寫清楚要去改什麼，並講明分支還在、成果沒掉。
pending 也把 merge_blocked 列進失敗原因的來源。

不合併本身是對的（安全預設要保留），錯的是不合併之後就沒有下文。
這跟先前「failed 群組不出現在任何清單」是同一個教訓：沒人看得到的停滯，
比停滯本身更糟。

兩條既有測試鎖的是舊行為（停在 merge_guard），改成鎖新的意圖。1737 全綠。

已知限制（沒在這次修）：本地模式下，政策判定需人工核准的群組即使核准了也
無法自動合併——需要人自己併分支，或改用開 PR 模式。要不要補這條路，
看是否真的需要支援無 remote 的專案。




---

## fix: 前置群沒進 base，後面就該等——放行只會做出建立在假設上的東西

afterGroups 只有在**確實有依賴**時才會有值：分群 agent 判定「B 必須等 A」，
是因為 B 的內容以 A 的成果為前提。原本 isFinished 連 failed 也算「已結束」，
理由是「否則前一階段一失敗，後面就永遠卡死」。那是錯的。

多專案實測的例子就在眼前：demo2 的分群 agent 判定

  D2-2「README 補 API 一覽」只動 README.md，與 D2-1 檔案完全不重疊，
  但內容上要列出「目前所有匯出的函式」，而 D2-1 正好會新增兩個匯出，
  所以必須等 D2-1 完成後才寫得出正確清單。

D2-1 因為合併路徑的問題停在 failed。舊行為會把 D2-2 放行——它會在沒有那兩個
新匯出的 base 上寫一份 README，列出不存在的函式，而且**它自己的 DoD 會全綠**
（README 改動不會讓 build 或 test 紅）。這種錯誤沒有任何一道關卡擋得住。

「永遠卡死」的顧慮現在也不成立：failed 群組會出現在待處理清單並帶 retry，
等下去是**看得見的等**，不是靜默死鎖。把 A 修好，B 自然就動了。

· isFinished 只認 merged（群組記錄整個不見時仍視為結束——那是資料異常，
  不該讓後面的群陪葬）
· 待處理清單的失敗群組加上「還有 N 群在等它進 base：g_xxx」。
  沒有這個數字，人看到的只是一則孤立的失敗，不知道背後停了一整條鏈。
  沒有後續群組就完全不提，不要多一句沒資訊的話。

測試：dispatcher 兩條（沒進 base → 不派；已合併 → 放行）、pending 兩條。1740 全綠。




---

## refactor: 移除 openPr 開關——不開 PR 就沒有審查，那條路本來就走不完

openPr 想給的安全（別動到正式 repo）**已經由專案的 prRepo 提供了**（推到複本，
現在跑的 Baolu sandbox 就是這樣）。它是重複的保險，而代價是一整條走不完的路：

實跑撞到——一個 openPr=false 的專案跑完全部關卡、政策判定需人工核准、
人在 CLI 按了 approve，然後系統找不到任何函式可以合併。群組永遠停在 merge_guard，
連帶把依賴它的下一群一起卡住。而我自己還寫了一條測試把這個死路鎖成「正確行為」
（`本地模式（沒有 PR 編號）→ 不會嘗試合併`，斷言 state 停在 merge_guard）。

現在只剩一個開關：allowLocalMerge（系統可不可以自己合併）。
關掉＝照常推分支、開 PR、跑 Merge Guard，只有最後那一步等人按。
那是唯一不可逆、會改動 base 的動作，值得一道明示同意。

── 順帶刪掉 170 行本地合併程式碼 ──

開 PR 變成必經之路後，「沒有 PR 的本地合併」那條路不可達了。連帶刪掉
mergeAndVerify / mergeLocked / doMerge / revertMerge / restoreRef 與 10 條測試。

要留下的教訓：合併後回頭確認 base 還是綠的、紅燈自動 revert——**那些安全網
只長在不會執行的那條路上**。實際跑的 PR 合併路徑（openPr=true，也就是唯一
真正在用的設定）從來沒有做過合併後檢查。刪掉的是假的安全感，不是真的保護。
真正的缺口（PR 合併後沒人驗 base）另外處理。

刪除範圍：config 的 openPr、環境變數 ORCH_OPEN_PR、externalActionFlags 的欄位、
GroupRunner 的 openPr 分支、控制台的「開 PR」下拉、e2e 腳本的設定。1734 全綠。




---

## feat: 跨批次依賴——讓分群 agent 看得到「還沒進 base」的群組，並在派工前擋一道

任務是一批一批進來的。第一批還沒做完，第二批就進來了——這時如果新任務以舊任務的
成果為前提，現有機制**兩層都接不住**：

1. 分群 agent 是瞎的：它只拿到「這一批的任務」，看不到任何還在跑或已開 PR 的群組。
   它用 Read/Grep 看到的 repo 也**沒有**那些改動。於是它把新任務當成獨立的群直接排下去。

2. 任務層級的依賴閘門開得太早：現有的「依賴未滿足就不給認領」是 MCP 判斷的，
   而 MCP 認定前置任務 done 的時機是 agent 呼叫 complete_task——那時 PR 才剛開。

   A 驗證通過 → complete_task（MCP 說 done）→ 開 PR ──→ 等審查 ──→ 合併
                              ↑                                    ↑
                    B 從這裡就被放行了                    B 真正需要的是這裡
                    （branch 從 base 長出來，裡面沒有 A）

那段空窗就是「PR 開著等你審」的時間，可能好幾小時。B 會在一個沒有 A 的 base 上開工，
做出建立在假設上的東西——而且它自己的 build/test 會全綠，沒有任何一道關卡擋得住。

── (i) 規劃時把在飛的群組給 agent 看 ──
· 列出該 repo 所有「成果還沒進 base」的群組（ready/forming/pr_open/in_review/
  changes_requested/merge_guard/failed），帶狀態、涵蓋任務、動到的檔案、PR 連結。
· 提示詞明講：它們的改動**現在不在 repo 裡**；特別點名 pr_open 與 in_review——
  那些任務在任務板上已經是「完成」，但對新任務來說等同不存在。
· 新增 afterExisting 欄位讓它表達「這一群要等 g_xxx 進 base」。
  這個依賴接到既有的 afterGroups，調度器的等待邏輯**早就寫好了**，
  只是規劃當下從來沒有資訊可以填。
· afterExisting 指到不存在的群組一律當錯誤重問，不默默丟掉——丟掉的話那個依賴
  就永遠不存在，而它正是「B 需要 A 的成果」這種最要命的關係。
· 沒有在飛的群組時完全不提，判準也不多出第 5 條（不要憑空要它填東西）。

── (ii) 派工前的第二道防線 ──
任務宣告的前置任務若落在一個還沒 merged 的群組裡，這一群就先不派。
規劃時沒看出來的、或任務板事後才補上的依賴宣告，都由這裡接住。
同群內部的先後不受影響（同一個工作區依序做，成果直接看得到）；
前置任務不在本調度器範圍內時也不擋（那交給 MCP 的認領閘門，擋久了會升級成 needs_human）。

測試 8 條，並確認「PR 還開著 → 不派」那條在拿掉守衛時真的會紅。1743 全綠。




---

## fix: 階段順序要按 repo 各自算——一個專案的群不該去等另一個專案的群

多專案實跑抓到的。demo2 第二階段的群組，afterGroups 長這樣：

  g_2e3503261604 ｜ afterGroups = ["g_ab9503480878", "g_8ce0f36f0650"]
                                    ↑ demo2 的 D2-1（對）  ↑ Baolu 的群（錯）

規劃是每個 repo 各自做的，階段編號只在該 repo 內部有意義。但建群時
previousStage 是跨 repo 共用一份的，於是 demo2 的 stage 1 去等了**所有** stage 0，
包含別的專案的。

後果：一個專案卡住會拖死另一個專案。而且在「前置群只認 merged」之後
（前一個 commit），Baolu 只要有一群 failed，demo2 就永遠不能動。
這一輪剛好 Baolu 兩分鐘就自動合併了，所以沒炸——換個順序就會看到一個
完全查不出原因的停滯。

改成每個 repo 各自追蹤 previousStage。順帶處理階段編號跳號：
repo A 有 stage 0/1/2、repo B 只有 stage 0/2 時，中間那階段沒有 B 的群，
不能把 B 的 previousStage 覆寫成空的，否則 B 的 stage 2 就不會等 B 的 stage 0。

測試 2 條，並確認「不等 B 專案」那條在還原成跨專案共用時真的會紅。1745 全綠。

── 這一輪多專案實跑的其他結果 ──
· 兩個專案（Baolu：Vue + 視覺關卡；orch-demo2：純工具庫、無 UI）同時登錄、
  各自的 MCP、各自的 worktree 與分支命名空間，互不干擾
· Baolu 的 LIVE-25 走完**完整閉環且全自動**：做完 → PR #33 → Merge Guard →
  政策放行（純文件）→ 自動 squash 合併，全程無人介入
· demo2 的 D2-1 改了 src/units.js，政策判定需人工核准，停在 in_review 等人
· D2-2 正確地停在 ready 等 D2-1 合併（分群 agent 判定它要列出「目前所有匯出的
  函式」，必須等新增匯出的 D2-1 進 base）




---

## refactor: 拿掉政策引擎——它在猜別人的 repo 長什麼樣，且在替使用者決定風險

原本「這個 PR 要不要人工核准」是一個規則引擎判的：比對檔案路徑，命中
`**/migrations/**`、`.github/workflows/**`、`**/*.rules` 之類的 glob 就轉人工，
其餘（純樣式/文件）自動合併。

兩個問題：

1. **它在猜別人的 repo 長什麼樣。** 換一個把 migration 放在 `db/schema/`、用別的 CI、
   或根本沒有 `.rules` 檔的專案，就同時做錯兩件事——該擋的沒擋、不該擋的亂擋。
   secrets 那組更是裝飾品：只抓得到「檔名叫 .env」，而真正會發生的是
   「把 API key 貼進 src/config.ts」。何況 agent 本來就碰不到 .env
   （PreToolUse hook 的硬邊界），那些 pattern 攔的是一個不會發生的情況。

2. **它在替使用者決定風險容忍度。** 「這個改動值不值得問你」本來就是使用者的決定。

改成一個開關 ＋ 一個看得懂那個 repo 的判斷者：

    自動合併 關 → Merge Guard 過 → 開 PR → 等人核准 →（合併佇列）合併
    自動合併 開 → Merge Guard 過 → 開 PR → 風險判斷者看過 → 合併

風險判斷者（merge-risk-judge.ts）只在開關開著時跑，只問一個問題：
**這個改動要是做錯了，救得回來嗎？** 它有唯讀 git 工具，看得到實際的 diff 與 repo 結構，
判準寫的是**後果**不是目錄名——「同樣叫 migration 的檔案，在這個專案裡可能只是一段
還沒被執行的 SQL，也可能一合併就會被 CI 自動套用到正式資料庫，你要看得出差別」。
判不出來、呼叫失敗、沒認證一律回「要問人」：無法確認安全 ≠ 確認安全。

── 順帶修好一個矛盾 ──

合併管線原本也被 allowLocalMerge 關掉。那造成：開關關著時每個群組都停在 in_review
等人核准，人按了核准卻沒有東西可以執行合併——直接走進死路。
開關的意思是「要不要等人」，不是「要不要有合併能力」。管線改成永遠接線，
把關的是**逐次**的核准憑證（人在 Slack/CLI 按的，或 GitHub 上的審查通過），
比一個全域開關精確。

同樣地，核准後的合併路徑不再重跑政策：GitHub 上的 approve 就是一個人看過並同意了，
再拿一組寫死的路徑規則去否決他，只是把「誰能決定」從人手上搶回程式手上。

── 保留的 ──

工具層的硬邊界完全不動：agent 碰不到 .env、.git/、跑不了部署指令，
那是 PreToolUse hook 在工具執行前 deny 的，不是提示詞、也不是事後判斷。
policy-engine.ts 只剩讀 diff（readDiffStat）與 glob 比對（matchGlob，那個硬邊界在用）。

淨刪：政策分類 239 行、config 的 autoMergePolicy、6 個測試檔的相關斷言。
新增：merge-risk-judge.ts ＋ 14 條測試。1730 全綠、e2e-daemon 完整通過。




---

## feat: 同 repo 的合併序列化，並在合併前確認 base 沒被外部動過

Merge Guard 的保證是「rebase 到**最新的 base** 上重跑完整驗證」。那個保證只有在
「驗的 base ＝ 合併落地的 base」時才成立。中間只要有別的群先合併進去，
最終落地的組合就沒有人驗過——而那正是語意飄移最容易溜過去的縫隙
（文字衝突 GitHub 自己會擋，「我依賴的函式被別人改掉了」不會）。

它壞掉的方式特別難查：下一群的守衛會撞到紅燈，但帳會算到**下一群**頭上，
無辜的那群被退回重做，真兇已經在 base 裡了。

── 兩層，角色不同 ──

**1. repo 鎖（正常情況的機制）**

從 Merge Guard 到合併為止，同一個 repo 一次只有一群。鍵是 repo：
**不同專案完全並行**，只有同一個 repo 的群互相排隊。

為什麼不是「合併前發現 base 變了就重跑」：那會退化成 O(N²)——三群同時完成，
G1 合併後 G2、G3 都要重跑，G2 合併後 G3 又要再跑一次，而守衛是整套裡最貴的操作
（實測分鐘級）。序列化則是每群剛好跑一次，且每次驗的都是它真正會落地的 base。
對著會變動的 base 做驗證，本質上就是序列的。

代價是同 repo 的守衛不再並行——但那本來就不該並行（三份 build+test+瀏覽器
同時跑在一台機器上，本身就是互相拖慢與搶埠的來源）。

合併佇列用 **try-lock** 而不是排隊：它是在主迴圈裡 await 的，排隊等一個正在跑
守衛的 worker 會把輪詢、規劃、派工、提醒整個卡住好幾分鐘。下一輪（15 秒後）再試。

**2. base SHA 比對（鎖看不到的情況）**

鎖只管得住我們自己。人在 GitHub 網頁上按合併、或別的工具動了 base，鎖完全不知道。
所以守衛通過時回傳它驗的那顆 commit，兩條合併路徑在真的合併之前各自再讀一次比對：
不一樣就不合併、記 base_moved 事件，下一輪重跑守衛。

自動合併那條退回 changes_requested 重跑；人核准那條**不作廢憑證**——
人的核准仍然有效，只是要對著新的 base 重驗一次。
讀不到 remote 狀態（離線、無 remote）就不亂擋。

測試：repo-lock 6 條（含「不同 repo 完全並行」與「try-lock 拿不到就不執行」）、
守衛回傳 baseSha 1 條、orchestrator 的 base 比對 3 條，並確認關鍵那條在停用檢查時
真的會紅。1734 全綠、e2e-daemon 完整通過。




---

## refactor: 移除 prRepo——它是為了一個不該存在的情境而生的陷阱

prRepo 把「任務板說的 repo」和「PR 實際開到哪」拆成兩個欄位。它存在的唯一理由是
「用**正式專案**的任務板，但別動到正式 repo」。

但那個需求本來就該用「測試用的任務板 ＋ 測試 repo」解決——任務板既然是測試用的，
任務裡的 repo 想寫什麼就寫什麼，直接指向測試 repo 就好。多這一層對映換不到東西。

而留著它是個陷阱：repo 設對了、忘了設 prRepo，`gh pr create --repo` 就直接把 PR
開到正式專案。一個「保護你」的欄位，漏設的後果正是它要防的事故。

移除範圍：config schema、ProjectRuntime、MergeProject、GroupRunner 開 PR 與合併、
Orchestrator 合併、ReviewWatcher 的 resolvePrRepo 對映（PR 一定在 group.repo）、
控制台的「PR 目標 repo」欄位。

順帶把測試用的 live 專案改成誠實的設定：repo 直接寫 cjo4m06/Baolu-orch-sandbox
（本地 clone 的 origin 本來就指那裡），不再假裝自己是 cjo4m06/Baolu。
順序上先改設定再刪欄位——反過來的話會有一瞬間 PR 指向正式 repo。

1731 全綠、e2e-daemon 完整通過。




---

## fix: CLI 對 stdio 任務板永遠連不上——confirm / reject 這條路是死的

實跑撞到：agent 正確地回報「這個任務的前提不成立」（我把任務寫錯了，要求
「README 目錄加一行」但那個 README 根本沒有目錄），待處理清單也正確列出來了，
但按 confirm 就一句：

  ❌ 無法連上任何 MCP，無法執行 complete_task。

原因是 CLI 自己拼了一份 MCP 設定：

  { url: '', token: '', label: p.id, stdio: { command, args, env } }

而 McpClientConfig **根本沒有 stdio 這個欄位**——stdio 是用 createTransport 注入的
（見 main.ts 的 mcpTransportFactory）。那個物件會被當成「連 url='' 的 HTTP」，
於是對**任何 stdio 任務板**都必定連不上。

後果是「無需改動」這個出口整個失效：agent 停下來問，人卻回答不了，任務永遠 blocked。
而錯誤訊息又很誠實地說「請檢查設定與網路」，看起來像環境問題、不像程式錯——
所以它可以一直錯下去沒人發現。

改成用 daemon 同一個 createMcpClient。第二份實作本來就沒有存在的理由，
兩份各自演化的結果就是這樣。

測試補一條真的去連 stdio MCP（mock-mcp-server）的，並確認它在還原成舊寫法時真的會紅。
1732 全綠。

順帶：CLI 的 confirm 有不可逆警告與 yes/N 確認，那個行為不變。




---

## fix: 測試與正式共用同一份資料目錄——分 profile 的只有資料庫，其餘全混在一起

原本只有 ledger 與鎖檔分 profile：

  分開 ： data/daemon.db     vs  data/test.db
          data/orchestrator.lock vs data/test.lock
  共用 ： data/worktrees  data/merge-worktrees  data/browser-tmp
          data/screenshots  data/backups  data/repos

於是跑一次測試就把 worktree 建進正式那份目錄，截圖與備份也混進去。
事後分不出哪些是真的，要清理也不敢下手。

而且我自己就是這樣搞混的：**正式庫裡躺著一個我為了測試加的專案**
（repo=cjo4m06/Baolu、repoPath 指向我建的 sandbox 複本）。使用者發現時，
那筆設定還因為 prRepo 被移除而變成「PR 會開到正式 repo」的狀態。

改成整個資料根目錄分 profile：

  正式：data/          → data/ledger.db、data/worktrees/、data/backups/ …
  測試：data/test/     → data/test/ledger.db、data/test/worktrees/ …

· bootstrap 新增 dataRoot，ledger 與鎖檔改成掛在它底下（檔名一致，看路徑就知道
  是哪個 profile）。ORCH_DATA_ROOT 可整包指到別處（e2e harness 用）。
· worktreeBaseOf / mergeWorktreeBaseOf / browserOutputRootOf 由常數改成
  dataRoot 的函式，一路傳進 buildPipeline、createMergePipeline、reconcileOnBoot。
· 備份目錄本來就是 dirname(ledgerPath)/backups，自動跟著分開。
· launchd 腳本的 stdout/stderr 也分（否則兩邊互相蓋掉）。

實測兩個 profile 各自開機：ledger、鎖檔、備份路徑全部各走各的。

── 同時做的事（非程式碼）──

依使用者要求清空所有資料庫（正式與測試都是 0 筆），清空前完整備份到
data/backups/pre-wipe-20260801-222542/（正式庫的 GitHub token、Slack、
Claude 認證都在裡面）。現存檔案搬進新結構：測試用的 sandbox 複本、假任務板 JSON、
worktree、截圖全部移到 data/test/ 底下。

1733 全綠。




---

## docs: 專案 CLAUDE.md——開發資料夾的規則寫死在 repo 裡

記憶只在我這邊，換一個 session／換一個人就沒了。這些規則是實際踩過才長出來的，
應該跟著 repo 走：

· 這個資料夾是開發用，一律 ORCH_PROFILE=test；正式服務跑在另一個資料夾
  （理由：正式 daemon 用 tsx 直接讀原始碼，同資料夾的話我改到一半它一重啟就載到壞的，
   資料分家擋不住這個）
· data/ = 正式、data/test/ = 測試，worktree／截圖／備份全部跟著分
· 測試只用 Baolu-orch-sandbox（有 UI）與 orch-demo2（無 UI）兩個 repo
· 測試專案的 repo 欄位絕不可以是 cjo4m06/Baolu——prRepo 已移除，寫什麼就開到哪
· 真實 Baolu 綁 Firebase 部署，絕不執行 deploy 指令（工具層已在 PreToolUse 硬擋）




---

## fix: 控制台截圖拍到設定頁的 token 明文，從 repo 移除

console-settings.png 一直在追蹤中，而它是控制台設定頁的完整截圖——
GitHub PAT、Slack Bot/App Token、Claude Auth Token 與端點全部明文可見。

也就是說就算重開一份乾淨的單一 commit 推上去，照樣會洩。

同一批憑證在 git 歷史裡也有（da7888d 加入、5c390cc 移除）：
.playwright-mcp/page-*.yml 是瀏覽器快照，拍到的正是同一個設定頁，
輸入框的值就寫在 YAML 裡。移除只是讓它離開工作區，歷史仍然保留得到。

· 兩張截圖移出 repo（放到 data/test/scratch/，那層已 gitignore）
· .gitignore 加上 console-*.png / *-settings.png

**這不代表憑證安全了**：它們已經在 git 物件裡，任何拿到這份 repo 的人都取得回來。
必須輪替（rotate）。歷史清理與輪替另外處理。



