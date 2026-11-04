//! Core types for the goto_index crate.

use std::sync::Arc;

mod file_event;
mod location;
mod range;

pub use file_event::FileEvent;
pub use location::Location;
pub use range::{Position, Range};

/// Statistics about an index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexStats {
    /// Number of files indexed
    pub files: usize,
    /// Number of symbol definitions
    pub definitions: usize,
    /// Number of symbol references
    pub references: usize,
}

impl IndexStats {
    /// Create new index stats.
    pub fn new(files: usize, definitions: usize, references: usize) -> Self {
        Self {
            files,
            definitions,
            references,
        }
    }
}

/// What an index actually covers.
///
/// A search that finds nothing is ambiguous: the symbol may not exist, or the
/// file that defines it may be outside what the index can read. This type is
/// the second half of that answer — the languages the index parses and how much
/// it has parsed — so a caller can say "not in the index" instead of "does not
/// exist".
///
/// Deliberately reports only what is known. Files skipped for being binary,
/// empty, larger than [`crate::MAX_INDEXABLE_FILE_SIZE`], or written in an
/// unlisted language are *not* counted anywhere, so the absence of a language
/// from [`Self::languages`] is the honest signal that its files are invisible
/// to search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexCoverage {
    /// Files currently indexed.
    pub files: usize,
    /// Symbol definitions currently indexed.
    pub definitions: usize,
    /// Symbol references currently indexed.
    pub references: usize,
    /// Language ids the index can parse, sorted (`go`, `javascript`, …).
    pub languages: Vec<String>,
}

impl IndexCoverage {
    /// Build from stats plus the registry's language ids.
    pub fn new(stats: IndexStats, mut languages: Vec<String>) -> Self {
        languages.sort();
        languages.dedup();
        Self {
            files: stats.files,
            definitions: stats.definitions,
            references: stats.references,
            languages,
        }
    }
}

/// A symbol with its line number (1-indexed).
/// Uses Arc<str> to avoid extra allocation when merging into index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolOccurrence {
    /// The symbol name
    pub name: Arc<str>,
    /// Line number (1-indexed)
    pub line: usize,
}

impl SymbolOccurrence {
    /// Create a new symbol occurrence.
    pub fn new(name: Arc<str>, line: usize) -> Self {
        Self { name, line }
    }
}

/// An alias mapping (alias_name -> original_name).
/// Uses Arc<str> to avoid extra allocation when merging into index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolAlias {
    /// The alias name (e.g., imported as)
    pub alias: Arc<str>,
    /// The original symbol name
    pub original: Arc<str>,
}

impl SymbolAlias {
    /// Create a new symbol alias.
    pub fn new(alias: Arc<str>, original: Arc<str>) -> Self {
        Self { alias, original }
    }
}

/// File metadata for staleness detection.
///
/// Stores size and modification time to quickly detect if a file has changed
/// without reading its contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FileMeta {
    /// File size in bytes
    pub size: u64,
    /// Modification time as seconds since UNIX epoch
    pub mtime_secs: i64,
    /// Modification time nanoseconds component
    pub mtime_nanos: u32,
}

impl FileMeta {
    /// Create new file metadata.
    pub fn new(size: u64, mtime_secs: i64, mtime_nanos: u32) -> Self {
        Self {
            size,
            mtime_secs,
            mtime_nanos,
        }
    }

    /// Create file metadata from std::fs::Metadata.
    pub fn from_metadata(meta: &std::fs::Metadata) -> Self {
        let size = meta.len();
        let (mtime_secs, mtime_nanos) = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| (d.as_secs() as i64, d.subsec_nanos()))
            .unwrap_or((0, 0));
        Self {
            size,
            mtime_secs,
            mtime_nanos,
        }
    }

    /// Check if the file has changed compared to current filesystem state.
    pub fn is_stale(&self, path: &std::path::Path) -> bool {
        match std::fs::metadata(path) {
            Ok(meta) => {
                let current = Self::from_metadata(&meta);
                *self != current
            }
            // File deleted or inaccessible
            Err(_) => true,
        }
    }
}
