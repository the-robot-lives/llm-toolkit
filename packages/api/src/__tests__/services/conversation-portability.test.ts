import { createConversationPortabilityRoutes } from "../../routes/conversation-portability.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UniversalThread } from "@llm-toolkit/shared";
import { portableConversation, snipConversation, universalMessageText } from "@llm-toolkit/shared";
import { StorageService } from "../../services/storage.ts";
import { ConversationPortabilityService } from "../../services/conversation-portability.ts";
import { claudeConversationAdapter } from "../../services/native/claude.ts";
import { codexConversationAdapter, importCodexConversation } from "../../services/native/codex.ts";
import { validateConversationContent } from "../../services/conversation-validator.ts";

const adapters = { claude: claudeConversationAdapter, codex: codexConversationAdapter };
function thread(id: string, cwd: string, texts = ["Source question", "Source answer"]): UniversalThread {
  return { id, harness: "claude", title: id, sourcePath: "", projectPath: cwd, startedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:02Z", messages: texts.map((text, index) => ({ id: `${id}-${index}`, role: index % 2 ? "assistant" : "user", timestamp: `2026-10-01T00:00:0${index}Z`, content: [{ type: "text", text }] })) };
}

describe("safe native conversation workflow", () => {
  let directory: string; let storage: StorageService; let service: ConversationPortabilityService;
  const paths = new Map<string, string>();
  beforeEach(async () => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "portable-core-")));
    storage = new StorageService(":memory:"); await storage.initialize();
    service = new ConversationPortabilityService(storage, undefined, { homeDir: directory, adapters });
    paths.clear();
    for (const [id, texts] of [["source", ["Source question", "Source answer"]], ["target", ["Target prefix", "Target suffix"]]] as const) {
      const source = thread(id, directory, [...texts]);
      const artifact = claudeConversationAdapter.render(source, { sessionId: id === "source" ? "123e4567-e89b-42d3-a456-426614174000" : "123e4567-e89b-42d3-a456-426614174001", cwd: directory, title: id, createdAt: source.startedAt, sourceHarness: "claude" });
      const path = join(directory, `${id}.jsonl`); writeFileSync(path, artifact.jsonl); paths.set(id, path);
      await storage.upsertConversation({ id, harness: "claude", title: id, projectPath: directory, sourcePath: path, startedAt: source.startedAt, updatedAt: source.updatedAt, messageCount: 2 });
    }
  });
  afterEach(() => { storage?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });

  test("creates an exclusive valid Codex copy plus private universal archive without touching source", async () => {
    const before = readFileSync(paths.get("source")!, "utf8");
    const preview = await service.preview("source", { targetHarness: "codex" });
    expect(preview.report.valid).toBe(true);
    const created = await service.create("source", preview.previewId);
    expect(created.nativeCreated).toBe(true);
    expect(readFileSync(paths.get("source")!, "utf8")).toBe(before);
    expect(created.sourcePath).not.toBe(paths.get("source"));
    expect(statSync(created.sourcePath).mode & 0o777).toBe(0o600);
    expect(statSync(created.universalPath).mode & 0o777).toBe(0o600);
    expect((await validateConversationContent(readFileSync(created.sourcePath, "utf8"), "codex", undefined, adapters)).valid).toBe(true);
    await expect(service.create("source", preview.previewId)).rejects.toThrow("Preview expired");
  });

  test("cross-provider reinsertion preserves target prefix and suffix and both native originals", async () => {
    const target = await service.load("target");
    const source = await service.load("source");
    const section = snipConversation(source, [source.messages[0].id]).document;
    const originalTarget = readFileSync(paths.get("target")!, "utf8");
    const preview = await service.preview("source", { targetHarness: "codex", document: section, insertIntoConversationId: "target", afterMessageId: target.messages[0].id });
    const created = await service.create("source", preview.previewId);
    const result = importCodexConversation(readFileSync(created.sourcePath, "utf8"), created.sourcePath);
    const text = result.messages.flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text)).join("\n");
    expect(text.indexOf("Target prefix")).toBeLessThan(text.indexOf("Source question"));
    expect(text.indexOf("Source question")).toBeLessThan(text.indexOf("Target suffix"));
    expect(readFileSync(paths.get("target")!, "utf8")).toBe(originalTarget);
  });

  test("source and existing-target changes after preview block publication", async () => {
    const preview = await service.preview("source", { targetHarness: "claude", insertIntoConversationId: "target" });
    writeFileSync(paths.get("target")!, readFileSync(paths.get("target")!, "utf8") + "\n");
    await expect(service.create("source", preview.previewId)).rejects.toThrow("changed since");
    expect(readdirSync(directory)).toEqual(expect.arrayContaining(["source.jsonl", "target.jsonl"]));
  });

  test("a colliding native destination remains untouched and our archive/staging files roll back", async () => {
    const preview = await service.preview("source", { targetHarness: "codex" });
    mkdirSync(dirname(preview.sourcePath), { recursive: true }); writeFileSync(preview.sourcePath, "EXISTING FILE");
    await expect(service.create("source", preview.previewId)).rejects.toThrow();
    expect(readFileSync(preview.sourcePath, "utf8")).toBe("EXISTING FILE");
    expect(readdirSync(dirname(preview.sourcePath))).toEqual([preview.sourcePath.split("/").at(-1)]);
  });

  test("unsafe insertion inside a pending target tool exchange is blocked", async () => {
    const target = thread("target", directory);
    target.messages = [
      { id: "call", role: "assistant", timestamp: target.startedAt, content: [{ type: "tool_use", toolCallId: "tool", name: "Read", input: {} }] },
      { id: "result", role: "user", timestamp: target.updatedAt, content: [{ type: "tool_result", toolCallId: "tool", content: "result" }] },
    ];
    const injected = new ConversationPortabilityService(storage, undefined, { homeDir: directory, adapters, readThread: async (_path, _harness) => target });
    await expect(injected.preview("source", { document: portableConversation(target), insertIntoConversationId: "target", afterMessageId: "call" })).rejects.toThrow("splits a tool call");
  });
  test.each(["source", "target"])("rejects %s changes during canonical loading", async (changing) => {
    const { importClaudeConversation } = await import("../../services/native/claude.ts");
    const changingPath = paths.get(changing)!;
    const racing = new ConversationPortabilityService(storage, undefined, { homeDir: directory, adapters, readThread: async (path) => {
      const result = importClaudeConversation(readFileSync(path, "utf8"), path);
      if (path === changingPath) writeFileSync(path, readFileSync(path, "utf8") + "\n");
      return result;
    } });
    await expect(racing.preview("source", { targetHarness: "claude", insertIntoConversationId: "target" })).rejects.toThrow("changed while loading");
  });

  test("reopens associated archive after append-only continuation and rejects changed prefixes", async () => {
    const source = await service.load("source");
    const preview = await service.preview("source", { targetHarness: "codex" });
    const created = await service.create("source", preview.previewId);
    await storage.upsertConversation({ id: "clone", harness: "codex", title: "clone", projectPath: directory, sourcePath: created.sourcePath, startedAt: source.startedAt, updatedAt: source.updatedAt, messageCount: 2 });
    const suffix = codexConversationAdapter.render(thread("later", directory, ["Later question", "Later answer"]), { sessionId: preview.sessionId, cwd: directory, title: "clone", createdAt: "2026-10-02T00:00:00Z", sourceHarness: "claude" });
    writeFileSync(created.sourcePath, readFileSync(created.sourcePath, "utf8") + suffix.jsonl.split("\n").slice(1).join("\n"));
    const reopened = await service.archive("clone");
    expect(reopened.thread.messages.slice(0, source.messages.length)).toEqual(source.messages);
    expect(reopened.thread.messages.slice(source.messages.length).map(message => message.content[0])).toEqual([expect.objectContaining({ type: "text", text: "Later question" }), expect.objectContaining({ type: "text", text: "Later answer" })]);
    writeFileSync(created.sourcePath, "changed prefix");
    await expect(service.archive("clone")).rejects.toThrow("prefix changed");
  });

  test("rich source edits are rejected rather than duplicating tool blocks", async () => {
    const source = thread("rich", directory);
    source.messages[0].content.push({ type: "tool_use", toolCallId: "t", name: "Read", input: { value: "unchanged" } });
    const rich = new ConversationPortabilityService(storage, undefined, { homeDir: directory, adapters, readThread: async () => source });
    await expect(rich.editedDocument("source", [{ originalIndex: 0, role: "user", content: "edited display" }])).rejects.toThrow("Rich messages");
    expect(source.messages[0].content[1]).toEqual({ type: "tool_use", toolCallId: "t", name: "Read", input: { value: "unchanged" } });
  });

  test("actual API selects a native Codex tool section and inserts historical context into a fresh Claude target", async () => {
    const rich = thread("codex-source", directory, ["Tool request", "Tool answer"]); rich.harness = "codex";
    rich.messages.splice(1, 0,
      { id: "call", role: "assistant", timestamp: rich.startedAt, provenance: { harness: "codex", sourcePath: "fixture" }, content: [{ type: "tool_use", toolCallId: "c", name: "exec_command", input: { cmd: "fixture only" }, providerType: "function_call" }] },
      { id: "result", role: "tool", timestamp: rich.startedAt, provenance: { harness: "codex", sourcePath: "fixture" }, content: [{ type: "tool_result", toolCallId: "c", content: "Synthetic tool output", providerType: "function_call_output" }] });
    const native = codexConversationAdapter.render(rich, { sessionId: "123e4567-e89b-42d3-a456-426614174002", cwd: directory, title: "native Codex", createdAt: rich.startedAt, sourceHarness: "codex" });
    const path = join(directory, "codex-source.jsonl"); writeFileSync(path, native.jsonl);
    await storage.upsertConversation({ id: "codex-source", harness: "codex", title: "native Codex", projectPath: directory, sourcePath: path, startedAt: rich.startedAt, updatedAt: rich.updatedAt, messageCount: 4 });
    const source = await service.load("codex-source"); const target = await service.load("target");
    const app = createConversationPortabilityRoutes(service);
    const post = (url: string, body: unknown) => app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const sectionResponse = await post("/codex-source/section", { messageIds: [source.messages.find(message => message.role === "tool")!.id] });
    expect(sectionResponse.status).toBe(200);
    const section = await sectionResponse.json();
    const previewResponse = await post("/codex-source/clone-preview", { targetHarness: "claude", document: section.data.document, insertIntoConversationId: "target", afterMessageId: target.messages[0].id });
    expect(previewResponse.status).toBe(200); const preview = (await previewResponse.json()).data;
    expect(preview.report.valid).toBe(true);
    const sourceBefore = readFileSync(path, "utf8"); const targetBefore = readFileSync(paths.get("target")!, "utf8");
    const createResponse = await post("/codex-source/clone", { previewId: preview.previewId }); expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()).data;
    const { importClaudeConversation } = await import("../../services/native/claude.ts");
    const clone = importClaudeConversation(readFileSync(created.sourcePath, "utf8"), created.sourcePath);
    const text = clone.messages.flatMap(message => message.content.filter(block => block.type === "text").map(block => block.text)).join("\n");
    expect(text.indexOf("Target prefix")).toBeLessThan(text.indexOf("Synthetic tool output")); expect(text.indexOf("Synthetic tool output")).toBeLessThan(text.indexOf("Target suffix"));
    expect(clone.messages.flatMap(message => message.content).some(block => block.type === "tool_use")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(sourceBefore); expect(readFileSync(paths.get("target")!, "utf8")).toBe(targetBefore);
  });

  test("precise text block edits preserve reasoning and closed tool payloads without duplicates", async () => {
    const source = thread("rich", directory);
    source.messages[0].content = [{ type: "text", text: "Before" }, { type: "thinking", thinking: "Opaque reasoning", signature: "original" }, { type: "tool_use", toolCallId: "t", name: "Read", input: { path: "fixture" } }, { type: "text", text: "After" }];
    source.messages[1].content = [{ type: "tool_result", toolCallId: "t", content: "unchanged result" }];
    const rich = new ConversationPortabilityService(storage, undefined, { homeDir: directory, adapters, readThread: async () => source });
    const result = await rich.editedDocument("source", [{ originalIndex: 0, role: "user", content: "display only", universalMessage: source.messages[0], textBlockEdits: [{ index: 0, text: "Edited before" }, { index: 3, text: "Edited after" }] }, { originalIndex: 1, role: "assistant", content: universalMessageText(source.messages[1]), universalMessage: source.messages[1] }]);
    expect(result.thread.messages[0].content).toEqual([{ type: "text", text: "Edited before" }, ...source.messages[0].content.slice(1, 3), { type: "text", text: "Edited after" }]);
    expect(source.messages[0].content[0]).toEqual({ type: "text", text: "Before" });
    await expect(rich.editedDocument("source", [{ originalIndex: 0, role: "user", content: "bad", universalMessage: source.messages[0], textBlockEdits: [{ index: 2, text: "not text" }] }])).rejects.toThrow("Invalid structured");
  });

  test("summary originals survive native reopen and restore instead of returning the summary", async () => {
    const source = await service.load("source");
    const edited = await service.editedDocument("source", [{ role: "assistant", content: "[Generated summary] concise", compactionOriginals: source.messages.map((message, index) => ({ originalIndex: index, role: message.role, content: "original display", universalMessage: message })) }]);
    const preview = await service.preview("source", { targetHarness: "codex", document: edited });
    const created = await service.create("source", preview.previewId);
    await storage.upsertConversation({ id: "summary-clone", harness: "codex", title: "summary", projectPath: directory, sourcePath: created.sourcePath, startedAt: source.startedAt, updatedAt: source.updatedAt, messageCount: 1 });
    expect(importCodexConversation(readFileSync(created.sourcePath, "utf8"), created.sourcePath).messages).toHaveLength(1);
    expect((await service.archive("summary-clone")).thread.messages).toEqual(source.messages);
  });

});
