import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { OrchestratorSchema, ProjectSchema, type AppConfig, type OrchestratorConfig, type ProjectConfig } from './index.js';

/**
 * 設定的唯一事實源：SQLite。
 *
 * 取代原本的 config/*.yaml。理由不是「DB 比較潮」，是三件很具體的事：
 *   1. 控制台要能改設定。程式改寫 YAML 檔很脆弱（註解、順序、重複鍵、引號規則），
 *      而且改壞了整個 daemon 起不來。
 *   2. 改完要立刻生效。設定檔只在啟動時讀一次，寫完檔還得重啟——那控制台就只是
 *      一個很貴的文字編輯器。
 *   3. 密鑰要能精準更新。`UPDATE ... SET config = ?` 是原子的，改一行 .env 不是。
 *
 * 密鑰存在這裡的保護等級與 .env 相同：同一台機器、同一個使用者權限、`data/` 已在
 * .gitignore。原本「密鑰只放 .env」的理由是「設定檔會被複製貼出」——DB 不會進 git，
 * 那個理由對它不成立。
 *
 * zod schema 仍然是型別的唯一事實源：讀取時一律 parse，所以舊資料缺欄位會自動補上預設，
 * 壞資料會在讀取當下就炸掉（而不是在半小時後某個用到它的地方）。
 */

const SETTINGS_KEY = 'orchestrator';

/** 設定值裡的 `${VAR}` 會在讀取時以環境變數展開（缺值 → 空字串 → 視為未設）。 */
export function expandEnv<T>(v: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof v === 'string') {
    return v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k: string) => env[k] ?? '') as unknown as T;
  }
  if (Array.isArray(v)) return v.map((x) => expandEnv(x, env)) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = expandEnv(val, env);
    return out as unknown as T;
  }
  return v;
}

export interface StoredProject {
  enabled: boolean;
  config: ProjectConfig;
  createdAt: number;
  updatedAt: number;
}

export class ConfigStore {
  private db: Database.Database;

  constructor(ledgerPath: string) {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    this.db = new Database(ledgerPath);
    this.db.pragma('journal_mode = WAL');
    // 與 Ledger 共用同一個檔案：CREATE TABLE IF NOT EXISTS 讓誰先開都沒差
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, repo TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        config TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_projects_repo ON projects(repo);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ── 調度器設定 ──

  /** 讀設定。沒存過就回 schema 預設（不是錯誤：全新安裝本來就沒有）。 */
  settings(): OrchestratorConfig {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as
      | { value: string }
      | undefined;
    const raw = row ? (JSON.parse(row.value) as unknown) : {};
    return OrchestratorSchema.parse(expandEnv(raw));
  }

  /** 原始值（未展開 `${VAR}`）。控制台編輯時要顯示使用者當初填的東西，不是展開後的密鑰。 */
  rawSettings(): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as unknown) : {};
  }

  /**
   * 局部更新設定：與現有值淺層合併後驗證再寫入。
   * 先驗證再寫是必要的——寫進去才發現不合法的話，下次啟動會直接死在讀取，
   * 而且使用者手上沒有任何工具可以改回來（控制台自己也讀不了設定）。
   */
  saveSettings(patch: Record<string, unknown>): OrchestratorConfig {
    const current = this.rawSettings() as Record<string, unknown>;
    const merged = { ...current, ...patch };
    const validated = OrchestratorSchema.parse(expandEnv(merged)); // 驗證用展開後的值
    const ts = Date.now();
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @ts)
         ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @ts`,
      )
      .run({ key: SETTINGS_KEY, value: JSON.stringify(merged), ts });
    return validated;
  }

  hasSettings(): boolean {
    return this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(SETTINGS_KEY) !== undefined;
  }

  // ── 專案 ──

  /** 啟用中的專案（daemon 用）。 */
  projects(): ProjectConfig[] {
    return this.allProjects()
      .filter((p) => p.enabled)
      .map((p) => p.config);
  }

  /** 全部專案含停用的（控制台用）。 */
  allProjects(): StoredProject[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY id')
      .all() as { id: string; enabled: number; config: string; created_at: number; updated_at: number }[];
    return rows.map((r) => ({
      enabled: r.enabled === 1,
      config: ProjectSchema.parse(expandEnv(JSON.parse(r.config))),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** 單一專案的原始設定（未展開）。控制台編輯用。 */
  rawProject(id: string): unknown | undefined {
    const row = this.db.prepare('SELECT config FROM projects WHERE id = ?').get(id) as { config: string } | undefined;
    return row ? (JSON.parse(row.config) as unknown) : undefined;
  }

  /** 新增或整份覆寫一個專案。驗證失敗會丟出，呼叫端負責回報給使用者。 */
  upsertProject(input: unknown, opts: { enabled?: boolean } = {}): ProjectConfig {
    const validated = ProjectSchema.parse(expandEnv(input));
    const ts = Date.now();
    const existing = this.db.prepare('SELECT enabled FROM projects WHERE id = ?').get(validated.id) as
      | { enabled: number }
      | undefined;
    // 沒指定 enabled 時保留原值；**全新專案預設停用**。
    //
    // 建立完就直接開跑的話，使用者根本來不及檢查設定對不對——實跑撞到：
    // 專案一存好就撈進 13 個任務、建了 3 個群組開始做，而那時驗收指令都還沒填。
    // 先停用、看過設定再按「啟用」，是唯一能真正檢查的順序。
    const enabled = opts.enabled ?? (existing ? existing.enabled === 1 : false);
    this.db
      .prepare(
        `INSERT INTO projects (id, repo, enabled, config, created_at, updated_at)
         VALUES (@id, @repo, @enabled, @config, @ts, @ts)
         ON CONFLICT(id) DO UPDATE SET repo = @repo, enabled = @enabled, config = @config, updated_at = @ts`,
      )
      .run({
        id: validated.id,
        repo: validated.repo,
        enabled: enabled ? 1 : 0,
        config: JSON.stringify(input),
        ts,
      });
    return validated;
  }

  /** @returns 是否真的有這個專案。 */
  setProjectEnabled(id: string, enabled: boolean): boolean {
    const r = this.db
      .prepare('UPDATE projects SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id);
    return r.changes > 0;
  }

  /** @returns 是否真的刪掉了。 */
  removeProject(id: string): boolean {
    return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }

  /** daemon 要的完整設定。 */
  appConfig(): AppConfig {
    return { orchestrator: this.settings(), projects: this.projects() };
  }
}
