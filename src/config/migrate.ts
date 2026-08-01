import { existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadRawConfig } from './index.js';
import type { ConfigStore } from './store.js';
import type { Logger } from '../observability/logger.js';

/**
 * 一次性把舊的 config/*.yaml 匯入 DB。
 *
 * 只在 DB **完全沒有設定**時執行（`hasSettings()` 為 false）。這個條件很重要：
 * 匯入之後使用者會在控制台改設定，若每次啟動都重匯，yaml 會把控制台的修改蓋回去——
 * 兩個事實源互相打架，而且是靜默打架（使用者只會看到「我改的東西又跑掉了」）。
 *
 * 匯完把檔案改名成 .imported，留著當備份但不會再被讀到。
 */
export function migrateYamlIfPresent(store: ConfigStore, log: Logger, baseDir = process.cwd()): boolean {
  if (store.hasSettings()) return false;

  const orchPath = resolve(baseDir, 'config/orchestrator.yaml');
  const projPath = resolve(baseDir, 'config/projects.yaml');
  if (!existsSync(orchPath) && !existsSync(projPath)) return false;

  // 讀原始值（不展開 ${VAR}）：見 loadRawConfig 的說明——展開會把密鑰複製進 DB，
  // 而且遷移當下若沒載入 .env，token 會靜靜變成空字串。
  const raw = loadRawConfig(baseDir);
  store.saveSettings(raw.orchestrator as Record<string, unknown>);
  const ids: string[] = [];
  for (const p of raw.projects) ids.push(store.upsertProject(p).id);
  log.info(
    { projects: ids },
    '已把 config/*.yaml 匯入資料庫；之後請用控制台修改設定（yaml 已改名為 .imported，不再讀取）',
  );

  for (const p of [orchPath, projPath]) {
    if (!existsSync(p)) continue;
    try {
      renameSync(p, `${p}.imported`);
    } catch (e) {
      // 改名失敗不影響匯入結果（hasSettings 之後為 true，不會重匯），只是備份檔沒留成
      log.warn({ path: p, err: e instanceof Error ? e.message : String(e) }, 'yaml 改名失敗（設定已匯入，可自行刪除）');
    }
  }
  return true;
}
