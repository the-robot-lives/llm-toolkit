# Project Layout

```
llm-toolkit/
├── bin/                            # Executable entry point
│   └── llm-toolkit               #   Launcher script (API + Web/TUI, zellij-aware)
├── packages/                       # Monorepo workspaces (pnpm)
│   ├── api/                        #   REST API server → [layout/api.md](layout/api.md)
│   ├── cli/                        #   Interactive TUI client → [layout/cli.md](layout/cli.md)
│   ├── shared/                     #   Shared types and parsers → [layout/shared.md](layout/shared.md)
│   └── web/                        #   Browser UI (Vite + React) → [layout/web.md](layout/web.md)
├── design/                         # Visual design assets
│   ├── logos/                      #   SVG logo variants + preview
│   ├── mockup-*.svg                #   Page mockups (dashboard, search, thread)
│   ├── SITEMAP.md                  #   Information architecture
│   ├── style-guide.md              #   Design system tokens and rules
│   └── README.md                   #   Design overview
├── docs/                           # Project documentation
│   ├── arch/                       #   Architecture detail pages (data-flow, storage, agent-watch-dog)
│   ├── layout/                     #   Layout detail pages
│   ├── PROJ-ARCH.md                #   Architecture overview
│   ├── PROJ-ARCH.summary.md        #   Architecture summary
│   ├── PROJ-LAYOUT.md              #   This file — project structure
│   └── PROJ-LAYOUT.summary.md      #   Layout summary
├── .gemini/                        # Gemini Code Assist review config
│   ├── config.yaml                 #   Reviewer settings
│   └── styleguide.md               #   Review style guide
├── .gitignore                      # Ignored files
├── INSTALL.md                      # Setup and installation guide
├── Makefile                        # install/uninstall/dev — symlinks bin/llm-toolkit → ~/.local/bin
├── package.json                    # Root workspace — scripts: dev:api, dev:web, dev:cli
├── pnpm-lock.yaml                  # Lockfile
├── pnpm-workspace.yaml             # Workspace config (packages/*)
├── tsconfig.base.json              # Shared TypeScript config
└── README.md                       # Project overview
```

## Key Files Requiring Setup

| File | Action |
|------|--------|
| `Makefile` | Run `make install` to install deps + symlink `llm-toolkit` |
| `pnpm-lock.yaml` | Or run `pnpm install` manually after clone |
| `INSTALL.md` | Follow for first-time setup |
