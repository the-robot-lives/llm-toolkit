# AGENTS.md — llm-toolkit

Guidance for **Codex**, **Grok**, **Cursor**, and other `AGENTS.md` / `AGENT.md` tools.

Claude Code loads [CLAUDE.md](./CLAUDE.md). Same policy; this file is the harness-shaped sibling (numbered MUST first, markdown headings). If both this file and a parent `AGENTS.md` load, **this file wins on conflict**.

## MUST (every turn)

1. **Trinity Protocol (REQUIRED)**: substantive responses follow Orientation (assumption table, minds-eye, mermaid plan) → Friction (WEDGE/SHADOW/CRITIC) → Response + meta-review. Full text: monorepo `protocols/the-trinity-protocol.md`.
2. **No shell in main thread** — delegate lookups/builds/greps to tasker subagents; batch and summarize.
3. **Worktree workflow (REQUIRED)**: all work on worktrees; integration-testing consolidation branches `epic.<group>` fork from active `develop`; feature branches merge into their parent epic via squash-PR (provenance); a fully-passing epic becomes one PR for the group. See monorepo CLAUDE.md "Git Trees — Worktree Workflow".
4. **PRs target `develop`.** Never merge or push `main` (CI/CD-only release path).

## Identity

Local-first console for coding-agent conversations and skills (search/browse/edit/extract Claude Code + Codex transcripts; symlink SKILL.md packages into harness install folders). Monorepo role: NPL-ecosystem product (graduated from Portfolio/Utilities).

## Stack & commands

TypeScript, pnpm workspace + Makefile. Build/test: see `Makefile` targets and `package.json` scripts (`pnpm install` first).

## Branch & PR Policy

- Submodules sit on **`develop`** — keep your checkout on `develop`.
- All PRs target **`develop`** (feature/bug/task branches fork from `develop`).
- **`main` is CI/CD-only**: CI/CD automation performs all merges into `main` (release path). Never merge to or push `main` by hand.

## Pointers

- Claude Code baseline: [CLAUDE.md](./CLAUDE.md)
