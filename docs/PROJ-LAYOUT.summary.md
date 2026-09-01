# Project Layout — Summary

```
llm-toolkit/
├── .gemini/                    # Gemini review-agent config + styleguide
├── bin/llm-toolkit             # Launcher (api/web/zellij, CLI, skill proxy)
├── packages/
│   ├── api/                    # Hono REST + SQLite/FTS/vectors + skills routes
│   │   └── src/{routes,services}/
│   ├── cli/                    # Ink TUI + one-shot commands
│   │   └── src/{commands,interactive}/
│   ├── shared/                 # Types, parsers, ensureApi
│   └── web/                    # Vite + React + Tailwind SPA
│       └── src/{components,pages,hostBridge.ts}/
├── apps/macos/                 # SwiftUI + WKWebView host
│   └── Sources/{LLMToolkitKit,LLMToolkit}
├── skill-manage/               # Rust skill/agent/command linker
├── completions/                # bash + zsh
├── design/                     # Logos, mockups, style guide, sitemap
├── docs/
│   ├── arch/                   # data-flow, storage, agent-watch-dog, skills
│   ├── howto/
│   └── layout/                 # api, cli, shared, web, macos
├── project-management/         # Personas, screens (01–44), user stories
├── CHANGELOG.md
├── INSTALL.md
├── Makefile                    # install + install-osx
├── package.json
└── README.md
```
