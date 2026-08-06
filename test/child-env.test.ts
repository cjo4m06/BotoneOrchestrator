import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execa } from 'execa';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sanitizedChildEnv, DAEMON_ONLY_ENV } from '../src/worker/child-env.js';
import { buildAgentEnv } from '../src/worker/agent-runtime.js';

/**
 * 這一整個檔案守的是**同一類 bug**：一個能力有好幾個執行點，只接了其中一個。
 *
 * 2026-08-06 連續兩次：
 *  ① launchd 的 NODE_ENV=production 漏給 agent → npm 當成 --omit=dev → build 掛
 *  ② 修 ① 時只改了 buildAgentEnv（agent 那條），漏了 verifier 的 runShell（DoD 關卡那條），
 *    而驗證也只印了 buildAgentEnv 的結果，所以沒抓到
 *
 * 所以這裡不只斷言函式行為，也斷言**每個執行點都接上了**，並且**真的跑一次 npm**。
 */

// ── 函式行為 ──

test('daemon 自己的 NODE_ENV／ORCH_* 不進子行程', () => {
  const env = sanitizedChildEnv({
    PATH: '/usr/bin',
    NODE_ENV: 'production',        // launchd 就是這樣起 daemon 的
    ORCH_DATA_ROOT: '/x/data',
    ORCH_LEDGER_PATH: '/x/data/ledger.db',
  } as NodeJS.ProcessEnv);

  assert.equal(env.NODE_ENV, undefined);
  assert.equal(env.ORCH_DATA_ROOT, undefined);
  assert.equal(env.ORCH_LEDGER_PATH, undefined);
  assert.equal(env.PATH, '/usr/bin');
});

test('ORCH_PROFILE 是改寫成 test，不是拿掉', () => {
  // 拿掉的話 profileOf 會退回 prod（bootstrap.ts 的預設），等於沒改
  assert.equal(sanitizedChildEnv({ ORCH_PROFILE: 'prod' } as NodeJS.ProcessEnv).ORCH_PROFILE, 'test');
  assert.equal(sanitizedChildEnv({} as NodeJS.ProcessEnv).ORCH_PROFILE, 'test');
});

test('只擋 daemon 自己的，不誤傷同前綴的專案變數', () => {
  const env = sanitizedChildEnv({
    ORCHESTRA_API_KEY: 'keep',
    NODE_OPTIONS: '--max-old-space-size=4096',
    NODE_VERSION: '24',
  } as NodeJS.ProcessEnv);
  assert.equal(env.ORCHESTRA_API_KEY, 'keep');
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096');
  assert.equal(env.NODE_VERSION, '24');
  assert.equal(DAEMON_ONLY_ENV.test('ORCHESTRA_API_KEY'), false);
  assert.equal(DAEMON_ONLY_ENV.test('NODE_OPTIONS'), false);
});

test('buildAgentEnv 疊在 sanitizedChildEnv 之上（兩層都要成立）', () => {
  const env = buildAgentEnv({
    PATH: '/usr/bin',
    NODE_ENV: 'production',
    ORCH_PROFILE: 'prod',
    GH_TOKEN: 'secret',
    ANTHROPIC_AUTH_TOKEN: 'keep-me',
  } as NodeJS.ProcessEnv);
  assert.equal(env.NODE_ENV, undefined);          // 來自 sanitizedChildEnv
  assert.equal(env.ORCH_PROFILE, 'test');         // 來自 sanitizedChildEnv
  assert.equal(env.GH_TOKEN, undefined);          // buildAgentEnv 自己那層
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'keep-me');
});

// ── execa 語意：只給 env 不夠 ──

test('execa 預設會把 process.env 疊回來——所以 extendEnv: false 是必要的', async () => {
  const clean = sanitizedChildEnv({ ...process.env, NODE_ENV: 'production' } as NodeJS.ProcessEnv);

  const leaked = await execa('echo "[$NODE_ENV]"', { shell: true, env: clean, all: true });
  assert.equal(leaked.all?.trim(), `[${process.env.NODE_ENV ?? ''}]`,
    '只給 env 時，process.env 會疊回來');

  const sealed = await execa('echo "[$NODE_ENV]"', { shell: true, env: clean, extendEnv: false, all: true });
  assert.equal(sealed.all?.trim(), '[]', 'extendEnv: false 才真的擋得住');
});

// ── 接線：每個執行點都要接上 ──

/** 剝掉註解行再比對——說明文字裡一定會提到這些名字，會誤判成「有接」。 */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

test('DoD 關卡的 runShell 有帶消毒過的環境，而且關掉 extendEnv', () => {
  const src = codeOf('src/worker/verifier.ts');
  assert.match(src, /env: sanitizedChildEnv\(\)/, 'runShell 沒給 env ＝ 直接繼承 daemon 的 NODE_ENV');
  assert.match(src, /extendEnv: false/, '只給 env 沒用，execa 會把 process.env 疊回來');
});

test('全部五個 query() 都有 env（少一個，那個角色就拿得到真 GH_TOKEN）', () => {
  const files = [
    'src/worker/agent-runtime.ts',
    'src/worker/reviewer.ts',
    'src/core/plan-agent.ts',
    'src/pr/drift-judge.ts',
    'src/core/merge-risk-judge.ts',
  ];
  let total = 0;
  for (const f of files) {
    const src = codeOf(f);
    const queries = (src.match(/\bquery\(\{/g) ?? []).length;
    const envs = (src.match(/env: buildAgentEnv\(/g) ?? []).length;
    total += queries;
    assert.equal(envs, queries, `${f}：${queries} 個 query() 但只有 ${envs} 個帶 env`);
  }
  // 數量本身也守著：新增角色時忘了加進這份清單，這行會提醒
  const all = execSyncQueryCount();
  assert.equal(all, total, `全 src 有 ${all} 個 query()，但這個測試只檢查了 ${total} 個`);
});

/** 全 src 的 query({ 出現次數——用來確認上面那份檔案清單沒有漏。 */
function execSyncQueryCount(): number {
  const files = [
    'src/worker/agent-runtime.ts', 'src/worker/reviewer.ts', 'src/core/plan-agent.ts',
    'src/pr/drift-judge.ts', 'src/core/merge-risk-judge.ts', 'src/core/planner.ts',
    'src/core/orchestrator.ts', 'src/core/group-runner.ts', 'src/worker/worker.ts',
    'src/pr/merge-guard.ts', 'src/pr/pr-manager.ts', 'src/main.ts',
  ];
  return files.reduce((n, f) => n + (existsSync(f) ? (codeOf(f).match(/\bquery\(\{/g) ?? []).length : 0), 0);
}

// ── 真的跑一次：這才是唯一擋得住這個 bug 的測法 ──

test('NODE_ENV=production 的行程環境下，關卡跑 npm ci 仍裝得到 devDependencies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-childenv-'));
  try {
    // 形狀比照 WorkerControl：**沒有 dependencies**，建置工具全在 devDependencies
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'gate-env-fixture', version: '1.0.0', private: true,
      devDependencies: { 'is-odd': '3.0.1' },
    }));
    await execa('npm', ['install', '--package-lock-only', '--silent'], { cwd: dir, reject: false });

    // 關鍵：模擬 launchd 給 daemon 的環境
    const daemonEnv = { ...process.env, NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    const r = await execa('npm ci', {
      cwd: dir,
      shell: true,
      env: sanitizedChildEnv(daemonEnv),
      extendEnv: false,
      reject: false,
      all: true,
    });

    assert.equal(r.exitCode, 0, `npm ci 失敗：${r.all}`);
    assert.ok(existsSync(join(dir, 'node_modules', 'is-odd')),
      `devDependency 沒裝到——這就是 build 關卡 exit 127 的成因。npm 輸出：${r.all}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
