import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/server.ts";

// Live end-to-end: real model gateway required (DATATIDE_LIVE=1 + models.json).
const LIVE = process.env.DATATIDE_LIVE === "1";

describe.skipIf(!LIVE)("SSE chat end-to-end", () => {
  let baseUrl: string;
  let token: string;
  let cleanup: () => void;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "datatide-live-"));
    const CSV = readFileSync(new URL("../../data/datasets/sales_demo.csv", import.meta.url), "utf8");
    const { app } = await createServer({ dataDir: join(root, "data"), reportsDir: join(root, "reports") });
    cleanup = await new Promise<() => void>((res) => {
      const server = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        res(() => server.close());
      });
    });
    await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "liveadmin", password: "secret1" }),
    });
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "liveadmin", password: "secret1" }),
    });
    token = ((await login.json()) as { token: string }).token;
    await fetch(`${baseUrl}/api/datasets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: "sales_demo",
        kind: "file",
        format: "csv",
        content_base64: Buffer.from(CSV).toString("base64"),
      }),
    });
    void writeFileSync; // keep import even if unused paths change
  });

  afterAll(() => cleanup());

  it("POST /api/chat 流式返回并落库", async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: "2026年8月华东区线上渠道销售额是多少？一句话回答" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const raw = await res.text();
    const events = raw.split("\n\n").filter(Boolean).map((chunk) => {
      const lines = chunk.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
      const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
      return { event, data: data ? JSON.parse(data) : undefined };
    });
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain("tool_start");
    expect(kinds).toContain("done");
    const done = events.find((e) => e.event === "done")!;
    expect((done.data as { text: string }).text.length).toBeGreaterThan(10);

    // messages persisted
    const sessions = (await (await fetch(`${baseUrl}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { id: number }[];
    expect(sessions.length).toBeGreaterThan(0);
    const messages = (await (await fetch(`${baseUrl}/api/sessions/${sessions[0]!.id}/messages`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { role: string }[];
    expect(messages.some((m) => m.role === "assistant")).toBe(true);
  }, 240_000);
});
