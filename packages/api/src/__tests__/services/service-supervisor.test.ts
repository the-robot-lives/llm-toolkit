import { describe, test, expect, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import http from "node:http";
import type { NplPluginConfig } from "@llm-toolkit/shared";
import { ServiceSupervisor } from "../../services/service-supervisor.ts";

const tempDir = mkdtempSync(join(tmpdir(), "llm-toolkit-supervisor-test-"));

const LONG_RUN = ["-e", "setInterval(()=>{},1000)"];
const EXIT_IMMEDIATELY = ["-e", "process.exit(3)"];

function baseConfig(services: NplPluginConfig["services"]): NplPluginConfig {
  return { version: 1, services, mcp_sync: { targets: [] } };
}

let config = baseConfig([]);
let supervisor = newSupervisor();

function newSupervisor(): ServiceSupervisor {
  return new ServiceSupervisor({
    dataDir: tempDir,
    getConfig: () => config,
    healthTimeoutMs: 4000,
    healthIntervalMs: 100,
    livenessProbeMs: 700,
  });
}

function pidPath(name: string): string {
  return join(tempDir, "services", `${name}.pid`);
}

beforeEach(() => {
  config = baseConfig([]);
});

afterAll(async () => {
  await Promise.allSettled(
    Object.keys(supervisor.statusAll()).map((name) => supervisor.stop(name)),
  );
  supervisor.stopAllSync();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ServiceSupervisor", () => {
  test("start → running with pid file", async () => {
    config = baseConfig([
      { name: "long-a", command: process.execPath, args: LONG_RUN, enabled: true },
    ]);
    const status = await supervisor.start("long-a");
    expect(status.status).toBe("running");
    expect(status.pid).toBeGreaterThan(0);
    expect(existsSync(pidPath("long-a"))).toBe(true);
    const all = supervisor.statusAll();
    expect(all["long-a"]?.status).toBe("running");
    expect(all["long-a"]?.startedAt).toBeInstanceOf(Date);
    expect(all["long-a"]?.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  test("stop → stopped, pid file removed, process dead", async () => {
    config = baseConfig([
      { name: "long-b", command: process.execPath, args: LONG_RUN, enabled: true },
    ]);
    const started = await supervisor.start("long-b");
    const pid = started.pid!;
    await supervisor.stop("long-b");
    expect(existsSync(pidPath("long-b"))).toBe(false);
    expect(supervisor.statusAll()["long-b"]?.status).toBe("stopped");
    // SIGTERM → node exits; give the OS a moment then confirm the pid is gone.
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  test("restart → running again with a fresh pid", async () => {
    config = baseConfig([
      { name: "long-c", command: process.execPath, args: LONG_RUN, enabled: true },
    ]);
    const first = await supervisor.start("long-c");
    const again = await supervisor.restart("long-c");
    expect(again.status).toBe("running");
    expect(again.pid).not.toBe(first.pid);
  });

  test("start on running service → conflict", async () => {
    config = baseConfig([
      { name: "long-d", command: process.execPath, args: LONG_RUN, enabled: true },
    ]);
    await supervisor.start("long-d");
    await expect(supervisor.start("long-d")).rejects.toMatchObject({ code: "conflict" });
    await supervisor.stop("long-d");
  });

  test("early exit → failed with exit code", async () => {
    config = baseConfig([
      { name: "boomer", command: process.execPath, args: EXIT_IMMEDIATELY, enabled: true },
    ]);
    await expect(supervisor.start("boomer")).rejects.toMatchObject({ code: "failed" });
    const status = supervisor.statusAll()["boomer"];
    expect(status?.status).toBe("failed");
    expect(status?.exitCode).toBe(3);
  });

  test("unknown service → not-found", async () => {
    await expect(supervisor.start("nope")).rejects.toMatchObject({ code: "not-found" });
  });

  test("stale pid file reaped on reconcile", async () => {
    const dying = spawn(process.execPath, ["-e", ""]) as unknown as {
      pid?: number;
      on(event: string, listener: () => void): unknown;
    };
    await new Promise<void>((resolve) => dying.on("exit", () => resolve()));
    mkdirSync(join(tempDir, "services"), { recursive: true });
    writeFileSync(pidPath("ghost"), String(dying.pid));
    supervisor.reconcile();
    expect(existsSync(pidPath("ghost"))).toBe(false);
    expect(supervisor.statusAll()["ghost"]?.status).toBeUndefined();
  });

  test("live foreign pid adopted on reconcile, stoppable by pid", async () => {
    const foreign = spawn(process.execPath, LONG_RUN, { stdio: "ignore" });
    try {
      mkdirSync(join(tempDir, "services"), { recursive: true });
      writeFileSync(pidPath("adoptee"), String(foreign.pid));
      supervisor.reconcile();
      expect(supervisor.statusAll()["adoptee"]).toMatchObject({ status: "adopted", pid: foreign.pid });
      const stopped = await supervisor.stop("adoptee");
      expect(stopped.status).toBe("stopped");
      expect(existsSync(pidPath("adoptee"))).toBe(false);
    } finally {
      try {
        foreign.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  test("autostart picks enabled+autostart services only", async () => {
    config = baseConfig([
      { name: "auto-on", command: process.execPath, args: LONG_RUN, enabled: true, autostart: true },
      { name: "manual", command: process.execPath, args: LONG_RUN, enabled: true },
      { name: "auto-disabled", command: process.execPath, args: LONG_RUN, enabled: false, autostart: true },
    ]);
    await supervisor.autostartEnabled();
    const all = supervisor.statusAll();
    expect(all["auto-on"]?.status).toBe("running");
    expect(all["manual"]?.status).toBe("stopped");
    expect(all["auto-disabled"]?.status).toBe("stopped");
  });

  test("health poll: resolves running once an http port responds", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      config = baseConfig([
        { name: "healthsvc", command: process.execPath, args: LONG_RUN, port, health_url: "/healthz" },
      ]);
      const status = await supervisor.start("healthsvc");
      expect(status.status).toBe("running");
    } finally {
      await supervisor.stop("healthsvc").catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
