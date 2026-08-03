// src/slack/blocks.ts 的單元測試（純函式，不碰 Slack API）。
// 執行：npx tsx --test test/slack-blocks.test.ts
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_IDS,
  clarificationBlocks,
  clarificationText,
  decodeActionValue,
  encodeActionValue,
  eventBlocks,
  eventText,
  mergeApprovalBlocks,
  noChangeBlocks,
  noChangeText,
  screenshotComment,
  screenshotFallbackBlocks,
  taskCardBlocks,
  taskCardText,
  needsHuman,
  humanDuration,
  progressLine,
} from '../src/slack/blocks.js';
import type { ClarificationRequest, GateReport } from '../src/types.js';

type AnyBlock = Record<string, any>;

/** 取出 blocks 內所有按鈕（測試輔助）。 */
function buttons(blocks: unknown[]): AnyBlock[] {
  return (blocks as AnyBlock[])
    .filter((b) => b.type === 'actions')
    .flatMap((b) => (b.elements ?? []) as AnyBlock[]);
}

/** 把所有文字節點攤平成一個字串，方便斷言內容有無出現。 */
function allText(blocks: unknown[]): string {
  return JSON.stringify(blocks);
}

const task = {
  id: 'T-101',
  title: '修正結帳頁 RWD 破版',
  repo: 'acme/web',
  category: 'bug',
  description: '手機寬度下按鈕溢出容器',
  docRefs: ['spec/checkout.md#rwd'],
  dependencies: ['T-100'],
};

// ── 任務卡 ──

test('taskCardBlocks：含 header、關鍵欄位、規格與控制按鈕', () => {
  const blocks = taskCardBlocks(task);
  const b = blocks as AnyBlock[];
  assert.equal(b[0]?.type, 'header');
  assert.match(b[0]?.text.text, /修正結帳頁 RWD 破版/);

  const text = allText(blocks);
  assert.match(text, /T-101/);
  assert.match(text, /acme\/web/);
  assert.match(text, /bug/);
  assert.match(text, /T-100/); // 依賴
  assert.match(text, /spec\/checkout\.md#rwd/); // docRefs

  // 執行中只該有「當下真的能按」的兩顆；重試在執行中沒有意義
  const ids = buttons(blocks).map((x) => x.action_id);
  assert.deepEqual(ids, [ACTION_IDS.taskPause, ACTION_IDS.taskAbort]);
  for (const btn of buttons(blocks)) {
    assert.deepEqual(decodeActionValue(btn.value)?.taskId, 'T-101');
  }
});

/**
 * 卡片貼出去就不動的話，任務做完了、PR 開了、甚至在等人核准，卡片上還是同樣
 * 三顆按鈕——人根本看不出它在等自己。狀態與按鈕必須跟著走。
 */
test('任務卡：狀態會顯示在卡片上', () => {
  for (const [status, expect] of [
    ['working', /執行中/], ['verifying', /驗證中/], ['pr_open', /PR 已開/],
    ['awaiting_reply', /等你回覆/], ['awaiting_merge', /等你核准合併/],
    ['merged', /已合併/], ['failed', /失敗/],
    ['reviewing', /審查中/], ['merge_checking', /合併把關中/], ['reworking', /重做中/],
  ] as const) {
    assert.match(allText(taskCardBlocks(task, status)), expect, `${status} 應顯示狀態`);
  }
});

test('任務卡：需要人動手的狀態要講清楚在等什麼', () => {
  assert.match(allText(taskCardBlocks(task, 'awaiting_reply')), /請在這條 thread 回覆/);
  assert.match(allText(taskCardBlocks(task, 'awaiting_merge', { groupId: 'g1' })), /按下方按鈕核准或退回/);
});

test('任務卡：按鈕隨狀態變，做完的任務不該還掛著「暫停」', () => {
  const ids = (s: Parameters<typeof taskCardBlocks>[1], g?: string) =>
    buttons(taskCardBlocks(task, s, g ? { groupId: g } : {})).map((x) => x.action_id);

  assert.deepEqual(ids('verifying'), [ACTION_IDS.taskPause, ACTION_IDS.taskAbort]);
  assert.deepEqual(ids('awaiting_human'), [ACTION_IDS.taskRetry, ACTION_IDS.taskAbort]);
  assert.deepEqual(ids('failed'), [ACTION_IDS.taskRetry, ACTION_IDS.taskAbort]);
  // 終態改成提供「清除這張卡」：收工的卡留在頻道只是佔版面，但進行中的絕不給
  assert.deepEqual(ids('merged'), [ACTION_IDS.cardDismiss], '已合併只該剩清除鈕');
  assert.deepEqual(ids('done'), [ACTION_IDS.cardDismiss]);
  for (const s of ['working', 'verifying', 'reviewing', 'awaiting_merge', 'awaiting_human', 'failed'] as const) {
    assert.equal(ids(s, 'g1').includes(ACTION_IDS.cardDismiss), false, `${s} 不該有清除鈕（會誤刪進行中的東西）`);
  }
  assert.deepEqual(ids('pr_open'), [], 'PR 開了之後沒有當下能按的');
  // 裁決之後按鈕必須消失，否則人會重複點（重複核准 = 重複寫憑證、重複觸發把關）
  assert.deepEqual(ids('merge_checking'), [], '已核准後不該還能再按核准');
  assert.deepEqual(ids('reworking'), [], '已退回後不該還能再按退回');
  assert.deepEqual(ids('reviewing'), [ACTION_IDS.taskPause, ACTION_IDS.taskAbort]);
});

/** 核准鈕直接放在任務卡上：人不必去頻道別處翻那張早就被洗掉的核准卡。 */
test('任務卡：等核准時直接提供核准/退回按鈕，且帶得回群組 id', () => {
  const b = taskCardBlocks(task, 'awaiting_merge', { groupId: 'g_abc' });
  const btns = buttons(b);
  assert.deepEqual(btns.map((x) => x.action_id), [ACTION_IDS.mergeApprove, ACTION_IDS.mergeReject]);
  assert.equal(decodeActionValue(btns[0]!.value)?.groupId, 'g_abc');
});

test('任務卡：沒有群組 id 時不會給出按不動的核准鈕', () => {
  assert.deepEqual(buttons(taskCardBlocks(task, 'awaiting_merge')), []);
});

test('taskCardBlocks：缺 description/docRefs 也能產出合法 blocks（不得有空字串文字）', () => {
  const blocks = taskCardBlocks({ id: 'T-1', title: 't', repo: 'a/b', category: 'dev' });
  for (const raw of blocks as AnyBlock[]) {
    const texts: string[] = [];
    if (raw.text?.text) texts.push(raw.text.text);
    for (const f of raw.fields ?? []) texts.push(f.text);
    for (const e of raw.elements ?? []) if (e.text?.text ?? e.text) texts.push(e.text?.text ?? e.text);
    for (const t of texts) assert.ok(t.length > 0, `空文字節點：${JSON.stringify(raw)}`);
  }
  assert.match(allText(blocks), /（無）/);
});

test('taskCardBlocks：超長描述會截斷在 Slack 上限內', () => {
  const blocks = taskCardBlocks({ ...task, description: 'x'.repeat(5000) });
  const section = (blocks as AnyBlock[]).find((b) => b.type === 'section' && b.text?.text?.startsWith('x'));
  assert.ok(section);
  assert.ok(section!.text.text.length <= 2900, `長度 ${section!.text.text.length}`);
  assert.match(section!.text.text, /…$/);
});

test('taskCardText：純文字備援帶任務 id、repo 與狀態', () => {
  assert.equal(taskCardText(task), '🟡 [T-101] 修正結帳頁 RWD 破版（acme/web）— 執行中');
  assert.match(taskCardText(task, 'awaiting_merge'), /等你核准合併/);
  assert.match(taskCardText(task, 'merged'), /已合併/);
});

test('needsHuman：只有真的在等人的狀態才算', () => {
  assert.equal(needsHuman('awaiting_reply'), true);
  assert.equal(needsHuman('awaiting_merge'), true);
  assert.equal(needsHuman('awaiting_human'), true);
  assert.equal(needsHuman('working'), false);
  assert.equal(needsHuman('merged'), false);
});

// ── action value 編解碼 ──

test('encode/decodeActionValue：round-trip 與拒絕非法輸入', () => {
  const v = { taskId: 'T-1', optionId: 'opt-a' };
  assert.deepEqual(decodeActionValue(encodeActionValue(v)), { taskId: 'T-1', optionId: 'opt-a', groupId: undefined, projectId: undefined });
  assert.equal(decodeActionValue(undefined), undefined);
  assert.equal(decodeActionValue('不是 json'), undefined);
  assert.equal(decodeActionValue('[1,2]'), undefined);
  // 非字串欄位一律丟棄（不信任入站 payload）
  assert.deepEqual(decodeActionValue('{"taskId":123}'), { taskId: undefined, optionId: undefined, groupId: undefined, projectId: undefined });
});

// ── 生命週期事件 ──

test('eventBlocks：一般事件一行、且不 @人', () => {
  const blocks = eventBlocks({ type: 'pr_open', url: 'https://gh/pr/1' }, { mentions: ['U1'] });
  assert.equal(blocks.length, 1);
  assert.match(allText(blocks), /https:\/\/gh\/pr\/1/);
  assert.doesNotMatch(allText(blocks), /<@U1>/);
});

test('eventBlocks：失敗與提問類事件才 @人', () => {
  assert.match(allText(eventBlocks({ type: 'failed', detail: 'build 紅' }, { mentions: ['U1', 'U2'] })), /<@U1> <@U2>/);
  assert.match(allText(eventBlocks({ type: 'problem', detail: '429' }, { mentions: ['U1'] })), /<@U1>/);
  assert.doesNotMatch(allText(eventBlocks({ type: 'merged' }, { mentions: ['U1'] })), /<@U1>/);
});

test('eventBlocks：stalled 附失敗項目與結果簽章', () => {
  const gate: GateReport = {
    green: false,
    signature: 'sig-abc',
    checks: [
      { name: 'test', ok: false, detail: '3 failed' },
      { name: 'build', ok: true, detail: 'ok' },
    ],
  };
  const text = allText(eventBlocks({ type: 'stalled', gate }));
  assert.match(text, /test：3 failed/);
  assert.doesNotMatch(text, /build/); // 只列失敗項
  assert.match(text, /sig-abc/);
});

test('eventText：與 console 通知共用同一份文案', () => {
  assert.equal(eventText({ type: 'claimed' }), '🟡 已認領');
});

// ── 澄清 ──

const clarify: ClarificationRequest = {
  question: '訂單取消後要不要退庫存？',
  options: [
    { id: 'restock', label: '退回庫存', recommended: true },
    { id: 'keep', label: '不退' },
  ],
  recommendedDefault: 'restock',
  rationale: '牽涉庫存正確性，不可逆',
};

test('clarificationBlocks：問題 + 理由 + 建議預設 + 每個選項一顆按鈕 + 我來打字', () => {
  const blocks = clarificationBlocks('T-9', clarify, { mentions: ['U1'] });
  const text = allText(blocks);
  assert.match(text, /<@U1>/); // 提問要 @人
  assert.match(text, /訂單取消後要不要退庫存？/);
  assert.match(text, /牽涉庫存正確性，不可逆/);
  assert.match(text, /建議預設/);

  const btns = buttons(blocks);
  assert.equal(btns.length, 3);
  assert.deepEqual(
    btns.map((b) => b.action_id),
    [ACTION_IDS.clarifyOption, ACTION_IDS.clarifyOption, ACTION_IDS.clarifyFreeText],
  );
  assert.deepEqual(decodeActionValue(btns[0]!.value), { taskId: 'T-9', optionId: 'restock', groupId: undefined, projectId: undefined });
  assert.equal(btns[0]!.style, 'primary'); // 建議選項標記
  assert.match(btns[0]!.text.text, /（建議）/);
  assert.equal(btns[1]!.style, undefined);
  assert.deepEqual(decodeActionValue(btns[2]!.value)?.taskId, 'T-9');
});

test('clarificationBlocks：沒有 recommendedDefault 時退回 options 的 recommended 旗標', () => {
  const req: ClarificationRequest = { ...clarify, recommendedDefault: undefined };
  const btns = buttons(clarificationBlocks('T-9', req));
  assert.equal(btns[0]!.style, 'primary');
});

test('clarificationBlocks：選項超過上限時截斷，仍保留「我來打字」', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, label: `選項 ${i}` }));
  const btns = buttons(clarificationBlocks('T-9', { ...clarify, options: many, recommendedDefault: undefined }));
  assert.equal(btns.length, 25); // Slack actions 上限
  assert.equal(btns.at(-1)!.action_id, ACTION_IDS.clarifyFreeText);
});

test('clarificationText：純文字備援', () => {
  assert.match(clarificationText(clarify), /❓ 需要你的決定/);
});

// ── 合併核准 ──

test('mergeApprovalBlocks：核准/退回兩顆按鈕、value 帶 groupId', () => {
  const blocks = mergeApprovalBlocks({
    groupId: 'g_abc',
    branch: 'orch/g_abc',
    repo: 'acme/web',
    taskTitles: ['修 RWD', '加測試'],
    prUrl: 'https://gh/pr/7',
    reasons: ['migration'],
  });
  const text = allText(blocks);
  assert.match(text, /https:\/\/gh\/pr\/7/);
  assert.match(text, /g_abc/);
  assert.match(text, /修 RWD、加測試/);
  assert.match(text, /migration/);

  const btns = buttons(blocks);
  assert.deepEqual(
    btns.map((b) => b.action_id),
    [ACTION_IDS.mergeApprove, ACTION_IDS.mergeReject],
  );
  assert.deepEqual(decodeActionValue(btns[0]!.value)?.groupId, 'g_abc');
  assert.equal(btns[0]!.style, 'primary');
  assert.equal(btns[1]!.style, 'danger');
});

test('mergeApprovalBlocks：沒有 PR 連結時退回顯示分支', () => {
  const blocks = mergeApprovalBlocks({ groupId: 'g1', branch: 'orch/g1', repo: 'a/b', taskTitles: [] });
  assert.match(allText(blocks), /orch\/g1/);
});

// ── 「這張卡不用做」的人工確認（DESIGN §7b） ──

const noChange = {
  taskId: 'T-3',
  title: '把首頁改成暗色主題',
  category: 'already_satisfied' as const,
  reason: '暗色主題在 theme.ts 已經實作且預設啟用',
  evidence: 'src/theme.ts:12 有 defaultTheme = dark；npm test 全綠',
};

test('noChangeBlocks：兩顆按鈕（確認不用做 / 請你去做），value 帶 taskId', () => {
  const blocks = noChangeBlocks(noChange);
  const btns = buttons(blocks);
  assert.deepEqual(
    btns.map((b) => b.action_id),
    [ACTION_IDS.noChangeConfirm, ACTION_IDS.noChangeReject],
  );
  for (const b of btns) assert.equal(decodeActionValue(b.value)?.taskId, 'T-3');
});

test('noChangeBlocks：攤開分類/理由/查證依據，讓人有依據才按不可逆的按鈕', () => {
  const text = allText(noChangeBlocks(noChange, { mentions: ['U7'] }));
  assert.match(text, /<@U7>/); // 要人做決定 → @人
  assert.match(text, /T-3/);
  assert.match(text, /現況已符合需求/); // 分類的中文標籤
  assert.match(text, /theme.ts 已經實作/); // 理由
  assert.match(text, /defaultTheme = dark/); // 查證依據
  assert.match(text, /不可逆/); // 明確警語（D18：誤點的代價要寫出來）
});

test('noChangeBlocks：確認鈕有 Slack 原生二次確認對話框且標成 danger（防誤點）', () => {
  const confirmBtn = buttons(noChangeBlocks(noChange))[0]!;
  assert.equal(confirmBtn.style, 'danger');
  assert.ok(confirmBtn.confirm, '不可逆操作必須有二次確認');
  assert.match(confirmBtn.confirm.text.text, /不可逆/);
  assert.match(confirmBtn.confirm.text.text, /T-3/);
  // 「請你去做」是可逆的（回 queued 重跑），不需要對話框擋人
  assert.equal(buttons(noChangeBlocks(noChange))[1]!.confirm, undefined);
});

test('noChangeBlocks：agent 沒給依據時要明講（那是該懷疑的訊號），且無空文字節點', () => {
  const blocks = noChangeBlocks({ taskId: 'T-4', category: 'spec_unclear', reason: 'r' });
  assert.match(allText(blocks), /未提供/);
  for (const raw of blocks as AnyBlock[]) {
    const texts: string[] = [];
    if (raw.text?.text) texts.push(raw.text.text);
    for (const f of raw.fields ?? []) texts.push(f.text);
    for (const e of raw.elements ?? []) if (e.text?.text ?? e.text) texts.push(e.text?.text ?? e.text);
    for (const t of texts) assert.ok(t.length > 0, `空文字節點：${JSON.stringify(raw)}`);
  }
});

test('noChangeText：純文字備援帶 taskId 與分類', () => {
  assert.match(noChangeText(noChange), /T-3/);
  assert.match(noChangeText(noChange), /現況已符合需求/);
});

// ── 截圖 ──

test('screenshotComment：只顯示檔名與張數', () => {
  const c = screenshotComment(['/tmp/shots/home-1280.png', '/tmp/shots/home-375.png']);
  assert.equal(c, '📸 驗證截圖（2 張）：home-1280.png、home-375.png');
});

test('screenshotFallbackBlocks：上傳失敗時列出本機完整路徑', () => {
  const text = allText(screenshotFallbackBlocks(['/tmp/a.png']));
  assert.match(text, /\/tmp\/a.png/);
  assert.match(text, /上傳 Slack 失敗/);
});

/**
 * 使用者的要求：「事件過程寫在留言，但所有操作都停在卡片上」。
 * thread 是收合的——把可按的東西放在裡面，等於人看不到有事要處理。
 */
test('所有操作都在卡片上 — 澄清：選項變成卡片上的按鈕，並附「我來打字」', () => {
  const b = taskCardBlocks(task, 'awaiting_reply', {
    prompt: '空陣列要回傳 0 還是丟例外？',
    options: ['回傳 0', '丟例外'],
  });
  const btns = buttons(b);
  assert.deepEqual(btns.map((x) => x.text.text), ['回傳 0', '丟例外', '✏️ 我來打字']);
  assert.equal(decodeActionValue(btns[0]!.value)?.optionId, '回傳 0');
  assert.equal(decodeActionValue(btns[0]!.value)?.taskId, 'T-101', '要帶得回任務 id');
  assert.match(allText(b), /空陣列要回傳 0 還是丟例外/, '問題要顯示在卡片上，不必去 thread 翻');
});

test('所有操作都在卡片上 — 澄清：選項太多時收斂（Slack 一列放不下無限顆按鈕）', () => {
  const b = taskCardBlocks(task, 'awaiting_reply', { options: ['a', 'b', 'c', 'd', 'e', 'f'] });
  assert.ok(buttons(b).length <= 5);
});

/** confirm 會呼叫 complete_task（不可逆），所以要標成危險色並排在後面。 */
test('所有操作都在卡片上 — 「不用做」：確認與否決兩顆都在卡片上', () => {
  const b = taskCardBlocks(task, 'awaiting_no_change', { prompt: '這個功能上一個 PR 已經做過了' });
  const btns = buttons(b);
  assert.deepEqual(btns.map((x) => x.action_id), [ACTION_IDS.noChangeReject, ACTION_IDS.noChangeConfirm]);
  assert.equal(btns[1]?.style, 'danger', '不可逆的操作要標紅');
  assert.match(allText(b), /上一個 PR 已經做過/, '理由要顯示在卡片上');
});

test('所有操作都在卡片上 — 沒有 prompt 時不會多出空的引用區塊', () => {
  assert.equal(/^>/m.test(allText(taskCardBlocks(task, 'awaiting_reply'))), false);
});

// ── 卡片上的進度 ──

/**
 * 實跑時一個任務跑了 17 分鐘，卡片只在「執行中／驗證中／審查中」之間跳，
 * thread 一則訊息都沒有。那段時間裡「正在做事」與「已經死了」在畫面上一模一樣。
 */
describe('任務卡進度', () => {
  const task = { id: 'T-1', title: '加深色模式', repo: 'acme/web', category: 'feature' };
  const textOf = (b: unknown[]): string => JSON.stringify(b);

  it('顯示輪數、耗時與改了幾個檔案', () => {
    const b = taskCardBlocks(task, 'working', {
      progress: { round: 3, elapsedMs: 17 * 60_000, changedFiles: 7 },
    });
    assert.match(textOf(b), /第 3 輪/);
    assert.match(textOf(b), /已跑 17 分鐘/);
    assert.match(textOf(b), /改了 7 個檔案/);
  });

  it('顯示上一輪的結果', () => {
    const b = taskCardBlocks(task, 'working', { progress: { round: 2, lastOutcome: 'build、test' } });
    assert.match(textOf(b), /上一輪：build、test/);
  });

  it('沒有進度資訊時不多印空行', () => {
    assert.equal(/第 \d+ 輪|上一輪/.test(textOf(taskCardBlocks(task, 'working'))), false);
  });

  it('時間換算：不到一分鐘、分鐘、小時', () => {
    assert.equal(humanDuration(30_000), '不到 1 分鐘');
    assert.equal(humanDuration(17 * 60_000), '17 分鐘');
    assert.equal(humanDuration(60 * 60_000), '1 小時');
    assert.equal(humanDuration(95 * 60_000), '1 小時 35 分');
  });

  it('progressLine：全空時回 undefined（不要印一行只有分隔號的東西）', () => {
    assert.equal(progressLine({}), undefined);
    assert.equal(progressLine(undefined), undefined);
  });
});
