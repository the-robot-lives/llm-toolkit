import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export class NplPluginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NplPluginConfigError";
  }
}

export type NplServiceTransport = "stdio" | "http";

export interface NplServiceConfig {
  name: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  transport?: NplServiceTransport;
  url?: string;
  health_url?: string;
  port?: number;
  enabled?: boolean;
  autostart?: boolean;
  sync_to_stores?: boolean;
}

export interface NplPluginConfig {
  version: number;
  services: NplServiceConfig[];
  mcp_sync?: { targets: string[] };
}

export const DEFAULT_CONFIG: NplPluginConfig = {
  version: 1,
  services: [],
  mcp_sync: { targets: [] },
};

// ⟦𓋗𓎼𓐒𓁵⟧ findUserConfigPath :: $NPL_CONFIG_HOME > $XDG_CONFIG_HOME > ~/.config, then npl/npl-plugin.config.yaml
export function findUserConfigPath(home?: string): string {
  const base =
    process.env.NPL_CONFIG_HOME ??
    process.env.XDG_CONFIG_HOME ??
    join(home ?? homedir(), ".config");
  return join(base, "npl", "npl-plugin.config.yaml");
}

// ⟦𓐨𓎞𓏢𓈆⟧ findProjectRoot :: walk up from startCwd to the dir containing .npl/npl-plugin.config.yaml
export function findProjectRoot(startCwd: string): string | null {
  let dir = resolve(startCwd);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, ".npl", "npl-plugin.config.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function expandHome(p: string, home?: string): string {
  if (p === "~") return home ?? homedir();
  if (p.startsWith("~/")) return join(home ?? homedir(), p.slice(2));
  return p;
}

// ⟦𓎁𓇋𓄻𓍕⟧ validateService :: required fields, name shape, http⇒url
function validateService(svc: unknown, origin: string): NplServiceConfig {
  if (typeof svc !== "object" || svc === null) {
    throw new NplPluginConfigError(`${origin}: service entry is not an object`);
  }
  const s = svc as Record<string, unknown>;
  const name = s.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new NplPluginConfigError(`${origin}: service missing required "name"`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new NplPluginConfigError(
      `${origin}: service name "${name}" must match /^[a-z0-9-]+$/`,
    );
  }
  const transport = (s.transport ?? "stdio") as NplServiceTransport;
  if (transport !== "stdio" && transport !== "http") {
    throw new NplPluginConfigError(
      `${origin}: service "${name}" has invalid transport "${String(s.transport)}" (expected stdio|http)`,
    );
  }
  if (transport === "http" && (typeof s.url !== "string" || s.url.length === 0)) {
    throw new NplPluginConfigError(
      `${origin}: service "${name}" has transport "http" but no "url"`,
    );
  }
  return s as unknown as NplServiceConfig;
}

// ⟦𓌢𓃷𓆔𓁧⟧ parseConfigFile :: read + YAML parse + validate; null when file absent
function parseConfigFile(path: string, origin: string): Partial<NplPluginConfig> | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new NplPluginConfigError(`${origin}: malformed YAML at ${path}: ${(err as Error).message}`);
  }
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new NplPluginConfigError(`${origin}: config at ${path} is not a mapping`);
  }
  const doc = raw as Record<string, unknown>;
  const out: Partial<NplPluginConfig> = { ...(doc as Partial<NplPluginConfig>) };
  if (doc.services !== undefined) {
    if (!Array.isArray(doc.services)) {
      throw new NplPluginConfigError(`${origin}: "services" must be a list`);
    }
    out.services = doc.services.map((s) => validateService(s, origin));
  }
  return out;
}

export interface MergeResult {
  config: NplPluginConfig;
  serviceSources: Record<string, "user" | "project">;
}

// ⟦𓄻⟧ mergeConfigs :: scalars replaced; services merged by name with field-level override; env/args replaced wholesale
export function mergeConfigs(
  base: NplPluginConfig,
  override: Partial<NplPluginConfig>,
  baseLayer: "user" | "project" = "user",
  overrideLayer: "user" | "project" = "project",
): MergeResult {
  const config: NplPluginConfig = {
    ...structuredClone(base),
    ...Object.fromEntries(Object.entries(override).filter(([, v]) => v !== undefined)),
  };
  const serviceSources: Record<string, "user" | "project"> = {};
  const byName = new Map<string, NplServiceConfig>();
  for (const svc of base.services) {
    byName.set(svc.name, structuredClone(svc));
    serviceSources[svc.name] = baseLayer;
  }
  for (const svc of override.services ?? []) {
    const existing = byName.get(svc.name);
    if (existing) {
      byName.set(svc.name, {
        ...existing,
        ...Object.fromEntries(Object.entries(svc).filter(([, v]) => v !== undefined)),
      });
    } else {
      byName.set(svc.name, structuredClone(svc));
    }
    serviceSources[svc.name] = overrideLayer;
  }
  config.services = [...byName.values()];
  return { config, serviceSources };
}

export interface LoadNplPluginConfigOpts {
  cwd?: string;
  home?: string;
  userPath?: string;
  projectPath?: string;
}

export interface LoadedNplPluginConfig {
  config: NplPluginConfig;
  projectRoot: string | null;
  layers: { userFound: boolean; projectFound: boolean };
  serviceSources: Record<string, "user" | "project">;
}

// ⟦𓋗⟧ loadNplPluginConfig :: user layer then project layer, merged onto defaults
export function loadNplPluginConfig(opts: LoadNplPluginConfigOpts = {}): LoadedNplPluginConfig {
  const startCwd = opts.cwd ?? process.cwd();
  const projectRoot = findProjectRoot(startCwd);

  const userPath = opts.userPath ?? findUserConfigPath(opts.home);
  const projectPath =
    opts.projectPath ?? (projectRoot ? join(projectRoot, ".npl", "npl-plugin.config.yaml") : null);

  const userDoc = parseConfigFile(userPath, "user config");
  const projectDoc = projectPath ? parseConfigFile(projectPath, "project config") : null;

  const layers = { userFound: userDoc !== null, projectFound: projectDoc !== null };

  // Version check per layer.
  for (const [label, doc] of [["user", userDoc], ["project", projectDoc]] as const) {
    if (doc && doc.version !== undefined && doc.version !== 1) {
      throw new NplPluginConfigError(
        `${label} config: unsupported version ${doc.version} (expected 1)`,
      );
    }
  }

  const userBase: NplPluginConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    ...(userDoc ?? {}),
  };
  // Dedupe within the user layer itself.
  assertUniqueNames(userBase.services ?? [], "user config");

  let merged: MergeResult;
  if (projectDoc) {
    const projectServices = projectDoc.services ?? [];
    assertUniqueNames(projectServices, "project config");
    merged = mergeConfigs(userBase, projectDoc, "user", "project");
  } else {
    merged = { config: userBase, serviceSources: {} };
    for (const svc of userBase.services) merged.serviceSources[svc.name] = "user";
  }

  assertUniqueNames(merged.config.services ?? [], "merged config");
  for (const svc of merged.config.services ?? []) {
    if (typeof svc.command !== "string" || svc.command.length === 0) {
      throw new NplPluginConfigError(`merged config: service "${svc.name}" missing required "command"`);
    }
    if (svc.cwd) svc.cwd = expandHome(svc.cwd, opts.home);
  }

  return {
    config: merged.config,
    projectRoot,
    layers,
    serviceSources: merged.serviceSources,
  };
}

function assertUniqueNames(services: NplServiceConfig[], origin: string): void {
  const seen = new Set<string>();
  for (const svc of services) {
    if (seen.has(svc.name)) {
      throw new NplPluginConfigError(`${origin}: duplicate service name "${svc.name}"`);
    }
    seen.add(svc.name);
  }
}

export interface SaveNplPluginConfigOpts {
  projectRoot?: string;
  home?: string;
}

// ⟦𓋗𓋗⟧ saveNplPluginConfig :: write full config for scope, preserving unknown top-level keys
export function saveNplPluginConfig(
  scope: "user" | "project",
  config: NplPluginConfig,
  opts: SaveNplPluginConfigOpts = {},
): string {
  const path =
    scope === "user"
      ? findUserConfigPath(opts.home)
      : join(
          opts.projectRoot ?? findProjectRoot(process.cwd()) ?? process.cwd(),
          ".npl",
          "npl-plugin.config.yaml",
        );

  // Preserve unknown top-level keys from an existing file at this scope.
  let known: Record<string, unknown>;
  try {
    known = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  } catch {
    known = config as unknown as Record<string, unknown>;
  }
  const existing = parseConfigFile(path, `${scope} config`);
  const mergedDoc: Record<string, unknown> = { ...(existing ?? {}) };
  for (const key of Object.keys(known)) delete mergedDoc[key];
  const out = { ...mergedDoc, ...known };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(out), "utf-8");
  return path;
}

export function resolveServiceCwd(
  svc: NplServiceConfig,
  projectRoot: string | null,
  home?: string,
): string {
  const expanded = expandHome(svc.cwd ?? "", home);
  if (!expanded) return projectRoot ?? process.cwd();
  return isAbsolute(expanded) ? expanded : resolve(projectRoot ?? process.cwd(), expanded);
}
