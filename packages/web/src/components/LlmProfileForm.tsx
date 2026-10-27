import React, { useState, useEffect, useId, useRef } from "react";
import { testLlmProfile } from "../hooks/useApi.js";
import type { LlmProfile, LlmProfileProvider } from "../hooks/useApi.js";

const PROVIDERS: Array<{ value: LlmProfileProvider; label: string; local?: boolean }> = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "alibaba", label: "Alibaba Cloud (Model Studio)" },
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
  alibaba: "ALIBABA_API_KEY or DASHSCOPE_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
};

const MODEL_PLACEHOLDERS: Partial<Record<LlmProfileProvider, string>> = {
  anthropic: "claude-sonnet-4-20250514",
  alibaba: "qwen3.8-flash",
  "openai-compatible": "gpt-4o",
  ollama: "llama3",
  lmstudio: "local-model",
  llamacpp: "model-name",
};

const ALIBABA_ENDPOINTS = [
  { label: "Token Plan · Singapore", url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" },
  { label: "Token Plan · Beijing", url: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" },
  { label: "Coding Plan · International", url: "https://coding-intl.dashscope.aliyuncs.com/v1" },
  { label: "Coding Plan · China", url: "https://coding.dashscope.aliyuncs.com/v1" },
  { label: "Model Studio · Singapore", url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  { label: "Model Studio · Beijing", url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
];

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

  const formId = useId();
  const connection = JSON.stringify([profile.provider, profile.baseUrl, profile.apiType, profile.apiKey, profile.local]);
  const latestConnection = useRef(connection);
  latestConnection.current = connection;
  const requestId = useRef(0);
  useEffect(() => {
    requestId.current++;
    setTesting(false);
    setTestResult(null);
  }, [connection]);
  useEffect(() => () => { requestId.current++; }, []);

  const isLocal = profile.local || isLocalProvider(profile.provider);
  const needsKey = profile.provider === "anthropic" || profile.provider === "alibaba" || (profile.provider === "openai-compatible" && !profile.local);
  // baseUrl/apiType shown for custom (openai-compatible) providers; preset for local ones
  const showConnection = profile.provider === "alibaba" || profile.provider === "openai-compatible" || profile.provider === "ollama" || profile.provider === "lmstudio" || profile.provider === "llamacpp";

  const handleProviderChange = (provider: LlmProfileProvider) => {
    const preset = LOCAL_PRESETS[provider];
    const local = isLocalProvider(provider);
    onChange({
      provider,
      local,
      apiKey: undefined,
      baseUrl: preset ? preset.baseUrl : provider === "alibaba" ? ALIBABA_ENDPOINTS[0].url : provider === "anthropic" ? undefined : profile.provider === "alibaba" ? undefined : profile.baseUrl,
      apiType: provider === "openai-compatible" ? profile.apiType ?? "openai" : undefined,
    });
    setTestResult(null);
  };

  const handleTest = async () => {
    const currentRequest = ++requestId.current;
    const testedConnection = connection;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testLlmProfile(profile);
      if (requestId.current === currentRequest && latestConnection.current === testedConnection) setTestResult(res);
    } catch (err) {
      if (requestId.current === currentRequest && latestConnection.current === testedConnection) {
        setTestResult({ ok: false, error: err instanceof Error ? err.message : "Test request failed" });
      }
    }
    if (requestId.current === currentRequest) setTesting(false);
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
          {testing ? "Fetching..." : "Test & fetch models"}
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
          <label htmlFor={`${formId}-provider`} className="block text-xs text-text-muted mb-1">Provider</label>
          <select
            id={`${formId}-provider`}
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
          <label htmlFor={`${formId}-model`} className="block text-xs text-text-muted mb-1">Model</label>
          <input
            type="text"
            id={`${formId}-model`}
            list={`${formId}-models`}
            value={profile.model}
            onChange={(e) => onChange({ model: e.target.value })}
            placeholder={MODEL_PLACEHOLDERS[profile.provider] ?? "model-name"}
            className={`w-full ${inputCls}`}
          />
          <datalist id={`${formId}-models`}>
            {testResult?.models?.map((model) => <option key={model} value={model} />)}
          </datalist>
          <p className="mt-1 text-xs text-text-dim">
            {testResult?.models?.length ? "Choose a fetched model or enter a model ID." : "Fetch models to see available options, or enter a model ID."}
          </p>
        </div>
      </div>

      {profile.provider === "alibaba" && (
        <div>
          <label htmlFor={`${formId}-endpoint`} className="block text-xs text-text-muted mb-1">Alibaba endpoint preset</label>
          <select id={`${formId}-endpoint`} className={`w-full ${inputCls}`}
            value={ALIBABA_ENDPOINTS.some((endpoint) => endpoint.url === profile.baseUrl) ? profile.baseUrl : ""}
            onChange={(event) => { if (event.target.value) onChange({ baseUrl: event.target.value }); }}>
            <option value="">Custom endpoint</option>
            {ALIBABA_ENDPOINTS.map((endpoint) => <option key={endpoint.url} value={endpoint.url}>{endpoint.label}</option>)}
          </select>
          <p className="mt-1 text-xs text-text-dim">Use the endpoint for your key's region and plan. Token/Coding Plan keys differ from standard Model Studio keys.</p>
        </div>
      )}

      {showConnection && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor={`${formId}-url`} className="block text-xs text-text-muted mb-1">Base URL</label>
            <input
              type="text"
              id={`${formId}-url`}
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
          <label htmlFor={`${formId}-key`} className="block text-xs text-text-muted mb-1">API Key</label>
          <input
            id={`${formId}-key`}
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
              ? `Connected — ${testResult.models?.length ?? 0} models fetched${testResult.models?.length ? "." : "; enter a model ID manually."}`
              : testResult.error || "Test failed"}
          </p>
        </div>
      )}
      <p className="text-xs text-text-dim">
        Test and fetch models using these fields before saving. Testing does not save settings or run a completion.
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
