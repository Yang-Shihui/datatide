import * as readline from "node:readline";
import { Engine } from "./engine/engine.ts";
import { MetaStore } from "./store/meta.ts";
import { DatasetRegistry } from "./agent/registry.ts";
import { createBiAgent, type BiAgent } from "./agent/agent.ts";
import type { UserScope } from "./agent/tools.ts";

/**
 * Interactive terminal for local verification. Server-free: boots the
 * engine + registry from ./data and talks to the configured model directly.
 */
async function main() {
  const meta = new MetaStore("data/meta.db");
  const engine = await Engine.create(":memory:");
  const registry = new DatasetRegistry(engine, meta);
  await registry.ensureRegistered();

  const datasets = meta.listDatasets().map((d) => d.name);
  const scope: UserScope = { username: process.env.BI_AGENT_USER ?? "cli", datasets };
  const agent = await createBiAgent({
    scope,
    engine,
    registry,
    modelSpec: process.env.BI_AGENT_MODEL,
  });

  console.log(`bi-agent CLI — 数据集: ${datasets.join(", ") || "（无，先在 data/ 放入 CSV 并注册）"}`);

  const singleShot = process.argv.slice(2).join(" ").trim();
  if (singleShot) {
    await runTurn(agent, singleShot);
    await agent.dispose();
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you ▸ " });
  rl.prompt();
  rl.on("line", (line) => {
    const question = line.trim();
    if (!question) {
      rl.prompt();
      return;
    }
    if (question === "/exit") {
      rl.close();
      return;
    }
    // steer, not queue: feed input into the running agent when busy
    runTurn(agent, question)
      .catch((err) => console.error("error ▸", err instanceof Error ? err.message : err))
      .finally(() => rl.prompt());
  });
  rl.on("close", async () => {
    await agent.dispose();
    process.exit(0);
  });
}

async function runTurn(agent: BiAgent, question: string) {
  const sub = attachLogging(agent);
  try {
    await agent.session.prompt(question, { streamingBehavior: "steer" });
  } finally {
    sub();
  }
  agent.charts.length = 0; // CLI does not render charts
}

function attachLogging(agent: BiAgent): () => void {
  const sub = agent.session.subscribe((event) => {
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") process.stdout.write(e.delta);
        break;
      }
      case "tool_execution_start":
        process.stdout.write(`\n[tool] ${event.toolName} ${JSON.stringify(event.args ?? {}).slice(0, 120)}\n`);
        break;
      case "tool_execution_end":
        if (event.isError) {
          const text =
            event.result.content?.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join("") ?? "";
          process.stdout.write(`[tool] ${event.toolName} 失败: ${text.slice(0, 300)}\n`);
        }
        break;
      case "auto_retry_start":
        process.stdout.write("\n[retry] 模型请求失败，自动重试中…\n");
        break;
      case "agent_end": {
        // SDK emits agent_end on every auto-retry pass; only willRetry=false is final
        if (event.willRetry) break;
        const last = event.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
        if (last?.role === "assistant" && last.stopReason === "error") {
          process.stdout.write(`\n[error] ${last.errorMessage}\n`);
        } else {
          process.stdout.write("\n");
        }
        break;
      }
    }
  });
  return sub;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
