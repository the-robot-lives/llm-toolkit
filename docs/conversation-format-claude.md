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
