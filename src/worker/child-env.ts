/**
 * 調度器**代替專案執行任何東西**時的環境基底。
 *
 * 為什麼要獨立成一個檔、而且檔名不帶 "agent"：
 * 這個能力有兩個執行點——agent 的 Bash（agent-runtime 的 buildAgentEnv）與
 * DoD 關卡（verifier 的 runShell）。2026-08-06 修 NODE_ENV 外洩時只修了前者，
 * 因為 `buildAgentEnv` 這個名字讀起來像「只跟 agent 有關」，關卡那條從沒被想到。
 * 結果是：agent 自己手動跑 `npm ci && npm run build` 全綠，關卡照樣紅，
 * agent 因此推論成「關卡環境的 PATH 少了 node」——推論錯了，但它會這樣推是必然的。
 *
 * 名字放在這裡就是為了讓下一個人問「還有誰在代替專案執行東西？」而不是「agent 的環境對不對？」
 */

/**
 * daemon 自己的執行模式，一律不傳給任何子行程。
 *
 * `NODE_ENV`：launchd 用 `NODE_ENV=production` 起 daemon（那是給 logger 用的，
 * 見 observability/logger.ts）。而 **npm 把 `NODE_ENV=production` 當成 `--omit=dev`**。
 * 實際後果（2026-08-06，WorkerControl）：那個專案的 package.json 沒有 dependencies，
 * vite / laravel-vite-plugin / sass-embedded 全在 devDependencies，於是 `npm ci` 一個都沒裝，
 * `npm run build` 回 `vite: command not found`（exit 127）。
 *
 * `ORCH_*`：daemon 的 profile 與資料庫路徑。子行程不該看見，更不該在改到本 repo 時繼承 prod。
 */
export const DAEMON_ONLY_ENV = /^(NODE_ENV|ORCH_.*)$/;

/**
 * 濾掉 daemon 自身設定，並把 profile 釘在 test。
 *
 * **`ORCH_PROFILE` 是「改寫成 test」而不是「拿掉」**：`profileOf` 讀不到這個變數時
 * 預設回 prod（見 config/bootstrap.ts——忘了設就該落在不會弄壞正式那邊，那個預設對 daemon 是對的），
 * 所以只拿掉等於沒拿掉。擋的情境是「把調度器這個 repo 自己丟進任務板」：
 * 子行程跑 `npm test` 會直接讀寫正式的 ledger.db。對其他專案這個變數沒有意義，設了不影響。
 *
 * **注意呼叫端**：execa 預設 `extendEnv: true` 會把 `process.env` 疊回你給的 env 之上，
 * 也就是 `NODE_ENV` 會從底下疊回來。用這支函式的地方**必須同時給 `extendEnv: false`**
 * （實測：只給 env 的話子行程仍然印得出 `NODE_ENV=production`）。
 */
export function sanitizedChildEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (DAEMON_ONLY_ENV.test(k)) continue;
    env[k] = v;
  }
  env.ORCH_PROFILE = 'test';
  return env;
}
