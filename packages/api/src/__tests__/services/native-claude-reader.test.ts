import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { UniversalThread } from "@llm-toolkit/shared";
import { renderClaudeConversation } from "../../services/native/claude.ts";

const python = process.env.LLM_TOOLKIT_CLAUDE_SDK_PYTHON;
it.skipIf(!python)("SDK 0.2.174 get and fork preserve Unicode separator messages and parent chains", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "llm-toolkit-claude-reader-")));
  try {
    const cwd = join(root, "workspace"); await mkdir(cwd);
    const config = join(root, "config");
    const text = "before\u0085middle\u2028next\u2029after";
    const timestamp = "2026-10-27T08:00:00.000Z";
    const thread: UniversalThread = { id: "fixture", harness: "claude", sourcePath: "/fixture", projectPath: cwd, title: "Unicode SDK proof", startedAt: timestamp, updatedAt: timestamp, messages: ["user", "assistant", "user", "assistant"].map((role, i) => ({ id: `fixture-${i}`, role: role as "user" | "assistant", timestamp, content: [{ type: "text", text: `${i}:${text}` }] })) };
    const sessionId = randomUUID();
    const artifact = renderClaudeConversation(thread, { sessionId, cwd, title: thread.title, createdAt: timestamp, sourceHarness: "claude" });
    const path = join(config, "projects", artifact.relativePath);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, artifact.jsonl, { flag: "wx", mode: 0o600 });
    const expected = join(root, "expected.json");
    await writeFile(expected, JSON.stringify({ messages: thread.messages.map(m => m.content[0].type === "text" ? m.content[0].text : ""), ids: artifact.records.filter(r => r.type === "user" || r.type === "assistant").map(r => r.uuid) }));
    const script = `import json,sys,pathlib,importlib.metadata,uuid
from claude_agent_sdk import get_session_messages, fork_session
assert importlib.metadata.version('claude-agent-sdk') == '0.2.174'
source_id,cwd,source_path,expected_path=sys.argv[1:]
expected=json.loads(pathlib.Path(expected_path).read_text())
# Demonstrate the actual pinned SDK failure before checking the repaired export.
unsafe_id=str(uuid.uuid4())
unsafe_records=[json.loads(line) for line in pathlib.Path(source_path).read_text().split('\\n') if line.strip()]
for record in unsafe_records: record['sessionId']=unsafe_id
unsafe_path=pathlib.Path(source_path).parent/(unsafe_id+'.jsonl')
unsafe_path.write_text(''.join(json.dumps(record,ensure_ascii=False)+'\\n' for record in unsafe_records))
try:
 fork_session(unsafe_id,directory=cwd)
except ValueError:
 pass
else:
 raise AssertionError('Expected unescaped Unicode separators to reproduce the SDK fork parser failure')
def texts(messages):
 return [''.join(b['text'] for b in m.message['content'] if b['type']=='text') for m in messages]
source=get_session_messages(source_id,directory=cwd)
assert texts(source)==expected['messages']
assert [m.uuid for m in source]==expected['ids']
fork=fork_session(source_id,directory=cwd)
messages=get_session_messages(fork.session_id,directory=cwd)
assert texts(messages)==expected['messages']
assert len(set(m.uuid for m in messages))==len(expected['messages'])
assert not set(m.uuid for m in messages).intersection(expected['ids'])
fork_path=pathlib.Path(source_path).parent/(fork.session_id+'.jsonl')
records=[json.loads(line) for line in fork_path.read_text().split('\\n') if line.strip()]
records=[r for r in records if r.get('type') in ('user','assistant')]
assert len(records)==len(expected['messages'])
previous=None
for r in records:
 assert r['parentUuid']==previous
 assert r['sessionId']==fork.session_id
 previous=r['uuid']
print(json.dumps({'sourceMessages':len(source),'forkMessages':len(messages),'parentsPreserved':True}))
`;
    // Only this child receives the fixture config; HOME and the real user archive remain untouched.
    const result = await promisify(execFile)(python!, ["-c", script, sessionId, cwd, path, expected], { env: { ...process.env, CLAUDE_CONFIG_DIR: config }, timeout: 15_000 });
    expect(JSON.parse(result.stdout)).toEqual({ sourceMessages: 4, forkMessages: 4, parentsPreserved: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
