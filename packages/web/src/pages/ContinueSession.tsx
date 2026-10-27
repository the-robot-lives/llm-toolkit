import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { conversationMarkdown, parsePortableConversation, snipConversation, universalMessageText } from "@llm-toolkit/shared/portable-conversation";
import type { ConversationCompatibilityIssue, ConversationValidationReport, PortableConversationDocument, UniversalThread } from "@llm-toolkit/shared";
import { apiFetch, useConversations } from "../hooks/useApi.js";
import { CloneApproval, ValidationReport, type NativeClonePreview } from "../components/ConversationValidation.js";

type Target = "claude" | "codex" | "gemini" | "opencode" | "aider" | "other";
interface Capabilities { targets: Array<{ harness: Target; native: boolean; compatibilityVersion: string; destinations: string[] }> }
interface Created { id?: string; sourcePath: string; universalPath: string; resumeCommand: string; nativeCreated: boolean; indexed: boolean }

export function ContinueSession() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const previewSequence = useRef(0);
  const [thread, setThread] = useState<UniversalThread | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [document, setDocument] = useState<PortableConversationDocument | null>(null);
  const [sectionIssues, setSectionIssues] = useState<ConversationCompatibilityIssue[]>([]);
  const [target, setTarget] = useState<Target>("claude");
  const [cwd, setCwd] = useState("");
  const [title, setTitle] = useState("");
  const [destinationRoot, setDestinationRoot] = useState("");
  const [insertMode, setInsertMode] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [targetThread, setTargetThread] = useState<UniversalThread | null>(null);
  const [after, setAfter] = useState("end");
  const [preview, setPreview] = useState<NativeClonePreview | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"format" | "validate">("format");
  const [editor, setEditor] = useState("");
  const [validationText, setValidationText] = useState("");
  const [validationTarget, setValidationTarget] = useState<Target | "universal">("claude");
  const [report, setReport] = useState<ConversationValidationReport | null>(null);
  const [repairPreview, setRepairPreview] = useState<string | null>(null);
  const conversations = useConversations({ limit: 200, sort: "updated_at" });
  const capability = capabilities?.targets.find((entry) => entry.harness === target);
  const resetPreview = () => { previewSequence.current++; setPreview(null); setCreated(null); setError(""); };

  useEffect(() => {
    let active = true;
    if (!id) return;
    setThread(null); setDocument(null); setPreview(null); setError("");
    Promise.all([apiFetch<{ data: UniversalThread }>(`/conversations/${id}/universal?raw=true`), apiFetch<{ data: Capabilities }>("/conversations/format-capabilities")])
      .then(async ([source, caps]) => {
        let data = source.data;
        if (searchParams.get("draft") === "1") {
          const draft = await apiFetch<{ data: { messages: unknown[] } | null }>(`/conversations/${id}/draft`);
          if (draft.data) { const edited = await apiFetch<{ data: PortableConversationDocument }>(`/conversations/${id}/edit-document`, { method: "POST", body: JSON.stringify({ messages: draft.data.messages }) }); data = edited.data.thread; }
        }
        if (!active) return;
        setThread(data); setCapabilities(caps.data); setSelected(new Set(data.messages.map((message) => message.id))); setTarget(data.harness as Target); setValidationTarget(data.harness as Target); setCwd(data.projectPath); setTitle(`${data.title} (copy)`);
      })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "Could not load conversation"); });
    return () => { active = false; };
  }, [id]);
  useEffect(() => { setDestinationRoot(capability?.destinations[0] ?? ""); setPreview(null); }, [target, capabilities]);
  useEffect(() => {
    let active = true;
    setTargetThread(null); setPreview(null);
    if (!insertMode || !targetId) return;
    apiFetch<{ data: UniversalThread }>(`/conversations/${encodeURIComponent(targetId)}/universal`).then(({ data }) => { if (!active) return; setTargetThread(data); setTarget(data.harness as Target); setCwd(data.projectPath); setTitle(`${data.title} (with inserted section)`); setAfter("end"); }).catch((err) => { if (active) setError(err instanceof Error ? err.message : "Could not load destination conversation"); });
    return () => { active = false; };
  }, [insertMode, targetId]);

  const prepareSection = async () => {
    if (!id) throw new Error("Conversation not found");
    if (document) return document;
    if (!thread) throw new Error("Conversation is not loaded");
    const data = snipConversation(thread, [...selected]);
    setDocument(data.document); setEditor(JSON.stringify(data.document, null, 2)); setSectionIssues(data.issues); return data.document;
  };
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(""); try { await action(); } catch (err) { setError(err instanceof Error ? err.message : "Operation failed"); } finally { setBusy(false); } };
  const prepareNative = () => run(async () => {
    const sequence = ++previewSequence.current;
    const source = await prepareSection();
    const { data } = await apiFetch<{ data: NativeClonePreview }>(`/conversations/${id}/clone-preview`, { method: "POST", body: JSON.stringify({ targetHarness: target, projectPath: cwd, title, destinationRoot: destinationRoot || undefined, document: source, insertIntoConversationId: insertMode ? targetId : undefined, afterMessageId: insertMode ? after === "start" ? null : after === "end" ? undefined : after : undefined }) });
    if (sequence !== previewSequence.current) return;
    setPreview(data); setCreated(null);
  });
  const create = () => run(async () => {
    if (!preview) return;
    const { data } = await apiFetch<{ data: Created }>(`/conversations/${id}/clone`, { method: "POST", body: JSON.stringify({ previewId: preview.previewId }) });
    setCreated(data); setPreview(null);
  });
  const download = (format: "universal" | "markdown") => run(async () => {
    const source = await prepareSection();
    const content = format === "markdown" ? conversationMarkdown(source) : JSON.stringify(source, null, 2);
    const link = window.document.createElement("a"); const url = URL.createObjectURL(new Blob([content], { type: format === "markdown" ? "text/markdown" : "application/json" }));
    link.href = url; link.download = `conversation-section.${format === "markdown" ? "md" : "json"}`; link.click(); URL.revokeObjectURL(url);
  });
  const validate = () => run(async () => { const { data } = await apiFetch<{ data: ConversationValidationReport }>("/conversations/validate", { method: "POST", body: JSON.stringify({ content: validationText, target: validationTarget }) }); setReport(data); setRepairPreview(null); });
  const validateSource = () => run(async () => { const { data } = await apiFetch<{ data: ConversationValidationReport }>(`/conversations/${id}/validate`); setReport(data); setTab("validate"); });

  if (!thread) return <div className="mx-auto max-w-5xl py-10"><p className="text-text-muted">{error || "Loading source conversation…"}</p><button className="btn-action mt-3" onClick={() => navigate(-1)}>Back</button></div>;
  return <div className="mx-auto max-w-6xl space-y-4 pb-16">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl text-text-bright">Format, snip and clone</h1><p className="text-sm text-text-muted">{thread.title} · {thread.harness} · {thread.messages.length} active messages</p><p className="mt-1 text-xs text-text-dim">Original conversations stay unchanged. Native copies use the target’s current configuration.</p></div><button className="btn-action" onClick={() => navigate(`/thread/${id}`)}>Back to thread</button></header>
    <div className="flex gap-2"><button aria-pressed={tab === "format"} className="btn-action" onClick={() => setTab("format")}>Format / Clone</button><button aria-pressed={tab === "validate"} className="btn-action" onClick={() => setTab("validate")}>Validator</button><button className="btn-action" disabled={busy} onClick={validateSource}>Validate source file</button></div>
    {error && <p role="alert" className="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
    {created && <section className="space-y-2 rounded border border-green-500/30 p-4"><h2 className="font-medium text-green-400">Native conversation created</h2><p className="break-all text-xs text-text-muted">{created.sourcePath}</p><code className="block break-all text-sm text-glow">{created.resumeCommand}</code><button className="btn-action" onClick={() => run(async () => navigator.clipboard.writeText(created.resumeCommand))}>Copy resume command</button>{created.id && <button className="btn-action ml-2" onClick={() => navigate(`/thread/${created.id}`)}>Open cloned thread</button>}{!created.indexed && <p className="text-xs text-amber-200">The native copy is valid. Refresh the index to show it in Toolkit.</p>}</section>}
    {tab === "format" ? <>
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <section className="space-y-3 rounded border border-border-subtle p-4"><h2 className="font-medium text-text-bright">1. Choose source sections</h2><div className="flex gap-2 text-xs"><button className="btn-action" onClick={() => { setSelected(new Set(thread.messages.map((message) => message.id))); setDocument(null); resetPreview(); }}>Select all</button><button className="btn-action" onClick={() => { setSelected(new Set()); setDocument(null); resetPreview(); }}>Select none</button></div><p className="text-xs text-text-dim">Tool calls and their results are kept together. Separate selections retain source-section boundaries.</p><div className="max-h-[520px] space-y-1 overflow-auto">{thread.messages.map((message, index) => <label key={message.id} className="flex gap-2 rounded p-2 text-xs hover:bg-surface-active"><input type="checkbox" checked={selected.has(message.id)} onChange={() => { setSelected((before) => { const next = new Set(before); next.has(message.id) ? next.delete(message.id) : next.add(message.id); return next; }); setDocument(null); resetPreview(); }} /><span><strong>{index + 1}. {message.role}</strong><span className="mt-1 block line-clamp-2 text-text-muted">{universalMessageText(message).slice(0, 160)}</span></span></label>)}</div><button className="btn-action" disabled={busy || !selected.size} onClick={() => run(async () => { await prepareSection(); })}>Prepare selected sections</button></section>
        <section className="space-y-4 rounded border border-border-subtle p-4"><h2 className="font-medium text-text-bright">2. Choose destination</h2><label className="block text-sm">Target provider<select aria-label="Target provider" className="mt-1 w-full rounded border border-border-subtle bg-surface p-2" value={target} onChange={(event) => { setTarget(event.target.value as Target); resetPreview(); }}>{capabilities?.targets.map((entry) => <option key={entry.harness} value={entry.harness}>{entry.harness}{entry.native ? "" : " — native format unavailable"}</option>)}</select></label>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={insertMode} onChange={(event) => { setInsertMode(event.target.checked); resetPreview(); }} />Insert into a copy of an existing conversation</label>
          {insertMode && <><label className="block text-sm">Destination conversation<select aria-label="Destination conversation" className="mt-1 w-full rounded border border-border-subtle bg-surface p-2" value={targetId} onChange={(event) => { setTargetId(event.target.value); resetPreview(); }}><option value="">Choose a recent conversation</option>{conversations.data?.data.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.harness} · {conversation.title}</option>)}</select></label>{targetThread && <label className="block text-sm">Insert after<select aria-label="Insertion boundary" className="mt-1 w-full rounded border border-border-subtle bg-surface p-2" value={after} onChange={(event) => { setAfter(event.target.value); resetPreview(); }}><option value="start">At the beginning</option>{targetThread.messages.map((message, index) => <option key={message.id} value={message.id}>{index + 1}. {message.role} · {universalMessageText(message).slice(0, 60)}</option>)}<option value="end">At the end</option></select></label>}<p className="text-xs text-text-dim">The destination’s prefix and suffix are preserved in the new clone. Its original file is never overwritten.</p></>}
          <label className="block text-sm">Project directory<input aria-label="Project directory" className="mt-1 w-full rounded border border-border-subtle bg-surface p-2 font-mono text-xs" value={cwd} onChange={(event) => { setCwd(event.target.value); resetPreview(); }} /></label>
          <label className="block text-sm">New conversation title<input aria-label="New conversation title" className="mt-1 w-full rounded border border-border-subtle bg-surface p-2" value={title} onChange={(event) => { setTitle(event.target.value); resetPreview(); }} /></label>
          {!!capability?.destinations.length && <label className="block text-xs text-text-muted">Native history folder<select aria-label="Native history folder" className="mt-1 w-full rounded border border-border-subtle bg-surface p-2 text-xs" value={destinationRoot} onChange={(event) => { setDestinationRoot(event.target.value); resetPreview(); }}>{capability.destinations.map((root) => <option key={root} value={root}>{root}</option>)}</select></label>}
          <div className="flex flex-wrap gap-2"><button className="btn-action-primary" disabled={busy || !selected.size || !capability?.native || (insertMode && !targetThread)} onClick={prepareNative}>{busy ? "Preparing…" : "Preview and validate native clone"}</button><button className="btn-action" disabled={busy || !selected.size} onClick={() => download("universal")}>Export universal JSON</button><button className="btn-action" disabled={busy || !selected.size} onClick={() => download("markdown")}>Export Markdown</button></div>
          {!capability?.native && <p className="text-xs text-amber-200">This native target is not verified in this build. Universal JSON and readable Markdown remain available.</p>}
          {sectionIssues.map((issue, index) => <p key={index} className="text-xs text-amber-200">{issue.message}</p>)}
        </section>
      </div>
      {<><button className="btn-action" disabled={busy} onClick={() => run(async () => { const { data } = await apiFetch<{ data: PortableConversationDocument }>(`/conversations/${id}/archive`); setDocument(data); setThread(data.thread); setSelected(new Set(data.thread.messages.map((message) => message.id))); setEditor(JSON.stringify(data, null, 2)); resetPreview(); })}>Restore archived originals into preview</button><details className="rounded border border-border-subtle p-4"><summary className="cursor-pointer text-sm text-text-muted">Universal section editor / import</summary><p className="my-2 text-xs text-text-dim">Paste a version 1 universal document to restore or transfer sections. Native fields are validated again before a copy is created.</p><textarea aria-label="Universal section document" className="h-64 w-full rounded border border-border-subtle bg-void p-3 font-mono text-xs" value={editor} onChange={(event) => setEditor(event.target.value)} /><button className="btn-action mt-2" onClick={() => { try { const parsed = parsePortableConversation(editor); setDocument(parsed); setThread(parsed.thread); setSelected(new Set(parsed.thread.messages.map((message) => message.id))); resetPreview(); } catch (err) { setError(err instanceof Error ? err.message : "Invalid universal document"); } }}>Use edited universal document</button><input type="file" accept=".json" aria-label="Import universal section" className="ml-3 text-xs" onChange={(event) => { const file = event.target.files?.[0]; if (file) run(async () => { if (file.size > 50_000_000) throw new Error("Maximum file size is 50 MB"); const text = await file.text(); const parsed = parsePortableConversation(text); setDocument(parsed); setThread(parsed.thread); setSelected(new Set(parsed.thread.messages.map((message) => message.id))); setEditor(text); resetPreview(); }); }} /></details></>}
      {preview && <CloneApproval preview={preview} busy={busy} onCreate={create} onCancel={() => setPreview(null)} />}
    </> : <section className="space-y-3 rounded border border-border-subtle p-4"><h2 className="font-medium text-text-bright">Conversation validator</h2><p className="text-xs text-text-muted">Validate existing native files or versioned universal documents. Validation is read-only; unknown formats are reported rather than guessed.</p><select aria-label="Validator target" className="rounded border border-border-subtle bg-surface p-2" value={validationTarget} onChange={(event) => { setValidationTarget(event.target.value as Target | "universal"); setReport(null); }}><option value="universal">Universal document v1</option>{capabilities?.targets.map((entry) => <option key={entry.harness} value={entry.harness}>{entry.harness}</option>)}</select><input type="file" accept=".json,.jsonl" aria-label="Conversation file to validate" onChange={(event) => { const file = event.target.files?.[0]; if (file) run(async () => { if (file.size > 50_000_000) throw new Error("Maximum file size is 50 MB"); setValidationText(await file.text()); setReport(null); }); }} /><textarea aria-label="Conversation content to validate" className="h-64 w-full rounded border border-border-subtle bg-void p-3 font-mono text-xs" value={validationText} onChange={(event) => { setValidationText(event.target.value); setReport(null); }} /><div className="flex flex-wrap gap-2"><button className="btn-action-primary" disabled={busy || !validationText.trim()} onClick={validate}>Validate content</button><button className="btn-action" disabled={busy || !validationText.trim() || validationTarget === "universal"} onClick={() => run(async () => { const { data } = await apiFetch<{ data: { content: string; report: ConversationValidationReport } }>("/conversations/format-jsonl", { method: "POST", body: JSON.stringify({ content: validationText, target: validationTarget }) }); setRepairPreview(data.content); setReport(data.report); })}>Preview JSONL formatting</button>{report && <button className="btn-action" onClick={() => run(async () => navigator.clipboard.writeText(JSON.stringify(report, null, 2)))}>Copy diagnostics</button>}</div>{repairPreview !== null && <div className="space-y-2 rounded border border-border-subtle p-3"><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-text-muted">{repairPreview.slice(0, 40_000)}</pre><p className="text-xs text-text-dim">Whitespace/key formatting only; no missing history or messages are fabricated. This does not write a file.</p><button className="btn-action" onClick={() => { setValidationText(repairPreview); setRepairPreview(null); }}>Use formatted content</button></div>}{report && <ValidationReport report={report} />}</section>}
  </div>;
}
