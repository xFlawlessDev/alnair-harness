//! Auto-attach: arming, the roster-time decision, and the failure fallback.

use super::*;
use crate::app::dispatch::session::load::dispatch_load_session;
use crate::app::roster::{RosterActivity, RosterEntry, RosterOrigin};
use crate::app::session_startup::{AutoAttach, pick_auto_attach};
use std::path::Path;

fn roster_row(session_id: &str, cwd: &Path, activity: RosterActivity) -> RosterEntry {
    RosterEntry {
        session_id: session_id.to_string(),
        title: None,
        cwd: cwd.to_string_lossy().into_owned(),
        is_worktree: false,
        model_id: None,
        yolo: false,
        activity,
        resident: true,
        last_change_unix_ms: 1_000,
        viewed_at: None,
        origin: RosterOrigin {
            kind: "local".into(),
            host: None,
        },
    }
}

/// Nothing armed → no choice, and the method stays cheap (no roster walk).
#[test]
fn auto_attach_choice_is_none_when_nothing_was_armed() {
    let mut app = test_app();
    assert!(app.take_startup_auto_attach_choice().is_none());
}

/// A bare launch is only a candidate while the welcome screen is untouched.
#[test]
fn auto_attach_choice_requires_an_untouched_welcome() {
    let dir = tempfile::tempdir().unwrap();
    let row = roster_row("s1", dir.path(), RosterActivity::Idle);

    // Deferred startup action (e.g. waiting on auth) → not ours to override.
    let mut app = test_app();
    app.leader_roster = vec![row.clone()];
    app.startup_auto_attach = Some(AutoAttach {
        cwd: dir.path().to_path_buf(),
    });
    app.deferred_startup.new_session = true;
    assert!(app.take_startup_auto_attach_choice().is_none());
    assert!(
        app.startup_auto_attach.is_none(),
        "the marker is consumed even on a miss — one shot only"
    );

    // An agent already exists → the user is already somewhere.
    let mut app = test_app_with_agent();
    app.leader_roster = vec![row];
    app.startup_auto_attach = Some(AutoAttach {
        cwd: dir.path().to_path_buf(),
    });
    assert!(app.take_startup_auto_attach_choice().is_none());
}

/// The happy path: newest matching session wins, and the activity rides along
/// so `handle_session_loaded` can decide whether to explain the attach.
#[test]
fn auto_attach_choice_picks_newest_and_records_activity() {
    let dir = tempfile::tempdir().unwrap();
    let mut older = roster_row("older", dir.path(), RosterActivity::Idle);
    older.last_change_unix_ms = 10;
    let mut newer = roster_row("newer", dir.path(), RosterActivity::Working);
    newer.last_change_unix_ms = 99;

    let mut app = test_app();
    app.leader_roster = vec![older, newer];
    app.startup_auto_attach = Some(AutoAttach {
        cwd: dir.path().to_path_buf(),
    });

    let choice = app
        .take_startup_auto_attach_choice()
        .expect("a session to join");
    assert_eq!(choice.session_id, "newer");
    assert_eq!(choice.activity, RosterActivity::Working);
    assert_eq!(
        app.startup_auto_attach_activity,
        Some(RosterActivity::Working)
    );
    assert!(app.startup_auto_attach.is_none(), "one shot");
    assert!(
        app.take_startup_auto_attach_choice().is_none(),
        "a second roster must not re-attach"
    );
}

/// `RosterLoaded` turns the choice into a real load for the picked session.
#[test]
fn roster_loaded_dispatches_the_auto_attach_load() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = test_app();
    app.startup_auto_attach = Some(AutoAttach {
        cwd: dir.path().to_path_buf(),
    });

    let effects = dispatch(
        Action::TaskComplete(TaskResult::RosterLoaded {
            sessions: vec![roster_row("auto-target", dir.path(), RosterActivity::Idle)],
        }),
        &mut app,
    );

    let loaded = effects
        .iter()
        .find_map(|e| match e {
            Effect::LoadSession {
                session_id,
                session_cwd,
                ..
            } => Some((session_id.clone(), session_cwd.clone())),
            _ => None,
        })
        .expect("an auto-attach must issue Effect::LoadSession");
    assert_eq!(loaded.0, "auto-target");
    assert_eq!(loaded.1, Some(dir.path().to_path_buf()));
    assert_eq!(
        app.startup_auto_attach_agent,
        Some(AgentId(0)),
        "the failure path needs to know the agent was ours"
    );
}

/// A roster with no session for this cwd leaves the welcome screen alone.
#[test]
fn roster_loaded_without_a_match_stays_on_welcome() {
    let mine = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let mut app = test_app();
    app.startup_auto_attach = Some(AutoAttach {
        cwd: mine.path().to_path_buf(),
    });

    let effects = dispatch(
        Action::TaskComplete(TaskResult::RosterLoaded {
            sessions: vec![roster_row("elsewhere", other.path(), RosterActivity::Idle)],
        }),
        &mut app,
    );
    assert!(
        effects.is_empty(),
        "no load for a session in another repo, got {effects:?}"
    );
    assert!(matches!(app.active_view, ActiveView::Welcome));
    assert!(app.startup_auto_attach_agent.is_none());
}

/// A session that vanished between the roster snapshot and the load falls back
/// to Welcome with a toast — never a stranded failed agent view.
#[test]
fn auto_attach_load_failure_returns_to_welcome() {
    let mut app = test_app();
    let effects = dispatch_load_session(&mut app, "gone".into(), None, false);
    let agent_id = effects
        .iter()
        .find_map(|e| match e {
            Effect::LoadSession { agent_id, .. } => Some(*agent_id),
            _ => None,
        })
        .expect("load dispatched");
    app.startup_auto_attach_agent = Some(agent_id);

    let _ = dispatch(
        Action::TaskComplete(TaskResult::SessionLoadFailed {
            agent_id,
            session_id: acp::SessionId::new("gone"),
            error: "session not found".into(),
        }),
        &mut app,
    );

    assert!(
        matches!(app.active_view, ActiveView::Welcome),
        "an unrequested attach must not leave the user in a failed view"
    );
    assert!(
        !app.agents.contains_key(&agent_id),
        "the agent is discarded"
    );
    assert!(app.startup_auto_attach_agent.is_none());
}

/// A user-driven load keeps the existing error block behaviour.
#[test]
fn user_load_failure_is_not_rewritten_as_an_attach_failure() {
    let mut app = test_app();
    let effects = dispatch_load_session(&mut app, "gone".into(), None, false);
    let agent_id = effects
        .iter()
        .find_map(|e| match e {
            Effect::LoadSession { agent_id, .. } => Some(*agent_id),
            _ => None,
        })
        .expect("load dispatched");
    assert!(
        app.startup_auto_attach_agent.is_none(),
        "precondition: not an auto-attach"
    );

    let _ = dispatch(
        Action::TaskComplete(TaskResult::SessionLoadFailed {
            agent_id,
            session_id: acp::SessionId::new("gone"),
            error: "session not found".into(),
        }),
        &mut app,
    );
    assert!(
        app.agents.contains_key(&agent_id),
        "the agent view survives so the failure is visible"
    );
}

/// Guard against the picker and the auto-attach disagreeing about cwd rules.
#[test]
fn auto_attach_never_matches_a_dormant_session() {
    let dir = tempfile::tempdir().unwrap();
    let rows = vec![roster_row("dormant", dir.path(), RosterActivity::Dormant)];
    assert!(pick_auto_attach(&rows, dir.path(), true).is_none());
}
