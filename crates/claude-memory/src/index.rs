//! MEMORY.md index parser/patcher.
//!
//! Entry line: `- [<title>](<slug>.md) — <hook>`. Parsing is tolerant: any
//! `- ` bullet line whose link target ends in `.md` is an entry; the
//! separator may be em-dash or hyphen; hook may be empty. All non-entry
//! lines are preserved verbatim and in order on rewrite.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    /// Link display text (kept verbatim).
    pub title: String,
    /// Link target, e.g. `alpha-memory.md`.
    pub target: String,
    /// Slug (target with `.md` stripped).
    pub slug: String,
    /// Hook text after the separator (empty string when absent).
    pub hook: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IndexFile {
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    Entry(IndexEntry),
    /// Any other line, verbatim (without trailing newline).
    Verbatim(String),
}

/// Parse one line as an entry, if it is one.
pub fn parse_entry(line: &str) -> Option<IndexEntry> {
    let t = line.trim_start();
    if !t.starts_with("- ") {
        return None;
    }
    // Find `[title](target)` after the bullet.
    let rest = &t[2..];
    let open = rest.find('[')?;
    let close = rest[open + 1..].find(']')? + open + 1;
    let title = rest[open + 1..close].to_string();
    if title.contains('[') {
        return None;
    }
    if !rest[close + 1..].starts_with('(') {
        return None;
    }
    let target_start = close + 2;
    let target_end = rest[target_start..].find(')')? + target_start;
    let target = rest[target_start..target_end].to_string();
    if !target.ends_with(".md") || target.contains('/') {
        return None;
    }
    let slug = target[..target.len() - 3].to_string();
    let after = &rest[target_end + 1..];
    // Separator: " — " (em-dash) or " - " (hyphen), else empty hook.
    let hook = if let Some(h) = after.strip_prefix(" — ") {
        h.to_string()
    } else if let Some(h) = after.strip_prefix(" - ") {
        h.to_string()
    } else {
        String::new()
    };
    Some(IndexEntry {
        title,
        target,
        slug,
        hook,
    })
}

fn render_entry(e: &IndexEntry) -> String {
    if e.hook.is_empty() {
        format!("- [{}]({})", e.title, e.target)
    } else {
        format!("- [{}]({}) — {}", e.title, e.target, e.hook)
    }
}

/// Truncate a hook to ~120 chars on one line (no newlines).
pub fn truncate_hook(text: &str) -> String {
    let one_line: String = text.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c }).collect();
    let one_line = one_line.trim();
    if one_line.chars().count() <= 120 {
        one_line.to_string()
    } else {
        let truncated: String = one_line.chars().take(120).collect();
        format!("{}…", truncated.trim_end())
    }
}

impl IndexFile {
    pub fn parse(raw: &str) -> IndexFile {
        IndexFile {
            lines: raw.lines().map(|l| match parse_entry(l) {
                Some(e) => Line::Entry(e),
                None => Line::Verbatim(l.to_string()),
            }).collect(),
        }
    }

    pub fn to_string(&self) -> String {
        let mut out = String::new();
        for l in &self.lines {
            match l {
                Line::Entry(e) => out.push_str(&render_entry(e)),
                Line::Verbatim(v) => out.push_str(v),
            }
            out.push('\n');
        }
        out
    }

    pub fn is_indexed(&self, slug: &str) -> bool {
        let target = format!("{}.md", slug);
        self.lines.iter().any(|l| {
            matches!(l, Line::Entry(e) if e.target == target)
        })
    }

    pub fn hook_for(&self, slug: &str) -> Option<String> {
        let target = format!("{}.md", slug);
        self.lines.iter().find_map(|l| match l {
            Line::Entry(e) if e.target == target => Some(e.hook.clone()),
            _ => None,
        })
    }

    /// Append an entry line (`title`, `hook`).
    pub fn append(&mut self, slug: &str, title: &str, hook: &str) {
        self.lines.push(Line::Entry(IndexEntry {
            title: title.to_string(),
            target: format!("{}.md", slug),
            slug: slug.to_string(),
            hook: truncate_hook(hook),
        }));
    }

    /// Remove every entry referencing `slug`; returns count removed.
    pub fn remove_slug(&mut self, slug: &str) -> usize {
        let target = format!("{}.md", slug);
        let before = self.lines.len();
        self.lines.retain(|l| !matches!(l, Line::Entry(e) if e.target == target));
        before - self.lines.len()
    }

    /// Rewrite the entry for `slug` with a new title/hook (when present).
    /// Returns true when an entry was updated.
    pub fn update_entry(&mut self, slug: &str, title: &str, hook: &str) -> bool {
        let target = format!("{}.md", slug);
        for l in &mut self.lines {
            if let Line::Entry(e) = l {
                if e.target == target {
                    e.title = title.to_string();
                    e.hook = truncate_hook(hook);
                    return true;
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "# Memory Index\n\n## Active\n- [Alpha](alpha-memory.md) — first\n- [Beta](beta-feedback.md)\n\n## Ref\n- [Gamma](gamma-reference.md) — pointer\n";

    #[test]
    fn parse_and_roundtrip() {
        let idx = IndexFile::parse(SAMPLE);
        assert_eq!(idx.to_string(), SAMPLE);
        assert!(idx.is_indexed("alpha-memory"));
        assert!(idx.is_indexed("beta-feedback"));
        assert!(!idx.is_indexed("nope"));
        assert_eq!(idx.hook_for("alpha-memory").as_deref(), Some("first"));
        assert_eq!(idx.hook_for("beta-feedback").as_deref(), Some(""));
        assert_eq!(idx.hook_for("nope"), None);
    }

    #[test]
    fn tolerant_separator_and_blank_hook() {
        let idx = IndexFile::parse("- [A](a.md) - hyphen sep\n- [B](b.md)\n");
        assert_eq!(idx.hook_for("a").as_deref(), Some("hyphen sep"));
        assert_eq!(idx.hook_for("b").as_deref(), Some(""));
    }

    #[test]
    fn non_entries_preserved() {
        let idx = IndexFile::parse(SAMPLE);
        let verbatim = idx.lines.iter().filter(|l| matches!(l, Line::Verbatim(_))).count();
        assert_eq!(verbatim, 5); // header, blank, "## Active", blank, "## Ref"
    }

    #[test]
    fn remove_and_update() {
        let mut idx = IndexFile::parse(SAMPLE);
        assert_eq!(idx.remove_slug("beta-feedback"), 1);
        assert_eq!(idx.remove_slug("beta-feedback"), 0);
        assert!(idx.update_entry("alpha-memory", "Renamed", "new hook"));
        assert!(!idx.update_entry("ghost", "x", "y"));
        assert!(idx.to_string().contains("- [Renamed](alpha-memory.md) — new hook"));
        assert!(!idx.to_string().contains("beta-feedback"));
        assert!(idx.to_string().contains("## Ref")); // sections kept
    }

    #[test]
    fn append_and_truncate() {
        let mut idx = IndexFile::parse("# Memory Index\n");
        idx.append("new-memory", "New Memory", "desc");
        assert!(idx.is_indexed("new-memory"));
        let long = "x".repeat(200);
        idx.append("long", "Long", &long);
        let out = idx.to_string();
        assert!(out.lines().all(|l| l.chars().count() <= 145));
        assert!(out.contains('…'));
    }
}
