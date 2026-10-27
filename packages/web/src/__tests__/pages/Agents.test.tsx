import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Agents } from "../../pages/Agents.tsx";
import { groupAgentFamilies } from "../../pages/agentFamilies.ts";

const row = (name: string, extra = {}) => ({ name, path: `/agents/${name}.md`, sourceRoot: "/agents", categoryId: "all", installs: [], ...extra });
const skills = [row("npl-coder"), row("npl-coder-glm-flash", { parent: "npl-coder", variant: { provider: "zai", model: "glm-5.3-flash" } }), row("npl-coder-deepseek", { parent: "npl-coder", variant: { provider: "alibaba", model: "deepseek-v4-pro" } }), row("independent")];
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo) => Promise.resolve({ ok: true, json: () => Promise.resolve(String(input).includes("/config") ? { data: { agents: { sourceFolders: [], providers: ["claude"] } } } : { data: { skills, categories: [], destinations: [], providers: ["claude"], discoveredFolders: [] } }) })));
});

describe("agent families", () => {
  test("collapses variants by default and expands individual agents", async () => {
    render(<MemoryRouter><Agents /></MemoryRouter>);
    const expand = await screen.findByRole("button", { name: "Expand npl-coder variants (2)" });
    expect(screen.queryByText("npl-coder-glm-flash")).not.toBeInTheDocument();
    expect(screen.getAllByText("independent").length).toBeGreaterThan(0);
    fireEvent.click(expand);
    expect(screen.getAllByText("npl-coder-glm-flash").length).toBeGreaterThan(0);
    expect(screen.getByText("glm-5.3-flash")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse npl-coder variants (2)" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Collapse npl-coder variants (2)" }));
    expect(screen.queryByText("npl-coder-glm-flash")).not.toBeInTheDocument();
  });
  test("searching provider reveals matching variants under their parent", async () => {
    render(<MemoryRouter><Agents /></MemoryRouter>);
    await screen.findByRole("button", { name: "Expand npl-coder variants (2)" });
    fireEvent.change(screen.getByPlaceholderText("Filter by name or description…"), { target: { value: "alibaba" } });
    await waitFor(() => expect(screen.getAllByText("npl-coder-deepseek").length).toBeGreaterThan(0));
    expect(screen.queryByText("npl-coder-glm-flash")).not.toBeInTheDocument();
    expect(screen.getAllByText("npl-coder").length).toBeGreaterThan(0);
  });
  test("generic variants have an expandable synthetic parent without a nonexistent agent action", async () => {
    const generic = [row("agent-groq-haiku", { parent: "agent", variant: { provider: "groq", model: "gpt-oss-20b", tier: "haiku" } })];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo) => Promise.resolve({ ok: true, json: () => Promise.resolve(String(input).includes("/config") ? { data: { agents: { sourceFolders: [], providers: ["claude"] } } } : { data: { skills: generic, categories: [], destinations: [], providers: ["claude"], discoveredFolders: [] } }) })));
    render(<MemoryRouter><Agents /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Expand agent variants (1)" }));
    expect(screen.getByText("agent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "agent" })).not.toBeInTheDocument();
    expect(screen.getAllByText("agent-groq-haiku").length).toBeGreaterThan(0);
  });
  test("missing parents become synthetic families, cycles and unannotated suffixes stay visible", () => {
    const rows = [row("variant", { parent: "missing" }), row("a", { parent: "b" }), row("b", { parent: "a" }), row("legacy-glm")];
    const groups = groupAgentFamilies(rows, rows);
    expect(groups.find((group) => group.name === "missing")).toMatchObject({ parent: undefined, children: [{ name: "variant" }] });
    expect(groups.filter((group) => group.children.length === 0).map((group) => group.name)).toEqual(["a", "b", "legacy-glm"]);
  });
});
