import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProjectEntry, ProjectLocation } from "@llm-toolkit/shared";
import type { StorageService } from "./storage.ts";

const exec = promisify(execFile);
export interface RepositoryScope {
  org?: { value: string | null; from?: string | null };
  project?: { value: string | null; from?: string | null };
  repo_root?: string | null;
  common_dir?: string | null;
  canonical_root?: string | null;
  remote?: string | null;
}
interface Inventory { repositories?: Array<RepositoryScope & { path: string; exists?: boolean }> }
interface Row { project_path: string; conversation_count: number; last_active: string | null }
export interface ProjectCatalogOptions {
  cwd?: string;
  resolveScope?: (path: string) => Promise<RepositoryScope>;
  inventory?: (root: string) => Promise<Inventory>;
  worktrees?: (root: string) => Promise<string[]>;
}

/** Resolution deliberately ignores process NPL_ORG/NPL_PROJECT: they describe this server, not each transcript. */
async function runScope(args: string[]): Promise<unknown> {
  const { stdout } = await exec("npl-scope", args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}
async function defaultResolve(path: string): Promise<RepositoryScope> {
  let directory = path;
  if (!existsSync(directory)) {
    // A removed conventional worktree still identifies its owning checkout.
    // Never reclassify an arbitrary deleted directory as its ancestor's repo.
    const marker = path.indexOf("/.claude/worktrees/");
    if (marker < 0) return {};
    directory = path.slice(0, marker);
    if (!existsSync(directory)) return {};
  }
  return await runScope(["get", "--json", "--ignore-env", "--dir", directory]) as RepositoryScope;
}
function physical(path: string | null | undefined): string | null {
  if (!path) return null;
  try { return realpathSync(path); } catch { return path; }
}
function normalizeScope(scope: RepositoryScope): RepositoryScope {
  return { ...scope, repo_root: physical(scope.repo_root), canonical_root: physical(scope.canonical_root), common_dir: physical(scope.common_dir) };
}
function canInheritWorktree(path: string, canonical: string): boolean {
  const directory = physical(path)!;
  if (directory === canonical) return true;
  // External/legacy worktrees may have a different ancestor registry. Resolve
  // them through the CLI; reuse canonical records only within our convention.
  if (!directory.startsWith(`${canonical}/.claude/worktrees/`)) return false;
  if (existsSync(resolve(directory, ".agent-kit.yaml"))) return false;
  try {
    const pointer = readFileSync(resolve(directory, ".git"), "utf8").trim();
    if (!pointer.startsWith("gitdir: ")) return false;
    const gitdir = resolve(directory, pointer.slice(8));
    if (existsSync(resolve(gitdir, "agent-kit.yaml"))) return false;
  } catch { return false; }
  let parent = dirname(directory);
  while (parent !== canonical && dirname(parent) !== parent) {
    if (existsSync(resolve(parent, ".agent-kit/projects.tsv"))) return false;
    parent = dirname(parent);
  }
  return parent === canonical;
}
function scopeKey(scope: RepositoryScope): string | null {
  const org = scope.org?.value;
  const project = scope.project?.value;
  if (!org || !project || !scope.repo_root) return null;
  // A generic parent/global default is not evidence that unrelated repositories belong together.
  const source = scope.project?.from ?? "";
  const explicit = /^(registry|repo|canonical|local|worktree):/.test(source);
  return explicit ? `tobor:${encodeURIComponent(org)}/${encodeURIComponent(project)}` : null;
}
export function deriveProjectName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : path;
}

export class ProjectCatalog {
  private readonly scopes = new Map<string, { at: number; value: RepositoryScope }>();
  private snapshot?: { at: number; data: ProjectEntry[] };
  private pending?: Promise<ProjectEntry[]>;
  private inventories = new Map<string, { at: number; data: Inventory }>();
  private trees = new Map<string, { at: number; data: string[] }>();
  constructor(private storage: StorageService, private options: ProjectCatalogOptions = {}) {}
  invalidate() { this.snapshot = undefined; this.scopes.clear(); this.inventories.clear(); this.trees.clear(); }
  private async scope(path: string) {
    const cached = this.scopes.get(path);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    let value: RepositoryScope = {};
    try { value = normalizeScope(await (this.options.resolveScope ?? defaultResolve)(path)); } catch { /* preserve legacy path when unresolvable */ }
    this.scopes.set(path, { at: Date.now(), value });
    return value;
  }
  async list(): Promise<ProjectEntry[]> {
    if (this.snapshot && Date.now() - this.snapshot.at < 5000) return this.snapshot.data;
    if (this.pending) return this.pending;
    this.pending = this.build();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  private async build(): Promise<ProjectEntry[]> {
    const rows = this.storage.getDb().prepare("SELECT project_path, COUNT(*) as conversation_count, MAX(updated_at) as last_active FROM conversations GROUP BY project_path ORDER BY last_active DESC").all() as Row[];
    const locations = new Map<string, Row>(rows.map(row => [row.project_path, row]));
    const knownScopes = new Map<string, RepositoryScope>();
    const roots = new Set<string>();
    for (const path of [this.options.cwd ?? process.cwd(), ...rows.map(row => row.project_path)]) {
      if (!isAbsolute(path)) continue;
      let at = resolve(path);
      while (dirname(at) !== at) {
        if (existsSync(resolve(at, ".gitmodules"))) roots.add(at);
        at = dirname(at);
      }
    }
    for (const root of roots) {
      try {
        let cached = this.inventories.get(root);
        if (!cached || Date.now() - cached.at > 60_000) {
          cached = { at: Date.now(), data: await (this.options.inventory ?? (async root => await runScope(["inventory", "--json", "--ignore-env", "--dir", root]) as Inventory))(root) };
          this.inventories.set(root, cached);
        }
        const inventory = cached.data;
        for (const repo of inventory.repositories ?? []) {
          if (repo.exists === false || !isAbsolute(repo.path)) continue;
          locations.set(repo.path, locations.get(repo.path) ?? { project_path: repo.path, conversation_count: 0, last_active: null });
          knownScopes.set(repo.path, normalizeScope(repo));
        }
      } catch { /* older npl-scope versions still support transcript-backed projects */ }
    }
    // Resolve in bounded batches; repository discovery must not spawn an unbounded process fan-out.
    const paths = [...locations.keys()];
    for (let i = 0; i < paths.length; i += 8) {
      await Promise.all(paths.slice(i, i + 8).map(async path => { if (!knownScopes.has(path)) knownScopes.set(path, await this.scope(path)); }));
    }
    const repositories = new Map<string, RepositoryScope>();
    for (const scope of knownScopes.values()) {
      const key = scope.common_dir ?? scope.canonical_root ?? scope.repo_root;
      if (key && !repositories.has(key)) repositories.set(key, scope);
    }
    const repositoryScopes = [...repositories.values()];
    for (let i = 0; i < repositoryScopes.length; i += 8) {
      await Promise.all(repositoryScopes.slice(i, i + 8).map(async scope => {
        const root = scope.canonical_root ?? scope.repo_root;
        if (!root) return;
        try {
          let cachedTrees = this.trees.get(root);
          if (!cachedTrees || Date.now() - cachedTrees.at > 60_000) {
            cachedTrees = { at: Date.now(), data: await (this.options.worktrees ?? (async root => {
              const { stdout } = await exec("git", ["-C", root, "worktree", "list", "--porcelain"], { timeout: 5000, maxBuffer: 1024 * 1024 });
              return stdout.split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
            }))(root) };
            this.trees.set(root, cachedTrees);
          }
          for (const path of new Set([root, ...cachedTrees.data])) {
            if (path === scope.common_dir) continue;
            if (!locations.has(path)) locations.set(path, { project_path: path, conversation_count: 0, last_active: null });
            if (!knownScopes.has(path)) {
              knownScopes.set(path, canInheritWorktree(path, root)
                ? { ...scope, repo_root: physical(path), canonical_root: root }
                : await this.scope(path));
            }
          }
        } catch { /* deleted or inaccessible checkout */ }
      }));
    }
    const metas = new Map((await this.storage.getAllProjectMeta()).map(meta => [meta.projectPath, meta]));
    const groups = new Map<string, ProjectEntry>();
    for (const row of locations.values()) {
      const scope = knownScopes.get(row.project_path) ?? {};
      const key = scopeKey(scope) ?? scope.canonical_root ?? scope.repo_root ?? row.project_path;
      const scoped = key.startsWith("tobor:") && scope.org?.value && scope.project?.value;
      let group = groups.get(key);
      if (!group) {
        const meta = metas.get(key);
        group = { projectPath: key, title: meta?.title ?? null, displayName: meta?.title ?? (scoped ? scope.project!.value! : deriveProjectName(key)), description: meta?.description ?? null, tags: meta?.tags ?? [], conversationCount: 0, lastActive: null, scope: scoped ? { organization: scope.org!.value!, project: scope.project!.value! } : null, locations: [] };
        groups.set(key, group);
      }
      const meta = metas.get(row.project_path);
      const location: ProjectLocation = { path: row.project_path, repositoryRoot: scope.repo_root ?? null, canonicalRoot: scope.canonical_root ?? null, remote: scope.remote ?? null, isWorktree: !!scope.canonical_root && scope.repo_root !== scope.canonical_root, conversationCount: row.conversation_count, lastActive: row.last_active, title: meta?.title ?? null, description: meta?.description ?? null, tags: meta?.tags ?? [] };
      group.locations.push(location);
      group.conversationCount += row.conversation_count;
      if (row.last_active && (!group.lastActive || row.last_active > group.lastActive)) group.lastActive = row.last_active;
    }
    const data = [...groups.values()].sort((a, b) => (b.lastActive ?? "").localeCompare(a.lastActive ?? "") || a.displayName.localeCompare(b.displayName));
    this.snapshot = { at: Date.now(), data };
    return data;
  }
  async paths(identity: string): Promise<string[]> {
    const project = (await this.list()).find(project => project.projectPath === identity);
    return project?.locations.map(location => location.path) ?? (identity.startsWith("tobor:") ? [] : [identity]);
  }
}
