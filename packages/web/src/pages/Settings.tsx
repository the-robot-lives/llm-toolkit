import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { apiFetch, useIndexStatus, rebuildIndex } from "../hooks/useApi.js";
import type { LlmProfile, LlmIndexingConfig } from "../hooks/useApi.js";
import { LlmProfileForm, emptyProfile } from "../components/LlmProfileForm.js";

interface LlmConfig {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  apiType?: "openai" | "anthropic";
}

interface AppConfig {
  indexPaths: string[];
  embedding: { provider: string; model?: string; apiKey?: string };
  llm?: LlmConfig;
  llmProfiles?: LlmProfile[];
  defaultProfileId?: string;
  defaultLocalProfileId?: string;
  indexing?: LlmIndexingConfig;
  server: { port: number; host: string };
}

interface ScanProject {
  projectPath: string;
  encodedDir: string;
  fileCount: number;
  newOrChanged: number;
}

interface ScanPreview {
  watchPaths: string[];
  projects: ScanProject[];
  totalFiles: number;
  totalNewFiles: number;
  embeddingProvider: string;
  estimatedTokens: number;
  estimatedCost: number;
}

// ⟦𓏁𓋊𓁹𓏺⟧ Settings :: auto-generated pointer for public function Settings
export function Settings() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [scanPreview, setScanPreview] = useState<ScanPreview | null>(null);
  const [scanning, setScanning] = useState(false);
  const [excludedProjects, setExcludedProjects] = useState<Set<string>>(new Set());
  const [browsingPath, setBrowsingPath] = useState(false);
  const [dirEntries, setDirEntries] = useState<string[]>([]);
  const [browseBase, setBrowseBase] = useState("");
  const { data: idxData, refetch: refetchIndex } = useIndexStatus();
  const indexStatus = idxData?.data;

  useEffect(() => {
    const defaults: AppConfig = {
      indexPaths: [],
      embedding: { provider: "local", model: "all-MiniLM-L6-v2" },
      server: { port: 3100, host: "localhost" },
    };
    apiFetch<{ data: AppConfig }>("/config")
      .then((res) => {
        const cfg = res.data;
        // Normalize: ensure profiles/indexing exist (older configs may lack them)
        cfg.llmProfiles = cfg.llmProfiles ?? (cfg.llm ? [] : []);
        cfg.indexing = cfg.indexing ?? { preferLocal: true, deepWindowDays: 14 };
        if (!cfg.defaultProfileId && cfg.llmProfiles.length > 0) {
          cfg.defaultProfileId = cfg.llmProfiles[0].id;
        }
        setConfig(cfg);
        setLoading(false);
      })
      .catch(() => {
        setConfig(defaults);
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const res = await apiFetch<{ data: AppConfig }>("/config", {
        method: "PATCH",
        body: JSON.stringify(config),
      });
      setConfig(res.data);
    } catch {
      // Error handling would go here
    }
    setSaving(false);
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const res = await apiFetch<{ data: ScanPreview }>("/index/preview");
      setScanPreview(res.data);
    } catch {
      // Error handling
    }
    setScanning(false);
  };

  const handleReindex = async () => {
    setReindexing(true);
    try {
      await rebuildIndex({
        useLocalLlm: config?.indexing?.preferLocal ?? true,
        deepWindowDays: config?.indexing?.deepWindowDays ?? 14,
        force: false,
      });
      const pollInterval = setInterval(async () => {
        try {
          const res = await apiFetch<{ data: { status: string; progress?: { phase: string; current: number; total: number; currentFile?: string } } }>("/index/status");
          refetchIndex();
          if (res.data.status === "idle" && (!res.data.progress || res.data.progress.phase === "idle" || res.data.progress.phase === "done")) {
            clearInterval(pollInterval);
            setReindexing(false);
            setScanPreview(null);
          }
        } catch {
          clearInterval(pollInterval);
          setReindexing(false);
        }
      }, 1500);
    } catch {
      setReindexing(false);
    }
  };

  const toggleProjectExclude = (projectPath: string) => {
    setExcludedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectPath)) next.delete(projectPath); else next.add(projectPath);
      return next;
    });
  };

  const addPath = () => {
    if (!config || !newPath.trim()) return;
    setConfig({ ...config, indexPaths: [...config.indexPaths, newPath.trim()] });
    setNewPath("");
  };

  const removePath = (idx: number) => {
    if (!config) return;
    setConfig({ ...config, indexPaths: config.indexPaths.filter((_, i) => i !== idx) });
  };

  const updateEmbedding = (updates: Partial<AppConfig["embedding"]>) => {
    if (!config) return;
    setConfig({ ...config, embedding: { ...config.embedding, ...updates } });
  };

  const updateIndexing = (updates: Partial<LlmIndexingConfig>) => {
    if (!config) return;
    setConfig({ ...config, indexing: { preferLocal: true, deepWindowDays: 14, ...config.indexing, ...updates } });
  };

  const updateProfile = (id: string, updates: Partial<LlmProfile>) => {
    if (!config) return;
    setConfig({
      ...config,
      llmProfiles: (config.llmProfiles ?? []).map((p) => (p.id === id ? { ...p, ...updates } : p)),
    });
  };

  const addProfile = () => {
    if (!config) return;
    const profile = emptyProfile();
    setConfig({
      ...config,
      llmProfiles: [...(config.llmProfiles ?? []), profile],
      defaultProfileId: config.defaultProfileId ?? profile.id,
    });
  };

  const deleteProfile = (id: string) => {
    if (!config) return;
    const remaining = (config.llmProfiles ?? []).filter((p) => p.id !== id);
    const localRemaining = remaining.filter((p) => p.local);
    setConfig({
      ...config,
      llmProfiles: remaining,
      defaultProfileId:
        config.defaultProfileId === id
          ? remaining[0]?.id ?? ""
          : config.defaultProfileId,
      defaultLocalProfileId:
        config.defaultLocalProfileId === id
          ? localRemaining[0]?.id ?? ""
          : config.defaultLocalProfileId,
    });
  };

  if (loading) {
    return <div className="mx-auto max-w-3xl"><p className="text-sm text-text-muted">Loading...</p></div>;
  }

  const embeddingNeedsKey = config?.embedding.provider && config.embedding.provider !== "local";

  const profiles = config?.llmProfiles ?? [];
  const localProfiles = profiles.filter((p) => p.local);
  const indexing = config?.indexing ?? { preferLocal: true, deepWindowDays: 14 };

  const PHASE_LABELS: Record<string, string> = {
    scan: "Scanning files...",
    describe: "Describing conversations...",
    "work-items": "Extracting work items...",
    embed: "Embedding...",
    done: "Finishing up...",
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 text-xl font-medium text-text-bright">Settings</h1>
      <div className="space-y-6">
        {/* Index Configuration */}
        <section className="rounded-md border border-border-subtle bg-surface p-6 space-y-5">
          <div>
            <h2 className="text-base font-medium text-text-primary">Index &amp; Embeddings</h2>
            <p className="mt-1 text-xs text-text-dim">
              Scans watch paths for Claude Code JSONL conversation files, imports metadata into SQLite, and generates text embeddings for semantic search. Already-indexed conversations are skipped unless the file has changed. Tags, project metadata, and prompts are preserved across rebuilds.
            </p>
          </div>

          {/* Current status */}
          <div className="rounded-md bg-canvas px-4 py-3 space-y-2">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${indexStatus?.status === "indexing" ? "bg-yellow-400 animate-pulse" : "bg-green-400"}`} />
                <span className="text-xs text-text-primary font-medium">
                  {indexStatus?.status === "indexing" ? "Indexing..." : "Idle"}
                </span>
              </div>
              <span className="text-xs text-text-dim">
                {indexStatus?.conversationCount ?? 0} conversations indexed
              </span>
              {indexStatus?.lastIndexed && (
                <span className="text-xs text-text-dim">
                  Last: {new Date(indexStatus.lastIndexed).toLocaleString()}
                </span>
              )}
            </div>

            {/* Progress bar during indexing */}
            {reindexing && indexStatus?.progress && indexStatus.progress.phase !== "idle" && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-text-dim">
                  <span>
                    {PHASE_LABELS[indexStatus.progress.phase]
                      ?? (indexStatus.progress.phase === "scanning" ? "Scanning files..." : `Indexing ${indexStatus.progress.current} / ${indexStatus.progress.total}`)}
                    {indexStatus.progress.llm ? ` (${indexStatus.progress.llm})` : ""}
                  </span>
                  {indexStatus.progress.currentFile && (
                    <span className="truncate max-w-xs font-mono text-text-dim">{indexStatus.progress.currentFile}</span>
                  )}
                </div>
                <div className="h-1.5 w-full rounded-full bg-surface-active overflow-hidden">
                  <div
                    className="h-full rounded-full bg-glow transition-all duration-300"
                    style={{ width: indexStatus.progress.total > 0 ? `${(indexStatus.progress.current / indexStatus.progress.total) * 100}%` : "0%" }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Indexing LLM preferences */}
          <div className="space-y-3 rounded-md bg-canvas px-4 py-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={indexing.preferLocal}
                onChange={(e) => updateIndexing({ preferLocal: e.target.checked })}
                className="accent-cyan-400 shrink-0"
              />
              <span className="text-xs text-text-primary">Prefer local LLM for indexing / feature extraction</span>
            </label>
            <div className="flex items-center gap-2">
              <label className="text-xs text-text-muted shrink-0">Deep analysis window (days)</label>
              <input
                type="number"
                min={1}
                value={indexing.deepWindowDays}
                onChange={(e) => updateIndexing({ deepWindowDays: Math.max(1, Number(e.target.value) || 1) })}
                className="w-20 rounded bg-void px-2 py-1 text-xs text-text-primary outline-none border border-border-subtle focus:border-glow"
              />
              <span className="text-xs text-text-dim">Recent conversations within this window get deeper LLM analysis.</span>
            </div>
          </div>

          {/* Watch paths */}
          <div>
            <label className="block text-xs text-text-muted mb-2 font-medium">Watch Paths</label>
            <div className="space-y-1.5 mb-3">
              {config?.indexPaths.map((path, i) => (
                <div key={i} className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-canvas px-3 py-1.5 text-xs text-text-muted font-mono">{path}</code>
                  <button onClick={() => removePath(i)} className="text-xs text-red-400 hover:text-red-300 transition-colors">Remove</button>
                </div>
              ))}
              {(!config?.indexPaths || config.indexPaths.length === 0) && (
                <p className="text-xs text-text-dim italic">No watch paths configured. Add ~/.claude/projects to get started.</p>
              )}
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="~/.claude/projects or /path/to/conversations"
                className="flex-1 rounded bg-canvas px-3 py-1.5 text-sm text-text-primary placeholder:text-text-dim outline-none border border-border-subtle focus:border-glow"
                onKeyDown={(e) => { if (e.key === "Enter") addPath(); }}
              />
              <button onClick={addPath} className="rounded bg-surface-active px-3 py-1 text-xs text-text-muted hover:text-text-primary transition-colors">
                Add
              </button>
            </div>
          </div>

          {/* Scan + Rebuild */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <button
                onClick={handleScan}
                disabled={scanning || reindexing}
                className="rounded border border-border-subtle px-4 py-1.5 text-sm text-text-muted hover:text-text-primary hover:border-glow transition-colors disabled:opacity-50"
              >
                {scanning ? "Scanning..." : "Preview Scan"}
              </button>
              <button
                onClick={handleReindex}
                disabled={reindexing || scanning}
                className="rounded bg-glow px-4 py-1.5 text-sm font-medium text-void hover:bg-glow/90 disabled:opacity-50"
              >
                {reindexing ? "Rebuilding..." : "Rebuild Index"}
              </button>
            </div>

            {/* Scan preview results */}
            {scanPreview && (
              <div className="rounded-md border border-border-subtle bg-canvas p-4 space-y-4">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-medium text-text-primary">Scan Preview</h3>
                  <button onClick={() => setScanPreview(null)} className="text-xs text-text-dim hover:text-text-muted">Dismiss</button>
                </div>

                {/* Summary stats */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded bg-surface-raised p-2.5 text-center">
                    <p className="font-mono text-lg text-white">{scanPreview.totalFiles}</p>
                    <p className="text-xs text-text-dim">Total Files</p>
                  </div>
                  <div className="rounded bg-surface-raised p-2.5 text-center">
                    <p className="font-mono text-lg text-glow">{scanPreview.totalNewFiles}</p>
                    <p className="text-xs text-text-dim">New / Changed</p>
                  </div>
                  <div className="rounded bg-surface-raised p-2.5 text-center">
                    <p className="font-mono text-lg text-white">
                      {scanPreview.embeddingProvider === "local" ? "Free" : `~$${scanPreview.estimatedCost.toFixed(4)}`}
                    </p>
                    <p className="text-xs text-text-dim">
                      Est. Cost ({scanPreview.embeddingProvider})
                    </p>
                  </div>
                </div>

                {scanPreview.totalNewFiles > 0 && (
                  <p className="text-xs text-text-dim">
                    ~{scanPreview.estimatedTokens.toLocaleString()} tokens across {scanPreview.totalNewFiles} conversations will be embedded.
                    {scanPreview.totalFiles - scanPreview.totalNewFiles > 0 && (
                      <> {scanPreview.totalFiles - scanPreview.totalNewFiles} already indexed (skipped).</>
                    )}
                  </p>
                )}

                {/* Project list with checkboxes */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs text-text-muted font-medium">Projects ({scanPreview.projects.length})</label>
                    <div className="flex gap-2">
                      <button onClick={() => setExcludedProjects(new Set())} className="text-xs text-glow hover:underline">Include All</button>
                      <button onClick={() => setExcludedProjects(new Set(scanPreview.projects.map((p) => p.projectPath)))} className="text-xs text-text-dim hover:text-text-muted">Exclude All</button>
                    </div>
                  </div>
                  <div className="max-h-60 overflow-y-auto space-y-1 rounded border border-border-subtle bg-void p-2">
                    {scanPreview.projects.map((proj) => {
                      const excluded = excludedProjects.has(proj.projectPath);
                      const shortPath = proj.projectPath.split("/").slice(-3).join("/");
                      return (
                        <label
                          key={proj.projectPath}
                          className={`flex items-center gap-2 rounded px-2 py-1.5 cursor-pointer transition-colors ${excluded ? "opacity-40" : "hover:bg-surface-active"}`}
                        >
                          <input
                            type="checkbox"
                            checked={!excluded}
                            onChange={() => toggleProjectExclude(proj.projectPath)}
                            className="accent-cyan-400 shrink-0"
                          />
                          <span className="flex-1 text-xs text-text-primary font-mono truncate" title={proj.projectPath}>{shortPath}</span>
                          <span className="text-xs text-text-dim shrink-0">{proj.fileCount} files</span>
                          {proj.newOrChanged > 0 && (
                            <span className="text-xs text-glow shrink-0">{proj.newOrChanged} new</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                  {excludedProjects.size > 0 && (
                    <p className="mt-1 text-xs text-yellow-400">
                      {excludedProjects.size} project{excludedProjects.size !== 1 ? "s" : ""} excluded — these will be skipped during rebuild.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Embedding Provider */}
        <section className="rounded-md border border-border-subtle bg-surface p-6">
          <h2 className="mb-4 text-base font-medium text-text-primary">Embedding Provider</h2>
          <select
            value={config?.embedding.provider ?? "local"}
            onChange={(e) => updateEmbedding({ provider: e.target.value })}
            className="rounded bg-canvas px-3 py-1.5 text-sm text-text-primary border border-border-subtle outline-none"
          >
            <option value="local">Local (Transformers.js)</option>
            <option value="openai">OpenAI</option>
            <option value="voyage">Voyage</option>
            <option value="anthropic">Anthropic</option>
          </select>
          <p className="mt-2 text-xs text-text-dim">
            Local embeddings use all-MiniLM-L6-v2 (~25MB, runs on CPU). No API key required.
          </p>

          {embeddingNeedsKey && (
            <div className="mt-4">
              <label className="block text-xs text-text-muted mb-1">API Key</label>
              <input
                type="password"
                value={config?.embedding.apiKey ?? ""}
                onChange={(e) => updateEmbedding({ apiKey: e.target.value })}
                placeholder="Enter API key (or set via environment variable)"
                className="w-full rounded bg-canvas px-3 py-1.5 text-sm text-text-primary placeholder:text-text-dim outline-none border border-border-subtle"
              />
              <p className="mt-1 text-xs text-text-dim">
                Can also be set via ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable.
              </p>
            </div>
          )}
        </section>

        {/* LLM Profiles */}
        <section className="rounded-md border border-border-subtle bg-surface p-6 space-y-4">
          <div>
            <h2 className="text-base font-medium text-text-primary">LLM Profiles</h2>
            <p className="mt-1 text-xs text-text-dim">
              Configure one or more LLM providers. Cloud profiles need an API key; LM Studio, Ollama, and llama.cpp run locally with no key required.
            </p>
          </div>

          <div className="space-y-4">
            {profiles.map((profile) => (
              <LlmProfileForm
                key={profile.id}
                profile={profile}
                onChange={(updates) => updateProfile(profile.id, updates)}
                onDelete={() => deleteProfile(profile.id)}
              />
            ))}
            {profiles.length === 0 && (
              <p className="text-xs text-text-dim italic">No profiles configured. Add one to enable LLM features.</p>
            )}
          </div>

          <button
            onClick={addProfile}
            className="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-muted hover:text-text-primary hover:border-glow transition-colors"
          >
            + Add Profile
          </button>

          {/* Defaults */}
          <div className="grid grid-cols-2 gap-4 border-t border-border-subtle pt-4">
            <div>
              <label className="block text-xs text-text-muted mb-1">Default LLM</label>
              <select
                value={config?.defaultProfileId ?? ""}
                onChange={(e) => setConfig(config ? { ...config, defaultProfileId: e.target.value } : config)}
                className="w-full rounded bg-canvas px-3 py-1.5 text-sm text-text-primary border border-border-subtle outline-none"
              >
                <option value="">None</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Default local LLM</label>
              <select
                value={config?.defaultLocalProfileId ?? ""}
                onChange={(e) => setConfig(config ? { ...config, defaultLocalProfileId: e.target.value || undefined } : config)}
                className="w-full rounded bg-canvas px-3 py-1.5 text-sm text-text-primary border border-border-subtle outline-none"
              >
                <option value="">None</option>
                {localProfiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Local LLM setup help */}
          <details className="rounded-md border border-border-subtle bg-canvas p-4">
            <summary className="cursor-pointer text-xs font-medium text-text-muted">Local LLM setup</summary>
            <div className="mt-3 space-y-3 text-xs text-text-dim">
              <div>
                <p className="font-medium text-text-muted">LM Studio</p>
                <p>
                  Start the local server: Developer tab → Start Server (port 1234). Enable CORS and serve on
                  <code className="mx-1 rounded bg-void px-1 py-0.5 font-mono text-text-muted">localhost:1234/v1</code>.
                </p>
              </div>
              <div>
                <p className="font-medium text-text-muted">llama.cpp</p>
                <p>
                  Run <code className="rounded bg-void px-1 py-0.5 font-mono text-text-muted">llama-server -m &lt;model&gt; --port 8080</code> —
                  an OpenAI-compatible endpoint at <code className="rounded bg-void px-1 py-0.5 font-mono text-text-muted">localhost:8080/v1</code>.
                </p>
              </div>
              <div>
                <p className="font-medium text-text-muted">Ollama</p>
                <p>
                  Install and <code className="rounded bg-void px-1 py-0.5 font-mono text-text-muted">ollama serve</code> (default
                  <code className="mx-1 rounded bg-void px-1 py-0.5 font-mono text-text-muted">localhost:11434</code>). Pull a model with
                  <code className="ml-1 rounded bg-void px-1 py-0.5 font-mono text-text-muted">ollama pull llama3</code>.
                </p>
              </div>
            </div>
          </details>
        </section>

        <p className="text-xs text-text-dim">
          Skill, agent, command, and MCP catalogs live on{" "}
          <Link to="/skills" className="text-glow hover:underline">Skills</Link>
          {", "}
          <Link to="/agents" className="text-glow hover:underline">Agents</Link>
          {", "}
          <Link to="/commands" className="text-glow hover:underline">Commands</Link>
          {", and "}
          <Link to="/mcp" className="text-glow hover:underline">MCP</Link>
          .
        </p>

        {/* Save */}
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded bg-glow px-6 py-2 text-sm font-medium text-void hover:bg-glow/90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}
