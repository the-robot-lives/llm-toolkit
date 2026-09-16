//! Integration tests: golden-fixture ops coverage + edge cases. The fixture
//! corpus is copied to a temp dir before every mutation test.

use std::fs;
use std::path::{Path, PathBuf};

use claude_memory::error::Error;
use claude_memory::ops::{self, CreateInput, UpdateInput};

fn workspace_root() -> PathBuf {
    // tests/ -> crate dir -> crates dir -> workspace root
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn golden_projects() -> PathBuf {
    workspace_root().join("claude-memory/tests/golden/projects")
}

fn temp_corpus(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("claude-memory-it-{}-{}", tag, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    copy_dir(&golden_projects(), &dir.join("projects"));
    dir.join("projects")
}

fn copy_dir(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let to = dst.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &to);
        } else {
            fs::copy(entry.path(), to).unwrap();
        }
    }
}

fn project_dir(root: &Path, name: &str) -> PathBuf {
    let p = root.join(name).join("memory");
    fs::create_dir_all(&p).unwrap();
    root.to_path_buf()
}

// ---------- golden ops over the committed corpus ----------

#[test]
fn list_projects() {
    let root = golden_projects();
    let projects = ops::list_projects(&root).unwrap();
    assert_eq!(projects.len(), 1);
    let p = &projects[0];
    assert_eq!(p.slug, "-Users-test-Demo");
    assert!(p.index_present);
    assert_eq!(p.memory_count, 4);
    assert!(p.memory_dir.ends_with("memory"));
}

#[test]
fn list_memories_sorted_with_hooks() {
    let root = golden_projects();
    let out = ops::list_memories(&root, "-Users-test-Demo").unwrap();
    let slugs: Vec<&str> = out.entries.iter().map(|e| e.slug.as_str()).collect();
    assert_eq!(slugs, ["alpha-memory", "beta-feedback", "gamma-reference", "unindexed-note"]);
    let alpha = &out.entries[0];
    assert_eq!(alpha.title, "alpha-memory");
    assert_eq!(alpha.description.as_deref(), Some("First test memory for golden fixtures"));
    assert_eq!(alpha.type_.as_deref(), Some("project"));
    assert_eq!(alpha.modified.as_deref(), Some("2026-09-01T00:00:00.000Z"));
    assert!(alpha.indexed);
    assert_eq!(alpha.index_hook.as_deref(), Some("first test memory for golden fixtures"));
    let unindexed = out.entries.iter().find(|e| e.slug == "unindexed-note").unwrap();
    assert!(!unindexed.indexed);
    assert_eq!(unindexed.index_hook, None);
    assert!(out.index_raw.starts_with("# Memory Index"));
}

#[test]
fn read_memory_full_shape() {
    let root = golden_projects();
    let d = ops::read_memory(&root, "-Users-test-Demo", "alpha-memory").unwrap();
    assert_eq!(d.summary.title, "alpha-memory");
    assert_eq!(
        d.frontmatter_raw.as_deref(),
        Some("name: alpha-memory\ndescription: \"First test memory for golden fixtures\"\nmetadata:\n  type: project\n  originSessionId: 00000000-0000-0000-0000-000000000001\n  modified: 2026-09-01T00:00:00.000Z")
    );
    assert_eq!(d.body, "Body of alpha with a [[beta-feedback]] link and searchable needle XYZZY-ALPHA.\nSecond line mentions gamma-reference too.\n");
    assert!(d.raw.starts_with("---\nname: alpha-memory"));
}

#[test]
fn read_memory_missing_is_not_found() {
    let root = golden_projects();
    let err = ops::read_memory(&root, "-Users-test-Demo", "ghost").unwrap_err();
    assert_eq!(err.code(), "NOT_FOUND");
}

#[test]
fn search_orders_projects_slugs_fields_lines() {
    let root = golden_projects();
    let hits = ops::search_memories(&root, "XYZZY", None).unwrap();
    assert_eq!(hits.len(), 4);
    assert_eq!(hits[0].slug, "alpha-memory");
    assert_eq!(hits[0].field, "body");
    assert!(hits[0].snippet.contains("XYZZY-ALPHA"));
    // description hits before body hits for the same slug (beta has none in body order)
    let beta: Vec<_> = hits.iter().filter(|h| h.slug == "beta-feedback").collect();
    assert_eq!(beta.len(), 1);
    // case-insensitive
    let lower = ops::search_memories(&root, "xyzzy-alpha", None).unwrap();
    assert_eq!(lower.len(), 1);
    // index file never searched
    let idx_hits = ops::search_memories(&root, "one line per topic", None).unwrap();
    assert!(idx_hits.is_empty());
    // project scoping
    let scoped = ops::search_memories(&root, "XYZZY", Some("-Users-test-Demo")).unwrap();
    assert_eq!(scoped.len(), hits.len());
    // empty result for unknown needle
    assert!(ops::search_memories(&root, "ZZZNOTPRESENT", None).unwrap().is_empty());
}

// ---------- create / update / delete ----------

#[test]
fn create_happy_path_writes_frontmatter_and_index() {
    let root = temp_corpus("create");
    let res = ops::create_memory(
        &root,
        "-Users-test-Demo",
        &CreateInput {
            slug: "new-note".into(),
            name: Some("New Note".into()),
            description: Some("A fresh note".into()),
            type_: Some("user".into()),
            body: "Hello body.\n".into(),
        },
    )
    .unwrap();
    assert_eq!(res.slug, "new-note");
    assert!(res.index_updated);

    let d = ops::read_memory(&root, "-Users-test-Demo", "new-note").unwrap();
    assert_eq!(d.summary.title, "New Note");
    assert_eq!(d.summary.type_.as_deref(), Some("user"));
    let modified = d.summary.modified.clone().unwrap();
    assert_eq!(modified.len(), 24);
    assert!(modified.ends_with('Z'));
    assert_eq!(d.body, "Hello body.\n");
    assert!(d.raw.starts_with("---\nname: New Note\n"));

    // index line appended at end
    let out = ops::list_memories(&root, "-Users-test-Demo").unwrap();
    let entry = out.entries.iter().find(|e| e.slug == "new-note").unwrap();
    assert!(entry.indexed);
    assert_eq!(entry.index_hook.as_deref(), Some("A fresh note"));
    assert!(out.index_raw.trim_end().ends_with("- [New Note](new-note.md) — A fresh note"));
}

#[test]
fn create_into_project_without_index_creates_index() {
    let root = temp_corpus("create-index");
    project_dir(&root, "-Users-fresh");
    ops::create_memory(
        &root,
        "-Users-fresh",
        &CreateInput {
            slug: "solo".into(),
            name: None,
            description: None,
            type_: None,
            body: "b".into(),
        },
    )
    .unwrap();
    let idx = fs::read_to_string(root.join("-Users-fresh/memory/MEMORY.md")).unwrap();
    assert!(idx.starts_with("# Memory Index"));
    assert!(idx.contains("- [solo](solo.md)"));
    // title falls back to slug
    let d = ops::read_memory(&root, "-Users-fresh", "solo").unwrap();
    assert_eq!(d.summary.title, "solo");
}

#[test]
fn create_error_cases() {
    let root = temp_corpus("create-errors");
    // EXISTS
    let err = ops::create_memory(
        &root,
        "-Users-test-Demo",
        &CreateInput { slug: "alpha-memory".into(), body: String::new(), ..Default::default() },
    )
    .unwrap_err();
    assert_eq!(err.code(), "EXISTS");
    // INVALID_SLUG variants
    for bad in ["../evil", ".hidden", "a/b", "", "a..b", "has space"] {
        let err = ops::create_memory(
            &root,
            "-Users-test-Demo",
            &CreateInput { slug: bad.into(), body: String::new(), ..Default::default() },
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALID_SLUG", "slug {bad:?}");
    }
    // NO_PROJECT (project dir missing)
    let err = ops::create_memory(
        &root,
        "-Users-nope",
        &CreateInput { slug: "x".into(), body: String::new(), ..Default::default() },
    )
    .unwrap_err();
    assert_eq!(err.code(), "NO_PROJECT");
    // NO_PROJECT (project dir exists but no memory dir)
    fs::create_dir_all(root.join("-Users-bare")).unwrap();
    let err = ops::create_memory(
        &root,
        "-Users-bare",
        &CreateInput { slug: "x".into(), body: String::new(), ..Default::default() },
    )
    .unwrap_err();
    assert_eq!(err.code(), "NO_PROJECT");
}

#[test]
fn update_field_patch_bumps_modified_and_syncs_index() {
    let root = temp_corpus("update");
    let before = ops::read_memory(&root, "-Users-test-Demo", "alpha-memory").unwrap();
    let res = ops::update_memory(
        &root,
        "-Users-test-Demo",
        "alpha-memory",
        &UpdateInput {
            name: Some("Alpha Renamed".into()),
            description: Some("Updated hook".into()),
            sync_index: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(res.index_updated);
    let after = ops::read_memory(&root, "-Users-test-Demo", "alpha-memory").unwrap();
    assert_eq!(after.summary.title, "Alpha Renamed");
    assert_ne!(after.summary.modified, before.summary.modified);
    // other frontmatter preserved
    assert!(after.frontmatter_raw.as_ref().unwrap().contains("originSessionId: 00000000-0000-0000-0000-000000000001"));
    // index entry rewritten
    let out = ops::list_memories(&root, "-Users-test-Demo").unwrap();
    let a = out.entries.iter().find(|e| e.slug == "alpha-memory").unwrap();
    assert_eq!(a.index_hook.as_deref(), Some("Updated hook"));
}

#[test]
fn update_without_sync_leaves_index() {
    let root = temp_corpus("update-nosync");
    let res = ops::update_memory(
        &root,
        "-Users-test-Demo",
        "alpha-memory",
        &UpdateInput {
            name: Some("Changed".into()),
            sync_index: false,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!res.index_updated);
    let out = ops::list_memories(&root, "-Users-test-Demo").unwrap();
    let a = out.entries.iter().find(|e| e.slug == "alpha-memory").unwrap();
    assert_eq!(a.index_hook.as_deref(), Some("first test memory for golden fixtures"));
    // index line byte-untouched (old title kept); file title changed
    assert!(out.index_raw.contains("- [Alpha memory](alpha-memory.md) — first test memory for golden fixtures"));
}

#[test]
fn update_unindexed_file_touches_no_index() {
    let root = temp_corpus("update-unindexed");
    let res = ops::update_memory(
        &root,
        "-Users-test-Demo",
        "unindexed-note",
        &UpdateInput {
            description: Some("New desc".into()),
            sync_index: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!res.index_updated); // not indexed → no auto-add
    let raw = fs::read_to_string(root.join("-Users-test-Demo/memory/MEMORY.md")).unwrap();
    assert!(raw.contains("- [Alpha memory](alpha-memory.md)"));
}

#[test]
fn update_content_replaces_raw_and_bumps() {
    let root = temp_corpus("update-content");
    let replacement = "---\nname: gamma-reference\nmetadata:\n  type: reference\n  modified: 2020-01-01T00:00:00.000Z\n---\n\nReplaced body.\n";
    ops::update_memory(
        &root,
        "-Users-test-Demo",
        "gamma-reference",
        &UpdateInput { content: Some(replacement.into()), sync_index: true, ..Default::default() },
    )
    .unwrap();
    let d = ops::read_memory(&root, "-Users-test-Demo", "gamma-reference").unwrap();
    assert_eq!(d.body, "Replaced body.\n");
    assert!(!d.summary.modified.as_deref().unwrap().starts_with("2020"));
    // untouched fields survive
    assert!(d.frontmatter_raw.as_ref().unwrap().contains("type: reference"));
}

#[test]
fn update_missing_not_found() {
    let root = temp_corpus("update-missing");
    let err = ops::update_memory(
        &root,
        "-Users-test-Demo",
        "ghost",
        &UpdateInput { name: Some("x".into()), ..Default::default() },
    )
    .unwrap_err();
    assert_eq!(err.code(), "NOT_FOUND");
}

#[test]
fn delete_removes_file_and_index_lines() {
    let root = temp_corpus("delete");
    let res = ops::delete_memory(&root, "-Users-test-Demo", "alpha-memory").unwrap();
    assert!(res.file_deleted);
    assert_eq!(res.index_lines_removed, 1);
    assert!(!root.join("-Users-test-Demo/memory/alpha-memory.md").exists());
    let raw = fs::read_to_string(root.join("-Users-test-Demo/memory/MEMORY.md")).unwrap();
    assert!(!raw.contains("alpha-memory.md"));
    assert!(raw.contains("## Reference")); // empty sections kept
    // second delete: file already gone, index already clean
    let res = ops::delete_memory(&root, "-Users-test-Demo", "alpha-memory").unwrap();
    assert!(!res.file_deleted);
    assert_eq!(res.index_lines_removed, 0);
    // missing file, present index line: cleanup still happens
    let beta_path = root.join("-Users-test-Demo/memory/beta-feedback.md");
    fs::remove_file(&beta_path).unwrap();
    let res = ops::delete_memory(&root, "-Users-test-Demo", "beta-feedback").unwrap();
    assert!(!res.file_deleted);
    assert_eq!(res.index_lines_removed, 1);
}

// ---------- misc ----------

#[test]
fn non_utf8_file_is_io_error() {
    let root = temp_corpus("nonutf8");
    fs::write(
        root.join("-Users-test-Demo/memory/broken.md"),
        [0xff, 0xfe, 0x00, b'b'],
    )
    .unwrap();
    let err = ops::read_memory(&root, "-Users-test-Demo", "broken").unwrap_err();
    assert_eq!(err.code(), "IO");
    let err = ops::search_memories(&root, "x", Some("-Users-test-Demo")).unwrap_err();
    assert_eq!(err.code(), "IO");
}

#[test]
fn no_frontmatter_file_round_trips() {
    let root = temp_corpus("nofm");
    fs::write(root.join("-Users-test-Demo/memory/plain.md"), "just text\nno frontmatter\n").unwrap();
    let d = ops::read_memory(&root, "-Users-test-Demo", "plain").unwrap();
    assert_eq!(d.frontmatter_raw, None);
    assert_eq!(d.body, "just text\nno frontmatter\n");
    assert_eq!(d.summary.title, "plain");
    assert_eq!(d.summary.type_, None);
}

#[test]
fn missing_index_is_tolerated() {
    let root = temp_corpus("noindex");
    fs::remove_file(root.join("-Users-test-Demo/memory/MEMORY.md")).unwrap();
    let out = ops::list_memories(&root, "-Users-test-Demo").unwrap();
    assert_eq!(out.index_raw, "");
    assert_eq!(out.entries.len(), 4);
    assert!(out.entries.iter().all(|e| !e.indexed && e.index_hook.is_none()));
}

// ---------- golden regeneration / verification ----------

#[test]
fn golden_expected_json_matches() {
    let expected_path = workspace_root().join("claude-memory/tests/golden/expected.json");
    let generated = claude_memory::golden::golden_json(&golden_projects());
    if std::env::var("CLAUDE_MEMORY_REGEN").ok().as_deref() == Some("1") {
        fs::write(&expected_path, &generated).unwrap();
        return;
    }
    let committed = fs::read_to_string(&expected_path).unwrap();
    assert_eq!(generated, committed, "golden drift — rerun with CLAUDE_MEMORY_REGEN=1");
}
