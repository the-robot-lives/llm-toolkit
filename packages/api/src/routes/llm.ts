import { Hono } from "hono";
import type { LlmService } from "../services/llm.ts";
import type { StorageService } from "../services/storage.ts";
import type { LlmCompletionRequest, LlmConfig, LlmProfile } from "@llm-toolkit/shared";
import { loadConfig, maskKey, isMaskedKey } from "./config.ts";

const LLM_ENV_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  zai: "ZAI_API_KEY",
  litellm: "LITELLM_API_KEY",
};

function resolveApiKey(config: LlmConfig, storage: StorageService): LlmConfig {
  if (config.apiKey && !isMaskedKey(config.apiKey)) return config;

  const resolved = { ...config };

  const envKey = LLM_ENV_KEYS[config.provider];
  if (envKey && process.env[envKey]) {
    resolved.apiKey = process.env[envKey];
    return resolved;
  }

  const raw = storage.getSetting("app_config");
  if (raw) {
    try {
      const stored = JSON.parse(raw) as { llm?: LlmConfig };
      if (stored.llm?.apiKey && !isMaskedKey(stored.llm.apiKey)) {
        resolved.apiKey = stored.llm.apiKey;
      }
    } catch {}
  }
  return resolved;
}

// <REMOVED UUID HERE> createLlmRoutes :: auto-generated pointer for public function createLlmRoutes
export function createLlmRoutes(llmService: LlmService, storage: StorageService): Hono {
  const routes = new Hono();

  routes.get("/status", (c) => {
    return c.json({
      data: {
        available: llmService.available,
        provider: llmService.providerName,
      },
    });
  });

  routes.get("/models", async (c) => {
    if (!llmService.available) {
      return c.json({ data: [] });
    }
    try {
      const models = await llmService.listModels();
      return c.json({ data: models });
    } catch {
      return c.json({ data: [] });
    }
  });

  routes.post("/models", async (c) => {
    const config = await c.req.json() as LlmConfig;
    if (!config?.provider) {
      return c.json({ data: [] });
    }
    const resolved = resolveApiKey(config, storage);
    const ephemeral = new (await import("../services/llm.ts")).LlmService();
    await ephemeral.initialize(resolved);
    if (!ephemeral.available) {
      return c.json({ data: [] });
    }
    try {
      const models = await ephemeral.listModels();
      return c.json({ data: models });
    } catch {
      return c.json({ data: [] });
    }
  });

  routes.get("/profiles", (c) => {
    const config = loadConfig(storage);
    const profiles = (config.llmProfiles ?? []).map((p) => ({ ...p, apiKey: maskKey(p.apiKey) }));
    return c.json({
      data: {
        profiles,
        defaultProfileId: config.defaultProfileId ?? "",
        defaultLocalProfileId: config.defaultLocalProfileId,
        indexing: config.indexing ?? { preferLocal: true, deepWindowDays: 14 },
      },
    });
  });

  routes.post("/test-profile", async (c) => {
    const body = await c.req.json() as { id?: string; profile?: LlmProfile };
    const config = loadConfig(storage);
    const draft = body?.profile;
    const stored = (config.llmProfiles ?? []).find((p) => p.id === (draft?.id ?? body?.id));
    const profile = draft ? { ...draft } : stored ? { ...stored } : undefined;
    const providers = ["anthropic", "alibaba", "openai-compatible", "ollama", "lmstudio", "llamacpp"];
    if (!profile || !providers.includes(profile.provider) || typeof profile.id !== "string" ||
        (profile.apiKey !== undefined && typeof profile.apiKey !== "string") ||
        (profile.baseUrl !== undefined && typeof profile.baseUrl !== "string") ||
        (profile.model !== undefined && typeof profile.model !== "string")) {
      return c.json({ ok: false, error: "A valid profile or saved profile id is required" }, 400);
    }
    if (isMaskedKey(profile.apiKey)) {
      // A masked key may only authorize the saved connection it represents.
      // Never forward an existing credential to a newly edited host/provider.
      if (!stored || stored.provider !== profile.provider || stored.baseUrl !== profile.baseUrl ||
          stored.apiType !== profile.apiType) {
        return c.json({ ok: false, error: "Re-enter the API key to test a changed connection." }, 400);
      }
      profile.apiKey = stored.apiKey;
    }
    const { profileToLlmConfig, LlmService } = await import("../services/llm.ts");
    const resolved = profileToLlmConfig(profile);
    if (!profile.local && !["ollama", "lmstudio", "llamacpp"].includes(profile.provider) && !resolved.apiKey) {
      return c.json({ ok: false, error: "Enter an API key or configure the provider environment variable." });
    }
    const ephemeral = new LlmService();
    await ephemeral.initialize(resolved);
    if (!ephemeral.available) {
      return c.json({ ok: false, error: "Check the provider, base URL, and API key." });
    }
    try {
      const models = await ephemeral.listModels(true);
      return c.json({ ok: true, models: [...new Set(models)].sort() });
    } catch (err) {
      // Upstream error bodies may contain credentials; return status only.
      const status = typeof err === "object" && err !== null && "status" in err ? Number(err.status) : undefined;
      return c.json({ ok: false, error: `Could not fetch models${status ? ` (HTTP ${status})` : ""}. Check the API key and base URL; this endpoint may not support model discovery.` });
    }
  });

  routes.post("/complete", async (c) => {
    if (!llmService.available) {
      return c.json({ error: "LLM service not available — configure a provider in settings", code: "LLM_UNAVAILABLE" }, 503);
    }

    const body = await c.req.json() as LlmCompletionRequest;

    if (!body.messages?.length) {
      return c.json({ error: "messages array is required", code: "INVALID_REQUEST" }, 400);
    }

    try {
      const result = await llmService.complete(body);
      return c.json({ data: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return c.json({ error: message, code: "LLM_ERROR" }, 500);
    }
  });

  return routes;
}
