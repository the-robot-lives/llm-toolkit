# SCR-44 — Skills

**Surface:** web / macos  
**Type:** primary  
**Category:** Library  
**Route:** `/skills`, `/skills/:name`

## Purpose

Browse SKILL.md packages grouped by `categories.yaml`, and enable/disable them as
symlinks into global `~/.claude/skills` or a project `.claude/skills`.

## Layout

- Target bar: provider chips (Claude / Codex / Grok / Gemini / OpenCode), Global on/off, multi-select Projects dropdown
- Left rail: category list with enabled/total counts
- Center: skill list with a master switch (all selected targets) and per-provider chips
- Right inspector: per-destination enable actions + SKILL.md
- Sources panel (toggled): pin SKILL.md source trees

## Related

- SCR-14 Settings (link only)
- SCR-46 Agents, SCR-47 Commands, SCR-48 MCP
- `packages/web/src/pages/Skills.tsx`
- `GET/POST /api/skills*`
