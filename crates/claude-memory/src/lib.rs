//! Dependency-free (std-only) reader/writer for Claude Code project memory
//! dirs. Implements `docs/claude-memory-contract.md` — this crate is the
//! normative implementation; the Swift port must stay behavior-identical.

pub mod error;
pub mod frontmatter;
pub mod golden;
pub mod index;
pub mod ops;
pub mod time;

pub use error::{Error, Result};
pub use frontmatter::Frontmatter;
pub use index::IndexFile;
