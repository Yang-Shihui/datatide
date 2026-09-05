import { Type } from "@sinclair/typebox";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { McpBridge } from "./bridge.ts";

/**
 * 单一 MCP 网关工具（代理模式，防上下文爆炸）：
 * action=list 查工具清单（纯缓存），action=call 调用 server__tool。
 */
export function createMcpGatewayTool(bridge: McpBridge) {
  return defineTool({
    name: "mcp",
    label: "MCP 外部工具",
    description:
      "调用外部 MCP 工具（联网搜索、Python 计算、Excel 处理等，由管理员配置）。" +
      "action=list 返回全部可用工具及参数说明；action=call 执行指定工具。" +
      "调用前必须先 list 确认工具存在与参数要求。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("call")], {
        description: "list=查看可用工具；call=执行",
      }),
      tool: Type.Optional(Type.String({ description: "call 时必填：工具全名（server__tool 形式，list 返回的名字）" })),
      args: Type.Optional(Type.Unknown({ description: "call 时必填：工具参数对象，结构见 list 中该工具的说明" })),
    }),
    async execute(_id, params): Promise<AgentToolResult<{ tool?: string }>> {
      if (params.action === "list") {
        const text = bridge.listAll();
        return { content: [{ type: "text" as const, text }], details: {} };
      }
      if (!params.tool) throw new Error("action=call 需要 tool 参数（server__tool 形式）。先用 action=list 查看。");
      if (params.args !== undefined && (typeof params.args !== "object" || params.args === null || Array.isArray(params.args))) {
        throw new Error("args 必须是 JSON 对象。");
      }
      const { text, images } = await bridge.call(params.tool, (params.args ?? {}) as Record<string, unknown>);
      const content: AgentToolResult<Record<string, never>>["content"] = [];
      if (text) content.push({ type: "text", text });
      for (const img of images.slice(0, 3)) {
        content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
      if (content.length === 0) content.push({ type: "text", text: "（工具返回为空）" });
      return { content, details: { tool: params.tool } };
    },
  });
}
