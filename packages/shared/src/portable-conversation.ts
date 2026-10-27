import type { AgentHarness, UniversalContentBlock, UniversalMessage, UniversalThread } from "./types/index.ts";
import type { ConversationCompatibilityIssue, PortableConversationDocument } from "./types/portable-conversation.ts";

const HARNESSES = new Set<AgentHarness>(["claude", "codex", "gemini", "opencode", "aider", "other"]);
const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const BLOCK_TYPES = new Set(["text", "thinking", "redacted_thinking", "tool_use", "tool_result", "image", "audio", "document", "unknown"]);
const MAX_DOCUMENT_CHARS = 50_000_000;

export class ConversationFormatError extends Error {
  constructor(message: string) { super(message); this.name = "ConversationFormatError"; }
}

export function parsePortableConversation(value: unknown): PortableConversationDocument {
  if (typeof value === "string") {
    if (value.length > MAX_DOCUMENT_CHARS) throw new ConversationFormatError("Conversation document is too large (50 MB maximum)");
    try { value = JSON.parse(value); } catch { throw new ConversationFormatError("Conversation document is not valid JSON"); }
  }
  if (!record(value) || value.format !== "llm-toolkit.conversation" || value.version !== 1) {
    throw new ConversationFormatError("Expected llm-toolkit.conversation version 1");
  }
  validateUniversalThread(value.thread);
  if (value.selection !== undefined) {
    if (!record(value.selection) || typeof value.selection.sourceThreadId !== "string") throw new ConversationFormatError("Invalid section provenance");
    for (const key of ["requestedMessageIds", "includedMessageIds", "dependencyMessageIds"]) {
      if (!Array.isArray(value.selection[key]) || !(value.selection[key] as unknown[]).every((id) => typeof id === "string")) throw new ConversationFormatError("Invalid section message IDs");
    }
  }
  return structuredClone(value) as unknown as PortableConversationDocument;
}

export function validateUniversalThread(value: unknown): asserts value is UniversalThread {
  if (!record(value)) throw new ConversationFormatError("Conversation thread must be an object");
  for (const key of ["id", "sourcePath", "projectPath", "title", "startedAt", "updatedAt"]) {
    if (typeof value[key] !== "string") throw new ConversationFormatError(`Conversation ${key} must be a string`);
  }
  if (!value.id || !HARNESSES.has(value.harness as AgentHarness)) throw new ConversationFormatError("Invalid conversation identity or harness");
  if (!Array.isArray(value.messages) || value.messages.length > 100_000) throw new ConversationFormatError("Conversation messages must be an array of at most 100,000 messages");
  const ids = new Set<string>();
  for (const message of value.messages) {
    if (!record(message) || typeof message.id !== "string" || !message.id || ids.has(message.id)) throw new ConversationFormatError("Message IDs must be nonempty and unique");
    ids.add(message.id);
    if (!ROLES.has(message.role as string) || typeof message.timestamp !== "string" || !Number.isFinite(Date.parse(message.timestamp))) throw new ConversationFormatError(`Invalid role or timestamp for message ${message.id}`);
    if (!Array.isArray(message.content) || message.content.length > 10_000) throw new ConversationFormatError(`Invalid content for message ${message.id}`);
    message.content.forEach((block) => validateBlock(block, 0));
  }
  if (value.rawEvents !== undefined && !Array.isArray(value.rawEvents)) throw new ConversationFormatError("Raw event archive must be an array");
}

function validateBlock(value: unknown, depth: number): void {
  if (depth > 20 || !record(value) || !BLOCK_TYPES.has(value.type as string)) throw new ConversationFormatError("Invalid universal content block");
  if (value.type === "text" && typeof value.text !== "string") throw new ConversationFormatError("Text block requires text");
  if (value.type === "thinking" && typeof value.thinking !== "string") throw new ConversationFormatError("Thinking block requires text");
  if (value.type === "tool_use" && (typeof value.toolCallId !== "string" || !value.toolCallId || typeof value.name !== "string" || !value.name || !record(value.input))) throw new ConversationFormatError("Tool calls require an ID, name and object input");
  if (value.type === "tool_result") {
    if (typeof value.toolCallId !== "string" || !value.toolCallId) throw new ConversationFormatError("Tool results require a call ID");
    if (Array.isArray(value.content)) value.content.forEach((block) => validateBlock(block, depth + 1));
    else if (typeof value.content !== "string") throw new ConversationFormatError("Tool result content must be text or universal blocks");
  }
  for (const key of ["source", "data", "mediaType", "signature", "transcript"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new ConversationFormatError(`Content block ${key} must be a string`);
  }
}

export function portableConversation(thread: UniversalThread): PortableConversationDocument {
  validateUniversalThread(thread);
  return { format: "llm-toolkit.conversation", version: 1, thread: structuredClone(thread) };
}

/** Select whole messages and the matching tool calls/results, preserving physical source order. */
export function snipConversation(thread: UniversalThread, requestedIds?: string[]): { document: PortableConversationDocument; issues: ConversationCompatibilityIssue[] } {
  validateUniversalThread(thread);
  if (requestedIds === undefined) return { document: portableConversation(thread), issues: toolPairIssues(thread.messages) };
  if (!requestedIds.length || new Set(requestedIds).size !== requestedIds.length) throw new ConversationFormatError("Choose at least one unique message");
  const requested = new Set(requestedIds);
  const byId = new Map(thread.messages.map((message) => [message.id, message]));
  if (requestedIds.some((id) => !byId.has(id))) throw new ConversationFormatError("Selection contains an unknown message");
  const selected = new Set(requestedIds);
  const calls = new Map<string, string[]>();
  for (const message of thread.messages) for (const block of message.content) {
    if (block.type !== "tool_use" && block.type !== "tool_result") continue;
    const owners = calls.get(block.toolCallId) ?? [];
    owners.push(message.id); calls.set(block.toolCallId, owners);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of thread.messages) {
      if (!selected.has(message.id)) continue;
      for (const block of message.content) {
        if (block.type !== "tool_use" && block.type !== "tool_result") continue;
        for (const owner of calls.get(block.toolCallId) ?? []) if (!selected.has(owner)) { selected.add(owner); changed = true; }
      }
    }
  }
  const messages = thread.messages.filter((message) => selected.has(message.id));
  const dependencyMessageIds = messages.filter((message) => !requested.has(message.id)).map((message) => message.id);
  const segments: Array<{ messageIds: string[]; omittedBefore: number }> = [];
  let previous = -1;
  for (let index = 0; index < thread.messages.length; index++) {
    const message = thread.messages[index];
    if (!selected.has(message.id)) continue;
    if (!segments.length || index !== previous + 1) segments.push({ messageIds: [], omittedBefore: index - previous - 1 });
    segments[segments.length - 1].messageIds.push(message.id);
    previous = index;
  }
  // A section must never smuggle unrelated raw history or provider-level caches into its export.
  const { rawEvents: _rawEvents, providerMetadata: _metadata, ...source } = thread;
  const document = portableConversation({ ...source, messages });
  document.selection = { sourceThreadId: thread.id, requestedMessageIds: [...requestedIds], includedMessageIds: messages.map((message) => message.id), dependencyMessageIds, segments };
  const issues = toolPairIssues(messages);
  if (dependencyMessageIds.length) issues.push({ severity: "info", code: "tool_dependencies_included", message: `${dependencyMessageIds.length} additional message(s) included to keep tool calls and results together.` });
  if (thread.rawEvents?.length) issues.push({ severity: "info", code: "section_archive_filtered", message: "Unselected raw events are excluded. Selected messages retain their own provider provenance." });
  if (segments.length > 1) issues.push({ severity: "warning", code: "noncontiguous_sections", message: `${segments.length} separate source sections are included in order; intervening messages are omitted, not summarized.` });
  return { document, issues };
}

/** Reinsert a section into a universal draft. Native originals are not touched. */
export function insertConversationSection(target: PortableConversationDocument, section: PortableConversationDocument, afterMessageId: string | null): PortableConversationDocument {
  const destination = parsePortableConversation(target);
  const source = parsePortableConversation(section);
  const position = afterMessageId === null ? 0 : destination.thread.messages.findIndex((message) => message.id === afterMessageId) + 1;
  if (afterMessageId !== null && position === 0) throw new ConversationFormatError("Insertion message is not in the destination conversation");
  const callIds = new Map<string, string>();
  const newIds = new Map(source.thread.messages.map((message) => [message.id, crypto.randomUUID()]));
  const content = source.thread.messages.map((message) => {
    const copy = structuredClone(message);
    copy.id = newIds.get(message.id)!;
    copy.provenance = { harness: source.thread.harness, sourcePath: source.thread.sourcePath, ...copy.provenance };
    copy.providerMetadata = { ...copy.providerMetadata, portableSource: { threadId: source.thread.id, messageId: message.id } };
    copy.content = copy.content.map((block) => {
      if (block.type !== "tool_use" && block.type !== "tool_result") return block;
      if (!callIds.has(block.toolCallId)) callIds.set(block.toolCallId, `portable_${crypto.randomUUID().replaceAll("-", "")}`);
      return { ...block, toolCallId: callIds.get(block.toolCallId)! };
    });
    return copy;
  });
  destination.thread.messages.splice(position, 0, ...content);
  delete destination.thread.rawEvents;
  delete destination.thread.providerMetadata;
  delete destination.selection;
  return destination;
}

export function universalMessageText(message: UniversalMessage): string {
  return message.content.map(blockText).filter(Boolean).join("\n\n");
}

function blockText(block: UniversalContentBlock): string {
  switch (block.type) {
    case "text": return block.text;
    case "thinking": return `[Historical reasoning]\n${block.thinking}`;
    case "redacted_thinking": return "[Opaque provider reasoning preserved in universal data]";
    case "tool_use": return `[Historical tool call: ${block.name}; id=${block.toolCallId}]\n${JSON.stringify(block.input, null, 2)}`;
    case "tool_result": return `[Historical tool result: ${block.toolCallId}${block.isError ? "; error" : ""}]\n${typeof block.content === "string" ? block.content : block.content.map(blockText).join("\n")}`;
    case "image": return `[Image${block.mediaType ? `: ${block.mediaType}` : ""}${block.source ? `; ${block.source}` : ""}; ${block.data ? "embedded data retained in universal document" : "reference only"}]`;
    case "audio": return block.transcript ?? `[Audio${block.source ? `: ${block.source}` : ""}; data retained in universal document]`;
    case "document": return block.text ?? `[Document${block.source ? `: ${block.source}` : ""}; data retained in universal document]`;
    case "unknown": return `[Provider content: ${block.providerType ?? "unknown"}]\n${JSON.stringify(block.raw, null, 2)}`;
  }
}

export function conversationMarkdown(document: PortableConversationDocument): string {
  const parsed = parsePortableConversation(document);
  const sections = new Map(parsed.selection?.segments?.map((segment, index) => [segment.messageIds[0], { ...segment, index }]) ?? []);
  return [`# ${parsed.thread.title}`, `Source: ${parsed.thread.harness}`, ...parsed.thread.messages.map((message, index) => {
    const section = sections.get(message.id);
    const boundary = section ? `---\n\n### Source section ${section.index + 1}${section.omittedBefore ? ` (${section.omittedBefore} preceding messages omitted)` : ""}\n\n` : "";
    return `${boundary}## ${index + 1}. ${message.role}\n\n${universalMessageText(message)}`;
  })].join("\n\n");
}

export function toolPairIssues(messages: UniversalMessage[]): ConversationCompatibilityIssue[] {
  const calls = new Map<string, UniversalMessage>();
  const results = new Map<string, UniversalMessage>();
  const issues: ConversationCompatibilityIssue[] = [];
  for (const message of messages) for (const block of message.content) {
    if (block.type === "tool_use") {
      if (calls.has(block.toolCallId)) issues.push({ severity: "warning", code: "duplicate_tool_call", message: `Tool call ${block.toolCallId} appears more than once; native export may use readable history.`, messageId: message.id });
      calls.set(block.toolCallId, message);
    }
    if (block.type === "tool_result") results.set(block.toolCallId, message);
  }
  for (const [id, message] of calls) if (!results.has(id)) issues.push({ severity: "warning", code: "unresolved_tool_call", message: `Tool call ${id} has no result in this history; it must not become a pending target tool call.`, messageId: message.id });
  for (const [id, message] of results) if (!calls.has(id)) issues.push({ severity: "warning", code: "orphan_tool_result", message: `Tool result ${id} has no call in this history; native export may use readable history.`, messageId: message.id });
  return issues;
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
