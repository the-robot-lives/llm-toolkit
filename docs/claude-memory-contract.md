# Claude Memory Tools — Cross-Implementation Contract

Normative implementation: **Rust** (`crates/claude-memory`) — it solely owns
filesystem CRUD. The Swift side (`apps/macos/Packages/ClaudeMemoryKit`) is a
REST **client** of the `/api/memory` surface (see the endpoint table below),
mirroring the Rust op names 1:1; it never touches the memory root directly.
Both suites assert against the shared golden fixtures in
`crates/claude-memory/tests/golden/`. On any disagreement, Rust output is the
spec unless a bug is proven in Rust — then fix Rust first, regenerate
`expected.json`, then reconcile the Swift client models in the same PR.

## Storage layout

- Root: `~/.claude/projects/` (overridable; core/napi APIs take an explicit
  root; the Swift client targets the REST surface and never resolves the root
  itself).
- Project: a directory under root, e.g. `-Users-keithbrings-Work-Space-Noizu`.
  Its memory dir is `<root>/<project>/memory/`.
- Index: `<memoryDir>/MEMORY.md`.
- Memory file: `<memoryDir>/<slug>.md`.

## Memory file format

```markdown
---
name: alpha-memory
description: "First test memory"
metadata:
  type: project
  modified: 2026-09-01T00:00:00.000Z
---

Body. [[wiki-links]] allowed. Searchable text here.
```

Frontmatter rules (line-based, dependency-free parser in both impls):

- `---` fence opens; next bare `---` line closes; absent/empty frontmatter =
  no frontmatter (all fields null).
- Flat entries: `key: value` (value may be bare or double-quoted; trim
  whitespace; keep verbatim otherwise).
- One nested map: `metadata:` followed by two-space-indented `child: value`
  lines (same quoting rules).
- Unknown keys, unknown metadata children, and blank lines inside the fence
  are preserved **in order** on rewrite.
- `name`, `description` (flat) and `metadata.type`, `metadata.modified` are
  the meaningful fields. Everything else round-trips.

## Index (MEMORY.md) rules

- Entry line: `- [<title>](<file>.md) — <hook>` — leading `-` + space,
  title in brackets, `(file.md)` where `file` is the slug, then an em-dash
  (` — `) + free-text hook. Parsing is tolerant: any `-[ ]` bullet line whose
  link target ends in `.md` is an entry; the separator may be em-dash or
  hyphen; hook may be empty. Title is entry text only (the display title is
  frontmatter `name` at render time; index title kept verbatim).
- Section headers (`## …`), blank lines, and any non-entry lines are
  preserved verbatim and in order on rewrite.
- `indexed` = at least one entry line references `<slug>.md`.
- On **create**: append entry line at end of file (title = memory `name`,
  hook = memory `description` truncated to ~120 chars on one line). If
  MEMORY.md does not exist, create it with `# Memory Index\n\n` then the line.
- On **delete**: remove every entry line referencing `<slug>.md`; leave all
  other lines untouched. Do not delete empty sections.
- Index writes are atomic (temp file + rename within the same directory).

## Slug rules

`^[A-Za-z0-9][A-Za-z0-9._-]*$`, never contains `..`, never starts with `.`.
Violations ⇒ `INVALID_SLUG`. File name is `<slug>.md`. Path traversal is
impossible by construction (single filename inside `memoryDir`, no separators
allowed).

## Operations (identical JSON shapes in napi, REST, Swift)

- `listProjects(root) → ProjectSummary[]`
  `{slug, memoryDir, indexPresent, memoryCount}` — projects = subdirectories
  of root; only those containing a `memory/` subdir; sorted by slug asc;
  `memoryCount` = `*.md` files excluding `MEMORY.md`.
- `listMemories(root, project) → {indexRaw, entries[]}` — `entries`:
  `MemorySummary[]` sorted by slug asc.
  `MemorySummary = {slug, fileName, title, description, type, modified,
  mtimeMs, sizeBytes, indexed, indexHook}` — `title` = frontmatter `name` or
  slug; `type`/`modified` = frontmatter values or null; `mtimeMs`/`sizeBytes`
  from the filesystem; `indexHook` = hook text from the index line or null.
- `readMemory(root, project, slug) → MemoryDetail` =
  MemorySummary + `{body, frontmatterRaw, raw}`. `raw` = full file bytes as
  UTF-8; `frontmatterRaw` = the inner frontmatter text (without fences) or
  null; `body` = text after the closing fence (leading newline stripped) or
  full text when no frontmatter. Missing file ⇒ `NOT_FOUND`.
- `searchMemories(root, query, project?) → SearchHit[]` — case-insensitive
  substring over title, description, body across one project or all.
  `{project, slug, field: "title"|"description"|"body", line, snippet}` —
  `line` = 1-based line number in the file; `snippet` = the full trimmed
  line, max 240 chars. Index (MEMORY.md) itself is NOT searched. Ordered:
  project slug asc, then slug asc, then field order title<description<body,
  then line asc.
- `createMemory(root, project, {slug, name?, description?, type?, body}) →
  {slug, indexUpdated}` — errors: `EXISTS`, `INVALID_SLUG`, `NO_PROJECT`
  (project dir or memory dir absent). Writes frontmatter from fields
  (`modified` = now UTC `YYYY-MM-DDTHH:MM:SS.sssZ`), body, then index line.
- `updateMemory(root, project, slug, {content?} | {name?/description?/type?/body?},
  syncIndex?) → {slug, indexUpdated}` — `content` = full raw replacement;
  otherwise field patch on parsed frontmatter/body. Always bumps
  `metadata.modified` to now on frontmatter-bearing files. `syncIndex`
  (default true): if indexed, rewrite the entry's title/hook when
  name/description changed; if not indexed, leave index untouched (no
  auto-add).
- `deleteMemory(root, project, slug) → {slug, fileDeleted, indexLinesRemoved}`
  — missing file still attempts index cleanup; `fileDeleted=false` then.

## Error convention

Core returns typed errors. napi message: `MEMORY_<CODE>: <detail>` (codes
`NOT_FOUND | EXISTS | INVALID_SLUG | NO_PROJECT | IO`). REST maps to 404 /
409 / 400 / 404 / 500 with `{error: "<CODE>", detail}`. Swift: `ClaudeMemoryError`
enum with the same cases.

## Sync policy (Rust ⇄ napi/REST ⇄ Swift)

1. `crates/claude-memory/tests/golden/` is the shared corpus: fixture inputs
   + `expected.json` generated by running the Rust implementation
   (`CLAUDE_MEMORY_REGEN=1` regenerates and drift-checks).
2. Rust behavior is checked against `expected.json` in `cargo test`; Swift
   client tests decode the same file to assert field-name/shape parity with
   the REST surface (normalizing checkout-dependent `mtimeMs` and the
   relativized `memoryDir`), not byte identity.
3. Any semantic change lands in Rust first, regenerates `expected.json`, then
   propagates in the same PR: napi/REST shapes, then Swift models.

## REST endpoints (`/api/memory`)

Implemented in `packages/api/src/routes/memory.ts` over the napi addon
(`crates/claude-memory-node`); the addon is lazy-loaded per request. The
memory root is `CLAUDE_MEMORY_ROOT` env or `~/.claude/projects`. This REST
surface is upstream spec for the Swift client.

| Method | Path | Request | Response (200) |
|---|---|---|---|
| GET | `/api/memory/projects` | — | `ProjectSummary[]` |
| GET | `/api/memory/search?query=&project=` | — | `SearchHit[]` |
| GET | `/api/memory/:project/memories` | — | `{indexRaw, entries: MemorySummary[]}` |
| GET | `/api/memory/:project/memories/:slug` | — | `MemoryDetail` |
| POST | `/api/memory/:project/memories` | `{slug, name?, description?, type?, body}` | `{slug, indexUpdated}` |
| PATCH | `/api/memory/:project/memories/:slug` | `{content?}` or `{name?, description?, type?, body?, syncIndex?}` | `{slug, indexUpdated}` |
| DELETE | `/api/memory/:project/memories/:slug` | — | `{slug, fileDeleted, indexLinesRemoved}` |

Field names match the napi/Rust JSON exactly (camelCase: `memoryDir`,
`indexPresent`, `memoryCount`, `fileName`, `mtimeMs`, `sizeBytes`,
`indexHook`, `indexRaw`, `indexUpdated`, `fileDeleted`,
`indexLinesRemoved`, `frontmatterRaw`). `description`, `type`, `modified`,
`indexHook`, `frontmatterRaw` are `null` when absent.

Error responses: HTTP status per code plus `{error: "<CODE>", detail}`;
mapping `NOT_FOUND → 404`, `NO_PROJECT → 404`, `EXISTS → 409`,
`INVALID_SLUG → 400`, `IO → 500` (also 500 for any unparseable error,
e.g. addon missing).
