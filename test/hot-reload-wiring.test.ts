import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectRegistry } from '../src/core/project-registry.js';
import { createSilentLogger } from './helpers/index.js';
import type { ProjectConfig } from '../src/config/index.js';
import type { ProjectRuntime } from '../src/core/group-runner.js';

/**
 * 控制台的存檔鈕會顯示「已儲存」、欄位也會顯示新值（loadSettings 回頭讀 DB），
 * 所以「設定沒生效」這件事在畫面上**完全看不出來**。
 *
 * 先前只有 pollIntervalSec 與 maxConcurrentWorkers 是傳函式（每輪現拿），其餘吃開機快照：
 *  · commandTimeoutSec 改大 → daemon 仍用舊值判紅，agent 一直白改程式去追時間問題
 *  · allowLocalMerge 關掉想踩煞車 → 照舊自動合併（**不可逆的外部副作用**）
 *  · 專案層的驗收指令／逾時 → registry 只換 config、runtime 原封不動，而讀取端拿的是 runtime
 */

function code(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

test('自動合併是現拿的——關掉之後不可以再合併', async () => {
  const { GroupRunner } = await import('../src/core/group-runner.js');
  assert.ok(GroupRunner);
  // 型別層面就要允許函式，否則呼叫端只能傳快照
  assert.match(code('src/core/group-runner.ts'), /allowLocalMerge\?: boolean \| \(\(\) => boolean\)/);
  // 使用點必須解析函式，不能直接當布林用（那樣函式永遠是 truthy ⇒ 等於永遠開著）
  assert.match(code('src/core/group-runner.ts'), /typeof this\.deps\.allowLocalMerge === 'function'/);
  // 正式接線要傳函式
  assert.match(code('src/main.ts'), /allowLocalMerge: \(\) => externalActionFlags\(store\.settings\(\)/);
});

test('全域指令逾時是現拿的（makeVerifier 每次用時才建）', () => {
  const src = code('src/main.ts');
  assert.match(src, /verifierDepsOf\(liveSettings\(\)/, 'makeVerifier 讀開機快照 ＝ 改了逾時不生效');
  assert.match(src, /liveSettings: \(\) => store\.settings\(\)/, '正式接線沒接 liveSettings');
});

test('專案設定改了會套進 runtime（讀取端拿的是 runtime，不是 config）', async () => {
  const runtimes: ProjectRuntime[] = [];
  const cfg = (commands: Record<string, string>): ProjectConfig => ({
    id: 'p1', repo: 'acme/web', repoPath: '/repo',
    mcp: { transport: 'stdio', command: 'true' }, commands,
  } as unknown as ProjectConfig);

  const registry = new ProjectRegistry(
    async (p) => {
      const runtime = {
        repo: p.repo, repoPath: p.repoPath, baseBranch: 'main',
        verifierConfig: { ...p.commands }, mcp: {} as never,
      } as unknown as ProjectRuntime;
      runtimes.push(runtime);
      return { config: p, client: {} as never, source: {} as never, runtime };
    },
    createSilentLogger(),
    (runtime, p) => { runtime.verifierConfig = { ...(p as unknown as { commands: object }).commands } as never; },
  );

  await registry.sync([cfg({ test: 'npm test' })]);
  assert.deepEqual(registry.runtimeOf('acme/web')?.verifierConfig, { test: 'npm test' });

  // 只改指令（連線欄位沒動 ⇒ 指紋相同 ⇒ 不重建連線）
  await registry.sync([cfg({ test: 'npm run test:ci' })]);
  assert.deepEqual(
    registry.runtimeOf('acme/web')?.verifierConfig,
    { test: 'npm run test:ci' },
    'runtime 沒跟著換 ＝ 控制台改了驗收指令，daemon 永遠用開機那份',
  );
  assert.equal(runtimes.length, 1, '不該重建連線（那會中斷正在跑的輪詢）');
});

test('沒有「按了什麼都不會發生」的設定欄位', () => {
  const ui = readFileSync('src/console/ui.html', 'utf8');
  // progressRounds 從頭到尾只有宣告與賦值、沒有任何讀取端，所以欄位已從 UI 移除
  assert.doesNotMatch(ui, /s-rounds/, 'UI 還留著無進展輪數，但它沒有消費端');
  assert.doesNotMatch(code('src/core/group-runner.ts'), /progressRounds/);
  assert.doesNotMatch(code('src/main.ts'), /progressRounds/);
});

test('五個角色的模型別名都是現拿的（控制台換模型不必重啟）', () => {
  const roles = [
    'src/worker/agent-runtime.ts', 'src/worker/reviewer.ts', 'src/core/plan-agent.ts',
    'src/pr/drift-judge.ts', 'src/core/merge-risk-judge.ts',
  ];
  for (const f of roles) {
    const src = code(f);
    assert.match(src, /model\?: Hot<string>;/, `${f} 的 model 還是寫死字串 ⇒ 收的是開機快照`);
    // 使用點必須解析，直接當值用的話傳函式進來會變成把函式當模型名送出去
    assert.match(src, /hotValue\(this\.deps\.model\)/, `${f} 沒有解析 Hot`);
  }
  // 正式接線：五個角色都傳函式
  const main = code('src/main.ts');
  for (const r of ['coder', 'reviewer', 'planner', 'driftJudge', 'riskJudge']) {
    assert.match(main, new RegExp(`model: modelOf\\('${r}'\\)`), `main.ts 的 ${r} 還在傳快照`);
  }
  assert.match(main, /liveSettings\(\)\.agent\.models/, 'modelOf 要從現拿的設定讀');
});

test('合併管線的專案清單是現拿的——開機後才加的專案也合併得了', async () => {
  const { createMergePipeline } = await import('../src/main.js');
  const specs: { id: string; runtime: never }[] = [];
  const built: string[] = [];

  const pipeline = await createMergePipeline({
    // 一開始是空的（等同「開機時這個專案還沒加進來」）
    projects: () => specs as never,
    actions: { allowLocalMerge: true },
    log: createSilentLogger(),
    ensureWorkspace: async (i: { path: string }) => { built.push(i.path); return i.path; },
  });
  assert.equal(pipeline, undefined, '一個專案都沒有 → 不接線');

  // 現在把專案加進來（＝控制台新增／重新啟用）
  specs.push({ id: 'uniwork', runtime: { repo: 'acme/web', repoPath: '/repo', baseBranch: 'main', verifierConfig: {} } as never });

  // 工作區路徑必須真的存在——resolveProject 會檢查（不在就當作被清掉了，回 undefined 並重建）
  const ws = mkdtempSync(join(tmpdir(), 'orch-ws-'));
  try {
    const p2 = await createMergePipeline({
      projects: () => specs as never,
      actions: { allowLocalMerge: true },
      log: createSilentLogger(),
      ensureWorkspace: async (i: { path: string }) => { built.push(i.path); return ws; },
    });
    assert.notEqual(p2, undefined);
    assert.ok(p2?.resolveProject('acme/web'), '現拿的清單要看得到後來才加的專案');
    // 正式接線也要傳函式——只有這裡是函式、main.ts 傳快照的話，線上照樣壞
    assert.match(code('src/main.ts'), /projects: \(\) => registry\.list\(\)/,
      'main.ts 傳的是開機快照 ⇒ 開機後才加的專案永遠合併不了（實跑：uniwork）');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('查不到專案時不判死——那三種來源都會自己好', () => {
  const src = code('src/core/orchestrator.ts');
  assert.match(src, /merge_deferred/, '要記成 deferred 而不是 merge_blocked');
  // failGroup 不可以出現在「查不到 runtime」那條路上
  const idx = src.indexOf('暫時找不到專案 runtime');
  assert.ok(idx > 0, '找不到延後處理的那段');
  const block = src.slice(idx, idx + 600);
  assert.doesNotMatch(block, /failGroup/, '判死等於毀掉人剛按的核准');
});
