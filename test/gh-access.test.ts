import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyGhAccess } from '../src/main.js';
import { interpretGhError } from '../src/pr/pr-manager.js';
import { createRecordingLogger } from './helpers/index.js';
import { readFileSync } from 'node:fs';

/**
 * 控制台設定的 GitHub token 看不到專案的 repo 時會發生什麼。
 *
 * ── 實跑災情（21:28）──
 *
 * 使用者在控制台設了一顆 fine-grained PAT，resource owner 是個人帳號，
 * 而專案的 repo 屬於某個 organization。**resource owner 選個人帳號的 fine-grained PAT
 * 看不到任何 organization 的 repo** —— 那是 GitHub 的規則，不是設定漏了什麼。
 *
 * 而 `GH_TOKEN` 一旦被設定，gh 就完全不看自己的認證（keyring／gh auth login）。
 * 所以那顆 token 不只是沒幫上忙 —— 它**把原本可用的 keyring 認證蓋掉了**，
 * 讓一個本來會動的系統壞掉。
 *
 * 更糟的是錯誤訊息：GitHub 對無權限的私有 repo 回 Not Found 而不是 403，
 * 於是 gh 吐出「Could not resolve to a Repository」，看起來像 repo 打錯或被刪了。
 * 這個誤導讓真正的原因延後一小時才被查出來。
 */

/** 假 gh：只有 allow 清單裡的 repo 看得到，而且可以區分「有沒有帶 token」。 */
function fakeGh(allow: { withToken: string[]; withoutToken: string[] }, env: NodeJS.ProcessEnv) {
  const calls: string[] = [];
  return {
    calls,
    run: async (args: string[]) => {
      const repo = (args[1] ?? '').replace(/^repos\//, '');
      calls.push(`${repo}${env.GH_TOKEN ? '(token)' : '(自帶認證)'}`);
      const list = env.GH_TOKEN ? allow.withToken : allow.withoutToken;
      return { exitCode: list.includes(repo) ? 0 : 1 };
    },
  };
}

test('token 看得到全部 repo → 什麼都不動', async () => {
  const env: NodeJS.ProcessEnv = { GH_TOKEN: 't', GITHUB_TOKEN: 't' };
  const gh = fakeGh({ withToken: ['org/a', 'org/b'], withoutToken: [] }, env);
  const log = createRecordingLogger();

  const r = await verifyGhAccess(['org/a', 'org/b'], log.logger, { run: gh.run, env });

  assert.deepEqual(r, { ok: ['org/a', 'org/b'], denied: [], revoked: false });
  assert.equal(env.GH_TOKEN, 't', '沒問題就不該動 token');
  assert.deepEqual(log.messages('error'), [], '不該吵');
});

/** 這是這次災情的正解：把蓋住可用認證的那顆 token 拿掉。 */
test('設定的 token 看不到、但 gh 自己的認證看得到 → 收回設定的 token', async () => {
  const env: NodeJS.ProcessEnv = { GH_TOKEN: 'pat', GITHUB_TOKEN: 'pat' };
  const gh = fakeGh({ withToken: [], withoutToken: ['paopaotui-co/Dinosaur'] }, env);
  const log = createRecordingLogger();

  const r = await verifyGhAccess(['paopaotui-co/Dinosaur'], log.logger, { run: gh.run, env });

  assert.equal(r.revoked, true);
  assert.deepEqual(r.ok, ['paopaotui-co/Dinosaur']);
  assert.deepEqual(r.denied, []);
  assert.equal(env.GH_TOKEN, undefined, '設定的 token 必須被收掉，否則 gh 不會用自己的認證');
  assert.equal(env.GITHUB_TOKEN, undefined);

  const err = log.messages('error').join('\n');
  assert.match(err, /已忽略設定裡的 token/);
  assert.match(err, /organization/, '要講出最常見的原因，不然使用者只會看到「沒權限」');
});

/** 兩邊都不行時把 token 放回去——至少維持原本的行為，不要讓狀態變得更難懂。 */
test('兩種認證都看不到 → token 放回去，但要吵得夠大聲', async () => {
  const env: NodeJS.ProcessEnv = { GH_TOKEN: 'pat', GITHUB_TOKEN: 'pat' };
  const gh = fakeGh({ withToken: [], withoutToken: [] }, env);
  const log = createRecordingLogger();

  const r = await verifyGhAccess(['org/x'], log.logger, { run: gh.run, env });

  assert.equal(r.revoked, false);
  assert.deepEqual(r.denied, ['org/x']);
  assert.equal(env.GH_TOKEN, 'pat', '放回去，維持原本行為');
  assert.match(log.messages('error').join('\n'), /開 PR、讀審查、合併全部會失敗/);
});

test('沒有設定 token 而 gh 自己也看不到 → 只警告，不亂動環境', async () => {
  const env: NodeJS.ProcessEnv = {};
  const gh = fakeGh({ withToken: [], withoutToken: [] }, env);
  const log = createRecordingLogger();

  const r = await verifyGhAccess(['org/x'], log.logger, { run: gh.run, env });

  assert.deepEqual(r.denied, ['org/x']);
  assert.equal(r.revoked, false);
  assert.match(log.messages('error').join('\n'), /Not Found/);
});

test('重複的 repo 只查一次', async () => {
  const env: NodeJS.ProcessEnv = { GH_TOKEN: 't' };
  const gh = fakeGh({ withToken: ['a/b'], withoutToken: [] }, env);
  await verifyGhAccess(['a/b', 'a/b', 'a/b'], createRecordingLogger().logger, { run: gh.run, env });
  assert.equal(gh.calls.length, 1);
});

// ── 錯誤訊息的翻譯 ──

/**
 * 「Could not resolve to a Repository」看起來像 repo 打錯或被刪了，
 * 實際上幾乎都是權限——GitHub 對無權限的私有 repo 回 Not Found 而不是 403。
 */
test('把誤導的 GitHub 錯誤翻譯成真正的原因', () => {
  const msg = interpretGhError(
    "GraphQL: Could not resolve to a Repository with the name 'paopaotui-co/Dinosaur'. (repository)",
    'paopaotui-co/Dinosaur',
  );
  assert.ok(msg);
  assert.match(msg, /Not Found 不是 403/);
  assert.match(msg, /resource owner 必須選 paopaotui-co/, '要指名是哪個 organization，不要只講抽象規則');
  assert.match(msg, /classic token|gh auth login/, '要給得出替代方案');
});

test('認證失效與權限不足是不同的原因，要分開講', () => {
  const msg = interpretGhError('gh: Bad credentials (HTTP 401)', 'a/b');
  assert.ok(msg);
  assert.match(msg, /沒有有效認證/);
  assert.doesNotMatch(msg, /organization/, '這個情境跟組織無關，講了只會誤導');
});

test('認不出來的錯誤不要硬掰原因', () => {
  assert.equal(interpretGhError('some unrelated failure', 'a/b'), undefined);
});


/**
 * 接線：驗證要在**啟動時**跑。
 *
 * 沒有這一步的話，問題會等到某一群跑了一小時、要開 PR 時才炸，
 * 而且炸出來的訊息看起來像「repo 不存在」——那正是這次花了一小時才查出來的原因。
 */
test('main 在啟動時就驗證 gh 對每個專案 repo 的存取權', () => {
  const src = readFileSync('src/main.ts', 'utf8');
  assert.match(
    src,
    /await verifyGhAccess\(\s*config\.projects\.map\(\(p\) => p\.repo\),\s*log,?\s*\)/,
    'main 沒有在啟動時呼叫 verifyGhAccess —— 問題會延後到開 PR 才浮現',
  );
  // 必須在 applyGh 之後：要驗的正是「設定裡那顆 token 灌進去之後」的狀態
  assert.ok(
    src.indexOf('applyGh(config.orchestrator.github.token)') < src.indexOf('await verifyGhAccess('),
    'verifyGhAccess 必須排在 applyGh 之後，否則驗的不是實際會用的認證',
  );
});

/** 接線：findPr 失敗時要把翻譯過的原因寫進 log，不是只吐 gh 的原始訊息。 */
test('findPr 失敗時把可能原因一起記下來', async () => {
  const { PrManager } = await import('../src/pr/pr-manager.js');
  const log = createRecordingLogger();
  const pm = new PrManager(log.logger, async () => ({
    exitCode: 1,
    stdout: '',
    stderr: "GraphQL: Could not resolve to a Repository with the name 'paopaotui-co/Dinosaur'. (repository)",
  }));

  const r = await pm.findOpenPr('paopaotui-co/Dinosaur', 'orch/x', '/tmp');

  assert.equal(r, undefined, '查不到就是查不到（呼叫端已經處理得安全）');
  const rec = log.records.find((x) => String(x.msg).includes('查詢既有 PR 失敗'));
  assert.ok(rec, '要留下紀錄');
  assert.ok((rec as { level: number }).level >= 50, '等級要是 error——warn 會被淹掉，這次就是這樣拖了一小時');
  assert.match(
    String((rec as Record<string, unknown>)['可能原因'] ?? ''),
    /resource owner 必須選 paopaotui-co/,
    'findPr 沒有把錯誤翻譯出來 —— 使用者只會看到「repo 不存在」',
  );
});
