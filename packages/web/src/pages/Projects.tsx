import { ToborConnection } from "../components/ToborConnection.js";
import type { ProjectEntry, ToborProject } from "@llm-toolkit/shared";
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../hooks/useApi.js";



function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function shortProject(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/") || path;
}

function TagList({
  tags,
  onAdd,
  onRemove,
}: {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && !tags.includes(trimmed)) onAdd(trimmed);
    setDraft("");
    setAdding(false);
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" onClick={event => event.stopPropagation()}>
      {tags.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 rounded bg-surface-subtle px-1.5 py-0.5 text-xs text-text-muted"
        >
          {tag}
          <button
            onClick={() => onRemove(tag)}
            className="leading-none text-text-muted hover:text-red-400"
            title="Remove tag"
          >
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setDraft(""); setAdding(false); }
          }}
          className="w-20 rounded border border-border-subtle bg-surface-raised px-1 py-0.5 text-xs text-text-primary outline-none focus:border-glow"
          placeholder="tag…"
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="rounded border border-dashed border-border-subtle px-1.5 py-0.5 text-xs text-text-muted hover:border-glow hover:text-glow"
        >
          + tag
        </button>
      )}
    </div>
  );
}

function InlineEdit({
  value,
  placeholder,
  onSave,
  className,
}: {
  value: string | null;
  placeholder: string;
  onSave: (val: string | null) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commit() {
    const trimmed = draft.trim();
    onSave(trimmed.length > 0 ? trimmed : null);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setDraft(value ?? ""); setEditing(false); }
        }}
        className={`w-full rounded border border-border-subtle bg-surface-raised px-1 py-0.5 outline-none focus:border-glow ${className ?? ""}`}
      />
    );
  }

  return (
    <span
      onClick={(event) => { event.stopPropagation(); setDraft(value ?? ""); setEditing(true); }}
      className={`cursor-text ${!value ? "text-text-muted italic" : ""} ${className ?? ""}`}
      title="Click to edit"
    >
      {value ?? placeholder}
    </span>
  );
}

// <REMOVED UUID HERE> Projects :: auto-generated pointer for public function Projects
export function Projects() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [remoteProjects, setRemoteProjects] = useState<ToborProject[]>([]);
  const [linkRepository, setLinkRepository] = useState("");
  const [linkProject, setLinkProject] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMessage, setLinkMessage] = useState("");
  const repositoryRoots = [...new Set(projects.flatMap(project => project.locations.map(location => location.canonicalRoot ?? location.repositoryRoot).filter((root): root is string => !!root)))].sort();
  async function link() {
    setLinkBusy(true); setLinkMessage("");
    try {
      await apiFetch("/tobor/link", { method: "POST", body: JSON.stringify({ repositoryPath: linkRepository, projectId: linkProject }) });
      setProjects(await apiFetch<ProjectEntry[]>("/projects"));
      setLinkMessage("Repository linked. Its worktrees inherit this project unless explicitly overridden.");
    } catch (err) { setLinkMessage(err instanceof Error ? err.message : "Could not link repository."); }
    finally { setLinkBusy(false); }
  }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<ProjectEntry[]>("/projects")
      .then((data) => {
        setProjects(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  async function patchProject(projectPath: string, updates: { title?: string | null; description?: string | null; tags?: string[] }) {
    const encoded = encodeURIComponent(projectPath);
    await apiFetch(`/projects/${encoded}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    setProjects((prev) =>
      prev.map((p) =>
        p.projectPath === projectPath ? { ...p, ...updates } : p,
      ),
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-text-muted text-sm">
        Loading projects…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-white">Projects</h1>
          <span className="text-sm text-text-muted">{projects.length} projects</span>
        </div>
        <p className="mt-1 text-sm text-text-muted">Repositories and worktrees grouped by their organization and project scope. Related sites and libraries share a project. Unscoped directories remain separate.</p>
      </div>

      <ToborConnection onProjects={setRemoteProjects} />
      {!!remoteProjects.length && !!repositoryRoots.length && <section aria-label="Link repository to Tobor" className="rounded-md border border-border-subtle p-4 space-y-3"><h2 className="text-sm font-medium">Link a repository to a Tobor project</h2><p className="text-sm text-text-muted">Set the project shared by a repository and its worktrees. Related sites and libraries can use the same project.</p><label className="block text-xs text-text-muted">Repository<select aria-label="Repository to link" className="block w-full bg-void border border-border-subtle rounded p-2 mt-1" value={linkRepository} onChange={event => setLinkRepository(event.target.value)}><option value="">Choose repository…</option>{repositoryRoots.map(root => <option key={root} value={root}>{root}</option>)}</select></label><label className="block text-xs text-text-muted">Tobor project<select aria-label="Tobor project to link" className="block w-full bg-void border border-border-subtle rounded p-2 mt-1" value={linkProject} onChange={event => setLinkProject(event.target.value)}><option value="">Choose project…</option>{remoteProjects.map(project => <option key={project.id} value={project.id}>{project.organizationSlug} / {project.name}</option>)}</select></label><button className="btn-action" disabled={linkBusy || !linkRepository || !linkProject} onClick={link}>{linkBusy ? "Linking…" : "Link repository"}</button>{linkMessage && <p role="status" className="text-sm text-text-muted">{linkMessage}</p>}</section>}

      {projects.length === 0 ? (
        <p className="text-sm text-text-muted">No projects found.</p>
      ) : (
        <div className="space-y-2">
          {projects.map((proj) => (
            <div
              key={proj.projectPath}
              className="rounded-md border border-border-subtle bg-surface-raised px-4 py-3 cursor-pointer hover:border-glow/30 transition-colors"
              role="button"
              tabIndex={0}
              onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); navigate(`/projects/${encodeURIComponent(proj.projectPath)}`); } }}
              onClick={() => navigate(`/projects/${encodeURIComponent(proj.projectPath)}`)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-sm font-medium text-text-primary">
                    <InlineEdit
                      value={proj.title}
                      placeholder={proj.displayName ?? shortProject(proj.projectPath)}
                      onSave={(val) => patchProject(proj.projectPath, { title: val })}
                      className="text-sm font-medium text-text-primary"
                    />
                  </div>
                  <p className="truncate font-mono text-xs text-text-muted" title={proj.projectPath}>
                    {proj.scope ? `${proj.scope.organization} / ${proj.scope.project}` : proj.projectPath}
                  </p>
                  {proj.scope && (() => {
                    const remote = remoteProjects.find(item => item.organizationSlug === proj.scope!.organization && item.slug === proj.scope!.project);
                    return remote ? <a href={`https://agentonomi.com/app/${encodeURIComponent(remote.organizationSlug)}/projects/${encodeURIComponent(remote.id)}`} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()} className="text-xs text-glow underline">Open Tobor project · {remote.name}</a> : <p className="text-xs text-text-muted">{remoteProjects.length ? "No matching project in connected Tobor account" : "Connect to Tobor to verify remote project"}</p>;
                  })()}
                  <p className="text-xs text-text-muted">{proj.locations.length} location{proj.locations.length === 1 ? "" : "s"} · {proj.locations.filter(location => location.isWorktree).length} worktrees</p>
                  <div className="text-xs text-text-muted">
                    <InlineEdit
                      value={proj.description}
                      placeholder="Add description…"
                      onSave={(val) => patchProject(proj.projectPath, { description: val })}
                      className="text-xs text-text-muted"
                    />
                  </div>
                  <TagList
                    tags={proj.tags}
                    onAdd={(tag) => patchProject(proj.projectPath, { tags: [...proj.tags, tag] })}
                    onRemove={(tag) => patchProject(proj.projectPath, { tags: proj.tags.filter((t) => t !== tag) })}
                  />
                </div>
                <div className="ml-4 flex shrink-0 flex-col items-end gap-2">
                  <span className="text-sm text-text-muted">
                    {proj.conversationCount} conversation{proj.conversationCount !== 1 ? "s" : ""}
                  </span>
                  <span className="text-xs text-text-muted">
                    Last active {formatDate(proj.lastActive)}
                  </span>
                  <button
                    onClick={(event) => { event.stopPropagation(); navigate(`/browse?project=${encodeURIComponent(proj.projectPath)}`); }}
                    className="rounded border border-border-subtle px-2.5 py-1 text-xs text-text-muted transition-colors hover:border-glow hover:text-glow"
                  >
                    Browse
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {remoteProjects.some(remote => !projects.some(local => local.scope?.organization === remote.organizationSlug && local.scope?.project === remote.slug)) && <section className="space-y-2"><h2 className="text-sm font-medium text-text-primary">Other Tobor projects</h2><p className="text-xs text-text-muted">No scoped local repositories discovered for these projects.</p>{remoteProjects.filter(remote => !projects.some(local => local.scope?.organization === remote.organizationSlug && local.scope?.project === remote.slug)).map(remote => <a key={remote.id} href={`https://agentonomi.com/app/${encodeURIComponent(remote.organizationSlug)}/projects/${encodeURIComponent(remote.id)}`} target="_blank" rel="noopener noreferrer" className="block text-sm text-glow underline">{remote.organizationSlug} / {remote.name}</a>)}</section>}
    </div>
  );
}
