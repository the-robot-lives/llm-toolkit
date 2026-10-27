import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { geminiConversationSnapshot, geminiProjectHash, importGeminiConversation, renderGeminiConversation, resolveGeminiProjectIdentifier, validateGeminiConversation } from "../../services/native/gemini.ts";

// Optional external proof: install the published core in a task-specific temp dir, never add it to app dependencies.
const coreRoot = process.env.LLM_TOOLKIT_GEMINI_CORE_ROOT;
it.skipIf(!coreRoot)("published Gemini 0.65.0 reader and resume-history converter accept isolated generated sessions", async () => {
  expect(JSON.parse(await readFile(join(coreRoot!, "package.json"), "utf8")).version).toBe("0.65.0");
  const load = (relative: string) => import(pathToFileURL(join(coreRoot!, "dist/src", relative)).href);
  const [{ Storage }, { loadConversationRecord }, { convertSessionToClientHistory }] = await Promise.all([load("config/storage.js"), load("services/chatRecordingService.js"), load("utils/sessionUtils.js")]);
  const root = await mkdtemp(join(tmpdir(), "llm-toolkit-gemini-reader-"));
  const previousGeminiHome = process.env.GEMINI_CLI_HOME;
  process.env.GEMINI_CLI_HOME = root;
  try {
    const cwd = join(root, "workspace"); await mkdir(cwd);
    // Official registration is performed ONLY in this disposable home/workspace.
    const storage = new Storage(cwd); await storage.initialize();
    const projectDir: string = storage.getProjectTempDir(); const slug = basename(projectDir);
    const registry = JSON.parse(await readFile(join(root, ".gemini/projects.json"), "utf8"));
    const marker = await readFile(join(projectDir, ".project_root"), "utf8");
    expect(resolveGeminiProjectIdentifier(registry, cwd, { [slug]: marker })).toBe(slug);
    const timestamp = "2026-10-27T08:00:00.000Z";
    const metadata = { sessionId: randomUUID(), projectHash: geminiProjectHash(cwd), startTime: timestamp, lastUpdated: timestamp, kind: "main" };
    const m = (id: string, type: string, content: unknown, extra = {}) => ({ id, type, content, timestamp, ...extra });
    const tool = { id: "call", name: "read_file", args: { count: 0, offset: -1 }, status: "success", timestamp, result: "fixture output" };
    const records = [metadata, m("u", "user", "/historical command"), m("a", "gemini", [{ text: "reason", thought: true, thoughtSignature: "opaque" }, { functionCall: { id: tool.id, name: tool.name, args: tool.args } }], { toolCalls: [tool], tokens: { input: 0, output: -1, cached: 0, total: -1 } }), m("later", "gemini", "old"), { $patch: { id: "later", content: "edited" } }, { $rewindTo: "later" }, m("final", "gemini", "Fixture answer")];
    const input = records.map(r => JSON.stringify(r)).join("\n") + "\n";
    const source = join(root, "source.jsonl"); await writeFile(source, input);
    const native = await loadConversationRecord(source);
    expect(native.messages).toEqual(geminiConversationSnapshot(records).messages);
    const portable = importGeminiConversation(input, source, cwd);
    const context = { sessionId: randomUUID(), cwd, title: "Fixture clone", createdAt: timestamp, sourceHarness: "gemini" as const, geminiProjectIdentifier: slug };
    const artifact = renderGeminiConversation(portable, context);
    expect(validateGeminiConversation(artifact.jsonl, context).valid).toBe(true);
    await mkdir(join(projectDir, "chats"), { recursive: true });
    const target = join(root, ".gemini/tmp", artifact.relativePath);
    await writeFile(target, artifact.jsonl, { flag: "wx", mode: 0o600 });
    const loaded = await loadConversationRecord(target);
    expect(loaded.sessionId).toBe(context.sessionId); expect(loaded.projectHash).toBe(geminiProjectHash(cwd));
    expect(loaded.messages).toHaveLength(portable.messages.length);
    const resumed = convertSessionToClientHistory(loaded.messages);
    expect(resumed).toHaveLength(portable.messages.length);
    expect(resumed.every((turn: { content: { parts: Array<Record<string, unknown>> } }) => turn.content.parts.every(p => "text" in p && !p.thought && !p.functionCall && !p.functionResponse))).toBe(true);
    const legacy = join(root, "legacy.json"); await writeFile(legacy, JSON.stringify({ ...metadata, messages: native.messages }, null, 2));
    expect((await loadConversationRecord(legacy)).messages).toEqual(native.messages);
  } finally {
    if (previousGeminiHome === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = previousGeminiHome;
    await rm(root, { recursive: true, force: true });
  }
});
