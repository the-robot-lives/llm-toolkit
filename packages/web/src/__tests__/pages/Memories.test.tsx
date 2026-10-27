import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    expect(screen.queryByRole("button", { name: "Pin memory" })).toBeNull();
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
  test("shows actual search ranks and contributions without inventing browse or missing scores", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/status")) return response({ ...disconnected, connected: true });
      if (url.endsWith("/search")) return response({ data: { results: [
        { memory: { id: "zero", title: "Zero score" }, score: 0, contributions: [{ source: "content", rank: 2, score: 0 }] },
        { memory: { id: "negative", title: "Negative score" }, score: -0.002 },
        { memory: { id: "missing", title: "Missing score" } },
      ] } });
      return response({ data: { nodes: [{ id: "browse", title: "Browse memory", salience: 0, decay_weight: 0, recall_count: 0 }] } });
    }));
    render(<Memories />);
    await screen.findByText("Browse memory");
    expect(screen.getByText("Salience: 0.000")).toBeInTheDocument();
    expect(screen.getByText("Memory weight: 0.000")).toBeInTheDocument();
    expect(screen.getByText("Recalls: 0")).toBeInTheDocument();
    expect(screen.queryByText(/Rank #/)).toBeNull();
    expect(screen.getByText(/Browsing memories without a search ranking/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search memories" }), { target: { value: "query" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const zero = (await screen.findByText("Zero score")).closest("article")!;
    expect(within(zero).getByText("Rank #1")).toBeInTheDocument();
    expect(within(zero).getByText("Recall score: 0.000000")).toBeInTheDocument();
    expect(within(zero).getByText("content · rank 2 · contribution 0.000000")).toBeInTheDocument();
    expect(screen.getByText("Recall score: -0.002000")).toBeInTheDocument();
    const missing = screen.getByText("Missing score").closest("article")!;
    expect(within(missing).getByText("Rank #3")).toBeInTheDocument();
    expect(within(missing).queryByText(/Recall score:/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await screen.findByText("Browse memory");
    expect(screen.queryByText(/Rank #/)).toBeNull();
  });
  test("uses an accessible thumbtack toggle with accurate pin and unpin explanations", async () => {
    let pinned = false;
    const id = "11111111-1111-4111-8111-111111111111";
    const fetcher = vi.fn((url: string) => {
      if (url.endsWith("/status")) return response({ ...disconnected, connected: true, writeEnabled: true });
      if (url.endsWith("/pin")) { pinned = true; return response({ data: {} }); }
      if (url.endsWith("/unpin")) { pinned = false; return response({ data: {} }); }
      return response({ data: { nodes: [{ id, title: "Pinnable memory", pinned }] } });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<Memories />);
    const pin = await screen.findByRole("button", { name: "Pin memory" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    expect(pin.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(pin.textContent).toBe("");
    expect(document.getElementById(pin.getAttribute("aria-describedby")!)).toHaveTextContent("Pin to protect this memory from pruning. Pinning does not change search rank.");
    fireEvent.focus(pin);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(pin, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(pin);
    const unpin = await screen.findByRole("button", { name: "Unpin memory" });
    expect(unpin).toHaveAttribute("aria-pressed", "true");
    expect(document.getElementById(unpin.getAttribute("aria-describedby")!)).toHaveTextContent("This does not delete it.");
    expect(fetcher).toHaveBeenCalledWith(`/api/remote-memory/memories/${id}/pin`, expect.objectContaining({ method: "POST" }));
    fireEvent.click(unpin);
    await screen.findByRole("button", { name: "Pin memory" });
    expect(fetcher).toHaveBeenCalledWith(`/api/remote-memory/memories/${id}/unpin`, expect.objectContaining({ method: "POST" }));
  });
});
