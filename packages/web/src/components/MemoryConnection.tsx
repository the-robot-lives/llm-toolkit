import React, { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../hooks/useApi.js";

export interface MemoryConnectionStatus {
  connected: boolean;
  serverUrl: string;
  writeEnabled: boolean;
  loginPending: boolean;
  connectionId?: string | null;
}

export function MemoryConnection({ onChange }: { onChange?: (status: MemoryConnectionStatus) => void }) {
  const [status, setStatus] = useState<MemoryConnectionStatus | null>(null);
  const [write, setWrite] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const next = await apiFetch<MemoryConnectionStatus>("/remote-memory/status");
    setStatus(next);
    onChange?.(next);
    if (next.connected && !next.loginPending) setAuthorizationUrl("");
    return next;
  }, [onChange]);
  useEffect(() => { refresh().catch(() => setError("Memory connection status is unavailable.")); }, [refresh]);
  useEffect(() => { setWrite(status?.writeEnabled ?? false); }, [status?.writeEnabled]);
  useEffect(() => {
    if (!authorizationUrl) return;
    const timer = setInterval(() => { refresh().catch(() => {}); }, 2000);
    const timeout = setTimeout(() => { clearInterval(timer); setAuthorizationUrl(""); setMessage("Login expired. Connect again to continue."); }, 600_000);
    return () => { clearInterval(timer); clearTimeout(timeout); };
  }, [authorizationUrl, refresh]);

  const act = async (action: "connect" | "test" | "disconnect") => {
    setBusy(true); setError(""); setMessage("");
    try {
      if (action === "connect") {
        const result = await apiFetch<{ authorizationUrl: string }>("/remote-memory/oauth/start", { method: "POST", body: JSON.stringify({ writeEnabled: write }) });
        // Only the fixed, trusted service may receive the browser login.
        if (new URL(result.authorizationUrl).origin !== "https://therobot.is") throw new Error("Unexpected login service");
        setAuthorizationUrl(result.authorizationUrl);
      } else {
        await apiFetch(`/remote-memory/${action}`, { method: "POST", body: "{}" });
        if (action === "test") setMessage("Connected successfully. Your memories are accessible.");
        else { setAuthorizationUrl(""); setMessage("Disconnected from this app. Your memories are preserved."); }
        await refresh();
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Connection failed"); }
    finally { setBusy(false); }
  };

  return <section aria-label="Memory service connection" className="rounded-md border border-border-subtle bg-surface p-6 space-y-4">
    <div><h2 className="text-base font-medium text-text-primary">Memories · therobot.is</h2>
      <p className="mt-1 text-sm text-text-muted">Connect your memory account securely in your browser. Your password stays with therobot.is.</p></div>
    <p role="status" className="text-sm text-text-primary">{status ? status.connected ? `Connected · ${status.writeEnabled ? "Reading and editing" : "Read only"}` : "Not connected" : "Checking connection…"}</p>
    <label className="flex items-center gap-2 text-sm text-text-muted"><input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />Allow capturing and editing memories</label>
    <div className="flex flex-wrap gap-3">
      <button disabled={busy || !status} onClick={() => act("connect")} className="rounded bg-glow px-4 py-2 text-sm text-void disabled:opacity-50">{busy ? "Please wait…" : status?.connected ? "Reconnect" : "Connect to therobot.is"}</button>
      {status?.connected && <><button disabled={busy} onClick={() => act("test")} className="rounded border border-border-subtle px-4 py-2 text-sm">Test connection</button><button disabled={busy} onClick={() => act("disconnect")} className="rounded border border-border-subtle px-4 py-2 text-sm">Disconnect</button></>}
    </div>
    {authorizationUrl && <div className="rounded bg-canvas p-3 space-y-2"><a href={authorizationUrl} target="_blank" rel="noopener noreferrer" className="text-glow underline">Continue login in your browser</a><p className="text-xs text-text-muted">Approve access, then return here. Connection status updates automatically.</p></div>}
    {message && <p role="status" className="text-sm text-text-muted">{message}</p>}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
  </section>;
}
