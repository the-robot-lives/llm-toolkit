import { parsePortableConversation } from "@llm-toolkit/shared";
import type { AgentHarness, ConversationCompatibilityIssue, ConversationValidationReport, NativeConversationAdapter, NativeConversationContext, NativeConversationHarness } from "@llm-toolkit/shared";

export type NativeAdapters = Partial<Record<NativeConversationHarness, NativeConversationAdapter>>;

export async function nativeConversationAdapters(): Promise<NativeAdapters> {
  const [claude, codex, gemini] = await Promise.all([import("./native/claude.ts"), import("./native/codex.ts"), import("./native/gemini.ts")]);
  return { claude: claude.claudeConversationAdapter, codex: codex.codexConversationAdapter, gemini: gemini.geminiConversationAdapter };
}

export async function validateConversationContent(content: string, target: AgentHarness | "universal", context?: NativeConversationContext, adapters?: NativeAdapters): Promise<ConversationValidationReport> {
  if (typeof content !== "string" || content.length > 50_000_000) return report(target, "limits/v1", [{ severity: "error", code: "document.size", path: "$", message: "Provide at most 50 MB of conversation data.", repairable: false }], false, 0);
  if (target === "universal") {
    try {
      const document = parsePortableConversation(content);
      return report(target, "llm-toolkit.conversation/v1", [], true, document.thread.messages.length);
    } catch (error) {
      return report(target, "llm-toolkit.conversation/v1", [{ severity: "error", code: "universal.invalid-document", path: "$.thread", message: error instanceof Error ? error.message : "Invalid universal conversation document", repairable: false }], true, 0);
    }
  }
  if (target !== "claude" && target !== "codex" && target !== "gemini") return { schemaVersion: 1, provider: target, compatibilityVersion: "unsupported", status: "unsupported", valid: false, errors: [], warnings: [{ severity: "warning", code: "adapter.unsupported", path: "$", message: `Native ${target} validation is not implemented. Use a universal document or Markdown export.`, repairable: false }] };
  const adapter = (adapters ?? await nativeConversationAdapters())[target];
  if (!adapter) return { schemaVersion: 1, provider: target, compatibilityVersion: "unsupported", status: "unsupported", valid: false, errors: [], warnings: [{ severity: "warning", code: "adapter.unavailable", path: "$", message: "This target adapter is not available in this build.", repairable: false }] };
  try {
    const validation = adapter.validate(content, context);
    const issues = validation.issues.map(normalizeIssue);
    if (!validation.valid && !issues.some((issue) => issue.severity === "error")) issues.push({ severity: "error", code: "native.invalid", path: "$", message: "The native conversation did not pass its validator", repairable: false });
    const complete = validation.complete !== false && !issues.some((issue) => /(?:opaque|unverified|unknown-extension|incomplete-history)/.test(issue.code));
    return report(target, validation.compatibilityVersion ?? adapter.compatibilityVersion ?? `${target}/unverified`, issues, complete, content.split("\n").filter((line) => line.trim()).length);
  } catch {
    return report(target, adapter.compatibilityVersion ?? `${target}/unverified`, [{ severity: "warning", code: "validator.failed", path: "$", message: "Validation could not complete. No conversation files were changed.", repairable: false }], false, 0);
  }
}

function normalizeIssue(issue: ConversationCompatibilityIssue): ConversationCompatibilityIssue {
  return { ...issue, code: issue.code.slice(0, 160), path: issue.path ?? (issue.line ? `/records/${issue.line - 1}` : "$"), repairable: issue.repairable ?? false, message: issue.message.slice(0, 2_000) };
}

function report(provider: AgentHarness | "universal", compatibilityVersion: string, issues: ConversationCompatibilityIssue[], complete: boolean, recordCount: number): ConversationValidationReport {
  const errors = issues.filter((issue) => issue.severity === "error").map(normalizeIssue);
  const warnings = issues.filter((issue) => issue.severity !== "error").map(normalizeIssue);
  const status = errors.length ? "invalid" : complete ? "valid" : "incomplete";
  return { schemaVersion: 1, provider, compatibilityVersion, status, valid: status === "valid", errors, warnings, recordCount };
}
