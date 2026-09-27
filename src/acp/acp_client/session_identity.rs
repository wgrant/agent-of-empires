//! Native session admission, selected only by the connection lifecycle.

use agent_client_protocol::schema::v1::{RequestId, SessionId, SessionNotification};
use agent_client_protocol::{
    Agent, ConnectionTo, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, UntypedMessage,
};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StateMutex;
use tokio::sync::{oneshot, Mutex, MutexGuard, Notify};

use super::errors::acp_internal_error;
use super::subagents::{ended_child, spawned_child, MAX_SUBAGENTS};
use crate::acp::control_protocol::{
    PromptCompletedMarker, SessionReplayed, MAX_CONTROL_QUEUE_BYTES, MAX_CONTROL_QUEUE_FRAMES,
};

// The replayed backlog a reattach flushes is exactly the runner's detached
// control queue, so this buffer is sized against the same contract: a
// legitimate reattach must accept the whole flushed queue rather than be
// killed for a backlog the runner was entitled to hold. Charge original control
// frame bytes: typed schema serialization can expand the native representation.
// Direct stdio has no detached queue and bounds its typed notification payload.
const MAX_PENDING_UPDATES: usize = MAX_CONTROL_QUEUE_FRAMES;
const MAX_PENDING_BYTES: usize = MAX_CONTROL_QUEUE_BYTES;

// Only the daemon control reader writes this synthetic transport field.
pub(super) const CONTROL_FRAME_BYTES_FIELD: &str = "__aoe_control_frame_bytes";

/// Every agent-side notification the connection admits, on one handler.
///
/// The SDK renders its whole handler chain per inbound message
/// (`trace!(handler = ?handler.describe_chain())`), and each link nests the
/// links below it through `{:?}`, so the rendered description roughly doubles
/// per added link. One more `on_receive_notification` therefore doubles the
/// per-notification cost of a replay, so new agent-side notifications join
/// this type rather than extending the chain.
#[derive(Clone, Debug)]
pub(super) enum SessionIngressNotification {
    Update(serde_json::Value),
    /// Runner-minted barrier marking the end of a session/load replay (#4016).
    Replayed(SessionReplayed),
    /// Daemon-minted barrier releasing a local prompt's outcome.
    PromptCompleted(PromptCompletedMarker),
}

impl JsonRpcMessage for SessionIngressNotification {
    fn matches_method(method: &str) -> bool {
        SessionNotification::matches_method(method)
            || SessionReplayed::matches_method(method)
            || PromptCompletedMarker::matches_method(method)
    }

    fn method(&self) -> &str {
        match self {
            Self::Update(_) => "session/update",
            Self::Replayed(marker) => marker.method(),
            Self::PromptCompleted(marker) => marker.method(),
        }
    }

    fn to_untyped_message(&self) -> agent_client_protocol::Result<UntypedMessage> {
        match self {
            Self::Update(params) => UntypedMessage::new(self.method(), params),
            Self::Replayed(marker) => marker.to_untyped_message(),
            Self::PromptCompleted(marker) => marker.to_untyped_message(),
        }
    }

    fn parse_message(
        method: &str,
        params: &impl serde::Serialize,
    ) -> agent_client_protocol::Result<Self> {
        if SessionReplayed::matches_method(method) {
            return Ok(Self::Replayed(SessionReplayed::parse_message(
                method, params,
            )?));
        }
        if PromptCompletedMarker::matches_method(method) {
            return Ok(Self::PromptCompleted(PromptCompletedMarker::parse_message(
                method, params,
            )?));
        }
        if !SessionNotification::matches_method(method) {
            return Err(agent_client_protocol::Error::method_not_found());
        }
        Ok(Self::Update(serde_json::to_value(params)?))
    }
}

impl JsonRpcNotification for SessionIngressNotification {}

impl SessionIngressNotification {
    /// Decode a `session/update` payload, splitting off the daemon reader's
    /// control frame byte count.
    pub(super) fn decode_update(
        mut params: serde_json::Value,
        control_transport: bool,
    ) -> agent_client_protocol::Result<(SessionNotification, Option<usize>)> {
        let invalid = |error: serde_json::Error| {
            agent_client_protocol::Error::invalid_params().data(error.to_string())
        };
        let wire_bytes = if control_transport {
            let claim = match &mut params {
                serde_json::Value::Object(fields) => fields.remove(CONTROL_FRAME_BYTES_FIELD),
                serde_json::Value::Array(fields) => fields.pop(),
                _ => None,
            }
            .ok_or_else(|| {
                agent_client_protocol::Error::invalid_params()
                    .data("missing control frame byte count")
            })?;
            Some(serde_json::from_value(claim).map_err(invalid)?)
        } else {
            None
        };
        super::extension_updates::tunnel_extension_update(&mut params);
        Ok((serde_json::from_value(params).map_err(invalid)?, wire_bytes))
    }
}

/// Admit the child an admitted session's `subagent_spawned` announces.
fn admit_child(children: &mut HashSet<SessionId>, notification: &SessionNotification) {
    if let Some(child) = spawned_child(&notification.update) {
        if children.len() < MAX_SUBAGENTS {
            children.insert(child);
        }
    } else if let Some(child) = ended_child(&notification.update) {
        children.remove(&child);
    }
}

#[derive(Default)]
pub(super) struct SessionIngress {
    state: StateMutex<IdentityState>,
    pub(super) fence: Mutex<()>,
    changed: Notify,
    failure: Notify,
}

#[derive(Default)]
struct IdentityState {
    current: Option<SessionId>,
    /// Native subagent sessions announced under `current`, admitted alongside it.
    children: HashSet<SessionId>,
    pending: Option<Establishment>,
    generation: u64,
    failed: bool,
}

struct Establishment {
    generation: u64,
    candidate: Option<SessionId>,
    updates: Vec<SessionNotification>,
    encoded_bytes: usize,
    /// Subagents already running when this establishment began, admitted with it.
    subagents: HashSet<SessionId>,
}

/// Count encoded pending payload without retaining a second copy.
struct PendingByteCount {
    written: usize,
    limit: usize,
}

impl std::io::Write for PendingByteCount {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.written = self
            .written
            .checked_add(bytes.len())
            .filter(|written| *written <= self.limit)
            .ok_or(std::io::ErrorKind::WriteZero)?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(PartialEq)]
enum RequestAdmission {
    Reject,
    AwaitCommit,
    Active,
}

impl SessionIngress {
    pub(super) fn new(current: Option<SessionId>) -> Self {
        Self {
            state: StateMutex::new(IdentityState {
                current,
                ..IdentityState::default()
            }),
            ..Self::default()
        }
    }

    pub(super) fn current(&self) -> Option<SessionId> {
        self.state.lock().unwrap().current.clone()
    }

    /// Called under the mutation fence, or before the connection starts.
    pub(super) fn begin(&self) -> u64 {
        let mut state = self.state.lock().unwrap();
        state.generation += 1;
        let generation = state.generation;
        state.pending = Some(Establishment {
            generation,
            candidate: None,
            updates: Vec::new(),
            encoded_bytes: 0,
            subagents: HashSet::new(),
        });
        generation
    }

    /// Admit subagents a previous daemon saw announced and not yet ended: a
    /// reattached runner keeps them running, but their announcements are
    /// gone from what it flushes.
    pub(super) fn readmit_subagents(&self, ids: impl IntoIterator<Item = SessionId>) {
        let mut state = self.state.lock().unwrap();
        let ids = ids.into_iter().take(MAX_SUBAGENTS);
        match state.pending.as_mut() {
            Some(pending) => pending.subagents.extend(ids),
            None => state.children.extend(ids),
        }
    }

    /// Publish a response fact under the wire's ordering barrier, not an update's ID.
    pub(super) fn resolve(&self, generation: Option<u64>, id: SessionId) {
        let mut state = self.state.lock().unwrap();
        if !state.failed {
            if let Some(pending) = state.pending.as_mut() {
                if generation.is_none_or(|generation| generation == pending.generation) {
                    pending.candidate = Some(id);
                }
            }
        }
    }

    /// Caller retains the fence through boundary publication and returned replay.
    pub(super) fn finish(
        &self,
        id: Option<SessionId>,
    ) -> agent_client_protocol::Result<Vec<SessionNotification>> {
        let mut state = self.state.lock().unwrap();
        if state.failed {
            return Err(Self::overflow_error());
        }
        let (mut updates, mut children) = state
            .pending
            .take()
            .map(|pending| (pending.updates, pending.subagents))
            .unwrap_or_default();
        updates.retain(|notification| {
            let admitted = Some(&notification.session_id) == id.as_ref()
                || children.contains(&notification.session_id);
            if admitted {
                admit_child(&mut children, notification);
            }
            admitted
        });
        state.current = id;
        state.children = children;
        drop(state);
        self.changed.notify_waiters();
        Ok(updates)
    }

    /// Hold the admission fence through effects, retaining bytes across both checks.
    pub(super) async fn notification(
        &self,
        notification: SessionNotification,
        wire_bytes: Option<usize>,
    ) -> agent_client_protocol::Result<Option<(SessionNotification, MutexGuard<'_, ()>)>> {
        let Some(notification) = self.route(notification, wire_bytes)? else {
            return Ok(None);
        };
        let guard = self.fence.lock().await;
        Ok(self
            .route(notification, wire_bytes)?
            .map(|notification| (notification, guard)))
    }

    fn route(
        &self,
        notification: SessionNotification,
        wire_bytes: Option<usize>,
    ) -> agent_client_protocol::Result<Option<SessionNotification>> {
        let mut state = self.state.lock().unwrap();
        if state.failed {
            return Ok(None);
        }
        if let Some(pending) = state.pending.as_mut() {
            // No encoded-size work on the established per-token path.
            let size = if pending.updates.len() >= MAX_PENDING_UPDATES {
                None
            } else if let Some(size) = wire_bytes {
                (size <= MAX_PENDING_BYTES - pending.encoded_bytes).then_some(size)
            } else {
                // Stdio has no detached control queue; bound its typed payload.
                let mut count = PendingByteCount {
                    written: 0,
                    limit: MAX_PENDING_BYTES - pending.encoded_bytes,
                };
                serde_json::to_writer(&mut count, &notification)
                    .ok()
                    .map(|()| count.written)
            };
            let Some(size) = size else {
                pending.updates.clear();
                pending.encoded_bytes = 0;
                state.failed = true;
                drop(state);
                self.changed.notify_waiters();
                self.failure.notify_one();
                return Err(Self::overflow_error());
            };
            pending.encoded_bytes += size;
            pending.updates.push(notification);
            return Ok(None);
        }
        let admitted = state.current.as_ref() == Some(&notification.session_id)
            || state.children.contains(&notification.session_id);
        if admitted {
            admit_child(&mut state.children, &notification);
        }
        Ok(admitted.then_some(notification))
    }

    /// Whether `id` is an admitted subagent session rather than the main one.
    pub(super) fn is_subagent(&self, id: &SessionId) -> bool {
        self.state.lock().unwrap().children.contains(id)
    }

    fn request_admission(&self, id: &SessionId) -> RequestAdmission {
        let state = self.state.lock().unwrap();
        if state.failed {
            return RequestAdmission::Reject;
        }
        if let Some(pending) = state.pending.as_ref() {
            // Subagents re-admitted with this session, or announced during
            // it, are decided by the same commit.
            let awaits = pending.candidate.as_ref() == Some(id)
                || pending.subagents.contains(id)
                || pending
                    .updates
                    .iter()
                    .any(|update| spawned_child(&update.update).as_ref() == Some(id));
            return if awaits {
                RequestAdmission::AwaitCommit
            } else {
                RequestAdmission::Reject
            };
        }
        if state.current.as_ref() == Some(id) || state.children.contains(id) {
            RequestAdmission::Active
        } else {
            RequestAdmission::Reject
        }
    }

    pub(super) async fn request(
        &self,
        id: &SessionId,
    ) -> agent_client_protocol::Result<MutexGuard<'_, ()>> {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match self.request_admission(id) {
                RequestAdmission::Reject => {
                    let mut error = agent_client_protocol::Error::invalid_params();
                    error.message = "sessionId does not identify the active native session".into();
                    return Err(error);
                }
                RequestAdmission::AwaitCommit => changed.await,
                RequestAdmission::Active => {
                    let guard = self.fence.lock().await;
                    if self.request_admission(id) == RequestAdmission::Active {
                        return Ok(guard);
                    }
                    drop(guard);
                }
            }
        }
    }

    pub(super) async fn failed(&self) -> agent_client_protocol::Error {
        loop {
            let failed = self.failure.notified();
            tokio::pin!(failed);
            failed.as_mut().enable();
            if self.state.lock().unwrap().failed {
                return Self::overflow_error();
            }
            failed.await;
        }
    }

    fn overflow_error() -> agent_client_protocol::Error {
        acp_internal_error("pending native session updates exceed replay capacity".into())
    }
}

struct CancelOrderedRequest {
    connection: ConnectionTo<Agent>,
    id: RequestId,
    settled: Arc<AtomicBool>,
}

impl Drop for CancelOrderedRequest {
    fn drop(&mut self) {
        if !self.settled.swap(true, Ordering::AcqRel) {
            let _ = self.connection.send_cancel_request(self.id.clone());
        }
    }
}

/// Preserve response-before-callback ordering and the foreground waiter's cancellation.
pub(super) async fn ordered_session_request<Req>(
    connection: &ConnectionTo<Agent>,
    ingress: &Arc<SessionIngress>,
    generation: u64,
    request: Req,
    native_id: fn(&Req::Response) -> SessionId,
) -> agent_client_protocol::Result<Req::Response>
where
    Req: JsonRpcRequest,
    Req::Response: Send + 'static,
{
    let sent = connection.send_request(request);
    let settled = Arc::new(AtomicBool::new(false));
    let _cancel = CancelOrderedRequest {
        connection: connection.clone(),
        id: sent.id().clone(),
        settled: settled.clone(),
    };
    let ingress = ingress.clone();
    let (tx, rx) = oneshot::channel();
    sent.on_receiving_result(move |result| async move {
        settled.store(true, Ordering::Release);
        if let Ok(response) = result.as_ref() {
            ingress.resolve(Some(generation), native_id(response));
        }
        let _ = tx.send(result);
        Ok(())
    })?;
    rx.await
        .map_err(|_| acp_internal_error("session response waiter closed".into()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::acp_client::test_helpers::text_chunk;

    fn notif(id: &str) -> SessionNotification {
        SessionNotification::new(id.to_string(), text_chunk("x", None))
    }

    #[tokio::test]
    async fn pending_replay_and_wire_budget_are_bounded() {
        let ingress = SessionIngress::new(Some(SessionId::from("s")));
        let guard = ingress.fence.lock().await;
        let mut admission =
            std::pin::pin!(ingress.notification(notif("s"), Some(MAX_PENDING_BYTES / 2)));
        assert!(futures_util::poll!(admission.as_mut()).is_pending());
        ingress.begin();
        drop(guard);
        assert!(admission.await.unwrap().is_none());
        assert!(ingress
            .notification(notif("s"), Some(MAX_PENDING_BYTES / 2))
            .await
            .unwrap()
            .is_none());
        assert!(ingress.notification(notif("s"), Some(1)).await.is_err());
        assert!(futures_util::poll!(std::pin::pin!(ingress.failed())).is_ready());
        assert!(ingress.finish(Some(SessionId::from("s"))).is_err());

        // The budget accepts its exact ceiling.
        {
            let ingress = SessionIngress::default();
            ingress.begin();
            for _ in 0..2 {
                ingress
                    .route(notif("s"), Some(MAX_PENDING_BYTES / 2))
                    .unwrap();
            }
            assert_eq!(ingress.finish(Some(SessionId::from("s"))).unwrap().len(), 2);
        }

        {
            let ingress = SessionIngress::default();
            ingress.begin();
            for _ in 0..MAX_CONTROL_QUEUE_FRAMES {
                ingress
                    .route(notif("s"), None)
                    .expect("a full detach-queue backlog fits");
            }
            let replay = ingress
                .finish(Some(SessionId::from("s")))
                .expect("commit succeeds");
            assert_eq!(replay.len(), MAX_CONTROL_QUEUE_FRAMES);

            // Past that contract the buffer stays bounded: an overflow fails the
            // attach rather than growing without limit.
            {
                let ingress = SessionIngress::default();
                ingress.begin();
                for _ in 0..MAX_CONTROL_QUEUE_FRAMES {
                    ingress.route(notif("s"), None).expect("under the cap");
                }
                assert!(ingress.route(notif("s"), None).is_err());
            }
        }
    }

    fn spawned(on: &str, child: &str) -> SessionNotification {
        let mut params = serde_json::json!({
            "sessionId": on,
            "update": {"sessionUpdate": "subagent_spawned", "subagentSessionId": child,
                       "name": "n", "task": "t", "capabilities": {}},
        });
        super::super::extension_updates::tunnel_extension_update(&mut params);
        serde_json::from_value(params).unwrap()
    }

    #[test]
    fn announced_subagents_are_admitted_live_and_in_replay() {
        let admitted = |ingress: &SessionIngress, n| ingress.route(n, None).unwrap().is_some();
        let id = |s: &str| SessionId::from(s.to_string());
        let ingress = SessionIngress::new(Some(id("root")));
        assert!(!admitted(&ingress, notif("child")), "unannounced");
        assert!(admitted(&ingress, spawned("root", "child")));
        assert!(admitted(&ingress, notif("child")));
        assert!(admitted(&ingress, spawned("child", "grandchild")));
        assert!(admitted(&ingress, notif("grandchild")));
        assert!(!admitted(&ingress, spawned("stranger", "x")));
        assert!(
            !admitted(&ingress, notif("x")),
            "announced by an unadmitted session"
        );
        assert!(ingress.is_subagent(&id("grandchild")) && !ingress.is_subagent(&id("root")));
        assert!(ingress.request_admission(&id("child")) == RequestAdmission::Active);

        // A replay keeps a child's updates only after its announcement, and
        // children of the previous session do not carry over.
        ingress.begin();
        for n in [
            notif("child"),
            spawned("root", "child"),
            notif("child"),
            notif("x"),
        ] {
            ingress.route(n, None).unwrap();
        }
        let replay = ingress.finish(Some(id("root"))).unwrap();
        let sessions: Vec<&str> = replay.iter().map(|n| n.session_id.0.as_ref()).collect();
        assert_eq!(sessions, ["root", "child"]);
        assert!(ingress.is_subagent(&id("child")) && !ingress.is_subagent(&id("grandchild")));

        // During an establishment, a re-admitted or newly announced child's
        // request waits for the commit like the session's own.
        ingress.begin();
        ingress.readmit_subagents([id("kept")]);
        ingress.route(spawned("root", "fresh"), None).unwrap();
        for waiting in ["kept", "fresh"] {
            assert!(ingress.request_admission(&id(waiting)) == RequestAdmission::AwaitCommit);
        }
        assert!(ingress.request_admission(&id("stranger")) == RequestAdmission::Reject);
        ingress.finish(Some(id("root"))).unwrap();

        // An ended child leaves the admitted set, so it never fills up.
        let mut params = serde_json::json!({
            "sessionId": "root",
            "update": {"sessionUpdate": "subagent_state_update", "subagentSessionId": "fresh",
                       "state": "completed"},
        });
        super::super::extension_updates::tunnel_extension_update(&mut params);
        assert!(admitted(&ingress, serde_json::from_value(params).unwrap()));
        assert!(!ingress.is_subagent(&id("fresh")) && ingress.is_subagent(&id("kept")));
    }
}
