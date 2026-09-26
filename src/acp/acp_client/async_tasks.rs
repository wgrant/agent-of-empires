//! Stopping one background task the adapter reports through AIR async tasks,
//! rather than cancelling the whole turn.

use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::{Agent, ConnectionTo, JsonRpcRequest};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "_session/async_task/stop", response = serde_json::Value)]
#[serde(rename_all = "camelCase")]
struct StopAsyncTaskRequest {
    session_id: SessionId,
    async_task_id: String,
}

/// Fired detached: the adapter reports the task's new state itself.
pub(super) fn dispatch_stop_async_task(
    connection: &ConnectionTo<Agent>,
    session_id: &SessionId,
    async_task_id: String,
) {
    info!(target: "acp.protocol", task = %async_task_id, "sending _session/async_task/stop");
    let sent = connection.send_request(StopAsyncTaskRequest {
        session_id: session_id.clone(),
        async_task_id: async_task_id.clone(),
    });
    tokio::spawn(async move {
        if let Err(e) = sent.block_task().await {
            warn!(target: "acp.protocol", task = %async_task_id, "_session/async_task/stop failed: {e}");
        }
    });
}
