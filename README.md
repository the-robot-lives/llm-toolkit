# llm-toolkit

**Repo:** https://github.com/the-robot-lives/llm-toolkit

Local-first console for coding-agent conversations and skills — search, browse, edit, and extract artifacts from Claude Code and Codex transcripts, then symlink SKILL.md packages into each harness's install folders. Also known as *Claude Assist* / *agent-watch-dog*.

## What

A pnpm-workspace TypeScript app (Hono API + web SPA + CLI), plus a Rust `skill-manage` crate and a Swift macOS host. Five surfaces, one SQLite index:

| Surface | How |
|---------|-----|
| Web console | `llm-toolkit` or `pnpm dev:api` + `pnpm dev:web` |
| macOS app | `make install-osx` — WKWebView around the same SPA |
| Ink TUI | `llm-toolkit interactive` |
| One-shot CLI | `llm-toolkit recent`, `search`, `list`, `show`, `index` |
| Skills linker | Skills page in the console, or `llm-toolkit skill …` |

## Why

Agent conversations are locked in per-harness JSONL logs and hard to search, reuse, or mine for skills/runbooks. llm-toolkit turns those transcripts into a queryable local index and turns good sessions into reusable Skills, Agents, Commands, and MCP configs — installed across Claude, Codex, Grok, Gemini, and OpenCode from one place.

## Getting Started

Prerequisites: Node 18+, pnpm 8+ (macOS app additionally needs Swift/Xcode).

```bash
make install              # deps, skill-manage release, completions, ~/.local/bin/llm-toolkit
llm-toolkit               # API + web (zellij split when available)
```

Then open http://localhost:5173 (or http://localhost:3100 once the console is built). The API indexes `~/.claude/projects/` and `~/.codex/sessions/` on first boot.

macOS desktop host (same SPA, native sidebar):

```bash
make install-osx          # /Applications/LLM Toolkit.app  (not part of make install)
```

### Usage

```bash
llm-toolkit                 # launch API + web
llm-toolkit recent          # last hour, no server (reads SQLite)
llm-toolkit recent 2h --json
llm-toolkit search "auth middleware"
llm-toolkit list
llm-toolkit show <conversation-id>
llm-toolkit index

llm-toolkit skill list
llm-toolkit skill enable skills react-engineer --provider claude
llm-toolkit skill --help
```

`llm-toolkit recent` opens the existing DB read-only and does not start the API.

### Install targets

| Command | What it does |
|---------|----------------|
| `make install` | pnpm deps, skill-manage release, completions, `~/.local/bin/llm-toolkit` |
| `make install-osx` | Build and copy `LLM Toolkit.app` to `/Applications` (`INSTALL_DIR=` override) |
| `make install-completions` | bash + zsh completions only |
| `make macos-run` | Launch the Mac host from the checkout |

Zsh: add `fpath=(~/.local/share/zsh/site-functions $fpath)` before `compinit` if not already there. Walkthrough: [INSTALL.md](INSTALL.md).

### Configuration

| Variable | Default | Role |
|----------|---------|------|
| `LLM_TOOLKIT_DATA_DIR` | `~/.llm-toolkit` | SQLite + stored config |
| `LLM_TOOLKIT_WATCH_PATHS` | Claude + Codex defaults | Colon-separated JSONL roots |
| `LLM_TOOLKIT_WATCH` | `true` | Set `false` to disable the file watcher |
| `LLM_TOOLKIT_SKILL_FOLDERS` | auto-discover | Colon-separated SKILL.md trees |
| `SKILL_REPO` | | Extra skills source (skill-manage) |
| `PORT` / `LLM_TOOLKIT_API_PORT` | `3100` | API (also serves `packages/web/dist`) |
| `LLM_TOOLKIT_WEB_PORT` | `5173` | Vite |

Legacy `CLAUDE_ASSIST_*` names are still accepted.

## How It Works

JSONL transcripts are the source of truth. The indexer writes a derived SQLite index (raw events, universal messages, FTS5, optional MiniLM vectors). The SPA, Mac app, and TUI all call the local Hono API. Edits create versions; they never rewrite harness logs.

```
JSONL ──▶ Indexer ──▶ SQLite (FTS5 + vec)
                         │
                    Hono :3100
                   ╱    │     ╲
              Web SPA  TUI   Mac host
                         │
              Skills ──▶ per-provider symlinks
```

The **Skills**, **Agents**, **Commands**, and **MCP** sidebar pages share one targeting bar: pick providers, toggle **Global**, multi-select projects. Enablement is provider-agnostic:

| Kind | Source | Enable |
|------|--------|--------|
| Skills | `SKILL.md` folders | Directory symlink into `skills/` |
| Agents | `*.md` definitions | File symlink into `agents/<name>.md` |
| Commands | slash-command `*.md` | File symlink into `commands/<name>.md` |
| MCP | JSON/TOML defs (+ live configs) | Named server block in the provider config |

| Provider | Global skills | Project skills |
|----------|---------------|----------------|
| Claude | `~/.claude/skills` | `<project>/.claude/skills` |
| Codex | `~/.codex/skills` | `<project>/.codex/skills` |
| Grok | `~/.grok/skills` | `<project>/.grok/skills` |
| Gemini | `~/.gemini/skills` | `<project>/.gemini/skills` |
| OpenCode | `~/.config/opencode/skills` | `<project>/.opencode/skills` |

Agents/commands use the matching `agents/` and `commands/` folders. MCP writes `~/.claude.json` / `.mcp.json`, Codex/Grok `config.toml`, Gemini `settings.json`, or OpenCode `opencode.json`. Details: [docs/arch/skills.md](docs/arch/skills.md).

Key console routes: `/` `/search` `/browse` (explore), `/thread/:id` (+ `/edit` non-destructive editor, `/convert` extract agent/skill/command/runbook, `/continue` resume/transfer), `/skills` `/agents` `/commands` `/mcp` (catalog + enable), `/datasets` `/prompts` `/tags` `/projects` (library), `/settings` (index paths, embeddings, LLM).

## Repo Layout & Docs

- `packages/` — pnpm workspace: `api`, `web`, `cli`, `shared`
- `skill-manage/` — Cargo crate (skills linker binary)
- `apps/macos/` — Swift package (WKWebView host)

Full design: [docs/PROJ-ARCH.md](docs/PROJ-ARCH.md) · Tree: [docs/PROJ-LAYOUT.md](docs/PROJ-LAYOUT.md) · Tasks: [docs/PROJ-HOWTO.md](docs/PROJ-HOWTO.md) · FAQ: [docs/PROJ-FAQ.md](docs/PROJ-FAQ.md)

## Development

```bash
pnpm dev:api          # Hono, reload
pnpm dev:web          # Vite, :5173
pnpm dev:cli
pnpm test
pnpm typecheck
pnpm build
```

License: MIT.
