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

/// `+…`: choose a directory, then create there.
///
/// The location picker lives on the dashboard, so this opens the dashboard and
/// hands the picker to it. That keeps ONE picker implementation: the tab strip
/// reaches a repo with no session yet through the same affordance the dashboard
/// already offers, rather than growing a second modal.
pub(in crate::app::dispatch) fn dispatch_open_location_picker_for_tabs(
    app: &mut AppView,
) -> Vec<Effect> {
    if !matches!(app.active_view, ActiveView::AgentDashboard) {
        let effects = super::dashboard::dispatch_open_dashboard(app);
        if !matches!(app.active_view, ActiveView::AgentDashboard) {
            app.show_toast("Changing location needs the dashboard (/dashboard)");
            return effects;
        }
    }
    super::dashboard::dispatch_dashboard_open_location_picker(app)
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
