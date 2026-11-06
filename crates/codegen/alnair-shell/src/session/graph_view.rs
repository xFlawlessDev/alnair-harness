//! Read models and controls for graph clients; scheduling stays in the actor.

use super::graph_tracker::GraphOrchestration;

#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphInspection {
    pub graph: Option<GraphOrchestration>,
    pub enabled: bool,
    /// A projected graph belongs to another session and is read-only here.
    pub source: &'static str,
    pub node_goal: Option<GraphNodeGoalProgress>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphNodeGoalProgress {
    pub node_id: String,
    pub worker_rounds: u32,
    pub verify_rounds: u32,
    pub tokens_used: i64,
    pub elapsed_ms: u64,
    pub subagent_id: Option<String>,
    pub subagent_role: Option<String>,
    pub pause_message: Option<String>,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphControlAction {
    Pause,
    Clear,
}
