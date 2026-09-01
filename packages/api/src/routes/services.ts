import { Hono, type Context } from "hono";
import type { NplPluginConfig } from "@llm-toolkit/shared";
import { loadNplPluginConfig, saveNplPluginConfig } from "@llm-toolkit/shared";
import type { ServiceSupervisor, ServiceStatus } from "../services/service-supervisor.ts";
import { ServiceError } from "../services/service-supervisor.ts";

const NAME_PATTERN = /^[a-z0-9-]+$/;

export interface ServiceRoutesOpts {
  projectRoot: string | null;
  home?: string;
  /** Test overrides mirroring loadNplPluginConfig's opts. */
  userPath?: string;
  projectPath?: string;
  cwd?: string;
}

function errorResponse(c: Context, message: string, status: 400 | 404 | 409 | 500) {
  return c.json({ error: message }, status);
}

// ⟦𓋗𓆏⟧ createServiceRoutes :: list/join runtime status + lifecycle controls + npl plugin config editing
export function createServiceRoutes(supervisor: ServiceSupervisor, opts: ServiceRoutesOpts): Hono {
  const routes = new Hono();

  const loadLayers = () =>
    loadNplPluginConfig({
      cwd: opts.cwd ?? opts.projectRoot ?? process.cwd(),
      home: opts.home,
      userPath: opts.userPath,
      projectPath: opts.projectPath,
    });

  routes.get("/", (c) => {
    let loaded: ReturnType<typeof loadLayers>;
    try {
      loaded = loadLayers();
    } catch (err) {
      return errorResponse(c, (err as Error).message, 500);
    }
    const statuses = supervisor.statusAll();
    const services = loaded.config.services.map((svc) => {
      const runtime: ServiceStatus = statuses[svc.name] ?? { status: "stopped" as const };
      return {
        name: svc.name,
        source: loaded.serviceSources[svc.name] ?? (loaded.layers.projectFound ? "project" : "user"),
        enabled: svc.enabled !== false,
        autostart: svc.autostart === true,
        transport: svc.transport ?? "stdio",
        command: svc.command,
        args: svc.args,
        url: svc.url,
        status: runtime.status,
        pid: runtime.pid,
        startedAt: runtime.startedAt,
        uptimeMs: runtime.uptimeMs,
        exitCode: runtime.exitCode,
      };
    });
    return c.json({ services });
  });

  const lifecycle = (action: "start" | "stop" | "restart") =>
    async (c: Context): Promise<Response> => {
      const name = c.req.param("name") ?? "";
      if (!NAME_PATTERN.test(name)) {
        return errorResponse(c, `invalid service name "${name}"`, 400);
      }
      try {
        const status = await supervisor[action](name);
        return c.json({ ok: true, status: status.status }, 200);
      } catch (err) {
        if (err instanceof ServiceError) {
          const httpStatus = err.code === "not-found" ? 404 : err.code === "conflict" ? 409 : 500;
          return errorResponse(c, err.message, httpStatus);
        }
        return errorResponse(c, (err as Error).message, 500);
      }
    };

  routes.post("/:name/start", lifecycle("start"));
  routes.post("/:name/stop", lifecycle("stop"));
  routes.post("/:name/restart", lifecycle("restart"));

  routes.patch("/:name", async (c) => {
    const name = c.req.param("name") ?? "";
    if (!NAME_PATTERN.test(name)) {
      return errorResponse(c, `invalid service name "${name}"`, 400);
    }
    let body: { enabled?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "request body must be JSON", 400);
    }
    if (typeof body.enabled !== "boolean") {
      return errorResponse(c, "body must be { enabled: boolean }", 400);
    }
    const enabled: boolean = body.enabled;

    let loaded: ReturnType<typeof loadLayers>;
    try {
      loaded = loadLayers();
    } catch (err) {
      return errorResponse(c, (err as Error).message, 500);
    }
    const svc = loaded.config.services.find((s) => s.name === name);
    if (!svc) {
      return errorResponse(c, `unknown service "${name}"`, 404);
    }

    // Highest-priority existing layer wins: project file when its layer was found, else user file.
    const scope: "user" | "project" = loaded.layers.projectFound ? "project" : "user";
    const scopeConfig: NplPluginConfig = {
      version: 1,
      services: loaded.config.services
        // Only services sourced at this scope travel with the write; the edited service is
        // added with merged fields so the enabled flip (and any project-layer overrides)
        // persist at this scope.
        .filter((s) => loaded.serviceSources[s.name] === scope || s.name === name)
        .map((s) =>
          s.name === name
            ? { ...s, enabled }
            : s,
        ),
      ...(loaded.config.mcp_sync ? { mcp_sync: loaded.config.mcp_sync } : {}),
    };

    try {
      saveNplPluginConfig(scope, scopeConfig, {
        home: opts.home,
        ...(scope === "project" && opts.projectRoot ? { projectRoot: opts.projectRoot } : {}),
      });
    } catch (err) {
      return errorResponse(c, `failed to save config: ${(err as Error).message}`, 500);
    }

    const updated = { ...svc, enabled };
    return c.json({
      data: {
        name: updated.name,
        enabled: updated.enabled,
        autostart: updated.autostart === true,
        transport: updated.transport ?? "stdio",
        command: updated.command,
        args: updated.args,
        url: updated.url,
        status: supervisor.statusAll()[name]?.status ?? "stopped",
      },
    });
  });

  routes.get("/config", (c) => {
    try {
      const loaded = loadLayers();
      return c.json({ data: { config: loaded.config, layers: loaded.layers } });
    } catch (err) {
      return errorResponse(c, (err as Error).message, 500);
    }
  });

  routes.put("/config", async (c) => {
    const scope = c.req.query("scope") === "project" ? "project" : "user";
    let body: NplPluginConfig;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "request body must be JSON", 400);
    }
    if (!body || !Array.isArray(body.services)) {
      return errorResponse(c, "body must be a config object with a services list", 400);
    }
    try {
      const path = saveNplPluginConfig(scope, body, {
        home: opts.home,
        ...(scope === "project" && opts.projectRoot ? { projectRoot: opts.projectRoot } : {}),
      });
      return c.json({ data: { path } });
    } catch (err) {
      return errorResponse(c, `failed to save config: ${(err as Error).message}`, 500);
    }
  });

  return routes;
}
