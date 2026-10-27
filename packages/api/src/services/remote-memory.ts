import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export const MEMORY_SERVER = "https://therobot.is/mcp";
const ORIGIN = "https://therobot.is";
type SavedAuth = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; expiresAt?: number; redirect?: string; connectionId?: string };
type PendingAuth = { state: string; verifier?: string; started: number; scope: string; url?: string };

/** Fixed-origin fetch: discovery cannot forward tokens to another host or follow redirects. */
export const memoryFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== ORIGIN || url.username || url.password) throw new Error("Untrusted memory service endpoint");
  return fetch(input, { ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(30_000) });
};

export class RemoteMemoryService implements OAuthClientProvider {
  private saved: SavedAuth = {};
  private pending?: PendingAuth;
  private login = false;
  private operation = Promise.resolve();
  private readonly file: string;

  constructor(dataDir = process.env.LLM_TOOLKIT_DATA_DIR ?? process.env.CLAUDE_ASSIST_DATA_DIR ?? join(homedir(), ".llm-toolkit")) {
    this.file = join(dataDir, "memory-oauth.json");
    try { this.saved = JSON.parse(readFileSync(this.file, "utf8")); chmodSync(this.file, 0o600); } catch { /* not connected */ }
  }

  get redirectUrl() { return this.saved.redirect; }
  get clientMetadata() {
    return { client_name: "LLM Toolkit", redirect_uris: [this.redirectUrl!], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" as const };
  }
  state() { return this.pending!.state; }
  clientInformation() { return this.saved.client; }
  saveClientInformation(client: OAuthClientInformationMixed) { this.saved.client = client; this.persist(); }
  tokens() { return this.login ? undefined : this.saved.tokens; }
  saveTokens(tokens: OAuthTokens) {
    this.saved.tokens = tokens;
    this.saved.expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined;
    this.persist();
  }
  saveCodeVerifier(verifier: string) { if (!this.pending) throw new Error("Login not started"); this.pending.verifier = verifier; }
  codeVerifier() { if (!this.pending?.verifier) throw new Error("Login expired. Connect again."); return this.pending.verifier; }
  redirectToAuthorization(url: URL) {
    if (url.origin !== ORIGIN) throw new Error("Untrusted authorization endpoint");
    if (this.pending) this.pending.url = url.href;
  }
  invalidateCredentials(scope: string) {
    if (scope === "all" || scope === "client") this.saved.client = undefined;
    if (scope === "all" || scope === "tokens") { this.saved.tokens = undefined; this.saved.expiresAt = undefined; }
    if (scope === "all" || scope === "verifier") this.pending = undefined;
    this.persist();
  }
  private persist() {
    const dir = this.file.slice(0, this.file.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.saved), { mode: 0o600, flag: "wx" });
    renameSync(tmp, this.file);
  }

  status() {
    return { connected: !!this.saved.tokens, serverUrl: MEMORY_SERVER, writeEnabled: this.saved.tokens?.scope?.split(" ").includes("mcp:write") ?? false, expiresAt: this.saved.expiresAt ?? null, connectionId: this.saved.connectionId ?? null, loginPending: !!this.pending && Date.now() - this.pending.started < 600_000 };
  }

  /** Serialize refreshes: rotating refresh tokens must never race. */
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }

  startLogin(port: number, write: boolean) {
    return this.exclusive(async () => {
      const redirect = `http://127.0.0.1:${port}/api/remote-memory/oauth/callback`;
      if (redirect !== this.saved.redirect) this.saved.client = undefined;
      this.saved.redirect = redirect;
      this.pending = { state: randomBytes(32).toString("base64url"), started: Date.now(), scope: write ? "mcp:read mcp:write" : "mcp:read" };
      this.login = true;
      try {
        await auth(this, { serverUrl: MEMORY_SERVER, scope: this.pending.scope, fetchFn: memoryFetch });
        if (!this.pending.url) throw new Error("The memory service did not provide a login URL");
        return { authorizationUrl: this.pending.url };
      } finally { this.login = false; }
    });
  }

  finishLogin(code: string, state: string) {
    return this.exclusive(async () => {
      const pending = this.pending;
      const actual = Buffer.from(state);
      const expected = Buffer.from(pending?.state ?? "");
      if (!pending || Date.now() - pending.started > 600_000 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Login expired or invalid. Return to LLM Toolkit and connect again.");
      // Consume state before exchanging, including failed exchanges.
      pending.state = "";
      try {
        const result = await auth(this, { serverUrl: MEMORY_SERVER, authorizationCode: code, scope: pending.scope, fetchFn: memoryFetch });
        if (result !== "AUTHORIZED") throw new Error("Authorization was not completed");
        this.saved.connectionId = randomBytes(12).toString("hex");
        this.persist();
      } finally { this.pending = undefined; }
    });
  }

  disconnect() {
    return this.exclusive(async () => {
      // Disconnect only this app; never revoke shared credentials or delete memories.
      this.saved = {};
      this.pending = undefined;
      try { unlinkSync(this.file); } catch { /* already absent */ }
    });
  }

  call(tool: "graph_subgraph" | "recall_preview" | "remember" | "memory_set", args: Record<string, unknown>) {
    return this.exclusive(async () => {
      if (!this.saved.tokens) throw new Error("Sign in to therobot.is to access your memories.");
      if (!["graph_subgraph", "recall_preview"].includes(tool) && !this.status().writeEnabled) throw new Error("Reconnect with memory editing enabled to make changes.");
      const client = new Client({ name: "llm-toolkit", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(MEMORY_SERVER), { authProvider: this, fetch: memoryFetch });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const selected = tools.find((item) => item.name === tool) ?? tools.find((item) => item.name.toLowerCase().replace(/[^a-z0-9]/g, "").endsWith(tool.replaceAll("_", "")));
        if (!selected) throw new Error("The memory service does not support this action.");
        // Bulk review retries rely on the server's import deduplication contract.
        // Never silently send an unprotected write to an older server schema.
        if (tool === "remember" && args.source_ref && !selected.inputSchema?.properties?.source_ref) throw new Error("The memory service does not support safe bulk imports yet.");
        const result = await client.callTool({ name: selected.name, arguments: args });
        if (result.isError) throw new Error("The memory service rejected this action. Check your account permissions and try again.");
        if (result.structuredContent) return result.structuredContent;
        const blocks = result.content as Array<{ type: string; text?: string }>;
        const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
        try { return JSON.parse(text); } catch { throw new Error("The memory service returned an unsupported response."); }
      } finally { await client.close().catch(() => {}); }
    });
  }
}
