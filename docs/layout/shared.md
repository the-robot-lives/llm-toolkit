# packages/shared — Shared Types and Parsers

Types, JSONL parsers, and `ensureApi()` used by api, cli, and web.

```
shared/
├── src/
│   ├── parsers/                # Conversation JSONL parsers
│   ├── types/                  # UniversalMessage, AppConfig, SkillsConfig, …
│   ├── api-launcher.ts         # Node-only API auto-start (do not import from web)
│   ├── __tests__/
│   └── index.ts                # Re-exports (includes api-launcher)
├── package.json
└── tsconfig.json
```

Web UI should import types from this package carefully: the barrel also exports Node `api-launcher`.
