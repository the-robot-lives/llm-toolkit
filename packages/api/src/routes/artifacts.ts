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
import { migrateSkillsConfig } from "../services/skills.ts";

export { isArtifactKind };

// ⟦𓋎𓆱𓅯𓋑⟧ createArtifactRoutes :: auto-generated pointer for public function createArtifactRoutes
export function createArtifactRoutes(storage: StorageService, kind: ArtifactKind): Hono {
  const routes = new Hono();
  const configOf = () => {
    const app = loadConfig(storage);
    return resolveKindConfig(kind, app.skills, app[kind]);
  };

  routes.get("/", (c) => {
    const catalog = maskCatalog(scanArtifacts(kind, configOf()));
    return c.json({ data: { ...catalog, [kind]: catalog.items } });
  });

  routes.get("/discover", (c) => {
    return c.json({ data: { folders: discoverArtifactFolders(kind) } });
  });

  routes.post("/enable", async (c) => {
    const body = await c.req.json() as { name?: string; destinationId?: string; destinationIds?: string[]; replace?: boolean };
    const ids = body.destinationIds?.length ? body.destinationIds : body.destinationId ? [body.destinationId] : [];
    if (!body.name || ids.length === 0) {
      return c.json({ error: "name and destinationId(s) are required" }, 400);
    }
    try {
      const results = applyArtifactTargets(kind, configOf(), body.name, ids, true, Boolean(body.replace));
      return c.json({ data: results.length === 1 ? results[0] : results });
    } catch (err) {
      return actionError(c, err);
    }
  });

  routes.post("/disable", async (c) => {
    const body = await c.req.json() as { name?: string; destinationId?: string; destinationIds?: string[] };
    const ids = body.destinationIds?.length ? body.destinationIds : body.destinationId ? [body.destinationId] : [];
    if (!body.name || ids.length === 0) {
      return c.json({ error: "name and destinationId(s) are required" }, 400);
    }
    try {
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
    };
    if (!body.name || !body.destinationIds?.length || typeof body.enabled !== "boolean") {
      return c.json({ error: "name, destinationIds, and enabled are required" }, 400);
    }
    try {
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
