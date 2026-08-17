import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { DEPS_RELEASED_EVENT, isDepsReleased, releaseDeps, upstreamSettled } from '../src/core/deps-release.js';
import { collectPending } from '../src/core/pending.js';
import { InboundRouter } from '../src/notify/notifier.js';
import { createSilentLogger, createTmpLedger, type TmpLedger } from './helpers/index.js';

/**
 * `closed`（沒有東西要交付）是終態、永遠不會 merged，而「上游結束了沒」有**兩個**判斷點，
 * 先前兩個都只認 merged ⇒ 等它的群會永遠排下去，畫面上還長得跟正常排隊一樣。
 *
 * 這一整組測的是：那個死結有出口、而且出口按下去兩邊會一起放。
 */
describe('放行下游（上游永遠不會進 base 時的唯一出口）', () => {
  let tmp: TmpLedger;
  beforeEach(() => { tmp = createTmpLedger(); });
  afterEach(() => tmp.cleanup());

  function seedTask(id: string): void {
    tmp.ledger.upsertDiscoveredTask({
      id, payloadHash: `h-${id}`, repo: 'o/r', category: 'dev',
      title: `任務 ${id}`, description: '', dependencies: [], docRefs: [],
    });
  }

  /** 上游（會停在指定狀態）＋ 一個等著它的下游。 */
  function seedPair(upState: 'closed' | 'failed' | 'merged'): { up: string; down: string } {
    seedTask('T-up');
    seedTask('T-down');
    const up = tmp.ledger.createGroup({ repo: 'o/r', branch: 'b-up', taskIds: ['T-up'], footprint: [] });
    tmp.ledger.updateGroupState(up.id, upState);
    const down = tmp.ledger.createGroup({ repo: 'o/r', branch: 'b-down', taskIds: ['T-down'], footprint: [], afterGroups: [up.id] });
    return { up: up.id, down: down.id };
  }

  const router = (): InboundRouter => new InboundRouter({ ledger: tmp.ledger, log: createSilentLogger() });

  it('沒放行過 → closed 上游對下游而言仍是「還在等」', () => {
    const { up } = seedPair('closed');
    assert.equal(upstreamSettled(tmp.ledger, tmp.ledger.getGroup(up)), false);
    assert.equal(isDepsReleased(tmp.ledger, up), false);
  });

  it('放行過 → 兩個判斷點共用的那支函式就會放行', () => {
    const { up, down } = seedPair('closed');
    releaseDeps(tmp.ledger, { groupId: up, state: 'closed', blocked: [down], userId: 'test' });
    assert.equal(upstreamSettled(tmp.ledger, tmp.ledger.getGroup(up)), true);
  });

  it('merged 本來就通了（不必放行，也不該多記一筆讀不懂的紀錄）', async () => {
    const { up } = seedPair('merged');
    assert.equal(upstreamSettled(tmp.ledger, tmp.ledger.getGroup(up)), true);
    assert.equal(await router().releaseDeps({ groupId: up, userId: 'test' }), false);
    assert.equal(isDepsReleased(tmp.ledger, up), false, '按了也不該留下放行紀錄');
  });

  it('群組記錄整個不見 → 視為結束（資料異常不該讓後面的群陪葬）', () => {
    assert.equal(upstreamSettled(tmp.ledger, undefined), true);
  });

  it('放行的痕跡在上下游兩邊都查得到（人是從下游開始查的）', async () => {
    const { up, down } = seedPair('closed');
    assert.equal(await router().releaseDeps({ groupId: up, userId: 'someone', reason: '那份 API 早就在了' }), true);

    const upEv = tmp.ledger.latestEvent('group', up, DEPS_RELEASED_EVENT);
    assert.ok(upEv, '上游要留下「誰放行的」');
    assert.match(upEv.detail ?? '', /someone/);
    assert.match(upEv.detail ?? '', new RegExp(down), '要寫清楚放行了誰');
    assert.match(upEv.detail ?? '', /那份 API 早就在了/);
    assert.ok(tmp.ledger.latestEvent('group', down, 'deps_released_upstream'), '下游也要查得到為什麼它不等了');
  });

  it('按過就要從清單上消失（不然人會一直看到自己剛按過的東西）', async () => {
    const { up } = seedPair('closed');
    const before = collectPending(tmp.ledger).filter((i) => i.id === up);
    assert.equal(before.length, 1, '擋著人的死上游要先出現在清單上');
    assert.deepEqual(before[0]?.actions, ['release_deps'], '列出來卻沒有可按的動作，就只是把死結講給人聽');

    await router().releaseDeps({ groupId: up, userId: 'test' });
    assert.deepEqual(collectPending(tmp.ledger).filter((i) => i.id === up), []);
  });

  /**
   * 放行之後下游就不再是「正常排隊」了。它若還是不動，那是真的卡住，要看得見。
   * 這道判準只要在自檢那邊自己再寫一份（只認 merged），放行過的下游就會被永遠當成
   * 排隊中而不列——而它其實已經沒有東西在等了。
   */
  it('放行後下游若還是不動，就不再算「正常排隊」，要浮出來', () => {
    const STALE = 31 * 60_000; // 超過 SELF_CHECK_STALE_MS
    const { up, down } = seedPair('closed');

    const before = collectPending(tmp.ledger, Date.now() + STALE).map((i) => i.id);
    assert.equal(before.includes(down), false, '還在等上游 ＝ 正常排隊，列出來只會多一顆按不動的鈕');

    releaseDeps(tmp.ledger, { groupId: up, state: 'closed', blocked: [down], userId: 'test' });
    const after = collectPending(tmp.ledger, Date.now() + STALE).map((i) => i.id);
    assert.equal(after.includes(down), true, '不等任何人了卻還是不動 ＝ 真的卡住');
    assert.equal(after.includes(up), false, '上游已經處理過，不該再出現');
  });

  it('failed 上游也放行得了（「這個我不打算修了，讓後面先走」也是人的決定）', async () => {
    const { up } = seedPair('failed');
    assert.equal(await router().releaseDeps({ groupId: up, userId: 'test' }), true);
    assert.equal(upstreamSettled(tmp.ledger, tmp.ledger.getGroup(up)), true);
  });

  it('不存在的群組 → 明講失敗，不要假裝成功', async () => {
    assert.equal(await router().releaseDeps({ groupId: 'g_nope', userId: 'test' }), false);
  });

  /**
   * ── 這個 repo 反覆踩到的形狀：一個能力有多個執行點，只接了其中一個 ──
   *
   * 群層級（Dispatcher 的 isFinished）與任務層級（Orchestrator.depsInBase）都要問同一句話。
   * 只接一邊的話，人按了放行、畫面上還是不動——而那個症狀完全看不出是哪一道在擋。
   */
  describe('兩個判斷點必須讀同一支函式', () => {
    const strip = (f: string): string =>
      readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    it('Dispatcher 的 isFinished', () => {
      assert.match(strip('src/main.ts'), /upstreamSettled\(ledger, ledger\.getGroup\(groupId\)\)/);
    });

    it('Orchestrator.depsInBase', () => {
      const src = strip('src/core/orchestrator.ts');
      assert.match(src, /upstreamSettled\(ledger, depGroup\)/);
      assert.doesNotMatch(src, /depGroup\?\.state !== 'merged'/, '自己再寫一次判準 ⇒ 放行只放一半');
    });
  });

  /** 給得出動作，三個介面就都要按得到——少一個就是「在那個介面上按不到」。 */
  describe('三個介面都接得到這顆按鈕', () => {
    it('CLI', () => {
      const src = readFileSync('src/cli/ask.ts', 'utf8');
      assert.match(src, /'release_deps'/, 'CLI 認得這個動作碼');
      assert.match(src, /router\.releaseDeps\?\./, 'CLI 真的呼叫得到');
    });

    it('控制台', () => {
      assert.match(readFileSync('src/console/server.ts', 'utf8'), /case 'release_deps'/);
      // 動作碼要與後端一致：畫面上畫得出鈕、後端卻不認得，就是按了拿到「不支援的動作」
      assert.match(readFileSync('src/console/ui.html', 'utf8'), /release_deps: \['放行下游'/);
    });

    it('Slack App Home', () => {
      assert.match(readFileSync('src/slack/home.ts', 'utf8'), /acts\.includes\('release_deps'\)/);
      assert.match(readFileSync('src/slack/app-home.ts', 'utf8'), /groupReleaseDeps/);
      assert.match(readFileSync('src/main.ts', 'utf8'), /async releaseDeps\(groupId\)/, 'App Home 的快捷操作要接上 router');
    });
  });
});
