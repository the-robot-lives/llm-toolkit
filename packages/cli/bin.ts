#!/usr/bin/env tsx
import { ensureApi } from "@llm-toolkit/shared";
import { parseInvocation } from "./src/interface-selection.js";

const rawArgs = process.argv.slice(2);
const { command, args, warnings } = parseInvocation(rawArgs);

const NEEDS_API = new Set(["search", "list", "show", "edit", "convert", "dataset", "serve", "merge", "rehome", "index", "interactive", "services"]);

async function main() {
  for (const warning of warnings) {
    console.error(warning);
  }
  if (command === "recent") {
    const { runRecentCommand } = await import("./src/commands/recent.js");
    process.exitCode = runRecentCommand(args);
    return;
  }
  if (command === "validate" || command === "validate-conversation") {
    const { runValidateCommand } = await import("./src/commands/validate.js");
    process.exitCode = await runValidateCommand(args);
    return;
  }
  if (NEEDS_API.has(command)) {
    const { alreadyRunning } = await ensureApi();
    if (!alreadyRunning) {
      console.error("Started API server on http://localhost:3100");
    }
  }
  const [{ render }, { default: React }, { App }] = await Promise.all([import("ink"), import("react"), import("./src/app.tsx")]);
  render(React.createElement(App, { command, args }));
}

main();
