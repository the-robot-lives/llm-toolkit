# llm-toolkit

Local-first console for coding-agent conversations and skills. Search, browse, edit, and extract artifacts from Claude Code and Codex transcripts — then symlink SKILL.md packages into each harness’s install folders.

Also known as *Claude Assist* / *agent-watch-dog*.

## Quick start

```bash
# Node 18+, pnpm 8+
make install              # deps, skill-manage, completions, ~/.local/bin/llm-toolkit
llm-toolkit               # API + web (zellij split when available)
```

Then open http://localhost:5173 (or http://localhost:3100 once the console is built). The API indexes `~/.claude/projects/` and `~/.codex/sessions/` on first boot.

macOS desktop host (same SPA, native sidebar):

```bash
make install-osx          # /Applications/LLM Toolkit.app  (not part of make install)
open "/Applications/LLM Toolkit.app"
```

## Surfaces

| Surface | How |
|---------|-----|
| Web console | `llm-toolkit` or `pnpm dev:api` + `pnpm dev:web` |
| macOS app | `make install-osx` — WKWebView around the same SPA |
| Ink TUI | `llm-toolkit interactive` |
| One-shot CLI | `llm-toolkit recent`, `search`, `list`, `show`, `index` |
| Skills linker | Skills page in the console, or `llm-toolkit skill …` |

## Usage

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

## Skills, agents, commands, MCP

The **Skills**, **Agents**, **Commands**, and **MCP** sidebar pages share one targeting bar: pick providers, turn **Global** on/off, multi-select projects. The row switch hits every selected target.

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

Agents/commands use the matching `agents/` and `commands/` folders. MCP writes `~/.claude.json` / `.mcp.json`, Codex/Grok `config.toml`, Gemini `settings.json`, or OpenCode `opencode.json`. CLI equivalent for the symlink kinds: `llm-toolkit skill`. Details: [docs/arch/skills.md](docs/arch/skills.md).

## Console routes

| Route | Purpose |
|-------|---------|
| `/` `/search` `/browse` | Explore — FTS / semantic search and browse |
| `/thread/:id` | Thread viewer (markdown, code, Mermaid, LaTeX) |
| `/thread/:id/edit` | Non-destructive editor (source JSONL untouched) |
| `/thread/:id/convert` | Extract agent / skill / command / runbook |
| `/thread/:id/continue` | Resume / transfer continuation |
| `/skills` `/agents` `/commands` `/mcp` | Catalog + enable into provider dests |
| `/datasets` `/prompts` `/tags` `/projects` | Library |
| `/settings` | Index paths, embeddings, LLM |
| `/safety-watch` `/style-guides` | Stubs / reference |

## Install targets

| Command | What it does |
|---------|----------------|
| `make install` | pnpm deps, skill-manage release, completions, `~/.local/bin/llm-toolkit` |
| `make install-osx` | Build and copy `LLM Toolkit.app` to `/Applications` (`INSTALL_DIR=` override) |
| `make install-completions` | bash + zsh completions only |
| `make macos-run` | Launch the Mac host from the checkout |

Zsh: add `fpath=(~/.local/share/zsh/site-functions $fpath)` before `compinit` if it is not already there. Walkthrough: [INSTALL.md](INSTALL.md).

## Configuration

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

## Architecture

JSONL transcripts are the source of truth. The indexer writes a derived SQLite index (raw events, universal messages, FTS, optional MiniLM vectors). The SPA, Mac app, and TUI all call the local Hono API. Edits create versions; they never rewrite harness logs.

```
JSONL ──▶ Indexer ──▶ SQLite (FTS5 + vec)
                         │
                    Hono :3100
                   ╱    │     ╲
              Web SPA  TUI   Mac host
                         │
              Skills ──▶ per-provider symlinks
```

Full design: [docs/PROJ-ARCH.md](docs/PROJ-ARCH.md). Tree: [docs/PROJ-LAYOUT.md](docs/PROJ-LAYOUT.md). Tasks: [docs/PROJ-HOWTO.md](docs/PROJ-HOWTO.md). FAQ: [docs/PROJ-FAQ.md](docs/PROJ-FAQ.md).

## Development

```bash
pnpm dev:api          # Hono, reload
pnpm dev:web          # Vite, :5173
pnpm dev:cli
pnpm test
pnpm typecheck
pnpm build
```

`packages/*` is a pnpm workspace; `skill-manage/` is a Cargo crate; `apps/macos/` is a Swift package.

## License

MIT
