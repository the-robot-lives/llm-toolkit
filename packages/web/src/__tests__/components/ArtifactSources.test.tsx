import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ArtifactSources } from "../../components/ArtifactSources.tsx";
const state = () => ({ skills: { configured: [], effective: ["/defaults/skills"], defaults: ["/defaults/skills"], warnings: [], catalogs: [] }, agents: { configured: ["/agents/one", "/agents/two"], effective: ["/agents/one", "/agents/two"], defaults: [], warnings: [] }, commands: { configured: [], effective: ["/defaults/commands"], defaults: ["/defaults/commands"], warnings: [] } });
let current: ReturnType<typeof state>; let writes: unknown[];
beforeEach(() => {
  current = state(); writes = [];
  vi.stubGlobal("fetch", vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith("/catalog/preview")) return Promise.resolve({ ok: true, json: async () => ({ data: { root: "/defaults/skills", catalogFile: "/defaults/skills/catalog.yaml", token: "preview", yaml: "version: 1\nskills:\n  nested:\n    path: category/nested\n", entries: [{ name: "nested", path: "category/nested" }], errors: [] } }) });
    if (url.endsWith("/catalog/create")) { writes.push(JSON.parse(String(options?.body))); return Promise.resolve({ ok: true, json: async () => ({ data: { catalogFile: "/defaults/skills/catalog.yaml" } }) }); }
    if (options?.method === "PATCH") { const body = JSON.parse(String(options.body)); writes.push(body); for (const kind of ["skills", "agents", "commands"] as const) { current[kind].configured = body[kind]; current[kind].effective = body[kind].length ? body[kind] : current[kind].defaults; } }
    return Promise.resolve({ ok: true, json: async () => ({ data: current }) });
  }));
});
describe("Settings artifact sources", () => {
  test("shows defaults, preserves them on first add, orders independent lists and saves only source arrays", async () => {
    render(<ArtifactSources />); await screen.findByDisplayValue("/defaults/skills");
    expect(screen.getByLabelText("skills source 1")).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Add skills folder" }));
    expect(screen.getByLabelText("skills source 1")).toHaveValue("/defaults/skills");
    fireEvent.change(screen.getByLabelText("skills source 2"), { target: { value: "/custom/skills" } });
    fireEvent.click(screen.getByRole("button", { name: "Move agents source 2 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Save source folders" }));
    await screen.findByText(/Source folders saved/);
    expect(writes[0]).toEqual({ skills: ["/defaults/skills", "/custom/skills"], agents: ["/agents/two", "/agents/one"], commands: [] });
  });
  test("requires preview before explicit catalog creation", async () => {
    render(<ArtifactSources />); fireEvent.click(await screen.findByRole("button", { name: "Preview catalog for /defaults/skills" }));
    await screen.findByRole("region", { name: "Catalog preview" }); expect(writes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Create catalog.yaml" }));
    await waitFor(() => expect(writes).toEqual([{ root: "/defaults/skills", token: "preview" }]));
  });
});
