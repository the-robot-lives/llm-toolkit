import { Hono } from "hono";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AppConfig, ArtifactKind, SkillsConfig, LlmProfile } from "@llm-toolkit/shared";
import type { StorageService } from "../services/storage.ts";
import type { LlmService } from "../services/llm.ts";
import { defaultSkillsConfig, findSkillCatalog, migrateSkillsConfig } from "../services/skills.ts";
import { normalizeSourceRoots } from "../services/source-roots.ts";
import { discoverArtifactFolders, resolveKindConfig } from "../services/artifacts.ts";

const CONFIG_KEY = "app_config";

const DEFAULTS: AppConfig = {
  indexPaths: [join(homedir(), ".claude", "projects")],
  indexSources: [
    { harness: "claude", path: join(homedir(), ".claude", "projects"), format: "jsonl", label: "Claude Code" },
    { harness: "codex", path: join(homedir(), ".codex", "sessions"), format: "jsonl", label: "Codex" },
  ],
  embedding: { provider: "local", model: "all-MiniLM-L6-v2" },
  server: { port: 3100, host: "localhost" },
  skills: defaultSkillsConfig(),
  agents: defaultSkillsConfig(),
  commands: defaultSkillsConfig(),
  mcp: defaultSkillsConfig(),
  llmProfiles: [],
  defaultProfileId: "",
  indexing: { preferLocal: true, deepWindowDays: 14 },
};

const LLM_ENV_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  zai: "ZAI_API_KEY",
  litellm: "LITELLM_API_KEY",
};

function applyEnvOverlays(config: AppConfig): AppConfig {
  // Embedding key overlays
  const embeddingEnvKey = LLM_ENV_KEYS[config.embedding.provider];
  if (embeddingEnvKey && process.env[embeddingEnvKey]) {
    config.embedding.apiKey = process.env[embeddingEnvKey];
  }

  // LLM key + URL overlays
  if (config.llm?.provider) {
    const llmEnvKey = LLM_ENV_KEYS[config.llm.provider];
    if (llmEnvKey && process.env[llmEnvKey]) {
      config.llm.apiKey = process.env[llmEnvKey];
    }
    if (config.llm.provider === "litellm" && !config.llm.apiKey && process.env.OPENAI_API_KEY) {
      config.llm.apiKey = process.env.OPENAI_API_KEY;
    }
    if (config.llm.provider === "ollama" && process.env.OLLAMA_BASE_URL) {
      config.llm.baseUrl = process.env.OLLAMA_BASE_URL;
    }
    if (config.llm.provider === "litellm" && process.env.LITELLM_BASE_URL) {
      config.llm.baseUrl = process.env.LITELLM_BASE_URL;
    }
  }

  return config;
}

const PROFILE_ENV_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
  alibaba: "ALIBABA_API_KEY",
};

const PROFILE_LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llamacpp"]);

/** Deterministic profile id slug from name + provider + model. */
function profileSlug(name: string, provider: string, model?: string): string {
  const base = [name, provider, model]
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (base || "profile").slice(0, 64);
}

function normalizeProfile(raw: Partial<LlmProfile>, legacy?: AppConfig["llm"], usedIds?: Set<string>): LlmProfile | null {
  const provider = String(raw.provider ?? "") as LlmProfile["provider"];
  if (!provider) return null;
  const local = raw.local === true || PROFILE_LOCAL_PROVIDERS.has(provider);
  let id = typeof raw.id === "string" && raw.id ? raw.id : "";
  if (!id) {
    // Deterministic slug so ids stay stable across requests (storedById lookup).
    const base = profileSlug(typeof raw.name === "string" && raw.name ? raw.name : provider, provider, raw.model);
    id = base;
    if (usedIds) {
      for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    }
  }
  usedIds?.add(id);
  const profile: LlmProfile = {
    id,
    name: typeof raw.name === "string" && raw.name ? raw.name : provider,
    provider,
    apiType: raw.apiType === "anthropic" ? "anthropic" : raw.apiType === "openai" ? "openai" : undefined,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : undefined,
    model: typeof raw.model === "string" && raw.model ? raw.model : (legacy?.model ?? "gpt-4o"),
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    local,
  };
  return profile;
}

// Legacy single-llm config → llmProfiles (only when no profiles stored yet).
function migrateLlmProfiles(dbConfig: Partial<AppConfig>): void {
  if (dbConfig.llmProfiles?.length) return;
  if (!dbConfig.llm?.provider) return;
  const legacy = dbConfig.llm;
  const providerMap: Record<string, LlmProfile["provider"]> = {
    anthropic: "anthropic",
    alibaba: "alibaba",
    openai: "openai-compatible",
    litellm: "openai-compatible",
    groq: "openai-compatible",
    cerebras: "openai-compatible",
    deepseek: "openai-compatible",
    zai: "openai-compatible",
    ollama: "ollama",
    custom: legacy.apiType === "anthropic" ? "anthropic" : "openai-compatible",
  };
  const provider = providerMap[legacy.provider] ?? "openai-compatible";
  const profile = normalizeProfile({
    id: "default",
    name: legacy.provider === "custom" ? "Custom" : legacy.provider,
    provider,
    apiType: legacy.apiType,
    baseUrl: legacy.baseUrl,
    model: legacy.model ?? "gpt-4o",
    apiKey: legacy.apiKey,
  }, legacy);
  if (!profile) return;
  dbConfig.llmProfiles = [profile];
  dbConfig.defaultProfileId = profile.id;
  if (profile.local) dbConfig.defaultLocalProfileId = profile.id;
}

function applyProfileEnvOverlays(profile: LlmProfile): void {
  if (profile.apiKey) return;
  const envKey = PROFILE_ENV_KEYS[profile.provider];
  if (envKey && process.env[envKey]) profile.apiKey = process.env[envKey];
  if (!profile.apiKey && profile.provider === "alibaba") profile.apiKey = process.env.DASHSCOPE_API_KEY;
}

export function maskKey(key: string | undefined): string | undefined {
  if (!key || key.length < 8) return key ? "***" : undefined;
  return key.slice(0, 3) + "..." + key.slice(-4);
}

export function isMaskedKey(key: string | undefined): boolean {
  if (!key) return false;
  return key === "***" || /^.{3}\.\.\..{4}$/.test(key);
}

function sanitizeForResponse(config: AppConfig): AppConfig {
  const safe = structuredClone(config);
  safe.embedding.apiKey = maskKey(safe.embedding.apiKey);
  if (safe.llm) safe.llm.apiKey = maskKey(safe.llm.apiKey);
  if (safe.llmProfiles) {
    for (const profile of safe.llmProfiles) profile.apiKey = maskKey(profile.apiKey);
  }
  return safe;
}

function migrateLegacyConfig(storage: StorageService): Partial<AppConfig> {
  const legacyPath = join(
    process.env.LLM_TOOLKIT_DATA_DIR ?? process.env.CLAUDE_ASSIST_DATA_DIR ?? join(homedir(), ".llm-toolkit"),
    "config.json",
  );
  if (!existsSync(legacyPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(legacyPath, "utf-8")) as Partial<AppConfig>;
    storage.setSetting(CONFIG_KEY, JSON.stringify(raw));
    return raw;
  } catch {
    return {};
  }
}

export function loadConfig(storage: StorageService): AppConfig {
  let dbConfig: Partial<AppConfig> = {};
  const raw = storage.getSetting(CONFIG_KEY);
  if (raw) {
    dbConfig = JSON.parse(raw);
  } else {
    dbConfig = migrateLegacyConfig(storage);
  }

  const merged: AppConfig = {
    ...DEFAULTS,
    ...dbConfig,
    embedding: { ...DEFAULTS.embedding, ...dbConfig.embedding },
    server: { ...DEFAULTS.server, ...dbConfig.server },
  };
  if (!merged.indexSources && merged.indexPaths) {
    merged.indexSources = merged.indexPaths.map((path) => ({ harness: "claude", path, format: "jsonl" }));
  }
  if (dbConfig.llm) merged.llm = dbConfig.llm;
  migrateLlmProfiles(dbConfig);
  merged.llmProfiles = (dbConfig.llmProfiles ?? []).map((p) => normalizeProfile(p as LlmProfile)).filter((p): p is LlmProfile => p !== null);
  for (const profile of merged.llmProfiles) applyProfileEnvOverlays(profile);
  merged.defaultProfileId = dbConfig.defaultProfileId ?? merged.llmProfiles[0]?.id ?? "";
  merged.defaultLocalProfileId = dbConfig.defaultLocalProfileId ?? merged.llmProfiles.find((p) => p.local)?.id;
  merged.indexing = { ...DEFAULTS.indexing!, ...dbConfig.indexing };
  merged.skills = migrateSkillsConfig(dbConfig.skills);
  merged.agents = resolveKindConfig("agents", merged.skills, dbConfig.agents);
  merged.commands = resolveKindConfig("commands", merged.skills, dbConfig.commands);
  merged.mcp = resolveKindConfig("mcp", merged.skills, dbConfig.mcp);

  return applyEnvOverlays(merged);
}

export function persistSkillsConfig(storage: StorageService, skills: SkillsConfig): AppConfig {
  return persistArtifactConfig(storage, "skills", skills);
}

export function persistArtifactConfig(storage: StorageService, kind: ArtifactKind, config: SkillsConfig): AppConfig {
  const current = loadConfig(storage);
  current[kind] = migrateSkillsConfig(config);
  persistConfig(storage, current);
  return sanitizeForResponse(current);
}

function persistConfig(storage: StorageService, current: AppConfig): void {
  const toStore = structuredClone(current);
  const embEnvKey = LLM_ENV_KEYS[toStore.embedding.provider];
  if (embEnvKey && process.env[embEnvKey]) delete toStore.embedding.apiKey;
  if (toStore.llm?.provider) {
    const llmEnvKey = LLM_ENV_KEYS[toStore.llm.provider];
    if (llmEnvKey && process.env[llmEnvKey]) delete toStore.llm.apiKey;
  }
  for (const profile of toStore.llmProfiles ?? []) {
    const envKey = PROFILE_ENV_KEYS[profile.provider];
    if (profile.apiKey && ((envKey && profile.apiKey === process.env[envKey]) ||
      (profile.provider === "alibaba" && profile.apiKey === process.env.DASHSCOPE_API_KEY))) {
      delete profile.apiKey;
    }
  }
  storage.setSetting(CONFIG_KEY, JSON.stringify(toStore));
}

const SOURCE_KINDS = ["skills", "agents", "commands"] as const;

export function artifactSourceSettings(storage: StorageService, discover: typeof discoverArtifactFolders = discoverArtifactFolders) {
  const config = loadConfig(storage);
  return Object.fromEntries(SOURCE_KINDS.map(kind => {
    const configured = normalizeSourceRoots(config[kind]?.sourceFolders ?? []);
    const defaults = normalizeSourceRoots(discover(kind));
    const effective = configured.paths.length ? configured.paths : defaults.paths;
    return [kind, { configured: configured.paths, effective, defaults: defaults.paths, warnings: configured.paths.length ? configured.warnings : defaults.warnings, ...(kind === "skills" ? { catalogs: effective.map(root => ({ root, catalogFile: findSkillCatalog(root) ?? null })) } : {}) }];
  }));
}

// <REMOVED UUID HERE> createConfigRoutes :: auto-generated pointer for public function createConfigRoutes
export function createConfigRoutes(storage: StorageService, llmService: LlmService, sourceDiscovery = discoverArtifactFolders): Hono {
  const routes = new Hono();

  routes.get("/artifact-sources", c => c.json({ data: artifactSourceSettings(storage, sourceDiscovery) }));
  routes.patch("/artifact-sources", async c => {
    const url = new URL(c.req.url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return c.json({ error: "Source settings are available only on this computer." }, 403);
    if (![url.origin, "http://localhost:5173", "http://127.0.0.1:5173"].includes(c.req.header("Origin") ?? "")) return c.json({ error: "Untrusted request origin" }, 403);
    const updates = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!updates || Array.isArray(updates) || Object.keys(updates).some(key => !SOURCE_KINDS.includes(key as typeof SOURCE_KINDS[number]))) return c.json({ error: "Provide Skills, Agents, or Commands source arrays only." }, 400);
    try {
      // Source-only persistence intentionally does not round-trip normalized or
      // masked LLM settings, credentials, unknown config keys or OAuth files.
      const saved = storage.getSetting(CONFIG_KEY);
      const raw = saved ? JSON.parse(saved) : migrateLegacyConfig(storage);
      const defaults = loadConfig(storage);
      for (const kind of SOURCE_KINDS) if (updates[kind] !== undefined) {
        if (!Array.isArray(updates[kind]) || (updates[kind] as unknown[]).length > 100) throw new Error("Use at most 100 source folders per kind.");
        const normalized = normalizeSourceRoots(updates[kind], true);
        raw[kind] = { ...(raw[kind] ?? defaults[kind]), sourceFolders: normalized.paths };
      }
      storage.setSetting(CONFIG_KEY, JSON.stringify(raw));
      return c.json({ data: artifactSourceSettings(storage, sourceDiscovery) });
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Could not save source folders." }, 400); }
  });

  routes.get("/", (c) => {
    const config = loadConfig(storage);
    return c.json({ data: sanitizeForResponse(config) });
  });

  routes.patch("/", async (c) => {
    const current = loadConfig(storage);
    const updates = await c.req.json() as Partial<AppConfig>;
    // Old general Settings snapshots may include independently saved artifact
    // source lists. Preserve authoritative current lists on mixed global saves;
    // legacy artifact-only PATCH requests still update their source folders.
    const mixedGlobalSave = Object.keys(updates).some(key => !["skills", "agents", "commands", "mcp"].includes(key));
    const sourceSafePatch = (kind: ArtifactKind) => {
      const patch = { ...updates[kind] };
      if (mixedGlobalSave) delete patch.sourceFolders;
      return patch;
    };

    if (updates.indexPaths) current.indexPaths = updates.indexPaths;
    if (updates.indexSources) current.indexSources = updates.indexSources;
    if (updates.embedding) {
      if (isMaskedKey(updates.embedding.apiKey)) delete updates.embedding.apiKey;
      current.embedding = { ...current.embedding, ...updates.embedding };
    }
    if (updates.server) current.server = { ...current.server, ...updates.server };
    if (updates.llm) {
      if (isMaskedKey(updates.llm.apiKey)) delete updates.llm.apiKey;
      current.llm = { ...current.llm, ...updates.llm };
    }
    if (updates.llmProfiles) {
      // Replace array wholesale. Per-profile masked keys keep the stored value.
      const storedById = new Map((current.llmProfiles ?? []).map((p) => [p.id, p]));
      const usedIds = new Set<string>();
      current.llmProfiles = updates.llmProfiles
        .map((p) => {
          const normalized = normalizeProfile(p as LlmProfile, undefined, usedIds);
          if (!normalized) return null;
          if (isMaskedKey(normalized.apiKey)) {
            // Only reuse the stored key when this profile id actually exists;
            // otherwise drop the mask so we never persist '***' as a real key.
            normalized.apiKey = storedById.get(normalized.id)?.apiKey;
          }
          return normalized;
        })
        .filter((p): p is LlmProfile => p !== null);
    }
    if (updates.defaultProfileId !== undefined) current.defaultProfileId = updates.defaultProfileId;
    if (updates.defaultLocalProfileId !== undefined) current.defaultLocalProfileId = updates.defaultLocalProfileId;
    if (updates.indexing) current.indexing = { ...current.indexing, ...updates.indexing };
    if (updates.skills) {
      current.skills = migrateSkillsConfig({ ...current.skills, ...sourceSafePatch("skills") });
    }
    if (updates.agents) {
      current.agents = migrateSkillsConfig({ ...current.agents, ...sourceSafePatch("agents") });
    }
    if (updates.commands) {
      current.commands = migrateSkillsConfig({ ...current.commands, ...sourceSafePatch("commands") });
    }
    if (updates.mcp) {
      current.mcp = migrateSkillsConfig({ ...current.mcp, ...sourceSafePatch("mcp") });
    }

    persistConfig(storage, current);
    llmService.setProfiles(
      current.llmProfiles ?? [],
      current.defaultProfileId ?? "",
      current.defaultLocalProfileId,
    );

    // Hot-reconfigure LLM service if LLM config changed
    if (updates.llm) {
      await llmService.reconfigure(current.llm);
    }

    return c.json({ data: sanitizeForResponse(current) });
  });

  return routes;
}


