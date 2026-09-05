import { Engine, type DatasetSchema } from "../engine/engine.ts";
import { MetaStore } from "../store/meta.ts";

export interface DatasetInfo {
  name: string;
  description: string;
  schema: DatasetSchema;
  /** queryable table names (qualified for postgres datasets) */
  tables: string[];
}

/**
 * Bridges the meta store (which datasets exist) and the DuckDB engine
 * (which objects are queryable in this process). Re-registers everything on
 * boot since the engine instance is in-memory.
 */
export class DatasetRegistry {
  constructor(
    private readonly engine: Engine,
    private readonly meta: MetaStore,
  ) {}

  async ensureRegistered(): Promise<void> {
    for (const ds of this.meta.listDatasets()) {
      if (ds.kind === "file") {
        await this.engine.registerFile(ds.name, ds.config as { path: string; format: "csv" | "parquet" });
      } else {
        await this.engine.registerPostgres(ds.name, ds.config as { dsn: string });
      }
    }
  }

  async describe(name: string): Promise<DatasetInfo> {
    const ds = this.meta.getDataset(name);
    if (!ds) throw new Error(`数据集 ${name} 未注册。`);
    const tables = await this.engine.listTables(name, ds.kind);
    const schema = await this.engine.describe(name, ds.kind);
    return { name, description: ds.description, schema, tables };
  }

  /** Prompt-facing snapshot: what the model sees before any tool call. */
  async snapshotText(names: string[]): Promise<string> {
    const blocks: string[] = [];
    for (const name of names) {
      let info: DatasetInfo;
      try {
        info = await this.describe(name);
      } catch (err) {
        blocks.push(`### 数据集 ${name}\n（加载失败: ${err instanceof Error ? err.message : String(err)}）`);
        continue;
      }
      const cols = info.schema.columns
        .map((c) => {
          const samples = c.sampleValues?.length ? `，取值如: ${c.sampleValues.slice(0, 8).join("、")}` : "";
          return `- ${c.name} (${c.type}${samples})`;
        })
        .join("\n");
      blocks.push(
        `### 数据集 ${info.name}\n${info.description || "（无描述）"}\n` +
          `可查询表: ${info.tables.join(", ")}\n行数: ${info.schema.rowCount}\n字段:\n${cols}`,
      );
    }
    return blocks.join("\n\n");
  }
}
