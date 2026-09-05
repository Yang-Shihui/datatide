import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatasetRegistry } from "./registry.ts";
import type { SkillStore } from "./skills.ts";
import type { UserScope } from "./tools.ts";

const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../prompts/analyst");

function loadStatic(name: string): string {
  return readFileSync(join(PROMPT_DIR, name), "utf8").trim();
}

const PERSONA = loadStatic("persona.md");
const RULES = loadStatic("rules.md");
const OUTPUT_FORMAT = loadStatic("output-format.md");

export async function buildSystemPrompt(
  scope: UserScope,
  registry: DatasetRegistry,
  opts: { includeSnapshot?: boolean } = {},
  skills?: SkillStore,
): Promise<string> {
  const parts: string[] = [PERSONA];

  parts.push(
    "## 当前用户\n\n" +
      `用户名: ${scope.username}\n` +
      `授权数据集: ${scope.datasets.length > 0 ? scope.datasets.join(", ") : "（无）"}\n` +
      "只允许查询上述数据集；用户询问其他数据时明确说明没有权限。",
  );

  parts.push(RULES);
  parts.push(OUTPUT_FORMAT);

  if (opts.includeSnapshot !== false && scope.datasets.length > 0) {
    parts.push("## 数据集快照\n\n" + (await registry.snapshotText(scope.datasets)));
  }

  const skillSection = skills?.promptSection();
  if (skillSection) parts.push(skillSection);

  return parts.join("\n\n");
}
