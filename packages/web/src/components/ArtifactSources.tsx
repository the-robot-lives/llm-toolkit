import React, { useEffect, useState } from "react";
import { apiFetch } from "../hooks/useApi.js";

type Kind = "skills" | "agents" | "commands";
const kinds: Kind[] = ["skills", "agents", "commands"];
interface SourceState { configured: string[]; effective: string[]; defaults: string[]; warnings: string[]; catalogs?: { root: string; catalogFile: string | null }[] }
type Settings = Record<Kind, SourceState>;
interface Preview { root: string; catalogFile: string; token: string; yaml: string; entries: { name: string; path: string }[]; errors: string[] }
const inputClass = "min-w-0 flex-1 rounded border border-border-subtle bg-canvas px-2 py-1.5 font-mono text-xs";

export function ArtifactSources() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Record<Kind, string[]>>({ skills: [], agents: [], commands: [] });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const accept = (next: Settings) => {
    if (!next || kinds.some(kind => !next[kind] || ![next[kind].configured, next[kind].effective, next[kind].defaults, next[kind].warnings].every(Array.isArray))) throw new Error("Invalid source configuration response.");
    setSettings(next); setDraft(Object.fromEntries(kinds.map(kind => [kind, next[kind].configured])) as Record<Kind, string[]>); };
  useEffect(() => { apiFetch<{ data: Settings }>("/config/artifact-sources").then(({ data }) => accept(data)).catch(() => setError("Could not load artifact source folders.")); }, []);
  const dirty = !!settings && kinds.some(kind => JSON.stringify(draft[kind]) !== JSON.stringify(settings[kind].configured));
  const edit = (kind: Kind, paths: string[]) => { setDraft(current => ({ ...current, [kind]: paths })); setPreview(null); setNotice(""); };
  const add = (kind: Kind) => edit(kind, [...(draft[kind].length ? draft[kind] : settings?.[kind].effective ?? []), ""]);
  async function save() {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await apiFetch<{ data: Settings }>("/config/artifact-sources", { method: "PATCH", body: JSON.stringify(draft) });
      accept(result.data); window.dispatchEvent(new Event("artifact-sources-changed")); setPreview(null); setNotice("Source folders saved. Existing folders and installed links were not changed.");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save source folders."); }
    finally { setBusy(false); }
  }
  async function catalog(root: string, action: "preview" | "create") {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await apiFetch<{ data: Preview }>(`/skills/catalog/${action}`, { method: "POST", body: JSON.stringify({ root, ...(action === "create" ? { token: preview?.token } : {}) }) });
      if (action === "preview") setPreview(result.data);
      else {
        setPreview(null);
        const refreshed = await apiFetch<{ data: Settings }>("/config/artifact-sources"); accept(refreshed.data); window.dispatchEvent(new Event("artifact-sources-changed"));
        setNotice(`Created ${result.data.catalogFile}. Your existing files and installed links were unchanged.`);
      }
    } catch (error) { setError(error instanceof Error ? error.message : "Could not generate catalog."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Artifact source folders" className="space-y-4 rounded border border-border-subtle bg-surface p-5">
    <div><h2 className="text-base font-medium text-text-bright">Artifact source folders</h2><p className="mt-1 text-xs text-text-muted">Configure multiple sources separately for Skills, Agents and Commands. Earlier folders take precedence; duplicate names are reported on their catalog page. Removing a source never deletes its files or installed symlinks. Re-add it to manage its existing links again.</p></div>
    {!settings && !error && <p role="status">Loading source folders…</p>}
    {settings && kinds.map(kind => {
      const defaults = draft[kind].length === 0;
      const paths = defaults ? settings[kind].effective : draft[kind];
      return <fieldset key={kind} disabled={busy} className="space-y-2 rounded border border-border-subtle p-3">
        <legend className="px-1 text-sm font-medium capitalize">{kind}</legend>
        <p className="text-xs text-text-muted">{defaults ? "Using discovered defaults (shown below). Adding a folder keeps these sources and appends your new one." : "Custom source order. Leaving no custom folders explicitly returns to discovered defaults."}</p>
        {paths.length === 0 && <p className="text-xs text-text-dim">No default sources found.</p>}
        {paths.map((path, index) => <div key={index} className="flex items-center gap-2">
          <span className="text-xs text-text-dim">{index + 1}.</span>
          <input aria-label={`${kind} source ${index + 1}`} readOnly={defaults} value={path} className={inputClass} onChange={event => edit(kind, paths.map((item, at) => at === index ? event.target.value : item))} />
          {!defaults && <><button type="button" aria-label={`Move ${kind} source ${index + 1} up`} disabled={index === 0} onClick={() => { const next = [...paths]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; edit(kind, next); }} className="btn-action">↑</button><button type="button" aria-label={`Move ${kind} source ${index + 1} down`} disabled={index === paths.length - 1} onClick={() => { const next = [...paths]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; edit(kind, next); }} className="btn-action">↓</button><button type="button" aria-label={`Remove ${kind} source ${index + 1}`} onClick={() => edit(kind, paths.filter((_, at) => at !== index))} className="text-xs text-red-400">Remove</button></>}
        </div>)}
        <div className="flex gap-3 text-xs"><button type="button" onClick={() => add(kind)} className="btn-action">Add {kind} folder</button>{defaults && paths.length > 0 && <button type="button" onClick={() => edit(kind, [...paths])} className="btn-action">Customize {kind} sources</button>}{!defaults && <button type="button" onClick={() => edit(kind, [])} className="text-glow">Use {kind} defaults</button>}</div>
        {settings[kind].warnings.map(warning => <p key={warning} className="text-xs text-amber-300">{warning}</p>)}
        {kind === "skills" && <div className="space-y-2 pt-2"><p className="text-xs text-text-muted">Roots without a catalog still discover nested SKILL.md packages. Preview a new catalog before creating it; existing catalogs are never replaced. Save source changes first.</p>{(settings.skills.configured.length ? settings.skills.configured : settings.skills.effective).map(root => {
          const existing = settings.skills.catalogs?.find(item => item.root === root)?.catalogFile;
          return existing ? <p key={root} className="break-all text-xs text-text-dim">Existing catalog kept: {existing}</p> : <button key={root} type="button" disabled={dirty} onClick={() => void catalog(root, "preview")} className="block text-left text-xs text-glow">Preview catalog for {root}</button>;
        })}</div>}
      </fieldset>;
    })}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {notice && <p role="status" className="text-sm text-text-muted">{notice}</p>}
    {settings && <div className="flex items-center gap-3"><button type="button" disabled={busy || !dirty} onClick={() => void save()} className="btn-action-primary disabled:opacity-50">{busy ? "Working…" : "Save source folders"}</button><span className="text-xs text-text-dim">{dirty ? "Unsaved source changes" : "Sources are saved"}</span></div>}
    {preview && <section aria-label="Catalog preview" className="space-y-2 rounded border border-border-subtle p-3"><h3 className="font-medium">Catalog preview · {preview.entries.length} skills</h3><p className="break-all font-mono text-xs">{preview.catalogFile}</p>{preview.errors.map(message => <p key={message} role="alert" className="text-xs text-amber-300">{message}</p>)}<pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{preview.yaml}</pre><button type="button" disabled={busy || dirty || preview.errors.length > 0} onClick={() => void catalog(preview.root, "create")} className="btn-action-primary disabled:opacity-50">Create catalog.yaml</button><button type="button" onClick={() => setPreview(null)} className="ml-3 text-xs text-text-muted">Cancel</button></section>}
  </section>;
}
