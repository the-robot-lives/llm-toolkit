import React, { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../hooks/useApi.js";

type ServiceSource = "default" | "user" | "project";
type ServiceTransport = "stdio" | "http";
type ServiceStatus = "stopped" | "starting" | "running" | "failed" | "adopted";

interface ServiceEntry {
  name: string;
  source: ServiceSource;
  enabled: boolean;
  autostart: boolean;
  transport: ServiceTransport;
  command?: string;
  args?: string[];
  url?: string;
  status: ServiceStatus;
  pid?: number;
  startedAt?: string;
  uptimeMs?: number;
}

interface ServicesResponse {
  services: ServiceEntry[];
}

interface ServiceActionResponse {
  ok: boolean;
  status: ServiceStatus;
}

const STATUS_DOT: Record<ServiceStatus, string> = {
  running: "bg-green-400",
  starting: "bg-amber-400",
  stopped: "bg-gray-400",
  failed: "bg-red-400",
  adopted: "bg-blue-400",
};

const SOURCE_BADGE: Record<ServiceSource, string> = {
  default: "bg-surface-raised text-text-muted",
  user: "bg-blue-900/30 text-blue-400",
  project: "bg-green-900/30 text-green-400",
};

function formatUptime(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function canStart(s: ServiceEntry) {
  return s.status === "stopped" || s.status === "failed";
}
function canStop(s: ServiceEntry) {
  return s.status === "running" || s.status === "starting" || s.status === "adopted";
}
function canRestart(s: ServiceEntry) {
  return s.status === "running" || s.status === "adopted";
}

// ⟦𓊝𓆏𓂁𓋜⟧ Services :: local MCP/daemon service management
export function Services() {
  const [services, setServices] = useState<ServiceEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);

  const fetchServices = useCallback(async () => {
    try {
      const res = await apiFetch<ServicesResponse>("/services");
      setServices(res.services);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load services");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServices();
    const interval = setInterval(fetchServices, 5000);
    return () => clearInterval(interval);
  }, [fetchServices]);

  const runAction = async (service: ServiceEntry, action: "start" | "stop" | "restart") => {
    setBusyName(service.name);
    setActionError(null);
    try {
      await apiFetch<ServiceActionResponse>(`/services/${encodeURIComponent(service.name)}/${action}`, {
        method: "POST",
      });
      await fetchServices();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Failed to ${action} ${service.name}`);
    } finally {
      setBusyName(null);
    }
  };

  const toggleEnabled = async (service: ServiceEntry) => {
    setBusyName(service.name);
    setActionError(null);
    try {
      await apiFetch(`/services/${encodeURIComponent(service.name)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !service.enabled }),
      });
      await fetchServices();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Failed to update ${service.name}`);
    } finally {
      setBusyName(null);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl">
        <p className="text-sm text-text-muted">Loading...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 text-xl font-medium text-text-bright">Services</h1>

      {error && (
        <div className="mb-6 rounded bg-red-950/30 border border-red-900/50 px-3 py-2">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {services && services.length === 0 ? (
        <section className="rounded-md border border-border-subtle bg-surface p-6">
          <p className="text-sm text-text-muted">No services configured.</p>
          <p className="mt-2 text-xs text-text-dim">
            Define local MCP/daemon services in{" "}
            <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-text-muted">~/.config/npl/npl-plugin.config.yaml</code>
            {" "}or{" "}
            <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-text-muted">./.npl/npl-plugin.config.yaml</code>
            {" "}and they will appear here.
          </p>
        </section>
      ) : (
        <section className="rounded-md border border-border-subtle bg-surface p-6">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="pb-2 pr-4 text-xs font-medium text-text-muted">Name</th>
                  <th className="pb-2 pr-4 text-xs font-medium text-text-muted">Source</th>
                  <th className="pb-2 pr-4 text-xs font-medium text-text-muted">Transport</th>
                  <th className="pb-2 pr-4 text-xs font-medium text-text-muted">Enabled</th>
                  <th className="pb-2 pr-4 text-xs font-medium text-text-muted">Status</th>
                  <th className="pb-2 text-xs font-medium text-text-muted">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(services ?? []).map((s) => (
                  <tr key={s.name} className="border-b border-border-subtle/50 last:border-0">
                    <td className="py-3 pr-4 font-mono text-sm text-text-primary">{s.name}</td>
                    <td className="py-3 pr-4">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${SOURCE_BADGE[s.source]}`}>
                        {s.source}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-xs text-text-muted">
                      {s.transport === "http" ? (s.url ?? "http") : (s.command ?? "stdio")}
                    </td>
                    <td className="py-3 pr-4">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        disabled={busyName === s.name}
                        onChange={() => toggleEnabled(s)}
                        className="accent-cyan-400 shrink-0 cursor-pointer"
                        aria-label={`Toggle ${s.name} enabled`}
                      />
                    </td>
                    <td className="py-3 pr-4">
                      <span className="flex items-center gap-2">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[s.status]}`} />
                        <span className="text-xs text-text-primary font-medium capitalize">{s.status}</span>
                        {s.pid != null && <span className="text-xs text-text-dim">pid {s.pid}</span>}
                        {s.uptimeMs != null && (
                          <span className="text-xs text-text-dim">{formatUptime(s.uptimeMs)}</span>
                        )}
                      </span>
                    </td>
                    <td className="py-3">
                      <div className="flex gap-2">
                        <button
                          onClick={() => runAction(s, "start")}
                          disabled={!canStart(s) || busyName === s.name}
                          className="rounded border border-border-subtle px-2.5 py-1 text-xs text-text-muted hover:text-text-primary hover:border-glow transition-colors disabled:opacity-40 disabled:pointer-events-none"
                        >
                          Start
                        </button>
                        <button
                          onClick={() => runAction(s, "stop")}
                          disabled={!canStop(s) || busyName === s.name}
                          className="rounded border border-border-subtle px-2.5 py-1 text-xs text-text-muted hover:text-text-primary hover:border-glow transition-colors disabled:opacity-40 disabled:pointer-events-none"
                        >
                          Stop
                        </button>
                        <button
                          onClick={() => runAction(s, "restart")}
                          disabled={!canRestart(s) || busyName === s.name}
                          className="rounded border border-border-subtle px-2.5 py-1 text-xs text-text-muted hover:text-text-primary hover:border-glow transition-colors disabled:opacity-40 disabled:pointer-events-none"
                        >
                          Restart
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {actionError && (
            <div className="mt-4 rounded bg-red-950/30 border border-red-900/50 px-3 py-2">
              <p className="text-xs text-red-400">{actionError}</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
