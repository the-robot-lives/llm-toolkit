import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

  test("lists skills in the selected catalog", async () => {
    renderSkills();
    await waitFor(() => {
      expect(screen.getByText("Agent Architect")).toBeInTheDocument();
    });
    expect(screen.getByText("agent-architect")).toBeInTheDocument();
  });
});
