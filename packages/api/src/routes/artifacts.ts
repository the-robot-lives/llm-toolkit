import { Hono } from "hono";
import type { ArtifactKind, SkillsConfig } from "@llm-toolkit/shared";
import type { StorageService } from "../services/storage.ts";
import { loadConfig, persistArtifactConfig } from "./config.ts";
import {
  SkillActionError,
  applyArtifactTargets,
  discoverArtifactFolders,
  isArtifactKind,
  maskCatalog,
  readArtifactDetail,
  resolveKindConfig,
  scanArtifacts,
} from "../services/artifacts.ts";
import { normalizeSourceRoots, sourceRootIdentity } from "../services/source-roots.ts";
import { createSkillCatalog, previewSkillCatalog, migrateSkillsConfig } from "../services/skills.ts";

export { isArtifactKind };

// <REMOVED UUID HERE> createArtifactRoutes :: auto-generated pointer for public function createArtifactRoutes
export function createArtifactRoutes(storage: StorageService, kind: ArtifactKind): Hono {
  const routes = new Hono();
  const configOf = () => {
    const app = loadConfig(storage);
    return resolveKindConfig(kind, app.skills, app[kind]);
  };

  const verifyExpectedSource = (name: string, expected: unknown) => {
    if (expected === undefined) return; // legacy name-only callers keep first-root semantics
    const active = scanArtifacts(kind, configOf()).items.find(item => item.name === name);
    if (typeof expected !== "string" || !active || active.path !== expected) {
      throw new SkillActionError("The active source changed. Refresh the catalog before applying this action.", 409);
    }
  };

  routes.get("/", (c) => {
    const catalog = maskCatalog(scanArtifacts(kind, configOf()));
    return c.json({ data: { ...catalog, [kind]: catalog.items } });
  });

  routes.get("/discover", (c) => {
    return c.json({ data: { folders: discoverArtifactFolders(kind) } });
  });

  if (kind === "skills") {
    const approvedRoot = (value: unknown) => {
      if (typeof value !== "string" || value.length > 4096) throw new SkillActionError("Choose a configured skill source folder.", 400);
      const configured = configOf().sourceFolders;
      const roots = normalizeSourceRoots(configured.length ? configured : discoverArtifactFolders("skills")).paths;
      const root = sourceRootIdentity(value);
      if (!roots.includes(root)) throw new SkillActionError("Save this folder as a Skills source before generating its catalog.", 403);
      return root;
    };
    routes.post("/catalog/:action", async c => {
      c.header("Cache-Control", "no-store");
      const url = new URL(c.req.url);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return c.json({ error: "Catalog generation is available only on this computer." }, 403);
      if (![url.origin, "http://localhost:5173", "http://127.0.0.1:5173"].includes(c.req.header("Origin") ?? "")) return c.json({ error: "Untrusted request origin" }, 403);
      const body = await c.req.json().catch(() => null) as { root?: unknown; token?: unknown } | null;
      try {
        const root = approvedRoot(body?.root);
        if (c.req.param("action") === "preview") return c.json({ data: previewSkillCatalog(root) });
        if (c.req.param("action") !== "create" || typeof body?.token !== "string") return c.json({ error: "Preview the catalog before creating it." }, 400);
        return c.json({ data: createSkillCatalog(root, body.token) }, 201);
      } catch (error) { return actionError(c, error); }
    });
  }

  routes.post("/enable", async (c) => {
    const body = await c.req.json() as { name?: string; destinationId?: string; destinationIds?: string[]; replace?: boolean; expectedSource?: string };
    const ids = body.destinationIds?.length ? body.destinationIds : body.destinationId ? [body.destinationId] : [];
    if (!body.name || ids.length === 0) {
      return c.json({ error: "name and destinationId(s) are required" }, 400);
    }
    try {
      verifyExpectedSource(body.name, body.expectedSource);
      const results = applyArtifactTargets(kind, configOf(), body.name, ids, true, Boolean(body.replace));
      return c.json({ data: results.length === 1 ? results[0] : results });
    } catch (err) {
      return actionError(c, err);
    }
  });

  routes.post("/disable", async (c) => {
    const body = await c.req.json() as { name?: string; destinationId?: string; destinationIds?: string[]; expectedSource?: string };
    const ids = body.destinationIds?.length ? body.destinationIds : body.destinationId ? [body.destinationId] : [];
    if (!body.name || ids.length === 0) {
      return c.json({ error: "name and destinationId(s) are required" }, 400);
    }
    try {
      verifyExpectedSource(body.name, body.expectedSource);
      const results = applyArtifactTargets(kind, configOf(), body.name, ids, false);
      return c.json({ data: results.length === 1 ? results[0] : results });
    } catch (err) {
      return actionError(c, err);
    }
  });

  routes.post("/apply", async (c) => {
    const body = await c.req.json() as {
      name?: string;
      destinationIds?: string[];
      enabled?: boolean;
      replace?: boolean;
      expectedSource?: string;
    };
    if (!body.name || !body.destinationIds?.length || typeof body.enabled !== "boolean") {
      return c.json({ error: "name, destinationIds, and enabled are required" }, 400);
    }
    try {
      verifyExpectedSource(body.name, body.expectedSource);
      const results = applyArtifactTargets(kind, configOf(), body.name, body.destinationIds, body.enabled, Boolean(body.replace));
      return c.json({ data: results });
    } catch (err) {
      return actionError(c, err);
    }
  });

  routes.post("/destinations", async (c) => {
    const body = await c.req.json() as { path?: string };
    if (!body.path?.trim()) {
      return c.json({ error: "path is required" }, 400);
    }
    const current = migrateSkillsConfig(configOf());
    const root = body.path.trim();
    if ((current.projectRoots ?? []).includes(root)) {
      return c.json({ data: persistArtifactConfig(storage, kind, current), info: "already present" });
    }
    const next: SkillsConfig = {
      ...current,
      projectRoots: [...(current.projectRoots ?? []), root],
    };
    return c.json({ data: persistArtifactConfig(storage, kind, next) });
  });

  routes.get("/:name", (c) => {
    const name = c.req.param("name");
    const detail = readArtifactDetail(kind, configOf(), name);
    if (!detail) return c.json({ error: "not found" }, 404);
    return c.json({ data: detail });
  });

  return routes;
}

function actionError(c: { json: (body: unknown, status?: number) => Response }, err: unknown) {
  if (err instanceof SkillActionError) {
    return c.json({ error: err.message, status: err.installStatus }, err.status as 400 | 404 | 409);
  }
  const message = err instanceof Error ? err.message : "artifact action failed";
  return c.json({ error: message }, 500);
}
