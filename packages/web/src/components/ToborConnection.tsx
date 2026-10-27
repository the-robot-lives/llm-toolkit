import React, { useCallback, useEffect, useState } from "react";
import type { ToborProject } from "@llm-toolkit/shared";
import { apiFetch } from "../hooks/useApi.js";
interface Status { connected: boolean; loginPending: boolean; connectionId?: string | null }

export function ToborConnection({ onProjects }: { onProjects?: (projects: ToborProject[]) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    const next = await apiFetch<Status>("/tobor/status");
    setStatus(next);
    if (next.connected && !next.loginPending) setUrl("");
  }, []);
  const load = useCallback(async () => {
    const result = await apiFetch<{ data: ToborProject[] }>("/tobor/projects");
    setCount(result.data.length);
    onProjects?.(result.data);
  }, [onProjects]);
  useEffect(() => { refresh().catch(() => setError("Tobor connection status is unavailable.")); }, [refresh]);
  useEffect(() => {
    if (status?.connected) load().catch(() => setError("Could not load projects. Reconnect and allow Projects and Organizations access."));
    else { setCount(null); onProjects?.([]); }
  }, [status?.connected, status?.connectionId, load, onProjects]);
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
        await apiFetch("/tobor/disconnect", { method: "POST", body: "{}" });
        setUrl(""); await refresh();
      } else await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Tobor connection failed."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Tobor project connection" className="rounded-md border border-border-subtle bg-surface-raised p-4 space-y-3">
    <div><h2 className="font-medium text-text-primary">Tobor projects</h2><p className="mt-1 text-sm text-text-muted">Link repository scopes to projects in Agentonomi. This connection is separate from your memory account.</p></div>
    <p role="status" className="text-sm text-text-primary">{status ? status.connected ? `Connected${count !== null ? ` · ${count} accessible projects` : ""}` : "Not connected · local repository groups remain available" : "Checking connection…"}</p>
    <div className="flex flex-wrap gap-3"><button disabled={busy || !status} onClick={() => act("connect")} className="btn-action">{status?.connected ? "Reconnect to Tobor" : "Connect to Tobor"}</button>{status?.connected && <><button disabled={busy} onClick={() => act("refresh")} className="btn-action">Refresh projects</button><button disabled={busy} onClick={() => act("disconnect")} className="btn-action">Disconnect Tobor</button></>}</div>
    {url && <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm text-glow underline">Continue Tobor login in your browser</a>}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
  </section>;
}
