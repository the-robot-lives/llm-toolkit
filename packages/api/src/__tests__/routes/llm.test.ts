import { beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { createLlmRoutes } from "../../routes/llm.ts";
import { LlmService, profileToLlmConfig } from "../../services/llm.ts";
import type { StorageService } from "../../services/storage.ts";
import type { LlmProfile } from "@llm-toolkit/shared";

const { listModels, construct } = vi.hoisted(() => ({ listModels: vi.fn(), construct: vi.fn() }));
vi.mock("openai", () => ({ default: class {
  models = { list: listModels };
  constructor(options: unknown) { construct(options); }
} }));

const saved: LlmProfile = {
  id: "saved", name: "Alibaba", provider: "alibaba", model: "qwen3.8-flash", local: false,
  baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", apiKey: "test-stored-credential",
};
const setSetting = vi.fn();
const storage = {
  getSetting: () => JSON.stringify({ llmProfiles: [saved] }), setSetting,
} as unknown as StorageService;
const app = new Hono().route("/llm", createLlmRoutes(new LlmService(), storage));
const request = (body: unknown) => app.request("/llm/test-profile", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  listModels.mockResolvedValue([{ id: "qwen-max" }, { id: "qwen-flash" }]);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    success: true, output: { total: 2, models: [{ model: "qwen-max" }, { model: "qwen-flash" }] },
  }), { status: 200 })));
});

describe("draft profile discovery", () => {
  test("tests unsaved Alibaba settings and returns models without persisting", async () => {
    const response = await request({ profile: { ...saved, id: "not-saved", model: "", apiKey: "draft-credential" } });
    expect(await response.json()).toEqual({ ok: true, models: ["qwen-flash", "qwen-max"] });
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ headers: { Authorization: "Bearer draft-credential" } }));
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("/api/v1/models?");
    expect(setSetting).not.toHaveBeenCalled();
  });

  test("resolves masked credentials for the same saved connection", async () => {
    expect((await request({ profile: { ...saved, apiKey: "tes...tial", model: "" } })).status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ headers: { Authorization: `Bearer ${saved.apiKey}` } }));
  });

  test.each([
    { baseUrl: "https://different.example/v1" }, { provider: "openai-compatible" }, { id: "new" },
  ])("does not reuse a masked credential for a changed connection %j", async (change) => {
    const response = await request({ profile: { ...saved, ...change, apiKey: "tes...tial" } });
    expect(response.status).toBe(400);
    expect(construct).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
  });

  test("reports authentication failures instead of a false successful empty list", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("upstream echoed secret", { status: 401 }));
    const result = await (await request({ id: saved.id })).json();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 401");
    expect(result.error).not.toContain("secret");
  });

  test("rejects invalid draft provider", async () => {
    expect((await request({ profile: { ...saved, provider: "invalid" } })).status).toBe(400);
  });

  test("paginates the native Alibaba text model catalog", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { total: 2, models: [{ model: "page-one" }] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { total: 2, models: [{ model: "page-two" }] } })));
    expect(await (await request({ id: saved.id })).json()).toEqual({ ok: true, models: ["page-one", "page-two"] });
    expect(String(vi.mocked(fetch).mock.calls[1][0])).toContain("page_no=2");
  });

  test("uses OpenAI discovery for Coding Plan and generic compatible profiles", async () => {
    const response = await request({ profile: { ...saved, baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1" } });
    expect(await response.json()).toEqual({ ok: true, models: ["qwen-flash", "qwen-max"] });
    expect(construct).toHaveBeenCalledWith(expect.objectContaining({ baseURL: "https://coding-intl.dashscope.aliyuncs.com/v1" }));
    expect(fetch).not.toHaveBeenCalled();
    listModels.mockRejectedValue(Object.assign(new Error("invalid key"), { status: 401 }));
    expect(await (await request({ profile: { ...saved, provider: "openai-compatible" } })).json()).toMatchObject({ ok: false });
  });

  test("supports Alibaba environment fallback and default token endpoint", () => {
    vi.stubEnv("ALIBABA_API_KEY", "environment-credential");
    expect(profileToLlmConfig({ ...saved, apiKey: undefined, baseUrl: undefined })).toMatchObject({
      apiKey: "environment-credential", baseUrl: saved.baseUrl, apiType: "openai",
    });
    vi.unstubAllEnvs();
  });
});
