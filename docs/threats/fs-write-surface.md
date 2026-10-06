# Filesystem Write Surface

Trust boundary: API process → files that other programs (coding agents, shells) later consume. These writes matter because they change what trusted agents execute or read.

## Service supervisor (T-002)

`packages/api/src/services/service-supervisor.ts` `spawn`s `svc.command` with
`svc.args` from the resolved `npl-plugin.config.yaml` (project `.npl/` walk-up,
else `~/.config/npl/`). This is command execution **by design** — the config
file is the trust anchor. Anyone who can write that file (or reach the
unauthenticated `/api/services/:name/start` route, see T-001) gets arbitrary
process execution as the local user. Config validation covers shape (name
`^[a-z0-9-]+$`, http⇒url), not command safety.

`mcp_sync.targets` additionally propagates service registrations into host MCP
config files (overlaps T-003).

## MCP config rewrites (T-003)

`mcp-config.ts` reads and rewrites `mcpServers` maps in `~/.claude.json`,
`*.mcp.json`, `*settings.json`, and Codex-style TOML. A registered server
entry (URL/command + env) is executed/trusted by Claude Code and other
harnesses on next session. A malicious entry = remote code/credential channel
for every future agent session. Mitigations: writes happen only through
explicit user action in the UI/API; entries always name the llm-toolkit server.
Gap: no verification that user-entered server URLs/commands point where the
user thinks they point (no allowlist, no confirmation of egress targets).

## Memory writes (T-004 / T-005)

`/api/memory` performs CRUD over `~/.claude/projects/<project>/memory/`
(`MEMORY.md` index + frontmatter `slug.md` files) via the Rust
`crates/claude-memory` napi module; the Swift `ClaudeMemoryKit` is REST-only
(never touches the FS — per `docs/claude-memory-contract.md`).

- **Path traversal**: the Rust core validates `slug` (rejects empty, `..`,
  separators — `validate_slug`), but the **project segment** from the URL is
  joined unvalidated (`memory_dir = root.join(project).join("memory")`). A
  project of `..` points one level above the root. Reads/writes outside the
  intended tree have not been demonstrated end-to-end — flagged for a fix +
  test, not asserted as exploitable.
- **Persistent prompt injection**: memory files are read by Claude Code agents
  as trusted context. Anything that can reach the write surface (T-001/T-006,
  or a malicious skill linked via T-008 surface) can plant instructions that
  outlive the session. No provenance/sandboxing exists.

## Symlink operations (T-008)

`skills.ts`/`artifacts.ts` enable skills/agents/commands as **symlinks** from
one canonical source tree into per-provider dests. Safety properties verified
in code: refuses to remove real (non-symlink) paths, verifies existing symlink
targets stay within managed sources, never deletes real copies. Residual
risk: the *content* of a linked skill is executed/read by agents (same
prompt-injection class as memory), and a compromised source repo propagates
by design — that is the symlink model's stated trade-off.
