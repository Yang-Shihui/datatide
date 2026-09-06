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
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        username TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        username TEXT NOT NULL,
        session_id INTEGER,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0
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
    this.db
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

  // ---- users & access ----

  createUser(username: string, passwordHash: string, role: "admin" | "analyst" | "viewer"): UserRow {
    this.db
      .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)")
      .run(username, passwordHash, role);
    return this.getUser(username)!;
  }

  addMessage(sessionId: number, role: "user" | "assistant", content: string, extrasJson?: string): number {
    const info = this.db
      .prepare("INSERT INTO chat_messages (session_id, role, content, extras_json) VALUES (?, ?, ?, ?)")
      .run(sessionId, role, content, extrasJson);
    return Number(info.lastInsertRowid);
  }

  getUser(username: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
  }

  getUserById(id: number): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  }

  listUsers(): UserRow[] {
    return this.db.prepare("SELECT * FROM users ORDER BY id").all() as UserRow[];
  }

  /** Dataset names a user may query. Admins see everything. */
  datasetsForUser(user: UserRow): string[] {
    if (user.role === "admin") return this.listDatasets().map((d) => d.name);
    const rows = this.db
      .prepare(
        "SELECT d.name FROM dataset_access a JOIN datasets d ON d.id = a.dataset_id WHERE a.user_id = ? ORDER BY d.name",
      )
      .all(user.id) as { name: string }[];
    return rows.map((r) => r.name);
  }

  grantDataset(username: string, datasetName: string): void {
    const user = this.getUser(username);
    const ds = this.getDataset(datasetName);
    if (!user || !ds) throw new Error("用户或数据集不存在");
    this.db
      .prepare("INSERT OR IGNORE INTO dataset_access (dataset_id, user_id) VALUES (?, ?)")
      .run(ds.id, user.id);
  }

  revokeDataset(username: string, datasetName: string): void {
    const user = this.getUser(username);
    const ds = this.getDataset(datasetName);
    if (!user || !ds) throw new Error("用户或数据集不存在");
    this.db.prepare("DELETE FROM dataset_access WHERE dataset_id = ? AND user_id = ?").run(ds.id, user.id);
  }

  // ---- auth sessions ----

  createAuthSession(tokenHash: string, userId: number, expiresAtISO: string): void {
    this.db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash, userId, expiresAtISO);
  }

  authSessionUser(tokenHash: string): UserRow | undefined {
    const row = this.db
      .prepare(
        "SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
      )
      .get(tokenHash, new Date().toISOString()) as UserRow | undefined;
    return row;
  }

  deleteAuthSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
  }

  // ---- chat sessions ----

  createChatSession(userId: number, title: string): number {
    const info = this.db.prepare("INSERT INTO chat_sessions (user_id, title) VALUES (?, ?)").run(userId, title);
    return Number(info.lastInsertRowid);
  }

  listChatSessions(userId: number): { id: number; title: string; updated_at: string }[] {
    return this.db
      .prepare("SELECT id, title, updated_at FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId) as { id: number; title: string; updated_at: string }[];
  }

  touchChatSession(id: number, title?: string): void {
    if (title) this.db.prepare("UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), id);
    else this.db.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  chatSessionOwner(id: number): number | undefined {
    const row = this.db.prepare("SELECT user_id FROM chat_sessions WHERE id = ?").get(id) as { user_id: number } | undefined;
    return row?.user_id;
  }

  setMessageExtras(messageId: number, extrasJson: string): void {
    this.db.prepare("UPDATE chat_messages SET extras_json = ? WHERE id = ?").run(extrasJson, messageId);
  }

  getMessage(messageId: number): { id: number; session_id: number; role: string; content: string; extras_json: string | null } | undefined {
    return this.db
      .prepare("SELECT id, session_id, role, content, extras_json FROM chat_messages WHERE id = ?")
      .get(messageId) as { id: number; session_id: number; role: string; content: string; extras_json: string | null } | undefined;
  }

  /** 删除 sessionId 下 id >= messageId 的消息（编辑重发的回退语义） */
  truncateMessagesFrom(sessionId: number, messageId: number): number {
    const info = this.db
      .prepare("DELETE FROM chat_messages WHERE session_id = ? AND id >= ?")
      .run(sessionId, messageId);
    return Number(info.changes);
  }

  listMessages(sessionId: number): { id: number; role: string; content: string; extras_json: string | null; created_at: string }[] {
    return this.db
      .prepare("SELECT id, role, content, extras_json, created_at FROM chat_messages WHERE session_id = ? ORDER BY id")
      .all(sessionId) as { id: number; role: string; content: string; extras_json: string | null; created_at: string }[];
  }

  renameChatSession(id: number, title: string): void {
    this.db
      .prepare("UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, new Date().toISOString(), id);
  }

  deleteChatSession(id: number): void {
    this.db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id); // messages 级联删除
  }

  // ---- 审计日志 ----

  audit(username: string, action: string, detail: Record<string, unknown> = {}): void {
    this.db
      .prepare("INSERT INTO audit_log (username, action, detail) VALUES (?, ?, ?)")
      .run(username, action, JSON.stringify(detail));
  }

  listAudit(limit = 200): { id: number; ts: string; username: string; action: string; detail: string }[] {
    return this.db
      .prepare("SELECT id, ts, username, action, detail FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(limit) as { id: number; ts: string; username: string; action: string; detail: string }[];
  }

  // ---- token 用量 ----

  recordUsage(username: string, sessionId: number | null, inputTokens: number, outputTokens: number, totalTokens: number): void {
    this.db
      .prepare("INSERT INTO usage_events (username, session_id, input_tokens, output_tokens, total_tokens) VALUES (?, ?, ?, ?, ?)")
      .run(username, sessionId, inputTokens, outputTokens, totalTokens);
  }

  usageStats(): {
    totals: { input: number; output: number; total: number; turns: number };
    byUser: { username: string; input: number; output: number; total: number; turns: number }[];
    byDay: { day: string; total: number }[];
  } {
    const totals = (
      this.db
        .prepare("SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(total_tokens),0) t, COUNT(*) n FROM usage_events")
        .get() as { i: number; o: number; t: number; n: number }
    );
    const byUser = this.db
      .prepare(
        "SELECT username, COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output, COALESCE(SUM(total_tokens),0) total, COUNT(*) turns FROM usage_events GROUP BY username ORDER BY total DESC",
      )
      .all() as { username: string; input: number; output: number; total: number; turns: number }[];
    const byDay = this.db
      .prepare(
        "SELECT substr(ts,1,10) day, COALESCE(SUM(total_tokens),0) total FROM usage_events GROUP BY substr(ts,1,10) ORDER BY day DESC LIMIT 30",
      )
      .all() as { day: string; total: number }[];
    return { totals: { input: totals.i, output: totals.o, total: totals.t, turns: totals.n }, byUser, byDay };
  }

  // ---- reports ----

  createReportConfig(userId: number, datasetName: string, title: string, prompt: string, cron: string): number {
    const ds = this.getDataset(datasetName);
    if (!ds) throw new Error("数据集不存在");
    const info = this.db
      .prepare("INSERT INTO report_configs (user_id, dataset_id, title, prompt, cron) VALUES (?, ?, ?, ?, ?)")
      .run(userId, ds.id, title, prompt, cron);
    return Number(info.lastInsertRowid);
  }

  listReportConfigs(userId?: number) {
    const sql = `
      SELECT r.id, r.title, r.prompt, r.cron, r.enabled, r.last_run_at, d.name AS dataset_name, u.username
      FROM report_configs r JOIN datasets d ON d.id = r.dataset_id JOIN users u ON u.id = r.user_id
      ${userId ? "WHERE r.user_id = ?" : ""} ORDER BY r.id`;
    return (userId ? this.db.prepare(sql).all(userId) : this.db.prepare(sql).all()) as {
      id: number; title: string; prompt: string; cron: string; enabled: number;
      last_run_at: string | null; dataset_name: string; username: string;
    }[];
  }

  getReportConfig(id: number) {
    return this.listReportConfigs().find((r) => r.id === id);
  }

  setReportEnabled(id: number, enabled: boolean): void {
    this.db.prepare("UPDATE report_configs SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  }

  markReportRun(id: number, configId: number, status: "success" | "error", outputPath: string | null, error: string | null): void {
    this.db
      .prepare("UPDATE report_runs SET status = ?, finished_at = ?, output_path = ?, error = ? WHERE id = ?")
      .run(status, new Date().toISOString(), outputPath, error, id);
    if (status === "success") {
      this.db.prepare("UPDATE report_configs SET last_run_at = ? WHERE id = ?").run(new Date().toISOString(), configId);
    }
  }

  startReportRun(configId: number): number {
    const info = this.db.prepare("INSERT INTO report_runs (config_id) VALUES (?)").run(configId);
    return Number(info.lastInsertRowid);
  }

  listReportRuns(configId?: number) {
    if (configId) {
      return this.db.prepare("SELECT * FROM report_runs WHERE config_id = ? ORDER BY id DESC LIMIT 50").all(configId) as Record<string, unknown>[];
    }
    return this.db.prepare("SELECT * FROM report_runs ORDER BY id DESC LIMIT 100").all() as Record<string, unknown>[];
  }

  getReportRun(id: number) {
    return this.db.prepare("SELECT * FROM report_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }

  close(): void {
    this.db.close();
  }
}
