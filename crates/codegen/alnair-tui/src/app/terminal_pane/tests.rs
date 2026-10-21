use super::{Applied, PaneSelection, PtyNotification, TerminalPane, pane_height};

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
fn emulator_replies_are_captured_not_dropped() {
    // A shell probes its terminal at startup (`ESC[6n`) and blocks until the
    // emulator answers. If the reply sink is dropped, the answer goes nowhere
    // and the shell never prints its prompt — the pane stays blank forever.
    let mut pane = pane();
    pane.apply(&output("\x1b[6n"));
    let replies = pane.take_emulator_replies();
    assert!(
        !replies.is_empty(),
        "the cursor-position report must be captured for forwarding"
    );
    assert!(
        replies.starts_with(b"\x1b["),
        "DSR is answered with a CSI sequence, got {replies:?}"
    );
    // Draining twice yields nothing: the reply was handed over exactly once.
    assert!(pane.take_emulator_replies().is_empty());
}

#[test]
fn a_replay_keeps_the_reply_sink_alive() {
    // The replay path rebuilds the emulator; the fresh sink must be kept or
    // every reply after a reopen is silently lost.
    let mut pane = pane();
    pane.apply(&replay("x"));
    pane.apply(&output("\x1b[6n"));
    assert!(
        !pane.take_emulator_replies().is_empty(),
        "replies must still be captured after a replay reset"
    );
}

#[test]
fn scrolling_back_shows_history_and_hides_the_cursor() {
    let mut pane = TerminalPane::new("pty-1".to_string(), 10, 2);
    let mut notif = output("one\r\ntwo\r\nthree");
    pane.apply(&notif);
    let _ = &mut notif;

    // Two rows tall: the earlier lines have scrolled into history.
    assert!(pane.screen.history_size() > 0, "fixture must overflow");
    assert_eq!(pane.screen.display_offset(), 0);
    assert!(
        pane.screen.cursor_cell().is_some(),
        "live view has a cursor"
    );

    let offset = pane.screen.scroll_by(1);
    assert_eq!(offset, 1, "one row back");
    assert!(
        pane.screen.cursor_cell().is_none(),
        "the cursor belongs to the live view, not to a history row"
    );

    // Back to live.
    assert_eq!(pane.screen.scroll_to_bottom(), 0);
    assert!(pane.screen.cursor_cell().is_some());
}

#[test]
fn scrolling_is_clamped_to_available_history() {
    let mut pane = TerminalPane::new("pty-1".to_string(), 10, 2);
    pane.apply(&output("a\r\nb\r\nc\r\nd"));
    let history = pane.screen.history_size();
    // Asking for far more than exists clamps instead of erroring.
    assert_eq!(pane.screen.scroll_by(10_000), history);
    // And scrolling forward past the bottom clamps to 0.
    assert_eq!(pane.screen.scroll_by(-10_000), 0);
}

#[test]
fn selection_copies_only_the_dragged_columns() {
    let mut pane = TerminalPane::new("pty-1".to_string(), 20, 3);
    pane.apply(&output("hello world"));
    // Columns 0..=4 on row 0 => "hello".
    pane.selection = Some(PaneSelection {
        anchor: (0, 0),
        head: (0, 4),
        dragging: false,
    });
    assert_eq!(pane.selected_text(), "hello");
}

#[test]
fn a_backwards_selection_selects_the_same_span() {
    let mut pane = TerminalPane::new("pty-1".to_string(), 20, 3);
    pane.apply(&output("hello world"));
    pane.selection = Some(PaneSelection {
        anchor: (0, 4),
        head: (0, 0),
        dragging: false,
    });
    assert_eq!(pane.selected_text(), "hello");
}

#[test]
fn a_multi_row_selection_joins_with_newlines() {
    let mut pane = TerminalPane::new("pty-1".to_string(), 20, 3);
    pane.apply(&output("alpha\r\nbeta"));
    pane.selection = Some(PaneSelection {
        anchor: (0, 0),
        head: (1, 3),
        dragging: false,
    });
    assert_eq!(pane.selected_text(), "alpha\nbeta");
}

#[test]
fn an_empty_selection_copies_nothing() {
    let mut pane = TerminalPane::new("pty-1".to_string(), 20, 3);
    pane.apply(&output("hello"));
    pane.selection = Some(PaneSelection::new((0, 2)));
    assert_eq!(pane.selected_text(), "");
}

#[test]
fn an_exited_pane_keeps_its_output_readable() {
    // "exit" must not blank the pane: the user needs the last output to know
    // what happened, and the footer explains the state.
    let mut pane = TerminalPane::new("pty-1".to_string(), 20, 3);
    pane.apply(&output("bye"));
    pane.apply(&PtyNotification {
        terminal_id: "pty-1".to_string(),
        kind: "exit".to_string(),
        exit_code: Some(0),
        ..Default::default()
    });
    assert_eq!(row_text(&pane, 0), "bye");
    assert_eq!(pane.exited, Some(Some(0)));
}

#[test]
fn a_bell_arms_the_flash_once() {
    let mut pane = pane();
    // BEL is 0x07; the emulator turns it into an event, not a grid change.
    pane.apply(&output("\x07"));
    assert!(pane.bell_flash_frames > 0, "a BEL must arm the flash");
    // The flash decays one frame at a time and then stops reporting work.
    for _ in 0..12 {
        assert!(pane.tick_bell());
    }
    assert_eq!(pane.bell_flash_frames, 0);
    assert!(!pane.tick_bell(), "an expired flash needs no redraw");
}

#[test]
fn the_bell_lit_phase_blinks() {
    let mut pane = pane();
    pane.apply(&output("\x07"));
    let phases: Vec<bool> = (0..8)
        .map(|_| {
            let lit = pane.bell_lit();
            pane.tick_bell();
            lit
        })
        .collect();
    assert!(
        phases.iter().any(|l| *l),
        "the flash must be visible at all"
    );
    assert!(
        phases.iter().any(|l| !*l),
        "a steady border is not a flash: it must blink"
    );
}

#[test]
fn the_scrollback_label_tracks_the_offset() {
    let mut pane = TerminalPane::new("pty-1".to_string(), 10, 2);
    pane.apply(&output("a\r\nb\r\nc\r\nd"));
    assert_eq!(pane.scrollback_label(), None, "live view has no label");
    pane.screen.scroll_by(2);
    assert_eq!(pane.scrollback_label().as_deref(), Some("\u{2212}2"));
    pane.screen.scroll_to_bottom();
    assert_eq!(pane.scrollback_label(), None);
}

#[test]
fn the_empty_state_clears_on_first_output() {
    let mut pane = pane();
    assert!(!pane.saw_output, "a fresh pane has printed nothing");
    pane.apply(&output("x"));
    assert!(pane.saw_output, "any output retires the empty state");
}

#[test]
fn a_replay_clears_a_stale_bell() {
    // A half-faded flash from the previous view must not survive the reset:
    // the replay replaces everything on screen.
    let mut pane = pane();
    pane.apply(&output("\x07"));
    assert!(pane.bell_flash_frames > 0);
    pane.apply(&replay("fresh"));
    assert_eq!(pane.bell_flash_frames, 0);
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
