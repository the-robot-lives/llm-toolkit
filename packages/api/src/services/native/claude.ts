import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  ConversationCompatibilityIssue, NativeConversationAdapter, NativeConversationArtifact,
  NativeConversationContext, NativeConversationValidation, UniversalContentBlock,
  UniversalMessage, UniversalThread,
} from "@llm-toolkit/shared";

type JsonRecord = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const compatibilityVersion = "claude-code/2.1.311;agent-sdk-python/0.2.174";
// Anthropic Message response enum; broader than the generated clone subset.
const nativeStopReasons = new Set(["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal", "model_context_window_exceeded"]);
const absoluteCwd = (value: unknown) => typeof value === "string" && (/^\//.test(value) || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value));
const chainTypes = new Set(["user", "assistant", "progress", "system", "attachment"]);
const isObject = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): string => typeof value === "string" ? value : "";
const messageOf = (record: JsonRecord): JsonRecord => isObject(record.message) ? record.message : {};
const blocksOf = (record: JsonRecord): JsonRecord[] => Array.isArray(messageOf(record).content) ? (messageOf(record).content as unknown[]).filter(isObject) : [];
const visible = (record: JsonRecord): boolean => (record.type === "user" || record.type === "assistant") && !record.isMeta && !record.isSidechain && !record.teamName;
const blockIds = (record: JsonRecord, type: string, field: string): string[] => blocksOf(record).filter(b => b.type === type).map(b => string(b[field])).filter(Boolean);

/** Claude CLI/SDK project path encoding, including its 200-character limit. */
export function claudeProjectKey(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= 200) return sanitized;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

function readRecords(jsonl: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  jsonl.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid Claude JSONL at line ${index + 1}.`); }
    if (!isObject(value)) throw new Error(`Claude JSONL line ${index + 1} must contain an object.`);
    records.push(value);
  });
  return records;
}

/** Reconstructs the active parent chain; logical compaction backpointers are archival only. */
export function claudeConversationChain(records: JsonRecord[]): JsonRecord[] {
  const entries = records.filter(r => chainTypes.has(string(r.type)) && typeof r.uuid === "string");
  const byId = new Map(entries.map(r => [string(r.uuid), r]));
  const positions = new Map(entries.map((r, i) => [string(r.uuid), i]));
  const parents = new Set(entries.map(r => string(r.parentUuid)).filter(Boolean));
  const leaves: JsonRecord[] = [];
  for (const terminal of entries.filter(r => !parents.has(string(r.uuid)))) {
    let item: JsonRecord | undefined = terminal;
    const seen = new Set<string>();
    while (item && !seen.has(string(item.uuid))) {
      seen.add(string(item.uuid));
      if (visible(item)) { leaves.push(item); break; }
      item = byId.get(string(item.parentUuid));
    }
  }
  const leaf = leaves.sort((a, b) => (positions.get(string(b.uuid)) ?? -1) - (positions.get(string(a.uuid)) ?? -1))[0];
  if (!leaf) return [];
  const chain: JsonRecord[] = [];
  const reached = new Set<string>();
  let cursor: JsonRecord | undefined = leaf;
  while (cursor && !reached.has(string(cursor.uuid))) {
    reached.add(string(cursor.uuid)); chain.push(cursor);
    cursor = byId.get(string(cursor.parentUuid));
  }
  chain.reverse();

  // A streamed assistant response is split across entries sharing message.id.
  // Parallel tool results fan out; recover the sibling branches of responses
  // that are already on the active chain, never unrelated/subagent branches.
  const anchors = new Map<string, JsonRecord>();
  for (const r of chain) if (r.type === "assistant" && string(messageOf(r).id)) anchors.set(string(messageOf(r).id), r);
  const callOwners = new Map<string, string | null>();
  const siblingsByFamily = new Map<string, JsonRecord[]>();
  const familyByAssistantId = new Map<string, string>();
  const resultsByFamily = new Map<string, JsonRecord[]>();
  const answeredByFamily = new Map<string, Set<string>>();
  const uniqueEntries = [...byId.values()];
  for (const r of uniqueEntries) {
    if (r.type !== "assistant") continue;
    const family = string(messageOf(r).id);
    if (!family) continue;
    const siblings = siblingsByFamily.get(family) ?? [];
    siblings.push(r); siblingsByFamily.set(family, siblings);
    familyByAssistantId.set(string(r.uuid), family);
    for (const id of blockIds(r, "tool_use", "id")) {
      callOwners.set(id, callOwners.has(id) && callOwners.get(id) !== family ? null : family);
    }
  }
  for (const r of uniqueEntries) {
    if (r.type !== "user") continue;
    const ids = blockIds(r, "tool_result", "tool_use_id");
    if (!ids.length) continue;
    const families = new Set<string>();
    const parentFamily = familyByAssistantId.get(string(r.parentUuid));
    const sourceFamily = familyByAssistantId.get(string(r.sourceToolAssistantUUID));
    if (parentFamily) families.add(parentFamily);
    if (sourceFamily) families.add(sourceFamily);
    ids.forEach(id => { const owner = callOwners.get(id); if (owner) families.add(owner); });
    for (const family of families) {
      const bucket = resultsByFamily.get(family) ?? [];
      bucket.push(r); resultsByFamily.set(family, bucket);
      if (reached.has(string(r.uuid))) {
        const answered = answeredByFamily.get(family) ?? new Set<string>();
        ids.forEach(id => answered.add(id)); answeredByFamily.set(family, answered);
      }
    }
  }
  const inserts = new Map<string, JsonRecord[]>();
  for (const [family, anchor] of anchors) {
    const sameWriter = (r: JsonRecord) => Boolean(r.isSidechain) === Boolean(anchor.isSidechain) && r.agentId === anchor.agentId;
    const siblings = (siblingsByFamily.get(family) ?? []).filter(sameWriter);
    const siblingIds = new Set(siblings.map(r => string(r.uuid)));
    const results = (resultsByFamily.get(family) ?? []).filter(r => sameWriter(r) && !reached.has(string(r.uuid)));
    const answered = new Set(answeredByFamily.get(family) ?? []);
    const recoveredResults: JsonRecord[] = [];
    for (const result of results) {
      const ids = blockIds(result, "tool_result", "tool_use_id");
      const direct = siblingIds.has(string(result.parentUuid));
      const attributable = ids.some(id => callOwners.get(id) === family && !answered.has(id));
      if (!direct && !attributable) continue;
      recoveredResults.push(result); ids.forEach(id => answered.add(id));
    }
    const byTimestamp = (a: JsonRecord, b: JsonRecord) => string(a.timestamp).localeCompare(string(b.timestamp));
    const recovered = [...siblings.filter(r => !reached.has(string(r.uuid))).sort(byTimestamp), ...recoveredResults.sort(byTimestamp)];
    recovered.forEach(r => reached.add(string(r.uuid)));
    inserts.set(string(anchor.uuid), recovered);
  }
  return chain.flatMap(r => [r, ...(inserts.get(string(r.uuid)) ?? [])]).filter(visible);
}

function toUniversalBlock(raw: unknown): UniversalContentBlock {
  if (!isObject(raw)) return { type: "unknown", raw, providerRaw: raw };
  const meta = { providerType: string(raw.type), providerRaw: structuredClone(raw) };
  switch (raw.type) {
    case "text": return { type: "text", text: string(raw.text), ...meta };
    case "thinking": return { type: "thinking", thinking: string(raw.thinking), signature: typeof raw.signature === "string" ? raw.signature : undefined, ...meta };
    case "redacted_thinking": return { type: "redacted_thinking", data: typeof raw.data === "string" ? raw.data : undefined, ...meta };
    case "tool_use": return { type: "tool_use", toolCallId: string(raw.id), name: string(raw.name), input: isObject(raw.input) ? structuredClone(raw.input) : {}, ...meta };
    case "tool_result": return { type: "tool_result", toolCallId: string(raw.tool_use_id), content: Array.isArray(raw.content) ? raw.content.map(toUniversalBlock) : string(raw.content), isError: typeof raw.is_error === "boolean" ? raw.is_error : undefined, ...meta };
    case "image": {
      const source = isObject(raw.source) ? raw.source : {};
      return { type: "image", mediaType: typeof source.media_type === "string" ? source.media_type : undefined, data: source.type === "base64" ? string(source.data) : undefined, source: source.type === "url" ? string(source.url) : undefined, ...meta };
    }
    case "document": {
      const source = isObject(raw.source) ? raw.source : {};
      return { type: "document", mediaType: typeof source.media_type === "string" ? source.media_type : undefined, data: source.type === "base64" ? string(source.data) : undefined, text: source.type === "text" ? string(source.data) : undefined, source: source.type === "url" ? string(source.url) : undefined, ...meta };
    }
    default: return { type: "unknown", raw: structuredClone(raw), ...meta };
  }
}

/** Pure import. Raw events preserve archival data; messages are the SDK's active chain. */
export function importClaudeConversation(jsonl: string, sourcePath: string): UniversalThread {
  const records = readRecords(jsonl);
  const ordinal = new Map<JsonRecord, number>();
  const physicalIndices = new Map(records.map((record, index) => [record, index]));
  let contentIndex = 0;
  records.forEach(r => { if (r.type === "user" || r.type === "assistant") ordinal.set(r, contentIndex++); });
  const active = claudeConversationChain(records);
  if (!active.length) throw new Error("Claude transcript contains no active user/assistant message chain.");
  const messages: UniversalMessage[] = active.map(record => {
    const native = messageOf(record);
    const content = typeof native.content === "string" ? [{ type: "text" as const, text: native.content }] : Array.isArray(native.content) ? native.content.map(toUniversalBlock) : [];
    const id = createHash("sha256").update(`${sourcePath}:message:${ordinal.get(record)}:${record.uuid}`).digest("hex").slice(0, 16);
    return {
      id: `claude:${id}`, role: record.type === "assistant" ? "assistant" : "user", timestamp: string(record.timestamp), content,
      providerMessageId: string(record.uuid), model: typeof native.model === "string" ? native.model : undefined,
      stopReason: typeof native.stop_reason === "string" ? native.stop_reason : undefined,
      ...(isObject(native.usage) && typeof native.usage.input_tokens === "number" && typeof native.usage.output_tokens === "number" ? { usage: native.usage as unknown as UniversalMessage["usage"] } : {}),
      provenance: { harness: "claude", sourcePath, rawIndex: physicalIndices.get(record), parentId: typeof record.parentUuid === "string" ? record.parentUuid : null },
      providerHints: { sessionId: record.sessionId, isCompactSummary: record.isCompactSummary, isSidechain: record.isSidechain },
      providerMetadata: { apiMessageId: native.id }, providerRaw: structuredClone(record),
    };
  });
  const first = active[0]; const last = active[active.length - 1];
  const firstContent = records.find(r => r.type === "user" || r.type === "assistant") ?? first;
  const lastContent = [...records].reverse().find(r => r.type === "user" || r.type === "assistant") ?? last;
  const title = [...records].reverse().find(r => r.type === "custom-title" && typeof r.customTitle === "string")?.customTitle
    ?? [...records].reverse().find(r => r.type === "ai-title" && typeof r.aiTitle === "string")?.aiTitle
    ?? messages.find(m => m.role === "user")?.content.filter(b => b.type === "text").map(b => b.text).join(" ").slice(0, 120)
    ?? "Imported Claude conversation";
  const sessionId = string(first.sessionId) || basename(sourcePath, ".jsonl");
  return {
    id: `claude:${sessionId}`, harness: "claude", sourcePath, projectPath: string(last.cwd) || string(first.cwd), title: String(title),
    startedAt: string(firstContent.timestamp), updatedAt: string(lastContent.timestamp), messages,
    rawEvents: records.map((raw, i) => ({ id: `claude:${sourcePath}:${i}`, harness: "claude", eventType: string(raw.type), timestamp: string(raw.timestamp), raw: structuredClone(raw) })),
    providerMetadata: { sessionId, nativeFormat: "claude-code-jsonl", activeChain: true, archivalRecordCount: records.length },
  };
}

function nativeImage(block: UniversalContentBlock): JsonRecord | null {
  if (block.type !== "image" || !block.data || !/^(image\/(png|jpeg|gif|webp))$/.test(block.mediaType ?? "") || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data) || block.data.length % 4) return null;
  const bytes = Buffer.from(block.data, "base64");
  const mime = block.mediaType;
  const matches = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mime === "image/gif" ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))
    : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return matches ? { type: "image", source: { type: "base64", media_type: mime, data: block.data } } : null;
}

function textOf(block: UniversalContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return block.thinking;
  if (block.type === "tool_result") return typeof block.content === "string" ? block.content : block.content.map(textOf).join("\n");
  if (block.type === "document") return block.text ?? block.source ?? "[document data retained in portable archive]";
  if (block.type === "audio") return block.transcript ?? block.source ?? "[audio data retained in portable archive]";
  if (block.type === "image") return block.source ?? "[image data retained in portable archive]";
  if (block.type === "redacted_thinking") return "[redacted provider reasoning retained in portable archive]";
  return JSON.stringify(block.type === "unknown" ? block.raw : block);
}

export function renderClaudeConversation(thread: UniversalThread, context: NativeConversationContext): NativeConversationArtifact {
  const issues: ConversationCompatibilityIssue[] = [];
  const records: JsonRecord[] = [];
  const isClaudeMessage = (message: UniversalMessage) => (message.provenance?.harness ?? context.sourceHarness) === "claude";
  const uses = new Map<string, number[]>(); const results = new Map<string, number[]>();
  thread.messages.forEach((m, i) => m.content.forEach(b => {
    if (b.type === "tool_use") uses.set(b.toolCallId, [...(uses.get(b.toolCallId) ?? []), i]);
    if (b.type === "tool_result") results.set(b.toolCallId, [...(results.get(b.toolCallId) ?? []), i]);
  }));
  const paired = (id: string) => {
    if (uses.get(id)?.length !== 1 || results.get(id)?.length !== 1) return false;
    const from = uses.get(id)![0]; const to = results.get(id)![0];
    if (from >= to || !isClaudeMessage(thread.messages[from]) || !isClaudeMessage(thread.messages[to]) || thread.messages[from].role !== "assistant" || !["user", "tool"].includes(thread.messages[to].role)) return false;
    const family = (message: UniversalMessage) => isObject(message.providerRaw) ? string(messageOf(message.providerRaw).id) : "";
    const ownerFamily = family(thread.messages[from]);
    return thread.messages.slice(from + 1, to).every(m => m.role === "assistant"
      ? Boolean(ownerFamily) && family(m) === ownerFamily
      : m.content.some(b => b.type === "tool_result"));
  };
  let parentUuid: string | null = null;
  const assistantIds = new Map<string, string>();
  for (const message of thread.messages) {
    const sameHarness = isClaudeMessage(message);
    const issue = (code: string, text: string, blockIndex?: number) => issues.push({ severity: "warning", code, message: text, messageId: message.id, blockIndex });
    const content: JsonRecord[] = [];
    if (message.providerHints?.isCompactSummary) issue("historical-compaction-summary", "The source compaction summary is retained as readable context; source compaction checkpoints are not replayed.");
    if (message.role === "system" || message.role === "developer") {
      content.push({ type: "text", text: `[Imported ${message.role} context — historical text, not a system instruction]\n${message.content.map(textOf).join("\n")}` });
      issue("historical-privileged-context", "System/developer context is included as historical user text, not active target instructions.");
    } else message.content.forEach((block, index) => {
      const sourceRaw = isObject(block.providerRaw) ? block.providerRaw : {};
      switch (block.type) {
        case "text": content.push({ type: "text", text: block.text }); break;
        case "tool_use":
          if (sameHarness && paired(block.toolCallId) && message.role === "assistant" && block.name) content.push({ type: "tool_use", id: block.toolCallId, name: block.name, input: structuredClone(block.input) });
          else { content.push({ type: "text", text: `[Historical tool call ${block.toolCallId}: ${block.name}]\n${JSON.stringify(block.input)}` }); issue("historical-tool-call", "Tool call rendered as history; foreign or incomplete tool transactions are not replayed.", index); }
          break;
        case "tool_result":
          if (sameHarness && paired(block.toolCallId) && message.role !== "assistant") content.push({ type: "tool_result", tool_use_id: block.toolCallId, content: typeof block.content === "string" ? block.content : block.content.map(b => {
            const image = nativeImage(b);
            if (image) return image;
            if (b.type !== "text") issue("historical-tool-result-content", "Unsupported nested tool-result content is rendered as text; original data remains in the portable archive.", index);
            return { type: "text", text: textOf(b) };
          }), ...(block.isError === undefined ? {} : { is_error: block.isError }) });
          else { content.push({ type: "text", text: `[Historical tool result ${block.toolCallId}${block.isError ? " (error)" : ""}]\n${textOf(block)}` }); issue("historical-tool-result", "Tool result rendered as historical text for target compatibility.", index); }
          break;
        case "thinking":
          if (sameHarness && block.signature && sourceRaw.type === "thinking" && sourceRaw.signature === block.signature && sourceRaw.thinking === block.thinking && message.role === "assistant") content.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
          else { content.push({ type: "text", text: `[Historical reasoning]\n${block.thinking}` }); issue("historical-reasoning", "Reasoning is rendered as text because its original target-compatible signature cannot be preserved.", index); }
          break;
        case "redacted_thinking":
          if (sameHarness && block.data && sourceRaw.type === "redacted_thinking" && sourceRaw.data === block.data && message.role === "assistant") content.push({ type: "redacted_thinking", data: block.data });
          else { content.push({ type: "text", text: textOf(block) }); issue("opaque-reasoning", "Opaque provider reasoning remains in the portable archive, not a fabricated target reasoning block.", index); }
          break;
        case "image":
          if (message.role !== "assistant" && nativeImage(block)) content.push(nativeImage(block)!);
          else { content.push({ type: "text", text: `[Historical image: ${textOf(block)}]` }); issue("historical-image", "Image reference remains readable; unsupported or external image data is not fetched.", index); }
          break;
        default: content.push({ type: "text", text: `[Historical ${block.type}]\n${textOf(block)}` }); issue("historical-block", `${block.type} is retained as readable history; its native representation remains in the portable archive.`, index);
      }
    });
    if (!content.length) { issue("empty-message", "Empty source message omitted from native transcript."); continue; }
    const uuid = randomUUID();
    const role = message.role === "assistant" ? "assistant" : "user";
    const native: JsonRecord = { role, content };
    if (role === "assistant") {
      const rawMessage = isObject(message.providerRaw) ? messageOf(message.providerRaw) : {};
      const sourceId = sameHarness ? string(rawMessage.id) || message.id : message.id;
      if (!assistantIds.has(sourceId)) assistantIds.set(sourceId, `msg_${randomUUID().replaceAll("-", "")}`);
      const stopReason = content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn";
      // Stop reasons describe the emitted response, never a foreign provider's
      // completed/flattened source transaction or a source streaming checkpoint.
      if (message.stopReason != null && message.stopReason !== stopReason) issue("stop-reason-normalized", "Source stop reason was normalized to match the emitted Claude response blocks.");
      Object.assign(native, { id: assistantIds.get(sourceId), type: "message", ...(sameHarness && message.model ? { model: message.model } : {}), stop_reason: stopReason, stop_sequence: null });
      if (message.usage && sameHarness) native.usage = structuredClone(message.usage);
      if (!sameHarness && message.model) issue("source-model-not-restored", "Source model metadata remains in the portable archive; the target CLI uses its own model configuration.");
    }
    records.push({ type: role, uuid, parentUuid, sessionId: context.sessionId, timestamp: message.timestamp || context.createdAt, cwd: context.cwd, isSidechain: false, userType: "external", ...(context.cliVersion ? { version: context.cliVersion } : {}), message: native });
    parentUuid = uuid;
  }
  records.push({ type: "custom-title", customTitle: context.title, sessionId: context.sessionId });
  const jsonl = `${records.map(r => JSON.stringify(r)).join("\n")}\n`;
  issues.push(...validateClaudeConversation(jsonl, context).issues);
  return { harness: "claude", sessionId: context.sessionId, relativePath: `${claudeProjectKey(context.cwd)}/${context.sessionId}.jsonl`, records, jsonl, issues, resumeArgs: ["claude", "--resume", context.sessionId] };
}

export function validateClaudeConversation(jsonl: string, context?: NativeConversationContext): NativeConversationValidation {
  const issues: ConversationCompatibilityIssue[] = [];
  let location = "/records";
  const fail = (code: string, message: string, path = location) => issues.push(Object.assign({ severity: "error" as const, code, message }, { path, repairable: false }));
  let records: JsonRecord[];
  try { records = readRecords(jsonl); } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSONL.";
    const line = Number(message.match(/line (\d+)/)?.[1] ?? 1) - 1;
    const issue = Object.assign({ severity: "error" as const, code: "invalid-jsonl", message }, { path: `/lines/${line}`, repairable: false });
    return Object.assign({ valid: false, issues: [issue] }, { compatibilityVersion, complete: false });
  }
  if (!context) {
    const checked = validateExistingClaudeRecords(records);
    if (jsonl && !jsonl.endsWith("\n")) checked.issues.push(Object.assign({ severity: "warning" as const, code: "missing-final-newline", message: "Append one final newline before continuing this append-only transcript; its last JSON record is otherwise complete." }, { path: "/end-of-file", repairable: true, suggestion: "Append a single newline without changing any JSON record." }));
    return checked;
  }
  if (jsonl && !jsonl.endsWith("\n")) issues.push(Object.assign({ severity: "error" as const, code: "missing-final-newline", message: "Native clones must end in a newline so the CLI can append safely." }, { path: "/end-of-file", repairable: true, suggestion: "Append a single newline." }));
  const seen = new Set<string>(); const pending = new Set<string>();
  let pendingResponse = "";
  let previous: string | null = null; let sessionId = context?.sessionId;
  for (const [recordIndex, record] of records.entries()) {
    location = `/records/${recordIndex}`;
    if (record.type === "custom-title") { if (sessionId && record.sessionId !== sessionId) fail("session-mismatch", "Title sessionId differs from the target session."); continue; }
    if (record.type !== "user" && record.type !== "assistant") { fail("unsupported-native-entry", "New native conversations may contain only user, assistant, and custom-title entries."); continue; }
    const id = string(record.uuid);
    if (!UUID.test(id) || seen.has(id)) fail("invalid-message-id", "Native message UUIDs must be unique UUIDs.");
    if (record.parentUuid !== previous) fail("broken-parent-chain", "Native message parentUuid must refer to the preceding message, or null at the root.");
    previous = id; seen.add(id);
    sessionId ??= string(record.sessionId);
    if (!UUID.test(string(record.sessionId)) || record.sessionId !== sessionId) fail("session-mismatch", "Every native message must use the same valid target session UUID.");
    if (!absoluteCwd(record.cwd) || (context && record.cwd !== context.cwd)) fail("invalid-cwd", "Native cwd must be the absolute target working directory.");
    if (!Number.isFinite(Date.parse(string(record.timestamp)))) fail("invalid-timestamp", "Native messages require ISO-compatible timestamps.");
    if (record.isSidechain !== false || record.isMeta || record.permissionMode || record.teamName || record.agentSetting) fail("unsafe-native-state", "Clones must not restore source permission, sidechain, meta, or agent configuration.");
    const message = messageOf(record);
    if (message.role !== record.type || !Array.isArray(message.content) || !message.content.length) { fail("invalid-native-message", "Native message role/content does not match its record type."); continue; }
    const content = message.content as unknown[];
    if (record.type === "assistant") {
      if (!string(message.id)) fail("invalid-assistant-id", "Assistant API message id must be a nonempty string.", `${location}/message/id`);
      if (message.type !== "message") fail("invalid-assistant-type", "Assistant API message type must be message.", `${location}/message/type`);
      if (!nativeStopReasons.has(string(message.stop_reason))) fail("invalid-stop-reason", "Assistant stop reason is not a supported Claude response value.", `${location}/message/stop_reason`);
      const usesTool = content.some(b => isObject(b) && b.type === "tool_use");
      if (usesTool !== (message.stop_reason === "tool_use")) fail("stop-reason-content-mismatch", "Generated stop reason must match whether this response emits native tool calls.", `${location}/message/stop_reason`);
      if (message.stop_reason === "stop_sequence" && !string(message.stop_sequence)) fail("invalid-stop-sequence", "A stop_sequence response requires the matched sequence string.", `${location}/message/stop_sequence`);
    }
    if (pending.size && record.type === "assistant" && message.id !== pendingResponse) fail("interrupted-tool-transaction", "A new assistant response appears before earlier tool calls have results.");
    if (pending.size && record.type === "user" && !content.some(b => isObject(b) && b.type === "tool_result")) fail("interrupted-tool-transaction", "A user turn interrupts an unanswered tool transaction.");
    let nonResultSeen = false;
    for (const raw of content) {
      if (!isObject(raw)) { fail("invalid-content-block", "Native content blocks must be objects."); continue; }
      if (raw.type === "text" && typeof raw.text === "string") { nonResultSeen = true; continue; }
      if (raw.type === "tool_use") {
        if (record.type !== "assistant" || !string(raw.id) || !string(raw.name) || !isObject(raw.input) || pending.has(string(raw.id))) fail("invalid-tool-call", "Tool calls require an assistant, unique id, name, and object input.");
        pending.add(string(raw.id)); pendingResponse = string(message.id); continue;
      }
      if (raw.type === "tool_result") {
        if (nonResultSeen) fail("tool-result-order", "Tool results must appear before text in their user message.");
        if (record.type !== "user" || !pending.delete(string(raw.tool_use_id)) || !(typeof raw.content === "string" || Array.isArray(raw.content))) fail("orphan-tool-result", "Tool results must follow a matching assistant tool call.");
        if (Array.isArray(raw.content)) for (const child of raw.content) {
          if (!isObject(child) || !(child.type === "text" && typeof child.text === "string" || child.type === "image" && isObject(child.source) && nativeImage({ type: "image", mediaType: string(child.source.media_type), data: string(child.source.data) }))) fail("unsupported-tool-result-content", "Tool results can contain only validated text or inline image blocks in the supported native subset.");
        }
        if (raw.is_error !== undefined && typeof raw.is_error !== "boolean") fail("invalid-tool-error-flag", "Tool result is_error must be a boolean.");
        continue;
      }
      if (raw.type === "thinking" && record.type === "assistant" && typeof raw.thinking === "string" && string(raw.signature)) continue;
      if (raw.type === "redacted_thinking" && record.type === "assistant" && string(raw.data)) continue;
      if (raw.type === "image" && record.type === "user" && isObject(raw.source) && nativeImage({ type: "image", mediaType: string(raw.source.media_type), data: string(raw.source.data) })) continue;
      fail("unsupported-content-block", "Native block is unsupported or has incomplete required fields.");
    }
  }
  if (!seen.size) fail("empty-conversation", "Native conversation requires at least one user or assistant message.");
  if (pending.size) fail("unanswered-tool-call", "Native conversation contains unanswered tool calls.");
  return Object.assign({ valid: !issues.some(i => i.severity === "error"), issues }, { compatibilityVersion, complete: !issues.some(i => i.severity === "error") });
}

const metadataTypes = new Set([
  "custom-title", "ai-title", "agent-name", "agent-setting", "permission-mode", "mode", "atis-latch",
  "queue-operation", "last-prompt", "tools-used", "file-history-snapshot", "file-history-delta", "pr-link",
  "api-request-shape", "api-request-blob", "api-request", "content-replacement", "tag", "summary",
]);

/** Existing native transcripts are graphs with metadata, not generated linear clones. */
function validateExistingClaudeRecords(records: JsonRecord[]): NativeConversationValidation {
  type LocatedIssue = ConversationCompatibilityIssue & { path: string; repairable: boolean };
  const issues: LocatedIssue[] = [];
  const add = (severity: "error" | "warning" | "info", code: string, message: string, index: number, field = "", repairable = false) => {
    issues.push({ severity, code, message, path: `/records/${index}${field ? `/${field}` : ""}`, repairable });
  };
  const byId = new Map<string, JsonRecord>();
  const indices = new Map<JsonRecord, number>();
  let mainSession: string | undefined;
  records.forEach((r, index) => {
    indices.set(r, index);
    const type = string(r.type);
    if (["session_meta", "response_item", "event_msg", "turn_context"].includes(type)) {
      add("error", "foreign-native-format", "This is a Codex event. Select the Codex validator or convert through the portable conversation format.", index, "type"); return;
    }
    if (["result", "stream_event"].includes(type)) {
      add("error", "sdk-stream-not-transcript", "SDK result/stream events are not native transcript entries. Use the session transcript file rather than CLI stream-json output.", index, "type"); return;
    }
    if (!chainTypes.has(type)) {
      if (!metadataTypes.has(type)) add("warning", "unknown-native-entry", "Entry type is not covered by the tested Claude version. Preserve it and check it against the installed CLI before editing.", index, "type");
      return;
    }
    const id = string(r.uuid);
    if (!UUID.test(id)) add("error", "invalid-message-id", "Transcript chain entries need a valid UUID. Regenerate IDs and every referencing parent link together in a new clone.", index, "uuid");
    if (byId.has(id)) add("warning", "duplicate-message-id", "A UUID occurs more than once. The SDK uses the last entry; inspect whether this is an intentional streaming replacement before changing it.", index, "uuid");
    byId.set(id, r);
    if (r.parentUuid !== null && (typeof r.parentUuid !== "string" || !UUID.test(r.parentUuid))) add("error", "invalid-parent-id", "parentUuid must be null at a root or a valid message UUID.", index, "parentUuid");
    if (r.type !== "user" && r.type !== "assistant") return;
    if (!UUID.test(string(r.sessionId))) add("error", "invalid-session-id", "Messages need a valid sessionId UUID matching their transcript file.", index, "sessionId");
    if (!r.isSidechain && !r.teamName) {
      mainSession ??= string(r.sessionId);
      if (r.sessionId !== mainSession) add("error", "session-mismatch", "Main-chain messages contain different session IDs. Use a clone operation that rewrites all IDs consistently.", index, "sessionId");
    }
    if (!absoluteCwd(r.cwd)) add("error", "invalid-cwd", "Message cwd is missing or is not an absolute Unix/Windows directory. Choose the intended destination when cloning.", index, "cwd");
    if (!Number.isFinite(Date.parse(string(r.timestamp)))) add("error", "invalid-timestamp", "Message timestamp is missing or invalid. Preserve a valid original timestamp or supply an explicit replacement in a clone.", index, "timestamp");
    const m = messageOf(r);
    if (r.type === "assistant") {
      if (!string(m.id)) add("error", "invalid-assistant-id", "Assistant API message id must be a nonempty string.", index, "message/id");
      if (m.type !== "message") add("error", "invalid-assistant-type", "Assistant API message type must be message.", index, "message/type");
      if (m.stop_reason === null || m.stop_reason === undefined) add("warning", "pending-stop-reason", "Assistant stop reason is incomplete, as in an interrupted streaming response. Review before continuing it.", index, "message/stop_reason");
      else if (!nativeStopReasons.has(string(m.stop_reason))) add("error", "invalid-stop-reason", "Assistant stop reason is not a supported Claude response value.", index, "message/stop_reason");
      if (m.stop_reason === "stop_sequence" && !string(m.stop_sequence)) add("error", "invalid-stop-sequence", "A stop_sequence response requires the matched sequence string.", index, "message/stop_sequence");
    }
    if (m.role !== r.type) add("error", "invalid-native-role", "The message role must match its user/assistant transcript entry type.", index, "message/role");
    if (!(typeof m.content === "string" || Array.isArray(m.content))) add("error", "invalid-native-content", "Message content must be a string or an array of content blocks.", index, "message/content");
    for (const [blockIndex, block] of (Array.isArray(m.content) ? m.content : []).entries()) {
      const field = `message/content/${blockIndex}`;
      if (!isObject(block)) { add("error", "invalid-content-block", "Content blocks must be objects.", index, field); continue; }
      switch (block.type) {
        case "text": if (typeof block.text !== "string") add("error", "invalid-text-block", "Text blocks require a text string.", index, `${field}/text`); break;
        case "tool_use":
          if (r.type !== "assistant" || !string(block.id) || !string(block.name) || !isObject(block.input)) add("error", "invalid-tool-call", "Tool use requires an assistant role, call ID, tool name, and object input.", index, field);
          break;
        case "tool_result":
          if (r.type !== "user" || !string(block.tool_use_id) || !(typeof block.content === "string" || Array.isArray(block.content))) add("error", "invalid-tool-result", "Tool result requires a user role, matching call ID, and string/block-array content.", index, field);
          break;
        case "thinking":
          if (r.type !== "assistant" || typeof block.thinking !== "string") add("error", "invalid-thinking-block", "Thinking blocks require assistant role and text.", index, field);
          if (!string(block.signature)) add("warning", "missing-thinking-signature", "Thinking has no usable signature. Convert it to historical text before changing providers; signatures cannot be fabricated.", index, `${field}/signature`);
          break;
        case "redacted_thinking": if (r.type !== "assistant" || !string(block.data)) add("error", "invalid-redacted-thinking", "Redacted thinking requires its original opaque data and assistant role.", index, field); break;
        case "image":
        case "document": if (!isObject(block.source)) add("error", "invalid-attachment", "Attachment blocks require a native source object. Preserve original data or use a readable historical reference.", index, `${field}/source`); break;
        default: add("warning", "unvalidated-content-block", "This provider content block is outside the tested adapter subset. Keep its original data and verify with the installed CLI before conversion.", index, `${field}/type`);
      }
    }
  });
  for (const [id, record] of byId) {
    const index = indices.get(record) ?? 0;
    if (typeof record.parentUuid === "string" && !byId.has(record.parentUuid)) add("error", "missing-parent", "parentUuid references an absent chain entry. Export the dependency closure or relink an explicitly selected new clone; do not silently remove history.", index, "parentUuid");
    if (record.parentUuid === id) add("error", "parent-cycle", "A message is its own parent. Rebuild the selected clone with a fresh acyclic chain.", index, "parentUuid");
  }
  const complete = new Set<string>();
  for (const id of byId.keys()) {
    const walk = new Set<string>();
    let next = id;
    while (next && byId.has(next) && !complete.has(next)) {
      if (walk.has(next)) { add("error", "parent-cycle", "The parent chain contains a cycle. Inspect its links before cloning or resuming.", indices.get(byId.get(next)!) ?? 0, "parentUuid"); break; }
      walk.add(next); next = string(byId.get(next)!.parentUuid);
    }
    walk.forEach(uid => complete.add(uid));
  }
  const chain = claudeConversationChain(records);
  if (!chain.length) add("error", "empty-conversation", "No visible user/assistant chain can be reconstructed. This may be metadata-only, an incomplete fragment, or the wrong export format.", 0);
  const calls = new Map<string, { response: string; result: boolean }>();
  const pending = new Set<string>();
  let response = "";
  for (const record of chain) {
    const index = indices.get(record) ?? 0;
    const m = messageOf(record);
    if (record.type === "assistant") {
      const currentResponse = string(m.id) || string(record.uuid);
      if (pending.size && response !== currentResponse) add("warning", "interrupted-tool-transaction", "An assistant response starts before earlier tool calls receive results. Include the missing result or render the interrupted call as history in a clone.", index, "message");
      for (const id of blockIds(record, "tool_use", "id")) {
        if (calls.has(id) && calls.get(id)!.response !== currentResponse) add("error", "duplicate-tool-call-id", "Different assistant responses reuse a tool-call ID. Rewrite call and result IDs together in a clone.", index, "message/content");
        calls.set(id, { response: currentResponse, result: false }); pending.add(id); response = currentResponse;
      }
    } else {
      for (const id of blockIds(record, "tool_result", "tool_use_id")) {
        const call = calls.get(id);
        if (!call || call.result) add("error", "orphan-tool-result", "Tool result has no preceding unanswered call in the active chain. Include its call or preserve this output as historical text.", index, "message/content");
        else { call.result = true; pending.delete(id); }
      }
    }
  }
  if (pending.size) add("warning", "unanswered-tool-call", "The active chain ends with interrupted tool calls. Claude can mark them interrupted on resume; a portable clone should render them as historical text to avoid replay ambiguity.", indices.get(chain.at(-1)!) ?? 0, "message/content");
  return Object.assign({ valid: !issues.some(i => i.severity === "error"), issues }, { compatibilityVersion, complete: !issues.some(i => i.severity === "error" || ["unknown-native-entry", "unvalidated-content-block", "missing-thinking-signature", "unanswered-tool-call", "interrupted-tool-transaction", "duplicate-message-id", "pending-stop-reason"].includes(i.code)) });
}

export const claudeConversationAdapter: NativeConversationAdapter = { harness: "claude", compatibilityVersion, render: renderClaudeConversation, validate: validateClaudeConversation };
