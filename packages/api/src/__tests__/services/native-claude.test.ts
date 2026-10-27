import { describe, expect, it } from "vitest";
import type { NativeConversationContext, UniversalThread } from "@llm-toolkit/shared";
import { claudeConversationAdapter, claudeConversationChain, claudeProjectKey, importClaudeConversation, renderClaudeConversation, validateClaudeConversation } from "../../services/native/claude.ts";

const context: NativeConversationContext = { sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/tmp/portable-conversation", title: "Portable test", createdAt: "2026-10-27T08:00:00.000Z", sourceHarness: "claude", cliVersion: "2.1.311" };
const timestamp = "2026-10-26T08:00:00.000Z";
function record(uuid: string, parentUuid: string | null, type: string, content: unknown, extra: Record<string, unknown> = {}) {
  return { uuid, parentUuid, type, sessionId: "22222222-2222-4222-8222-222222222222", cwd: "/source/project", timestamp, isSidechain: false, message: { role: type, content }, ...extra };
}
const text = (text: string) => ({ type: "text", text });
const call = (id: string) => ({ type: "tool_use", id, name: "Read", input: { file_path: "example.txt" } });
const result = (id: string) => ({ type: "tool_result", tool_use_id: id, content: `result for ${id}` });
const raw = (records: unknown[]) => records.map(r => JSON.stringify(r)).join("\n") + "\n";
function parallelRecords() {
  return [
    record("u", null, "user", "Inspect both files"),
    record("a", "u", "assistant", [call("call-a")], { message: { id: "msg-parallel", role: "assistant", content: [call("call-a")] } }),
    record("b", "a", "assistant", [call("call-b")], { message: { id: "msg-parallel", role: "assistant", content: [call("call-b")] } }),
    record("ra", "a", "user", [result("call-a")]),
    record("rb", "b", "user", [result("call-b")]),
    record("final", "ra", "assistant", [text("Both files inspected")], { message: { id: "msg-final", role: "assistant", content: [text("Both files inspected")] } }),
  ];
}
function thread(records: Record<string, unknown>[] = [record("u", null, "user", "Hello"), record("a", "u", "assistant", [text("Hello back")])]): UniversalThread {
  return importClaudeConversation(raw(records), "/fixture/source.jsonl");
}

describe("Claude native conversation adapter", () => {
  it("reconstructs parallel tool branches and excludes unrelated sidechains", () => {
    const records = [...parallelRecords(), record("side", "u", "assistant", [text("Subagent private branch")], { isSidechain: true })];
    const chain = claudeConversationChain(records);
    expect(chain.map(r => r.uuid)).toEqual(["u", "a", "b", "rb", "ra", "final"]);
    const imported = thread(records);
    expect(imported.messages.flatMap(m => m.content).filter(b => b.type === "tool_result")).toHaveLength(2);
    expect(imported.rawEvents).toHaveLength(7);
    expect(imported.messages.some(m => m.providerMessageId === "side")).toBe(false);
  });

  it("uses the post-compaction chain without following logicalParentUuid, while archiving raw history", () => {
    const records = [...parallelRecords(),
      { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: null, logicalParentUuid: "final", timestamp },
      record("summary", "boundary", "user", "Summary of earlier work", { isCompactSummary: true }),
      record("after", "summary", "assistant", [text("Continue from summary")]),
    ];
    const imported = thread(records);
    expect(imported.messages.map(m => m.providerMessageId)).toEqual(["summary", "after"]);
    expect(imported.rawEvents).toHaveLength(9);
    expect(imported.startedAt).toBe(timestamp);
    expect(renderClaudeConversation(imported, context).issues.some(i => i.code === "historical-compaction-summary")).toBe(true);
  });

  it("exports a fresh native parent chain with matching tool pairs and preserves source data", () => {
    const source = thread(parallelRecords());
    const original = JSON.stringify(source);
    const artifact = claudeConversationAdapter.render(source, context);
    expect(artifact.relativePath).toBe("-tmp-portable-conversation/11111111-1111-4111-8111-111111111111.jsonl");
    expect(artifact.resumeArgs).toEqual(["claude", "--resume", context.sessionId]);
    expect(artifact.jsonl.endsWith("\n")).toBe(true);
    expect(validateClaudeConversation(artifact.jsonl, context)).toMatchObject({ valid: true, issues: [] });
    const reimported = importClaudeConversation(artifact.jsonl, "/fixture/clone.jsonl");
    const semantic = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => ["providerRaw", "providerType", "providerHints"].includes(key) ? undefined : item));
    expect(semantic(reimported.messages.map(m => m.content))).toEqual(semantic(source.messages.map(m => m.content)));
    expect(new Set(reimported.messages.map(m => m.providerMessageId)).size).toBe(source.messages.length);
    expect(reimported.messages.every(m => m.providerHints?.sessionId === context.sessionId)).toBe(true);
    expect(JSON.stringify(source)).toBe(original);
  });

  it("converts foreign tools, reasoning and privileged roles into labeled history, never forged native state", () => {
    const source = thread();
    source.harness = "codex";
    source.messages[1].model = "gpt-source-model";
    source.messages.forEach(message => { message.provenance = { harness: "codex", sourcePath: "/foreign.jsonl" }; });
    source.messages[0].role = "developer";
    source.messages[1].content = [
      { type: "thinking", thinking: "Earlier analysis", signature: "foreign-signature" },
      { type: "tool_use", toolCallId: "foreign", name: "exec_command", input: { cmd: "echo example" } },
    ];
    source.messages.push({ ...source.messages[0], id: "result", role: "tool", content: [{ type: "tool_result", toolCallId: "foreign", content: "example" }] });
    const artifact = renderClaudeConversation(source, { ...context, sourceHarness: "codex" });
    expect(artifact.issues.map(i => i.code)).toEqual(expect.arrayContaining(["historical-privileged-context", "historical-reasoning", "historical-tool-call", "historical-tool-result"]));
    expect(artifact.records.filter(r => r.type !== "custom-title").every(r => r.type === "user" || r.type === "assistant")).toBe(true);
    expect(artifact.records.flatMap(r => ((r.message as Record<string, unknown> | undefined)?.content ?? [])).every(b => (b as Record<string, unknown>).type === "text")).toBe(true);
    expect(artifact.jsonl).not.toContain('"signature"');
    expect(artifact.jsonl).not.toContain("gpt-source-model");
    expect(validateClaudeConversation(artifact.jsonl, context).valid).toBe(true);
  });

  it("normalizes foreign and stale stop reasons to the actual emitted Claude response", () => {
    for (const stopReason of ["stop", "tool_calls", "tool_use"]) {
      const source = thread();
      source.messages[1].stopReason = stopReason;
      source.messages[1].provenance = { harness: "codex", sourcePath: "/fixture/foreign.jsonl" };
      source.messages[1].content = [{ type: "tool_use", toolCallId: "foreign-call", name: "exec_command", input: { cmd: "fixture" } }];
      const artifact = renderClaudeConversation(source, context);
      const assistant = artifact.records.find(r => r.type === "assistant")!.message as Record<string, unknown>;
      expect(assistant.stop_reason).toBe("end_turn");
      expect(artifact.issues.some(i => i.code === "stop-reason-normalized" && i.severity === "warning")).toBe(true);
      expect(validateClaudeConversation(artifact.jsonl, context).valid).toBe(true);
    }
    const native = thread(parallelRecords());
    native.messages.filter(m => m.role === "assistant").forEach(m => { m.stopReason = "tool_use"; });
    const artifact = renderClaudeConversation(native, context);
    for (const record of artifact.records.filter(r => r.type === "assistant")) {
      const message = record.message as { content: Array<{ type: string }>; stop_reason: string };
      expect(message.stop_reason).toBe(message.content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn");
    }
    expect(validateClaudeConversation(artifact.jsonl, context).valid).toBe(true);
  });

  it("preserves safe native completion reasons only for unchanged source bodies", () => {
    for (const reason of ["max_tokens", "refusal", "stop_sequence", "model_context_window_exceeded"]) {
      const nativeMessage = { id: "msg_fixture", type: "message", role: "assistant", content: [text("Original native answer")], stop_reason: reason, stop_sequence: reason === "stop_sequence" ? "matched sequence" : null };
      const source = thread([record("u", null, "user", "Question"), record("a", "u", "assistant", nativeMessage.content, { message: nativeMessage })]);
      const output = (input: UniversalThread) => renderClaudeConversation(input, context);
      const assistant = (artifact: ReturnType<typeof output>) => artifact.records.find(r => r.type === "assistant")!.message as Record<string, unknown>;
      const unchanged = output(source);
      expect(assistant(unchanged)).toMatchObject({ stop_reason: reason, stop_sequence: nativeMessage.stop_sequence });
      expect(unchanged.issues.some(i => i.code === "stop-reason-normalized")).toBe(false);
      expect(importClaudeConversation(unchanged.jsonl, "/fixture/clone").messages[1].stopReason).toBe(reason);
      expect(validateClaudeConversation(unchanged.jsonl, context).valid).toBe(true);
      const edited = structuredClone(source);
      edited.messages[1].content = [{ type: "text", text: "Edited answer" }];
      expect(assistant(output(edited))).toMatchObject({ stop_reason: "end_turn", stop_sequence: null });
      expect(output(edited).issues.some(i => i.code === "stop-reason-normalized")).toBe(true);
      const foreign = structuredClone(source);
      foreign.messages[1].provenance = { harness: "codex", sourcePath: "/fixture/foreign" };
      expect(assistant(output(foreign))).toMatchObject({ stop_reason: "end_turn", stop_sequence: null });
    }
    const incomplete = thread(); incomplete.messages[1].stopReason = "stop_sequence";
    expect((renderClaudeConversation(incomplete, context).records.find(r => r.type === "assistant")!.message as Record<string, unknown>).stop_reason).toBe("end_turn");
  });

  it("retains unchanged signed native thinking but renders edited or unsigned thinking as history", () => {
    const block = { type: "thinking", thinking: "Original reasoning", signature: "opaque-source-signature" };
    const source = thread([record("u", null, "user", "Question"), record("a", "u", "assistant", [block, text("Answer")])]);
    expect(renderClaudeConversation(source, context).jsonl).toContain('"type":"thinking"');
    const thinking = source.messages[1].content[0];
    if (thinking.type !== "thinking") throw new Error("wrong fixture");
    thinking.thinking = "Edited reasoning";
    const edited = renderClaudeConversation(source, context);
    expect(edited.jsonl).not.toContain('"signature"');
    expect(edited.issues.some(i => i.code === "historical-reasoning")).toBe(true);
  });

  it("reports an incomplete tool transaction and emits readable history rather than an orphan", () => {
    const source = thread([record("u", null, "user", "Read"), record("a", "u", "assistant", [call("missing")])]);
    const artifact = renderClaudeConversation(source, context);
    expect(artifact.issues.some(i => i.code === "historical-tool-call")).toBe(true);
    expect(validateClaudeConversation(artifact.jsonl, context).valid).toBe(true);
    expect(artifact.jsonl).not.toContain('"type":"tool_use"');
  });

  it("rejects corrupt JSONL and invalid UUID/session/parent/tool structure", () => {
    expect(() => importClaudeConversation("not json", "/bad.jsonl")).toThrow("line 1");
    const artifact = renderClaudeConversation(thread(), context);
    const records = structuredClone(artifact.records);
    records[1].parentUuid = "missing";
    records[1].sessionId = "foreign-session";
    const checked = validateClaudeConversation(raw(records), context);
    expect(checked.valid).toBe(false);
    expect(checked.issues.map(i => i.code)).toEqual(expect.arrayContaining(["broken-parent-chain", "session-mismatch"]));
    const orphan = record("33333333-3333-4333-8333-333333333333", null, "user", [result("unknown")], { sessionId: context.sessionId, cwd: context.cwd });
    expect(validateClaudeConversation(raw([orphan]), context).issues.some(i => i.code === "orphan-tool-result")).toBe(true);
  });

  it("matches long project path hashing and safely maps image/reference blocks", () => {
    const long = `/tmp/${"a".repeat(205)}`;
    expect(claudeProjectKey(long).split("-").at(-1)).toBe("h1xq5i");
    expect(claudeProjectKey(long).length).toBeLessThan(220);
    const source = thread();
    source.messages[0].content = [ { type: "image", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yP0cAAAAASUVORK5CYII=" }, { type: "document", source: "file:///external/private.pdf", text: "Document excerpt" } ];
    const artifact = renderClaudeConversation(source, context);
    expect(artifact.jsonl).toContain('"type":"image"');
    expect(artifact.jsonl).toContain("Document excerpt");
    expect(artifact.issues.some(i => i.code === "historical-block")).toBe(true);
  });
});

describe("standalone Claude transcript validation", () => {
  const nativeFixture = () => {
    const source = thread(parallelRecords());
    return renderClaudeConversation(source, context);
  };
  it("accepts real metadata around a native transcript, with versioned diagnostics", () => {
    const artifact = nativeFixture();
    const records = [ { type: "queue-operation", operation: "enqueue", sessionId: context.sessionId }, ...artifact.records, { type: "tools-used", sessionId: context.sessionId, tools: ["Read"] } ];
    const checked = validateClaudeConversation(raw(records));
    expect(checked.valid).toBe(true);
    expect(checked.issues).toEqual([]);
    expect(checked).toMatchObject({ compatibilityVersion: "claude-code/2.1.311;agent-sdk-python/0.2.174" });
  });
  it("validates assistant API identity, type and stop reasons with sanitized structural diagnostics", () => {
    for (const [field, value, code] of [["id", null, "invalid-assistant-id"], ["type", "foreign-type", "invalid-assistant-type"], ["stop_reason", "foreign-secret-value", "invalid-stop-reason"]] as const) {
      const artifact = nativeFixture(); const record = artifact.records.find(r => r.type === "assistant")!;
      (record.message as Record<string, unknown>)[field] = value;
      for (const ctx of [undefined, context]) {
        const report = validateClaudeConversation(raw(artifact.records), ctx);
        expect(report.valid).toBe(false);
        expect(report.issues.some(i => i.code === code && i.path?.endsWith(`/message/${field}`))).toBe(true);
        expect(JSON.stringify(report)).not.toContain("foreign-secret-value");
      }
    }
    const artifact = nativeFixture(); const record = artifact.records.find(r => r.type === "assistant")!;
    (record.message as Record<string, unknown>).stop_reason = "end_turn";
    expect(validateClaudeConversation(raw(artifact.records), context).issues.some(i => i.code === "stop-reason-content-mismatch")).toBe(true);
  });
  it("keeps interrupted null stop reasons incomplete and legitimate native response values readable", () => {
    const artifact = renderClaudeConversation(thread(), context);
    const message = artifact.records.find(r => r.type === "assistant")!.message as Record<string, unknown>;
    for (const reason of ["end_turn", "max_tokens", "stop_sequence", "pause_turn", "refusal", "model_context_window_exceeded"]) {
      message.stop_reason = reason; message.stop_sequence = reason === "stop_sequence" ? "fixture sequence" : null;
      expect(validateClaudeConversation(raw(artifact.records)).valid).toBe(true);
    }
    message.stop_reason = null;
    expect(validateClaudeConversation(raw(artifact.records))).toMatchObject({ valid: true, complete: false });
    expect(validateClaudeConversation(raw(artifact.records), context).valid).toBe(false);
  });

  it("reports unknown version extensions without deleting them or pretending they are malformed", () => {
    const artifact = nativeFixture();
    const checked = validateClaudeConversation(raw([...artifact.records, { type: "future-native-metadata", value: "not shown in diagnostics" }]));
    expect(checked.valid).toBe(true);
    expect(checked.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "warning", code: "unknown-native-entry", path: expect.stringMatching(/^\/records\/\d+\/type$/) })]));
    expect(JSON.stringify(checked)).not.toContain("not shown in diagnostics");
  });
  it("locates graph corruption and rejects SDK stream/Codex files masquerading as Claude transcripts", () => {
    const artifact = nativeFixture();
    const records = structuredClone(artifact.records);
    records[0].parentUuid = records[1].uuid;
    const cycle = validateClaudeConversation(raw(records));
    expect(cycle.valid).toBe(false);
    expect(cycle.issues.some(i => i.code === "parent-cycle")).toBe(true);
    expect(validateClaudeConversation(raw([{ type: "response_item", payload: {} }])).issues.some(i => i.code === "foreign-native-format")).toBe(true);
    expect(validateClaudeConversation(raw([{ type: "result", result: "hidden output" }])).issues.some(i => i.code === "sdk-stream-not-transcript")).toBe(true);
    const syntax = validateClaudeConversation('{"sensitive":"do not echo"');
    expect(syntax.valid).toBe(false);
    expect(syntax.issues[0]).toMatchObject({ code: "invalid-jsonl", path: "/lines/0" });
    expect(JSON.stringify(syntax)).not.toContain("sensitive");
  });
  it("rejects interrupted native tool ordering while rendering a new clone safely as history", () => {
    const source = thread([record("u", null, "user", "Read"), record("a", "u", "assistant", [call("late")]), record("intervening", "a", "assistant", [text("Different response")]), record("r", "intervening", "user", [result("late")])]);
    const safe = renderClaudeConversation(source, context);
    expect(validateClaudeConversation(safe.jsonl, context).valid).toBe(true);
    expect(safe.jsonl).not.toContain('"type":"tool_use"');
    expect(safe.issues.some(i => i.code === "historical-tool-call")).toBe(true);
  });
});


describe("Claude mixed-source snippets", () => {
  it("does not trust global thread harness when an inserted message came from Codex", () => {
    const source = thread();
    source.messages[1].model = "foreign-model";
    source.messages[1].provenance = { harness: "codex", sourcePath: "/foreign.jsonl" };
    const raw = { type: "thinking", thinking: "Foreign reasoning", signature: "foreign-signature" };
    source.messages[1].content = [{ type: "thinking", thinking: raw.thinking, signature: raw.signature, providerRaw: raw }];
    const artifact = renderClaudeConversation(source, context);
    expect(artifact.jsonl).not.toContain('"signature"');
    expect(artifact.jsonl).not.toContain("foreign-model");
    expect(artifact.issues.some(i => i.code === "historical-reasoning")).toBe(true);
  });
  it("reports a safely repairable missing final newline", () => {
    const artifact = renderClaudeConversation(thread(), context);
    const checked = validateClaudeConversation(artifact.jsonl.trimEnd());
    expect(checked.valid).toBe(true);
    expect(checked.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing-final-newline", repairable: true, path: "/end-of-file" })]));
  });
});
