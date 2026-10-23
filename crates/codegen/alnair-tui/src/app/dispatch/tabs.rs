//! Session tab dispatch: activation, closing, reopening, and the view mark.
//!
//! A tab is a view, not a session. Closing a tab therefore never closes the
//! session — it only removes the chip and, if it was active, moves the cursor
//! to a neighbour. The one action that touches the agent is activation, which
//! routes through `switch_to_agent` (the single funnel that also registers the
//! tab) or `dispatch_load_session` when the session is not hosted locally.
//!
//! Every mutation writes the shared store. Writes are fire-and-forget: a failed
//! write degrades to a per-process strip rather than blocking the UI.

use super::ctx::{SwitchCause, find_agent_id_by_session_id, switch_to_agent};
use super::session::load::dispatch_load_session;
use crate::app::actions::Effect;
use crate::app::app_view::{ActiveView, AppView};
use crate::app::tabs::store;

/// Persist the current tab list under the active scope.
fn persist(app: &AppView) {
    let scope = app.tabs_scope;
    let cwd_key = app.cwd.to_string_lossy().into_owned();
    let tabs = app.tabs.tabs().to_vec();
    let active = app.tabs.active_index();
    // Fire-and-forget: the store takes a blocking flock, so it cannot run on
    // the dispatch path. `update` is cheap to call and the lock is held only
    // for one read-modify-write.
    std::thread::spawn(move || {
        let result = store::update(move |state| {
            state.scope = scope;
            let list = state.list_mut(scope, &cwd_key);
            list.tabs = tabs;
            list.active = active;
        });
        if let Err(e) = result {
            tracing::warn!(error = %e, "failed to persist pager tab state");
        }
    });
}

/// Activate the tab at `index`, loading the session when it is not local.
pub(in crate::app::dispatch) fn dispatch_switch_to_tab(
    app: &mut AppView,
    index: usize,
) -> Vec<Effect> {
    let Some(tab) = app.tabs.tabs().get(index).cloned() else {
        return vec![];
    };
    dispatch_activate_session(app, &tab.session_id, &tab.cwd)
}

/// Activate the tab for a session id (mouse clicks land here).
pub(in crate::app::dispatch) fn dispatch_switch_to_tab_id(
    app: &mut AppView,
    session_id: &str,
) -> Vec<Effect> {
    let Some(tab) = app
        .tabs
        .tabs()
        .iter()
        .find(|t| t.session_id == session_id)
        .cloned()
    else {
        return vec![];
    };
    dispatch_activate_session(app, &tab.session_id, &tab.cwd)
}

/// The one place a tab turns into a view switch.
///
/// Locally-hosted sessions go through `switch_to_agent`; anything else is a
/// leader-hosted session this client is not attached to yet, so it takes the
/// strict `session/load` path (join-not-steal, so it attaches as a viewer).
fn dispatch_activate_session(
    app: &mut AppView,
    session_id: &str,
    cwd: &std::path::Path,
) -> Vec<Effect> {
    if let Some(agent_id) = find_agent_id_by_session_id(&app.agents, session_id) {
        switch_to_agent(app, agent_id, SwitchCause::Picker);
        app.tabs.set_active_id(session_id);
        persist(app);
        return vec![];
    }
    app.tabs.set_active_id(session_id);
    dispatch_load_session(app, session_id.to_string(), Some(cwd.to_path_buf()), false)
}

/// Close the active tab and activate a neighbour.
pub(in crate::app::dispatch) fn dispatch_close_tab(app: &mut AppView) -> Vec<Effect> {
    let Some(index) = app.tabs.active_index() else {
        return vec![];
    };
    dispatch_close_tab_at(app, index)
}

/// Close a specific tab by session id (a chip's own `×`).
///
/// A click on a background chip's close glyph must remove THAT tab, not
/// whatever is active; routing it through `dispatch_close_tab` would close the
/// wrong one.
pub(in crate::app::dispatch) fn dispatch_close_tab_id(
    app: &mut AppView,
    session_id: &str,
) -> Vec<Effect> {
    let Some(index) = app
        .tabs
        .tabs()
        .iter()
        .position(|t| t.session_id == session_id)
    else {
        return vec![];
    };
    dispatch_close_tab_at(app, index)
}

/// Remove the tab at `index`, persist, and activate the neighbour.
fn dispatch_close_tab_at(app: &mut AppView, index: usize) -> Vec<Effect> {
    let Some(closed) = app.tabs.close(index) else {
        return vec![];
    };
    // In-process guard: an async write started before this close must not
    // revive the chip. Cross-process revival is impossible — the store's lock
    // spans the whole read-modify-write.
    app.cancelled_tabs.insert(closed.session_id.clone());
    persist(app);

    match app.tabs.active().map(|t| t.session_id.clone()) {
        Some(next) => dispatch_switch_to_tab_id(app, &next),
        None => {
            app.active_view = ActiveView::Welcome;
            vec![]
        }
    }
}

/// Reopen the most recently closed tab.
pub(in crate::app::dispatch) fn dispatch_reopen_tab(app: &mut AppView) -> Vec<Effect> {
    let Some(reopened) = app.tabs.reopen() else {
        app.show_toast("No closed tab to reopen");
        return vec![];
    };
    app.cancelled_tabs.remove(&reopened.session_id);
    persist(app);
    dispatch_activate_session(app, &reopened.session_id, &reopened.cwd)
}

/// Move the tab cursor and activate the result.
pub(in crate::app::dispatch) fn dispatch_cycle_tab(
    app: &mut AppView,
    forward: bool,
) -> Vec<Effect> {
    let Some(tab) = app.tabs.cycle(forward).cloned() else {
        return vec![];
    };
    persist(app);
    dispatch_activate_session(app, &tab.session_id, &tab.cwd)
}

/// Open the app-level directory picker for "where should the new session go?".
///
/// The strip's `+` and `/new` both land here. `+` used to route through the
/// dashboard's picker, which meant it was refused whenever the dashboard was
/// not the foreground view; the picker is app-level now, so the question is
/// asked in place.
pub(in crate::app::dispatch) fn open_new_session_picker(app: &mut AppView) -> Vec<Effect> {
    use crate::app::app_view::PendingLocationChoice;
    use crate::views::location_picker::LocationPickerPurpose;

    if app.location_picker.is_some() {
        return vec![];
    }
    // Anchor on the active tab's directory: with a global strip spanning
    // repositories, the process cwd is the wrong guess.
    let base = app
        .tabs
        .active()
        .map(|t| t.cwd.clone())
        .unwrap_or_else(|| app.cwd.clone());
    app.location_picker = Some(crate::views::location_picker::open_location_picker(
        base,
        LocationPickerPurpose::NewSession,
        false,
    ));
    app.pending_location = Some(PendingLocationChoice::NewSession);
    vec![]
}

/// Open the app-level directory picker to move the pager (welcome screen).
pub(in crate::app::dispatch) fn open_pager_cwd_picker(app: &mut AppView) -> Vec<Effect> {
    use crate::app::app_view::PendingLocationChoice;
    use crate::views::location_picker::LocationPickerPurpose;

    if app.location_picker.is_some() {
        return vec![];
    }
    app.location_picker = Some(crate::views::location_picker::open_location_picker(
        app.cwd.clone(),
        LocationPickerPurpose::PagerCwd,
        false,
    ));
    app.pending_location = Some(PendingLocationChoice::PagerCwd);
    vec![]
}

/// Close the app-level picker without applying anything.
pub(in crate::app::dispatch) fn dispatch_close_app_location_picker(
    app: &mut AppView,
) -> Vec<Effect> {
    app.location_picker = None;
    app.pending_location = None;
    vec![]
}

/// Apply a path chosen in the app-level picker.
///
/// Validates first: a bad path keeps the modal open with an inline error
/// rather than silently creating a session in the old directory.
pub(in crate::app::dispatch) fn dispatch_app_location_chosen(
    app: &mut AppView,
    input: String,
) -> Vec<Effect> {
    use crate::app::app_view::PendingLocationChoice;

    let Some(purpose) = app.pending_location.clone() else {
        return dispatch_close_app_location_picker(app);
    };
    let Some(path) = crate::views::location_picker::resolve_location_input(&input, &app.cwd)
        .filter(|p| p.is_dir())
    else {
        if let Some(modal) = app.location_picker.as_mut() {
            modal.state.error = Some(format!("Not a directory: {}", input.trim()));
        }
        return vec![];
    };

    app.location_picker = None;
    app.pending_location = None;
    match purpose {
        PendingLocationChoice::NewSession => dispatch_new_session_in_dir(app, path),
        PendingLocationChoice::PagerCwd => dispatch_move_pager_cwd(app, path),
    }
}

/// Point the pager at `path` without creating a session.
fn dispatch_move_pager_cwd(app: &mut AppView, path: std::path::PathBuf) -> Vec<Effect> {
    let display = crate::project_picker::sources::display_path(&path);
    let changed = app.cwd != path;
    app.cwd = path.clone();
    app.cwd_has_git_ancestor = path.ancestors().any(|p| p.join(".git").exists());
    crate::git_info::populate_from_cwd_async(path.clone());
    if let Some(d) = app.dashboard.as_mut() {
        d.cwd = path.clone();
        d.cwd_has_git_ancestor = app.cwd_has_git_ancestor;
    }
    if changed {
        app.show_toast(&format!("\u{2192} {display}"));
    }
    vec![Effect::SetWorkingDir { path }]
}

/// Create a new session rooted at `path`.
///
/// The session is created in the chosen directory *without* moving the
/// process cwd: a global strip spans repositories, so re-rooting the pager
/// would silently change where unrelated later actions resolve relative
/// paths. `/cd` remains the explicit way to move the pager itself.
pub(in crate::app::dispatch) fn dispatch_new_session_in_dir(
    app: &mut AppView,
    path: std::path::PathBuf,
) -> Vec<Effect> {
    use super::session::lifecycle::dispatch_new_session_inner;

    // The project picker's question is answered by this dialog; asking it
    // again inside the fresh session would be a second prompt for the same
    // decision.
    let saved_shown = app.project_picker_shown;
    app.project_picker_shown = true;
    let mut effects = dispatch_new_session_inner(app, None);
    app.project_picker_shown = saved_shown;

    // `dispatch_new_session_inner` seeds the agent from the active session's
    // cwd (or `app.cwd`). Re-point the freshly created placeholder at the
    // chosen directory before its `CreateSession` effect runs.
    let Some(agent_id) = effects.iter().find_map(|e| match e {
        Effect::CreateSession { agent_id, .. } => Some(*agent_id),
        _ => None,
    }) else {
        return effects;
    };
    if let Some(agent) = app.agents.get_mut(&agent_id) {
        agent.session.cwd = path.clone();
        agent.prompt.file_search.retarget(&path);
    }
    for effect in &mut effects {
        if let Effect::CreateSession {
            agent_id: id, cwd, ..
        } = effect
            && *id == agent_id
        {
            *cwd = path.clone();
        }
    }
    effects
}

/// Register a session as a tab (called from `switch_to_agent`).
pub(crate) fn register_tab(app: &mut AppView, session_id: &str, cwd: std::path::PathBuf) {
    if app.cancelled_tabs.contains(session_id) {
        return;
    }
    app.tabs
        .open(crate::app::tabs::TabEntry::new(session_id, cwd));
    persist(app);
}

/// Register the tab a freshly-bound agent now owns.
///
/// `switch_to_agent` is the funnel for every `ActiveView::Agent` assignment,
/// but a brand-new session has no id yet when it runs — `AgentSession::session_id`
/// is `None` until the shell answers `CreateSession`. Without this second
/// registration, sessions created through `/new`, Ctrl+N, or a dashboard
/// dispatch never reached the strip, while a resumed session (id known up
/// front) did. The bind is the first moment a tab can be named, so it is the
/// right chokepoint.
///
/// The strip cursor only follows a session that is actually in front: a
/// dashboard dispatch leaves the dashboard foregrounded, and stealing the
/// active chip there would claim the user is looking at something they are
/// not.
pub(in crate::app::dispatch) fn register_agent_tab(
    app: &mut AppView,
    agent_id: crate::app::agent::AgentId,
) {
    let Some(agent) = app.agents.get(&agent_id) else {
        return;
    };
    let Some(session_id) = agent.session.session_id.as_ref().map(|s| s.0.to_string()) else {
        return;
    };
    if app.cancelled_tabs.contains(&session_id) {
        return;
    }
    let cwd = agent.session.cwd.clone();
    let foreground = matches!(app.active_view, ActiveView::Agent(id) if id == agent_id);
    // `open` moves the cursor onto the new chip; remember where it was so a
    // background bind can put it back.
    let previous = app.tabs.active().map(|t| t.session_id.clone());
    app.tabs
        .open(crate::app::tabs::TabEntry::new(session_id, cwd));
    if !foreground && let Some(previous) = previous {
        app.tabs.set_active_id(&previous);
    }
    persist(app);
}

/// Refresh a tab's title/cwd after a replay or rename, without moving the
/// cursor — arriving on a tab in another window must not steal focus here.
pub(in crate::app::dispatch) fn refresh_tab(
    app: &mut AppView,
    session_id: &str,
    title: Option<String>,
    cwd: Option<std::path::PathBuf>,
) {
    if app.tabs.find(session_id).is_none() {
        return;
    }
    app.tabs.refresh(session_id, title, cwd);
    persist(app);
}
