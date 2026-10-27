import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, parse } from "node:path";
import { createInterface } from "node:readline";
import type { UniversalContentBlock, UniversalMessage, UniversalThread } from "@llm-toolkit/shared";
import { codexRequiresMaterialization, importCodexConversation } from "./codex.ts";

type Value = Record<string, unknown>;
type Rpc = (method: string, params: Value) => Promise<Value>;
const READ_METHODS = new Set(["initialize", "thread/read", "thread/turns/list", "thread/items/list"]);

export interface CodexReadOptions {
  /** A configured source home; no source config, auth, permissions or tools are changed. */
  codexHome?: string;
  executable?: string;
  timeoutMs?: number;
  /** Request the official visible-history projection even for a complete rollout. */
  materialize?: boolean;
  /** Test-only transport injection; production always uses the installed read-only RPC methods. */
  request?: Rpc;
}

/** Complete inherited/paginated visible history without starting, resuming or running a turn. */
export async function readCodexConversation(sourcePath: string, options: CodexReadOptions = {}): Promise<UniversalThread> {
  const raw = await readFile(sourcePath, "utf8");
  if (!codexRequiresMaterialization(raw) && !options.materialize) return importCodexConversation(raw, sourcePath);
  const records = raw.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as Value);
  const meta = records.find(record => record.type === "session_meta")?.payload as Value | undefined;
  if (!meta || typeof meta.id !== "string") throw new Error("Codex inherited history requires its original session metadata.");
  const expectedPath = await realpath(sourcePath);
  const codexHome = options.codexHome ?? inferCodexHome(expectedPath);
  if (!codexHome && !options.request) throw new Error("Codex inherited history must be read from its configured Codex home; the standalone rollout is incomplete.");
  const client = options.request ? { request: options.request, close: async () => {} } : startReader(options.executable ?? "codex", codexHome!, options.timeoutMs ?? 120_000);
  try {
    const summary = await client.request("thread/read", { threadId: meta.id, includeTurns: false });
    const threadInfo = object(summary.thread);
    if (!threadInfo || threadInfo.id !== meta.id) throw new Error("Codex read returned a different thread identity.");
    if (typeof threadInfo.path !== "string" || await realpath(threadInfo.path) !== expectedPath) throw new Error("Codex read returned a different source path; refusing to mix histories.");
    const messages: UniversalMessage[] = [];
    const projectedEvents: Value[] = [];
    const seenTurns = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      if (++pageCount > 1000) throw new Error("Codex history exceeds the reader page limit; no partial history was imported.");
      const page = await client.request("thread/turns/list", { threadId: meta.id, itemsView: "full", sortDirection: "asc", limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data)) throw new Error("Codex returned an invalid turn page.");
      for (const value of page.data) {
        const turn = object(value);
        if (!turn || typeof turn.id !== "string" || !Array.isArray(turn.items)) throw new Error("Codex returned an invalid turn.");
        if (seenTurns.has(turn.id)) throw new Error("Codex returned overlapping turn pages; no partial history was imported.");
        seenTurns.add(turn.id);
        const items = turn.itemsView === "full" || turn.itemsView == null ? turn.items : await readTurnItems(client.request, meta.id, turn.id);
        const timestamp = typeof turn.startedAt === "number" ? new Date(turn.startedAt * 1000).toISOString() : typeof meta.timestamp === "string" ? meta.timestamp : new Date(0).toISOString();
        for (const [index, item] of items.entries()) {
          const projected = object(item);
          if (!projected || typeof projected.id !== "string" || typeof projected.type !== "string") throw new Error("Codex returned an invalid history item.");
          const content = projectedContent(projected);
          projectedEvents.push({ type: "app_server_item", timestamp, payload: projected, turnId: turn.id });
          if (!content.length) continue;
          messages.push({ id: `${sourcePath}:materialized:${turn.id}:${projected.id}:${index}`, role: projected.type === "userMessage" || projected.type === "hookPrompt" ? "user" : "assistant", timestamp, content, providerMessageId: projected.id, provenance: { harness: "codex", sourcePath }, providerHints: { turnId: turn.id, materialized: true, itemType: projected.type, ...(typeof projected.phase === "string" ? { phase: projected.phase } : {}) }, providerRaw: { type: "app_server_item", payload: projected } });
        }
      }
      cursor = nextCursor(page.nextCursor, cursors);
    } while (cursor);
    if (!messages.length) throw new Error("Codex returned no visible inherited history; no partial clone was created.");
    if (hash(await readFile(sourcePath, "utf8")) !== hash(raw)) throw new Error("The Codex source changed while it was read. Reload before exporting or cloning.");
    const title = typeof threadInfo.name === "string" && threadInfo.name ? threadInfo.name : typeof threadInfo.preview === "string" ? threadInfo.preview.slice(0, 100) : "Codex conversation";
    return { id: `codex:${meta.id}`, harness: "codex", sourcePath, projectPath: typeof threadInfo.cwd === "string" ? threadInfo.cwd : String(meta.cwd ?? dirname(sourcePath)), title, startedAt: messages[0].timestamp, updatedAt: messages.at(-1)!.timestamp, messages, rawEvents: records.map((event, index) => ({ id: `${sourcePath}:${index}`, timestamp: typeof event.timestamp === "string" ? event.timestamp : messages[0].timestamp, harness: "codex", eventType: String(event.type), raw: event })), providerMetadata: { sessionId: meta.id, sessionMeta: meta, codexHistory: { mode: "app-server-visible-history", complete: true, turnCount: seenTurns.size, pageCount, opaqueContextPreserved: false, note: "All visible turns were read through Codex; provider-private model context is not reconstructed. The original rollout and ancestry references are retained separately." }, materializedEvents: projectedEvents } };
  } finally { await client.close(); }
}

async function readTurnItems(request: Rpc, threadId: string, turnId: string): Promise<unknown[]> {
  const items: unknown[] = []; const cursors = new Set<string>(); let cursor: string | undefined; let pages = 0;
  do {
    if (++pages > 1000) throw new Error("Codex history exceeds the item page limit.");
    const page = await request("thread/items/list", { threadId, turnId, sortDirection: "asc", limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw new Error("Codex returned an invalid history item page.");
    items.push(...page.data); cursor = nextCursor(page.nextCursor, cursors);
  } while (cursor);
  return items;
}

function startReader(executable: string, codexHome: string, timeoutMs: number): { request: Rpc; close: () => Promise<void> } {
  // No login, configuration writes, thread/start, thread/resume, turn/start,
  // compaction, shell commands or server-request approvals are exposed here.
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], { env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "ignore"] }) as ReturnType<typeof spawn> & { stdin: NonNullable<ReturnType<typeof spawn>["stdin"]>; stdout: NonNullable<ReturnType<typeof spawn>["stdout"]>; on(event: "error" | "exit", callback: () => void): unknown; once(event: "exit", callback: () => void): unknown };
  const pending = new Map<number, { resolve: (value: Value) => void; reject: (reason: Error) => void }>();
  let id = 0; let stopped = false;
  const fail = (message: string) => { for (const request of pending.values()) request.reject(new Error(message)); pending.clear(); };
  child.on("error", () => { stopped = true; fail("The installed Codex app-server could not be started."); });
  child.stdin.on("error", () => fail("Codex read-only input closed."));
  child.on("exit", () => { stopped = true; fail("Codex read-only app-server exited before completing its response."); });
  const lines = createInterface({ input: child.stdout }) as ReturnType<typeof createInterface> & { on(event: "line", callback: (line: string) => void): unknown };
  lines.on("line", line => {
    let value: Value; try { value = JSON.parse(line) as Value; } catch { return; }
    if (typeof value.id === "number" && pending.has(value.id) && !value.method) {
      const request = pending.get(value.id)!; pending.delete(value.id);
      if (value.error) request.reject(new Error("Codex could not read the requested stored history. Check its installed version and original home."));
      else { const result = object(value.result); if (result) request.resolve(result); else request.reject(new Error("Codex returned an invalid read result.")); }
    } else if (value.id != null && typeof value.method === "string") {
      child.stdin.write(JSON.stringify({ id: value.id, error: { code: -32601, message: "This client permits history reads only." } }) + "\n");
    }
  });
  const rawRequest: Rpc = (method, params) => new Promise((resolve, reject) => {
    if (!READ_METHODS.has(method) || stopped) { reject(new Error("Only Codex read-only history methods are permitted.")); return; }
    const requestId = ++id; pending.set(requestId, { resolve, reject });
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + "\n", error => { if (error) { pending.delete(requestId); reject(new Error("Codex read-only request could not be sent.")); } });
  });
  const timeout = setTimeout(() => { fail("Codex history read timed out; no partial history was imported."); child.kill("SIGTERM"); }, timeoutMs);
  timeout.unref();
  const ready = rawRequest("initialize", { clientInfo: { name: "llm_toolkit_history_reader", version: "1.0.0" }, capabilities: { experimentalApi: true } }).then(() => { child.stdin.write('{"method":"initialized"}\n'); });
  return { request: async (method, params) => { await ready; return rawRequest(method, params); }, close: async () => {
    clearTimeout(timeout); fail("Codex history reader closed."); lines.close(); child.stdin.end();
    if (!stopped) {
      const timer = setTimeout(() => { if (!stopped) child.kill("SIGTERM"); }, 500); timer.unref();
      const kill = setTimeout(() => { if (!stopped) child.kill("SIGKILL"); }, 2000); kill.unref();
      await new Promise<void>(resolve => { if (stopped) resolve(); else child.once("exit", () => resolve()); });
      clearTimeout(timer); clearTimeout(kill);
    }
  } };
}

function nextCursor(value: unknown, seen: Set<string>): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !value || seen.has(value)) throw new Error("Codex returned an invalid or repeated history cursor.");
  seen.add(value); return value;
}
function inferCodexHome(sourcePath: string): string | undefined { let directory = dirname(sourcePath); while (directory !== parse(directory).root) { if (["sessions", "archived_sessions"].includes(directory.split(/[\\/]/).at(-1)!)) return dirname(directory); directory = dirname(directory); } return undefined; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function object(value: unknown): Value | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Value : undefined; }
function projectedContent(item: Value): UniversalContentBlock[] {
  if (item.type === "userMessage" || item.type === "hookPrompt") return Array.isArray(item.content) ? item.content.map(value => { const block = object(value); if (block?.type === "text" && typeof block.text === "string") return { type: "text", text: block.text }; if (block?.type === "image" && typeof block.url === "string") return { type: "image", source: block.url, providerRaw: block }; return { type: "unknown", raw: value, providerType: `codex-app-server:${String(block?.type ?? "unknown")}` }; }) : typeof item.text === "string" ? [{ type: "text", text: item.text }] : [];
  if (item.type === "agentMessage" && typeof item.text === "string") return [{ type: "text", text: item.text }];
  if (item.type === "reasoning") return [{ type: "thinking", thinking: Array.isArray(item.summary) ? item.summary.filter(value => typeof value === "string").join("\n") : "", providerType: "codex-app-server:reasoning", providerRaw: item }];
  if (item.type === "functionCallOutput") return [{ type: "text", text: `[Historical tool output: ${String(item.name ?? "tool")}]\n${typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "")}`, providerType: "codex-app-server:functionCallOutput", providerRaw: item }];
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "fileChange" || item.type === "webSearch" || item.type === "plan") {
    const visible: Value = {};
    for (const key of ["server", "tool", "name", "arguments", "result", "error", "contentItems", "changes", "action", "text", "status"]) if (item[key] != null) visible[key] = item[key];
    return [{ type: "text", text: `[Historical ${item.type}]\n${JSON.stringify(visible)}`, providerType: `codex-app-server:${item.type}`, providerRaw: item }];
  }
  if (item.type === "commandExecution") return [{ type: "text", text: `[Historical command — ${String(item.status ?? "unknown status")}]\n${String(item.command ?? "")}\n${String(item.aggregatedOutput ?? "")}`, providerType: "codex-app-server:commandExecution", providerRaw: item }];
  return [{ type: "unknown", raw: item, providerType: `codex-app-server:${String(item.type)}`, providerRaw: item }];
}
