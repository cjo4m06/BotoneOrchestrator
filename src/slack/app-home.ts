import { HOME_ACTION_IDS, handleSlashCommand, homeViewBlocks, type HomeInput } from './home.js';
import type { InboundAction, InboundSlashCommand, SlackSocketLike, SlackViewsLike } from './gateway.js';
import type { Logger } from '../observability/logger.js';

/**
 * App Home 與 `/orch` slash command 的接線。
 *
 * 與 SlackGateway 分開的理由：Gateway 管的是「一任務一 thread」的對話流，
 * 它不認識 ledger、也不該認識。App Home 是**唯讀報表**，需要的是整個系統的快照，
 * 所以由外面（main.ts）注入一個 snapshot 函式。兩者共用同一個 socket，互不干擾。
 *
 * 全部路徑都是 best-effort：Slack 那邊沒開 Home Tab、沒註冊 slash command、
 * 或 API 暫時掛掉，都只留 warn。這是觀測介面，壞掉不該影響任何一個任務的執行。
 */

export interface AppHomeDeps {
  views: SlackViewsLike;
  socket: SlackSocketLike;
  log: Logger;
  /** 現在的系統快照（每次開啟／重新整理都重新取，不做快取）。 */
  snapshot: () => HomeInput;
  /** slash command 的純文字輸出（與 CLI 共用同一批 formatter）。 */
  render: { status(): string; cost(): string; pending(): string };
}

export class AppHome {
  constructor(private deps: AppHomeDeps) {}

  attach(): void {
    const { socket, log } = this.deps;

    if (socket.onHomeOpened) {
      socket.onHomeOpened((userId) => void this.publish(userId));
    } else {
      log.debug('socket 不支援 app_home_opened，App Home 停用');
    }

    if (socket.onSlashCommand) {
      socket.onSlashCommand(async (c) => this.slash(c));
    } else {
      log.debug('socket 不支援 slash command');
    }

    // 重新整理鈕與 Gateway 共用 onAction；彼此都會忽略不屬於自己的 action_id
    socket.onAction((a) => void this.action(a));

    log.info('Slack App Home 已接線（app_home_opened / 重新整理 / slash command）');
  }

  /** 對單一使用者發佈 Home 頁。 */
  async publish(userId: string): Promise<void> {
    if (!userId) return;
    try {
      const blocks = homeViewBlocks(this.deps.snapshot());
      await this.deps.views.publish({ user_id: userId, view: { type: 'home', blocks } });
      // 成功也要留痕：人機互動是稽核軌跡的一部分，而且沒有這行就無從判斷
      // 「面板一片空白」是沒收到事件、發佈失敗、還是真的沒東西可顯示。
      this.deps.log.info({ userId, blocks: blocks.length }, 'App Home 已發佈');
    } catch (e) {
      // 最常見的原因是 Slack app 沒開 Home Tab；講清楚，免得只看到一句 API 錯誤
      this.deps.log.warn(
        { userId, err: e instanceof Error ? e.message : String(e) },
        'App Home 發佈失敗（請確認 Slack app 已啟用 Home Tab）',
      );
    }
  }

  private async action(a: InboundAction): Promise<void> {
    if (a.actionId !== HOME_ACTION_IDS.refresh) return;
    if (!a.userId) return;
    await this.publish(a.userId);
  }

  private async slash(c: InboundSlashCommand): Promise<string> {
    try {
      const out = handleSlashCommand(c.text ?? '', this.deps.render).text;
      this.deps.log.info({ userId: c.userId, text: c.text, chars: out.length }, '收到 /orch 指令');
      return out;
    } catch (e) {
      this.deps.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'slash command 處理失敗');
      return '⚠️ 讀取狀態時發生錯誤，請看 daemon 的 log。';
    }
  }
}
