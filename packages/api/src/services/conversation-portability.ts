import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
  sources: Array<{ path: string; hash: string }>;
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
    } else {
      thread = { id, harness: conversation.harness, title: conversation.title, sourcePath: conversation.sourcePath, projectPath: conversation.projectPath, startedAt: conversation.startedAt.toISOString(), updatedAt: conversation.updatedAt.toISOString(), messages: await this.storage.getUniversalMessages(id), rawEvents: await this.storage.getRawTranscriptEvents(id) };
    }
    thread = { ...thread, id, title: conversation.title || thread.title, sourcePath: conversation.sourcePath, projectPath: thread.projectPath || conversation.projectPath };
    validateUniversalThread(thread);
    return thread;
  }

  private async loadSnapshot(id: string) {
    const conversation = await this.storage.getConversation(id);
    if (!conversation) throw new Error("Conversation not found");
    const fingerprint = { path: conversation.sourcePath, hash: sourceHash(conversation.sourcePath) };
    const thread = await this.load(id);
    if (thread.sourcePath !== fingerprint.path || sourceHash(fingerprint.path) !== fingerprint.hash) throw new Error("A source conversation changed while loading. Preview again before creating a copy.");
    return { thread, fingerprint };
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
    const sources = [sourceSnapshot.fingerprint];
    if (request.insertIntoConversationId) {
      const targetSnapshot = await this.loadSnapshot(request.insertIntoConversationId);
      const target = targetSnapshot.thread;
      const boundary = request.afterMessageId === undefined ? target.messages.at(-1)?.id ?? null : request.afterMessageId;
      assertInsertionBoundary(target, boundary);
      document = insertConversationSection(portableConversation(target), document, boundary);
      sources.push(targetSnapshot.fingerprint);
      issues.push({ severity: "info", code: "target_copy", message: "The existing target conversation remains unchanged. A new copy will contain its prefix, the inserted section, and its suffix." });
    }
    const targetHarness = request.targetHarness ?? document.thread.harness;
    if (targetHarness !== "claude" && targetHarness !== "codex") throw new Error(`Native ${targetHarness} cloning is unsupported. Export universal JSON or Markdown instead.`);
    const projectPath = request.projectPath ?? document.thread.projectPath;
    if (!isAbsolute(projectPath) || projectPath.includes("\0") || !existsSync(projectPath) || !statSync(projectPath).isDirectory()) throw new Error("Choose an existing absolute project directory for the new conversation");
    const cwd = realpathSync(projectPath);
    const roots = this.destinations(targetHarness);
    const root = request.destinationRoot ? canonicalRoot(expandHome(request.destinationRoot, this.options.homeDir)) : roots[0];
    if (!roots.includes(root)) throw new Error("Choose a configured destination root");
    const context: NativeConversationContext = { sessionId: randomUUID(), cwd, title: request.title?.trim() || `${document.thread.title} (copy)`, createdAt: new Date().toISOString(), sourceHarness: document.thread.harness };
    const adapter = (this.options.adapters ?? await nativeConversationAdapters())[targetHarness];
    if (!adapter) throw new Error("This native target adapter is unavailable. Export a universal document instead.");
    const artifact = adapter.render(document.thread, context);
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
      exclusiveWrite(sidecarStage, JSON.stringify(preview.document, null, 2) + "\n"); remember(sidecarStage);
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
      if (original && !edit.injected && edit.content === universalMessageText(original) && edit.role === original.role && !edit.rawEdited) return message;
      if (edit.rawEdited && edit.rawRecord && typeof edit.rawRecord === "object") {
        // Raw provider edits become explicit text in a new copy; arbitrary policy/header fields are never transplanted.
        message.content = [{ type: "text", text: edit.content }];
        message.providerMetadata = { ...message.providerMetadata, rawEditArchive: edit.rawRecord };
      } else {
        const firstText = message.content.findIndex((block) => block.type === "text");
        if (firstText >= 0) message.content[firstText] = { type: "text", text: edit.content };
        else message.content.unshift({ type: "text", text: edit.content });
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
