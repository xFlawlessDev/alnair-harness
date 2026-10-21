//! Tracks open TUI sessions in `~/.alnair/active_sessions.json` for crash
//! recovery. Clean exit removes the entry; crash leaves it behind. On next
//! launch, [`collect_crashed`] finds orphaned entries (dead PIDs).

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;

use agent_client_protocol as acp;
use chrono::{DateTime, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActiveSession {
    pub session_id: acp::SessionId,
    pub pid: u32,
    pub cwd: String,
    pub opened_at: DateTime<Utc>,
}

const DATA_FILENAME: &str = "active_sessions.json";
const LOCK_FILENAME: &str = "active_sessions.lock";
const TMP_FILENAME: &str = "active_sessions.json.tmp";

/// Register a session as active (idempotent by session_id).
pub fn register(session: ActiveSession) -> io::Result<()> {
    register_in(&crate::util::alnair_home::alnair_home(), session)
}

/// Unregister a session (clean exit). No-op if not found.
pub fn unregister(session_id: &acp::SessionId) -> io::Result<()> {
    unregister_in(&crate::util::alnair_home::alnair_home(), session_id)
}

/// Non-blocking unregister for signal handlers. Returns `Ok(false)` on
/// lock contention; the orphan is cleaned up by `collect_crashed` next launch.
pub fn try_unregister(session_id: &acp::SessionId) -> io::Result<bool> {
    try_unregister_in(&crate::util::alnair_home::alnair_home(), session_id)
}

/// Remove entries with dead PIDs and return them.
pub fn collect_crashed() -> io::Result<Vec<ActiveSession>> {
    collect_crashed_in(&crate::util::alnair_home::alnair_home())
}

pub fn register_in(root: &Path, session: ActiveSession) -> io::Result<()> {
    with_locked_state(root, |sessions| {
        sessions.retain(|s| s.session_id != session.session_id);
        sessions.push(session);
    })
}

pub fn unregister_in(root: &Path, session_id: &acp::SessionId) -> io::Result<()> {
    with_locked_state(root, |sessions| {
        sessions.retain(|s| s.session_id != *session_id);
    })
}

pub fn try_unregister_in(root: &Path, session_id: &acp::SessionId) -> io::Result<bool> {
    try_with_locked_state(root, |sessions| {
        sessions.retain(|s| s.session_id != *session_id);
    })
    .map(|opt| opt.is_some())
}

pub fn collect_crashed_in(root: &Path) -> io::Result<Vec<ActiveSession>> {
    with_locked_state(root, |sessions| {
        let (alive, dead): (Vec<_>, Vec<_>) = sessions.drain(..).partition(|s| is_pid_alive(s.pid));
        *sessions = alive;
        dead
    })
}

pub fn list_in(root: &Path) -> io::Result<Vec<ActiveSession>> {
    let data_path = root.join(DATA_FILENAME);
    read_data_file(&data_path)
}

fn with_locked_state<F, R>(root: &Path, mutate: F) -> io::Result<R>
where
    F: FnOnce(&mut Vec<ActiveSession>) -> R,
{
    let lock_path = root.join(LOCK_FILENAME);
    let data_path = root.join(DATA_FILENAME);
    let tmp_path = root.join(TMP_FILENAME);

    fs::create_dir_all(root)?;
    let lock_file = open_lock_file(&lock_path)?;
    lock_file.lock_exclusive()?;

    let result = locked_mutate(&data_path, &tmp_path, mutate);

    let _ = lock_file.unlock();
    result
}

/// Non-blocking variant for signal handlers.
fn try_with_locked_state<F, R>(root: &Path, mutate: F) -> io::Result<Option<R>>
where
    F: FnOnce(&mut Vec<ActiveSession>) -> R,
{
    let lock_path = root.join(LOCK_FILENAME);
    let data_path = root.join(DATA_FILENAME);
    let tmp_path = root.join(TMP_FILENAME);

    fs::create_dir_all(root)?;
    let lock_file = open_lock_file(&lock_path)?;

    match lock_file.try_lock_exclusive() {
        Ok(()) => {
            let result = locked_mutate(&data_path, &tmp_path, mutate);
            let _ = lock_file.unlock();
            result.map(Some)
        }
        // "Someone else holds it" is not an error — the caller declines.
        //
        // The kind test alone is not portable: on Windows `LockFileEx` reports
        // ERROR_LOCK_VIOLATION (raw 33), which `fs2` surfaces as
        // `ErrorKind::Uncategorized`, NOT `WouldBlock`. Testing only the kind
        // made every contended call on Windows return `Err`, so callers that
        // treat an error as fatal (rather than as "try later") failed instead
        // of backing off.
        Err(e) if is_lock_contended(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Whether a `try_lock_*` failure means "another holder has it" rather than a
/// real I/O fault.
fn is_lock_contended(e: &io::Error) -> bool {
    if e.kind() == io::ErrorKind::WouldBlock {
        return true;
    }
    // ERROR_LOCK_VIOLATION (33) and ERROR_SHARING_VIOLATION (32): the first is
    // an overlapping byte-range lock, the second a share-mode conflict. Both
    // mean "contended" for our purposes.
    #[cfg(windows)]
    if matches!(e.raw_os_error(), Some(32) | Some(33)) {
        return true;
    }
    false
}

fn locked_mutate<F, R>(data_path: &Path, tmp_path: &Path, mutate: F) -> io::Result<R>
where
    F: FnOnce(&mut Vec<ActiveSession>) -> R,
{
    let mut sessions = read_data_file(data_path)?;
    let result = mutate(&mut sessions);
    write_data_file_atomic(tmp_path, data_path, &sessions)?;
    Ok(result)
}

fn open_lock_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
}

fn read_data_file(path: &Path) -> io::Result<Vec<ActiveSession>> {
    match fs::read(path) {
        Ok(bytes) if bytes.is_empty() => Ok(Vec::new()),
        Ok(bytes) => match serde_json::from_slice::<Vec<ActiveSession>>(&bytes) {
            Ok(sessions) => Ok(sessions),
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "active_sessions.json is corrupted, starting with empty list"
                );
                Ok(Vec::new())
            }
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

fn write_data_file_atomic(
    tmp_path: &Path,
    data_path: &Path,
    sessions: &[ActiveSession],
) -> io::Result<()> {
    let json = serde_json::to_string_pretty(sessions)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(tmp_path, json.as_bytes())?;
    crate::util::fs::replace_file(tmp_path, data_path)
}

fn is_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let pid_i = match i32::try_from(pid) {
            Ok(p) if p > 0 => p,
            _ => return false,
        };
        let ret = unsafe { libc::kill(pid_i as libc::pid_t, 0) };
        if ret == 0 {
            return true;
        }
        io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) };
        match handle {
            Ok(h) => {
                let _ = unsafe { CloseHandle(h) };
                true
            }
            Err(_) => false,
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        // Conservative: assume alive if we can't check.
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_session(id: &str, pid: u32) -> ActiveSession {
        ActiveSession {
            session_id: acp::SessionId::new(id),
            pid,
            cwd: "/tmp/test".into(),
            opened_at: Utc::now(),
        }
    }

    #[test]
    fn register_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let s = make_session("s1", std::process::id());
        register_in(dir.path(), s.clone()).unwrap();
        register_in(dir.path(), s).unwrap();
        assert_eq!(list_in(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn collect_crashed_partitions_by_pid_liveness() {
        let dir = TempDir::new().unwrap();
        register_in(dir.path(), make_session("alive", std::process::id())).unwrap();
        register_in(dir.path(), make_session("dead", 2_000_000_000)).unwrap();

        let crashed = collect_crashed_in(dir.path()).unwrap();
        assert_eq!(crashed.len(), 1);
        assert_eq!(&*crashed[0].session_id.0, "dead");
        assert_eq!(&*list_in(dir.path()).unwrap()[0].session_id.0, "alive");
    }

    #[test]
    fn concurrent_registers_no_corruption() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        std::thread::scope(|s| {
            for i in 0..10 {
                let p = path.clone();
                s.spawn(move || {
                    register_in(&p, make_session(&format!("s{i}"), std::process::id())).unwrap()
                });
            }
        });
        assert_eq!(list_in(dir.path()).unwrap().len(), 10);
    }

    /// A concurrent holder must make `try_unregister_in` decline instead of
    /// blocking.
    ///
    /// The holder is a **separate process**, not a second handle in this one:
    /// `LockFileEx` (behind `fs2` on Windows) fails with `ERROR_LOCK_VIOLATION`
    /// for an overlapping lock requested by the same process, so
    /// `lock_exclusive()` here would panic before the assertion ever ran. On
    /// Unix the same-process double lock succeeds, which is why the original
    /// form passed there.
    #[test]
    fn try_unregister_skips_if_locked() {
        let dir = TempDir::new().unwrap();
        let s = make_session("s1", std::process::id());
        register_in(dir.path(), s.clone()).unwrap();

        let lock_path = dir.path().join(LOCK_FILENAME);
        #[cfg(windows)]
        let ready_path = dir.path().join("lock-holder-ready");
        // A child that takes the lock and holds it until we signal by closing
        // stdin. `flock` is POSIX; Windows uses a PowerShell FileStream lock.
        #[cfg(unix)]
        let mut holder = std::process::Command::new("sh")
            .args([
                "-c",
                &format!("exec 9>>'{}'; flock -x 9; read _", lock_path.display()),
            ])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("spawn lock holder");
        #[cfg(windows)]
        let mut holder = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    // `ReadWrite` sharing (not `None`): the assertion path still
                    // has to OPEN the file to attempt its lock. `None` denies the
                    // open itself, which surfaces as ERROR_SHARING_VIOLATION
                    // before the lock is ever tried. `FileStream.Lock` then takes
                    // the byte-range lock that `try_lock_exclusive` collides with.
                    //
                    // The ready-marker line is the handshake with the assertion
                    // below: PowerShell's cold start is far slower than the
                    // ~500 ms a fixed sleep allowed, so under a loaded full-suite
                    // run the lock was sometimes not held yet and the "must
                    // decline" assertion saw a free lock.
                    "$f=[IO.File]::Open('{lock}','OpenOrCreate','ReadWrite','ReadWrite'); \
                     $f.Lock(0,[Int64]::MaxValue); \
                     Set-Content -NoNewline -Path '{ready}' -Value 'ok'; \
                     [Console]::In.ReadLine() | Out-Null; $f.Close()",
                    lock = lock_path.display(),
                    ready = ready_path.display(),
                ),
            ])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("spawn lock holder");

        // Wait for the holder to actually take the lock (see the ready-marker
        // comment above) instead of racing a fixed sleep.
        #[cfg(windows)]
        {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            while !ready_path.exists() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "lock holder never signalled readiness"
                );
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
        #[cfg(unix)]
        std::thread::sleep(std::time::Duration::from_millis(500));

        assert!(
            !try_unregister_in(dir.path(), &s.session_id).unwrap(),
            "a held lock must make try_unregister decline"
        );

        // Release: closing stdin lets the holder exit and drop its lock.
        drop(holder.stdin.take());
        let _ = holder.wait();
        assert_eq!(list_in(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn corrupt_file_recovers() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(DATA_FILENAME), "garbage{{{").unwrap();
        assert!(list_in(dir.path()).unwrap().is_empty());
        register_in(dir.path(), make_session("s1", std::process::id())).unwrap();
        assert_eq!(list_in(dir.path()).unwrap().len(), 1);
    }
}
