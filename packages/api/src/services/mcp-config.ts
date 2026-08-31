import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { McpConfigFormat } from "@llm-toolkit/shared";

export interface McpServerDef {
  transport?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  extra?: Record<string, unknown>;
}

export interface McpServerState {
  name: string;
  def: McpServerDef;
  enabled: boolean;
}

export interface McpConfigSnapshot {
  path: string;
  format: McpConfigFormat;
  servers: McpServerState[];
}

const SECRET_KEYS = /auth|token|secret|password|credential|api[_-]?key|bearer/i;

export function formatForPath(path: string, fallback: McpConfigFormat): McpConfigFormat {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.endsWith(".mcp.json")) return "mcp-json";
  if (normalized.endsWith(".claude.json") || normalized.endsWith("/.claude.json")) return "claude-json";
  if (normalized.endsWith("config.toml")) return "toml-mcp";
  if (normalized.endsWith("opencode.json") || normalized.endsWith("opencode.jsonc")) return "opencode-json";
  if (normalized.endsWith("settings.json")) return "json-mcpServers";
  return fallback;
}

export function readMcpConfig(path: string, format: McpConfigFormat): McpConfigSnapshot {
  const resolvedFormat = formatForPath(path, format);
  if (!existsSync(path)) {
    return { path, format: resolvedFormat, servers: [] };
  }
  const text = readFileSync(path, "utf-8");
  const servers = resolvedFormat === "toml-mcp" ? parseTomlMcp(text) : parseJsonMcp(text, resolvedFormat);
  return { path, format: resolvedFormat, servers };
}

export function harvestClaudeProjectServers(home = homedir()): McpServerState[] {
  const claudeJson = join(home, ".claude.json");
  if (!existsSync(claudeJson)) return [];
  try {
    const data = JSON.parse(readFileSync(claudeJson, "utf-8")) as Record<string, unknown>;
    const byName = new Map<string, McpServerState>();
    for (const server of Object.entries(asRecord(data.mcpServers))) {
      byName.set(server[0], {
        name: server[0],
        def: normalizeServer(asRecord(server[1])),
        enabled: true,
      });
    }
    const projects = asRecord(data.projects);
    for (const entry of Object.values(projects)) {
      const rec = asRecord(entry);
      const servers = asRecord(rec.mcpServers);
      const disabled = new Set(asStringList(rec.disabledMcpServers).concat(asStringList(rec.disabledMcpjsonServers)));
      for (const [name, raw] of Object.entries(servers)) {
        if (byName.has(name)) continue;
        byName.set(name, {
          name,
          def: normalizeServer(asRecord(raw)),
          enabled: !disabled.has(name),
        });
      }
    }
    return [...byName.values()];
  } catch {
    return [];
  }
}

export function readClaudeProjectOverlay(projectRoot: string, home = homedir()): McpServerState[] {
  const claudeJson = join(home, ".claude.json");
  if (!existsSync(claudeJson)) return [];
  try {
    const data = JSON.parse(readFileSync(claudeJson, "utf-8")) as Record<string, unknown>;
    const projects = asRecord(data.projects);
    const entry = asRecord(projects[projectRoot]);
    const servers = asRecord(entry.mcpServers);
    const disabled = new Set(asStringList(entry.disabledMcpServers).concat(asStringList(entry.disabledMcpjsonServers)));
    return Object.entries(servers).map(([name, raw]) => ({
      name,
      def: normalizeServer(asRecord(raw)),
      enabled: !disabled.has(name),
    }));
  } catch {
    return [];
  }
}

export function upsertMcpServer(
  path: string,
  format: McpConfigFormat,
  name: string,
  def: McpServerDef,
  enabled = true,
): McpServerState {
  const snapshot = readMcpConfig(path, format);
  const next = snapshot.servers.filter((item) => item.name !== name);
  next.push({ name, def: { ...def }, enabled });
  writeMcpConfig(path, snapshot.format, next);
  return { name, def, enabled };
}

export function disableMcpServer(
  path: string,
  format: McpConfigFormat,
  name: string,
  remove: boolean,
): McpServerState {
  const snapshot = readMcpConfig(path, format);
  const existing = snapshot.servers.find((item) => item.name === name);
  const next = remove
    ? snapshot.servers.filter((item) => item.name !== name)
    : snapshot.servers.map((item) => item.name === name ? { ...item, enabled: false } : item);
  if (!existing && !remove) {
    return { name, def: {}, enabled: false };
  }
  writeMcpConfig(path, snapshot.format, next);
  return { name, def: existing?.def ?? {}, enabled: false };
}

export function defsEqual(a: McpServerDef, b: McpServerDef): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

export function maskMcpDef(def: McpServerDef): McpServerDef {
  const masked: McpServerDef = { ...def };
  if (def.env) {
    masked.env = Object.fromEntries(
      Object.entries(def.env).map(([key, value]) => [key, shouldMask(key, value) ? maskValue(value) : value]),
    );
  }
  if (def.headers) {
    masked.headers = Object.fromEntries(
      Object.entries(def.headers).map(([key, value]) => [key, shouldMask(key, value) ? maskValue(value) : value]),
    );
  }
  return masked;
}

export function parseMcpSourceFile(text: string, fileName: string): McpServerState[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (fileName.endsWith(".toml")) return parseTomlMcp(trimmed);
  const json = parseJsonish(trimmed);
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const rec = json as Record<string, unknown>;
  if (rec.mcpServers && typeof rec.mcpServers === "object") {
    return Object.entries(asRecord(rec.mcpServers)).map(([name, raw]) => ({
      name,
      def: normalizeServer(asRecord(raw)),
      enabled: true,
    }));
  }
  if (rec.mcp && typeof rec.mcp === "object") {
    return Object.entries(asRecord(rec.mcp)).map(([name, raw]) => ({
      name,
      def: normalizeServer(asRecord(raw)),
      enabled: true,
    }));
  }
  if (typeof rec.name === "string" && (rec.command || rec.url || rec.transport)) {
    return [{ name: rec.name, def: normalizeServer(rec), enabled: true }];
  }
  if (rec.command || rec.url || rec.type || rec.transport) {
    return [{ name: fileName.replace(/\.(jsonc?|toml)$/i, ""), def: normalizeServer(rec), enabled: true }];
  }
  return Object.entries(rec)
    .filter(([, value]) => value && typeof value === "object" && !Array.isArray(value))
    .map(([name, raw]) => ({ name, def: normalizeServer(asRecord(raw)), enabled: true }));
}

function writeMcpConfig(
  path: string,
  format: McpConfigFormat,
  servers: McpServerState[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, "utf-8") : "";
  if (existsSync(path)) backupPath(path);
  if (format === "toml-mcp") {
    writeFileSync(path, writeTomlMcp(current, servers), "utf-8");
    return;
  }
  writeFileSync(path, writeJsonMcp(current || "{}", format, servers), "utf-8");
}

function backupPath(path: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  renameSync(path, `${path}.bak.${stamp}`);
}

function parseJsonMcp(text: string, format: McpConfigFormat): McpServerState[] {
  const json = parseJsonish(text);
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const rec = json as Record<string, unknown>;
  if (format === "opencode-json") {
    return Object.entries(asRecord(rec.mcp)).map(([name, raw]) => {
      const def = normalizeServer(asRecord(raw));
      const enabled = asRecord(raw).enabled === false ? false : true;
      return { name, def, enabled };
    });
  }
  const servers = asRecord(rec.mcpServers);
  const disabled = new Set(asStringList(rec.disabledMcpServers).concat(asStringList(rec.disabledMcpjsonServers)));
  return Object.entries(servers).map(([name, raw]) => ({
    name,
    def: normalizeServer(asRecord(raw)),
    enabled: !disabled.has(name),
  }));
}

function writeJsonMcp(original: string, format: McpConfigFormat, servers: McpServerState[]): string {
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseJsonish(original);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (format === "opencode-json") {
    const mcp: Record<string, unknown> = {};
    for (const server of servers) {
      mcp[server.name] = denormalizeOpencode(server);
    }
    data.mcp = mcp;
    return `${JSON.stringify(data, null, 2)}\n`;
  }
  const mcpServers: Record<string, unknown> = {};
  const disabled: string[] = [];
  for (const server of servers) {
    mcpServers[server.name] = denormalizeClaude(server.def);
    if (!server.enabled) disabled.push(server.name);
  }
  data.mcpServers = mcpServers;
  if (format === "claude-json") {
    data.disabledMcpServers = disabled;
  } else if (disabled.length > 0) {
    data.disabledMcpServers = disabled;
  } else {
    delete data.disabledMcpServers;
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

function parseTomlMcp(text: string): McpServerState[] {
  const tables = splitTomlTables(text);
  const grouped = new Map<string, Record<string, string>>();
  const nested = new Map<string, Record<string, Record<string, string>>>();
  for (const table of tables) {
    const match = table.header.match(/^mcp_servers\.([^.]+)(?:\.(.+))?$/);
    if (!match) continue;
    const name = match[1]!;
    const sub = match[2];
    if (!sub) grouped.set(name, { ...(grouped.get(name) ?? {}), ...table.values });
    else {
      const bag = nested.get(name) ?? {};
      bag[sub] = table.values;
      nested.set(name, bag);
    }
  }
  const names = new Set([...grouped.keys(), ...nested.keys()]);
  return [...names].sort().map((name) => {
    const values = grouped.get(name) ?? {};
    const nest = nested.get(name) ?? {};
    const enabled = values.enabled ? values.enabled !== "false" : true;
    const def: McpServerDef = {};
    if (values.command) def.command = unquoteToml(values.command);
    if (values.url) def.url = unquoteToml(values.url);
    if (values.args) def.args = parseTomlArray(values.args);
    if (values.command && !values.url) def.transport = "stdio";
    if (values.url && !values.command) def.transport = values.url.includes("/sse") ? "sse" : "http";
    if (nest.env) def.env = mapUnquote(nest.env);
    if (nest.headers) def.headers = mapUnquote(nest.headers);
    if (values.env) def.env = { ...parseTomlInlineTable(values.env), ...def.env };
    if (values.headers) def.headers = { ...parseTomlInlineTable(values.headers), ...def.headers };
    return { name, def, enabled };
  });
}

function writeTomlMcp(original: string, servers: McpServerState[]): string {
  const stripped = stripTomlMcp(original).trimEnd();
  const blocks = servers.map((server) => renderTomlServer(server)).join("\n");
  if (!stripped) return `${blocks}\n`;
  return `${stripped}\n\n${blocks}\n`;
}

function stripTomlMcp(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\[([^\]]+)\]\s*$/);
    if (header) {
      skipping = header[1]!.startsWith("mcp_servers.");
    }
    if (!skipping) out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

function renderTomlServer(server: McpServerState): string {
  const lines = [`[mcp_servers.${escapeTomlKey(server.name)}]`];
  if (server.def.command) lines.push(`command = ${tomlString(server.def.command)}`);
  if (server.def.args?.length) lines.push(`args = [${server.def.args.map(tomlString).join(", ")}]`);
  if (server.def.url) lines.push(`url = ${tomlString(server.def.url)}`);
  lines.push(`enabled = ${server.enabled ? "true" : "false"}`);
  if (server.def.env && Object.keys(server.def.env).length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${escapeTomlKey(server.name)}.env]`);
    for (const [key, value] of Object.entries(server.def.env)) {
      lines.push(`${escapeTomlKey(key)} = ${tomlString(value)}`);
    }
  }
  if (server.def.headers && Object.keys(server.def.headers).length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${escapeTomlKey(server.name)}.headers]`);
    for (const [key, value] of Object.entries(server.def.headers)) {
      lines.push(`${escapeTomlKey(key)} = ${tomlString(value)}`);
    }
  }
  return lines.join("\n");
}

interface TomlTable {
  header: string;
  values: Record<string, string>;
}

function splitTomlTables(text: string): TomlTable[] {
  const tables: TomlTable[] = [];
  let current: TomlTable | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = { header: header[1]!, values: {} };
      tables.push(current);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    current.values[key] = value;
  }
  return tables;
}

function parseTomlArray(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner.split(",").map((part) => unquoteToml(part.trim())).filter(Boolean);
}

function parseTomlInlineTable(raw: string): Record<string, string> {
  const inner = raw.trim().replace(/^\{/, "").replace(/\}$/, "");
  const out: Record<string, string> = {};
  if (!inner.trim()) return out;
  for (const part of inner.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = unquoteToml(part.slice(eq + 1).trim());
  }
  return out;
}

function unquoteToml(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function mapUnquote(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, unquoteToml(value)]));
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function normalizeServer(raw: Record<string, unknown>): McpServerDef {
  const type = String(raw.type ?? raw.transport ?? "").toLowerCase();
  const command = firstString(raw.command);
  const url = firstString(raw.url);
  const args = Array.isArray(raw.args)
    ? raw.args.map((item) => String(item))
    : Array.isArray(raw.command)
      ? (raw.command as unknown[]).slice(1).map((item) => String(item))
      : undefined;
  const commandFromArray = Array.isArray(raw.command) ? String(raw.command[0] ?? "") : command;
  const env = asStringMap(raw.env);
  const headers = asStringMap(raw.headers);
  let transport: McpServerDef["transport"];
  if (type === "stdio" || type === "local") transport = "stdio";
  else if (type === "sse") transport = "sse";
  else if (type === "http" || type === "remote") transport = "http";
  else if (commandFromArray) transport = "stdio";
  else if (url) transport = url.includes("/sse") ? "sse" : "http";
  return {
    transport,
    command: commandFromArray || undefined,
    args: args?.length ? args : undefined,
    env: Object.keys(env).length ? env : undefined,
    url: url || undefined,
    headers: Object.keys(headers).length ? headers : undefined,
  };
}

function denormalizeClaude(def: McpServerDef): Record<string, unknown> {
  if (def.transport === "stdio" || def.command) {
    const out: Record<string, unknown> = { type: "stdio", command: def.command };
    if (def.args?.length) out.args = def.args;
    if (def.env) out.env = def.env;
    return out;
  }
  const out: Record<string, unknown> = {
    type: def.transport === "sse" ? "sse" : "http",
    url: def.url,
  };
  if (def.headers) out.headers = def.headers;
  return out;
}

function denormalizeOpencode(server: McpServerState): Record<string, unknown> {
  const def = server.def;
  if (def.transport === "stdio" || def.command) {
    const command = [def.command, ...(def.args ?? [])].filter(Boolean);
    const out: Record<string, unknown> = { type: "local", command, enabled: server.enabled };
    if (def.env) out.env = def.env;
    return out;
  }
  return {
    type: "remote",
    url: def.url,
    enabled: server.enabled,
    ...(def.headers ? { headers: def.headers } : {}),
  };
}

function canonicalize(def: McpServerDef): McpServerDef {
  return {
    transport: def.transport,
    command: def.command,
    args: def.args,
    env: def.env,
    url: def.url,
    headers: def.headers,
  };
}

function parseJsonish(text: string): unknown {
  const stripped = text.replace(/^\uFEFF/, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(stripped);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

function asStringMap(value: unknown): Record<string, string> {
  const rec = asRecord(value);
  return Object.fromEntries(Object.entries(rec).map(([key, item]) => [key, String(item)]));
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

function shouldMask(key: string, value: string): boolean {
  if (SECRET_KEYS.test(key)) return true;
  if (value.startsWith("eyJ") && value.includes(".")) return true;
  return false;
}

function maskValue(value: string): string {
  if (value.length < 8) return "***";
  return `${value.slice(0, 3)}...${value.slice(-4)}`;
}
