import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type {
  ArtifactKind,
  SkillDestination,
  SkillDestinationKind,
  SkillInstallStatus,
  SkillProvider,
  SkillsConfig,
} from "@llm-toolkit/shared";
import { ARTIFACT_DEST_SPECS, ARTIFACT_KIND_ORDER, SKILL_PROVIDER_ORDER, SKILL_PROVIDER_SPECS } from "@llm-toolkit/shared";

const SKIP_DIRS = new Set(["shared", "evals", "docs", "skills", "node_modules", ".git", "assets", "references"]);
const CATEGORIES_FILES = ["categories.yaml", "categories.yml"];

export function expandPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function defaultSkillsConfig(): SkillsConfig {
  return {
    sourceFolders: [],
    providers: ["claude"],
    globalEnabled: true,
    projectRoots: [],
  };
}

export function migrateSkillsConfig(raw: Partial<SkillsConfig> | undefined): SkillsConfig {
  const sourceFolders = raw?.sourceFolders ?? [];
  if (raw?.providers?.length) {
    return {
      sourceFolders,
      providers: uniqueProviders(raw.providers),
      globalEnabled: raw.globalEnabled ?? true,
      projectRoots: (raw.projectRoots ?? []).map(expandPath),
    };
  }
  if (raw?.destinations?.length) {
    const providers = new Set<SkillProvider>();
    const projectRoots = new Set<string>();
    let globalEnabled = false;
    for (const dest of raw.destinations) {
      const inferred = inferProviderFromPath(dest.path);
      if (!inferred) continue;
      providers.add(inferred.provider);
      if (inferred.kind === "global") globalEnabled = true;
      else if (inferred.projectRoot) projectRoots.add(inferred.projectRoot);
    }
    return {
      sourceFolders,
      providers: providers.size ? uniqueProviders([...providers]) : ["claude"],
      globalEnabled,
      projectRoots: [...projectRoots],
    };
  }
  return { ...defaultSkillsConfig(), sourceFolders };
}

export function expandDestinations(config: SkillsConfig, home = homedir(), kind: ArtifactKind = "skills"): SkillDestination[] {
  if (config.destinations?.length && !config.providers?.length) {
    return config.destinations.map((dest) => ({ ...dest, path: expandPath(dest.path) }));
  }
  const migrated = migrateSkillsConfig(config);
  const providers: SkillProvider[] = migrated.providers?.length ? migrated.providers : ["claude"];
  const dests: SkillDestination[] = [];
  if (migrated.globalEnabled !== false) {
    for (const provider of providers) {
      dests.push(globalDestination(provider, home, kind));
    }
  }
  for (const root of migrated.projectRoots ?? []) {
    dests.push(...providers.map((provider) => projectDestination(provider, root, kind)));
  }
  return dests;
}

export function globalDestination(provider: SkillProvider, home = homedir(), kind: ArtifactKind = "skills"): SkillDestination {
  const spec = ARTIFACT_DEST_SPECS[provider][kind];
  const resolved = spec.global.startsWith("~/")
    ? join(home, spec.global.slice(2))
    : expandPath(spec.global);
  return {
    id: `global-${provider}`,
    label: `Global ${SKILL_PROVIDER_SPECS[provider].title}`,
    path: resolved,
    kind: "global",
    provider,
  };
}

export function projectDestination(provider: SkillProvider, projectRoot: string, kind: ArtifactKind = "skills"): SkillDestination {
  const spec = ARTIFACT_DEST_SPECS[provider][kind];
  const root = expandPath(projectRoot);
  const path = join(root, spec.project);
  const slug = basename(root) || "project";
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 8);
  return {
    id: `project-${hash}-${provider}`,
    label: `${SKILL_PROVIDER_SPECS[provider].title} · ${slug}`,
    path,
    kind: "project",
    provider,
    projectRoot: root,
  };
}

export function inferProviderFromPath(rawPath: string): { provider: SkillProvider; kind: SkillDestinationKind; projectRoot?: string } | null {
  const path = expandPath(rawPath).replace(/\\/g, "/");
  for (const provider of SKILL_PROVIDER_ORDER) {
    for (const artifactKind of ARTIFACT_KIND_ORDER) {
      const spec = ARTIFACT_DEST_SPECS[provider][artifactKind];
      const global = expandPath(spec.global).replace(/\\/g, "/");
      if (path === global) return { provider, kind: "global" };
      const marker = "/" + spec.project.replace(/\\/g, "/");
      if (path.endsWith(marker) || path.endsWith(marker + "/")) {
        return { provider, kind: "project", projectRoot: path.slice(0, path.length - marker.length) };
      }
    }
  }
  return null;
}

export function normalizeSkillsDir(input: string, provider: SkillProvider = "claude"): { path: string; kind: SkillDestinationKind; provider: SkillProvider; projectRoot?: string } {
  const expanded = expandPath(input);
  const abs = isAbsolute(expanded) ? expanded : resolve(expanded);
  const inferred = inferProviderFromPath(abs);
  if (inferred) {
    return { path: abs, kind: inferred.kind, provider: inferred.provider, projectRoot: inferred.projectRoot };
  }
  const spec = SKILL_PROVIDER_SPECS[provider];
  return { path: join(abs, spec.projectDir), kind: "project", provider, projectRoot: abs };
}

export function classifyDestinationKind(skillsDir: string): SkillDestinationKind {
  return inferProviderFromPath(skillsDir)?.kind ?? "project";
}

export function destinationIdFor(path: string, kind: SkillDestinationKind, provider?: SkillProvider): string {
  const inferred = inferProviderFromPath(path);
  const prov = provider ?? inferred?.provider ?? "claude";
  if (kind === "global" || inferred?.kind === "global") return `global-${prov}`;
  const root = inferred?.projectRoot ?? dirname(dirname(expandPath(path)));
  return projectDestination(prov, root).id;
}

function uniqueProviders(list: SkillProvider[]): SkillProvider[] {
  const allowed = new Set<SkillProvider>(SKILL_PROVIDER_ORDER);
  const seen = new Set<SkillProvider>();
  const out: SkillProvider[] = [];
  for (const item of list) {
    if (!allowed.has(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.length ? out : ["claude"];
}

export interface SkillCategoryRecord {
  id: string;
  title: string;
  description?: string;
  flow?: string[];
  skills: string[];
}

export interface ParsedCategoriesFile {
  version?: number;
  path: string;
  categories: SkillCategoryRecord[];
}

export interface SkillInstall {
  destinationId: string;
  status: SkillInstallStatus;
  linkPath: string;
  target?: string;
}

export interface DiscoveredSkill {
  name: string;
  title?: string;
  description?: string;
  path: string;
  sourceRoot: string;
  categoryId: string;
  installs: SkillInstall[];
}

export interface SkillSourceInfo {
  path: string;
  categoriesFile?: string;
  skillCount: number;
}

export interface SkillsCatalog {
  sources: SkillSourceInfo[];
  destinations: Array<SkillDestination & { exists: boolean }>;
  categories: SkillCategoryRecord[];
  skills: DiscoveredSkill[];
  discoveredFolders: string[];
  providers: SkillProvider[];
  globalEnabled: boolean;
  projectRoots: string[];
}

export interface SkillDetail extends DiscoveredSkill {
  skillMarkdown: string;
  files: string[];
}

export function findCategoriesFile(dir: string): string | undefined {
  for (const name of CATEGORIES_FILES) {
    const candidate = join(dir, name);
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

export function discoverSourceFolders(fromDirs: string[] = [process.cwd()]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const consider = (dir: string) => {
    const categories = findCategoriesFile(dir);
    if (!categories) return;
    const resolved = resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    found.push(resolved);
  };

  if (process.env.SKILL_REPO) consider(expandPath(process.env.SKILL_REPO));
  const extra = process.env.LLM_TOOLKIT_SKILL_FOLDERS;
  if (extra) {
    for (const part of extra.split(":")) {
      if (part.trim()) consider(expandPath(part));
    }
  }

  for (const start of fromDirs) {
    let dir = resolve(expandPath(start));
    for (let i = 0; i < 12; i++) {
      consider(dir);
      consider(join(dir, "skills"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return found;
}

export function parseCategoriesYaml(text: string, filePath = "categories.yaml"): ParsedCategoriesFile {
  const parsed = parseYamlLite(text);
  const root = asRecord(parsed);
  const rawCats = asRecord(root.categories);
  const categories: SkillCategoryRecord[] = [];
  for (const [id, value] of Object.entries(rawCats)) {
    const rec = asRecord(value);
    const names = unique([
      ...stringList(rec.items),
      ...stringList(rec.skills),
      ...stringList(rec.agents),
      ...stringList(rec.commands),
      ...stringList(rec.mcp),
    ]);
    categories.push({
      id,
      title: stringValue(rec.title) || id,
      description: stringValue(rec.description) || undefined,
      flow: stringList(rec.flow),
      skills: names,
    });
  }
  const versionRaw = root.version;
  const version = typeof versionRaw === "number" ? versionRaw : Number(stringValue(versionRaw)) || undefined;
  return { version, path: filePath, categories };
}

export function parseSkillFrontmatter(text: string): { name?: string; title?: string; description?: string } {
  const extracted = extractFrontmatter(text);
  if (!extracted) return {};
  const map = parseFlatYamlMap(extracted.yaml);
  return {
    name: map.name || undefined,
    title: map.title || undefined,
    description: map.description || undefined,
  };
}

const SKILL_MD_PREVIEW_CHARS = 16_000;

export function scanSkills(config: SkillsConfig): SkillsCatalog {
  const migrated = migrateSkillsConfig(config);
  const discoveredFolders = discoverSourceFolders();
  const sourceFolders = (migrated.sourceFolders.length > 0
    ? migrated.sourceFolders.map(expandPath)
    : discoveredFolders
  ).filter((p) => existsSync(p));

  const rawDests = config.destinations?.length && !config.providers?.length
    ? config.destinations
    : expandDestinations(migrated);
  const destinations = rawDests.map((dest) => {
    const path = expandPath(dest.path);
    return { ...dest, path, exists: existsSync(path) };
  });

  const skillsByName = new Map<string, DiscoveredSkill>();
  const sources: SkillSourceInfo[] = [];
  const categoriesById = new Map<string, SkillCategoryRecord>();
  const skillToCategory = new Map<string, string>();

  for (const root of sourceFolders) {
    const categoriesFile = findCategoriesFile(root);
    let count = 0;
    if (categoriesFile) {
      try {
        const parsed = parseCategoriesYaml(readFileSync(categoriesFile, "utf-8"), categoriesFile);
        for (const cat of parsed.categories) {
          if (!categoriesById.has(cat.id)) categoriesById.set(cat.id, { ...cat });
          else {
            const existing = categoriesById.get(cat.id)!;
            existing.skills = unique([...existing.skills, ...cat.skills]);
          }
          for (const name of cat.skills) {
            if (!skillToCategory.has(name)) skillToCategory.set(name, cat.id);
          }
        }
      } catch {
        // ignore unreadable categories files; still scan SKILL.md dirs
      }
    }

    for (const skill of listSkillDirs(root)) {
      count += 1;
      if (skillsByName.has(skill.name)) continue;
      skillsByName.set(skill.name, skill);
    }
    sources.push({ path: root, categoriesFile, skillCount: count });
  }

  const uncategorized: string[] = [];
  for (const skill of skillsByName.values()) {
    const categoryId = skillToCategory.get(skill.name) ?? "uncategorized";
    skill.categoryId = categoryId;
    skill.installs = destinations.map((dest) => classifyInstall(dest, skill));
    if (categoryId === "uncategorized") uncategorized.push(skill.name);
  }

  if (uncategorized.length > 0 && !categoriesById.has("uncategorized")) {
    categoriesById.set("uncategorized", {
      id: "uncategorized",
      title: "Uncategorized",
      description: "Skills with SKILL.md that are not listed in categories.yaml",
      skills: uncategorized.sort(),
    });
  } else if (uncategorized.length > 0) {
    const existing = categoriesById.get("uncategorized")!;
    existing.skills = unique([...existing.skills, ...uncategorized]).sort();
  }

  for (const cat of categoriesById.values()) {
    cat.skills = cat.skills.filter((name) => skillsByName.has(name));
  }

  return {
    sources,
    destinations,
    categories: [...categoriesById.values()],
    skills: [...skillsByName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    discoveredFolders,
    providers: migrated.providers ?? ["claude"],
    globalEnabled: migrated.globalEnabled !== false,
    projectRoots: migrated.projectRoots ?? [],
  };
}

export function readSkillDetail(config: SkillsConfig, name: string): SkillDetail | null {
  const catalog = scanSkills(config);
  const skill = catalog.skills.find((s) => s.name === name);
  if (!skill) return null;
  const skillMd = join(skill.path, "SKILL.md");
  let skillMarkdown = "";
  if (existsSync(skillMd)) {
    skillMarkdown = readFileSync(skillMd, "utf-8");
    if (skillMarkdown.length > SKILL_MD_PREVIEW_CHARS) {
      skillMarkdown = skillMarkdown.slice(0, SKILL_MD_PREVIEW_CHARS) + "\n\n…";
    }
  }
  let files: string[] = [];
  try {
    files = readdirSync(skill.path).filter((entry) => !entry.startsWith(".")).sort();
  } catch {
    files = [];
  }
  return { ...skill, skillMarkdown, files };
}

export function enableSkill(
  config: SkillsConfig,
  name: string,
  destinationId: string,
  replace = false,
): SkillInstall {
  const catalog = scanSkills(config);
  const skill = catalog.skills.find((s) => s.name === name);
  if (!skill) throw new SkillActionError(`unknown skill: ${name}`, 404);
  const dest = catalog.destinations.find((d) => d.id === destinationId);
  if (!dest) throw new SkillActionError(`unknown destination: ${destinationId}`, 404);
  assertSafeDest(dest.path);

  const linkPath = join(dest.path, skill.name);
  const source = skill.path;
  const current = classifyInstall(dest, skill);

  if (current.status === "enabled") {
    return current;
  }

  if (existsSync(linkPath) || isSymlink(linkPath)) {
    if (!replace) {
      throw new SkillActionError(
        `${skill.name} exists at ${linkPath} (status=${current.status}); pass replace to backup and relink`,
        409,
        current.status,
      );
    }
    backupPath(linkPath);
  }

  mkdirSync(dest.path, { recursive: true });
  if (isSymlink(linkPath) || existsSync(linkPath)) {
    rmSync(linkPath, { recursive: true, force: true });
  }
  symlinkSync(source, linkPath);
  return classifyInstall({ ...dest, exists: true }, skill);
}

export function disableSkill(
  config: SkillsConfig,
  name: string,
  destinationId: string,
): SkillInstall {
  const catalog = scanSkills(config);
  const skill = catalog.skills.find((s) => s.name === name);
  const dest = catalog.destinations.find((d) => d.id === destinationId);
  if (!dest) throw new SkillActionError(`unknown destination: ${destinationId}`, 404);
  assertSafeDest(dest.path);

  const linkPath = join(dest.path, name);
  if (!existsSync(linkPath) && !isSymlink(linkPath)) {
    return {
      destinationId,
      status: "disabled",
      linkPath,
    };
  }

  if (!isSymlink(linkPath)) {
    throw new SkillActionError(
      `${name} is a real path (not a managed symlink); refuse to remove: ${linkPath}`,
      409,
      "real",
    );
  }

  const target = resolveSymlink(linkPath);
  const underSource = skill
    ? samePath(target, skill.path) || config.sourceFolders.map(expandPath).some((root) => isUnder(target, root))
    : config.sourceFolders.map(expandPath).some((root) => isUnder(target, root));
  if (existsSync(target) && !underSource && skill && !samePath(target, skill.path)) {
    throw new SkillActionError(
      `symlink points outside sources: ${linkPath} -> ${target}`,
      409,
      "foreign",
    );
  }

  unlinkSync(linkPath);
  return {
    destinationId,
    status: "disabled",
    linkPath,
  };
}

export function applySkillTargets(
  config: SkillsConfig,
  name: string,
  destinationIds: string[],
  enabled: boolean,
  replace = false,
): SkillInstall[] {
  const ids = unique(destinationIds.filter(Boolean));
  if (ids.length === 0) throw new SkillActionError("destinationIds are required", 400);
  const results: SkillInstall[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    try {
      results.push(enabled ? enableSkill(config, name, id, replace) : disableSkill(config, name, id));
    } catch (err) {
      if (err instanceof SkillActionError) {
        errors.push(`${id}: ${err.message}`);
        continue;
      }
      throw err;
    }
  }
  if (results.length === 0 && errors.length > 0) {
    throw new SkillActionError(errors.join("; "), 409);
  }
  return results;
}

export class SkillActionError extends Error {
  status: number;
  installStatus?: SkillInstallStatus;
  constructor(message: string, status: number, installStatus?: SkillInstallStatus) {
    super(message);
    this.name = "SkillActionError";
    this.status = status;
    this.installStatus = installStatus;
  }
}

function listSkillDirs(root: string): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const path = join(root, name);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const skillMd = join(path, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    let title: string | undefined;
    let description: string | undefined;
    try {
      const meta = parseSkillFrontmatter(readFileSync(skillMd, "utf-8"));
      title = meta.title || titleFromHeading(readFileSync(skillMd, "utf-8")) || undefined;
      description = meta.description;
    } catch {
      // ignore
    }
    out.push({
      name,
      title,
      description,
      path,
      sourceRoot: root,
      categoryId: "uncategorized",
      installs: [],
    });
  }
  return out;
}

function classifyInstall(dest: SkillDestination & { exists?: boolean }, skill: DiscoveredSkill): SkillInstall {
  const linkPath = join(expandPath(dest.path), skill.name);
  if (!isSymlink(linkPath) && !existsSync(linkPath)) {
    return { destinationId: dest.id, status: "disabled", linkPath };
  }
  if (isSymlink(linkPath)) {
    const target = resolveSymlink(linkPath);
    if (!existsSync(target)) {
      return { destinationId: dest.id, status: "broken", linkPath, target };
    }
    if (samePath(target, skill.path)) {
      return { destinationId: dest.id, status: "enabled", linkPath, target };
    }
    return { destinationId: dest.id, status: "foreign", linkPath, target };
  }
  return { destinationId: dest.id, status: "real", linkPath };
}

function assertSafeDest(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts.includes(".system")) {
    throw new SkillActionError("refusing to write under .system", 400);
  }
}

function backupPath(path: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.bak.${stamp}`;
  renameSync(path, backup);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function resolveSymlink(path: string): string {
  const target = readlinkSync(path);
  return isAbsolute(target) ? target : resolve(dirname(path), target);
}

export function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function isUnder(path: string, root: string): boolean {
  try {
    const child = realpathSync(path);
    const base = realpathSync(root);
    return child === base || child.startsWith(base.endsWith("/") ? base : base + "/");
  } catch {
    const child = resolve(path);
    const base = resolve(root);
    return child === base || child.startsWith(base + "/");
  }
}

function titleFromHeading(text: string): string | undefined {
  const match = text.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function extractFrontmatter(text: string): { yaml: string } | null {
  if (!text.startsWith("---")) return null;
  const rest = text.slice(3);
  const start = rest.startsWith("\n") || rest.startsWith("\r\n") ? rest.replace(/^\r?\n/, "") : rest;
  const end = start.search(/\r?\n---\s*(?:\r?\n|$)/);
  if (end < 0) return null;
  return { yaml: start.slice(0, end) };
}

function parseFlatYamlMap(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      i += 1;
      continue;
    }
    const key = match[1]!;
    const raw = match[2] ?? "";
    if (raw === ">" || raw === "|") {
      const folded = raw === ">";
      const chunks: string[] = [];
      i += 1;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (next.trim() === "") {
          chunks.push("");
          i += 1;
          continue;
        }
        if (!/^[ \t]/.test(next)) break;
        chunks.push(next.replace(/^[ \t]+/, ""));
        i += 1;
      }
      result[key] = folded
        ? chunks.map((c) => c.trim()).filter(Boolean).join(" ")
        : chunks.join("\n").trim();
      continue;
    }
    result[key] = unquote(raw);
    i += 1;
  }
  return result;
}

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export function parseYamlLite(text: string): YamlValue {
  const lines: { indent: number; content: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^ */)?.[0].length ?? 0;
    lines.push({ indent, content: raw.trim() });
  }
  const [value] = parseYamlBlock(lines, 0, 0);
  return value;
}

function parseYamlBlock(lines: { indent: number; content: string }[], index: number, indent: number): [YamlValue, number] {
  if (index >= lines.length) return [null, index];
  const first = lines[index]!;
  if (first.content.startsWith("- ")) {
    return parseYamlList(lines, index, indent);
  }
  return parseYamlMap(lines, index, indent);
}

function parseYamlMap(
  lines: { indent: number; content: string }[],
  index: number,
  indent: number,
): [{ [key: string]: YamlValue }, number] {
  const map: { [key: string]: YamlValue } = {};
  let i = index;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) break;
    const match = line.content.match(/^([^:]+):(.*)$/);
    if (!match) {
      i += 1;
      continue;
    }
    const key = match[1]!.trim();
    const rest = match[2]!.trim();
    i += 1;
    if (rest === "") {
      const next = lines[i];
      if (!next || next.indent <= indent) {
        map[key] = null;
      } else {
        const [child, nextIndex] = parseYamlBlock(lines, i, next.indent);
        map[key] = child;
        i = nextIndex;
      }
    } else {
      map[key] = parseScalar(rest);
    }
  }
  return [map, i];
}

function parseYamlList(
  lines: { indent: number; content: string }[],
  index: number,
  indent: number,
): [YamlValue[], number] {
  const list: YamlValue[] = [];
  let i = index;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) break;
    if (!line.content.startsWith("- ")) break;
    const rest = line.content.slice(2).trim();
    i += 1;
    if (rest === "") {
      const next = lines[i];
      if (!next || next.indent <= indent) {
        list.push(null);
      } else {
        const [child, nextIndex] = parseYamlBlock(lines, i, next.indent);
        list.push(child);
        i = nextIndex;
      }
    } else if (/^[^:]+:\s*/.test(rest) && !rest.startsWith("http")) {
      const fake = [{ indent, content: rest }, ...lines.slice(i).map((l) => ({ ...l }))];
      const [child, consumed] = parseYamlMap(fake, 0, indent);
      list.push(child);
      i += Math.max(0, consumed - 1);
    } else {
      list.push(parseScalar(rest));
    }
  }
  return [list, i];
}

function parseScalar(raw: string): YamlValue {
  const value = unquote(raw);
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function asRecord(value: YamlValue | undefined): { [key: string]: YamlValue } {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function stringValue(value: YamlValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function stringList(value: YamlValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter(Boolean);
}
