import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, readlinkSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  disableSkill,
  discoverSourceFolders,
  readSkillDetail,
  enableSkill,
  expandDestinations,
  inferProviderFromPath,
  normalizeSkillsDir,
  parseCategoriesYaml,
  parseSkillFrontmatter,
  scanSkills,
  SkillActionError,
} from "../../services/skills.ts";

const CATEGORIES = `
version: 1
categories:
  agents:
    title: AI & Agent Engineering
    description: Agents and harnesses
    skills:
      - agent-architect
      - rapid-prototype
  docs-meta:
    title: Docs
    skills:
      - technical-writer
`;

function writeSkill(root: string, name: string, description: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n\nBody.\n`,
  );
}

describe("parseCategoriesYaml", () => {
  test("reads category titles and skill lists", () => {
    const parsed = parseCategoriesYaml(CATEGORIES, "categories.yaml");
    expect(parsed.version).toBe(1);
    expect(parsed.categories.map((c) => c.id)).toEqual(["agents", "docs-meta"]);
    expect(parsed.categories[0]?.title).toBe("AI & Agent Engineering");
    expect(parsed.categories[0]?.skills).toEqual(["agent-architect", "rapid-prototype"]);
  });
});

describe("parseSkillFrontmatter", () => {
  test("reads folded description", () => {
    const meta = parseSkillFrontmatter(`---\nname: demo\ndescription: >\n  First line\n  second line\n---\n\n# Demo\n`);
    expect(meta.name).toBe("demo");
    expect(meta.description).toBe("First line second line");
  });
});

describe("normalizeSkillsDir", () => {
  test("appends .claude/skills for a project root", () => {
    const result = normalizeSkillsDir("/tmp/my-app");
    expect(result.path).toBe("/tmp/my-app/.claude/skills");
    expect(result.kind).toBe("project");
  });

  test("keeps an explicit skills directory", () => {
    const result = normalizeSkillsDir("/tmp/my-app/.claude/skills");
    expect(result.path).toBe("/tmp/my-app/.claude/skills");
    expect(result.kind).toBe("project");
    expect(result.provider).toBe("claude");
  });
});

describe("expandDestinations", () => {
  test("builds global dirs per selected provider", () => {
    const dests = expandDestinations(
      { sourceFolders: [], providers: ["claude", "codex", "gemini"], globalEnabled: true, projectRoots: [] },
      "/home/tester",
    );
    expect(dests.map((d) => d.id)).toEqual(["global-claude", "global-codex", "global-gemini"]);
    expect(dests.find((d) => d.provider === "codex")?.path).toBe("/home/tester/.codex/skills");
    expect(dests.find((d) => d.provider === "gemini")?.path).toBe("/home/tester/.gemini/skills");
  });

  test("adds per-provider project folders for selected roots", () => {
    const dests = expandDestinations(
      {
        sourceFolders: [],
        providers: ["claude", "opencode"],
        globalEnabled: false,
        projectRoots: ["/work/app"],
      },
      "/home/tester",
    );
    expect(dests.map((d) => d.path).sort()).toEqual([
      "/work/app/.claude/skills",
      "/work/app/.opencode/skills",
    ]);
  });

  test("infers claude project dests from a path", () => {
    expect(inferProviderFromPath("/work/app/.grok/skills")).toEqual({
      provider: "grok",
      kind: "project",
      projectRoot: "/work/app",
    });
  });
});

describe("scan / enable / disable", () => {
  const root = mkdtempSync(join(tmpdir(), "llm-toolkit-skills-"));
  const source = join(root, "skills");
  const globalDest = join(root, "home", ".claude", "skills");
  const projectDest = join(root, "app", ".claude", "skills");

  test("setup fixture", () => {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "categories.yaml"), CATEGORIES);
    writeSkill(source, "agent-architect", "Design agents");
    writeSkill(source, "rapid-prototype", "Spike quickly");
    writeSkill(source, "orphan-skill", "Not in categories");
    mkdirSync(globalDest, { recursive: true });
  });

  const dests = [
    { id: "global-claude", label: "Global Claude", path: globalDest, kind: "global" as const },
    { id: "project-app", label: "This app", path: projectDest, kind: "project" as const },
  ];

  test("groups skills from categories.yaml and leftover SKILL.md dirs", () => {
    const catalog = scanSkills({ sourceFolders: [source], destinations: dests });
    expect(catalog.skills.map((s) => s.name).sort()).toEqual([
      "agent-architect",
      "orphan-skill",
      "rapid-prototype",
    ]);
    expect(catalog.categories.find((c) => c.id === "agents")?.skills).toEqual([
      "agent-architect",
      "rapid-prototype",
    ]);
    expect(catalog.categories.find((c) => c.id === "uncategorized")?.skills).toEqual(["orphan-skill"]);
    expect(catalog.skills.find((s) => s.name === "agent-architect")?.installs[0]?.status).toBe("disabled");
  });

  test("enable writes a symlink into global and project destinations", () => {
    const cfg = { sourceFolders: [source], destinations: dests };
    const global = enableSkill(cfg, "agent-architect", "global-claude");
    expect(global.status).toBe("enabled");
    const project = enableSkill(cfg, "agent-architect", "project-app");
    expect(project.status).toBe("enabled");
    const catalog = scanSkills(cfg);
    const skill = catalog.skills.find((s) => s.name === "agent-architect");
    expect(skill?.installs.map((i) => i.status)).toEqual(["enabled", "enabled"]);
  });

  test("enable is idempotent when already linked", () => {
    const again = enableSkill(
      { sourceFolders: [source], destinations: dests },
      "agent-architect",
      "global-claude",
    );
    expect(again.status).toBe("enabled");
  });

  test("refuses to overwrite a real directory without replace", () => {
    const name = "rapid-prototype";
    mkdirSync(join(globalDest, name), { recursive: true });
    writeFileSync(join(globalDest, name, "SKILL.md"), "# local copy\n");
    expect(() =>
      enableSkill({ sourceFolders: [source], destinations: dests }, name, "global-claude"),
    ).toThrow(SkillActionError);
  });

  test("replace backs up a real directory and links", () => {
    const name = "rapid-prototype";
    const result = enableSkill(
      { sourceFolders: [source], destinations: dests },
      name,
      "global-claude",
      true,
    );
    expect(result.status).toBe("enabled");
  });

  test("disable removes a managed symlink and refuses real paths", () => {
    const cfg = { sourceFolders: [source], destinations: dests };
    const disabled = disableSkill(cfg, "agent-architect", "global-claude");
    expect(disabled.status).toBe("disabled");
    mkdirSync(join(globalDest, "orphan-skill"), { recursive: true });
    expect(() => disableSkill(cfg, "orphan-skill", "global-claude")).toThrow(/real path/);
  });

  test("cleanup", () => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("foreign symlink", () => {
  test("classifies a symlink that points elsewhere", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-toolkit-skills-foreign-"));
    const source = join(root, "skills");
    const dest = join(root, ".claude", "skills");
    mkdirSync(source, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeSkill(source, "agent-architect", "Design agents");
    mkdirSync(join(root, "other-skill"), { recursive: true });
    symlinkSync(join(root, "other-skill"), join(dest, "agent-architect"));
    const catalog = scanSkills({
      sourceFolders: [source],
      destinations: [{ id: "global-claude", label: "Global", path: dest, kind: "global" }],
    });
    expect(catalog.skills[0]?.installs[0]?.status).toBe("foreign");
    rmSync(root, { recursive: true, force: true });
  });
});


describe("catalog-driven nested skills", () => {
  test("catalog is authoritative, nested paths drive flat target symlinks, and metadata/categories survive", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-toolkit-skill-catalog-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      writeSkill(join(source, "skills", "engineering"), "nested", "Nested skill");
      writeSkill(join(source, "skills", "run-plans", "deep"), "nrp-demo", "Deep plan");
      writeSkill(source, "not-in-catalog", "Must not be guessed");
      writeFileSync(join(source, "categories.yaml"), "version: 1\ncategories:\n  wrong:\n    title: Old category\n    skills:\n      - nested\n  engineering:\n    title: Engineering\n");
      writeFileSync(join(source, "catalog.yaml"), "version: 1\nskills:\n  nested:\n    path: skills/engineering/nested\n    category: engineering\n    tags: [code, tools]\n  nrp-demo:\n    path: skills/run-plans/deep/nrp-demo\n    category: plans\n");
      const destination = join(root, "target");
      const cfg = { sourceFolders: [source], destinations: [{ id: "test", label: "Test", path: destination, kind: "global" as const, provider: "claude" as const }] };
      const catalog = scanSkills(cfg);
      expect(catalog.skills.map(skill => skill.name)).toEqual(["nested", "nrp-demo"]);
      expect(catalog.skills[0]).toMatchObject({ categoryId: "engineering", tags: ["code", "tools"], catalogFile: join(source, "catalog.yaml") });
      expect(catalog.categories.find(category => category.id === "wrong")?.skills).toEqual([]);
      expect(catalog.categories.find(category => category.id === "engineering")?.skills).toEqual(["nested"]);
      expect(readSkillDetail(cfg, "nrp-demo")?.skillMarkdown).toContain("Deep plan");
      expect(enableSkill(cfg, "nrp-demo", "test").status).toBe("enabled");
      expect(readlinkSync(join(destination, "nrp-demo"))).toBe(realpathSync(join(source, "skills", "run-plans", "deep", "nrp-demo")));
      expect(existsSync(join(destination, "nrp-demo", "SKILL.md"))).toBe(true);
      expect(disableSkill(cfg, "nrp-demo", "test").status).toBe("disabled");
      expect(readFileSync(join(source, "skills", "run-plans", "deep", "nrp-demo", "SKILL.md"), "utf-8")).toContain("Deep plan");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("catalog-only roots discover, while escapes, missing paths and malformed catalogs never fall back", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-toolkit-skill-catalog-invalid-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      writeSkill(source, "unlisted", "Do not include");
      writeSkill(root, "outside", "Outside content");
      symlinkSync(join(root, "outside"), join(source, "escaped"));
      mkdirSync(join(source, "escaped-file"));
      symlinkSync(join(root, "outside", "SKILL.md"), join(source, "escaped-file", "SKILL.md"));
      writeFileSync(join(source, "catalog.yaml"), `version: 1
skills:
  parent-escape:
    path: ../outside
  absolute:
    path: ${join(root, "outside")}
  symlink-escape:
    path: escaped
  missing:
    category: nope
  escaped-file:
    path: escaped-file
`);
      expect(discoverSourceFolders([source])).toContain(source);
      const catalog = scanSkills({ sourceFolders: [source], providers: [], globalEnabled: false });
      expect(catalog.skills).toEqual([]);
      expect(catalog.sources[0]?.warnings).toHaveLength(5);
      writeFileSync(join(source, "catalog.yaml"), "version: 99\nskills: nope\n");
      const malformed = scanSkills({ sourceFolders: [source], providers: [], globalEnabled: false });
      expect(malformed.skills).toEqual([]);
      expect(malformed.sources[0]?.warnings?.[0]).toContain("no directory fallback");
      expect(() => disableSkill({ sourceFolders: [source] }, "../outside", "test")).toThrow(/Invalid skill name/);
      const destination = join(root, "target"); mkdirSync(destination);
      symlinkSync(join(root, "outside"), join(destination, "unknown-foreign"));
      expect(() => disableSkill({ sourceFolders: [source], destinations: [{ id: "test", path: destination, label: "Test", kind: "global", provider: "claude" }] }, "unknown-foreign", "test")).toThrow(/outside sources/);
      expect(existsSync(join(destination, "unknown-foreign"))).toBe(true);
      rmSync(join(source, "catalog.yaml"));
      symlinkSync(join(root, "outside", "SKILL.md"), join(source, "catalog.yaml"));
      const escapedCatalog = scanSkills({ sourceFolders: [source], providers: [], globalEnabled: false });
      expect(escapedCatalog.skills).toEqual([]);
      expect(escapedCatalog.sources[0]?.warnings?.[0]).toContain("no directory fallback");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
