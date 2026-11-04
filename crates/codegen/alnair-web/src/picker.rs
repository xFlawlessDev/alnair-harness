//! A native directory chooser, for "add workspace".
//!
//! The browser cannot answer this question. `showDirectoryPicker()` yields a
//! handle whose `name` is a leaf, never an absolute path — and the agent needs
//! an absolute path to open a session in. `<input webkitdirectory>` has the
//! same limitation. So the dialog runs on the machine serving the page, which
//! for `alnair web` is the user's own desktop.
//!
//! Three constraints shape this module:
//!
//! - **One dialog at a time.** Two stacked native windows would hide the first
//!   and leave a request hanging; a second call is refused instead.
//! - **Bounded.** A dialog nobody answers must not pin a request forever, and
//!   the child is killed when the wait ends.
//! - **Never blocks the runtime.** The chooser is a process, awaited
//!   asynchronously; nothing here touches the async threads synchronously.
//!
//! The endpoint is gated by the same cookie + `Origin` check as `/ws`
//! (`server.rs`), because a page on another origin could otherwise pop a modal
//! dialog on the user's desktop.

use std::process::Stdio;

use tokio::process::Command;
use tokio::sync::Mutex;
use tracing::debug;

/// How long a dialog may stay open before it is abandoned and killed.
///
/// Generous on purpose: picking a directory is a human action, and a workspace
/// can sit several levels deep. The bound exists so an abandoned dialog cannot
/// wedge the endpoint forever, not to rush anyone.
const DIALOG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// The title every platform's dialog shows.
const TITLE: &str = "Select a workspace directory";

/// Why a pick did not produce a path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PickError {
    /// A dialog is already open; native dialogs cannot be stacked safely.
    Busy,
    /// This platform has no usable chooser (a headless server, or a missing
    /// `zenity`/`kdialog`). The caller offers a typed path instead.
    Unavailable(String),
    /// The chooser ran and failed.
    Failed(String),
}

impl PickError {
    /// The message the browser shows. No paths, no command lines: this is
    /// surfaced to a page.
    pub fn message(&self) -> &str {
        match self {
            Self::Busy => "a folder picker is already open",
            Self::Unavailable(_) => "no native folder picker is available on this machine",
            Self::Failed(_) => "the folder picker failed",
        }
    }
}

/// One dialog at a time, process-wide.
///
/// `try_lock` rather than `lock`: waiting would queue requests behind a dialog
/// the user may never answer, and each waiter would eventually spawn its own
/// window. Refusing is the honest answer.
static OPEN: Mutex<()> = Mutex::const_new(());

/// Ask the user for a directory. `Ok(None)` means they cancelled.
pub async fn pick_directory() -> Result<Option<String>, PickError> {
    let guard = OPEN.try_lock().map_err(|_| PickError::Busy)?;

    let result = run_chooser().await;
    drop(guard);
    result
}

/// The command to run on this platform, if one exists.
///
/// Split out so the construction is testable without spawning anything.
#[derive(Debug, PartialEq, Eq)]
struct ChooserCommand {
    program: String,
    args: Vec<String>,
}

impl ChooserCommand {
    fn new(program: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            program: program.into(),
            args,
        }
    }
}

/// The first candidate for this platform.
///
/// Windows and Linux each have two, and the second is only tried when the first
/// is not installed — see [`run_chooser`].
fn candidates() -> Vec<ChooserCommand> {
    if cfg!(target_os = "windows") {
        // `-EncodedCommand` sidesteps every layer of quoting between here and
        // PowerShell: the script travels as UTF-16LE base64, so a title or a
        // path with quotes cannot break the command line.
        //
        // The owner form is what makes the dialog reachable at all. Without
        // one, WinForms opens the picker BEHIND the browser window that
        // triggered it: the page spins, the reader sees nothing, and the
        // action reads as broken. A hidden, topmost owner keeps the modal in
        // front without leaving a stray window behind.
        //
        // EVERY optional property is guarded, and `$ErrorActionPreference` is
        // `Continue` rather than `Stop`. Both are load-bearing: on the .NET
        // Framework build of WinForms that ships with Windows PowerShell,
        // `FolderBrowserDialog` has no `UseDescriptionForTitle`, so assigning
        // it raised a terminating error, the script exited 1, and the caller
        // read that as "the user cancelled" — a button that only ever blinked.
        // A property that does not exist must cost nothing, and the one that
        // does must still set the title.
        let script = r#"
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$owner = $null
try {
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    $owner.FormBorderStyle = 'None'
    $owner.Size = New-Object System.Drawing.Size(1, 1)
    $owner.StartPosition = 'CenterScreen'
    $owner.Show()
    $owner.Activate()
} catch {
    if ($owner) { try { $owner.Dispose() } catch {} }
    $owner = $null
}
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
try { $dialog.Description = 'Select a workspace directory' } catch {}
try { $dialog.UseDescriptionForTitle = $true } catch {}
try { $dialog.ShowNewFolderButton = $true } catch {}
try {
    $result = if ($owner) { $dialog.ShowDialog($owner) } else { $dialog.ShowDialog() }
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::Out.WriteLine($dialog.SelectedPath)
    }
} catch {
    # A dialog that cannot open is a failure the caller should SEE, not a
    # silent cancel: write the reason to stderr and exit non-zero so the
    # endpoint reports "the folder picker failed" instead of doing nothing.
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
} finally {
    if ($owner) {
        try { $owner.Close() } catch {}
        try { $owner.Dispose() } catch {}
    }
}
"#;
        return vec![
            ChooserCommand::new(
                "powershell",
                vec![
                    "-NoProfile".into(),
                    // Required: WinForms' folder dialog is a COM STA object.
                    "-STA".into(),
                    "-EncodedCommand".into(),
                    encode_powershell(script),
                ],
            ),
            // Windows PowerShell ships with the OS, but a locked-down image can
            // remove it while leaving PowerShell 7 installed. `run_chooser`
            // tries each candidate in turn, so this is the second chance rather
            // than a second dialog.
            ChooserCommand::new(
                "pwsh",
                vec![
                    "-NoProfile".into(),
                    "-STA".into(),
                    "-EncodedCommand".into(),
                    encode_powershell(script),
                ],
            ),
        ];
    }

    if cfg!(target_os = "macos") {
        // `POSIX path of` yields a slash-separated absolute path with a
        // trailing separator; the caller trims it.
        let script = format!("POSIX path of (choose folder with prompt \"{TITLE}\")");
        return vec![ChooserCommand::new("osascript", vec!["-e".into(), script])];
    }

    vec![
        ChooserCommand::new(
            "zenity",
            vec![
                "--file-selection".into(),
                "--directory".into(),
                format!("--title={TITLE}"),
            ],
        ),
        ChooserCommand::new(
            "kdialog",
            vec![
                "--getexistingdirectory".into(),
                ".".into(),
                "--title".into(),
                TITLE.into(),
            ],
        ),
    ]
}

/// UTF-16LE base64, the encoding `powershell -EncodedCommand` expects.
fn encode_powershell(script: &str) -> String {
    let bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64(&bytes)
}

/// Minimal base64 (standard alphabet, padded).
///
/// Hand-rolled rather than pulling a dependency in for one call: the input is
/// always the same shape, and an encoder this small is easy to keep correct.
fn base64(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

/// Run the first available chooser and read the chosen path.
async fn run_chooser() -> Result<Option<String>, PickError> {
    let mut missing = Vec::new();

    for candidate in candidates() {
        match spawn(&candidate).await {
            Ok(outcome) => return Ok(outcome),
            Err(SpawnFailure::NotFound) => missing.push(candidate.program),
            Err(SpawnFailure::Other(message)) => return Err(PickError::Failed(message)),
        }
    }

    Err(PickError::Unavailable(format!(
        "tried {}",
        missing.join(", ")
    )))
}

/// How a spawn attempt failed: not installed, versus installed but broken.
enum SpawnFailure {
    NotFound,
    Other(String),
}

/// Start one chooser, wait for it, and interpret the result.
///
/// Cancellation and failure are mostly the same observable — a non-zero exit
/// with no output — because `osascript` and `zenity` both signal "the user
/// closed the dialog" that way, and an empty path is not a usable answer
/// either.
///
/// **stderr breaks the tie.** A chooser that exits non-zero AND writes to
/// stderr did not cancel; it broke. That distinction is the whole reason the
/// Windows script routes its exceptions to stderr: treating a crash as a cancel
/// is what made "add workspace" look like a button that does nothing.
async fn spawn(spec: &ChooserCommand) -> Result<Option<String>, SpawnFailure> {
    debug!(program = %spec.program, "web: opening the native folder picker");

    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // Piped, not null: a chooser that fails explains itself here, and that
        // explanation is the difference between a reported failure and a
        // silent cancel.
        .stderr(Stdio::piped())
        // The dialog is its own window; it must not be tied to the server's
        // lifetime in a way that would kill it mid-interaction.
        .kill_on_drop(true);

    let child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            SpawnFailure::NotFound
        } else {
            SpawnFailure::Other(error.to_string())
        }
    })?;

    let output = match tokio::time::timeout(DIALOG_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        // `kill_on_drop` kills the child when the future is dropped here.
        Ok(Err(error)) => return Err(SpawnFailure::Other(error.to_string())),
        Err(_) => {
            return Err(SpawnFailure::Other(
                "the folder picker timed out".to_string(),
            ));
        }
    };

    if !output.status.success() {
        // A cancel and a crash both exit non-zero. stderr is what tells them
        // apart, and the Windows script is written to put a failure there:
        // without this, a chooser that never opened was reported as "the user
        // cancelled" and the button looked dead.
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if reason.is_empty() {
            return Ok(None);
        }
        return Err(SpawnFailure::Other(reason));
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let path = raw.trim();
    if path.is_empty() {
        return Ok(None);
    }
    Ok(Some(trim_trailing_separator(path)))
}

/// Drop the trailing separator, keeping a bare root (`/`, `C:\`) intact.
fn trim_trailing_separator(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return path.to_string();
    }
    // `C:` alone is a drive-relative path, not the root; keep the separator.
    if trimmed.len() == 2 && trimmed.ends_with(':') {
        return format!("{trimmed}\\");
    }
    trimmed.to_string()
}

/// Whether this build has any chooser to offer.
///
/// Only Linux can be probed cheaply (`zenity`/`kdialog` may be absent); the
/// answer is advisory, because a caller that guesses wrong still gets a clear
/// `Unavailable` error and can fall back to a typed path.
pub fn is_supported() -> bool {
    !candidates().is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_vectors() {
        // The padding cases are the ones a hand-rolled encoder gets wrong.
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn powershell_script_is_utf16le_base64() {
        // `-EncodedCommand` is UTF-16LE; a UTF-8 payload is silently mangled
        // into a script that PowerShell refuses to parse.
        let encoded = encode_powershell("hi");
        // "hi" in UTF-16LE is 68 00 69 00.
        assert_eq!(encoded, base64(&[0x68, 0x00, 0x69, 0x00]));
    }

    #[test]
    fn windows_command_is_sta_and_encoded() {
        // WinForms' folder dialog is a COM STA object; without `-STA` it throws
        // on some Windows builds instead of opening.
        let spec = &candidates()[0];
        assert_eq!(spec.program, "powershell");
        assert!(spec.args.iter().any(|arg| arg == "-STA"));
        assert!(spec.args.iter().any(|arg| arg == "-EncodedCommand"));
        // The script must ask for a FOLDER, not a file.
        assert!(spec.args.iter().any(|arg| arg == "-NoProfile"));
    }

    #[test]
    fn windows_has_a_pwsh_fallback() {
        // A locked-down image can remove Windows PowerShell while leaving
        // PowerShell 7 installed. The second candidate is only tried when the
        // first is missing, so this cannot open two dialogs.
        let specs = candidates();
        assert!(specs.len() >= 2, "windows needs a fallback chooser");
        assert_eq!(specs[1].program, "pwsh");
        assert!(specs[1].args.iter().any(|arg| arg == "-STA"));
        assert!(specs[1].args.iter().any(|arg| arg == "-EncodedCommand"));
    }

    #[test]
    fn windows_script_owns_the_dialog_and_survives_no_desktop() {
        // Two properties the script has to keep, both learned from a real
        // report of "the + button does nothing":
        //
        // - The dialog needs an OWNER, or WinForms draws it behind the browser
        //   window and the reader never sees it.
        // - Creating that owner must be optional. A session with no desktop
        //   cannot make a window, and `$ErrorActionPreference = 'Stop'` would
        //   turn that into a non-zero exit the caller reads as a cancel.
        let specs = candidates();
        let encoded = specs[0]
            .args
            .iter()
            .position(|arg| arg == "-EncodedCommand")
            .and_then(|index| specs[0].args.get(index + 1))
            .expect("the script travels as -EncodedCommand");
        let script = decode_powershell(encoded);
        assert!(script.contains("ShowDialog($owner)"), "{script}");
        assert!(script.contains("try {"), "{script}");
        assert!(script.contains("$owner = $null"), "{script}");
    }

    #[test]
    fn windows_script_guards_optional_dialog_properties() {
        // The regression that made the picker a button that only blinked.
        //
        // `FolderBrowserDialog.UseDescriptionForTitle` does not exist on the
        // .NET Framework build that ships with Windows PowerShell. Under
        // `$ErrorActionPreference = 'Stop'` that assignment was a terminating
        // error: the script exited 1 with no stdout, and the caller read "exit
        // non-zero and nothing printed" as "the user cancelled".
        //
        // Two things keep that from recurring: the preference is `Continue`,
        // and each optional property is assigned inside its own `try`.
        let specs = candidates();
        let encoded = specs[0]
            .args
            .iter()
            .position(|arg| arg == "-EncodedCommand")
            .and_then(|index| specs[0].args.get(index + 1))
            .expect("the script travels as -EncodedCommand");
        let script = decode_powershell(encoded);

        assert!(
            script.contains("$ErrorActionPreference = 'Continue'"),
            "a terminating preference turns an optional property into a dead button: {script}"
        );
        for property in [
            "Description",
            "UseDescriptionForTitle",
            "ShowNewFolderButton",
        ] {
            let guarded = format!("try {{ $dialog.{property} =");
            assert!(
                script.contains(&guarded),
                "`{property}` must be assigned inside its own try, or a build without it aborts the script: {script}"
            );
        }
        // A dialog that cannot open must SAY so, not exit quietly.
        assert!(
            script.contains("[Console]::Error.WriteLine"),
            "a failure has to reach stderr, which is what distinguishes it from a cancel: {script}"
        );
    }

    /// The inverse of [`encode_powershell`], for asserting on the script.
    fn decode_powershell(encoded: &str) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut bits = 0u32;
        let mut bit_count = 0u32;
        let mut bytes = Vec::new();
        for byte in encoded.bytes() {
            if byte == b'=' {
                break;
            }
            let Some(value) = ALPHABET.iter().position(|entry| *entry == byte) else {
                continue;
            };
            bits = (bits << 6) | value as u32;
            bit_count += 6;
            if bit_count >= 8 {
                bit_count -= 8;
                bytes.push((bits >> bit_count) as u8);
            }
        }
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    }

    #[test]
    fn trailing_separators_are_trimmed_but_roots_survive() {
        assert_eq!(trim_trailing_separator("/home/me/repo/"), "/home/me/repo");
        assert_eq!(
            trim_trailing_separator("C:\\work\\repo\\"),
            "C:\\work\\repo"
        );
        assert_eq!(trim_trailing_separator("/"), "/");
        assert_eq!(trim_trailing_separator("C:\\"), "C:\\");
        // `C:` is drive-relative; it must not lose the separator and become
        // something else entirely.
        assert_eq!(trim_trailing_separator("C:"), "C:\\");
    }

    #[test]
    fn busy_is_reported_rather_than_queued() {
        // The observable contract: a second call while a dialog is open is
        // refused. Simulated by holding the lock, since spawning a real dialog
        // in a test would block on a human.
        let guard = OPEN.try_lock().expect("first acquire must succeed");
        let second = OPEN.try_lock();
        assert!(second.is_err(), "a second picker must be refused");
        drop(guard);
        assert!(OPEN.try_lock().is_ok(), "the lock must be released");
    }

    #[test]
    fn error_messages_never_leak_paths_or_commands() {
        let unavailable = PickError::Unavailable("tried zenity, kdialog".into());
        assert_eq!(
            unavailable.message(),
            "no native folder picker is available on this machine"
        );
        assert!(!unavailable.message().contains("zenity"));
    }
}
