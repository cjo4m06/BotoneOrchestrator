import { ConfigStore } from './store.js';
import type { Logger } from '../observability/logger.js';

/**
 * 把設定裡殘留的 `${VAR}` 參照換成實際值，讓資料庫真的成為唯一事實源。
 *
 * 為什麼需要這一步：yaml→DB 遷移時我保留了 `${VAR}` 字面值（理由是「不要把密鑰
 * 複製到使用者沒要求的地方」）。結果是**值其實還住在 .env**，於是：
 *   1. 說好的「設定都在資料庫」是假的；
 *   2. 更糟的是 `.env` 只在行程啟動時讀一次 —— 改 `.env` 必須重啟才生效，
 *      而熱重載的整個重點就是不必重啟。
 *
 * 所以只要環境變數當下解析得出值，就把它寫死進 DB。**解析不出來的維持原樣**：
 * 用空字串蓋掉一個 token，症狀會是「daemon 起來了但每次都 401」，比留著參照難查得多。
 *
 * `.env` 不動。它變成備援而不是事實源，想回頭也還在。
 */

const SECRET_PATHS = [
  ['slack', 'botToken'],
  ['slack', 'appToken'],
  ['github', 'token'],
] as const;

export interface PromotionResult {
  settings: string[];
  projects: string[];
  /** 解析不出值、因此維持 `${VAR}` 的欄位（需要人處理）。 */
  unresolved: string[];
}

const REF = /^\$\{([A-Z0-9_]+)\}$/;

/** 這個值是不是純粹的 `${VAR}` 參照？（混在字串中間的不動——那多半是刻意組出來的） */
export function envRef(v: unknown): string | undefined {
  return typeof v === 'string' ? (REF.exec(v.trim())?.[1] ?? undefined) : undefined;
}

function get(obj: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function set(obj: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cur = obj;
  for (const k of path.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

export function promoteSecrets(
  store: ConfigStore,
  log: Logger,
  env: NodeJS.ProcessEnv = process.env,
): PromotionResult {
  const out: PromotionResult = { settings: [], projects: [], unresolved: [] };

  // 設定
  const raw = structuredClone(store.rawSettings()) as Record<string, unknown>;
  let changed = false;
  for (const path of SECRET_PATHS) {
    const name = envRef(get(raw, path));
    if (!name) continue;
    const value = env[name];
    if (!value) {
      out.unresolved.push(`${path.join('.')} = \${${name}}`);
      continue;
    }
    set(raw, path, value);
    out.settings.push(path.join('.'));
    changed = true;
  }
  if (changed) store.saveSettings(raw);

  // 專案：目前只有 mcp.token 是密鑰
  for (const p of store.allProjects()) {
    const rawP = structuredClone(store.rawProject(p.config.id)) as Record<string, unknown> | undefined;
    if (!rawP) continue;
    const name = envRef(get(rawP, ['mcp', 'token']));
    if (!name) continue;
    const value = env[name];
    if (!value) {
      out.unresolved.push(`${p.config.id}.mcp.token = \${${name}}`);
      continue;
    }
    set(rawP, ['mcp', 'token'], value);
    store.upsertProject(rawP, { enabled: p.enabled });
    out.projects.push(p.config.id);
  }

  if (out.settings.length || out.projects.length) {
    log.info(
      { settings: out.settings, projects: out.projects },
      '已把 ${VAR} 參照的密鑰寫進資料庫（.env 不再是必要的；之後改設定不必重啟）',
    );
  }
  if (out.unresolved.length) {
    log.warn({ fields: out.unresolved }, '這些欄位的環境變數目前沒有值，維持 ${VAR} 參照（請在控制台補上實際值）');
  }
  return out;
}
