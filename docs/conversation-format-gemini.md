# Gemini CLI native conversation compatibility

Research and proof: 2026-10-27. Compatibility target is published `@google/gemini-cli-core@0.65.0`, npm git head `6006c14a4decfe4b891c6263ad6ad5992e404b5b`. No `gemini` executable is installed on this machine. Local `~/.gemini` has no native `tmp` session archive; no personal session contents were used as fixtures.

## Format and destination

The pinned release records append-only JSONL: metadata followed by message upserts, `$patch` updates/removals/reordering, `$rewindTo`, and `$set` metadata or legacy full-history checkpoints. Legacy pretty JSON snapshots are also readable. The importer materializes the active ordered messages and retains every original record separately; it does not flatten the archive into the active history. Reader behavior is versioned implementation compatibility, not a stable general Gemini interchange specification. [Official recording service](https://github.com/google-gemini/gemini-cli/blob/v0.65.0/packages/core/src/services/chatRecordingService.ts).

The schema has session UUID, `projectHash`, `startTime`, `lastUpdated`, and message IDs/timestamps/content. Types are `user`, `gemini`, `info`, `error`, `warning`; model records may include tool calls, thought summaries, model name and token summaries. Content uses GenAI Parts, including function calls/responses, inline/file attachments and opaque thought signatures. Counter values including zero and negative reports are preserved without truthiness defaults. [Official recording types](https://github.com/google-gemini/gemini-cli/blob/v0.65.0/packages/core/src/services/chatRecordingTypes.ts).

`projectHash` is SHA256 of the project root string, but the current storage directory is a registered slug, **not necessarily the hash**. `Storage.initialize()` obtains a slug via locked `projects.json` registration and maintains `.project_root` ownership markers. The renderer requires the caller to resolve an existing registry entry and matching marker; it never creates or replaces the user's registry. Missing registration blocks saving and asks the user to open Gemini in the chosen project once. Runtime storage can differ under sandbox execution. [Storage](https://github.com/google-gemini/gemini-cli/blob/v0.65.0/packages/core/src/config/storage.ts), [project registry](https://github.com/google-gemini/gemini-cli/blob/v0.65.0/packages/core/src/config/projectRegistry.ts), [project hash](https://github.com/google-gemini/gemini-cli/blob/v0.65.0/packages/core/src/utils/paths.ts).

Relative to the configured Gemini runtime `tmp` root, the artifact uses `<registered-slug>/chats/session-<YYYY-MM-DDTHH-mm>-<session-uuid-first-8>.jsonl`. The exclusive writer must reject collisions and must not overwrite an existing session; rerender with a fresh session UUID if necessary. Resume arguments are separately tokenized `gemini --resume <uuid>`, run from the target project folder. Both `.json` and `.jsonl` session files are discoverable by the pinned CLI's session scanner. [Session scanner and selection](https://github.com/google-gemini/gemini-cli/blob/v0.65.0/packages/cli/src/utils/sessionUtils.ts), [session-management documentation](https://github.com/google-gemini/gemini-cli/blob/v0.65.0/docs/cli/session-management.md).

## Safe rendering and validator limits

Generated clones have fresh session/message IDs and destination metadata. Tools, reasoning and attachments become explicit historical text with compatibility warnings, including same-provider source tools. No function-call replay, forged thought signatures, inherited subagent/workspace runtime state, source permissions or target model settings are generated. Original typed blocks and opaque native records remain in the portable envelope. This is context portability; executable provider state is deliberately represented as history.

Gemini's resume converter discards blank, slash-prefixed, question-prefixed and injected-context-prefixed user messages. Generated copies prefix such source text with `[Historical user message]` so it remains visible context. Source thought signatures are opaque and cannot be validated cryptographically offline. [Official resume-history conversion](https://github.com/google-gemini/gemini-cli/blob/v0.65.0/packages/core/src/utils/sessionUtils.ts).

General validation accepts legacy snapshots and append-only mutation streams, checks active tool ID/name linkage and shape, and reports unknown extensions/interrupted calls as incomplete warnings. Generated-clone validation additionally requires destination/session agreement, fresh unique message UUIDs, one header, safe text-only Parts, no archived mutation records or inherited runtime state, and final newline. Diagnostics use stable `gemini.*` codes and structural paths without quoting input contents. Unknown future event/part/status semantics never receive a complete compatibility result.

## Reproducing the native reader proof

The focused suite contains an optional external reader test. Install the **pinned** published core into a disposable directory and pass its package root; no new application dependency is needed:

```sh
task_gemini_proof=$(mktemp -d /tmp/llm-toolkit-gemini-proof.XXXXXX)
npm install --prefix "$task_gemini_proof" --ignore-scripts --no-audit --no-fund @google/gemini-cli-core@0.65.0
LLM_TOOLKIT_GEMINI_CORE_ROOT="$task_gemini_proof/node_modules/@google/gemini-cli-core" pnpm --filter @llm-toolkit/api exec vitest run src/__tests__/services/native-gemini.test.ts src/__tests__/services/native-gemini-reader.test.ts
```

The test redirects only the official supported `GEMINI_CLI_HOME` setting into a disposable workspace, asks official `Storage` to register that fixture project, validates the lookup, then exercises `loadConversationRecord` and `convertSessionToClientHistory` on synthetic source and clone files. It verifies patch/rewind materialization, legacy JSON, retained slash-command context and absence of replayable tools/signatures in cloned history. It cleans up its own fixture home afterward. **13 tests passed with the published reader enabled**, plus API typecheck. No model requests, tool executions or real user-history writes occurred. Interactive CLI resume and future versions remain unverified.
