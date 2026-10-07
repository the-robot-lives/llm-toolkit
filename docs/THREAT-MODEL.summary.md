# Threat Model — Summary

Single-user local tool with an **unauthenticated network API** whose write
surface reaches agent-trusted files: harness MCP configs (`~/.claude.json`),
project-memory dirs, symlinked skill trees, and a supervisor that spawns
arbitrary commands. Crown jewels: transcript corpus (source + pasted secrets),
LLM keys in `settings.app_config`, harness config files.

Register: 2 mitigated · 5 partial · 3 open (T-001..T-010).

- **T-001 High/open** — API listens on all interfaces (no `hostname` in
  `serve()`); CORS is browser-only. LAN can read transcripts + hit write routes.
- **T-002 High/partial** — ServiceSupervisor spawns arbitrary commands from
  `npl-plugin.config.yaml`; start/stop routes unauthenticated. RCE-by-design.
- **T-003 High/partial** — MCP config rewrites can point harness agents at an
  attacker-controlled server; no URL/command allowlisting.
- **T-004 Medium/partial** — `/api/memory` project segment not validated
  against `..` (slug is); possible one-level escape — flagged for fix + test.
- **T-005 Medium/partial** — memory files are agent-consumed → persistent
  prompt-injection channel.
- **T-006 Medium/open** — no Host-header validation → DNS-rebinding
  no-preflight writes from remote pages.
- **T-007 Medium/accepted** — LLM keys plaintext in SQLite + API responses.
- **T-008 Low/mitigated** — symlink enable/disable refuses real-path removal,
  verifies targets within sources.
- **T-009 Low/open** — no audit trail of writes.
- **T-010 Low/partial** — pnpm deps, locally rebuilt napi `.node`, model
  download.

Residual risk: loopback-only reachability is *assumed* but not *enforced*;
binding `127.0.0.1` + Host allowlist would close T-001/T-006.

Details: docs/threats/local-api-perimeter.md · docs/threats/fs-write-surface.md
