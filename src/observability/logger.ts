import pino from 'pino';

export function createLogger() {
  const isProd = process.env.NODE_ENV === 'production';
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    // 開發時用 pino-pretty 便於閱讀；正式（launchd）走純 JSON 進 log 檔
    transport: isProd
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } },
  });
}

export type Logger = ReturnType<typeof createLogger>;
