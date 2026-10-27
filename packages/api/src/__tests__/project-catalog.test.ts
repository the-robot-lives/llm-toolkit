import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
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
      worktrees: async root => root === main ? [main, `${main}/.git`, tree, `${main}/.claude/worktrees/unused`] : [],
    });
    const group = (await catalog.list()).find(project => project.projectPath === "tobor:robot/toolkit")!;
    expect(group.conversationCount).toBe(3);
    expect(group.locations.some(location => location.path === `${main}/.git`)).toBe(false);
    expect(group.locations.find(location => location.path === tree)).toMatchObject({ isWorktree: true, title: "In-progress feature", tags: ["feature"] });
    expect((await storage.getProjectMeta(tree))!.title).toBe("In-progress feature");
    const conversations = createConversationRoutes(storage, undefined, undefined, catalog);
    const response = await conversations.request("/?project=" + encodeURIComponent(group.projectPath));
    const result = await response.json();
    expect(result.meta.total).toBe(3); expect(result.data.map((item: { id: string }) => item.id).sort()).toEqual(["main", "site", "tree"]);
    const unknown = await (await conversations.request("/?project=tobor%3Arobot%2Funknown")).json();
    expect(unknown.meta.total).toBe(0); expect(unknown.data).toEqual([]);
    const legacy = await createProjectRoutes(storage, catalog).request("/" + encodeURIComponent(tree));
    expect(await legacy.json()).toMatchObject({ title: "In-progress feature", lastActive: "2026-10-27", conversationCount: 1 });
  });
  test("does not collapse unrelated repos into inherited global or monorepo defaults", async () => {
    await conversation("one", "/one"); await conversation("two", "/two");
    const catalog = new ProjectCatalog(storage, { resolveScope: async root => ({ ...scope(root), project: { value: "infrastructure", from: "/parent/.agent-kit.yaml" } }), inventory: async () => ({}), worktrees: async () => [] });
    expect((await catalog.list()).map(project => project.projectPath).sort()).toEqual(["/one", "/two"]);
  });
  test("groups known worktrees of an unmapped repository without assigning an inherited project", async () => {
    const root = "/unmapped/repository"; const tree = `${root}/.claude/worktrees/task`;
    await conversation("base", root); await conversation("task", tree);
    const catalog = new ProjectCatalog(storage, { resolveScope: async path => ({ ...scope(root), repo_root: path, project: { value: "infrastructure", from: "parent:/monorepo/.agent-kit.yaml" } }), inventory: async () => ({}), worktrees: async () => [root, tree] });
    const rows = await catalog.list();
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ projectPath: root, scope: null, conversationCount: 2 });
    expect(rows[0].locations.find(location => location.path === tree)?.isWorktree).toBe(true);
    const routes = createConversationRoutes(storage, undefined, undefined, catalog);
    const result = await (await routes.request("/?project=" + encodeURIComponent(root))).json();
    expect(result.meta.total).toBe(2);
  });

  test("reuses canonical scope only when a conventional worktree has no explicit override", async () => {
    const root = join(dir, "repo"); const plain = join(root, ".claude/worktrees/plain"); const overridden = join(root, ".claude/worktrees/overridden"); const registered = join(root, ".claude/worktrees/registered");
    for (const tree of [plain, overridden, registered]) {
      mkdirSync(tree, { recursive: true }); const gitdir = join(dir, tree === plain ? "plain-git" : tree === overridden ? "override-git" : "registry-git"); mkdirSync(gitdir);
      writeFileSync(join(tree, ".git"), `gitdir: ${gitdir}\n`);
      if (tree === overridden) writeFileSync(join(gitdir, "agent-kit.yaml"), "project: private-project\n");
      if (tree === registered) { mkdirSync(join(tree, ".agent-kit")); writeFileSync(join(tree, ".agent-kit/projects.tsv"), "github.com/robot/repo\trobot\tregistry-project\n"); }
    }
    await conversation("base", root);
    const resolveScope = vi.fn(async (path: string) => path === overridden || path === registered ? { ...scope(root, path === overridden ? "private-project" : "registry-project"), repo_root: path } : scope(root));
    const catalog = new ProjectCatalog(storage, { resolveScope, inventory: async () => ({}), worktrees: async () => [root, plain, overridden, registered] });
    const groups = await catalog.list();
    expect(groups.find(project => project.scope?.project === "toolkit")?.locations.some(location => location.path === plain)).toBe(true);
    expect(groups.find(project => project.scope?.project === "private-project")?.locations[0].path).toBe(overridden);
    expect(resolveScope).not.toHaveBeenCalledWith(plain);
    expect(resolveScope).toHaveBeenCalledWith(overridden);
    expect(resolveScope).toHaveBeenCalledWith(registered);
    expect(groups.find(project => project.scope?.project === "registry-project")?.locations[0].path).toBe(registered);
  });

  test("never promotes an indexed private worktree scope into its unindexed canonical checkout", async () => {
    const root = join(dir, "repo"); const plain = join(root, ".claude/worktrees/plain"); const overridden = join(root, ".claude/worktrees/private");
    for (const tree of [plain, overridden]) {
      mkdirSync(tree, { recursive: true }); const gitdir = join(dir, tree === plain ? "plain-git" : "private-git"); mkdirSync(gitdir); writeFileSync(join(tree, ".git"), `gitdir: ${gitdir}\n`);
      if (tree === overridden) writeFileSync(join(gitdir, "agent-kit.yaml"), "project: private-project\n");
    }
    await conversation("private-task", overridden);
    const resolveScope = vi.fn(async (path: string) => ({ ...scope(root, path === overridden ? "private-project" : "canonical-project"), repo_root: path }));
    const catalog = new ProjectCatalog(storage, { resolveScope, inventory: async () => ({}), worktrees: async () => [root, plain, overridden] });
    const groups = await catalog.list();
    expect(resolveScope).toHaveBeenCalledWith(realpathSync(root));
    const canonical = groups.find(project => project.scope?.project === "canonical-project")!;
    expect(canonical.locations.map(location => location.path).sort()).toEqual([realpathSync(root), plain].sort());
    expect(canonical.conversationCount).toBe(0);
    const privateProject = groups.find(project => project.scope?.project === "private-project")!;
    expect(privateProject.locations.map(location => location.path)).toEqual([overridden]);
    expect(privateProject.conversationCount).toBe(1);
  });

});
