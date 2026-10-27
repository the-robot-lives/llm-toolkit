import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export const TOBOR_SERVER = "https://agentonomi.com/custom/tobor/mcp";
const ORIGIN = "https://agentonomi.com";
type SavedAuth = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; expiresAt?: number; redirect?: string; connectionId?: string };
type PendingAuth = { state: string; verifier?: string; started: number; scope: string; url?: string };

/** Fixed-origin fetch: discovery cannot forward tokens to another host or follow redirects. */
export const toborFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== ORIGIN || url.username || url.password) throw new Error("Untrusted project service endpoint");
  return fetch(input, { ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(30_000) });
};

export class ToborPermissionError extends Error {
  constructor(readonly tool: string) {
    super(`${tool === "Project_List" ? "Projects" : "Organizations"} access is disabled for this Tobor connection. The effective tool policy blocks ${tool}. Check this OAuth client and its endpoint permissions in Agentonomi MCP settings.`);
    this.name = "ToborPermissionError";
  }
}

export class ToborService implements OAuthClientProvider {
  private saved: SavedAuth = {};
  private pending?: PendingAuth;
  private login = false;
  private operation = Promise.resolve();
  private readonly file: string;
  private projectAccess: "unknown" | "available" | "disabled" = "unknown";

  constructor(dataDir = process.env.LLM_TOOLKIT_DATA_DIR ?? process.env.CLAUDE_ASSIST_DATA_DIR ?? join(homedir(), ".llm-toolkit")) {
    this.file = join(dataDir, "tobor-oauth.json");
    try { this.saved = JSON.parse(readFileSync(this.file, "utf8")); chmodSync(this.file, 0o600); } catch { /* not connected */ }
  }

  get redirectUrl() { return this.saved.redirect; }
  get clientMetadata() {
    return { client_name: "LLM Toolkit Projects", redirect_uris: [this.redirectUrl!], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" as const };
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
    return { connected: !!this.saved.tokens, serverUrl: TOBOR_SERVER, permissionsUrl: this.saved.client?.client_id ? `https://agentonomi.com/app/admin/mcp-config/oauth-client/${encodeURIComponent(this.saved.client.client_id)}` : null, expiresAt: this.saved.expiresAt ?? null, connectionId: this.saved.connectionId ?? null, projectAccess: this.projectAccess, loginPending: !!this.pending && Date.now() - this.pending.started < 600_000 };
  }

  /** Serialize refreshes: rotating refresh tokens must never race. */
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }

  startLogin(port: number) {
    return this.exclusive(async () => {
      const redirect = `http://127.0.0.1:${port}/api/tobor/oauth/callback`;
      if (redirect !== this.saved.redirect) this.saved.client = undefined;
      this.saved.redirect = redirect;
      this.pending = { state: randomBytes(32).toString("base64url"), started: Date.now(), scope: "mcp offline_access" };
      this.login = true;
      try {
        await auth(this, { serverUrl: TOBOR_SERVER, scope: this.pending.scope, fetchFn: toborFetch });
        if (!this.pending.url) throw new Error("The project service did not provide a login URL");
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
        const result = await auth(this, { serverUrl: TOBOR_SERVER, authorizationCode: code, scope: pending.scope, fetchFn: toborFetch });
        if (result !== "AUTHORIZED") throw new Error("Authorization was not completed");
        this.saved.connectionId = randomBytes(12).toString("hex");
        this.projectAccess = "unknown";
        this.persist();
      } finally { this.pending = undefined; }
    });
  }

  disconnect() {
    return this.exclusive(async () => {
      // Disconnect only this app; never revoke shared credentials or delete projects.
      this.saved = {};
      this.projectAccess = "unknown";
      this.pending = undefined;
      try { unlinkSync(this.file); } catch { /* already absent */ }
    });
  }

  private async call(client: Client, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const available = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      available.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    const normalized = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const selected = available.find(item => normalized(item.name) === normalized(tool));
    const fallback = available.find(item => normalized(item.name) === "toolcall");
    if (!selected && !fallback) throw new Error(`The Tobor connection does not expose ${tool}. Enable Projects and Organizations in its consent settings.`);
    let result = await client.callTool(selected ? { name: selected.name, arguments: args } : { name: fallback!.name, arguments: { tool, arguments: args } });
    const decode = (response: typeof result): Record<string, unknown> => {
      if (response.structuredContent) return response.structuredContent as Record<string, unknown>;
      const text = (response.content as Array<{ type: string; text?: string }>).filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
      return JSON.parse(text) as Record<string, unknown>;
    };
    // Some deployed gateways advertise Project_List but retain a legacy dotted
    // dispatch alias. Retry this read-only operation only when the SAME grant's
    // manifest explicitly includes and enables it; never override a real deny.
    const aliasError = result.isError && (result.content as Array<{ type: string; text?: string }>).some(block => block.type === "text" && /disabled for this API key/i.test(block.text ?? ""));
    if (aliasError && !selected && fallback && tool === "Project_List") {
      const manifestTool = available.find(item => normalized(item.name) === "sessionmanifest");
      let permitted = false;
      if (manifestTool) {
        try {
          const manifestResult = await client.callTool({ name: manifestTool.name, arguments: {} });
          if (!manifestResult.isError) {
            const manifest = decode(manifestResult);
            const entry = Array.isArray(manifest.tools) ? manifest.tools.find(item => item && typeof item.name === "string" && normalized(item.name) === normalized(tool)) : undefined;
            permitted = entry?.enabled === true && entry.included === true;
          }
        } catch { /* A missing/invalid manifest is never permission to retry. */ }
      }
      if (permitted) result = await client.callTool({ name: fallback.name, arguments: { tool: "Project.List", arguments: args } });
    }
    if (result.isError) {
      const message = (result.content as Array<{ type: string; text?: string }>).filter(block => block.type === "text").map(block => block.text ?? "").join(" ");
      if (/disabled for this API key|disabled for this.*client|not allowed.*tool/i.test(message)) {
        if (tool === "Project_List") this.projectAccess = "disabled";
        throw new ToborPermissionError(tool);
      }
      throw new Error("Tobor rejected the project lookup. Check your organization access.");
    }
    return decode(result);
  }

  private withClient<T>(action: (client: Client) => Promise<T>) {
    return this.exclusive(async () => {
      if (!this.saved.tokens) throw new Error("Connect to Tobor to browse remote projects.");
      const client = new Client({ name: "llm-toolkit-projects", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(TOBOR_SERVER), { authProvider: this, fetch: toborFetch });
      try { await client.connect(transport); return await action(client); }
      finally { await client.close().catch(() => {}); }
    });
  }
  private async organizations(client: Client) {
    const organizations: Array<{ id: string; slug: string; name: string }> = [];
    for (let offset = 0; offset < 10_000; offset += 100) {
      const result = await this.call(client, "Organization_List", { limit: 100, offset });
      const rows = result.organizations;
      if (!Array.isArray(rows)) throw new Error("Unexpected organizations response");
      for (const row of rows) if (typeof row.id === "string" && typeof row.slug === "string") organizations.push({ id: row.id, slug: row.slug, name: typeof row.name === "string" ? row.name : row.slug });
      if (rows.length < 100) break;
    }
    return organizations;
  }
  listOrganizations() { return this.withClient(client => this.organizations(client)); }

  /** Only the explicitly selected organization is queried for projects. */
  listProjects(organization: string) {
    return this.withClient(async client => {
      const organizations = await this.organizations(client);
      const org = organizations.find(item => item.id === organization || item.slug === organization);
      if (!org) throw new Error("Organization is not accessible through this Tobor connection.");
      const projects: import("@llm-toolkit/shared").ToborProject[] = [];
      for (let offset = 0; offset < 10_000; offset += 100) {
        const result = await this.call(client, "Project_List", { organization: org.id, status: "active", limit: 100, offset });
        const rows = result.projects;
        if (!Array.isArray(rows)) throw new Error("Unexpected projects response");
        for (const row of rows) if (typeof row.id === "string" && typeof row.slug === "string" && typeof row.name === "string") projects.push({ id: row.id, slug: row.slug, name: row.name, organizationId: org.id, organizationSlug: org.slug, status: typeof row.status === "string" ? row.status : "active" });
        if (rows.length < 100) break;
      }
      this.projectAccess = "available";
      return projects;
    });
  }
}
