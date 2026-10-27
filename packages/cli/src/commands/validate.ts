import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ConversationValidationReport } from "@llm-toolkit/shared";

export async function runValidateCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { console.log("Usage: llm-toolkit validate <conversation.jsonl|document.json> --target claude|codex|gemini|universal [--json] [--api http://127.0.0.1:3100]"); return 0; }
  try {
    let file = ""; let target = ""; let json = false;
    let base: string | undefined;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--target") target = args[++index] ?? "";
      else if (arg === "--api") base = args[++index] ?? "";
      else if (arg === "--json") json = true;
      else if (!arg.startsWith("-") && !file) file = arg;
      else throw new Error(`Unknown option: ${arg}`);
    }
    if (!file || !["claude", "codex", "gemini", "opencode", "aider", "other", "universal"].includes(target)) throw new Error("Provide a file and --target. Run llm-toolkit validate --help for usage.");
    const path = resolve(file);
    if (statSync(path).size > 50_000_000) throw new Error("Maximum input size is 50 MB; the file was not changed");
    const content = readFileSync(path, "utf8");
    let report: ConversationValidationReport;
    if (base) {
      const url = new URL(base);
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Validation API must be the local Toolkit server");
      const response = await fetch(new URL("/api/conversations/validate", url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target, content }), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Validation service returned HTTP ${response.status}`);
      report = ((await response.json()) as { data: ConversationValidationReport }).data;
    } else {
      // This pure module imports only native format adapters, never API startup or SQLite.
      const { validateConversationContent } = await import("../../../api/src/services/conversation-validator.ts");
      report = await validateConversationContent(content, target as Parameters<typeof validateConversationContent>[1]);
    }
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`${report.status.toUpperCase()} · ${report.provider} · ${report.compatibilityVersion}`);
      for (const issue of [...report.errors, ...report.warnings]) console.log(`${issue.severity.toUpperCase()} ${issue.code} ${issue.path ?? "$"}: ${issue.message}`);
    }
    return report.valid ? 0 : report.status === "invalid" ? 1 : 2;
  } catch (error) {
    console.error(`llm-toolkit validate: ${error instanceof Error ? error.message : "Validation failed"}`);
    return 3;
  }
}
