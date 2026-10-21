use super::{Applied, PtyNotification, TerminalPane, pane_height};

fn pane() -> TerminalPane {
    TerminalPane::new("pty-1".to_string(), 20, 4)
}

fn output(text: &str) -> PtyNotification {
    use base64::Engine as _;
    PtyNotification {
        terminal_id: "pty-1".to_string(),
        kind: "output".to_string(),
        data: Some(base64::engine::general_purpose::STANDARD.encode(text.as_bytes())),
        is_replay: false,
        exit_code: None,
    }
}

fn replay(text: &str) -> PtyNotification {
    PtyNotification {
        is_replay: true,
        ..output(text)
    }
}

fn row_text(pane: &TerminalPane, row: usize) -> String {
    pane.screen.visible_rows()[row].text()
}

#[test]
fn output_frames_feed_the_emulator() {
    let mut pane = pane();
    assert_eq!(pane.apply(&output("hello")), Applied::Changed);
    assert_eq!(row_text(&pane, 0), "hello");
}

#[test]
fn replay_resets_before_feeding() {
    let mut pane = pane();
    pane.apply(&output("abc"));
    assert_eq!(row_text(&pane, 0), "abc");

    // A replay frame is the whole ring buffer, not an increment: it must not
    // append to what the pane already showed.
    pane.apply(&replay("x"));
    assert_eq!(row_text(&pane, 0), "x");
}

#[test]
fn exit_records_the_code_and_clears_busy() {
    let mut pane = pane();
    pane.busy = true;
    let applied = pane.apply(&PtyNotification {
        terminal_id: "pty-1".to_string(),
        kind: "exit".to_string(),
        exit_code: Some(3),
        ..Default::default()
    });
    assert_eq!(applied, Applied::Changed);
    assert_eq!(pane.exited, Some(Some(3)));
    assert!(!pane.busy);
    assert_eq!(
        pane.exit_label().as_deref(),
        Some("[process exited with code 3]")
    );
}

#[test]
fn exit_without_a_code_still_reports() {
    let mut pane = pane();
    pane.apply(&PtyNotification {
        terminal_id: "pty-1".to_string(),
        kind: "exit".to_string(),
        ..Default::default()
    });
    assert_eq!(pane.exited, Some(None));
    assert_eq!(pane.exit_label().as_deref(), Some("[process exited]"));
}

#[test]
fn busy_transitions_toggle_the_flag() {
    let mut pane = pane();
    let started = pane.apply(&PtyNotification {
        terminal_id: "pty-1".to_string(),
        kind: "process_started".to_string(),
        ..Default::default()
    });
    assert_eq!(started, Applied::Busy(true));
    assert!(pane.busy);

    let ended = pane.apply(&PtyNotification {
        terminal_id: "pty-1".to_string(),
        kind: "process_ended".to_string(),
        ..Default::default()
    });
    assert_eq!(ended, Applied::Busy(false));
    assert!(!pane.busy);
}

#[test]
fn malformed_frames_are_ignored_not_fatal() {
    let mut pane = pane();
    let mut bad = output("");
    bad.data = Some("not base64!!".to_string());
    assert_eq!(pane.apply(&bad), Applied::Ignored);

    let mut missing = output("");
    missing.data = None;
    assert_eq!(pane.apply(&missing), Applied::Ignored);

    let unknown = PtyNotification {
        terminal_id: "pty-1".to_string(),
        kind: "something_new".to_string(),
        ..Default::default()
    };
    assert_eq!(pane.apply(&unknown), Applied::Ignored);
}

#[test]
fn resize_is_idempotent_and_rejects_zero() {
    let mut pane = pane();
    assert!(!pane.resize(20, 4), "same size is a no-op");
    assert!(pane.resize(30, 6));
    assert_eq!(pane.size, (30, 6));
    assert!(!pane.resize(0, 6), "a zero dimension is refused");
    assert_eq!(pane.size, (30, 6));
}

#[test]
fn replay_after_resize_keeps_the_new_size() {
    let mut pane = pane();
    pane.resize(40, 10);
    pane.apply(&replay("x"));
    assert_eq!(pane.screen.size().cols, 40);
    assert_eq!(pane.screen.size().rows, 10);
}

#[test]
fn pane_height_respects_both_constraints() {
    // Plenty of room: the default height wins over 40%.
    assert_eq!(pane_height(60), Some(12));
    // Tight: 40% is the binding constraint, scrollback keeps its minimum.
    assert_eq!(pane_height(20), Some(8));
    assert_eq!(pane_height(15), Some(6));
    // 40% of 12 is 4, which still leaves the scrollback its 8 rows.
    assert_eq!(pane_height(12), Some(4));
    // Nothing to give: the scrollback would drop below its minimum.
    assert_eq!(pane_height(9), None);
    assert_eq!(pane_height(0), None);
}

#[test]
fn pane_height_always_leaves_the_scrollback_minimum() {
    for available in 1..200u16 {
        if let Some(h) = pane_height(available) {
            assert!(
                available - h >= super::MIN_SCROLLBACK_ROWS,
                "available={available} height={h} starved the scrollback"
            );
            assert!(h > 0);
        }
    }
}

#[test]
fn notification_payload_deserializes_from_the_server_shape() {
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD.encode(b"hi");
    let wire = serde_json::json!({
        "terminalId": "pty-9",
        "type": "output",
        "data": data,
        "outputOffset": 0,
        "isReplay": true,
    });
    let notif: PtyNotification = serde_json::from_value(wire).expect("server payload parses");
    assert_eq!(notif.terminal_id, "pty-9");
    assert_eq!(notif.kind, "output");
    assert!(notif.is_replay);
    assert_eq!(notif.data.as_deref(), Some(data.as_str()));
}

#[test]
fn exit_payload_deserializes_from_the_server_shape() {
    let wire = serde_json::json!({
        "terminalId": "pty-9",
        "type": "exit",
        "exitCode": 130,
        "signal": null,
        "isReplay": true,
    });
    let notif: PtyNotification = serde_json::from_value(wire).expect("exit payload parses");
    assert_eq!(notif.kind, "exit");
    assert_eq!(notif.exit_code, Some(130));
}
