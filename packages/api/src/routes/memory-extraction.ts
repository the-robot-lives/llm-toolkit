import { Hono } from "hono";
import type { MemoryExtractionService } from "../services/memory-extraction.ts";

const safeErrors = ["An operation is already running", "Review draft already exists", "Conversation not found", "Choose a configured", "No conversational text", "Connect to therobot.is", "This review draft has changed", "This review belongs", "Invalid review draft", "Invalid memory", "Invalid emotional", "Invalid candidate", "Unknown memory"];
export function createMemoryExtractionRoutes(service: MemoryExtractionService) {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const url = new URL(c.req.url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return c.json({ error: "Memory review is available only on this computer." }, 403);
    if (c.req.method !== "GET") {
      const origin = c.req.header("Origin");
      if (!origin || ![url.origin, "http://localhost:5173", "http://127.0.0.1:5173"].includes(origin)) return c.json({ error: "Untrusted request origin" }, 403);
      if (!c.req.header("Content-Type")?.startsWith("application/json")) return c.json({ error: "JSON required" }, 415);
    }
    await next();
  });
  routes.get("/:id", (c) => c.json({ data: service.get(c.req.param("id")) }));
  routes.post("/:id/scan", async (c) => {
    const body = await c.req.json().catch(() => null) as { profileId?: unknown; replaceDraftId?: unknown } | null;
    if (!body || typeof body.profileId !== "string" || (body.replaceDraftId !== undefined && typeof body.replaceDraftId !== "string")) return c.json({ error: "Choose a configured LLM profile." }, 400);
    try { return c.json({ data: await service.scan(c.req.param("id"), body.profileId, body.replaceDraftId as string | undefined) }); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      return safeErrors.some((prefix) => message.startsWith(prefix)) ? c.json({ error: message }, 409) : c.json({ error: "Could not extract memories. Check the selected LLM profile and try again. The previous review has been retained." }, 502);
    }
  });
  routes.post("/:id/commit", async (c) => {
    const body = await c.req.json().catch(() => null) as { draftId?: unknown; candidates?: unknown } | null;
    if (!body || typeof body.draftId !== "string") return c.json({ error: "A review draft is required." }, 400);
    try { return c.json({ data: await service.commit(c.req.param("id"), body.draftId, body.candidates) }); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      return safeErrors.some((prefix) => message.startsWith(prefix)) ? c.json({ error: message }, 400) : c.json({ error: "Could not commit memories. Your review draft has been retained." }, 502);
    }
  });
  return routes;
}
