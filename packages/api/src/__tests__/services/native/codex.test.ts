import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { NativeConversationContext, UniversalMessage, UniversalThread } from "@llm-toolkit/shared";
import { codexHasInheritedHistory, importCodexConversation, renderCodexConversation, validateCodexConversation } from "../../../services/native/codex.ts";
import { readCodexConversation } from "../../../services/native/codex-reader.ts";

const time = "2026-10-27T08:00:00.000Z";
const context: NativeConversationContext = { sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/tmp/project", title: "Portable fixture", createdAt: time, sourceHarness: "claude", cliVersion: "0.164.0" };
const message = (id: string, role: UniversalMessage["role"], content: UniversalMessage["content"]): UniversalMessage => ({ id, role, timestamp: time, content });
const thread = (messages: UniversalMessage[]): UniversalThread => ({ id: "source", harness: "claude", sourcePath: "/fixture/source.jsonl", projectPath: "/fixture", title: "Fixture", startedAt: time, updatedAt: time, messages });
const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n";

describe("Codex native conversation adapter", () => {
  it("writes complete model context and UI projections without transplanting source authority or execution policy", () => {
    const original = thread([
      message("policy", "developer", [{ type: "text", text: "Historical instruction" }]),
      message("question", "user", [{ type: "text", text: "Question" }]),
      message("answer", "assistant", [{ type: "text", text: "Answer" }]),
    ]);
    original.rawEvents = [{ id: "policy", timestamp: time, harness: "codex", eventType: "turn_context", raw: { type: "turn_context", payload: { approval_policy: "never", sandbox_policy: { type: "danger-full-access" } } } }];
    original.providerMetadata = { sessionMeta: { base_instructions: { text: "Source policy" }, dynamic_tools: [{ name: "unsafe" }] } };
    const output = renderCodexConversation(original, context);
    expect(validateCodexConversation(output.jsonl, context).valid).toBe(true);
    expect(output.relativePath).toBe("2026/10/27/rollout-2026-10-27T08-00-00-11111111-1111-4111-8111-111111111111.jsonl");
    expect(output.resumeArgs).toEqual(["codex", "resume", context.sessionId, "--cd", context.cwd]);
    expect(output.jsonl).not.toContain("danger-full-access");
    expect(output.jsonl).not.toContain("base_instructions");
    expect(output.records.filter(record => record.type === "event_msg")).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ type: "user_message", message: expect.stringContaining("Historical developer context") }) }), expect.objectContaining({ payload: expect.objectContaining({ type: "agent_message", message: "Answer" }) })]));
    expect(output.issues.some(value => value.code === "codex.historical-authority")).toBe(true);
  });

  it("uses standalone function calls/results with preserved arguments and assistant phase for native closed pairs", () => {
    const call = message("call", "assistant", [{ type: "tool_use", toolCallId: "call_1", name: "exec_command", input: { cmd: "echo fixture" }, providerType: "function_call", providerRaw: { type: "function_call", arguments: '{ "cmd": "echo fixture" }', namespace: "functions" } }]);
    const answer = message("answer", "assistant", [{ type: "text", text: "Done" }]); answer.providerHints = { phase: "final_answer" };
    const output = renderCodexConversation(thread([message("user", "user", [{ type: "text", text: "Run fixture" }]), call, message("result", "tool", [{ type: "tool_result", toolCallId: "call_1", content: "fixture", providerType: "function_call_output" }]), answer]), { ...context, sourceHarness: "codex" });
    const payloads = output.records.filter(record => record.type === "response_item").map(record => record.payload);
    expect(payloads).toContainEqual({ type: "function_call", call_id: "call_1", name: "exec_command", arguments: '{ "cmd": "echo fixture" }', namespace: "functions" });
    expect(payloads).toContainEqual({ type: "function_call_output", call_id: "call_1", output: "fixture" });
    expect(payloads).toContainEqual(expect.objectContaining({ type: "message", role: "assistant", phase: "final_answer" }));
    expect(validateCodexConversation(output.jsonl, context).valid).toBe(true);
  });

  it("uses each inserted message's provenance and preserves native structured output", () => {
    const call = message("call", "assistant", [{ type: "tool_use", toolCallId: "c", name: "tool", input: {}, providerType: "function_call" }]);
    const output = [{ type: "input_text", text: "Structured output" }, { type: "input_image", image_url: "https://example.invalid/fixture.png" }];
    const result = message("result", "tool", [{ type: "tool_result", toolCallId: "c", content: JSON.stringify(output), providerType: "function_call_output", providerRaw: { type: "function_call_output", output } }]);
    for (const value of [call, result]) value.provenance = { harness: "codex", sourcePath: "/fixture/source" };
    const native = renderCodexConversation(thread([call, result]), context);
    expect(native.records).toContainEqual(expect.objectContaining({ payload: { type: "function_call_output", call_id: "c", output } }));
    expect(validateCodexConversation(native.jsonl, context).valid).toBe(true);
    for (const value of [call, result]) value.provenance = { harness: "claude", sourcePath: "/fixture/source" };
    const foreign = renderCodexConversation(thread([call, result]), { ...context, sourceHarness: "codex" });
    expect(foreign.records.some(value => (value.payload as Record<string, unknown>).type === "function_call")).toBe(false);
  });

  it("uses edited custom-tool input and derives the output type from its matching call", () => {
    const call = message("call", "assistant", [{ type: "tool_use", toolCallId: "custom", name: "apply_patch", input: { input: "edited patch" }, providerType: "custom_tool_call", providerRaw: { type: "custom_tool_call", input: "old patch" } }]);
    const result = message("result", "tool", [{ type: "tool_result", toolCallId: "custom", content: "ok" }]);
    const output = renderCodexConversation(thread([call, result]), { ...context, sourceHarness: "codex" });
    expect(output.records).toContainEqual(expect.objectContaining({ payload: { type: "custom_tool_call", call_id: "custom", name: "apply_patch", input: "edited patch" } }));
    expect(output.records).toContainEqual(expect.objectContaining({ payload: { type: "custom_tool_call_output", call_id: "custom", output: "ok" } }));
    expect(validateCodexConversation(output.jsonl, context).valid).toBe(true);
  });

  it("keeps foreign or unresolved calls and protected reasoning as readable history, not fabricated native tool state", () => {
    const output = renderCodexConversation(thread([message("call", "assistant", [{ type: "tool_use", toolCallId: "incomplete", name: "Bash", input: { command: "echo fixture" } }, { type: "redacted_thinking", data: "opaque-secret-signature" }])]), context);
    expect(output.records.some(record => (record.payload as Record<string, unknown>).type === "function_call")).toBe(false);
    expect(output.jsonl).toContain("Historical tool call");
    expect(output.jsonl).not.toContain("opaque-secret-signature");
    expect(output.issues.filter(value => value.severity === "warning")).toHaveLength(2);
    expect(validateCodexConversation(output.jsonl, context).valid).toBe(true);
  });

  it("imports all context roles and tool pairs once, preserving opaque source records separately", () => {
    const output = renderCodexConversation(thread([message("u", "user", [{ type: "text", text: "Question" }]), message("a", "assistant", [{ type: "text", text: "Answer" }])]), context);
    const imported = importCodexConversation(output.jsonl, "/fixture/rollout.jsonl");
    expect(imported.messages.map(value => value.content[0])).toEqual([{ type: "text", text: "Question", providerType: "input_text", providerRaw: { type: "input_text", text: "Question" } }, { type: "text", text: "Answer", providerType: "output_text", providerRaw: { type: "output_text", text: "Answer" } }]);
    expect(imported.rawEvents).toHaveLength(output.records.length);
    expect(imported.messages).toHaveLength(2);
    const header = output.records[0];
    const withTools = jsonl([header, { timestamp: time, type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Historical policy" }] } }, { timestamp: time, type: "response_item", payload: { type: "function_call", name: "tool", call_id: "c", arguments: "{}" } }, { timestamp: time, type: "response_item", payload: { type: "function_call_output", call_id: "c", output: "ok" } }, { timestamp: time, type: "world_state", payload: { full: true, state: {} } }]);
    const full = importCodexConversation(withTools, "/fixture/native.jsonl");
    expect(full.messages.map(value => value.role)).toEqual(["developer", "assistant", "tool"]);
    expect(full.messages[1].content[0]).toMatchObject({ type: "tool_use", toolCallId: "c" });
    expect(full.messages[2].content[0]).toMatchObject({ type: "tool_result", toolCallId: "c" });
    expect(full.rawEvents?.at(-1)?.eventType).toBe("world_state");
  });

  it("reports actionable structured failures and distinguishes existing source records from clone safety", () => {
    const artifact = renderCodexConversation(thread([message("u", "user", [{ type: "text", text: "Fixture" }])]), context);
    const unsafe = jsonl([...artifact.records, { timestamp: time, type: "turn_context", payload: { cwd: context.cwd, model: "fixture", approval_policy: "never", sandbox_policy: { type: "danger-full-access" } } }]);
    expect(validateCodexConversation(unsafe).valid).toBe(true);
    expect(validateCodexConversation(unsafe, context).issues.some(value => value.code === "codex.unsafe-native-record")).toBe(true);
    const wrong = JSON.parse(JSON.stringify(artifact.records)); wrong[0].payload.timestamp = "2026-02-30T00:00:00Z"; wrong[2].payload.content = [{ type: "tool_call", name: "bad" }];
    const validation = validateCodexConversation(jsonl(wrong), context);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "codex.invalid-session-time", path: "$records[0].payload.timestamp", repairable: true }), expect.objectContaining({ code: "codex.unsupported-content-type" })]));
    expect(JSON.stringify(validateCodexConversation('{"private":"do-not-echo"'))).not.toContain("do-not-echo");
  });

  it("blocks unresolved inherited prefixes rather than importing a misleading partial conversation", () => {
    const output = renderCodexConversation(thread([]), context);
    (output.records[0].payload as Record<string, unknown>).history_base = { thread_id: "22222222-2222-4222-8222-222222222222", end_ordinal_exclusive: 10 };
    const raw = jsonl(output.records);
    expect(codexHasInheritedHistory(raw)).toBe(true);
    expect(() => importCodexConversation(raw, "/fixture/child.jsonl")).toThrow("inherited history");
    expect(validateCodexConversation(raw).issues.some(value => value.code === "codex.incomplete-history")).toBe(true);
  });
});

describe("Codex read-only visible history materialization", () => {
  it("reads every cursor page/full item page and preserves original ancestry without executing or mutating source", async () => {
    const root = await mkdtemp(join(tmpdir(), "toolkit-codex-reader-")); const source = join(root, "source.jsonl");
    const artifact = renderCodexConversation(thread([]), context); (artifact.records[0].payload as Record<string, unknown>).history_base = { thread_id: "parent", end_ordinal_exclusive: 2 }; const raw = jsonl(artifact.records); await writeFile(source, raw);
    const methods: string[] = [];
    try {
      const result = await readCodexConversation(source, { request: async (method, params) => {
        methods.push(method);
        if (method === "thread/read") return { thread: { id: context.sessionId, path: source, cwd: "/tmp/project", name: "Materialized" } };
        if (method === "thread/items/list") return { data: [{ type: "agentMessage", id: "a", text: "Inherited answer", phase: "final_answer" }], nextCursor: null };
        if (params.cursor === "next") return { data: [{ id: "turn2", startedAt: 1, itemsView: "summary", items: [] }], nextCursor: null };
        return { data: [{ id: "turn1", startedAt: 0, itemsView: "full", items: [{ type: "userMessage", id: "u", content: [{ type: "text", text: "Inherited question" }] }] }], nextCursor: "next" };
      } });
      expect(result.messages.map(value => value.role)).toEqual(["user", "assistant"]);
      expect(methods).toEqual(["thread/read", "thread/turns/list", "thread/turns/list", "thread/items/list"]);
      expect(result.providerMetadata?.codexHistory).toMatchObject({ mode: "app-server-visible-history", complete: true, pageCount: 2, opaqueContextPreserved: false });
      expect(await readFile(source, "utf8")).toBe(raw);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed on repeated cursors or an unavailable binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "toolkit-codex-reader-")); const source = join(root, "source.jsonl");
    const artifact = renderCodexConversation(thread([]), context); (artifact.records[0].payload as Record<string, unknown>).history_base = { thread_id: "parent", end_ordinal_exclusive: 2 }; await writeFile(source, jsonl(artifact.records));
    try {
      await expect(readCodexConversation(source, { request: async method => method === "thread/read" ? { thread: { id: context.sessionId, path: source } } : { data: [], nextCursor: "repeated" } })).rejects.toThrow("repeated history cursor");
      await expect(readCodexConversation(source, { codexHome: root, executable: join(root, "not-installed"), timeoutMs: 1000 })).rejects.toThrow("could not be started");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  const installed = spawnSync("codex", ["--version"], { encoding: "utf8" });
  it.skipIf(installed.status !== 0)("is accepted by the installed Codex parser and visible-history projection without running a turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "toolkit-native-codex-")); const home = join(root, "home"); const cwd = join(root, "project");
    await mkdir(home); await mkdir(cwd);
    await writeFile(join(home, "config.toml"), 'model_provider="fixture"\nmodel="fixture"\n[model_providers.fixture]\nname="Offline fixture"\nbase_url="http://127.0.0.1:9"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n');
    const artifact = renderCodexConversation(thread([message("u", "user", [{ type: "text", text: "Synthetic question" }]), message("a", "assistant", [{ type: "text", text: "Synthetic answer" }])]), { ...context, cwd, modelProvider: "fixture" });
    const source = join(home, "sessions", artifact.relativePath); await mkdir(join(source, ".."), { recursive: true }); await writeFile(source, artifact.jsonl);
    try {
      const actual = await readCodexConversation(source, { codexHome: home, materialize: true, timeoutMs: 15_000 });
      expect(actual.messages.map(value => value.role)).toEqual(["user", "assistant"]);
      expect(actual.messages.map(value => value.content[0])).toEqual([{ type: "text", text: "Synthetic question" }, { type: "text", text: "Synthetic answer" }]);
      expect(await readFile(source, "utf8")).toBe(artifact.jsonl);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);
});
