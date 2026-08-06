import type { LedgerEvent } from '../store/ledger.js';

/**
 * 人回覆之後怎麼把答案送回 agent（並接回同一個 session）。
 *
 * 修的是一個很安靜、但會讓整條互動路徑失效的缺口：
 * agent 呼叫 ask_human 提問 → Worker park → 人在 Slack/CLI 回答 → InboundRouter
 * 把答案寫進 events、任務轉回 queued → 群組重派 → Worker **從頭重跑這個任務**。
 * 重跑時答案沒有被讀出來、session 也沒接回去，於是 agent 什麼都不知道，
 * 大機率再問一次同樣的問題——形成「問→答→再問」的循環，而且每一圈都真的在燒錢。
 *
 * 兩件事一起做才有用：
 *   1. **把答案注入 prompt**（沒有這個，人的回覆等於丟進黑洞）
 *   2. **resume 原本的 session**（沒有這個，agent 得重新讀一次規格、重新摸索一次程式碼；
 *      而且它先前的推理過程消失，很可能得出跟提問當下不一樣的判斷）
 *
 * 已消費的回覆要標記，否則同一個答案會在之後每一輪重跑時反覆注入——
 * agent 會以為人又回答了一次，把早就處理完的問題再處理一遍。
 */

/** 會產生「要回灌給 agent 的人類回覆」的事件種類（新到舊由 id 決定）。 */
export const HUMAN_REPLY_EVENTS = ['clarification_answer', 'no_change_rejected'] as const;
export type HumanReplyKind = (typeof HUMAN_REPLY_EVENTS)[number];

/**
 * 這個任務上**所有已經被人裁決過的問題**（不消費、可重複讀）。
 *
 * 為什麼 reviewer 需要它：reviewer 只看得到規格與 diff。規格上寫著「沒有定論」的地方，
 * 如果人已經透過 ask_human 拍板了，reviewer 完全不知道——它會把一個已經解決的問題
 * 重新提出來，退回 agent，白費一輪。實跑撞到：規格明寫「主題要不要一併重設沒有定論」，
 * 人回答了「不要」，agent 照做，reviewer 卻退回說「你不該自行決定」。
 *
 * 與 pendingHumanReply 的差別：那個是「還沒送進 agent 的最新一則」，讀完要標記消費；
 * 這個是「歷來所有裁決」，任何時候都能讀，不影響消費狀態。
 */
/**
 * 常設決定（`scope='always'`）在事件表裡的 kind。
 *
 * 掛在 `system` scope、refId ＝ repo：這樣它**不屬於任何一張卡**，
 * 而下一張卡查得到。這正是它存在的理由。
 */
export const STANDING_DECISION = 'standing_decision';

/**
 * 這個 repo 上「人已經拍板、而且說了以後都這樣」的決定。
 *
 * ── 為什麼需要跨任務 ──
 *
 * 實跑（2026-08-04）：`spec/ 寫不進去` 這件事，02:43 害了 QTa5wZ5CIi_z，
 * 17:44 又原封不動害了 zZb5MGTMdQRZ——**相隔 14 小時、同一個 repo、同一個成因**。
 * 就算第一次有人回答了，那個答案也只存在於第一張卡的事件裡，第二張卡看不到。
 *
 * 所以人在回答時可以說「以後都這樣」，答案就掛到 repo 上而不是那張卡上。
 * 下一個 agent 的 prompt 裡自動帶出來——不必再問一次，也不必寫進 spec/ 才存在。
 */
export function standingDecisions(
  ledger: { listEvents(q: { scope: 'system'; refId: string; kind?: string; limit?: number }): LedgerEvent[] },
  repo: string,
): { question: string; answer: string }[] {
  const rows = ledger.listEvents({ scope: 'system', refId: repo, kind: STANDING_DECISION, limit: 50 });
  return rows
    .map((e) => {
      try {
        const j = JSON.parse(e.detail ?? '{}') as { question?: unknown; answer?: unknown };
        return {
          question: typeof j.question === 'string' ? j.question : '（原問題已不可考）',
          answer: typeof j.answer === 'string' ? j.answer : '',
        };
      } catch {
        return { question: '（原問題已不可考）', answer: e.detail ?? '' };
      }
    })
    .filter((d) => d.answer.trim() !== '');
}

export function settledDecisions(
  ledger: { listEvents(q: { scope: 'task'; refId: string; kind?: string; limit?: number }): LedgerEvent[] },
  taskId: string,
): { question: string; answer: string }[] {
  const answered = ledger.listEvents({ scope: 'task', refId: taskId, kind: 'clarification_answer', limit: 50 });
  if (answered.length === 0) return [];
  const asked = ledger.listEvents({ scope: 'task', refId: taskId, kind: 'clarification_asked', limit: 50 });

  // **用 threadTs 對，不用位置對。**
  //
  // 先前是 `answered.map((e, i) => ({ question: questions[i] … }))`——用陣列位置
  // 把答案綁到問題上，而兩張清單之間沒有任何參照關係。只要有一則提問還沒被回答，
  // 整串就位移：agent 問 Q1 → 人答 A1 → 任務重跑 → agent 又問 Q2（還沒人回）→
  // asked=[Q2,Q1]、answered=[A1] → 配出 {question: Q2, answer: A1}。
  //
  // 而這份東西會進 reviewer 的 prompt，開頭寫著「下面這些已經由需求方決定了，
  // 不要因為規格沒寫而回報違規」——**等於程式編了一個沒有人做過的裁決，
  // 然後叫審查者據此放行**。比漏掉更糟。
  //
  // threadTs 本來就是天然的關聯鍵（Slack thread ＝ 一次問答），只是先前沒被用來配對。
  const byThread = new Map<string, string>();
  for (const e of asked) {
    const { threadTs, question } = parseAsked(e.detail);
    if (threadTs && question) byThread.set(threadTs, question);
  }

  const out: { question: string; answer: string }[] = [];
  for (const e of answered) {
    const { threadTs, answer } = parseAnswer(e.detail);
    if (!answer) continue;
    // 對不到就照實說「對不到」，不要硬塞給最近的一則提問
    out.push({ question: (threadTs && byThread.get(threadTs)) || '（這則答覆對不到原始提問）', answer });
  }
  return out;
}

/** clarification_asked 的 detail：新版是整包 JSON，舊版是純問題文字。 */
function parseAsked(detail: string | undefined): { threadTs?: string; question?: string } {
  if (!detail) return {};
  try {
    const j = JSON.parse(detail) as { question?: unknown; threadTs?: unknown };
    return {
      ...(typeof j.question === 'string' ? { question: j.question } : {}),
      ...(typeof j.threadTs === 'string' ? { threadTs: j.threadTs } : {}),
    };
  } catch {
    return { question: detail };
  }
}

function parseAnswer(detail: string | undefined): { threadTs?: string; answer?: string } {
  if (!detail) return {};
  try {
    const j = JSON.parse(detail) as { answer?: unknown; threadTs?: unknown };
    return {
      ...(typeof j.answer === 'string' ? { answer: j.answer } : {}),
      ...(typeof j.threadTs === 'string' ? { threadTs: j.threadTs } : {}),
    };
  } catch {
    return { answer: detail };
  }
}

/** clarification_asked 的 detail 可能是 JSON 或純文字。 */
function questionText(detail: string | undefined): string {
  if (!detail) return '';
  try {
    const j = JSON.parse(detail) as { question?: unknown };
    return typeof j.question === 'string' ? j.question : detail;
  } catch {
    return detail;
  }
}

/** 標記「這則回覆已經送進 agent 了」的事件種類；detail 存被消費事件的 id。 */
export const HUMAN_REPLY_CONSUMED = 'human_reply_consumed';

export interface HumanReply {
  /** 來源事件 id（消費標記用）。 */
  eventId: number;
  kind: HumanReplyKind;
  /** 給 agent 看的問題描述（澄清才有原問題，否決則是固定敘述）。 */
  question: string;
  answer: string;
}

/** human-reply 需要的 ledger 能力（只讀事件 + 寫消費標記）。 */
export interface HumanReplyLedger {
  latestEvent(scope: 'task', refId: string, kind: string): LedgerEvent | undefined;
  logEvent(scope: 'task', refId: string, kind: string, detail?: string): void;
}

/** 澄清答覆的 detail 是 JSON：{ threadTs, answer }；解析失敗就退回原字串。 */
function answerText(detail: string | undefined): string {
  if (!detail) return '';
  try {
    const j = JSON.parse(detail) as { answer?: unknown };
    if (typeof j.answer === 'string') return j.answer;
  } catch {
    /* 不是 JSON → 當純文字用 */
  }
  return detail;
}

/**
 * 取出這個任務「還沒送進 agent」的人類回覆。
 *
 * 同時有多種回覆時取 id 最大的那則（事件 id 單調遞增 ⇒ 最後寫的就是人最後說的話）。
 */
export function pendingHumanReply(ledger: HumanReplyLedger, taskId: string): HumanReply | undefined {
  const candidates = HUMAN_REPLY_EVENTS
    .map((kind) => ({ kind, ev: ledger.latestEvent('task', taskId, kind) }))
    .filter((c): c is { kind: HumanReplyKind; ev: LedgerEvent } => c.ev !== undefined);
  if (candidates.length === 0) return undefined;

  const latest = candidates.reduce((a, b) => (b.ev.id > a.ev.id ? b : a));

  const consumed = ledger.latestEvent('task', taskId, HUMAN_REPLY_CONSUMED);
  const consumedId = consumed ? Number(consumed.detail ?? 0) : 0;
  if (Number.isFinite(consumedId) && latest.ev.id <= consumedId) return undefined;

  if (latest.kind === 'no_change_rejected') {
    return {
      eventId: latest.ev.id,
      kind: latest.kind,
      question: '你先前宣告「本任務不需要任何程式碼改動」。',
      answer:
        '人已否決這個宣告：這個任務**確實需要改動**，請重新查證後實作，不要再次呼叫 report_no_change。'
        + '若你仍認為做不到，請改用 ask_human 說明卡在哪裡。',
    };
  }

  const question = latestQuestion(ledger, taskId);
  return {
    eventId: latest.ev.id,
    kind: latest.kind,
    question,
    answer: answerText(latest.ev.detail),
  };
}

/** 找回當初 park 時記下的問題（沒有就給一句通用敘述，別讓 prompt 出現空問題）。 */
function latestQuestion(ledger: HumanReplyLedger, taskId: string): string {
  const asked = ledger.latestEvent('task', taskId, 'clarification_asked');
  return asked?.detail && asked.detail.trim() !== '' ? asked.detail : '（你先前提出的問題）';
}

/** 標記已消費：下一輪不會再把同一則回覆注入一次。 */
export function markHumanReplyConsumed(ledger: HumanReplyLedger, taskId: string, reply: HumanReply): void {
  ledger.logEvent('task', taskId, HUMAN_REPLY_CONSUMED, String(reply.eventId));
}
