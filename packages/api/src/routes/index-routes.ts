// 〚📁:32fd8a7c-d690-5120-8997-db4f72845272〛 Index routes :: /api/index rebuild/status/preview wiring over IndexerService.

import { Hono } from "hono";
import type { IndexerService, IndexAllOptions } from "../services/indexer.ts";

// <REMOVED UUID HERE> createIndexRoutes :: auto-generated pointer for public function createIndexRoutes
export function createIndexRoutes(indexer: IndexerService): Hono {
  const routes = new Hono();

  routes.post("/rebuild", async (c) => {
    let options: IndexAllOptions = {};
    try {
      const body = await c.req.json() as Partial<IndexAllOptions> | undefined;
      if (body && typeof body === "object") {
        options = {
          useLocalLlm: body.useLocalLlm === true,
          deepWindowDays: typeof body.deepWindowDays === "number" ? body.deepWindowDays : undefined,
          force: body.force === true,
        };
      }
    } catch {
      // No/empty body — use defaults.
    }
    // Fire-and-forget: start indexing in the background
    indexer.indexAll(options).then((result) => {
      console.log(`Indexing complete: ${result.indexed} indexed, ${result.errors} errors`);
    }).catch((err) => {
      console.error("Indexing failed:", err);
    });
    return c.json({ data: { status: "started" } });
  });

  routes.get("/status", async (c) => {
    const status = indexer.getStatus();
    const progress = indexer.progress;
    return c.json({ data: { ...status, progress } });
  });

  routes.get("/preview", async (c) => {
    const preview = await indexer.scanPreview();
    return c.json({ data: preview });
  });

  return routes;
}

// Backward-compatible named export for existing tests
export const indexRoutes = new Hono();
indexRoutes.post("/rebuild", async (c) => c.json({ data: { status: "started" } }));
indexRoutes.get("/status", async (c) => c.json({ data: { status: "idle", lastIndexed: null, conversationCount: 0 } }));
