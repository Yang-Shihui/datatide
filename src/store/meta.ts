import Database from "better-sqlite3";
import type { DatasetKind, FileDatasetConfig, PostgresDatasetConfig } from "../engine/engine.ts";

export interface DatasetRow {
  id: number;
  name: string;
  kind: DatasetKind;
  config: FileDatasetConfig | PostgresDatasetConfig;
  description: string;
  created_at: string;
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: "admin" | "analyst" | "viewer";
  created_at: string;
}

/**
 * Application metadata (users, dataset registry, chat sessions, report
 * configs) in a single SQLite file. Analytics data itself lives in DuckDB /
 * the attached postgres — this store never holds business rows.
 */
export class MetaStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin','analyst','viewer')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS datasets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('file','postgres')),
        config_json TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS dataset_access (
        dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (dataset_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '新对话',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content TEXT NOT NULL,
        extras_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS report_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        cron TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS report_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_id INTEGER NOT NULL REFERENCES report_configs(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','error')),
        output_path TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
    `);
  }

  // ---- datasets ----

  createDataset(name: string, kind: DatasetKind, config: FileDatasetConfig | PostgresDatasetConfig, description: string): DatasetRow {
    const info = this.db
      .prepare("INSERT INTO datasets (name, kind, config_json, description) VALUES (?, ?, ?, ?)")
      .run(name, kind, JSON.stringify(config), description);
    return this.getDataset(name)!;
  }

  getDataset(name: string): DatasetRow | undefined {
    const row = this.db.prepare("SELECT * FROM datasets WHERE name = ?").get(name) as Record<string, unknown> | undefined;
    return row ? this.toDataset(row) : undefined;
  }

  listDatasets(): DatasetRow[] {
    return (this.db.prepare("SELECT * FROM datasets ORDER BY id").all() as Record<string, unknown>[]).map((r) => this.toDataset(r));
  }

  deleteDataset(name: string): void {
    this.db.prepare("DELETE FROM datasets WHERE name = ?").run(name);
  }

  private toDataset(row: Record<string, unknown>): DatasetRow {
    return {
      id: row.id as number,
      name: row.name as string,
      kind: row.kind as DatasetKind,
      config: JSON.parse(row.config_json as string),
      description: row.description as string,
      created_at: row.created_at as string,
    };
  }

  close(): void {
    this.db.close();
  }
}
