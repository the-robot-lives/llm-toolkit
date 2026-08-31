import { afterAll, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StorageService } from "../../services/storage.ts";
import { createArtifactRoutes } from "../../routes/artifacts.ts";
import { createConfigRoutes } from "../../routes/config.ts";

const tempDir = mkdtempSync(join(tmpdir(), "llm-toolkit-artifact-routes-"));
process.env.LLM_TOOLKIT_DATA_DIR = tempDir;
const storage = new StorageService(join(tempDir, "test.db"));
const source = join(tempDir, "agents");
const dest = join(tempDir, "project", ".claude", "agents");
const projectRoot = join(tempDir, "project");
let destId = "";

const app = new Hono();

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("agents routes", () => {
  test("setup", async () => {
    await storage.initialize();
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "categories.yaml"),
      "version: 1\ncategories:\n  npl:\n    title: NPL\n    agents:\n      - demo-agent\n",
    );
    writeFileSync(
      join(source, "demo-agent.md"),
      "---\nname: demo-agent\ndescription: Demo\n---\n\n# Demo Agent\n",
    );
    const noopLlm = { reconfigure: async () => {} } as never;
    app.route("/api/config", createConfigRoutes(storage, noopLlm));
    app.route("/api/agents", createArtifactRoutes(storage, "agents"));
    await app.request("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agents: {
          sourceFolders: [source],
          providers: ["claude"],
          globalEnabled: false,
          projectRoots: [projectRoot],
        },
      }),
    });
  });

  test("GET /api/agents lists markdown agents", async () => {
    const res = await app.request("/api/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items[0].name).toBe("demo-agent");
    destId = body.data.destinations[0].id;
    expect(body.data.destinations[0].path).toBe(dest);
  });

  test("POST enable then disable creates and removes a file symlink", async () => {
    const enabled = await app.request("/api/agents/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo-agent", destinationId: destId }),
    });
    expect(enabled.status).toBe(200);
    expect(lstatSync(join(dest, "demo-agent.md")).isSymbolicLink()).toBe(true);
    const disabled = await app.request("/api/agents/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo-agent", destinationId: destId }),
    });
    expect(disabled.status).toBe(200);
  });
});
