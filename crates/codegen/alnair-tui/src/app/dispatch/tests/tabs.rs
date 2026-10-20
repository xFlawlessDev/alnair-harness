//! Tab dispatch: activation, close/reopen, unread, and the view watermark.

use super::*;
use crate::app::roster::{RosterActivity, RosterEntry, RosterOrigin};
use crate::app::tabs::TabEntry;
use chrono::{TimeZone, Utc};

fn roster_row(session_id: &str, cwd: &str, last_change_ms: i64) -> RosterEntry {
    RosterEntry {
        session_id: session_id.to_string(),
        title: None,
        cwd: cwd.to_string(),
        is_worktree: false,
        model_id: None,
        yolo: false,
        activity: RosterActivity::Idle,
        resident: true,
        last_change_unix_ms: last_change_ms,
        viewed_at: None,
        origin: RosterOrigin {
            kind: "local".into(),
            host: None,
        },
    }
}

fn app_with_tabs(ids: &[&str]) -> AppView {
    let mut app = test_app();
    app.cwd = PathBuf::from("/repo");
    for id in ids {
        app.tabs.open(TabEntry::new(*id, PathBuf::from("/repo")));
    }
    app
}

/// Closing the active tab moves to a neighbour and never closes the session.
#[test]
fn close_tab_keeps_the_session_and_moves_the_cursor() {
    let mut app = app_with_tabs(&["a", "b", "c"]);
    app.tabs.set_active(1);

    let effects = dispatch(Action::CloseTab, &mut app);

    assert_eq!(app.tabs.session_ids(), vec!["a", "c"]);
    assert_eq!(
        app.tabs.active().map(|t| t.session_id.as_str()),
        Some("c"),
        "the right neighbour takes over"
    );
    assert!(
        !effects
            .iter()
            .any(|e| matches!(e, Effect::CreateSession { .. })),
        "a tab close must never create a session, got {effects:?}"
    );
    // The neighbour is activated, and since it is not hosted locally that is a
    // strict load — never a new session.
    assert!(
        effects
            .iter()
            .any(|e| matches!(e, Effect::LoadSession { session_id, .. } if session_id == "c")),
        "the neighbour becomes the view, got {effects:?}"
    );
}

#[test]
fn closing_the_last_tab_returns_to_the_welcome_screen() {
    let mut app = app_with_tabs(&["a"]);
    dispatch(Action::CloseTab, &mut app);
    assert!(app.tabs.is_empty());
    assert!(matches!(app.active_view, ActiveView::Welcome));
}

#[test]
fn close_tab_records_the_cancellation_so_a_reload_cannot_revive_it() {
    let mut app = app_with_tabs(&["a", "b"]);
    dispatch(Action::CloseTab, &mut app);
    assert!(
        app.cancelled_tabs.contains("b"),
        "an in-flight write must not resurrect the closed chip"
    );
}

#[test]
fn reopen_tab_restores_the_position_and_clears_the_guard() {
    let mut app = app_with_tabs(&["a", "b", "c"]);
    app.tabs.set_active(1);
    dispatch(Action::CloseTab, &mut app);
    assert!(app.cancelled_tabs.contains("b"));

    dispatch(Action::ReopenTab, &mut app);
    assert_eq!(app.tabs.session_ids(), vec!["a", "b", "c"]);
    assert!(
        !app.cancelled_tabs.contains("b"),
        "a deliberate reopen must clear the cancellation guard"
    );
}

#[test]
fn reopen_with_nothing_closed_is_a_no_op_toast() {
    let mut app = app_with_tabs(&["a"]);
    let effects = dispatch(Action::ReopenTab, &mut app);
    assert!(effects.is_empty());
    assert_eq!(app.tabs.session_ids(), vec!["a"]);
}

#[test]
fn cycling_wraps_and_activates() {
    let mut app = app_with_tabs(&["a", "b"]);
    app.tabs.set_active(1);
    dispatch(Action::CycleTab(true), &mut app);
    assert_eq!(app.tabs.active().map(|t| t.session_id.as_str()), Some("a"));
}

/// Switching to a tab that is not hosted locally goes through the strict
/// `session/load` path (join-not-steal), never a second `session/new`.
#[test]
fn switching_to_a_remote_tab_loads_it() {
    let mut app = app_with_tabs(&["a", "remote"]);
    app.tabs.set_active(0);

    let effects = dispatch(Action::SwitchToTab(1), &mut app);

    let loaded = effects
        .iter()
        .find_map(|e| match e {
            Effect::LoadSession { session_id, .. } => Some(session_id.clone()),
            _ => None,
        })
        .expect("a remote tab must issue a load");
    assert_eq!(loaded, "remote");
    assert!(
        !effects
            .iter()
            .any(|e| matches!(e, Effect::CreateSession { .. })),
        "switching tabs must never create a session"
    );
}

#[test]
fn switching_to_an_unknown_index_is_a_no_op() {
    let mut app = app_with_tabs(&["a"]);
    assert!(dispatch(Action::SwitchToTab(9), &mut app).is_empty());
    assert!(dispatch(Action::SwitchToTabId("nope".into()), &mut app).is_empty());
}

/// The view mark is queued as an effect, not written locally: the watermark is
/// server-side so two clients cannot diverge.
#[test]
fn record_view_dispatches_the_ext_effect() {
    let mut app = test_app();
    let effects = dispatch(Action::RecordSessionView("s1".into()), &mut app);
    assert!(
        effects
            .iter()
            .any(|e| matches!(e, Effect::RecordSessionView { session_id } if session_id == "s1")),
        "got {effects:?}"
    );
}

// ---- unread -------------------------------------------------------------

#[test]
fn unread_requires_a_newer_change_than_the_watermark() {
    let mut app = test_app();
    let viewed = Utc.timestamp_millis_opt(1_000).unwrap();
    let mut row = roster_row("s", "/repo", 2_000);
    row.viewed_at = Some(viewed);
    app.leader_roster = vec![row];
    assert!(app.tab_is_unread("s"), "changed after the last view");

    app.leader_roster[0].last_change_unix_ms = 500;
    assert!(!app.tab_is_unread("s"), "viewed after the last change");
}

/// A session that predates the field reads as unread once, then self-corrects.
#[test]
fn missing_watermark_reads_as_unread() {
    let mut app = test_app();
    app.leader_roster = vec![roster_row("s", "/repo", 1)];
    assert!(app.tab_is_unread("s"));
}

#[test]
fn a_session_outside_the_roster_is_never_unread() {
    let app = test_app();
    assert!(!app.tab_is_unread("unknown"));
}

/// The strip's glyph prefers precise local state over the roster.
#[test]
fn tab_status_prefers_local_agent_state() {
    let mut app = test_app_with_agent();
    let id = AgentId(0);
    {
        let agent = app.agents.get_mut(&id).unwrap();
        agent.session.session_id = Some(acp::SessionId::new("local"));
        agent.session.state = AgentState::TurnRunning;
    }
    // The roster would say Idle; the local turn is the truth.
    app.leader_roster = vec![roster_row("local", "/repo", 1)];

    assert_eq!(
        app.tab_status("local"),
        crate::views::tab_strip::TabStatus::Running
    );
}

#[test]
fn tab_status_falls_back_to_the_roster_for_remote_sessions() {
    let mut app = test_app();
    let mut working = roster_row("remote", "/repo", 1);
    working.activity = RosterActivity::Working;
    let mut needs_input = roster_row("remote2", "/repo", 1);
    needs_input.activity = RosterActivity::NeedsInput;
    app.leader_roster = vec![working, needs_input];

    assert_eq!(
        app.tab_status("remote"),
        crate::views::tab_strip::TabStatus::Running
    );
    assert_eq!(
        app.tab_status("remote2"),
        crate::views::tab_strip::TabStatus::Permission
    );
}

/// The repo detail is what keeps a global strip legible across repositories.
#[test]
fn tab_repo_detail_names_the_repository() {
    let mut app = app_with_tabs(&["s"]);
    app.leader_roster = vec![roster_row("s", "/work/alnair", 1)];
    assert_eq!(app.tab_repo_detail("s").as_deref(), Some("alnair"));
}
