import pino from 'pino';
import type { Logger } from '../../src/observability/logger.js';

export interface LogRecord {
  level: number;
  msg: string;
  [key: string]: unknown;
}

/** 靜音 Logger：測試注入用，不產生任何輸出（避免 node:test 報表被 log 淹沒）。 */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' }) as unknown as Logger;
}

export interface RecordingLogger {
  logger: Logger;
  records: LogRecord[];
  /** 取某等級以上的訊息文字，便於斷言「有沒有記到某件事」。 */
  messages(minLevel?: 'debug' | 'info' | 'warn' | 'error'): string[];
}

/**
 * 記錄式 Logger：一樣不輸出到 stdout，但把每筆 log 存進陣列供斷言。
 * 用於驗證「該警告時有警告」這類行為（比對 msg 或欄位）。
 */
export function createRecordingLogger(): RecordingLogger {
  const records: LogRecord[] = [];
  const stream = {
    write(line: string): void {
      records.push(JSON.parse(line) as LogRecord);
    },
  };
  const logger = pino({ level: 'debug', base: undefined, timestamp: false }, stream) as unknown as Logger;
  const levels: Record<string, number> = { debug: 20, info: 30, warn: 40, error: 50 };
  return {
    logger,
    records,
    messages(minLevel = 'debug') {
      const min = levels[minLevel] ?? 20;
      return records.filter((r) => r.level >= min).map((r) => r.msg);
    },
  };
}
