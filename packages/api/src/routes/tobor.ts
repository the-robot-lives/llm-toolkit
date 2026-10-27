import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectCatalog } from "../services/project-catalog.ts";
import { Hono } from "hono";
import { ToborService, ToborPermissionError } from "../services/tobor.ts";

const exec = promisify(execFile);

export function createToborRoutes(service = new ToborService(), catalog?: ProjectCatalog) {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const url = new URL(c.req.url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return c.json({ error: "Project login is available only on this computer." }, 403);
    if (c.req.method !== "GET") {
      const origin = c.req.header("Origin");
      if (!origin || ![url.origin, "http://localhost:5173", "http://127.0.0.1:5173"].includes(origin)) return c.json({ error: "Untrusted request origin" }, 403);
      if (!c.req.header("Content-Type")?.startsWith("application/json")) return c.json({ error: "JSON required" }, 415);
    }
    await next();
  });
  routes.get("/status", c => c.json(service.status()));
  routes.post("/oauth/start", async c => {
    try { return c.json(await service.startLogin(Number(new URL(c.req.url).port) || 3100)); }
    catch { return c.json({ error: "Could not start Tobor login. Check your connection and try again." }, 502); }
  });
  routes.get("/oauth/callback", async c => {
    c.header("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    c.header("Referrer-Policy", "no-referrer");
    try {
      if (c.req.query("error") || !c.req.query("code")) throw new Error("Not authorized");
      await service.finishLogin(c.req.query("code")!, c.req.query("state") ?? "");
      return c.html("<!doctype html><title>Projects connected</title><h1>Connected to Tobor</h1><p>Return to LLM Toolkit. You can close this window.</p>");
    } catch { return c.html("<!doctype html><title>Login incomplete</title><h1>Login was not completed</h1><p>Return to LLM Toolkit and choose Connect again.</p>", 400); }
  });
  routes.post("/disconnect", async c => { await service.disconnect(); return c.json(service.status()); });
  routes.post("/link", async c => {
    const body = await c.req.json<{ repositoryPath?: string; projectId?: string; organization?: string }>();
    if (!catalog || typeof body.repositoryPath !== "string" || typeof body.projectId !== "string" || typeof body.organization !== "string") return c.json({ error: "Choose a repository and a Tobor project." }, 400);
    const locations = (await catalog.list()).flatMap(project => project.locations);
    const root = locations.find(location => (location.canonicalRoot ?? location.repositoryRoot) === body.repositoryPath);
    if (!root) return c.json({ error: "Repository is not in the local project catalog." }, 400);
    try {
      const remote = (await service.listProjects(body.organization)).find(project => project.id === body.projectId);
      if (!remote) return c.json({ error: "Project is not accessible through this Tobor connection." }, 403);
      await exec("npl-scope", ["set", "--scope", "repo", "--dir", body.repositoryPath, "--org", remote.organizationSlug, "--project", remote.slug], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      catalog.invalidate();
      return c.json({ ok: true, organization: remote.organizationSlug, project: remote.slug });
    } catch (error) {
      if (error instanceof ToborPermissionError) return c.json({ error: error.message, code: "TOBOR_PERMISSION_REQUIRED" }, 403);
      return c.json({ error: "Could not link this repository. Check Tobor access and repository file permissions." }, 502);
    }
  });
  routes.get("/organizations", async c => {
    try { return c.json({ data: await service.listOrganizations() }); }
    catch (error) {
      if (error instanceof ToborPermissionError) return c.json({ error: error.message, code: "TOBOR_PERMISSION_REQUIRED" }, 403);
      return c.json({ error: "Could not list Tobor organizations. Connect or check Organizations access." }, 502);
    }
  });
  routes.get("/projects", async c => {
    const organization = c.req.query("organization");
    if (!organization) return c.json({ error: "Choose an organization before loading projects." }, 400);
    try { return c.json({ data: await service.listProjects(organization) }); }
    catch (error) {
      if (error instanceof ToborPermissionError) return c.json({ error: error.message, code: "TOBOR_PERMISSION_REQUIRED" }, 403);
      return c.json({ error: "Could not list projects for this organization. Check your Tobor access." }, 502);
    }
  });
  return routes;
}
