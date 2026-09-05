import type { AnalysisSession } from "./agent.ts";

export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; result: string }
  | { type: "chart"; chart: { id: string; title: string; spec: unknown } }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

export interface TurnOutcome {
  text: string;
  charts: { id: string; title: string; spec: unknown }[];
}

/**
 * One agent turn, mapped to transport-agnostic events. The SSE server and
 * the report scheduler both consume this, so event semantics live in exactly
 * one place (including the willRetry false-positive guard).
 */
export async function runTurn(
  agent: AnalysisSession,
  question: string,
  onEvent: (event: TurnEvent) => void,
): Promise<TurnOutcome> {
  let text = "";
  let chartsEmitted = 0;
  agent.charts.length = 0; // charts are per-turn state

  const sub = agent.session.subscribe((event) => {
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") {
          text += e.delta;
          onEvent({ type: "text", delta: e.delta });
        } else if (e.type === "thinking_delta") {
          onEvent({ type: "thinking", delta: e.delta });
        }
        break;
      }
      case "tool_execution_start":
        onEvent({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
        break;
      case "tool_execution_end": {
        const result = event.result.content?.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join("") ?? "";
        onEvent({ type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, result });
        // make_chart pushed into the collector during execute — stream it out
        if (event.toolName === "make_chart" && !event.isError) {
          while (chartsEmitted < agent.charts.length) {
            const chart = agent.charts[chartsEmitted++]!;
            onEvent({ type: "chart", chart });
          }
        }
        break;
      }
      case "auto_retry_start":
        break;
      case "agent_end":
        if (event.willRetry) break;
        {
          const last = event.messages.at(-1) as
            | { role?: string; stopReason?: string; errorMessage?: string }
            | undefined;
          if (last?.role === "assistant" && last.stopReason === "error") {
            onEvent({ type: "error", message: last.errorMessage ?? "模型返回错误" });
          }
        }
        break;
    }
  });

  try {
    await agent.session.prompt(question, { streamingBehavior: "steer" });
  } finally {
    sub();
  }

  // any charts still undrained (tool_end ordering edge) — emit before done
  while (chartsEmitted < agent.charts.length) {
    const chart = agent.charts[chartsEmitted++]!;
    onEvent({ type: "chart", chart });
  }
  onEvent({ type: "done", text });
  return { text, charts: [...agent.charts] };
}
