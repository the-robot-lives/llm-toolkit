import React, { useCallback, useEffect, useState } from "react";
import { MemoryConnection, type MemoryConnectionStatus } from "../components/MemoryConnection.js";
import { apiFetch } from "../hooks/useApi.js";

interface MemoryNode { id: string; title?: string; summary?: string; content_type?: string; pinned?: boolean; state?: string; sealed?: boolean; record_class?: string; disputed?: boolean }
export function Memories() {
  const [connection, setConnection] = useState<MemoryConnectionStatus | null>(null);
  const [memories, setMemories] = useState<MemoryNode[]>([]);
  const [query, setQuery] = useState("");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async (search = "") => {
    setBusy(true); setError("");
    try {
      const result = search.trim()
        ? await apiFetch<{ data: { results: { memory: MemoryNode }[] } }>("/remote-memory/search", { method: "POST", body: JSON.stringify({ query: search }) })
        : await apiFetch<{ data: { nodes: MemoryNode[]; truncated?: boolean } }>("/remote-memory/memories");
      if ("results" in result.data) setMemories(result.data.results.map((item) => item.memory));
      else { setMemories(result.data.nodes); setNotice(result.data.truncated ? "Showing up to 100 memories. Search to find others." : ""); }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load memories"); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { setMemories([]); if (connection?.connected) void load(); }, [connection?.connected, connection?.connectionId, load]);

  const save = async () => {
    setBusy(true); setError("");
    try {
      const result = await apiFetch<{ data: { id?: string; status?: string } }>("/remote-memory/memories", { method: "POST", body: JSON.stringify({ content, summary }) });
      if (result.data.status === "quarantined" || !result.data.id) {
        setError(result.data.status === "quarantined" ? "The memory service held this memory for review. Your draft has been kept." : "The service did not confirm that your memory was stored. Your draft has been kept.");
        return;
      }
      setContent(""); setSummary(""); await load(); setNotice(result.data.status === "duplicate" ? "This memory was already captured." : "Memory captured successfully.");
    }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save memory"); }
    finally { setBusy(false); }
  };
  const update = async (id: string, action: string) => {
    setBusy(true); setError("");
    try { await apiFetch(`/remote-memory/memories/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" }); await load(query); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not update memory"); }
    finally { setBusy(false); }
  };
  return <div className="mx-auto max-w-4xl space-y-6">
    <div><h1 className="text-xl font-medium text-text-bright">Memories</h1><p className="mt-2 text-sm text-text-muted">Recall and capture memories with therobot.is. Local Claude memory files remain available in the native app’s Claude Memory Files section.</p></div>
    <MemoryConnection onChange={setConnection} />
    {connection?.connected && <>
      <form onSubmit={(e) => { e.preventDefault(); void load(query); }} className="flex gap-3"><input aria-label="Search memories" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="What would you like to recall?" className="flex-1 rounded border border-border-subtle bg-canvas px-3 py-2" /><button disabled={busy} className="rounded border border-border-subtle px-4 py-2">{busy ? "Loading…" : "Search"}</button><button type="button" disabled={busy} onClick={() => { setQuery(""); void load(); }} className="text-sm text-glow">Browse</button></form>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}{notice && <p role="status" className="text-sm text-text-muted">{notice}</p>}
      {!busy && !error && memories.length === 0 && <p className="text-sm text-text-muted">No memories found.</p>}
      <div className="space-y-3">{memories.map((memory) => <article key={memory.id} className="rounded border border-border-subtle bg-surface p-4 space-y-2"><h2 className="text-base text-text-primary">{memory.sealed ? "Sealed memory" : memory.title || memory.summary || memory.content_type || "Memory"}</h2>{!memory.sealed && <p className="whitespace-pre-wrap text-sm text-text-muted">{memory.summary}</p>}<p className="text-xs text-text-dim">{[memory.content_type, memory.state, memory.pinned && "Pinned", memory.record_class, memory.disputed && "Disputed"].filter(Boolean).join(" · ")}</p>{connection.writeEnabled && <div className="flex gap-4 text-xs text-glow"><button disabled={busy} onClick={() => update(memory.id, memory.pinned ? "unpin" : "pin")}>{memory.pinned ? "Unpin" : "Pin"}</button></div>}</article>)}</div>
      {connection.writeEnabled ? <section className="rounded border border-border-subtle bg-surface p-5 space-y-3"><h2 className="text-base text-text-primary">Capture a memory</h2><input aria-label="Memory summary" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Short summary (optional)" className="w-full rounded border border-border-subtle bg-canvas p-2" /><textarea aria-label="Memory content" value={content} onChange={(e) => setContent(e.target.value)} placeholder="What would you like to remember?" rows={5} className="w-full rounded border border-border-subtle bg-canvas p-2" /><button disabled={busy || !content.trim()} onClick={save} className="rounded bg-glow px-4 py-2 text-void disabled:opacity-50">Save memory</button></section> : <p className="text-sm text-text-muted">To capture or edit memories, enable editing above and reconnect.</p>}
    </>}
  </div>;
}
