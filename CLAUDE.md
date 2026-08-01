# Botone Orchestrator — 這個資料夾的規則

## 這裡是開發資料夾，不是正式環境

**任何開發、測試、實跑一律用 `ORCH_PROFILE=test`。**

```bash
ORCH_PROFILE=test npx tsx src/main.ts        # 對的
npx tsx src/main.ts                          # 錯的：會用正式資料
```

正式服務不在這裡跑（見下方「正式部署」）。在這個資料夾跑正式 profile，等於讓
「我改到一半的程式碼」直接變成正式服務的行為。

## 資料目錄按 profile 分家

```
data/          正式：data/ledger.db、data/backups/
data/test/     測試：data/test/ledger.db、worktrees/、repos/、screenshots/、live*/
```

由 `src/config/bootstrap.ts` 的 `dataRoot` 決定，worktree／合併工作區／瀏覽器暫存／
截圖／備份**全部**掛在各自的 root 底下。`ORCH_DATA_ROOT` 可整包指到別處（e2e 用）。

**不要在 `data/`（正式那層）建任何測試用的東西。** 曾經發生過：正式庫裡躺著一個
為了測試而加的專案，指向沙盒複本，事後分不出哪些是真的。

## 測試只用這兩個 repo

| repo | 本地 clone | 形狀 |
|---|---|---|
| `cjo4m06/Baolu-orch-sandbox` | `data/test/repos/Baolu-sandbox` | Vue app，有 UI → 測視覺關卡與介面判斷者 |
| `cjo4m06/orch-demo2` | `data/test/repos/demo2` | 純工具庫，無 UI → 測不同形狀的專案 |

假任務板：`scripts/mock-mcp-server.ts` ＋ `data/test/live/tasks.json`、
`data/test/live2/tasks.json`（`ORCH_MOCK_TASKS` 指過去）。

**測試專案的 `repo` 欄位絕不可以是 `cjo4m06/Baolu`。** 沒有 `prRepo` 這種「把 PR 導開」
的欄位了（已移除）——`repo` 寫什麼，PR 就開到哪。

## 對真實 Baolu 的紅線

`cjo4m06/Baolu` 綁 Firebase 部署（`npm run deploy` = `vite build && firebase deploy`，
無 CI，合併不會自動部署）。

- **絕不執行任何 deploy 指令**（工具層 `evaluateToolPolicy` 已在 PreToolUse 擋掉
  `firebase deploy`、`npm|yarn|pnpm run deploy`、vercel/netlify/wrangler deploy、
  強制推送 main——那是硬邊界，不是提示詞）。
- 要測完整週期（含合併）用沙盒複本，不要碰本體。

## 正式部署

正式服務跑在**另一個資料夾**（這個 repo 的獨立 clone，停在穩定的 commit），
launchd 指向那裡。這個資料夾只負責改程式。

理由：正式 daemon 是用 `tsx` 直接讀原始碼跑的。同一個資料夾的話，我在這裡改到一半、
跑測試、切分支，正式服務一重啟就會載到壞掉的狀態——資料分家擋不住這個。

## 驗證

```bash
npm run typecheck
npm test                      # 全套單元/整合測試
npx tsx scripts/e2e-daemon.ts # 完整 daemon 鏈路（假件，不碰網路）
```

改動涉及畫面時要用真實瀏覽器驗證（見使用者的全域守則）。
