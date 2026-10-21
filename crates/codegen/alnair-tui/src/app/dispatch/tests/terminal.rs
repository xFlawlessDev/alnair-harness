//! Terminal pane dispatch: lazy creation, replay-on-reopen, close on exit.

use super::super::terminal::{
    close_terminal_effect, dispatch_toggle_terminal, forget_terminal, handle_pty_created,
    prepare_loaded_pane,
};
use super::*;

fn view() -> AgentView {
    test_app_with_agent()
        .agents
        .into_iter()
        .next()
        .expect("fixture agent")
        .1
}

fn session_id_of(view: &AgentView) -> acp::SessionId {
    view.session
        .session_id
        .clone()
        .expect("fixture has a session id")
}

#[test]
fn toggling_on_without_a_pane_creates_one() {
    let mut view = view();
    let effects = dispatch_toggle_terminal(&mut view);
    assert!(view.terminal_open);
    match effects.as_slice() {
        [Effect::PtyCreate { rows, cols, .. }] => {
            assert_eq!(*rows, crate::app::terminal_pane::DEFAULT_PANE_ROWS);
            assert_eq!(*cols, 80);
        }
        other => panic!("expected PtyCreate, got {other:?}"),
    }
    // The pane itself only exists once the server answers.
    assert!(view.terminal.is_none());
}

#[test]
fn the_create_effect_names_the_active_session() {
    let mut view = view();
    let expected = session_id_of(&view);
    let effects = dispatch_toggle_terminal(&mut view);
    match effects.as_slice() {
        [Effect::PtyCreate { session_id, .. }] => {
            assert_eq!(session_id.0.as_ref(), expected.0.as_ref())
        }
        other => panic!("expected PtyCreate, got {other:?}"),
    }
}

#[test]
fn toggling_off_only_hides() {
    let mut view = view();
    let agent_id = view.session.id;
    handle_pty_created(&mut view, agent_id, "pty-1".to_string());
    assert!(view.terminal_open);

    let effects = dispatch_toggle_terminal(&mut view);
    assert!(!view.terminal_open);
    assert!(effects.is_empty(), "hiding must not kill the PTY");
    assert!(
        view.terminal.is_some(),
        "the emulator keeps its scrollback while hidden"
    );
}

#[test]
fn reopening_replays_instead_of_creating_a_second_pty() {
    let mut view = view();
    let agent_id = view.session.id;
    handle_pty_created(&mut view, agent_id, "pty-1".to_string());
    dispatch_toggle_terminal(&mut view); // hide
    let effects = dispatch_toggle_terminal(&mut view); // show again
    match effects.as_slice() {
        [Effect::PtyLoad { pty_id, .. }] => assert_eq!(pty_id, "pty-1"),
        other => panic!("expected PtyLoad, got {other:?}"),
    }
}

#[test]
fn a_view_without_a_session_refuses_and_says_why() {
    let app = test_app_with_agent();
    let mut view = app.agents.into_iter().next().unwrap().1;
    view.session.session_id = None;
    let effects = dispatch_toggle_terminal(&mut view);
    assert!(effects.is_empty());
    assert!(!view.terminal_open, "the toggle must not latch on");
}

#[test]
fn pty_created_installs_the_pane_and_arms_the_replay() {
    let mut view = view();
    let agent_id = view.session.id;
    let effects = handle_pty_created(&mut view, agent_id, "pty-9".to_string());
    assert_eq!(
        view.terminal.as_ref().expect("pane installed").pty_id,
        "pty-9"
    );
    assert!(view.terminal_open);
    match effects.as_slice() {
        [Effect::PtyLoad { pty_id, .. }] => assert_eq!(pty_id, "pty-9"),
        other => panic!("expected PtyLoad, got {other:?}"),
    }
}

#[test]
fn a_loaded_pane_takes_the_servers_size() {
    let mut view = view();
    let agent_id = view.session.id;
    handle_pty_created(&mut view, agent_id, "pty-1".to_string());
    let pane = view.terminal.as_mut().unwrap();
    prepare_loaded_pane(pane, 30, 100, false, None);
    assert_eq!(pane.size, (100, 30));
    assert!(pane.exited.is_none());
}

#[test]
fn a_loaded_pane_that_already_exited_is_marked_dead() {
    let mut view = view();
    let agent_id = view.session.id;
    handle_pty_created(&mut view, agent_id, "pty-1".to_string());
    let pane = view.terminal.as_mut().unwrap();
    pane.busy = true;
    prepare_loaded_pane(pane, 24, 80, true, Some(0));
    assert_eq!(pane.exited, Some(Some(0)));
    assert!(!pane.busy, "an exited PTY cannot be running a command");
}

#[test]
fn closing_emits_a_kill_for_a_live_pane() {
    let mut view = view();
    let agent_id = view.session.id;
    handle_pty_created(&mut view, agent_id, "pty-1".to_string());
    match close_terminal_effect(&view) {
        Some(Effect::PtyClose { pty_id }) => assert_eq!(pty_id, "pty-1"),
        other => panic!("expected PtyClose, got {other:?}"),
    }
    forget_terminal(&mut view);
    assert!(view.terminal.is_none());
    assert!(!view.terminal_open);
    assert!(close_terminal_effect(&view).is_none());
}

#[test]
fn the_toggle_routes_through_dispatch() {
    let mut view = view();
    let effects = dispatch_toggle_terminal(&mut view);
    assert_eq!(effects.len(), 1);
    assert!(view.terminal_open);
}
