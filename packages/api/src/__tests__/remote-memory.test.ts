import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, statSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sdk = vi.hoisted(() => ({ auth: vi.fn(), callTool: vi.fn(), connect: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({ auth: sdk.auth }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
  connect = sdk.connect;
  listTools = async () => ({ tools: [{ name: "graph_subgraph" }, { name: "remember" }] });
  callTool = sdk.callTool;
  close = async () => {};
} }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: class {} }));
import { RemoteMemoryService, memoryFetch } from "../services/remote-memory.ts";
import { createRemoteMemoryRoutes } from "../routes/remote-memory.ts";

beforeEach(() => { vi.clearAllMocks(); });
function mockLogin() {
  sdk.auth.mockImplementation(async (provider, options) => {
    if (options.authorizationCode) {
      expect(provider.codeVerifier()).toBe("test-verifier");
      provider.saveTokens({ access_token: "private-token", token_type: "Bearer", expires_in: 3600, scope: options.scope });
      return "AUTHORIZED";
    }
    provider.saveClientInformation({ client_id: "test-public-client" });
    provider.saveCodeVerifier("test-verifier");
    provider.redirectToAuthorization(new URL(`https://therobot.is/oauth/authorize?state=${provider.state()}`));
    return "REDIRECT";
  });
}

describe("Remote memory OAuth", () => {
  test("binds a one-time state to PKCE, persists private tokens and never returns them in status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-oauth-"));
    try {
      mockLogin();
      const service = new RemoteMemoryService(dir);
      const { authorizationUrl } = await service.startLogin(3100, false);
      expect(service.redirectUrl).toBe("http://127.0.0.1:3100/api/remote-memory/oauth/callback");
      const state = new URL(authorizationUrl).searchParams.get("state")!;
      await expect(service.finishLogin("code", "attacker")).rejects.toThrow();
      await service.finishLogin("code", state);
      expect(service.status().connected).toBe(true);
      expect(service.status().writeEnabled).toBe(false);
      expect(JSON.stringify(service.status())).not.toContain("private-token");
      expect(statSync(join(dir, "memory-oauth.json")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, "memory-oauth.json"), "utf8")).not.toContain("test-verifier");
      await expect(service.finishLogin("code", state)).rejects.toThrow();
      await expect(service.call("remember", { content: "unauthorized write" })).rejects.toThrow("editing enabled");
      const restored = new RemoteMemoryService(dir);
      expect(restored.status().connected).toBe(true);
      await restored.disconnect();
      expect(restored.status().connected).toBe(false);
      expect(new RemoteMemoryService(dir).status().connected).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("expires pending login and refuses forwarding credentials to other hosts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-oauth-"));
    try {
      mockLogin();
      const service = new RemoteMemoryService(dir);
      const login = await service.startLogin(3100, true);
      const state = new URL(login.authorizationUrl).searchParams.get("state")!;
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
      await expect(service.finishLogin("code", state)).rejects.toThrow();
      now.mockRestore();
      await expect(memoryFetch("https://attacker.example/token", { headers: { Authorization: "Bearer private" } })).rejects.toThrow("Untrusted");
      expect(() => service.redirectToAuthorization(new URL("https://attacker.example/login"))).toThrow("Untrusted");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("decodes MCP JSON results and keeps provider failures out of public route errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-oauth-"));
    try {
      const service = new RemoteMemoryService(dir);
      service.saveTokens({ access_token: "private-token", token_type: "Bearer", scope: "mcp:read" });
      sdk.callTool.mockResolvedValue({ content: [{ type: "text", text: '{"nodes":[]}' }] });
      expect(await service.call("graph_subgraph", { limit: 1 })).toEqual({ nodes: [] });
      sdk.connect.mockRejectedValueOnce(new Error("upstream private-token"));
      const response = await createRemoteMemoryRoutes(service).request("http://localhost:3100/memories");
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("private-token");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("refuses bulk writes when a server does not advertise source-ref deduplication", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-oauth-"));
    try {
      const service = new RemoteMemoryService(dir);
      service.saveTokens({ access_token: "private-token", token_type: "Bearer", scope: "mcp:read mcp:write" });
      await expect(service.call("remember", { content: "reviewed memory", source_ref: "stable-import-id" })).rejects.toThrow("safe bulk imports");
      expect(sdk.callTool).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("checks the expected connection inside the serialized operation before using its grant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-oauth-"));
    try {
      const service = new RemoteMemoryService(dir);
      service.saveTokens({ access_token: "private-token", token_type: "Bearer", scope: "mcp:read mcp:write" });
      await expect(service.call("remember", { content: "reviewed memory" }, "another-connection")).rejects.toThrow("Memory connection changed");
      expect(sdk.callTool).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("Remote memory browser boundaries", () => {
  test("rejects foreign origins, validates callback state and never echoes OAuth codes", async () => {
    const service = { status: () => ({ connected: false }), startLogin: vi.fn(), finishLogin: vi.fn().mockRejectedValue(new Error("bad state private-code")) } as unknown as RemoteMemoryService;
    const app = createRemoteMemoryRoutes(service);
    const foreign = await app.request("http://localhost:3100/oauth/start", { method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }, body: "{}" });
    expect(foreign.status).toBe(403);
    const remote = await app.request("http://attacker.example/status");
    expect(remote.status).toBe(403);
    const callback = await app.request("http://localhost:3100/oauth/callback?code=private-code&state=invalid");
    expect(callback.status).toBe(400);
    expect(await callback.text()).not.toContain("private-code");
    expect(callback.headers.get("cache-control")).toBe("no-store");
    const denied = await app.request("http://localhost:3100/oauth/callback?error=access_denied");
    expect(denied.status).toBe(400);
    expect(service.finishLogin).toHaveBeenCalledTimes(1);
  });
});
