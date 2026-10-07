//! Contract operations: listProjects, listMemories, readMemory,
//! searchMemories, createMemory, updateMemory, deleteMemory.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::frontmatter::MemoryFile;
use crate::index::IndexFile;
use crate::time::now_utc;

// ---------- JSON-shaped result types ----------

#[derive(Debug, Clone, PartialEq)]
pub struct ListMemoriesOutput {
    pub index_raw: String,
    pub entries: Vec<MemorySummary>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectSummary {
    pub slug: String,
    pub memory_dir: String,
    pub index_present: bool,
    pub memory_count: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemorySummary {
    pub slug: String,
    pub file_name: String,
    pub title: String,
    pub description: Option<String>,
    pub type_: Option<String>,
    pub modified: Option<String>,
    pub mtime_ms: f64,
    pub size_bytes: u64,
    pub indexed: bool,
    pub index_hook: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemoryDetail {
    pub summary: MemorySummary,
    pub body: String,
    pub frontmatter_raw: Option<String>,
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub project: String,
    pub slug: String,
    /// "title" | "description" | "body"
    pub field: String,
    pub line: u64,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WriteResult {
    pub slug: String,
    pub index_updated: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeleteResult {
    pub slug: String,
    pub file_deleted: bool,
    pub index_lines_removed: u64,
}

// ---------- path helpers ----------

pub fn validate_slug(slug: &str) -> Result<()> {
    let valid = !slug.is_empty()
        && slug.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !slug.contains("..")
        && !slug.starts_with('.');
    if valid {
        Ok(())
    } else {
        Err(Error::InvalidSlug(slug.to_string()))
    }
}

pub fn memory_dir(root: &Path, project: &str) -> PathBuf {
    root.join(project).join("memory")
}

pub fn index_path(root: &Path, project: &str) -> PathBuf {
    memory_dir(root, project).join("MEMORY.md")
}

fn file_slug(file_name: &str) -> Option<&str> {
    let stem = file_name.strip_suffix(".md")?;
    if stem == "MEMORY" {
        None
    } else {
        Some(stem)
    }
}

fn dir_entries(dir: &Path) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir).map_err(Error::from)? {
        let entry = entry.map_err(Error::from)?;
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    Ok(names)
}

// ---------- atomic write ----------

pub fn atomic_write(path: &Path, contents: &str) -> Result<()> {
    let dir = path.parent().ok_or_else(|| Error::Io("no parent dir".into()))?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id()
    ));
    fs::write(&tmp, contents).map_err(Error::from)?;
    // Rename within the same directory.
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        Error::Io(e.to_string())
    })
}

// ---------- read-side ops ----------

/// Projects = subdirectories of root containing a `memory/` subdir,
/// sorted by slug asc.
pub fn list_projects(root: &Path) -> Result<Vec<ProjectSummary>> {
    let mut out = Vec::new();
    let names = dir_entries(root)?;
    for name in names {
        let mem = memory_dir(root, &name);
        if !mem.is_dir() {
            continue;
        }
        let mut count = 0u64;
        for f in dir_entries(&mem)? {
            if file_slug(&f).is_some() {
                count += 1;
            }
        }
        let index_present = index_path(root, &name).is_file();
        out.push(ProjectSummary {
            slug: name,
            memory_dir: mem.to_string_lossy().into_owned(),
            index_present,
            memory_count: count,
        });
    }
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(out)
}

fn stat_ms(path: &Path) -> Result<(f64, u64)> {
    let meta = fs::metadata(path).map_err(Error::from)?;
    let mtime = meta
        .modified()
        .map_err(Error::from)?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    Ok((mtime.as_secs_f64() * 1000.0, meta.len()))
}

fn summarize(root: &Path, project: &str, index: &IndexFile, slug: &str) -> Result<MemorySummary> {
    let file_name = format!("{}.md", slug);
    let path = memory_dir(root, project).join(&file_name);
    let (mtime_ms, size_bytes) = stat_ms(&path)?;
    let text = fs::read_to_string(&path).map_err(Error::from)?;
    let mf = MemoryFile::parse(&text);
    Ok(MemorySummary {
        slug: slug.to_string(),
        file_name,
        title: mf.name().unwrap_or(slug).to_string(),
        description: mf.description().map(|s| s.to_string()),
        type_: mf.type_().map(|s| s.to_string()),
        modified: mf.modified().map(|s| s.to_string()),
        mtime_ms,
        size_bytes,
        indexed: index.is_indexed(slug),
        index_hook: index.hook_for(slug),
    })
}

/// `{indexRaw, entries[]}` — entries sorted by slug asc.
pub fn list_memories(root: &Path, project: &str) -> Result<ListMemoriesOutput> {
    let mem = memory_dir(root, project);
    let index_raw = match fs::read_to_string(index_path(root, project)) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(Error::Io(e.to_string())),
    };
    let index = IndexFile::parse(&index_raw);
    let mut slugs: Vec<String> = Vec::new();
    for f in dir_entries(&mem)? {
        if let Some(slug) = file_slug(&f) {
            slugs.push(slug.to_string());
        }
    }
    slugs.sort();
    let mut entries = Vec::new();
    for slug in &slugs {
        entries.push(summarize(root, project, &index, slug)?);
    }
    Ok(ListMemoriesOutput {
        index_raw,
        entries,
    })
}

/// MemorySummary + body/frontmatterRaw/raw. Missing file ⇒ NOT_FOUND.
pub fn read_memory(root: &Path, project: &str, slug: &str) -> Result<MemoryDetail> {
    validate_slug(slug)?;
    let path = memory_dir(root, project).join(format!("{}.md", slug));
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::NotFound(format!("{}/{}", project, slug)))
        }
        // Non-UTF8 bytes (or other read failure) surface as IO.
        Err(e) => return Err(Error::Io(e.to_string())),
    };
    let index_raw = fs::read_to_string(index_path(root, project)).unwrap_or_default();
    let index = IndexFile::parse(&index_raw);
    let summary = summarize(root, project, &index, slug)?;
    let mf = MemoryFile::parse(&raw);
    Ok(MemoryDetail {
        summary,
        body: mf.body,
        frontmatter_raw: mf.frontmatter_raw,
        raw,
    })
}

fn field_rank(field: &str) -> u8 {
    match field {
        "title" => 0,
        "description" => 1,
        _ => 2,
    }
}

/// Case-insensitive substring search over title, description, body across
/// one project or all. MEMORY.md itself is NOT searched.
pub fn search_memories(root: &Path, query: &str, project: Option<&str>) -> Result<Vec<SearchHit>> {
    let needle = query.to_lowercase();
    let mut hits = Vec::new();
    let projects: Vec<String> = match project {
        Some(p) => vec![p.to_string()],
        None => list_projects(root)?
            .into_iter()
            .map(|p| p.slug)
            .collect(),
    };
    for proj in projects {
        let mem = memory_dir(root, &proj);
        let mut slugs: Vec<String> = Vec::new();
        for f in dir_entries(&mem)? {
            if let Some(slug) = file_slug(&f) {
                slugs.push(slug.to_string());
            }
        }
        slugs.sort();
        for slug in slugs {
            let path = mem.join(format!("{}.md", slug));
            let text = match fs::read_to_string(&path) {
                Ok(t) => t,
                Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                    return Err(Error::Io(format!("{}: non-UTF8 content", path.display())))
                }
                Err(e) => return Err(Error::Io(e.to_string())),
            };
            let mf = MemoryFile::parse(&text);
            let title = mf.name().unwrap_or(&slug).to_string();
            let mut project_hits: Vec<SearchHit> = Vec::new();
            let mut scan = |field: &str, content: &str| {
                for (i, line) in content.lines().enumerate() {
                    if line.to_lowercase().contains(&needle) {
                        let mut snippet: String = line.trim().chars().take(240).collect();
                        if snippet.is_empty() && !line.trim().is_empty() {
                            snippet = line.trim().to_string();
                        }
                        project_hits.push(SearchHit {
                            project: proj.clone(),
                            slug: slug.clone(),
                            field: field.to_string(),
                            line: (i + 1) as u64,
                            snippet,
                        });
                    }
                }
            };
            scan("title", &title);
            if let Some(desc) = mf.description() {
                scan("description", desc);
            }
            scan("body", &mf.body);
            hits.append(&mut project_hits);
        }
    }
    hits.sort_by(|a, b| {
        a.project
            .cmp(&b.project)
            .then(a.slug.cmp(&b.slug))
            .then(field_rank(&a.field).cmp(&field_rank(&b.field)))
            .then(a.line.cmp(&b.line))
    });
    Ok(hits)
}

// ---------- write-side ops ----------

/// Create a memory file + index entry. Errors: INVALID_SLUG, NO_PROJECT,
/// EXISTS.
pub fn create_memory(
    root: &Path,
    project: &str,
    input: &CreateInput,
) -> Result<WriteResult> {
    validate_slug(&input.slug)?;
    let mem = memory_dir(root, project);
    if !mem.is_dir() {
        return Err(Error::NoProject(project.to_string()));
    }
    let path = mem.join(format!("{}.md", input.slug));
    if path.exists() {
        return Err(Error::Exists(format!("{}/{}", project, input.slug)));
    }

    let mut fm = crate::frontmatter::Frontmatter::default();
    if let Some(name) = &input.name {
        fm.set_flat("name", name);
    }
    if let Some(desc) = &input.description {
        fm.set_flat("description", desc);
    }
    if let Some(t) = &input.type_ {
        fm.set_metadata_child("type", t);
    }
    fm.set_metadata_child("modified", &now_utc());

    let mf = MemoryFile {
        frontmatter: Some(fm),
        frontmatter_raw: None,
        body: input.body.clone(),
    };
    atomic_write(&path, &mf.to_raw())?;

    // Index: append entry; create MEMORY.md when missing.
    let ipath = index_path(root, project);
    let mut index = match fs::read_to_string(&ipath) {
        Ok(s) => IndexFile::parse(&s),
        Err(_) => IndexFile::parse("# Memory Index\n\n"),
    };
    let title = input.name.clone().unwrap_or_else(|| input.slug.clone());
    let hook = input.description.clone().unwrap_or_default();
    let was_present = index.is_indexed(&input.slug);
    index.append(&input.slug, &title, &hook);
    atomic_write(&ipath, &index.to_string())?;

    Ok(WriteResult {
        slug: input.slug.clone(),
        index_updated: !was_present,
    })
}

#[derive(Debug, Clone, Default)]
pub struct CreateInput {
    pub slug: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub type_: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateInput {
    /// Full raw replacement (mutually exclusive with the field patches).
    pub content: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub type_: Option<String>,
    pub body: Option<String>,
    pub sync_index: bool,
}

/// Update a memory. `content` = full raw replacement; otherwise field patch.
/// Always bumps `metadata.modified` on frontmatter-bearing files. With
/// `sync_index` (default true), rewrites the entry's title/hook when indexed
/// and name/description changed; never auto-adds.
pub fn update_memory(
    root: &Path,
    project: &str,
    slug: &str,
    input: &UpdateInput,
) -> Result<WriteResult> {
    validate_slug(slug)?;
    let mem = memory_dir(root, project);
    let path = mem.join(format!("{}.md", slug));
    let old_raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::NotFound(format!("{}/{}", project, slug)))
        }
        Err(e) => return Err(Error::Io(e.to_string())),
    };

    let mut index_updated = false;
    let new_raw: String;
    let (old_name, old_desc);
    let (new_name, new_desc);

    if let Some(content) = &input.content {
        let old_mf = MemoryFile::parse(&old_raw);
        old_name = old_mf.name().map(|s| s.to_string());
        old_desc = old_mf.description().map(|s| s.to_string());
        // Raw replacement: bump modified when the replacement bears frontmatter.
        let mut mf = MemoryFile::parse(content);
        if let Some(fm) = mf.frontmatter.as_mut() {
            fm.set_metadata_child("modified", &now_utc());
        }
        new_raw = mf.to_raw();
        let new_mf = MemoryFile::parse(&new_raw);
        new_name = new_mf.name().map(|s| s.to_string());
        new_desc = new_mf.description().map(|s| s.to_string());
    } else {
        let mut mf = MemoryFile::parse(&old_raw);
        old_name = mf.name().map(|s| s.to_string());
        old_desc = mf.description().map(|s| s.to_string());
        match mf.frontmatter.as_mut() {
            Some(fm) => {
                if let Some(name) = &input.name {
                    fm.set_flat("name", name);
                }
                if let Some(desc) = &input.description {
                    fm.set_flat("description", desc);
                }
                if let Some(t) = &input.type_ {
                    fm.set_metadata_child("type", t);
                }
                // Always bump on frontmatter-bearing files.
                fm.set_metadata_child("modified", &now_utc());
            }
            None => {
                // No frontmatter: only a body patch applies.
                // (Field patches other than body are no-ops without frontmatter.)
            }
        }
        if let Some(body) = &input.body {
            mf.body = body.clone();
        }
        new_raw = mf.to_raw();
        let new_mf = MemoryFile::parse(&new_raw);
        new_name = new_mf.name().map(|s| s.to_string());
        new_desc = new_mf.description().map(|s| s.to_string());
    }

    atomic_write(&path, &new_raw)?;

    if input.sync_index && (new_name != old_name || new_desc != old_desc) {
        let ipath = index_path(root, project);
        if let Ok(index_text) = fs::read_to_string(&ipath) {
            let mut index = IndexFile::parse(&index_text);
            if index.is_indexed(slug) {
                let title = new_name.clone().unwrap_or_else(|| slug.to_string());
                let hook = new_desc.clone().unwrap_or_default();
                index_updated = index.update_entry(slug, &title, &hook);
                if index_updated {
                    atomic_write(&ipath, &index.to_string())?;
                }
            }
        }
    }

    Ok(WriteResult {
        slug: slug.to_string(),
        index_updated,
    })
}

/// Delete a memory + index cleanup. Missing file still attempts index
/// cleanup (fileDeleted=false).
pub fn delete_memory(root: &Path, project: &str, slug: &str) -> Result<DeleteResult> {
    validate_slug(slug)?;
    let path = memory_dir(root, project).join(format!("{}.md", slug));
    let file_deleted = match fs::remove_file(&path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(Error::Io(e.to_string())),
    };
    let mut index_lines_removed = 0u64;
    let ipath = index_path(root, project);
    if let Ok(index_text) = fs::read_to_string(&ipath) {
        let mut index = IndexFile::parse(&index_text);
        let removed = index.remove_slug(slug);
        if removed > 0 {
            atomic_write(&ipath, &index.to_string())?;
            index_lines_removed = removed as u64;
        }
    }
    Ok(DeleteResult {
        slug: slug.to_string(),
        file_deleted,
        index_lines_removed,
    })
}
