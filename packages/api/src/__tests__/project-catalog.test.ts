import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StorageService } from "../services/storage.ts";
import { ProjectCatalog, type RepositoryScope } from "../services/project-catalog.ts";
import { createProjectRoutes } from "../routes/projects.ts";
import { createConversationRoutes } from "../routes/conversations.ts";
let dir: string;
let storage: StorageService;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "project-catalog-")); storage = new StorageService(join(dir, "index.db")); await storage.initialize(); });
afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });
async function conversation(id: string, path: string) {
  await storage.upsertConversation({ id, projectPath: path, title: id, startedAt: "2026-10-01", updatedAt: "2026-10-27", messageCount: 0, sourcePath: `/source/${id}.jsonl` });
}
function scope(root: string, project = "toolkit"): RepositoryScope {
  return { org: { value: "robot", from: "registry:/workspace/.agent-kit/projects.tsv" }, project: { value: project, from: "registry:/workspace/.agent-kit/projects.tsv" }, repo_root: root, canonical_root: root, common_dir: `${root}/.git`, remote: `github.com/robot/${root.split("/").at(-1)}` };
}
describe("scoped project catalog", () => {
  test("groups related repositories and worktrees without changing source metadata, and filters aggregate conversations", async () => {
    const main = "/work/toolkit"; const tree = "/work/toolkit/.claude/worktrees/feature"; const site = "/work/toolkit-site";
    await conversation("main", main); await conversation("tree", tree); await conversation("site", site); await conversation("other", "/work/other");
    await storage.upsertProjectMeta({ projectPath: tree, title: "In-progress feature", tags: ["feature"] });
    const catalog = new ProjectCatalog(storage, {
      resolveScope: async path => path === tree ? { ...scope(main), repo_root: tree } : scope(path, path.endsWith("other") ? "other" : "toolkit"),
      inventory: async () => ({ repositories: [] }),
      worktrees: async root => root === main ? [main, tree, `${main}/.claude/worktrees/unused`] : [],
    });
    const group = (await catalog.list()).find(project => project.projectPath === "tobor:robot/toolkit")!;
    expect(group.conversationCount).toBe(3);
    expect(group.locations.find(location => location.path === tree)).toMatchObject({ isWorktree: true, title: "In-progress feature", tags: ["feature"] });
    expect((await storage.getProjectMeta(tree))!.title).toBe("In-progress feature");
    const conversations = createConversationRoutes(storage, undefined, undefined, catalog);
    const response = await conversations.request("/?project=" + encodeURIComponent(group.projectPath));
    const result = await response.json();
    expect(result.meta.total).toBe(3); expect(result.data.map((item: { id: string }) => item.id).sort()).toEqual(["main", "site", "tree"]);
    const unknown = await (await conversations.request("/?project=tobor%3Arobot%2Funknown")).json();
    expect(unknown.meta.total).toBe(0); expect(unknown.data).toEqual([]);
    const legacy = await createProjectRoutes(storage, catalog).request("/" + encodeURIComponent(tree));
    expect((await legacy.json()).title).toBe("In-progress feature");
  });
  test("does not collapse unrelated repos into inherited global or monorepo defaults", async () => {
    await conversation("one", "/one"); await conversation("two", "/two");
    const catalog = new ProjectCatalog(storage, { resolveScope: async root => ({ ...scope(root), project: { value: "infrastructure", from: "/parent/.agent-kit.yaml" } }), inventory: async () => ({}), worktrees: async () => [] });
    expect((await catalog.list()).map(project => project.projectPath).sort()).toEqual(["/one", "/two"]);
  });
});
