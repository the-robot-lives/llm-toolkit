import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch, useLlmProfiles } from "../hooks/useApi.js";
import { MemoryConnection, type MemoryConnectionStatus } from "../components/MemoryConnection.js";

interface Candidate {
  id: string; content: string; summary: string; context: string;
  valence: number; arousal: number; dominance: number; enabled: boolean;
  evidence: { messageId: string; excerpt: string }[];
  status: "draft" | "committed" | "failed" | "quarantined";
  memoryId?: string; error?: string;
}
interface Draft {
  id: string; conversationId: string; title: string; profileId: string; createdAt: string;
  coverage: { includedMessages: number; totalMessages: number; includedCharacters: number; totalCharacters: number; partial: boolean };
  candidates: Candidate[];
}
const inputClass = "w-full rounded border border-border-subtle bg-canvas p-2 text-sm";
const cacheKey = (id: string) => `memory-review:${id}`;

/** Restore editable fields only. Server-owned evidence and commit receipts always win. */
function restoreEdits(server: Draft): Draft {
  try {
    const local = JSON.parse(localStorage.getItem(cacheKey(server.conversationId)) ?? "null") as Draft | null;
    if (!local || local.id !== server.id || !Array.isArray(local.candidates)) return server;
    return { ...server, candidates: server.candidates.map((candidate) => {
      const edit = local.candidates.find((item) => item.id === candidate.id);
      if (!edit || candidate.status === "committed" || typeof edit.enabled !== "boolean" || ![edit.content, edit.summary, edit.context].every((s) => typeof s === "string") || ![edit.valence, edit.arousal, edit.dominance].every((n) => typeof n === "number")) return candidate;
      return { ...candidate, content: edit.content, summary: edit.summary, context: edit.context, valence: edit.valence, arousal: edit.arousal, dominance: edit.dominance, enabled: edit.enabled };
    }) };
  } catch { return server; }
}

export function MemoryReview() {
  const { id } = useParams<{ id: string }>();
  const profiles = useLlmProfiles();
  const [profileId, setProfileId] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [connection, setConnection] = useState<MemoryConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const updateDraft = (value: Draft) => {
    setDraft(value);
    try { localStorage.setItem(cacheKey(value.conversationId), JSON.stringify(value)); }
    catch { setNotice("Browser draft storage is unavailable. Keep this page open until you commit; the extracted server draft is retained."); }
  };
  useEffect(() => {
    let active = true;
    setLoading(true); setDraft(null); setError("");
    if (id) apiFetch<{ data: Draft | null }>(`/memory-extraction/${encodeURIComponent(id)}`)
      .then(({ data }) => { if (active && data) { setDraft(restoreEdits(data)); setProfileId(data.profileId); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Could not load review"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id]);
  useEffect(() => { if (profiles.data && !profiles.data.profiles.some((profile) => profile.id === profileId)) setProfileId(profiles.data.defaultProfileId || profiles.data.profiles[0]?.id || ""); }, [profiles.data, profileId]);

  const scan = async () => {
    if (!id || !profileId || (draft && !window.confirm("Replace this memory review with a new scan? Your current edits and selections will be replaced only after the new scan succeeds. Memories already committed remain in the store."))) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await apiFetch<{ data: Draft }>(`/memory-extraction/${encodeURIComponent(id)}/scan`, { method: "POST", body: JSON.stringify({ profileId, replaceDraftId: draft?.id }) });
      updateDraft(result.data);
      if (!result.data.candidates.length) setNotice("No durable memories were found in the scanned text.");
    } catch (e) { setError(e instanceof Error ? e.message : "Scan failed. Your previous review is retained."); }
    finally { setBusy(false); }
  };
  const edit = (candidateId: string, values: Partial<Candidate>) => {
    if (draft) updateDraft({ ...draft, candidates: draft.candidates.map((candidate) => candidate.id === candidateId && candidate.status !== "committed" ? { ...candidate, ...values } : candidate) });
  };
  const selectAll = (enabled: boolean) => {
    if (draft) updateDraft({ ...draft, candidates: draft.candidates.map((candidate) => candidate.status === "committed" ? candidate : { ...candidate, enabled }) });
  };
  const selected = draft?.candidates.filter((candidate) => candidate.enabled && candidate.status !== "committed") ?? [];
  const invalid = draft?.candidates.some((candidate) => candidate.status !== "committed" && (!candidate.content.trim() || candidate.content.length > 8_000 || candidate.context.length > 6_000 || candidate.summary.length > 500 || !Number.isFinite(candidate.arousal) || candidate.arousal < 0 || candidate.arousal > 1 || !Number.isFinite(candidate.valence) || candidate.valence < -1 || candidate.valence > 1 || !Number.isFinite(candidate.dominance) || candidate.dominance < 0 || candidate.dominance > 1));
  const commit = async () => {
    if (!id || !draft || !selected.length || busy || invalid) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await apiFetch<{ data: Draft }>(`/memory-extraction/${encodeURIComponent(id)}/commit`, { method: "POST", body: JSON.stringify({ draftId: draft.id, candidates: draft.candidates }) });
      updateDraft(result.data);
      const pending = result.data.candidates.filter((candidate) => candidate.enabled && candidate.status !== "committed").length;
      setNotice(pending ? `${pending} selected memories still need attention. Successful memories will not be sent again.` : "Selected memories committed. Disabled memories remain in your review.");
    } catch (e) { setError(e instanceof Error ? e.message : "Commit failed. Your draft is retained."); }
    finally { setBusy(false); }
  };
  return <div className="mx-auto max-w-5xl space-y-5 pb-16">
    <Link to={`/thread/${id}`} className="text-sm text-glow">← Back to conversation</Link>
    <header><h1 className="text-xl font-medium text-text-bright">Extract memories</h1><p className="mt-2 text-sm text-text-muted">{draft?.title || "Scan this conversation, then review what to remember."}</p></header>
    <section className="rounded border border-border-subtle bg-surface p-4 space-y-3">
      <label className="block text-sm">Extraction profile<select aria-label="Extraction profile" value={profileId} disabled={busy} onChange={(e) => setProfileId(e.target.value)} className={`${inputClass} mt-1`}><option value="">Choose a profile</option>{profiles.data?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select></label>
      <p className="text-xs text-text-muted">Scanning sends user and assistant text to the selected model. Tool output and private reasoning are excluded. Nothing is added to memory until you commit.</p>
      {!profiles.loading && !profiles.data?.profiles.length && <p className="text-sm text-text-muted">Add a model profile in <Link className="text-glow" to="/settings">Settings</Link> first.</p>}
      {profiles.error && <p role="alert">{profiles.error}</p>}
      <button onClick={scan} disabled={loading || busy || !profileId} className="btn-action-primary disabled:opacity-50">{busy ? "Working…" : draft ? "Scan again" : "Scan conversation"}</button>
    </section>
    <MemoryConnection onChange={setConnection} />
    {loading && <p role="status">Loading review…</p>}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {notice && <p role="status" className="text-sm text-text-muted">{notice}</p>}
    {draft && <>
      <p className="text-sm text-text-muted">Scanned {draft.coverage.includedMessages} of {draft.coverage.totalMessages} text messages ({draft.coverage.includedCharacters.toLocaleString()} of {draft.coverage.totalCharacters.toLocaleString()} characters). {draft.coverage.partial && <strong className="text-amber-300">Partial scan: only the first 120,000 characters were included.</strong>}</p>
      <div className="flex flex-wrap items-center gap-3"><h2 className="mr-auto text-base font-medium">Review {draft.candidates.length} extracted memories</h2><button disabled={busy} className="btn-action" onClick={() => selectAll(true)}>Select all</button><button disabled={busy} className="btn-action" onClick={() => selectAll(false)}>Select none</button></div>
      <p className="text-xs text-text-muted">Emotional values are estimates for you to review: arousal 0 = calm, 1 = excited; valence −1 = negative, 1 = positive; dominance 0 = helpless, 1 = in control.</p>
      {draft.candidates.map((candidate, index) => <article key={candidate.id} className={`space-y-3 rounded border border-border-subtle bg-surface p-4 ${candidate.enabled ? "" : "opacity-65"}`}>
        <div className="flex items-center gap-3"><input type="checkbox" aria-label={`Include memory ${index + 1}`} checked={candidate.enabled} disabled={busy || candidate.status === "committed"} onChange={(e) => edit(candidate.id, { enabled: e.target.checked })} /><h3 className="font-medium">Memory {index + 1}</h3><span className="ml-auto text-xs text-text-muted">{candidate.status === "committed" ? "Committed ✓" : candidate.status}</span></div>
        <fieldset disabled={busy || candidate.status === "committed"} className="space-y-3">
          <label className="block text-sm">Summary<input aria-label={`Summary ${index + 1}`} value={candidate.summary} maxLength={500} onChange={(e) => edit(candidate.id, { summary: e.target.value })} className={inputClass} /></label>
          <label className="block text-sm">Memory<textarea aria-label={`Memory ${index + 1}`} value={candidate.content} rows={3} maxLength={8_000} onChange={(e) => edit(candidate.id, { content: e.target.value })} className={inputClass} /></label>
          <label className="block text-sm">Context<textarea aria-label={`Context ${index + 1}`} value={candidate.context} rows={2} maxLength={6_000} onChange={(e) => edit(candidate.id, { context: e.target.value })} className={inputClass} /></label>
          <div className="grid grid-cols-3 gap-3">{(["arousal", "valence", "dominance"] as const).map((field) => <label key={field} className="text-sm capitalize">{field}<input type="number" aria-label={`${field} ${index + 1}`} min={field === "valence" ? -1 : 0} max={1} step={0.05} value={candidate[field]} onChange={(e) => edit(candidate.id, { [field]: Number(e.target.value) })} className={inputClass} /></label>)}</div>
        </fieldset>
        <details><summary className="cursor-pointer text-sm text-glow">Source context ({candidate.evidence.length} messages)</summary>{candidate.evidence.map((evidence) => <blockquote key={evidence.messageId} className="mt-2 border-l-2 border-border-subtle pl-3 text-xs text-text-muted"><p className="break-all font-mono">{evidence.messageId}</p><p className="mt-1 whitespace-pre-wrap">{evidence.excerpt}</p></blockquote>)}</details>
        {candidate.error && <p role="alert" className="text-sm text-amber-300">{candidate.error}</p>}
      </article>)}
      <section className="sticky bottom-3 flex flex-wrap items-center gap-3 rounded border border-border-strong bg-surface-raised p-4 shadow-xl"><p className="mr-auto text-sm">{selected.length} selected for memory</p><button onClick={commit} disabled={busy || !selected.length || invalid || !connection?.connected || !connection.writeEnabled} className="btn-action-primary disabled:opacity-50">{busy ? "Working…" : "Commit to memory"}</button>{invalid && <p className="w-full text-xs text-amber-300">Check memory text and emotional value ranges before committing.</p>}{(!connection?.connected || !connection.writeEnabled) && <p className="w-full text-xs text-text-muted">Connect above with editing enabled to commit. You can scan and review while disconnected.</p>}</section>
    </>}
  </div>;
}
