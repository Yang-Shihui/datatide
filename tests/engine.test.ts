import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine, GuardError } from "../src/engine/engine.ts";
import { MetaStore } from "../src/store/meta.ts";

const CSV = `date,region,category,amount
2026-01-01,华东,食品,100
2026-01-02,华东,食品,150
2026-01-03,华北,食品,80
2026-01-04,华东,日化,60
2026-01-05,华南,日化,40
`;

let engine: Engine;
let meta: MetaStore;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "bi-agent-test-"));
  writeFileSync(join(dir, "sales.csv"), CSV);
  engine = await Engine.create(":memory:");
  meta = new MetaStore(":memory:");
  meta.createDataset("sales", "file", { path: join(dir, "sales.csv"), format: "csv" }, "测试数据集");
  await engine.registerFile("sales", { path: join(dir, "sales.csv"), format: "csv" });
});

afterEach(() => {
  // nothing shared across tests needs cleanup yet
});

describe("Engine — 文件数据集", () => {
  it("describe 输出行数、字段与低基数文本列的枚举值", async () => {
    const s = await engine.describe("sales", "file");
    expect(s.rowCount).toBe(5);
    const region = s.columns.find((c) => c.name === "region");
    expect(region?.sampleValues).toEqual(expect.arrayContaining(["华东", "华北", "华南"]));
    const amount = s.columns.find((c) => c.name === "amount");
    expect(amount?.sampleValues).toBeUndefined();
  });

  it("guard 后执行查询并返回 JSON 行", async () => {
    const r = await engine.query("SELECT region, sum(amount) AS total FROM sales GROUP BY region ORDER BY total DESC", {
      allowedViews: ["sales"],
    });
    expect(r.rows[0]).toMatchObject({ region: "华东" });
    expect(Number(r.rows[0]!.total)).toBe(310);
    expect(r.truncated).toBe(false);
  });

  it("行数上限触发截断标记", async () => {
    const r = await engine.query("SELECT * FROM sales", { allowedViews: ["sales"], rowCap: 3 });
    expect(r.rowCount).toBe(3);
    expect(r.truncated).toBe(true);
  });

  it("守卫拒绝的语句抛 GuardError 且不落库", async () => {
    await expect(
      engine.query("SELECT * FROM read_csv_auto('/etc/passwd')", { allowedViews: ["sales"] }),
    ).rejects.toBeInstanceOf(GuardError);
    await expect(engine.query("DROP TABLE sales", { allowedViews: ["sales"] })).rejects.toBeInstanceOf(GuardError);
  });

  it("查询引用未授权对象被拒", async () => {
    await expect(engine.query("SELECT * FROM other_table", { allowedViews: ["sales"] })).rejects.toBeInstanceOf(
      GuardError,
    );
  });

  it("错误 SQL 原样报错（自纠回路依赖错误信息）", async () => {
    await expect(engine.query("SELECT nope FROM sales", { allowedViews: ["sales"] })).rejects.toThrow(/nope|column/i);
  });
});

describe("MetaStore — 数据集注册表", () => {
  it("创建/读取/删除数据集配置", () => {
    const d = meta.getDataset("sales")!;
    expect(d.kind).toBe("file");
    expect((d.config as { path: string }).path).toContain("sales.csv");
    meta.createDataset("pgsales", "postgres", { dsn: "host=127.0.0.1 dbname=x" }, "");
    expect(meta.listDatasets()).toHaveLength(2);
    meta.deleteDataset("pgsales");
    expect(meta.getDataset("pgsales")).toBeUndefined();
  });
});

// Postgres 数据源测试：需要真实可达的 PG（CI 用 services 提供）
const PG_DSN = process.env.BI_AGENT_TEST_PG_DSN;
describe.skipIf(!PG_DSN)("Engine — Postgres 数据集", () => {
  it("ATTACH 只读挂载并能查询", async () => {
    const e = await Engine.create(":memory:");
    await e.registerPostgres("pgtest", { dsn: PG_DSN! });
    const tables = await e.listTables("pgtest", "postgres");
    expect(tables.length).toBeGreaterThan(0);
    const r = await e.query(`SELECT count(*) AS n FROM ${tables[0]}`, {
      allowedViews: tables,
    });
    expect(Number(r.rows[0]!.n)).toBeGreaterThanOrEqual(0);
    // 只读：写入被拒绝
    await expect(
      engine.query(`CREATE TABLE pgtest.public.hack(a INT)`, { allowedViews: tables }),
    ).rejects.toBeInstanceOf(GuardError);
  });
});
