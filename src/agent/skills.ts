import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  /** SKILL.md 绝对路径 */
  filePath: string;
  /** 内置（随仓库分发）还是外部目录挂载 */
  source: "builtin" | "external";
}

/** 解析 SKILL.md 的 YAML frontmatter（仅 name/description 两个键的行式子集） */
export function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!.trim()] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { name: meta.name, description: meta.description, body: raw.slice(m[0].length).trim() };
}

function scanDir(dir: string, source: Skill["source"], out: Skill[], seen: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在视为无技能
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      scanDir(full, source, out, seen);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      const raw = readFileSync(full, "utf8");
      const { name, description, body } = parseFrontmatter(raw);
      // Agent Skills 规范：description 必填（缺失则丢弃），name 回退到目录名
      if (!description) continue;
      const skillName = name || (dir.split(/[\\/]/).pop() ?? "");
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skillName) || seen.has(skillName)) continue;
      seen.add(skillName);
      out.push({ name: skillName, description, filePath: full, source });
      void body;
    }
  }
  void statSync;
}

export class SkillStore {
  private constructor(private readonly skills: Skill[]) {}

  /**
   * 扫描内置 skills/ 与 DATATIDE_SKILLS_DIR（外部挂载，标准 Agent Skills 格式，
   * 兼容 Claude Code skills 目录）。技能集在启动时冻结——与 agent 会话缓存策略一致。
   * 重名时内置优先：内置是受信内容，外部目录不得遮蔽产品方法论。
   */
  static create(builtinDir: string, externalDir?: string): SkillStore {
    const skills: Skill[] = [];
    const seen = new Set<string>();
    scanDir(builtinDir, "builtin", skills, seen);
    scanDir(externalDir ?? "", "external", skills, seen);
    return new SkillStore(skills);
  }

  list(): Skill[] {
    return [...this.skills];
  }

  get(name: string): Skill | undefined {
    return this.skills.find((s) => s.name === name);
  }

  /** 注入 system prompt 的技能清单（只含 name + description，渐进式披露） */
  promptSection(): string {
    if (this.skills.length === 0) return "";
    const items = this.skills.map((s) => `- **${s.name}**：${s.description}`).join("\n");
    return (
      "## 可用分析技能\n\n" +
      "调用 use_skill 工具（name 填技能名）可加载技能的完整方法论，再按其指导分析。\n\n" +
      items
    );
  }

  /** use_skill 工具的返回正文 */
  loadBody(name: string): string {
    const skill = this.get(name);
    if (!skill) return "";
    const { body } = parseFrontmatter(readFileSync(skill.filePath, "utf8"));
    return body;
  }
}
