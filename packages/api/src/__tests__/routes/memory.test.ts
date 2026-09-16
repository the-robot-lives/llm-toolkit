import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryRoutes, loadMemoryNative } from "../../routes/memory.ts";

// Route tests are gated on the built native addon; skip with a clear message
// when `pnpm build:memory-native` has not been run.
const native = loadMemoryNative();
const d = describe;
const suite = native ? d : d.skip;

let tempDir = "";
let app = new Hono();

beforeAll(() => {
  if (!native) return;
  tempDir = mkdtempSync(join(tmpdir(), "llm-toolkit-memory-routes-"));
  cpSync(
    join(fileURLToPath(new URL("../../../../../", import.meta.url)), "crates", "claude-memory", "tests", "golden", "projects"),
    join(tempDir, "projects"),
    { recursive: true },
  );
  process.env.CLAUDE_MEMORY_ROOT = join(tempDir, "projects");
  app.route("/api/memory", createMemoryRoutes());
});

afterAll(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

suite("memory routes", () => {
  test("addon present", () => {
    expect(native, "native addon missing — run `pnpm build:memory-native`").toBeTruthy();
  });

  test("GET /projects lists fixture project", async () => {
    const res = await app.request("/api/memory/projects");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((p: { slug: string }) => p.slug)).toContain("-Users-test-Demo");
    const project = body.find((p: { slug: string }) => p.slug === "-Users-test-Demo");
    expect(project.indexPresent).toBe(true);
    expect(project.memoryCount).toBe(4);
  });

  test("GET /:project/memories returns index + sorted entries", async () => {
    const res = await app.request("/api/memory/-Users-test-Demo/memories");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.indexRaw).toContain("# Memory Index");
    expect(body.entries.map((e: { slug: string }) => e.slug)).toEqual([
      "alpha-memory",
      "beta-feedback",
      "gamma-reference",
      "unindexed-note",
    ]);
  });

  test("GET /:project/memories/:slug returns detail; 404 on miss", async () => {
    const ok = await app.request("/api/memory/-Users-test-Demo/memories/alpha-memory");
    expect(ok.status).toBe(200);
    const detail = await ok.json();
    expect(detail.title).toBe("alpha-memory");
    expect(detail.frontmatterRaw).toContain("name: alpha-memory");
    expect(detail.body).toContain("XYZZY-ALPHA");

    const miss = await app.request("/api/memory/-Users-test-Demo/memories/ghost");
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ error: "NOT_FOUND", detail: "-Users-test-Demo/ghost" });
  });

  test("POST creates memory + index line; duplicate → 409; bad slug → 400", async () => {
    const created = await app.request("/api/memory/-Users-test-Demo/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "route-made", name: "Route Made", description: "via REST", type: "user", body: "hi" }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ slug: "route-made", indexUpdated: true });

    const dup = await app.request("/api/memory/-Users-test-Demo/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "route-made", body: "" }),
    });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe("EXISTS");

    const bad = await app.request("/api/memory/-Users-test-Demo/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "../evil", body: "" }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("INVALID_SLUG");
  });

  test("PATCH updates + syncs index; NO_PROJECT project → 404", async () => {
    const patched = await app.request("/api/memory/-Users-test-Demo/memories/route-made", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "updated hook" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ slug: "route-made", indexUpdated: true });

    const missing = await app.request("/api/memory/-Users-nope/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "x", body: "" }),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("NO_PROJECT");
  });

  test("GET /search returns hits across the project", async () => {
    const res = await app.request("/api/memory/search?query=XYZZY");
    expect(res.status).toBe(200);
    const hits = await res.json();
    expect(hits.length).toBe(4);
    expect(hits[0].field).toBe("body");
  });

  test("DELETE removes file + index lines", async () => {
    const res = await app.request("/api/memory/-Users-test-Demo/memories/route-made", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: "route-made", fileDeleted: true, indexLinesRemoved: 1 });
    const again = await app.request("/api/memory/-Users-test-Demo/memories/route-made", { method: "DELETE" });
    expect(await again.json()).toEqual({ slug: "route-made", fileDeleted: false, indexLinesRemoved: 0 });
  });
});
