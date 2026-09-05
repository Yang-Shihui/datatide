import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpBridge, loadMcpConfig } from "../src/mcp/bridge.ts";

const FAKE = join(import.meta.dirname, "fake-mcp-server.mjs");
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "datatide-mcp-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
import { rmSync } from "node:fs";

describe("loadMcpConfig", () => {
  it("读标准 mcpServers 格式", () => {
    const path = join(root, "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { fake: { command: "node", args: [FAKE, "--name", "t"] } } }));
    const cfg = loadMcpConfig(path);
    expect(cfg.mcpServers.fake?.command).toBe("node");
  });

  it("兼容裸 {server: {...}} 格式（.mcp.json 变体）", () => {
    const path = join(root, "mcp2.json");
    writeFileSync(path, JSON.stringify({ fake: { command: "node", args: [FAKE] } }));
    expect(loadMcpConfig(path).mcpServers.fake).toBeDefined();
  });

  it("未配置路径返回空", () => {
    expect(loadMcpConfig(undefined).mcpServers).toEqual({});
  });
});

describe("McpBridge — stdio 假 server 全链路", () => {
  it("启动预取元数据后 list 可用；call 走通并回传文本", async () => {
    const bridge = await McpBridge.create({
      mcpServers: { fake: { command: "node", args: [FAKE, "--name", "alpha"], description: "测试服务器" } },
    });

    const listing = bridge.listAll();
    expect(listing).toContain("fake__echo");
    expect(listing).toContain("fake__add");
    expect(listing).toContain("回显输入的 message 参数");

    const call = await bridge.call("fake__echo", { message: "你好" });
    expect(call.text).toBe("echo(alpha): 你好");
    expect(call.images).toEqual([]);

    const sum = await bridge.call("fake__add", { a: 2, b: 40 });
    expect(sum.text).toBe("sum = 42");

    bridge.shutdown();
  });

  it("includeTools/excludeTools 过滤", async () => {
    const bridge = await McpBridge.create({
      mcpServers: { fake: { command: "node", args: [FAKE], excludeTools: ["add"] } },
    });
    const listing = bridge.listAll();
    expect(listing).toContain("fake__echo");
    expect(listing).not.toContain("fake__add");
    bridge.shutdown();
  });

  it("调用不存在的工具给出可自纠错误", async () => {
    const bridge = await McpBridge.create({
      mcpServers: { fake: { command: "node", args: [FAKE] } },
    });
    await expect(bridge.call("fake__nope", {})).rejects.toThrow(/不存在/);
    await expect(bridge.call("nope__x", {})).rejects.toThrow(/不存在/);
    bridge.shutdown();
  });

  it("server 名与工具名的非法字符被清洗", async () => {
    const bridge = await McpBridge.create({
      mcpServers: { "my.server#1": { command: "node", args: [FAKE] } },
    });
    const listing = bridge.listAll();
    expect(listing).toMatch(/my_server_1__echo/);
    expect(listing).not.toMatch(/my\.server#1__/);
    bridge.shutdown();
  });

  it("配置缺 command/url 启动即报错", async () => {
    await expect(McpBridge.create({ mcpServers: { bad: {} } })).rejects.toThrow(/command（stdio）或 url/);
  });
});
