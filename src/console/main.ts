/**
 * 獨立執行的控制台（`npm run console`）。
 *
 * daemon 沒在跑也能用：設定寫進同一個 SQLite，daemon 下一輪 tick 會自己套用
 * （見 Orchestrator 的 beforeTick）。此時沒有裁決路徑，介面會標示為唯讀。
 */
import { pathToFileURL } from 'node:url';

import { loadEnv } from '../config/env.js';
import { loadBootstrap } from '../config/bootstrap.js';
import { ConfigStore } from '../config/store.js';
import { migrateYamlIfPresent } from '../config/migrate.js';
import { promoteSecrets } from '../config/promote-secrets.js';
import { Ledger } from '../store/ledger.js';
import { createLogger } from '../observability/logger.js';
import { ConsoleServer } from './server.js';
import { projectPurgerOf } from '../core/project-purge.js';
import { worktreeBaseOf } from '../main.js';

export async function main(): Promise<void> {
  loadEnv();
  const log = createLogger();
  const boot = loadBootstrap();
  const store = new ConfigStore(boot.ledgerPath);
  migrateYamlIfPresent(store, log);
  promoteSecrets(store, log); // ${VAR} 參照寫死進 DB（見 promote-secrets.ts）
  const ledger = new Ledger(boot.ledgerPath, log);
  ledger.init();

  const port = boot.consolePort;
  const server = new ConsoleServer({
    store, ledger, log, port,
    // 停用＝清乾淨。跟 daemon 內建的控制台用同一個，從哪一邊按結果都一樣。
    purgeProject: projectPurgerOf({ store, ledger, worktreeBase: worktreeBaseOf(boot.dataRoot), log }),
  });
  const { url } = await server.start();
  console.log(`\n  控制台：${url}\n`);

  const stop = async (): Promise<void> => {
    await server.stop();
    ledger.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
