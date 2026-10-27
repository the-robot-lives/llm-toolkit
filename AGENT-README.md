# AGENT-README

> Orientation for AI coding agents working in this repo. Human docs: README.md.

## Type

node-web+node-cli+rust+macos-app

## Purpose

Local-first console for coding-agent conversations and skills — search, browse, edit, and extract artifacts from Claude Code and Codex transcripts, then symlink SKILL.md packages into each harness's install folders (aka Claude Assist / agent-watch-dog).

## Stack

TypeScript pnpm workspace (Hono API + web SPA + Ink TUI CLI) over one SQLite index, plus a Rust `skill-manage` crate and a Swift macOS host (WKWebView around the SPA). Node 22 devEngines; pnpm 8+.

## Dev mode

```bash
pnpm install            # first
make install            # deps, skill-manage release, completions, ~/.local/bin/llm-toolkit
llm-toolkit             # API + web (or: pnpm dev:api + pnpm dev:web)
```

## Ports / URLs

- API http://localhost:3100 (`PORT` / `LLM_TOOLKIT_API_PORT`, also serves `packages/web/dist`)
- Web dev http://localhost:5173 (Vite)

## Tests

```bash
pnpm -r test            # or: pnpm test (root script)
pnpm -r typecheck       # typecheck all workspaces
```

## Gotchas

- Indexes `~/.claude/projects/` and `~/.codex/sessions/` on first boot; `LLM_TOOLKIT_DATA_DIR` (default `~/.llm-toolkit`) holds SQLite + config.
- `LLM_TOOLKIT_WATCH=false` disables the file watcher; `LLM_TOOLKIT_WATCH_PATHS` overrides the JSONL roots; `SKILL_REPO` adds a skills source.
- `llm-toolkit recent` opens the DB read-only and does not start the API.
- macOS desktop host is separate: `make install-osx` → `/Applications/LLM Toolkit.app` (not part of `make install`).
- Zsh completions need `fpath=(~/.local/share/zsh/site-functions $fpath)` before `compinit`.
