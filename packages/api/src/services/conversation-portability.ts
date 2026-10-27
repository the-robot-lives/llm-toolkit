import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { conversationMarkdown, insertConversationSection, parsePortableConversation, portableConversation, snipConversation, universalMessageText, validateUniversalThread } from "@llm-toolkit/shared";
import type { AgentHarness, ConversationCompatibilityIssue, ConversationValidationReport, EditedMessage, IndexSource, NativeConversationArtifact, NativeConversationContext, NativeConversationHarness, PortableConversationDocument, UniversalMessage, UniversalThread } from "@llm-toolkit/shared";
import type { StorageService } from "./storage.ts";
import type { IndexerService } from "./indexer.ts";
import { nativeConversationAdapters, validateConversationContent, type NativeAdapters } from "./conversation-validator.ts";

export interface ConversationCloneRequest {
  targetHarness?: AgentHarness;
  projectPath?: string;
  title?: string;
  messageIds?: string[];
  document?: unknown;
  insertIntoConversationId?: string;
  afterMessageId?: string | null;
  destinationRoot?: string;
}

interface PreviewState {
  sourceId: string;
  expiresAt: number;
  sources: Array<{ path: string; hash: string; byteLength?: number }>;
  document: PortableConversationDocument;
  context: NativeConversationContext;
  artifact: NativeConversationArtifact;
  root: string;
  sourcePath: string;
  report: ConversationValidationReport;
  issues: ConversationCompatibilityIssue[];
}

export interface ClonePreview {
  previewId: string;
  targetHarness: NativeConversationHarness;
  sessionId: string;
  title: string;
  projectPath: string;
  sourcePath: string;
  messageCount: number;
  jsonl: string;
  resumeCommand: string;
  report: ConversationValidationReport;
  issues: ConversationCompatibilityIssue[];
}

interface PortabilityOptions {
  homeDir?: string;
  sources?: IndexSource[];
  adapters?: NativeAdapters;
  readThread?: (path: string, harness: AgentHarness) => Promise<UniversalThread>;
}

export class ConversationPortabilityService {
  private previews = new Map<string, PreviewState>();
  constructor(private storage: StorageService, private indexer?: IndexerService, private options: PortabilityOptions = {}) {}

  destinations(harness: NativeConversationHarness): string[] {
    const configured = (this.options.sources ?? this.indexer?.getSources() ?? []).filter((source) => source.harness === harness).map((source) => canonicalRoot(expandHome(source.path, this.options.homeDir)));
    const standard = harness === "claude" ? join(this.options.homeDir ?? homedir(), ".claude", "projects") : harness === "codex" ? join(this.options.homeDir ?? homedir(), ".codex", "sessions") : join(this.options.homeDir ?? homedir(), ".gemini", "tmp");
    return [...new Set(configured.length ? configured : [canonicalRoot(standard)])];
  }

  async load(id: string): Promise<UniversalThread> {
    const conversation = await this.storage.getConversation(id);
    if (!conversation) throw new Error("Conversation not found");
    let thread: UniversalThread;
    if (this.options.readThread) thread = await this.options.readThread(conversation.sourcePath, conversation.harness);
    else if (conversation.harness === "claude") {
      const { importClaudeConversation } = await import("./native/claude.ts");
      thread = importClaudeConversation(readConversationFile(conversation.sourcePath), conversation.sourcePath);
    } else if (conversation.harness === "codex") {
      const { readCodexConversation } = await import("./native/codex-reader.ts");
      thread = await readCodexConversation(conversation.sourcePath);
    } else if (conversation.harness === "gemini") {
      const { importGeminiConversation } = await import("./native/gemini.ts");
      thread = importGeminiConversation(readConversationFile(conversation.sourcePath), conversation.sourcePath, conversation.projectPath);
    } else {
      thread = { id, harness: conversation.harness, title: conversation.title, sourcePath: conversation.sourcePath, projectPath: conversation.projectPath, startedAt: conversation.startedAt.toISOString(), updatedAt: conversation.updatedAt.toISOString(), messages: await this.storage.getUniversalMessages(id), rawEvents: await this.storage.getRawTranscriptEvents(id) };
    }
    thread = { ...thread, id, title: conversation.title || thread.title, sourcePath: conversation.sourcePath, projectPath: thread.projectPath || conversation.projectPath };
    validateUniversalThread(thread);
    if (!this.options.readThread && ["claude", "codex", "gemini"].includes(conversation.harness)) {
      const report = await this.validateSource(id);
      const history = thread.providerMetadata?.codexHistory as { complete?: boolean } | undefined;
      const unresolved = report.errors.filter((issue) => !(conversation.harness === "codex" && history?.complete && issue.code === "codex.incomplete-history"));
      if (unresolved.length) throw new Error(`Source conversation failed structural validation (${unresolved.map((issue) => issue.code).slice(0, 5).join(", ")}). Use the validator to review it before cloning.`);
      if (report.status === "incomplete" && !(conversation.harness === "codex" && history?.complete)) throw new Error("Source conversation validation is incomplete. Use the validator to review unsupported or missing history before cloning.");
    }
    return thread;
  }

  private async loadSnapshot(id: string) {
    const conversation = await this.storage.getConversation(id);
    if (!conversation) throw new Error("Conversation not found");
    const fingerprint = { path: conversation.sourcePath, hash: sourceHash(conversation.sourcePath), byteLength: statSync(conversation.sourcePath).size };
    const thread = await this.load(id);
    if (thread.sourcePath !== fingerprint.path || sourceHash(fingerprint.path) !== fingerprint.hash) throw new Error("A source conversation changed while loading. Preview again before creating a copy.");
    return { thread, fingerprint };
  }

  async archive(id: string): Promise<PortableConversationDocument> {
    const conversation = await this.storage.getConversation(id);
    if (!conversation) throw new Error("Conversation not found");
    const root = this.destinations(conversation.harness as NativeConversationHarness).find((candidate) => { const rel = relative(candidate, conversation.sourcePath); return rel && !rel.startsWith("..") && !isAbsolute(rel); });
    if (!root) throw new Error("Archive is outside the configured provider folders");
    const path = `${conversation.sourcePath}.universal.json`;
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || realpathSync(dirname(path)) !== dirname(path) || lstatSync(conversation.sourcePath).isSymbolicLink()) throw new Error("No safe portable archive is available for this conversation");
    const document = parsePortableConversation(readConversationFile(path));
    const binding = document.thread.providerMetadata?.portableArchiveBinding as { harness?: string; sessionId?: string; byteLength?: number; sha256?: string } | undefined;
    if (!binding || binding.harness !== conversation.harness || !binding.sessionId || !Number.isSafeInteger(binding.byteLength) || binding.byteLength! < 1 || binding.byteLength! > 50_000_000) throw new Error("Archive association is missing or invalid");
    if (statSync(conversation.sourcePath).size > 50_000_000) throw new Error("Archive restoration supports at most 50 MB; no content was truncated");
    const native = readFileSync(conversation.sourcePath);
    if (native.length < binding.byteLength! || createHash("sha256").update(native.subarray(0, binding.byteLength)).digest("hex") !== binding.sha256) throw new Error("The conversation prefix changed; its archive cannot be restored safely");
    const prefix = native.subarray(0, binding.byteLength).toString("utf8");
    let baseline: UniversalThread;
    if (conversation.harness === "claude") baseline = (await import("./native/claude.ts")).importClaudeConversation(prefix, conversation.sourcePath);
    else if (conversation.harness === "codex") baseline = (await import("./native/codex.ts")).importCodexConversation(prefix, conversation.sourcePath);
    else baseline = (await import("./native/gemini.ts")).importGeminiConversation(prefix, conversation.sourcePath, conversation.projectPath);
    if (baseline.providerMetadata?.sessionId !== binding.sessionId) throw new Error("Archive session identity does not match its native prefix");
    const current = await this.load(id);
    if (current.messages.length < baseline.messages.length || baseline.messages.some((message, index) => current.messages[index]?.id !== message.id)) throw new Error("The archived history boundary no longer resolves; restore is blocked to preserve later turns");
    document.thread.messages = document.thread.messages.flatMap(message => {
      const originals = message.providerMetadata?.compactionOriginals;
      if (!message.providerMetadata?.generatedSummary || !Array.isArray(originals)) return [message];
      return originals.map((value: EditedMessage) => value.universalMessage ? structuredClone(value.universalMessage) : { id: randomUUID(), role: value.role, timestamp: message.timestamp, content: [{ type: "text" as const, text: value.content }], provenance: { harness: "other" as const, sourcePath: document.thread.sourcePath } });
    });
    document.thread.messages.push(...structuredClone(current.messages.slice(baseline.messages.length)));
    validateUniversalThread(document.thread);
    document.thread.providerMetadata = { ...document.thread.providerMetadata, archiveRestore: { appendedMessagesPreserved: current.messages.length - baseline.messages.length } };
    return document;
  }

  async section(id: string, messageIds?: string[]) { return snipConversation(await this.load(id), messageIds); }

  async validateSource(id: string, target?: AgentHarness): Promise<ConversationValidationReport> {
    const conversation = await this.storage.getConversation(id);
    if (!conversation) throw new Error("Conversation not found");
    return validateConversationContent(readConversationFile(conversation.sourcePath), target ?? conversation.harness, undefined, this.options.adapters);
  }

  async preview(id: string, request: ConversationCloneRequest): Promise<ClonePreview> {
    const sourceSnapshot = await this.loadSnapshot(id);
    const source = sourceSnapshot.thread;
    let { document, issues } = request.document !== undefined ? { document: parsePortableConversation(request.document), issues: [] as ConversationCompatibilityIssue[] } : snipConversation(source, request.messageIds);
    const sources: PreviewState["sources"] = [sourceSnapshot.fingerprint];
    const trustedMessages = new Map(source.messages.map(message => [message.id, message]));
    if (document.thread.id !== source.id) {
      const origin = await this.storage.getConversation(document.thread.id);
      const recorded = document.thread.providerMetadata?.portableArchiveSources;
      const expected = Array.isArray(recorded) && origin ? recorded.find((value: unknown) => value && typeof value === "object" && (value as { path?: unknown }).path === origin.sourcePath) as { path: string; hash: string; byteLength?: number } | undefined : undefined;
      let verified = false;
      if (origin && expected && typeof expected.hash === "string") {
        try {
          if (sourcePrefixMatches(origin.sourcePath, expected)) {
            const original = await this.loadSnapshot(origin.id);
            if (sourcePrefixMatches(origin.sourcePath, expected)) { for (const message of original.thread.messages) trustedMessages.set(message.id, message); sources.push(original.fingerprint); verified = true; }
          }
        } catch { /* Archived originals remain readable when their native source is unavailable. */ }
      }
      if (!verified) issues.push({ severity: "warning", code: "archive_origin_unverified", message: "Archived or imported originals could not be verified against their unchanged native source. Structured provider blocks will remain historical context." });
    }
    const verifiedIncoming = new Set<string>();
    for (const message of document.thread.messages) {
      const original = trustedMessages.get(message.id);
      if (original && original.role === message.role && JSON.stringify(original.content) === JSON.stringify(message.content)) {
        message.provenance = { ...original.provenance, harness: original.provenance?.harness ?? source.harness, sourcePath: original.provenance?.sourcePath ?? source.sourcePath };
        message.providerRaw = structuredClone(original.providerRaw); message.providerHints = structuredClone(original.providerHints); message.model = original.model; message.stopReason = original.stopReason;
        verifiedIncoming.add(message.id);
      }
    }
    const insertedIds = new Set<string>();
    if (request.insertIntoConversationId) {
      const targetSnapshot = await this.loadSnapshot(request.insertIntoConversationId);
      const target = targetSnapshot.thread;
      for (const message of target.messages) trustedMessages.set(message.id, message);
      const boundary = request.afterMessageId === undefined ? target.messages.at(-1)?.id ?? null : request.afterMessageId;
      assertInsertionBoundary(target, boundary);
      document = insertConversationSection(portableConversation(target), document, boundary);
      for (const message of document.thread.messages) {
        const origin = message.providerMetadata?.portableSource as { messageId?: string } | undefined;
        if (origin?.messageId && verifiedIncoming.has(origin.messageId) && !target.messages.some(existing => existing.id === message.id)) { trustedMessages.set(message.id, structuredClone(message)); insertedIds.add(message.id); }
      }
      sources.push(targetSnapshot.fingerprint);
      issues.push({ severity: "info", code: "target_copy", message: "The existing target conversation remains unchanged. A new copy will contain its prefix, the inserted section, and its suffix." });
    }
    const targetHarness = request.targetHarness ?? document.thread.harness;
    if (targetHarness !== "claude" && targetHarness !== "codex" && targetHarness !== "gemini") throw new Error(`Native ${targetHarness} cloning is unsupported. Export universal JSON or Markdown instead.`);
    const projectPath = request.projectPath ?? document.thread.projectPath;
    if (!isAbsolute(projectPath) || projectPath.includes("\0") || !existsSync(projectPath) || !statSync(projectPath).isDirectory()) throw new Error("Choose an existing absolute project directory for the new conversation");
    const cwd = realpathSync(projectPath);
    const roots = this.destinations(targetHarness);
    const root = request.destinationRoot ? canonicalRoot(expandHome(request.destinationRoot, this.options.homeDir)) : roots[0];
    if (!roots.includes(root)) throw new Error("Choose a configured destination root");
    const context: NativeConversationContext = { sessionId: randomUUID(), cwd, title: request.title?.trim() || `${document.thread.title} (copy)`, createdAt: new Date().toISOString(), sourceHarness: document.thread.harness };
    if (targetHarness === "gemini") {
      const { resolveGeminiProjectIdentifier } = await import("./native/gemini.ts");
      const registryPath = join(this.options.homeDir ?? homedir(), ".gemini", "projects.json");
      let registry: { projects?: Record<string, string> };
      let registryHash: string;
      try { const registryContent = readConversationFile(registryPath); registryHash = createHash("sha256").update(registryContent).digest("hex"); registry = JSON.parse(registryContent); } catch { throw new Error("Open Gemini CLI once in the target project to register its conversation folder, then preview again."); }
      const slug = registry.projects?.[cwd];
      if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error("Open Gemini CLI once in the target project to register its conversation folder, then preview again.");
      const markerPath = join(this.options.homeDir ?? homedir(), ".gemini", "tmp", slug, ".project_root");
      let marker: string;
      try { marker = readConversationFile(markerPath); } catch { throw new Error("Gemini project ownership could not be verified. Open Gemini CLI in the target project first."); }
      context.geminiProjectIdentifier = resolveGeminiProjectIdentifier(registry, cwd, { [slug]: marker }) ?? undefined;
      if (!context.geminiProjectIdentifier || sourceHash(registryPath) !== registryHash) throw new Error("Gemini project registration changed or could not be verified. Open Gemini CLI in the target project and preview again.");
      sources.push({ path: registryPath, hash: registryHash }, { path: markerPath, hash: createHash("sha256").update(marker).digest("hex") });
    }
    const adapter = (this.options.adapters ?? await nativeConversationAdapters())[targetHarness];
    if (!adapter) throw new Error("This native target adapter is unavailable. Export a universal document instead.");
    const activeThread = structuredClone(document.thread);
    for (const message of activeThread.messages) {
      const trusted = trustedMessages.get(message.id);
      const matches = trusted && trusted.role === message.role && trusted.content.length === message.content.length && trusted.content.every((block, index) => block.type === "text" ? message.content[index]?.type === "text" : JSON.stringify(block) === JSON.stringify(message.content[index]));
      if (matches) {
        message.provenance = { ...trusted.provenance, harness: trusted.provenance?.harness ?? source.harness, sourcePath: trusted.provenance?.sourcePath ?? source.sourcePath };
        message.providerRaw = structuredClone(trusted.providerRaw); message.providerHints = structuredClone(trusted.providerHints); message.model = trusted.model; message.stopReason = trusted.stopReason;
      } else {
        message.provenance = { ...message.provenance, harness: "other", sourcePath: message.provenance?.sourcePath ?? document.thread.sourcePath };
        issues.push({ severity: "warning", code: "untrusted_native_blocks", message: "Imported or structurally changed provider blocks are rendered as historical context; native provenance is verified against the source.", messageId: message.id });
      }
      if (insertedIds.has(message.id)) message.content = message.content.map(block => {
        if (block.type !== "redacted_thinking") return block;
        issues.push({ severity: "warning", code: "inserted_reasoning_opaque", message: "Inserted opaque reasoning remains in the private archive and is not replayed in a new context.", messageId: message.id });
        return { type: "text", text: "[Historical opaque reasoning retained in the portable archive]" };
      });
      if (insertedIds.has(message.id)) for (const block of message.content) if (block.type === "thinking" && block.signature) {
        delete block.signature; delete block.providerRaw;
        issues.push({ severity: "warning", code: "inserted_reasoning_opaque", message: "Inserted signed reasoning is retained as historical context because signature validity in the new context is unverified.", messageId: message.id });
      }
    }
    const artifact = adapter.render(activeThread, context);
    const validation = await validateConversationContent(artifact.jsonl, targetHarness, context, this.options.adapters);
    issues = [...issues, ...artifact.issues];
    if (document.selection?.segments && document.selection.segments.length > 1) issues.push({ severity: "warning", code: "section_gaps", message: `${document.selection.segments.length} separate source sections are being copied in source order. Intervening messages are omitted.` });
    const history = document.thread.providerMetadata?.codexHistory;
    if (history && typeof history === "object" && (history as Record<string, unknown>).opaqueContextPreserved === false) issues.push({ severity: "warning", code: "visible_history_materialized", message: "All visible Codex turns were materialized. Provider-internal model context is retained only where available as provenance and is not replayed." });
    const sourcePath = containedPath(root, artifact.relativePath);
    const previewId = randomUUID();
    this.prunePreviews();
    this.previews.set(previewId, { sourceId: id, expiresAt: Date.now() + 15 * 60_000, sources, document, context, artifact, root, sourcePath, report: validation, issues });
    return { previewId, targetHarness, sessionId: context.sessionId, title: context.title, projectPath: cwd, sourcePath, messageCount: document.thread.messages.length, jsonl: artifact.jsonl, resumeCommand: resumeCommand(cwd, artifact.resumeArgs), report: validation, issues };
  }

  async create(id: string, previewId: string) {
    const preview = this.previews.get(previewId);
    if (!preview || preview.sourceId !== id || preview.expiresAt < Date.now()) throw new Error("Preview expired. Validate the conversation again before creating it.");
    if (!preview.report.valid || preview.issues.some((issue) => issue.severity === "error")) throw new Error("Resolve validation errors before creating the conversation");
    for (const source of preview.sources) if (sourceHash(source.path) !== source.hash) throw new Error("A source conversation changed since the preview. Preview again before creating a copy.");
    // Consume before writing so double-clicks cannot create two copies from one approval.
    this.previews.delete(previewId);
    ensureSafeDirectories(preview.root, dirname(preview.sourcePath));
    const sidecar = `${preview.sourcePath}.universal.json`;
    const nativeStage = `${preview.sourcePath}.stage-${randomUUID()}`;
    const sidecarStage = `${sidecar}.stage-${randomUUID()}`;
    const owned = new Map<string, { dev: number; ino: number }>();
    const remember = (path: string) => { const stat = lstatSync(path); owned.set(path, { dev: stat.dev, ino: stat.ino }); };
    const removeOwned = (path: string) => { const original = owned.get(path); if (!original || !existsSync(path)) return; const current = lstatSync(path); if (current.dev === original.dev && current.ino === original.ino) unlinkSync(path); };
    try {
      exclusiveWrite(nativeStage, preview.artifact.jsonl); remember(nativeStage);
      const archived = structuredClone(preview.document);
      archived.thread.providerMetadata = { ...archived.thread.providerMetadata, portableArchiveSources: preview.sources, portableArchiveBinding: { harness: preview.artifact.harness, sessionId: preview.context.sessionId, byteLength: Buffer.byteLength(preview.artifact.jsonl), sha256: createHash("sha256").update(preview.artifact.jsonl).digest("hex") } };
      exclusiveWrite(sidecarStage, JSON.stringify(archived, null, 2) + "\n"); remember(sidecarStage);
      const validation = await validateConversationContent(readFileSync(nativeStage, "utf8"), preview.artifact.harness, preview.context, this.options.adapters);
      if (!validation.valid) throw new Error("The staged native file failed validation. Originals are unchanged.");
      for (const source of preview.sources) if (sourceHash(source.path) !== source.hash) throw new Error("A source conversation changed while preparing the copy. Preview again before creating it.");
      // Hard-link publication is atomic and fails if the destination already exists.
      // Publish the complete private archive before the native filename becomes visible to watchers.
      linkSync(sidecarStage, sidecar); remember(sidecar);
      linkSync(nativeStage, preview.sourcePath); remember(preview.sourcePath);
    } catch (error) {
      removeOwned(preview.sourcePath); removeOwned(sidecar);
      throw error;
    } finally { removeOwned(nativeStage); removeOwned(sidecarStage); }
    let indexed = false;
    let conversationId: string | undefined;
    const issues = [...preview.issues];
    try {
      if (this.indexer) {
        await this.indexer.indexFile(preview.sourcePath, { harness: preview.artifact.harness, path: preview.root, format: "jsonl" }, { force: true, collect: [] });
        const indexedConversation = await this.storage.getConversationBySourcePath(preview.sourcePath);
        conversationId = indexedConversation?.id;
        indexed = Boolean(conversationId);
      }
    } catch {
      issues.push({ severity: "warning", code: "index_pending", message: "The validated native file was created. Refresh the conversation index to show it in Toolkit." });
    }
    return { id: conversationId, sessionId: preview.context.sessionId, harness: preview.artifact.harness, title: preview.context.title, projectPath: preview.context.cwd, sourcePath: preview.sourcePath, universalPath: sidecar, indexed, nativeCreated: true, resumeCommand: resumeCommand(preview.context.cwd, preview.artifact.resumeArgs), report: preview.report, issues };
  }

  async clone(id: string, request: ConversationCloneRequest = {}) { const preview = await this.preview(id, request); return this.create(id, preview.previewId); }

  async editedDocument(id: string, edits: EditedMessage[]): Promise<PortableConversationDocument> {
    const source = await this.load(id);
    if (!edits.length) throw new Error("Provide edited messages");
    const messages = edits.map((edit): UniversalMessage => {
      const original = edit.originalIndex === undefined ? undefined : source.messages[edit.originalIndex];
      const supplied = edit.universalMessage;
      let message: UniversalMessage;
      if (supplied) { validateUniversalThread({ ...source, messages: [supplied] }); message = structuredClone(supplied); }
      else if (original) message = structuredClone(original);
      else message = { id: randomUUID(), role: edit.role, timestamp: new Date().toISOString(), content: [{ type: "text", text: edit.content }], provenance: { harness: "other", sourcePath: source.sourcePath } };
      if (edit.textBlockEdits) {
        if (!original || !supplied || JSON.stringify(original.content) !== JSON.stringify(supplied.content) || original.role !== edit.role) throw new Error("Structured message changed since the editor loaded. Reload before editing text blocks.");
        message = structuredClone(original);
        const seen = new Set<number>();
        for (const change of edit.textBlockEdits) {
          if (!Number.isInteger(change.index) || seen.has(change.index) || message.content[change.index]?.type !== "text" || typeof change.text !== "string" || change.text.length > 1_000_000) throw new Error("Invalid structured text block edit");
          seen.add(change.index);
          message.content[change.index] = { ...message.content[change.index], type: "text", text: change.text };
        }
        return message;
      }
      if (original && !edit.injected && edit.content === universalMessageText(original) && edit.role === original.role && !edit.rawEdited) return message;
      if (edit.rawEdited && edit.rawRecord && typeof edit.rawRecord === "object") {
        // Raw provider edits become explicit text in a new copy; arbitrary policy/header fields are never transplanted.
        message.content = [{ type: "text", text: edit.content }];
        message.providerMetadata = { ...message.providerMetadata, rawEditArchive: edit.rawRecord };
      } else {
        if (message.content.length !== 1 || message.content[0].type !== "text") throw new Error("Rich messages contain structured tool, reasoning or attachment blocks. Keep them unchanged, select sections to clone, or compact them with an explicit summary preview.");
        message.content = [{ type: "text", text: edit.content }];
      }
      message.role = edit.role;
      if (edit.compactionOriginals?.length) message.providerMetadata = { ...message.providerMetadata, compactionOriginals: edit.compactionOriginals, generatedSummary: true };
      return message;
    });
    return portableConversation({ ...source, messages, rawEvents: undefined });
  }

  private prunePreviews() {
    for (const [key, value] of this.previews) if (value.expiresAt < Date.now()) this.previews.delete(key);
    while (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value!);
  }
}

export function assertInsertionBoundary(thread: UniversalThread, afterMessageId: string | null): void {
  const position = afterMessageId === null ? 0 : thread.messages.findIndex((message) => message.id === afterMessageId) + 1;
  if (afterMessageId !== null && position === 0) throw new Error("Choose an insertion boundary in the target conversation");
  const open = new Set<string>();
  for (let index = 0; index < position; index++) for (const block of thread.messages[index].content) {
    if (block.type === "tool_use") open.add(block.toolCallId);
    if (block.type === "tool_result") open.delete(block.toolCallId);
  }
  if (open.size) throw new Error("This boundary splits a tool call from its result. Insert after the completed tool exchange instead.");
}

export function readConversationFile(path: string): string {
  if (statSync(path).size > 50_000_000) throw new Error("Conversation exceeds the 50 MB native-file limit. No history was truncated or changed.");
  return readFileSync(path, "utf8");
}
function sourceHash(path: string) { return createHash("sha256").update(readConversationFile(path)).digest("hex"); }
function canonicalRoot(path: string) { return existsSync(path) ? realpathSync(path) : resolve(path); }
function expandHome(path: string, home?: string) { return path.startsWith("~/") ? join(home ?? homedir(), path.slice(2)) : path; }
function containedPath(root: string, name: string) {
  if (isAbsolute(name) || name.split(/[\\/]/).includes("..") || name.includes("\0")) throw new Error("Native adapter returned an unsafe destination path");
  const path = resolve(root, name);
  if (!path.startsWith(resolve(root) + sep)) throw new Error("Native output must remain inside its configured destination");
  return path;
}
function ensureSafeDirectories(root: string, directory: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink()) throw new Error("Native destination root is a symlink; choose its actual configured directory");
  let current = root;
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && (lstatSync(current).isSymbolicLink() || !statSync(current).isDirectory())) throw new Error("Native destination contains an unsafe directory component");
    mkdirSync(current, { recursive: true, mode: 0o700 });
  }
}
function exclusiveWrite(path: string, content: string) { const descriptor = openSync(path, "wx", 0o600); try { writeFileSync(descriptor, content); } finally { closeSync(descriptor); } }
export function resumeCommand(cwd: string, args: string[]) { return `cd ${quote(cwd)} && ${args.map(quote).join(" ")}`; }
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Matches the legacy editor's display, so unchanged rich messages do not get flattened. */
export function legacyMessageText(message: UniversalMessage): string {
  return message.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "thinking") return `<thinking>\n${block.thinking}\n</thinking>`;
    if (block.type === "tool_use") return `[Tool: ${block.name}]\n${block.name === "Bash" ? `$ ${block.input.command ?? ""}` : JSON.stringify(block.input, null, 2)}`;
    if (block.type === "tool_result") { const text = typeof block.content === "string" ? block.content : universalMessageText({ ...message, content: block.content }); return `${block.isError ? "[Tool Output: Error]" : "[Tool Output]"}\n${text}`; }
    return universalMessageText({ ...message, content: [block] });
  }).filter(Boolean).join("\n\n");
}

function sourcePrefixMatches(path: string, expected: { hash: string; byteLength?: number }): boolean {
  if (expected.byteLength === undefined) return sourceHash(path) === expected.hash;
  if (!Number.isSafeInteger(expected.byteLength) || expected.byteLength < 1 || expected.byteLength > 50_000_000 || statSync(path).size < expected.byteLength) return false;
  const descriptor = openSync(path, "r");
  try { const prefix = Buffer.alloc(expected.byteLength); return readSync(descriptor, prefix, 0, prefix.length, 0) === prefix.length && createHash("sha256").update(prefix).digest("hex") === expected.hash; }
  finally { closeSync(descriptor); }
}
