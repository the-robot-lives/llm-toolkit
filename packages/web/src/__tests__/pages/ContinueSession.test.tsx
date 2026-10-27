import { describe, test, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ContinueSession } from "../../pages/ContinueSession.tsx";

const thread = { id: "conv-1", harness: "claude", sourcePath: "/fixture/source.jsonl", projectPath: "/fixture/project", title: "Synthetic conversation", startedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:01Z", messages: [{ id: "m1", role: "user", timestamp: "2026-10-01T00:00:00Z", content: [{ type: "text", text: "Question" }] }, { id: "m2", role: "assistant", timestamp: "2026-10-01T00:00:01Z", content: [{ type: "text", text: "Answer" }] }] };
const valid = { schemaVersion: 1, provider: "codex", compatibilityVersion: "fixture/v1", status: "valid", valid: true, errors: [], warnings: [] };
beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    let data: unknown = [];
    if (url.includes("/universal")) data = thread;
    else if (url.endsWith("/format-capabilities")) data = { targets: [{ harness: "claude", native: true, destinations: ["/fixture/claude"], compatibilityVersion: "fixture" }, { harness: "codex", native: true, destinations: ["/fixture/codex"], compatibilityVersion: "fixture" }] };
    else if (url.endsWith("/clone-preview")) data = { previewId: "p1", targetHarness: "codex", sourcePath: "/fixture/new.jsonl", title: "Copy", projectPath: "/fixture/project", messageCount: 2, jsonl: "{}\n", resumeCommand: "codex resume fixture", report: valid, issues: [] };
    else if (url.endsWith("/clone")) data = { id: "new", sourcePath: "/fixture/new.jsonl", universalPath: "/fixture/new.jsonl.universal.json", resumeCommand: "codex resume fixture", nativeCreated: true, indexed: true };
    else if (url.endsWith("/validate")) data = { ...valid, status: "invalid", valid: false, errors: [{ severity: "error", code: "fixture.invalid", path: "/records/0", message: "Invalid fixture shape" }] };
    return { ok: true, json: async () => ({ data, meta: { total: 0, limit: 200 } }) };
  }));
});
const show = () => render(<MemoryRouter initialEntries={["/thread/conv-1/continue"]}><Routes><Route path="/thread/:id/continue" element={<ContinueSession />} /></Routes></MemoryRouter>);

describe("portable conversation flow", () => {
  test("requires a validated preview and explicit creation", async () => {
    show();
    await screen.findByRole("heading", { name: "Format, snip and clone" });
    fireEvent.change(screen.getByLabelText("Target provider"), { target: { value: "codex" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview and validate native clone" }));
    await screen.findByRole("heading", { name: "Create a new codex conversation" });
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/clone"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Create native clone" }));
    await screen.findByRole("heading", { name: "Native conversation created" });
    expect(vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/clone"))?.[1]?.body).toBe(JSON.stringify({ previewId: "p1" }));
  });
  test("surfaces structural diagnostics without changing a file", async () => {
    show();
    await screen.findByRole("heading", { name: "Format, snip and clone" });
    fireEvent.click(screen.getByRole("button", { name: "Validator" }));
    fireEvent.change(screen.getByLabelText("Conversation content to validate"), { target: { value: "{}" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate content" }));
    await screen.findByText("fixture.invalid");
    expect(screen.getByText("/records/0")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/clone"))).toBe(false);
  });
});
