# 自主開發調度器 · 設計文件（DESIGN）

> 本檔是**基準規格**。所有實作以此為準；要改行為，先改這份文件再改 code。
> 目的：讓 orchestrator 自動領取多專案 MCP 派發的任務、用 Claude Agent SDK 完成編程、驗證、開 PR、審查後合併，全程可監控、可澄清、可恢復。

---

## 0. 一句話定位

一個**本機常駐的自主開發調度器**（launchd daemon，TypeScript + Claude Agent SDK）：
輪詢多個專案的 MCP 任務 → 智慧分群與排程 → 每任務在隔離 worktree 內由 agent 監督式完成 →
測試/瀏覽器/截圖驗證 → 一群任務完成後開一個 PR → 人在 GitHub 審查、在 Slack 互動 → 合併守衛把關後合併。

---

## 1. 核心約束與決策記錄（不可飄移）

| # | 決策 | 理由 |
|---|------|------|
| D1 | **MCP 只透過它公開的 `handler__*` 工具存取**，不改 MCP server 原始碼 | MCP 有其他使用者在用 |
| D2 | `start_task` = 認領（原子、且 MCP 會檢查依賴完成與指派） | 省去自建分散式鎖 |
| D3 | `complete_task` = **實作+驗證通過後、開 PR 之前**呼叫（bug 類帶 `summary` 修復報告，其餘不帶） | 下游任務靠上游 `done` 才能 `start_task`；不能拖到合併後，否則依賴鏈卡死 |
| D4 | MCP 只有 `todo/in_progress/done` 三態，裝不下細狀態；**細狀態機由本機 SQLite ledger 維護** | MCP 無法回寫細狀態，也沒有「反 done」工具 |
| D5 | **一個 group = 一條分支 = 一個 PR** | 對映需求「完成一群就發 PR」 |
| D6 | 群內任務依**真實排序**（見 D8）commit 到同一分支；**並行只發生在群與群之間** | 避免群內多 agent 同寫一分支互踩 |
| D7 | 群間並行**需檔案足跡不重疊**才安全；重疊 → 序列化 | 兩群動同一批檔會衝突/語意飄移 |
| D8 | Planner 讀**任務內容 + 檔案足跡**自行判斷分群與排序；MCP 的 `dependencies` **只當順序提示、可能不完整**（有隱性依賴、也可能該用相似性分群） | 需求：不完全相信宣告依賴 |
| D9 | **Planner 是吞吐量最佳化，不是正確性保證**；就算分群/並行判錯，由 **Merge Guard**（rebase+重測+語意飄移）在合併時兜底 | 讓「判斷可能出錯」變成可接受 |
| D10 | **不設 turn 上限、不設 token 預算上限**；agent 跑到 DoD 綠燈為止 | 使用者明確要求（避免撞到武斷數字就放棄） |
| D11 | **無進展偵測 = 結果簽章連續 N 輪沒改善；只通知 Slack、不中止任務** | 抓卡牆/空轉但不誤殺「慢但真的在前進」 |
| D12 | **Slack 是人機介面層**（Socket Mode + Bolt）：全生命週期通知 + 中途澄清 + 合併核准 + 控制指令；**一任務一 thread** | 本機無公網 ingress，Socket Mode 不需對外開埠 |
| D13 | **GitHub PR 只作 code review 面**；Review Watcher 把 PR 事件鏡射回 Slack thread | 各司其職 |
| D14 | **完成 = 機器可判定的 DoD 綠燈**，不是 agent 自稱「做完了」 | agent 自報不可信 |
| D15 | **證據不完整時一律不做破壞性決策**：對帳拿不到 MCP 證據、狀態判別不了時，保留現場（worktree／分支／未提交成果）並標記待人工，絕不刪除 | 網路抖動不該讓 agent 辛苦寫好但未 commit 的成果被 `rm -rf` |
| D16 | **每個非終態都必須有消費者**；新增 GroupState 時必須同時指定「誰寫入、誰推進、崩潰後誰恢復」 | 狀態黑洞會讓任務與 worktree 永久遺失（已發生過：`merge_guard`／`changes_requested` 無人消費） |
| D17 | **合併需要「核准憑證」（approvedBy），狀態不等於核准**。憑證只由 GitHub approved 事件或人在 Slack 的裁決產生；崩潰殘留的 `merge_guard` 狀態不算核准 | 合併不可逆；「狀態是 merge_guard」也可能只是上次跑到一半留下的 |
| D18 | **誤殺比漏抓更會拖垮系統**。每加一道檢查，必須同時設計「合法例外的出口」並測試它 | 檢查誤判會強迫 agent 做錯事——例如 DoD 的「diff 非空」逼 agent 為了通過驗證而亂改程式碼（出口見 §7b） |
| D19 | **降級只適用於「環境缺件」，不適用於「執行期出錯」**：缺瀏覽器/缺 token → 跳過並標明；程式本身丟例外 → 判紅或通知，絕不靜默變綠 | catch-all 把例外變成 ok 是「誤判為成功」的放大器 |
| D20 | **靜置期以專案（MCP 任務板）為單位**：該任務板最後一次新增/編輯任務要滿 N 分鐘（yaml `quietPeriodMinutes`，預設 15、0 = 關閉）才准分群。被擋的任務**留在 discovered**，不改狀態 | 人建立同系列任務有時間差；抓到一半就開工 = 半成品功能 + 兩個互相依賴又看不懂的 PR。被擋不是錯誤，是等待，所以不能標成失敗 |
| D21 | **每一次 agent 執行都要留 `task_id ↔ session_id` 與用量**，含完全沒有人機互動的那些 | 事後查「這個任務當時做了什麼」唯一的對照鍵就是 session_id；只記互動的話，最正常的任務反而查不到。成本歸屬也只有這裡拿得到 SDK 的實際數字 |
| D28 | **核准憑證要落在 ledger，不能只放記憶體**（D17 的補充） | 只放記憶體時三條路都壞、而且壞得很安靜（人以為核准了）：CLI 是另一個行程、獨立控制台同理、daemon 重啟則整批消失。D17 本身不變——憑證仍是明確寫下的一筆事件，不是從 merge_guard 狀態推論；另有作廢事件抵銷，否則一次核准可以合併兩次 |
| D26 | **花費上限只擋「派新工作」，不砍進行中的**。日/週/月三檔，警戒線提早通知，同一週期只通知一次（去重鍵在 ledger ⇒ 跨重啟有效） | 系統刻意不限制單次執行的 turn／token（D10），代價是沒有東西會自己踩煞車。砍進行中的那一輪等於把已經花掉的錢丟掉還留下半成品；停「再派新的」最多超支一個群組的量，而且停在乾淨狀態 |
| D27 | **正式與測試各一份資料庫**（ORCH_PROFILE，預設 prod） | 跑一次 e2e、開一次 --once 除錯，都會在正式 ledger 留下事件甚至群組；那些垃圾會混進成本統計與對帳判斷，而且事後分不出來 |
| D25 | **開工前也要確認 base 是最新的**，不是只有合併前。取不到最新版一律降級成本地 base + 但書，不讓「連不到網路」變成「整群做不了」 | 本地 clone 停在三天前的話，agent 會在過期的程式碼上實作——重做別人做過的東西、對著已被改掉的 API 寫、驗證全綠卻一 rebase 就爆。這種問題要到 PR 階段才發現，整群的工都要重來。判斷邏輯與 Merge Guard 共用一份（兩份實作遲早分歧，而分歧的症狀是「守衛說 base 最新，agent 卻在舊碼上做」）|
| D23 | **設定的事實源是 SQLite，不是設定檔**；只有 `ledgerPath`／`lockPath` 來自環境變數 | 控制台要能改設定且立刻生效。改寫 YAML 很脆弱（註解／順序／引號），而且檔案只在啟動時讀一次——寫完還要重啟的話，控制台只是一個很貴的文字編輯器。密鑰放 DB 與放 .env 保護等級相同（`data/` 已 gitignore）；「設定檔會被複製貼出」這個理由對 DB 不成立 |
| D24 | **讀取端一律走 ProjectRegistry，不留快照**；`sources`／`intervalSec`／併發上限都可以是函式 | 留快照的地方就是熱重載失效的地方，而且失效得很安靜：控制台顯示「已儲存」，daemon 照舊輪詢舊清單 |
| D22 | **人的回覆必須注入 prompt 並 resume 原 session**，且同一則只用一次（消費標記） | 只把答覆寫進 ledger 而不送回 agent，等於答案丟進黑洞：agent 會再問一次同樣的問題，形成「問→答→再問」的循環，每圈都真的在燒錢。resume 失敗（session 過期）降級成全新 session，不讓那一輪報銷 |

---

## 2. 全景架構（分層）

```
LAYER 0 · 外部    MCP-A  MCP-B ...      GitHub(PR·Review)      Claude API
                   │ poll(handler__*)     │ REST/GraphQL          │ Agent SDK
LAYER 1 · 調度器常駐服務 (launchd · Node · TypeScript)
   ① Poller ─▶ ② Planner ─▶ ③ Dispatcher ─▶ ④ Worker Pool
   (輪詢·去重)  (分群·排序圖)  (併發·足跡衝突)   (監督式完成任務)
   ⑤ PR Manager  ⑥ Review Watcher  ⑦ Merge Guard  ⑧ Policy Engine  ⑨ Observability
LAYER 2 · 狀態與設定   Task Ledger(SQLite)  Project Registry  Secrets/Env  Cost Log(僅記錄)
LAYER 3 · 隔離工作區   git worktree #1   worktree #2 ...  (每群獨立分支/目錄)
```

---

## 3. 主控迴圈

```
每 N 秒一輪：
 1. Poll 所有專案 MCP（list_repos → 對 git remote → list_tasks({repo, mine, status:todo}))
 2. 去重/冪等：key = task.id + payloadHash，比對 ledger
       新任務 → 寫入 discovered ；已完成/進行中 → 略過（MCP 會重派，靠這擋）
 3. Planner：讀內容 + 檔案足跡 → 分群 + 真實排序圖（並行/序列）
 4. Dispatcher：群間並行（足跡重疊者序列化），派給 Worker
 5. Worker（每群，群內依真實排序逐一）：
       start_task → read_doc(所有 docRefs) → 監督迴圈(agent→DoD→回饋) → complete_task
 6. 全群 done → PR Manager 開一個 PR（豐富內文 + 截圖）
 7. Review Watcher：approved → Merge Guard；changes_requested → 回步驟 5 改
 8. Merge Guard：rebase 最新 main → 重測 → 語意飄移檢查 → 合併 → 合併後 CI（紅 → 自動 revert）
```

---

**每一段都要在控制台看得見**（activity 表）。花時間最久的幾段——規劃 agent 讀完整個 repo
再分群（實測單次 6 分鐘）、reviewer 審查、介面判斷者量版面、合併把關比對 diff——期間
ledger 完全靜止：任務狀態沒變、群組狀態沒變、事件表沒有新列。沒有 activity 的話，
畫面與「平台掛了」完全一樣（使用者實際回報：「我以為整個專案都在停擺」）。
同理，整輪失敗要寫 `tick_failed` 事件——只寫 log 的話，「閒著」與「每輪都在同一個地方炸掉」
在畫面上長得一模一樣。

---

## 4. 任務層 / 群組層狀態機

```
── 任務層 (MCP + ledger) ──
 discovered → queued ─start_task→ in_progress ─實作→ verifying ─(測試+瀏覽器/截圖)
     │(依賴未完/未指派)                          綠│         紅/歧義│
  blocked:deps                              complete_task    回實作 / blocked:needs_clarification(Slack)
                                                 ▼
                                               done ── 解鎖下游 start_task

── 群組層 (ledger + GitHub) ──
 群內所有 task = done → pr_open → in_review ─(要求修改)→ 改群組分支→更新PR ─┐
                                    │ approved                              │
                                    ▼                                       │
                              merge_guard(rebase+重測+語意飄移) ◀───────────┘
                              綠│               飄移/紅│
                            merged            修正 / failed(Slack 通知)
```

### 4b. 群組狀態語意表（誰寫入、誰推進 — 對映 D16）

`merge_guard` 有兩種語意，混用會導致**重複合併**（曾是真實缺陷），因此必須明列：

| 狀態 | 意義 | 寫入者 | 推進者 |
|---|---|---|---|
| `forming` | 群內任務執行中（暫態，寫入者持有 dispatcher slot） | GroupRunner | GroupRunner；崩潰後由 Reconciler |
| `ready` | **可派工——Dispatcher 的唯一輸入** | Planner／requeue 階段 | Dispatcher |
| `pr_open` / `in_review` | 等 GitHub 審查 | GroupRunner／ReviewWatcher | ReviewWatcher |
| `changes_requested` | 兼作 **park**：等人回覆（審查意見或澄清），可恢復、非終態、**worktree 保留** | ReviewWatcher／GroupRunner | Orchestrator 的 requeue 階段（`shouldRequeueGroup`） |
| `merge_guard` | (a) 暫態：GroupRunner 就地跑守衛（群仍在 running）<br>(b) 待合併：已取得核准，等調度器把關後合併 | (a) GroupRunner (b) 人工核准路徑 | (b) 由 Orchestrator 消費；**靠 `dispatcher.isRunning` 區分**，且必須有 D17 的核准憑證 |
| `merged` / `failed` | 終態 | — | — |

---

## 5. Worker 監督控制迴圈（DoD 兜底）

```
start_task（依賴/指派由 MCP 把關；signal=依賴未到 → 讓它等）
   └ read_doc(所有 docRefs)   ← 未讀不准寫 code
   ┌▶ Agent SDK 編程一輪
   │    │ agent 呼叫 ask_human 工具（不可逆歧義）→ 貼 Slack + park + 釋放 worker
   │    ▼
   │  DoD 關卡（調度器判，非 agent 自稱）: typecheck/lint/test/build 綠? diff 非空? 視覺回歸? docRefs 覆蓋?
   │    │未綠 → 把具體失敗回灌 → 迴圈
   │    │綠 → 獨立 reviewer agent（全新 context）對 docRefs 規格 → 合格 → complete_task
   │  無進展偵測: 結果簽章連續 N 輪沒改善 → Slack 通知(不中止)
   └ 煞車: 只有「無進展通知」與「ask_human 停等」；不設 turn/token 上限
```

**DoD（完成定義，機器可判定）**：typecheck 綠、lint 綠、專案 test 綠、build 綠、diff 非空、
（視覺任務）多斷點截圖產出且視覺回歸在閾值內、docRefs 每段都被涵蓋、獨立 reviewer 判定合規。

實作上的三個關鍵細節（踩過才知道）：
- **「diff 非空」的比較基準是「本任務開始時的 HEAD」**，不是群分支起點——群內多個任務共用
  同一 worktree，前面的任務已被 commit，用群起點當基準會讓「第二個任務沒做事」被誤判成有變更。
  判定要涵蓋未追蹤檔（新增檔案也是變更），並排除 node_modules。
- **failingIds 必須是固定字串**（不可含耗時、像素差百分比等浮動值），否則結果簽章不穩、
  無進展偵測（D11）會失效。
- **合法的零 diff 有出口**（D18／§7b），否則這道關卡會逼 agent 亂改程式碼。

---

## 6. 錯誤處理（三分類）

```
外部呼叫(Claude API / MCP handler / GitHub / git) 出錯：
  transient  429·500·502·503·529·網路逾時 → 指數退避+jitter 重試(有上限)；全域連掛 → 熔斷暫停整池
  permanent  400 參數·401/403 認證          → 不重試，fail + Slack 通知(多為設定/金鑰)
  signal     start_task「依賴未完/未指派」、repo 不符 → 「照做」而非重試（標 blocked / 修正定向）
重試需冪等：complete_task 重送安全；push 被拒(non-fast-forward) → rebase 再推
```

**崩潰恢復（reconciler）**：daemon 重啟時 `list_tasks({mine, in_progress})` ∩ ledger 對帳；
worktree 在且 session 可續 → resume；狀態不明 → **保留現場並標記待人工**（D15）。

- **涵蓋所有非終態**（D16），不只 `forming`：`merge_guard` / `pr_open` / `in_review` /
  `changes_requested` 崩潰後同樣需要恢復決策，否則群組與 worktree 永久遺失。
- **證據不完整就不動手**（D15）：MCP 查不到「這任務是否已 done」時，不可判定 unrecoverable
  並清掉 worktree——那會刪掉 agent 已寫好但未 commit 的成果。多來源聚合時，
  必須能回報「哪些來源查詢失敗」，不能把「查不到」和「確定沒有」混為一談。
- **保留策略**：events / task_iterations / screenshots / 失敗 worktree 都要有上限，
  否則長期常駐會把磁碟撐爆。清理一律保守：只刪明確過期且非進行中的。

---

## 7. 歧義 / 澄清決策樹

```
Agent 卡住/有疑問：
 1. 能從 docRefs/read_doc/search_docs/既有 code 解答？ 是→自解續做
 2. 決定「可逆且低風險」（選型/命名/排版）？
      是→ 選最合理預設，繼續，並在 PR「假設與待確認」欄位標明依據 → 交 review 非同步糾正
 3. 不可逆/高風險（資料/安全/外部副作用）？
      是→ agent 呼叫 ask_human → 狀態 blocked:needs_clarification → Slack 貼「問題+選項+建議預設+理由」按鈕
          → worker 釋放去做別的 → 人回覆 → 注入答案 → resume
          （逾時 T：低風險採建議預設續做；高風險續 park + 再提醒，絕不亂猜）
```

### 7b. 「這個任務不需要改動」的出口（report_no_change）

DoD 有「diff 非空」關卡（防 agent 什麼都沒做也被判完成）。但**合法的零 diff 確實存在**，
沒有出口的話 agent 只會為了讓關卡變綠而亂改程式碼——那比漏抓更糟。
所以要分的不是「有沒有 diff」，而是「零 diff 有沒有理由」：

```
零 diff + 沒說明        → 偷懶/失敗 → 回灌「尚未實作」續做
零 diff + report_no_change → 合法判斷 → 依政策處置（預設 park 等人確認）
有 diff  + report_no_change → 以事實為準，宣告作廢，照常驗證
```

分類：`already_satisfied`（現況已符合）/ `not_applicable`（描述與現況不符）/
`blocked_externally`（缺外部依賴）/ `spec_unclear`（規格不足）。

**預設一律 park 等人確認，不自動 complete_task**（可由 `orchestrator.yaml` 的 `noChange` 覆寫）。
兩個理由：complete_task 不可逆（D4 無反 done 工具）；且「這張卡不用做」本身通常代表
任務板有重複/過時/寫錯的卡，自動標 done 會把這個訊號吞掉。
配套：Stop hook 把 no_change 宣告列為正當收工理由（否則 agent 被 Stop hook 與 DoD 兩頭夾殺）。

---

## 8. Slack 設計（人機介面層）

- **一任務一 thread**：認領時貼「任務卡」root，之後事件都 threaded reply。
- **出站事件**：🟡認領 / 📖讀spec / 🔧迭代（僅重要節點）/ ❓需澄清 / ⚠️遇到問題(4xx-5xx·卡牆) / 📸截圖 / 🚀PR開 / 👀in review·要求修改 / 🔀合併 / 💀失敗。
- **入站互動（Socket Mode）**：澄清用**按鈕（選項+建議預設+我來打字）**；合併核准 `[核准][退回]`；控制指令 thread 內回「暫停/中止/重試/用你的預設」。
- **噪音控制**：只推有意義的狀態轉移 + 提問 + 失敗；例行迭代留 log/dashboard。提問與失敗才 @人。
- **技術**：`@slack/bolt` + Socket Mode（不需公網 URL）；`chat.postMessage`+`thread_ts` 串 thread；`files.uploadV2` 傳截圖；映射 `thread_ts ↔ task_id ↔ pending_question` 存 ledger。
- **App Home（常駐面板）**：頻道訊息幾小時就被洗掉，但「有哪些事在等我／現在跑到哪／花了多少」要天天看。
  `app_home_opened` → `views.publish` 重新取數發佈（不快取，顯示舊資料比不顯示更糟）。
  面板上**只放安全動作**（重試）；不可逆的（確認「不用做」→ complete_task）留在任務卡與 CLI，兩者都有二次確認。
- **`/orch` slash command**：`status`／`cost`／`pending`，ephemeral 純文字。
- **CLI 是對等的第二入口**（`npm run ask` / `-- status` / `-- cost`）：沒設定 Slack 時系統照樣可用，
  而且所有裁決都走同一個 InboundRouter、報表走同一批 formatter——兩個介面不會給出不一樣的答案。

---

## 9. 合併守衛（Merge Guard，語意飄移）

```
approved（且持有核准憑證 approvedBy — D17）→
 (0) 前置：確實 checkout 到群組分支（checkout 失敗 = precondition_failed，
     不可繼續——否則會替一個從未檢出的分支蓋綠燈）
     並 **git fetch 最新 base**：不 fetch 就是拿「本地過期的 base」驗證，
     而真正會發生語意飄移的情況恰恰就是 remote 有新變更 → 假綠燈。
     離線／無 remote → 降級但**必須標明但書**（把假綠燈變成有但書的綠燈）
 (a) rebase 最新 base 進群組分支
       有 CODE 衝突 → agent 嘗試解 → 解不掉 → failed + 通知
 (b) 語意飄移檢查（diff 看不出來的那種）：
       我引用的函式/檔案被別的 PR 刪了？依賴的 API 簽章被改了？共用套件版本衝突？
       手法：在「合併後狀態」重跑 build + test + 關鍵路徑驗證
       飄移/紅 → 退回實作修正
 (c) 全綠 → merge → 合併後對 base 再跑一次 CI；紅 → 自動 revert + 通知（守住 main 不壞）
```

**動到使用者真實 clone 的安全前提**（本地合併路徑）：
1. 工作區必須乾淨（`git status --porcelain` 非空一律拒絕）——否則 checkout 會把使用者
   未提交的變更帶走，紅燈時的 `reset --hard` 會永久刪除它們。
2. 記下原本的分支，**finally 無論成敗都切回去**。
3. 同一個 repoPath 的合併必須**互斥**（涵蓋 checkout→merge→合併後檢查→revert 整段）：
   多群並行時共用主 clone，否則 A 的 revert 會撤銷 B 的合併。
4. merge commit 要**驗證 `parent1 === 自己的 before`**，不能事後 `rev-parse HEAD` 就當成自己的；
   revert 前再驗一次，不符改交人工。

---

## 10. 政策引擎（Policy Engine）

- **自動合併政策**：純樣式/文件類 → 可自動合併；動到 **DB migration / CI 設定 / 依賴變更 / 刪檔 / secrets** → `needs_human` 閘門（Slack 核准）。
- **紅線（PreToolUse 擋）**：`git push -f` 到 main、刪保護路徑、production 部署、改帳單相關 → 一律拒絕。
- 每專案可在 `projects.yaml` 覆寫政策。

---

## 11. 資料模型（SQLite）

```ts
type TaskState  = 'discovered'|'queued'|'blocked'|'in_progress'|'verifying'|'done';
type GroupState = 'forming'|'ready'|'pr_open'|'in_review'|'changes_requested'|'merge_guard'|'merged'|'failed';
type BlockReason= 'deps'|'needs_clarification'|'needs_human';

interface Task {
  id: string; payloadHash: string;              // 去重 key = id + payloadHash
  repo: string; category: 'bug'|'dev'|'design'|'improvement'|string;
  title: string; description: string;
  dependencies: string[];                        // MCP 宣告 → 只當順序提示
  docRefs: string[];                             // "path#section"
  state: TaskState; block?: { reason: BlockReason; detail?: string };
  groupId?: string; attempts: number; lastError?: string; updatedAt: number;
  sourceUpdatedAt?: number;                      // MCP 端最後活動時間（靜置期 D20 用）
}
interface Group {
  id: string; repo: string; branch: string;      // 一群 = 一分支 = 一 PR
  taskIds: string[]; footprint: string[];        // 已排序 / 檔案足跡
  state: GroupState; prUrl?: string; prNumber?: number;
}
interface AgentSession {                         // 一列 = 一個任務在一個 SDK session 上的執行（D21）
  taskId: string; groupId?: string; sessionId: string;
  rounds: number; costUsd: number;               // 多輪累加
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
  models: string[]; status: 'active'|'done'|'parked'|'error';
}
interface Activity {                             // **活的**，不是稽核：開工寫一列、做完刪掉
  id: string; kind: 'plan'|'poll'|'code'|'review_poll'|'merge';
  repo?: string; refId?: string;                 // 對應的 task／group
  title: string; detail?: string;                // 「規劃 14 個任務」／「第 3 輪：跑驗收關卡」
  startedAt: number; heartbeatAt: number;        // 心跳分辨「跑很久」與「daemon 死了」
}
// 另: task_iterations(結果簽章歷史)、clarifications(thread_ts↔task↔問題)、events(audit)
// 加欄位一律走 applyColumnMigrations（CREATE TABLE IF NOT EXISTS 不會讓既有表長出新欄位）
```

---

## 12. 模組介面（契約）

```ts
type McpOut<T> = { ok:true; value:T } | { ok:false; kind:'transient'|'permanent'|'signal'; detail:string };
interface McpClient {
  listRepos(): Promise<RepoInfo[]>;
  listTasks(q:{repo:string; mine?:boolean; status?:'todo'|'in_progress'|'done'}): Promise<TaskBrief[]>;
  getTask(id:string): Promise<TaskDetail>;
  startTask(id:string): Promise<McpOut<TaskDetail>>;            // 依賴未完/未指派 → kind:'signal'
  completeTask(id:string, o?:{summary?:string}): Promise<McpOut<void>>;
  readDoc(t:DocType, file:string, section?:string): Promise<string>;
  searchDocs(q:string, t?:DocType): Promise<DocHit[]>;
}
interface Poller     { pollOnce(): Promise<Task[]>; }                        // 回傳新任務
interface Planner    { plan(pending: Task[]): Promise<PlanResult>; }
interface Dispatcher { tick(plan: PlanResult): Promise<void>; }
interface Worker     { run(group: PlannedGroup): Promise<GroupOutcome>; }
interface Verifier   { check(c: VerifyCtx): Promise<GateReport>; }
interface ProgressMonitor { record(taskId:string, r:GateReport, diffHash:string): { stalled:boolean; rounds:number }; }
interface PrManager  { open(g:Group, tasks:TaskDetail[], p:PlannedGroup): Promise<PullRequest>; update(g:Group): Promise<void>; }
interface ReviewWatcher { poll(): Promise<ReviewEvent[]>; }
interface MergeGuard { attempt(g:Group): Promise<MergeVerdict>; }
interface PolicyEngine { classify(g:Group, tasks:Task[], diff:DiffStat): { autoMerge:boolean; redlines:string[] }; }
interface SlackGateway {
  postTaskCard(t:Task): Promise<string>;                        // → thread_ts
  event(threadTs:string, e:LifecycleEvent): Promise<void>;
  askClarification(threadTs:string, q:ClarificationRequest): Promise<void>;
  postScreenshots(threadTs:string, paths:string[]): Promise<void>;
  onAnswer(cb:(a:ClarificationAnswer)=>void): void;
  onControl(cb:(c:ControlCommand)=>void): void;
}
```

---

## 13. Agent SDK 串接

```ts
// Worker 監督迴圈（每任務）
async function runTask(task: TaskDetail, ctx: WorkerCtx) {
  const claim = await mcp.startTask(task.id);
  if (!claim.ok && claim.kind === 'signal') return park(task, 'deps');
  const docs = await Promise.all(task.docRefs.map(loadDoc));   // 強制讀 spec

  let session: string | undefined, feedback: GateReport | undefined;
  while (true) {
    const r = await agent.iterate({ cwd: ctx.worktree, task, docs, feedback, resumeSessionId: session });
    session = r.sessionId;
    if (r.askedClarification) { await parkForClarification(task, r.askedClarification, ctx.threadTs); return; }

    const gate  = await verifier.check({ cwd: ctx.worktree, task });          // DoD 由調度器判
    const stall = progress.record(task.id, gate, gitDiffHash(ctx.worktree));
    if (stall.stalled) slack.event(ctx.threadTs, { type:'stalled', gate });   // 只通知

    if (gate.green) {
      const rev = await reviewer.check(task, docs, ctx.worktree);             // 全新 context 對規格
      if (rev.ok) break;
      feedback = rev.asGateReport();
    } else feedback = gate;                                                    // 具體失敗回灌
  }
  await mcp.completeTask(task.id, task.category === 'bug' ? { summary: buildFixReport(task) } : undefined);
}

// agent.iterate 內部（SDK query + hooks）
query({
  prompt: buildPrompt(input),
  options: {
    cwd: input.cwd, resume: input.resumeSessionId, permissionMode: 'acceptEdits',
    mcpServers: { project: projectMcp, ask: askHumanTool },   // read_doc/search_docs + ask_human
    hooks: {
      PreToolUse:  [policyGuard],     // 擋 force-push/刪保護路徑/危險指令
      PostToolUse: [auditLogger],     // 稽核 + 空轉偵測
      Stop:        [dodStopHook],     // 想結束前驗 DoD；沒綠 → block+continue
    },
  },
});
```

> SDK option 名稱（`query`/`hooks`/`resume`/`mcpServers`/`permissionMode`）依現行 Claude Agent SDK；
> 實作時對安裝版本核對確切簽章。

---

## 14. PR 內文版型（需求 5）

```
## 做了什麼 (What)            成果
## 怎麼做 (How)               實作方式/關鍵決策
## 架構 (Architecture)        模組/資料流變動
## 畫面設計 (UI)              多斷點截圖 + 設計說明
## 操作形式 (UX)              使用者流程
## 核心關鍵技術 (Key Tech)
## 驗證 (Verification)        test/lint/build + 瀏覽器/視覺回歸結果
## 假設與待確認 (Assumptions) 可逆預設 + 依據（讓 reviewer 快速糾正）
## 涵蓋任務 (Tasks)           T-xxx 清單 + docRefs 連結
```

---

## 15. 建置路線圖

- **M0 骨架**（本階段）：型別契約、config 載入、SQLite ledger、模組 stub、可 build、git init。
- **M1 垂直主幹**：poll → start_task → worktree → Agent SDK 一輪 → verifier(build/test) → complete_task → 開 PR。Planner 先「一任務一群」、Slack 先只出站。
- **M2 監督閉環**：DoD 回灌迴圈、Stop hook、獨立 reviewer、無進展偵測。
- **M3 分群與並行**：Planner 內容+足跡分群、Dispatcher 足跡衝突序列化、群組分支。
- **M4 Slack 互動**：Socket Mode 入站、ask_human、澄清按鈕、截圖、控制指令。
- **M5 合併守衛 + 政策**：Review Watcher、rebase 重測、語意飄移、合併後 revert、政策閘門。
- **M6 韌性**：錯誤三分類重試/熔斷、reconciler 崩潰恢復、observability/dashboard。

---

## 16. 技術選型

- Runtime：Node 24（LTS 系），TypeScript（ESM / NodeNext）。
- 執行引擎：**Claude Agent SDK**（`query` + hooks + resume）。
- Claude 認證：`ANTHROPIC_AUTH_TOKEN`（Bearer）+ `ANTHROPIC_BASE_URL`（自訂端點/gateway），或 `ANTHROPIC_API_KEY`；經 `.env` 載入 `process.env`，SDK 子行程繼承。
- MCP 存取：`@modelcontextprotocol/sdk`（orchestrator 自己當 MCP client 呼叫 handler__*）。
- 儲存：`better-sqlite3`（同步、單機、易備份）。
- Slack：`@slack/bolt` + Socket Mode。
- GitHub：`@octokit/rest`。
- 瀏覽器驗證：`playwright`（多斷點截圖 + 視覺回歸）。
- 其他：`zod`（設定/結構驗證）、`yaml`、`execa`（跑 build/test/git）、`pino`（log）。
- 常駐：macOS `launchd`（開機自啟、掛掉自動重拉）。
```
