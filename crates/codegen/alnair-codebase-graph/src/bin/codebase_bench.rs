//! Retrieval benchmark for the structural code-search tools.
//!
//! ## What this measures, and what it refuses to
//!
//! Three questions are often conflated. This harness answers the first two and
//! is explicit about the limits of the third:
//!
//! 1. **Is the tool correct?** Does `search_symbols` point at the declaration a
//!    human would name? Graded on symbols whose true location is known
//!    independently of the thing under test.
//! 2. **Is it better than `grep`?** Wall time, and how much text lands in the
//!    context window.
//! 3. **Does the agent get better answers?** **Not measured here.** That needs
//!    end-to-end turns with a model and a graded answer key.
//!
//! Reporting (1) and (2) as if they answered (3) is the usual mistake, so the
//! output labels every number with the question it belongs to.
//!
//! ## How ground truth is established
//!
//! Symbols are chosen from the source tree, not from the index: a small
//! TypeScript-free scan reads every `.rs` file and records `fn name(` as the
//! declaration site. That is a second, independent reader of the same truth,
//! so the tool is never graded against its own output.
//!
//! Deliberately narrow: only Rust `fn` declarations, because this is the
//! language the repository itself is written in and the one where a
//! line-oriented scan is trustworthy. Grading other languages here would
//! measure the scanner, not the tool.
//!
//! ## Usage
//!
//! ```text
//! cargo run --release -p alnair-codebase-graph --bin codebase_bench -- --repo .
//! ```

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use alnair_codebase_graph::{IndexBuilder, ScopeGraphIndex, SymbolQuery};

/// How many symbols to grade.
const SAMPLE_SIZE: usize = 40;

/// Result cap the agent would actually use.
const LIMIT: usize = 20;

fn main() {
    let repo = repo_arg();

    eprintln!("scanning {} for ground truth …", repo.display());
    let truth = rust_fn_declarations(&repo);
    eprintln!("{} rust fn declarations found", truth.len());
    if truth.is_empty() {
        eprintln!("no ground truth; is this a Rust repository?");
        std::process::exit(2);
    }

    eprintln!("indexing …");
    let build_start = Instant::now();
    let index = IndexBuilder::new().build(&repo).expect("build index");
    let build = build_start.elapsed();
    let (files, defs, refs) = index.stats();

    println!("## Index");
    println!("repo              {}", repo.display());
    println!("files             {files}");
    println!("definitions       {defs}");
    println!("references        {refs}");
    println!("cold build        {:.2}s", build.as_secs_f64());
    println!("ground truth      {} unique names", truth.len());
    println!();

    let sample = sample(&truth);
    grade_correctness(&index, &truth, &sample);
    measure_latency(&index, &sample);
    measure_context_cost(&index, &repo, &sample);
    report_what_is_not_measured(&repo);
}

fn repo_arg() -> PathBuf {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--repo"
            && let Some(path) = args.next()
        {
            return PathBuf::from(path);
        }
    }
    std::env::current_dir().expect("cwd")
}

/// `name -> (relative_path, 1-indexed line)` for every `fn name(` in the tree.
///
/// A deliberately dumb reader: it must not share code with the tree-sitter
/// path, or "the tool agrees with the benchmark" would only mean "the tool
/// agrees with itself".
fn rust_fn_declarations(root: &Path) -> BTreeMap<String, (String, usize)> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if path.is_dir() {
                // Skip the same trees the indexer skips.
                if name == "target" || name == "node_modules" || name.starts_with('.') {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            for (idx, line) in text.lines().enumerate() {
                let Some(name) = fn_name(line) else {
                    continue;
                };
                // Keep the FIRST declaration only: a name declared twice has no
                // single correct answer, so grading it measures ambiguity.
                out.entry(name).or_insert((rel.clone(), idx + 1));
            }
        }
    }
    out
}

/// Extract `name` from a line declaring a Rust function.
fn fn_name(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    // Skip comments and attributes: `// fn foo` is not a declaration.
    if trimmed.starts_with("//") || trimmed.starts_with('#') {
        return None;
    }
    let rest = trimmed.strip_prefix("fn ").or_else(|| {
        // `pub fn`, `pub(crate) fn`, `async fn`, `const fn`, `unsafe fn`,
        // and their combinations.
        let mut r = trimmed;
        loop {
            let before = r;
            r = r
                .strip_prefix("pub(crate) ")
                .or_else(|| r.strip_prefix("pub(super) "))
                .or_else(|| r.strip_prefix("pub "))
                .or_else(|| r.strip_prefix("async "))
                .or_else(|| r.strip_prefix("const "))
                .or_else(|| r.strip_prefix("unsafe "))
                .or_else(|| r.strip_prefix("extern "))
                .unwrap_or(r);
            if r == before {
                break;
            }
        }
        r.strip_prefix("fn ")
    })?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    (!name.is_empty()).then_some(name)
}

/// A deterministic, evenly-strided sample.
///
/// Strided rather than random so two runs on one commit grade the same set: a
/// benchmark whose sample moves between runs cannot show a regression.
fn sample(truth: &BTreeMap<String, (String, usize)>) -> Vec<String> {
    let names: Vec<&String> = truth.keys().collect();
    if names.len() <= SAMPLE_SIZE {
        return names.into_iter().cloned().collect();
    }
    let step = names.len() / SAMPLE_SIZE;
    (0..SAMPLE_SIZE).map(|i| names[i * step].clone()).collect()
}

/// Question 1 — does the tool find the declaration, and does it rank it first?
fn grade_correctness(
    index: &ScopeGraphIndex,
    truth: &BTreeMap<String, (String, usize)>,
    sample: &[String],
) {
    println!("## Q1 — Is the tool correct?");
    println!("ground truth comes from a line scanner, not from the index.");

    let mut correct = 0usize;
    let mut ranked_first = 0usize;
    let mut wrong_location: Vec<String> = Vec::new();
    let mut not_returned: Vec<String> = Vec::new();

    for name in sample {
        let Some((want_path, want_line)) = truth.get(name) else {
            continue;
        };
        let result = index.search_symbols(&SymbolQuery::new(name.clone()).with_limit(LIMIT));

        let first_named = result.matches.iter().find(|m| m.name == *name);
        let Some(found) = first_named else {
            not_returned.push(name.clone());
            continue;
        };
        let Some(site) = found.sites.first() else {
            not_returned.push(name.clone());
            continue;
        };

        if site.path == *want_path && site.line == *want_line {
            correct += 1;
            if result.matches.first().is_some_and(|m| m.name == *name) {
                ranked_first += 1;
            }
        } else {
            wrong_location.push(format!(
                "{name}: got {}:{}, want {want_path}:{want_line}",
                site.path, site.line
            ));
        }
    }

    let total = sample.len().max(1);
    let pct = |n: usize| n as f64 / total as f64 * 100.0;
    println!(
        "exact location      {correct}/{total} ({:.0}%)",
        pct(correct)
    );
    println!(
        "ranked first        {ranked_first}/{total} ({:.0}%)",
        pct(ranked_first)
    );
    println!(
        "wrong location      {}  ← a confidently wrong answer, worse than 'not found'",
        wrong_location.len()
    );
    for line in wrong_location.iter().take(6) {
        println!("  - {line}");
    }
    println!(
        "false negatives     {}  ← 'no such symbol' for a symbol that exists",
        not_returned.len()
    );
    for name in not_returned.iter().take(6) {
        println!("  - {name}");
    }
    println!();
}

/// Question 2a — warm-query latency percentiles.
fn measure_latency(index: &ScopeGraphIndex, sample: &[String]) {
    println!("## Q2a — Latency");
    let mut samples: Vec<Duration> = Vec::with_capacity(sample.len());
    for name in sample {
        let start = Instant::now();
        let _ = index.search_symbols(&SymbolQuery::new(name.clone()).with_limit(LIMIT));
        samples.push(start.elapsed());
    }
    samples.sort();
    let at = |p: f64| {
        let idx = ((samples.len() as f64 - 1.0) * p).round() as usize;
        samples[idx.min(samples.len().saturating_sub(1))]
    };
    println!(
        "p50                 {:.2} ms",
        at(0.50).as_secs_f64() * 1000.0
    );
    println!(
        "p95                 {:.2} ms",
        at(0.95).as_secs_f64() * 1000.0
    );
    println!(
        "max                 {:.2} ms",
        at(1.0).as_secs_f64() * 1000.0
    );
    println!();
}

/// Question 2b — how much text each approach puts in the context window.
///
/// Line counts, not tokens: tokens depend on the tokenizer and would make the
/// number non-comparable across providers. Lines are what a reader can check
/// against their own eyes.
fn measure_context_cost(index: &ScopeGraphIndex, repo: &Path, sample: &[String]) {
    println!("## Q2b — Context cost");
    println!("`rg` is the baseline a model reaches for without this tool.");

    let mut tool_lines = 0usize;
    let mut grep_lines = 0usize;
    let mut tool_ms = Duration::ZERO;
    let mut grep_ms = Duration::ZERO;
    let mut grep_runs = 0usize;

    for name in sample {
        let start = Instant::now();
        let result = index.search_symbols(&SymbolQuery::new(name.clone()).with_limit(LIMIT));
        tool_ms += start.elapsed();
        // Heading plus the sites rendered for each match.
        tool_lines += result
            .matches
            .iter()
            .map(|m| 1 + m.sites.len())
            .sum::<usize>();

        let start = Instant::now();
        if let Ok(out) = Command::new("rg")
            .args(["--no-heading", "--line-number", "--fixed-strings", name])
            .current_dir(repo)
            .output()
        {
            grep_ms += start.elapsed();
            grep_runs += 1;
            grep_lines += String::from_utf8_lossy(&out.stdout).lines().count();
        }
    }

    println!("tool  lines         {tool_lines}");
    println!("rg    lines         {grep_lines}");
    if grep_lines > 0 && tool_lines > 0 {
        println!(
            "ratio               {:.1}× more text with rg",
            grep_lines as f64 / tool_lines as f64
        );
    }
    if grep_runs > 0 {
        println!(
            "rg    per query     {:.1} ms (process spawn included)",
            grep_ms.as_secs_f64() * 1000.0 / grep_runs as f64
        );
    }
    println!(
        "tool  per query     {:.2} ms",
        tool_ms.as_secs_f64() * 1000.0 / sample.len().max(1) as f64
    );
    println!();
}

/// Question 3 is not answered by a binary. Say so where a reader will look.
fn report_what_is_not_measured(repo: &Path) {
    println!("## Q3 — Does the agent get better answers?");
    println!("NOT MEASURED by this benchmark. It needs end-to-end turns with a");
    println!("model and a graded answer key; a retrieval binary cannot produce it.");
    println!();
    println!("What this benchmark does establish:");
    println!("  - whether the tool returns the right location (Q1)");
    println!("  - whether it is faster and smaller than rg (Q2)");
    println!();
    println!("What still needs a real session:");
    println!("  - does the model choose it over grep");
    println!("  - does a wrong answer from it mislead more than grep would");
    println!();
    println!("Session logs: {}/sessions", alnair_home().display());
    let _ = repo;
}

fn alnair_home() -> PathBuf {
    std::env::var_os("ALNAIR_SHARE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|h| PathBuf::from(h).join(".alnair"))
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::fn_name;

    #[test]
    fn plain_declaration() {
        assert_eq!(fn_name("fn alpha() {}"), Some("alpha".into()));
    }

    #[test]
    fn visibility_and_modifiers() {
        for line in [
            "pub fn beta(",
            "pub(crate) fn beta(",
            "async fn beta(",
            "pub async fn beta(",
            "pub(crate) const fn beta(",
            "unsafe fn beta(",
        ] {
            assert_eq!(fn_name(line), Some("beta".into()), "{line}");
        }
    }

    /// A comment or attribute mentioning `fn` is not a declaration; treating it
    /// as one would corrupt the ground truth the tool is graded against.
    #[test]
    fn comments_and_attributes_are_ignored() {
        assert_eq!(fn_name("// fn gamma()"), None);
        assert_eq!(fn_name("    /// fn gamma()"), None);
        assert_eq!(fn_name("#[allow(dead_code)]"), None);
    }

    #[test]
    fn generics_and_lifetimes_stop_at_the_name() {
        assert_eq!(fn_name("fn delta<T>(x: T)"), Some("delta".into()));
        assert_eq!(
            fn_name("fn epsilon<'a>(x: &'a str)"),
            Some("epsilon".into())
        );
    }

    #[test]
    fn a_call_is_not_a_declaration() {
        assert_eq!(fn_name("    zeta();"), None);
        assert_eq!(fn_name("foo::bar();"), None);
    }
}
