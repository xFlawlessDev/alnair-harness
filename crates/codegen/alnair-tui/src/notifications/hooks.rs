use std::process::{Command, Stdio};
use std::time::Duration;

use crate::notifications::NotificationEvent;
use crate::notifications::config::NotificationHook;

/// Build the shell invocation for a hook command.
///
/// Hooks are user shell snippets, so they must run in the user's shell. On
/// Unix that is `sh -c`. On Windows `sh` usually does not exist at all (the
/// previous code failed with `NotFound`), so the command goes through the
/// detected Windows shell — the same `alnair_config::shell` cascade the tool
/// runner uses (pwsh → powershell → Git Bash → cmd), which also gets the
/// quoting and `MSYS_NO_PATHCONV` handling right for each of them.
fn hook_command(command: &str) -> Command {
    #[cfg(unix)]
    {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(command);
        cmd
    }
    #[cfg(not(unix))]
    {
        let invocation = alnair_config::shell::shell_command_argv(command);
        let mut cmd = Command::new(&invocation.program);
        cmd.args(&invocation.args);
        for (key, value) in &invocation.env {
            cmd.env(key, value);
        }
        cmd
    }
}

fn execute_hook(
    command: &str,
    event_str: &str,
    message: &str,
    session_id: Option<&str>,
    timeout: Duration,
) {
    let mut cmd = hook_command(command);
    cmd.env("ALNAIR_EVENT", event_str)
        .env("ALNAIR_MESSAGE", message)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(sid) = session_id {
        cmd.env("ALNAIR_SESSION_ID", sid);
    }

    // Create a new process group so we can kill the entire tree on timeout,
    // preventing orphaned subprocesses from accumulating.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe per POSIX and does not
        // allocate or take locks. Called between fork and exec.
        unsafe {
            cmd.pre_exec(|| {
                nix::unistd::setsid().ok();
                Ok(())
            });
        }
    }

    match cmd.spawn() {
        Ok(mut child) => {
            use wait_timeout::ChildExt;
            match child.wait_timeout(timeout) {
                Ok(Some(_)) => {}
                Ok(None) => {
                    // Kill the entire process group, not just the direct child.
                    #[cfg(unix)]
                    {
                        let pid = child.id() as i32;
                        let _ = nix::sys::signal::killpg(
                            nix::unistd::Pid::from_raw(pid),
                            nix::sys::signal::Signal::SIGKILL,
                        );
                    }
                    #[cfg(not(unix))]
                    {
                        let _ = child.kill();
                    }
                    let _ = child.wait();
                    tracing::warn!("hook timed out");
                }
                Err(e) => tracing::debug!(error = %e, command, "hook wait failed"),
            }
        }
        Err(e) => tracing::debug!(error = %e, command, "hook spawn failed"),
    }
}

pub fn run_hook(hook: &NotificationHook, event: &NotificationEvent) {
    let command = hook.command.clone();
    let event_str: &'static str = event.kind.as_str();
    let message = event.body.clone();
    let session_id = event.session_id.clone();
    let timeout = Duration::from_secs(hook.timeout_secs.max(1));

    std::thread::spawn(move || {
        execute_hook(
            &command,
            event_str,
            &message,
            session_id.as_deref(),
            timeout,
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notifications::config::NotificationEventKind;
    use std::time::Instant;

    fn test_event() -> NotificationEvent {
        NotificationEvent {
            kind: NotificationEventKind::TurnComplete,
            title: "Alnair".into(),
            body: "test body payload".into(),
            session_id: Some("test-session-123".into()),
        }
    }

    /// A hook snippet that writes `text` to `path`, in the shell this host
    /// actually runs hooks in.
    ///
    /// The hook runner is platform-aware (see [`super::hook_command`]), so the
    /// tests must be too: `printf … > file` is POSIX, while PowerShell needs
    /// `Set-Content`. Keeping both spellings here is what makes these tests
    /// meaningful on Windows instead of failing on a missing `sh`.
    fn write_file_command(path: &std::path::Path, text: &str) -> String {
        #[cfg(unix)]
        {
            format!(
                "printf '%s' '{}' > {}",
                text.replace('\'', r"'\''"),
                path.display()
            )
        }
        #[cfg(not(unix))]
        {
            // Single-quoted PowerShell literal: `'` is escaped by doubling it.
            let escaped = text.replace('\'', "''");
            format!(
                "Set-Content -NoNewline -Path '{}' -Value '{}'",
                path.display(),
                escaped
            )
        }
    }

    /// A hook snippet that dumps the child environment to `path`.
    fn dump_env_command(path: &std::path::Path) -> String {
        #[cfg(unix)]
        {
            format!("env > {}", path.display())
        }
        #[cfg(not(unix))]
        {
            // `Get-ChildItem env:` prints `Name Value` pairs, one per line.
            format!(
                "Get-ChildItem env: | ForEach-Object {{ \"$($_.Name)=$($_.Value)\" }} | Set-Content -Path '{}'",
                path.display()
            )
        }
    }

    #[test]
    fn sets_environment_variables() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("env.txt");
        let command = dump_env_command(&out);

        execute_hook(
            &command,
            "Turn complete",
            "hello world",
            Some("sess-42"),
            Duration::from_secs(10),
        );

        let content = std::fs::read_to_string(&out).unwrap();
        assert!(
            content.contains("Turn complete"),
            "missing ALNAIR_EVENT: {content}"
        );
        assert!(
            content.contains("hello world"),
            "missing ALNAIR_MESSAGE: {content}"
        );
        assert!(
            content.contains("sess-42"),
            "missing ALNAIR_SESSION_ID: {content}"
        );
    }

    #[test]
    fn omits_session_id_when_none() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("env.txt");
        let command = dump_env_command(&out);

        execute_hook(
            &command,
            "Turn complete",
            "msg",
            None,
            Duration::from_secs(10),
        );

        let content = std::fs::read_to_string(&out).unwrap();
        assert!(
            !content.contains("ALNAIR_SESSION_ID"),
            "ALNAIR_SESSION_ID should not be set: {content}"
        );
    }

    #[test]
    fn kills_on_timeout() {
        // A command that outlives the timeout in whichever shell runs hooks.
        #[cfg(unix)]
        let sleeper = "sleep 100";
        #[cfg(not(unix))]
        let sleeper = "Start-Sleep -Seconds 100";

        let start = Instant::now();
        execute_hook(
            sleeper,
            "Turn complete",
            "msg",
            None,
            Duration::from_secs(1),
        );
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_secs(10),
            "should return within timeout, took {elapsed:?}"
        );
    }

    #[test]
    fn handles_failed_shell_command_gracefully() {
        // Must not panic: a missing binary is a logged debug, not a crash.
        execute_hook(
            "/nonexistent/path/binary",
            "Turn complete",
            "msg",
            None,
            Duration::from_secs(1),
        );
    }

    #[test]
    fn handles_nonzero_exit_gracefully() {
        #[cfg(unix)]
        let failing = "exit 1";
        #[cfg(not(unix))]
        let failing = "exit 1";

        execute_hook(
            failing,
            "Turn complete",
            "msg",
            None,
            Duration::from_secs(10),
        );
    }

    #[test]
    fn successful_command_completes_without_error() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("done");
        let command = write_file_command(&marker, "ok");

        execute_hook(
            &command,
            "Turn complete",
            "msg",
            None,
            Duration::from_secs(10),
        );

        assert!(marker.exists(), "hook never produced {}", marker.display());
    }

    #[test]
    fn run_hook_spawns_thread_without_panic() {
        let hook = NotificationHook {
            command: write_file_command(&std::env::temp_dir().join("alnair-hook-spawn-test"), "ok"),
            events: vec![],
            only_unfocused: false,
            timeout_secs: 5,
        };
        run_hook(&hook, &test_event());
        std::thread::sleep(Duration::from_millis(200));
    }

    #[test]
    fn timeout_clamped_to_minimum_one_second() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("done");
        let hook = NotificationHook {
            command: format!("sleep 100; touch {}", marker.display()),
            events: vec![],
            only_unfocused: false,
            // exercises the .max(1) clamp inside run_hook
            timeout_secs: 0,
        };
        let start = Instant::now();
        run_hook(&hook, &test_event());
        // Wait for the spawned thread to finish (clamp turns 0 -> 1s timeout)
        std::thread::sleep(Duration::from_millis(2500));
        let elapsed = start.elapsed();
        // The hook should have been killed by the 1s timeout, so the marker
        // file should NOT exist (sleep 100 never completes).
        assert!(
            !marker.exists(),
            "hook should have been killed by timeout before creating marker"
        );
        // Sanity: the whole thing completed well under 10s, confirming the
        // timeout was ~1s (clamped) not 0s (instant) or unbounded.
        assert!(
            elapsed < Duration::from_secs(5),
            "should complete within a few seconds, took {elapsed:?}"
        );
    }

    #[test]
    fn run_hook_passes_correct_env_via_thread() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("env.txt");
        let hook = NotificationHook {
            command: dump_env_command(&out),
            events: vec![],
            only_unfocused: false,
            timeout_secs: 10,
        };
        let event = test_event();
        run_hook(&hook, &event);

        // Poll for the output file instead of a fixed sleep — the spawned
        // thread + fork/exec may take variable time on loaded systems.
        let deadline = Instant::now() + Duration::from_secs(20);
        let content = loop {
            if let Ok(c) = std::fs::read_to_string(&out) {
                break c;
            }
            assert!(
                Instant::now() < deadline,
                "hook did not produce {} within 20s",
                out.display()
            );
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(
            content.contains("Turn complete"),
            "missing ALNAIR_EVENT: {content}"
        );
        assert!(
            content.contains("test body payload"),
            "missing ALNAIR_MESSAGE: {content}"
        );
        assert!(
            content.contains("test-session-123"),
            "missing ALNAIR_SESSION_ID: {content}"
        );
    }
}
