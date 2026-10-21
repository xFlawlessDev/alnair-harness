//! `alnair/terminal/pty/notification` — PTY output, exit and busy transitions.
//!
//! The server routes these to one client (the PTY's recorded
//! `target_client_id`), so a notification that names a PTY this client does not
//! own is not an error: it belongs to another pager. It is dropped quietly.
//!
//! Frames are matched by `terminalId`, not by the agent that requested them: a
//! PTY outlives the tab switch that created it, and the pane hangs off the
//! agent view rather than the layout, so the owning view is wherever the id
//! currently lives.

use agent_client_protocol as acp;

use super::super::app_view::AppView;
use super::AgentView;
use crate::app::terminal_pane::{Applied, PtyNotification};

/// Apply one PTY notification. Returns whether the screen needs a redraw.
pub(super) fn handle_pty_notification(notif: &acp::ExtNotification, app: &mut AppView) -> bool {
    let Ok(payload) = serde_json::from_str::<PtyNotification>(notif.params.get()) else {
        tracing::debug!("failed to parse alnair/terminal/pty/notification");
        return false;
    };

    let Some(view) = app
        .agents
        .values_mut()
        .find(|view| owns_pty(view, &payload.terminal_id))
    else {
        // Either another client's PTY, or a pane whose tab was closed while
        // the frame was in flight. Logged through `unified_log` so the drop is
        // visible in `unified.jsonl` — a silently-dropped frame is the single
        // hardest PTY failure to diagnose from the outside.
        let known: Vec<String> = app
            .agents
            .values()
            .filter_map(|v| v.terminal.as_ref().map(|p| p.pty_id.clone()))
            .collect();
        crate::unified_log::warn(
            "pty.notification.unknown_terminal",
            None,
            Some(serde_json::json!({
                "terminal_id": payload.terminal_id,
                "kind": payload.kind,
                "known_terminals": known,
            })),
        );
        return false;
    };

    let Some(pane) = view.terminal.as_mut() else {
        return false;
    };
    // Log through `unified_log`, not `tracing`: the pager's tracing output is
    // NOT written to `~/.alnair/logs/unified.jsonl` (it goes to stderr), so a
    // `tracing::debug!` here is invisible exactly when a user needs it. The
    // unified log is the one surface both this process and the leader feed.
    crate::unified_log::debug(
        "pty.notification.apply",
        None,
        Some(serde_json::json!({
            "terminal_id": payload.terminal_id,
            "kind": payload.kind,
            "bytes": payload.data.as_ref().map(String::len).unwrap_or(0),
        })),
    );
    match pane.apply(&payload) {
        Applied::Changed => true,
        // The busy glyph is only visible while the pane is drawn; a hidden
        // pane still records the flag so the title is right when reopened.
        Applied::Busy(_) => view.terminal_open,
        Applied::Ignored => false,
    }
}

fn owns_pty(view: &AgentView, pty_id: &str) -> bool {
    view.terminal
        .as_ref()
        .is_some_and(|pane| pane.pty_id == pty_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::app_view::AppView;
    use crate::test_util::make_agent_view;

    /// A `AppView` carrying one agent view, built through the same test helper
    /// the rest of the crate uses for isolated agent fixtures.
    fn app_with_pane(pty_id: &str) -> AppView {
        let mut app = AppView::new_for_tests();
        let mut view = make_agent_view(Some("sess-1"), "/tmp/project");
        view.terminal = Some(crate::app::terminal_pane::TerminalPane::new(
            pty_id.to_string(),
            20,
            4,
        ));
        view.terminal_open = true;
        app.agents.insert(crate::app::agent::AgentId(0), view);
        app
    }

    fn notif(kind: &str, data: Option<&str>) -> acp::ExtNotification {
        use base64::Engine as _;
        let mut params = serde_json::json!({
            "terminalId": "pty-1",
            "type": kind,
        });
        if let Some(text) = data {
            params["data"] = serde_json::json!(
                base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
            );
        }
        acp::ExtNotification::new(
            "alnair/terminal/pty/notification",
            serde_json::value::to_raw_value(&params).unwrap().into(),
        )
    }

    #[test]
    fn output_reaches_the_owning_pane() {
        let mut app = app_with_pane("pty-1");
        assert!(handle_pty_notification(
            &notif("output", Some("hi")),
            &mut app
        ));
        let view = app.agents.get(&crate::app::agent::AgentId(0)).unwrap();
        let pane = view.terminal.as_ref().unwrap();
        assert_eq!(pane.screen.visible_rows()[0].text(), "hi");
    }

    #[test]
    fn a_notification_for_another_pty_is_ignored() {
        let mut app = app_with_pane("pty-2");
        assert!(!handle_pty_notification(
            &notif("output", Some("hi")),
            &mut app
        ));
    }

    #[test]
    fn a_notification_with_no_pane_at_all_is_ignored() {
        let mut app = AppView::new_for_tests();
        app.agents.insert(
            crate::app::agent::AgentId(0),
            make_agent_view(Some("sess-1"), "/tmp/project"),
        );
        assert!(!handle_pty_notification(
            &notif("output", Some("hi")),
            &mut app
        ));
    }

    #[test]
    fn malformed_payloads_are_ignored() {
        let mut app = app_with_pane("pty-1");
        let bad = acp::ExtNotification::new(
            "alnair/terminal/pty/notification",
            serde_json::value::to_raw_value(&serde_json::json!({ "nope": 1 }))
                .unwrap()
                .into(),
        );
        assert!(!handle_pty_notification(&bad, &mut app));
    }

    #[test]
    fn busy_frames_only_repaint_an_open_pane() {
        let mut app = app_with_pane("pty-1");
        assert!(handle_pty_notification(
            &notif("process_started", None),
            &mut app
        ));

        let view = app.agents.get_mut(&crate::app::agent::AgentId(0)).unwrap();
        assert!(view.terminal.as_ref().unwrap().busy);
        view.terminal_open = false;
        assert!(!handle_pty_notification(
            &notif("process_ended", None),
            &mut app
        ));
        let view = app.agents.get(&crate::app::agent::AgentId(0)).unwrap();
        assert!(!view.terminal.as_ref().unwrap().busy);
    }

    #[test]
    fn exit_frames_repaint() {
        let mut app = app_with_pane("pty-1");
        let mut params = serde_json::json!({
            "terminalId": "pty-1",
            "type": "exit",
            "exitCode": 2,
        });
        let _ = &mut params;
        let notif = acp::ExtNotification::new(
            "alnair/terminal/pty/notification",
            serde_json::value::to_raw_value(&params).unwrap().into(),
        );
        assert!(handle_pty_notification(&notif, &mut app));
        let view = app.agents.get(&crate::app::agent::AgentId(0)).unwrap();
        assert_eq!(view.terminal.as_ref().unwrap().exited, Some(Some(2)));
    }
}
