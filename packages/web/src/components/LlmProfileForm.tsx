import React, { useState } from "react";
import { testLlmProfile } from "../hooks/useApi.js";
import type { LlmProfile, LlmProfileProvider } from "../hooks/useApi.js";

const PROVIDERS: Array<{ value: LlmProfileProvider; label: string; local?: boolean }> = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "ollama", label: "Ollama", local: true },
  { value: "lmstudio", label: "LM Studio", local: true },
  { value: "llamacpp", label: "llama.cpp", local: true },
];

const LOCAL_PRESETS: Partial<Record<LlmProfileProvider, { baseUrl: string }>> = {
  ollama: { baseUrl: "http://localhost:11434" },
  lmstudio: { baseUrl: "http://localhost:1234/v1" },
  llamacpp: { baseUrl: "http://localhost:8080/v1" },
};

const ENV_KEY_NAMES: Partial<Record<LlmProfileProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
};

const MODEL_PLACEHOLDERS: Partial<Record<LlmProfileProvider, string>> = {
  anthropic: "claude-sonnet-4-20250514",
  "openai-compatible": "gpt-4o",
  ollama: "llama3",
  lmstudio: "local-model",
  llamacpp: "model-name",
};

const inputCls =
  "rounded bg-canvas px-3 py-1.5 text-sm text-text-primary placeholder:text-text-dim outline-none border border-border-subtle focus:border-glow";

export function isLocalProvider(provider: LlmProfileProvider): boolean {
  return !!PROVIDERS.find((p) => p.value === provider)?.local;
}

interface Props {
  profile: LlmProfile;
  onChange: (updates: Partial<LlmProfile>) => void;
  onDelete?: () => void;
}

// ⟦𓂀𓆣𓋴𓎛⟧ LlmProfileForm :: profile edit card
export function LlmProfileForm({ profile, onChange, onDelete }: Props) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; models?: string[]; error?: string } | null>(null);

  const isLocal = profile.local || isLocalProvider(profile.provider);
  const needsKey = profile.provider === "anthropic" || (profile.provider === "openai-compatible" && !profile.local);
  // baseUrl/apiType shown for custom (openai-compatible) providers; preset for local ones
  const showConnection = profile.provider === "openai-compatible" || profile.provider === "ollama" || profile.provider === "lmstudio" || profile.provider === "llamacpp";

  const handleProviderChange = (provider: LlmProfileProvider) => {
    const preset = LOCAL_PRESETS[provider];
    const local = isLocalProvider(provider);
    onChange({
      provider,
      local,
      baseUrl: preset ? preset.baseUrl : provider === "anthropic" ? undefined : profile.baseUrl,
      apiType: provider === "openai-compatible" ? profile.apiType ?? "openai" : undefined,
    });
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testLlmProfile(profile.id);
      setTestResult(res);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : "Test request failed" });
    }
    setTesting(false);
  };

  return (
    <div className="rounded-md border border-border-subtle bg-canvas p-4 space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={profile.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Profile name"
          className={`flex-1 font-medium ${inputCls}`}
        />
        <button
          onClick={handleTest}
          disabled={testing}
          className="rounded border border-border-subtle px-3 py-1 text-xs text-text-muted hover:text-text-primary hover:border-glow transition-colors disabled:opacity-50"
        >
          {testing ? "Testing..." : "Test"}
        </button>
        {onDelete && (
          <button
            onClick={onDelete}
            className="text-xs text-red-400 hover:text-red-300 transition-colors"
            title="Delete profile"
          >
            Delete
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-text-muted mb-1">Provider</label>
          <select
            value={profile.provider}
            onChange={(e) => handleProviderChange(e.target.value as LlmProfileProvider)}
            className={`w-full ${inputCls}`}
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Model</label>
          <input
            type="text"
            value={profile.model}
            onChange={(e) => onChange({ model: e.target.value })}
            placeholder={MODEL_PLACEHOLDERS[profile.provider] ?? "model-name"}
            className={`w-full ${inputCls}`}
          />
        </div>
      </div>

      {showConnection && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-text-muted mb-1">Base URL</label>
            <input
              type="text"
              value={profile.baseUrl ?? ""}
              onChange={(e) => onChange({ baseUrl: e.target.value || undefined })}
              placeholder={LOCAL_PRESETS[profile.provider]?.baseUrl ?? "https://api.example.com/v1"}
              className={`w-full ${inputCls}`}
            />
          </div>
          {profile.provider === "openai-compatible" && (
            <div>
              <label className="block text-xs text-text-muted mb-1">API Type</label>
              <select
                value={profile.apiType ?? "openai"}
                onChange={(e) => onChange({ apiType: e.target.value as "openai" | "anthropic" })}
                className={`w-full ${inputCls}`}
              >
                <option value="openai">OpenAI-compatible</option>
                <option value="anthropic">Anthropic-compatible</option>
              </select>
            </div>
          )}
        </div>
      )}

      {needsKey && (
        <div>
          <label className="block text-xs text-text-muted mb-1">API Key</label>
          <input
            type="password"
            value={profile.apiKey ?? ""}
            onChange={(e) => onChange({ apiKey: e.target.value || undefined })}
            placeholder="Enter API key (or set via environment variable)"
            className={`w-full ${inputCls}`}
          />
          {ENV_KEY_NAMES[profile.provider] && (
            <p className="mt-1 text-xs text-text-dim">
              Can also be set via {ENV_KEY_NAMES[profile.provider]} environment variable.
            </p>
          )}
        </div>
      )}

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={isLocal}
          disabled={isLocalProvider(profile.provider)}
          onChange={(e) => onChange({ local: e.target.checked })}
          className="accent-cyan-400"
        />
        <span className="text-xs text-text-muted">Local LLM (runs on this machine)</span>
      </label>

      {testResult && (
        <div
          className={`rounded px-3 py-2 border ${
            testResult.ok
              ? "bg-green-950/30 border-green-900/50"
              : "bg-red-950/30 border-red-900/50"
          }`}
        >
          <p className={`text-xs ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
            {testResult.ok
              ? `OK${testResult.models?.length ? ` — ${testResult.models.length} model${testResult.models.length !== 1 ? "s" : ""}: ${testResult.models.slice(0, 5).join(", ")}${testResult.models.length > 5 ? ", …" : ""}` : ""}`
              : testResult.error || "Test failed"}
          </p>
        </div>
      )}
      <p className="text-xs text-text-dim">
        Save settings first, then Test verifies the profile is reachable.
      </p>
    </div>
  );
}

export function emptyProfile(): LlmProfile {
  return {
    id: `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: "New Profile",
    provider: "anthropic",
    model: "",
    local: false,
  };
}
