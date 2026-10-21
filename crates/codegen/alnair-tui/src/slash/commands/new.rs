//! `/new` (alias `/clear`) -- create a new session.
//!
//! Asks where first. A session created without naming its directory silently
//! inherits whatever the active session happened to be using, which is exactly
//! the guess a multi-tab user does not want; the picker makes the destination
//! an explicit choice. `/clear` keeps the old behavior because its name
//! promises "start over here", not "start somewhere else".

use crate::app::actions::Action;
use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand};

/// Start a new agent session, clearing the current conversation.
pub struct NewCommand;

impl SlashCommand for NewCommand {
    fn name(&self) -> &str {
        "new"
    }

    fn aliases(&self) -> &[&str] {
        &["clear"]
    }

    fn description(&self) -> &str {
        "Start a new session"
    }

    fn usage(&self) -> &str {
        "/new"
    }

    fn run(&self, _ctx: &mut CommandExecCtx, _args: &str) -> CommandResult {
        CommandResult::Action(Action::NewSessionPickLocation)
    }
}

/// `/clear` -- start a new session in the current directory, no questions.
pub struct ClearCommand;

impl SlashCommand for ClearCommand {
    fn name(&self) -> &str {
        "clear"
    }

    fn description(&self) -> &str {
        "Start a new session in the current directory"
    }

    fn usage(&self) -> &str {
        "/clear"
    }

    fn run(&self, _ctx: &mut CommandExecCtx, _args: &str) -> CommandResult {
        CommandResult::Action(Action::NewSession)
    }
}
