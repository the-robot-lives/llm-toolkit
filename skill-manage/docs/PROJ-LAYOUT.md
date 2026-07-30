# Project Layout

`skill-manage` is a Rust CLI/TUI utility that lists, enables, disables, and audits
coding-agent **skills**, **agents**, and **commands** by managing symlinks from
provider install roots (Claude / Codex / Grok) into configured source trees,
with a YAML catalog for tags, work types, and editor profiles.

```
skill-manage/
├── src/                        # Rust source (single binary: skill-manage)
│   ├── main.rs                 #   Entry point; module wiring + command dispatch
│   ├── cli.rs                  #   clap CLI definition (subcommands, flags, value enums)
│   ├── config.rs               #   AppConfig: config.yaml load, env overrides, path expansion
│   ├── kinds.rs                #   Core types: Kind, Provider, InstallStatus, SourceItem
│   ├── sources.rs              #   Source-root discovery of skills/agents/commands; skill structure checks
│   ├── link.rs                 #   Symlink enable/disable/classify; replace + backup safety rules
│   ├── catalog.rs              #   catalog.yaml: tags, work_types, editor profiles, validation
│   ├── audit.rs                #   Audit checks (broken links, structure, strict mode, JSON output)
│   ├── status.rs               #   `status` summary across kinds and providers
│   └── tui/                    #   Interactive ratatui TUI (`-i` / `tui` subcommand)
│       ├── mod.rs              #     TUI bootstrap; terminal setup + event loop
│       ├── app.rs              #     App state: screens, filters, toggles, catalog editing
│       └── ui.rs               #     Rendering: lists, status bar, help, profile screens
├── schema/                     # Example YAML configs (installed to ~/.local/share/skill-manage/schema)
│   ├── config.example.yaml     #   Source roots + provider install paths template
│   └── catalog.example.yaml    #   Tags/work_types/editor-profiles catalog template
├── docs/                       # Documentation
│   ├── PROJ-LAYOUT.md          #   This file
│   └── PROJ-LAYOUT.summary.md  #   Tree-only companion for tools/agents
├── .gitignore                  # Ignores /target/ and /coverage/
├── Cargo.toml                  # Package manifest (clap, ratatui, crossterm, serde_yaml, chrono)
├── Cargo.lock                  # Locked dependency versions
├── Makefile                    # compile/test/install targets (dispatched by ../../mk/subdirs.mk)
└── README.md                   # Usage, TUI keys, config/env vars, CLI summary — start here
```

Note: `target/` (cargo build output) is gitignored and intentionally omitted.

## Key Files Requiring Setup

| File | Action |
|------|--------|
| `~/.config/skill-manage/config.yaml` | Generate with `skill-manage init-config` (or use `SKILL_REPO`/`AGENT_REPO`/`COMMAND_REPO` env vars) |
| `~/.config/skill-manage/catalog.yaml` | Generate with `skill-manage catalog init` |

Install: `make -C utilities/agent/skill-manage install` → `~/.local/bin/skill-manage`.
