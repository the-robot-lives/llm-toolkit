import { Hono } from "hono";
import { serializeClaudeJsonl } from "../services/native/claude.ts";
import { conversationMarkdown } from "@llm-toolkit/shared";
import type { AgentHarness, EditedMessage, UniversalContentBlock, UniversalMessage } from "@llm-toolkit/shared";
import { ConversationPortabilityService, type ConversationCloneRequest } from "../services/conversation-portability.ts";
import { nativeConversationAdapters, validateConversationContent } from "../services/conversation-validator.ts";

const targets = new Set(["claude", "codex", "gemini", "opencode", "aider", "other", "universal"]);

export function createConversationPortabilityRoutes(service: ConversationPortabilityService): Hono {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    if (c.req.method !== "GET") {
      const origin = c.req.header("Origin");
      if (origin) {
        try { if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) return c.json({ error: "Conversation changes are only available from this computer" }, 403); }
        catch { return c.json({ error: "Invalid request origin" }, 403); }
      }
    }
    await next();
  });
  routes.get("/format-capabilities", async (c) => {
    const adapters = await nativeConversationAdapters();
    return c.json({ data: { universalVersion: 1, targets: ["claude", "codex", "gemini", "opencode", "aider", "other"].map((harness) => ({ harness, native: Boolean(adapters[harness as "claude" | "codex" | "gemini"]), compatibilityVersion: adapters[harness as "claude" | "codex" | "gemini"]?.compatibilityVersion ?? "unsupported", destinations: harness === "claude" || harness === "codex" || harness === "gemini" ? service.destinations(harness) : [] })) } });
  });
  routes.post("/validate", async (c) => {
    try {
      const body = await c.req.json() as { content?: unknown; target?: string };
      if (typeof body.content !== "string" || !targets.has(body.target ?? "")) return c.json({ error: "Provide conversation content and a known validator target" }, 400);
      return c.json({ data: await validateConversationContent(body.content, body.target as AgentHarness | "universal") });
    } catch { return c.json({ error: "Invalid validation request" }, 400); }
  });
  routes.post("/format-jsonl", async (c) => {
    try {
      const body = await c.req.json() as { content?: string; target?: string };
      if (typeof body.content !== "string" || body.content.length > 50_000_000 || !targets.has(body.target ?? "")) return c.json({ error: "Provide at most 50 MB and a known target" }, 400);
      const records = body.content.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => { try { return JSON.parse(line); } catch { throw new Error(`Invalid JSON at line ${index + 1}; no content was changed`); } });
      const content = body.target === "claude" ? serializeClaudeJsonl(records) : records.map((record) => JSON.stringify(record)).join("\n") + "\n";
      return c.json({ data: { content, report: await validateConversationContent(content, body.target as AgentHarness | "universal") } });
    } catch (error) { return c.json({ error: error instanceof SyntaxError ? "Invalid formatting request" : error instanceof Error ? error.message : "Formatting failed" }, 400); }
  });
  routes.get("/:id/archive", async (c) => {
    try { return c.json({ data: await service.archive(c.req.param("id")) }); }
    catch { return c.json({ error: "No associated archive is available, or its native prefix changed. Originals remain unchanged." }, 409); }
  });
  routes.get("/:id/universal", async (c) => {
    try { const thread = await service.load(c.req.param("id")); if (c.req.query("raw") !== "true") delete thread.rawEvents; return c.json({ data: thread, meta: { total: thread.messages.length } }); }
    catch (error) { return failure(c, error); }
  });
  routes.get("/:id/thread", async (c) => {
    try { const thread = await service.load(c.req.param("id")); return c.json({ data: thread.messages.map(displayRecord), meta: { total: thread.messages.length } }); }
    catch (error) { return failure(c, error); }
  });
  routes.get("/:id/validate", async (c) => {
    try { const target = c.req.query("target"); if (target && (!targets.has(target) || target === "universal")) return c.json({ error: "Choose a native target" }, 400); return c.json({ data: await service.validateSource(c.req.param("id"), target as AgentHarness | undefined) }); }
    catch (error) { return failure(c, error); }
  });
  routes.post("/:id/section", async (c) => {
    try { const body = await c.req.json() as { messageIds?: string[] }; return c.json({ data: await service.section(c.req.param("id"), body.messageIds) }); }
    catch (error) { return failure(c, error); }
  });
  routes.post("/:id/format", async (c) => {
    try {
      const body = await c.req.json() as ConversationCloneRequest & { format?: string };
      if (body.format === "native") return c.json({ data: await service.preview(c.req.param("id"), body) });
      const result = await service.section(c.req.param("id"), body.messageIds);
      return c.json({ data: { ...result, content: body.format === "markdown" ? conversationMarkdown(result.document) : JSON.stringify(result.document, null, 2), format: body.format === "markdown" ? "markdown" : "universal" } });
    } catch (error) { return failure(c, error); }
  });
  routes.post("/:id/clone-preview", async (c) => {
    try { return c.json({ data: await service.preview(c.req.param("id"), await c.req.json()) }); }
    catch (error) { return failure(c, error); }
  });
  routes.post("/:id/clone", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as ConversationCloneRequest & { previewId?: string };
      if (!body.previewId) return c.json({ data: { ...await service.preview(c.req.param("id"), body), requiresApproval: true } });
      return c.json({ data: await service.create(c.req.param("id"), body.previewId) }, 201);
    } catch (error) { return failure(c, error); }
  });
  routes.post("/:id/save-edit", async (c) => {
    try {
      const body = await c.req.json() as { messages?: EditedMessage[]; mode?: string; description?: string; previewId?: string };
      if (body.mode === "overwrite") return c.json({ error: "Native originals are preserved. Save as a new validated thread; in-place history rewrites can invalidate provider indexes." }, 409);
      if (!Array.isArray(body.messages) || !body.messages.length) return c.json({ error: "Provide edited messages" }, 400);
      const document = await service.editedDocument(c.req.param("id"), body.messages);
      const preview = await service.preview(c.req.param("id"), { document, title: body.description });
      return c.json({ data: { ...preview, requiresApproval: true } });
    } catch (error) { return failure(c, error); }
  });
  routes.post("/:id/edit-document", async (c) => {
    try { const body = await c.req.json() as { messages?: EditedMessage[] }; if (!Array.isArray(body.messages)) return c.json({ error: "Provide edited messages" }, 400); return c.json({ data: await service.editedDocument(c.req.param("id"), body.messages) }); }
    catch (error) { return failure(c, error); }
  });
  return routes;
}

function displayRecord(message: UniversalMessage) {
  const raw = message.providerRaw;
  if (raw && typeof raw === "object" && "message" in raw && ["user", "assistant"].includes(String((raw as { type?: string }).type))) return raw;
  return { type: message.role === "assistant" ? "assistant" : "user", uuid: message.id, timestamp: message.timestamp, message: { role: message.role, content: message.content.map(displayBlock) }, originalNativeEvent: raw };
}
function displayBlock(block: UniversalContentBlock): unknown {
  if (block.type === "tool_use") return { type: "tool_use", id: block.toolCallId, name: block.name, input: block.input };
  if (block.type === "tool_result") return { type: "tool_result", tool_use_id: block.toolCallId, content: block.content, is_error: block.isError };
  return block;
}
function failure(c: import("hono").Context, error: unknown) {
  const message = error instanceof SyntaxError ? "Invalid conversation request" : error instanceof Error ? error.message : "Conversation operation failed";
  return c.json({ error: message }, message === "Conversation not found" ? 404 : /^(?:A source conversation changed|The Codex source changed|Preview expired|Structured message changed)/.test(message) ? 409 : 400);
}
