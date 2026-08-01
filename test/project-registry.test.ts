import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ProjectRegistry, projectFingerprint, type RegisteredProject } from '../src/core/project-registry.js';
import { Poller } from '../src/core/poller.js';
import { createSilentLogger, createRecordingLogger, createTmpLedger } from './helpers/index.js';
import type { ProjectConfig } from '../src/config/index.js';
import type { PollSource } from '../src/core/poller.js';

const project = (over: Partial<ProjectConfig> = {}): ProjectConfig =>
  ({
    id: 'p1', repo: 'acme/web', repoPath: '/tmp/r',
    mcp: { transport: 'http', url: 'https://x.test', token: 't' },
    commands: {}, visual: {}, autoMergePolicy: {},
    ...over,
  }) as ProjectConfig;

interface Built {
  closed: string[];
  builds: string[];
  factory: (p: ProjectConfig) => Promise<Omit<RegisteredProject, 'fingerprint'> | undefined>;
}

function fakeFactory(opts: { failFor?: Set<string> } = {}): Built {
  const closed: string[] = [];
  const builds: string[] = [];
  return {
    closed,
    builds,
    factory: async (p) => {
      builds.push(p.id);
      if (opts.failFor?.has(p.id)) return undefined;
      const client = {
        async startTask() { return { ok: true as const, value: {} as never }; },
        async completeTask() { return { ok: true as const, value: undefined }; },
        async loadDocs() { return []; },
        async listTasks() { return []; },
        async getTask() { return {} as never; },
        close: async () => void closed.push(p.id),
      };
      return {
        config: p,
        client,
        source: { client, repo: p.repo, mine: true } as PollSource,
        runtime: { repo: p.repo, repoPath: p.repoPath, baseBranch: 'main', verifierConfig: {}, mcp: client } as never,
      };
    },
  };
}

describe('ProjectRegistry — 專案熱重載', () => {
  it('新增專案立刻出現在 sources（不必重啟）', async () => {
    const f = fakeFactory();
    const reg = new ProjectRegistry(f.factory, createSilentLogger());

    const r1 = await reg.sync([project()]);
    assert.deepEqual(r1.added, ['p1']);
    assert.equal(reg.sources().length, 1);

    const r2 = await reg.sync([project(), project({ id: 'p2', repo: 'acme/api' })]);
    assert.deepEqual(r2.added, ['p2']);
    assert.equal(reg.sources().length, 2);
  });

  /** 停用的專案若還在輪詢，它會繼續認領任務——使用者按了停用卻什麼都沒停。 */
  it('移除／停用的專案立刻停止輪詢，並關掉 MCP 連線', async () => {
    const f = fakeFactory();
    const reg = new ProjectRegistry(f.factory, createSilentLogger());
    await reg.sync([project(), project({ id: 'p2', repo: 'acme/api' })]);

    const r = await reg.sync([project()]);

    assert.deepEqual(r.removed, ['p2']);
    assert.deepEqual(reg.ids(), ['p1']);
    assert.deepEqual(f.closed, ['p2'], '連線要真的關掉，不是只從清單移除');
  });

  /**
   * 指紋只涵蓋「改了就必須重連」的欄位。整份設定 hash 的話，
   * 改一個截圖門檻也會把 MCP 連線砍掉重連，正在跑的輪詢會無謂中斷。
   */
  it('只改非連線欄位 → 不重建連線，但設定要換新', async () => {
    const f = fakeFactory();
    const reg = new ProjectRegistry(f.factory, createSilentLogger());
    await reg.sync([project({ quietPeriodMinutes: 15 })]);

    const r = await reg.sync([project({ quietPeriodMinutes: 30 })]);

    assert.deepEqual(r.updated, ['p1']);
    assert.deepEqual(f.builds, ['p1'], '只該建過一次');
    assert.deepEqual(f.closed, [], '不該關掉連線');
    assert.equal(reg.configOf('acme/web')?.quietPeriodMinutes, 30, '設定要真的換新');
  });

  it('改了 MCP 設定 → 重建連線（舊的要關掉）', async () => {
    const f = fakeFactory();
    const reg = new ProjectRegistry(f.factory, createSilentLogger());
    await reg.sync([project()]);

    const r = await reg.sync([project({ mcp: { transport: 'http', url: 'https://x.test', token: '新token' } as never })]);

    assert.deepEqual(r.updated, ['p1']);
    assert.deepEqual(f.builds, ['p1', 'p1'], '要重建');
    assert.deepEqual(f.closed, ['p1'], '舊連線要關掉，否則會洩漏一條連線');
  });

  it('指紋只看連線相關欄位', () => {
    const a = projectFingerprint(project({ quietPeriodMinutes: 1 }));
    const b = projectFingerprint(project({ quietPeriodMinutes: 999 }));
    assert.equal(a, b, '靜置分鐘數不該影響指紋');
    assert.notEqual(a, projectFingerprint(project({ repoPath: '/other' })));
  });

  /** 一個 MCP 掛掉不該讓其他專案跟著消失（那會讓整個系統看起來壞了）。 */
  it('單一專案建立失敗，其餘照常運作', async () => {
    const f = fakeFactory({ failFor: new Set(['bad']) });
    const rec = createRecordingLogger();
    const reg = new ProjectRegistry(f.factory, rec.logger);

    const r = await reg.sync([project(), project({ id: 'bad', repo: 'acme/bad' })]);

    assert.deepEqual(r.added, ['p1']);
    assert.deepEqual(r.failed, ['bad']);
    assert.deepEqual(reg.ids(), ['p1']);
  });

  it('工廠丟例外也只影響那一個專案', async () => {
    const rec = createRecordingLogger();
    const reg = new ProjectRegistry(
      async (p) => {
        if (p.id === 'boom') throw new Error('連線爆炸');
        return fakeFactory().factory(p);
      },
      rec.logger,
    );

    const r = await reg.sync([project({ id: 'boom', repo: 'a/b' }), project()]);

    assert.deepEqual(r.failed, ['boom']);
    assert.deepEqual(r.added, ['p1']);
    assert.ok(rec.messages('error').some((m) => m.includes('專案載入失敗')));
  });

  it('closeAll 關掉全部連線', async () => {
    const f = fakeFactory();
    const reg = new ProjectRegistry(f.factory, createSilentLogger());
    await reg.sync([project(), project({ id: 'p2', repo: 'acme/api' })]);

    await reg.closeAll();

    assert.equal(reg.size(), 0);
    assert.deepEqual(f.closed.sort(), ['p1', 'p2']);
  });

  it('關連線失敗不會擋住移除（下一個 client 是獨立連線）', async () => {
    const rec = createRecordingLogger();
    const reg = new ProjectRegistry(
      async (p) => {
        const base = await fakeFactory().factory(p);
        return { ...base!, client: { ...base!.client, close: async () => { throw new Error('關不掉'); } } };
      },
      rec.logger,
    );
    await reg.sync([project()]);

    await reg.sync([]); // 不該 throw

    assert.equal(reg.size(), 0);
    assert.ok(rec.messages('warn').some((m) => m.includes('MCP 連線關閉失敗')));
  });

  it('repoPaths 去重（同一個 clone 被兩個專案共用時只掃一次）', async () => {
    const f = fakeFactory();
    const reg = new ProjectRegistry(f.factory, createSilentLogger());
    await reg.sync([project(), project({ id: 'p2', repo: 'acme/api' })]);
    assert.deepEqual(reg.repoPaths(), ['/tmp/r']);
  });
});

describe('Poller — sources 傳函式才有熱重載', () => {
  /**
   * 收一份陣列留著就是熱重載失效的地方，而且失效得很安靜：
   * 控制台顯示「已儲存」，daemon 卻還在輪詢舊清單。
   */
  it('傳函式 → 每輪重新取得專案清單', async (t) => {
    const tmp = createTmpLedger();
    t.after(() => tmp.cleanup());

    let sources: PollSource[] = [];
    const poller = new Poller(() => sources, tmp.ledger, createSilentLogger());

    assert.deepEqual(await poller.pollOnce(), [], '一開始沒有來源');

    const client = {
      async listTasks() { return [{ id: 'T-1', title: 't', status: 'todo' as const, repo: 'acme/web' }]; },
      async getTask() {
        return {
          id: 'T-1', title: 't', status: 'todo' as const, repo: 'acme/web',
          description: 'd', dependencies: [], docRefs: [], category: 'dev' as const,
        };
      },
    };
    sources = [{ client, repo: 'acme/web', mine: true }];

    const fresh = await poller.pollOnce();
    assert.deepEqual(fresh.map((x) => x.id), ['T-1'], '新增的來源下一輪就被輪詢到');
  });

  it('傳陣列仍照舊（既有呼叫端不受影響）', async (t) => {
    const tmp = createTmpLedger();
    t.after(() => tmp.cleanup());
    const poller = new Poller([], tmp.ledger, createSilentLogger());
    assert.deepEqual(await poller.pollOnce(), []);
  });
});

describe('ProjectRegistry — sync 是每輪都會跑的，沒變就要完全安靜', () => {
  /**
   * sync 每 tick 都被呼叫。把「沒變」也算成 updated 的話，log 會每十幾秒噴一次
   * 「專案清單已更新」——真正的變更就淹沒在裡面，等於沒有這條 log。
   */
  it('設定完全沒變 → 不回報任何異動、不寫 log', async () => {
    const f = fakeFactory();
    const rec = createRecordingLogger();
    const reg = new ProjectRegistry(f.factory, rec.logger);
    await reg.sync([project()]);
    const before = rec.records.length;

    const r = await reg.sync([project()]);

    assert.deepEqual(r, { added: [], updated: [], removed: [], failed: [] });
    assert.equal(rec.records.length, before, '沒有異動就不該再寫 log');
  });

  it('內容真的變了才回報 updated', async () => {
    const f = fakeFactory();
    const reg = new ProjectRegistry(f.factory, createSilentLogger());
    await reg.sync([project({ quietPeriodMinutes: 15 })]);

    assert.deepEqual((await reg.sync([project({ quietPeriodMinutes: 15 })])).updated, []);
    assert.deepEqual((await reg.sync([project({ quietPeriodMinutes: 30 })])).updated, ['p1']);
  });
});
