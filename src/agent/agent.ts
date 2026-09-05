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
import { buildSystemPrompt } from "./prompt.ts";
import { createTools, type ToolContext, type UserScope } from "./tools.ts";

const stripCwdLine: ExtensionFactory = (pi) => {
  pi.on("before_agent_start", (event) => {
    return { systemPrompt: event.systemPrompt.replace(/\nCurrent working directory: .*$/, "") };
  });
};

export interface BiAgentOptions {
  scope: UserScope;
  engine: Engine;
  registry: DatasetRegistry;
  /** "provider/model-id"; defaults to BI_AGENT_MODEL env or the configured default model */
  modelSpec?: string;
}

export interface BiAgent {
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
export async function createBiAgent(options: BiAgentOptions): Promise<BiAgent> {
  const { scope, engine, registry } = options;

  const charts: ToolContext["charts"] = [];
  const toolContext: ToolContext = { engine, registry, scope, charts };
  const tools = createTools(toolContext);

  const systemPrompt = await buildSystemPrompt(scope, registry);

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
  if (!provider || !id) throw new Error(`BI_AGENT_MODEL 格式应为 provider/model-id，收到: ${spec}`);
  const model = modelRuntime.getModel(provider, id);
  if (!model) {
    const available = await modelRuntime.getAvailable();
    throw new Error(
      `模型 ${spec} 不可用。可用模型: ${available.map((m) => `${m.provider}/${m.id}`).join(", ") || "（无）"}`,
    );
  }
  return model;
}
