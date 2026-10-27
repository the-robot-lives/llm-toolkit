import { Hono } from "hono";
import type { StorageService } from "../services/storage.ts";
import { ProjectCatalog, deriveProjectName } from "../services/project-catalog.ts";

export function createProjectRoutes(storage: StorageService, catalog = new ProjectCatalog(storage)): Hono {
  const routes = new Hono();
  routes.get("/", async (c) => c.json(await catalog.list()));
  routes.get("/:path", async (c) => {
    const projectPath = c.req.param("path");
    const found = (await catalog.list()).find(project => project.projectPath === projectPath);
    if (found) return c.json(found);
    if (projectPath.startsWith("tobor:")) return c.json({ error: "Project not found" }, 404);
    // Legacy directory links remain readable, even when now included in a scoped project.
    const meta = await storage.getProjectMeta(projectPath);
    return c.json({ projectPath, title: meta?.title ?? null, displayName: meta?.title ?? deriveProjectName(projectPath), description: meta?.description ?? null, tags: meta?.tags ?? [], conversationCount: await storage.getConversationCount(projectPath), lastActive: null, scope: null, locations: [] });
  });
  routes.patch("/:path", async (c) => {
    const projectPath = c.req.param("path");
    const body = await c.req.json<{ title?: string; description?: string; tags?: string[] }>();
    if ((body.title != null && typeof body.title !== "string") || (body.description != null && typeof body.description !== "string") || (body.tags !== undefined && (!Array.isArray(body.tags) || !body.tags.every(tag => typeof tag === "string")))) return c.json({ error: "Invalid project metadata" }, 400);
    await storage.upsertProjectMeta({ projectPath, ...(body.title !== undefined && { title: body.title }), ...(body.description !== undefined && { description: body.description }), ...(body.tags !== undefined && { tags: body.tags }) });
    catalog.invalidate();
    return c.json(await storage.getProjectMeta(projectPath));
  });
  return routes;
}
