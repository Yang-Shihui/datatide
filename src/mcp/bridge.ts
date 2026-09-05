import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

/**
 * MCP 桥接层：把外部 MCP server 的工具以"单一网关工具"暴露给 agent。
 *
 * 设计（采 pi-mcp-adapter 验证过的代理模式）：
 * - 不逐个注册 MCP 工具（几十个工具会撑爆上下文），只注册一个 mcp 网关，
 *   模型通过 list 查工具、call 调用；
 * - 服务端 lazy 连接：首次 call 才连接，用完按空闲断开；工具元数据启动即缓存，
 *   list 不需要服务器存活；
 * - MCP 工具结果原样透传（文本/图片都受 Pi SDK 支持）；超长输出截断。
 *
 * 信任模型：mcp.json 由管理员配置——配置即信任声明，server 返回的内容视为工具输出
 * （会作为工具结果进入模型上下文，与 query_sql 的结果同级）。
 */

export interface McpServerConfig {
  /** stdio: 命令行启动；http: Streamable HTTP URL */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** 展示名，缺省用 key */
  description?: string;
  /** 工具名过滤（glob，* 通配），include 优先于 exclude */
  includeTools?: string[];
  excludeTools?: string[];
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpToolMeta {
  server: string;
  tool: string;
  /** 网关 call 用的全名：server__tool */
  fullName: string;
  description: string;
}

const IDLE_DISCONNECT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 50_000;

export function loadMcpConfig(path: string | undefined): McpConfig {
  if (!path) return { mcpServers: {} };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const servers = raw.mcpServers ?? raw; // 兼容裸 {server: {...}} 与标准 {mcpServers: {...}}
  if (typeof servers !== "object" || servers === null) throw new Error(`MCP 配置格式不正确: ${path}`);
  return { mcpServers: servers as Record<string, McpServerConfig> };
}

function globMatch(patterns: string[] | undefined, name: string, fallback: boolean): boolean {
  if (!patterns || patterns.length === 0) return fallback;
  return patterns.some((p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(name));
}

interface Conn {
  client: Client;
  timer: ReturnType<typeof setTimeout>;
}

export class McpBridge {
  private readonly servers: Record<string, McpServerConfig>;
  private readonly toolIndex = new Map<string, McpToolMeta>();
  private readonly conns = new Map<string, Conn>();

  constructor(config: McpConfig) {
    this.servers = config.mcpServers;
  }

  /**
   * 配置校验 + 启动时逐个连接预取工具元数据，取完即断开。
   * 预取失败的 server 不阻塞启动（call 时会重连重试）。
   */
  static async create(config: McpConfig): Promise<McpBridge> {
    const bridge = new McpBridge(config);
    for (const [name, cfg] of Object.entries(bridge.servers)) {
      if (!cfg.command && !cfg.url) throw new Error(`MCP server ${name}: 需要 command（stdio）或 url（http）之一`);
      if (cfg.command && cfg.url) throw new Error(`MCP server ${name}: command 与 url 只能配一个`);
    }
    for (const name of Object.keys(bridge.servers)) {
      try {
        await bridge.refreshServerTools(name);
      } catch (err) {
        console.error(`[mcp] server ${name} 预取工具列表失败（call 时重试）:`, err instanceof Error ? err.message : err);
      } finally {
        bridge.disconnect(name);
      }
    }
    return bridge;
  }

  private async connect(server: string): Promise<Client> {
    const existing = this.conns.get(server);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.disconnect(server), IDLE_DISCONNECT_MS);
      return existing.client;
    }
    const cfg = this.servers[server];
    if (!cfg) throw new Error(`MCP server ${server} 未配置`);
    const client = new Client({ name: "datatide", version: "0.1.0" });
    const transport = cfg.url
      ? new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } })
      : new StdioClientTransport({ command: cfg.command!, args: cfg.args, env: { ...(cfg.env ?? {}) } });
    await client.connect(transport);
    const timer = setTimeout(() => this.disconnect(server), IDLE_DISCONNECT_MS);
    this.conns.set(server, { client, timer });
    return client;
  }

  private disconnect(server: string): void {
    const conn = this.conns.get(server);
    if (!conn) return;
    this.conns.delete(server);
    clearTimeout(conn.timer);
    conn.client.close().catch(() => {});
  }

  /** 连接单个 server 并刷新其工具元数据缓存（include/exclude 过滤在此生效） */
  private async refreshServerTools(server: string): Promise<McpToolMeta[]> {
    const cfg = this.servers[server];
    if (!cfg) return [];
    const client = await this.connect(server);
    const { tools } = await client.listTools();
    for (const [full, t] of [...this.toolIndex]) if (t.server === server) this.toolIndex.delete(full);
    const metas: McpToolMeta[] = [];
    for (const t of tools) {
      if (!globMatch(cfg.includeTools, t.name, true)) continue;
      if (globMatch(cfg.excludeTools, t.name, false)) continue;
      const meta: McpToolMeta = {
        server,
        tool: t.name,
        fullName: `${server}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
        description: t.description ?? "",
      };
      this.toolIndex.set(meta.fullName, meta);
      metas.push(meta);
    }
    return metas;
  }

  /** 网关 list：纯读启动时缓存的元数据，不触发连接 */
  listAll(): string {
    const lines: string[] = [];
    for (const [server, cfg] of Object.entries(this.servers)) {
      const metas = [...this.toolIndex.values()].filter((t) => t.server === server);
      lines.push(`### server: ${server}${cfg.description ? `（${cfg.description}）` : ""}`);
      if (metas.length === 0) {
        lines.push("（启动时未能获取工具列表——server 不可用，或工具被 include/exclude 过滤。）");
        continue;
      }
      for (const m of metas) lines.push(`- ${m.fullName}：${m.description || "（无描述）"}`);
    }
    return lines.length > 0 ? lines.join("\n") : "当前没有配置任何 MCP server。";
  }

  /** 网关 call：调用 server__tool */
  async call(fullName: string, args: Record<string, unknown>): Promise<{ text: string; images: { data: string; mimeType: string }[] }> {
    const meta = this.toolIndex.get(fullName);
    if (!meta) throw new Error(`工具 ${fullName} 不存在。先用 mcp 工具的 action=list 查看可用工具。`);
    const client = await this.connect(meta.server);
    const result = await client.callTool({ name: meta.tool, arguments: args });
    const textParts: string[] = [];
    const images: { data: string; mimeType: string }[] = [];
    for (const c of (result.content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>) {
      if (c.type === "text" && c.text) textParts.push(c.text);
      else if (c.type === "image" && c.data) images.push({ data: c.data, mimeType: c.mimeType ?? "image/png" });
      else if (c.type !== "text" && c.type !== "image") textParts.push(`[不支持的内容类型: ${c.type}]`);
    }
    let text = textParts.join("\n");
    if (text.length > MAX_OUTPUT_CHARS) {
      text = text.slice(0, MAX_OUTPUT_CHARS) + `\n\n[输出超长已截断：原 ${text.length} 字符。请缩小调用范围。]`;
    }
    return { text, images };
  }

  /** 网关工具的 TypeBox 入参（延迟到注册时构建，避免循环依赖） */
  /** 设置页展示用：server 清单与已索引工具数 */
  serversInfo(): { name: string; description?: string; toolCount: number }[] {
    return Object.entries(this.servers).map(([name, cfg]) => ({
      name,
      description: cfg.description,
      toolCount: [...this.toolIndex.values()].filter((t) => t.server === name).length,
    }));
  }

  statusLine(): string {
    const n = Object.keys(this.servers).length;
    const t = this.toolIndex.size;
    return n === 0 ? "未配置 MCP server" : `${n} 个 server / ${t} 个已索引工具`;
  }

  shutdown(): void {
    for (const server of [...this.conns.keys()]) this.disconnect(server);
  }
}
