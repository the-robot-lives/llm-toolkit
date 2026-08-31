import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App.tsx";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.includes("/config")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: {
            indexPaths: ["~/.claude/projects"],
            embedding: { provider: "local" },
            server: { port: 3100, host: "localhost" },
          },
        }),
      });
    }
    if (url.includes("/skills") || url.includes("/agents") || url.includes("/commands") || url.includes("/mcp")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: { sources: [], destinations: [], categories: [], skills: [], items: [], discoveredFolders: [] },
        }),
      });
    }
    if (url.includes("/index/status")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { status: "idle", lastIndexed: null, conversationCount: 0 } }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: [], meta: { total: 0, limit: 20 } }),
    });
  }));
});

describe("App routing", () => {
  test("renders Explore at root route '/'", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByPlaceholderText("Search conversations...")).toBeInTheDocument();
  });

  test("renders Explore at '/search' route", async () => {
    render(
      <MemoryRouter initialEntries={["/search"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByPlaceholderText("Search conversations...")).toBeInTheDocument();
  });

  test("renders Explore at '/browse' route", async () => {
    render(
      <MemoryRouter initialEntries={["/browse"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByPlaceholderText("Search conversations...")).toBeInTheDocument();
  });

  test("renders Skills at '/skills' route", async () => {
    render(
      <MemoryRouter initialEntries={["/skills"]}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Skills" })).toBeInTheDocument();
    });
  });

  test("renders Agents at '/agents' route", async () => {
    render(
      <MemoryRouter initialEntries={["/agents"]}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument();
    });
  });

  test("renders Settings at '/settings' route", async () => {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    });
  });
});
