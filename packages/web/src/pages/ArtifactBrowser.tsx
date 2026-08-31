import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiFetch } from "../hooks/useApi.js";
import { MarkdownView } from "../components/MarkdownView.js";

type SkillProvider = "claude" | "codex" | "grok" | "gemini" | "opencode";

export type ArtifactKind = "skills" | "agents" | "commands" | "mcp";

const PROVIDERS: { id: SkillProvider; title: string }[] = [
  { id: "claude", title: "Claude" },
  { id: "codex", title: "Codex" },
  { id: "grok", title: "Grok" },
  { id: "gemini", title: "Gemini" },
  { id: "opencode", title: "OpenCode" },
];

const KIND_META: Record<ArtifactKind, {
  title: string;
  singular: string;
  itemLabel: string;
  emptyHint: string;
  sourceHint: string;
}> = {
  skills: {
    title: "Skills",
    singular: "skill",
    itemLabel: "SKILL.md packages",
    emptyHint: "No skills match. Add a source folder with categories.yaml or SKILL.md packages.",
    sourceHint: "Trees that contain categories.yaml / categories.yml and SKILL.md packages.",
  },
  agents: {
    title: "Agents",
    singular: "agent",
    itemLabel: "agent definitions",
    emptyHint: "No agents match. Add a source folder of *.md agent files, or pin ~/.claude/agents.",
    sourceHint: "Folders of *.md agent definitions (Claude-style) to symlink into each provider’s agents directory.",
  },
  commands: {
    title: "Commands",
    singular: "command",
    itemLabel: "slash commands",
    emptyHint: "No commands match. Add a source folder of *.md slash commands, or pin ~/.claude/commands.",
    sourceHint: "Folders of *.md slash-command files to symlink into each provider’s commands directory.",
  },
  mcp: {
    title: "MCP",
    singular: "MCP server",
    itemLabel: "MCP servers",
    emptyHint: "No MCP servers match. Pin a folder of JSON definitions, or enable servers already present in a provider config.",
    sourceHint: "JSON/TOML MCP server definitions. Enable writes them into ~/.claude.json, config.toml, or project .mcp.json.",
  },
};

type InstallStatus = "enabled" | "disabled" | "foreign" | "real" | "broken";

interface SkillDestination {
  id: string;
  label: string;
  path: string;
  kind: "global" | "project";
  provider?: SkillProvider;
  projectRoot?: string;
  exists?: boolean;
}

interface SkillCategory {
  id: string;
  title: string;
  description?: string;
  skills: string[];
}

interface SkillInstall {
  destinationId: string;
  status: InstallStatus;
  linkPath: string;
  target?: string;
}

interface SkillRow {
  name: string;
  title?: string;
  description?: string;
  path: string;
  sourceRoot: string;
  categoryId: string;
  installs: SkillInstall[];
}

interface SkillsCatalog {
  sources: Array<{ path: string; categoriesFile?: string; skillCount: number }>;
  destinations: SkillDestination[];
  categories: SkillCategory[];
  skills: SkillRow[];
  items?: SkillRow[];
  discoveredFolders: string[];
  providers: SkillProvider[];
  globalEnabled: boolean;
  projectRoots: string[];
}

interface SkillDetail extends SkillRow {
  skillMarkdown: string;
  files: string[];
  previewKind?: "markdown" | "json";
}

interface SkillsConfig {
  sourceFolders: string[];
  providers?: SkillProvider[];
  globalEnabled?: boolean;
  projectRoots?: string[];
}

interface ProjectOption {
  projectPath: string;
  displayName?: string;
  title?: string | null;
}

const STATUS_COLOR: Record<InstallStatus, string> = {
  enabled: "text-emerald-400",
  disabled: "text-text-dim",
  foreign: "text-yellow-400",
  real: "text-orange-400",
  broken: "text-red-400",
};

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---")) return markdown;
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? markdown.slice(match[0].length).trim() : markdown;
}

function shortProject(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/") || path;
}

function installOf(skill: SkillRow, destId: string): SkillInstall | undefined {
  return skill.installs.find((item) => item.destinationId === destId);
}

export function ArtifactBrowser({ kind }: { kind: ArtifactKind }) {
  const meta = KIND_META[kind];
  const basePath = `/${kind}`;
  const apiPath = `/${kind}`;
  const navigate = useNavigate();
  const { name: selectedName } = useParams<{ name?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const categoryId = searchParams.get("cat") ?? "all";
  const statusFilter = (searchParams.get("status") as "all" | "enabled" | "disabled") || "all";

  const [catalog, setCatalog] = useState<SkillsCatalog | null>(null);
  const [config, setConfig] = useState<SkillsConfig | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<SkillDetail | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [newSource, setNewSource] = useState("");
  const [newProject, setNewProject] = useState("");

  const reload = useCallback(async () => {
    setError(null);
    const [catalogRes, configRes, projectRes] = await Promise.all([
      apiFetch<{ data: SkillsCatalog }>(apiPath),
      apiFetch<{ data: Record<string, SkillsConfig | undefined> }>("/config"),
      apiFetch<ProjectOption[]>("/projects").catch(() => [] as ProjectOption[]),
    ]);
    setCatalog(catalogRes.data);
    const stored = configRes.data[kind] ?? (kind === "skills" ? undefined : configRes.data.skills);
    setConfig(stored ?? {
      sourceFolders: [],
      providers: catalogRes.data.providers,
      globalEnabled: catalogRes.data.globalEnabled,
      projectRoots: catalogRes.data.projectRoots,
    });
    setProjects(Array.isArray(projectRes) ? projectRes : []);
  }, [apiPath, kind]);

  useEffect(() => {
    reload()
      .catch((err) => setError(err instanceof Error ? err.message : `Failed to load ${meta.title.toLowerCase()}`))
      .finally(() => setLoading(false));
  }, [reload]);

  useEffect(() => {
    if (!selectedName) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    apiFetch<{ data: SkillDetail }>(`${apiPath}/${encodeURIComponent(selectedName)}`)
      .then((res) => {
        if (!cancelled) setSelected(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : `Could not load ${meta.singular}`);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedName, apiPath, meta.singular]);

  const saveConfig = async (next: SkillsConfig) => {
    const res = await apiFetch<{ data: Record<string, SkillsConfig | undefined> }>("/config", {
      method: "PATCH",
      body: JSON.stringify({ [kind]: next }),
    });
    setConfig(res.data[kind] ?? next);
    await reload();
  };

  const providers = catalog?.providers?.length ? catalog.providers : config?.providers ?? ["claude"];
  const globalEnabled = catalog?.globalEnabled ?? config?.globalEnabled ?? true;
  const projectRoots = catalog?.projectRoots ?? config?.projectRoots ?? [];
  const destinations = catalog?.destinations ?? [];

  const patchTargets = async (patch: Partial<SkillsConfig>) => {
    if (!config) return;
    setBusy("targets");
    try {
      await saveConfig({
        sourceFolders: config.sourceFolders,
        providers,
        globalEnabled,
        projectRoots,
        ...patch,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update targets");
    }
    setBusy(null);
  };

  const toggleProvider = async (provider: SkillProvider) => {
    const next = providers.includes(provider)
      ? providers.filter((item) => item !== provider)
      : PROVIDERS.map((item) => item.id).filter((id) => providers.includes(id) || id === provider);
    if (next.length === 0) return;
    await patchTargets({ providers: next });
  };

  const addSource = async (path: string) => {
    if (!config || !path.trim()) return;
    const expanded = path.trim();
    if (config.sourceFolders.includes(expanded)) return;
    setBusy("source");
    try {
      await saveConfig({ ...config, sourceFolders: [...config.sourceFolders, expanded] });
      setNewSource("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add source folder");
    }
    setBusy(null);
  };

  const removeSource = async (path: string) => {
    if (!config) return;
    setBusy("source");
    try {
      await saveConfig({ ...config, sourceFolders: config.sourceFolders.filter((p) => p !== path) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove source folder");
    }
    setBusy(null);
  };

  const addProjectRoot = async (path: string) => {
    const root = path.trim();
    if (!root || projectRoots.includes(root)) return;
    await patchTargets({ projectRoots: [...projectRoots, root] });
    setNewProject("");
  };

  const removeProjectRoot = async (path: string) => {
    await patchTargets({ projectRoots: projectRoots.filter((p) => p !== path) });
  };

  const applyTargets = async (skill: SkillRow, destIds: string[], enabled: boolean) => {
    if (destIds.length === 0) return;
    const needingReplace = destIds.filter((id) => {
      const status = installOf(skill, id)?.status ?? "disabled";
      return status === "real" || status === "foreign" || status === "broken";
    });
    let replace = false;
    if (enabled && needingReplace.length > 0) {
      replace = window.confirm(
        `${skill.name} already exists in ${needingReplace.length} location(s). Backup and replace?`,
      );
      if (!replace) return;
    }
    const key = `${skill.name}:${destIds.join(",")}`;
    setBusy(key);
    setError(null);
    try {
      await apiFetch(`${apiPath}/apply`, {
        method: "POST",
        body: JSON.stringify({ name: skill.name, destinationIds: destIds, enabled, replace }),
      });
      await reload();
      if (selectedName === skill.name) {
        const detail = await apiFetch<{ data: SkillDetail }>(`${apiPath}/${encodeURIComponent(skill.name)}`);
        setSelected(detail.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `${meta.title} update failed`);
    }
    setBusy(null);
  };

  const destsForProvider = (provider: SkillProvider) =>
    destinations.filter((dest) => dest.provider === provider);

  const masterState = (skill: SkillRow): "on" | "off" | "mixed" => {
    if (destinations.length === 0) return "off";
    const enabled = destinations.filter((dest) => installOf(skill, dest.id)?.status === "enabled").length;
    if (enabled === 0) return "off";
    if (enabled === destinations.length) return "on";
    return "mixed";
  };

  const setCategory = (id: string) => {
    const next = new URLSearchParams(searchParams);
    if (id === "all") next.delete("cat");
    else next.set("cat", id);
    setSearchParams(next, { replace: true });
  };

  const setStatus = (value: "all" | "enabled" | "disabled") => {
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete("status");
    else next.set("status", value);
    setSearchParams(next, { replace: true });
  };

  const openSkill = (name: string) => {
    const qs = searchParams.toString();
    navigate(`${basePath}/${encodeURIComponent(name)}${qs ? `?${qs}` : ""}`);
  };

  const closeSkill = () => {
    const qs = searchParams.toString();
    navigate(`${basePath}${qs ? `?${qs}` : ""}`);
  };

  const query = filter.trim().toLowerCase();
  const skillsByName = useMemo(() => {
    const map = new Map<string, SkillRow>();
    for (const skill of catalog?.skills ?? []) map.set(skill.name, skill);
    return map;
  }, [catalog]);

  const visibleSkills = useMemo(() => {
    const names = categoryId === "all"
      ? (catalog?.skills ?? []).map((s) => s.name)
      : catalog?.categories.find((c) => c.id === categoryId)?.skills ?? [];
    return names
      .map((name) => skillsByName.get(name))
      .filter((skill): skill is SkillRow => {
        if (!skill) return false;
        if (query) {
          const hay = `${skill.name} ${skill.title ?? ""} ${skill.description ?? ""}`.toLowerCase();
          if (!hay.includes(query)) return false;
        }
        if (statusFilter === "all") return true;
        const enabled = skill.installs.some((install) => install.status === "enabled");
        return statusFilter === "enabled" ? enabled : !enabled;
      });
  }, [catalog, categoryId, query, skillsByName, statusFilter]);

  const enabledCount = (catalog?.skills ?? []).filter((skill) => masterState(skill) !== "off").length;

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, { total: number; enabled: number }>();
    for (const cat of catalog?.categories ?? []) {
      const rows = cat.skills.map((n) => skillsByName.get(n)).filter(Boolean) as SkillRow[];
      counts.set(cat.id, {
        total: rows.length,
        enabled: rows.filter((s) => s.installs.some((i) => i.status === "enabled")).length,
      });
    }
    return counts;
  }, [catalog, skillsByName]);

  const pinnedSources = config?.sourceFolders ?? [];
  const discoveredUnpinned = (catalog?.discoveredFolders ?? []).filter((path) => !pinnedSources.includes(path));
  const activeCategory = catalog?.categories.find((c) => c.id === categoryId);
  const projectOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { path: string; label: string }[] = [];
    for (const root of projectRoots) {
      seen.add(root);
      out.push({ path: root, label: shortProject(root) });
    }
    for (const project of projects) {
      if (seen.has(project.projectPath)) continue;
      seen.add(project.projectPath);
      out.push({
        path: project.projectPath,
        label: project.displayName || project.title || shortProject(project.projectPath),
      });
    }
    return out;
  }, [projectRoots, projects]);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium text-text-bright">{meta.title}</h1>
          <p className="mt-1 text-sm text-text-muted">
            Enable {meta.itemLabel} into each provider’s global folder and selected project folders.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-text-dim">
          <span>
            <span className="font-medium text-text-primary">{enabledCount}</span>
            {" / "}
            {(catalog?.skills ?? catalog?.items ?? []).length} on
          </span>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              reload().finally(() => setLoading(false));
            }}
            className="text-glow hover:underline"
          >
            Rescan
          </button>
          <button
            type="button"
            onClick={() => setShowSources((v) => !v)}
            className={`rounded-md border px-3 py-1.5 transition-colors ${
              showSources
                ? "border-glow bg-glow-bg text-text-bright"
                : "border-border-subtle text-text-muted hover:text-text-primary"
            }`}
          >
            Sources
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-3 rounded-md border border-border-subtle bg-canvas p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-text-dim">Providers</span>
          {PROVIDERS.map((provider) => {
            const on = providers.includes(provider.id);
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => toggleProvider(provider.id)}
                disabled={busy === "targets"}
                className={`rounded-md px-2.5 py-1 text-xs capitalize transition-colors ${
                  on ? "bg-glow text-void" : "border border-border-subtle text-text-muted hover:text-text-primary"
                }`}
              >
                {provider.title}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <button
              type="button"
              role="switch"
              aria-checked={globalEnabled}
              onClick={() => patchTargets({ globalEnabled: !globalEnabled })}
              disabled={busy === "targets"}
              className={`relative h-5 w-9 rounded-full transition-colors ${globalEnabled ? "bg-glow" : "bg-surface-active"}`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-void transition-all ${globalEnabled ? "left-4" : "left-0.5"}`} />
            </button>
            Global
          </label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowProjects((v) => !v)}
              className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-muted hover:text-text-primary"
            >
              Projects{projectRoots.length ? ` (${projectRoots.length})` : ""}
            </button>
            {showProjects && (
              <div className="absolute z-20 mt-1 w-80 rounded-md border border-border-subtle bg-void p-2 shadow-lg">
                <p className="mb-2 px-1 text-[10px] uppercase tracking-wider text-text-dim">
                  Write into each selected provider folder in these projects
                </p>
                <ul className="max-h-56 space-y-0.5 overflow-auto">
                  {projectOptions.map((option) => {
                    const on = projectRoots.includes(option.path);
                    return (
                      <li key={option.path}>
                        <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-surface/80">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => (on ? removeProjectRoot(option.path) : addProjectRoot(option.path))}
                            className="mt-0.5 accent-cyan-400"
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-xs text-text-primary">{option.label}</span>
                            <span className="block truncate font-mono text-[10px] text-text-dim">{option.path}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                  {projectOptions.length === 0 && (
                    <li className="px-1 py-1 text-[11px] italic text-text-dim">No indexed projects yet.</li>
                  )}
                </ul>
                <div className="mt-2 flex gap-2">
                  <input
                    type="text"
                    value={newProject}
                    onChange={(e) => setNewProject(e.target.value)}
                    placeholder="/path/to/project"
                    className="flex-1 rounded-md border border-border-subtle bg-canvas px-2 py-1 text-xs text-text-primary outline-none focus:border-glow"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addProjectRoot(newProject);
                    }}
                  />
                  <button type="button" onClick={() => addProjectRoot(newProject)} className="btn-action">
                    Add
                  </button>
                </div>
              </div>
            )}
          </div>
          <span className="font-mono text-[11px] text-text-dim">
            {destinations.length === 0
              ? "Select a provider and Global or a project"
              : destinations.map((d) => d.label).join(" · ")}
          </span>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-900/50 bg-red-950/30 px-3 py-2">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {showSources && (
        <SourcesPanel
          sourceHint={meta.sourceHint}
          pinnedSources={pinnedSources}
          discoveredUnpinned={discoveredUnpinned}
          newSource={newSource}
          busy={busy}
          onNewSource={setNewSource}
          onAddSource={addSource}
          onRemoveSource={removeSource}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name or description…"
          className="min-w-[16rem] flex-1 rounded-md border border-border-subtle bg-void px-3 py-1.5 text-sm text-text-primary placeholder:text-text-dim outline-none focus:border-glow"
        />
        {(["all", "enabled", "disabled"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setStatus(value)}
            className={`rounded-md px-3 py-1.5 text-xs capitalize transition-colors ${
              statusFilter === value
                ? "bg-glow text-void"
                : "border border-border-subtle text-text-muted hover:text-text-primary"
            }`}
          >
            {value}
          </button>
        ))}
      </div>

      <div className="flex min-h-[32rem] gap-5">
        <nav className="w-52 shrink-0" aria-label={`${meta.singular.charAt(0).toUpperCase()}${meta.singular.slice(1)} categories`}>
          <p className="mb-2 px-2 text-[10px] font-medium uppercase tracking-wider text-text-dim">Categories</p>
          <ul className="space-y-0.5">
            <li>
              <CategoryButton
                active={categoryId === "all"}
                title="All"
                total={catalog?.skills.length ?? 0}
                enabled={enabledCount}
                onClick={() => setCategory("all")}
              />
            </li>
            {(catalog?.categories ?? []).map((category) => {
              const counts = categoryCounts.get(category.id) ?? { total: 0, enabled: 0 };
              return (
                <li key={category.id}>
                  <CategoryButton
                    active={categoryId === category.id}
                    title={category.title}
                    total={counts.total}
                    enabled={counts.enabled}
                    onClick={() => setCategory(category.id)}
                  />
                </li>
              );
            })}
          </ul>
        </nav>

        <section className="min-w-0 flex-1">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-text-primary">
              {categoryId === "all" ? `All ${meta.title.toLowerCase()}` : activeCategory?.title ?? meta.title}
            </h2>
            <span className="text-xs text-text-dim">{visibleSkills.length}</span>
          </div>
          {activeCategory?.description && categoryId !== "all" && (
            <p className="mb-3 text-xs text-text-dim">{activeCategory.description}</p>
          )}

          {loading && !catalog ? (
            <p className="text-sm text-text-muted">Scanning {meta.title.toLowerCase()}…</p>
          ) : visibleSkills.length === 0 ? (
            <p className="text-sm text-text-muted">{meta.emptyHint}</p>
          ) : (
            <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle bg-canvas">
              {visibleSkills.map((skill) => {
                const active = selectedName === skill.name;
                const master = masterState(skill);
                return (
                  <li key={skill.name}>
                    <div
                      className={`flex items-start gap-3 px-3 py-2.5 transition-colors ${
                        active ? "bg-glow-bg" : "hover:bg-surface/80"
                      }`}
                    >
                      <button
                        type="button"
                        role="switch"
                        aria-checked={master === "mixed" ? "mixed" : master === "on"}
                        aria-label={`${master === "on" ? "Disable" : "Enable"} ${skill.name} for selected targets`}
                        disabled={destinations.length === 0 || busy?.startsWith(`${skill.name}:`)}
                        onClick={() => applyTargets(skill, destinations.map((d) => d.id), master !== "on")}
                        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
                          master === "on" ? "bg-glow" : master === "mixed" ? "bg-glow/50" : "bg-surface-active"
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 h-4 w-4 rounded-full bg-void transition-all ${
                            master === "off" ? "left-0.5" : "left-4"
                          }`}
                        />
                      </button>
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openSkill(skill.name)}>
                        <div className="flex items-baseline gap-2">
                          <span className="truncate text-sm font-medium text-text-bright">
                            {skill.title || skill.name}
                          </span>
                          <span className="truncate font-mono text-[11px] text-text-dim">{skill.name}</span>
                        </div>
                        {skill.description && (
                          <p className="mt-0.5 line-clamp-1 text-xs text-text-muted">{skill.description}</p>
                        )}
                      </button>
                      <div className="flex shrink-0 flex-wrap justify-end gap-1 pt-0.5">
                        {providers.map((provider) => {
                          const dests = destsForProvider(provider);
                          const enabled = dests.filter((d) => installOf(skill, d.id)?.status === "enabled").length;
                          const on = dests.length > 0 && enabled === dests.length;
                          const mixed = enabled > 0 && !on;
                          return (
                            <button
                              key={provider}
                              type="button"
                              title={`${provider}: ${enabled}/${dests.length || 0}`}
                              disabled={dests.length === 0}
                              onClick={() => applyTargets(skill, dests.map((d) => d.id), !on)}
                              className={`rounded px-1.5 py-0.5 text-[10px] capitalize ${
                                on
                                  ? "bg-glow/20 text-glow"
                                  : mixed
                                    ? "text-yellow-400"
                                    : "text-text-dim hover:text-text-muted"
                              }`}
                            >
                              {provider}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {selected && (
          <aside className="w-[22rem] shrink-0 rounded-md border border-border-subtle bg-canvas p-4">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-text-bright">{selected.title || selected.name}</h3>
                <p className="font-mono text-[11px] text-text-dim">{selected.name}</p>
              </div>
              <button type="button" onClick={closeSkill} className="text-xs text-text-dim hover:text-text-muted">
                Close
              </button>
            </div>
            {selected.description && (
              <p className="mb-3 text-xs leading-5 text-text-muted">{selected.description}</p>
            )}
            <div className="mb-3 space-y-1.5">
              {destinations.map((dest) => {
                const install = installOf(selected, dest.id);
                const status = install?.status ?? "disabled";
                const on = status === "enabled";
                return (
                  <button
                    key={dest.id}
                    type="button"
                    onClick={() => applyTargets(selected, [dest.id], !on)}
                    className="flex w-full items-center justify-between rounded-md border border-border-subtle px-2.5 py-1.5 text-left text-xs text-text-muted hover:text-text-primary"
                    title={dest.path}
                  >
                    <span className="truncate">{dest.label}</span>
                    <span className={STATUS_COLOR[status]}>{status}</span>
                  </button>
                );
              })}
              {destinations.length === 0 && (
                <p className="text-[11px] italic text-text-dim">Turn on Global or pick a project to choose destinations.</p>
              )}
            </div>
            <code className="mb-2 block break-all font-mono text-[10px] text-text-dim">{selected.path}</code>
            {selected.files.length > 0 && (
              <p className="mb-3 text-[11px] text-text-dim">{selected.files.join(" · ")}</p>
            )}
            {selected.skillMarkdown && (
              <div className="max-h-[28rem] overflow-auto rounded bg-void px-3 py-2 text-xs">
                {selected.previewKind === "json" || kind === "mcp" ? (
                  <pre className="whitespace-pre-wrap font-mono text-[11px] text-text-muted">{selected.skillMarkdown}</pre>
                ) : (
                  <MarkdownView content={stripFrontmatter(selected.skillMarkdown)} />
                )}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function CategoryButton({
  active,
  title,
  total,
  enabled,
  onClick,
}: {
  active: boolean;
  title: string;
  total: number;
  enabled: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
        active
          ? "bg-glow-bg text-text-bright"
          : "text-text-primary hover:bg-surface/80 hover:text-text-bright"
      }`}
    >
      <span className="truncate">{title}</span>
      <span className="ml-2 shrink-0 font-mono text-[10px] text-text-dim">
        {enabled > 0 ? `${enabled}/${total}` : total}
      </span>
    </button>
  );
}

function SourcesPanel({
  sourceHint,
  pinnedSources,
  discoveredUnpinned,
  newSource,
  busy,
  onNewSource,
  onAddSource,
  onRemoveSource,
}: {
  sourceHint: string;
  pinnedSources: string[];
  discoveredUnpinned: string[];
  newSource: string;
  busy: string | null;
  onNewSource: (value: string) => void;
  onAddSource: (path: string) => void;
  onRemoveSource: (path: string) => void;
}) {
  return (
    <div className="rounded-md border border-border-subtle bg-canvas p-4">
      <p className="mb-2 text-xs font-medium text-text-muted">Source folders</p>
      <p className="mb-2 text-[11px] text-text-dim">
        {sourceHint}
      </p>
      <div className="mb-2 space-y-1">
        {pinnedSources.map((path) => (
          <div key={path} className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-void px-2 py-1 font-mono text-[11px] text-text-muted" title={path}>
              {path}
            </code>
            <button type="button" onClick={() => onRemoveSource(path)} disabled={busy === "source"} className="text-[11px] text-red-400 hover:text-red-300">
              Remove
            </button>
          </div>
        ))}
        {pinnedSources.length === 0 && (
          <p className="text-[11px] italic text-text-dim">None pinned — using discovered folders.</p>
        )}
        {discoveredUnpinned.map((path) => (
          <div key={path} className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-void px-2 py-1 font-mono text-[11px] text-text-dim" title={path}>
              {path}
            </code>
            <button type="button" onClick={() => onAddSource(path)} disabled={busy === "source"} className="text-[11px] text-glow hover:underline">
              Pin
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={newSource}
          onChange={(e) => onNewSource(e.target.value)}
          placeholder="/path/to/source"
          className="flex-1 rounded-md border border-border-subtle bg-void px-2 py-1 text-xs text-text-primary outline-none focus:border-glow"
          onKeyDown={(e) => {
            if (e.key === "Enter") onAddSource(newSource);
          }}
        />
        <button type="button" onClick={() => onAddSource(newSource)} disabled={busy === "source"} className="btn-action">
          Add
        </button>
      </div>
    </div>
  );
}
