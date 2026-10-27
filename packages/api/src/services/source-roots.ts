import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function sourceRootIdentity(path: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const absolute = resolve(expanded);
  try { return realpathSync(absolute); } catch { return absolute; }
}

/** Root order defines precedence. Aliases of the same directory count only once. */
export function normalizeSourceRoots(values: unknown, validate = false): { paths: string[]; warnings: string[] } {
  if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("Source folders must be an array of paths.");
  const paths: string[] = [], warnings: string[] = [];
  const seen = new Set<string>();
  for (const raw of values as string[]) {
    const path = raw.trim();
    if (!path || path.includes("\0") || (validate && !isAbsolute(path) && path !== "~" && !path.startsWith("~/"))) throw new Error("Use a nonempty absolute folder path or ~/path.");
    const canonical = sourceRootIdentity(path);
    if (seen.has(canonical)) { warnings.push(`Duplicate source alias ignored: ${path}`); continue; }
    try {
      if (!statSync(canonical).isDirectory()) throw new Error("not-directory");
    } catch (error) {
      if ((error as Error).message === "not-directory" && validate) throw new Error(`Source is not a folder: ${path}`);
      warnings.push(`Source is currently unavailable: ${path}. Its configuration and installed links are retained.`);
    }
    seen.add(canonical); paths.push(canonical);
  }
  return { paths, warnings };
}

export function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
