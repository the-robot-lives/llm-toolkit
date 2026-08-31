// Conversation source record types (from JSONL)
export type RecordType =
  | "permission-mode"
  | "user"
  | "assistant"
  | "attachment"
  | "system"
  | "file-history-snapshot"
  | "last-prompt"
  | "queue-operation"
  | "custom-title"
  | "agent-name";

export type AgentHarness = "claude" | "codex" | "gemini" | "opencode" | "aider" | "other";

export interface IndexSource {
  harness: AgentHarness;
  path: string;
  format?: "jsonl" | "auto";
  label?: string;
}

export type UniversalRole = "system" | "developer" | "user" | "assistant" | "tool";

export type UniversalContentBlock =
  | UniversalTextBlock
  | UniversalThinkingBlock
  | UniversalRedactedThinkingBlock
  | UniversalToolUseBlock
  | UniversalToolResultBlock
  | UniversalImageBlock
  | UniversalAudioBlock
  | UniversalDocumentBlock
  | UniversalUnknownBlock;

export interface UniversalBlockBase {
  id?: string;
  providerType?: string;
  providerHints?: Record<string, unknown>;
  providerRaw?: unknown;
  [key: string]: unknown;
}

export interface UniversalTextBlock extends UniversalBlockBase {
  type: "text";
  text: string;
  system?: boolean;
}

export interface UniversalThinkingBlock extends UniversalBlockBase {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface UniversalRedactedThinkingBlock extends UniversalBlockBase {
  type: "redacted_thinking";
  data?: string;
}

export interface UniversalToolUseBlock extends UniversalBlockBase {
  type: "tool_use";
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface UniversalToolResultBlock extends UniversalBlockBase {
  type: "tool_result";
  toolCallId: string;
  content: string | UniversalContentBlock[];
  isError?: boolean;
}

export interface UniversalImageBlock extends UniversalBlockBase {
  type: "image";
  mediaType?: string;
  source?: string;
  data?: string;
}

export interface UniversalAudioBlock extends UniversalBlockBase {
  type: "audio";
  mediaType?: string;
  source?: string;
  data?: string;
  transcript?: string;
}

export interface UniversalDocumentBlock extends UniversalBlockBase {
  type: "document";
  mediaType?: string;
  source?: string;
  data?: string;
  text?: string;
}

export interface UniversalUnknownBlock extends UniversalBlockBase {
  type: "unknown";
  raw: unknown;
}

export interface UniversalMessage {
  id: string;
  role: UniversalRole;
  timestamp: string;
  content: UniversalContentBlock[];
  providerMessageId?: string;
  model?: string;
  stopReason?: string | null;
  usage?: TokenUsage;
  provenance?: {
    harness: AgentHarness;
    sourcePath: string;
    rawIndex?: number;
    parentId?: string | null;
  };
  providerHints?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
  providerRaw?: unknown;
  [key: string]: unknown;
}

export interface RawTranscriptEvent {
  id: string;
  timestamp: string;
  harness: AgentHarness;
  eventType: string;
  raw: unknown;
}

export interface UniversalThread {
  id: string;
  harness: AgentHarness;
  sourcePath: string;
  projectPath: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  messages: UniversalMessage[];
  rawEvents?: RawTranscriptEvent[];
  providerMetadata?: Record<string, unknown>;
}

export interface BaseRecord {
  uuid: string;
  parentUuid: string | null;
  type: RecordType;
  timestamp: string;
  sessionId: string;
  isSidechain?: boolean;
}

export interface UserMessage extends BaseRecord {
  type: "user";
  message: {
    role: "user";
    content: string | ContentBlock[];
  };
  promptId?: string;
  permissionMode?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
}

export interface ContentBlock {
  type: "text" | "tool_result" | "tool_use" | "thinking";
  text?: string;
  thinking?: string;
  signature?: string;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Deep-clone a content block array and strip provider-specific fields
 * so the result is safe to send to any LLM provider.
 */
// ⟦𓉦𓉖𓊐𓎨⟧ standardizeContentBlocks :: Deep-clone a content block array and strip provider-specific fields
export function standardizeContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    const clean: ContentBlock = { type: block.type };

    switch (block.type) {
      case "text":
        clean.text = block.text ?? "";
        break;
      case "thinking":
        clean.thinking = block.thinking ?? "";
        // signature is Anthropic-specific; drop it
        break;
      case "tool_use":
        clean.id = block.id;
        clean.name = block.name;
        clean.input = block.input ? structuredClone(block.input) : {};
        break;
      case "tool_result":
        clean.tool_use_id = block.tool_use_id;
        clean.content = block.content;
        clean.is_error = block.is_error;
        break;
    }

    return clean;
  });
}

/**
 * Clone a full message array (user/assistant), standardizing content blocks
 * and stripping provider-specific fields for cross-model compatibility.
 */
// ⟦𓂑𓂘𓉨𓏯⟧ standardizeMessages :: Clone a full message array (user/assistant), standardizing content blocks
export function standardizeMessages(
  messages: Array<{ role: string; content: string | ContentBlock[]; [k: string]: unknown }>,
): Array<{ role: string; content: string | ContentBlock[] }> {
  return messages.map((msg) => ({
    role: msg.role,
    content: typeof msg.content === "string"
      ? msg.content
      : standardizeContentBlocks(msg.content),
  }));
}

export interface AssistantMessage extends BaseRecord {
  type: "assistant";
  message: {
    model: string;
    role: "assistant";
    content: ContentBlock[];
    stop_reason: string | null;
    usage?: TokenUsage;
  };
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// Index database types
export interface Conversation {
  id: string;
  harness: AgentHarness;
  projectPath: string;
  startedAt: Date;
  updatedAt: Date;
  messageCount: number;
  title: string;
  slug: string | null;
  description: string | null;
  summary: string | null;
  tags: string[];
  status: "active" | "archived" | "edited";
  sourcePath: string;
  firstMessage?: string;
  lastMessage?: string;
}

export interface SearchResult {
  conversation: Conversation;
  snippet: string;
  highlights: Array<{ start: number; end: number }>;
  relevance: number;
}

export interface SearchOptions {
  query: string;
  mode: "fts" | "semantic";
  harness?: AgentHarness;
  project?: string;
  dateFrom?: Date;
  dateTo?: Date;
  role?: "user" | "assistant" | "tool";
  limit?: number;
  offset?: number;
}

// Thread editing
export interface ThreadEdit {
  id: string;
  sourceId: string;
  createdAt: Date;
  description: string;
  messages: EditedMessage[];
}

export interface EditedMessage {
  originalIndex?: number;
  role: "user" | "assistant" | "system";
  content: string;
  injected?: boolean;
  collapsed?: boolean;
  template?: string;
  rawRecord?: unknown;
  rawEdited?: boolean;
}

// Conversion artifacts
export type ArtifactType = "agent" | "skill" | "command" | "snippet" | "runbook";

export interface ConversionCandidate {
  type: ArtifactType;
  startIndex: number;
  endIndex: number;
  confidence: number;
  description: string;
}

export interface Artifact {
  type: ArtifactType;
  name: string;
  description: string;
  content: string;
  sourceConversationId: string;
  sourceMessageRange: [number, number];
}

// Dataset types
export type QualityLabel = "gold" | "silver" | "bronze";

export interface Dataset {
  name: string;
  description: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  entryCount: number;
}

export interface DatasetEntry {
  id: string;
  datasetName: string;
  conversationId: string;
  editId?: string;
  startIndex: number;
  endIndex: number;
  quality: QualityLabel;
  systemPrompt?: string;
  messages: Array<{ role: string; content: string }>;
  createdAt: Date;
}

// API response wrappers
export interface ApiResponse<T> {
  data: T;
  meta?: {
    total?: number;
    page?: number;
    limit?: number;
  };
}

export interface ApiError {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

// Config
export type LlmProvider =
  | "anthropic"
  | "openai"
  | "ollama"
  | "litellm"
  | "groq"
  | "cerebras"
  | "deepseek"
  | "zai"
  | "custom";

export interface LlmConfig {
  provider: LlmProvider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  apiType?: "openai" | "anthropic";
}

export type SkillDestinationKind = "global" | "project";

export type SkillInstallStatus = "enabled" | "disabled" | "foreign" | "real" | "broken";

export type SkillProvider = "claude" | "codex" | "grok" | "gemini" | "opencode";

export type ArtifactKind = "skills" | "agents" | "commands" | "mcp";

export type ArtifactLinkStyle = "dir" | "file" | "config";

export type McpConfigFormat = "claude-json" | "mcp-json" | "toml-mcp" | "json-mcpServers" | "opencode-json";

export interface SkillProviderSpec {
  id: SkillProvider;
  title: string;
  /** Home-level skills dir, using ~ */
  globalDir: string;
  /** Project-relative skills dir */
  projectDir: string;
}

export interface ArtifactDestSpec {
  /** Home-level dest (dir or config file), using ~ */
  global: string;
  /** Project-relative dest (dir or config file) */
  project: string;
  style: ArtifactLinkStyle;
  /** Destination filename suffix for file-style kinds (e.g. ".md") */
  suffix?: string;
  format?: McpConfigFormat;
}

export const SKILL_PROVIDER_ORDER: SkillProvider[] = ["claude", "codex", "grok", "gemini", "opencode"];

export const ARTIFACT_KIND_ORDER: ArtifactKind[] = ["skills", "agents", "commands", "mcp"];

const PROVIDER_TITLES: Record<SkillProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  gemini: "Gemini",
  opencode: "OpenCode",
};

export const ARTIFACT_DEST_SPECS: Record<SkillProvider, Record<ArtifactKind, ArtifactDestSpec>> = {
  claude: {
    skills: { global: "~/.claude/skills", project: ".claude/skills", style: "dir" },
    agents: { global: "~/.claude/agents", project: ".claude/agents", style: "file", suffix: ".md" },
    commands: { global: "~/.claude/commands", project: ".claude/commands", style: "file", suffix: ".md" },
    mcp: { global: "~/.claude.json", project: ".mcp.json", style: "config", format: "claude-json" },
  },
  codex: {
    skills: { global: "~/.codex/skills", project: ".codex/skills", style: "dir" },
    agents: { global: "~/.codex/agents", project: ".codex/agents", style: "file", suffix: ".md" },
    commands: { global: "~/.codex/commands", project: ".codex/commands", style: "file", suffix: ".md" },
    mcp: { global: "~/.codex/config.toml", project: ".codex/config.toml", style: "config", format: "toml-mcp" },
  },
  grok: {
    skills: { global: "~/.grok/skills", project: ".grok/skills", style: "dir" },
    agents: { global: "~/.grok/agents", project: ".grok/agents", style: "file", suffix: ".md" },
    commands: { global: "~/.grok/commands", project: ".grok/commands", style: "file", suffix: ".md" },
    mcp: { global: "~/.grok/config.toml", project: ".grok/config.toml", style: "config", format: "toml-mcp" },
  },
  gemini: {
    skills: { global: "~/.gemini/skills", project: ".gemini/skills", style: "dir" },
    agents: { global: "~/.gemini/agents", project: ".gemini/agents", style: "file", suffix: ".md" },
    commands: { global: "~/.gemini/commands", project: ".gemini/commands", style: "file", suffix: ".md" },
    mcp: { global: "~/.gemini/settings.json", project: ".gemini/settings.json", style: "config", format: "json-mcpServers" },
  },
  opencode: {
    skills: { global: "~/.config/opencode/skills", project: ".opencode/skills", style: "dir" },
    agents: { global: "~/.config/opencode/agents", project: ".opencode/agents", style: "file", suffix: ".md" },
    commands: { global: "~/.config/opencode/commands", project: ".opencode/commands", style: "file", suffix: ".md" },
    mcp: { global: "~/.config/opencode/opencode.jsonc", project: "opencode.json", style: "config", format: "opencode-json" },
  },
};

export const SKILL_PROVIDER_SPECS: Record<SkillProvider, SkillProviderSpec> = {
  claude: { id: "claude", title: PROVIDER_TITLES.claude, globalDir: ARTIFACT_DEST_SPECS.claude.skills.global, projectDir: ARTIFACT_DEST_SPECS.claude.skills.project },
  codex: { id: "codex", title: PROVIDER_TITLES.codex, globalDir: ARTIFACT_DEST_SPECS.codex.skills.global, projectDir: ARTIFACT_DEST_SPECS.codex.skills.project },
  grok: { id: "grok", title: PROVIDER_TITLES.grok, globalDir: ARTIFACT_DEST_SPECS.grok.skills.global, projectDir: ARTIFACT_DEST_SPECS.grok.skills.project },
  gemini: { id: "gemini", title: PROVIDER_TITLES.gemini, globalDir: ARTIFACT_DEST_SPECS.gemini.skills.global, projectDir: ARTIFACT_DEST_SPECS.gemini.skills.project },
  opencode: { id: "opencode", title: PROVIDER_TITLES.opencode, globalDir: ARTIFACT_DEST_SPECS.opencode.skills.global, projectDir: ARTIFACT_DEST_SPECS.opencode.skills.project },
};

export interface SkillDestination {
  id: string;
  label: string;
  /** Absolute (or ~) path to a skills directory, e.g. ~/.claude/skills or <project>/.claude/skills */
  path: string;
  kind: SkillDestinationKind;
  provider?: SkillProvider;
  projectRoot?: string;
}

export interface SkillsConfig {
  /** Source trees that contain SKILL.md packages and optional categories.yaml */
  sourceFolders: string[];
  /** Providers whose skill folders are targeted */
  providers?: SkillProvider[];
  /** When true, include each selected provider's home-level skills dir */
  globalEnabled?: boolean;
  /** Project roots; each becomes <root>/<provider.projectDir> for selected providers */
  projectRoots?: string[];
  /** Legacy explicit dest list — still honored if providers is unset */
  destinations?: SkillDestination[];
}

export interface AppConfig {
  indexPaths: string[];
  indexSources?: IndexSource[];
  embedding: {
    provider: "local" | "openai" | "voyage" | "anthropic";
    model?: string;
    apiKey?: string;
  };
  llm?: LlmConfig;
  server: {
    port: number;
    host: string;
  };
  skills?: SkillsConfig;
  agents?: SkillsConfig;
  commands?: SkillsConfig;
  mcp?: SkillsConfig;
}

// LLM inference
export interface LlmCompletionRequest {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string | ContentBlock[] }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmCompletionResponse {
  content: string;
  model: string;
  provider: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  finishReason: string;
}
