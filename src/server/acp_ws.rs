//! Acp WebSocket fanout.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{
    ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    Path, Query, State,
};
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};
use tokio::select;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;
use tracing::{debug, warn};

/// WebSocket close code 1001 ("going away").
const CLOSE_CODE_GOING_AWAY: u16 = 1001;

use super::{AcpBroadcastFrame, AppState};
use crate::acp::event_store::StoredEvent;
use crate::acp::state::{AcpSessionId, AcpState, AgentName};

/// Cadence at which the server emits an application-level Ping.
const PING_INTERVAL: Duration = Duration::from_secs(30);

/// Maximum gap allowed between Pongs before we tear down a stuck socket.
const PONG_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// The app-level keepalive frame emitted on every ping tick.
fn heartbeat_frame() -> String {
    r#"{"kind":"heartbeat"}"#.to_string()
}

/// Query parameters for the structured view WS upgrade.
#[derive(Debug, Default, Deserialize)]
pub struct AcpWsQuery {
    #[serde(default)]
    pub since: Option<u64>,
    /// Set `frames=0` to receive only the folded projections (`reduced_state` +
    /// `transcript_snapshot` / `transcript_delta`) and none of the raw event frames they
    /// are built from.
    #[serde(default)]
    pub frames: Option<u8>,
}

/// Public route handler for the structured view WebSocket.
pub async fn acp_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<AcpWsQuery>,
) -> impl IntoResponse {
    // Logged at DEBUG so we can prove the route was reached even when the upgrade fails.
    let since = q.since.unwrap_or(0);
    let forward_frames = q.frames.unwrap_or(1) != 0;
    debug!(
        target: "acp.ws",
        session = %id,
        since,
        forward_frames,
        "agent ws route entered, beginning upgrade"
    );
    let session_for_handler = id.clone();
    ws.protocols(["aoe-auth"])
        .on_upgrade(move |socket| async move {
            debug!(target: "acp.ws", session = %session_for_handler, "agent ws upgrade complete");
            handle(socket, session_for_handler, state, since, forward_frames).await
        })
}

async fn handle(
    mut socket: WebSocket,
    session_id: String,
    state: Arc<AppState>,
    since: u64,
    forward_frames: bool,
) {
    // Clone the shutdown token so this handler exits promptly when the daemon receives
    // SIGINT/SIGTERM/SIGHUP, instead of holding axum's graceful drain open until the
    // browser tab decides to disconnect.
    let shutdown = state.shutdown.clone();

    // Subscribe BEFORE the replay snapshot so events published in the window between
    // snapshot and live-loop entry land in `rx`.
    let mut rx = state.acp_events_tx.subscribe();

    // Keeps the session's shared transcript fold while this connection reads it.
    let _transcript_hold = state.acp_event_store.hold_transcript(&session_id);
    // Per-connection memory of the cold state fields already delivered.
    let mut cold = ColdFieldCache::default();

    // Replay events newer than `since` immediately on connect.
    let Connected {
        mut reduced,
        mut last_applied_seq,
        mut transcript_seq,
        sent: replay_count,
    } = connect_replay(
        &mut socket,
        &state,
        &session_id,
        since,
        forward_frames,
        &mut cold,
    )
    .await;
    debug!(
        target: "acp.ws",
        session = %session_id,
        since,
        replayed = replay_count,
        "agent ws subscribed"
    );

    let mut ping_interval = tokio::time::interval(PING_INTERVAL);
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // First tick fires immediately; consume it so the first ping waits
    // PING_INTERVAL rather than racing the upgrade handshake.
    ping_interval.tick().await;
    let mut last_pong_at = Instant::now();

    let mut shutting_down = false;
    loop {
        select! {
            _ = shutdown.cancelled() => {
                debug!(target: "acp.ws", session = %session_id, "shutdown signaled, closing");
                shutting_down = true;
                break;
            }
            client_msg = socket.recv() => {
                match client_msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Pong(_))) => {
                        // Browser ack of our keepalive Ping.
                        last_pong_at = Instant::now();
                        continue;
                    }
                    // Inbound messages from the client are not used today.
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => {
                        warn!(target: "acp.ws", "client recv error: {e}");
                        break;
                    }
                }
            }
            _ = ping_interval.tick() => {
                if last_pong_at.elapsed() > PONG_IDLE_TIMEOUT {
                    warn!(
                        target: "acp.ws",
                        session = %session_id,
                        idle_secs = last_pong_at.elapsed().as_secs(),
                        "agent ws idle reaper fired (no Pong from peer)"
                    );
                    break;
                }
                // App-level heartbeat the browser can actually see.
                if socket
                    .send(Message::Text(heartbeat_frame().into()))
                    .await
                    .is_err()
                {
                    debug!(target: "acp.ws", session = %session_id, "ws heartbeat send failed, peer gone");
                    break;
                }
                if socket
                    .send(Message::Ping(Vec::new().into()))
                    .await
                    .is_err()
                {
                    debug!(target: "acp.ws", session = %session_id, "ws Ping send failed, peer gone");
                    break;
                }
            }
            event = rx.recv() => {
                match event {
                    Ok(frame) => {
                        if frame.session_id != session_id {
                            continue;
                        }
                        if forward_frames {
                            let payload = match serde_json::to_string(&frame) {
                                Ok(s) => s,
                                Err(e) => {
                                    warn!(target: "acp.ws", "serialise frame: {e}");
                                    continue;
                                }
                            };
                            if socket.send(Message::Text(payload.into())).await.is_err() {
                                break;
                            }
                        }
                        // Reduce this event into the connection's control state and push
                        // the updated snapshot.
                        if frame.seq > last_applied_seq {
                            last_applied_seq = frame.seq;
                            let _ = reduced.apply_event((*frame.event).clone());
                        }
                        if !send_reduced_state(&mut socket, &session_id, frame.seq, &reduced, &mut cold).await {
                            break;
                        }
                        if frame.seq > transcript_seq
                            && !send_transcript_changes(
                                &mut socket,
                                &state,
                                &session_id,
                                &mut transcript_seq,
                            )
                            .await
                        {
                            break;
                        }
                    }
                    Err(RecvError::Lagged(skipped)) => {
                        // Tell the client they missed events so they can request a
                        // snapshot+replay rather than silently diverging.
                        let gap = serde_json::json!({
                            "kind": "lagged",
                            "skipped": skipped,
                        });
                        let _ = socket
                            .send(Message::Text(gap.to_string().into()))
                            .await;
                        // The skipped events never reached this connection; the
                        // daemon's own folds have them.
                        let (rebuilt, seq) = control_snapshot(&state, &session_id).await;
                        reduced = rebuilt;
                        last_applied_seq = seq;
                        // The cold-field cache still describes what this socket
                        // holds, so an unchanged command list stays omitted.
                        if !send_reduced_state(&mut socket, &session_id, seq, &reduced, &mut cold)
                            .await
                        {
                            break;
                        }
                        if !send_transcript_changes(
                            &mut socket,
                            &state,
                            &session_id,
                            &mut transcript_seq,
                        )
                        .await
                        {
                            break;
                        }
                    }
                    Err(RecvError::Closed) => break,
                }
            }
        }
    }

    debug!(target: "acp.ws", session = %session_id, "agent ws disconnected");
    let close_frame = if shutting_down {
        Some(CloseFrame {
            code: CLOSE_CODE_GOING_AWAY,
            reason: "server shutdown".into(),
        })
    } else {
        None
    };
    let _ = socket.send(Message::Close(close_frame)).await;
}

/// What a connection starts its live loop from.
struct Connected {
    reduced: AcpState,
    /// Highest seq folded into `reduced`.
    last_applied_seq: u64,
    /// Highest seq whose transcript changes the socket has.
    transcript_seq: u64,
    /// Frames forwarded.
    sent: usize,
}

/// Forward the stored frames after `since` (unless the client opted out with
/// `frames=0`), then send the connect snapshot: the daemon's control state
/// brought up to those frames, and the rows the session's shared transcript
/// fold changed after `since`.
async fn connect_replay(
    socket: &mut WebSocket,
    state: &AppState,
    session_id: &str,
    since: u64,
    forward_frames: bool,
    cold: &mut ColdFieldCache,
) -> Connected {
    // First, so every frame it has folded is in the log read below.
    let (mut reduced, mut last_applied_seq) = control_snapshot(state, session_id).await;
    let store = Arc::clone(&state.acp_event_store);
    let sid = session_id.to_string();
    let read = tokio::task::spawn_blocking(move || {
        let entries = store.replay_recorded_from(&sid, since);
        // Even with nothing new, the client times stalls from the latest event.
        let last_event_at = match entries.last() {
            Some(latest) => Some(latest.recorded_at),
            None => store
                .replay_page_before(&sid, u64::MAX, Some(1))
                .events
                .last()
                .map(|latest| latest.recorded_at),
        };
        let changes = store.transcript_changes(&sid, since, None);
        (entries, last_event_at, changes)
    })
    .await;
    let (entries, last_event_at, changes) = read.unwrap_or_else(|e| {
        // Blocking task panicked or was cancelled.
        warn!(
            target: "acp.ws",
            session_id = %session_id,
            error = %e,
            "replay drain blocking task failed; sending zero frames"
        );
        (Vec::new(), None, Default::default())
    });
    let mut sent = 0usize;
    let mut highest = since;
    let mut socket_open = true;
    for StoredEvent { seq, event, .. } in entries {
        highest = highest.max(seq);
        if seq > last_applied_seq {
            let _ = reduced.apply_event(event.clone());
            last_applied_seq = seq;
        }
        if !forward_frames || !socket_open {
            continue;
        }
        let frame = AcpBroadcastFrame {
            session_id: session_id.to_string(),
            seq,
            event: Arc::new(event),
            worker_generation: None,
        };
        let payload = match serde_json::to_string(&frame) {
            Ok(s) => s,
            Err(e) => {
                warn!(target: "acp.ws", "serialise replay frame: {e}");
                continue;
            }
        };
        socket_open = socket.send(Message::Text(payload.into())).await.is_ok();
        sent += usize::from(socket_open);
    }
    let snapshot_seq = highest.max(last_applied_seq);
    let _ = send_reduced_state(socket, session_id, snapshot_seq, &reduced, cold).await;
    let rows: Vec<_> = changes.rows.into_iter().map(|(row, _)| row).collect();
    let _ = send_transcript_snapshot(
        socket,
        session_id,
        snapshot_seq,
        &rows,
        &changes.removed,
        last_event_at,
    )
    .await;
    Connected {
        reduced,
        last_applied_seq,
        transcript_seq: changes.through,
        sent,
    }
}

/// The daemon's control state for the session and the last seq folded into it.
async fn control_snapshot(state: &AppState, session_id: &str) -> (AcpState, u64) {
    match state
        .session_service
        .control_state_snapshot(session_id)
        .await
    {
        Some(snapshot) => snapshot,
        None => {
            let (agent, model) = seed_identity(state, session_id).await;
            (
                AcpState::new(AcpSessionId(session_id.to_string()), agent, model),
                0,
            )
        }
    }
}

/// Send each row the session's transcript changed after `*through`, as the
/// fold now holds it, and advance `*through`. False once the socket is gone.
async fn send_transcript_changes(
    socket: &mut WebSocket,
    state: &AppState,
    session_id: &str,
    through: &mut u64,
) -> bool {
    use crate::acp::transcript::TranscriptDelta;
    let store = &state.acp_event_store;
    let changes = match store.transcript_changes_if_folded(session_id, *through) {
        Some(changes) => changes,
        None => {
            // Dropped after a missed event, so fold the log again off the runtime.
            let store = Arc::clone(store);
            let sid = session_id.to_string();
            let after = *through;
            match tokio::task::spawn_blocking(move || store.transcript_changes(&sid, after, None))
                .await
            {
                Ok(changes) => changes,
                Err(_) => return true,
            }
        }
    };
    *through = (*through).max(changes.through);
    for (row, created) in changes.rows {
        let delta = if created {
            TranscriptDelta::Append(row)
        } else {
            TranscriptDelta::Patch {
                id: row.id.clone(),
                row,
            }
        };
        if !send_transcript_delta(socket, session_id, *through, &delta).await {
            return false;
        }
    }
    for id in changes.removed {
        let delta = TranscriptDelta::Remove(id);
        if !send_transcript_delta(socket, session_id, *through, &delta).await {
            return false;
        }
    }
    true
}

/// State fields large enough, and static enough, to be worth suppressing when they have not
/// changed since the last frame on this connection.
const COLD_STATE_FIELDS: [&str; 5] = [
    "available_commands",
    "available_modes",
    "config_options",
    // Not static, but big and bursty.
    "recent_diffs",
    "background_agents",
];

async fn seed_identity(state: &AppState, session_id: &str) -> (AgentName, Option<String>) {
    let instances = state.instances.read().await;
    instances
        .iter()
        .find(|i| i.id == session_id)
        .map(|i| {
            (
                AgentName(i.agent_name.clone().unwrap_or_else(|| i.tool.clone())),
                i.agent_model.clone(),
            )
        })
        .unwrap_or_else(|| (AgentName(String::new()), None))
}

/// Per-connection memory of the cold fields already sent, so an unchanged one can be
/// omitted.
#[derive(Default)]
struct ColdFieldCache {
    hashes: std::collections::HashMap<&'static str, u64>,
}

impl ColdFieldCache {
    /// Strip the cold fields whose value this connection already has, and
    /// return their names so the client knows to keep what it holds rather
    /// than read the absence as "now empty".
    fn strip_unchanged(&mut self, state: &mut serde_json::Value) -> Vec<&'static str> {
        use std::hash::{Hash, Hasher};
        let Some(obj) = state.as_object_mut() else {
            return Vec::new();
        };
        let mut unchanged = Vec::new();
        for field in COLD_STATE_FIELDS {
            let Some(value) = obj.get(field) else {
                continue;
            };
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            value.to_string().hash(&mut hasher);
            let digest = hasher.finish();
            if self.hashes.get(field) == Some(&digest) {
                obj.remove(field);
                unchanged.push(field);
            } else {
                self.hashes.insert(field, digest);
            }
        }
        unchanged
    }
}

/// Serialize and send the reduced control state as a `kind`-tagged `reduced_state` frame.
async fn send_reduced_state(
    socket: &mut WebSocket,
    session_id: &str,
    seq: u64,
    reduced: &AcpState,
    cold: &mut ColdFieldCache,
) -> bool {
    let mut state = match serde_json::to_value(reduced) {
        Ok(v) => v,
        Err(e) => {
            warn!(target: "acp.ws", "serialise reduced_state: {e}");
            return true;
        }
    };
    let unchanged = cold.strip_unchanged(&mut state);
    let frame = serde_json::json!({
        "kind": "reduced_state",
        "session_id": session_id,
        "seq": seq,
        "state": state,
        "unchanged": unchanged,
    });
    match serde_json::to_string(&frame) {
        Ok(payload) => socket.send(Message::Text(payload.into())).await.is_ok(),
        Err(e) => {
            warn!(target: "acp.ws", "serialise reduced_state: {e}");
            true
        }
    }
}

async fn send_transcript_snapshot(
    socket: &mut WebSocket,
    session_id: &str,
    seq: u64,
    rows: &[crate::acp::transcript::TranscriptRow],
    removed: &[String],
    last_event_at: Option<chrono::DateTime<chrono::Utc>>,
) -> bool {
    let frame = serde_json::json!({
        "kind": "transcript_snapshot",
        "session_id": session_id,
        "seq": seq,
        "rows": rows,
        "removed": removed,
        "last_event_at": last_event_at,
    });
    match serde_json::to_string(&frame) {
        Ok(payload) => socket.send(Message::Text(payload.into())).await.is_ok(),
        Err(e) => {
            warn!(target: "acp.ws", "serialise transcript_snapshot: {e}");
            true
        }
    }
}

/// Serialize and send one incremental transcript row change as a `kind`-tagged
/// `transcript_delta` frame.
async fn send_transcript_delta(
    socket: &mut WebSocket,
    session_id: &str,
    seq: u64,
    delta: &crate::acp::transcript::TranscriptDelta,
) -> bool {
    let frame = serde_json::json!({
        "kind": "transcript_delta",
        "session_id": session_id,
        "seq": seq,
        "delta": delta,
    });
    match serde_json::to_string(&frame) {
        Ok(payload) => socket.send(Message::Text(payload.into())).await.is_ok(),
        Err(e) => {
            warn!(target: "acp.ws", "serialise transcript_delta: {e}");
            true
        }
    }
}

/// Helper used by the worker supervisor (and integration tests) to publish a frame.
pub fn publish(state: &AppState, frame: AcpBroadcastFrame) {
    // Discard the receiver count; broadcast::Sender::send is best-effort
    // and ignores send-with-no-receivers.
    let _ = state.acp_events_tx.send(frame);
}

/// Push-notification trigger for "agent needs your approval." Called by the worker
/// supervisor when it observes an `ApprovalRequested` structured view event.
pub async fn trigger_approval_push(
    state: &AppState,
    session_id: &str,
    approval_title: &str,
    destructive: bool,
    seq: u64,
) {
    let badge = if destructive {
        "DESTRUCTIVE"
    } else {
        "approval"
    };
    let title = format!("{} needs approval", session_id);
    let body = if destructive {
        format!("{badge}: {approval_title}")
    } else {
        approval_title.to_string()
    };
    let tag = approval_tag(session_id);
    send_acp_push(state, session_id, false, |url| AcpNotifyPayload {
        kind: "notify",
        title: title.clone(),
        body: body.clone(),
        url,
        tag: tag.clone(),
        session_id: session_id.to_string(),
        seq,
    })
    .await;
}

/// Retract a previously shown approval notification on every device once the approval is
/// handled.
pub async fn trigger_approval_clear_push(state: &AppState, session_id: &str, seq: u64) {
    let tag = approval_tag(session_id);
    send_acp_push(state, session_id, true, |url| AcpClearPayload {
        kind: "clear",
        title: "Resolved",
        body: "Handled on another device",
        url,
        tag: tag.clone(),
        session_id: session_id.to_string(),
        seq,
    })
    .await;
}

/// Tag shared by the approval show and clear pushes for a session.
fn approval_tag(session_id: &str) -> String {
    format!("acp-approval-{session_id}")
}

/// Tag shared by the question show and clear pushes for a session.
fn question_tag(session_id: &str) -> String {
    format!("acp-question-{session_id}")
}

/// Push-notification trigger for "agent asked you a question." Called by the worker
/// supervisor when it observes an `ElicitationRequested` (`AskUserQuestion`) structured
/// view event.
pub async fn trigger_question_push(state: &AppState, session_id: &str, question: &str, seq: u64) {
    let title = format!("{} has a question", session_id);
    let body = push_body_snippet(question);
    let tag = question_tag(session_id);
    send_acp_push(state, session_id, false, |url| AcpNotifyPayload {
        kind: "notify",
        title: title.clone(),
        body: body.clone(),
        url,
        tag: tag.clone(),
        session_id: session_id.to_string(),
        seq,
    })
    .await;
}

/// Retract a previously shown question notification once the question is answered.
pub async fn trigger_question_clear_push(state: &AppState, session_id: &str, seq: u64) {
    let tag = question_tag(session_id);
    send_acp_push(state, session_id, true, |url| AcpClearPayload {
        kind: "clear",
        title: "Resolved",
        body: "Handled on another device",
        url,
        tag: tag.clone(),
        session_id: session_id.to_string(),
        seq,
    })
    .await;
}

/// Payload for a dedicated ACP attention push (approval / question).
#[derive(Serialize)]
struct AcpNotifyPayload {
    kind: &'static str,
    title: String,
    body: String,
    url: String,
    tag: String,
    session_id: String,
    seq: u64,
}

/// Payload telling the service worker to retract a shown ACP attention notification once
/// the request is handled.
#[derive(Serialize)]
struct AcpClearPayload {
    kind: &'static str,
    title: &'static str,
    body: &'static str,
    url: String,
    tag: String,
    session_id: String,
    seq: u64,
}

/// Question text can be long and lands on a lock screen, so collapse
/// whitespace and cap it before it goes into a push payload.
fn push_body_snippet(s: &str) -> String {
    const MAX: usize = 120;
    let compact = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() > MAX {
        format!("{}…", compact.chars().take(MAX).collect::<String>())
    } else {
        compact
    }
}

/// Shared sender for the dedicated ACP "needs your attention" pushes (approval and
/// question) and their matching clear pushes. A clear shows nothing, so it skips
/// subscriptions whose browser revokes push after silent deliveries (#2491).
async fn send_acp_push<T, F>(state: &AppState, session_id: &str, silent: bool, make_payload: F)
where
    T: Serialize,
    F: Fn(String) -> T,
{
    let Some(push) = state.push.as_ref() else {
        return;
    };
    if !state.push_enabled {
        return;
    }
    let path = format!("/sessions/{session_id}/acp");
    let subs = push.store.snapshot().await;
    if subs.is_empty() {
        return;
    }
    let client = match super::push_send::build_client() {
        Ok(c) => c,
        Err(e) => {
            warn!(target: "acp.push", "build_client: {e}");
            return;
        }
    };
    for sub in subs {
        if silent && !super::push::accepts_silent_push(&sub) {
            continue;
        }
        let Some(url) = super::push::build_push_url(&sub, &path) else {
            continue;
        };
        super::push::deliver(push, &client, &sub, &make_payload(url), 60).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::state::Event;

    /// Prompt dispatch (Tier 3) reads the daemon's own control state through
    /// `fold_control_state`, so the whole decision is only as good as this fold.
    #[tokio::test]
    async fn fold_control_state_tracks_the_turn_flags_dispatch_reads() {
        let mut inst = crate::session::Instance::new("t", "/tmp/aoe-fold-control");
        inst.id = "s-fold".to_string();
        inst.agent_name = Some("claude".to_string());
        let state = crate::server::test_support::build_test_app_state(vec![inst]);

        // Publish through the real choke point rather than writing straight to the store.
        use crate::acp::supervisor::BroadcastSink;
        let sink = crate::acp::supervisor::ChannelSink {
            tx: state.acp_events_tx.clone(),
            event_store: Arc::clone(&state.acp_event_store),
            control_cache: Arc::clone(&state.acp_control_cache),
        };
        let record = |seq: u64, event: Event| {
            assert!(
                sink.publish_persisted("s-fold", seq, &event),
                "publish must reach the event store"
            );
        };
        // A live steerable turn.
        record(
            1,
            Event::PromptCapabilities {
                image: false,
                audio: false,
                embedded_context: false,
                load_session: None,
                steering: true,
            },
        );
        record(
            2,
            Event::UserPromptSent {
                text: "go".into(),
                attachments: Vec::new(),
                prompt_id: None,
                synthesized: false,
            },
        );
        let folded = state.session_service.fold_control_state("s-fold").await;
        assert!(folded.turn_active, "the prompt opened a turn");
        assert!(folded.steering, "capabilities survive the fold");
        assert!(!folded.cancelling);
        assert_eq!(
            crate::acp::dispatch::decide(
                &folded,
                crate::acp::dispatch::WorkerLiveness {
                    running: true,
                    idle_dormant: false,
                    rate_limit_parked: false,
                },
            ),
            crate::acp::dispatch::PromptDispatch::Steered
        );

        // A pending cancel flips the same live turn to "park", which is the
        // gate that keeps Stop-then-type from restarting the runner (#1727).
        record(
            3,
            Event::CancelRequested {
                escalates_at: chrono::Utc::now(),
            },
        );
        let folded = state.session_service.fold_control_state("s-fold").await;
        assert!(folded.cancelling);
        assert_eq!(
            crate::acp::dispatch::decide(
                &folded,
                crate::acp::dispatch::WorkerLiveness {
                    running: true,
                    idle_dormant: false,
                    rate_limit_parked: false,
                },
            ),
            crate::acp::dispatch::PromptDispatch::Queued {
                reason: crate::acp::dispatch::QueueReason::Cancelling,
            }
        );

        // Turn end reopens the send path.
        record(
            4,
            Event::Stopped {
                reason: "cancelled".into(),
            },
        );
        let folded = state.session_service.fold_control_state("s-fold").await;
        assert!(!folded.turn_active, "Stopped closed the turn");
        assert!(!folded.cancelling, "and cleared the pending cancel");
        assert_eq!(
            crate::acp::dispatch::decide(
                &folded,
                crate::acp::dispatch::WorkerLiveness {
                    running: true,
                    idle_dormant: false,
                    rate_limit_parked: false,
                },
            ),
            crate::acp::dispatch::PromptDispatch::Sent
        );

        // An unknown session folds to a default (idle) state rather than
        // erroring, so a prompt for a session the daemon has not seen is not
        // parked forever on a phantom turn.
        let unknown = state.session_service.fold_control_state("s-missing").await;
        assert!(!unknown.turn_active);
    }

    /// `AcpState::apply_event` takes no seq and is not idempotent, and the
    /// drain overlaps the live broadcast by design, so a duplicated event
    /// would leave a second, unresolvable approval card in the shelf.
    type TestSocket = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    async fn connect_test_socket(
        state: Arc<AppState>,
    ) -> (TestSocket, tokio::task::JoinHandle<()>) {
        connect_test_socket_with(state, "frames=0").await
    }

    async fn connect_test_socket_with(
        state: Arc<AppState>,
        query: &str,
    ) -> (TestSocket, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = axum::Router::new()
            .route("/{id}", axum::routing::get(acp_ws))
            .with_state(state);
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/s-1?{query}"))
            .await
            .unwrap();
        (socket, server)
    }

    async fn receive_kind(socket: &mut TestSocket, kind: &str) -> serde_json::Value {
        use futures_util::StreamExt;
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let message = socket.next().await.expect("socket remains open").unwrap();
                if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
                    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
                    if value["kind"] == kind {
                        return value;
                    }
                }
            }
        })
        .await
        .expect("expected websocket frame")
    }

    /// Every message a connect sends, up to and including its transcript snapshot.
    async fn connect_messages(state: &Arc<AppState>, query: &str) -> Vec<serde_json::Value> {
        use futures_util::StreamExt;
        let (mut socket, server) = connect_test_socket_with(Arc::clone(state), query).await;
        let mut messages = Vec::new();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let message = socket.next().await.expect("socket remains open").unwrap();
                if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
                    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
                    let done = value["kind"] == "transcript_snapshot";
                    messages.push(value);
                    if done {
                        break;
                    }
                }
            }
        })
        .await
        .expect("connect snapshot");
        drop(socket);
        server.abort();
        let _ = server.await;
        messages
    }

    /// The connect snapshot is whole-session control state plus the rows
    /// changed after `since`, while forwarded frames stay scoped to `since`.
    /// Every client dials with a non-zero `since` after its first connect.
    #[tokio::test]
    async fn connect_sends_whole_state_and_the_rows_changed_since_the_cursor() {
        let _home = crate::session::test_support::isolate_app_dir();
        let state = crate::server::test_support::build_test_app_state(Vec::new());
        let approval = crate::acp::approvals::Approval {
            nonce: crate::acp::approvals::Nonce("n-1".into()),
            tool_call: crate::acp::state::ToolCall {
                id: "t-1".into(),
                name: "Edit".into(),
                kind: "edit".into(),
                args_preview: "{}".into(),
                started_at: chrono::Utc::now(),
                parent_tool_call_id: None,
                memory_recall: None,
                diffs: Vec::new(),
            },
            destructive: false,
            options: Vec::new(),
            choice: false,
            requested_at: chrono::Utc::now(),
            resolved: None,
            subagent: None,
        };
        let history = [
            Event::AvailableCommandsUpdated {
                commands: vec![crate::acp::state::AvailableCommand {
                    name: "review".into(),
                    description: "Review".into(),
                    accepts_input: false,
                }],
            },
            Event::ModesAvailable {
                current_mode_id: "plan".into(),
                modes: vec![crate::acp::state::ModeInfo {
                    id: "plan".into(),
                    name: "Plan".into(),
                    description: None,
                }],
            },
            Event::ApprovalRequested { approval },
            Event::AgentMessageChunk {
                text: "hello".into(),
            },
        ];
        for (i, event) in history.iter().enumerate() {
            state
                .acp_event_store
                .record("s-1", i as u64 + 1, event)
                .unwrap();
        }
        let frames = |messages: &[serde_json::Value]| {
            messages.iter().filter(|m| m.get("event").is_some()).count()
        };
        let snapshot_rows = |messages: &[serde_json::Value]| -> Vec<(String, String)> {
            messages.last().unwrap()["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| {
                    (
                        row["id"].as_str().unwrap().to_owned(),
                        row["text"].as_str().unwrap().to_owned(),
                    )
                })
                .collect()
        };

        // A reconnect that already has everything through seq 4.
        let reconnect = connect_messages(&state, "since=4").await;
        assert_eq!(frames(&reconnect), 0, "nothing new to forward");
        assert!(snapshot_rows(&reconnect).is_empty());
        let reduced = &reconnect
            .iter()
            .find(|m| m["kind"] == "reduced_state")
            .unwrap()["state"];
        assert_eq!(reduced["available_commands"].as_array().unwrap().len(), 1);
        assert_eq!(reduced["available_modes"].as_array().unwrap().len(), 1);
        assert_eq!(
            reduced["pending_approvals"].as_array().unwrap().len(),
            1,
            "a pending approval must still render after a reconnect"
        );
        assert!(
            !reconnect.last().unwrap()["last_event_at"].is_null(),
            "the client learns when the session last did anything"
        );

        // A cold connect gets every frame and every row.
        let cold = connect_messages(&state, "since=0").await;
        assert_eq!(frames(&cold), 4);
        assert_eq!(snapshot_rows(&cold), [("msg-4".into(), "hello".into())]);

        // A reply continued past the cursor arrives whole.
        state
            .acp_event_store
            .record(
                "s-1",
                5,
                &Event::AgentMessageChunk {
                    text: " world".into(),
                },
            )
            .unwrap();
        let continued = connect_messages(&state, "since=4").await;
        assert_eq!(frames(&continued), 1);
        assert_eq!(
            snapshot_rows(&continued),
            [("msg-4".into(), "hello world".into())]
        );
    }

    /// Deleting a session's events, as switching it to the terminal does,
    /// leaves nothing of the old conversation for the next connect.
    #[tokio::test]
    async fn a_connect_after_the_log_is_deleted_starts_clean() {
        let _home = crate::session::test_support::isolate_app_dir();
        let state = crate::server::test_support::build_test_app_state(Vec::new());
        state
            .acp_event_store
            .record("s-1", 1, &Event::ThinkingStarted)
            .unwrap();
        let reduced = |messages: &[serde_json::Value]| {
            messages
                .iter()
                .find(|m| m["kind"] == "reduced_state")
                .unwrap()["state"]
                .clone()
        };
        let before = connect_messages(&state, "since=0").await;
        assert_eq!(reduced(&before)["turn_active"], true);
        state.session_service.delete_session_events("s-1");
        let after = connect_messages(&state, "since=0").await;
        assert_eq!(reduced(&after)["turn_active"], false);
    }

    #[tokio::test]
    async fn control_fold_skips_events_the_drain_already_applied() {
        let _home = crate::session::test_support::isolate_app_dir();
        let approval = |nonce: &str| crate::acp::approvals::Approval {
            nonce: crate::acp::approvals::Nonce(nonce.into()),
            tool_call: crate::acp::state::ToolCall {
                id: "t-1".into(),
                name: "Edit".into(),
                kind: "edit".into(),
                args_preview: "{}".into(),
                started_at: chrono::Utc::now(),
                parent_tool_call_id: None,
                memory_recall: None,
                diffs: Vec::new(),
            },
            destructive: false,
            options: Vec::new(),
            choice: false,
            requested_at: chrono::Utc::now(),
            resolved: None,
            subagent: None,
        };
        let state = crate::server::test_support::build_test_app_state(Vec::new());
        let event = Event::ApprovalRequested {
            approval: approval("n-1"),
        };
        state.acp_event_store.record("s-1", 7, &event).unwrap();
        let (mut socket, server) = connect_test_socket(state.clone()).await;
        let initial = receive_kind(&mut socket, "reduced_state").await;
        assert_eq!(
            initial["state"]["pending_approvals"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        receive_kind(&mut socket, "transcript_snapshot").await;
        publish(
            &state,
            AcpBroadcastFrame {
                session_id: "s-1".into(),
                seq: 7,
                event: Arc::new(event),
                worker_generation: None,
            },
        );
        let repeated = receive_kind(&mut socket, "reduced_state").await;
        assert_eq!(repeated["seq"], 7);
        assert_eq!(
            repeated["state"]["pending_approvals"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        state.shutdown.cancel();
        drop(socket);
        server.abort();
        let _ = server.await;
    }

    /// Live rows come from the session's shared fold: a new row as an
    /// append, and a change to it as a patch carrying the whole row.
    #[tokio::test]
    async fn live_frames_send_the_rows_the_shared_fold_changed() {
        use crate::acp::supervisor::BroadcastSink;
        let _home = crate::session::test_support::isolate_app_dir();
        let state = crate::server::test_support::build_test_app_state(Vec::new());
        let sink = crate::acp::supervisor::ChannelSink {
            tx: state.acp_events_tx.clone(),
            event_store: Arc::clone(&state.acp_event_store),
            control_cache: Arc::clone(&state.acp_control_cache),
        };
        state
            .acp_event_store
            .record("s-1", 1, &Event::ThinkingStarted)
            .unwrap();
        let (mut socket, server) = connect_test_socket(state.clone()).await;
        receive_kind(&mut socket, "transcript_snapshot").await;
        sink.publish("s-1", 2, &Event::AgentMessageChunk { text: "Hel".into() });
        let appended = receive_kind(&mut socket, "transcript_delta").await;
        assert_eq!(appended["delta"]["Append"]["id"], "msg-2");
        sink.publish("s-1", 3, &Event::AgentMessageChunk { text: "lo".into() });
        let patched = receive_kind(&mut socket, "transcript_delta").await;
        assert_eq!(patched["delta"]["Patch"]["row"]["text"], "Hello");
        state.shutdown.cancel();
        drop(socket);
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn lagged_broadcast_reports_gap_and_rebuilds_control_state() {
        let _home = crate::session::test_support::isolate_app_dir();
        let state = crate::server::test_support::build_test_app_state(Vec::new());
        state
            .acp_event_store
            .record("s-1", 1, &Event::ThinkingStarted)
            .unwrap();
        let (mut socket, server) = connect_test_socket(state.clone()).await;
        let initial = receive_kind(&mut socket, "reduced_state").await;
        assert_eq!(initial["state"]["turn_active"], true);
        receive_kind(&mut socket, "transcript_snapshot").await;
        use crate::acp::supervisor::BroadcastSink;
        let sink = crate::acp::supervisor::ChannelSink {
            tx: state.acp_events_tx.clone(),
            event_store: Arc::clone(&state.acp_event_store),
            control_cache: Arc::clone(&state.acp_control_cache),
        };
        // No await in this burst: the current-thread receiver cannot drain its eight slots.
        for seq in 2..=17 {
            let event = match seq {
                2 => Event::Stopped {
                    reason: "done".into(),
                },
                3 => Event::AgentMessageChunk {
                    text: "missed reply".into(),
                },
                _ => Event::ThinkingEnded,
            };
            sink.publish("s-1", seq, &event);
        }
        let gap = receive_kind(&mut socket, "lagged").await;
        assert_eq!(gap["skipped"], 8);
        let rebuilt = receive_kind(&mut socket, "reduced_state").await;
        assert_eq!(rebuilt["seq"], 17);
        assert_eq!(
            rebuilt["state"]["turn_active"], false,
            "missed Stop must be recovered from durable history"
        );
        let recovered = receive_kind(&mut socket, "transcript_delta").await;
        assert_eq!(
            recovered["delta"]["Append"]["text"], "missed reply",
            "a row the lag skipped reaches the transcript"
        );
        state.shutdown.cancel();
        drop(socket);
        server.abort();
        let _ = server.await;
    }

    /// The clear path reuses the tag helpers, so a drift here would silently fail to
    /// close the matching notification (#2491). Both payloads carry `kind` and `seq`,
    /// and a clear keeps title/body so a not-yet-updated service worker degrades to a
    /// benign notification rather than a blank one.
    #[test]
    fn attention_payloads_are_session_scoped_and_kind_distinct() {
        assert_eq!(approval_tag("s1"), "acp-approval-s1");
        assert_eq!(question_tag("s1"), "acp-question-s1");

        let clear = serde_json::to_value(AcpClearPayload {
            kind: "clear",
            title: "Resolved",
            body: "Handled on another device",
            url: "/sessions/s1/acp".into(),
            tag: approval_tag("s1"),
            session_id: "s1".into(),
            seq: 7,
        })
        .unwrap();
        assert_eq!(clear["kind"], "clear");
        assert_eq!(clear["tag"], "acp-approval-s1");
        assert_eq!(clear["seq"], 7);
        assert_eq!(clear["title"], "Resolved");

        let notify = serde_json::to_value(AcpNotifyPayload {
            kind: "notify",
            title: "t".into(),
            body: "b".into(),
            url: "/sessions/s1/acp".into(),
            tag: question_tag("s1"),
            session_id: "s1".into(),
            seq: 3,
        })
        .unwrap();
        assert_eq!(notify["kind"], "notify");
        assert_eq!(notify["tag"], "acp-question-s1");
        assert_eq!(notify["seq"], 3);

        // Short text passes through with whitespace collapsed.
        assert_eq!(
            push_body_snippet("Which   env?\n staging\tor prod"),
            "Which env? staging or prod"
        );
        // Long text is truncated and gets an ellipsis.
        let long = "word ".repeat(100);
        let snippet = push_body_snippet(&long);
        assert!(snippet.ends_with('…'));
        assert_eq!(snippet.chars().count(), 120 + 1);
    }
}
