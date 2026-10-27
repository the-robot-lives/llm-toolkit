import { describe, test, expect, vi } from "vitest";
import type { UniversalMessage } from "@llm-toolkit/shared";
import type { StorageService } from "../services/storage.ts";
import type { LlmService } from "../services/llm.ts";
import type { RemoteMemoryService } from "../services/remote-memory.ts";
import { MemoryExtractionService, extractionTranscript, parseMemoryCandidates } from "../services/memory-extraction.ts";
import { createMemoryExtractionRoutes } from "../routes/memory-extraction.ts";

const messages: UniversalMessage[] = [
  { id: "m1", role: "user", timestamp: "", content: [{ type: "text", text: "Prefer additive migrations and keep a rollback path." }] },
  { id: "m2", role: "assistant", timestamp: "", content: [{ type: "text", text: "We agreed to test the release before deploying." }, { type: "thinking", thinking: "private reasoning" }] },
];
const memories = [
  { content: "Prefer additive migrations.", summary: "Migration preference", context: "Release planning", valence: 0, arousal: 0.4, dominance: 0.5, messageIds: ["m1"] },
  { content: "Test releases before deploying.", summary: "Release decision", context: "Release planning", valence: 0.2, arousal: 0.3, dominance: 0.6, messageIds: ["m2"] },
];
function setup() {
  const settings = new Map<string, string>();
  const complete = vi.fn().mockResolvedValue({ content: JSON.stringify({ memories }) });
  const call = vi.fn().mockResolvedValue({ id: "remote-id", status: "ok" });
  const status = vi.fn().mockReturnValue({ connected: true, writeEnabled: true });
  const storage = { getSetting: (key: string) => settings.get(key) ?? null, setSetting: (key: string, value: string) => settings.set(key, value), getConversation: async () => ({ title: "Release conversation" }), getUniversalMessages: async () => messages } as unknown as StorageService;
  const llm = { getProfile: (id: string) => id === "profile" ? { id } : null, resolveProvider: async () => ({ complete }) } as unknown as LlmService;
  const remote = { call, status } as unknown as RemoteMemoryService;
  return { service: new MemoryExtractionService(storage, llm, remote), storage, llm, remote, call, complete, status };
}
describe("Conversation memory review", () => {
  test("scan persists evidence-checked drafts without writing remote memories", async () => {
    const { service, call, complete, storage, llm, remote } = setup();
    const draft = await service.scan("conversation", "profile");
    expect(call).not.toHaveBeenCalled();
    expect(draft.candidates[0].evidence).toEqual([{ messageId: "m1", excerpt: messages[0].content[0].type === "text" ? messages[0].content[0].text : "" }]);
    expect(JSON.stringify(complete.mock.calls[0])).not.toContain("private reasoning");
    expect(new MemoryExtractionService(storage, llm, remote).get("conversation")?.id).toBe(draft.id);
    await expect(service.scan("conversation", "profile")).rejects.toThrow("Confirm replacement");
    complete.mockResolvedValueOnce({ content: "invalid structured result" });
    await expect(service.scan("conversation", "profile", draft.id)).rejects.toThrow();
    expect(service.get("conversation")?.id).toBe(draft.id);
  });
  test("commits only enabled edited candidates with actual mood and stable deduplication keys", async () => {
    const { service, call } = setup();
    const draft = await service.scan("conversation", "profile");
    draft.candidates[0].content = "An edited, approved preference.";
    draft.candidates[0].context = "User reviewed the release discussion.";
    draft.candidates[0].arousal = 0.85;
    draft.candidates[1].enabled = false;
    const result = await service.commit("conversation", draft.id, draft.candidates);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][1]).toMatchObject({ content: "An edited, approved preference.", context: "User reviewed the release discussion.", arousal: 0.85, source_ref: expect.stringContaining(draft.candidates[0].id) });
    expect(JSON.parse(call.mock.calls[0][1].metadata)).toMatchObject({ conversation_id: "conversation", message_ids: ["m1"], reviewed: true });
    expect(result.candidates[1].enabled).toBe(false);
    expect(result.candidates[1].status).toBe("draft");
    await service.commit("conversation", draft.id, draft.candidates);
    expect(call).toHaveBeenCalledTimes(1);
  });
  test("retains partial failures and quarantine, retries only unconfirmed items using the same ref", async () => {
    const { service, call } = setup();
    const draft = await service.scan("conversation", "profile");
    call.mockResolvedValueOnce({ id: "stored", status: "ok" }).mockResolvedValueOnce({ id: null, status: "quarantined" });
    const first = await service.commit("conversation", draft.id, draft.candidates);
    expect(first.candidates.map((c) => c.status)).toEqual(["committed", "quarantined"]);
    const ref = call.mock.calls[1][1].source_ref;
    call.mockRejectedValueOnce(new Error("secret upstream error"));
    const second = await service.commit("conversation", draft.id, first.candidates);
    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[2][1].source_ref).toBe(ref);
    expect(second.candidates[1].content).toBe(memories[1].content);
    expect(second.candidates[1].error).not.toContain("secret upstream");
    call.mockResolvedValueOnce({ id: "already-stored", status: "duplicate" });
    const third = await service.commit("conversation", draft.id, second.candidates);
    expect(third.candidates[1].status).toBe("committed");
  });
  test("rejects forged ids and invalid emotional ranges before any remote write", async () => {
    const { service, call, status } = setup();
    const draft = await service.scan("conversation", "profile");
    const invalid = structuredClone(draft.candidates);
    invalid[0].arousal = 1.1;
    await expect(service.commit("conversation", draft.id, invalid)).rejects.toThrow("Invalid emotional");
    invalid[0].arousal = 0.5; invalid[0].id = "forged";
    await expect(service.commit("conversation", draft.id, invalid)).rejects.toThrow("Unknown");
    status.mockReturnValue({ connected: true, writeEnabled: false });
    await expect(service.commit("conversation", draft.id, draft.candidates)).rejects.toThrow("editing enabled");
    expect(call).not.toHaveBeenCalled();
  });
  test("serializes conversation operations to prevent double commits", async () => {
    const { service, call } = setup();
    const draft = await service.scan("conversation", "profile");
    draft.candidates[1].enabled = false;
    let done!: (value: unknown) => void;
    call.mockImplementationOnce(() => new Promise((resolve) => { done = resolve; }));
    const pending = service.commit("conversation", draft.id, draft.candidates);
    await expect(service.commit("conversation", draft.id, draft.candidates)).rejects.toThrow("already running");
    done({ id: "stored", status: "ok" }); await pending;
    expect(call).toHaveBeenCalledTimes(1);
  });
  test("reports partial transcript coverage and rejects hallucinated evidence", () => {
    const transcript = extractionTranscript([{ ...messages[0], content: [{ type: "text", text: "a".repeat(130_000) }] }, messages[1]]);
    expect(transcript.coverage).toMatchObject({ includedCharacters: 120_000, totalCharacters: 130_047, partial: true });
    expect(() => parseMemoryCandidates(JSON.stringify({ memories: [{ ...memories[0], messageIds: ["invented"] }] }), messages.map((m) => ({ id: m.id, text: "source" })))).toThrow("evidence");
    expect(() => parseMemoryCandidates(JSON.stringify({ memories: [{ ...memories[0], arousal: -1 }] }), [{ id: "m1", text: "source" }])).toThrow("emotional");
  });
  test("route rejects foreign origin and does not leak model failures", async () => {
    const { service, complete } = setup();
    const routes = createMemoryExtractionRoutes(service);
    const foreign = await routes.request("http://localhost:3100/conversation/scan", { method: "POST", headers: { Origin: "https://foreign.example", "Content-Type": "application/json" }, body: '{"profileId":"profile"}' });
    expect(foreign.status).toBe(403);
    complete.mockRejectedValue(new Error("private upstream token"));
    const failure = await routes.request("http://localhost:3100/conversation/scan", { method: "POST", headers: { Origin: "http://localhost:3100", "Content-Type": "application/json" }, body: '{"profileId":"profile"}' });
    expect(failure.status).toBe(502);
    expect(await failure.text()).not.toContain("private upstream token");
  });
});
