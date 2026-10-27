# Codex conversation compatibility

Verified on 2026-10-27 with installed `codex-cli 0.164.0`. The matching first-party
release is `rust-v0.164.0`, commit `6aaac694803004a63c6f393d153c96d22521a6b9`.
This is a versioned file adapter, not a claim that private rollout storage is a
stable public import API.

## Contracts checked

- [Official app-server documentation](https://learn.chatgpt.com/docs/app-server)
  describes reading history, resuming a thread, and forking stored history.
- [Installed-version session and turn types](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/protocol/src/protocol.rs)
  define `SessionMeta`, `SessionMetaLine`, `ThreadHistoryMode`, and display events.
- [Installed-version response types](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/protocol/src/models.rs)
  define message content, function/custom calls and outputs, and assistant phases.
- [Rollout serialization](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/history/src/rollout_payload.rs)
  and [the recorder](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/rollout/src/recorder.rs)
  define JSONL records. The recorder can skip malformed lines, so successful file
  lookup alone is insufficient validation.
- [The title index](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/rollout/src/session_index.rs)
  is append-only `session_index.jsonl`, with `id`, `thread_name`, and `updated_at`.

The local command `codex app-server generate-json-schema --experimental --out DIR`
was also checked. Its `ThreadResumeParams.history` explicitly says it is unstable
and intended for Codex Cloud; the adapter does not use it as a generic import API.

## Native clone output

New clones receive fresh UUIDs, an explicit destination directory, and a dated
`sessions/YYYY/MM/DD/rollout-TIMESTAMP-UUID.jsonl` path. Their self-contained header
uses legacy history mode, a matching root `session_id`, the writer originator and
CLI compatibility version. No source sandbox, approval policy, base instructions,
dynamic tool definitions, account identifiers, fork pointers, or runtime state is
activated in the clone. The target's own configuration remains authoritative.

User and assistant model-context records use `input_text` and `output_text`.
Function/custom calls are standalone response items with string arguments and
matching standalone outputs. They are never nested inside message content.
Closed native Codex pairs can remain native; foreign, duplicate, cross-turn, or
incomplete tool interactions become labelled readable history with compatibility
notices. Per-message provenance controls this decision for mixed-provider inserts.
Protected reasoning and opaque controls remain in the portable archive; no foreign
signature or encrypted state is invented for the target.

Each imported user turn also receives harmless historical task boundaries and
`user_message`/`agent_message` display events. This matters: an isolated native
test showed that model-context records alone can parse successfully while exposing
zero visible turns. With the display events, the installed app-server returned the
expected user and assistant items. Historical display events do not execute tools.

The pure renderer does not write files or update indexes. The storage caller must
validate, exclusively create the target file, validate the written file, and append
the optional title-index entry. Tokenized resume arguments avoid shell injection.

## Reading paginated history

Physical paginated rollout files may inherit a prefix through `history_base`; they
may also contain retained or reverted history even without an external prefix.
The indexing parser preserves physical records and labels that view incomplete.
The export/clone path must call `readCodexConversation`, which materializes every
visible turn using only `thread/read`, `thread/turns/list` with full items, and
`thread/items/list` where necessary. Cursors are checked for repetition and bounded.
The returned thread identity and source path must match, and the source file must
remain unchanged during reading. No resume, new turn, compaction, login, tool
execution, or server approval is requested.

Public history projection does not expose every opaque model-context field.
Materialized output states that limitation and preserves the original physical
records and ancestry references separately. Missing parents, unsupported readers,
invalid pagination, or changed sources fail instead of returning a partial clone.

## Validator scope

Diagnostics use stable `codex.*` codes, record paths, and repairability hints. They
do not echo malformed source content. Required identity/header fields, timestamps,
message roles/content, phase values, turn boundaries, and call/output relationships
are checked. Existing native policy/runtime records are distinguished from the
stricter safe-new-clone subset. Opaque or version-drift records produce explicit
coverage gaps (`complete: false`), not invented validation guarantees.

The focused native test uses an isolated `CODEX_HOME`, synthetic text, an offline
fixture provider, and the installed app-server's read-only methods. No inference
turn or real user history is created or modified. CI without a Codex executable
reports that installed-parser smoke as skipped; structural regressions still run.
