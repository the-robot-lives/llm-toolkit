import { Hono } from "hono";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DeleteResult,
  ListMemoriesResult,
  MemoryDetail,
  ProjectSummary,
  SearchHit,
  WriteResult,
} from "./memory-types.ts";

// Memory root overridable for tests; defaults to the real Claude projects dir.
export function memoryRoot(): string {
  return process.env.CLAUDE_MEMORY_ROOT ?? join(process.env.HOME ?? "", ".claude", "projects");
}

type MemoryNative = {
  listProjects(root: string): Promise<ProjectSummary[]>;
  listMemories(root: string, project: string): Promise<ListMemoriesResult>;
  readMemory(root: string, project: string, slug: string): Promise<MemoryDetail>;
  searchMemories(root: string, query: string, project?: string): Promise<SearchHit[]>;
  createMemory(
    root: string,
    project: string,
    input: { slug: string; name?: string; description?: string; type?: string; body: string },
  ): Promise<WriteResult>;
  updateMemory(
    root: string,
    project: string,
    slug: string,
    input: { content?: string; name?: string; description?: string; type?: string; body?: string; sync_index?: boolean },
  ): Promise<WriteResult>;
  deleteMemory(root: string, project: string, slug: string): Promise<DeleteResult>;
};

let cached: MemoryNative | null | undefined;

/**
 * Lazily require the napi addon so the API boots (and every non-memory route
 * works) even when the native module has not been built yet.
 * Returns null (and callers respond 503) when the addon is missing.
 */
export function loadMemoryNative(): MemoryNative | null {
  if (cached !== undefined) return cached;
  try {
    const nativeDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "native");
    const require = createRequire(import.meta.url);
    // Require the platform binary directly — the generated index.js loader
    // resolves __dirname/require() incorrectly under this package's ESM mode.
    const binary = join(nativeDir, `claude-memory.${process.platform}-${process.arch}.node`);
    const entry = existsSync(binary) ? binary : nativeDir;
    cached = require(entry) as MemoryNative;
  } catch {
    cached = null;
  }
  return cached;
}

/** REST error mapping per contract: NOT_FOUND/NO_PROJECT → 404, EXISTS → 409, INVALID_SLUG → 400, IO → 500. */
function statusFor(code: string): 400 | 404 | 409 | 500 {
  switch (code) {
    case "NOT_FOUND":
    case "NO_PROJECT":
      return 404;
    case "EXISTS":
      return 409;
    case "INVALID_SLUG":
      return 400;
    default:
      return 500;
  }
}

function errorResponse(c: any, e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  const match = /^MEMORY_([A-Z_]+):\s([\s\S]*)$/.exec(message);
  if (!match) return c.json({ error: "IO", detail: message }, 500);
  return c.json({ error: match[1], detail: match[2] }, statusFor(match[1]));
}

export function createMemoryRoutes(): Hono {
  const routes = new Hono();

  const native = () => {
    const mod = loadMemoryNative();
    if (!mod) throw new Error("IO: claude-memory native addon is not built — run `pnpm build:memory-native`");
    return mod;
  };

  // GET /projects → ProjectSummary[]
  routes.get("/projects", async (c) => {
    try {
      return c.json(await native().listProjects(memoryRoot()));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  // GET /search?query=…&project=… → SearchHit[]
  routes.get("/search", async (c) => {
    const query = c.req.query("query");
    if (!query) return c.json({ error: "INVALID_SLUG", detail: "query is required" }, 400);
    try {
      return c.json(await native().searchMemories(memoryRoot(), query, c.req.query("project") ?? undefined));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  // GET /:project/memories → { indexRaw, entries }
  routes.get("/:project/memories", async (c) => {
    const project = decodeURIComponent(c.req.param("project"));
    try {
      return c.json(await native().listMemories(memoryRoot(), project));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  // GET /:project/memories/:slug → MemoryDetail
  routes.get("/:project/memories/:slug", async (c) => {
    const project = decodeURIComponent(c.req.param("project"));
    const slug = decodeURIComponent(c.req.param("slug"));
    try {
      return c.json(await native().readMemory(memoryRoot(), project, slug));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  // POST /:project/memories (body: { slug, name?, description?, type?, body }) → { slug, indexUpdated }
  routes.post("/:project/memories", async (c) => {
    const project = decodeURIComponent(c.req.param("project"));
    const body = await c.req.json<{ slug?: string; name?: string; description?: string; type?: string; body?: string }>();
    if (!body.slug || typeof body.slug !== "string") {
      return c.json({ error: "INVALID_SLUG", detail: "slug is required" }, 400);
    }
    try {
      return c.json(
        await native().createMemory(memoryRoot(), project, {
          slug: body.slug,
          name: body.name ?? undefined,
          description: body.description ?? undefined,
          type: body.type ?? undefined,
          body: body.body ?? "",
        }),
      );
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  // PATCH /:project/memories/:slug (body: { content? } | { name?/description?/type?/body?, syncIndex? })
  routes.patch("/:project/memories/:slug", async (c) => {
    const project = decodeURIComponent(c.req.param("project"));
    const slug = decodeURIComponent(c.req.param("slug"));
    const body = await c.req.json<{
      content?: string;
      name?: string;
      description?: string;
      type?: string;
      body?: string;
      syncIndex?: boolean;
    }>();
    try {
      return c.json(
        await native().updateMemory(memoryRoot(), project, slug, {
          content: body.content ?? undefined,
          name: body.name ?? undefined,
          description: body.description ?? undefined,
          type: body.type ?? undefined,
          body: body.body ?? undefined,
          sync_index: body.syncIndex ?? undefined,
        }),
      );
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  // DELETE /:project/memories/:slug → { slug, fileDeleted, indexLinesRemoved }
  routes.delete("/:project/memories/:slug", async (c) => {
    const project = decodeURIComponent(c.req.param("project"));
    const slug = decodeURIComponent(c.req.param("slug"));
    try {
      return c.json(await native().deleteMemory(memoryRoot(), project, slug));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  return routes;
}
