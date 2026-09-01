import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { apiFetch } from "../interactive/hooks/useApi.js";

const API_BASE = "http://localhost:3100/api";

export type ServiceStatus = "stopped" | "starting" | "running" | "failed" | "adopted";
export type ServiceSource = "default" | "user" | "project";

export interface ServiceEntry {
  name: string;
  source: ServiceSource;
  enabled: boolean;
  autostart: boolean;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  status: ServiceStatus;
  pid?: number;
  startedAt?: string;
  uptimeMs?: number;
}

type ServicesMode = "interactive" | "list" | "start" | "stop" | "restart" | "all";

export interface ParsedServicesArgs {
  mode: ServicesMode;
  name?: string;
  error?: string;
}

const ACTION_FLAGS: Record<string, "start" | "stop" | "restart"> = {
  "--start": "start",
  "--stop": "stop",
  "--restart": "restart",
};

const STATUS_COLORS: Record<ServiceStatus, string> = {
  running: "green",
  failed: "red",
  starting: "yellow",
  adopted: "blue",
  stopped: "gray",
};

// ⟦𓇹𓁢𓎛𓆏⟧ parseServicesArgs :: auto-generated pointer for public function parseServicesArgs
export function parseServicesArgs(args: string[]): ParsedServicesArgs {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--list") return { mode: "list" };
    if (arg === "--all") return { mode: "all" };
    const action = ACTION_FLAGS[arg];
    if (action) {
      const name = args[i + 1];
      if (!name || name.startsWith("--")) {
        return { mode: "interactive", error: `Missing service name after ${arg}` };
      }
      return { mode: action, name };
    }
    if (arg.startsWith("--")) {
      return { mode: "interactive", error: `Unknown flag: ${arg}` };
    }
  }
  return { mode: "interactive" };
}

interface ServicesCommandProps {
  args: string[];
}

// ⟦𓊝𓂀𓃰𓉼⟧ ServicesCommand :: auto-generated pointer for public function ServicesCommand
export function ServicesCommand({ args }: ServicesCommandProps) {
  const parsed = parseServicesArgs(args);
  if (parsed.error) return <FlagErrorExit message={parsed.error} />;
  if (parsed.mode === "interactive") return <ServicesDashboard />;
  return <ServicesNonInteractive mode={parsed.mode} name={parsed.name} />;
}

function FlagErrorExit({ message }: { message: string }) {
  const { exit } = useApp();
  useEffect(() => {
    process.exitCode = 1;
    exit();
  }, [exit]);
  return <Text color="red">Error: {message}</Text>;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function ServicesNonInteractive({ mode, name }: { mode: "list" | "start" | "stop" | "restart" | "all"; name?: string }) {
  const { exit } = useApp();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (mode === "list") {
          const { services } = await apiFetch<{ services: ServiceEntry[] }>("/services");
          if (cancelled) return;
          if (services.length === 0) {
            setMessage("No services registered.");
            return;
          }
          const rows = services.map((s) =>
            [
              pad(s.name, 24),
              pad(s.status, 10),
              pad(s.enabled ? "enabled" : "disabled", 10),
              pad(s.pid != null ? String(s.pid) : "-", 8),
              s.source,
            ].join(" ")
          );
          setMessage(["NAME".padEnd(24) + " " + "STATUS".padEnd(10) + " " + "ENABLED".padEnd(10) + " " + "PID".padEnd(8) + " SOURCE", ...rows].join("\n"));
          return;
        }
        if (mode === "all") {
          const { services } = await apiFetch<{ services: ServiceEntry[] }>("/services");
          const enabled = services.filter((s) => s.enabled);
          if (cancelled) return;
          if (enabled.length === 0) {
            setMessage("No enabled services to start.");
            return;
          }
          const lines: string[] = [];
          for (const service of enabled) {
            try {
              const r = await apiFetch<{ ok: boolean; status: ServiceStatus }>(
                `/services/${encodeURIComponent(service.name)}/start`,
                { method: "POST" }
              );
              lines.push(`${service.name}: ${r.status}`);
            } catch (err: any) {
              lines.push(`${service.name}: failed (${err.message})`);
            }
          }
          setMessage(lines.join("\n"));
          return;
        }
        // start / stop / restart NAME
        const r = await apiFetch<{ ok: boolean; status: ServiceStatus }>(
          `/services/${encodeURIComponent(name ?? "")}/${mode}`,
          { method: "POST" }
        );
        setMessage(`${name}: ${r.status}`);
      } catch (err: any) {
        if (cancelled) return;
        process.exitCode = 1;
        setMessage(`Error: ${err.message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, name]);

  useEffect(() => {
    if (message == null) return;
    exit();
  }, [message, exit]);

  if (message == null) return <Text dimColor>Working...</Text>;
  return <Text color={process.exitCode === 1 ? "red" : undefined}>{message}</Text>;
}

function ServicesDashboard() {
  const { exit } = useApp();
  const [services, setServices] = useState<ServiceEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const refetch = useCallback(() => {
    apiFetch<{ services: ServiceEntry[] }>("/services")
      .then((body) => {
        setServices(body.services);
        setError(null);
      })
      .catch((err: any) => setError(err.message));
  }, []);

  useEffect(() => {
    refetch();
    const timer = setInterval(refetch, 3000);
    return () => clearInterval(timer);
  }, [refetch]);

  useEffect(() => {
    if (cursor >= services.length) setCursor(Math.max(0, services.length - 1));
  }, [services.length, cursor]);

  const showNotice = (text: string, ok: boolean) => {
    setNotice({ text, ok });
    setTimeout(() => setNotice(null), 2500);
  };

  const act = useCallback(
    async (service: ServiceEntry, action: "start" | "stop" | "restart") => {
      try {
        const r = await apiFetch<{ ok: boolean; status: ServiceStatus }>(
          `/services/${encodeURIComponent(service.name)}/${action}`,
          { method: "POST" }
        );
        showNotice(`${action} ${service.name}: ${r.status}`, true);
        refetch();
      } catch (err: any) {
        showNotice(`${action} ${service.name}: ${err.message}`, false);
      }
    },
    [refetch]
  );

  const toggleEnabled = useCallback(
    async (service: ServiceEntry) => {
      try {
        await apiFetch(`/services/${encodeURIComponent(service.name)}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: !service.enabled }),
        });
        showNotice(`${service.name}: ${!service.enabled ? "enabled" : "disabled"}`, true);
        refetch();
      } catch (err: any) {
        showNotice(`toggle ${service.name}: ${err.message}`, false);
      }
    },
    [refetch]
  );

  useInput((input, key) => {
    if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow || input === "j") setCursor((c) => Math.min(Math.max(0, services.length - 1), c + 1));
    else if (input === "q" || key.escape) exit();
    else if (input === "s" || input === "x" || input === "r") {
      const current = services[cursor];
      if (current) act(current, input === "s" ? "start" : input === "x" ? "stop" : "restart");
    } else if (input === " ") {
      const current = services[cursor];
      if (current) toggleEnabled(current);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Services</Text>
      <Text dimColor>j/k:move s:start x:stop r:restart space:toggle-enabled q:quit</Text>
      {notice && <Text color={notice.ok ? "green" : "red"}>{notice.text}</Text>}
      {error && <Text color="red">{error}</Text>}
      {!error && services.length === 0 && <Text dimColor>No services registered.</Text>}
      <Box flexDirection="column" marginTop={1}>
        {services.map((s, i) => (
          <Text key={s.name} inverse={i === cursor}>
            {i === cursor ? "▸ " : "  "}
            {pad(s.name, 24)}
            <Text color={STATUS_COLORS[s.status] ?? "gray"}>{pad(s.status, 10)}</Text>
            {s.enabled ? <Text color="green">●</Text> : <Text>○</Text>}
            {"  "}
            {pad(s.source, 10)}
            <Text dimColor>{s.pid != null ? `pid ${s.pid}` : ""}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
