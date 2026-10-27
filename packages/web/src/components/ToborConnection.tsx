import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ToborProject } from "@llm-toolkit/shared";
import { apiFetch } from "../hooks/useApi.js";
interface Status { connected: boolean; loginPending: boolean; connectionId?: string | null; projectAccess?: "unknown" | "available" | "disabled"; permissionsUrl?: string | null }
interface Organization { id: string; slug: string; name: string }

export function ToborConnection({ onProjects }: { onProjects?: (projects: ToborProject[]) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organization, setOrganization] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const projectRequest = useRef(0);
  const refresh = useCallback(async () => {
    const next = await apiFetch<Status>("/tobor/status");
    setStatus(next);
    if (next.connected && !next.loginPending) setUrl("");
  }, []);
  const load = useCallback(async () => {
    const request = ++projectRequest.current;
    setCount(null); onProjects?.([]);
    if (!organization) return;
    try {
      const result = await apiFetch<{ data: ToborProject[] }>(`/tobor/projects?organization=${encodeURIComponent(organization)}`);
      if (request !== projectRequest.current) return;
      setCount(result.data.length); onProjects?.(result.data);
      await refresh();
    } catch (err) {
      if (request !== projectRequest.current) return;
      setError(err instanceof Error ? err.message : "Could not load projects.");
      await refresh().catch(() => {});
    }
  }, [organization, onProjects, refresh]);
  useEffect(() => { refresh().catch(() => setError("Tobor connection status is unavailable.")); }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    ++projectRequest.current; onProjects?.([]); setCount(null); setOrganization(""); setOrganizations([]);
    if (status?.connected) {
      apiFetch<{ data: Organization[] }>("/tobor/organizations").then(result => {
        if (!cancelled) setOrganizations(result.data);
      }).catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : "Could not load organizations."); });
    }
    return () => { cancelled = true; };
  }, [status?.connected, status?.connectionId, onProjects]);
  useEffect(() => {
    setError("");
    if (status?.connected) void load();
    return () => { ++projectRequest.current; };
  }, [organization, status?.connected, status?.connectionId, load]);
  useEffect(() => {
    if (!url) return;
    const timer = setInterval(() => { refresh().catch(() => {}); }, 2000);
    const timeout = setTimeout(() => { clearInterval(timer); setUrl(""); setError("Login expired. Connect again."); }, 600_000);
    return () => { clearInterval(timer); clearTimeout(timeout); };
  }, [url, refresh]);
  async function act(action: "connect" | "refresh" | "disconnect") {
    setBusy(true); setError("");
    try {
      if (action === "connect") {
        const response = await apiFetch<{ authorizationUrl: string }>("/tobor/oauth/start", { method: "POST", body: "{}" });
        if (new URL(response.authorizationUrl).origin !== "https://agentonomi.com") throw new Error("Unexpected login service");
        setUrl(response.authorizationUrl);
      } else if (action === "disconnect") {
        await apiFetch("/tobor/disconnect", { method: "POST", body: "{}" }); setUrl(""); await refresh();
      } else await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Tobor connection failed."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Tobor project connection" className="rounded-md border border-border-subtle bg-surface-raised p-4 space-y-3">
    <div><h2 className="font-medium text-text-primary">Tobor projects</h2><p className="mt-1 text-sm text-text-muted">Link repository scopes to projects in Agentonomi. This connection is separate from your memory account.</p></div>
    <p role="status" className="text-sm text-text-primary">{status ? status.connected ? `Connected${status.projectAccess === "disabled" ? " · Projects permission required" : count !== null ? ` · ${count} accessible projects` : ""}` : "Not connected · local repository groups remain available" : "Checking connection…"}</p>
    <p className="text-xs text-text-muted">This app needs Organization_List and Project_List. If client toggles are already enabled, check effective endpoint permissions in Agentonomi MCP settings. Leave other permissions unchanged.</p>
    {status?.connected && status.permissionsUrl?.startsWith("https://agentonomi.com/app/admin/mcp-config/oauth-client/") && <a href={status.permissionsUrl} target="_blank" rel="noopener noreferrer" className="block text-sm text-glow underline">Manage project permissions</a>}
    {status?.connected && <label className="block text-sm text-text-muted">Organization<select aria-label="Tobor organization" className="ml-2 rounded border border-border-subtle bg-void px-2 py-1" value={organization} onChange={event => setOrganization(event.target.value)}><option value="">Choose an organization…</option>{organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}</select></label>}
    <div className="flex flex-wrap gap-3"><button disabled={busy || !status} onClick={() => act("connect")} className="btn-action">{status?.connected ? "Reconnect to Tobor" : "Connect to Tobor"}</button>{status?.connected && <><button disabled={busy || !organization} onClick={() => act("refresh")} className="btn-action">Refresh projects</button><button disabled={busy} onClick={() => act("disconnect")} className="btn-action">Disconnect Tobor</button></>}</div>
    {url && <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm text-glow underline">Continue Tobor login in your browser</a>}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
  </section>;
}
