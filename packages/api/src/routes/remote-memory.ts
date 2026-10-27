import { Hono } from "hono";
import { RemoteMemoryService } from "../services/remote-memory.ts";

export function createRemoteMemoryRoutes(service = new RemoteMemoryService()) {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const url = new URL(c.req.url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return c.json({ error: "Memory login is available only on this computer." }, 403);
    if (c.req.method !== "GET") {
      const origin = c.req.header("Origin");
      if (!origin || ![url.origin, "http://localhost:5173", "http://127.0.0.1:5173"].includes(origin)) return c.json({ error: "Untrusted request origin" }, 403);
      if (!c.req.header("Content-Type")?.startsWith("application/json")) return c.json({ error: "JSON required" }, 415);
    }
    await next();
  });
  routes.get("/status", (c) => c.json(service.status()));
  routes.post("/oauth/start", async (c) => {
    try {
      const body = await c.req.json<{ writeEnabled?: boolean }>();
      const port = Number(new URL(c.req.url).port) || 3100;
      return c.json(await service.startLogin(port, body.writeEnabled === true));
    } catch { return c.json({ error: "Could not start therobot.is login. Check your connection and try again." }, 502); }
  });
  routes.get("/oauth/callback", async (c) => {
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    c.header("Referrer-Policy", "no-referrer");
    try {
      if (c.req.query("error") || !c.req.query("code")) throw new Error("Not authorized");
      await service.finishLogin(c.req.query("code")!, c.req.query("state") ?? "");
      return c.html("<!doctype html><html><title>Memory connected</title><body><h1>Connected to therobot.is</h1><p>Return to LLM Toolkit. You can close this window.</p></body></html>");
    } catch { return c.html("<!doctype html><html><title>Login incomplete</title><body><h1>Login was not completed</h1><p>Return to LLM Toolkit and choose Connect again.</p></body></html>", 400); }
  });
  routes.post("/disconnect", async (c) => { await service.disconnect(); return c.json(service.status()); });
  routes.post("/test", async (c) => {
    try { await service.call("graph_subgraph", { limit: 1 }); return c.json({ ok: true }); }
    catch { return c.json({ error: "Could not access memories. Check your connection or sign in again." }, 502); }
  });
  routes.get("/memories", async (c) => {
    try { return c.json({ data: await service.call("graph_subgraph", { limit: 100, min_weight: 0 }) }); }
    catch { return c.json({ error: "Could not load memories. Sign in or reconnect to therobot.is." }, 502); }
  });
  routes.post("/search", async (c) => {
    const body = await c.req.json<{ query?: string }>();
    if (!body.query?.trim() || body.query.length > 10_000) return c.json({ error: "Enter a search query (up to 10,000 characters)." }, 400);
    try { return c.json({ data: await service.call("recall_preview", { query: body.query.trim(), limit: 30 }) }); }
    catch { return c.json({ error: "Could not search memories. Check your connection and account permissions." }, 502); }
  });
  routes.post("/memories", async (c) => {
    const body = await c.req.json<{ content?: string; summary?: string; context?: string }>();
    if (!body.content?.trim() || body.content.length > 100_000) return c.json({ error: "Enter memory content (up to 100,000 characters)." }, 400);
    try { return c.json({ data: await service.call("remember", { content: body.content.trim(), summary: body.summary, context: body.context }) }); }
    catch { return c.json({ error: "Could not save memory. Reconnect with memory editing enabled and try again." }, 502); }
  });
  routes.post("/memories/:id/:action", async (c) => {
    const id = c.req.param("id");
    const action = c.req.param("action");
    if (!/^[0-9a-f-]{36}$/i.test(id) || !["pin", "unpin"].includes(action)) return c.json({ error: "Invalid memory action" }, 400);
    try {
      return c.json({ data: await service.call("memory_set", { memory_id: id, pinned: action === "pin" }) });
    } catch { return c.json({ error: "Could not update memory. Check your connection and editing permission." }, 502); }
  });
  return routes;
}
