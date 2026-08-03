#!/usr/bin/env bash
#
# launchd 常駐管理。plist 由本腳本**產生**而非寫死路徑：
# node 的位置因安裝方式而異（Homebrew / nvm / 官方安裝檔），寫死一份遲早會對不上，
# 而對不上的症狀是「服務標成已載入但其實沒在跑」，很難查。
#
#   ./scripts/launchd.sh install     安裝並啟動（第一次用這個）
#   ./scripts/launchd.sh start       啟動（已安裝、之前 stop 過）
#   ./scripts/launchd.sh stop        只停止，保留設定（下次登入仍會自動啟動）
#   ./scripts/launchd.sh restart     重新 build 並啟動（git pull 之後用這個）
#   ./scripts/launchd.sh uninstall   停止並移除（開機不再自動啟動）
#   ./scripts/launchd.sh status      目前狀態
#   ./scripts/launchd.sh logs        跟看 log
#   ./scripts/launchd.sh plist       只印出將產生的 plist，不做任何事
#
# 選項：--profile test   改用測試的資料目錄（data/test/，與正式完全分開）
#      --yes            略過確認（給自動化用）
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.botone.orchestrator"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
PROFILE="prod"
ASSUME_YES=0

CMD="${1:-}"; shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    *) echo "未知選項：$1" >&2; exit 2 ;;
  esac
done

# 資料目錄跟著 profile 走（見 src/config/bootstrap.ts 的 dataRoot）：
# 正式＝data/，測試＝data/test/。日誌也分開，否則兩邊的 stdout 會互相蓋掉。
if [ "$PROFILE" = "test" ]; then DATA_DIR="data/test"; else DATA_DIR="data"; fi

die() { echo "✗ $*" >&2; exit 1; }
info() { echo "  $*"; }

# ── 環境探測 ────────────────────────────────────────────────
# launchd 給的預設 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，node／gh／npm 都不在裡面。
# 少了正確的 PATH，daemon 起得來（下面用絕對路徑），但 `gh pr create` 與 worktree 裡的
# `npm test` 會 ENOENT ⇒ 開不了 PR、DoD 關卡永遠紅燈，而且只有掛上 launchd 才會壞。
detect() {
  NODE="$(command -v node || true)"
  [ -n "$NODE" ] || die "找不到 node"
  # 刻意用 command -v 而不是 process.execPath：後者會解到帶版號的實體路徑
  # （例：/opt/homebrew/Cellar/node@24/24.18.0/bin/node），brew upgrade 之後就失效，
  # 症狀是開機後服務靜靜地起不來。command -v 拿到的是穩定的 symlink。
  [ -x "$NODE" ] || die "node 不可執行：$NODE"
  NODE_DIR="$(dirname "$NODE")"

  GH_DIR=""
  if command -v gh >/dev/null 2>&1; then
    GH_DIR="$(dirname "$(command -v gh)")"
  else
    echo "⚠ 找不到 gh（GitHub CLI）。沒有它就無法開 PR／讀審查狀態。" >&2
    echo "  安裝：brew install gh" >&2
  fi

  # 去重後組成 PATH，順序：node → gh → 常見前綴 → 系統
  LAUNCH_PATH=""
  for d in "$NODE_DIR" "$GH_DIR" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
    [ -n "$d" ] || continue
    case ":$LAUNCH_PATH:" in *":$d:"*) continue ;; esac
    LAUNCH_PATH="${LAUNCH_PATH:+$LAUNCH_PATH:}$d"
  done
}

render_plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO/dist/main.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$REPO</string>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <!-- 崩潰後最短重啟間隔。重啟太快會撞上前一個行程還沒放掉的單一實例鎖。 -->
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>$REPO/$DATA_DIR/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$REPO/$DATA_DIR/stderr.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <!-- 這行是必要的，不是保險：見本檔開頭的說明。 -->
    <key>PATH</key>
    <string>$LAUNCH_PATH</string>
    <key>ORCH_PROFILE</key>
    <string>$PROFILE</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>
PLIST
}

is_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

# bootout 是**非同步**的：它回來的時候服務往往還在（狀態 SIGTERMed、pid 還在），
# 這時馬上 bootstrap 會得到 `Bootstrap failed: 5: Input/output error`。實跑撞到過。
# 所以每次要重新掛載之前，都得等到它真的消失。
wait_gone() {
  local i
  for i in $(seq 1 30); do
    is_loaded || return 0
    sleep 1
  done
  return 1
}

unload_and_wait() {
  is_loaded || return 0
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  wait_gone || die "舊的服務停不掉（30 秒後仍在），請看 $REPO/$DATA_DIR/stderr.log"
}

# ── 子指令 ──────────────────────────────────────────────────
case "$CMD" in
  plist)
    detect; render_plist
    ;;

  install)
    detect
    [ -f "$REPO/dist/main.js" ] || {
      info "dist/main.js 不存在 → 先 build"
      (cd "$REPO" && npm run build)
    }

    if [ "$ASSUME_YES" -ne 1 ]; then
      echo
      echo "即將安裝常駐服務："
      info "profile   $PROFILE $([ "$PROFILE" = prod ] && echo '（正式資料目錄 data/）' || echo '（測試資料目錄 data/test/）')"
      info "node      $NODE"
      info "程式      $REPO/dist/main.js"
      info "PATH      $LAUNCH_PATH"
      echo
      echo "裝上去之後它會開始輪詢任務、實際對你設定的專案工作"
      echo "（是否開 PR／自動合併，取決於控制台「設定」分頁裡的開關）。"
      printf "確定要安裝嗎？[y/N] "
      read -r ans
      case "$ans" in y|Y|yes|YES) ;; *) echo "已取消"; exit 0 ;; esac
    fi

    mkdir -p "$HOME/Library/LaunchAgents" "$REPO/data"
    render_plist > "$PLIST"
    plutil -lint "$PLIST" >/dev/null || die "產生的 plist 格式有問題：$PLIST"

    unload_and_wait   # 已載入的話先卸載並等它真的消失
    launchctl bootstrap "$DOMAIN" "$PLIST"

    sleep 2
    if is_loaded; then
      # 大括號不可省：全形標點是多位元組字元，bash 會把它吃進變數名，
      # 在 set -u 下直接變成 "unbound variable" 而中斷（實跑撞到）。
      echo "✓ 已安裝並啟動（${LABEL}，profile=${PROFILE}）"
      info "看 log：./scripts/launchd.sh logs"
      info "停止：  ./scripts/launchd.sh uninstall"
    else
      die "bootstrap 回報成功但服務不在，請看 $REPO/$DATA_DIR/stderr.log"
    fi
    ;;

  uninstall)
    unload_and_wait
    rm -f "$PLIST"
    echo "✓ 已停止並移除（開機不會再自動啟動）"
    ;;

  stop)
    is_loaded || { echo "本來就沒在跑"; exit 0; }
    unload_and_wait
    echo "✓ 已停止（設定保留，下次登入仍會自動啟動；要徹底移除用 uninstall）"
    ;;

  # 有 stop 卻沒有 start 是不對稱的——實際被這個絆到過：stop 之後想再開，
  # 打 start 得到的是用法說明，看起來像腳本壞了。
  start)
    [ -f "$PLIST" ] || die "尚未安裝，請先 install"
    is_loaded && { echo "已經在跑了（要套用新程式碼用 restart）"; exit 0; }
    launchctl bootstrap "$DOMAIN" "$PLIST"
    sleep 2
    is_loaded && echo "✓ 已啟動" || die "啟動後服務不在，請看 $REPO/$DATA_DIR/stderr.log"
    ;;

  restart)
    [ -f "$PLIST" ] || die "尚未安裝，請先 install"
    (cd "$REPO" && npm run build)
    unload_and_wait
    launchctl bootstrap "$DOMAIN" "$PLIST"
    sleep 2
    is_loaded && echo "✓ 已重新啟動" || die "重啟後服務不在，請看 $REPO/$DATA_DIR/stderr.log"
    ;;

  status)
    if [ -f "$PLIST" ]; then info "plist    $PLIST"; else info "plist    未安裝"; fi
    if is_loaded; then
      # pid 不存在代表「有登記但沒在跑」——最常見的原因是程式一啟動就退出。
      # 取 "= " 之後的整段而不是 $NF：值可能含空白（例 "last exit code = (never exited)"）。
      launchctl print "$DOMAIN/$LABEL" | awk -F' = ' '
        /^\tstate = /    { print "  狀態     " $2 }
        /^\tpid = /      { print "  pid      " $2 }
        /last exit code/ { print "  上次結束 " $2 }'
    else
      info "狀態     未載入"
    fi
    ;;

  logs)
    # **看 stdout 不是 stderr。** daemon 的日誌全部走 stdout，stderr 只有真的爆掉時
    # 才有東西（node 的 uncaught exception）。原本 tail stderr，結果是「什麼都看不到」，
    # 而使用者會以為服務沒在跑。
    #
    # 正式模式的日誌是單行 JSON（給機器讀的），有 pino-pretty 就轉成人看得懂的格式。
    # 兩個檔案一起跟：平常看 stdout，真的爆了才會有 stderr。
    OUT="$REPO/$DATA_DIR/stdout.log"
    ERR="$REPO/$DATA_DIR/stderr.log"
    [ -f "$OUT" ] || die "找不到 $OUT（服務跑過嗎？先 ./scripts/launchd.sh status）"
    PRETTY="$REPO/node_modules/.bin/pino-pretty"
    if [ -x "$PRETTY" ]; then
      tail -n 40 -f "$OUT" "$ERR" | "$PRETTY" --colorize --translateTime 'SYS:HH:MM:ss' --ignore 'pid,hostname'
    else
      tail -n 40 -f "$OUT" "$ERR"
    fi
    ;;

  *)
    # 印到第一個非註解行為止。寫死行數的話，每次改用法說明都要記得跟著調——
    # 忘了就會把 `set -euo pipefail` 之類的程式碼一起印給使用者看（踩過）。
    awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
    exit 2
    ;;
esac
