//! `/connect` -- pick a provider to connect, re-authenticate, or disconnect.

use crate::app::actions::Action;
use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand};

pub struct ConnectCommand;

impl SlashCommand for ConnectCommand {
    fn name(&self) -> &str {
        "connect"
    }

    fn description(&self) -> &str {
        "Connect a provider, or disconnect a connected one"
    }

    fn usage(&self) -> &str {
        "/connect"
    }

    /// Opens the provider picker rather than auto-starting a flow: the user
    /// chooses a row there, and already-connected providers show a green
    /// "connected" badge plus a `d` disconnect chord.
    fn run(&self, _ctx: &mut CommandExecCtx, _args: &str) -> CommandResult {
        CommandResult::Action(Action::OpenLoginPicker)
    }
}
