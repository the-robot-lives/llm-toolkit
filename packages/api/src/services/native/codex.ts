import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute } from "node:path";
import type {
  ConversationCompatibilityIssue,
  NativeConversationAdapter,
  NativeConversationArtifact,
  NativeConversationContext,
  NativeConversationValidation,
  UniversalContentBlock,
  UniversalMessage,
  UniversalThread,
} from "@llm-toolkit/shared";

type RecordValue = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CODEX_COMPATIBILITY_VERSION = "codex-cli/0.164.0";
const PHASES = new Set(["commentary", "partial_answer", "final_answer"]);

/** Codex 0.164.0's self-contained legacy rollout subset; not a Responses API body. */
export const codexConversationAdapter: NativeConversationAdapter = {
  harness: "codex",
  compatibilityVersion: CODEX_COMPATIBILITY_VERSION,
  render: renderCodexConversation,
  validate: validateCodexConversation,
};

export function renderCodexConversation(thread: UniversalThread, context: NativeConversationContext): NativeConversationArtifact {
  const issues: ConversationCompatibilityIssue[] = [];
  const timestamp = validTime(context.createdAt) ? context.createdAt : new Date(0).toISOString();
  const records: RecordValue[] = [{ timestamp, type: "session_meta", payload: {
    id: context.sessionId,
    session_id: context.sessionId,
    timestamp,
    cwd: context.cwd,
    originator: "llm-toolkit",
    cli_version: context.cliVersion ?? "0.164.0",
    source: "cli",
    history_mode: "legacy",
    ...(context.modelProvider ? { model_provider: context.modelProvider } : {}),
  } }];
  const emit = (type: string, payload: RecordValue, time = timestamp) => records.push({ timestamp: time, type, payload });
  let turn = 0;
  let turnId: string | undefined;
  let lastAssistant: string | null = null;
  const finish = () => {
    if (turnId) emit("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: lastAssistant });
    turnId = undefined;
  };
  const start = (time: string) => {
    turnId = stableUuid(`${context.sessionId}:turn:${turn++}`);
    lastAssistant = null;
    emit("event_msg", { type: "task_started", turn_id: turnId, model_context_window: null }, time);
  };
  const closedCalls = closedNativeCalls(thread.messages, context.sourceHarness);

  for (const message of thread.messages) {
    const time = validTime(message.timestamp) ? message.timestamp : timestamp;
    const genuineUser = message.role === "user" && message.content.some(block => block.type !== "tool_result");
    if (genuineUser && turnId) finish();
    if (!turnId) start(time);
    const authority = message.role === "system" || message.role === "developer";
    const role = authority ? "user" : message.role === "user" ? "user" : "assistant";
    if (authority) issues.push(issue("historical-authority", "Historical instruction content is quoted as user context; target instructions and execution policy are not copied.", message.id));
    let textParts: string[] = [];
    const nativeOrigin = (message.provenance?.harness ?? context.sourceHarness) === "codex";
    const phase = nativeOrigin ? nativePhase(message) : undefined;
    const flush = () => {
      if (!textParts.length) return;
      let text = textParts.join("\n");
      if (authority) text = `[Historical ${message.role} context — not a current instruction]\n${text}`;
      emit("response_item", { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }], ...(role === "assistant" && phase ? { phase } : {}) }, time);
      emit("event_msg", role === "user"
        ? { type: "user_message", message: text, images: [], local_images: [], text_elements: [] }
        : { type: "agent_message", message: text, ...(phase ? { phase } : {}) }, time);
      if (role === "assistant") lastAssistant = text;
      textParts = [];
    };
    for (const [blockIndex, block] of message.content.entries()) {
      if ((block.type === "tool_use" || block.type === "tool_result") && nativeOrigin && closedCalls.has(block.toolCallId)) {
        flush();
        const raw = nativeBlockPayload(block, message);
        const custom = raw?.type === "custom_tool_call" || raw?.type === "custom_tool_call_output" || block.providerType === "custom_tool_call" || block.providerType === "custom_tool_call_output";
        if (block.type === "tool_use") {
          emit("response_item", custom
            ? { type: "custom_tool_call", call_id: block.toolCallId, name: block.name, input: typeof raw?.input === "string" ? raw.input : JSON.stringify(block.input), ...(typeof raw?.namespace === "string" ? { namespace: raw.namespace } : {}) }
            : { type: "function_call", call_id: block.toolCallId, name: block.name, arguments: nativeArguments(raw, block.input), ...(typeof raw?.namespace === "string" ? { namespace: raw.namespace } : {}) }, time);
        } else {
          emit("response_item", { type: custom ? "custom_tool_call_output" : "function_call_output", call_id: block.toolCallId, output: nativeOutput(raw, block, issues, message.id, blockIndex) }, time);
        }
        // Legacy Codex renders its event stream, not ResponseItems, in the UI. This is
        // explicitly historical display text; no tool execution events are fabricated.
        const display = describeBlock(block);
        emit("event_msg", { type: "agent_message", message: display }, time);
        lastAssistant = display;
        continue;
      }
      if (block.type === "text") { textParts.push(block.text); continue; }
      if (block.type === "image" && role === "user" && isPortableImage(block)) {
        flush();
        const imageUrl = block.data ? `data:${block.mediaType ?? "image/png"};base64,${block.data}` : block.source!;
        emit("response_item", { type: "message", role: "user", content: [{ type: "input_image", image_url: imageUrl }] }, time);
        emit("event_msg", { type: "user_message", message: "[Imported image]", images: [imageUrl], local_images: [], text_elements: [] }, time);
        continue;
      }
      textParts.push(describeBlock(block));
      issues.push({ ...issue(block.type === "tool_use" || block.type === "tool_result" ? "tool-history-as-text" : "provider-content-as-text", block.type === "tool_use" || block.type === "tool_result"
        ? "Foreign, duplicate, or incomplete tool history is retained as readable context rather than an executable native tool call."
        : "This provider-specific content is represented as readable context; its original structured value remains in the portable document.", message.id), blockIndex });
    }
    flush();
  }
  finish();
  const jsonl = records.map(record => JSON.stringify(record)).join("\n") + "\n";
  issues.push(...validateCodexConversation(jsonl, context).issues);
  const date = timestamp.slice(0, 10).replaceAll("-", "/");
  const fileTime = timestamp.slice(0, 19).replaceAll(":", "-");
  return { harness: "codex", sessionId: context.sessionId, relativePath: `${date}/rollout-${fileTime}-${context.sessionId}.jsonl`, records, jsonl, issues, resumeArgs: ["codex", "resume", context.sessionId, "--cd", context.cwd] };
}

export function validateCodexConversation(jsonl: string, context?: NativeConversationContext): NativeConversationValidation {
  const issues: ConversationCompatibilityIssue[] = [];
  const strict = Boolean(context);
  const add = (code: string, message: string, index: number, field = "", severity: "error" | "warning" | "info" = "error", repairable = false) => issues.push({ severity, code: `codex.${code}`, message, path: `$records[${index}]${field}`, repairable });
  let records: RecordValue[];
  try { records = parseRecords(jsonl); } catch (failure) { return { valid: false, compatibilityVersion: CODEX_COMPATIBILITY_VERSION, issues: [{ ...error("invalid-jsonl", "Use one complete JSON object per line; fix the malformed line before importing."), path: `$lines[${typeof (failure as { line?: number }).line === "number" ? (failure as { line: number }).line - 1 : 0}]`, repairable: true }] }; }
  const meta = object(records[0]?.payload);
  if (records[0]?.type !== "session_meta" || !meta) add("missing-session-meta", "Start the rollout with its session_meta record.", 0, "", "error", true);
  else {
    for (const key of ["id", "timestamp", "cwd", "originator", "cli_version"]) if (typeof meta[key] !== "string" || !meta[key]) add("invalid-session-meta", `Provide the required session_meta ${key} string.`, 0, `.payload.${key}`, "error", true);
    if (!UUID.test(String(meta.id))) add("invalid-session-id", "Use a valid UUID thread ID.", 0, ".payload.id", "error", true);
    if (meta.session_id != null && !UUID.test(String(meta.session_id))) add("invalid-session-id", "session_id must be a UUID.", 0, ".payload.session_id", "error", true);
    if (strict && meta.session_id !== meta.id) add("invalid-session-id", "New root clones require session_id to match id.", 0, ".payload.session_id", "error", true);
    if (!validTime(meta.timestamp)) add("invalid-session-time", "Use an RFC3339 session timestamp.", 0, ".payload.timestamp", "error", true);
    if (typeof meta.cwd !== "string" || !isAbsolute(meta.cwd)) add("invalid-session-cwd", "Use an absolute native working-directory path.", 0, ".payload.cwd", "error", true);
    if (meta.history_mode != null && meta.history_mode !== "legacy" && meta.history_mode !== "paginated") add("unknown-history-mode", "This validator supports legacy and paginated Codex history modes.", 0, ".payload.history_mode");
    if (meta.history_base) add("incomplete-history", "This physical rollout inherits an external prefix. Materialize it through the Codex read-only history reader before cloning.", 0, ".payload.history_base", "error", true);
    if (typeof meta.cli_version === "string" && meta.cli_version !== "0.164.0") add("version-drift", "Detailed compatibility is verified against Codex 0.164.0; validate this version with its installed parser as well.", 0, ".payload.cli_version", "warning");
    if (strict) {
      if (meta.history_mode !== "legacy") add("clone-history-mode", "New portable clones must use self-contained legacy history.", 0, ".payload.history_mode");
      if (meta.id !== context!.sessionId || meta.cwd !== context!.cwd) add("context-mismatch", "Output identity and directory must match the requested target.", 0, ".payload");
      for (const key of ["base_instructions", "dynamic_tools", "selected_capability_roots", "parent_thread_id", "forked_from_id"]) if (meta[key] != null) add("unsafe-source-context", `Do not transplant source ${key} into a new clone.`, 0, `.payload.${key}`);
    }
  }
  const calls = new Map<string, string>(); const seenCalls = new Set<string>();
  let activeTurn: string | undefined;
  for (const [index, record] of records.entries()) {
    if (!validTime(record.timestamp)) add("invalid-timestamp", "Use a valid RFC3339 record timestamp.", index, ".timestamp", "error", true);
    const payload = object(record.payload);
    if (!payload) { add("invalid-payload", "Provide a JSON object payload.", index, ".payload", "error", true); continue; }
    if (index === 0) continue;
    if (record.type === "session_meta") { add("additional-session-meta", "Additional historical metadata is not the thread's canonical identity.", index, "", strict ? "error" : "info"); continue; }
    if (record.type === "event_msg") {
      if (payload.type === "task_started") {
        if (activeTurn || typeof payload.turn_id !== "string" || !payload.turn_id) add("invalid-turn-boundary", "Each turn start needs an ID and a completed preceding turn.", index, ".payload.turn_id");
        activeTurn = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
      } else if (payload.type === "task_complete") {
        if (!activeTurn || activeTurn !== payload.turn_id) add("invalid-turn-boundary", "Match task_complete to its task_started turn ID.", index, ".payload.turn_id");
        if (strict && calls.size) add("pending-tools", "Finish tool pairs before completing the imported turn.", index, ".payload");
        activeTurn = undefined;
      } else if (payload.type === "user_message" || payload.type === "agent_message") {
        if (typeof payload.message !== "string") add("invalid-display-message", "The display message must be a string.", index, ".payload.message");
      } else add("opaque-event", "This event type is outside the portable validator subset; retain it and check with the matching Codex parser.", index, ".payload.type", strict ? "error" : "warning");
      continue;
    }
    if (record.type !== "response_item") {
      if (strict) add("unsafe-native-record", "New clones may not replay source policy, runtime, or opaque control records.", index);
      else if (record.type === "world_state") { if (typeof payload.full !== "boolean" || !object(payload.state)) add("invalid-world-state", "world_state requires full:boolean and state:object.", index, ".payload"); }
      else if (record.type === "turn_context") { if (typeof payload.cwd !== "string" || !isAbsolute(payload.cwd) || typeof payload.model !== "string" || payload.approval_policy == null || !object(payload.sandbox_policy)) add("invalid-turn-context", "turn_context requires absolute cwd, model, approval_policy and sandbox_policy.", index, ".payload"); else add("opaque-policy-context", "Historical policy context is retained, never activated by a clone; full policy-version validation requires its Codex parser.", index, ".payload", "warning"); }
      else add("opaque-record", "This record is outside the verified portable subset; check it with the matching Codex parser.", index, ".type", "warning");
      continue;
    }
    if (payload.type === "message") {
      const roles = strict ? ["user", "assistant"] : ["system", "developer", "user", "assistant"];
      if (!roles.includes(String(payload.role))) add("invalid-role", "Use a supported message role; tool outputs are standalone response items.", index, ".payload.role", "error", true);
      if (!Array.isArray(payload.content) || !payload.content.length) add("invalid-content", "Messages require a non-empty content array.", index, ".payload.content", "error", true);
      else for (const [blockIndex, value] of payload.content.entries()) {
        const block = object(value); const path = `.payload.content[${blockIndex}]`;
        if (!block || !["input_text", "output_text", "input_image", "input_audio"].includes(String(block.type))) add("unsupported-content-type", "Use input_text, output_text, input_image or input_audio; native tool calls must not be nested in content.", index, path, "error", true);
        else if (block.type === "input_image" ? typeof block.image_url !== "string" && typeof block.file_id !== "string" : block.type === "input_audio" ? typeof block.audio_url !== "string" : typeof block.text !== "string") add("invalid-content-value", "Provide the value required by this content type.", index, path, "error", true);
      }
      if (payload.phase != null && (payload.role !== "assistant" || !PHASES.has(String(payload.phase)))) add("invalid-phase", "Assistant phase must be commentary, partial_answer or final_answer.", index, ".payload.phase", "error", true);
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      if (typeof payload.call_id !== "string" || !payload.call_id || seenCalls.has(payload.call_id) || typeof payload.name !== "string" || !payload.name || typeof payload[payload.type === "function_call" ? "arguments" : "input"] !== "string") add("invalid-tool-call", "Tool calls need unique call_id, a name and string arguments/input.", index, ".payload", "error", true);
      else { calls.set(payload.call_id, payload.type); seenCalls.add(payload.call_id); }
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const expected = payload.type === "function_call_output" ? "function_call" : "custom_tool_call";
      if (typeof payload.call_id !== "string" || calls.get(payload.call_id) !== expected || !validToolOutput(payload.output)) add("orphan-tool-output", "Place output after its matching call and preserve the correct call_id/type.", index, ".payload.call_id", "error", true);
      else calls.delete(payload.call_id);
    } else if (payload.type === "reasoning") {
      if (!Array.isArray(payload.summary) || payload.encrypted_content != null && typeof payload.encrypted_content !== "string") add("invalid-reasoning", "Reasoning requires a summary array and optional encrypted string.", index, ".payload");
      if (strict) add("protected-reasoning", "Protected reasoning cannot be synthesized or replayed in a portable clone.", index, ".payload");
    } else add("opaque-response-item", "This response type is outside the verified subset; retain it and check with its installed Codex parser.", index, ".payload.type", strict ? "error" : "warning");
  }
  if (calls.size) add("incomplete-tool-pairs", "The file ends with unresolved tool calls; include their results or convert the incomplete section to readable context.", Math.max(records.length - 1, 0), "", "error", true);
  if (activeTurn) add("incomplete-turn", "This turn has no completion marker. Re-read an active source or explicitly close an imported historical turn.", Math.max(records.length - 1, 0), "", "error", true);
  return { valid: !issues.some(value => value.severity === "error"), complete: !issues.some(value => /opaque|incomplete|version-drift/.test(value.code)), compatibilityVersion: CODEX_COMPATIBILITY_VERSION, issues };
}

/** Parse model-context records once; matching event_msg projections are not duplicate messages. */
export function importCodexConversation(jsonl: string, sourcePath: string): UniversalThread {
  const records = parseRecords(jsonl);
  const meta = records.map(record => record.type === "session_meta" ? object(record.payload) : undefined).find(Boolean) ?? {};
  if (meta.history_base) throw new Error("This Codex rollout references inherited history. Use readCodexConversation to materialize its complete visible history.");
  const id = typeof meta.id === "string" ? meta.id : createHash("sha256").update(sourcePath).digest("hex").slice(0, 32);
  const fallback = validTime(meta.timestamp) ? String(meta.timestamp) : new Date(0).toISOString();
  const messages = records.flatMap((record, index) => {
    if (record.type !== "response_item") return [];
    const payload = object(record.payload);
    if (!payload) return [];
    const content = responseToContent(payload);
    if (!content.length) return [];
    const role = payload.type === "message" && ["system", "developer", "user", "assistant"].includes(String(payload.role)) ? payload.role as UniversalMessage["role"] : payload.type === "function_call_output" || payload.type === "custom_tool_call_output" ? "tool" : "assistant";
    return [{ id: `${sourcePath}:${index}`, role, timestamp: validTime(record.timestamp) ? String(record.timestamp) : fallback, content, providerMessageId: typeof payload.id === "string" ? payload.id : undefined, provenance: { harness: "codex" as const, sourcePath, rawIndex: index }, providerHints: { payloadType: payload.type, ...(typeof payload.phase === "string" ? { phase: payload.phase } : {}) }, providerRaw: record }];
  });
  const firstUser = messages.find(message => message.role === "user");
  return { id: `codex:${id}`, harness: "codex", sourcePath, projectPath: typeof meta.cwd === "string" ? meta.cwd : dirname(sourcePath), title: firstUser ? firstUser.content.map(describeBlock).join(" ").slice(0, 100) : basename(sourcePath), startedAt: messages[0]?.timestamp ?? fallback, updatedAt: messages.at(-1)?.timestamp ?? fallback, messages, rawEvents: records.map((raw, index) => ({ id: `${sourcePath}:${index}`, timestamp: validTime(raw.timestamp) ? String(raw.timestamp) : fallback, harness: "codex", eventType: String(raw.type ?? "unknown"), raw })), providerMetadata: { sessionId: id, sessionMeta: meta, codexHistory: { mode: "self-contained-rollout", complete: meta.history_mode !== "paginated", historyMode: meta.history_mode ?? "legacy", ...(meta.history_mode === "paginated" ? { note: "Physical paginated records are an indexing view only; use the official history reader for a complete visible conversation." } : {}) } } };
}

export function codexHasInheritedHistory(jsonl: string): boolean {
  const first = parseRecords(jsonl).find(record => record.type === "session_meta");
  return Boolean(object(first?.payload)?.history_base);
}

/** Paginated projections may contain retained/reverted history even without an external base. */
export function codexRequiresMaterialization(jsonl: string): boolean {
  const first = parseRecords(jsonl).find(record => record.type === "session_meta");
  const meta = object(first?.payload);
  return Boolean(meta?.history_base) || meta?.history_mode === "paginated";
}

export function codexSessionIndexEntry(context: NativeConversationContext): { id: string; thread_name: string; updated_at: string } {
  return { id: context.sessionId, thread_name: context.title, updated_at: context.createdAt };
}

function responseToContent(payload: RecordValue): UniversalContentBlock[] {
  switch (payload.type) {
    case "message": return Array.isArray(payload.content) ? payload.content.map(value => {
      const block = object(value);
      if (!block) return { type: "unknown", raw: value };
      if ((block.type === "input_text" || block.type === "output_text") && typeof block.text === "string") return { type: "text", text: block.text, providerType: String(block.type), providerRaw: block };
      if (block.type === "input_image") return { type: "image", source: typeof block.image_url === "string" ? block.image_url : undefined, providerType: "input_image", providerRaw: block };
      return { type: "unknown", raw: block, providerType: String(block.type), providerRaw: block };
    }) : [];
    case "function_call":
    case "custom_tool_call": {
      let input: RecordValue = {};
      if (payload.type === "function_call" && typeof payload.arguments === "string") { try { input = object(JSON.parse(payload.arguments)) ?? { value: JSON.parse(payload.arguments) }; } catch { input = { unparsedArguments: payload.arguments }; } }
      else input = { input: payload.input };
      return [{ type: "tool_use", toolCallId: String(payload.call_id ?? ""), name: String(payload.name ?? ""), input, providerType: String(payload.type), providerRaw: payload }];
    }
    case "function_call_output":
    case "custom_tool_call_output": return [{ type: "tool_result", toolCallId: String(payload.call_id ?? ""), content: typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? ""), providerType: String(payload.type), providerRaw: payload }];
    case "reasoning": return [{ type: "thinking", thinking: Array.isArray(payload.summary) ? payload.summary.map(value => object(value)?.text).filter(value => typeof value === "string").join("\n") : "", providerType: "reasoning", providerRaw: payload }];
    default: return [{ type: "unknown", raw: payload, providerType: String(payload.type ?? "unknown"), providerRaw: payload }];
  }
}

function closedNativeCalls(messages: UniversalMessage[], sourceHarness: NativeConversationContext["sourceHarness"]): Set<string> {
  const pending = new Set<string>(); const complete = new Set<string>(); const invalid = new Set<string>();
  for (const message of messages) {
    if (message.role === "user" && message.content.some(block => block.type !== "tool_result")) for (const id of pending) invalid.add(id);
    for (const block of message.content) {
    if ((block.type === "tool_use" || block.type === "tool_result") && (message.provenance?.harness ?? sourceHarness) !== "codex") invalid.add(block.toolCallId);
    if (block.type === "tool_use") { if (!block.toolCallId || pending.has(block.toolCallId) || complete.has(block.toolCallId)) invalid.add(block.toolCallId); pending.add(block.toolCallId); }
    if (block.type === "tool_result") { if (!pending.delete(block.toolCallId) || complete.has(block.toolCallId)) invalid.add(block.toolCallId); complete.add(block.toolCallId); }
  }
  }
  return new Set([...complete].filter(id => !invalid.has(id) && !pending.has(id)));
}
function nativeBlockPayload(block: UniversalContentBlock, message: UniversalMessage): RecordValue | undefined { return object(block.providerRaw) ?? object(object(message.providerRaw)?.payload); }
function validToolOutput(value: unknown): boolean {
  return typeof value === "string" || Array.isArray(value) && value.every(item => {
    const block = object(item);
    return block?.type === "input_text" && typeof block.text === "string" || block?.type === "input_image" && (typeof block.image_url === "string" || typeof block.file_id === "string") || block?.type === "input_audio" && typeof block.audio_url === "string";
  });
}
function nativeOutput(raw: RecordValue | undefined, block: Extract<UniversalContentBlock, { type: "tool_result" }>, issues: ConversationCompatibilityIssue[], messageId: string, blockIndex: number): unknown {
  if (Array.isArray(raw?.output)) {
    if (typeof block.content === "string" && block.content === JSON.stringify(raw.output) && validToolOutput(raw.output)) return structuredClone(raw.output);
    issues.push({ ...issue("structured-tool-output", "Structured or protected tool output was converted to readable context; its original remains in the portable archive.", messageId), blockIndex });
    if (raw.output.some(value => object(value)?.type === "encrypted_content")) return "[Protected tool output is retained in the portable source archive.]";
  }
  return blockText(block.content);
}
function nativeArguments(raw: RecordValue | undefined, input: RecordValue): string { if (typeof raw?.arguments === "string") { try { if (JSON.stringify(JSON.parse(raw.arguments)) === JSON.stringify(input)) return raw.arguments; } catch { if (input.unparsedArguments === raw.arguments) return raw.arguments; } } return JSON.stringify(input); }
function nativePhase(message: UniversalMessage): string | undefined { const phase = message.providerHints?.phase ?? object(object(message.providerRaw)?.payload)?.phase; return typeof phase === "string" && PHASES.has(phase) ? phase : undefined; }
function isPortableImage(block: Extract<UniversalContentBlock, { type: "image" }>): boolean { return Boolean(block.data && (!block.mediaType || /^image\/[a-z0-9.+-]+$/i.test(block.mediaType)) || block.source && /^(https:\/\/|data:image\/)/i.test(block.source)); }
function blockText(content: string | UniversalContentBlock[]): string { return typeof content === "string" ? content : content.map(describeBlock).join("\n"); }
function describeBlock(block: UniversalContentBlock): string {
  switch (block.type) {
    case "text": return block.text;
    case "tool_use": return `[Historical tool call: ${block.name}]\n${JSON.stringify(block.input)}`;
    case "tool_result": return `[Historical tool result: ${block.toolCallId}${block.isError ? "; error" : ""}]\n${blockText(block.content)}`;
    case "thinking": return block.thinking ? `[Historical reasoning summary]\n${block.thinking}` : "[Protected reasoning is retained in the portable source archive.]";
    case "redacted_thinking": return "[Protected reasoning is retained in the portable source archive.]";
    case "image": return `[Image retained in portable source: ${block.source ?? block.mediaType ?? "embedded image"}]`;
    case "audio": return block.transcript ? `[Audio transcript]\n${block.transcript}` : "[Audio retained in portable source archive.]";
    case "document": return block.text ? `[Document]\n${block.text}` : `[Document retained in portable source: ${block.source ?? "attachment"}]`;
    case "unknown": return `[Historical ${block.providerType ?? "unsupported"} content is retained in the portable source archive.]`;
  }
}
function parseRecords(jsonl: string): RecordValue[] { return jsonl.split(/\r?\n/).flatMap((line, index) => { if (!line.trim()) return []; try { const value = object(JSON.parse(line)); if (!value) throw new Error(); return [value]; } catch { throw Object.assign(new Error(`Codex JSONL line ${index + 1} must be a complete JSON object.`), { line: index + 1 }); } }); }
function object(value: unknown): RecordValue | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined; }
function validTime(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false; const year = Number(value.slice(0, 4)); const month = Number(value.slice(5, 7)); const day = Number(value.slice(8, 10)); const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]; }
function issue(code: string, message: string, messageId?: string): ConversationCompatibilityIssue { return { severity: "warning", code: `codex.${code}`, message, ...(messageId ? { messageId } : {}) }; }
function error(code: string, message: string): ConversationCompatibilityIssue { return { severity: "error", code: `codex.${code}`, message }; }
function stableUuid(seed: string): string { const hex = createHash("sha256").update(seed).digest("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; }
