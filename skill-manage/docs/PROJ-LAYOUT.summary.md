# Project Layout — Summary

```
skill-manage/
├── src/                        # Rust source
│   ├── main.rs                 #   entry + dispatch
│   ├── cli.rs                  #   clap CLI defs
│   ├── config.rs               #   config.yaml + env
│   ├── kinds.rs                #   core types
│   ├── sources.rs              #   source discovery
│   ├── link.rs                 #   symlink ops
│   ├── catalog.rs              #   catalog.yaml
│   ├── audit.rs                #   audit checks
│   ├── status.rs               #   status summary
│   └── tui/                    #   ratatui TUI
│       ├── mod.rs
│       ├── app.rs
│       └── ui.rs
├── schema/                     # example YAML configs
│   ├── config.example.yaml
│   └── catalog.example.yaml
├── docs/                       # documentation
│   ├── PROJ-LAYOUT.md
│   └── PROJ-LAYOUT.summary.md
├── .gitignore                  # ignores /target/, /coverage/
├── Cargo.toml                  # package manifest
├── Cargo.lock                  # locked deps
├── Makefile                    # compile/test/install
└── README.md                   # start here
```
