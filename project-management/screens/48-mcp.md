# SCR-48 — MCP

**Surface:** web / macos  
**Type:** primary  
**Category:** Library  
**Route:** `/mcp`, `/mcp/:name`

## Purpose

Browse MCP server definitions (JSON/TOML source files, plus servers already
present in provider configs) and enable/disable them in:

- Claude: `~/.claude.json` (user) / `<project>/.mcp.json`
- Codex / Grok: `config.toml` `[mcp_servers.<name>]`
- Gemini: `settings.json` `mcpServers`
- OpenCode: `opencode.json(c)` `mcp`

Same provider / Global / Projects targeting bar as Skills. Secrets in headers
and env values are masked in the catalog.

## Related

- SCR-44 Skills
- `packages/web/src/pages/Mcp.tsx`
- `GET/POST /api/mcp*`
