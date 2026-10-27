# Changelog — utilities/agent/claude-assist

Claude Assist — local dev tool for searching, browsing, editing, and mining Claude Code conversations (pnpm workspace: `api`, `cli`, `shared`, `web`).

## 2026-10-27
- Connect Settings and Memories to therobot.is MCP with browser OAuth login, scoped capture/pinning, private token storage and loopback-only API; preserve the local Claude Memory Files editor (PR #22 → develop)
- Add Alibaba profile endpoint presets and test/fetch model options from unsaved settings, with strict discovery errors and masked-key connection protection (PR #21 → develop)
- Pin pnpm-managed Node 22.23.4 for local app/API launches to avoid the native SQLite crash with system Node 26 (PR #20 → develop)
- Restore API/CLI TypeScript builds by rewriting source import extensions, and align artifact/skill config-route test doubles with LLM profiles (PR #19 → develop)
- Multi-LLM profiles + two-tier incremental semantic indexing: profile CRUD with masked-key-safe PUT and cloud/local presets in web Settings, plus a content-hash incremental describe/embed → work-items pipeline in the API indexer (#5, merge `f52142c`)

## 2026-10-21
- Web console loads the annotate page-comments widget on the vite dev server only: host-gated script in `packages/web/index.html` (localhost/127.0.0.1 + port 5173) injects the pinned tobor-kit v1.1.0 bundle (SRI `sha384` + `crossorigin="anonymous"`) and mounts `<noizu-page-comments site="devbox">` against `annotate-srv.therobotlives.com` (#17; api-base host typo fixed in #18)

## [Unreleased]
- Agents, Commands, and MCP pages share the Skills targeting bar (providers, Global, projects); agents/commands symlink `*.md`, MCP writes provider config entries
- README, PROJ-ARCH, and PROJ-LAYOUT refreshed for the Mac host, Skills page, and current install targets
- Native macOS app (`apps/macos`) hosts the full web console with SwiftUI chrome, menus, server supervisor, and route parity for every implemented SPA page
- `make install-osx` (aliases: `install-macos`, `install/osx`, `install/macos`) builds `LLM Toolkit.app` and copies it to `/Applications`; the app bundle stamps the checkout path so the installed host still finds this tree
- Skills is a first-class sidebar page (`/skills`) with a category rail, skill list, and inspector; Settings only links to it
- Skills targeting is per-provider (Claude, Codex, Grok, Gemini, OpenCode) with a Global on/off and multi-select project dropdown; enable writes the matching `~/.…/skills` or `<project>/.…/skills` symlink for each selected target
- Web Layout/Harness grow a Mac-host bridge (`hostBridge.ts`) so the desktop shell can hide web chrome, navigate, and switch harnesses
- NPL architecture/layout docs refreshed: `docs/PROJ-ARCH.md`, `docs/PROJ-LAYOUT.md`, summaries, and per-package `docs/layout/{api,cli,web}.md` (commit `ff72b3565bf`, 2026-07-16)

## [m3-tui-and-provider-config] — 2026-06-27 — tag: `utilities-agent-claude-assist/m3-tui-and-provider-config`
Milestone summary: major interactive TUI expansion plus configurable LLM provider endpoints and interface selection.

### Added
- Session-continue workflow in the CLI: `ContinueSessionPage` + `sessionWorkflow` service for resuming conversations
- New TUI pages: Safety Watch and Style Guide; richer Explore page, Header, and conversation rows
- Custom LLM provider support in TUI Settings (provider, model, API key, base URL, apiType openai/anthropic)
- Interface selection at launch: `--interface web|tui` flag and `CLAUDE_ASSIST_DEFAULT_INTERFACE` env vars, with tests
- Focus context and selected-line components for keyboard navigation
- Indexer/search/storage service growth (~380 lines) with new indexer and search tests

### Changed
- API bootstrap (`index.ts`) rewired for the expanded indexer and storage services

## [m2-thread-editing-and-operations] — 2026-06-26 — tag: `utilities-agent-claude-assist/m2-thread-editing-and-operations`
Milestone summary: hardened conversation operations (non-destructive JSONL editing) and LLM API-key resolution.

### Added
- Operations service: JSONL entry loading, non-message-entry bucketing, edited-record building, synthetic records, session rewrites — with operations test suite
- Expanded web Edit page supporting the new editing operations
- LLM API-key resolution chain: masked-key detection, per-provider env vars (Anthropic, OpenAI, Groq, Cerebras, DeepSeek, Z.ai, LiteLLM), stored `app_config` fallback

### Changed
- Conversations routes and indexer updated for the new operation semantics; shared types extended

### Fixed
- Stray accidental file `2` committed then removed (net zero)

## [m1-subtree-import] — 2026-06-14 — tag: `utilities-agent-claude-assist/m1-subtree-import`
Milestone summary: project imported into the monorepo as a squashed git subtree and wired into utility installation.

### Added
- Initial import of Claude Assist (squashed subtree from external repo commit `c17f75c84fe`): Hono API with FTS5 + semantic search, React web UI, Ink interactive CLI, shared types package

### Changed
- Makefile install targets adjusted for monorepo utility installation
