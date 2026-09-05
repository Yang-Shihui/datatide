import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";

let baseUrl: string;
let adminToken: string;
let analystToken: string;
let root: string;
let cleanup: () => void;

const CSV = `date,region,amount
2026-01-01,华东,100
2026-01-02,华北,80
`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "datatide-server-"));
  writeFileSync(join(root, "sales.csv"), CSV);
  const { app } = await createServer({
    dataDir: join(root, "data"),
    reportsDir: join(root, "reports"),
    staticDir: join(root, "static"), // deliberately nonexistent: SPA must 404 with hint
  });
  cleanup = await new Promise<() => void>((resolvePromise) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolvePromise(() => server.close());
    });
  });
});

afterAll(() => cleanup());

const post = async (path: string, body: unknown, token?: string) =>
  fetch(baseUrl + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const get = async (path: string, token?: string) =>
  fetch(baseUrl + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

describe("auth", () => {
  it("首个注册用户自动成为管理员", async () => {
    const res = await post("/auth/register", { username: "alice", password: "secret1" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("admin");
  });

  it("后续注册默认 analyst；重复用户名被拒", async () => {
    const res = await post("/auth/register", { username: "bob", password: "secret2" });
    expect(((await res.json()) as { role: string }).role).toBe("analyst");
    const dup = await post("/auth/register", { username: "bob", password: "secret3" });
    expect(dup.status).toBe(400);
  });

  it("登录失败 400，成功返回 token", async () => {
    expect((await post("/auth/login", { username: "alice", password: "wrong" })).status).toBe(400);
    const res = await post("/auth/login", { username: "alice", password: "secret1" });
    expect(res.status).toBe(200);
    adminToken = ((await res.json()) as { token: string }).token;
    const res2 = await post("/auth/login", { username: "bob", password: "secret2" });
    analystToken = ((await res2.json()) as { token: string }).token;
  });

  it("未携带 token 访问 /api 一律 401", async () => {
    expect((await get("/api/me")).status).toBe(401);
  });
});

describe("datasets", () => {
  it("管理员上传 CSV 并读取 schema", async () => {
    const res = await post(
      "/api/datasets",
      { name: "sales", kind: "file", format: "csv", description: "测试", content_base64: Buffer.from(CSV).toString("base64") },
      adminToken,
    );
    expect(res.status).toBe(200);
    const schema = await get("/api/datasets/sales/schema", adminToken);
    const body = (await schema.json()) as { schema: { rowCount: number; columns: { name: string }[] } };
    expect(body.schema.rowCount).toBe(2);
    expect(body.schema.columns.map((c) => c.name)).toContain("region");
  });

  it("数据集名不合法被拒", async () => {
    const res = await post("/api/datasets", { name: "1bad name", kind: "file", format: "csv", content_base64: "eA==" }, adminToken);
    expect(res.status).toBe(400);
  });

  it("非管理员不能上传；未授权的 analyst 访问 schema 得 403", async () => {
    const denied = await post("/api/datasets", { name: "x", kind: "file", format: "csv", content_base64: "eA==" }, analystToken);
    expect(denied.status).toBe(403);
    const forbidden = await get("/api/datasets/sales/schema", analystToken);
    expect(forbidden.status).toBe(403);
  });
});

describe("sessions", () => {
  it("未授权任何数据集的用户开对话得到 400；会话列表正常", async () => {
    // bob（analyst）没有数据集授权 → 无法创建 agent
    const created = await post("/api/chat", { message: "hi" }, analystToken);
    expect(created.status).toBe(400);
    const list = (await (await get("/api/sessions", analystToken)).json()) as unknown[];
    expect(Array.isArray(list)).toBe(true);
  });
});

describe("reports", () => {
  it("创建报告配置并列出；坏 cron 保存成功但不调度", async () => {
    const res = await post(
      "/api/reports",
      { dataset: "sales", title: "周报", prompt: "总结本周销售", cron: "not-a-cron" },
      adminToken,
    );
    expect(res.status).toBe(200);
    const list = (await (await get("/api/reports", adminToken)).json()) as { title: string; dataset_name: string }[];
    expect(list[0]?.title).toBe("周报");
    expect(list[0]?.dataset_name).toBe("sales");
  });

  it("analyst 只能看到自己的报告", async () => {
    const list = (await (await get("/api/reports", analystToken)).json()) as unknown[];
    expect(list).toHaveLength(0);
  });

  it("报告内容路由拒绝越权路径", async () => {
    const res = await get("/api/report-runs/999/content", adminToken);
    expect(res.status).toBe(404);
  });
});

describe("static", () => {
  it("未构建 UI 时 SPA 回退返回 404 提示而不是崩溃", async () => {
    const res = await get("/");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("console UI not built");
  });
});
