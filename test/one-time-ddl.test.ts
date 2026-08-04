import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { SCHEMA, ONE_TIME_DDL, APPLIED_DDL_KEY, applyOneTimeDdl } from '../src/store/schema.js';
import { createTmpLedger, createTmpDir, type TmpLedger, type TmpDir } from './helpers/index.js';

/**
 * 一次性 DDL（加欄位以外的結構變更）。
 *
 * ── 為什麼需要跟 COLUMN_MIGRATIONS 分家 ──
 *
 * 那張清單判斷「做過沒」的依據是**結果本身**（欄位存在＝做過了），天生冪等。
 * DROP TABLE 沒有這種性質：表被刪掉之後，SCHEMA 的 CREATE TABLE IF NOT EXISTS
 * 會在下次開機時把空表建回來——用「表在不在」當判準的話，這條遷移會每次開機都跑，
 * 而且每次都認為自己是第一次。所以要另外記一筆。
 */

describe('applyOneTimeDdl', () => {
  let dir: TmpDir;
  let db: Database.Database;
  beforeEach(() => {
    dir?.cleanup();
    dir = createTmpDir('one-time-ddl-');
    db = new Database(join(dir.path, 'x.db'));
    db.exec(SCHEMA);
  });
  after(() => { try { db.close(); } catch { /* 已關 */ } dir?.cleanup(); });

  it('第一次跑：DDL 執行，並在 settings 記下 id', () => {
    db.exec('CREATE TABLE IF NOT EXISTS task_iterations (id INTEGER PRIMARY KEY)');

    const changed = applyOneTimeDdl(db);

    assert.deepEqual(changed, ['drop-task-iterations-v1']);
    assert.equal(tableExists(db, 'task_iterations'), false);
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(APPLIED_DDL_KEY) as { value: string };
    assert.deepEqual(JSON.parse(row.value), ['drop-task-iterations-v1']);
  });

  it('第二次跑：不再執行（表被舊版 build 建回來也不會再刪一次）', () => {
    db.exec('CREATE TABLE IF NOT EXISTS task_iterations (id INTEGER PRIMARY KEY)');
    applyOneTimeDdl(db);
    // 模擬「舊版 build 開了一次機」：SCHEMA 把空表建回來
    db.exec('CREATE TABLE IF NOT EXISTS task_iterations (id INTEGER PRIMARY KEY)');

    const second = applyOneTimeDdl(db);

    assert.deepEqual(second, [], '已經跑過的不可以再跑一次');
    assert.equal(
      tableExists(db, 'task_iterations'),
      true,
      '這是刻意的：一次性就是一次性。表留著沒有寫入者也沒有讀取者，'
      + '而「每次開機都重跑遷移」對未來任何有副作用的 DDL 就是災難',
    );
  });

  it('全新的 DB（表根本沒存在過）→ 記成跑過，但**不回報動到東西**', () => {
    assert.equal(tableExists(db, 'task_iterations'), false, '前置：全新 DB 沒有這張表');

    const changed = applyOneTimeDdl(db);

    assert.deepEqual(
      changed,
      [],
      '每建一個新 DB（每個測試、每個新 profile）都喊一次「執行了不可逆的結構變更」，'
      + '狼來了喊多了，真正該看的那一次就沒人會看',
    );
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(APPLIED_DDL_KEY) as { value: string };
    assert.deepEqual(JSON.parse(row.value), ['drop-task-iterations-v1'], '但還是要記成跑過');
  });

  it('紀錄壞掉（不是合法 JSON）→ 當成沒跑過重跑，不是靜默跳過', () => {
    db.exec('CREATE TABLE IF NOT EXISTS task_iterations (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(APPLIED_DDL_KEY, '{壞掉的', Date.now());

    const changed = applyOneTimeDdl(db);

    assert.deepEqual(
      changed,
      ['drop-task-iterations-v1'],
      '這裡的 DDL 一律要求冪等（DROP IF EXISTS），重跑的代價遠小於「以為跑過了其實沒跑」',
    );
  });

  it('每一條 DDL 都必須是冪等的寫法（重跑不會炸）', () => {
    for (const d of ONE_TIME_DDL) {
      assert.match(
        d.sql,
        /IF EXISTS|IF NOT EXISTS/,
        `${d.id} 不是冪等的寫法——紀錄壞掉時會重跑，非冪等的 DDL 會在那一刻讓 daemon 開不了機`,
      );
      assert.ok(d.why.trim(), `${d.id} 沒有寫理由（事後看到一條 DROP 卻不知道為什麼）`);
      assert.ok(d.affects.trim(), `${d.id} 沒有指明動到哪張表，無法分辨「真的刪了」與「本來就沒有」`);
    }
  });
});

describe('Ledger.init 與一次性 DDL 的順序', () => {
  let tmp: TmpLedger;
  after(() => tmp?.cleanup());

  it('SCHEMA 之後才跑 DDL——順序反了等於沒刪', () => {
    tmp = createTmpLedger(); // init() 已在裡面跑過
    const db = new Database(tmp.dbPath, { readonly: true });
    try {
      assert.equal(
        tableExists(db, 'task_iterations'),
        false,
        '先 DROP 再 CREATE TABLE IF NOT EXISTS 的話，表會被立刻建回來',
      );
      // SCHEMA 裡也不可以留 CREATE：留著的話下次開機又會長回來
      assert.doesNotMatch(SCHEMA, /CREATE TABLE IF NOT EXISTS task_iterations/);
    } finally {
      db.close();
    }
  });
});

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined;
}
