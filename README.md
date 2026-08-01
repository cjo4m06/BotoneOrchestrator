# Botone Orchestrator

本機常駐的**自主開發調度器**：輪詢多專案 MCP 任務 → 分群排程 → Claude Agent SDK 完成編程 →
測試/瀏覽器/截圖驗證 → 一群任務完成後開 PR → 人在 GitHub 審查、Slack 互動 → 合併守衛把關後合併。

> 完整設計見 [`DESIGN.md`](./DESIGN.md)。**行為以該文件為準**，決策記錄在 §1（D1–D19）。

## 快速開始

```bash
npm install
cp .env.example .env          # 填 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL
npm test                      # 單元 + 整合測試
npm run console               # 開控制台 → http://127.0.0.1:8787
```

設定全部在控制台裡：**專案**分頁新增專案（MCP URL/token、git repo、本機路徑、靜置期），
**設定**分頁調輪詢週期、併發數、外部動作開關與 Slack。

**沒有設定檔**。所有設定存在 SQLite（`data/daemon.db`），只有兩個值來自環境變數：
`ORCH_LEDGER_PATH`（DB 位置，預設 `./data/daemon.db`）與 `ORCH_LOCK_PATH`。
雞生蛋——設定住在 DB 裡，「DB 在哪」沒辦法從 DB 讀。

改完**不用重啟**：daemon 每輪從 DB 對齊一次專案清單與設定。唯一的例外是 Slack token
（要重連 socket），控制台上有標示。

> 舊版的 `config/*.yaml` 會在第一次啟動時自動匯入 DB，然後改名成 `.imported`。
> 密鑰維持 `${VAR}` 參照不展開，所以不會被複製進 DB。

**密鑰全部存在資料庫**（`data/` 已 gitignore），用控制台管理：MCP token、Slack token、
Claude 認證都是。改完**不必重啟**——MCP token 下一輪重連、Claude 認證下一次 agent 執行就套用。

`.env` 只剩兩個用途：(1) 全新安裝時的方便起點，(2) `${VAR}` 參照的來源。
啟動時會自動把設定裡殘留的 `${VAR}` 換成實際值寫進 DB（解析不出來的維持原樣並警告），
所以搬移一次之後 `.env` 就不是必要的了。**注意 `${VAR}` 的值住在 `.env`，
而 `.env` 只在行程啟動時讀一次——那條路改了要重啟**，控制台會把這種欄位標成黃色邊框。

## 能力現況

| 面向 | 狀態 |
|---|---|
| 多專案 MCP（http / stdio）、輪詢去重 | ✅ |
| 內容感知分群（中文斷詞）+ 真實檔案足跡 + 拓樸排序 | ✅ |
| 併發調度（足跡重疊序列化、主 clone 互斥鎖、單一實例鎖） | ✅ |
| Agent SDK 監督迴圈（DoD 回灌、不設 turn/token 上限） | ✅ |
| DoD 關卡：diff 非空 / typecheck / lint / build / test / 視覺 | ✅ |
| 視覺驗證：多斷點截圖、爆版與歪斜偵測、像素級回歸 | ✅ |
| 獨立 reviewer（全新 context 對規格審查、活鎖保護） | ✅ |
| 澄清出口 `ask_human` + 無需改動出口 `report_no_change` | ✅ |
| Merge Guard：fetch 最新 base → rebase → 重測 → 語意飄移 | ✅ |
| 政策閘門、工具紅線（部署/CI/secrets 保護） | ✅ |
| PR 內文九段（做了什麼/怎麼做/架構/畫面/操作/技術/驗證/假設/任務） | ✅ |
| Review Watcher → approved 合併 / changes_requested 回灌重做 | ✅ |
| Slack：任務卡 thread、澄清與核准按鈕、截圖、入站控制 | ✅ |
| 韌性：三分類重試/熔斷、崩潰對帳、保留策略、優雅停止 | ✅ |

**已驗證**：1092 個單元/整合測試、typecheck 全綠；主幹 e2e（`--dry` 與 live 真 agent）通過；
完整週期含合併已在沙盒 live 驗證（真 agent 依真實 spec 編程 → build → Merge Guard → 合併 → 合併後 build 綠）；
live daemon 曾自主完成連續 4 個真實任務。

## 回覆 daemon 的提問

agent 遇到不可逆的歧義會停下來問你，判定任務不需要改動時也會等你確認。有兩個回覆入口，
**走的是同一套裁決邏輯**（`InboundRouter`），差別只在介面：

**本機 CLI**（不需要 Slack、daemon 沒跑也能先回答）

```bash
npm run ask                         # 列出所有等你處理的事項
npm run ask -- T-1287 固定底部       # 回答澄清（用 id 較安全，清單會隨 daemon 變動）
npm run ask -- 1 --default          # 採用 agent 建議的預設
npm run ask -- T-0442 confirm       # 確認「這張卡確實不用做」→ complete_task（不可逆，會再問一次）
npm run ask -- T-0442 reject        # 你誤判了，回去做
npm run ask -- g_ef84 approve|deny  # 核准／退回合併

npm run ask -- status               # 現在在做什麼（任務／群組／靜置期倒數／受阻清單）
npm run ask -- cost                 # 今天／近 7 天／全部的花費與 token，最貴的任務排行
```

**本機控制台**（`npm run console`，只綁 127.0.0.1）：待辦、進度、成本、專案設定都在這裡，
待處理事項可以直接回答／核准。daemon 在跑時它已內建，網址一樣。

**Slack**（控制台啟用 + Socket Mode 的兩個 token）：一任務一 thread，
點按鈕或在 thread 裡打字都可以。另有 App Home 常駐面板與 `/orch` 指令
（`status`／`cost`／`pending`）。未啟用時自動降級成 console，**此時就只能用 CLI 回覆**。

## Slack 設定（可選，不設也能用 CLI）

daemon 跑在你自己的機器上、沒有對外網址，所以走 **Socket Mode**（daemon 主動連出去），
不需要 ngrok 或任何反向代理。

### 1. 建立 app

到 <https://api.slack.com/apps> →「Create New App」→ 選 **From an app manifest** →
選工作區 → 把 `config/slack-app-manifest.yaml` 的內容整份貼上 → Next → Create。

用 manifest 而不是「From scratch」的理由：權限、事件訂閱、Home Tab、slash command
分散在四個不同頁面，手動勾漏一項的症狀通常是「某個功能靜靜地不會動」，很難查。

### 2. 取得兩個 token

| Token | 去哪拿 | 長相 |
| --- | --- | --- |
| Bot token | 左側 **OAuth & Permissions** → `Install to Workspace` → 授權 → 複製 **Bot User OAuth Token** | `xoxb-…` |
| App token | 左側 **Basic Information** → 捲到 **App-Level Tokens** → `Generate Token and Scopes` → 隨便命名 → 加上 scope **`connections:write`** → Generate | `xapp-…` |

兩個都要。少了 app token 只能出站通知（收不到你的按鈕與回覆），少了 bot token 整個降級成 console。

### 3. 填設定

`.env`（**只放這裡**，設定檔不存明文）：

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

然後在控制台的 **設定 → Slack** 填入（或直接貼 token，或寫 `${SLACK_BOT_TOKEN}` 從 .env 取），
啟用並設定頻道。

### 4. 把 bot 加進頻道

在該頻道打 `/invite @Orchestrator`。**沒加會失敗**：`chat.postMessage` 對沒加入的頻道會回
`not_in_channel`，症狀是 daemon 一直 warn 但頻道裡什麼都沒有。

### 5. 驗收

```bash
npx tsx src/main.ts --once     # log 應出現「Slack App Home 已接線」
```

- 在 Slack 側邊欄點這個 app → **Home** 分頁應出現面板
- 任意頻道打 `/orch status` → 應回一段只有你看得到的狀態文字

想 @ 特定的人（提問與失敗時）：`.env` 加 `SLACK_MENTION_USER_IDS=U123,U456`。

## 端到端 harness

```bash
npm run e2e:cli                      # CLI 人機互動全鏈路（真的 spawn CLI，11 條探針）
npm run e2e:visual                   # 視覺驗證（真的啟 server + 開瀏覽器，4 條探針）
npx tsx scripts/e2e-daemon.ts        # 完整 daemon 鏈路（假 agent，27 條探針）
npx tsx scripts/e2e-trunk.ts --dry   # 假 agent（真寫檔），無需 token
npx tsx scripts/e2e-trunk.ts         # 真 AgentRuntime（需 .env token）
npx tsx scripts/e2e-full.ts          # 完整週期含合併（沙盒，本地不推送）
npx tsx scripts/explore-mcp.ts       # 唯讀探索 MCP 回應格式（讀 MCP_URL/MCP_TOKEN）
```

## 常駐（launchd）

```bash
./scripts/launchd.sh install      # 產生 plist、build、掛上並啟動（會先確認）
./scripts/launchd.sh status       # 目前狀態
./scripts/launchd.sh logs         # 跟看 log
./scripts/launchd.sh restart      # 改完程式碼後：重 build 再重啟
./scripts/launchd.sh uninstall    # 停止並移除（開機不再自動啟動）
```

plist 由腳本**產生**而不是版控裡的固定檔案：node 的位置因安裝方式而異
（Homebrew／nvm／官方安裝檔），寫死一份遲早會對不上，而對不上的症狀是
「服務標成已載入但其實沒在跑」，很難查。要先看內容的話：`./scripts/launchd.sh plist`。

外部動作開關（開 PR／合併）、GitHub token、Slack 憑證都在控制台的「設定」分頁，
存在資料庫裡，**不需要**在 plist 設。GitHub token 由 daemon 啟動時注入 `GH_TOKEN`
供 `gh` 子行程使用，所以不依賴 `gh auth login` 的 keychain 狀態。

測試用：`./scripts/launchd.sh install --profile test` 會改用 `data/test.db`。

### plist 裡的 `PATH` 不能拿掉

launchd 給的預設 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，實測在那底下
`node`／`gh`／`npm` **全部找不到**（只有 `git` 在 `/usr/bin`）。少了那一行，
daemon 本身起得來（ProgramArguments 用的是絕對路徑），但：

- `gh pr create` → ENOENT ⇒ 開不了 PR
- worktree 裡跑 `npm test`／`npx vite` → ENOENT ⇒ DoD 關卡永遠紅燈

而且從終端機手動跑一切正常，只有掛上 launchd 才壞，錯誤訊息又只是「找不到指令」。
腳本會自己從 `command -v` 推出正確的 PATH，所以照上面用就不會踩到。
