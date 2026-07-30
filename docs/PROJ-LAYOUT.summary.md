# Project Layout — Summary

```
llm-toolkit/
├── bin/                        # llm-toolkit launcher script
├── packages/
│   ├── api/                    # REST API server (Express + SQLite)
│   │   └── src/{routes,services}/
│   ├── cli/                    # TUI client (Ink)
│   │   └── src/{commands,interactive}/
│   ├── shared/                 # Types, parsers, utilities
│   │   └── src/{parsers,types}/
│   └── web/                    # Browser UI (Vite + React + Tailwind)
│       └── src/{components,context,hooks,pages,services}/
├── docs/                       # Architecture and layout documentation
│   ├── arch/
│   └── layout/
├── design/                     # Logos, mockups, style guide
├── .gemini/                    # Gemini review config
├── Makefile                    # make install → ~/.local/bin symlink
├── package.json                # Root workspace
├── pnpm-workspace.yaml         # Workspace config
├── tsconfig.base.json          # Shared TS config
├── INSTALL.md                  # Setup guide
└── README.md
```
