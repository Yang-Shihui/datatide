/** 极简 stdio MCP server（JSON-RPC over stdio），hermetic 测试用：echo + add 两个工具 */
const nameIdx = process.argv.indexOf("--name");
const serverName = nameIdx > -1 ? process.argv[nameIdx + 1] : "fake";

const TOOLS = [
  {
    name: "echo",
    description: "回显输入的 message 参数",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "add",
    description: "两数相加",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  },
];

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || !method) return;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: serverName, version: "0.0.1" } } });
  } else if (method.startsWith("notifications/")) {
    // 通知无需应答
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    const tool = params.name;
    const args = params.arguments ?? {};
    if (tool === "echo") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo(${serverName}): ${args.message}` }] } });
    } else if (tool === "add") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `sum = ${Number(args.a) + Number(args.b)}` }] } });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${tool}` } });
    }
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

setInterval(() => {}, 30_000); // 保持进程存活
