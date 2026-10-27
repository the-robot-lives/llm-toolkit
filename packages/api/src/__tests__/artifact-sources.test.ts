import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, rmSync, symlinkSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { StorageService } from "../services/storage.ts";
import { createConfigRoutes, loadConfig } from "../routes/config.ts";
import { createArtifactRoutes } from "../routes/artifacts.ts";
import { createSkillCatalog, previewSkillCatalog, scanSkills } from "../services/skills.ts";
import { scanArtifacts } from "../services/artifacts.ts";

let root: string, storage: StorageService;
const headers = { Origin: "http://localhost:3100", "Content-Type": "application/json" };
function skill(parent: string, name: string, description = "A nested package") {
  const path = join(parent, name); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n# ${name}\n`);
  return path;
}
beforeEach(async () => { root = mkdtempSync(join(tmpdir(), "artifact-sources-")); storage = new StorageService(join(root, "test.db")); await storage.initialize(); });
afterEach(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
function app() {
  const app = new Hono();
  app.route("/api/config", createConfigRoutes(storage, { reconfigure: async () => {}, setProfiles: () => {} } as never, () => []));
  app.route("/api/skills", createArtifactRoutes(storage, "skills"));
  app.route("/api/agents", createArtifactRoutes(storage, "agents"));
  app.route("/api/commands", createArtifactRoutes(storage, "commands"));
  return app;
}

describe("artifact source settings", () => {
  test("saves separate ordered roots, deduplicates aliases, and preserves raw secrets/extras and installed links", async () => {
    const first = join(root, "first"), second = join(root, "second"); mkdirSync(first); mkdirSync(second);
    const alias = join(root, "alias"); symlinkSync(first, alias);
    const installed = join(root, "installed"); symlinkSync(first, installed);
    const oauth = join(root, "memory-oauth.json"); writeFileSync(oauth, "fixture-grant-unchanged");
    const raw = { indexPaths: ["/existing"], embedding: { provider: "local", customEmbeddingField: 9 }, llmProfiles: [{ id: "provider", name: "Provider", provider: "openai-compatible", model: "model", apiKey: "fixture-secret", customProfileField: "keep" }], skills: { sourceFolders: [], providers: ["codex"], customSkillField: { preserve: true } }, agents: { sourceFolders: [], extra: "agent-extra" }, unrelated: { custom: true } };
    storage.setSetting("app_config", JSON.stringify(raw));
    const api = app();
    const response = await api.request("http://localhost:3100/api/config/artifact-sources", { method: "PATCH", headers, body: JSON.stringify({ skills: [first, alias, second], agents: [second], commands: [first, second] }) });
    expect(response.status).toBe(200);
    const result = JSON.parse(storage.getSetting("app_config")!);
    expect(result.skills.sourceFolders).toEqual([realpathSync(first), realpathSync(second)]);
    expect(result.skills.customSkillField).toEqual(raw.skills.customSkillField);
    expect(result.llmProfiles).toEqual(raw.llmProfiles); expect(result.unrelated).toEqual(raw.unrelated); expect(result.embedding).toEqual(raw.embedding);
    expect(result.agents.extra).toBe("agent-extra"); expect(result.commands.sourceFolders).toHaveLength(2);
    expect((loadConfig(storage).skills as unknown as Record<string, unknown>).customSkillField).toEqual(raw.skills.customSkillField);
    await api.request("http://localhost:3100/api/config/artifact-sources", { method: "PATCH", headers, body: '{"skills":[]}' });
    expect(lstatSync(installed).isSymbolicLink()).toBe(true); expect(existsSync(first)).toBe(true); expect(readFileSync(oauth, "utf8")).toBe("fixture-grant-unchanged");
    const rejected = await api.request("http://localhost:3100/api/config/artifact-sources", { method: "PATCH", headers, body: '{"skills":["relative/path"]}' });
    expect(rejected.status).toBe(400);
    const foreign = await api.request("http://localhost:3100/api/config/artifact-sources", { method: "PATCH", headers: { ...headers, Origin: "https://foreign.example" }, body: '{"skills":[]}' });
    expect(foreign.status).toBe(403);
  });
  test("an old general Settings snapshot cannot revert newer source lists or newly added source metadata", async () => {
    const a = join(root, "a"), b = join(root, "b"); mkdirSync(a); mkdirSync(b);
    storage.setSetting("app_config", JSON.stringify({ skills: { sourceFolders: [a], providers: ["claude"], custom: "kept" } }));
    const api = app(); const previous = (await (await api.request("http://localhost:3100/api/config")).json()).data;
    await api.request("http://localhost:3100/api/config/artifact-sources", { method: "PATCH", headers, body: JSON.stringify({ skills: [b] }) });
    const latest = JSON.parse(storage.getSetting("app_config")!); latest.skills.addedByUser = { preserved: true }; storage.setSetting("app_config", JSON.stringify(latest));
    previous.embedding.model = "updated-model";
    const saved = await api.request("http://localhost:3100/api/config", { method: "PATCH", headers, body: JSON.stringify(previous) });
    expect(saved.status).toBe(200);
    const result = JSON.parse(storage.getSetting("app_config")!);
    expect(result.skills.sourceFolders).toEqual([realpathSync(b)]); expect(result.skills.addedByUser).toEqual({ preserved: true }); expect(result.skills.custom).toBe("kept"); expect(result.embedding.model).toBe("updated-model");
  });
  test("saved root changes affect each catalog immediately without touching existing target links", async () => {
    const lists: Record<string, string[]> = {};
    for (const kind of ["skills", "agents", "commands"]) {
      const a = join(root, `${kind}-a`), b = join(root, `${kind}-b`); mkdirSync(a); mkdirSync(b); lists[kind] = [a, b];
      if (kind === "skills") { skill(join(a, "nested"), "first"); skill(join(b, "nested"), "second"); }
      else { writeFileSync(join(a, "first.md"), "# First"); writeFileSync(join(b, "second.md"), "# Second"); }
    }
    const installed = join(root, "existing-link"); symlinkSync(lists.skills[0], installed);
    const api = app();
    const saved = await api.request("http://localhost:3100/api/config/artifact-sources", { method: "PATCH", headers, body: JSON.stringify(lists) }); expect(saved.status).toBe(200);
    for (const kind of ["skills", "agents", "commands"]) {
      const result = await (await api.request(`http://localhost:3100/api/${kind}`)).json();
      expect(result.data.skills.map((item: { name: string }) => item.name)).toEqual(["first", "second"]);
    }
    await api.request("http://localhost:3100/api/config/artifact-sources", { method: "PATCH", headers, body: JSON.stringify({ skills: [lists.skills[1]] }) });
    const after = await (await api.request("http://localhost:3100/api/skills")).json(); expect(after.data.skills.map((item: { name: string }) => item.name)).toEqual(["second"]);
    expect(lstatSync(installed).isSymbolicLink()).toBe(true); expect(existsSync(lists.skills[0])).toBe(true);
  });
  test("displayed source guards reject concurrent reorders and fresh views select the new winner for all kinds", async () => {
    const api = app();
    for (const kind of ["skills", "agents", "commands"] as const) {
      const a = join(root, kind, "a"), b = join(root, kind, "b"); mkdirSync(a, { recursive: true }); mkdirSync(b);
      if (kind === "skills") { skill(a, "shared"); skill(b, "shared"); }
      else { writeFileSync(join(a, "shared.md"), "# A"); writeFileSync(join(b, "shared.md"), "# B"); }
      const current = JSON.parse(storage.getSetting("app_config") ?? "{}");
      current[kind] = { sourceFolders: [a, b], providers: ["claude"], globalEnabled: false, projectRoots: [join(root, "project")] };
      storage.setSetting("app_config", JSON.stringify(current));
      const before = (await (await api.request(`http://localhost:3100/api/${kind}`)).json()).data;
      const displayed = before.items[0]; const destination = before.destinations[0];
      await api.request("http://localhost:3100/api/config/artifact-sources", { method: "PATCH", headers, body: JSON.stringify({ [kind]: [b, a] }) });
      const stale = await api.request(`http://localhost:3100/api/${kind}/apply`, { method: "POST", headers, body: JSON.stringify({ name: "shared", expectedSource: displayed.path, enabled: true, destinationIds: [destination.id] }) });
      expect(stale.status).toBe(409);
      const target = join(destination.path, kind === "skills" ? "shared" : "shared.md"); expect(existsSync(target)).toBe(false);
      const fresh = (await (await api.request(`http://localhost:3100/api/${kind}`)).json()).data.items[0];
      const applied = await api.request(`http://localhost:3100/api/${kind}/apply`, { method: "POST", headers, body: JSON.stringify({ name: "shared", expectedSource: fresh.path, enabled: true, destinationIds: [destination.id] }) });
      expect(applied.status).toBe(200); expect(realpathSync(target)).toBe(fresh.path);
      await api.request("http://localhost:3100/api/config/artifact-sources", { method: "PATCH", headers, body: JSON.stringify({ [kind]: [a] }) });
      expect(lstatSync(target).isSymbolicLink()).toBe(true); expect(realpathSync(target)).toBe(fresh.path);
      const active = (await (await api.request(`http://localhost:3100/api/${kind}`)).json()).data.items[0];
      const conflict = await api.request(`http://localhost:3100/api/${kind}/apply`, { method: "POST", headers, body: JSON.stringify({ name: "shared", expectedSource: active.path, enabled: true, destinationIds: [destination.id] }) });
      expect(conflict.status).toBe(409); expect(realpathSync(target)).toBe(fresh.path);
    }
  });
  test("legacy nested discovery works before catalogs, reports conflicting names and honors source order", () => {
    const first = join(root, "first"), second = join(root, "second");
    const chosen = skill(join(first, "category", "deeper"), "shared"); skill(join(second, "other"), "shared");
    const alias = join(root, "alias"); symlinkSync(first, alias);
    const catalog = scanSkills({ sourceFolders: [first, alias, second], globalEnabled: false });
    expect(catalog.sources).toHaveLength(2); expect(catalog.skills).toHaveLength(1);
    expect(catalog.skills[0].path).toBe(realpathSync(chosen)); expect(catalog.skills[0].alternatives).toHaveLength(1);
    expect(catalog.sources[1].warnings?.[0]).toContain("first source wins");
    for (const source of [first, second]) writeFileSync(join(source, "agent.md"), "---\nname: agent\n---\n# Agent");
    const agents = scanArtifacts("agents", { sourceFolders: [first, alias, second], globalEnabled: false });
    expect(agents.sources).toHaveLength(2); expect(agents.items[0].alternatives).toHaveLength(1); expect(agents.sources[1].warnings?.[0]).toContain("first source wins");
  });
});

describe("catalog preview and exclusive creation", () => {
  test("previews without writes, round-trips metadata, and requires explicit create for configured roots", async () => {
    const source = join(root, "source"); const description = 'Keep "quoted" metadata\nand multiple lines';
    skill(join(source, "category", "deep"), "example", description);
    storage.setSetting("app_config", JSON.stringify({ skills: { sourceFolders: [source] } }));
    const api = app();
    const response = await api.request("http://localhost:3100/api/skills/catalog/preview", { method: "POST", headers, body: JSON.stringify({ root: source }) });
    expect(response.status).toBe(200); const preview = (await response.json()).data;
    expect(preview.entries[0].path).toBe("category/deep/example"); expect(preview.errors).toEqual([]); expect(existsSync(join(source, "catalog.yaml"))).toBe(false);
    const created = await api.request("http://localhost:3100/api/skills/catalog/create", { method: "POST", headers, body: JSON.stringify({ root: source, token: preview.token }) });
    expect(created.status).toBe(201); expect(readFileSync(join(source, "catalog.yaml"), "utf8")).toBe(preview.yaml);
    const scan = scanSkills({ sourceFolders: [source], globalEnabled: false }); expect(scan.skills[0].description).toBe(description); expect(scan.sources[0].warnings).toEqual([]);
    const repeated = await api.request("http://localhost:3100/api/skills/catalog/create", { method: "POST", headers, body: JSON.stringify({ root: source, token: preview.token }) });
    expect(repeated.status).toBe(409); expect(readFileSync(join(source, "catalog.yaml"), "utf8")).toBe(preview.yaml);
    const unknown = await api.request("http://localhost:3100/api/skills/catalog/preview", { method: "POST", headers, body: JSON.stringify({ root }) }); expect(unknown.status).toBe(403);
  });
  test("rejects duplicate names, escapes and stale previews; skips contained cycles safely", () => {
    const source = join(root, "source"); skill(join(source, "a"), "same"); skill(join(source, "b"), "same");
    const duplicate = previewSkillCatalog(source); expect(duplicate.errors.some(error => error.includes("Duplicate skill name"))).toBe(true); expect(() => createSkillCatalog(source, duplicate.token)).toThrow(/Resolve/);
    rmSync(join(source, "b"), { recursive: true }); symlinkSync(source, join(source, "cycle"));
    const clean = previewSkillCatalog(source); expect(clean.errors).toEqual([]); expect(clean.entries).toHaveLength(1);
    skill(join(source, "new"), "another"); expect(() => createSkillCatalog(source, clean.token)).toThrow(/changed/);
    const outside = skill(root, "outside"); symlinkSync(outside, join(source, "escape"));
    const escaped = previewSkillCatalog(source); expect(escaped.errors.some(error => error.includes("Outside-root"))).toBe(true); expect(() => createSkillCatalog(source, escaped.token)).toThrow(/Resolve/);
    expect(existsSync(join(source, "catalog.yaml"))).toBe(false);
  });
  test("discovery depth limits are visible and prevent incomplete catalog creation", () => {
    const source = join(root, "source"); skill(source, "visible");
    const deep = join(source, ...Array.from({ length: 35 }, (_, index) => `level-${index}`)); skill(deep, "too-deep");
    const preview = previewSkillCatalog(source);
    expect(preview.errors.some(error => error.includes("Results are incomplete"))).toBe(true);
    expect(() => createSkillCatalog(source, preview.token)).toThrow(/Resolve/);
    expect(existsSync(join(source, "catalog.yaml"))).toBe(false);
  });
  test("never replaces an existing or broken-symlink catalog", () => {
    const source = join(root, "source"); skill(source, "example");
    symlinkSync(join(root, "missing.yaml"), join(source, "catalog.yaml"));
    expect(() => previewSkillCatalog(source)).toThrow(/already exists/); expect(lstatSync(join(source, "catalog.yaml")).isSymbolicLink()).toBe(true);
    rmSync(join(source, "catalog.yaml")); writeFileSync(join(source, "catalog.yml"), "existing user data");
    expect(() => previewSkillCatalog(source)).toThrow(/already exists/); expect(readFileSync(join(source, "catalog.yml"), "utf8")).toBe("existing user data");
  });
});
