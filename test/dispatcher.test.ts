import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher, type GroupRunner } from '../src/core/dispatcher.js';
import type { Group } from '../src/types.js';
import { createSilentLogger, createRecordingLogger } from './helpers/index.js';

function makeGroup(id: string, footprint: string[], repo = 'acme/web', afterGroups: string[] = []): Group {
  return {
    id,
    repo,
    branch: `orch/web/${id}`,
    taskIds: [`${id}-t1`],
    footprint,
    afterGroups,
    state: 'ready',
    createdAt: 1,
    updatedAt: 1,
  };
}

/** 可手動放行的 runner：dispatch 是同步的，測試需要控制「群何時跑完」。 */
function controllableRunner(): {
  runner: GroupRunner;
  started: string[];
  finish(id: string): void;
  reject(id: string, err: Error): void;
} {
  const started: string[] = [];
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  return {
    started,
    runner: (g) =>
      new Promise<void>((resolve, reject) => {
        started.push(g.id);
        pending.set(g.id, { resolve, reject });
      }),
    finish(id) {
      pending.get(id)?.resolve();
      pending.delete(id);
    },
    reject(id, err) {
      pending.get(id)?.reject(err);
      pending.delete(id);
    },
  };
}

/** 讓 runner 的 .catch().finally() 微任務鏈跑完。 */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('Dispatcher — 群間併發與足跡序列化', () => {
  it('併發上限：超過 maxConcurrent 的群留待下輪', async () => {
    const c = controllableRunner();
    const d = new Dispatcher(2, c.runner, createSilentLogger());

    const ready = [makeGroup('g1', ['a.ts']), makeGroup('g2', ['b.ts']), makeGroup('g3', ['c.ts'])];
    assert.equal(d.dispatch(ready), 2);
    assert.deepEqual(c.started, ['g1', 'g2']);
    assert.equal(d.activeCount(), 2);
    assert.equal(d.isRunning('g3'), false);

    // 上限已滿 → 再派也不會有新動作
    assert.equal(d.dispatch(ready), 0);
    assert.deepEqual(c.started, ['g1', 'g2']);
  });

  it('完成後釋放 slot，下一輪才派得出去', async () => {
    const c = controllableRunner();
    const d = new Dispatcher(2, c.runner, createSilentLogger());
    const ready = [makeGroup('g1', ['a.ts']), makeGroup('g2', ['b.ts']), makeGroup('g3', ['c.ts'])];

    d.dispatch(ready);
    c.finish('g1');
    await settle();

    assert.equal(d.activeCount(), 1);
    assert.equal(d.isRunning('g1'), false);

    assert.equal(d.dispatch(ready.slice(2)), 1);
    assert.deepEqual(c.started, ['g1', 'g2', 'g3']);

    c.finish('g2');
    c.finish('g3');
    await settle();
    assert.equal(d.activeCount(), 0);
  });

  it('同 repo 足跡重疊 → 序列化（重疊者不派）', async () => {
    const c = controllableRunner();
    const d = new Dispatcher(4, c.runner, createSilentLogger());

    const started = d.dispatch([
      makeGroup('g1', ['src/a.ts', 'src/b.ts']),
      makeGroup('g2', ['src/b.ts']), // 與 g1 重疊 b.ts
      makeGroup('g3', ['src/z.ts']), // 不重疊
    ]);

    assert.equal(started, 2);
    assert.deepEqual(c.started, ['g1', 'g3']);
    assert.equal(d.isRunning('g2'), false);
  });

  it('重疊者在前群結束後即可派出', async () => {
    const c = controllableRunner();
    const d = new Dispatcher(4, c.runner, createSilentLogger());
    const g1 = makeGroup('g1', ['src/b.ts']);
    const g2 = makeGroup('g2', ['src/b.ts']);

    d.dispatch([g1, g2]);
    assert.deepEqual(c.started, ['g1']);

    c.finish('g1');
    await settle();

    assert.equal(d.dispatch([g2]), 1);
    assert.deepEqual(c.started, ['g1', 'g2']);
  });

  it('足跡不重疊 → 併行', () => {
    const c = controllableRunner();
    const d = new Dispatcher(4, c.runner, createSilentLogger());

    const started = d.dispatch([makeGroup('g1', ['src/a.ts']), makeGroup('g2', ['src/b.ts'])]);

    assert.equal(started, 2);
    assert.equal(d.activeCount(), 2);
  });

  it('不同 repo 即使檔名相同也可併行（足跡只在同 repo 內比較）', () => {
    const c = controllableRunner();
    const d = new Dispatcher(4, c.runner, createSilentLogger());

    const started = d.dispatch([
      makeGroup('g1', ['src/a.ts'], 'acme/web'),
      makeGroup('g2', ['src/a.ts'], 'acme/api'),
    ]);

    assert.equal(started, 2);
    assert.deepEqual(c.started, ['g1', 'g2']);
  });

  it('空足跡的群彼此不算重疊', () => {
    const c = controllableRunner();
    const d = new Dispatcher(4, c.runner, createSilentLogger());
    assert.equal(d.dispatch([makeGroup('g1', []), makeGroup('g2', [])]), 2);
  });

  it('已在跑的群不會被重複派出', () => {
    const c = controllableRunner();
    const d = new Dispatcher(4, c.runner, createSilentLogger());
    const g1 = makeGroup('g1', ['a.ts']);

    assert.equal(d.dispatch([g1]), 1);
    assert.equal(d.dispatch([g1]), 0);
    assert.deepEqual(c.started, ['g1']);
  });

  it('runner 拋錯：記錄錯誤、釋放 slot，不影響後續派發', async () => {
    const c = controllableRunner();
    const rec = createRecordingLogger();
    const d = new Dispatcher(1, c.runner, rec.logger);

    d.dispatch([makeGroup('g1', ['a.ts'])]);
    c.reject('g1', new Error('worktree 建立失敗'));
    await settle();

    assert.equal(d.activeCount(), 0, '失敗也要釋放 slot，否則池會漏光');
    assert.ok(rec.messages('error').includes('群執行失敗'));
    assert.ok(rec.records.some((r) => r.err === 'worktree 建立失敗'));

    // 後續照常運作
    assert.equal(d.dispatch([makeGroup('g2', ['a.ts'])]), 1);
    assert.deepEqual(c.started, ['g1', 'g2']);
  });

  it('runner 同步拋錯（非 async 函式）：不從 dispatch 逸出，也不洩漏 slot', async () => {
    const rec = createRecordingLogger();
    // 刻意不是 async：例外會同步丟出，沒有 Promise 可以 .catch
    const runner = (() => {
      throw new Error('worktree 目錄不存在');
    }) as unknown as GroupRunner;
    const d = new Dispatcher(1, runner, rec.logger);

    assert.equal(d.dispatch([makeGroup('g1', ['a.ts'])]), 1, 'dispatch 不該把例外往外丟');
    assert.equal(d.activeCount(), 0, '同步失敗一樣要釋放 slot，否則這個群永遠佔著位子');
    assert.ok(rec.messages('error').includes('群執行失敗'));
    assert.ok(rec.records.some((r) => r.err === 'worktree 目錄不存在'));

    // slot 沒漏 → 下一個群仍派得出去
    const c = controllableRunner();
    const d2 = new Dispatcher(1, c.runner, createSilentLogger());
    assert.equal(d2.dispatch([makeGroup('g2', ['a.ts'])]), 1);
    await settle();
  });

  it('runner 回傳非 Promise 也不會炸（.catch/.finally 找不到方法）', () => {
    const runner = (() => undefined) as unknown as GroupRunner;
    const d = new Dispatcher(1, runner, createSilentLogger());
    assert.equal(d.dispatch([makeGroup('g1', ['a.ts'])]), 1);
  });

  it('maxConcurrent = 1 → 完全序列', () => {
    const c = controllableRunner();
    const d = new Dispatcher(1, c.runner, createSilentLogger());
    assert.equal(d.dispatch([makeGroup('g1', ['a.ts']), makeGroup('g2', ['b.ts'])]), 1);
    assert.equal(d.activeCount(), 1);
  });
});

// ── 階段順序（規劃 agent 排出來的 1 → 2&3 → 4）──

/**
 * 足跡只擋得住「已經知道會動到同一個檔案」。但規劃者常常只能判斷「這兩個很可能會撞，
 * 說不準是哪個檔案」——實跑就是這樣撞的：兩個任務都改 SandboxView.vue，足跡卻猜不出來。
 * 階段順序是那個判斷的落地方式：檔案不同也照樣排隊。
 */
describe('Dispatcher — 階段順序', () => {
  it('前一階段還沒結束 → 後一階段不派（即使足跡完全不重疊）', async () => {
    const c = controllableRunner();
    const finished = new Set<string>();
    const d = new Dispatcher(4, c.runner, createSilentLogger(), (id) => finished.has(id));

    const g1 = makeGroup('g1', ['a.ts']);
    const g2 = makeGroup('g2', ['b.ts'], 'acme/web', ['g1']);

    assert.equal(d.dispatch([g1, g2]), 1, '只有第一階段可以派');
    assert.deepEqual(c.started, ['g1']);

    // g1 跑完但還沒進終態（例如 PR 開著等人核准）→ 仍然不放行
    c.finish('g1');
    await settle();
    assert.equal(d.dispatch([g2]), 0, '沒真的結束就不算結束');

    finished.add('g1');
    assert.equal(d.dispatch([g2]), 1);
    assert.deepEqual(c.started, ['g1', 'g2']);
  });

  it('同一階段內照樣並行', () => {
    const c = controllableRunner();
    const d = new Dispatcher(4, c.runner, createSilentLogger(), () => true);
    const ready = [makeGroup('g2', ['b.ts'], 'acme/web', ['g1']), makeGroup('g3', ['c.ts'], 'acme/web', ['g1'])];
    assert.equal(d.dispatch(ready), 2);
    assert.deepEqual(c.started, ['g2', 'g3']);
  });

  /**
   * afterGroups 只有在**確實有依賴**時才會有值：分群 agent 判定「B 必須等 A」，
   * 是因為 B 的內容以 A 的成果為前提。A 沒進 base，那個前提就不存在——
   * 這時放行 B 只會產出建立在假設上的東西，而且它自己的 DoD 還會全綠。
   *
   * 實跑的例子：D2-2 要列出「目前所有匯出的函式」，新增那些匯出的 D2-1 沒能合併，
   * 照做就是一份寫著不存在函式的 README。
   */
  it('前置群沒進 base → 後面繼續等（等下去是看得見的等，前置群會出現在待處理清單）', () => {
    const c = controllableRunner();
    // main.ts 的 isFinished 只認 merged
    const d = new Dispatcher(4, c.runner, createSilentLogger(), () => false);
    assert.equal(d.dispatch([makeGroup('g2', ['b.ts'], 'acme/web', ['g1'])]), 0);
  });

  it('前置群已合併 → 放行', () => {
    const c = controllableRunner();
    const d = new Dispatcher(4, c.runner, createSilentLogger(), (id) => id === 'g1');
    assert.equal(d.dispatch([makeGroup('g2', ['b.ts'], 'acme/web', ['g1'])]), 1);
  });

  it('沒注入 isFinished → 退回舊行為（不因查不到狀態而全部卡住）', () => {
    const c = controllableRunner();
    const d = new Dispatcher(4, c.runner, createSilentLogger());
    assert.equal(d.dispatch([makeGroup('g2', ['b.ts'], 'acme/web', ['g1'])]), 1);
  });
});

/**
 * 中止訊號要一路傳到 agent 與 DoD 指令，不能只停主迴圈。
 *
 * 先前 AbortController 只傳給 orchestrator.run()——那只是「不再排新工作」。
 * 正在寫程式的 agent 完全不知情，會做到收尾寬限逾時，然後整個行程被強制結束；
 * 它用 Bash 起的 dev server／watch 跳出 process group 就成了孤兒。
 * 實跑撞到：npm run dev 佔著 8843/8880/8888 活了一個多小時，沒有任何地方看得到。
 */
describe('中止訊號要傳到被派出的群', () => {
  it('dispatch 收到的 signal 會原樣交給 runner', () => {
    const got: (AbortSignal | undefined)[] = [];
    const c = controllableRunner();
    const d = new Dispatcher(4, async (g, s) => { got.push(s); return c.runner(g); }, createSilentLogger());
    const ac = new AbortController();

    d.dispatch([makeGroup('g1', ['a.ts'])], ac.signal);

    assert.equal(got.length, 1);
    assert.equal(got[0], ac.signal, 'runner 要拿得到同一個 signal，否則 agent 永遠不知道要停');
  });

  it('沒傳 signal 也照常運作（舊呼叫端不受影響）', () => {
    const c = controllableRunner();
    const d = new Dispatcher(4, c.runner, createSilentLogger());
    assert.equal(d.dispatch([makeGroup('g1', ['a.ts'])]), 1);
  });
});
