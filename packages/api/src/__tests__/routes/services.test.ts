import { describe, test, expect, afterAll } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNplPluginConfig } from "@llm-toolkit/shared";
import { createServiceRoutes } from "../../routes/services.ts";
import { ServiceSupervisor } from "../../services/service-supervisor.ts";

const home = mkdtempSync(join(tmpdir(), "llm-toolkit-svc-routes-home-"));
const dataDir = mkdtempSync(join(tmpdir(), "llm-toolkit-svc-routes-data-"));
const userConfigPath = join(home, ".config", "npl", "npl-plugin.config.yaml");

mkdirSync(join(home, ".config", "npl"), { recursive: true });
writeFileSync(
  userConfigPath,
  [
    "version: 1",
    "services:",
    "  - name: echo-on",
    "    command: node",
    "    args: [\"-e\", \"setInterval(()=>{},1000)\"]",
    "    enabled: true",
    "  - name: echo-off",
    "    command: node",
    "    args: [\"-e\", \"setInterval(()=>{},1000)\"]",
    "    enabled: false",
    "mcp_sync:",
    "  targets: []",
    "",
  ].join("\n"),
  "utf-8",
);

const supervisor = new ServiceSupervisor({
  dataDir,
  getConfig: () => loadNplPluginConfig({ home, userPath: userConfigPath }).config,
  healthTimeoutMs: 4000,
  healthIntervalMs: 100,
  livenessProbeMs: 700,
});

const app = new Hono();
app.route(
  "/api/services",
  createServiceRoutes(supervisor, { projectRoot: null, home, userPath: userConfigPath }),
);

afterAll(async () => {
  await Promise.allSettled(
    Object.keys(supervisor.statusAll()).map((name) => supervisor.stop(name)),
  );
  supervisor.stopAllSync();
  rmSync(home, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("service routes", () => {
  test("GET / lists config services joined with runtime status", async () => {
    const res = await app.request("/api/services");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.services).toHaveLength(2);
    const on = body.services.find((s: { name: string }) => s.name === "echo-on");
    expect(on).toMatchObject({
      name: "echo-on",
      source: "user",
      enabled: true,
      autostart: false,
      transport: "stdio",
      command: "node",
      status: "stopped",
    });
    expect(on.startedAt).toBeUndefined();
    const off = body.services.find((s: { name: string }) => s.name === "echo-off");
    expect(off.enabled).toBe(false);
  });

  test("POST /:name/start, duplicate start → 409, stop → 200", async () => {
    const started = await app.request("/api/services/echo-on/start", { method: "POST" });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ ok: true, status: "running" });

    const duplicate = await app.request("/api/services/echo-on/start", { method: "POST" });
    expect(duplicate.status).toBe(409);

    const stopped = await app.request("/api/services/echo-on/stop", { method: "POST" });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ ok: true, status: "stopped" });
  });

  test("400 on invalid service name (path traversal guard)", async () => {
    const res = await app.request("/api/services/..%2Fetc/start", { method: "POST" });
    expect([400, 404]).toContain(res.status);
    if (res.status === 400) {
      const body = await res.json();
      expect(body.error).toBeDefined();
    }
    // Plain invalid shape must always hit the name validator → 400.
    const bad = await app.request("/api/services/BadName/start", { method: "POST" });
    expect(bad.status).toBe(400);
    const badBody = await bad.json();
    expect(badBody.error).toBeDefined();
  });

  test("404 on unknown service", async () => {
    const res = await app.request("/api/services/no-such-svc/start", { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("no-such-svc");
  });

  test("PATCH /:name flips enabled and persists to user config", async () => {
    const res = await app.request("/api/services/echo-on", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ name: "echo-on", enabled: false });

    const reloaded = loadNplPluginConfig({ home, userPath: userConfigPath });
    expect(reloaded.layers.userFound).toBe(true);
    const svc = reloaded.config.services.find((s) => s.name === "echo-on");
    expect(svc?.enabled).toBe(false);
    // The untouched sibling must survive the scoped write.
    expect(reloaded.config.services.find((s) => s.name === "echo-off")?.enabled).toBe(false);
    // Flip back so other assertions stay deterministic.
    await app.request("/api/services/echo-on", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
  });

  test("PATCH /:name with non-boolean body → 400", async () => {
    const res = await app.request("/api/services/echo-on", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /config returns resolved config + layers", async () => {
    const res = await app.request("/api/services/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.config.services).toHaveLength(2);
    expect(body.data.layers).toMatchObject({ userFound: true, projectFound: false });
  });

  test("PUT /config?scope=user saves and returns path", async () => {
    const res = await app.request("/api/services/config?scope=user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        services: [
          {
            name: "put-svc",
            command: process.execPath,
            args: ["-e", "setInterval(()=>{},1000)"],
            enabled: true,
          },
        ],
        mcp_sync: { targets: [] },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.path).toBe(userConfigPath);
    expect(existsSync(userConfigPath)).toBe(true);
    const reloaded = loadNplPluginConfig({ home, userPath: userConfigPath });
    expect(reloaded.config.services.map((s) => s.name)).toContain("put-svc");
  });
});
