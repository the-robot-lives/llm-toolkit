# SCR-47 — Commands

**Surface:** web / macos  
**Type:** primary  
**Category:** Library  
**Route:** `/commands`, `/commands/:name`

## Purpose

Browse slash-command `*.md` files and enable/disable them as file symlinks into
each provider’s commands directory (`~/.claude/commands`, `~/.codex/commands`,
`~/.grok/commands`, …). Same targeting bar as Skills.

## Related

- SCR-44 Skills
- `packages/web/src/pages/Commands.tsx`
- `GET/POST /api/commands*`
