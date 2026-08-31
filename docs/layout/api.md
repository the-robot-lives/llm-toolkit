# packages/api — REST API Server

Hono server: index/search conversations (SQLite + FTS5 + sqlite-vec) and symlink SKILL.md packages. Listens on `:3100` and, when present, serves `packages/web/dist`.

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
│   │   └── storage.ts
│   ├── __tests__/
│   └── index.ts
├── package.json
└── tsconfig.json
```
