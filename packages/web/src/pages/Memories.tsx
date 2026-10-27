import React, { useCallback, useEffect, useId, useState } from "react";
import { MemoryConnection, type MemoryConnectionStatus } from "../components/MemoryConnection.js";
import { apiFetch } from "../hooks/useApi.js";

interface MemoryNode { id: string; title?: string; summary?: string; content_type?: string; pinned?: boolean; state?: string; sealed?: boolean; record_class?: string; disputed?: boolean; salience?: number; decay_weight?: number; recall_count?: number }
interface MemoryResult {
  memory: MemoryNode;
  score?: number;
  contributions?: { source: string; rank?: number; score?: number }[];
}
const hasNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function PinButton({ pinned, busy, onClick }: { pinned: boolean; busy: boolean; onClick: () => void }) {
  const tooltipId = useId();
  const [showTooltip, setShowTooltip] = useState(false);
  return <span className="relative inline-flex" onMouseEnter={() => setShowTooltip(true)} onMouseLeave={() => setShowTooltip(false)} onFocus={() => setShowTooltip(true)} onBlur={() => setShowTooltip(false)} onKeyDown={(event) => { if (event.key === "Escape") setShowTooltip(false); }}>
    <button type="button" aria-label={pinned ? "Unpin memory" : "Pin memory"} aria-pressed={pinned} aria-describedby={tooltipId} disabled={busy} onClick={onClick}
      className={`inline-flex h-9 w-9 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow disabled:opacity-50 ${pinned ? "border-glow bg-glow/15 text-glow" : "border-border-subtle text-text-muted hover:border-glow hover:text-glow"}`}>
      <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 3h6l-1 7 4 4v2H6v-2l4-4-1-7Z" />
        <path d="M12 16v6" />
      </svg>
    </button>
    <span id={tooltipId} role="tooltip" hidden={!showTooltip} className="absolute bottom-full right-0 z-10 w-64 pb-2 text-xs font-normal text-text-primary">
      <span className="block rounded border border-border-subtle bg-canvas p-2 shadow-lg">{pinned ? "Unpin to allow this memory to become a pruning candidate again. This does not delete it." : "Pin to protect this memory from pruning. Pinning does not change search rank."}</span>
    </span>
  </span>;
}

function MemoryRanking({ result, rank }: { result: MemoryResult; rank?: number }) {
  const { memory, score, contributions } = result;
  return <>
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
      {rank !== undefined && <span className="font-medium text-glow">Rank #{rank}</span>}
      {hasNumber(score) && <span>Recall score: {score.toFixed(6)}</span>}
      {hasNumber(memory.salience) && <span>Salience: {memory.salience.toFixed(3)}</span>}
      {hasNumber(memory.decay_weight) && <span>Memory weight: {memory.decay_weight.toFixed(3)}</span>}
      {hasNumber(memory.recall_count) && <span>Recalls: {memory.recall_count}</span>}
    </div>
    {!!contributions?.length && <details className="text-xs text-text-muted">
      <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow">Ranking details</summary>
      <p className="mt-2">Retrieval paths contribute to the combined recall score; this is not a confidence percentage.</p>
      <ul className="mt-1 space-y-1">{contributions.map((item, index) => <li key={`${item.source}-${index}`}>{item.source}{hasNumber(item.rank) && ` · rank ${item.rank}`}{hasNumber(item.score) && ` · contribution ${item.score.toFixed(6)}`}</li>)}</ul>
    </details>}
  </>;
}
export function Memories() {
  const [connection, setConnection] = useState<MemoryConnectionStatus | null>(null);
  const [memories, setMemories] = useState<MemoryResult[]>([]);
  const [ranked, setRanked] = useState(false);
  const [query, setQuery] = useState("");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async (search = "") => {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = search.trim()
        ? await apiFetch<{ data: { results: MemoryResult[] } }>("/remote-memory/search", { method: "POST", body: JSON.stringify({ query: search }) })
        : await apiFetch<{ data: { nodes: MemoryNode[]; truncated?: boolean } }>("/remote-memory/memories");
      if ("results" in result.data) { setMemories(result.data.results); setRanked(true); }
      else { setMemories(result.data.nodes.map((memory) => ({ memory }))); setRanked(false); setNotice(result.data.truncated ? "Showing up to 100 memories. Search to find others." : ""); }
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
      {memories.length > 0 && <p className="text-xs text-text-dim">{ranked ? "Ranked for your search by the memory service. Higher recall scores rank earlier for this query." : "Browsing memories without a search ranking. Search to see recall ranks and scores."}</p>}
      <div className="space-y-3">{memories.map((result, index) => {
        const { memory } = result;
        return <article key={memory.id} className="rounded border border-border-subtle bg-surface p-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-base text-text-primary">{memory.sealed ? "Sealed memory" : memory.title || memory.summary || memory.content_type || "Memory"}</h2>
            {connection.writeEnabled && <PinButton pinned={memory.pinned === true} busy={busy} onClick={() => void update(memory.id, memory.pinned ? "unpin" : "pin")} />}
          </div>
          <MemoryRanking result={result} rank={ranked ? index + 1 : undefined} />
          {!memory.sealed && <p className="whitespace-pre-wrap text-sm text-text-muted">{memory.summary}</p>}
          <p className="text-xs text-text-dim">{[memory.content_type, memory.state, memory.pinned && "Pinned", memory.record_class, memory.disputed && "Disputed"].filter(Boolean).join(" · ")}</p>
        </article>;
      })}</div>
      {connection.writeEnabled ? <section className="rounded border border-border-subtle bg-surface p-5 space-y-3"><h2 className="text-base text-text-primary">Capture a memory</h2><input aria-label="Memory summary" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Short summary (optional)" className="w-full rounded border border-border-subtle bg-canvas p-2" /><textarea aria-label="Memory content" value={content} onChange={(e) => setContent(e.target.value)} placeholder="What would you like to remember?" rows={5} className="w-full rounded border border-border-subtle bg-canvas p-2" /><button disabled={busy || !content.trim()} onClick={save} className="rounded bg-glow px-4 py-2 text-void disabled:opacity-50">Save memory</button></section> : <p className="text-sm text-text-muted">To capture or edit memories, enable editing above and reconnect.</p>}
    </>}
  </div>;
}
