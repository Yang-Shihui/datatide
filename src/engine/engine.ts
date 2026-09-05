import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { guardSql } from "./guard.ts";

export type DatasetKind = "file" | "postgres";

export interface FileDatasetConfig {
  path: string; // absolute path to csv/parquet file
  format: "csv" | "parquet";
}

export interface PostgresDatasetConfig {
  dsn: string; // libpq-style connection string
}

export interface DatasetColumn {
  name: string;
  type: string;
  /** distinct sample values for low-cardinality text columns */
  sampleValues?: string[];
}

export interface DatasetSchema {
  rowCount: number;
  columns: DatasetColumn[];
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

export const DEFAULT_ROW_CAP = 200;

const POSTGRES_TABLE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Owns the single DuckDB instance backing all datasets. File datasets become
 * views; postgres datasets are ATTACHed read-only through the postgres
 * extension, so both kinds answer through one SQL dialect and one tool chain.
 */
export class Engine {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly dataDir: string,
  ) {}

  static async create(dataDir: string): Promise<Engine> {
    const instance = await DuckDBInstance.create(":memory:");
    return new Engine(instance, dataDir);
  }

  /** Register a file-backed dataset view. Config comes from the meta store. */
  async registerFile(name: string, config: FileDatasetConfig): Promise<void> {
    if (!POSTGRES_TABLE.test(name)) throw new Error(`数据集名不合法: ${name}`);
    const conn = await this.connect();
    try {
      const lit = config.path.replace(/'/g, "''");
      const src =
        config.format === "csv"
          ? `read_csv_auto('${lit}', header=true)`
          : `read_parquet('${lit}')`;
      await conn.run(`CREATE OR REPLACE VIEW ${name} AS SELECT * FROM ${src}`);
    } finally {
      await conn.closeSync();
    }
  }

  /** Attach a postgres database read-only under the dataset name. */
  async registerPostgres(name: string, config: PostgresDatasetConfig): Promise<void> {
    if (!POSTGRES_TABLE.test(name)) throw new Error(`数据集名不合法: ${name}`);
    const conn = await this.connect();
    try {
      // install/load are idempotent; may hit the network on first run
      await conn.run("INSTALL postgres");
      await conn.run("LOAD postgres");
      const lit = config.dsn.replace(/'/g, "''");
      await conn.run(`ATTACH '${lit}' AS ${name} (TYPE POSTGRES, READ_ONLY)`);
    } catch (err) {
      throw new Error(
        `Postgres 数据集 ${name} 连接失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await conn.closeSync();
    }
  }

  async dropDataset(name: string): Promise<void> {
    const conn = await this.connect();
    try {
      const attached = await conn.runAndReadAll(
        "SELECT database_name FROM duckdb_databases() WHERE database_name = ?",
        [name],
      );
      if (attached.getRowObjectsJson().length > 0) {
        await conn.run(`DETACH ${name}`);
      } else {
        await conn.run(`DROP VIEW IF EXISTS ${name}`);
      }
    } finally {
      await conn.closeSync();
    }
  }

  /** All queryable tables for a dataset, qualified where applicable. */
  async listTables(name: string, kind: DatasetKind): Promise<string[]> {
    if (kind === "file") return [name];
    const conn = await this.connect();
    try {
      const res = await conn.runAndReadAll(
        `SELECT table_schema, table_name FROM ${name}.information_schema.tables
         WHERE table_schema NOT IN ('information_schema', 'pg_catalog')`,
      );
      return res
        .getRowObjectsJson()
        .map((r) => `${name}.${r.table_schema}.${r.table_name}`)
        .filter((t) => /^(?:[a-z0-9_]+\.){2}[a-z0-9_]+$/.test(t));
    } finally {
      await conn.closeSync();
    }
  }

  /** Schema snapshot injected into the system prompt. */
  async describe(name: string, kind: DatasetKind): Promise<DatasetSchema> {
    const tables = await this.listTables(name, kind);
    if (tables.length === 0) return { rowCount: 0, columns: [] };
    const conn = await this.connect();
    try {
      let rowCount = 0;
      const columns: DatasetColumn[] = [];
      for (const table of tables) {
        const countRes = await conn.runAndReadAll(
          `SELECT count(*)::BIGINT AS n FROM ${table}`,
        );
        rowCount += Number(countRes.getRowObjectsJson()[0]?.n ?? 0);
        const desc = await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${table}`);
        for (const row of desc.getRowObjectsJson()) {
          const col: DatasetColumn = {
            name: String(row.column_name),
            type: String(row.column_type),
          };
          if (/^(VARCHAR|TEXT)/i.test(col.type)) {
            col.sampleValues = await this.sampleValues(conn, table, col.name);
          }
          columns.push(col);
        }
      }
      return { rowCount, columns };
    } finally {
      await conn.closeSync();
    }
  }

  private async sampleValues(
    conn: DuckDBConnection,
    table: string,
    column: string,
  ): Promise<string[] | undefined> {
    if (!POSTGRES_TABLE.test(column)) return undefined;
    const res = await conn.runAndReadAll(
      `SELECT DISTINCT CAST(${column} AS VARCHAR) AS v FROM ${table}
       WHERE ${column} IS NOT NULL LIMIT 13`,
    );
    const values = res.getRowObjectsJson().map((r) => String(r.v));
    // only expose values for enum-like columns
    if (values.length === 0 || values.length > 12) return undefined;
    return values;
  }

  /**
   * Run an agent-generated query: guard, apply the row cap, execute with a
   * wall-clock timeout, and normalize to JSON rows.
   */
  async query(
    sql: string,
    opts: { allowedViews: string[]; rowCap?: number; timeoutMs?: number },
  ): Promise<QueryResult> {
    const rowCap = opts.rowCap ?? DEFAULT_ROW_CAP;
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const guarded = guardSql(sql, { allowedViews: opts.allowedViews, rowCap });
    if (!guarded.ok) throw new GuardError(guarded.reason);

    const conn = await this.connect();
    const started = Date.now();
    try {
      const timer = setTimeout(() => conn.interrupt(), timeoutMs);
      let reader;
      try {
        reader = await conn.runAndReadAll(guarded.sql);
      } finally {
        clearTimeout(timer);
      }
      const rows = reader.getRowObjectsJson() as Record<string, unknown>[];
      return {
        rows: rows.slice(0, rowCap),
        rowCount: Math.min(rows.length, rowCap),
        truncated: rows.length > rowCap,
        elapsedMs: Date.now() - started,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Interrupted/.test(msg)) {
        throw new GuardError(`查询超时（>${timeoutMs}ms），已中断。请缩小扫描范围或增加过滤条件。`);
      }
      throw err;
    } finally {
      await conn.closeSync();
    }
  }

  private connect(): Promise<DuckDBConnection> {
    return this.instance.connect();
  }
}

export class GuardError extends Error {}
