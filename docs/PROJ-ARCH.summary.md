# Architecture Summary

Local-first **llm-toolkit** (*Claude Assist* / *agent-watch-dog*): index coding-agent transcripts, search/browse/edit/extract, and symlink SKILL.md packages into harness folders. Clients: Hono API, React SPA, macOS WKWebView host, Ink TUI/CLI. SQLite is a derived index (FTS5 + optional sqlite-vec). Embedded **skill-manage** Rust crate. `make install` → `~/.local/bin/llm-toolkit`; `make install-osx` → `/Applications/LLM Toolkit.app`. No k8s deploy.

## Components

- **API** (Hono :3100) — IndexerService (JSONL → raw → universal → flat messages; chokidar); StorageService; EmbeddingService (MiniLM); SearchService; LlmService; editor/operations; converter/exporter; harness-transform (Claude/Codex); harness-transfer + session-workflow (pending write-back); SkillsService (categories.yaml + per-provider dests). Also serves `packages/web/dist`.
- **Web** — Explore, thread/edit/convert/continue, projects, datasets, prompts, tags, **Skills / Agents / Commands / MCP**, settings, Safety Watch stub, style guide. `hostBridge.ts` for the Mac host.
- **macOS** — SwiftUI + WKWebView around the same SPA; starts or attaches to `:3100`.
- **CLI** — `recent` (direct DB), `search`, `list`, `show`, `index`; full Ink TUI.
- **Shared** — types, JSONL parsers, `ensureApi()`.
- **skill-manage** — Rust symlink enable/disable/audit + catalog; `llm-toolkit skill …`.
- **bin/llm-toolkit** — zellij-aware API+web launcher, skill proxy, CLI dispatch.

## Data / Storage / Skills

- Index: harness JSONL → raw events → universal → flat messages (+ FTS / optional vectors).
- DB: `~/.llm-toolkit/llm-toolkit.db` (WAL; sqlite-vec degrades).
- Defaults: Claude `~/.claude/projects`, Codex `~/.codex/sessions`.
- CORS: localhost origins. Auth: none.
- Skills/agents/commands/MCP: same providers and targeting; skills+agents+commands symlink, MCP writes config entries.

## Key Decisions

- Local-first SQLite + local embeddings; external LLM optional
- JSONL source of truth; non-destructive versioned edits
- Raw retained before universal; transfer via Universal only
- One SPA hosted by browser and Mac
- Symlink skills from one source tree; never copy
- One PATH entry for web, TUI, API, and skill management

## Stack (short)

Node/tsx · Hono · better-sqlite3 + sqlite-vec · MiniLM · React/Vite/Tailwind · Ink · SwiftUI/WKWebView · Rust skill-manage · pnpm workspaces
