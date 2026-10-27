import { describe, expect, test } from "vitest";
import type { UniversalThread } from "../types/index.ts";
import { conversationMarkdown, insertConversationSection, parsePortableConversation, portableConversation, snipConversation } from "../portable-conversation.ts";

function fixture(): UniversalThread {
  return {
    id: "source", harness: "claude", sourcePath: "/source/session.jsonl", projectPath: "/repo", title: "Example",
    startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    messages: [
      { id: "user", role: "user", timestamp: "2026-01-01T00:00:03Z", content: [{ type: "text", text: "Read the file" }] },
      { id: "call", role: "assistant", timestamp: "2026-01-01T00:00:01Z", content: [{ type: "tool_use", toolCallId: "call-1", name: "Read", input: { path: "/file" } }], providerRaw: { uuid: "call", selected: true } },
      { id: "result", role: "tool", timestamp: "2026-01-01T00:00:01Z", content: [{ type: "tool_result", toolCallId: "call-1", content: "Contents" }] },
      { id: "last", role: "assistant", timestamp: "2026-01-01T00:00:02Z", content: [{ type: "text", text: "Finished" }] },
    ],
    rawEvents: [{ id: "unselected", timestamp: "2026-01-01T00:00:00Z", harness: "claude", eventType: "user", raw: { content: "UNSELECTED PRIVATE CONTENT" } }],
    providerMetadata: { entireSource: "UNSELECTED PRIVATE CONTENT" },
  };
}

describe("portable conversation documents", () => {
  test("round trips the existing universal representation without reordering equal or inverted timestamps", () => {
    const thread = fixture();
    expect(parsePortableConversation(JSON.stringify(portableConversation(thread))).thread).toEqual(thread);
    expect(parsePortableConversation(JSON.stringify(portableConversation(thread))).thread.messages.map((m) => m.id)).toEqual(["user", "call", "result", "last"]);
  });

  test("snips tool dependency closure in source order and excludes unrelated raw archives", () => {
    const source = fixture();
    const result = snipConversation(source, ["result"]);
    expect(result.document.thread.messages.map((m) => m.id)).toEqual(["call", "result"]);
    expect(result.document.selection?.dependencyMessageIds).toEqual(["call"]);
    expect(result.document.thread.rawEvents).toBeUndefined();
    expect(result.document.thread.providerMetadata).toBeUndefined();
    expect(JSON.stringify(result.document)).not.toContain("UNSELECTED PRIVATE CONTENT");
    expect(result.document.thread.messages[0].providerRaw).toEqual(source.messages[1].providerRaw);
    expect(source.messages).toHaveLength(4);
  });

  test("reinsertion remaps message and call identifiers together without mutating either original", () => {
    const source = fixture();
    const section = snipConversation(source, ["call"]).document;
    const result = insertConversationSection(portableConversation(source), section, "user");
    expect(result.thread.messages).toHaveLength(6);
    expect(new Set(result.thread.messages.map((m) => m.id)).size).toBe(6);
    const call = result.thread.messages[1].content[0];
    const output = result.thread.messages[2].content[0];
    expect(call.type).toBe("tool_use");
    expect(output.type).toBe("tool_result");
    expect("toolCallId" in call && "toolCallId" in output && call.toolCallId === output.toolCallId).toBe(true);
    expect("toolCallId" in call && call.toolCallId).not.toBe("call-1");
    expect(source.messages).toHaveLength(4);
    expect(section.thread.messages).toHaveLength(2);
  });

  test("rejects malformed or wrong-version documents and unknown insertion positions", () => {
    const doc = portableConversation(fixture());
    expect(() => parsePortableConversation({ ...doc, version: 2 })).toThrow("version 1");
    expect(() => parsePortableConversation({ ...doc, thread: { ...doc.thread, messages: [{ ...doc.thread.messages[0], role: "root" }] } })).toThrow("role");
    expect(() => snipConversation(doc.thread, ["missing"])).toThrow("unknown");
    expect(() => insertConversationSection(doc, doc, "missing")).toThrow("Insertion");
  });

  test("reports open tool history instead of fabricating tool output", () => {
    const source = fixture(); source.messages.splice(2, 1);
    const result = snipConversation(source, ["call"]);
    expect(result.issues.some((issue) => issue.code === "unresolved_tool_call")).toBe(true);
    expect(result.document.thread.messages).toHaveLength(1);
  });

  test("readable format preserves roles and tool context", () => {
    const text = conversationMarkdown(portableConversation(fixture()));
    expect(text).toContain("## 3. tool");
    expect(text).toContain("Historical tool call: Read");
    expect(text).toContain("Contents");
  });
});
