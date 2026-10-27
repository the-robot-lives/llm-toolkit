import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Projects } from "../../pages/Projects.js";
const remote = { id: "project-id", slug: "toolkit", name: "Toolkit", organizationId: "org-id", organizationSlug: "robot", status: "active" };
const project = { projectPath: "tobor:robot/toolkit", title: null, displayName: "toolkit", description: null, tags: [], conversationCount: 3, lastActive: "2026-10-27", scope: { organization: "robot", project: "toolkit" }, locations: [{ path: "/repo", repositoryRoot: "/repo", canonicalRoot: "/repo", isWorktree: false }, { path: "/repo/.claude/worktrees/task", repositoryRoot: "/repo/.claude/worktrees/task", canonicalRoot: "/repo", isWorktree: true }] };
const response = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });
beforeEach(() => vi.restoreAllMocks());
function mock() {
  const fetcher = vi.fn((url: string) => {
    if (url.endsWith("/tobor/status")) return response({ connected: true, loginPending: false, connectionId: "one" });
    if (url.endsWith("/tobor/projects")) return response({ data: [remote] });
    if (url.endsWith("/tobor/link")) return response({ ok: true });
    return response([project]);
  });
  vi.stubGlobal("fetch", fetcher); return fetcher;
}
describe("Projects Tobor grouping", () => {
  test("shows scoped repository/worktree grouping and accessible remote identity", async () => {
    mock(); render(<MemoryRouter><Projects /></MemoryRouter>);
    expect(await screen.findByText("2 locations · 1 worktrees")).toBeInTheDocument();
    const link = await screen.findByRole("link", { name: "Open Tobor project · Toolkit" });
    expect(link).toHaveAttribute("href", "https://agentonomi.com/app/robot/projects/project-id");
    expect(screen.getByText("robot / toolkit")).toBeInTheDocument();
  });
  test("links canonical repository once, not its individual worktree", async () => {
    const fetcher = mock(); render(<MemoryRouter><Projects /></MemoryRouter>);
    const picker = await screen.findByLabelText("Repository to link");
    expect(picker.querySelectorAll("option")).toHaveLength(2);
    fireEvent.change(picker, { target: { value: "/repo" } });
    fireEvent.change(screen.getByLabelText("Tobor project to link"), { target: { value: "project-id" } });
    fireEvent.click(screen.getByRole("button", { name: "Link repository" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/tobor/link", expect.objectContaining({ method: "POST", body: '{"repositoryPath":"/repo","projectId":"project-id"}' })));
    expect(await screen.findByText("Repository linked. Its worktrees inherit this project unless explicitly overridden.")).toBeInTheDocument();
  });
});
