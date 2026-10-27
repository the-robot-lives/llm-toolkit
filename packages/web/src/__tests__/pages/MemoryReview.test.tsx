import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { MemoryReview } from "../../pages/MemoryReview.js";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("../../hooks/useApi.js", () => ({ apiFetch, useLlmProfiles: () => ({ data: { profiles: [{ id: "model", name: "Local model", model: "local" }], defaultProfileId: "model" }, loading: false }) }));
vi.mock("../../components/MemoryConnection.js", () => ({ MemoryConnection: ({ onChange }: { onChange: (status: unknown) => void }) => {
  React.useEffect(() => { onChange({ connected: true, writeEnabled: true }); }, [onChange]); return <div>Memory connected</div>;
} }));
const initial = {
  id: "draft", conversationId: "conversation", title: "Release discussion", profileId: "model", createdAt: "",
  coverage: { includedMessages: 2, totalMessages: 3, includedCharacters: 120000, totalCharacters: 150000, partial: true },
  candidates: [1, 2].map((n) => ({ id: `c${n}`, content: `Memory content ${n}`, summary: `Summary ${n}`, context: `Context ${n}`, valence: 0, arousal: 0.5, dominance: 0.5, enabled: true, status: "draft", evidence: [{ messageId: `m${n}`, excerpt: `Original source ${n}` }] })),
};
function view() { return render(<MemoryRouter initialEntries={["/thread/conversation/memories"]}><Routes><Route path="/thread/:id/memories" element={<MemoryReview />} /></Routes></MemoryRouter>); }
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
describe("Memory bulk review", () => {
  test("scans explicitly, edits context and arousal, and sends only enabled selection intent on commit", async () => {
    apiFetch.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/scan")) return { data: structuredClone(initial) };
      if (path.endsWith("/commit")) {
        const body = JSON.parse(String(options?.body));
        return { data: { ...initial, candidates: body.candidates.map((candidate: { enabled: boolean }) => ({ ...candidate, status: candidate.enabled ? "committed" : "draft" })) } };
      }
      return { data: null };
    });
    view();
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan conversation" })).not.toBeDisabled());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Scan conversation" }));
    await screen.findByText("Review 2 extracted memories");
    expect(screen.getByText(/Partial scan/)).toBeInTheDocument();
    expect(screen.getByText("Original source 1")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Memory 1"), { target: { value: "User-approved edit" } });
    fireEvent.change(screen.getByLabelText("Context 1"), { target: { value: "Edited situation" } });
    fireEvent.change(screen.getByLabelText("arousal 1"), { target: { value: "0.8" } });
    fireEvent.click(screen.getByRole("button", { name: "Select none" }));
    expect(screen.getByRole("button", { name: "Commit to memory" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Include memory 1"));
    fireEvent.change(screen.getByLabelText("Memory 2"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("arousal 2"), { target: { value: "2" } });
    expect(screen.getByRole("button", { name: "Commit to memory" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Commit to memory" }));
    await screen.findByText("Committed ✓");
    const [, request] = apiFetch.mock.calls.find((call) => String(call[0]).endsWith("/commit"))!;
    const body = JSON.parse(request.body);
    expect(body.candidates[0]).toMatchObject({ content: "User-approved edit", context: "Edited situation", arousal: 0.8, enabled: true });
    expect(body.candidates[1].enabled).toBe(false);
    expect(screen.getByLabelText("Memory 1")).toBeDisabled();
  });
  test("restores edits after navigation, validates ranges, and confirms before replacing a review", async () => {
    apiFetch.mockResolvedValue({ data: structuredClone(initial) });
    const first = view();
    await screen.findByText("Review 2 extracted memories");
    fireEvent.change(screen.getByLabelText("Context 1"), { target: { value: "Kept across navigation" } });
    fireEvent.click(screen.getByLabelText("Include memory 2"));
    first.unmount(); view();
    await screen.findByText("Review 2 extracted memories");
    expect(screen.getByLabelText("Context 1")).toHaveValue("Kept across navigation");
    expect(screen.getByLabelText("Include memory 2")).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("arousal 1"), { target: { value: "2" } });
    expect(screen.getByRole("button", { name: "Commit to memory" })).toBeDisabled();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const count = apiFetch.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
    expect(confirm).toHaveBeenCalled(); expect(apiFetch.mock.calls.length).toBe(count);
    confirm.mockRestore();
  });
  test("keeps failed and held memories editable after a partial commit", async () => {
    apiFetch.mockImplementation(async (path: string) => path.endsWith("/commit") ? { data: { ...initial, candidates: [{ ...initial.candidates[0], status: "committed" }, { ...initial.candidates[1], status: "quarantined", error: "Held for review. Draft retained." }] } } : { data: structuredClone(initial) });
    view();
    await screen.findByText("Review 2 extracted memories");
    fireEvent.click(screen.getByRole("button", { name: "Commit to memory" }));
    await screen.findByText("Held for review. Draft retained.");
    expect(screen.getByLabelText("Memory 1")).toBeDisabled();
    expect(screen.getByLabelText("Memory 2")).not.toBeDisabled();
    expect(screen.getByText(/1 selected memories still need attention/)).toBeInTheDocument();
  });
  test("offers an explicit confirmed new review after changing the memory connection", async () => {
    apiFetch.mockResolvedValue({ data: { ...initial, targetConnectionId: "previous-connection" } });
    view();
    await screen.findByText("Review 2 extracted memories");
    expect(screen.getByRole("button", { name: "Commit to memory" })).toBeDisabled();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Start new review for this connection" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("previous connection remain in that store"));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });
});
