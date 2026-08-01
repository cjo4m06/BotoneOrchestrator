import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_TOOLS,
  ASK_HUMAN_FALLBACK,
  browserServerConfig,
  buildAgentEnv,
  buildAgentPrompt,
  classifyAgentError,
  collectStreamOutcome,
  createAskHumanHandler,
  createPreToolUseGuard,
  createStopHook,
  decomposeShellCommand,
  directoryFormsOf,
  evaluateCommandRedline,
  evaluateToolPolicy,
  isDeployScriptName,
  parseUsage,
  resolveToolPolicy,
  tokenizeShell,
} from '../src/worker/agent-runtime.js';
import type { ClarificationCapture, IterateInput } from '../src/worker/agent-runtime.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRecordingLogger, createSilentLogger, makeGateReport, makeTaskDetail } from './helpers/index.js';

function input(overrides: Partial<IterateInput> = {}): IterateInput {
  return {
    cwd: '/tmp/worktree',
    task: makeTaskDetail({ id: 'T-1', title: '深色模式', description: '在設定頁加入切換', category: 'dev', repo: 'acme/web' }),
    docs: [],
    ...overrides,
  };
}

// ── buildAgentPrompt ──

test('最小輸入：任務標題/類別/repo/描述與完成要求都在，且無多餘段落', () => {
  const p = buildAgentPrompt(input());

  assert.match(p, /^# 任務 T-1：深色模式\n/);
  assert.match(p, /^類別：dev｜repo：acme\/web$/m);
  assert.match(p, /## 任務描述\n在設定頁加入切換/);
  assert.equal(p.includes('## 規格文件'), false);
  assert.equal(p.includes('## 澄清答覆'), false);
  assert.equal(p.includes('## 上一輪驗證未通過'), false);
  assert.match(p, /## 完成要求/);
});

test('完成要求永遠壓在最後（避免被前面的規格內容淹沒）', () => {
  const p = buildAgentPrompt(
    input({
      docs: [{ ref: 'spec/a.md#§1', content: '規格內容' }],
      answer: { question: 'Q', answer: 'A' },
      feedback: makeGateReport({ green: false, checks: [{ name: 'test', ok: false, detail: '紅' }] }),
    }),
  );
  const idx = (s: string) => p.indexOf(s);
  assert.ok(idx('## 任務描述') < idx('## 規格文件'));
  assert.ok(idx('## 規格文件') < idx('## 澄清答覆'));
  assert.ok(idx('## 澄清答覆') < idx('## 上一輪驗證未通過'));
  assert.ok(idx('## 上一輪驗證未通過') < idx('## 完成要求'));
  // 指示區塊（完成要求 + 最終總結格式）必須壓在所有「輸入」之後，才不會被規格內容淹沒。
  // 總結格式本身是一份含多個標題的範本，所以不能用「之後沒有其他 ##」來斷言。
  assert.ok(idx('## 完成要求') < idx('## 最終總結的格式'));
  const inputs = ['## 任務描述', '## 規格文件', '## 澄清答覆', '## 上一輪驗證未通過'];
  for (const sec of inputs) assert.ok(idx(sec) < idx('## 完成要求'), `${sec} 應在完成要求之前`);
});

test('prompt 要求 agent 產出 PR 需要的敘事段落（否則 PR 全是「待補」）', () => {
  const p = buildAgentPrompt(input());
  // PR 內文的敘事是從 agent 總結解析出來的；prompt 不講，agent 就只會寫一兩句話，
  // 需求「讓審查人員快速了解」等於沒兌現（實際看 PR 時發現大半段落都是「（待補）」）
  for (const sec of ['做了什麼', '怎麼做', '架構', '畫面設計', '操作形式', '核心技術', '假設']) {
    assert.match(p, new RegExp(`## ${sec}`), `總結格式應包含「${sec}」`);
  }
  assert.match(p, /不適用的段落整段省略/, '不可鼓勵硬湊段落');
});

test('docs：每份規格以 ### ref 起頭並帶入完整內容', () => {
  const p = buildAgentPrompt(
    input({
      docs: [
        { ref: 'spec/theme.md#色票', content: '主色 #111\n次色 #eee' },
        { ref: 'prd/theme.md', content: '使用者可切換主題' },
      ],
    }),
  );
  assert.match(p, /## 規格文件（docRefs，務必逐段遵循）/);
  assert.match(p, /### spec\/theme\.md#色票\n主色 #111\n次色 #eee/);
  assert.match(p, /### prd\/theme\.md\n使用者可切換主題/);
});

test('澄清答覆會把問題與答覆一起注入（agent 需要脈絡才知道在回什麼）', () => {
  const p = buildAgentPrompt(input({ answer: { question: '要不要刪舊欄位？', answer: '不要刪，先標 deprecated' } }));
  assert.match(p, /## 澄清答覆\n問題：要不要刪舊欄位？\n答覆：不要刪，先標 deprecated/);
});

test('回饋只列失敗關卡；通過的關卡不干擾 agent', () => {
  const p = buildAgentPrompt(
    input({
      feedback: makeGateReport({
        green: false,
        checks: [
          { name: 'typecheck', ok: true, detail: '通過' },
          { name: 'test', ok: false, detail: '2 個測試失敗' },
        ],
      }),
    }),
  );
  assert.match(p, /- \[test\] 2 個測試失敗/);
  assert.equal(p.includes('typecheck'), false, '通過的關卡不應出現在修正清單');
});

test('回饋帶 failingIds 時附上具體失敗項', () => {
  const p = buildAgentPrompt(
    input({
      feedback: makeGateReport({
        green: false,
        checks: [{ name: 'test', ok: false, detail: '單元測試紅燈', failingIds: ['auth.spec.ts:12', 'auth.spec.ts:40'] }],
      }),
    }),
  );
  assert.match(p, /- \[test\] 單元測試紅燈（失敗項：auth\.spec\.ts:12, auth\.spec\.ts:40）/);
});

test('failingIds 為空陣列時不輸出括號', () => {
  const p = buildAgentPrompt(
    input({ feedback: makeGateReport({ green: false, checks: [{ name: 'lint', ok: false, detail: '3 warnings', failingIds: [] }] }) }),
  );
  assert.match(p, /- \[lint\] 3 warnings$/m);
});

test('回饋內所有關卡都通過時，整段不輸出（空標題會讓 agent 亂猜哪裡錯）', () => {
  const p = buildAgentPrompt(input({ feedback: makeGateReport({ green: true, checks: [{ name: 'build', ok: true, detail: 'ok' }] }) }));
  assert.equal(p.includes('## 上一輪驗證未通過'), false);
  assert.equal(p.includes('- [build]'), false);
});

test('回饋的 checks 為空時同樣不輸出未通過段落', () => {
  const p = buildAgentPrompt(input({ feedback: makeGateReport({ green: false, checks: [] }) }));
  assert.equal(p.includes('## 上一輪驗證未通過'), false);
});

// ── evaluateToolPolicy：紅線 ──

const denied: [string, RegExp][] = [
  // push 一律禁止（不分是否 force）：推分支是 PrManager 的職責，開放給 agent
  // 等於讓它能 `git push origin main` 跳過整條 PR/守衛流程
  ['git push --force origin main', /外部動作/],
  ['git push -f origin feature/x', /外部動作/],
  ['git push origin main --force', /外部動作/],
  ['git push --force-with-lease origin main', /外部動作/],
  ['cd /repo && git push -f', /外部動作/],
  ['git push origin feature/dark-mode', /外部動作/],
  ['git push -u origin HEAD', /外部動作/],
  ['git push --set-upstream origin feat/x', /外部動作/],
  ['git push origin feature/deploy-page', /外部動作/],
  // GitHub CLI 全面禁止：gh 能做的都是不可逆的外部副作用
  ['gh pr merge 12 --squash', /外部動作/],
  ['gh repo delete acme/web --yes', /外部動作/],
  ['gh pr create --title x --body y', /外部動作/],
  ['gh api -X PATCH /repos/acme/web', /外部動作/],
  ['cd /repo && gh pr merge 3', /外部動作/],
  // 改 remote 會讓後續推送指向非預期的 repo
  ['git remote set-url origin git@github.com:evil/x.git', /remote/],
  ['git remote add mirror git@github.com:other/x.git', /remote/],
  ['git remote remove origin', /remote/],
  ['rm -rf /', /rm -rf/],
  ['rm -rf /usr/local/lib', /rm -rf/],
  ['rm -rf ~/Desktop/專案', /rm -rf/],
  ['rm -rf $HOME/code', /rm -rf/],
  ['rm -rf ${HOME}/code', /rm -rf/],
  ['rm -fr /tmp/x', /rm -rf/],
  ['rm -r -f /var/data', /rm -rf/],
  ['sudo rm -rf /etc', /rm -rf/],
  ['git reset --hard origin/main', /hard reset/],
  ['firebase deploy', /firebase deploy/],
  ['firebase deploy --only hosting', /firebase deploy/],
  ['npm run deploy', /deploy script/],
  ['yarn run deploy', /deploy script/],
  ['pnpm run deploy', /deploy script/],
  ['npm run deploy:prod', /deploy script/],
  ['vercel deploy --prod', /雲端部署/],
  ['netlify deploy', /雲端部署/],
  ['wrangler deploy', /雲端部署/],
];

for (const [cmd, reason] of denied) {
  test(`紅線擋下：${cmd}`, () => {
    const v = evaluateToolPolicy('Bash', { command: cmd });
    assert.equal(v.deny, true, `應被拒絕：${cmd}`);
    assert.match(v.reason ?? '', reason);
    assert.match(v.reason ?? '', /^紅線：/, '拒絕理由需標明是紅線，方便 agent 判讀');
  });
}

test('紅線也擋多行指令中的危險行', () => {
  const v = evaluateToolPolicy('Bash', { command: 'npm run build\ngit push --force origin main\n' });
  assert.equal(v.deny, true);
});

// ── evaluateToolPolicy：正常放行 ──

const allowed = [
  'npm test',
  'npm run build',
  'npm ci',
  'npx tsc --noEmit',
  'git status --porcelain',
  'git add -A && git commit -m "feat: 深色模式"',
  'git reset --hard HEAD',
  'rm -rf node_modules',
  'rm -rf ./dist',
  'rm -rf dist/assets',
  'npm run predeploy',
  'echo "deploy 這個字只出現在字串裡"',
  'cat docs/deploy.md',
];

for (const cmd of allowed) {
  test(`正常指令放行：${cmd}`, () => {
    assert.deepEqual(evaluateToolPolicy('Bash', { command: cmd }), { deny: false });
  });
}

// agent 仍然需要的本地 git 操作：擋過頭會讓它做不完任務（§D18 誤殺）
const stillAllowedGit = [
  'git status --porcelain',
  'git add -A',
  'git commit -m "feat: x"',
  'git diff HEAD',
  'git log --oneline -5',
  'git checkout -b feat/x',
  'git stash',
  'git remote -v',        // 唯讀，不是變更
  'git remote show origin',
  'git remote get-url origin',
];

for (const cmd of stillAllowedGit) {
  test(`本地 git 操作仍放行：${cmd}`, () => {
    assert.deepEqual(evaluateToolPolicy('Bash', { command: cmd }), { deny: false });
  });
}

test('禁用 gh 不影響名稱相近的指令', () => {
  // 只擋指令本身叫 gh 的情況，不能把含有 gh 字樣的東西一起掃掉
  assert.deepEqual(evaluateToolPolicy('Bash', { command: 'npm run lighthouse' }), { deny: false });
  assert.deepEqual(evaluateToolPolicy('Bash', { command: 'echo "gh is blocked"' }), { deny: false });
  assert.deepEqual(evaluateToolPolicy('Bash', { command: 'cat docs/gh-usage.md' }), { deny: false });
});

// ── 深度防禦：指令字串比對擋不完，所以還有腳本內容掃描與環境隔離 ──

test('先寫腳本再執行 → 讀腳本內容攔下（字串比對看不到 gh）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-script-'));
  writeFileSync(join(dir, 'x.sh'), '#!/bin/bash\ngh pr merge 1 --squash\n');
  const v = evaluateToolPolicy('Bash', { command: 'bash x.sh' }, undefined, dir);
  assert.equal(v.deny, true);
  assert.match(v.reason ?? '', /被執行的腳本內容/);
  rmSync(dir, { recursive: true, force: true });
});

test('腳本內容正常 → 不誤殺', () => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-script-'));
  writeFileSync(join(dir, 'ok.sh'), '#!/bin/bash\nnpm run build\nnpm test\n');
  assert.deepEqual(evaluateToolPolicy('Bash', { command: 'bash ok.sh' }, undefined, dir), { deny: false });
  rmSync(dir, { recursive: true, force: true });
});

test('腳本讀不到時放行（動態產生的內容靠環境隔離兜底，不是靠猜）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-script-'));
  assert.deepEqual(evaluateToolPolicy('Bash', { command: 'bash nowhere.sh' }, undefined, dir), { deny: false });
  rmSync(dir, { recursive: true, force: true });
});

test('環境隔離：agent 子行程拿不到 GitHub 認證，但保留自己要用的東西', () => {
  const env = buildAgentEnv({
    PATH: '/usr/bin',
    HOME: '/home/x',
    GH_TOKEN: 'secret',
    GITHUB_TOKEN: 'secret',
    GH_ENTERPRISE_TOKEN: 'secret',
    ANTHROPIC_AUTH_TOKEN: 'keep-me',
  } as NodeJS.ProcessEnv);

  // 這才是真正的底線：不管指令怎麼包裝，gh 都是未登入狀態
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_ENTERPRISE_TOKEN, undefined);
  assert.match(env.GH_CONFIG_DIR ?? '', /gh-empty/);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_ASKPASS, '/bin/false');
  // agent 自己要跑就得留著這些
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'keep-me');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/x');
});

test('prompt 明講禁令（第三層：讓 agent 知道為什麼被擋，別去找繞路）', () => {
  const p = buildAgentPrompt(input());
  assert.match(p, /不要使用 `gh`/);
  assert.match(p, /不要 `git push`/);
  assert.match(p, /沒有 GitHub 認證/);
});

test('非 Bash 工具不受 Bash 紅線影響', () => {
  assert.deepEqual(evaluateToolPolicy('Read', { file_path: '/etc/passwd' }), { deny: false });
  assert.deepEqual(evaluateToolPolicy('Edit', { file_path: 'src/a.ts' }), { deny: false });
  // 同樣的字串放到非 Bash 工具不會被誤擋
  assert.deepEqual(evaluateToolPolicy('Write', { content: 'rm -rf /' }), { deny: false });
});

test('command 缺席或非字串時不誤擋也不丟錯', () => {
  assert.deepEqual(evaluateToolPolicy('Bash', {}), { deny: false });
  assert.deepEqual(evaluateToolPolicy('Bash', { command: 123 }), { deny: false });
  assert.deepEqual(evaluateToolPolicy('Bash', { command: null }), { deny: false });
});

// ── evaluateToolPolicy：保護路徑（Write / Edit / NotebookEdit） ──

const protectedWrites: [string, RegExp][] = [
  // CI 設定
  ['.github/workflows/ci.yml', /CI 設定/],
  ['.github/workflows/deploy.yaml', /CI 設定/],
  ['.github/actions/setup/action.yml', /CI 設定/],
  ['.gitlab-ci.yml', /CI 設定/],
  ['.circleci/config.yml', /CI 設定/],
  ['Jenkinsfile', /CI 設定/],
  // 部署設定
  ['firebase.json', /部署設定/],
  ['.firebaserc', /部署設定/],
  ['vercel.json', /部署設定/],
  ['netlify.toml', /部署設定/],
  ['wrangler.toml', /部署設定/],
  // secrets
  ['.env', /secrets/],
  ['.env.local', /secrets/],
  ['.env.production', /secrets/],
  ['certs/server.pem', /secrets/],
  ['certs/private.key', /secrets/],
  ['serviceAccount.json', /secrets/],
  ['.npmrc', /secrets/],
  // git 內部
  ['.git/config', /git 內部檔/],
  ['.git/hooks/pre-commit', /git 內部檔/],
];

for (const [path, label] of protectedWrites) {
  test(`保護路徑擋下寫入：${path}`, () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const v = evaluateToolPolicy(tool, { file_path: path });
      assert.equal(v.deny, true, `${tool} 寫入 ${path} 應被擋`);
      assert.match(v.reason ?? '', /^紅線：/);
      assert.match(v.reason ?? '', label);
      assert.match(v.reason ?? '', new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '理由要帶上路徑，agent 才知道是哪個檔');
    }
  });
}

test('保護路徑用絕對路徑（worktree 前綴）一樣擋得住', () => {
  const v = evaluateToolPolicy('Write', { file_path: '/Users/x/worktrees/g1/.github/workflows/ci.yml' });
  assert.equal(v.deny, true);
});

test('NotebookEdit 用 notebook_path 也受保護路徑檢查', () => {
  assert.equal(evaluateToolPolicy('NotebookEdit', { notebook_path: '.git/hooks/x.ipynb' }).deny, true);
  assert.deepEqual(evaluateToolPolicy('NotebookEdit', { notebook_path: 'notebooks/analysis.ipynb' }), { deny: false });
});

// 誤擋比漏擋更會拖垮系統：日常開發會碰到的路徑一律要放行
const allowedWrites = [
  'src/index.ts',
  'src/config/env.ts',
  'src/auth/credentials.ts',
  'src/utils/apiKey.ts',
  'src/keys/index.ts',
  'src/components/Env.tsx',
  'test/foo.test.ts',
  'README.md',
  'docs/deploy.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'config/orchestrator.yaml',
  'db/migrations/001_init.sql',
  'public/logo.svg',
  '.github/ISSUE_TEMPLATE/bug.md',
  '.github/pull_request_template.md',
  '.gitignore',
  'firestore.rules',
  'scripts/deploy.sh',
];

for (const path of allowedWrites) {
  test(`正常開發檔案放行：${path}`, () => {
    assert.deepEqual(evaluateToolPolicy('Write', { file_path: path }), { deny: false });
    assert.deepEqual(evaluateToolPolicy('Edit', { file_path: path }), { deny: false });
  });
}

test('範本/範例檔不算 secrets（.env.example 本來就該能改）', () => {
  for (const p of ['.env.example', '.env.sample', '.env.template', 'firebase.example.json', 'config/app.dist']) {
    assert.deepEqual(evaluateToolPolicy('Write', { file_path: p }), { deny: false }, `${p} 不該被擋`);
  }
});

test('file_path 缺席或非字串時不誤擋', () => {
  assert.deepEqual(evaluateToolPolicy('Write', {}), { deny: false });
  assert.deepEqual(evaluateToolPolicy('Edit', { file_path: 42 }), { deny: false });
  assert.deepEqual(evaluateToolPolicy('Edit', { file_path: '   ' }), { deny: false });
});

test('唯讀工具不受保護路徑限制（讀 .env 判斷設定是合理的）', () => {
  assert.deepEqual(evaluateToolPolicy('Read', { file_path: '.env' }), { deny: false });
  assert.deepEqual(evaluateToolPolicy('Grep', { path: '.git/config' }), { deny: false });
});

// ── 保護路徑：shell 繞道 ──

test('用指令刪除/覆寫保護路徑同樣擋下', () => {
  for (const cmd of ['rm .env', 'rm -f .github/workflows/ci.yml', 'echo "{}" > firebase.json', 'cat x >> .env.production']) {
    const v = evaluateToolPolicy('Bash', { command: cmd });
    assert.equal(v.deny, true, `應被擋：${cmd}`);
    assert.match(v.reason ?? '', /^紅線：/);
  }
});

test('唯讀/一般 shell 操作不因保護路徑被誤擋', () => {
  for (const cmd of [
    'cat .env',
    'grep -r API_KEY .env',
    'cp .env.example .env.local.bak',
    'npm test > /tmp/out.log 2>&1',
    'rm -rf dist && npm run build',
    'git rm --cached src/old.ts',
  ]) {
    assert.deepEqual(evaluateToolPolicy('Bash', { command: cmd }), { deny: false }, `不該被擋：${cmd}`);
  }
});

// ── 保護路徑可由設定覆寫 ──

test('protectedPaths 可覆寫（給定即取代內建集合）', () => {
  const opts = { protectedPaths: ['**/infra/**'] };
  assert.equal(evaluateToolPolicy('Write', { file_path: 'infra/main.tf' }, opts).deny, true);
  // 取代後內建的 CI 保護不再生效（專案自行負責）
  assert.deepEqual(evaluateToolPolicy('Write', { file_path: '.github/workflows/ci.yml' }, opts), { deny: false });
});

test('allowPaths 疊在內建例外之上，可解開特定保護路徑', () => {
  const opts = { allowPaths: ['**/.github/workflows/docs.yml'] };
  assert.deepEqual(evaluateToolPolicy('Write', { file_path: '.github/workflows/docs.yml' }, opts), { deny: false });
  assert.equal(evaluateToolPolicy('Write', { file_path: '.github/workflows/ci.yml' }, opts).deny, true);
  // 內建例外仍在
  assert.deepEqual(evaluateToolPolicy('Write', { file_path: '.env.example' }, opts), { deny: false });
});

test('resolveToolPolicy 預設值本身是安全的（沒帶設定也擋得住）', () => {
  const p = resolveToolPolicy();
  assert.ok(p.protectedRules.length > 0);
  assert.ok(p.protectedRules.some((r) => r.pattern.includes('.github/workflows')));
  assert.ok(p.allowPaths.length > 0);
});

// ── shell 指令拆解（紅線比對前的正規化） ──

test('tokenizeShell：引號內視為單一 token，跳脫字元被還原', () => {
  assert.deepEqual(tokenizeShell('echo "npm run deploy"'), ['echo', 'npm run deploy']);
  assert.deepEqual(tokenizeShell("sh -c 'rm -rf /'"), ['sh', '-c', 'rm -rf /']);
  assert.deepEqual(tokenizeShell('git commit -m "feat: 深色模式"'), ['git', 'commit', '-m', 'feat: 深色模式']);
});

test('decomposeShellCommand：; && || | 換行都會切段', () => {
  const d = decomposeShellCommand('npm ci && npm run build; npm test | tee out.log\ngit status');
  assert.deepEqual(d.commands, [
    ['npm', 'ci'],
    ['npm', 'run', 'build'],
    ['npm', 'test'],
    ['tee', 'out.log'],
    ['git', 'status'],
  ]);
});

test('decomposeShellCommand：剝掉 sudo/env/npx 與環境變數前綴', () => {
  assert.deepEqual(decomposeShellCommand('sudo npm ci').commands, [['npm', 'ci']]);
  assert.deepEqual(decomposeShellCommand('env FOO=1 BAR=2 npm test').commands, [['npm', 'test']]);
  assert.deepEqual(decomposeShellCommand('FOO=1 npm test').commands, [['npm', 'test']]);
  assert.deepEqual(decomposeShellCommand('npx tsc --noEmit').commands, [['tsc', '--noEmit']]);
});

test('decomposeShellCommand：bash -c / sh -c 的內層字串會被拆開往內看', () => {
  assert.deepEqual(decomposeShellCommand('bash -c "npm run build && npm test"').commands, [
    ['npm', 'run', 'build'],
    ['npm', 'test'],
  ]);
  assert.deepEqual(decomposeShellCommand("sh -c 'firebase deploy'").commands, [['firebase', 'deploy']]);
  // 內層字串也要留在 sources，保護路徑掃描才看得到
  assert.ok(decomposeShellCommand('bash -c "rm .env"').sources.includes('rm .env'));
});

test('decomposeShellCommand：2>&1 不是指令分隔符（不可把重導向切壞）', () => {
  assert.deepEqual(decomposeShellCommand('npm test > out.log 2>&1').commands, [
    ['npm', 'test', '>', 'out.log', '2>&1'],
  ]);
});

test('isDeployScriptName：deploy / deploy:prod / build:deploy 算，predeploy 不算', () => {
  for (const n of ['deploy', 'deploy:prod', 'build:deploy', 'deploy-web']) {
    assert.equal(isDeployScriptName(n), true, `${n} 應視為部署 script`);
  }
  for (const n of ['predeploy', 'deployment', 'test:deploy-check', 'build', '']) {
    assert.equal(isDeployScriptName(n), false, `${n} 不該被視為部署 script`);
  }
});

// ── 紅線：繞道寫法（缺陷 4）──

const deniedBypass: [string, RegExp][] = [
  // 套件管理器：沒有 run、run-script、其他 PM
  ['yarn deploy', /deploy script/],
  ['pnpm deploy', /deploy script/],
  ['bun run deploy', /deploy script/],
  ['npm run-script deploy', /deploy script/],
  ['npm run deploy --if-present', /deploy script/],
  ['npm --prefix ./web run deploy', /deploy script/],
  ['npm run build:deploy', /deploy script/],
  // firebase 的其他部署子指令
  ['firebase hosting:channel:deploy preview', /firebase deploy/],
  ['firebase functions:deploy api', /firebase deploy/],
  // 強推的其他寫法（現在連一般 push 都擋，理由統一成外部動作）
  ['git push origin +main', /外部動作/],
  ['git push origin +refs/heads/main', /外部動作/],
  ['git push origin +feature/x', /外部動作/],
  ['git -C /repo push --force origin main', /外部動作/],
  // 包裝繞道
  ['bash -c "npm run deploy"', /deploy script/],
  ["sh -c 'firebase deploy'", /firebase deploy/],
  ['bash -lc "vercel deploy --prod"', /雲端部署/],
  ['env FIREBASE_TOKEN=x firebase deploy', /firebase deploy/],
  ['FOO=1 npm run deploy', /deploy script/],
  ['npx firebase deploy', /firebase deploy/],
  ['sudo bash -c "rm -rf /var"', /rm -rf/],
  // 串接繞道
  ['npm run build && vercel --prod', /雲端部署/],
  ['npm test; firebase deploy', /firebase deploy/],
  ['npm run lint || yarn deploy', /deploy script/],
  ['(cd web && npm run deploy)', /deploy script/],
  // 其他部署途徑
  ['make deploy', /deploy target/],
  ['bash scripts/deploy.sh', /部署腳本/],
  ['./deploy.sh --prod', /部署腳本/],
  ['node scripts/deploy.js', /部署腳本/],
  ['gh-pages -d dist', /雲端部署/],
  ['gcloud run deploy api --region us-central1', /雲端部署/],
  ['wrangler pages deploy dist', /雲端部署/],
  ['npm publish', /發布套件/],
  ['git reset --hard upstream/main', /hard reset/],
];

for (const [cmd, reason] of deniedBypass) {
  test(`紅線擋下繞道寫法：${cmd}`, () => {
    const v = evaluateToolPolicy('Bash', { command: cmd });
    assert.equal(v.deny, true, `應被拒絕：${cmd}`);
    assert.match(v.reason ?? '', /^紅線：/);
    assert.match(v.reason ?? '', reason);
  });
}

// 誤擋比漏擋更會拖垮系統：這些都是日常開發指令，一律要放行
const allowedAfterHardening = [
  'npm run build && npm test',
  'npm ci && npm run typecheck',
  'yarn build',
  'yarn install --frozen-lockfile',
  'pnpm install',
  'bun run test',
  'npm run test:e2e',
  'npm run build:prod',
  'npm run predeploy',
  'time npm run build',
  'sudo npm install -g tsx',
  'git reset --hard HEAD~1',
  'bash scripts/setup.sh',
  'node scripts/build.js',
  'vercel --version',
  'netlify status',
  'firebase --version',
  'firebase emulators:start',
  'grep -rn deploy src/',
  'echo "npm run deploy" >> notes.md',
  'npm test > out.log 2>&1',
  'mv src/a.ts src/b.ts',
  'rm -rf .github/ISSUE_TEMPLATE',
];

for (const cmd of allowedAfterHardening) {
  test(`強化後仍放行正常指令：${cmd}`, () => {
    assert.deepEqual(evaluateToolPolicy('Bash', { command: cmd }), { deny: false }, `不該被擋：${cmd}`);
  });
}

// ── 保護路徑：刪整個目錄（缺陷 5）──

test('directoryFormsOf：由 glob 推出目錄本身的形式', () => {
  assert.deepEqual(directoryFormsOf('**/.github/workflows/**'), ['**/.github/workflows', '**/.github']);
  assert.deepEqual(directoryFormsOf('**/.git/**'), ['**/.git']);
  assert.deepEqual(directoryFormsOf('**/*.pem'), [], '萬用字元段落推不出目錄');
  assert.deepEqual(directoryFormsOf('**/Jenkinsfile'), []);
});

const deniedDirRemovals: [string, RegExp][] = [
  ['rm -rf .github/workflows', /CI 設定/],
  ['rm -rf .github/workflows/', /CI 設定/],
  ['rm -rf .github', /CI 設定/],
  ['rm -rf .git', /git 內部檔/],
  ['rm -r .circleci', /CI 設定/],
  ['bash -c "rm -rf .git"', /git 內部檔/],
  ['mv .env /tmp/backup', /secrets/],
];

for (const [cmd, label] of deniedDirRemovals) {
  test(`刪整個保護目錄同樣擋下：${cmd}`, () => {
    const v = evaluateToolPolicy('Bash', { command: cmd });
    assert.equal(v.deny, true, `應被擋：${cmd}`);
    assert.match(v.reason ?? '', /^紅線：/);
    assert.match(v.reason ?? '', label);
  });
}

test('刪一般目錄不受影響（誤擋會讓 agent 連 build 產物都清不掉）', () => {
  for (const cmd of ['rm -rf dist', 'rm -rf node_modules', 'rm -rf coverage .nyc_output', 'rm -rf src/legacy']) {
    assert.deepEqual(evaluateToolPolicy('Bash', { command: cmd }), { deny: false }, `不該被擋：${cmd}`);
  }
});

// ── package.json script 紅線（缺陷 6）──
//
// Verifier 會以 shell 實跑 npm script，所以能寫 package.json 就等於能執行任意指令。

const PKG = (scripts: Record<string, string>): string =>
  JSON.stringify({ name: 'app', version: '1.0.0', scripts, dependencies: { react: '^18.0.0' } }, null, 2);

test('把部署指令塞進 build script → 擋下（否則 npm run build 就會真的部署）', () => {
  const v = evaluateToolPolicy('Write', { file_path: 'package.json', content: PKG({ build: 'vite build && firebase deploy' }) });
  assert.equal(v.deny, true);
  assert.match(v.reason ?? '', /^紅線：/);
  assert.match(v.reason ?? '', /package\.json/);
  assert.match(v.reason ?? '', /"build"/);
});

test('以 Edit 片段改 script 一樣擋（agent 通常只改一行）', () => {
  const v = evaluateToolPolicy('Edit', {
    file_path: 'package.json',
    old_string: '"build": "vite build"',
    new_string: '"build": "vite build && firebase deploy"',
  });
  assert.equal(v.deny, true);
  assert.match(v.reason ?? '', /firebase deploy/);
});

test('MultiEdit 的每一段 new_string 都要檢查', () => {
  const v = evaluateToolPolicy('MultiEdit', {
    file_path: 'package.json',
    edits: [
      { old_string: '"lint": "eslint ."', new_string: '"lint": "eslint . --fix"' },
      { old_string: '"test": "vitest run"', new_string: '"test": "vitest run && npm run deploy"' },
    ],
  });
  assert.equal(v.deny, true);
  assert.match(v.reason ?? '', /"test"/);
});

test('子目錄的 package.json 同樣受檢查', () => {
  const v = evaluateToolPolicy('Write', { file_path: 'web/package.json', content: PKG({ start: 'vercel --prod' }) });
  assert.equal(v.deny, true);
});

test('JSON 解析失敗（寫到一半/含註解）不代表放行', () => {
  const broken = '{\n  "scripts": {\n    "build": "tsc && firebase deploy",\n';
  assert.equal(evaluateToolPolicy('Write', { file_path: 'package.json', content: broken }).deny, true);
});

test('shell 覆寫 package.json 也擋得住危險 script', () => {
  const v = evaluateToolPolicy('Bash', { command: `echo '${PKG({ build: 'firebase deploy' })}' > package.json` });
  assert.equal(v.deny, true, 'firebase deploy 出現在指令列本身就該擋');
});

test('專案原本就有的 deploy script 不擋（Verifier 不會跑它，擋了只是妨礙維護）', () => {
  const v = evaluateToolPolicy('Write', {
    file_path: 'package.json',
    content: PKG({ build: 'vite build', test: 'vitest run', deploy: 'firebase deploy', 'deploy:prod': 'firebase deploy --only hosting' }),
  });
  assert.deepEqual(v, { deny: false });
});

test('正常的 package.json 維護一律放行', () => {
  const cases: Array<Record<string, unknown>> = [
    { file_path: 'package.json', content: PKG({ build: 'tsc -p .', test: 'vitest run', lint: 'eslint .' }) },
    { file_path: 'package.json', new_string: '"zod": "^4.4.3"' },
    { file_path: 'package.json', new_string: '"scripts": {\n    "typecheck": "tsc --noEmit"\n  }' },
    { file_path: 'package.json' }, // 只帶路徑（拿不到內容就沒得判）
    { file_path: 'package-lock.json', content: '{"lockfileVersion":3}' },
    // 同樣內容放在別的 json 檔不受這條規則管（那不是 Verifier 會跑的東西）
    { file_path: 'tsconfig.json', content: PKG({ build: 'firebase deploy' }) },
  ];
  for (const input of cases) {
    assert.deepEqual(evaluateToolPolicy('Write', input), { deny: false }, `不該被擋：${JSON.stringify(input).slice(0, 60)}`);
  }
});

// ── SDK 串接層：PreToolUse hook（缺陷 3）──

test('PreToolUse hook：deny 時回傳 SDK 約定的 hookSpecificOutput 形狀', async () => {
  const rec = createRecordingLogger();
  const guard = createPreToolUseGuard(rec.logger);

  const out = await guard({ tool_name: 'Bash', tool_input: { command: 'firebase deploy' } });

  assert.deepEqual(out, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: '紅線：禁止 firebase deploy（專案綁部署）',
    },
  });
  assert.ok(rec.messages('warn').some((m) => m.includes('政策閘門擋下工具呼叫')), '擋下要留稽核紀錄');
});

test('PreToolUse hook：放行時回空物件（不可誤回 deny 形狀）', async () => {
  const guard = createPreToolUseGuard(createSilentLogger());
  assert.deepEqual(await guard({ tool_name: 'Bash', tool_input: { command: 'npm run build' } }), {});
  assert.deepEqual(await guard({ tool_name: 'Read', tool_input: { file_path: '.env' } }), {});
});

test('PreToolUse hook：吃得下缺欄位的 hookInput，不丟例外', async () => {
  const guard = createPreToolUseGuard(createSilentLogger());
  assert.deepEqual(await guard({}), {});
  assert.deepEqual(await guard({ tool_name: 'Bash' }), {});
  assert.deepEqual(await guard({ tool_name: 'Write', tool_input: null }), {});
});

test('PreToolUse hook：專案覆寫的保護路徑會生效', async () => {
  const guard = createPreToolUseGuard(createSilentLogger(), { protectedPaths: ['**/infra/**'] });
  const out = await guard({ tool_name: 'Write', tool_input: { file_path: 'infra/main.tf' } });
  assert.match(String((out as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason), /專案保護路徑/);
});

// ── SDK 串接層：Stop hook ──

function stopHookHarness(
  over: { changed?: boolean | Error; clar?: ClarificationCapture; blocks?: number; maxBlocks?: number } = {},
) {
  const captured: { clar?: ClarificationCapture } = over.clar ? { clar: over.clar } : {};
  const state = { blocks: over.blocks ?? 0 };
  const rec = createRecordingLogger();
  const hook = createStopHook({
    log: rec.logger,
    cwd: '/tmp/worktree',
    taskId: 'T-1',
    captured,
    state,
    maxBlocks: over.maxBlocks ?? 2,
    workingTreeChanged: async () => {
      if (over.changed instanceof Error) throw over.changed;
      return over.changed ?? true;
    },
  });
  return { hook, state, rec };
}

test('Stop hook：工作區零變更就想收工 → block 並要求續做', async () => {
  const h = stopHookHarness({ changed: false });
  const out = (await h.hook({})) as { continue?: boolean; systemMessage?: string };

  assert.equal(out.continue, true);
  assert.match(out.systemMessage ?? '', /工作區沒有任何檔案變更/);
  assert.equal(h.state.blocks, 1, '擋下次數要累加，否則會和外層 DoD 迴圈疊成活鎖');
  assert.ok(h.rec.messages('warn').some((m) => m.includes('Stop hook 擋下收工')));
});

test('Stop hook：有變更／提過澄清／已擋滿 → 一律放行（回空物件）', async () => {
  assert.deepEqual(await stopHookHarness({ changed: true }).hook({}), {});
  assert.deepEqual(await stopHookHarness({ changed: false, clar: { question: 'Q' } }).hook({}), {});
  assert.deepEqual(await stopHookHarness({ changed: false, blocks: 2 }).hook({}), {});
});

test('Stop hook：計數器歸零但 SDK 說已是續跑結果 → 靠 stop_hook_active 當下限，不無限重擋', async () => {
  const h = stopHookHarness({ changed: false, blocks: 0, maxBlocks: 1 });
  assert.deepEqual(await h.hook({ stop_hook_active: true }), {});
  // 同樣條件但沒有 stop_hook_active → 仍可擋一次
  assert.equal(((await stopHookHarness({ changed: false, blocks: 0, maxBlocks: 1 }).hook({})) as { continue?: boolean }).continue, true);
});

test('Stop hook：取工作區狀態失敗 → 放行（不可因 git 壞掉把 agent 關在迴圈裡）', async () => {
  const h = stopHookHarness({ changed: new Error('git 掛了') });
  assert.deepEqual(await h.hook({}), {});
  assert.equal(h.state.blocks, 0);
});

test('Stop hook：連續兩次零變更 → 擋兩次後放行給外層 DoD', async () => {
  const h = stopHookHarness({ changed: false });
  assert.equal(((await h.hook({})) as { continue?: boolean }).continue, true);
  assert.equal(((await h.hook({})) as { continue?: boolean }).continue, true);
  assert.deepEqual(await h.hook({}), {});
  assert.equal(h.state.blocks, 2);
});

// ── SDK 串接層：ask_human 工具 ──

test('ask_human：捕捉問題並回覆「採預設繼續」指示', async () => {
  const captured: { clar?: ClarificationCapture } = {};
  const rec = createRecordingLogger();
  const handler = createAskHumanHandler(captured, rec.logger, 'T-7');

  const res = await handler({ question: '要刪舊欄位嗎？', rationale: '不可逆', options: ['刪', '保留'] });

  assert.deepEqual(captured.clar, { question: '要刪舊欄位嗎？', rationale: '不可逆', options: ['刪', '保留'] });
  assert.deepEqual(res, { content: [{ type: 'text', text: ASK_HUMAN_FALLBACK }] });
  assert.ok(rec.messages('info').some((m) => m.includes('ask_human 被呼叫')));
});

test('ask_human：只有 question 也能捕捉（選項/理由可省略）', async () => {
  const captured: { clar?: ClarificationCapture } = {};
  await createAskHumanHandler(captured, createSilentLogger(), 'T-8')({ question: 'Q' });
  assert.deepEqual(captured.clar, { question: 'Q', rationale: undefined, options: undefined });
});

test('ask_human：後一次提問覆蓋前一次（Worker 只 park 最新問題）', async () => {
  const captured: { clar?: ClarificationCapture } = {};
  const handler = createAskHumanHandler(captured, createSilentLogger(), 'T-9');
  await handler({ question: '第一題' });
  await handler({ question: '第二題' });
  assert.equal(captured.clar?.question, '第二題');
});

// ── SDK 串接層：訊息串流解析 ──

async function* stream(...msgs: unknown[]): AsyncIterable<unknown> {
  for (const m of msgs) yield m;
}

test('串流解析：init 取 sessionId、success 取 result 文字', async () => {
  const out = await collectStreamOutcome(
    stream(
      { type: 'system', subtype: 'init', session_id: 's-1' },
      { type: 'assistant', message: { content: [] } },
      { type: 'result', subtype: 'success', session_id: 's-1', result: '做完了' },
    ),
  );
  assert.deepEqual(out, { sessionId: 's-1', resultText: '做完了', isError: false });
});

test('串流解析：只有 result 帶 session_id 時也要取到（resume 靠它）', async () => {
  const out = await collectStreamOutcome(stream({ type: 'result', subtype: 'success', session_id: 's-2', result: 'ok' }));
  assert.equal(out.sessionId, 's-2');
});

test('串流解析：非 success 的 result 一律視為錯誤', async () => {
  for (const subtype of ['error_max_turns', 'error_during_execution', 'error']) {
    const out = await collectStreamOutcome(stream({ type: 'result', subtype, session_id: 's-3' }));
    assert.equal(out.isError, true, `${subtype} 應判為錯誤`);
    assert.equal(out.resultText, '');
  }
});

test('串流解析：success 但沒有 result 欄位 → 空字串而不是 undefined', async () => {
  const out = await collectStreamOutcome(stream({ type: 'result', subtype: 'success' }));
  assert.deepEqual(out, { sessionId: undefined, resultText: '', isError: false });
});

test('串流解析：空串流／未知訊息／null 都不會炸', async () => {
  assert.deepEqual(await collectStreamOutcome(stream()), { sessionId: undefined, resultText: '', isError: false });
  assert.deepEqual(await collectStreamOutcome(stream(null, undefined, { type: 'user' }, 'noise')), {
    sessionId: undefined,
    resultText: '',
    isError: false,
  });
});

test('串流解析：後續 init 不會把已取得的 sessionId 洗成 undefined', async () => {
  const out = await collectStreamOutcome(
    stream({ type: 'system', subtype: 'init', session_id: 's-4' }, { type: 'system', subtype: 'init' }, {
      type: 'result',
      subtype: 'success',
      result: 'ok',
    }),
  );
  assert.equal(out.sessionId, 's-4');
});

// ── evaluateCommandRedline：供 package.json script 等「非 Bash 工具」重用 ──

test('evaluateCommandRedline 可獨立判定任意指令字串', () => {
  assert.equal(evaluateCommandRedline('vite build && firebase deploy').deny, true);
  assert.deepEqual(evaluateCommandRedline('vite build'), { deny: false });
  assert.deepEqual(evaluateCommandRedline(''), { deny: false });
  assert.deepEqual(evaluateCommandRedline('   '), { deny: false });
});

test('resolveToolPolicy 會一併展開目錄形式（刪目錄的防線來源）', () => {
  const p = resolveToolPolicy();
  assert.ok(p.protectedRules.some((r) => r.pattern === '**/.git'), '要有 .git 目錄本身的規則');
  assert.ok(p.protectedRules.some((r) => r.pattern === '**/.github/workflows'));
  assert.equal(new Set(p.protectedRules.map((r) => r.pattern)).size, p.protectedRules.length, '規則不可重複');
});

/**
 * SDK 的錯誤語意（SDKAssistantMessageError）與 api_retry 訊息的解析。
 *
 * 這些是「真實會從 SDK 收到的訊息形狀」——不是模擬注入的假故障。
 * SDK 對可重試的錯誤（429/529/5xx）會自己先重試並發 system/api_retry 通知，
 * 帶著真正的 HTTP 狀態碼；最終仍失敗才會給 result error。
 */
// ── SDK 錯誤語意（SDKAssistantMessageError）與 api_retry 解析 ──
//
// 這些是「真實會從 SDK 收到的訊息形狀」，不是模擬注入的假故障：SDK 對可重試的錯誤
// （429/529/5xx）會自己先重試並發 system/api_retry 通知，帶著真正的 HTTP 狀態碼。


const sdkStream = (msgs: unknown[]): AsyncIterable<unknown> => ({
  async *[Symbol.asyncIterator]() {
    for (const m of msgs) yield m;
  },
});
const initMsg = { type: 'system', subtype: 'init', session_id: 's1' };
const errResult = (extra: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'error_during_execution', session_id: 's1', errors: [], ...extra,
});

test('SDK 錯誤：overloaded（529）→ transient：值得等，退避後重試', async () => {
  const out = await collectStreamOutcome(sdkStream([
    initMsg,
    { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 5, retry_delay_ms: 2000, error_status: 529, error: 'overloaded' },
    errResult(),
  ]));
  assert.equal(out.isError, true);
  assert.equal(out.errorKind, 'transient');
  assert.equal(out.sdkError, 'overloaded');
  assert.equal(out.httpStatus, 529);
  assert.equal(out.retries?.length, 1);
  assert.equal(out.retries?.[0]?.delayMs, 2000);
});

test('SDK 錯誤：rate_limit（429）→ transient', async () => {
  const out = await collectStreamOutcome(sdkStream([
    initMsg,
    { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 5000, error_status: 429, error: 'rate_limit' },
    errResult(),
  ]));
  assert.equal(out.errorKind, 'transient');
  assert.equal(out.httpStatus, 429);
});

test('SDK 錯誤：authentication_failed（401）→ permanent：重試一萬次也不會好', async () => {
  const out = await collectStreamOutcome(sdkStream([
    initMsg,
    { type: 'assistant', error: 'authentication_failed', message: {}, parent_tool_use_id: null },
    errResult(),
  ]));
  assert.equal(out.errorKind, 'permanent');
  assert.equal(out.sdkError, 'authentication_failed');
});

test('SDK 錯誤：billing_error / invalid_request / model_not_found 全屬 permanent', () => {
  for (const e of ['billing_error', 'invalid_request', 'model_not_found', 'oauth_org_not_allowed'] as const) {
    assert.equal(classifyAgentError({ sdkError: e }), 'permanent', e);
  }
});

test('SDK 錯誤：server_error（5xx）→ transient', () => {
  assert.equal(classifyAgentError({ sdkError: 'server_error' }), 'transient');
});

test('SDK 錯誤：max_output_tokens 與各種上限 → capacity（要調設定/拆任務，不是等它好）', () => {
  assert.equal(classifyAgentError({ sdkError: 'max_output_tokens' }), 'capacity');
  assert.equal(classifyAgentError({ resultSubtype: 'error_max_turns' }), 'capacity');
  assert.equal(classifyAgentError({ resultSubtype: 'error_max_budget_usd' }), 'capacity');
  assert.equal(classifyAgentError({ resultSubtype: 'error_max_structured_output_retries' }), 'capacity');
});

test('SDK 錯誤：SDK 沒給語意碼時退回 HTTP 狀態碼：4xx=permanent、5xx/429=transient', () => {
  assert.equal(classifyAgentError({ status: 400 }), 'permanent');
  assert.equal(classifyAgentError({ status: 403 }), 'permanent');
  assert.equal(classifyAgentError({ status: 404 }), 'permanent');
  assert.equal(classifyAgentError({ status: 429 }), 'transient');
  assert.equal(classifyAgentError({ status: 500 }), 'transient');
  assert.equal(classifyAgentError({ status: 503 }), 'transient');
});

test('SDK 錯誤：連狀態碼都沒有時看錯誤文字（連線逾時等沒有 HTTP 回應的情況）', () => {
  assert.equal(classifyAgentError({ texts: ['request timed out after 60s'] }), 'transient');
  assert.equal(classifyAgentError({ texts: ['ECONNRESET'] }), 'transient');
  assert.equal(classifyAgentError({ texts: ['401 Unauthorized: invalid api key'] }), 'permanent');
  assert.equal(classifyAgentError({ texts: ['something weird'] }), 'unknown');
});

test('SDK 錯誤：api_retry 後最終成功 → 不算錯誤，但重試軌跡仍記下來（觀測用）', async () => {
  const out = await collectStreamOutcome(sdkStream([
    initMsg,
    { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 5, retry_delay_ms: 1000, error_status: 529, error: 'overloaded' },
    { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 2000, error_status: 529, error: 'overloaded' },
    { type: 'result', subtype: 'success', session_id: 's1', result: '完成了' },
  ]));
  assert.equal(out.isError, false);
  assert.equal(out.resultText, '完成了');
  assert.equal(out.retries?.length, 2, 'SDK 自己重試過，外層要看得到（否則只覺得這輪很慢）');
  assert.equal(out.errorKind, undefined);
});

test('SDK 錯誤：連線錯誤沒有 HTTP 回應（error_status=null）→ 不會誤填 httpStatus', async () => {
  const out = await collectStreamOutcome(sdkStream([
    initMsg,
    { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 1000, error_status: null, error: 'unknown' },
    errResult(),
  ]));
  assert.equal(out.httpStatus, undefined);
  assert.equal(out.retries?.[0]?.status, null);
});


// ── 用量／成本解析（SDK 的 result 訊息） ──

test('parseUsage：加總各模型的 token，成本用 total_cost_usd', () => {
  const u = parseUsage({
    type: 'result',
    subtype: 'success',
    total_cost_usd: 1.25,
    num_turns: 7,
    duration_ms: 42_000,
    modelUsage: {
      'claude-opus-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5000, costUSD: 1.0 },
      'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 300, costUSD: 0.25 },
    },
  });
  assert.equal(u?.costUsd, 1.25);
  assert.equal(u?.inputTokens, 110);
  assert.equal(u?.outputTokens, 22);
  assert.equal(u?.cacheReadTokens, 5300);
  assert.deepEqual(u?.models.sort(), ['claude-haiku-4-5-20251001', 'claude-opus-5']);
  assert.equal(u?.numTurns, 7);
  assert.equal(u?.durationMs, 42_000);
});

test('parseUsage：沒有 total_cost_usd 時退回各模型 costUSD 加總', () => {
  const u = parseUsage({ modelUsage: { m1: { costUSD: 0.3 }, m2: { costUSD: 0.7 } } });
  assert.equal(u?.costUsd, 1);
});

/** 錯誤結束的 result 也會帶用量——跑了就是花了錢，不記就等於帳目短少。 */
test('parseUsage：錯誤結束的 result 一樣解析得到用量', () => {
  const u = parseUsage({
    type: 'result',
    subtype: 'error_during_execution',
    total_cost_usd: 0.4,
    modelUsage: { 'claude-opus-5': { inputTokens: 5, outputTokens: 1 } },
  });
  assert.equal(u?.costUsd, 0.4);
  assert.equal(u?.inputTokens, 5);
});

test('parseUsage：缺欄位的訊息回 undefined（不編造 0 成本的紀錄）', () => {
  assert.equal(parseUsage({ type: 'result', subtype: 'success' }), undefined);
  assert.equal(parseUsage(null), undefined);
  assert.equal(parseUsage('nope'), undefined);
});

test('parseUsage：只有 total_cost_usd、沒有 modelUsage 也能記（token 為 0）', () => {
  const u = parseUsage({ total_cost_usd: 0.05 });
  assert.equal(u?.costUsd, 0.05);
  assert.deepEqual(u?.models, []);
  assert.equal(u?.inputTokens, 0);
});

// ── 瀏覽器工具與暫存輸出隔離 ──

/**
 * agent 先前做 UI 是閉著眼睛做：改完 CSS 只能靠 build 過了就當沒事。
 * 給它瀏覽器之後最大的風險不是它亂點，而是 Playwright MCP 預設把截圖／快照／log
 * 寫在「當下工作目錄」——落進 worktree 就會被 git add -A 吃進 PR，
 * 更糟的是讓「diff 非空」的 DoD 被垃圾檔滿足。這個 repo 自己被吃進過三個 commit。
 */
describe('browserServerConfig', () => {
  it('沒指定輸出根目錄 → 不掛瀏覽器（寧可沒有，也不要寫進 worktree）', () => {
    assert.equal(browserServerConfig(undefined, 'T-1'), undefined);
    assert.equal(browserServerConfig('   ', 'T-1'), undefined);
  });

  it('輸出目錄一任務一個，且帶上必要旗標', () => {
    const dir = mkdtempSync(join(tmpdir(), 'browser-root-'));
    const cfg = browserServerConfig(dir, 'LIVE-1')!;
    assert.equal(cfg.command, 'npx');
    const outIdx = cfg.args.indexOf('--output-dir');
    assert.ok(outIdx > 0);
    assert.equal(cfg.args[outIdx + 1], join(dir, 'LIVE-1'));
    assert.ok(existsSync(join(dir, 'LIVE-1')), '目錄要先建好，否則 MCP 可能退回當下工作目錄');
    for (const flag of ['--headless', '--isolated', '--no-sandbox']) {
      assert.ok(cfg.args.includes(flag), `缺少 ${flag}`);
    }
    assert.equal(cfg.args[cfg.args.indexOf('--output-mode') + 1], 'stdout');
  });

  it('任務 id 含路徑字元也不會跳出根目錄', () => {
    const dir = mkdtempSync(join(tmpdir(), 'browser-root2-'));
    const cfg = browserServerConfig(dir, '../../etc/passwd')!;
    const out = cfg.args[cfg.args.indexOf('--output-dir') + 1]!;
    // 真正要驗的是「解析後仍在根目錄底下」。名字開頭有兩個點不代表能跳出去——
    // 路徑分隔符被換掉之後 `.._.._etc_passwd` 只是個難看的**單層**目錄名，不是 traversal。
    assert.ok(resolve(out).startsWith(resolve(dir) + sep), `跳出根目錄：${out}`);
    assert.equal(resolve(out).split(sep).length, resolve(dir).split(sep).length + 1, '只能多一層');
  });
});

describe('瀏覽器工具的紅線', () => {
  it('用瀏覽器開本機檔案 → 擋下（深度防禦；MCP 的旗標可能被改掉）', () => {
    const v = evaluateToolPolicy('mcp__playwright__browser_navigate', { url: 'file:///etc/passwd' });
    assert.equal(v.deny, true);
    assert.match(v.reason ?? '', /本機檔案/);
  });

  it('一般網址照常放行', () => {
    assert.equal(evaluateToolPolicy('mcp__playwright__browser_navigate', { url: 'http://127.0.0.1:5173/sandbox' }).deny, false);
  });

  /**
   * **SDK 的 allowedTools 對 MCP 工具不具強制力。**
   * 實跑證實：browser_run_code_unsafe 沒列進 allowedTools，agent 照樣呼叫成功
   * （工具使用紀錄裡看得到那一次呼叫）。所以「不列進清單」不是保證，
   * 真正的攔截點是 PreToolUse hook——那是我們自己的程式碼。
   */
  it('沒列進清單的瀏覽器工具 → **由閘門擋下**（不能只靠 allowedTools）', () => {
    for (const t of ['browser_run_code_unsafe', 'browser_file_upload', 'browser_handle_dialog']) {
      assert.equal(ALLOWED_TOOLS.includes(`mcp__playwright__${t}`), false, `${t} 不該列進清單`);
      const v = evaluateToolPolicy(`mcp__playwright__${t}`, {});
      assert.equal(v.deny, true, `${t} 必須被閘門擋下，清單擋不住它`);
      assert.match(v.reason ?? '', /不在允許清單內/);
    }
  });

  it('清單內的瀏覽器工具照常放行', () => {
    assert.ok(ALLOWED_TOOLS.includes('mcp__playwright__browser_navigate'));
    assert.equal(evaluateToolPolicy('mcp__playwright__browser_navigate', { url: 'http://127.0.0.1:5173' }).deny, false);
    assert.equal(evaluateToolPolicy('mcp__playwright__browser_click', {}).deny, false);
  });
});

describe('工具使用回報', () => {
  it('每次呼叫都回報工具名（放行與否不受影響）', async () => {
    const seen: string[] = [];
    const guard = createPreToolUseGuard(createSilentLogger(), undefined, (n) => seen.push(n));

    await guard({ tool_name: 'Read', tool_input: { file_path: '/a.ts' } });
    await guard({ tool_name: 'mcp__playwright__browser_navigate', tool_input: { url: 'http://127.0.0.1:5173' } });

    assert.deepEqual(seen, ['Read', 'mcp__playwright__browser_navigate']);
  });

  it('被擋下的呼叫**也要**回報（不然「它試了但被擋」就查不到）', async () => {
    const seen: string[] = [];
    const guard = createPreToolUseGuard(createSilentLogger(), undefined, (n) => seen.push(n));

    const v = await guard({ tool_name: 'mcp__playwright__browser_navigate', tool_input: { url: 'file:///etc/passwd' } });

    assert.equal(v.hookSpecificOutput?.permissionDecision, 'deny');
    assert.deepEqual(seen, ['mcp__playwright__browser_navigate']);
  });
});
