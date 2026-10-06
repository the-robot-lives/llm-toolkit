# packages/api — REST API Server

Hono server: index/search conversations (SQLite + FTS5 + sqlite-vec), symlink SKILL.md packages, and Claude Code project-memory CRUD via the Rust `claude-memory` napi module. Listens on `:3100` and, when present, serves `packages/web/dist`.

```
api/
├── src/
│   ├── routes/
│   │   ├── config.ts           # GET/PATCH /config (incl. skills targeting)
│   │   ├── conversations.ts
│   │   ├── datasets.ts
│   │   ├── index-routes.ts     # /index rebuild + status
│   │   ├── llm.ts
│   │   ├── artifacts.ts        # shared catalog/apply for skills, agents, commands, mcp
│   │   ├── skills.ts           # /api/skills alias
│   │   ├── projects.ts
│   │   ├── prompts.ts
│   │   ├── search.ts
│   │   ├── services.ts        # NPL plugin config + service-supervisor start/stop
│   │   ├── memory.ts          # /api/memory — claude-memory napi CRUD
│   │   ├── memory-types.ts    # memory route DTOs
│   │   └── tags.ts
│   ├── services/
│   │   ├── converter.ts
│   │   ├── editor.ts
│   │   ├── embeddings.ts
│   │   ├── exporter.ts
│   │   ├── harness-transfer.ts
│   │   ├── harness-transform.ts
│   │   ├── indexer.ts
│   │   ├── llm.ts
│   │   ├── operations.ts
│   │   ├── search.ts
│   │   ├── session-workflow.ts
│   │   ├── skills.ts           # SKILL.md scan + symlink
│   │   ├── artifacts.ts        # agents/commands/mcp + shared targeting
│   │   ├── mcp-config.ts       # JSON/TOML MCP enable/disable
│   │   ├── service-supervisor.ts # child-process lifecycle for services routes
│   │   └── storage.ts
│   ├── __tests__/
│   └── index.ts
├── native/                    # claude-memory napi binding (index.js/index.d.ts tracked;
│                              # *.node built via pnpm build:memory-native, gitignored)
├── package.json
└── tsconfig.json
```
