# Skills, agents, commands, and MCP

Two complementary surfaces manage harness packages. Neither writes conversation SQLite.

Skills, **agents**, **commands**, and **MCP** share the same targeting bar
(providers × Global × project roots). Enable/disable differs by kind.

## Discovery

The API scans configured **source folders** (or auto-discovers `skills/categories.yaml` walking up from cwd / `SKILL_REPO` / `LLM_TOOLKIT_SKILL_FOLDERS`). A source tree is a directory of skill folders (`SKILL.md` + optional assets). `categories.yaml` / `categories.yml` groups names; leftover packages land in Uncategorized.

## Targets

Enable creates a **directory symlink** from a provider install root to the canonical skill folder. Disable removes the symlink only when it is managed (never deletes a real copy unless the user confirms `--replace` / backup).

| Provider | Global | Project |
|----------|--------|---------|
| Claude | `~/.claude/skills/<name>/` | `<project>/.claude/skills/<name>/` |
| Codex | `~/.codex/skills/<name>/` | `<project>/.codex/skills/<name>/` |
| Grok | `~/.grok/skills/<name>/` | `<project>/.grok/skills/<name>/` |
| Gemini | `~/.gemini/skills/<name>/` | `<project>/.gemini/skills/<name>/` |
| OpenCode | `~/.config/opencode/skills/<name>/` | `<project>/.opencode/skills/<name>/` |

The Skills page (`/skills`) selects **providers**, a **Global** on/off, and a **multi-select of project roots**. The row switch applies to every selected target; provider chips on a row apply to one harness across those scopes. Agents (`/agents`), Commands (`/commands`), and MCP (`/mcp`) reuse that bar.

| Kind | Source shape | Enable |
|------|--------------|--------|
| Skills | Dir with `SKILL.md` | Directory symlink into `skills/` |
| Agents | `*.md` definitions | File symlink into `agents/<name>.md` |
| Commands | Slash-command `*.md` | File symlink into `commands/<name>.md` |
| MCP | JSON/TOML server defs (plus live provider configs) | Named entry in `~/.claude.json` / `.mcp.json` / `config.toml` `[mcp_servers]` / `settings.json` / `opencode.json` |

Config lives in SQLite `settings.app_config` (`skills` / `agents` / `commands` / `mcp`: `providers`, `globalEnabled`, `projectRoots`, `sourceFolders`). Unset kinds inherit Skills targeting.

## skill-manage

The embedded Rust crate (`llm-toolkit skill …`) is the CLI/TUI equivalent: same symlink rules, YAML catalog / work-type bundles, audit, and context-budget reports. It does not drive the web UI; both should point at the same source tree.

→ Nested crate docs: [skill-manage/docs/PROJ-ARCH.md](../../skill-manage/docs/PROJ-ARCH.md)
