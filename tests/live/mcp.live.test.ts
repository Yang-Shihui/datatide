import { describe, expect, it } from "vitest";
import { McpBridge } from "../../src/mcp/bridge.ts";

// Live：真实外部 MCP server（@pydantic/mcp-run-python，Pyodide 沙箱）。DATATIDE_LIVE=1 门控。
const LIVE = process.env.DATATIDE_LIVE === "1";

describe.skipIf(!LIVE)("MCP live — run-python", () => {
  it("沙箱执行 pandas 统计并返回结果", async () => {
    const bridge = await McpBridge.create({
      mcpServers: { py: { command: "npx", args: ["-y", "@pydantic/mcp-run-python", "stdio"] } },
    });
    expect(bridge.listAll()).toContain("py__run_python_code");
    const r = await bridge.call("py__run_python_code", {
      python_code: "import statistics\nprint(round(statistics.stdev([100,150,130,170]), 2))",
    });
    expect(r.text).toContain("29.86");
    bridge.shutdown();
  }, 300_000);
});
