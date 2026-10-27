import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { ConversationCompatibilityIssue, NativeConversationAdapter, NativeConversationArtifact, NativeConversationContext, NativeConversationValidation, UniversalContentBlock, UniversalMessage, UniversalThread } from "@llm-toolkit/shared";

type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => typeof v === "string" ? v : "";
const clone = <T>(v: T): T => structuredClone(v);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ignoredUser = (s: string): boolean => !s.trim() || /^(?:[/?]|<session_context>|<hook_context>)/.test(s.trim());
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const compatibilityVersion = "gemini-cli/0.65.0;source/6006c14a4decfe4b891c6263ad6ad5992e404b5b";
export const geminiProjectHash = (cwd: string): string => createHash("sha256").update(cwd).digest("hex");

/** Pure lookup only; caller reads projects.json and tmp/<slug>/.project_root, never claims a slug. */
export function resolveGeminiProjectIdentifier(registry: unknown, cwd: string, ownershipMarkers: Record<string, string>): string | null {
  if (!obj(registry) || !obj(registry.projects)) return null;
  const normalize = (p: string) => process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
  const slug = registry.projects[normalize(cwd)];
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) return null;
  return typeof ownershipMarkers[slug] === "string" && normalize(ownershipMarkers[slug].trim()) === normalize(cwd) ? slug : null;
}
function recordsOf(input: string): Obj[] {
  try { const v: unknown = JSON.parse(input); if (obj(v)) return [v]; } catch { /* JSONL */ }
  return input.split(/\r?\n/).flatMap((line, i) => {
    if (!line.trim()) return [];
    let v: unknown; try { v = JSON.parse(line); } catch { throw new Error(`Invalid Gemini JSON/JSONL at line ${i + 1}.`); }
    if (!obj(v)) throw new Error(`Gemini record at line ${i + 1} must be an object.`);
    return [v];
  });
}
function parts(v: unknown): unknown[] { return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]; }

/** Published reader's ordered upsert/patch/remove/reorder/rewind semantics. Does not mutate inputs. */
export function geminiConversationSnapshot(records: Obj[]): Obj {
  let metadata: Obj = {}; let messages = new Map<string, Obj>();
  const add = (values: unknown) => { if (Array.isArray(values)) for (const v of values) if (obj(v) && typeof v.id === "string") messages.set(v.id, clone(v)); };
  const patch = (p: unknown) => {
    if (!obj(p)) return; const m = messages.get(str(p.id)); if (!m) return;
    if (p.content !== undefined) m.content = clone(p.content);
    if (m.type === "gemini" && Array.isArray(m.toolCalls) && Array.isArray(p.toolCalls)) {
      const byId = new Map(m.toolCalls.filter(obj).map(t => [str(t.id), t]));
      for (const t of p.toolCalls) if (obj(t) && "result" in t) { const target = byId.get(str(t.id)); if (target) target.result = clone(t.result); }
    }
  };
  for (const r of records) {
    if (typeof r.$rewindTo === "string") {
      let remove = !messages.has(r.$rewindTo);
      for (const id of messages.keys()) { if (id === r.$rewindTo) remove = true; if (remove) messages.delete(id); }
    } else if (obj(r.$patch)) {
      patch(r.$patch); if (Array.isArray(r.$patch.updates)) r.$patch.updates.forEach(patch);
      if (Array.isArray(r.$patch.removeIds)) r.$patch.removeIds.forEach(id => { if (typeof id === "string") messages.delete(id); });
      if (Array.isArray(r.$patch.orderIds)) {
        const ordered = new Map<string, Obj>();
        for (const id of r.$patch.orderIds) if (typeof id === "string" && messages.has(id)) ordered.set(id, messages.get(id)!);
        messages = new Map([...messages].filter(([id]) => !ordered.has(id)).concat([...ordered]));
      }
    } else if (typeof r.id === "string") messages.set(r.id, clone(r));
    else if (obj(r.$set)) { metadata = { ...metadata, ...clone(r.$set) }; if (Array.isArray(r.$set.messages)) { messages.clear(); add(r.$set.messages); } }
    else if (typeof r.sessionId === "string" && typeof r.projectHash === "string") { metadata = { ...metadata, ...clone(r) }; add(r.messages); }
  }
  return { ...metadata, messages: [...messages.values()] };
}
function block(v: unknown): UniversalContentBlock {
  if (typeof v === "string") return { type: "text", text: v };
  if (!obj(v)) return { type: "unknown", raw: clone(v) };
  const base = { providerRaw: clone(v), providerType: "gemini-part" };
  if (typeof v.text === "string") return v.thought === true ? { type: "thinking", thinking: v.text, signature: typeof v.thoughtSignature === "string" ? v.thoughtSignature : undefined, ...base } : { type: "text", text: v.text, ...base };
  if (obj(v.functionCall)) return { type: "tool_use", toolCallId: str(v.functionCall.id), name: str(v.functionCall.name), input: obj(v.functionCall.args) ? clone(v.functionCall.args) : {}, ...base };
  if (obj(v.functionResponse)) return { type: "tool_result", toolCallId: str(v.functionResponse.id), content: JSON.stringify(v.functionResponse.response ?? {}), ...base };
  const data = obj(v.inlineData) ? v.inlineData : obj(v.fileData) ? v.fileData : null;
  if (data) {
    const mediaType = str(data.mimeType); const common = { mediaType, data: typeof data.data === "string" ? data.data : undefined, source: typeof data.fileUri === "string" ? data.fileUri : undefined, ...base };
    return mediaType.startsWith("image/") ? { type: "image", ...common } : mediaType.startsWith("audio/") ? { type: "audio", ...common } : { type: "document", ...common };
  }
  return { type: "unknown", raw: clone(v), ...base };
}

/** Active materialized history plus every original append-only record as opaque archive. */
export function importGeminiConversation(input: string, sourcePath: string, projectPath = ""): UniversalThread {
  const records = recordsOf(input); const snapshot = geminiConversationSnapshot(records);
  if (!str(snapshot.sessionId) || !Array.isArray(snapshot.messages)) throw new Error("Gemini transcript has no session metadata.");
  const source = snapshot.messages.filter(obj); const messages: UniversalMessage[] = [];
  const legacyPending = new Map<string, string[]>();
  const remember = (name: string, id: string) => { const ids = legacyPending.get(name) ?? []; if (!ids.includes(id)) ids.push(id); legacyPending.set(name, ids); };
  // One reverse pass indexes explicit response IDs by model-turn segment (avoids rescanning large histories).
  const followingResponses = new Map<number, Set<string>>(); let responseIds = new Set<string>();
  for (let i = source.length - 1; i >= 0; i--) {
    if (source[i].type === "gemini") { followingResponses.set(i, responseIds); responseIds = new Set(); }
    else if (source[i].type === "user") for (const p of parts(source[i].content)) if (obj(p) && obj(p.functionResponse)) responseIds.add(str(p.functionResponse.id));
  }
  for (const [i, m] of source.entries()) {
    if (m.type !== "user" && m.type !== "gemini") continue;
    const content = parts(m.content).map((p, index) => {
      if (!obj(p)) return block(p);
      const normalized = clone(p);
      if (obj(normalized.functionCall)) {
        const call = normalized.functionCall;
        if (!str(call.id)) {
          const matching = Array.isArray(m.toolCalls) ? m.toolCalls.filter(obj).find(t => t.name === call.name && str(t.id)) : undefined;
          call.id = matching?.id ?? `synth_${createHash("sha256").update(`${sourcePath}:${m.id}:${index}`).digest("hex").slice(0, 16)}`;
        }
        remember(str(call.name), str(call.id));
      }
      if (obj(normalized.functionResponse)) {
        const response = normalized.functionResponse;
        const pending = legacyPending.get(str(response.name)) ?? [];
        if (!str(response.id)) response.id = pending[0] ?? `synth_orphan_${createHash("sha256").update(`${sourcePath}:${m.id}:${index}`).digest("hex").slice(0, 16)}`;
        const position = pending.indexOf(str(response.id)); if (position >= 0) pending.splice(position, 1);
      }
      return block(normalized);
    });
    const calls = new Set(content.filter(b => b.type === "tool_use").map(b => b.toolCallId));
    if (!content.some(b => b.type === "thinking") && m.type === "gemini" && Array.isArray(m.thoughts)) content.unshift(...m.thoughts.filter(obj).map(t => ({ type: "thinking" as const, thinking: [str(t.subject), str(t.description)].filter(Boolean).join(": "), providerRaw: clone(t), providerType: "gemini-thought-summary" })));
    if (m.type === "gemini" && Array.isArray(m.toolCalls)) for (const t of m.toolCalls.filter(obj)) if (!calls.has(str(t.id))) { remember(str(t.name), str(t.id)); content.push({ type: "tool_use", toolCallId: str(t.id), name: str(t.name), input: obj(t.args) ? clone(t.args) : {}, providerRaw: clone(t), providerType: "gemini-tool-record" }); }
    const usage = obj(m.tokens) && typeof m.tokens.input === "number" && typeof m.tokens.output === "number" ? { input_tokens: m.tokens.input, output_tokens: m.tokens.output, ...(typeof m.tokens.cached === "number" ? { cache_read_input_tokens: m.tokens.cached } : {}) } : undefined;
    const id = `gemini:${createHash("sha256").update(`${sourcePath}:${m.id}`).digest("hex").slice(0, 16)}`;
    messages.push({ id, role: m.type === "gemini" ? "assistant" : "user", timestamp: str(m.timestamp), content, providerMessageId: str(m.id), model: typeof m.model === "string" ? m.model : undefined, usage, provenance: { harness: "gemini", sourcePath, rawIndex: i }, providerRaw: clone(m) });
    if (m.type === "gemini" && Array.isArray(m.toolCalls)) {
      const results: UniversalContentBlock[] = m.toolCalls.filter(obj).filter(t => t.result !== undefined && t.result !== null && !followingResponses.get(i)?.has(str(t.id))).map(t => ({ type: "tool_result", toolCallId: str(t.id), content: typeof t.result === "string" ? t.result : parts(t.result).map(block), isError: t.status === "error", providerRaw: clone(t.result), providerType: "gemini-tool-result" }));
      if (results.length) messages.push({ id: `${id}:results`, role: "tool", timestamp: str(m.timestamp), content: results, provenance: { harness: "gemini", sourcePath, rawIndex: i } });
    }
  }
  return { id: `gemini:${snapshot.sessionId}`, harness: "gemini", sourcePath, projectPath, title: str(snapshot.summary) || messages.find(m => m.role === "user")?.content.filter(b => b.type === "text").map(b => b.text).join(" ").slice(0, 120) || "Imported Gemini conversation", startedAt: str(snapshot.startTime), updatedAt: str(snapshot.lastUpdated), messages, rawEvents: records.map((r, i) => ({ id: `gemini:${sourcePath}:${i}`, timestamp: str(r.timestamp) || str(snapshot.startTime), harness: "gemini", eventType: typeof r.id === "string" ? str(r.type) : "$patch" in r ? "patch" : "$rewindTo" in r ? "rewind" : "metadata", raw: clone(r) })), providerMetadata: { sessionId: snapshot.sessionId, projectHash: snapshot.projectHash, nativeFormat: "gemini-cli-jsonl", sourceSnapshotMetadata: Object.fromEntries(Object.entries(snapshot).filter(([k]) => k !== "messages")) } };
}
function historicalText(b: UniversalContentBlock): string {
  switch (b.type) {
    case "text": return b.text;
    case "thinking": return `[Historical reasoning]\n${b.thinking}`;
    case "redacted_thinking": return "[Historical redacted reasoning retained in portable archive]";
    case "tool_use": return `[Historical tool call: ${b.name}]\n${JSON.stringify(b.input)}`;
    case "tool_result": return `[Historical tool result${b.isError ? " (error)" : ""}]\n${typeof b.content === "string" ? b.content : b.content.map(historicalText).join("\n")}`;
    case "document": return `[Historical document]\n${b.text ?? b.source ?? "Binary data retained in portable archive"}`;
    case "audio": return `[Historical audio]\n${b.transcript ?? b.source ?? "Binary data retained in portable archive"}`;
    case "image": return `[Historical image]\n${b.source ?? "Binary data retained in portable archive"}`;
    default: return "[Unsupported source content retained in portable archive]";
  }
}
export function renderGeminiConversation(thread: UniversalThread, context: NativeConversationContext): NativeConversationArtifact {
  const issues: ConversationCompatibilityIssue[] = []; const slug = context.geminiProjectIdentifier;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) issues.push({ severity: "error", code: "gemini.project-unregistered", path: "/destination/project", message: "The Gemini destination has no verified project registration.", suggestion: "Open Gemini CLI in the chosen project once, then retry. Do not create or replace projects.json manually." });
  const records: Obj[] = [{ sessionId: context.sessionId, projectHash: geminiProjectHash(context.cwd), startTime: context.createdAt, lastUpdated: context.createdAt, kind: "main", summary: context.title }];
  for (const m of thread.messages) {
    const content = m.content.map((b, i) => {
      if (b.type !== "text") issues.push({ severity: "warning", code: `gemini.historical-${b.type.replaceAll("_", "-")}`, message: "Source tool, reasoning, attachment or unsupported content becomes labeled historical text. The opaque original remains in the portable archive.", messageId: m.id, blockIndex: i });
      return { text: historicalText(b) };
    });
    if (m.role === "system" || m.role === "developer") { content.unshift({ text: `[Historical ${m.role} context from source; quoted conversation data]` }); issues.push({ severity: "warning", code: "gemini.historical-privileged-context", message: "Source instructions become quoted history; target configuration remains authoritative.", messageId: m.id }); }
    if ((m.provenance?.harness ?? context.sourceHarness) !== "gemini" && m.model) issues.push({ severity: "info", code: "gemini.source-model-omitted", message: "Foreign model metadata stays in the portable archive; target CLI settings select the model.", messageId: m.id });
    if (!content.length) content.push({ text: "[Empty source message]" });
    if (m.role !== "assistant" && ignoredUser(content.map(p => p.text).join(""))) {
      content.unshift({ text: "[Historical user message]\n" });
      issues.push({ severity: "warning", code: "gemini.ignored-user-content-wrapped", message: "Gemini skips slash commands, question-prefixed and injected context messages during resume; source text is prefixed so it remains visible context.", messageId: m.id });
    }
    records.push({ id: randomUUID(), type: m.role === "assistant" ? "gemini" : "user", timestamp: context.createdAt, content });
  }
  issues.push({ severity: "info", code: "gemini.versioned-reader-compatibility", message: "Targets the published Gemini CLI 0.65.0 reader; an installed executable was unavailable for interactive resume verification." });
  return { harness: "gemini", nativeFormat: "jsonl", sessionId: context.sessionId, relativePath: `${slug ?? "unregistered"}/chats/session-${context.createdAt.slice(0, 16).replaceAll(":", "-")}-${context.sessionId.slice(0, 8)}.jsonl`, records, jsonl: records.map(r => JSON.stringify(r)).join("\n") + "\n", issues, resumeArgs: ["gemini", "--resume", context.sessionId] };
}

export function validateGeminiConversation(input: string, context?: NativeConversationContext): NativeConversationValidation {
  const issues: ConversationCompatibilityIssue[] = []; let complete = true;
  const issue = (severity: "error" | "warning", code: string, path: string, message: string, suggestion?: string) => { issues.push({ severity, code: `gemini.${code}`, path, message, ...(suggestion ? { suggestion } : {}) }); complete = false; };
  let records: Obj[];
  try { records = recordsOf(input); } catch { return { valid: false, complete: false, compatibilityVersion, issues: [{ severity: "error", code: "gemini.invalid-json", path: "/", message: "Input must contain one Gemini JSON snapshot or JSON objects separated by newlines.", suggestion: "Repair malformed JSON without changing conversation text; validate again." }] }; }
  if (!records.length) issue("error", "empty", "/", "No session records were found.");
  const messageTypes = new Set(["user", "gemini", "info", "error", "warning"]);
  const statuses = new Set(["validating", "scheduled", "error", "success", "executing", "cancelled", "awaiting_approval"]);
  const checkParts = (value: unknown, path: string, role?: unknown) => {
    if (typeof value === "string") return;
    if (!obj(value) && !Array.isArray(value)) { issue("error", "invalid-content", path, "Content must be text, a Part object or an array of text/Part values."); return; }
    for (const [i, p] of parts(value).entries()) {
      const at = `${path}/${i}`; if (typeof p === "string") continue;
      if (!obj(p)) { issue("error", "invalid-part", at, "Content part must be text or an object."); continue; }
      const known = ["text", "functionCall", "functionResponse", "inlineData", "fileData", "executableCode", "codeExecutionResult", "videoMetadata"];
      if (!known.some(k => k in p)) issue("warning", "unknown-part", at, "An unknown provider part needs version-specific verification.");
      if ("text" in p && typeof p.text !== "string") issue("error", "invalid-text", `${at}/text`, "Text must be a string.");
      if ("thought" in p && typeof p.thought !== "boolean") issue("error", "invalid-thought", `${at}/thought`, "Thought marker must be boolean.");
      if ("thoughtSignature" in p && typeof p.thoughtSignature !== "string") issue("error", "invalid-thought-signature", `${at}/thoughtSignature`, "Thought signature must be an opaque string.");
      if (role !== undefined && (p.thought === true || "thoughtSignature" in p) && role !== "gemini") issue("error", "thought-role", at, "Thoughts and signatures belong to Gemini model messages.");
      for (const k of ["functionCall", "functionResponse"]) if (k in p) {
        const f = p[k]; if (!obj(f) || !str(f.name) || (f.id !== undefined && typeof f.id !== "string") || (k === "functionCall" ? f.args !== undefined && !obj(f.args) : !obj(f.response))) issue("error", "invalid-function-part", `${at}/${k}`, "Function parts require a name, optional string ID, and an object for arguments or response.");
        if (role !== undefined && (k === "functionCall" && role !== "gemini" || k === "functionResponse" && role !== "user")) issue("error", "function-role", at, "Function calls require model messages; function responses require user messages.");
      }
      for (const k of ["inlineData", "fileData"]) if (k in p) {
        const d = p[k]; if (!obj(d) || !str(d.mimeType) || !str(d[k === "inlineData" ? "data" : "fileUri"])) issue("error", "invalid-attachment", `${at}/${k}`, "Attachment requires a MIME type and inline data or file URI.");
        else if (k === "inlineData" && (!/^[A-Za-z0-9+/]*={0,2}$/.test(str(d.data)) || str(d.data).length % 4 !== 0)) issue("error", "invalid-base64", `${at}/${k}/data`, "Inline data must be valid padded base64.");
      }
      if (context && (p.thought === true || "thoughtSignature" in p || "functionCall" in p || "functionResponse" in p || "inlineData" in p || "fileData" in p)) issue("error", "unsafe-generated-part", at, "Generated clones use readable history instead of provider tools, attachments or signed thoughts.");
    }
  };
  const checkMessage = (m: unknown, path: string) => {
    if (!obj(m)) { issue("error", "invalid-message", path, "Message must be an object."); return; }
    if (!str(m.id)) issue("error", "message-id", `${path}/id`, "Message requires a nonempty string ID.");
    else if (context && !uuid.test(str(m.id))) issue("error", "message-uuid", `${path}/id`, "Generated message ID must be a fresh UUID.");
    if (!messageTypes.has(str(m.type))) issue(context ? "error" : "warning", "unknown-message-type", `${path}/type`, "Message type is unknown to the pinned Gemini version.");
    if (context && m.type !== "user" && m.type !== "gemini") issue("error", "generated-message-type", `${path}/type`, "Generated clones support user and Gemini model messages only.");
    if (!date(m.timestamp)) issue("error", "message-time", `${path}/timestamp`, "Message timestamp must be a valid ISO date.");
    checkParts(m.content, `${path}/content`, m.type);
    if (m.type === "user" && parts(m.content).every(p => typeof p === "string" || obj(p) && typeof p.text === "string") && ignoredUser(parts(m.content).map(p => typeof p === "string" ? p : obj(p) ? str(p.text) : "").join(""))) issue(context ? "error" : "warning", "ignored-user-content", `${path}/content`, "Gemini resume ignores this blank, command or injected context user message.");
    if (m.displayContent !== undefined) checkParts(m.displayContent, `${path}/displayContent`, m.type);
    if (m.tokens !== undefined && m.tokens !== null) {
      if (!obj(m.tokens)) issue("error", "tokens", `${path}/tokens`, "Token summary must be an object or null.");
      else for (const k of ["input", "output", "cached", "total", "thoughts", "tool"]) if ((["input", "output", "cached", "total"].includes(k) || m.tokens[k] !== undefined) && (typeof m.tokens[k] !== "number" || !Number.isFinite(m.tokens[k]))) issue("error", "token-number", `${path}/tokens/${k}`, "Token counters must be finite numbers; zero and negative reported values are preserved.");
    }
    if (m.toolCalls !== undefined) {
      if (m.type !== "gemini" || !Array.isArray(m.toolCalls)) issue("error", "tool-records", `${path}/toolCalls`, "Tool records must be an array on a Gemini model message.");
      else { const ids = new Set<string>(); for (const [i, t] of m.toolCalls.entries()) {
        const at = `${path}/toolCalls/${i}`; if (!obj(t)) { issue("error", "tool-record", at, "Tool record must be an object."); continue; }
        if (!str(t.id) || ids.has(str(t.id))) issue("error", "tool-id", `${at}/id`, "Tool IDs must be nonempty and unique in a message."); ids.add(str(t.id));
        if (!str(t.name) || !obj(t.args)) issue("error", "tool-shape", at, "Tool records require a name and argument object.");
        if (!statuses.has(str(t.status))) issue("warning", "unknown-tool-status", `${at}/status`, "Tool status is unknown to the pinned version.");
        if (!date(t.timestamp)) issue("error", "tool-time", `${at}/timestamp`, "Tool timestamp must be a valid ISO date.");
        if (t.result !== undefined && t.result !== null) checkParts(t.result, `${at}/result`, "user");
      } }
    }
    if (m.thoughts !== undefined && (!Array.isArray(m.thoughts) || m.thoughts.some(t => !obj(t) || typeof t.subject !== "string" || typeof t.description !== "string" || !date(t.timestamp)))) issue("error", "thought-summary", `${path}/thoughts`, "Thought summaries require subject, description and ISO timestamp.");
  };
  let header = false; const generatedIds = new Set<string>();
  for (const [i, r] of records.entries()) {
    const at = `/records/${i}`;
    if (typeof r.id === "string") { checkMessage(r, at); if (context && generatedIds.has(r.id)) issue("error", "duplicate-message-id", `${at}/id`, "Generated message IDs must be unique."); generatedIds.add(r.id); }
    else if (typeof r.sessionId === "string" && typeof r.projectHash === "string") { header = true; if (Array.isArray(r.messages)) r.messages.forEach((m, j) => checkMessage(m, `${at}/messages/${j}`)); }
    else if (obj(r.$set)) { if (Array.isArray(r.$set.messages)) r.$set.messages.forEach((m, j) => checkMessage(m, `${at}/$set/messages/${j}`)); }
    else if (obj(r.$patch)) {
      const checkPatch = (p: unknown, path: string) => {
        if (!obj(p) || !str(p.id)) { issue("error", "invalid-patch", path, "Message patch requires a string target ID."); return; }
        if (p.content !== undefined) checkParts(p.content, `${path}/content`);
        if (p.toolCalls !== undefined && (!Array.isArray(p.toolCalls) || p.toolCalls.some(t => !obj(t) || !str(t.id)))) issue("error", "invalid-tool-patch", `${path}/toolCalls`, "Tool patches require string target IDs.");
      };
      if ("id" in r.$patch) checkPatch(r.$patch, `${at}/$patch`);
      if (Array.isArray(r.$patch.updates)) r.$patch.updates.forEach((p, j) => checkPatch(p, `${at}/$patch/updates/${j}`));
      else if ("updates" in r.$patch) issue("error", "invalid-patch-updates", `${at}/$patch/updates`, "Patch updates must be an array.");
      for (const k of ["removeIds", "orderIds"]) if (k in r.$patch && (!Array.isArray(r.$patch[k]) || r.$patch[k].some((v: unknown) => typeof v !== "string"))) issue("error", "invalid-patch-ids", `${at}/$patch/${k}`, "Patch identifier lists must contain strings.");
    } else if (typeof r.$rewindTo !== "string") issue("warning", "unknown-record", at, "Record is unknown to the pinned Gemini reader.");
    if (context && ("$set" in r || "$patch" in r || "$rewindTo" in r)) issue("error", "generated-mutation", at, "Generated clones must have a fresh header and messages without archival mutations.");
  }
  const snapshot = geminiConversationSnapshot(records);
  if (records.some(r => obj(r.$patch))) for (const [i, m] of (snapshot.messages as Obj[]).entries()) checkMessage(m, `/messages/${i}`);
  if (!(snapshot.messages as Obj[]).some(m => m.type === "user" || m.type === "gemini")) issue("warning", "no-resumable-messages", "/messages", "No user or model messages are available to resume.");
  if (!header) issue("error", "missing-header", "/sessionId", "A Gemini session metadata header is required.");
  if (!uuid.test(str(snapshot.sessionId))) issue("error", "session-id", "/sessionId", "Session ID must be a UUID.");
  if (!/^[a-f0-9]{64}$/i.test(str(snapshot.projectHash))) issue("error", "project-hash", "/projectHash", "Project hash must be a SHA256 hex digest of the original project root.");
  for (const k of ["startTime", "lastUpdated"]) if (!date(snapshot[k])) issue("error", "session-time", `/${k}`, "Session timestamps must be valid ISO dates.");
  if (date(snapshot.startTime) && date(snapshot.lastUpdated) && Date.parse(snapshot.lastUpdated) < Date.parse(snapshot.startTime)) issue("error", "time-order", "/lastUpdated", "Session update cannot precede its start.");
  if (context) {
    if (records.filter(r => typeof r.sessionId === "string" && typeof r.projectHash === "string").length !== 1 || Array.isArray(records[0]?.messages)) issue("error", "generated-header", "/records/0", "Generated clones require exactly one metadata header without embedded historical messages.");
    if (records[0]?.sessionId !== context.sessionId || snapshot.sessionId !== context.sessionId) issue("error", "session-mismatch", "/sessionId", "Session ID differs from the requested clone.");
    if (!isAbsolute(context.cwd) || snapshot.projectHash !== geminiProjectHash(context.cwd)) issue("error", "project-mismatch", "/projectHash", "Project hash must match the absolute destination folder.");
    if (!context.geminiProjectIdentifier || !/^[a-z0-9-]+$/.test(context.geminiProjectIdentifier)) issue("error", "project-unregistered", "/destination/project", "Destination project registration is missing.", "Open Gemini CLI in the chosen project once and retry.");
    if (snapshot.kind !== "main" || snapshot.directories !== undefined || snapshot.memoryScratchpad !== undefined) issue("error", "generated-runtime-state", "/", "Generated clones must not inherit source directories, subagent kind or memory runtime state.");
    if (!input.endsWith("\n")) issue("error", "missing-newline", "/end-of-file", "Generated append-only files must end with a newline.");
  }
  // Linkage checks apply to active history after mutations. Metadata and explicit responses may duplicate one result.
  const calls = new Map<string, string>(); const responses = new Set<string>();
  for (const m of (snapshot.messages as Obj[])) {
    for (const p of parts(m.content)) if (obj(p)) {
      if (obj(p.functionCall)) { const id = str(p.functionCall.id); if (!id) issue("warning", "legacy-function-id", "/messages", "A legacy function call lacks an ID; Gemini synthesizes IDs during resume."); else calls.set(id, str(p.functionCall.name)); }
      if (obj(p.functionResponse)) { const id = str(p.functionResponse.id); if (!id) issue("warning", "legacy-function-id", "/messages", "A legacy function response lacks an ID."); else if (!calls.has(id) || calls.get(id) !== str(p.functionResponse.name)) issue("error", "orphan-function-response", "/messages", "Function response has no preceding matching call ID/name."); else responses.add(id); }
    }
    if (Array.isArray(m.toolCalls)) for (const t of m.toolCalls.filter(obj)) { calls.set(str(t.id), str(t.name)); if (t.result !== undefined && t.result !== null) responses.add(str(t.id)); }
  }
  if ([...calls.keys()].some(id => !responses.has(id))) issue("warning", "unanswered-function-call", "/messages", "An active function call has no result; review interrupted session state.");
  return { valid: !issues.some(i => i.severity === "error"), complete, compatibilityVersion, issues };
}
export const geminiConversationAdapter: NativeConversationAdapter = { harness: "gemini", compatibilityVersion, render: renderGeminiConversation, validate: validateGeminiConversation };
