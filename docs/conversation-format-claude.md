# Claude Code native conversation compatibility

Verified 2026-10-27 against local Claude Code **2.1.311** and the official Python Agent SDK **0.2.174**. The adapter compatibility label records both versions. Claude's JSONL storage is an internal, changing format; a successful structural check is not a promise that every future CLI or provider API accepts arbitrary archived blocks.

## Source contracts

- [Claude Code session documentation](https://code.claude.com/docs/en/sessions) documents JSONL storage, directory encoding, transcript-path resume, and version drift. Native transcripts differ from `--output-format stream-json` and rendered `/export` output.
- [Agent SDK session documentation](https://code.claude.com/docs/en/agent-sdk/sessions) documents resume/fork behavior and pure session-reading helpers. Session data does not snapshot the working tree.
- [Agent SDK session storage](https://code.claude.com/docs/en/agent-sdk/session-storage) describes raw entry archives versus the active post-compaction chain and rewritten IDs when forking.
- [Official SDK reader source, pinned](https://github.com/anthropics/claude-agent-sdk-python/blob/717cea09021fac3654879f0a362ed254a73ec35d/src/claude_agent_sdk/_internal/sessions.py) and [fork implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/717cea09021fac3654879f0a362ed254a73ec35d/src/claude_agent_sdk/_internal/session_mutations.py) provide an independently executable reference. The checked PyPI package version is recorded separately from this upstream source revision.

## Adapter behavior

`importClaudeConversation` walks `parentUuid` to reconstruct the active chain, excludes subagent/meta branches, and recovers parallel tool-call siblings sharing an API message ID. It does not follow a compaction boundary's archival `logicalParentUuid`. Original entries remain in `rawEvents`; partial exports must filter that archive to avoid including excluded source history.

A new native clone receives fresh message/session IDs and a linear parent chain. It carries the selected working directory and a custom title. The caller canonicalizes the working directory, selects the configured Claude root, and writes exclusively with private file permissions. Project directory names use Claude's non-alphanumeric replacement and 200-character/hash convention. No source permission mode, scheduled tasks, agent settings, undo snapshots, or request blobs become active target state.

Source Claude tool transactions remain native only when complete and correctly ordered. Foreign or incomplete tools become labeled historical text; they are never executed. Unchanged signed Claude reasoning can retain its original signature. Foreign, edited, or unsigned reasoning becomes text, with a compatibility notice. Foreign model metadata is not used to select the target model. Unsupported/external attachments remain readable references; valid inline image data can be retained. The portable document preserves original provider data.

## Validation and executable proof

General validation accepts known native metadata and graph topology. Unknown private extensions produce warnings and `complete: false`, rather than being silently removed. Strict generated-clone validation additionally requires one fresh session, a linear parent chain, target cwd, supported blocks, complete tool transactions, and a terminating newline. Diagnostics use stable codes and record paths without echoing transcript contents. Safe newline repair is identified explicitly; semantic changes require a new reviewed clone.

Focused tests cover parallel tools, compaction, sidechains, semantic round trips, changed reasoning signatures, mixed-harness snippets, foreign model omission, invalid graphs/tool order, and actionable diagnostics. An isolated `CLAUDE_CONFIG_DIR` proof called the official SDK's `get_session_messages`, `list_sessions`, and `fork_session`: six source messages and six cloned messages were recovered; the compacted fixture returned its two active messages; the SDK fork had six messages with fresh IDs. No model request, historical tool execution, or real user-thread write occurred. This validates native file discovery and reading, not an end-to-end model continuation.

An independent load-only check also launched installed Claude Code `2.1.311` with `--resume` on a synthetic Codex-to-Claude native clone. The terminal displayed both known user/assistant fixture markers, the session title and an idle prompt without receiving input. The run used an isolated fixture cwd and `CLAUDE_CONFIG_DIR`, a dummy key, `--bare --safe-mode --tools '' --strict-mcp-config <empty-config> --disable-slash-commands`, and sandbox rules denying network plus reads of the real Claude/Codex configuration. This proves actual interactive CLI loading of that clone, with no model turn; inference continuation remains unverified.

## Assistant response envelope and stop reasons (2026-10-27)

The adapter derives generated `stop_reason` from the emitted native blocks: `tool_use` when a native tool-use block is emitted; otherwise it preserves safe recognized native completion reasons only when the emitted body matches the original Claude body and the source reason is unchanged. This includes `max_tokens`, `refusal`, `model_context_window_exceeded`, and `stop_sequence` with its original nonempty matched sequence. Edited or foreign bodies, stale tool state, and source server-pause checkpoints fall back to `end_turn` with a warning. It never copies a foreign provider's `stop`/`tool_calls`, a flattened source transaction's stale `tool_use`, or a source streaming checkpoint into a new Claude turn. Changed non-null source reasons produce `stop-reason-normalized`; the original reason remains in the portable source message.

Both validators check nonempty assistant API message ID and `type: "message"`, separately from transcript record UUIDs. Unknown non-null stop reasons produce `invalid-stop-reason` at `/records/<index>/message/stop_reason`. General native validation accepts null/missing stop reason only as an incomplete streaming warning, without falsely declaring an interrupted source structurally corrupt. Generated validation requires a supported non-null reason matching actual tool blocks. A `stop_sequence` response requires its matched sequence.

The installed application Anthropic SDK `0.39.0` declares the original four reasons plus nullable streaming state. The [official current Message/StopReason types](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts) additionally document `pause_turn`, `refusal` and `model_context_window_exceeded`; the source validator recognizes these legitimate values while the renderer emits its narrower completed-history subset. A structure-only local sample of 20 transcript files observed 1,446 assistant envelopes, all `type: "message"` with the required ID/type/reason fields; observed reasons were `tool_use`, `end_turn` and `stop_sequence`. No message contents, IDs or paths were emitted or added to fixtures.

Focused regressions cover Codex reasons with flattened tool calls, genuine native tool pairs, invalid assistant ID/type/reason, block/reason mismatches, and incomplete streaming reasons. All 18 focused tests and API typecheck passed without model requests or user-history writes.

## Unicode separators and the Python SDK fork parser (2026-10-27)

Raw U+0085, U+2028 and U+2029 inside JSON strings are valid native JSONL. However, the pinned Python SDK `0.2.174` `_parse_fork_transcript` decodes UTF-8 and uses Python `splitlines()`, which treats these codepoints as record boundaries and can silently discard the affected messages. This is visible in the [official fork parser source](https://github.com/anthropics/claude-agent-sdk-python/blob/717cea09021fac3654879f0a362ed254a73ec35d/src/claude_agent_sdk/_internal/session_mutations.py), and was reproduced with the installed package rather than inferred from an issue summary.

Claude clone serialization and the Claude target's Format JSONL action now escape those three codepoints as JSON Unicode escapes in every record. Parsing yields exactly the original text. The validator reports `sdk-fork-unescaped-line-separator` with a structural line location and `repairable: true` on external raw-separator files. It keeps their native JSONL classification valid and explains the narrower SDK fork interoperability risk. Formatting is an explicit lossless repair; validation never rewrites a user's file.

The optional external-reader regression runs the real SDK in a child process with only `CLAUDE_CONFIG_DIR` redirected to a disposable fixture. It reproduces the raw-separator fork failure, then checks the repaired four-message mixed user/assistant session through both `get_session_messages` and `fork_session`, including exact Unicode content, fresh fork UUIDs and preserved parent relationships. It invokes no model and never changes the real user archive or `HOME`.

```sh
LLM_TOOLKIT_CLAUDE_SDK_PYTHON=/path/to/isolated-sdk-0.2.174-venv/bin/python pnpm --filter @llm-toolkit/api exec vitest run src/__tests__/services/native-claude.test.ts src/__tests__/services/native-claude-reader.test.ts
```

A separate quick path check found that this Python SDK sanitizes a non-BMP emoji project-directory character to one hyphen, whereas the CLI-compatible JavaScript UTF-16 sanitizer produces two. This change does not alter native Claude destination encoding; SDK directory lookup in emoji paths remains a separate compatibility limitation. ASCII fixture paths keep the separator regression independent of that issue.
