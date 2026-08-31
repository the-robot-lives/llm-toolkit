# SCR-46 — Agents

**Surface:** web / macos  
**Type:** primary  
**Category:** Library  
**Route:** `/agents`, `/agents/:name`

## Purpose

Browse `*.md` agent definitions and enable/disable them as file symlinks into
each provider’s global `~/.<provider>/agents` (or equivalent) and selected
project `.<provider>/agents` folders. Same targeting bar as Skills.

## Related

- SCR-44 Skills
- `packages/web/src/pages/Agents.tsx`
- `GET/POST /api/agents*`
