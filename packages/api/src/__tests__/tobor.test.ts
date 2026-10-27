import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const sdk = vi.hoisted(() => ({ auth: vi.fn(), callTool: vi.fn(), connect: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({ auth: sdk.auth }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
  connect = sdk.connect;
  listTools = async () => ({ tools: [{ name: "ToolCall" }] });
  callTool = sdk.callTool;
  close = async () => {};
} }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: class {} }));
import { ToborService, ToborPermissionError, toborFetch } from "../services/tobor.ts";
import { createToborRoutes } from "../routes/tobor.ts";
beforeEach(() => vi.clearAllMocks());
describe("Tobor projects OAuth", () => {
  test("keeps separate private credentials and binds callback to one-time state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tobor-test-"));
    try {
      sdk.auth.mockImplementation(async (provider, options) => {
        if (options.authorizationCode) { expect(provider.codeVerifier()).toBe("verifier"); provider.saveTokens({ access_token: "private-tobor-token", token_type: "Bearer", scope: options.scope }); return "AUTHORIZED"; }
        provider.saveClientInformation({ client_id: "public-client" }); provider.saveCodeVerifier("verifier");
        provider.redirectToAuthorization(new URL(`https://agentonomi.com/oauth/authorize?state=${provider.state()}`)); return "REDIRECT";
      });
      const service = new ToborService(dir);
      const login = await service.startLogin(3100);
      expect(service.redirectUrl).toBe("http://127.0.0.1:3100/api/tobor/oauth/callback");
      const state = new URL(login.authorizationUrl).searchParams.get("state")!;
      await expect(service.finishLogin("code", "invalid")).rejects.toThrow();
      await service.finishLogin("code", state);
      await expect(service.finishLogin("code", state)).rejects.toThrow();
      expect(service.status().connected).toBe(true);
      expect(service.status().permissionsUrl).toBe("https://agentonomi.com/app/admin/mcp-config/oauth-client/public-client");
      expect(JSON.stringify(service.status())).not.toContain("private-tobor-token");
      expect(statSync(join(dir, "tobor-oauth.json")).mode & 0o777).toBe(0o600);
      await expect(toborFetch("https://therobot.is/mcp")).rejects.toThrow("Untrusted");
      await service.disconnect(); expect(service.status().connected).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("uses hidden ToolCall contract and paginates org-scoped projects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tobor-test-"));
    try {
      const service = new ToborService(dir);
      service.saveTokens({ access_token: "private", token_type: "Bearer" });
      sdk.callTool.mockImplementation(async ({ name, arguments: input }) => {
        expect(name).toBe("ToolCall");
        if (input.tool === "Organization_List") return { structuredContent: { organizations: [{ id: "org-id", slug: "robot" }, { id: "unselected-org", slug: "unselected" }] } };
        expect(input.tool).toBe("Project_List"); expect(input.arguments.organization).toBe("org-id");
        const size = input.arguments.offset === 0 ? 100 : 1;
        return { structuredContent: { projects: Array.from({ length: size }, (_, index) => ({ id: `project-${input.arguments.offset + index}`, slug: `slug-${input.arguments.offset + index}`, name: `Project ${index}`, status: "active" })) } };
      });
      const projects = await service.listProjects("robot");
      expect(projects.length).toBe(101); expect(projects.at(-1)).toMatchObject({ id: "project-100", organizationId: "org-id", organizationSlug: "robot" });
      expect(sdk.callTool).toHaveBeenCalledTimes(3);
      const routes = createToborRoutes(service);
      const denied = await routes.request("http://localhost:3100/oauth/start", { method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }, body: "{}" });
      expect(denied.status).toBe(403);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("linking rejects arbitrary paths and projects outside the authenticated catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tobor-test-"));
    try {
      const service = new ToborService(dir);
      const list = vi.spyOn(service, "listProjects").mockResolvedValue([]);
      const catalog = { list: async () => [{ locations: [{ canonicalRoot: "/known/repo", repositoryRoot: "/known/repo" }] }] } as unknown as import("../services/project-catalog.ts").ProjectCatalog;
      const routes = createToborRoutes(service, catalog);
      const headers = { Origin: "http://localhost:3100", "Content-Type": "application/json" };
      const outside = await routes.request("http://localhost:3100/link", { method: "POST", headers, body: JSON.stringify({ repositoryPath: "/arbitrary", projectId: "project-id", organization: "robot" }) });
      expect(outside.status).toBe(400); expect(list).not.toHaveBeenCalled();
      const forbidden = await routes.request("http://localhost:3100/link", { method: "POST", headers, body: JSON.stringify({ repositoryPath: "/known/repo", projectId: "inaccessible", organization: "robot" }) });
      expect(forbidden.status).toBe(403); expect(list).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("reports disabled Project_List distinctly and never queries projects without an organization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tobor-test-"));
    try {
      const service = new ToborService(dir); service.saveTokens({ access_token: "private", token_type: "Bearer" });
      sdk.callTool.mockImplementation(async ({ arguments: input }) => input.tool === "Organization_List"
        ? { structuredContent: { organizations: [{ id: "org-id", slug: "robot" }] } }
        : { isError: true, content: [{ type: "text", text: "Tool 'Project_List' is disabled for this API key" }] });
      await expect(service.listProjects("robot")).rejects.toBeInstanceOf(ToborPermissionError);
      expect(service.status().projectAccess).toBe("disabled");
      const routes = createToborRoutes(service);
      const denied = await routes.request("/projects?organization=robot");
      expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ code: "TOBOR_PERMISSION_REQUIRED" });
      sdk.callTool.mockClear();
      expect((await routes.request("/projects")).status).toBe(400);
      expect(sdk.callTool).not.toHaveBeenCalled();
      expect((await service.listOrganizations()).map(org => org.slug)).toEqual(["robot"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
