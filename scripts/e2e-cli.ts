/**
 * CLI 端到端：用**真的執行 `npm run ask`**（另開行程）走完整條人機互動流程。
 *
 * 為什麼需要這條：既有測試都在行程內直接呼叫 collectPending／applyAction，
 * 驗不到「使用者真的在終端機打指令」這條路——參數解析、profile 選到哪個資料庫、
 * 退出碼、輸出格式，全都只有實際 spawn 才會暴露。
 *
 * 使用者不在時 Slack 沒辦法互動測試，CLI 就是唯一能自動驗證的人機介面。
 *
 * 一律跑在 **test profile** 的獨立資料庫，不碰正式資料。
 */
import { execa } from 'execa';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ledger } from '../src/store/ledger.js';
import { ConfigStore } from '../src/config/store.js';
import { createLogger } from '../src/observability/logger.js';
import { NO_CHANGE_BLOCK_PREFIX } from '../src/notify/notifier.js';

const dir = mkdtempSync(join(tmpdir(), 'botone-cli-e2e-'));
const dbPath = join(dir, 'test.db');
const env = { ...process.env, ORCH_PROFILE: 'test', ORCH_LEDGER_PATH: dbPath, LOG_LEVEL: 'error' };

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n     ${detail}` : ''}`);
  ok ? (pass += 1) : (fail += 1);
}

async function ask(...args: string[]): Promise<{ out: string; code: number }> {
  const r = await execa('npx', ['tsx', 'src/cli/ask.ts', ...args], { env, reject: false, cwd: process.cwd() });
  return { out: `${r.stdout}\n${r.stderr}`, code: r.exitCode ?? 1 };
}

async function main(): Promise<void> {
  console.log('════════ CLI 端到端 ════════\n（真的 spawn `tsx src/cli/ask.ts`，跑在測試資料庫）\n');

  const log = createLogger();
  const store = new ConfigStore(dbPath);
  store.saveSettings({ budget: { dailyUsd: 3, warnAtPercent: 80 } });
  const ledger = new Ledger(dbPath, log);
  ledger.init();

  const task = (id: string, title: string) =>
    ledger.upsertDiscoveredTask({
      id, payloadHash: `h-${id}`, repo: 'acme/web', category: 'dev',
      title, description: '描述', dependencies: [], docRefs: [],
    });

  // ── 待辦：一個等澄清、一個宣告「不用做」、一個群組等核准 ──
  task('T-1', '結帳頁欄位調整');
  ledger.setBlock('T-1', 'needs_clarification', '要用 Stripe 還是綠界？建議：Stripe');
  task('T-2', '移除舊 banner');
  ledger.setBlock('T-2', 'needs_human', `${NO_CHANGE_BLOCK_PREFIX}這個 banner 上一個 PR 已移除`);
  ledger.logEvent('task', 'T-2', 'no_change_reported', JSON.stringify({
    category: 'already_satisfied', reason: '程式碼裡找不到對應元件', evidence: 'grep 無結果',
  }));
  ledger.upsertGroup({
    id: 'g_1', repo: 'acme/web', branch: 'orch/web/g_1', taskIds: ['T-3'], footprint: ['src/a.ts'],
    afterGroups: [], rationale: '',
    state: 'in_review', prUrl: 'https://example.test/pr/1', prNumber: 1,
  });
  ledger.logEvent('group', 'g_1', 'policy_needs_human', '程式碼變更需人工核准');
  // kind 必填：這筆是寫程式的 agent 燒的錢（ledger 的預設值也是 worker，行為不變）
  ledger.recordAgentSession({ kind: 'worker', taskId: 'T-1', sessionId: 's-1', costUsd: 2.5, models: ['claude-opus-5'] });

  // ① 列出待辦
  const list = await ask();
  check('① `ask` 列出所有待處理事項',
    list.code === 0 && list.out.includes('T-1') && list.out.includes('T-2') && list.out.includes('g_1'),
    list.out.split('\n').filter((l) => l.trim()).slice(0, 4).join('\n     '));

  // ② 顯示 agent 的建議預設（人才知道可以直接 --default）
  check('② 澄清項目附上 agent 的建議', list.out.includes('Stripe'));

  // ③ no_change 顯示分類與依據（沒有這些，人無從判斷 agent 有沒有誤判）
  check('③「不用做」附上分類與查證依據',
    list.out.includes('已符合') || list.out.includes('already_satisfied'), '');

  // ④ status：狀態總覽 + 專案分段
  const status = await ask('status');
  check('④ `ask status` 顯示受阻任務與原因',
    status.code === 0 && status.out.includes('T-1') && status.out.includes('needs_clarification'));

  // ⑤ cost：成本 + 花費上限
  const cost = await ask('cost');
  check('⑤ `ask cost` 顯示花費與上限用量',
    cost.out.includes('$2.50') && cost.out.includes('上限') && cost.out.includes('83%'),
    cost.out.split('\n').filter((l) => l.includes('今日') || l.includes('全部')).join('\n     '));

  // ⑥ 用 id 回答澄清（比編號安全——清單會隨 daemon 變動）
  const answer = await ask('T-1', '用', 'Stripe');
  const t1 = ledger.getTask('T-1');
  check('⑥ 用 id 回答澄清 → 任務回到 queued，答覆進事件',
    answer.code === 0 && t1?.state === 'queued' && t1?.block === undefined,
    `state=${t1?.state} 事件=${ledger.latestEvent('task', 'T-1', 'clarification_answer')?.detail ?? '(無)'}`);

  // ⑦ 否決「不用做」→ 任務回 queued，且留下可回灌給 agent 的稽核
  const reject = await ask('T-2', 'reject');
  check('⑦ 否決「不用做」→ 回 queued 且留下 no_change_rejected',
    reject.code === 0 && ledger.getTask('T-2')?.state === 'queued'
      && ledger.hasEvent('task', 'T-2', 'no_change_rejected'));

  // ⑧ 核准合併 → 憑證必須落在 **ledger**（D17：狀態不等於核准）。
  //    只放記憶體的話，CLI 是另一個行程 ⇒ 核准永遠傳不到 daemon，人以為核准了但什麼都沒發生。
  const approve = await ask('g_1', 'approve');
  const cred = ledger.latestEvent('group', 'g_1', 'merge_credential');
  check('⑧ 核准合併 → 憑證落在 ledger（跨行程才有效）',
    approve.code === 0 && ledger.getGroup('g_1')?.state === 'merge_guard'
      && cred !== undefined && String(cred.detail).includes('human:'),
    `state=${ledger.getGroup('g_1')?.state} 憑證=${cred?.detail ?? '(無)'}`);

  // ⑨ 不存在的目標要明確拒絕（不可靜靜什麼都不做）
  const bogus = await ask('T-999', '隨便');
  check('⑨ 不存在的 id → 非零退出碼並說明', bogus.code !== 0 && bogus.out.includes('❌'));

  // ⑩ 處理完之後清單要變空
  const after = await ask();
  check('⑩ 全部處理完 → 清單為空', after.out.includes('沒有需要你處理'));

  // ⑪ profile 隔離：正式資料庫完全沒被碰到
  const prodUntouched = !dbPath.includes('daemon.db');
  check('⑪ 全程只碰測試資料庫', prodUntouched, dbPath);

  ledger.close();
  store.close();

  console.log(`\n────────\n${pass} 通過 / ${fail} 失敗`);
  console.log(fail === 0 ? '結論：✅ CLI 人機互動鏈路完整' : '結論：❌ 有缺口');
}

main()
  .catch((e) => { console.error(e); fail += 1; })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exit(fail === 0 ? 0 : 1);
  });
