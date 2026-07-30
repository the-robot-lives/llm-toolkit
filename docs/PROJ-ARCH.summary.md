# Architecture Summary

Local-first tool for indexing, searching, editing, and extracting artifacts from AI coding-agent transcripts — evolving from a Claude Code log browser into agent-watch-dog, a multi-harness session-continuity tool (Claude + Codex importers live; Gemini/OpenCode/Aider stubbed). Three interfaces (REST API, browser SPA, terminal TUI) backed by a single SQLite database with FTS5 and sqlite-vec for full-text + semantic search. Chokidar file watching for incremental re-indexing. Self-contained pnpm/TypeScript project inside the Noizu Infra monorepo (`utilities/agent/llm-toolkit/`); its own `make install` symlinks `bin/llm-toolkit` into `~/.local/bin` (no k8-lib or .infra-config.yaml dependency).

## Components

- **API** (Hono) — IndexerService retains raw transcript events and derives universal messages into SQLite (harness-aware schema, FTS5/vec0 virtual tables); EmbeddingService (all-MiniLM-L6-v2, 384-dim); SearchService (FTS5 + cosine); LlmService (Anthropic SDK + OpenAI-compatible: OpenAI, LiteLLM/inference.noizu.com, Groq, Cerebras, DeepSeek, ZAI); editor/operations (versioned edits, clone/rehome/archive/tag); converter/exporter (agents, skills, runbooks, fine-tuning datasets); harness transfer/transform + session workflow. Routes: conversations, search, datasets, prompts, projects, tags, config, index, llm.
- **Web** (React + Vite + Tailwind) — SPA: Explore (search/browse), thread viewer, editor, project detail, datasets, prompts, tags, Safety Watch stub
- **CLI** (Ink) — TUI commands: search, list, show, index; interactive mode
- **Shared** — TypeScript types (UniversalMessage, AgentHarness), JSONL parsers, API auto-launcher
- **bin/llm-toolkit** — bash launcher (API + Web/TUI), zellij-aware

## Key Decisions

- Local-first: SQLite + local embeddings; LLM features optionally call external providers
- JSONL as source of truth; database is a derived index; edits are versioned, never destructive
- Raw transcript events preserved before normalization; harness transfer via Universal format, never provider-to-provider
- Monorepo with pnpm workspaces for shared types
- Hono over Express; sqlite-vec over pgvector (graceful degradation if unavailable)
