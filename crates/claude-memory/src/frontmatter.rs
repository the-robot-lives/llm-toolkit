//! Line-based frontmatter parser/serializer.
//!
//! Structure: `---` fence, flat `key: value` entries, at most one nested
//! `metadata:` map with two-space-indented children, blank and unparseable
//! lines preserved verbatim and in order on rewrite.

/// One ordered entry inside the frontmatter fence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    /// `key: value` — `raw` is the value exactly as written (quotes kept),
    /// `value` is the unquoted form.
    Flat { key: String, raw: String, value: String },
    /// `metadata:` followed by two-space-indented `child: value` lines
    /// (raw + unquoted, same rules as flat entries).
    Metadata { children: Vec<(String, String, String)> },
    /// Blank or unparseable line, preserved verbatim.
    Verbatim(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Frontmatter {
    pub entries: Vec<Entry>,
}

/// Strip one layer of double quotes and unescape `\"`.
pub fn unquote(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        v[1..v.len() - 1].replace("\\\"", "\"")
    } else {
        v.to_string()
    }
}

/// Quote a value when needed (contains a double quote, colon+space, or is
/// empty); escape inner double quotes.
pub fn quote(value: &str) -> String {
    if value.is_empty()
        || value.contains('"')
        || value.contains(": ")
        || value.starts_with('[')
        || value.starts_with('{')
    {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

/// Split `key: value` (first colon). Returns (key, raw value as written,
/// unquoted value). None when no colon or empty key.
fn split_kv(line: &str) -> Option<(String, String, String)> {
    let idx = line.find(':')?;
    let key = line[..idx].trim().to_string();
    if key.is_empty() {
        return None;
    }
    let raw = line[idx + 1..].trim().to_string();
    let value = unquote(&raw);
    Some((key, raw, value))
}

/// Offset of the closing `---` fence, scanning at most `inner_len + 1` lines
/// from `start`. None when unclosed.
fn find_closing_offset(raw: &str, start: usize, inner_len: usize) -> Option<usize> {
    let mut idx = start;
    for _ in 0..=inner_len {
        let line_end = raw[idx..]
            .find('\n')
            .map(|p| idx + p)
            .unwrap_or(raw.len());
        if raw[idx..line_end].trim_end() == "---" {
            return Some(idx);
        }
        idx = line_end + 1;
    }
    None
}

/// Text after the closing fence at `off`, with the fence's terminating
/// newline plus any further leading blank lines stripped.
fn rest_after_offset(raw: &str, off: usize) -> String {
    let mut after = &raw[off + 3..];
    if after.starts_with('\r') {
        after = &after[1..];
    }
    if after.starts_with('\n') {
        after = &after[1..];
    }
    // Strip one blank separator line (i.e. the fence's newline + "\n").
    if after.starts_with('\n') {
        after = &after[1..];
    }
    after.to_string()
}

/// Convenience: split raw text into (inner_len, closing offset) after the
/// opening fence line at byte 0.
fn rest_after_closing(raw: &str, inner_len: usize) -> String {
    let bytes = raw.as_bytes();
    let mut idx = 3; // "---"
    if bytes.get(idx) == Some(&b'\r') {
        idx += 1;
    }
    idx += 1; // '\n'
    match find_closing_offset(raw, idx, inner_len) {
        Some(off) => rest_after_offset(raw, off),
        None => String::new(),
    }
}

impl Frontmatter {
    /// Parse the inner frontmatter text (between the fences, no fences).
    pub fn parse(inner: &str) -> Frontmatter {
        let mut entries: Vec<Entry> = Vec::new();
        let mut lines = inner.lines().peekable();
        while let Some(line) = lines.next() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                entries.push(Entry::Verbatim(line.to_string()));
                continue;
            }
            if trimmed == "metadata:" {
                // Consume following two-space-indented children.
                let mut children: Vec<(String, String, String)> = Vec::new();
                while let Some(child) = lines.peek() {
                    let c: &str = child;
                    if c.starts_with("  ") && c.trim() != "---" {
                        if let Some((k, r, v)) = split_kv(c.trim()) {
                            children.push((k, r, v));
                            lines.next();
                            continue;
                        }
                    }
                    break;
                }
                entries.push(Entry::Metadata { children });
                continue;
            }
            match split_kv(line) {
                Some((key, raw, value)) => entries.push(Entry::Flat { key, raw, value }),
                None => entries.push(Entry::Verbatim(line.to_string())),
            }
        }
        Frontmatter { entries }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        match key {
            "metadata" => None,
            k => self.entries.iter().find_map(|e| match e {
                Entry::Flat { key: ek, value, .. } if ek == k => Some(value.as_str()),
                _ => None,
            }),
        }
    }

    pub fn metadata_child(&self, key: &str) -> Option<&str> {
        self.entries.iter().find_map(|e| match e {
            Entry::Metadata { children } => children
                .iter()
                .find(|(k, _, _)| k == key)
                .map(|(_, _, v)| v.as_str()),
            _ => None,
        })
    }

    /// Set a flat key (insert after the last existing flat entry that is not
    /// metadata, else at position 0; update in place when present).
    pub fn set_flat(&mut self, key: &str, value: &str) {
        let raw = quote(value);
        for e in &mut self.entries {
            if let Entry::Flat { key: k, raw: r, value: v } = e {
                if k == key {
                    *r = raw.clone();
                    *v = value.to_string();
                    return;
                }
            }
        }
        let mut insert_at = 0usize;
        for (i, e) in self.entries.iter().enumerate() {
            match e {
                Entry::Flat { .. } | Entry::Verbatim(_) => insert_at = i + 1,
                Entry::Metadata { .. } => break,
            }
        }
        self.entries.insert(
            insert_at,
            Entry::Flat {
                key: key.to_string(),
                raw,
                value: value.to_string(),
            },
        );
    }

    /// Set a metadata child (create the metadata map after the flat entries
    /// when absent; update in place when present).
    pub fn set_metadata_child(&mut self, key: &str, value: &str) {
        let raw = quote(value);
        for e in &mut self.entries {
            if let Entry::Metadata { children } = e {
                for (k, r, v) in children.iter_mut() {
                    if k == key {
                        *r = raw.clone();
                        *v = value.to_string();
                        return;
                    }
                }
                children.push((key.to_string(), raw, value.to_string()));
                return;
            }
        }
        let mut insert_at = 0usize;
        for (i, e) in self.entries.iter().enumerate() {
            if let Entry::Flat { .. } = e {
                insert_at = i + 1;
            }
        }
        self.entries.insert(
            insert_at,
            Entry::Metadata {
                children: vec![(key.to_string(), raw, value.to_string())],
            },
        );
    }

    /// Serialize to inner frontmatter text (no fences), byte-faithful to the
    /// parsed source apart from inserted/updated fields.
    pub fn to_string(&self) -> String {
        let mut out = String::new();
        for e in &self.entries {
            match e {
                Entry::Flat { key, raw, .. } => {
                    out.push_str(&format!("{}: {}\n", key, raw));
                }
                Entry::Metadata { children } => {
                    out.push_str("metadata:\n");
                    for (k, raw, _) in children {
                        out.push_str(&format!("  {}: {}\n", k, raw));
                    }
                }
                Entry::Verbatim(line) => {
                    out.push_str(line);
                    out.push('\n');
                }
            }
        }
        // Drop the trailing newline; callers fence with surrounding newlines.
        if out.ends_with('\n') {
            out.pop();
        }
        out
    }
}

/// A parsed memory file: raw text split into optional frontmatter + body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryFile {
    pub frontmatter: Option<Frontmatter>,
    /// Inner frontmatter text without fences, or None.
    pub frontmatter_raw: Option<String>,
    /// Text after the closing fence (leading newline stripped), or full text
    /// when there is no frontmatter.
    pub body: String,
}

impl MemoryFile {
    /// Parse raw file text.
    pub fn parse(raw: &str) -> MemoryFile {
        let mut lines = raw.lines();
        let first = lines.next().map(|l| l.trim_end());
        if first != Some("---") {
            return MemoryFile {
                frontmatter: None,
                frontmatter_raw: None,
                body: raw.to_string(),
            };
        }
        let mut inner: Vec<&str> = Vec::new();
        for line in lines {
            if line.trim_end() == "---" {
                let frontmatter_raw = inner.join("\n");
                // Empty frontmatter counts as no frontmatter.
                if frontmatter_raw.trim().is_empty() {
                    let after = rest_after_closing(raw, inner.len());
                    return MemoryFile {
                        frontmatter: None,
                        frontmatter_raw: None,
                        body: after,
                    };
                }
                let frontmatter = Frontmatter::parse(&frontmatter_raw);
                // Text after the closing fence, leading blank line stripped.
                let body = rest_after_closing(raw, inner.len());
                return MemoryFile {
                    frontmatter: Some(frontmatter),
                    frontmatter_raw: Some(frontmatter_raw),
                    body,
                };
            }
            inner.push(line);
        }
        // No closing fence — treat whole file as body with no frontmatter.
        MemoryFile {
            frontmatter: None,
            frontmatter_raw: None,
            body: raw.to_string(),
        }
    }

    pub fn name(&self) -> Option<&str> {
        self.frontmatter.as_ref().and_then(|f| f.get("name"))
    }

    pub fn description(&self) -> Option<&str> {
        self.frontmatter.as_ref().and_then(|f| f.get("description"))
    }

    pub fn type_(&self) -> Option<&str> {
        self.frontmatter.as_ref().and_then(|f| f.metadata_child("type"))
    }

    pub fn modified(&self) -> Option<&str> {
        self.frontmatter
            .as_ref()
            .and_then(|f| f.metadata_child("modified"))
    }

    /// Serialize with fences: `---\n<inner>\n---\n\n<body>`.
    pub fn to_raw(&self) -> String {
        match &self.frontmatter {
            Some(fm) => format!("---\n{}\n---\n\n{}", fm.to_string(), self.body),
            None => self.body.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nname: alpha-memory\ndescription: \"First test memory\"\nmetadata:\n  type: project\n  modified: 2026-09-01T00:00:00.000Z\n---\n\nBody. [[wiki-links]] allowed.\n";

    #[test]
    fn parse_roundtrip() {
        let mf = MemoryFile::parse(SAMPLE);
        let fm = mf.frontmatter.as_ref().unwrap();
        assert_eq!(mf.name(), Some("alpha-memory"));
        assert_eq!(mf.description(), Some("First test memory"));
        assert_eq!(mf.type_(), Some("project"));
        assert_eq!(mf.modified(), Some("2026-09-01T00:00:00.000Z"));
        assert_eq!(mf.body, "Body. [[wiki-links]] allowed.\n");
        assert_eq!(fm.to_string(), "name: alpha-memory\ndescription: \"First test memory\"\nmetadata:\n  type: project\n  modified: 2026-09-01T00:00:00.000Z");
        // Byte-faithful round-trip (raw value bytes preserved).
        assert_eq!(mf.to_raw(), SAMPLE);
    }

    #[test]
    fn no_frontmatter() {
        let mf = MemoryFile::parse("just text\nmore\n");
        assert!(mf.frontmatter.is_none());
        assert_eq!(mf.body, "just text\nmore\n");
        assert_eq!(mf.to_raw(), "just text\nmore\n");
    }

    #[test]
    fn empty_frontmatter_is_none() {
        let mf = MemoryFile::parse("---\n---\n\nbody\n");
        // Fences with nothing between count as absent/empty frontmatter.
        assert!(mf.frontmatter.is_none());
        assert_eq!(mf.body, "body\n");
    }

    #[test]
    fn unknown_lines_preserved() {
        let raw = "---\nname: x\ncustom-flat: keep me\n\nmetadata:\n  type: t\n  mystery: 42\n---\n\nbody\n";
        let mf = MemoryFile::parse(raw);
        assert_eq!(mf.to_raw(), raw);
    }

    #[test]
    fn set_fields_and_bump() {
        let mut mf = MemoryFile::parse(SAMPLE);
        let fm = mf.frontmatter.as_mut().unwrap();
        fm.set_flat("name", "renamed");
        fm.set_metadata_child("type", "user");
        fm.set_metadata_child("modified", "2026-09-16T00:00:00.000Z");
        fm.set_metadata_child("newchild", "v");
        assert_eq!(mf.name(), Some("renamed"));
        assert_eq!(mf.type_(), Some("user"));
        assert_eq!(mf.modified(), Some("2026-09-16T00:00:00.000Z"));
        let fm = mf.frontmatter.as_ref().unwrap();
        assert_eq!(fm.to_string(), "name: renamed\ndescription: \"First test memory\"\nmetadata:\n  type: user\n  modified: 2026-09-16T00:00:00.000Z\n  newchild: v");
    }

    #[test]
    fn set_flat_on_empty_frontmatter() {
        let mut fm = Frontmatter::default();
        fm.set_flat("name", "n");
        fm.set_metadata_child("type", "t");
        assert_eq!(fm.to_string(), "name: n\nmetadata:\n  type: t");
    }
}
