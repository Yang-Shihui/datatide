import { Type } from "@sinclair/typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { GuardError, type Engine, type QueryResult } from "../engine/engine.ts";
import type { DatasetRegistry } from "./registry.ts";
import type { SkillStore } from "./skills.ts";
import { formatTable } from "../format.ts";

export interface UserScope {
  username: string;
  datasets: string[];
}

export interface ToolContext {
  engine: Engine;
  registry: DatasetRegistry;
  scope: UserScope;
  /** charts generated this turn; the SSE server drains it after each run */
  charts: { id: string; title: string; spec: unknown }[];
  /** 可选：内置/挂载的分析方法论技能 */
  skills?: SkillStore;
}

const CHART_TYPES = ["bar", "line", "pie", "scatter"] as const;
const MAX_CHART_POINTS = 500;

/**
 * Validate a minimal ECharts option. We keep the schema tight on purpose:
 * the frontend renders only what it can trust, and a malformed spec must
 * fail at the tool boundary with a message the model can self-correct from.
 */
export function validateChartSpec(spec: unknown): { title: string; spec: Record<string, unknown> } {
  // LLM 常把对象整体 JSON.stringify 后传入，这里宽容解析
  if (typeof spec === "string") {
    try {
      spec = JSON.parse(spec);
    } catch {
      throw new Error("chart spec 是字符串但不是合法 JSON，请传 JSON 对象。");
    }
  }
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new Error("chart spec 必须是一个 JSON 对象。");
  }
  const s = spec as Record<string, unknown>;
  const series = s.series;
  if (!Array.isArray(series) || series.length === 0 || series.length > 4) {
    throw new Error("chart spec.series 必须是 1-4 个元素的数组。");
  }
  for (const item of series) {
    const ser = item as Record<string, unknown>;
    if (!CHART_TYPES.includes(ser.type as (typeof CHART_TYPES)[number])) {
      throw new Error(`不支持的图表类型 "${ser.type}"，可用: ${CHART_TYPES.join(", ")}。`);
    }
    const data = ser.data;
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("每个 series 都需要非空 data 数组。");
    }
    if (data.length > MAX_CHART_POINTS) {
      throw new Error(`数据点过多（${data.length} > ${MAX_CHART_POINTS}），请先聚合。`);
    }
  }
  const title = typeof s.title === "object" && s.title !== null && "text" in s.title
    ? String((s.title as Record<string, unknown>).text)
    : "图表";
  return { title, spec: s };
}

function describeQueryResult(result: QueryResult, sql: string): string {
  const lines = [
    `查询完成（${result.elapsedMs}ms，返回 ${result.rowCount} 行${result.truncated ? `，已达行数上限被截断` : ""}）。`,
    `执行的 SQL: \`${sql.replace(/\s+/g, " ").trim()}\``,
    "",
    formatTable(result.rows),
  ];
  if (result.truncated) {
    lines.push("", "注意：结果被截断，只显示前若干行。如需完整统计请改用聚合查询。");
  }
  return lines.join("\n");
}

export function createTools(ctx: ToolContext) {
  const { engine, registry, scope } = ctx;
  const allowedViews = scope.datasets;

  const datasetInfoTool = defineTool({
    name: "dataset_info",
    label: "数据集概览",
    description:
      "列出当前用户可用的数据集及其完整 schema（字段、类型、枚举取值、行数）。" +
      "在写任何 SQL 之前必须先调用本工具确认字段名与表名；用户问到数据范围时也用它回答。",
    parameters: Type.Object({}),
    async execute() {
      const text =
        scope.datasets.length === 0
          ? "当前用户没有被授权任何数据集。"
          : await registry.snapshotText(scope.datasets);
      return { content: [{ type: "text" as const, text }], details: { datasets: scope.datasets } };
    },
  });

  const querySqlTool = defineTool({
    name: "query_sql",
    label: "执行分析查询",
    description:
      "对已授权数据集执行只读 SELECT/WITH 查询（DuckDB SQL 方言，postgres 数据集用限定表名）。" +
      "每次最多返回 200 行；大结果请用聚合。禁止任何写操作。" +
      "错误信息会说明原因（字段名错误、越权对象等），据此修正后重试。",
    parameters: Type.Object({
      sql: Type.String({ description: "单条 SELECT 或 WITH 查询语句" }),
    }),
    async execute(_id, params) {
      try {
        const result = await engine.query(params.sql, { allowedViews });
        return {
          content: [{ type: "text" as const, text: describeQueryResult(result, params.sql) }],
          details: { rows: result.rows, rowCount: result.rowCount, truncated: result.truncated },
        };
      } catch (err) {
        if (err instanceof GuardError) {
          throw new Error(`查询被只读守卫拒绝：${err.message}`);
        }
        throw err;
      }
    },
  });

  const makeChartTool = defineTool({
    name: "make_chart",
    label: "生成图表",
    description:
      "把分析结论渲染成图表（ECharts option）。type 支持 bar/line/pie/scatter；" +
      "先 query_sql 拿到数据，再在这里填入聚合后的数据点（≤500 个）。" +
      "文本回答仍需给出数字结论，图表只是补充展示。",
    parameters: Type.Object({
      spec: Type.Unknown({ description: "ECharts option JSON 对象（title/series/xAxis 等）" }),
    }),
    async execute(_id, params) {
      const { title, spec } = validateChartSpec(params.spec);
      const chartId = `chart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      ctx.charts.push({ id: chartId, title, spec });
      return {
        content: [{ type: "text" as const, text: `图表「${title}」已生成（id: ${chartId}），将随回答一并展示。` }],
        details: { chartId, title, spec },
      };
    },
  });

  const useSkillTool = defineTool({
    name: "use_skill",
    label: "加载分析技能",
    description:
      "加载一个分析技能的完整方法论（归因拆解、口径核对、图表选型等）。" +
      "遇到技能清单里描述匹配当前问题的技能时，先加载它再按方法论执行；一次只加载一个。",
    parameters: Type.Object({
      name: Type.String({ description: "技能名，来自系统提示中的可用分析技能清单" }),
    }),
    async execute(_id, params) {
      const body = ctx.skills?.loadBody(params.name);
      if (!body) {
        const names = ctx.skills?.list().map((s) => s.name).join(", ") || "（无）";
        throw new Error(`技能 ${params.name} 不存在。可用技能：${names}`);
      }
      return { content: [{ type: "text" as const, text: body }], details: { skill: params.name } };
    },
  });

  return [datasetInfoTool, querySqlTool, makeChartTool, useSkillTool];
}
