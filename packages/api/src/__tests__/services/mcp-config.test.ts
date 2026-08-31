import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  disableMcpServer,
  maskMcpDef,
  parseMcpSourceFile,
  readMcpConfig,
  upsertMcpServer,
} from "../../services/mcp-config.ts";

describe("maskMcpDef", () => {
  test("masks authorization headers and jwt-like env values", () => {
    const masked = maskMcpDef({
      headers: { Authorization: "Bearer secret-token-value" },
      env: { AUTH_HEADER: "eyJhbGciOiJIUzI1NiJ9.payload.sig" },
    });
    expect(masked.headers?.Authorization).toMatch(/^.{3}\.\.\..{4}$/);
    expect(masked.env?.AUTH_HEADER).toMatch(/^.{3}\.\.\..{4}$/);
  });
});

describe("parseMcpSourceFile", () => {
  test("reads a single server object", () => {
    const parsed = parseMcpSourceFile(
      JSON.stringify({ command: "uvx", args: ["server"], env: { TOKEN: "abc" } }),
      "doc-pointers.json",
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe("doc-pointers");
    expect(parsed[0]?.def.command).toBe("uvx");
  });

  test("reads an mcpServers map", () => {
    const parsed = parseMcpSourceFile(
      JSON.stringify({ mcpServers: { npl: { type: "sse", url: "http://127.0.0.1/sse" } } }),
      "mcp.json",
    );
    expect(parsed[0]?.name).toBe("npl");
    expect(parsed[0]?.def.transport).toBe("sse");
  });
});

describe("toml mcp config", () => {
  const root = mkdtempSync(join(tmpdir(), "llm-toolkit-mcp-"));

  test("upserts and disables a grok-style server", () => {
    const path = join(root, "config.toml");
    writeFileSync(path, "[other]\nfoo = 1\n", "utf-8");
    upsertMcpServer(path, "toml-mcp", "doc-pointers", { url: "http://localhost:4242/mcp" }, true);
    const enabled = readMcpConfig(path, "toml-mcp");
    expect(enabled.servers[0]?.name).toBe("doc-pointers");
    expect(enabled.servers[0]?.enabled).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("[other]");
    disableMcpServer(path, "toml-mcp", "doc-pointers", false);
    const disabled = readMcpConfig(path, "toml-mcp");
    expect(disabled.servers[0]?.enabled).toBe(false);
  });

  test("cleanup", () => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("json mcp config", () => {
  test("writes .mcp.json without clobbering siblings", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-toolkit-mcp-json-"));
    mkdirSync(root, { recursive: true });
    const path = join(root, ".mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { keep: { type: "http", url: "http://k" } } }), "utf-8");
    upsertMcpServer(path, "mcp-json", "npl", { transport: "sse", url: "http://127.0.0.1/sse" }, true);
    const snap = readMcpConfig(path, "mcp-json");
    expect(snap.servers.map((s) => s.name).sort()).toEqual(["keep", "npl"]);
    rmSync(root, { recursive: true, force: true });
  });
});
