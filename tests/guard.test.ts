import { describe, expect, it } from "vitest";
import { extractTableRefs, guardSql, stripComments } from "../src/engine/guard.ts";

const opts = (views = ["sales", "pg.public.orders"], rowCap = 200) => ({ allowedViews: views, rowCap });

describe("guardSql — 允许的查询", () => {
  it("放行普通 SELECT 并套上外层 LIMIT", () => {
    const r = guardSql("SELECT region, amount FROM sales", opts());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toContain("LIMIT 201");
  });

  it("放行 WITH (CTE) 查询，CTE 别名不要求在白名单内", () => {
    const r = guardSql(
      "WITH top AS (SELECT region FROM sales) SELECT * FROM top JOIN sales USING (region)",
      opts(),
    );
    expect(r.ok).toBe(true);
  });

  it("放行子查询", () => {
    const r = guardSql("SELECT * FROM (SELECT region FROM sales) t", opts());
    expect(r.ok).toBe(true);
  });

  it("限定名命中白名单（postgres 数据集）", () => {
    const r = guardSql("SELECT * FROM pg.public.orders", opts());
    expect(r.ok).toBe(true);
  });

  it("无限定名按后缀匹配限定视图", () => {
    const r = guardSql("SELECT * FROM orders", opts());
    expect(r.ok).toBe(true);
  });

  it("字符串字面量里出现关键字不误拦", () => {
    const r = guardSql("SELECT * FROM sales WHERE note = 'please DROP TABLE ok' OR note = 'ATTACH me'", opts());
    expect(r.ok).toBe(true);
  });

  it("字符串字面量里出现文件函数不误拦", () => {
    const r = guardSql("SELECT * FROM sales WHERE note = 'read_csv() is fun'", opts());
    expect(r.ok).toBe(true);
  });

  it("注释被剥掉后语句仍然合法", () => {
    const r = guardSql("SELECT region FROM sales -- ORDER BY amount\n", opts());
    expect(r.ok).toBe(true);
  });

  it("字符串里的分号不会被当成多语句", () => {
    const r = guardSql("SELECT * FROM sales WHERE note = 'a;b'", opts());
    expect(r.ok).toBe(true);
  });

  it("函数参数里的 FROM 不算表引用（EXTRACT/SUBSTRING/TRIM）", () => {
    expect(guardSql("SELECT EXTRACT(QUARTER FROM order_date) AS q FROM sales", opts()).ok).toBe(true);
    expect(guardSql("SELECT SUBSTRING(region FROM 1 FOR 2) FROM sales", opts()).ok).toBe(true);
    expect(guardSql("SELECT TRIM(LEADING 'x' FROM region) FROM sales", opts()).ok).toBe(true);
  });
});

describe("guardSql — 函数参数与子查询中的表引用", () => {
  const expectReject = (sql: string) => {
    const r = guardSql(sql, opts());
    expect(r.ok, `${sql} 应被拒绝`).toBe(false);
  };

  it("函数参数里藏子查询时，内部的表引用仍受白名单约束", () => {
    expectReject("SELECT COALESCE((SELECT max(amount) FROM secret_table), 0) FROM sales");
  });

  it("IN (子查询) 内的表引用受白名单约束", () => {
    expectReject("SELECT * FROM sales WHERE region IN (SELECT name FROM secret_table)");
  });
});

describe("guardSql — 拒绝的查询", () => {
  const expectReject = (sql: string, views?: string[]) => {
    const r = guardSql(sql, opts(views));
    expect(r.ok, `${sql} 应被拒绝`).toBe(false);
  };

  it("拒绝空语句与非 SELECT 开头", () => {
    expectReject("");
    expectReject("EXPLAIN SELECT 1");
    expectReject("SHOW TABLES");
  });

  it("拒绝多语句", () => {
    expectReject("SELECT 1; SELECT 2");
    expectReject("SELECT 1; DROP TABLE x");
  });

  it("拒绝写操作与 DDL", () => {
    expectReject("INSERT INTO sales VALUES (1)");
    expectReject("UPDATE sales SET amount = 0");
    expectReject("DELETE FROM sales");
    expectReject("CREATE TABLE t(a INT)");
    expectReject("DROP TABLE sales");
    expectReject("ALTER TABLE sales RENAME TO x");
  });

  it("拒绝逃逸类语句", () => {
    expectReject("ATTACH 'x.db' AS evil");
    expectReject("PRAGMA enable_external_access=false");
    expectReject("SET threads=1");
    expectReject("COPY sales TO '/tmp/x.csv'");
    expectReject("INSTALL postgres");
    expectReject("LOAD postgres");
    expectReject("CALL duckdb()"); // CALL 属语句关键字
    expectReject("EXPORT DATABASE 'x'");
  });

  it("拒绝 SELECT ... INTO", () => {
    expectReject("SELECT * INTO new_t FROM sales");
  });

  it("拒绝直接读文件/外部库的表函数", () => {
    expectReject("SELECT * FROM read_csv_auto('/etc/passwd')");
    expectReject("SELECT read_text('/etc/passwd')");
    expectReject("SELECT * FROM parquet_scan('/data/secret.parquet')");
    expectReject("SELECT * FROM postgres_scan('dsn', 'public', 't')");
    expectReject("SELECT * FROM sqlite_scan('x.db', 't')");
  });

  it("拒绝白名单之外的数据对象", () => {
    expectReject("SELECT * FROM secret_table");
    expectReject("SELECT * FROM sales JOIN user_passwords ON 1=1");
  });

  it("块注释出现在语句中间不合法化语句", () => {
    const r = guardSql("SELECT 1 /* comment */ FROM sales", opts());
    expect(r.ok).toBe(true);
  });
});

describe("边界细节", () => {
  it("引号转义在字符串扫描下正确", () => {
    const r = guardSql("SELECT * FROM sales WHERE note = 'it''s a;b test'", opts());
    expect(r.ok).toBe(true);
  });

  it("带引号标识符里的关键字不算语句关键字", () => {
    const r = guardSql('SELECT "drop" FROM sales', opts());
    expect(r.ok).toBe(true);
  });

  it("stripComments 保留字符串内的 -- 和 /* */", () => {
    expect(stripComments(`SELECT 'a--b'`)).toBe(`SELECT 'a--b'`);
    expect(stripComments(`SELECT 'a/*b'`)).toBe(`SELECT 'a/*b'`);
    expect(stripComments("SELECT 1 -- x\nSELECT")).toBe("SELECT 1 \nSELECT");
  });
});

describe("extractTableRefs", () => {
  it("收集 FROM/JOIN 引用并跳过子查询", () => {
    const { refs, cteNames } = extractTableRefs(
      "WITH a AS (SELECT 1) SELECT * FROM a JOIN (SELECT 2) b ON true, sales s LEFT JOIN pg.public.orders o ON 1=1",
    );
    expect(cteNames.has("a")).toBe(true);
    expect(refs).toContain("sales");
    expect(refs).toContain("pg.public.orders");
    expect(refs).not.toContain("b");
  });
});
