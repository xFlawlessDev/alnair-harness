//! Ranking for located symbol hits.
//!
//! Discovery — *which* symbols match a query — is ranked in [`crate::search`],
//! where two genuinely competing signals (name tightness and usage frequency)
//! are fused with reciprocal-rank fusion. This module answers a narrower
//! question: the symbol is already known, so which of its occurrences should be
//! shown first? `assert` has tens of thousands of reference sites in a
//! workspace of this size.
//!
//! ## Ordered keys, deliberately not fusion
//!
//! The signals here are hierarchical, not competing:
//!
//! 1. **Kind.** A declaration answers "where is this?"; a call site does not.
//! 2. **Penalty.** A test or vendored file is a legitimate hit but rarely what
//!    the caller meant.
//! 3. **Proximity.** The file being edited, then its directory.
//! 4. **Depth.** `src/lib.rs` is more likely the public surface than a deeply
//!    nested implementation file.
//!
//! A caller who asked "where is this defined" wants the first definition in
//! source, full stop; averaging the signals would let a shallow vendored call
//! site outvote it. Fusion earns its keep when the inputs are noisy and
//! incomparable — as in symbol discovery — not when one key strictly dominates.
//!
//! Every comparator ends in `(path, line)` so the order is total and stable:
//! the input comes from hash maps, whose iteration order is not.

use std::path::Path;

/// One located occurrence, before ranking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RankedHit {
    /// Path relative to the index root.
    pub path: String,
    /// 1-indexed line.
    pub line: usize,
    /// The symbol at this site.
    pub symbol: String,
    /// Whether the site declares the symbol or uses it.
    pub is_definition: bool,
}

/// How to rank a hit list.
#[derive(Debug, Clone, Default)]
pub struct RankOptions<'a> {
    /// Relative path of the file the caller is working in, if known. Hits in
    /// this file, then in its directory, are promoted.
    pub context_path: Option<&'a str>,
}

/// Rank `hits` and keep the best `limit`.
///
/// Returns the kept hits and whether any were dropped. A `limit` of 0 keeps
/// nothing and reports truncation, which is safer than treating it as "no
/// limit" and returning the whole workspace.
pub fn rank_hits(
    hits: Vec<RankedHit>,
    limit: usize,
    options: &RankOptions<'_>,
) -> (Vec<RankedHit>, bool) {
    if hits.is_empty() {
        return (Vec::new(), false);
    }
    if limit == 0 {
        return (Vec::new(), true);
    }

    let mut ranked = hits;
    ranked.sort_by(|a, b| {
        b.is_definition
            .cmp(&a.is_definition)
            .then_with(|| penalty_tier(&a.path).cmp(&penalty_tier(&b.path)))
            .then_with(|| {
                proximity_tier(a, options.context_path)
                    .cmp(&proximity_tier(b, options.context_path))
            })
            .then_with(|| path_depth(&a.path).cmp(&path_depth(&b.path)))
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.line.cmp(&b.line))
    });

    let truncated = ranked.len() > limit;
    ranked.truncate(limit);
    (ranked, truncated)
}

/// How close a hit is to the caller's own file. Lower is closer.
fn proximity_tier(hit: &RankedHit, context_path: Option<&str>) -> u8 {
    let Some(context) = context_path else {
        return 2;
    };
    if normalize_separators(context) == hit.path {
        return 0;
    }
    let context_dir = Path::new(context)
        .parent()
        .map(|dir| normalize_separators(&dir.to_string_lossy()));
    if let Some(dir) = context_dir
        && !dir.is_empty()
        && Path::new(&hit.path)
            .parent()
            .map(|parent| normalize_separators(&parent.to_string_lossy()))
            .as_deref()
            == Some(dir.as_str())
    {
        return 1;
    }
    2
}

/// How much a path looks like something other than first-party source.
///
/// Test and vendored trees are legitimate search results but are rarely what a
/// caller means, so they sort behind source. The tiers are ordered, so a test
/// file inside a vendored tree ranks last of all.
fn penalty_tier(path: &str) -> u8 {
    let lower = normalize_separators(path).to_lowercase();
    let vendored = has_segment(&lower, "vendor")
        || has_segment(&lower, "node_modules")
        || has_segment(&lower, "third_party")
        || has_segment(&lower, "target");
    let test = has_segment(&lower, "tests")
        || has_segment(&lower, "test")
        || lower.contains("_test.")
        || lower.contains(".test.")
        || lower.contains("_tests.")
        || lower.contains(".spec.");

    match (vendored, test) {
        (true, _) => 2,
        (false, true) => 1,
        (false, false) => 0,
    }
}

/// Whether `path` has `segment` as a whole path component.
///
/// A plain `contains` would classify `crates/attestation/src/lib.rs` as a test
/// file because it happens to contain the letters "test".
fn has_segment(path: &str, segment: &str) -> bool {
    path.split('/').any(|component| component == segment)
}

fn path_depth(path: &str) -> usize {
    path.matches(['/', '\\']).count()
}

fn normalize_separators(path: &str) -> String {
    path.replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(path: &str, line: usize, is_definition: bool) -> RankedHit {
        RankedHit {
            path: path.to_string(),
            line,
            symbol: "sym".to_string(),
            is_definition,
        }
    }

    fn paths(hits: &[RankedHit]) -> Vec<&str> {
        hits.iter().map(|h| h.path.as_str()).collect()
    }

    #[test]
    fn definitions_outrank_references_regardless_of_proximity() {
        let hits = vec![
            hit("src/mine.rs", 10, false),
            hit("crates/far/away/deep.rs", 99, true),
        ];
        let (ranked, _) = rank_hits(hits, 10, &RankOptions::default());
        assert!(ranked[0].is_definition, "the declaration must come first");
    }

    #[test]
    fn a_hit_in_the_context_file_comes_first() {
        let hits = vec![
            hit("crates/other/src/lib.rs", 5, true),
            hit("crates/mine/src/lib.rs", 7, true),
        ];
        let options = RankOptions {
            context_path: Some("crates/mine/src/lib.rs"),
        };
        let (ranked, _) = rank_hits(hits, 10, &options);
        assert_eq!(ranked[0].path, "crates/mine/src/lib.rs");
    }

    #[test]
    fn a_hit_in_the_context_directory_comes_before_an_unrelated_one() {
        let hits = vec![
            hit("crates/other/src/lib.rs", 5, true),
            hit("crates/mine/src/other.rs", 7, true),
        ];
        let options = RankOptions {
            context_path: Some("crates/mine/src/lib.rs"),
        };
        let (ranked, _) = rank_hits(hits, 10, &options);
        assert_eq!(ranked[0].path, "crates/mine/src/other.rs");
    }

    #[test]
    fn shallow_paths_beat_deep_ones_when_proximity_ties() {
        let hits = vec![
            hit("crates/a/src/impl/detail/inner.rs", 5, true),
            hit("crates/a/src/lib.rs", 9, true),
        ];
        let (ranked, _) = rank_hits(hits, 10, &RankOptions::default());
        assert_eq!(ranked[0].path, "crates/a/src/lib.rs");
    }

    #[test]
    fn test_files_sort_behind_source() {
        let hits = vec![
            hit("crates/a/tests/it.rs", 5, true),
            hit("crates/a/src/lib.rs", 9, true),
        ];
        let (ranked, _) = rank_hits(hits, 10, &RankOptions::default());
        assert_eq!(ranked[0].path, "crates/a/src/lib.rs");
    }

    /// A vendored file is *shallower* than the test file here, so only the
    /// penalty tier can keep it behind — which is exactly the guarantee.
    #[test]
    fn vendored_files_sort_behind_test_files() {
        let hits = vec![
            hit("third_party/lib/x.rs", 1, true),
            hit("crates/a/tests/it.rs", 2, true),
            hit("crates/a/src/lib.rs", 3, true),
        ];
        let (ranked, _) = rank_hits(hits, 10, &RankOptions::default());
        assert_eq!(
            paths(&ranked),
            vec![
                "crates/a/src/lib.rs",
                "crates/a/tests/it.rs",
                "third_party/lib/x.rs"
            ]
        );
    }

    /// `contains("test")` would flag this as a test tree; the segment match must
    /// not.
    #[test]
    fn a_path_that_merely_contains_the_letters_test_is_not_penalised() {
        assert_eq!(penalty_tier("crates/attestation/src/lib.rs"), 0);
        assert_eq!(penalty_tier("crates/latest/src/lib.rs"), 0);
    }

    #[test]
    fn truncation_is_reported() {
        let hits: Vec<_> = (0..30).map(|i| hit("src/lib.rs", i + 1, true)).collect();
        let (ranked, truncated) = rank_hits(hits, 10, &RankOptions::default());
        assert_eq!(ranked.len(), 10);
        assert!(truncated);
    }

    #[test]
    fn a_complete_answer_is_not_reported_as_truncated() {
        let hits = vec![hit("src/lib.rs", 1, true)];
        let (ranked, truncated) = rank_hits(hits, 10, &RankOptions::default());
        assert_eq!(ranked.len(), 1);
        assert!(!truncated);
    }

    #[test]
    fn an_empty_input_is_not_truncated() {
        let (ranked, truncated) = rank_hits(Vec::new(), 10, &RankOptions::default());
        assert!(ranked.is_empty());
        assert!(!truncated, "nothing was dropped, so nothing is missing");
    }

    #[test]
    fn a_zero_limit_drops_everything_and_says_so() {
        let hits = vec![hit("src/lib.rs", 1, true)];
        let (ranked, truncated) = rank_hits(hits, 0, &RankOptions::default());
        assert!(ranked.is_empty());
        assert!(truncated);
    }

    #[test]
    fn ordering_is_stable_across_runs() {
        // Two identical inputs must produce identical output; the sort keys all
        // end in (path, line) so no HashMap iteration order can leak through.
        let hits: Vec<_> = (0..20)
            .map(|i| hit(&format!("src/f{i:02}.rs"), i + 1, i % 3 == 0))
            .collect();
        let (first, _) = rank_hits(hits.clone(), 20, &RankOptions::default());
        let (second, _) = rank_hits(hits, 20, &RankOptions::default());
        assert_eq!(first, second);
    }

    #[test]
    fn windows_and_unix_separators_are_treated_alike() {
        assert_eq!(penalty_tier("crates\\a\\tests\\it.rs"), 1);
        assert_eq!(penalty_tier("crates/a/tests/it.rs"), 1);
    }
}
