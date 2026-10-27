import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UniversalThread } from "@llm-toolkit/shared";
import { portableConversation, snipConversation } from "@llm-toolkit/shared";
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
});
