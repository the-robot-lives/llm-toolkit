# Project Layout

pnpm monorepo: TypeScript packages under `packages/`, native Mac host under `apps/macos/`, embedded Rust skill linker under `skill-manage/`.

```
llm-toolkit/
├── .gemini/                          # Gemini code-review agent config + styleguide
├── bin/llm-toolkit                   # bash launcher (api/web/zellij, CLI, skill proxy)
├── packages/                         # pnpm workspaces (packages/*)
│   ├── api/                          # Hono REST + SQLite/FTS/vec → [layout/api.md](layout/api.md)
│   ├── cli/                          # Ink TUI + one-shots → [layout/cli.md](layout/cli.md)
│   ├── shared/                       # Types, parsers, ensureApi → [layout/shared.md](layout/shared.md)
│   └── web/                          # Vite + React SPA → [layout/web.md](layout/web.md)
├── apps/macos/                       # SwiftUI + WKWebView host → [layout/macos.md](layout/macos.md)
├── skill-manage/                     # Rust CLI/TUI symlink manager
│   ├── src/                          # clap + ratatui
│   ├── schema/                       # config + catalog examples
│   └── docs/                         # nested PROJ-* → skill-manage/docs/PROJ-LAYOUT.md
├── completions/                      # bash + zsh for launcher, CLI, skill
├── design/                           # logos, mockups, style-guide, SITEMAP
├── docs/                             # this tree
│   ├── arch/                         # data-flow, storage, agent-watch-dog, skills
│   ├── howto/                        # task guides
│   ├── layout/                       # api, cli, shared, web, macos
│   ├── PROJ-ARCH.md
│   ├── PROJ-SCHEMA.md                # SQLite + config-artifact reference
│   ├── PROJ-LAYOUT.md                # this file
│   ├── PROJ-HOWTO.md
│   ├── PROJ-FAQ.md
│   ├── PROJ-SCHEMA.summary.md        # condensed schema quick-reference
│   └── PROJ-LAYOUT.summary.md
├── project-management/               # PM artifacts (not runtime)
│   ├── components/                   # 01–40 + index.yaml
│   ├── personas/
│   ├── screens/                      # 01–44 + index.yaml
│   ├── user-stories/                 # US-001…US-100
│   └── ROADMAP.md
├── merge-notes.md                    # branch-sweep notes (sep-1 sweep)
├── CHANGELOG.md
├── INSTALL.md                        # setup walkthrough
├── Makefile                          # install, completions, macos, install-osx
├── package.json                      # dev:api | dev:web | dev:cli
├── pnpm-lock.yaml                    # setup-required
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md                         # start here
```

## Key Files Requiring Setup

| File | Action |
|------|--------|
| `pnpm-lock.yaml` / `package.json` | `pnpm install` (Node ≥ 18, pnpm ≥ 8) |
| `Makefile` | `make install` → `~/.local/bin/llm-toolkit` + completions; `make install-osx` → `/Applications/LLM Toolkit.app` |
| `INSTALL.md` | First-time walkthrough |
| skill-manage config | `llm-toolkit skill init-config` / `SKILL_REPO` — [skill-manage/docs/PROJ-LAYOUT.md](../skill-manage/docs/PROJ-LAYOUT.md) |
| Runtime data | `~/.llm-toolkit/` (created on API boot) |
| `apps/macos` | macOS 14+, Swift 5.10+ for `make install-osx` / `macos-run` |
