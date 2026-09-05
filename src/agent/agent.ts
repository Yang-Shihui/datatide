import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { Engine } from "../engine/engine.ts";
import type { DatasetRegistry } from "./registry.ts";
import type { SkillStore } from "./skills.ts";
import type { McpBridge } from "../mcp/bridge.ts";
import { createMcpGatewayTool } from "../mcp/gateway.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { createTools, type ToolContext, type UserScope } from "./tools.ts";

const stripCwdLine: ExtensionFactory = (pi) => {
  pi.on("before_agent_start", (event) => {
    return { systemPrompt: event.systemPrompt.replace(/\nCurrent working directory: .*$/, "") };
  });
};

export interface AnalysisSessionOptions {
  scope: UserScope;
  engine: Engine;
  registry: DatasetRegistry;
  /** 可选：分析技能（清单进 system prompt，use_skill 工具加载正文） */
  skills?: SkillStore;
  /** 可选：MCP 桥接（注册单一 mcp 网关工具，服务器清单进 system prompt） */
  mcp?: McpBridge;
  /** "provider/model-id"; defaults to DATATIDE_MODEL env or the configured default model */
  modelSpec?: string;
}

export interface AnalysisSession {
  session: AgentSession;
  /** drained by callers (SSE server) after each run; charts generated this turn */
  charts: ToolContext["charts"];
  dispose: () => Promise<void>;
}

/**
 * Assemble a Pi agent session for one user scope: BI-only tool set,
 * analyst persona in the system prompt, cwd line stripped, no built-in
 * coding tools. One instance per conversation.
 */
export async function createAnalysisSession(options: AnalysisSessionOptions): Promise<AnalysisSession> {
  const { scope, engine, registry } = options;

  const charts: ToolContext["charts"] = [];
  const toolContext: ToolContext = { engine, registry, scope, charts, skills: options.skills };
  const tools = createTools(toolContext);
  if (options.mcp) tools.push(createMcpGatewayTool(options.mcp));

  let systemPrompt = await buildSystemPrompt(scope, registry, {}, options.skills);
  if (options.mcp) {
    systemPrompt += "\n\n## 外部工具（MCP）\n\n" +
      "平台接入了外部 MCP 工具（当前：" + options.mcp.statusLine() + "）。" +
      "当问题超出数据库查询能力（如需要 Python 计算/统计检验、联网查资料、处理 Excel 文件）时，" +
      "先用 mcp 工具 action=list 查看可用工具，再 action=call 调用。工具输出是分析依据之一，引用时注明来源。";
  }

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [stripCwdLine],
  });
  await loader.reload();

  const modelRuntime = await ModelRuntime.create();
  const model = options.modelSpec
    ? await pickModel(modelRuntime, options.modelSpec)
    : (await modelRuntime.getAvailable())[0];

  const { session } = await createAgentSession({
    model,
    modelRuntime,
    resourceLoader: loader,
    customTools: tools,
    tools: tools.map((t) => t.name),
    sessionManager: SessionManager.inMemory(),
  });

  return {
    session,
    charts,
    dispose: async () => {
      session.dispose();
    },
  };
}

async function pickModel(modelRuntime: ModelRuntime, spec: string) {
  const [provider, ...rest] = spec.split("/");
  const id = rest.join("/");
  if (!provider || !id) throw new Error(`DATATIDE_MODEL 格式应为 provider/model-id，收到: ${spec}`);
  const model = modelRuntime.getModel(provider, id);
  if (!model) {
    const available = await modelRuntime.getAvailable();
    throw new Error(
      `模型 ${spec} 不可用。可用模型: ${available.map((m) => `${m.provider}/${m.id}`).join(", ") || "（无）"}`,
    );
  }
  return model;
}
