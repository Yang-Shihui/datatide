import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import cron, { type ScheduledTask } from "node-cron";
import type { Engine } from "../engine/engine.ts";
import type { MetaStore } from "../store/meta.ts";
import type { DatasetRegistry } from "../agent/registry.ts";
import type { SkillStore } from "../agent/skills.ts";
import { createAnalysisSession } from "../agent/agent.ts";
import { runTurn } from "../agent/runner.ts";

export interface SchedulerDeps {
  meta: MetaStore;
  engine: Engine;
  registry: DatasetRegistry;
  skills?: SkillStore;
  reportsDir: string;
  modelSpec?: string;
}

/**
 * Cron-driven report generation: each enabled config gets a headless agent
 * turn per schedule; output lands as markdown in reports/ and is tracked in
 * report_runs. Failure of one config must never stop the scheduler.
 */
export class ReportScheduler {
  private tasks = new Map<number, ScheduledTask>();
  private running = new Set<number>();

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    mkdirSync(this.deps.reportsDir, { recursive: true });
    for (const config of this.deps.meta.listReportConfigs()) {
      if (config.enabled) this.schedule(config);
    }
  }

  /** (Re)schedule one config after create/update. */
  schedule(config: { id: number; cron: string; title: string }): void {
    this.unschedule(config.id);
    if (!cron.validate(config.cron)) {
      throw new Error(`cron 表达式不合法: ${config.cron}`);
    }
    const task = cron.schedule(config.cron, () => {
      this.runNow(config.id).catch((err) => {
        console.error(`[report] config ${config.id} 运行失败:`, err instanceof Error ? err.message : err);
      });
    });
    this.tasks.set(config.id, task);
  }

  unschedule(id: number): void {
    this.tasks.get(id)?.stop();
    this.tasks.delete(id);
  }

  stopAll(): void {
    for (const id of [...this.tasks.keys()]) this.unschedule(id);
  }

  /** Fire a run immediately (manual trigger and cron both land here). */
  async runNow(configId: number): Promise<{ runId: number; outputPath?: string; error?: string }> {
    if (this.running.has(configId)) {
      return { runId: -1, error: "该报告正在运行中" };
    }
    const config = this.deps.meta.getReportConfig(configId);
    if (!config) throw new Error("报告配置不存在");
    const runId = this.deps.meta.startReportRun(configId);
    this.running.add(configId);
    try {
      const scope = {
        username: config.username,
        datasets: [config.dataset_name],
      };
      const agent = await createAnalysisSession({
        scope,
        engine: this.deps.engine,
        registry: this.deps.registry,
        skills: this.deps.skills,
        modelSpec: this.deps.modelSpec,
      });
      const prompt =
        `请基于数据集 ${config.dataset_name} 生成一份 markdown 分析报告，主题：「${config.title}」。\n` +
        `分析要求：${config.prompt}\n` +
        `输出结构：结论摘要（3-5 条要点）→ 关键数据表 → 趋势/归因分析 → 建议。直接输出 markdown 正文，不要开场白。`;
      const { text } = await runTurn(agent, prompt, () => {});
      const outputPath = join(this.deps.reportsDir, `report-${configId}-run${runId}.md`);
      writeFileSync(outputPath, `# ${config.title}\n\n> 数据集: ${config.dataset_name} · 生成于 ${new Date().toISOString()}\n\n${text}\n`);
      this.deps.meta.markReportRun(runId, configId, "success", outputPath, null);
      agent.dispose();
      return { runId, outputPath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.meta.markReportRun(runId, configId, "error", null, message);
      return { runId, error: message };
    } finally {
      this.running.delete(configId);
    }
  }
}
