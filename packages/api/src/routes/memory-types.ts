// Contract JSON shapes for the claude-memory REST surface (mirrors the napi
// objects in crates/claude-memory-node/src/lib.rs).

export type ProjectSummary = {
  slug: string;
  memoryDir: string;
  indexPresent: boolean;
  memoryCount: number;
};

export type MemorySummary = {
  slug: string;
  fileName: string;
  title: string;
  description: string | null;
  type: string | null;
  modified: string | null;
  mtimeMs: number;
  sizeBytes: number;
  indexed: boolean;
  indexHook: string | null;
};

export type MemoryDetail = MemorySummary & {
  body: string;
  frontmatterRaw: string | null;
  raw: string;
};

export type ListMemoriesResult = {
  indexRaw: string;
  entries: MemorySummary[];
};

export type SearchHit = {
  project: string;
  slug: string;
  field: "title" | "description" | "body";
  line: number;
  snippet: string;
};

export type WriteResult = {
  slug: string;
  indexUpdated: boolean;
};

export type DeleteResult = {
  slug: string;
  fileDeleted: boolean;
  indexLinesRemoved: number;
};
