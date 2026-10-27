import { describe, expect, it } from "vitest";
import type { NativeConversationContext } from "@llm-toolkit/shared";
import { geminiConversationSnapshot, geminiProjectHash, importGeminiConversation, renderGeminiConversation, resolveGeminiProjectIdentifier, validateGeminiConversation } from "../../services/native/gemini.ts";

const timestamp = "2026-10-27T08:00:00.000Z";
const context: NativeConversationContext = { sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/fixture/destination", title: "Portable test", createdAt: timestamp, sourceHarness: "gemini", geminiProjectIdentifier: "destination" };
const metadata = { sessionId: "22222222-2222-4222-8222-222222222222", projectHash: geminiProjectHash("/fixture/source"), startTime: timestamp, lastUpdated: timestamp, kind: "main" };
const message = (id: string, type: string, content: unknown, extra = {}) => ({ id, type, timestamp, content, ...extra });
const raw = (records: unknown[]) => records.map(r => JSON.stringify(r)).join("\n") + "\n";
const simple = () => [metadata, message("u", "user", "Hello"), message("a", "gemini", [{ text: "Answer" }])];
const codes = (input: string, ctx?: NativeConversationContext) => validateGeminiConversation(input, ctx).issues.map(i => i.code);
const tool = { id: "call-1", name: "read_file", args: { count: 0, offset: -1 }, status: "success", timestamp, result: "result" };

describe("Gemini CLI native conversations", () => {
  it("validates both legacy JSON snapshots and append-only JSONL", () => {
    expect(validateGeminiConversation(raw(simple()))).toMatchObject({ valid: true, complete: true, issues: [] });
    const legacy = JSON.stringify({ ...metadata, messages: simple().slice(1) }, null, 2);
    expect(validateGeminiConversation(legacy)).toMatchObject({ valid: true, complete: true });
    expect(importGeminiConversation(legacy, "/fixture/source.json").messages.map(m => m.role)).toEqual(["user", "assistant"]);
  });
  it("replays updates, removes, reorder, rewind, and legacy compacted snapshots without mutating source", () => {
    const records = [...simple(), message("b", "user", "later"), { $patch: { updates: [{ id: "a", content: "edited" }], removeIds: ["u"], orderIds: ["b", "a"] } }, { $rewindTo: "a" }, message("c", "gemini", "continuation")];
    const original = JSON.stringify(records);
    expect((geminiConversationSnapshot(records).messages as Array<{ id: string }>).map(m => m.id)).toEqual(["b", "c"]);
    expect(JSON.stringify(records)).toBe(original);
    const compacted = [...records, { $set: { messages: [message("summary", "user", "Summary"), message("next", "gemini", "Continue")], lastUpdated: timestamp } }];
    const imported = importGeminiConversation(raw(compacted), "/fixture/source.jsonl");
    expect(imported.messages.map(m => m.providerMessageId)).toEqual(["summary", "next"]);
    expect(imported.rawEvents).toHaveLength(compacted.length);
  });
  it("imports tools, metadata results, token zero/negative values and opaque signatures", () => {
    const records = [metadata, message("u", "user", "Read"), message("a", "gemini", [{ text: "thinking", thought: true, thoughtSignature: "opaque" }, { functionCall: { id: tool.id, name: tool.name, args: tool.args } }], { toolCalls: [tool], tokens: { input: 0, output: -1, cached: 0, total: -1 } })];
    expect(validateGeminiConversation(raw(records)).valid).toBe(true);
    const thread = importGeminiConversation(raw(records), "/fixture/tools.jsonl");
    expect(thread.messages[1].content.map(b => b.type)).toEqual(["thinking", "tool_use"]);
    expect(thread.messages[1].usage).toEqual({ input_tokens: 0, output_tokens: -1, cache_read_input_tokens: 0 });
    expect(thread.messages[2].content[0]).toMatchObject({ type: "tool_result", content: "result", isError: false });
    expect(thread.messages[1].content[1]).toMatchObject({ input: { count: 0, offset: -1 } });
    expect(thread.messages[1].content[0]).toMatchObject({ signature: "opaque" });
  });
  it("does not synthesize duplicate tool results already present in the following user turn", () => {
    const records = [metadata, message("a", "gemini", "", { toolCalls: [tool] }), message("r", "user", [{ functionResponse: { id: tool.id, name: tool.name, response: { output: "result" } } }])];
    const thread = importGeminiConversation(raw(records), "/fixture/tool.jsonl");
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages.flatMap(m => m.content).filter(b => b.type === "tool_result")).toHaveLength(1);
    expect(validateGeminiConversation(raw(records)).valid).toBe(true);
  });
  it("assigns deterministic paired IDs to legacy function parts without IDs", () => {
    const records = [metadata, message("a", "gemini", [{ functionCall: { name: "read", args: {} } }]), message("r", "user", [{ functionResponse: { name: "read", response: { output: "ok" } } }])];
    const first = importGeminiConversation(raw(records), "/fixture/legacy");
    const second = importGeminiConversation(raw(records), "/fixture/legacy");
    const call = first.messages[0].content[0]; const result = first.messages[1].content[0];
    expect(call.type).toBe("tool_use"); expect(result.type).toBe("tool_result");
    if (call.type !== "tool_use" || result.type !== "tool_result") throw new Error("invalid fixture");
    expect(call.toolCallId).toMatch(/^synth_/); expect(result.toolCallId).toBe(call.toolCallId);
    expect(second.messages[0].content).toEqual(first.messages[0].content);
    expect(first.rawEvents?.[1].raw).toEqual(records[1]);
  });
  it("renders fresh UUIDs, verified slug path and matching project hash; semantic text roundtrip", () => {
    const source = importGeminiConversation(raw(simple()), "/fixture/source.jsonl"); const original = JSON.stringify(source);
    const artifact = renderGeminiConversation(source, context);
    expect(artifact.nativeFormat).toBe("jsonl");
    expect(artifact.relativePath).toBe("destination/chats/session-2026-10-27T08-00-11111111.jsonl");
    expect(artifact.resumeArgs).toEqual(["gemini", "--resume", context.sessionId]);
    expect(validateGeminiConversation(artifact.jsonl, context)).toMatchObject({ valid: true, complete: true, issues: [] });
    const result = importGeminiConversation(artifact.jsonl, "/fixture/clone.jsonl");
    expect(result.messages.map(m => m.content.map(b => b.type === "text" ? b.text : ""))).toEqual([["Hello"], ["Answer"]]);
    expect(result.messages.every(m => !["u", "a"].includes(m.providerMessageId!))).toBe(true);
    expect(JSON.stringify(source)).toBe(original);
  });
  it("quotes foreign instructions/tools/reasoning and never creates signed or executable provider state", () => {
    const thread = importGeminiConversation(raw(simple()), "/fixture/source.jsonl");
    thread.messages[0].role = "developer";
    thread.messages[1].provenance = { harness: "codex", sourcePath: "/fixture/codex" };
    thread.messages[1].content = [{ type: "thinking", thinking: "analysis", signature: "foreign" }, { type: "tool_use", toolCallId: "call", name: "exec", input: { cmd: "example" } }, { type: "tool_result", toolCallId: "call", content: "done" }, { type: "image", source: "https://example.invalid/image.png" }];
    const artifact = renderGeminiConversation(thread, context);
    expect(artifact.issues.map(i => i.code)).toEqual(expect.arrayContaining(["gemini.historical-privileged-context", "gemini.historical-thinking", "gemini.historical-tool-use", "gemini.historical-tool-result", "gemini.historical-image"]));
    expect(artifact.jsonl).not.toContain("thoughtSignature"); expect(artifact.jsonl).not.toContain("functionCall");
    expect(validateGeminiConversation(artifact.jsonl, context).valid).toBe(true);
  });
  it("wraps source commands and injected context so Gemini resume keeps their text", () => {
    for (const text of ["/command source", "?question", "<session_context>source</session_context>", "<hook_context>source</hook_context>"]) {
      const thread = importGeminiConversation(raw([metadata, message("u", "user", text)]), "/fixture/commands");
      const artifact = renderGeminiConversation(thread, context);
      expect(artifact.issues.some(i => i.code === "gemini.ignored-user-content-wrapped")).toBe(true);
      expect(artifact.jsonl).toContain("Historical user message");
      expect(validateGeminiConversation(artifact.jsonl, context)).toMatchObject({ valid: true, complete: true });
    }
  });
  it("requires existing registry and ownership marker rather than guessing a hash directory", () => {
    expect(resolveGeminiProjectIdentifier({ projects: { [context.cwd]: "destination-2" } }, context.cwd, { "destination-2": context.cwd + "\n" })).toBe("destination-2");
    expect(resolveGeminiProjectIdentifier({ projects: { [context.cwd]: "destination" } }, context.cwd, {})).toBeNull();
    expect(resolveGeminiProjectIdentifier({ projects: { [context.cwd]: "../escape" } }, context.cwd, { "../escape": context.cwd })).toBeNull();
    const absent = { ...context, geminiProjectIdentifier: undefined };
    const artifact = renderGeminiConversation(importGeminiConversation(raw(simple()), "/fixture/source"), absent);
    expect(artifact.issues).toContainEqual(expect.objectContaining({ severity: "error", code: "gemini.project-unregistered" }));
    expect(validateGeminiConversation(artifact.jsonl, absent).valid).toBe(false);
  });
  it("reports stable sanitized diagnostics for invalid IDs, timestamps, content and JSON", () => {
    expect(codes('{"secret-content":')).toEqual(["gemini.invalid-json"]);
    const broken = [{ ...metadata, sessionId: "bad", projectHash: "bad", startTime: "invalid" }, message("u", "user", 7)];
    expect(codes(raw(broken))).toEqual(expect.arrayContaining(["gemini.session-id", "gemini.project-hash", "gemini.session-time", "gemini.invalid-content"]));
    const report = validateGeminiConversation('{"secret-content":'); expect(JSON.stringify(report)).not.toContain("secret-content");
    expect(report.issues.every(i => i.path?.startsWith("/"))).toBe(true);
  });
  it("distinguishes unknown extensions and interrupted calls from hard corruption", () => {
    const unknown = [...simple(), { futureEvent: true }, message("x", "future-kind", [{ futurePart: true }])];
    expect(validateGeminiConversation(raw(unknown))).toMatchObject({ valid: true, complete: false });
    const interrupted = [metadata, message("a", "gemini", [{ functionCall: { id: "call", name: "read", args: {} } }])];
    expect(validateGeminiConversation(raw(interrupted))).toMatchObject({ valid: true, complete: false });
    const orphan = [metadata, message("u", "user", [{ functionResponse: { id: "missing", name: "read", response: {} } }])];
    expect(codes(raw(orphan))).toContain("gemini.orphan-function-response");
  });
  it("rejects native generated-state hazards, mismatched destination and malformed parts", () => {
    const artifact = renderGeminiConversation(importGeminiConversation(raw(simple()), "/fixture/source"), context);
    expect(codes(artifact.jsonl, { ...context, cwd: "/different" })).toContain("gemini.project-mismatch");
    const changed = structuredClone(artifact.records); changed[1].content = [{ text: "bad", thought: true, thoughtSignature: "fake" }];
    expect(codes(raw(changed), context)).toContain("gemini.unsafe-generated-part");
    expect(codes(raw([metadata, message("u", "user", [{ inlineData: { mimeType: "image/png", data: "bad!" } }])]))).toContain("gemini.invalid-base64");
    const duplicate = [...artifact.records, artifact.records[1]];
    expect(codes(raw(duplicate), context)).toContain("gemini.duplicate-message-id");
  });
});
