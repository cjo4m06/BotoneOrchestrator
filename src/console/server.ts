import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execa } from 'execa';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigStore, expandEnv } from '../config/store.js';
import { collectPending, frictionInput, statusInput, summarizeFriction } from '../cli/ask.js';
import { FRICTION_EVENT, parseFrictionEvent } from '../worker/friction.js';
import { FRICTION_TRIAGED, TRIAGE_LABEL, isTriageAction, triagedMap, toTaskCardText } from '../worker/friction-triage.js';
import { quietWaits, startOfToday, TASK_STATES, GROUP_STATES } from '../cli/report.js';
import { mcpResilienceFromEnv } from '../mcp/mcp-client.js';
import { listBranches } from '../git/base-freshness.js';
import { evaluateBudget, periodLabel } from '../core/budget.js';
import { createMcpClient } from '../main.js';
import { InboundRouter, type CompleteTaskFn } from '../notify/notifier.js';
import type { Ledger } from '../store/ledger.js';
import type { Logger } from '../observability/logger.js';
import type { ProjectConfig } from '../config/index.js';
import type { PurgeResult } from '../core/project-purge.js';
import { STALE_AFTER_MS } from '../observability/activity.js';
import { TICK_FAILED_EVENT } from '../core/orchestrator.js';

/**
 * 本機控制台。
 *
 * 只綁 127.0.0.1：能連到它的就是坐在這台機器前面的人，所以不做登入。
 * 這是刻意的取捨——加密碼等於多一個會忘記、會被寫進某個腳本的密鑰，而它擋不住
 * 任何真正的攻擊者（能在這台機器執行程式的人本來就讀得到 DB）。
 * 反過來說，**絕對不能綁 0.0.0.0**：這個介面可以改 MCP token、停用專案、核准合併。
 *
 * 用 node:http 不用框架：這是一個單頁工具，路由不到二十條，
 * 為它拉一個 web framework 只是多一份要跟著升級的相依。
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ConsoleDeps {
  store: ConfigStore;
  ledger: Ledger;
  log: Logger;
  /** 綁定位址。**只接受 loopback**，見上方說明。 */
  host?: string;
  port?: number;
  /** 人的裁決（回答澄清、核准合併…）；未注入則控制台只能看不能決定。 */
  router?: InboundRouter;
  /** daemon 是否在同一個行程裡（顯示用）。 */
  inProcess?: boolean;
  /**
   * 停用專案時清掉它的本地狀態（見 core/project-purge.ts）。
   *
   * **必填。** 少接的話「停用」就只是改個旗標，下次啟用會拿舊快照在跑；
   * 而且停用期間每一輪 tick 都會在規劃那一步擲錯，整個 tick 的後半段全部跳過。
   * 列為必填，就是要讓漏接在 typecheck 當場失敗，而不是等實跑才發現。
   */
  purgeProject: (repo: string) => Promise<PurgeResult>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export class ConsoleServer {
  private server = createServer((req, res) => void this.handle(req, res));
  private host: string;
  private port: number;

  constructor(private deps: ConsoleDeps) {
    this.host = deps.host ?? '127.0.0.1';
    this.port = deps.port ?? 8787;
    if (!LOOPBACK.has(this.host)) {
      // 這個介面能改密鑰與核准合併。綁到外部位址是安全事故，不是設定選項。
      throw new Error(`控制台只能綁 loopback（收到 ${this.host}）——它可以改 MCP token 與核准合併`);
    }
  }

  async start(): Promise<{ url: string }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => resolve());
    });
    // 傳 0 讓 OS 挑埠時，實際埠號要回填——同源判斷要比對它
    this.port = this.address().port || this.port;
    const url = `http://${this.host}:${this.port}`;
    this.deps.log.info({ url }, '控制台已啟動');
    return { url };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** 實際綁定的埠（傳 0 讓 OS 挑時要用得到）。 */
  address(): { host: string; port: number } {
    const a = this.server.address();
    return typeof a === 'object' && a !== null ? { host: a.address, port: a.port } : { host: this.host, port: this.port };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.host}`);
    const path = url.pathname;
    try {
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) return this.html(res);
      if (path === '/favicon.ico') {
        // 回一個 emoji favicon：不處理的話每次載入都噴 404，真正的錯誤會被淹沒
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text y="52" font-size="52">🤖</text></svg>';
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
        return void res.end(svg);
      }
      if (path.startsWith('/api/')) {
        const bad = crossSiteReason(req, this.port);
        if (bad) {
          this.deps.log.warn({ path, reason: bad }, '擋下跨站請求');
          return this.json(res, 403, { error: bad });
        }
        return await this.api(req, res, path, url);
      }
      this.json(res, 404, { error: '找不到' });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.deps.log.warn({ path, err: detail }, '控制台請求失敗');
      // 把錯誤原樣回給前端：這是本機工具，看得到真正的原因才修得動
      this.json(res, 400, { error: detail });
    }
  }

  /**
   * 找出 ui.html。
   *
   * 為什麼要找兩個地方：`tsc` 只吐 .js，不會複製非 TS 檔，所以 `dist/console/ui.html`
   * 得靠 build 腳本額外 cp。少了那一步時，開發時（tsx 直接跑 src）一切正常，
   * 只有掛上 launchd 跑 dist 才壞——而且症狀是首頁回一句沒頭沒尾的 400。
   * 實跑撞到過，追了一陣子才發現是檔案根本沒進 dist。
   *
   * 所以：dist 找不到就退回原始碼位置（同一份內容，只是沒複製過去），
   * 兩邊都沒有才報錯，而且要指名道姓說怎麼修。
   */
  private uiPath(): string {
    const candidates = [join(HERE, 'ui.html'), join(HERE, '..', '..', 'src', 'console', 'ui.html')];
    const found = candidates.find((p) => existsSync(p));
    if (!found) {
      throw new Error(`找不到控制台頁面 ui.html（找過：${candidates.join('、')}）。請執行 npm run build`);
    }
    return found;
  }

  private html(res: ServerResponse): void {
    const body = readFileSync(this.uiPath(), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  private json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.trim() === '') return {};
    return JSON.parse(raw) as Record<string, unknown>;
  }

  // ── API ──

  private async api(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    const { store, ledger } = this.deps;
    const m = req.method ?? 'GET';

    if (path === '/api/state' && m === 'GET') return this.json(res, 200, this.state());

    if (path === '/api/friction' && m === 'GET') {
      // agent 回報的系統摩擦。唯讀——這裡不做任何自動處置，
      // 因為那些是自我回報，可能對也可能只是它不想做某件事。
      // **在 SQL 就排除已分診的**（見 Ledger.listOpenFriction）：撈完再濾的話，
      // 已處理的那幾筆照樣佔著視窗名額，越處理越把未處理的老回報擠出視窗。
      const open = ledger.listOpenFriction(FRICTION_EVENT, FRICTION_TRIAGED, 200);
      const summary = summarizeFriction(
        open.map((e) => ({ id: e.id, taskId: e.refId ?? '(unknown)', ...(e.detail ? { detail: e.detail } : {}) })),
        200,
        new Map(),
      );
      return this.json(res, 200, { ...summary, triaged: ledger.countTriagedFriction(FRICTION_EVENT, FRICTION_TRIAGED) });
    }

    if (path === '/api/friction/card' && m === 'GET') {
      // 「要處理」的按鈕要貼到任務板，而 MCP **沒有建立任務的工具**（只有 list/get/start/complete），
      // 所以程式開不了卡——這裡只把原話、證據、建議整理成可貼的文字，一個字都不改寫。
      const id = Number(url.searchParams.get('id'));
      const row = ledger.listEvents({ scope: 'task', kind: FRICTION_EVENT, limit: 500 }).find((e) => e.id === id);
      const rep = row ? parseFrictionEvent(row.detail) : undefined;
      if (!row || !rep) return this.json(res, 404, { ok: false, error: `找不到編號 ${id} 的回報` });
      return this.json(res, 200, {
        ok: true,
        text: toTaskCardText({ ...rep, taskId: row.refId ?? undefined }),
      });
    }

    if (path === '/api/friction/triage' && m === 'POST') {
      const body = await this.body(req);
      const id = Number(body.id);
      const action = body.action;
      if (!Number.isInteger(id) || id <= 0) return this.json(res, 400, { ok: false, error: '缺少回報 id' });
      if (!isTriageAction(action)) {
        return this.json(res, 400, { ok: false, error: `未知的動作：${String(action)}` });
      }
      // **這一筆回報真的存在嗎。** 不驗的話打錯 id 會留下一筆指向空氣的分診，
      // 而那一筆會永遠把某個未來的回報藏起來（id 是遞增的，總有一天會撞上）。
      const exists = ledger.listEvents({ scope: 'task', kind: FRICTION_EVENT, limit: 500 }).some((e) => e.id === id);
      if (!exists) return this.json(res, 404, { ok: false, error: `找不到編號 ${id} 的回報` });

      const note = typeof body.note === 'string' ? body.note.trim() : '';
      // wont_fix 的理由是必填：事後要看得出「當時為什麼決定不處理」，
      // 而那正是幾週後最想知道、卻最查不到的東西。
      if (action === 'wont_fix' && note === '') {
        return this.json(res, 400, { ok: false, error: '「不處理」要寫一句理由（事後只剩這一行字查得到）' });
      }
      ledger.logEvent('system', String(id), FRICTION_TRIAGED, JSON.stringify({
        action, ...(note ? { note } : {}), by: 'console',
      }));
      this.deps.log.info({ frictionId: id, action, note }, '📋 摩擦回報已分診');
      return this.json(res, 200, { ok: true, detail: `已標記為「${TRIAGE_LABEL[action]}」` });
    }

    if (path === '/api/settings' && m === 'GET') {
      return this.json(res, 200, { raw: store.rawSettings(), effective: store.settings() });
    }
    if (path === '/api/settings' && m === 'PUT') {
      const patch = await this.body(req);
      const saved = store.saveSettings(patch);
      this.deps.log.info({ keys: Object.keys(patch) }, '控制台更新了設定');
      return this.json(res, 200, { ok: true, effective: saved });
    }

    if (path === '/api/projects' && m === 'GET') {
      return this.json(res, 200, {
        projects: store.allProjects().map((p) => ({
          enabled: p.enabled,
          raw: store.rawProject(p.config.id),
          effective: p.config,
          updatedAt: p.updatedAt,
        })),
      });
    }
    if (path === '/api/projects' && m === 'PUT') {
      const input = await this.body(req);
      const saved = store.upsertProject(input);
      this.deps.log.info({ id: saved.id, repo: saved.repo }, '控制台儲存了專案');
      return this.json(res, 200, { ok: true, project: saved });
    }
    if (path === '/api/projects/test' && m === 'POST') {
      return this.json(res, 200, await this.testMcp(await this.body(req)));
    }

    const projMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
    if (projMatch && m === 'DELETE') {
      const id = decodeURIComponent(projMatch[1]!);
      const gone = store.removeProject(id);
      this.deps.log.info({ id, gone }, '控制台刪除了專案');
      return this.json(res, gone ? 200 : 404, { ok: gone });
    }
    const enabledMatch = /^\/api\/projects\/([^/]+)\/enabled$/.exec(path);
    if (enabledMatch && m === 'POST') {
      const id = decodeURIComponent(enabledMatch[1]!);
      const { enabled } = (await this.body(req)) as { enabled?: boolean };
      const on = enabled === true;
      // 先取 repo：旗標改完之後 projects() 就查不到它了
      const repo = store.allProjects().find((p) => p.config.id === id)?.config.repo;
      const ok = store.setProjectEnabled(id, on);
      if (!ok) return this.json(res, 404, { ok });

      // **停用＝清乾淨。** 留著的話下次啟用是拿舊快照在跑，而且停用期間每一輪 tick
      // 都會因為「查不到專案」在規劃那一步擲錯，連帶讓輪詢、審查監看、合併佇列、
      // 待辦提醒全部跳過（實跑撞到）。
      let purged;
      if (!on && repo) {
        try {
          purged = await this.deps.purgeProject(repo);
          this.deps.log.info({ id, repo, ...purged }, '停用專案並清除本地狀態');
        } catch (e) {
          // 清理失敗不該讓「停用」失敗——旗標已經關了，那才是重點
          this.deps.log.warn({ id, err: e instanceof Error ? e.message : String(e) }, '停用後清理失敗（專案已停用）');
        }
      }
      return this.json(res, 200, { ok, ...(purged ? { purged } : {}) });
    }

    // 路徑選擇器：瀏覽器拿不到真實檔案路徑（安全限制），所以由伺服器端列目錄。
    // 這是本機工具，伺服器就在使用者的機器上，列自己的目錄沒有跨越任何邊界。
    if (path === '/api/fs' && m === 'GET') {
      return this.json(res, 200, await listDir(url.searchParams.get('path') ?? homedir()));
    }

    // 分支清單：讓人從實際存在的分支挑，而不是手打（打錯的話 worktree 會建不起來，
    // 而且錯誤要到派工時才出現）。
    if (path === '/api/branches' && m === 'GET') {
      const repoPath = url.searchParams.get('repoPath') ?? '';
      if (!repoPath) return this.json(res, 400, { error: '缺少 repoPath' });
      return this.json(res, 200, await branchesOf(repoPath));
    }

    if (path === '/api/events' && m === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500);
      return this.json(res, 200, { events: ledger.listEvents({ limit }) });
    }

    if (path === '/api/decide' && m === 'POST') {
      return this.json(res, 200, await this.decide(await this.body(req)));
    }

    this.json(res, 404, { error: `未知的 API：${m} ${path}` });
  }

  /** 儀表板要的一切，一次取完（前端每次重整只打一支）。 */
  private state(): Record<string, unknown> {
    const { store, ledger } = this.deps;
    const now = Date.now();
    const cfg = { projects: store.projects() };
    const st = statusInput(ledger, cfg, now, ledger.costByRepo(startOfToday(now)));
    const counts = <T extends string>(keys: readonly T[], get: (k: T) => unknown[]): Record<T, number> =>
      Object.fromEntries(keys.map((k) => [k, get(k).length])) as Record<T, number>;

    return {
      now,
      inProcess: this.deps.inProcess === true,
      canDecide: this.deps.router !== undefined,
      projects: store.allProjects().map((p) => ({ id: p.config.id, repo: p.config.repo, enabled: p.enabled })),
      taskCounts: counts(TASK_STATES, (k) => st.tasksByState[k]),
      groupCounts: counts(GROUP_STATES, (k) => st.groupsByState[k]),
      running: [...st.tasksByState.in_progress, ...st.tasksByState.verifying].map(brief),
      blocked: st.tasksByState.blocked.map(brief),
      groups: GROUP_STATES.flatMap((s) =>
        st.groupsByState[s].map((g) => ({ id: g.id, repo: g.repo, state: g.state, prUrl: g.prUrl ?? null })),
      ),
      // 現在誰在做什麼。**這是唯一能回答「平台是不是掛了」的東西**——
      // 規劃、審查、視覺驗證、合併把關期間 ledger 完全靜止，
      // 沒有這塊的話畫面上什麼都不會動（使用者實際回報：「我以為整個專案都在停擺」）。
      activities: ledger.listActivities().map((a) => ({
        ...a,
        // 心跳太舊 = daemon 沒了但沒人來收這一列。畫面要標出來，不能假裝它還在跑
        stale: now - a.heartbeatAt > STALE_AFTER_MS,
      })),
      // 最近一次整輪失敗。畫面上一定要有——不然「什麼都沒在動」與
      // 「每一輪都在同一個地方炸掉」長得一模一樣（實跑撞到規劃 agent 連續失敗）。
      lastFailure: latestTickFailure(ledger, now),
      pending: collectPending(ledger),
      quietWaits: quietWaits(st),
      budget: budgetView(store.settings().budget, (since) => ledger.costSummary(since).costUsd, now),
      cost: {
        today: ledger.costSummary(startOfToday(now)),
        total: ledger.costSummary(),
        byRepo: ledger.costByRepo(startOfToday(now)),
        topTasks: ledger.costByTask(10),
      },
    };
  }

  /**
   * 存檔前先測 MCP 連得通。
   *
   * 沒有這個按鈕的話，設定寫錯的回饋要等到下一輪輪詢、而且只出現在 daemon 的 log 裡——
   * 使用者在控制台按了「儲存」看到成功，實際上什麼都不會動。
   */
  private async testMcp(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    // **一定要展開 ${VAR}**：表單送來的是使用者填的字面值，而我們建議的寫法就是
    // `token: ${MY_TOKEN}`。不展開的話，測試會拿字面字串去連線並回 401——
    // 正好是最常見的設定方式測起來永遠失敗（實測撞到）。
    const p = expandEnv(input) as unknown as ProjectConfig;
    const mcp = p?.mcp;
    if (!mcp) return { ok: false, error: '缺少 mcp 設定' };

    // 走與 daemon 完全相同的建構路徑（createMcpClient），否則「測試通過但實際連不上」
    const client = createMcpClient(p, this.deps.log, mcpResilienceFromEnv());
    if (!client) return { ok: false, error: 'MCP 設定不完整（http 需要 url，stdio 需要 command）' };
    try {
      await client.connect();
      const tasks = await client.listTasks({ repo: p.repo, status: 'todo', mine: p.pollMine ?? true });
      return { ok: true, todoCount: tasks.length, sample: tasks.slice(0, 3).map((t) => ({ id: t.id, title: t.title })) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      await client.close().catch(() => {});
    }
  }

  /** 人的裁決：走與 Slack／CLI 完全相同的 InboundRouter（不是第二套邏輯）。 */
  private async decide(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const router = this.deps.router;
    if (!router) return { ok: false, error: '這個控制台沒有接上裁決路徑（daemon 未在同一行程）' };

    const action = String(input.action ?? '');
    const id = String(input.id ?? '');
    if (!id) return { ok: false, error: '缺少 id' };

    switch (action) {
      case 'answer': {
        // scope='always' → 答覆掛到 repo 上而不是這張卡上（見 human-reply.ts 的 standingDecisions）
        const scope = input.scope === 'always' ? ('always' as const) : ('task' as const);
        router.handleAnswer({ taskId: id, threadTs: '', freeText: String(input.text ?? ''), scope });
        return { ok: true, ...(scope === 'always' ? { detail: '已設為常設決定，之後這個專案的任務都會看到' } : {}) };
      }
      case 'retry': {
        // stuck_group 的 id 是**群組** id。走 handleControl 的 retry 對它無效
        //（那個做的是 clearBlock(taskId)），實跑撞到：按了什麼都沒發生。
        if (id.startsWith('g_')) {
          const revived = await router.reviveGroup({ groupId: id, userId: 'console' });
          return revived
            ? { ok: true, detail: '群組已回到待派工' }
            : { ok: false, error: '無法復活這個群組（可能已被清掉或狀態已改變）' };
        }
        await router.handleControl({ type: action, taskId: id, userId: 'console' });
        return { ok: true };
      }
      case 'land-anyway': {
        // 定案③：人看完證據後表態「我知道這個紅，但它不是這一群造成的」。
        // 理由是**必填**——沒有理由的放行事後查不出當時憑什麼放，跟沒記一樣。
        const note = String(input.text ?? '').trim();
        if (!note) return { ok: false, error: '請說明為什麼可以帶著這個紅落地（會記進 PR 內文與 ledger）' };
        const landed = await router.landAnyway({ groupId: id, userId: 'console', note });
        return landed
          ? { ok: true, detail: '已記錄理由，群組回到待派工' }
          : { ok: false, error: '無法落地這個群組（可能已被清掉）' };
      }
      case 'abort':
      case 'pause':
        await router.handleControl({ type: action, taskId: id, userId: 'console' });
        return { ok: true };
      case 'reject_no_change':
        await router.handleControl({ type: 'retry', taskId: id, userId: 'console', source: 'no_change_rejected' });
        return { ok: true };
      case 'confirm_no_change':
        // 不可逆（會呼叫 complete_task）。前端一定要二次確認才送到這裡。
        await router.handleControl({ type: 'confirm_no_change', taskId: id, userId: 'console' });
        return { ok: true };
      case 'approve':
      case 'deny':
        router.handleMergeDecision({ groupId: id, approved: action === 'approve', userId: 'console' });
        return { ok: true };
      default:
        return { ok: false, error: `未知的動作：${action}` };
    }
  }
}

/** 預算用量（控制台要把「還剩多少」放在設定旁邊，不然人得自己心算）。 */
function budgetView(
  limits: Parameters<typeof evaluateBudget>[0]['limits'],
  spent: (since: number) => number,
  now: number,
): Record<string, unknown> {
  const v = evaluateBudget({
    limits,
    spentSince: (since) => ({ sessions: 0, costUsd: spent(since), inputTokens: 0, outputTokens: 0, rounds: 0 }),
    now,
  });
  return {
    ok: v.ok,
    all: v.all.map((u) => ({ ...u, label: periodLabel(u.period) })),
    exceeded: v.exceeded.map((u) => u.period),
    warning: v.warning.map((u) => u.period),
  };
}

/** 列出目錄（只回目錄，檔案對選 clone 路徑沒有意義）。 */
async function listDir(target: string): Promise<Record<string, unknown>> {
  const dir = resolve(target.startsWith('~') ? join(homedir(), target.slice(1)) : target);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    // 標出哪些是 git repo：選 clone 路徑時，這是唯一真正重要的資訊
    const marked = await Promise.all(
      dirs.map(async (name) => ({ name, isRepo: await isGitRepo(join(dir, name)) })),
    );
    return { path: dir, parent: dirname(dir) === dir ? null : dirname(dir), entries: marked, isRepo: await isGitRepo(dir) };
  } catch (e) {
    return { path: dir, parent: dirname(dir) === dir ? null : dirname(dir), entries: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function branchesOf(repoPath: string): Promise<Record<string, unknown>> {
  const git = async (p: string, args: string[]) => {
    const r = await execa('git', ['-C', p, ...args], { reject: false });
    return { exitCode: r.exitCode ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  try {
    const b = await listBranches(git, repoPath);
    const head = await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return { ...b, current: head.exitCode === 0 ? head.stdout.trim() : null };
  } catch (e) {
    return { local: [], remote: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function brief(t: { id: string; title: string; repo: string; block?: { reason: string; detail?: string } }) {
  return { id: t.id, title: t.title, repo: t.repo, blockReason: t.block?.reason ?? null };
}

export type { CompleteTaskFn };


/**
 * 最近一小時內的整輪失敗（沒有就 null）。
 *
 * 為什麼要有時效：一小時前失敗過、現在已經正常了，還在畫面上掛紅字只會製造麻痺。
 * 但**還在持續失敗**的情況下，每一輪都會寫新的一筆，所以它會一直亮著——那正是要的效果。
 */
function latestTickFailure(ledger: ConsoleDeps['ledger'], now: number): { at: number; detail: string } | null {
  const e = ledger.latestEvent('system', null, TICK_FAILED_EVENT);
  if (!e || now - e.createdAt > 60 * 60_000) return null;
  return { at: e.createdAt, detail: e.detail ?? '（沒有細節）' };
}


/**
 * 擋下跨站請求（回擋下的理由；同站回 undefined）。
 *
 * ── 為什麼只綁 loopback 不夠 ──
 *
 * 「能連到它的就是坐在這台機器前面的人」對**瀏覽器**不成立。
 * 使用者瀏覽任何一個惡意網頁，那個網頁就能對 127.0.0.1:8787 發請求——
 * 而這個介面可以改 MCP token、核准合併、**停用專案（會連 worktree 與分支一起清掉）**。
 *
 * 實測（改這段之前）：
 *   curl -X PUT http://127.0.0.1:8901/api/projects \
 *        -H 'Content-Type: text/plain' -H 'Origin: https://evil.example' -d '{...}'
 *   → {"ok":true,"project":{"id":"pwned",...}}
 *
 * `text/plain` 是 CORS 的「簡單」型別，**不觸發 preflight**，所以瀏覽器會直接送出去。
 *
 * 兩道一起用：
 *  1. Origin 標頭存在且不是自己 → 擋。（跨站請求一定帶 Origin）
 *  2. 有 body 的方法要求 `application/json` → 強制觸發 preflight，
 *     而我們不回 CORS 標頭，瀏覽器就過不了那一關。
 *     這一條也擋掉「沒有 Origin 的表單送出」那種老派攻擊。
 */
export function crossSiteReason(
  req: { method?: string | undefined; headers: Record<string, string | string[] | undefined> },
  port: number,
): string | undefined {
  const origin = header(req.headers, 'origin');
  if (origin) {
    const ok = LOOPBACK_ORIGINS.some((h) => origin === `http://${h}:${port}` || origin === `https://${h}:${port}`);
    if (!ok) return `拒絕跨站請求（Origin: ${origin}）。控制台只接受從本機自己開啟的頁面送出的請求。`;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return undefined;

  const ct = (header(req.headers, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (ct !== 'application/json') {
    return `這個請求必須用 content-type: application/json（收到 ${ct || '（無）'}）。`
      + 'text/plain 不會觸發瀏覽器的預檢，等於讓任何網頁都能對本機控制台送出寫入請求。';
  }
  return undefined;
}

const LOOPBACK_ORIGINS = ['127.0.0.1', 'localhost', '[::1]'];

function header(h: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}
