//! `extern "C"` function declarations must be indexable definitions.
//!
//! The retrieval benchmark surfaced this as its only true false negative:
//! `CFPreferencesAppValueIsForced` is declared in an `extern` block, exists in
//! the source, and the tool answered "no such symbol". Call sites resolve to
//! these declarations, so a missing entry is a wrong answer, not a gap.
//!
//! The regression guard is deliberately end-to-end: it builds a real index over
//! a temp repo rather than asserting on a query string, because the failure was
//! in the query and a query-shaped test would have to duplicate it.

use alnair_codebase_graph::{IndexBuilder, ScopeGraphIndex};
use tempfile::tempdir;

fn index_over(files: &[(&str, &str)]) -> ScopeGraphIndex {
    let dir = tempdir().unwrap();
    for (name, content) in files {
        std::fs::write(dir.path().join(name), content).unwrap();
    }
    IndexBuilder::new().build(dir.path()).unwrap()
}

/// The exact shape the benchmark missed.
#[test]
fn an_extern_fn_declaration_is_a_definition() {
    let index = index_over(&[(
        "ffi.rs",
        r#"
extern "C" {
    fn CFPreferencesAppValueIsForced(key: *const u8, app: *const u8) -> bool;
    fn runtime_variable() -> i32;
}
"#,
    )]);

    for name in ["CFPreferencesAppValueIsForced", "runtime_variable"] {
        assert!(
            index.has_definition(name),
            "{name} is declared in an extern block and must be findable"
        );
    }
}

/// A block with a link name (`extern "C" { ... }`) and a bare `extern { ... }`
/// both use `foreign_mod_item`; both must work.
#[test]
fn an_extern_block_without_abi_string_still_indexes() {
    let index = index_over(&[("ffi.rs", "extern {\n    fn legacy_symbol() -> u8;\n}\n")]);
    assert!(index.has_definition("legacy_symbol"));
}

/// Adding the rule must not swallow ordinary functions, nor index an extern
/// block's absence of a name.
#[test]
fn ordinary_functions_are_still_indexed_and_nothing_extra_appears() {
    let index = index_over(&[(
        "lib.rs",
        "pub fn ours() {}\nextern \"C\" {\n    fn theirs();\n}\n",
    )]);
    assert!(index.has_definition("ours"));
    assert!(index.has_definition("theirs"));
    // The block itself and the ABI string are not symbols.
    assert!(!index.has_definition("C"));
    assert!(!index.has_definition("extern"));
}
