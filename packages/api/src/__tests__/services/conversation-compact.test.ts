import { describe, expect, test, vi } from "vitest";
import { compactConversationDraft, validateCompactRequest } from "../../services/conversation-compact.ts";
import type { LlmService } from "../../services/llm.ts";
const messages = [{ role: "user", content: "Please fix it" }, { role: "assistant", content: "Observed failure; not yet fixed" }, { role: "user", content: "Keep that uncertainty" }];
function llm(content: string) { const complete = vi.fn(async () => ({ content })); return { getProfile: () => ({ id: "p" }), resolveProvider: async () => ({ complete }) } as unknown as LlmService; }
describe("conversation compaction", () => {
  test("compaction cannot silently join non-contiguous sections or truncate an oversized request", () => {
    expect(() => validateCompactRequest({ messages, indices: [0, 2], profileId: "p", mode: "compact" })).toThrow("contiguous");
    expect(() => validateCompactRequest({ messages: [{ role: "user", content: "x".repeat(120_001) }], indices: [0], profileId: "p", mode: "compact" })).toThrow("no content has been truncated");
  });
  test("a generated summary cannot let the model select privileged roles and archives all selected originals", async () => {
    const result = await compactConversationDraft(llm('{"summary":"The failure is observed but unresolved", "role":"system"}'), { messages, indices: [0, 1, 2], profileId: "p", mode: "compact" });
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].compactionOriginals).toEqual(messages);
    expect(result.warnings.join(" ")).toContain("lossy");
  });
  test("simplification batches IDs and rejects missing/reordered results", async () => {
    await expect(compactConversationDraft(llm('{"messages":[{"id":"1","content":"wrong"},{"id":"0","content":"wrong"}]}'), { messages, indices: [0, 1], profileId: "p", mode: "simplify" })).rejects.toThrow("changed message IDs");
    const result = await compactConversationDraft(llm('{"messages":[{"id":"0","content":"Fix requested"},{"id":"1","content":"Still unresolved"}]}'), { messages, indices: [0, 1], profileId: "p", mode: "simplify" });
    expect(result.simplifications).toEqual([{ index: 0, content: "Fix requested" }, { index: 1, content: "Still unresolved" }]);
  });
});
