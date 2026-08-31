import { afterAll, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StorageService } from "../../services/storage.ts";
import { createSkillRoutes } from "../../routes/skills.ts";
import { createConfigRoutes } from "../../routes/config.ts";

const tempDir = mkdtempSync(join(tmpdir(), "llm-toolkit-skills-routes-"));
process.env.LLM_TOOLKIT_DATA_DIR = tempDir;
const storage = new StorageService(join(tempDir, "test.db"));
const source = join(tempDir, "skills");
const dest = join(tempDir, "project", ".claude", "skills");
const projectRoot = join(tempDir, "project");
let destId = "";

const app = new Hono();

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("skills routes", () => {
  test("setup", async () => {
    await storage.initialize();
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "categories.yaml"),
      "version: 1\ncategories:\n  agents:\n    title: Agents\n    skills:\n      - demo-skill\n",
    );
    mkdirSync(join(source, "demo-skill"));
    writeFileSync(
      join(source, "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo\n---\n\n# Demo Skill\n",
    );
    const noopLlm = { reconfigure: async () => {} } as never;
    app.route("/api/config", createConfigRoutes(storage, noopLlm));
    app.route("/api/skills", createSkillRoutes(storage));
    await app.request("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skills: {
          sourceFolders: [source],
          providers: ["claude"],
          globalEnabled: false,
          projectRoots: [projectRoot],
        },
      }),
    });
  });

  test("GET /api/skills lists categorized skills", async () => {
    const res = await app.request("/api/skills");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.skills[0].name).toBe("demo-skill");
    expect(body.data.categories.some((c: { id: string }) => c.id === "agents")).toBe(true);
    destId = body.data.destinations[0].id;
    expect(destId).toContain("claude");
    expect(body.data.destinations[0].path).toBe(dest);
  });

  test("POST enable then disable creates and removes a project symlink", async () => {
    const enabled = await app.request("/api/skills/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo-skill", destinationId: destId }),
    });
    expect(enabled.status).toBe(200);
    const enabledBody = await enabled.json();
    expect(enabledBody.data.status).toBe("enabled");

    const disabled = await app.request("/api/skills/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo-skill", destinationId: destId }),
    });
    expect(disabled.status).toBe(200);
    const disabledBody = await disabled.json();
    expect(disabledBody.data.status).toBe("disabled");
  });

  test("GET /api/skills/:name returns SKILL.md", async () => {
    const res = await app.request("/api/skills/demo-skill");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.skillMarkdown).toContain("# Demo Skill");
  });
});
