//! napi-rs binding for the claude-memory core. Every op is exposed as an
//! async (Promise-returning) function taking an explicit root path; errors
//! surface as JS Errors with message `MEMORY_<CODE>: <detail>`.

#![deny(clippy::all)]

use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi::{Error, Status};
use napi_derive::napi;

use claude_memory::ops;

fn to_js(e: claude_memory::Error) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("MEMORY_{}: {}", e.code(), e.detail()),
    )
}

fn root_path(root: String) -> PathBuf {
    PathBuf::from(root)
}

// ---------- object shapes (contract field names) ----------

#[napi(object)]
pub struct ProjectSummary {
    pub slug: String,
    pub memory_dir: String,
    pub index_present: bool,
    pub memory_count: u32,
}

#[napi(object)]
pub struct MemorySummary {
    pub slug: String,
    pub file_name: String,
    pub title: String,
    pub description: Option<String>,
    pub r#type: Option<String>,
    pub modified: Option<String>,
    pub mtime_ms: f64,
    pub size_bytes: f64,
    pub indexed: bool,
    pub index_hook: Option<String>,
}

#[napi(object)]
pub struct MemoryDetail {
    pub slug: String,
    pub file_name: String,
    pub title: String,
    pub description: Option<String>,
    pub r#type: Option<String>,
    pub modified: Option<String>,
    pub mtime_ms: f64,
    pub size_bytes: f64,
    pub indexed: bool,
    pub index_hook: Option<String>,
    pub body: String,
    pub frontmatter_raw: Option<String>,
    pub raw: String,
}

#[napi(object)]
pub struct ListMemoriesResult {
    pub index_raw: String,
    pub entries: Vec<MemorySummary>,
}

#[napi(object)]
pub struct SearchHit {
    pub project: String,
    pub slug: String,
    pub field: String,
    pub line: f64,
    pub snippet: String,
}

#[napi(object)]
pub struct WriteResult {
    pub slug: String,
    pub index_updated: bool,
}

#[napi(object)]
pub struct DeleteResult {
    pub slug: String,
    pub file_deleted: bool,
    pub index_lines_removed: f64,
}

#[napi(object)]
pub struct CreateMemoryInput {
    pub slug: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub r#type: Option<String>,
    pub body: String,
}

#[napi(object)]
pub struct UpdateMemoryInput {
    pub content: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub r#type: Option<String>,
    pub body: Option<String>,
    pub sync_index: Option<bool>,
}

fn summary(s: ops::MemorySummary) -> MemorySummary {
    MemorySummary {
        slug: s.slug,
        file_name: s.file_name,
        title: s.title,
        description: s.description,
        r#type: s.type_,
        modified: s.modified,
        mtime_ms: s.mtime_ms,
        size_bytes: s.size_bytes as f64,
        indexed: s.indexed,
        index_hook: s.index_hook,
    }
}

fn detail(d: ops::MemoryDetail) -> MemoryDetail {
    let s = d.summary;
    MemoryDetail {
        slug: s.slug,
        file_name: s.file_name,
        title: s.title,
        description: s.description,
        r#type: s.type_,
        modified: s.modified,
        mtime_ms: s.mtime_ms,
        size_bytes: s.size_bytes as f64,
        indexed: s.indexed,
        index_hook: s.index_hook,
        body: d.body,
        frontmatter_raw: d.frontmatter_raw,
        raw: d.raw,
    }
}

// ---------- ops ----------

#[napi]
pub async fn list_projects(root: String) -> Result<Vec<ProjectSummary>> {
    ops::list_projects(&root_path(root))
        .map(|ps| {
            ps.into_iter()
                .map(|p| ProjectSummary {
                    slug: p.slug,
                    memory_dir: p.memory_dir,
                    index_present: p.index_present,
                    memory_count: p.memory_count as u32,
                })
                .collect()
        })
        .map_err(to_js)
}

#[napi]
pub async fn list_memories(root: String, project: String) -> Result<ListMemoriesResult> {
    ops::list_memories(&root_path(root), &project)
        .map(|out| ListMemoriesResult {
            index_raw: out.index_raw,
            entries: out.entries.into_iter().map(summary).collect(),
        })
        .map_err(to_js)
}

#[napi(ts_return_type = "Promise<MemoryDetail>")]
pub async fn read_memory(root: String, project: String, slug: String) -> Result<MemoryDetail> {
    ops::read_memory(&root_path(root), &project, &slug)
        .map(detail)
        .map_err(to_js)
}

#[napi]
pub async fn search_memories(
    root: String,
    query: String,
    project: Option<String>,
) -> Result<Vec<SearchHit>> {
    ops::search_memories(&root_path(root), &query, project.as_deref())
        .map(|hits| {
            hits.into_iter()
                .map(|h| SearchHit {
                    project: h.project,
                    slug: h.slug,
                    field: h.field,
                    line: h.line as f64,
                    snippet: h.snippet,
                })
                .collect()
        })
        .map_err(to_js)
}

#[napi]
pub async fn create_memory(
    root: String,
    project: String,
    input: CreateMemoryInput,
) -> Result<WriteResult> {
    let core = ops::CreateInput {
        slug: input.slug,
        name: input.name,
        description: input.description,
        type_: input.r#type,
        body: input.body,
    };
    ops::create_memory(&root_path(root), &project, &core)
        .map(|w| WriteResult {
            slug: w.slug,
            index_updated: w.index_updated,
        })
        .map_err(to_js)
}

#[napi]
pub async fn update_memory(
    root: String,
    project: String,
    slug: String,
    input: UpdateMemoryInput,
) -> Result<WriteResult> {
    let core = ops::UpdateInput {
        content: input.content,
        name: input.name,
        description: input.description,
        type_: input.r#type,
        body: input.body,
        sync_index: input.sync_index.unwrap_or(true),
    };
    ops::update_memory(&root_path(root), &project, &slug, &core)
        .map(|w| WriteResult {
            slug: w.slug,
            index_updated: w.index_updated,
        })
        .map_err(to_js)
}

#[napi]
pub async fn delete_memory(root: String, project: String, slug: String) -> Result<DeleteResult> {
    ops::delete_memory(&root_path(root), &project, &slug)
        .map(|d| DeleteResult {
            slug: d.slug,
            file_deleted: d.file_deleted,
            index_lines_removed: d.index_lines_removed as f64,
        })
        .map_err(to_js)
}
