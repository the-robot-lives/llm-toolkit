import React from "react";
import type { ConversationCompatibilityIssue, ConversationValidationReport } from "@llm-toolkit/shared";

export interface NativeClonePreview {
  previewId: string;
  targetHarness: string;
  sessionId: string;
  title: string;
  projectPath: string;
  sourcePath: string;
  messageCount: number;
  jsonl: string;
  resumeCommand: string;
  report: ConversationValidationReport;
  issues: ConversationCompatibilityIssue[];
}

export function ValidationReport({ report }: { report: ConversationValidationReport }) {
  return <section className="space-y-2 rounded border border-border-subtle p-3" aria-label="Conversation validation report">
    <div className="flex flex-wrap items-center gap-2"><strong className={report.valid ? "text-green-400" : report.status === "invalid" ? "text-red-400" : "text-amber-300"}>{report.status.toUpperCase()}</strong><span className="text-xs text-text-muted">{report.provider} · {report.compatibilityVersion}</span></div>
    {!report.errors.length && !report.warnings.length && <p className="text-xs text-text-muted">Known structure and target rules passed.</p>}
    {[...report.errors, ...report.warnings].slice(0, 50).map((issue, index) => <div key={index} className="text-xs">
      <code className={issue.severity === "error" ? "text-red-400" : "text-amber-300"}>{issue.code}</code> <code className="text-text-dim">{issue.path ?? "$"}</code>
      <p className="text-text-primary">{issue.message}</p>{issue.suggestion && <p className="text-text-muted">{issue.suggestion}</p>}
    </div>)}
    {report.errors.length + report.warnings.length > 50 && <p className="text-xs text-text-dim">Showing the first 50 diagnostics. Copy the report for the complete list.</p>}
  </section>;
}

export function CloneApproval({ preview, busy, onCreate, onCancel }: { preview: NativeClonePreview; busy: boolean; onCreate: () => void; onCancel: () => void }) {
  return <section className="space-y-3 rounded-lg border border-glow/40 bg-surface-raised p-4" aria-label="Validated clone preview">
    <h2 className="font-medium text-text-bright">Create a new {preview.targetHarness} conversation</h2>
    <p className="text-sm text-text-muted">{preview.messageCount} source messages · {preview.title}. Source and target originals remain unchanged.</p>
    <p className="break-all font-mono text-xs text-text-dim">{preview.sourcePath}</p>
    <ValidationReport report={preview.report} />
    {!!preview.issues.length && <div className="space-y-1 text-xs text-amber-200">{preview.issues.slice(0, 30).map((issue, index) => <p key={index}>{issue.message}</p>)}</div>}
    <details><summary className="cursor-pointer text-xs text-text-muted">Native file preview</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-void p-3 text-xs text-text-muted">{preview.jsonl.slice(0, 80_000)}</pre>{preview.jsonl.length > 80_000 && <p className="text-xs text-text-dim">Showing 80,000 characters; the complete validated file will be written.</p>}</details>
    <div className="flex gap-2"><button className="btn-action-primary" disabled={busy || !preview.report.valid || preview.issues.some((issue) => issue.severity === "error")} onClick={onCreate}>{busy ? "Creating…" : "Create native clone"}</button><button className="btn-action" disabled={busy} onClick={onCancel}>Cancel preview</button></div>
  </section>;
}
