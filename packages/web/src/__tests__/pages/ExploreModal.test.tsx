import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../../App.tsx";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.includes("/config")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: {
            indexing: { preferLocal: true, deepWindowDays: 14 },
          },
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
      json: () => Promise.resolve({ data: [], meta: { total: 0, limit: 25 } }),
    });
  }));
});

describe("Explore index modal", () => {
  test("clicking LAST INDEXED tile opens the modal", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    const tile = await screen.findByText("Last Indexed");
    fireEvent.click(tile);
    await waitFor(() => {
      expect(screen.getByText("Conversations indexed")).toBeInTheDocument();
    });
    expect(screen.getByText("Refresh Index")).toBeInTheDocument();
  });
});
