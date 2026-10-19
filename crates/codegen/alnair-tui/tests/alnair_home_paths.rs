//! `ALNAIR_SHARE_DIR` override tests in an isolated binary so `alnair_home()`'s
//! process-wide `OnceLock` initializes from the overridden env var.

use std::path::PathBuf;

#[test]
fn alnair_home_override_path_helpers() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let alnair_home = tmp.path().to_path_buf();
    unsafe {
        std::env::set_var("ALNAIR_SHARE_DIR", &alnair_home);
    }

    assert_eq!(
        alnair_tui::util::pager_toml_path(),
        alnair_home.join("pager.toml")
    );
    assert_eq!(
        alnair_tui::util::display_alnair_home_prefix(),
        "$ALNAIR_SHARE_DIR"
    );
    assert_eq!(
        alnair_tui::util::display_user_alnair_path("config.toml"),
        "$ALNAIR_SHARE_DIR/config.toml"
    );

    let memory_path = alnair_home.join("memory/MEMORY.md");
    assert_eq!(
        alnair_tui::util::abbreviate_path(&memory_path.display().to_string()),
        "$ALNAIR_SHARE_DIR/memory/MEMORY.md"
    );

    assert!(alnair_tui::util::is_under_user_alnair_home(&memory_path));
    assert!(!alnair_tui::util::is_under_user_alnair_home(
        PathBuf::from("/tmp/other").as_path()
    ));
}
