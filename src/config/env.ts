import { config as loadDotenv } from 'dotenv';

export type AuthMethod = 'auth_token' | 'api_key' | 'none';

export interface AuthEnv {
  method: AuthMethod;
  baseUrl?: string;
}

/**
 * 載入 .env 到 process.env，並回報 Claude 認證方式。
 * dotenv 預設不覆蓋既有環境變數（export / launchd 設的值優先）。
 *
 * Agent SDK 的子行程在未設 options.env 時會繼承 process.env，因此
 * ANTHROPIC_AUTH_TOKEN（Bearer）與 ANTHROPIC_BASE_URL（自訂端點）在此載入後即生效。
 */
export function loadEnv(path?: string): AuthEnv {
  loadDotenv({ quiet: true, ...(path ? { path } : {}) });
  const baseUrl = process.env.ANTHROPIC_BASE_URL || undefined;
  if (process.env.ANTHROPIC_AUTH_TOKEN) return { method: 'auth_token', baseUrl };
  if (process.env.ANTHROPIC_API_KEY) return { method: 'api_key', baseUrl };
  return { method: 'none', baseUrl };
}
