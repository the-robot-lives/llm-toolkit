import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Memories } from "../../pages/Memories.js";
import { MemoryConnection } from "../../components/MemoryConnection.js";

const disconnected = { connected: false, writeEnabled: false, serverUrl: "https://therobot.is/mcp", loginPending: false };
beforeEach(() => { vi.restoreAllMocks(); });
const response = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

describe("Memories connection flow", () => {
  test("starts scoped login from unsaved settings and offers a browser login link", async () => {
    const fetcher = vi.fn((url: string) => response(url.endsWith("/status") ? disconnected : { authorizationUrl: "https://therobot.is/oauth/authorize?state=opaque" }));
    vi.stubGlobal("fetch", fetcher);
    render(<MemoryConnection />);
    await screen.findByText("Not connected");
    fireEvent.click(screen.getByLabelText("Allow capturing and editing memories"));
    fireEvent.click(screen.getByRole("button", { name: "Connect to therobot.is" }));
    const link = await screen.findByRole("link", { name: "Continue login in your browser" });
    expect(link).toHaveAttribute("href", "https://therobot.is/oauth/authorize?state=opaque");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(fetcher).toHaveBeenCalledWith("/api/remote-memory/oauth/start", expect.objectContaining({ method: "POST", body: '{"writeEnabled":true}' }));
  });
  test("never exposes a foreign authorization link", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => response(url.endsWith("/status") ? disconnected : { authorizationUrl: "https://attacker.example/login" })));
    render(<MemoryConnection />);
    await screen.findByText("Not connected");
    fireEvent.click(screen.getByRole("button", { name: "Connect to therobot.is" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unexpected login service");
    expect(screen.queryByRole("link")).toBeNull();
  });
  test("gates remote memory reads and writes on authentication and scope", async () => {
    const fetcher = vi.fn(() => response(disconnected));
    vi.stubGlobal("fetch", fetcher);
    const first = render(<Memories />);
    await screen.findByText("Not connected");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Save memory" })).toBeNull();
    first.unmount();
    vi.stubGlobal("fetch", vi.fn((url: string) => response(url.endsWith("/status") ? { ...disconnected, connected: true } : { data: { nodes: [{ id: "memory-1", title: "A memory", summary: "Private content", state: "active" }] } })));
    render(<Memories />);
    expect(await screen.findByText("A memory")).toBeInTheDocument();
    expect(screen.getByText("Connected · Read only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save memory" })).toBeNull();
  });
  test("disconnects locally and clears remote memory results", async () => {
    let connected = true;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/disconnect")) connected = false;
      return response(url.endsWith("/memories") ? { data: { nodes: [{ id: "memory-1", title: "A memory" }] } } : { ...disconnected, connected });
    }));
    render(<Memories />);
    await screen.findByText("A memory");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(screen.queryByText("A memory")).toBeNull());
    expect(screen.getByText("Disconnected from this app. Your memories are preserved.")).toBeInTheDocument();
  });
  test("retains the draft when the remote service quarantines a capture", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string, options?: RequestInit) => {
      if (url.endsWith("/status")) return response({ ...disconnected, connected: true, writeEnabled: true });
      if (options?.method === "POST") return response({ data: { id: null, status: "quarantined" } });
      return response({ data: { nodes: [] } });
    }));
    render(<Memories />);
    const content = await screen.findByLabelText("Memory content");
    fireEvent.change(content, { target: { value: "Keep this draft until confirmed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("held this memory for review");
    expect(content).toHaveValue("Keep this draft until confirmed");
    expect(screen.queryByText("Memory captured successfully.")).toBeNull();
  });
});
