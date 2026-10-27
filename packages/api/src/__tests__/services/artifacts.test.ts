import { describe, expect, test } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableArtifact, enableArtifact, scanArtifacts, readArtifactDetail } from "../../services/artifacts.ts";

function writeAgent(root: string, name: string, description: string) {
  writeFileSync(
    join(root, `${name}.md`),
    `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n`,
  );
}

describe("agents catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "llm-toolkit-agents-"));
  const source = join(root, "agents");
  const dest = join(root, "home", ".claude", "agents");

  test("enable writes a file symlink", () => {
    mkdirSync(source, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(source, "categories.yaml"), "version: 1\ncategories:\n  npl:\n    title: NPL\n    agents:\n      - npl-tasker\n");
    writeAgent(source, "npl-tasker", "Do tasks");
    const cfg = {
      sourceFolders: [source],
      destinations: [{ id: "global-claude", label: "Global Claude", path: dest, kind: "global" as const, provider: "claude" as const }],
    };
    const catalog = scanArtifacts("agents", cfg, join(root, "home"));
    expect(catalog.items.map((item) => item.name)).toEqual(["npl-tasker"]);
    expect(catalog.categories.some((cat) => cat.id === "npl")).toBe(true);
    const enabled = enableArtifact("agents", cfg, "npl-tasker", "global-claude");
    expect(enabled.status).toBe("enabled");
    expect(lstatSync(join(dest, "npl-tasker.md")).isSymbolicLink()).toBe(true);
    const disabled = disableArtifact("agents", cfg, "npl-tasker", "global-claude");
    expect(disabled.status).toBe("disabled");
  });

  test("cleanup", () => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("mcp catalog", () => {
  test("enable writes a project .mcp.json entry", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-toolkit-mcp-art-"));
    const source = join(root, "mcp");
    const project = join(root, "app");
    mkdirSync(source, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(source, "doc-pointers.json"),
      JSON.stringify({ url: "http://localhost:4242/mcp", type: "http" }),
    );
    const cfg = {
      sourceFolders: [source],
      destinations: [{
        id: "project-app",
        label: "App",
        path: join(project, ".mcp.json"),
        kind: "project" as const,
        provider: "claude" as const,
        projectRoot: project,
      }],
    };
    const catalog = scanArtifacts("mcp", cfg, join(root, "home"));
    expect(catalog.items[0]?.name).toBe("doc-pointers");
    const enabled = enableArtifact("mcp", cfg, "doc-pointers", "project-app");
    expect(enabled.status).toBe("enabled");
    const written = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf-8"));
    expect(written.mcpServers["doc-pointers"].url).toBe("http://localhost:4242/mcp");
    rmSync(root, { recursive: true, force: true });
  });
});


describe("agent family metadata", () => {
  test("catalog and detail preserve explicit parent/model variant metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-toolkit-family-"));
    try {
      writeFileSync(join(root, "npl-coder-glm-flash.md"), `---
name: npl-coder-glm-flash
description: |
  Code executor.
  Keep multiline descriptions intact.
model: zai/glm-5.3-flash
parent: npl-coder
variant:
    provider: zai
    model: "glm-5.3-flash (sub, high)"
    tier: sonnet
    account: zai-alt
---
# Model variant
`);
      const cfg = { sourceFolders: [root], providers: [], globalEnabled: false };
      const item = scanArtifacts("agents", cfg).items[0]!;
      expect(item.parent).toBe("npl-coder");
      expect(item.variant).toEqual({ provider: "zai", model: "glm-5.3-flash (sub, high)", tier: "sonnet", account: "zai-alt" });
      expect(item.description).toContain("Keep multiline descriptions intact");
      expect(readArtifactDetail("agents", cfg, item.name)?.variant).toEqual(item.variant);
      expect(scanArtifacts("commands", cfg).items[0]?.parent).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
