//! Structural guard: the child-network filter has exactly ONE implementation.
//!
//! The filter program and its installation are security-critical, and the piped
//! shell path plus the interactive PTY path must never drift into two copies.
//! A behavioral test cannot prove that (both copies would pass), so this test
//! asserts the source shape directly: one definition of the BPF program, one
//! definition of the installation routine, and no spawn site that inlines the
//! `pre_exec` body instead of calling the shared helper.

use std::path::{Path, PathBuf};

/// Repository root, derived from this crate's manifest dir
/// (`<root>/crates/codegen/alnair-sandbox`).
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("crate lives at crates/codegen/alnair-sandbox")
        .to_path_buf()
}

fn read(relative: &str) -> String {
    let path = repo_root().join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// The spawn sites that must route through the shared helper.
const SPAWN_SITES: &[&str] = &[
    "crates/codegen/alnair-shell/src/terminal/pty_session.rs",
    "crates/codegen/alnair-shell/src/terminal/streaming_local_terminal.rs",
    "crates/codegen/alnair-tools/src/computer/local/terminal.rs",
];

#[test]
fn filter_program_has_a_single_definition() {
    let source = read("crates/codegen/alnair-sandbox/src/child_net.rs");
    let definitions = source
        .lines()
        .filter(|line| {
            line.trim_start()
                .starts_with("fn build_child_network_filter(")
        })
        .count();
    assert_eq!(
        definitions, 1,
        "the seccomp program must have exactly one definition"
    );
}

#[test]
fn installation_routine_has_a_single_definition() {
    let source = read("crates/codegen/alnair-sandbox/src/child_net.rs");
    let definitions = source
        .lines()
        .filter(|line| {
            let line = line.trim_start();
            line.starts_with("pub unsafe fn install_child_network_filter(")
                || line.starts_with("unsafe fn install_child_network_filter(")
        })
        .count();
    // Two is expected and correct: the Linux implementation and the non-Linux
    // no-op stub, which are mutually exclusive by `cfg`.
    assert_eq!(
        definitions, 2,
        "expected exactly the linux implementation and the non-linux no-op stub"
    );

    // The Linux body must be the only place that programs the kernel. Count
    // call sites only: the `use libc::{…}` import also names the constant.
    let pr_set_seccomp_calls = source
        .lines()
        .filter(|line| !line.trim_start().starts_with("use ") && line.contains("PR_SET_SECCOMP"))
        .count();
    assert_eq!(
        pr_set_seccomp_calls, 1,
        "exactly one site may program seccomp, found {pr_set_seccomp_calls}"
    );
}

#[test]
fn spawn_sites_never_inline_the_installation_body() {
    for site in SPAWN_SITES {
        let source = read(site);
        assert!(
            !source.contains("install_child_network_filter"),
            "{site} must call the shared helper, not the raw installation routine"
        );
        assert!(
            !source.contains("prebuilt_child_network_filter"),
            "{site} must not hold its own copy of the filter program"
        );
        assert!(
            source.contains("child_network_pre_exec_hook") || source.contains("install_and_stage"),
            "{site} must reach the filter through the shared helper"
        );
    }
}

#[test]
fn pty_creation_is_fail_closed() {
    let source = read("crates/codegen/alnair-shell/src/terminal/pty_session.rs");
    // The PTY path must consult the shared decision and refuse on failure.
    assert!(
        source.contains("child_network_restricted"),
        "PTY creation must consult the shared restriction decision"
    );
    assert!(
        source.contains("installation_failure_message"),
        "PTY creation must surface the shared failure message"
    );
    // The refusal must abort creation: `create_pty` returns `Result`, and the
    // owned spawn's error is propagated with `?` rather than swallowed.
    let create_pty_body = source
        .split("pub async fn create_pty(")
        .nth(1)
        .expect("create_pty exists");
    assert!(
        create_pty_body.contains("spawn_pty_child("),
        "create_pty must spawn through the shared helper"
    );
    assert!(
        create_pty_body.contains("?;"),
        "create_pty must propagate a spawn refusal instead of continuing"
    );
}
