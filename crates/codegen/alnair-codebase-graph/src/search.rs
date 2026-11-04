//! Symbol search and ranking over an indexed [`ScopeGraphIndex`].
//!
//! The index answers *exact* name lookups (`find_definitions`). This module adds
//! the fuzzy front door a model needs when it does not already know the exact
//! identifier. Two problems have to be solved together:
//!
//! 1. **Discovery.** `assert` must also reach `assert_eq`, `debug_assert` and
//!    `assertion`, or the caller concludes the symbol does not exist.
//! 2. **Ranking.** A bare substring scan of this workspace matches tens of
//!    thousands of rows for a query like `assert`. An unranked answer is worse
//!    than no answer: it is confidently useless and costs a context window.
//!
//! ## Ranking is two-tier on purpose
//!
//! Match quality is the *primary* key. When a caller types an exact identifier
//! they mean it, so an exact match on a rarely-used symbol must not be buried
//! under a hot substring match. Usage frequency only orders candidates
//! *within* a tier.
//!
//! Within a tier the score is reciprocal-rank fusion (RRF) over two ranked
//! lists — name tightness and usage — which is the standard way to combine
//! signals that are not on a comparable scale. A symbol that is both tightly
//! matched and widely used therefore wins, and neither signal can dominate
//! purely by having a larger numeric range.
//!
//! Both properties are pinned by tests at the bottom of this module.

use crate::scope_graph::ScopeGraphIndex;

/// Results returned when the caller does not ask for a specific count.
pub const DEFAULT_SEARCH_LIMIT: usize = 20;

/// Hard ceiling on results per query, whatever the caller asks for.
///
/// The point of this module is to keep a search answer-sized; a caller that
/// wants more than this should narrow the query instead.
pub const MAX_SEARCH_LIMIT: usize = 100;

/// Sites reported per symbol when the caller does not ask for a count.
pub const DEFAULT_SITES_PER_SYMBOL: usize = 4;

/// RRF damping constant — the de-facto default from the original TREC work.
///
/// A larger constant flattens the head of each list, which matters here because
/// the usage list can be extremely top-heavy: one hot helper with 30k call sites
/// would otherwise swamp every name-tightness signal.
const RRF_K: f64 = 60.0;

/// How a symbol name matched the query.
///
/// Ordered worst-to-best, so a plain comparison sorts the strongest match
/// first. That ordering is load-bearing: [`rank`] uses it as the primary key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MatchKind {
    /// The query appears somewhere inside the name.
    Substring,
    /// The name starts with the query.
    Prefix,
    /// The name is the query.
    Exact,
}

impl MatchKind {
    /// Short wire spelling used in tool output.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Substring => "substring",
            Self::Prefix => "prefix",
            Self::Exact => "exact",
        }
    }
}

/// One located occurrence of a symbol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolSite {
    /// Path relative to the index root.
    pub path: String,
    /// 1-indexed line number.
    pub line: usize,
    /// Whether this site declares the symbol or uses it.
    pub is_definition: bool,
}

/// A ranked symbol match.
#[derive(Debug, Clone, PartialEq)]
pub struct SymbolMatch {
    /// The symbol name as it appears in source.
    pub name: String,
    /// How the name matched the query.
    pub kind: MatchKind,
    /// Total number of declaration sites.
    pub definition_count: usize,
    /// Total number of reference sites.
    pub reference_count: usize,
    /// Fused rank score. Higher is better; only comparable within one query.
    pub score: f64,
    /// The sites to show, best-first: declarations before uses, shallow paths
    /// before deep ones.
    pub sites: Vec<SymbolSite>,
    /// True when [`Self::sites`] holds fewer entries than the symbol has.
    pub sites_truncated: bool,
}

/// Parameters for [`ScopeGraphIndex::search_symbols`].
#[derive(Debug, Clone)]
pub struct SymbolQuery {
    /// The name fragment to look for. Matched case-insensitively.
    pub text: String,
    /// Maximum symbols returned. Clamped to `1..=`[`MAX_SEARCH_LIMIT`].
    pub limit: usize,
    /// When set, only symbols with a site under this relative path prefix are
    /// returned.
    ///
    /// Applied *before* ranking, not as a post-filter: a filter applied after
    /// truncation would spend the whole result budget on symbols that are about
    /// to be thrown away.
    pub path_prefix: Option<String>,
    /// Also collect use sites, not only declarations.
    pub include_references: bool,
    /// Sites collected per symbol.
    pub sites_per_symbol: usize,
}

impl SymbolQuery {
    /// A query with the default result count, declarations only.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            limit: DEFAULT_SEARCH_LIMIT,
            path_prefix: None,
            include_references: false,
            sites_per_symbol: DEFAULT_SITES_PER_SYMBOL,
        }
    }

    pub fn with_limit(mut self, limit: usize) -> Self {
        self.limit = limit;
        self
    }

    pub fn with_path_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.path_prefix = Some(prefix.into());
        self
    }

    pub fn with_references(mut self, include: bool) -> Self {
        self.include_references = include;
        self
    }

    pub fn with_sites_per_symbol(mut self, sites: usize) -> Self {
        self.sites_per_symbol = sites;
        self
    }

    /// The effective result cap: never zero, never above [`MAX_SEARCH_LIMIT`].
    fn effective_limit(&self) -> usize {
        self.limit.clamp(1, MAX_SEARCH_LIMIT)
    }

    /// The effective per-symbol site cap: at least one, so every returned
    /// symbol points somewhere.
    fn effective_sites(&self) -> usize {
        self.sites_per_symbol.max(1)
    }
}

/// The outcome of one [`ScopeGraphIndex::search_symbols`] call.
#[derive(Debug, Clone, PartialEq)]
pub struct SymbolSearch {
    /// Ranked matches, best first, at most the query's limit.
    pub matches: Vec<SymbolMatch>,
    /// Symbols that matched before the limit was applied.
    pub matched_symbols: usize,
    /// Sites across every matched symbol, before the per-symbol cap.
    pub total_sites: usize,
}

impl SymbolSearch {
    /// Whether the answer is incomplete: symbols or sites were dropped.
    pub fn is_truncated(&self) -> bool {
        self.matched_symbols > self.matches.len() || self.matches.iter().any(|m| m.sites_truncated)
    }
}

impl ScopeGraphIndex {
    /// Find symbols whose name matches `query.text`, best match first.
    ///
    /// Unlike [`ScopeGraphIndex::find_definitions`] this is not an exact
    /// lookup: it scans the definition key set and classifies each name as an
    /// exact, prefix or substring match, then ranks within those tiers.
    ///
    /// Returns an empty result for an empty or whitespace-only query — an empty
    /// needle would otherwise match every symbol in the repository.
    pub fn search_symbols(&self, query: &SymbolQuery) -> SymbolSearch {
        let needle = query.text.trim();
        if needle.is_empty() {
            return SymbolSearch {
                matches: Vec::new(),
                matched_symbols: 0,
                total_sites: 0,
            };
        }

        let prefix = query.path_prefix.as_deref();
        let mut candidates: Vec<Candidate<'_>> = Vec::new();
        let mut total_sites = 0usize;

        for (&symbol_id, definitions) in &self.definitions {
            let Some(name) = self.get_str(symbol_id) else {
                continue;
            };
            let Some(kind) = classify(name, needle) else {
                continue;
            };

            let collected = self.collect_sites(definitions, symbol_id, query, prefix);
            if collected.sites.is_empty() {
                // Every site was filtered out by `path_prefix`, or the symbol
                // has no definition at all. Reporting a symbol with no location
                // would be a dead end for the caller.
                continue;
            }

            total_sites += collected.available;
            candidates.push(Candidate {
                name,
                kind,
                definition_count: definitions.len(),
                reference_count: self.references.get(&symbol_id).map_or(0, Vec::len),
                sites: collected.sites,
                sites_truncated: collected.available > query.effective_sites(),
            });
        }

        let matched_symbols = candidates.len();
        let matches = rank(candidates, query.effective_limit());
        SymbolSearch {
            matches,
            matched_symbols,
            total_sites,
        }
    }

    /// Gather the sites for one symbol, capped and best-first.
    fn collect_sites(
        &self,
        definitions: &[(crate::StringId, u32)],
        symbol_id: crate::StringId,
        query: &SymbolQuery,
        prefix: Option<&str>,
    ) -> CollectedSites {
        let mut sites: Vec<SymbolSite> = Vec::new();

        for &(path_id, line) in definitions {
            if let Some(site) = self.site(path_id, line, true, prefix) {
                sites.push(site);
            }
        }
        if query.include_references
            && let Some(references) = self.references.get(&symbol_id)
        {
            for &(path_id, line) in references {
                if let Some(site) = self.site(path_id, line, false, prefix) {
                    sites.push(site);
                }
            }
        }

        // Declarations first, then shallow paths. This is the same rule the
        // tool layer applies, kept here so the cap drops the *least* useful
        // sites rather than whichever ones happened to come last.
        sites.sort_by(|a, b| {
            b.is_definition
                .cmp(&a.is_definition)
                .then_with(|| path_depth(&a.path).cmp(&path_depth(&b.path)))
                .then_with(|| a.path.cmp(&b.path))
                .then_with(|| a.line.cmp(&b.line))
        });

        let available = sites.len();
        sites.truncate(query.effective_sites());
        CollectedSites { sites, available }
    }

    fn site(
        &self,
        path_id: crate::StringId,
        line: u32,
        is_definition: bool,
        prefix: Option<&str>,
    ) -> Option<SymbolSite> {
        let stored = self.get_str(path_id)?;
        if let Some(prefix) = prefix
            && !matches_prefix(stored, prefix)
        {
            return None;
        }
        Some(SymbolSite {
            // Always forward slashes, whatever the host: the path is read by a
            // model and joined with a workspace root it already knows, and a
            // Windows `src\lib.rs` both reads badly and fails a caller's
            // `crates/foo/` prefix test on the next query.
            path: normalize_separators(stored),
            line: line as usize,
            is_definition,
        })
    }
}

/// Whether `path` is under `prefix`, tolerating either separator.
///
/// The index stores the host's separator, but a caller writes `/` — so a
/// byte-prefix test alone would match nothing on Windows. Comparing
/// component-by-component after normalization keeps both spellings usable
/// without changing the on-disk format.
fn matches_prefix(path: &str, prefix: &str) -> bool {
    if path.starts_with(prefix) {
        return true;
    }
    let normalized_path = normalize_separators(path);
    let normalized_prefix = normalize_separators(prefix);
    normalized_path.starts_with(&normalized_prefix)
}

fn normalize_separators(path: &str) -> String {
    path.replace('\\', "/")
}

/// Sites collected for one symbol, plus how many existed before the cap.
struct CollectedSites {
    sites: Vec<SymbolSite>,
    available: usize,
}

/// One candidate before ranking. Borrows the name to avoid a clone per symbol.
struct Candidate<'a> {
    name: &'a str,
    kind: MatchKind,
    definition_count: usize,
    reference_count: usize,
    sites: Vec<SymbolSite>,
    sites_truncated: bool,
}

/// Classify `name` against `needle`, or `None` when it does not contain it.
///
/// Exactness is judged case-insensitively, because a caller typing `readfile`
/// means the symbol `ReadFile` — reporting that as a mere prefix match would
/// rank it below an unrelated symbol that happens to be spelled identically.
fn classify(name: &str, needle: &str) -> Option<MatchKind> {
    if name.len() < needle.len() {
        // A shorter name can neither contain nor equal the needle.
        return None;
    }
    if equals_ignore_case(name, needle) {
        return Some(MatchKind::Exact);
    }
    if starts_with_ignore_case(name, needle) {
        return Some(MatchKind::Prefix);
    }
    if contains_ignore_case(name, needle) {
        return Some(MatchKind::Substring);
    }
    None
}

/// Case-insensitive equality that allocates only for non-ASCII input.
fn equals_ignore_case(a: &str, b: &str) -> bool {
    if a.is_ascii() && b.is_ascii() {
        return a.eq_ignore_ascii_case(b);
    }
    a.to_lowercase() == b.to_lowercase()
}

/// Case-insensitive `starts_with`.
///
/// The ASCII path avoids allocating; the fallback only runs for non-ASCII
/// needles, where a byte-length prefix may not land on a char boundary.
fn starts_with_ignore_case(haystack: &str, needle: &str) -> bool {
    haystack
        .get(..needle.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(needle))
        || haystack.to_lowercase().starts_with(&needle.to_lowercase())
}

/// Case-insensitive `contains`.
fn contains_ignore_case(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.is_ascii() && haystack.is_ascii() {
        let hay = haystack.as_bytes();
        let pin = needle.as_bytes();
        return hay
            .windows(pin.len())
            .any(|window| window.eq_ignore_ascii_case(pin));
    }
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// Rank candidates and truncate to `limit`.
///
/// Primary key is [`MatchKind`] (exact before prefix before substring); within
/// a tier the score is RRF over name tightness and usage frequency.
fn rank(candidates: Vec<Candidate<'_>>, limit: usize) -> Vec<SymbolMatch> {
    if candidates.is_empty() {
        return Vec::new();
    }

    // List 1 — name tightness. A shorter name that still contains the needle is
    // the tighter match: `read` is more likely the answer to "read" than
    // `read_file_from_disk`.
    let mut by_name: Vec<usize> = (0..candidates.len()).collect();
    by_name.sort_by(|&a, &b| {
        let (a, b) = (&candidates[a], &candidates[b]);
        a.name
            .len()
            .cmp(&b.name.len())
            .then_with(|| a.name.cmp(b.name))
    });

    // List 2 — usage frequency.
    let mut by_usage: Vec<usize> = (0..candidates.len()).collect();
    by_usage.sort_by(|&a, &b| {
        let (a, b) = (&candidates[a], &candidates[b]);
        b.reference_count
            .cmp(&a.reference_count)
            .then_with(|| a.name.cmp(b.name))
    });

    let mut name_rank = vec![0usize; candidates.len()];
    for (rank, &index) in by_name.iter().enumerate() {
        name_rank[index] = rank + 1;
    }
    let mut usage_rank = vec![0usize; candidates.len()];
    for (rank, &index) in by_usage.iter().enumerate() {
        usage_rank[index] = rank + 1;
    }

    let mut scored: Vec<(usize, f64)> = (0..candidates.len())
        .map(|index| (index, rrf(name_rank[index]) + rrf(usage_rank[index])))
        .collect();

    scored.sort_by(|(a_index, a_score), (b_index, b_score)| {
        let (a, b) = (&candidates[*a_index], &candidates[*b_index]);
        // Match kind first, then the fused score, then the name so the order is
        // stable across runs (the input comes from a hash map).
        b.kind
            .cmp(&a.kind)
            .then_with(|| b_score.total_cmp(a_score))
            .then_with(|| a.name.cmp(b.name))
    });
    scored.truncate(limit);

    scored
        .into_iter()
        .map(|(index, score)| {
            let candidate = &candidates[index];
            SymbolMatch {
                name: candidate.name.to_string(),
                kind: candidate.kind,
                definition_count: candidate.definition_count,
                reference_count: candidate.reference_count,
                score,
                sites: candidate.sites.clone(),
                sites_truncated: candidate.sites_truncated,
            }
        })
        .collect()
}

fn path_depth(path: &str) -> usize {
    path.matches(['/', '\\']).count()
}

/// Reciprocal-rank contribution of a 1-based rank.
///
/// Two lists (name tightness, usage frequency) are fused by summing this over
/// each candidate's position in both. Positions are comparable by construction,
/// which is the whole point: a raw reference count of 31,159 and a name-length
/// difference of 4 have no common scale.
fn rrf(rank: usize) -> f64 {
    1.0 / (RRF_K + rank as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One fixture row: `(symbol, [definition sites], reference count)`.
    type Entry<'a> = (&'a str, &'a [(&'a str, usize)], usize);

    /// Build an index with a fixed shape.
    fn index_with(entries: &[Entry<'_>]) -> ScopeGraphIndex {
        let mut index = ScopeGraphIndex::new();
        for (name, definitions, reference_count) in entries {
            for (path, line) in *definitions {
                index.add_definition(name, path, *line);
            }
            for i in 0..*reference_count {
                index.add_reference(name, "src/caller.rs", i + 1);
            }
        }
        index
    }

    fn names(matches: &[SymbolMatch]) -> Vec<&str> {
        matches.iter().map(|m| m.name.as_str()).collect()
    }

    fn search(index: &ScopeGraphIndex, query: SymbolQuery) -> Vec<SymbolMatch> {
        index.search_symbols(&query).matches
    }

    // Classification

    #[test]
    fn exact_prefix_and_substring_are_distinguished() {
        assert_eq!(classify("assert", "assert"), Some(MatchKind::Exact));
        assert_eq!(classify("assert_eq", "assert"), Some(MatchKind::Prefix));
        assert_eq!(classify("my_assert", "assert"), Some(MatchKind::Substring));
        assert_eq!(classify("unrelated", "assert"), None);
    }

    #[test]
    fn matching_is_case_insensitive() {
        assert_eq!(classify("ReadFile", "readfile"), Some(MatchKind::Exact));
        assert_eq!(classify("ReadFile", "read"), Some(MatchKind::Prefix));
        assert_eq!(classify("read_file", "FILE"), Some(MatchKind::Substring));
    }

    #[test]
    fn a_shorter_name_cannot_match() {
        assert_eq!(classify("as", "assert"), None);
    }

    #[test]
    fn non_ascii_names_still_match_case_insensitively() {
        // Lowercasing "Ä" yields "ä", which the ASCII fast path cannot do.
        assert_eq!(classify("Ärger", "ärger"), Some(MatchKind::Exact));
        assert_eq!(classify("Ärger", "ärg"), Some(MatchKind::Prefix));
    }

    // Discovery

    /// The whole point of the module: a partial name must find the family.
    #[test]
    fn a_partial_name_finds_the_whole_family() {
        let index = index_with(&[
            ("assert", &[("src/a.rs", 1)], 0),
            ("assert_eq", &[("src/b.rs", 2)], 0),
            ("debug_assert", &[("src/c.rs", 3)], 0),
            ("assertion", &[("src/d.rs", 4)], 0),
            ("unrelated", &[("src/e.rs", 5)], 0),
        ]);

        let found = search(&index, SymbolQuery::new("assert"));
        assert_eq!(
            names(&found),
            vec!["assert", "assert_eq", "assertion", "debug_assert"],
            "exact first, then prefixes by name, then substrings"
        );
        assert!(!names(&found).contains(&"unrelated"));
    }

    // Ranking

    /// An exact match must outrank a hot substring match. This is the case that
    /// makes a naive "sort by reference count" ranking unusable.
    #[test]
    fn an_exact_match_beats_a_much_hotter_substring_match() {
        let index = index_with(&[
            ("assert", &[("src/rare.rs", 1)], 0),
            ("debug_assert", &[("src/hot.rs", 2)], 10_000),
        ]);

        let found = search(&index, SymbolQuery::new("assert"));
        assert_eq!(found[0].name, "assert");
        assert_eq!(found[0].kind, MatchKind::Exact);
    }

    /// Within a tier, the more-used symbol wins.
    #[test]
    fn within_a_tier_usage_decides() {
        let index = index_with(&[
            ("read_file", &[("src/a.rs", 1)], 1),
            ("read_dir", &[("src/b.rs", 2)], 500),
        ]);

        let found = search(&index, SymbolQuery::new("read_"));
        assert_eq!(names(&found), vec!["read_dir", "read_file"]);
    }

    /// A tighter name beats a longer one when usage is equal.
    #[test]
    fn within_a_tier_a_tighter_name_wins_at_equal_usage() {
        let index = index_with(&[
            ("read", &[("src/a.rs", 1)], 7),
            ("read_file_from_disk", &[("src/b.rs", 2)], 7),
        ]);

        let found = search(&index, SymbolQuery::new("read"));
        assert_eq!(names(&found), vec!["read", "read_file_from_disk"]);
    }

    #[test]
    fn an_empty_query_returns_nothing() {
        let index = index_with(&[("anything", &[("src/a.rs", 1)], 0)]);
        assert!(search(&index, SymbolQuery::new("   ")).is_empty());
    }

    #[test]
    fn the_limit_is_clamped_to_the_ceiling() {
        assert_eq!(
            SymbolQuery::new("x")
                .with_limit(usize::MAX)
                .effective_limit(),
            MAX_SEARCH_LIMIT
        );
        assert_eq!(
            SymbolQuery::new("x").with_limit(0).effective_limit(),
            1,
            "zero must not mean 'no limit'"
        );
    }

    #[test]
    fn results_are_capped_and_report_the_total() {
        let mut index = ScopeGraphIndex::new();
        for i in 0..50 {
            index.add_definition(&format!("symbol_{i}"), "src/a.rs", i + 1);
        }

        let result = index.search_symbols(&SymbolQuery::new("symbol_").with_limit(5));
        assert_eq!(result.matches.len(), 5);
        assert_eq!(result.matched_symbols, 50);
        assert!(result.is_truncated());
    }

    // Path preference

    #[test]
    fn the_shallowest_definition_represents_the_symbol() {
        let index = index_with(&[(
            "Widget",
            &[("src/impl/detail/inner.rs", 40), ("src/lib.rs", 7)],
            0,
        )]);

        let found = search(&index, SymbolQuery::new("Widget"));
        assert_eq!(found[0].sites[0].path, "src/lib.rs");
        assert_eq!(found[0].sites[0].line, 7);
        assert_eq!(found[0].definition_count, 2);
    }

    #[test]
    fn a_path_prefix_filters_results() {
        let index = index_with(&[
            ("alpha", &[("src/a.rs", 1)], 0),
            ("beta", &[("tests/b.rs", 2)], 0),
        ]);

        let found = search(&index, SymbolQuery::new("a").with_path_prefix("src/"));
        assert_eq!(names(&found), vec!["alpha"]);
    }

    /// The index stores the host's separator, so on Windows a stored path is
    /// `src\lib.rs`. A caller always writes `/`.
    #[test]
    fn a_forward_slash_prefix_matches_a_backslash_path() {
        let index = index_with(&[("alpha", &[("src\\nested\\a.rs", 1)], 0)]);
        let found = search(&index, SymbolQuery::new("alpha").with_path_prefix("src/"));
        assert_eq!(names(&found), vec!["alpha"]);
    }

    /// The reported path is always forward-slash, whatever the host, because a
    /// model joins it with a root it already knows.
    #[test]
    fn a_reported_site_uses_forward_slashes() {
        let index = index_with(&[("alpha", &[("src\\nested\\a.rs", 1)], 0)]);
        let found = search(&index, SymbolQuery::new("alpha"));
        assert_eq!(found[0].sites[0].path, "src/nested/a.rs");
    }

    /// A symbol whose only definition sits outside the prefix must vanish, not
    /// fall back to an unfiltered site.
    #[test]
    fn a_path_prefix_excludes_symbols_defined_elsewhere() {
        let index = index_with(&[("gamma", &[("tests/c.rs", 3)], 0)]);
        let found = search(&index, SymbolQuery::new("gamma").with_path_prefix("src/"));
        assert!(found.is_empty());
    }

    // Sites

    #[test]
    fn declarations_are_reported_before_uses() {
        let index = index_with(&[("Thing", &[("src/lib.rs", 10)], 5)]);
        let found = search(&index, SymbolQuery::new("Thing").with_references(true));

        let sites = &found[0].sites;
        assert!(sites[0].is_definition, "the declaration comes first");
        assert!(sites[1..].iter().all(|s| !s.is_definition));
    }

    #[test]
    fn references_are_omitted_unless_asked_for() {
        let index = index_with(&[("Thing", &[("src/lib.rs", 10)], 5)]);

        let without = search(&index, SymbolQuery::new("Thing"));
        assert_eq!(without[0].sites.len(), 1, "declarations only");

        let with = search(&index, SymbolQuery::new("Thing").with_references(true));
        assert_eq!(
            with[0].sites.len(),
            DEFAULT_SITES_PER_SYMBOL,
            "the per-symbol cap applies"
        );
        assert_eq!(with[0].reference_count, 5);
    }

    #[test]
    fn a_capped_site_list_is_reported_as_truncated() {
        let mut index = ScopeGraphIndex::new();
        for i in 0..30 {
            index.add_definition("Hot", "src/lib.rs", i + 1);
        }

        let result = index.search_symbols(&SymbolQuery::new("Hot").with_sites_per_symbol(2));
        assert_eq!(result.matches[0].sites.len(), 2);
        assert!(result.matches[0].sites_truncated);
        assert!(result.is_truncated());
    }

    #[test]
    fn a_complete_answer_is_not_truncated() {
        let index = index_with(&[("Only", &[("src/lib.rs", 1)], 0)]);
        let result = index.search_symbols(&SymbolQuery::new("Only"));
        assert!(!result.is_truncated());
    }

    #[test]
    fn a_symbol_with_no_definition_is_not_reported() {
        let mut index = ScopeGraphIndex::new();
        // A use with no declaration: the symbol exists, but not as a definition.
        index.add_reference("orphan", "src/lib.rs", 3);

        let found = search(&index, SymbolQuery::new("orphan"));
        assert!(
            found.is_empty(),
            "a result with no location is a dead end for the caller"
        );
    }

    // RRF

    #[test]
    fn rrf_rewards_agreement_between_lists() {
        let both = rrf(1) + rrf(1);
        let split = rrf(1) + rrf(100);
        assert!(both > split);
    }

    #[test]
    fn rrf_is_monotonically_decreasing() {
        assert!(rrf(1) > rrf(2));
        assert!(rrf(2) > rrf(3));
        assert!(rrf(1) > 0.0);
    }
}
