import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Services } from "../../pages/Services.tsx";

const servicesPayload = {
  services: [
    {
      name: "alpha-mcp",
      source: "user",
      enabled: true,
      autostart: false,
      transport: "stdio",
      command: "npl-alpha",
      args: [],
      status: "stopped",
    },
    {
      name: "beta-daemon",
      source: "project",
      enabled: true,
      autostart: true,
      transport: "http",
      url: "http://localhost:8123",
      status: "running",
      pid: 4242,
      startedAt: "2026-09-01T00:00:00Z",
      uptimeMs: 125000,
    },
  ],
};

const fetchMock = vi.fn((input: RequestInfo, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/api/services")) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(servicesPayload),
    });
  }
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: true, status: "starting" }),
  });
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

describe("Services", () => {
  test("renders a row per service", async () => {
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText("alpha-mcp")).toBeInTheDocument();
    });
    expect(screen.getByText("beta-daemon")).toBeInTheDocument();
    expect(screen.getByText("pid 4242")).toBeInTheDocument();
  });

  test("renders empty-state hint when no services configured", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ services: [] }) })
    ));
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText("No services configured.")).toBeInTheDocument();
    });
    expect(screen.getByText(/~\/\.config\/npl\/npl-plugin\.config\.yaml/)).toBeInTheDocument();
  });

  test("Start button fires POST /api/services/:name/start", async () => {
    render(<MemoryRouter><Services /></MemoryRouter>);
    let row: HTMLElement | null = null;
    await waitFor(() => {
      row = screen.getByText("alpha-mcp").closest("tr");
      expect(row).not.toBeNull();
    });
    const rowEl = row!;
    await waitFor(() => {
      expect(rowEl.querySelector('input[type="checkbox"]')).not.toBeDisabled();
    });
    const startButton = rowEl.querySelector("button")!; // first button in row is Start
    expect(startButton).toHaveTextContent("Start");
    expect(startButton).not.toBeDisabled();
    fireEvent.click(startButton);
    await waitFor(() => {
      const startCall = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/services/alpha-mcp/start") && (i as RequestInit | undefined)?.method === "POST"
      );
      expect(startCall).toBeDefined();
    });
  });
});
