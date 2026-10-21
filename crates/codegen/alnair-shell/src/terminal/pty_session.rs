//! Agent-scoped interactive PTY manager. PTYs are keyed by `terminalId`,
//! outlive sessions, and multiplex I/O over the existing ACP WebSocket.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::{Arc, LazyLock};

use alnair_acp_lib::AcpAgentGatewaySender as GatewaySender;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{Mutex, mpsc};

use crate::extensions::routing::{TargetClientId, send_leader_routed_notification};
use crate::terminal::{TerminalExtError, TerminalInfo, TerminalStatus};

const NOTIFICATION_METHOD: &str = "alnair/terminal/pty/notification";
const OUTPUT_RING_BUFFER_SIZE: usize = 256 * 1024;
const OUTPUT_BATCH_INTERVAL_MS: u64 = 16;
const BUSY_POLL_INTERVAL_MS: u64 = 500;
const INPUT_CHANNEL_CAPACITY: usize = 256;

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    input_tx: mpsc::Sender<Vec<u8>>,
    output_offset: u64,
    output_ring: VecDeque<u8>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    cwd: Option<String>,
    name: Option<String>,
    created_at: u64,
    rows: u16,
    cols: u16,
    target_client_id: TargetClientId,
    /// The leader's subscriber key for the client that created this PTY.
    ///
    /// `target_client_id` is relay addressing; the leader routes on this. With
    /// several pagers sharing one leader, an untagged notification falls back
    /// to `last_active_client`, so a PTY's output could land on the wrong pager.
    leader_client_id: Option<u64>,
    busy: bool,
    gateway: GatewaySender,
}

type PtyMap = HashMap<String, Arc<Mutex<PtySession>>>;

static PTY_REGISTRY: LazyLock<Mutex<PtyMap>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub async fn get_pty(pty_id: &str) -> Option<Arc<Mutex<PtySession>>> {
    PTY_REGISTRY.lock().await.get(pty_id).cloned()
}

pub async fn require_pty(terminal_id: &str) -> Result<Arc<Mutex<PtySession>>, TerminalExtError> {
    get_pty(terminal_id)
        .await
        .ok_or_else(|| TerminalExtError::NotInteractive {
            terminal_id: terminal_id.into(),
        })
}

/// Everything the owned (restricted) spawn needs, kept separate from
/// `CommandBuilder` because portable-pty builds its `std::process::Command`
/// internally and exposes no pre-exec hook.
struct PtyLaunch<'a> {
    shell_path: &'a str,
    shell_args: &'a [String],
    cwd: Option<&'a str>,
    env: &'a HashMap<String, String>,
}

/// Spawn the child for an interactive PTY.
///
/// With child-network restriction active on Linux this owns the spawn: the
/// seccomp filter's `pre_exec` failure must abort *before* the target program
/// executes, and portable-pty's `spawn_command` offers no hook. Everywhere else
/// — and on Linux when no restriction is in effect — portable-pty's ceremony
/// runs unchanged, so unrestricted behavior is byte-identical to before.
fn spawn_pty_child(
    slave: &dyn portable_pty::SlavePty,
    master: &dyn portable_pty::MasterPty,
    builder: CommandBuilder,
    launch: &PtyLaunch<'_>,
) -> Result<Box<dyn portable_pty::Child + Send + Sync>, TerminalExtError> {
    #[cfg(target_os = "linux")]
    if alnair_sandbox::child_net::child_network_restricted() {
        return spawn_restricted_pty_child(master, launch).map_err(TerminalExtError::Internal);
    }
    let _ = launch;
    slave
        .spawn_command(builder)
        .map_err(|e| TerminalExtError::Internal(format!("failed to spawn shell: {e}")))
}

/// Owned PTY spawn used only while child-network restriction is active.
///
/// Replicates portable-pty's unix `spawn_command` ceremony (signal reset,
/// `setsid`, `TIOCSCTTY`, random-fd cleanup, umask) because that ceremony is
/// private to the crate, and adds the shared seccomp installation as the final
/// `pre_exec` step. A filter-installation failure is reported back through a
/// pipe (async-signal-safe `write`) so the caller can name the real reason
/// instead of a generic spawn error.
#[cfg(target_os = "linux")]
fn spawn_restricted_pty_child(
    master: &dyn portable_pty::MasterPty,
    launch: &PtyLaunch<'_>,
) -> Result<Box<dyn portable_pty::Child + Send + Sync>, String> {
    use std::os::unix::process::CommandExt;

    let tty_path = master.tty_name().ok_or_else(|| {
        "cannot install the child network filter: the PTY slave path is unavailable".to_string()
    })?;

    let open_slave = || {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&tty_path)
    };
    let stdin = open_slave().map_err(|e| format!("failed to open pty slave for stdin: {e}"))?;
    let stdout = open_slave().map_err(|e| format!("failed to open pty slave for stdout: {e}"))?;
    let stderr = open_slave().map_err(|e| format!("failed to open pty slave for stderr: {e}"))?;

    let mut cmd = std::process::Command::new(launch.shell_path);
    cmd.args(launch.shell_args);
    if let Some(dir) = launch.cwd {
        cmd.current_dir(dir);
    }
    // portable-pty's `as_command` clears the environment and re-adds `SHELL`
    // plus the builder's envs; mirror that so the child sees the same env.
    cmd.env_clear();
    cmd.env("SHELL", launch.shell_path);
    cmd.envs(launch.env);
    cmd.stdin(stdin).stdout(stdout).stderr(stderr);

    let mut stage_fds = [0 as libc::c_int; 2];
    // SAFETY: `pipe` writes two valid fds into the array on success.
    if unsafe { libc::pipe(stage_fds.as_mut_ptr()) } != 0 {
        return Err(format!(
            "failed to create the spawn stage pipe: {}",
            std::io::Error::last_os_error()
        ));
    }
    // Non-blocking so a stuck read can never wedge PTY creation; the write end
    // is closed by the parent right after `spawn`, so EOF is guaranteed.
    // SAFETY: both fds are freshly created and owned by this function.
    unsafe {
        let flags = libc::fcntl(stage_fds[0], libc::F_GETFL);
        if flags == -1 || libc::fcntl(stage_fds[0], libc::F_SETFL, flags | libc::O_NONBLOCK) == -1 {
            libc::close(stage_fds[0]);
            libc::close(stage_fds[1]);
            return Err(format!(
                "failed to configure the spawn stage pipe: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    /// Owns a raw fd and closes it on drop so early returns cannot leak.
    struct RawFdGuard(libc::c_int);
    impl Drop for RawFdGuard {
        fn drop(&mut self) {
            // SAFETY: the guard owns this fd exclusively.
            unsafe { libc::close(self.0) };
        }
    }
    let stage_read = RawFdGuard(stage_fds[0]);
    let stage_write = RawFdGuard(stage_fds[1]);
    let stage_write_fd = stage_write.0;

    // SAFETY: every call below is async-signal-safe (signal/sigprocmask/setsid/
    // ioctl/close/umask/prctl/write), which is what a post-fork pre-exec
    // context requires.
    unsafe {
        cmd.pre_exec(move || {
            for signo in &[
                libc::SIGCHLD,
                libc::SIGHUP,
                libc::SIGINT,
                libc::SIGQUIT,
                libc::SIGTERM,
                libc::SIGALRM,
            ] {
                libc::signal(*signo, libc::SIG_DFL);
            }
            let empty_set: libc::sigset_t = std::mem::zeroed();
            libc::sigprocmask(libc::SIG_SETMASK, &empty_set, std::ptr::null_mut());

            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            #[allow(clippy::cast_lossless)]
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            // Install BEFORE the fd sweep: `close_random_fds` closes every fd
            // above 2, which would take the stage pipe with it and leave the
            // parent unable to name the filter as the failure reason. `close`
            // is not in the blocked syscall set, so ordering it after the
            // filter is still legal.
            //
            // The one shared installation routine. On failure it records the
            // stage so the parent can name the filter as the reason, then
            // aborts the exec — the child never runs the target program.
            alnair_sandbox::child_net::install_and_stage(Some(stage_write_fd))?;

            portable_pty::unix::close_random_fds();
            Ok(())
        });
    }

    let spawned = cmd.spawn();
    drop(stage_write);

    match spawned {
        Ok(child) => Ok(Box::new(child)),
        Err(e) => {
            let mut buf = [0u8; 1];
            // SAFETY: `stage_read` is a valid owned fd; the buffer is one byte.
            let staged = unsafe { libc::read(stage_read.0, buf.as_mut_ptr().cast(), buf.len()) };
            if staged == 1 && buf[0] == STAGE_FILTER_FAILED {
                Err(alnair_sandbox::child_net::installation_failure_message(&e))
            } else {
                Err(format!("failed to spawn shell: {e}"))
            }
        }
    }
}

/// Stage byte the child writes when the seccomp filter could not be installed.
#[cfg(target_os = "linux")]
const STAGE_FILTER_FAILED: u8 = b'F';

pub async fn create_pty(
    shell: Option<&str>,
    cwd: Option<&str>,
    env: HashMap<String, String>,
    rows: u16,
    cols: u16,
    name: Option<&str>,
    gateway: GatewaySender,
    target_client_id: TargetClientId,
    leader_client_id: Option<u64>,
) -> Result<String, TerminalExtError> {
    let pty_id = uuid::Uuid::now_v7().to_string();

    let pty_system = native_pty_system();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| TerminalExtError::Internal(format!("failed to open pty: {e}")))?;

    let (shell_path, shell_args) = resolve_pty_shell(shell);

    let mut cmd = CommandBuilder::new(&shell_path);
    for arg in &shell_args {
        cmd.arg(arg);
    }

    if let Some(dir) = cwd {
        cmd.cwd(dir);
    } else if let Ok(dir) = std::env::current_dir() {
        cmd.cwd(dir);
    }

    for (k, v) in &env {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("LC_ALL", "en_US.UTF-8");

    let child = spawn_pty_child(
        pair.slave.as_ref(),
        pair.master.as_ref(),
        cmd,
        &PtyLaunch {
            shell_path: &shell_path,
            shell_args: &shell_args,
            cwd,
            env: &env,
        },
    )?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| TerminalExtError::Internal(format!("failed to clone pty reader: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| TerminalExtError::Internal(format!("failed to take pty writer: {e}")))?;

    let (input_tx, input_rx) = mpsc::channel(INPUT_CHANNEL_CAPACITY);
    spawn_pty_input_loop(writer, input_rx);

    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let resolved_cwd = cwd.map(|s| s.to_string()).or_else(|| {
        std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    });

    let resolved_name = name.map(|s| s.to_string()).or_else(|| {
        // Default to cwd basename, fall back to shell basename.
        resolved_cwd
            .as_deref()
            .and_then(|p| {
                std::path::Path::new(p)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
            })
            .or_else(|| {
                std::path::Path::new(&shell_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
            })
    });

    let session = PtySession {
        master: pair.master,
        input_tx,
        output_offset: 0,
        output_ring: VecDeque::with_capacity(OUTPUT_RING_BUFFER_SIZE),
        child,
        cwd: resolved_cwd,
        name: resolved_name,
        created_at,
        rows,
        cols,
        target_client_id,
        leader_client_id,
        busy: false,
        gateway: gateway.clone(),
    };

    let entry = Arc::new(Mutex::new(session));
    PTY_REGISTRY
        .lock()
        .await
        .insert(pty_id.clone(), entry.clone());

    let pty_id_clone = pty_id.clone();
    tokio::task::spawn_local(run_pty_output_loop(reader, entry, pty_id_clone, gateway));

    Ok(pty_id)
}

fn spawn_pty_input_loop(mut writer: Box<dyn Write + Send>, mut input_rx: mpsc::Receiver<Vec<u8>>) {
    tokio::task::spawn_blocking(move || {
        while let Some(mut chunk) = input_rx.blocking_recv() {
            while let Ok(more) = input_rx.try_recv() {
                chunk.extend_from_slice(&more);
            }
            // The write is the last hop before the shell sees a keystroke.
            // Logging the failure (rather than breaking silently) tells a
            // "shell ignores input" report apart from a dead master fd.
            if let Err(e) = writer.write_all(&chunk) {
                alnair_log::unified_log::warn(
                    "pty.input.write_failed",
                    None,
                    Some(serde_json::json!({ "error": e.to_string() })),
                );
                break;
            }
            if let Err(e) = writer.flush() {
                alnair_log::unified_log::warn(
                    "pty.input.flush_failed",
                    None,
                    Some(serde_json::json!({ "error": e.to_string() })),
                );
                break;
            }
            alnair_log::unified_log::debug(
                "pty.input.written",
                None,
                Some(serde_json::json!({ "bytes": chunk.len() })),
            );
        }
        alnair_log::unified_log::warn("pty.input_loop.closed", None, None);
    });
}

/// Reads PTY output, batches on a 16ms tick, and sends notifications.
/// Also samples the foreground process group on a slower tick and pushes
/// `process_started`/`process_ended` on idle↔busy transitions — time-based
/// rather than output-driven because a busy process can be silent.
async fn run_pty_output_loop(
    reader: Box<dyn Read + Send>,
    pty: Arc<Mutex<PtySession>>,
    pty_id: String,
    gateway: GatewaySender,
) {
    use tokio::sync::mpsc;
    use tokio::time::{Duration, interval};

    let (data_tx, mut data_rx) = mpsc::channel::<Vec<u8>>(64);
    let reader_pty_id = pty_id.clone();

    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // The PTY master hit EOF: the child side is fully closed.
                    // Without this line a dead shell is indistinguishable from
                    // one that simply printed nothing.
                    alnair_log::unified_log::warn(
                        "pty.reader.eof",
                        None,
                        Some(serde_json::json!({ "terminal_id": reader_pty_id })),
                    );
                    break;
                }
                Ok(n) => {
                    if data_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        alnair_log::unified_log::warn(
                            "pty.reader.send_failed",
                            None,
                            Some(serde_json::json!({ "terminal_id": reader_pty_id })),
                        );
                        break;
                    }
                }
                Err(e) => {
                    alnair_log::unified_log::warn(
                        "pty.reader.error",
                        None,
                        Some(serde_json::json!({
                            "terminal_id": reader_pty_id,
                            "error": e.to_string(),
                        })),
                    );
                    break;
                }
            }
        }
    });

    let mut pending = Vec::new();
    let mut tick = interval(Duration::from_millis(OUTPUT_BATCH_INTERVAL_MS));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut busy_tick = interval(Duration::from_millis(BUSY_POLL_INTERVAL_MS));
    busy_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            chunk = data_rx.recv() => {
                match chunk {
                    Some(data) => {
                        {
                            let mut session = pty.lock().await;
                            session.output_ring.extend(data.iter().copied());
                            if session.output_ring.len() > OUTPUT_RING_BUFFER_SIZE {
                                let excess = session.output_ring.len() - OUTPUT_RING_BUFFER_SIZE;
                                session.output_ring.drain(..excess);
                            }
                            session.output_offset += data.len() as u64;
                        }
                        // Every byte the shell emits passes here. Logging the
                        // chunk (not the flush) separates "the shell is silent"
                        // from "the flush never runs" — the two causes of a
                        // blank pane that look identical from outside.
                        alnair_log::unified_log::debug(
                            "pty.output.chunk",
                            None,
                            Some(serde_json::json!({
                                "terminal_id": pty_id,
                                "bytes": data.len(),
                            })),
                        );
                        pending.extend_from_slice(&data);
                    }
                    None => {
                        if !pending.is_empty() {
                            flush_output(&pty, &pty_id, &mut pending, &gateway).await;
                        }
                        // `data_rx` closed: the reader task ended (see the
                        // `pty.reader.*` line that precedes this one for why).
                        alnair_log::unified_log::warn(
                            "pty.output_loop.channel_closed",
                            None,
                            Some(serde_json::json!({ "terminal_id": pty_id })),
                        );
                        break;
                    }
                }
            }

            _ = tick.tick() => {
                if !pending.is_empty() {
                    flush_output(&pty, &pty_id, &mut pending, &gateway).await;
                }
            }

            _ = busy_tick.tick() => {
                sample_busy_transition(&pty, &pty_id).await;
            }
        }
    }

    // Child exited
    let (exit_code, signal, target_client_id, leader_client_id, was_busy) =
        tokio::task::spawn_blocking({
            let pty = pty.clone();
            move || {
                let mut session = pty.blocking_lock();
                let target_client_id = session.target_client_id.clone();
                let leader_client_id = session.leader_client_id;
                let was_busy = session.busy;
                match session.child.wait() {
                    Ok(es) => (
                        Some(es.exit_code() as i32),
                        None::<String>,
                        target_client_id,
                        leader_client_id,
                        was_busy,
                    ),
                    Err(_) => (None, None, target_client_id, leader_client_id, was_busy),
                }
            }
        })
        .await
        .unwrap_or_default();

    if was_busy {
        send_busy_notification(
            &pty_id,
            false,
            &target_client_id,
            &gateway,
            leader_client_id,
        );
    }

    send_leader_routed_notification(
        &gateway,
        NOTIFICATION_METHOD,
        serde_json::json!({
            "terminalId": pty_id,
            "type": "exit",
            "exitCode": exit_code,
            "signal": signal,
        }),
        &target_client_id,
        leader_client_id,
    );
}

/// Whether the PTY's controlling terminal has a foreground process group
/// distinct from the shell itself — i.e. a command is actively running
/// rather than the shell sitting idle at its prompt.
///
/// `process_group_leader()` issues `tcgetpgrp` on the master fd; an idle
/// shell is its own foreground process group, so it matches the shell
/// child's pid. When a command runs in the foreground the kernel reports
/// that command's process group instead. Returns false when the value is
/// unavailable (the shell exited or runs without job control).
///
/// Limitation: a shell that `exec`s a program in place keeps the same pid and
/// pgid, so `tcgetpgrp` still matches the recorded child pid and the program
/// reads as idle. Telling that apart from a real idle prompt needs per-OS
/// process inspection, so a command launched the usual way (fork then exec) is
/// detected while an `exec`-replaced shell is not.
#[cfg(unix)]
fn session_has_foreground_process(session: &PtySession) -> bool {
    let Some(foreground_pgid) = session.master.process_group_leader() else {
        return false;
    };
    match session.child.process_id() {
        Some(shell_pid) => i64::from(foreground_pgid) != i64::from(shell_pid),
        None => false,
    }
}

/// `tcgetpgrp` has no ConPTY equivalent (`process_group_leader` is
/// unix-only in portable-pty), so non-unix PTYs never report a foreground
/// process and clients close terminals without confirmation.
#[cfg(not(unix))]
fn session_has_foreground_process(_session: &PtySession) -> bool {
    false
}

/// Emits `process_started` / `process_ended` only on idle↔busy transitions so
/// a steady state never repeats notifications.
async fn sample_busy_transition(pty: &Arc<Mutex<PtySession>>, pty_id: &str) {
    let mut session = pty.lock().await;
    let now_busy = session_has_foreground_process(&session);
    if now_busy == session.busy {
        return;
    }
    session.busy = now_busy;
    send_busy_notification(
        pty_id,
        now_busy,
        &session.target_client_id,
        &session.gateway,
        session.leader_client_id,
    );
}

fn send_busy_notification(
    pty_id: &str,
    busy: bool,
    target_client_id: &TargetClientId,
    gateway: &GatewaySender,
    leader_client_id: Option<u64>,
) {
    send_leader_routed_notification(
        gateway,
        NOTIFICATION_METHOD,
        serde_json::json!({
            "terminalId": pty_id,
            "type": if busy { "process_started" } else { "process_ended" },
        }),
        target_client_id,
        leader_client_id,
    );
}

async fn flush_output(
    pty: &Arc<Mutex<PtySession>>,
    pty_id: &str,
    pending: &mut Vec<u8>,
    gateway: &GatewaySender,
) {
    use base64::Engine as _;

    let (output_offset, target_client_id, leader_client_id) = {
        let session = pty.lock().await;
        (
            session.output_offset,
            session.target_client_id.clone(),
            session.leader_client_id,
        )
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&*pending);
    pending.clear();

    send_leader_routed_notification(
        gateway,
        NOTIFICATION_METHOD,
        serde_json::json!({
            "terminalId": pty_id,
            "type": "output",
            "data": b64,
            "outputOffset": output_offset,
        }),
        &target_client_id,
        leader_client_id,
    );
}

pub async fn write_pty_input(pty_id: &str, data: &[u8]) -> Result<(), TerminalExtError> {
    let entry = require_pty(pty_id).await?;
    let input_tx = { entry.lock().await.input_tx.clone() };
    input_tx
        .send(data.to_vec())
        .await
        .map_err(|_| TerminalExtError::InputClosed {
            terminal_id: pty_id.into(),
        })?;
    sample_busy_transition(&entry, pty_id).await;
    Ok(())
}

pub async fn resize_pty(pty_id: &str, rows: u16, cols: u16) -> Result<(), TerminalExtError> {
    let entry = require_pty(pty_id).await?;
    let mut session = entry.lock().await;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| TerminalExtError::Internal(format!("failed to resize pty: {e}")))?;
    session.rows = rows;
    session.cols = cols;
    Ok(())
}

pub async fn is_exited(pty_id: &str) -> bool {
    match get_pty(pty_id).await {
        Some(entry) => entry.lock().await.child.try_wait().ok().flatten().is_some(),
        None => true,
    }
}

pub async fn close_pty(pty_id: &str) -> Result<(), String> {
    if let Some(entry) = PTY_REGISTRY.lock().await.remove(pty_id) {
        tokio::task::spawn_blocking(move || {
            let mut session = entry.blocking_lock();
            let _ = session.child.kill();
            let _ = session.child.wait();
        })
        .await
        .map_err(|e| format!("close task failed: {e}"))?;
    }
    Ok(())
}

/// Called on agent disconnect to clean up all PTYs.
pub async fn close_all() {
    let entries: Vec<Arc<Mutex<PtySession>>> = {
        let mut reg = PTY_REGISTRY.lock().await;
        reg.drain().map(|(_, v)| v).collect()
    };
    for entry in entries {
        let _ = tokio::task::spawn_blocking(move || {
            let mut session = entry.blocking_lock();
            let _ = session.child.kill();
            let _ = session.child.wait();
        })
        .await;
    }
}

/// Resolve the shell binary and arguments for an interactive PTY session.
///
/// Priority: explicit `shell` param > `$SHELL` env > platform default.
/// On Windows falls back to the `detect_windows_shell` cascade
/// (pwsh > powershell.exe > Git Bash > cmd.exe, overridable via
/// `ALNAIR_SHELL`) since `$SHELL` is absent.
fn resolve_pty_shell(shell: Option<&str>) -> (String, Vec<String>) {
    if let Some(s) = shell {
        return (s.to_string(), vec![]);
    }

    #[cfg(unix)]
    {
        let path = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        (path, vec!["-l".to_string()])
    }

    #[cfg(not(unix))]
    {
        use alnair_config::shell::{WindowsShell, detect_windows_shell};
        match detect_windows_shell() {
            WindowsShell::GitBash(path) => (path.clone(), vec!["-l".to_string()]),
            WindowsShell::Pwsh => ("pwsh".to_string(), vec!["-NoLogo".to_string()]),
            WindowsShell::PowerShell => ("powershell.exe".to_string(), vec!["-NoLogo".to_string()]),
            WindowsShell::Cmd => ("cmd.exe".to_string(), vec![]),
        }
    }
}

pub async fn list_ptys() -> Vec<TerminalInfo> {
    let entries: Vec<(String, Arc<Mutex<PtySession>>)> = {
        let reg = PTY_REGISTRY.lock().await;
        reg.iter()
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect()
    };

    let mut result = Vec::with_capacity(entries.len());
    for (id, entry) in entries {
        let mut session = entry.lock().await;
        let (status, exit_code) = match session.child.try_wait() {
            Ok(Some(es)) => (TerminalStatus::Exited, Some(es.exit_code() as i32)),
            Ok(None) => (TerminalStatus::Connected, None),
            Err(_) => (TerminalStatus::Error, None),
        };
        result.push(TerminalInfo {
            terminal_id: id,
            status,
            interactive: true,
            name: session.name.clone(),
            exit_code,
            cwd: session.cwd.clone(),
            output_offset: session.output_offset,
            created_at: session.created_at,
        });
    }
    result
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyLoadResult {
    pub terminal_id: String,
    pub rows: u16,
    pub cols: u16,
    pub exited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// Reconnect to a PTY. Replays the full ring buffer (with `isReplay: true`)
/// so the client can reset its VTE emulator and feed all bytes from scratch.
/// Exited PTYs are still loadable so the client can see final output.
///
/// Updates the stored `target_client_id` and `leader_client_id` so that
/// subsequent output notifications are routed to the reconnecting client.
pub async fn load(
    pty_id: &str,
    gateway: &GatewaySender,
    target_client_id: TargetClientId,
    leader_client_id: Option<u64>,
) -> Result<PtyLoadResult, TerminalExtError> {
    let entry = require_pty(pty_id).await?;
    let (replay, output_offset, exit_info, rows, cols, busy) = {
        let mut session = entry.lock().await;
        session.target_client_id = target_client_id.clone();
        // Only adopt a leader id when the reconnecting request carries one.
        // Blindly assigning would clear it on every reload, and a PTY whose
        // output loses its owner falls back to `last_active_client` — the wrong
        // pager as soon as a second one connects.
        if leader_client_id.is_some() {
            session.leader_client_id = leader_client_id;
        }
        let exit_info = session
            .child
            .try_wait()
            .ok()
            .flatten()
            .map(|es| es.exit_code() as i32);
        let busy = session_has_foreground_process(&session);
        session.busy = busy;
        (
            session.output_ring.iter().copied().collect::<Vec<u8>>(),
            session.output_offset,
            exit_info,
            session.rows,
            session.cols,
            busy,
        )
    };

    if !replay.is_empty() {
        use base64::Engine as _;
        send_leader_routed_notification(
            gateway,
            NOTIFICATION_METHOD,
            serde_json::json!({
                "terminalId": pty_id,
                "type": "output",
                "data": base64::engine::general_purpose::STANDARD.encode(&replay),
                "outputOffset": output_offset,
                "isReplay": true,
            }),
            &target_client_id,
            leader_client_id,
        );
    }

    let exited = exit_info.is_some();
    if exited {
        send_leader_routed_notification(
            gateway,
            NOTIFICATION_METHOD,
            serde_json::json!({
                "terminalId": pty_id,
                "type": "exit",
                "exitCode": exit_info,
                "isReplay": true,
            }),
            &target_client_id,
            leader_client_id,
        );
    } else {
        send_busy_notification(pty_id, busy, &target_client_id, gateway, leader_client_id);
    }

    Ok(PtyLoadResult {
        terminal_id: pty_id.to_string(),
        rows,
        cols,
        exited,
        exit_code: exit_info,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::Duration;

    use agent_client_protocol as acp;
    use alnair_acp_lib::acp_gateway;

    type RecordedNotifications = Rc<RefCell<Vec<(String, serde_json::Value)>>>;

    struct RecordingClient {
        notifications: RecordedNotifications,
    }

    #[async_trait::async_trait(?Send)]
    impl acp::Client for RecordingClient {
        async fn request_permission(
            &self,
            _: acp::RequestPermissionRequest,
        ) -> acp::Result<acp::RequestPermissionResponse> {
            unimplemented!()
        }

        async fn session_notification(&self, _: acp::SessionNotification) -> acp::Result<()> {
            Ok(())
        }

        async fn ext_notification(&self, args: acp::ExtNotification) -> acp::Result<()> {
            let params: serde_json::Value =
                serde_json::from_str(args.params.get()).unwrap_or_default();
            self.notifications
                .borrow_mut()
                .push((args.method.to_string(), params));
            Ok(())
        }
    }

    fn recording_gateway() -> (GatewaySender, RecordedNotifications) {
        let notifications: RecordedNotifications = Rc::new(RefCell::new(Vec::new()));
        let (sender, receiver) = acp_gateway::<acp::AgentSide, _>(RecordingClient {
            notifications: notifications.clone(),
        });
        tokio::task::spawn_local(receiver.run());
        (sender, notifications)
    }

    async fn create_test_pty(gateway: GatewaySender) -> String {
        let env = HashMap::from([("ENV".to_string(), String::new())]);
        create_pty(
            Some("/bin/sh"),
            None,
            env,
            24,
            80,
            None,
            gateway,
            TargetClientId::None,
        )
        .await
        .expect("create test pty")
    }

    fn busy_event_types(notifications: &RecordedNotifications, pty_id: &str) -> Vec<String> {
        notifications
            .borrow()
            .iter()
            .filter(|(method, params)| {
                method == NOTIFICATION_METHOD && params["terminalId"] == pty_id
            })
            .filter_map(|(_, params)| match params["type"].as_str() {
                Some(t @ ("process_started" | "process_ended")) => Some(t.to_string()),
                _ => None,
            })
            .collect()
    }

    async fn wait_for_busy_events(
        notifications: &RecordedNotifications,
        pty_id: &str,
        expected: &[&str],
        deadline: Duration,
    ) -> Vec<String> {
        let started = tokio::time::Instant::now();
        loop {
            let events = busy_event_types(notifications, pty_id);
            if events == expected {
                return events;
            }
            if started.elapsed() > deadline {
                return events;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    // Every test below spawns a PTY and therefore consults the process-global
    // child-network restriction flag. Serialize them so a test that forces the
    // flag (or forces an installation failure) cannot leak into a sibling that
    // is mid-spawn.
    const PTY_CHILD_NET: &str = "pty_child_net";

    /// Restores the restriction decision and the forced-failure switch on drop,
    /// including when an assertion panics — otherwise one failing test would
    /// poison every later one in the same binary.
    struct ChildNetOverride {
        fail_install: bool,
    }

    impl ChildNetOverride {
        fn apply(restriction: bool, fail_install: bool) -> Self {
            alnair_sandbox::test_support::force_restriction(restriction);
            alnair_sandbox::child_net::force_installation_failure(fail_install);
            Self { fail_install }
        }
    }

    impl Drop for ChildNetOverride {
        fn drop(&mut self) {
            alnair_sandbox::test_support::clear_forced_restriction();
            if self.fail_install {
                alnair_sandbox::child_net::force_installation_failure(false);
            }
        }
    }

    #[tokio::test]
    #[serial_test::serial(PTY_CHILD_NET)]
    async fn long_running_command_emits_balanced_started_then_ended_pair() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (gateway, notifications) = recording_gateway();
                let pty_id = create_test_pty(gateway).await;

                write_pty_input(&pty_id, b"sleep 2\n")
                    .await
                    .expect("write command");

                let after_start = wait_for_busy_events(
                    &notifications,
                    &pty_id,
                    &["process_started"],
                    Duration::from_secs(10),
                )
                .await;
                assert_eq!(after_start, vec!["process_started"]);

                let after_end = wait_for_busy_events(
                    &notifications,
                    &pty_id,
                    &["process_started", "process_ended"],
                    Duration::from_secs(10),
                )
                .await;
                assert_eq!(after_end, vec!["process_started", "process_ended"]);

                close_pty(&pty_id).await.expect("close pty");
            })
            .await;
    }

    #[tokio::test]
    #[serial_test::serial(PTY_CHILD_NET)]
    async fn idle_shell_emits_no_busy_notifications() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (gateway, notifications) = recording_gateway();
                let pty_id = create_test_pty(gateway).await;

                tokio::time::sleep(Duration::from_millis(BUSY_POLL_INTERVAL_MS * 3)).await;

                assert_eq!(
                    busy_event_types(&notifications, &pty_id),
                    Vec::<String>::new()
                );

                close_pty(&pty_id).await.expect("close pty");
            })
            .await;
    }

    /// Decoded `output` notifications for `pty_id`, oldest first.
    fn decoded_output(notifications: &RecordedNotifications, pty_id: &str) -> Vec<u8> {
        use base64::Engine as _;
        notifications
            .borrow()
            .iter()
            .filter(|(method, params)| {
                method == NOTIFICATION_METHOD
                    && params["terminalId"] == pty_id
                    && params["type"] == "output"
            })
            .filter_map(|(_, params)| {
                params["data"]
                    .as_str()
                    .and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
            })
            .flatten()
            .collect()
    }

    /// Poll the decoded PTY output until `needle` appears or the deadline passes.
    async fn wait_for_output(
        notifications: &RecordedNotifications,
        pty_id: &str,
        needle: &str,
        deadline: Duration,
    ) -> String {
        let started = tokio::time::Instant::now();
        loop {
            let text = String::from_utf8_lossy(&decoded_output(notifications, pty_id)).to_string();
            if text.contains(needle) {
                return text;
            }
            if started.elapsed() > deadline {
                return text;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Run `command` in a fresh PTY and return everything the shell printed.
    ///
    /// Drives the real `create_pty` entry point; the only test-only input is the
    /// restriction decision itself, which cannot be flipped by applying an
    /// irreversible kernel sandbox.
    async fn run_command_in_pty(command: &str) -> String {
        let (gateway, notifications) = recording_gateway();
        let env = HashMap::from([("ENV".to_string(), String::new())]);
        let pty_id = create_pty(
            Some("/bin/sh"),
            None,
            env,
            24,
            80,
            None,
            gateway,
            TargetClientId::None,
        )
        .await
        .expect("create pty");

        write_pty_input(&pty_id, format!("{command}\n").as_bytes())
            .await
            .expect("write command");
        // The PTY echoes whatever is typed, so a plain `echo __DONE__` matches
        // the echo before the command has even run. Splitting the literal makes
        // the echoed form (`__DO""NE__`) differ from the printed form, so a
        // match can only come from the shell actually executing the sentinel.
        write_pty_input(&pty_id, b"echo __DO\"\"NE__\n")
            .await
            .expect("write sentinel");

        let output =
            wait_for_output(&notifications, &pty_id, "__DONE__", Duration::from_secs(20)).await;
        close_pty(&pty_id).await.expect("close pty");
        output
    }

    /// Restricted: the seccomp filter is really installed, so an egress attempt
    /// inside the PTY is denied by the kernel rather than by test logic.
    #[tokio::test]
    #[serial_test::serial(PTY_CHILD_NET)]
    async fn restricted_pty_denies_network_egress() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let _guard = ChildNetOverride::apply(true, false);
                // A marker the command would create if it ever ran past the
                // denied connect. Its absence proves the block, not a crash.
                let output = run_command_in_pty(
                    "python3 -c 'import socket;\
                     socket.create_connection((\"127.0.0.1\", 1), timeout=2)' 2>&1 \
                     || echo __EGRESS_DENIED__",
                )
                .await;
                drop(_guard);

                assert!(
                    output.contains("__EGRESS_DENIED__"),
                    "restricted PTY must deny egress; got: {output}"
                );
                // EPERM surfaces as "Operation not permitted" from Python.
                assert!(
                    output.to_lowercase().contains("permitted")
                        || output.contains("PermissionError")
                        || output.contains("EPERM"),
                    "the denial must be the kernel's EPERM, not a Python-side error; got: {output}"
                );
            })
            .await;
    }

    /// Unrestricted: the same PTY still spawns a shell and streams real output.
    #[tokio::test]
    #[serial_test::serial(PTY_CHILD_NET)]
    async fn unrestricted_pty_runs_normally() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let _guard = ChildNetOverride::apply(false, false);
                let output = run_command_in_pty("echo __PTY_OK__").await;
                drop(_guard);

                assert!(
                    output.contains("__PTY_OK__"),
                    "unrestricted PTY must run the command; got: {output}"
                );
            })
            .await;
    }

    /// The restricted spawn owns its own ceremony, so it must still hand the
    /// child the environment `portable-pty` would have: inherited variables
    /// plus `SHELL`. A cleared env here would silently drop PATH/HOME/locale.
    #[tokio::test]
    #[serial_test::serial(PTY_CHILD_NET)]
    async fn restricted_pty_inherits_the_parent_environment() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let _guard = ChildNetOverride::apply(true, false);
                let output = run_command_in_pty("echo PATH_IS=$PATH; echo HOME_IS=$HOME").await;
                drop(_guard);

                assert!(
                    !output.contains("PATH_IS=\r") && !output.contains("PATH_IS=\n"),
                    "restricted PTY must inherit PATH; got: {output}"
                );
                assert!(
                    !output.contains("HOME_IS=\r") && !output.contains("HOME_IS=\n"),
                    "restricted PTY must inherit HOME; got: {output}"
                );
                assert!(
                    output.contains("PATH_IS=/"),
                    "PATH must be a real search path; got: {output}"
                );
            })
            .await;
    }

    /// Fail-closed: when the filter cannot be installed, `create_pty` returns an
    /// error naming the filter, and the command never produces its side effect.
    #[tokio::test]
    #[serial_test::serial(PTY_CHILD_NET)]
    async fn refused_pty_creation_never_runs_the_command() {
        use std::os::unix::fs::PermissionsExt;

        tokio::task::LocalSet::new()
            .run_until(async {
                let dir = tempfile::TempDir::new().expect("tempdir");
                let marker = dir.path().join("child-ran");
                // A real executable that records its own execution. `create_pty`
                // spawns this as the "shell", so `marker` existing proves the
                // child actually executed — the side effect the refusal must
                // prevent.
                let script = dir.path().join("would-be-shell");
                std::fs::write(
                    &script,
                    format!("#!/bin/sh\ntouch '{}'\nexec /bin/sh\n", marker.display()),
                )
                .expect("write script");
                std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                    .expect("chmod script");

                let _guard = ChildNetOverride::apply(true, true);

                let (gateway, _notifications) = recording_gateway();
                let env = HashMap::from([("ENV".to_string(), String::new())]);
                let result = create_pty(
                    Some(script.to_str().expect("utf8 path")),
                    None,
                    env,
                    24,
                    80,
                    None,
                    gateway,
                    TargetClientId::None,
                )
                .await;

                drop(_guard);

                let err = result.expect_err("refused PTY creation must not report success");
                let msg = err.to_string();
                assert!(
                    msg.contains("seccomp filter could not be installed"),
                    "the error must name the filter as the reason; got: {msg}"
                );
                assert!(
                    msg.contains("refusing to spawn an unfiltered child"),
                    "the error must state the fail-closed policy; got: {msg}"
                );
                // The decisive observation: the child never executed.
                assert!(
                    !marker.exists(),
                    "the target command must not run when the filter is refused"
                );
            })
            .await;
    }
}
