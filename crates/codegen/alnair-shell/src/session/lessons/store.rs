//! Workspace-scoped store of harness lessons.
//!
//! A lesson records *what our own harness got wrong in this workspace and what
//! fixed it* — the goal strategist's `strategy.md`, distilled. It is
//! deliberately not memory: memory answers "what is true about this repo?",
//! lessons answer "what did the harness get wrong here?".
//!
//! Location is user-global and partitioned by the SAME workspace key memory
//! uses (`alnair_memory::storage::workspace_key`), so one repository can never
//! own two directories depending on which subsystem asked:
//!
//! ```text
//! ~/.alnair/lessons/<slug>-<hash8>/LESSONS.md
//! ~/.alnair/lessons/<slug>-<hash8>/lessons.lock
//! ```
//!
//! Never inside the repository. A lesson file is read into context
//! automatically, so a repo-controlled one would let a hostile checkout steer
//! every future session in it.
//!
//! Storage discipline is copied from `active_sessions.rs`: an exclusive fs2
//! lock held across the whole read-modify-write, `replace_file` for the commit
//! (never a bare `rename` — that is the "persists on macOS, silently doesn't on
//! Windows" class), and `NotFound` reading as empty rather than corrupt.

use std::io;
use std::path::{Path, PathBuf};

use fs2::FileExt as _;

/// File holding the entries, inside the workspace directory.
const DATA_FILENAME: &str = "LESSONS.md";
/// Sidecar holding the advisory lock.
const LOCK_FILENAME: &str = "lessons.lock";
/// Temporary file used for the atomic commit.
const TMP_FILENAME: &str = "LESSONS.md.tmp";

/// Which harness lever the lesson points at.
///
/// Sorted by, not acted on: a future reader groups lessons by the thing that
/// fixed them. A keyword guess over the lesson text is adequate for v1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LessonComponent {
    Skill,
    Script,
    Subagent,
    Hook,
    Workflow,
}

impl LessonComponent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Skill => "skill",
            Self::Script => "script",
            Self::Subagent => "subagent",
            Self::Hook => "hook",
            Self::Workflow => "workflow",
        }
    }

    /// Parse a stored value. Unknown values fall back to `Workflow` rather
    /// than failing the whole entry — a future component name must not make
    /// today's reader drop the lesson.
    fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "skill" => Self::Skill,
            "script" => Self::Script,
            "subagent" => Self::Subagent,
            "hook" => Self::Hook,
            _ => Self::Workflow,
        }
    }
}

/// One captured lesson.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LessonEntry {
    /// When does this apply — the diagnosis, one sentence.
    pub cue: String,
    /// What to do instead.
    pub lesson: String,
    /// What produced it, so the reader can weigh it.
    pub evidence: String,
    pub component: LessonComponent,
    /// RFC3339 UTC capture time.
    pub captured: String,
    /// Dedup key: 8 hex chars of blake3 over the normalized cue + lesson.
    pub id: String,
    /// Fields this version does not know, preserved verbatim on rewrite.
    /// Same forward-compatibility rule `AgentDefinition` uses for frontmatter.
    pub extra: Vec<(String, String)>,
}

impl LessonEntry {
    /// Refuse an entry missing any of cue / lesson / evidence.
    ///
    /// A half-written lesson is worse than none: it would be injected with
    /// confidence it has not earned.
    pub fn is_complete(&self) -> bool {
        !self.cue.trim().is_empty()
            && !self.lesson.trim().is_empty()
            && !self.evidence.trim().is_empty()
    }

    /// `id = blake3(normalized_cue + "\0" + normalized_lesson)[..8]`.
    ///
    /// The strategist can fire repeatedly on the same stuck pattern; each fire
    /// must not add a near-duplicate line.
    pub fn compute_id(cue: &str, lesson: &str) -> String {
        let mut input = normalize_for_id(cue);
        input.push('\0');
        input.push_str(&normalize_for_id(lesson));
        blake3::hash(input.as_bytes()).to_hex()[..8].to_string()
    }
}

/// Lowercase and collapse whitespace, so a re-wrapped note still dedups.
fn normalize_for_id(raw: &str) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Outcome of an [`append`] attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendOutcome {
    /// A new entry was written.
    Appended,
    /// An entry with the same id already existed; nothing changed.
    Duplicate,
    /// The workspace is ephemeral (a temp dir), so nothing was written.
    SkippedEphemeral,
    /// The entry was missing a required field; nothing was written.
    Rejected,
}

/// The workspace's lesson directory, or `None` when it owns no durable state.
///
/// An ephemeral (temp-dir) workspace returns `None`: otherwise every
/// `tempfile::TempDir` test and every scratch run would write a lesson file
/// into the real home.
pub fn lessons_dir(cwd: &Path) -> Option<PathBuf> {
    lessons_dir_in(
        &crate::util::alnair_home::alnair_home().join("lessons"),
        cwd,
    )
}

/// [`lessons_dir`] against an explicit root, for tests.
pub fn lessons_dir_in(root: &Path, cwd: &Path) -> Option<PathBuf> {
    if alnair_memory::storage::is_ephemeral_workspace(cwd) {
        return None;
    }
    Some(root.join(alnair_memory::storage::workspace_key(cwd)))
}

/// Append one lesson to the workspace store.
pub fn append(cwd: &Path, entry: &LessonEntry, max_entries: usize) -> io::Result<AppendOutcome> {
    let root = crate::util::alnair_home::alnair_home().join("lessons");
    append_in(&root, cwd, entry, max_entries)
}

/// [`append`] against an explicit root, for tests.
pub fn append_in(
    root: &Path,
    cwd: &Path,
    entry: &LessonEntry,
    max_entries: usize,
) -> io::Result<AppendOutcome> {
    let Some(dir) = lessons_dir_in(root, cwd) else {
        return Ok(AppendOutcome::SkippedEphemeral);
    };
    if !entry.is_complete() {
        tracing::warn!(
            target: alnair_log::memory_log::TARGET,
            id = %entry.id,
            "LESSONS: refusing an incomplete entry (cue/lesson/evidence must all be non-empty)"
        );
        return Ok(AppendOutcome::Rejected);
    }

    std::fs::create_dir_all(&dir)?;
    let lock_path = dir.join(LOCK_FILENAME);
    let data_path = dir.join(DATA_FILENAME);
    let tmp_path = dir.join(TMP_FILENAME);

    let lock_file = open_lock_file(&lock_path)?;
    lock_file.lock_exclusive()?;
    let result = locked_append(&data_path, &tmp_path, entry, max_entries);
    let _ = lock_file.unlock();
    result
}

fn locked_append(
    data_path: &Path,
    tmp_path: &Path,
    entry: &LessonEntry,
    max_entries: usize,
) -> io::Result<AppendOutcome> {
    let mut entries = read_entries(data_path)?;
    if entries.iter().any(|e| e.id == entry.id) {
        return Ok(AppendOutcome::Duplicate);
    }
    entries.push(entry.clone());
    // Oldest dropped on overflow: past the cap the file stops being
    // browsable and the injection budget stops meaning anything.
    if max_entries > 0 && entries.len() > max_entries {
        let excess = entries.len() - max_entries;
        entries.drain(..excess);
    }
    write_entries_atomic(tmp_path, data_path, &entries)?;
    Ok(AppendOutcome::Appended)
}

/// Load up to `limit` lessons, newest first. `limit == 0` means no limit.
///
/// A workspace with no store returns an empty vec; a store that fails to parse
/// logs and also returns empty rather than injecting a partial list.
pub fn load(cwd: &Path, limit: usize) -> io::Result<Vec<LessonEntry>> {
    let root = crate::util::alnair_home::alnair_home().join("lessons");
    load_in(&root, cwd, limit)
}

/// [`load`] against an explicit root, for tests.
pub fn load_in(root: &Path, cwd: &Path, limit: usize) -> io::Result<Vec<LessonEntry>> {
    let Some(dir) = lessons_dir_in(root, cwd) else {
        return Ok(Vec::new());
    };
    let mut entries = read_entries(&dir.join(DATA_FILENAME))?;
    entries.reverse();
    if limit > 0 {
        entries.truncate(limit);
    }
    Ok(entries)
}

/// Delete the workspace's lesson file. Returns whether one existed.
///
/// Idempotent: clearing an empty store is not an error.
pub fn clear(cwd: &Path) -> io::Result<bool> {
    let root = crate::util::alnair_home::alnair_home().join("lessons");
    clear_in(&root, cwd)
}

/// [`clear`] against an explicit root, for tests.
pub fn clear_in(root: &Path, cwd: &Path) -> io::Result<bool> {
    let Some(dir) = lessons_dir_in(root, cwd) else {
        return Ok(false);
    };
    let data_path = dir.join(DATA_FILENAME);
    match std::fs::remove_file(&data_path) {
        Ok(()) => Ok(true),
        // On Windows `replace_file` deletes the destination before renaming,
        // so absence is a normal transient state, never corruption.
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Current UTC time as an RFC3339 string, e.g. `2026-10-22T09:14:03Z`.
///
/// Hand-rolled rather than pulling a date crate into the capture path: the
/// format is fixed and only ever written, never parsed back.
pub fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn open_lock_file(path: &Path) -> io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
}

fn read_entries(path: &Path) -> io::Result<Vec<LessonEntry>> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(parse(&raw, path)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

fn write_entries_atomic(
    tmp_path: &Path,
    data_path: &Path,
    entries: &[LessonEntry],
) -> io::Result<()> {
    std::fs::write(tmp_path, render(entries).as_bytes())?;
    crate::util::fs::replace_file(tmp_path, data_path)
}

// ---------------------------------------------------------------------------
// Markdown format
// ---------------------------------------------------------------------------

/// The file header. Kept short: it is read by humans who are deciding whether
/// to delete an entry.
fn header() -> String {
    "# Harness lessons\n\n\
     Entries are appended by the goal strategist. Delete any entry you disagree \
     with; it is read into the first turn of the next session in this workspace.\n\n"
        .to_string()
}

/// Render the whole file. Entries are written oldest-first, matching append
/// order, so a human scrolling the file sees history.
pub fn render(entries: &[LessonEntry]) -> String {
    let mut out = header();
    for entry in entries {
        out.push_str("## ");
        out.push_str(entry.cue.trim());
        out.push_str("\n\n");
        out.push_str("- **lesson**: ");
        out.push_str(entry.lesson.trim());
        out.push('\n');
        out.push_str("- **evidence**: ");
        out.push_str(entry.evidence.trim());
        out.push('\n');
        out.push_str("- **component**: ");
        out.push_str(entry.component.as_str());
        out.push('\n');
        out.push_str("- **captured**: ");
        out.push_str(&entry.captured);
        out.push('\n');
        out.push_str("- **id**: ");
        out.push_str(&entry.id);
        out.push('\n');
        for (key, value) in &entry.extra {
            out.push_str("- **");
            out.push_str(key);
            out.push_str("**: ");
            out.push_str(value);
            out.push('\n');
        }
        out.push('\n');
    }
    out
}

/// Parse the file. Deterministic, no YAML dependency.
///
/// Rules: an entry starts at a `## ` heading, `- **field**: value` lines are
/// the fields, unknown fields are preserved verbatim. A block missing a
/// required field is skipped; a file that yields nothing logs at `warn!` —
/// never a silent empty read.
pub fn parse(raw: &str, path: &Path) -> Vec<LessonEntry> {
    let mut entries = Vec::new();
    let mut current: Option<PartialEntry> = None;

    for line in raw.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            if let Some(partial) = current.take() {
                push_if_complete(&mut entries, partial, path);
            }
            current = Some(PartialEntry {
                cue: heading.trim().to_string(),
                ..Default::default()
            });
            continue;
        }
        let Some(partial) = current.as_mut() else {
            continue;
        };
        if let Some((key, value)) = parse_field_line(line) {
            partial.set(key, value);
        }
    }
    if let Some(partial) = current.take() {
        push_if_complete(&mut entries, partial, path);
    }

    if entries.is_empty() && !raw.trim().is_empty() {
        tracing::warn!(
            target: alnair_log::memory_log::TARGET,
            path = %path.display(),
            "LESSONS: file contains no parseable entries; injecting nothing"
        );
    }
    entries
}

#[derive(Default)]
struct PartialEntry {
    cue: String,
    lesson: Option<String>,
    evidence: Option<String>,
    component: Option<String>,
    captured: Option<String>,
    id: Option<String>,
    extra: Vec<(String, String)>,
}

impl PartialEntry {
    fn set(&mut self, key: &str, value: String) {
        match key {
            "lesson" => self.lesson = Some(value),
            "evidence" => self.evidence = Some(value),
            "component" => self.component = Some(value),
            "captured" => self.captured = Some(value),
            "id" => self.id = Some(value),
            _ => self.extra.push((key.to_string(), value)),
        }
    }
}

/// `- **field**: value` → `("field", "value")`.
fn parse_field_line(line: &str) -> Option<(&str, String)> {
    let rest = line.trim_start().strip_prefix("- **")?;
    let (key, value) = rest.split_once("**:")?;
    Some((key.trim(), value.trim().to_string()))
}

fn push_if_complete(entries: &mut Vec<LessonEntry>, partial: PartialEntry, path: &Path) {
    let (Some(lesson), Some(evidence)) = (partial.lesson, partial.evidence) else {
        tracing::warn!(
            target: alnair_log::memory_log::TARGET,
            path = %path.display(),
            cue = %partial.cue,
            "LESSONS: skipping an entry missing lesson or evidence"
        );
        return;
    };
    let entry = LessonEntry {
        id: partial
            .id
            .unwrap_or_else(|| LessonEntry::compute_id(&partial.cue, &lesson)),
        cue: partial.cue,
        lesson,
        evidence,
        component: partial
            .component
            .as_deref()
            .map(LessonComponent::parse)
            .unwrap_or(LessonComponent::Workflow),
        captured: partial.captured.unwrap_or_default(),
        extra: partial.extra,
    };
    if entry.is_complete() {
        entries.push(entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> LessonEntry {
        LessonEntry {
            cue: "Verification gaps keep reopening after a partial fix".into(),
            lesson: "Restructure the unit under test; split the tangled module first.".into(),
            evidence: "failed 3 consecutive verification rounds on: ship it".into(),
            component: LessonComponent::Workflow,
            captured: "2026-10-22T09:14:03Z".into(),
            id: LessonEntry::compute_id(
                "Verification gaps keep reopening after a partial fix",
                "Restructure the unit under test; split the tangled module first.",
            ),
            extra: Vec::new(),
        }
    }

    /// A non-ephemeral cwd for tests. `TempDir` lives under the OS temp root,
    /// which `is_ephemeral_workspace` rejects, so the fixtures use a path the
    /// key function treats as durable.
    fn durable_cwd(name: &str) -> PathBuf {
        PathBuf::from(format!("/nonexistent/lesson-test/{name}"))
    }

    #[test]
    fn render_parse_round_trip_preserves_every_field() {
        let mut entry = sample();
        entry.extra.push(("confidence".into(), "high".into()));
        let rendered = render(std::slice::from_ref(&entry));
        let parsed = parse(&rendered, Path::new("LESSONS.md"));
        assert_eq!(parsed.len(), 1);
        assert_eq!(
            parsed[0], entry,
            "unknown fields must survive the round trip"
        );
    }

    #[test]
    fn append_twice_with_same_cue_and_lesson_yields_one_entry() {
        let root = tempfile::TempDir::new().unwrap();
        let cwd = durable_cwd("dedup");
        let entry = sample();

        let first = append_in(root.path(), &cwd, &entry, 50).unwrap();
        let second = append_in(root.path(), &cwd, &entry, 50).unwrap();

        assert_eq!(first, AppendOutcome::Appended);
        assert_eq!(second, AppendOutcome::Duplicate);
        assert_eq!(load_in(root.path(), &cwd, 0).unwrap().len(), 1);
    }

    #[test]
    fn append_beyond_cap_drops_the_oldest() {
        let root = tempfile::TempDir::new().unwrap();
        let cwd = durable_cwd("cap");
        for i in 0..51 {
            let mut entry = sample();
            entry.cue = format!("cue {i}");
            entry.lesson = format!("lesson {i}");
            entry.id = LessonEntry::compute_id(&entry.cue, &entry.lesson);
            append_in(root.path(), &cwd, &entry, 50).unwrap();
        }
        let loaded = load_in(root.path(), &cwd, 0).unwrap();
        assert_eq!(loaded.len(), 50);
        // Newest first from `load`, so the surviving oldest is cue 1.
        assert_eq!(loaded.last().unwrap().cue, "cue 1");
        assert_eq!(loaded.first().unwrap().cue, "cue 50");
    }

    #[test]
    fn malformed_block_is_skipped_and_garbage_file_yields_empty() {
        let raw = "## good\n\n- **lesson**: do it\n- **evidence**: because\n\n\
                   ## broken\n\n- **lesson**: only a lesson\n";
        let parsed = parse(raw, Path::new("LESSONS.md"));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].cue, "good");

        assert!(parse("not markdown at all\n", Path::new("x")).is_empty());
    }

    #[test]
    fn incomplete_entry_is_rejected_not_written() {
        let root = tempfile::TempDir::new().unwrap();
        let cwd = durable_cwd("incomplete");
        let mut entry = sample();
        entry.evidence.clear();
        assert_eq!(
            append_in(root.path(), &cwd, &entry, 50).unwrap(),
            AppendOutcome::Rejected
        );
        assert!(load_in(root.path(), &cwd, 0).unwrap().is_empty());
    }

    #[test]
    fn ephemeral_workspace_owns_no_store() {
        let root = tempfile::TempDir::new().unwrap();
        let tmp_cwd = tempfile::TempDir::new().unwrap();
        assert_eq!(
            append_in(root.path(), tmp_cwd.path(), &sample(), 50).unwrap(),
            AppendOutcome::SkippedEphemeral
        );
        assert!(load_in(root.path(), tmp_cwd.path(), 0).unwrap().is_empty());
        // Nothing was created at all.
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn clear_is_idempotent() {
        let root = tempfile::TempDir::new().unwrap();
        let cwd = durable_cwd("clear");
        append_in(root.path(), &cwd, &sample(), 50).unwrap();

        assert!(clear_in(root.path(), &cwd).unwrap());
        assert!(!clear_in(root.path(), &cwd).unwrap());
        assert!(load_in(root.path(), &cwd, 0).unwrap().is_empty());
    }

    #[test]
    fn load_limit_takes_newest_first() {
        let root = tempfile::TempDir::new().unwrap();
        let cwd = durable_cwd("limit");
        for i in 0..5 {
            let mut entry = sample();
            entry.cue = format!("cue {i}");
            entry.lesson = format!("lesson {i}");
            entry.id = LessonEntry::compute_id(&entry.cue, &entry.lesson);
            append_in(root.path(), &cwd, &entry, 50).unwrap();
        }
        let newest = load_in(root.path(), &cwd, 3).unwrap();
        assert_eq!(newest.len(), 3);
        assert_eq!(newest[0].cue, "cue 4");
        assert_eq!(newest[2].cue, "cue 2");
    }

    #[test]
    fn id_is_stable_across_whitespace_and_case() {
        let a = LessonEntry::compute_id("Split  the Module", "do   the thing");
        let b = LessonEntry::compute_id("split the module", "do the thing");
        assert_eq!(a, b);
        assert_eq!(a.len(), 8);
    }

    #[test]
    fn rfc3339_helper_matches_a_known_timestamp() {
        // 2026-10-22T09:14:03Z == 1792650843 seconds since the epoch.
        let (y, m, d) = civil_from_days(1_792_650_843 / 86_400);
        assert_eq!((y, m, d), (2026, 10, 22));
        let now = now_rfc3339();
        assert!(now.ends_with('Z'), "{now}");
        assert_eq!(now.len(), 20, "{now}");
    }
}
