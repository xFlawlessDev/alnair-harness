//! Session-scoped graph inspection and boundary controls for ACP clients.

use agent_client_protocol as acp;
use serde::Deserialize;
use tokio::sync::oneshot;

use super::{Empty, ExtResult, parse_params, to_ext_response};
use crate::agent::MvpAgent;
use crate::session::{SessionCommand, graph_view::GraphControlAction};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphRequest {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphControlRequest {
    graph_id: String,
    action: GraphControlAction,
}

pub async fn handle(agent: &MvpAgent, args: &acp::ExtRequest) -> ExtResult {
    let req: GraphRequest = parse_params(args)?;
    let session = agent
        .sessions
        .borrow()
        .get(&acp::SessionId::new(req.session_id))
        .cloned()
        .ok_or_else(|| acp::Error::invalid_params().data("session not found"))?;
    match args.method.as_ref() {
        "alnair/graph/get" => {
            let (tx, rx) = oneshot::channel();
            session
                .cmd_tx
                .send(SessionCommand::InspectGraph { respond_to: tx })
                .map_err(|_| acp::Error::internal_error().data("session closed"))?;
            let result = rx
                .await
                .map_err(|_| acp::Error::internal_error().data("session closed"))?;
            to_ext_response(result.map_err(anyhow::Error::msg))
        }
        "alnair/graph/control" => {
            let req: GraphControlRequest = parse_params(args)?;
            let (tx, rx) = oneshot::channel();
            session
                .cmd_tx
                .send(SessionCommand::ControlGraph {
                    graph_id: req.graph_id,
                    action: req.action,
                    respond_to: tx,
                })
                .map_err(|_| acp::Error::internal_error().data("session closed"))?;
            let result = rx
                .await
                .map_err(|_| acp::Error::internal_error().data("session closed"))?;
            to_ext_response(result.map(|()| Empty {}).map_err(anyhow::Error::msg))
        }
        _ => Err(acp::Error::method_not_found()),
    }
}
