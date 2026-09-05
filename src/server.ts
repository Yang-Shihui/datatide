import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import express from "express";
import type { Request, Response } from "express";
import { Engine } from "./engine/engine.ts";
import { MetaStore } from "./store/meta.ts";
import { DatasetRegistry } from "./agent/registry.ts";
import { SkillStore } from "./agent/skills.ts";
import { McpBridge, loadMcpConfig } from "./mcp/bridge.ts";
import { createAnalysisSession, type AnalysisSession } from "./agent/agent.ts";
import { runTurn, type TurnEvent } from "./agent/runner.ts";
import { AuthService } from "./auth.ts";
import { ReportScheduler } from "./reports/scheduler.ts";

const PORT = Number(process.env.DATATIDE_PORT ?? 8200);
const ROW_CAP = 200;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

interface Ctx {
  meta: MetaStore;
  engine: Engine;
  registry: DatasetRegistry;
  skills: SkillStore;
  mcp?: McpBridge;
  auth: AuthService;
  scheduler: ReportScheduler;
  /** one agent per chat session; created lazily, disposed on eviction */
  agents: Map<number, AnalysisSession>;
  busy: Set<number>;
}

async function main() {
  const { app } = await createServer();
  app.listen(PORT, () => {
    console.log(`datatide server listening on http://127.0.0.1:${PORT}`);
  });
}

export async function createServer(opts: { staticDir?: string; reportsDir?: string; dataDir?: string } = {}) {
  const dataDir = resolve(opts.dataDir ?? process.env.DATATIDE_DATA_DIR ?? "data");
  const reportsDir = resolve(opts.reportsDir ?? process.env.DATATIDE_REPORTS_DIR ?? "reports");
  const staticDir = resolve(opts.staticDir ?? process.env.DATATIDE_STATIC_DIR ?? "static");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });

  const meta = new MetaStore(join(dataDir, "meta.db"));
  const engine = await Engine.create(":memory:");
  const registry = new DatasetRegistry(engine, meta);
  await registry.ensureRegistered();
  const skills = SkillStore.create(resolve("skills"), process.env.DATATIDE_SKILLS_DIR);
  let mcp: McpBridge | undefined;
  try {
    mcp = await McpBridge.create(loadMcpConfig(process.env.DATATIDE_MCP_CONFIG));
  } catch (err) {
    console.error("[mcp] 加载失败（继续无 MCP 启动）:", err instanceof Error ? err.message : err);
  }
  const auth = new AuthService(meta);
  const scheduler = new ReportScheduler({
    meta,
    engine,
    registry,
    skills,
    mcp,
    reportsDir,
    modelSpec: process.env.DATATIDE_MODEL,
  });
  scheduler.start();

  // bootstrap admin from env on first boot (dev convenience, documented)
  if (meta.listUsers().length === 0 && process.env.DATATIDE_ADMIN_PASSWORD) {
    auth.register("admin", process.env.DATATIDE_ADMIN_PASSWORD, "admin");
    console.log("[init] 已创建管理员 admin（密码来自 DATATIDE_ADMIN_PASSWORD）");
  }

  const ctx: Ctx = { meta, engine, registry, skills, mcp, auth, scheduler, agents: new Map(), busy: new Set() };

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64mb" }));

  // ---- auth ----
  app.post("/auth/register", (req, res) => guard(res, () => {
    const { username, password, role } = req.body as { username: string; password: string; role?: "admin" | "analyst" | "viewer" };
    // first registered user becomes admin automatically
    const isFirst = meta.listUsers().length === 0;
    const user = auth.register(username, password, isFirst ? "admin" : role ?? "analyst");
    res.json({ id: user.id, username: user.username, role: user.role });
  }));

  app.post("/auth/login", (req, res) => guard(res, () => {
    const { username, password } = req.body as { username: string; password: string };
    res.json(auth.login(username, password));
  }));

  app.post("/auth/logout", (req, res) => guard(res, () => {
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Bearer ")) auth.logout(header.slice(7));
    res.json({ ok: true });
  }));

  // ---- everything below requires auth ----
  app.use("/api", auth.middleware());

  app.get("/api/skills", (req, res) => {
    void currentUser(req);
    res.json(ctx.skills.list().map((s) => ({ name: s.name, description: s.description })));
  });

  app.get("/api/me", (req, res) => {
    const user = currentUser(req)!;
    res.json({ username: user.username, role: user.role, datasets: meta.datasetsForUser(user) });
  });

  // ---- datasets (admin) ----
  app.get("/api/datasets", (req, res) => {
    const user = currentUser(req)!;
    const all = meta.listDatasets().map((d) => ({
      name: d.name,
      kind: d.kind,
      description: d.description,
      created_at: d.created_at,
      authorized: meta.datasetsForUser(user).includes(d.name),
    }));
    res.json(all);
  });

  app.post("/api/datasets", (req, res) => adminOnly(req, res, () => guard(res, async () => {
    const { name, kind, description, format, content_base64, dsn } = req.body as {
      name: string; kind: "file" | "postgres"; description?: string;
      format?: "csv" | "parquet" | "xlsx"; content_base64?: string; dsn?: string;
    };
    if (!/^[a-z_][a-z0-9_]*$/.test(name ?? "")) throw new Error("数据集名需为小写字母/数字/下划线");
    if (meta.getDataset(name)) throw new Error("数据集已存在");
    if (kind === "file") {
      if (format !== "csv" && format !== "parquet" && format !== "xlsx") throw new Error("文件数据集需指定 format: csv|parquet|xlsx");
      if (!content_base64) throw new Error("缺少 content_base64（文件内容）");
      const buf = Buffer.from(content_base64, "base64");
      if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) throw new Error("文件为空或超过 64MB 上限");
      const dir = join(dataDir, "datasets");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${name}.${format}`);
      writeFileSync(path, buf);
      meta.createDataset(name, "file", { path, format }, description ?? "");
      await engine.registerFile(name, { path, format });
    } else if (kind === "postgres") {
      if (!dsn) throw new Error("postgres 数据集需要 dsn");
      meta.createDataset(name, "postgres", { dsn }, description ?? "");
      try {
        await engine.registerPostgres(name, { dsn });
      } catch (err) {
        meta.deleteDataset(name);
        throw err;
      }
    } else {
      throw new Error("kind 必须是 file 或 postgres");
    }
    res.json({ ok: true });
  })));

  app.delete("/api/datasets/:name", (req, res) => adminOnly(req, res, () => guard(res, async () => {
    const name = req.params.name;
    if (!meta.getDataset(name)) return res.status(404).json({ error: "数据集不存在" });
    meta.deleteDataset(name);
    await engine.dropDataset(name);
    res.json({ ok: true });
  })));

  app.get("/api/datasets/:name/schema", (req, res) => guard(res, async () => {
    const user = currentUser(req)!;
    if (!meta.datasetsForUser(user).includes(req.params.name)) {
      return res.status(403).json({ error: "无权访问该数据集" });
    }
    res.json(await registry.describe(req.params.name));
  }));

  // ---- chat ----
  app.post("/api/chat", (req, res) => guard(res, async () => {
    const user = currentUser(req)!;
    const { session_id: sessionId, message, skill: skillName, edit_message_id: editMessageId } = req.body as {
      session_id?: number; message: string; skill?: string; edit_message_id?: number;
    };
    if (!message?.trim()) return res.status(400).json({ error: "message 不能为空" });
    let skillBody: string | undefined;
    if (skillName) {
      const skill = ctx.skills.get(skillName);
      if (!skill) {
        return res.status(400).json({
          error: `技能 ${skillName} 不存在`,
          skills: ctx.skills.list().map((s) => s.name),
        });
      }
      skillBody = ctx.skills.loadBody(skillName);
    }

    if (meta.datasetsForUser(user).length === 0) return res.status(400).json({ error: "当前用户没有被授权任何数据集" });
    const id = sessionId ?? meta.createChatSession(user.id, message.slice(0, 30));
    if (meta.chatSessionOwner(id) !== user.id) return res.status(403).json({ error: "会话不存在" });
    if (ctx.busy.has(id)) return res.status(409).json({ error: "会话正在处理中，请稍候" });

    const agent = await getOrCreateAgent(ctx, user.username, id);
    if (!agent) return res.status(400).json({ error: "当前用户没有被授权任何数据集" });

    if (editMessageId != null) {
      // 编辑重发：把内存会话分支回退到该用户消息之前（更早的轮次与上下文原样保留），
      // DB 删除该消息及其后所有消息，然后按普通回合重新生成
      const target = meta.getMessage(Number(editMessageId));
      if (!target || target.session_id !== id) return res.status(400).json({ error: "要编辑的消息不存在" });
      if (target.role !== "user") return res.status(400).json({ error: "只能编辑用户消息" });
      let piEntry: string | undefined;
      try {
        piEntry = JSON.parse(target.extras_json || "{}").piEntry;
      } catch {
        piEntry = undefined;
      }
      const sm = agent.session.sessionManager;
      const entry = piEntry ? sm.getEntries().find((e) => e.id === piEntry) : undefined;
      if (entry?.parentId) sm.branch(entry.parentId);
      else sm.resetLeaf(); // 首条消息或旧消息无 piEntry 映射（如服务重启过）：回退到会话起点
      meta.truncateMessagesFrom(id, Number(editMessageId));
    }

    await startChat(ctx, req, res, id, agent, message, skillBody ? { name: skillName!, body: skillBody } : undefined);
  }));

  app.get("/api/sessions", (req, res) => {
    const user = currentUser(req)!;
    res.json(meta.listChatSessions(user.id));
  });

  app.get("/api/sessions/:id/messages", (req, res) => guard(res, () => {
    const user = currentUser(req)!;
    const id = Number(req.params.id);
    if (meta.chatSessionOwner(id) !== user.id) return res.status(403).json({ error: "会话不存在" });
    res.json(meta.listMessages(id));
  }));

  app.post("/api/sessions/:id/truncate", (req, res) => guard(res, () => {
    const user = currentUser(req)!;
    const id = Number(req.params.id);
    if (meta.chatSessionOwner(id) !== user.id) return res.status(403).json({ error: "会话不存在" });
    if (ctx.busy.has(id)) return res.status(409).json({ error: "会话正在处理中，无法回退" });
    const messageId = Number((req.body as { message_id?: number }).message_id);
    if (!Number.isInteger(messageId)) return res.status(400).json({ error: "message_id 不能为空" });
    const removed = meta.truncateMessagesFrom(id, messageId);
    // 内存 agent 一并销毁：被截断的对话不能残留在上下文里
    const agent = ctx.agents.get(id);
    if (agent) {
      agent.dispose();
      ctx.agents.delete(id);
    }
    res.json({ ok: true, removed });
  }));

  // ---- settings（admin 只读） ----
  app.get("/api/settings", (req, res) => adminOnly(req, res, () => {
    res.json({
      skills: ctx.skills.list().map((s) => ({ name: s.name, description: s.description, source: s.source })),
      mcp: {
        servers: ctx.mcp?.serversInfo() ?? [],
        configPath: process.env.DATATIDE_MCP_CONFIG ?? "（未配置）",
      },
    });
  }));

  // ---- reports ----
  app.get("/api/reports", (req, res) => {
    const user = currentUser(req)!;
    res.json(meta.listReportConfigs(user.role === "admin" ? undefined : user.id));
  });

  app.post("/api/reports", (req, res) => guard(res, () => {
    const user = currentUser(req)!;
    const { dataset, title, prompt, cron } = req.body as { dataset: string; title: string; prompt: string; cron: string };
    if (!title?.trim() || !prompt?.trim()) return res.status(400).json({ error: "title/prompt 不能为空" });
    if (!meta.datasetsForUser(user).includes(dataset)) return res.status(403).json({ error: "无权访问该数据集" });
    const id = meta.createReportConfig(user.id, dataset, title, prompt, cron ?? "0 9 * * 1");
    try {
      scheduler.schedule({ id, cron: cron ?? "0 9 * * 1", title });
    } catch (err) {
      void err; // config saved; invalid cron stays disabled until fixed
    }
    res.json({ id });
  }));

  app.post("/api/reports/:id/run", (req, res) => guard(res, async () => {
    const user = currentUser(req)!;
    const config = meta.getReportConfig(Number(req.params.id));
    if (!config) return res.status(404).json({ error: "报告不存在" });
    if (user.role !== "admin" && config.username !== user.username) return res.status(403).json({ error: "无权操作" });
    res.json(await scheduler.runNow(config.id));
  }));

  app.get("/api/reports/:id/runs", (req, res) => guard(res, () => {
    res.json(meta.listReportRuns(Number(req.params.id)));
  }));

  app.get("/api/report-runs/:runId/content", (req, res) => guard(res, () => {
    const run = meta.getReportRun(Number(req.params.runId));
    if (!run || !run.output_path) return res.status(404).json({ error: "报告内容不存在" });
    res.type("text/markdown; charset=utf-8").send(readReport(String(run.output_path), reportsDir));
  }));

  // ---- static console (served before auth so the browser can load the shell) ----
  serveStatic(app, staticDir, reportsDir);

  return { app, ctx, scheduler };
}

// ---- chat internals ----

async function getOrCreateAgent(ctx: Ctx, username: string, sessionId: number): Promise<AnalysisSession | undefined> {
  const existing = ctx.agents.get(sessionId);
  if (existing) return existing;
  const user = ctx.meta.getUser(username)!;
  const datasets = ctx.meta.datasetsForUser(user);
  if (datasets.length === 0) return undefined;
  const agent = await createAnalysisSession({
    scope: { username, datasets },
    engine: ctx.engine,
    registry: ctx.registry,
    skills: ctx.skills,
    mcp: ctx.mcp,
    modelSpec: process.env.DATATIDE_MODEL,
  });
  ctx.agents.set(sessionId, agent);
  if (ctx.agents.size > 32) {
    // simple eviction: drop the oldest session agent under memory pressure
    const first = ctx.agents.keys().next().value;
    if (first !== undefined && first !== sessionId) {
      await ctx.agents.get(first)?.dispose();
      ctx.agents.delete(first);
    }
  }
  return agent;
}

async function startChat(
  ctx: Ctx,
  _req: Request,
  res: Response,
  sessionId: number,
  agent: AnalysisSession,
  message: string,
  skill?: { name: string; body: string },
) {
  ctx.busy.add(sessionId);
  // 存库的是带技能标记的原文（回放时能看出技能来源），实际发给模型的 prompt 注入技能正文
  const storedMessage = skill ? `/skill:${skill.name} ${message}`.trim() : message;
  const userMessageId = ctx.meta.addMessage(sessionId, "user", storedMessage);
  if (skill) {
    message = `用户通过技能面板选择了技能「${skill.name}」，以下是该技能的方法论，请严格按其框架执行：\n\n<skill>\n${skill.body}\n</skill>\n\n用户问题：${message}`;
  }

  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();

  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      res.end();
    }
  };
  const safeWrite = (chunk: string) => {
    if (!res.writableEnded && !res.destroyed) res.write(chunk);
  };
  const send = (event: string, data: unknown) => {
    safeWrite(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Express 5: req 'close' fires when the body is read — watch res instead
  res.on("close", () => {
    if (!finished) {
      agent.session.abort();
      ctx.busy.delete(sessionId);
    }
  });

  const sm = agent.session.sessionManager;
  const beforeEntryIds = new Set(sm.getEntries().map((e) => e.id));

  const onEvent = (event: TurnEvent) => {
    switch (event.type) {
      case "text": send("text", { delta: event.delta }); break;
      case "thinking": send("thinking", { delta: event.delta }); break;
      case "tool_start": send("tool_start", { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }); break;
      case "tool_end": send("tool_end", { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, result: event.result }); break;
      case "chart": send("chart", event.chart); break;
      case "error": send("error", { message: event.message }); break;
      case "done": break; // sent below after persistence
    }
  };

  try {
    const outcome = await runTurn(agent, message, onEvent);
    // 记录本轮用户消息在 pi 会话里的条目 id——编辑重发时按它做分支回退
    const newEntry = sm
      .getEntries()
      .find((e) => !beforeEntryIds.has(e.id) && e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user");
    if (newEntry) {
      ctx.meta.setMessageExtras(userMessageId, JSON.stringify({ piEntry: newEntry.id }));
    }
    ctx.meta.addMessage(sessionId, "assistant", outcome.text, JSON.stringify({ charts: outcome.charts, thinking: outcome.thinking }));
    ctx.meta.touchChatSession(sessionId);
    send("done", { text: outcome.text });
  } catch (err) {
    const message_ = err instanceof Error ? err.message : String(err);
    send("error", { message: message_ });
  } finally {
    ctx.busy.delete(sessionId);
    finish();
  }
}

// ---- helpers ----

function currentUser(req: Request) {
  return (req as Request & { user?: ReturnType<AuthService["userForRequest"]> }).user;
}

function adminOnly(req: Request, res: Response, fn: () => void | Promise<void>) {
  const user = currentUser(req);
  if (user?.role !== "admin") {
    res.status(403).json({ error: "需要管理员权限" });
    return;
  }
  void fn();
}

async function guard(res: Response, fn: () => unknown | Promise<unknown>) {
  try {
    const out = await fn();
    // handlers that don't write a response themselves get a default 200
    if (!res.writableEnded && !res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function serveStatic(app: express.Express, staticDir: string, reportsDir: string) {
  app.use(express.static(staticDir));
  app.get(/^\/(?!api|auth|assets).*/, (_req, res) => {
    res.sendFile(join(staticDir, "index.html"), (err) => {
      if (err && !res.headersSent) res.status(404).send("console UI not built — run webui build (see README)");
    });
  });
}

function readReport(path: string, reportsDir: string): string {
  // report paths are produced by the scheduler itself; resolve to stay inside reports/
  const root = resolve(reportsDir);
  const target = resolve(path);
  if (!target.startsWith(root + sep)) throw new Error("路径不合法");
  return readFileSync(target, "utf8");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
