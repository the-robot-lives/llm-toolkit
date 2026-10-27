import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Skills } from "../../pages/Skills.tsx";

const catalog = {
  sources: [{ path: "/tmp/skills", categoriesFile: "/tmp/skills/categories.yaml", skillCount: 2 }],
  destinations: [{ id: "global-claude", label: "Global Claude", path: "/tmp/.claude/skills", kind: "global", provider: "claude" }],
  providers: ["claude"],
  globalEnabled: true,
  projectRoots: [],
  categories: [
    { id: "agents", title: "AI & Agent Engineering", description: "Agents", skills: ["agent-architect"] },
  ],
  skills: [
    {
      name: "agent-architect",
      title: "Agent Architect",
      description: "Design agents",
      path: "/tmp/skills/agent-architect",
      sourceRoot: "/tmp/skills",
      categoryId: "agents",
      installs: [{ destinationId: "global-claude", status: "enabled", linkPath: "/tmp/.claude/skills/agent-architect" }],
    },
  ],
  discoveredFolders: ["/tmp/skills"],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo) => {
    const url = String(input);
    if (url.includes("/config")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: { skills: { sourceFolders: [], providers: ["claude"], globalEnabled: true, projectRoots: [] } },
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: catalog }),
    });
  }));
});

function renderSkills(path = "/skills") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/skills" element={<Skills />} />
        <Route path="/skills/:name" element={<Skills />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Skills", () => {
  test("renders page heading and category rail", async () => {
    renderSkills();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Skills" })).toBeInTheDocument();
    });
    expect(screen.getByRole("navigation", { name: "Skill categories" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AI & Agent Engineering/ })).toBeInTheDocument();
  });

  test("shows catalog provenance and skipped-entry warnings", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo) => Promise.resolve({ ok: true, json: () => Promise.resolve(String(input).includes("/config") ? { data: { skills: { sourceFolders: ["/tmp/skills"], providers: ["claude"] } } } : { data: { ...catalog, sources: [{ path: "/tmp/skills", catalogFile: "/tmp/skills/catalog.yaml", skillCount: 1, warnings: ["missing: catalog path is missing; entry skipped."] }] } }) })));
    renderSkills();
    await screen.findByRole("region", { name: "Skill catalogs" });
    expect(screen.getByText("/tmp/skills/catalog.yaml")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("entry skipped");
  });
  test("refreshes selected detail after source changes and sends the displayed path with actions", async () => {
    let active = "/roots/a/agent-architect";
    const fetcher = vi.fn((input: RequestInfo, options?: RequestInit) => {
      const url = String(input);
      if (url.includes("/config")) return Promise.resolve({ ok: true, json: async () => ({ data: { skills: { sourceFolders: ["/roots/a", "/roots/b"], providers: ["claude"] } } }) });
      if (url.endsWith("/apply")) return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
      const row = { ...catalog.skills[0], path: active, installs: [{ destinationId: "global-claude", status: "disabled", linkPath: "/target/agent-architect" }] };
      if (url.endsWith("/agent-architect")) return Promise.resolve({ ok: true, json: async () => ({ data: { ...row, skillMarkdown: "# Agent", files: [] } }) });
      return Promise.resolve({ ok: true, json: async () => ({ data: { ...catalog, skills: [row] } }) });
    });
    vi.stubGlobal("fetch", fetcher);
    renderSkills("/skills/agent-architect"); await screen.findByText("/roots/a/agent-architect");
    active = "/roots/b/agent-architect"; window.dispatchEvent(new Event("artifact-sources-changed"));
    await screen.findByText("/roots/b/agent-architect"); expect(screen.queryByText("/roots/a/agent-architect")).not.toBeInTheDocument();
    const detail = screen.getByRole("complementary"); fireEvent.click(within(detail).getByRole("button", { name: "Global Claude disabled" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url, options]) => String(url).endsWith("/apply") && JSON.parse(String(options?.body)).expectedSource === active)).toBe(true));
  });
  test("lists skills in the selected catalog", async () => {
    renderSkills();
    await waitFor(() => {
      expect(screen.getByText("Agent Architect")).toBeInTheDocument();
    });
    expect(screen.getByText("agent-architect")).toBeInTheDocument();
  });
});
