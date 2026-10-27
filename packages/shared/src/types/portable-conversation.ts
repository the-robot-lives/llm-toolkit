import type { AgentHarness, UniversalThread } from "./index.ts";

/** Versioned interchange envelope; the existing universal thread remains the source of truth. */
export interface PortableConversationDocument {
  format: "llm-toolkit.conversation";
  version: 1;
  thread: UniversalThread;
  selection?: {
    sourceThreadId: string;
    requestedMessageIds: string[];
    includedMessageIds: string[];
    dependencyMessageIds: string[];
    segments?: Array<{ messageIds: string[]; omittedBefore: number }>;
  };
}

export type NativeConversationHarness = Extract<AgentHarness, "claude" | "codex" | "gemini">;

export interface ConversationCompatibilityIssue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  messageId?: string;
  blockIndex?: number;
  path?: string;
  repairable?: boolean;
  line?: number;
  suggestion?: string;
}

/** Native renderers are pure: storage, indexes and configured destination roots are owned by the caller. */
export interface NativeConversationContext {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: string;
  sourceHarness: AgentHarness;
  cliVersion?: string;
  modelProvider?: string;
  geminiProjectIdentifier?: string;
}

export interface NativeConversationArtifact {
  harness: NativeConversationHarness;
  sessionId: string;
  /** Relative to ~/.claude/projects or ~/.codex/sessions (or the selected configured source root). */
  relativePath: string;
  records: Array<Record<string, unknown>>;
  jsonl: string;
  nativeFormat?: "jsonl" | "json";
  issues: ConversationCompatibilityIssue[];
  /** Executable and arguments, separately tokenized. Never interpolate these without shell quoting. */
  resumeArgs: string[];
}

export interface NativeConversationValidation {
  valid: boolean;
  issues: ConversationCompatibilityIssue[];
  compatibilityVersion?: string;
  complete?: boolean;
}

export interface NativeConversationAdapter {
  harness: NativeConversationHarness;
  compatibilityVersion?: string;
  render(thread: UniversalThread, context: NativeConversationContext): NativeConversationArtifact;
  validate(jsonl: string, context?: NativeConversationContext): NativeConversationValidation;
}

export interface ConversationValidationReport {
  schemaVersion: 1;
  provider: AgentHarness | "universal";
  compatibilityVersion: string;
  status: "valid" | "invalid" | "incomplete" | "unsupported";
  valid: boolean;
  errors: ConversationCompatibilityIssue[];
  warnings: ConversationCompatibilityIssue[];
  recordCount?: number;
}
