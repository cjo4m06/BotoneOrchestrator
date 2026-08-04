import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UiJudge, buildUiPrompt, judgeToolGuard, parseUiResponse, uiCheck, unobservedWidthSpan, usedResize } from '../src/worker/ui-judge.js';
import { createSilentLogger, createRecordingLogger } from './helpers/index.js';

/**
 * 既有的視覺關卡量得出「這個元素超出視窗 340px」「跟基準差異 12%」——那些是事實。
 * 但畫面到底行不行遠不只如此：好不好讀、字級與對比夠不夠、視覺層次對不對、
 * 深色模式下有沒有「深底配深字」。這些沒有一項量得出來。
 *
 * 而先前的狀況更難看：截圖有拍、有像素比對、有傳到 Slack、有定期清理，
 * **從頭到尾沒有任何 agent 看過那張圖**。這一層就是為此存在。
 */

const INPUT = {
  cwd: '/wt',
  screenshots: ['/shots/home-1280.png', '/shots/home-390.png'],
  taskTitle: '加上深色模式切換',
};

const wrap = (o: unknown): string => '```json\n' + JSON.stringify(o) + '\n```';
const reply = (text: string) =>
  async function* () {
    yield { type: 'result', subtype: 'success', result: text };
  };

describe('parseUiResponse', () => {
  it('ok 判定', () => {
    assert.deepEqual(parseUiResponse(wrap({ status: 'ok', notes: ['對比夠'] })), {
      status: 'ok',
      notes: ['對比夠'],
    });
  });

  it('issues 判定含類別與具體問題', () => {
    const v = parseUiResponse(
      wrap({ status: 'issues', issues: [{ shot: 'a.png', kind: 'contrast', problem: '深底配深字讀不到' }] }),
    );
    assert.equal(v?.status, 'issues');
    if (v?.status !== 'issues') return;
    assert.equal(v.issues[0]?.kind, 'contrast');
  });

  it('沒給 problem 的 issue → 整份不採信（沒有具體問題就回灌不回去）', () => {
    assert.equal(parseUiResponse(wrap({ status: 'issues', issues: [{ shot: 'a.png', kind: 'contrast' }] })), undefined);
  });

  it('說 issues 卻一條都沒有 → 不採信', () => {
    assert.equal(parseUiResponse(wrap({ status: 'issues', issues: [] })), undefined);
  });

  it('不是 JSON → undefined 而不是丟例外', () => {
    assert.equal(parseUiResponse('看起來不錯'), undefined);
  });
});

describe('UiJudge', () => {
  it('判定 ok → 通過', async () => {
    const j = new UiJudge({
      log: createSilentLogger(),
      hasAuth: () => true,
      queryFn: reply(wrap({ status: 'ok', notes: [] })),
    });
    assert.equal((await j.judge(INPUT)).status, 'ok');
  });

  it('判定 issues → 回報逐項問題', async () => {
    const j = new UiJudge({
      log: createSilentLogger(),
      hasAuth: () => true,
      queryFn: reply(wrap({ status: 'issues', issues: [{ shot: 'a.png', kind: 'readability', problem: '字太小' }] })),
    });
    const v = await j.judge(INPUT);
    assert.equal(v.status, 'issues');
  });

  /**
   * 保守方向與 DoD 那些關卡相反：判不出來就放行。
   * 這是主觀判斷，讓它擋下建置與測試都綠的成果，誤殺代價高於漏放。
   */
  it('呼叫失敗 → skipped，不擋流程', async () => {
    const j = new UiJudge({
      log: createSilentLogger(),
      hasAuth: () => true,
      queryFn: () => {
        throw new Error('掛了');
      },
    });
    assert.equal((await j.judge(INPUT)).status, 'skipped');
  });

  it('回應解析不出 → skipped', async () => {
    const j = new UiJudge({ log: createSilentLogger(), hasAuth: () => true, queryFn: reply('嗯嗯') });
    assert.equal((await j.judge(INPUT)).status, 'skipped');
  });

  it('沒有認證 → skipped', async () => {
    const j = new UiJudge({ log: createSilentLogger(), hasAuth: () => false });
    assert.equal((await j.judge(INPUT)).status, 'skipped');
  });

  it('沒有截圖也沒有網址 → skipped（不白花一次呼叫）', async () => {
    let called = 0;
    const j = new UiJudge({
      log: createSilentLogger(),
      hasAuth: () => true,
      queryFn: () => {
        called += 1;
        return reply(wrap({ status: 'ok', notes: [] }))();
      },
    });
    assert.equal((await j.judge({ ...INPUT, screenshots: [] })).status, 'skipped');
    assert.equal(called, 0);
  });

  it('截圖過多 → 只看前幾張，且**留下警告**（靜默截斷會讓「全部看過」變成假象）', async () => {
    const rec = createRecordingLogger();
    const j = new UiJudge({
      log: rec.logger,
      hasAuth: () => true,
      maxShots: 2,
      queryFn: reply(wrap({ status: 'ok', notes: [] })),
    });
    await j.judge({ ...INPUT, screenshots: ['a', 'b', 'c', 'd'] });
    assert.ok(rec.messages('warn').some((m) => /截圖過多/.test(m)));
  });
});

describe('buildUiPrompt / uiCheck', () => {
  it('明確要求「用 Read 打開來看」而不是憑檔名猜', () => {
    const p = buildUiPrompt(INPUT);
    assert.match(p, /每一張都要用 Read 打開來看/);
    assert.match(p, /home-1280\.png/);
    assert.match(p, /加上深色模式切換/, '要知道任務目的才判斷得出畫面有沒有達成目的');
  });

  it('明說不要挑個人偏好', () => {
    assert.match(buildUiPrompt(INPUT), /不要\*\*回報：你個人的配色偏好/);
  });

  /**
   * skipped 判紅，方向與其他「主觀判斷」層相反。理由：版面門檻與像素比對已經降級成
   * 線索，視覺這一關只剩判斷者一個把關者。它不可用時若放行，整關就變成裝飾。
   */
  it('ok → 綠燈；skipped → **紅燈**（沒有第二道防線）；issues → 紅燈且細節可回灌', () => {
    assert.equal(uiCheck({ status: 'ok', notes: ['沒問題'] }).ok, true);
    const skipped = uiCheck({ status: 'skipped', reason: '沒金鑰' });
    assert.equal(skipped.ok, false);
    assert.match(skipped.detail, /沒有其他把關者/);
    const bad = uiCheck({
      status: 'issues',
      issues: [
        { origin: 'introduced', shot: 'a.png', kind: 'contrast', problem: '深底配深字', suggestion: '把文字改成淺色' },
      ],
    });
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /深底配深字/);
    assert.match(bad.detail, /把文字改成淺色/);
  });
});

// ── 既有問題不該擋這次的改動 ──

/**
 * 實跑撞到：任務是「在面板加一顆清空按鈕」，判斷者卻回報「× 關閉鈕只有 36×20px」。
 * 那是事實，但那顆按鈕是既有的、不是這次弄的。它在稽核整個頁面——
 * 因為我問的問題就是「這個介面行不行」，而它**沒有任何 git 工具**，分不出新舊。
 * 後果：diff 從一顆按鈕長成 9 個檔案，而且每輪都能再挖出新的既有問題。
 */
describe('issue 的 origin 分類', () => {
  const issue = (origin: 'introduced' | 'preexisting', problem: string) => ({
    origin, shot: 'a.png', kind: 'layout' as const, problem,
  });

  it('只有 introduced 會擋；preexisting 一樣列出來但放行', () => {
    const c = uiCheck({ status: 'issues', issues: [issue('preexisting', '× 鈕本來就太小')] });
    assert.equal(c.ok, true, '既有問題不該擋一個只加了按鈕的 PR');
    assert.match(c.detail, /× 鈕本來就太小/, '還是要列出來，值得修');
    assert.match(c.detail, /不擋這次的改動/);
  });

  it('有 introduced 就擋，既有問題附在後面', () => {
    const c = uiCheck({
      status: 'issues',
      issues: [issue('introduced', '這次加的按鈕在深色模式下看不到'), issue('preexisting', '× 鈕本來就太小')],
    });
    assert.equal(c.ok, false);
    assert.match(c.detail, /這次加的按鈕/);
    assert.match(c.detail, /以下是既有問題/);
  });

  it('沒標 origin → 當成 introduced（分不出來就擋，比放行安全）', () => {
    const v = parseUiResponse('```json\n' + JSON.stringify({
      status: 'issues', issues: [{ shot: 'a.png', kind: 'layout', problem: 'x' }],
    }) + '\n```');
    assert.equal(v?.status, 'issues');
    if (v?.status !== 'issues') return;
    assert.equal(v.issues[0]?.origin, 'introduced');
  });
});

describe('判斷者的 git 工具', () => {
  it('prompt 要它先查「這次改了什麼」，並說明只有 introduced 會擋', () => {
    const p = buildUiPrompt({ cwd: '/wt', baseRef: 'origin/main', screenshots: ['a.png'], taskTitle: 't' });
    assert.match(p, /git_changed_files/);
    assert.match(p, /git_blame/);
    assert.match(p, /只有 introduced 會擋/);
    assert.match(p, /分不出來就標 introduced/);
  });
});

describe('判斷者的工具閘門', () => {
  const guard = judgeToolGuard(createSilentLogger());

  it('清單內的工具放行', async () => {
    assert.deepEqual(await guard({ tool_name: 'Read' }), {});
    // Grep 是唯讀的、判斷者本來就該有。先前漏了，實跑時它去查程式碼被自己的閘門擋下。
    assert.deepEqual(await guard({ tool_name: 'Grep' }), {});
    assert.deepEqual(await guard({ tool_name: 'mcp__playwright__browser_navigate' }), {});
    assert.deepEqual(await guard({ tool_name: 'mcp__git__git_blame' }), {});
  });

  /**
   * SDK 的 allowedTools 對 MCP 工具**不具強制力**——實跑證實 browser_run_code_unsafe
   * 沒列進去卻被呼叫成功。判斷者能碰到什麼，只能由自己的 hook 決定。
   */
  it('判斷者不該有動手的能力：寫檔、跑指令、在頁面執行任意程式碼一律擋', async () => {
    for (const t of ['Write', 'Edit', 'Bash', 'mcp__playwright__browser_run_code_unsafe', 'mcp__playwright__browser_file_upload']) {
      const v = await guard({ tool_name: t });
      assert.equal(v.hookSpecificOutput?.permissionDecision, 'deny', `${t} 應被擋下`);
    }
  });
});

/**
 * 深度下限。
 *
 * 實跑抓到的：同一份程式碼、同一段提示詞連跑兩次，第一次 6 個工具呼叫就回 ok，
 * 第二次 78 個（其中 resize 6 次）抓到一個只在 640～890px 出現的浮動鈕壓字。
 * 專案只設了 390 與 1280 兩個斷點，中間那 890px 完全沒有證據——
 * 而提示詞裡**早就寫了**「至少要看寬螢幕與窄螢幕兩種」，它照樣沒照做。
 *
 * 所以這裡不判斷畫面好不好（那是判斷者的事），只檢查證據涵蓋了沒。
 */
describe('unobservedWidthSpan', () => {
  it('回相鄰寬度之間最大的那一段（最可能藏東西的地方）', () => {
    assert.deepEqual(unobservedWidthSpan([1280, 390]), [390, 1280]);
    assert.deepEqual(unobservedWidthSpan([375, 768, 1440]), [768, 1440]);
  });

  it('只有一個寬度（或沒設定）談不上縫隙——該補的是設定，不是在這裡瞎猜', () => {
    assert.equal(unobservedWidthSpan([1280]), undefined);
    assert.equal(unobservedWidthSpan([]), undefined);
    assert.equal(unobservedWidthSpan(undefined), undefined);
    assert.equal(unobservedWidthSpan([800, 800]), undefined);
  });
});

describe('判斷者說 ok 但沒看過寬度縫隙', () => {
  const WIDE = { ...INPUT, baseUrl: 'http://127.0.0.1:5173', capturedWidths: [390, 1280] };
  // 注入的 queryFn 不經過 PreToolUse hook，因此工具使用紀錄必定是空的
  // ——正好等於「判斷者一次都沒 resize」。
  const seq = (...texts: string[]) => {
    const prompts: string[] = [];
    let i = 0;
    const fn = async function* (args: { prompt: string }) {
      prompts.push(args.prompt);
      yield { type: 'result', subtype: 'success', result: texts[Math.min(i++, texts.length - 1)]! };
    };
    return { fn, prompts };
  };

  it('重問一次，並在重問的提示詞裡點名沒看過的區間', async () => {
    const { fn, prompts } = seq(
      wrap({ status: 'ok', notes: [] }),
      wrap({ status: 'issues', issues: [{ shot: 'x.png', kind: 'layout', problem: '640px 時浮動鈕壓到內文' }] }),
    );
    const j = new UiJudge({ log: createSilentLogger(), hasAuth: () => true, queryFn: fn });
    const v = await j.judge(WIDE);
    assert.equal(prompts.length, 2, '應該重問一次');
    assert.match(prompts[1]!, /390～1280px/);
    assert.equal(v.status, 'issues', '重問後找到的問題要採計');
  });

  it('兩次都沒看 → 不採計為綠燈（寧可紅燈給人看，也不吞下涵蓋不到的 ok）', async () => {
    const { fn, prompts } = seq(wrap({ status: 'ok', notes: [] }));
    const j = new UiJudge({ log: createSilentLogger(), hasAuth: () => true, queryFn: fn });
    const v = await j.judge(WIDE);
    assert.equal(prompts.length, 2, '只重問一次，不無限重試');
    assert.equal(v.status, 'skipped');
    assert.match(v.status === 'skipped' ? v.reason : '', /沒有改過視窗尺寸/);
    assert.equal(uiCheck(v).ok, false, 'skipped 本來就不是綠燈');
  });

  it('沒有 baseUrl（連不上 dev server）→ 不重問：它本來就沒有瀏覽器可 resize', async () => {
    const { fn, prompts } = seq(wrap({ status: 'ok', notes: [] }));
    const j = new UiJudge({ log: createSilentLogger(), hasAuth: () => true, queryFn: fn });
    assert.equal((await j.judge({ ...INPUT, capturedWidths: [390, 1280] })).status, 'ok');
    assert.equal(prompts.length, 1);
  });

  it('只有一個斷點 → 沒有縫隙可談，不重問', async () => {
    const { fn, prompts } = seq(wrap({ status: 'ok', notes: [] }));
    const j = new UiJudge({ log: createSilentLogger(), hasAuth: () => true, queryFn: fn });
    assert.equal((await j.judge({ ...WIDE, capturedWidths: [1280] })).status, 'ok');
    assert.equal(prompts.length, 1);
  });

  it('判定 issues 不重問——淺的「有問題」會擋下來，不是靜默放行', async () => {
    const { fn, prompts } = seq(wrap({ status: 'issues', issues: [{ shot: 'a.png', kind: 'layout', problem: '破版' }] }));
    const j = new UiJudge({ log: createSilentLogger(), hasAuth: () => true, queryFn: fn });
    assert.equal((await j.judge(WIDE)).status, 'issues');
    assert.equal(prompts.length, 1);
  });

  it('提示詞會把「沒有人看過的寬度」寫給判斷者（它原本不知道截圖只涵蓋幾個寬度）', () => {
    const p = buildUiPrompt(WIDE);
    assert.match(p, /390～1280px 之間完全沒有任何證據/);
    assert.doesNotMatch(buildUiPrompt({ ...WIDE, capturedWidths: [1280] }), /完全沒有任何證據/);
  });
});
