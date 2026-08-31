import { describe, expect, test } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableArtifact, enableArtifact, scanArtifacts } from "../../services/artifacts.ts";

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
