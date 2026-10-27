# llm-toolkit

<!-- 〚📁:b7bbbcd2-e54f-5469-b575-ec3da0df0106〛 llm-toolkit README :: Project entry point — what the toolkit does, install, quick start. -->

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

Agent model variants can declare a family in their YAML frontmatter. The Agents
view collapses these under the parent, with an expand button for individual
variants. Search includes provider, model, tier and account metadata and reveals
matching variants. Each definition retains its own enable/disable controls.

```yaml
name: npl-coder-glm-flash
model: zai/glm-5.3-flash  # Claude Code's execution model stays unchanged
parent: npl-coder
variant:
  provider: zai
  model: glm-5.3-flash
  account: zai
  # tier: sonnet  # optional; use only when the definition declares this tier
```

`parent` is the parent definition's filename without `.md`. If it isn't present,
the view creates a family heading. Variant metadata is optional; unannotated
agents stay independent. `provider` identifies the transport, `model` preserves
the model ID and any reasoning suffix, and `account` distinguishes actual routed
accounts such as `zai-alt`. Grouping changes presentation, not execution.

Key console routes: `/` `/search` `/browse` (explore), `/thread/:id` (+ `/edit` non-destructive editor, `/convert` extract agent/skill/command/runbook, `/continue` resume/transfer), `/skills` `/agents` `/commands` `/mcp` (catalog + enable), `/datasets` `/prompts` `/tags` `/projects` (library), `/settings` (index paths, embeddings, LLM).

## Repo Layout & Docs

- `packages/` — pnpm workspace: `api`, `web`, `cli`, `shared`
- `skill-manage/` — Cargo crate (skills linker binary)
- `apps/macos/` — Swift package (WKWebView host)

Full design: [docs/PROJ-ARCH.md](docs/PROJ-ARCH.md) · Tree: [docs/PROJ-LAYOUT.md](docs/PROJ-LAYOUT.md) · Tasks: [docs/PROJ-HOWTO.md](docs/PROJ-HOWTO.md) · FAQ: [docs/PROJ-FAQ.md](docs/PROJ-FAQ.md)

## Development

### Memories connection

Open **Settings → Memories · therobot.is**, or **Memories** in the sidebar, and choose **Connect to therobot.is**. Continue login in your browser, approve access, then return to Toolkit; connection status updates automatically. **Test connection** checks access to your memories. Enable **Allow capturing and editing memories** before connecting to grant write access; read-only connections can browse and search.

The native app keeps the existing local editor under **Claude Memory Files**. Connecting does not upload, move, or delete local files. Disconnect removes this app's local OAuth credentials and preserves your remote memories. Credentials are stored server-side in the Toolkit data directory with owner-only permissions, never in browser storage or Settings responses. The local API listens only on `127.0.0.1`.

```bash
pnpm dev:api          # Hono, reload
pnpm dev:web          # Vite, :5173
pnpm dev:cli
pnpm test
pnpm typecheck
pnpm build
```

License: MIT.

### LLM profiles in Settings

Choose **Alibaba Cloud (Model Studio)** to configure an Alibaba profile. Select the endpoint preset for your Token Plan, Coding Plan, or standard Model Studio key and region, or edit the base URL. These keys and endpoints are not interchangeable; see [Alibaba's endpoint reference](https://www.alibabacloud.com/help/en/model-studio/base-url).

Enter the key (or set `ALIBABA_API_KEY` / `DASHSCOPE_API_KEY`), then choose **Test & fetch models** before saving. The request uses the current draft fields without saving them or running a completion. Fetched model IDs appear in the Model field's dropdown; you can also enter a model ID manually. Providers that do not expose model discovery return an explicit error rather than a successful empty fallback. Discovery validates access to the model list, not that a completion will succeed for every listed model.
