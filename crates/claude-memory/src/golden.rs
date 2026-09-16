//! Shared golden-fixture generation: runs the ops against the fixture
//! corpus in `tests/golden/projects/` and renders `expected.json`.
//!
//! `mtimeMs` is filesystem-derived and checkout-dependent, so it is omitted
//! from the golden JSON (Swift compares it separately / ignores it).

use std::path::Path;

use crate::ops::{self, MemoryDetail, MemorySummary};

// ---------- tiny JSON writer (std only) ----------

pub enum Json {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn write(&self, out: &mut String) {
        match self {
            Json::Str(s) => write_json_string(s, out),
            Json::Num(n) => {
                if n.fract() == 0.0 && n.abs() < 1e15 {
                    out.push_str(&format!("{}", *n as i64));
                } else {
                    out.push_str(&format!("{}", n));
                }
            }
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Null => out.push_str("null"),
            Json::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Json::Obj(fields) => {
                out.push('{');
                for (i, (k, v)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_json_string(k, out);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }

    pub fn to_string(&self) -> String {
        let mut s = String::new();
        self.write(&mut s);
        s
    }
}

fn write_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn opt_str(v: &Option<String>) -> Json {
    match v {
        Some(s) => Json::Str(s.clone()),
        None => Json::Null,
    }
}

// ---------- op → Json ----------

pub fn project_summary_json(p: &ops::ProjectSummary) -> Json {
    Json::Obj(vec![
        ("slug".into(), Json::Str(p.slug.clone())),
        ("memoryDir".into(), Json::Str(p.memory_dir.clone())),
        ("indexPresent".into(), Json::Bool(p.index_present)),
        ("memoryCount".into(), Json::Num(p.memory_count as f64)),
    ])
}

pub fn memory_summary_json(m: &MemorySummary, with_mtime: bool) -> Json {
    let mut fields = vec![
        ("slug".to_string(), Json::Str(m.slug.clone())),
        ("fileName".to_string(), Json::Str(m.file_name.clone())),
        ("title".to_string(), Json::Str(m.title.clone())),
        ("description".to_string(), opt_str(&m.description)),
        ("type".to_string(), opt_str(&m.type_)),
        ("modified".to_string(), opt_str(&m.modified)),
    ];
    if with_mtime {
        fields.push(("mtimeMs".to_string(), Json::Num(m.mtime_ms)));
    }
    fields.push(("sizeBytes".to_string(), Json::Num(m.size_bytes as f64)));
    fields.push(("indexed".to_string(), Json::Bool(m.indexed)));
    fields.push(("indexHook".to_string(), opt_str(&m.index_hook)));
    Json::Obj(fields)
}

pub fn memory_detail_json(d: &MemoryDetail) -> Json {
    // mtimeMs omitted: filesystem-derived, not stable across checkouts.
    let mut summary = match memory_summary_json(&d.summary, false) {
        Json::Obj(fields) => fields,
        _ => unreachable!(),
    };
    summary.push(("body".to_string(), Json::Str(d.body.clone())));
    summary.push(("frontmatterRaw".to_string(), opt_str(&d.frontmatter_raw)));
    summary.push(("raw".to_string(), Json::Str(d.raw.clone())));
    Json::Obj(summary)
}

/// Build the full expected.json content for the fixture corpus at `root`
/// (the `tests/golden/projects` directory).
pub fn golden_json(root: &Path) -> String {
    let project = "-Users-test-Demo";
    let projects = ops::list_projects(root)
        .expect("listProjects")
        .into_iter()
        .map(|mut p| {
            // Relativize for cross-machine golden stability.
            p.memory_dir = format!("tests/golden/projects/{}/memory", p.slug);
            p
        })
        .collect::<Vec<_>>();
    let memories = ops::list_memories(root, project).expect("listMemories");
    let alpha = ops::read_memory(root, project, "alpha-memory").expect("readMemory alpha");
    let unindexed = ops::read_memory(root, project, "unindexed-note").expect("readMemory unindexed");
    let hits = ops::search_memories(root, "XYZZY", None).expect("searchMemories");
    let hits_project = ops::search_memories(root, "index", Some(project)).expect("searchMemories project");

    let doc = Json::Obj(vec![
        (
            "listProjects".into(),
            Json::Obj(vec![(
                "args".into(),
                Json::Obj(vec![("root".into(), Json::Str("tests/golden/projects".into()))]),
            )]),
        ),
        (
            "listProjectsResult".into(),
            Json::Arr(projects.iter().map(|p| project_summary_json(p)).collect()),
        ),
        (
            "listMemoriesArgs".into(),
            Json::Obj(vec![
                ("root".into(), Json::Str("tests/golden/projects".into())),
                ("project".into(), Json::Str(project.into())),
            ]),
        ),
        (
            "listMemoriesResult".into(),
            Json::Obj(vec![
                ("indexRaw".into(), Json::Str(memories.index_raw.clone())),
                (
                    "entries".into(),
                    Json::Arr(memories.entries.iter().map(|m| memory_summary_json(m, false)).collect()),
                ),
            ]),
        ),
        (
            "readMemoryAlphaArgs".into(),
            Json::Obj(vec![
                ("project".into(), Json::Str(project.into())),
                ("slug".into(), Json::Str("alpha-memory".into())),
            ]),
        ),
        ("readMemoryAlphaResult".into(), memory_detail_json(&alpha)),
        (
            "readMemoryUnindexedResult".into(),
            memory_detail_json(&unindexed),
        ),
        (
            "searchMemoriesArgs".into(),
            Json::Obj(vec![
                ("root".into(), Json::Str("tests/golden/projects".into())),
                ("query".into(), Json::Str("XYZZY".into())),
            ]),
        ),
        (
            "searchMemoriesResult".into(),
            Json::Arr(
                hits.iter()
                    .map(|h| {
                        Json::Obj(vec![
                            ("project".into(), Json::Str(h.project.clone())),
                            ("slug".into(), Json::Str(h.slug.clone())),
                            ("field".into(), Json::Str(h.field.clone())),
                            ("line".into(), Json::Num(h.line as f64)),
                            ("snippet".into(), Json::Str(h.snippet.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "searchMemoriesProjectScopedArgs".into(),
            Json::Obj(vec![
                ("root".into(), Json::Str("tests/golden/projects".into())),
                ("query".into(), Json::Str("index".into())),
                ("project".into(), Json::Str(project.into())),
            ]),
        ),
        (
            "searchMemoriesProjectScopedResult".into(),
            Json::Arr(
                hits_project
                    .iter()
                    .map(|h| {
                        Json::Obj(vec![
                            ("project".into(), Json::Str(h.project.clone())),
                            ("slug".into(), Json::Str(h.slug.clone())),
                            ("field".into(), Json::Str(h.field.clone())),
                            ("line".into(), Json::Num(h.line as f64)),
                            ("snippet".into(), Json::Str(h.snippet.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]);
    let mut json = doc.to_string();
    json.push('\n');
    json
}
