import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckRequester, CheckRunInput, WorkspaceKind } from '../store/ledger.js';
import type { Logger } from '../observability/logger.js';

/**
 * 關卡執行的記帳出口。
 *
 * ── 為什麼要有這一層 ──
 *
 * 先前每次跑完 build/test 就把輸出丟掉，只在 log 裡留一行綠或紅。於是
 * 「同一條分支 14:04:45 綠、14:13:51 紅」這種**只有橫跨時間才看得見**的事實，
 * 事後只能靠翻 stdout.log 一行一行對時間才發現——而那正是判斷「這個紅是不是這一群
 * 造成的」唯一有用的證據（實跑：PR #54 只新增 6 個檔，被一個完全無關的不穩定測試
 * 擋下，判成語意飄移、回灌三輪，16 個任務堵住）。
 *
 * ── 這一層刻意不做什麼 ──
 *
 * **不解讀。** 不判斷 exit code 代表什麼、不從輸出裡抽失敗測試名、不算簽章、
 * 不挑「看起來像失敗」的行。那些全是讀的人（agent 或人）的事——程式用正則猜
 * 換一個測試框架就會抓錯，而且沒有人會知道。
 */
export interface CheckRecorder {
  record(input: CheckRunInput): void;
}

/** 什麼都不做的記帳出口（測試與還沒接線的呼叫端用）。 */
export const NOOP_RECORDER: CheckRecorder = { record: () => {} };

/**
 * 存進 DB 的輸出上限。超過的部分落地成檔案，DB 只留頭尾。
 *
 * 為什麼要留**頭尾**而不是只留頭：測試輸出的慣例是失敗訊息在最後，只留頭等於
 * 保住一整片 `✓ passed` 而砍掉唯一有資訊的那一行。留頭是為了看得出「跑的是什麼」。
 */
export const MAX_INLINE_OUTPUT = 256 * 1024;
const HEAD_KEEP = 32 * 1024;
const TAIL_KEEP = 160 * 1024;

export interface SplitOutput {
  /** 存進 DB 的部分（可能是全文，也可能是頭尾＋一行說明）。 */
  inline: string;
  /** 需要落地的全文；不需要落地時是 undefined。 */
  spill?: string;
}

/**
 * 決定「DB 存什麼、檔案存什麼」。純函式，方便測試。
 *
 * 截斷的地方**一定要說**：中間省略了幾個字元寫在文字裡，讀的人才知道自己看到的
 * 是殘缺的，而不是以為那就是全部（無標記的截斷會讓下游把殘缺當完整）。
 */
export function splitOutput(output: string, maxInline = MAX_INLINE_OUTPUT): SplitOutput {
  if (output.length <= maxInline) return { inline: output };
  const head = output.slice(0, HEAD_KEEP);
  const tail = output.slice(-TAIL_KEEP);
  const omitted = output.length - head.length - tail.length;
  return {
    inline: `${head}\n\n…（中間省略 ${omitted} 個字元，全文見 output_path）…\n\n${tail}`,
    spill: output,
  };
}

export interface LedgerCheckSink {
  recordCheckRun(input: CheckRunInput): number;
}

export interface CheckRecorderOptions {
  ledger: LedgerCheckSink;
  log: Logger;
  /** 全文落地的根目錄（dataRoot 底下）。未給 → 不落地，只存頭尾。 */
  outputRoot?: string;
  maxInline?: number;
}

/**
 * 真正寫進 ledger 的記帳出口。
 *
 * **記帳失敗絕不往外冒。** 這是旁路：關卡本身的結果不該因為帳沒記成而改變
 * （磁碟滿了、DB 鎖住都可能發生）。留 warn 就好——但一定要留，
 * 靜默失敗會讓「這張表是空的」看起來像「這個關卡從來沒跑過」。
 */
export function createCheckRecorder(opts: CheckRecorderOptions): CheckRecorder {
  const max = opts.maxInline ?? MAX_INLINE_OUTPUT;
  return {
    record(input) {
      try {
        const { inline, spill } = splitOutput(input.output ?? '', max);
        let outputPath: string | undefined;
        if (spill !== undefined && opts.outputRoot) {
          mkdirSync(opts.outputRoot, { recursive: true });
          const name = `check-${input.startedAt ?? Date.now()}-${Math.abs(hash(input.command))}.log`;
          outputPath = join(opts.outputRoot, name);
          writeFileSync(outputPath, spill, 'utf8');
        }
        opts.ledger.recordCheckRun({
          ...input,
          output: inline,
          ...(outputPath ? { outputPath } : {}),
        });
      } catch (e) {
        opts.log.warn(
          { command: input.command, err: e instanceof Error ? e.message : String(e) },
          '關卡記帳失敗（不影響關卡結果）',
        );
      }
    },
  };
}

/** 檔名用的短雜湊（不需要密碼學強度，只要同一輪不同指令不要撞名）。 */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** 呼叫端在建 Verifier 時提供的上下文（哪個 repo、哪條分支、哪一種工作區、誰要求的）。 */
export interface CheckContext {
  repo: string;
  branch?: string;
  workspaceKind: WorkspaceKind;
  requestedBy: CheckRequester;
  headSha?: string;
  verifiedBaseSha?: string;
}
