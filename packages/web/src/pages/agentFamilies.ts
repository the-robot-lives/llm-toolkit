import type { AgentVariantMetadata } from "@llm-toolkit/shared";

export interface AgentFamilyItem {
  name: string;
  parent?: string;
  variant?: AgentVariantMetadata;
}
export interface AgentFamily<T> {
  name: string;
  parent?: T;
  children: T[];
}

/** Group explicit relationships only. Invalid cycles stay visible as individuals. */
export function groupAgentFamilies<T extends AgentFamilyItem>(all: T[], visible: T[]): AgentFamily<T>[] {
  const byName = new Map(all.map((item) => [item.name, item]));
  const rootOf = (item: T): string => {
    const seen = new Set([item.name]);
    let current = item;
    while (current.parent) {
      if (seen.has(current.parent)) return item.name;
      seen.add(current.parent);
      const parent = byName.get(current.parent);
      if (!parent) return current.parent;
      current = parent;
    }
    return current.name;
  };
  const groups = new Map<string, AgentFamily<T>>();
  for (const item of visible) {
    const name = rootOf(item);
    let group = groups.get(name);
    if (!group) {
      group = { name, parent: byName.get(name), children: [] };
      groups.set(name, group);
    }
    if (item.name !== name) group.children.push(item);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}
