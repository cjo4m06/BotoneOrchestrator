import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { backupLedger, prune } from '../src/store/backup.js';
import { Ledger } from '../src/store/ledger.js';
import { createTmpDir, createSilentLogger, createRecordingLogger } from './helpers/index.js';

describe('ledger 備份', () => {
  let dir: ReturnType<typeof createTmpDir>;
  let dbPath: string;

  beforeEach(() => {
    dir = createTmpDir('botone-backup-');
    dbPath = join(dir.path, 'daemon.db');
    const l = new Ledger(dbPath, createSilentLogger());
    l.init();
    l.upsertDiscoveredTask({
      id: 'T-1', payloadHash: 'h', repo: 'a/b', category: 'dev',
      title: '任務', description: 'd', dependencies: [], docRefs: [],
    });
    l.close();
  });
  afterEach(() => dir.cleanup());

  it('備份出來的檔案是可讀的完整資料庫', () => {
    const out = backupLedger(dbPath, createSilentLogger());
    assert.ok(out && existsSync(out));

    const copy = new Database(out, { readonly: true });
    const row = copy.prepare('SELECT id, title FROM tasks WHERE id = ?').get('T-1') as { title: string };
    copy.close();
    assert.equal(row.title, '任務', '備份要含得到資料，不能只是個空殼');
  });

  /**
   * WAL 模式下直接 copy 主檔會拿到「少了還在 WAL 裡的交易」的版本——
   * 看起來成功，還原時才發現少東西。VACUUM INTO 才是一致快照。
   */
  it('剛寫入、還沒 checkpoint 的資料也要在備份裡', () => {
    const l = new Ledger(dbPath, createSilentLogger());
    l.init();
    l.upsertDiscoveredTask({
      id: 'T-2', payloadHash: 'h2', repo: 'a/b', category: 'dev',
      title: '很新的任務', description: 'd', dependencies: [], docRefs: [],
    });
    const out = backupLedger(dbPath, createSilentLogger())!;
    l.close();

    const copy = new Database(out, { readonly: true });
    const n = copy.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number };
    copy.close();
    assert.equal(n.c, 2, 'WAL 裡的那筆也要備份到');
  });

  it('全新安裝（還沒有 DB）→ 不做事、不報錯', () => {
    assert.equal(backupLedger(join(dir.path, 'nope.db'), createSilentLogger()), undefined);
  });

  it('只保留最新的 N 份', () => {
    for (let i = 0; i < 5; i += 1) {
      backupLedger(dbPath, createSilentLogger(), { keep: 3, stamp: `2026010${i}-000000` });
    }
    const left = readdirSync(join(dir.path, 'backups')).filter((f) => f.endsWith('.db'));
    assert.equal(left.length, 3);
    assert.ok(left.includes('ledger-20260104-000000.db'), '最新的要留著');
    assert.equal(left.includes('ledger-20260100-000000.db'), false, '最舊的要被清掉');
  });

  it('keep 至少為 1（設 0 不會把備份全刪光）', () => {
    backupLedger(dbPath, createSilentLogger(), { keep: 0, stamp: 'a' });
    assert.equal(readdirSync(join(dir.path, 'backups')).length, 1);
  });

  it('備份失敗只記 log，不擲錯（不能讓 daemon 起不來）', () => {
    const rec = createRecordingLogger();
    // 目標目錄改成一個「已存在的檔案」→ mkdir 會失敗
    const blocked = join(dir.path, 'blocked');
    writeFileSync(blocked, 'x');
    assert.doesNotThrow(() => backupLedger(dbPath, rec.logger, { dir: blocked }));
  });

  it('prune 對不存在的目錄回 0', () => {
    assert.equal(prune(join(dir.path, 'nope'), 3), 0);
  });

  it('prune 不動非備份檔', () => {
    const bdir = join(dir.path, 'b2');
    mkdirSync(bdir, { recursive: true });
    writeFileSync(join(bdir, 'ledger-1.db'), 'x');
    writeFileSync(join(bdir, '重要筆記.txt'), 'x');
    utimesSync(join(bdir, 'ledger-1.db'), new Date(1), new Date(1));
    prune(bdir, 0);
    assert.equal(existsSync(join(bdir, '重要筆記.txt')), true, '只該碰 ledger-*.db');
  });
});
