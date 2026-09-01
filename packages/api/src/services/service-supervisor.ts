import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import http from "node:http";
import type { McpConfigFormat, NplPluginConfig, NplServiceConfig } from "@llm-toolkit/shared";
import { resolveServiceCwd } from "@llm-toolkit/shared";
import { disableMcpServer, upsertMcpServer, type McpServerDef } from "./mcp-config.ts";

// @types/node 25's ChildProcess event-emitter surface doesn't resolve cleanly under this
// TS config (skipLibCheck hides the internal breakage), so pin the slice we rely on.
type ChildEvents = ChildProcess & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
};

export type ServiceLifecycleStatus = "stopped" | "starting" | "running" | "failed" | "adopted";

export interface ServiceStatus {
  status: ServiceLifecycleStatus;
  pid?: number;
  startedAt?: Date;
  uptimeMs?: number;
  exitCode?: number | null;
}

export class ServiceError extends Error {
  code: "conflict" | "not-found" | "failed";

  constructor(code: "conflict" | "not-found" | "failed", message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

export interface ServiceSupervisorOpts {
  dataDir: string;
  getConfig: () => NplPluginConfig;
  projectRoot?: string | null;
  home?: string;
  /** Test hooks — defaults match production (15s health window, 500ms poll, 1s liveness probe). */
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  livenessProbeMs?: number;
}

interface OwnedEntry {
  child: ChildEvents;
  startedAt: Date;
  svc: NplServiceConfig;
  stopping: boolean;
}

interface FailureRecord {
  exitCode: number | null;
}

const MCP_TARGET_PATHS: Record<
  string,
  (ctx: { home?: string; projectRoot?: string | null }) => { path: string; format: McpConfigFormat } | null
> = {
  "claude-json": ({ home }) => ({ path: join(home ?? homedir(), ".claude.json"), format: "claude-json" }),
  "project-mcp-json": ({ projectRoot }) => ({
    path: join(projectRoot ?? process.cwd(), ".mcp.json"),
    format: "mcp-json",
  }),
};

const activeSupervisors = new Set<ServiceSupervisor>();
let cleanupHandlersInstalled = false;

function installCleanupHandlers(): void {
  if (cleanupHandlersInstalled) return;
  cleanupHandlersInstalled = true;
  const stopAll = () => {
    for (const supervisor of activeSupervisors) supervisor.stopAllSync();
  };
  process.once("exit", stopAll);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      stopAll();
      process.exit(0);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Single HTTP probe — resolves true on ANY response, false on connection failure/timeout. */
function probeHttp(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (up: boolean) => {
      if (settled) return;
      settled = true;
      resolve(up);
    };
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume();
      done(true);
    });
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.on("error", () => done(false));
  });
}

function mcpDefFor(svc: NplServiceConfig): McpServerDef {
  if (svc.transport === "http" && svc.url) {
    return { transport: "http", url: svc.url };
  }
  return { transport: "stdio", command: svc.command, args: svc.args, env: svc.env };
}

export class ServiceSupervisor {
  readonly dataDir: string;
  private readonly getConfig: () => NplPluginConfig;
  private readonly projectRoot: string | null;
  private readonly home?: string;
  private readonly healthTimeoutMs: number;
  private readonly healthIntervalMs: number;
  private readonly livenessProbeMs: number;

  private readonly children = new Map<string, OwnedEntry>();
  private readonly starting = new Set<string>();
  private readonly adopted = new Map<string, number>();
  private readonly failures = new Map<string, FailureRecord>();

  constructor(opts: ServiceSupervisorOpts) {
    this.dataDir = opts.dataDir;
    this.getConfig = opts.getConfig;
    this.projectRoot = opts.projectRoot ?? null;
    this.home = opts.home;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 15000;
    this.healthIntervalMs = opts.healthIntervalMs ?? 500;
    this.livenessProbeMs = opts.livenessProbeMs ?? 1000;
    activeSupervisors.add(this);
    installCleanupHandlers();
  }

  private pidDir(): string {
    return join(this.dataDir, "services");
  }

  private pidPath(name: string): string {
    return join(this.pidDir(), `${name}.pid`);
  }

  private service(name: string): NplServiceConfig {
    const svc = this.config()?.services.find((s) => s.name === name);
    if (!svc) throw new ServiceError("not-found", `unknown service "${name}"`);
    return svc;
  }

  private config(): NplPluginConfig | null {
    try {
      return this.getConfig();
    } catch (err) {
      console.error(`[services] config load failed: ${(err as Error).message}`);
      return null;
    }
  }

  // ⟦𓆏⟧ reconcile :: adopt live pid files, reap stale ones
  reconcile(): void {
    const dir = this.pidDir();
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".pid")) continue;
      const path = join(dir, file);
      const raw = readFileSync(path, "utf-8").trim();
      const pid = Number.parseInt(raw, 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        rmSync(path, { force: true });
        continue;
      }
      try {
        process.kill(pid, 0);
        this.adopted.set(basename(file, ".pid"), pid);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") {
          this.adopted.set(basename(file, ".pid"), pid);
        } else {
          rmSync(path, { force: true });
        }
      }
    }
  }

  private healthUrlFor(svc: NplServiceConfig): string | null {
    if (!svc.health_url && !svc.port) return null;
    const path = svc.health_url ?? "/";
    if (/^https?:\/\//.test(path)) return path;
    if (svc.url) return new URL(path, svc.url).toString();
    const port = svc.port ?? 80;
    return `http://127.0.0.1:${port}${path.startsWith("/") ? path : `/${path}`}`;
  }

  // ⟦𓆏𓆏⟧ start :: spawn + wait for health/liveness, pid file, mcp store sync
  async start(name: string): Promise<ServiceStatus> {
    const svc = this.service(name);
    if (this.children.has(name) || this.adopted.has(name)) {
      throw new ServiceError("conflict", `service "${name}" is already running`);
    }
    if (this.starting.has(name)) {
      throw new ServiceError("conflict", `service "${name}" is already starting`);
    }
    if (!svc.command) {
      throw new ServiceError("failed", `service "${name}" has no command`);
    }

    this.starting.add(name);
    let child: ChildEvents | null = null;
    try {
      const logDir = join(this.dataDir, "service-logs");
      mkdirSync(logDir, { recursive: true });
      const logFd = openSync(join(logDir, `${name}.log`), "a");
      child = spawn(svc.command, svc.args ?? [], {
        cwd: resolveServiceCwd(svc, this.projectRoot, this.home),
        env: { ...process.env, ...svc.env },
        stdio: ["ignore", logFd, logFd],
      }) as ChildEvents;
      closeSync(logFd);
    } catch (err) {
      this.starting.delete(name);
      this.failures.set(name, { exitCode: null });
      throw new ServiceError("failed", `service "${name}" failed to spawn: ${(err as Error).message}`);
    }

    const startedAt = new Date();
    const entry: OwnedEntry = { child, startedAt, svc, stopping: false };
    // Holder object: the exit callback mutates this, and TS flow analysis narrows bare
    // `let x = null` captures to `null` at use sites.
    const exit: { record: { code: number | null } | null } = { record: null };
    void new Promise<void>((resolve) => {
      child.on("exit", (code: number | null) => {
        exit.record = { code };
        this.children.delete(name);
        rmSync(this.pidPath(name), { force: true });
        if (!entry.stopping) this.failures.set(name, { exitCode: code });
        resolve();
      });
    });

    this.children.set(name, entry);
    if (child.pid) {
      mkdirSync(this.pidDir(), { recursive: true });
      writeFileSync(this.pidPath(name), String(child.pid));
    }

    const healthUrl = this.healthUrlFor(svc);
    let up: boolean;
    if (healthUrl) {
      const deadline = Date.now() + this.healthTimeoutMs;
      up = false;
      while (Date.now() < deadline) {
        if (exit.record) break;
        if (await probeHttp(healthUrl)) {
          up = true;
          break;
        }
        if (exit.record) break;
        await sleep(this.healthIntervalMs);
      }
    } else {
      await sleep(this.livenessProbeMs);
      up = !exit.record;
    }

    this.starting.delete(name);

    if (exit.record) {
      throw new ServiceError(
        "failed",
        `service "${name}" exited immediately (code ${exit.record.code ?? "unknown"})`,
      );
    }
    if (!up) {
      await this.stop(name);
      throw new ServiceError("failed", `service "${name}" failed health check within ${this.healthTimeoutMs}ms`);
    }

    this.syncStores(svc, true);
    return { status: "running", pid: child.pid, startedAt, uptimeMs: 0 };
  }

  // ⟦𓆏𓆏𓆏⟧ stop :: TERM → 3s grace → KILL, owned or adopted; idempotent when stopped
  async stop(name: string): Promise<ServiceStatus> {
    const owned = this.children.get(name);
    const adoptedPid = this.adopted.get(name);
    if (!owned && adoptedPid === undefined) {
      this.failures.delete(name);
      rmSync(this.pidPath(name), { force: true });
      return { status: "stopped" };
    }

    if (owned) {
      owned.stopping = true;
      owned.child.kill("SIGTERM");
      const graceExit = await this.waitForChildExit(owned.child, 3000);
      if (!graceExit) {
        owned.child.kill("SIGKILL");
        await this.waitForChildExit(owned.child, 1000);
      }
      this.children.delete(name);
    } else if (adoptedPid !== undefined) {
      await this.terminatePid(adoptedPid);
      this.adopted.delete(name);
    }

    this.failures.delete(name);
    rmSync(this.pidPath(name), { force: true });
    if (owned) this.syncStores(owned.svc, false);
    else {
      const svc = this.config()?.services.find((s) => s.name === name);
      if (svc) this.syncStores(svc, false);
    }
    return { status: "stopped" };
  }

  async restart(name: string): Promise<ServiceStatus> {
    await this.stop(name);
    return this.start(name);
  }

  private waitForChildExit(child: ChildEvents, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (exited: boolean) => {
        if (settled) return;
        settled = true;
        resolve(exited);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      child.on("exit", () => {
        clearTimeout(timer);
        done(true);
      });
    });
  }

  private async terminatePid(pid: number): Promise<void> {
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    if (!alive()) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    const deadline = Date.now() + 3000;
    while (alive() && Date.now() < deadline) await sleep(100);
    if (alive()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      const hardDeadline = Date.now() + 1000;
      while (alive() && Date.now() < hardDeadline) await sleep(50);
    }
  }

  statusAll(): Record<string, ServiceStatus> {
    const out: Record<string, ServiceStatus> = {};
    for (const [name, failure] of this.failures) {
      out[name] = { status: "failed", exitCode: failure.exitCode };
    }
    for (const [name, pid] of this.adopted) {
      out[name] = { status: "adopted", pid };
    }
    for (const [name, entry] of this.children) {
      out[name] = {
        status: "running",
        pid: entry.child.pid,
        startedAt: entry.startedAt,
        uptimeMs: Date.now() - entry.startedAt.getTime(),
      };
    }
    for (const name of this.starting) {
      out[name] = { status: "starting" };
    }
    const config = this.config();
    for (const svc of config?.services ?? []) {
      if (!out[svc.name]) out[svc.name] = { status: "stopped" };
    }
    return out;
  }

  async autostartEnabled(): Promise<void> {
    const services = (this.config()?.services ?? []).filter(
      (svc) => svc.enabled !== false && svc.autostart === true,
    );
    await Promise.allSettled(
      services.map(async (svc) => {
        try {
          await this.start(svc.name);
        } catch (err) {
          console.error(`[services] autostart for "${svc.name}" failed: ${(err as Error).message}`);
        }
      }),
    );
  }

  /** Synchronous best-effort kill of all children/adopted pids — for process exit handlers. */
  stopAllSync(): void {
    for (const [, entry] of this.children) {
      try {
        entry.child.kill("SIGTERM");
        const child = entry.child;
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, 500).unref();
      } catch {
        /* already gone */
      }
    }
    for (const [, pid] of this.adopted) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  private syncStores(svc: NplServiceConfig, enable: boolean): void {
    if (!svc.sync_to_stores) return;
    const targets = this.config()?.mcp_sync?.targets ?? [];
    for (const target of targets) {
      const mapper = MCP_TARGET_PATHS[target];
      if (!mapper) continue;
      const mapped = mapper({ home: this.home, projectRoot: this.projectRoot });
      if (!mapped) continue;
      try {
        if (enable) {
          upsertMcpServer(mapped.path, mapped.format, svc.name, mcpDefFor(svc), true);
        } else {
          disableMcpServer(mapped.path, mapped.format, svc.name, false);
        }
      } catch (err) {
        console.error(
          `[services] mcp store sync (${target}) for "${svc.name}" failed: ${(err as Error).message}`,
        );
      }
    }
  }
}
