import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillStore, parseFrontmatter } from "../src/agent/skills.ts";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `datatide-skills-${Date.now()}`);
  mkdirSync(join(root, "builtin", "attr"), { recursive: true });
  writeFileSync(
    join(root, "builtin", "attr", "SKILL.md"),
    "---\nname: attribution\ndescription: 归因拆解方法论\n---\n\n# 归因\n\n先拆维度再算贡献度。",
  );
  mkdirSync(join(root, "builtin", "no-desc"), { recursive: true });
  writeFileSync(join(root, "builtin", "no-desc", "SKILL.md"), "---\nname: nodesc\n---\n无描述内容");
  mkdirSync(join(root, "builtin", "bad name"), { recursive: true });
  writeFileSync(
    join(root, "builtin", "bad name", "SKILL.md"),
    "---\nname: Bad_Name\ndescription: 非法名\n---\n内容",
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("SkillStore", () => {
  it("扫描 SKILL.md，缺 description 或名字非法的丢弃", () => {
    const store = SkillStore.create(join(root, "builtin"));
    const names = store.list().map((s) => s.name);
    expect(names).toContain("attribution");
    expect(names).not.toContain("nodesc");
    expect(names).not.toContain("Bad_Name");
  });

  it("external 目录挂载；重名时内置优先", () => {
    mkdirSync(join(root, "ext", "attribution"), { recursive: true });
    writeFileSync(
      join(root, "ext", "attribution", "SKILL.md"),
      "---\nname: attribution\ndescription: 外部版本\n---\n外部内容",
    );
    mkdirSync(join(root, "ext", "extra"), { recursive: true });
    writeFileSync(
      join(root, "ext", "extra", "SKILL.md"),
      "---\nname: extra-skill\ndescription: 额外技能\n---\n内容",
    );
    const store = SkillStore.create(join(root, "builtin"), join(root, "ext"));
    const attribution = store.get("attribution")!;
    expect(attribution.source).toBe("builtin");
    expect(attribution.description).toBe("归因拆解方法论");
    expect(store.get("extra-skill")?.source).toBe("external");
  });

  it("promptSection 只含清单且引导 use_skill；空库返回空串", () => {
    const store = SkillStore.create(join(root, "builtin"));
    const section = store.promptSection();
    expect(section).toContain("use_skill");
    expect(section).toContain("**attribution**：归因拆解方法论");
    expect(SkillStore.create(join(root, "不存在")).promptSection()).toBe("");
  });

  it("loadBody 返回去 frontmatter 正文；不存在返回空串", () => {
    const store = SkillStore.create(join(root, "builtin"));
    expect(store.loadBody("attribution")).toContain("先拆维度再算贡献度");
    expect(store.loadBody("attribution")).not.toContain("description:");
    expect(store.loadBody("nope")).toBe("");
  });
});

describe("parseFrontmatter", () => {
  it("无 frontmatter 时 body 为原文", () => {
    const r = parseFrontmatter("直接正文");
    expect(r.body).toBe("直接正文");
    expect(r.name).toBeUndefined();
  });

  it("剥掉 frontmatter 并取 name/description", () => {
    const r = parseFrontmatter('---\nname: a-b\ndescription: "带引号的描述"\n---\n正文X');
    expect(r.name).toBe("a-b");
    expect(r.description).toBe("带引号的描述");
    expect(r.body).toBe("正文X");
  });
});
