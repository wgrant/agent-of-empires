//! Session-update kinds the ACP crate cannot represent yet: `notice`,
//! `compaction_update`, `compaction_summary_chunk`, the native subagent
//! lifecycle, and AIR async tasks. The handshake advertises the capabilities that unlock them;
//! see `initialize_params`. They are tunnelled
//! through a `session_info_update`'s `_meta`, keeping the typed pipeline's
//! session-identity and ordering guarantees.

use agent_client_protocol::schema::v1::SessionUpdate;
use serde_json::{json, Value};

use super::lifecycle::LifecycleSignal;
use super::update_events::compaction_completed_events;
use crate::acp::state::{AsyncTaskUsage, Event};

const TUNNEL_META_KEY: &str = "aoe/extensionUpdate";
const EXTENSION_KINDS: &[&str] = &[
    "notice",
    "compaction_update",
    "compaction_summary_chunk",
    "subagent_spawned",
    "subagent_state_update",
    "async_task_spawned",
    "async_task_progress",
    "async_task_state_update",
];

/// Rewrite an extension update inside `session/update` params into its tunnelled form.
pub(super) fn tunnel_extension_update(params: &mut Value) {
    let update = match params {
        Value::Object(fields) => fields.get_mut("update"),
        // Positional params follow the struct's field order: session id, then update.
        Value::Array(fields) => fields.get_mut(1),
        _ => None,
    };
    let Some(update) = update else {
        return;
    };
    let is_extension = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .is_some_and(|kind| EXTENSION_KINDS.contains(&kind));
    if is_extension {
        let original = update.take();
        *update = json!({
            "sessionUpdate": "session_info_update",
            "_meta": { TUNNEL_META_KEY: original },
        });
    }
}

/// The original extension update, when `update` is a tunnel.
pub(super) fn extension_update(update: &SessionUpdate) -> Option<&Value> {
    let SessionUpdate::SessionInfoUpdate(info) = update else {
        return None;
    };
    info.meta.as_ref()?.get(TUNNEL_META_KEY)
}

fn field<'a>(update: &'a Value, name: &str) -> Option<&'a str> {
    update
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn owned(update: &Value, name: &str) -> Option<String> {
    field(update, name).map(str::to_string)
}

fn async_task_usage(update: &Value) -> Option<AsyncTaskUsage> {
    let usage = update.get("usage")?;
    let n = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    Some(AsyncTaskUsage {
        total_tokens: n("totalTokens"),
        tool_uses: n("toolUses"),
        duration_ms: n("durationMs"),
    })
}

fn async_task_events(kind: &str, update: &Value) -> Option<Event> {
    let id = owned(update, "asyncTaskId")?;
    let at = chrono::Utc::now();
    let tool_call_id = owned(update, "toolCallId");
    Some(match kind {
        "async_task_spawned" => Event::AsyncTaskSpawned {
            name: owned(update, "name").unwrap_or_else(|| "Background task".into()),
            task_type: owned(update, "taskType").unwrap_or_else(|| "task".into()),
            description: owned(update, "description"),
            can_stop: update
                .get("canStop")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            id,
            tool_call_id,
            at,
        },
        "async_task_progress" => Event::AsyncTaskProgress {
            description: owned(update, "description"),
            usage: async_task_usage(update),
            id,
            tool_call_id,
            at,
        },
        _ => Event::AsyncTaskStateChanged {
            state: owned(update, "state")?,
            summary: owned(update, "summary"),
            id,
            tool_call_id,
            at,
        },
    })
}

fn notice(severity: &str, title: &str, description: Option<&str>) -> Event {
    Event::AgentNotice {
        severity: severity.to_string(),
        title: title.to_string(),
        description: description.map(str::to_string),
    }
}

/// The retained summary a completed compaction carries, when it is text.
fn compaction_summary(update: &Value) -> Option<String> {
    let text: Vec<&str> = update
        .get("summary")?
        .as_array()?
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect();
    let text = text.join("\n").trim().to_string();
    (!text.is_empty()).then_some(text)
}

pub(super) fn extension_events(update: &Value) -> Vec<Event> {
    match field(update, "sessionUpdate") {
        Some("notice") => vec![notice(
            field(update, "severity").unwrap_or("info"),
            field(update, "title").unwrap_or("Notice"),
            field(update, "description"),
        )],
        Some("compaction_update") => match field(update, "status") {
            Some("in_progress") => vec![Event::ConversationCompactionStarted],
            Some("completed") => {
                let mut events = compaction_completed_events();
                if let Some(text) = compaction_summary(update) {
                    events.push(Event::ConversationCompactionSummary { text });
                }
                events
            }
            Some("failed") => vec![notice(
                "warning",
                "Compaction failed",
                field(update, "error"),
            )],
            Some("cancelled") => vec![notice("info", "Compaction cancelled", None)],
            _ => Vec::new(),
        },
        Some("subagent_spawned") => field(update, "subagentSessionId")
            .map(|id| Event::SubagentSpawned {
                id: id.to_string(),
                parent: None,
                name: field(update, "name").unwrap_or("Subagent").to_string(),
                task: field(update, "task").unwrap_or_default().to_string(),
                at: chrono::Utc::now(),
            })
            .into_iter()
            .collect(),
        Some("subagent_state_update") => {
            match (field(update, "subagentSessionId"), field(update, "state")) {
                (Some(id), Some(state)) => vec![Event::SubagentStateChanged {
                    id: id.to_string(),
                    state: state.to_string(),
                    at: chrono::Utc::now(),
                }],
                _ => Vec::new(),
            }
        }
        Some(kind @ ("async_task_spawned" | "async_task_progress" | "async_task_state_update")) => {
            async_task_events(kind, update).into_iter().collect()
        }
        // The summary also arrives whole on the completed update.
        _ => Vec::new(),
    }
}

/// Compaction keeps the adapter silent for minutes, so the watchdog must see it.
pub(super) fn extension_lifecycle_signal(update: &Value) -> Option<LifecycleSignal> {
    match field(update, "sessionUpdate")? {
        "compaction_update" => match field(update, "status")? {
            "in_progress" => Some(LifecycleSignal::CompactionStarted),
            "completed" => Some(LifecycleSignal::CompactionCompleted),
            "failed" | "cancelled" => Some(LifecycleSignal::CompactionFailed),
            _ => None,
        },
        "compaction_summary_chunk" => Some(LifecycleSignal::Progress),
        "subagent_spawned" => Some(LifecycleSignal::SubagentStarted {
            id: field(update, "subagentSessionId")?.to_string(),
        }),
        "subagent_state_update" => Some(LifecycleSignal::SubagentEnded {
            id: field(update, "subagentSessionId")?.to_string(),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::SessionNotification;

    /// Tunnel a raw update and decode it the way ingress does.
    fn decode(update: Value) -> SessionUpdate {
        let mut params = json!({ "sessionId": "s1", "update": update });
        tunnel_extension_update(&mut params);
        serde_json::from_value::<SessionNotification>(params)
            .expect("tunnelled update decodes")
            .update
    }

    #[test]
    fn extension_kinds_survive_the_typed_decode_and_map_to_events() {
        let summary = json!([{ "type": "text", "text": "Kept: the plan." }]);
        let cases: Vec<(Value, Vec<&str>, Option<&str>)> = vec![
            (
                json!({"sessionUpdate": "notice", "severity": "warning", "title": "Config", "description": "Deprecated key"}),
                vec!["AgentNotice:warning:Config:Deprecated key"],
                None,
            ),
            (
                json!({"sessionUpdate": "compaction_update", "compactionId": "c1", "status": "in_progress"}),
                vec!["ConversationCompactionStarted"],
                Some("CompactionStarted"),
            ),
            (
                json!({"sessionUpdate": "compaction_update", "compactionId": "c1", "status": "completed", "summary": summary}),
                vec![
                    "ConversationCompacted",
                    "PlanUpdated",
                    "ConversationCompactionSummary:Kept: the plan.",
                ],
                Some("CompactionCompleted"),
            ),
            (
                json!({"sessionUpdate": "compaction_update", "compactionId": "c1", "status": "failed", "error": "too long"}),
                vec!["AgentNotice:warning:Compaction failed:too long"],
                Some("CompactionFailed"),
            ),
            (
                json!({"sessionUpdate": "compaction_update", "compactionId": "c1", "status": "cancelled"}),
                vec!["AgentNotice:info:Compaction cancelled:"],
                Some("CompactionFailed"),
            ),
            (
                json!({"sessionUpdate": "compaction_summary_chunk", "compactionId": "c1", "content": {"type": "text", "text": "Kept"}}),
                vec![],
                Some("Progress"),
            ),
            (
                json!({"sessionUpdate": "subagent_spawned", "subagentSessionId": "c9", "name": "Explore", "task": "Find it", "capabilities": {}}),
                vec!["SubagentSpawned:c9:Explore:Find it"],
                Some("SubagentStarted { id: \"c9\" }"),
            ),
            (
                json!({"sessionUpdate": "async_task_spawned", "asyncTaskId": "w1", "name": "calc-bug-check", "taskType": "workflow", "description": "Check calc.py", "showInTranscript": false, "canStop": true}),
                vec!["AsyncTaskSpawned:w1:calc-bug-check:workflow:true"],
                None,
            ),
            (
                json!({"sessionUpdate": "async_task_progress", "asyncTaskId": "w1", "description": "Review: review:average", "usage": {"totalTokens": 12957, "toolUses": 1, "durationMs": 1779}}),
                vec!["AsyncTaskProgress:w1:Review: review:average:12957/1"],
                None,
            ),
            (
                json!({"sessionUpdate": "async_task_state_update", "asyncTaskId": "w1", "state": "completed", "toolCallId": "toolu_1"}),
                vec!["AsyncTaskStateChanged:w1:completed:toolu_1"],
                None,
            ),
            (
                json!({"sessionUpdate": "subagent_state_update", "subagentSessionId": "c9", "state": "failed"}),
                vec!["SubagentStateChanged:c9:failed"],
                Some("SubagentEnded { id: \"c9\" }"),
            ),
        ];
        for (raw, want_events, want_signal) in cases {
            let update = decode(raw.clone());
            let ext = extension_update(&update).expect("tunnelled");
            let events: Vec<String> = extension_events(ext)
                .iter()
                .map(|e| match e {
                    Event::AgentNotice {
                        severity,
                        title,
                        description,
                    } => {
                        format!(
                            "AgentNotice:{severity}:{title}:{}",
                            description.as_deref().unwrap_or("")
                        )
                    }
                    Event::ConversationCompactionSummary { text } => {
                        format!("ConversationCompactionSummary:{text}")
                    }
                    Event::ConversationCompactionStarted => "ConversationCompactionStarted".into(),
                    Event::ConversationCompacted => "ConversationCompacted".into(),
                    Event::PlanUpdated { .. } => "PlanUpdated".into(),
                    Event::SubagentSpawned {
                        id,
                        parent: None,
                        name,
                        task,
                        ..
                    } => format!("SubagentSpawned:{id}:{name}:{task}"),
                    Event::AsyncTaskSpawned {
                        id,
                        name,
                        task_type,
                        can_stop,
                        ..
                    } => format!("AsyncTaskSpawned:{id}:{name}:{task_type}:{can_stop}"),
                    Event::AsyncTaskProgress {
                        id,
                        description,
                        usage,
                        ..
                    } => {
                        let usage = usage.as_ref().unwrap();
                        format!(
                            "AsyncTaskProgress:{id}:{}:{}/{}",
                            description.as_deref().unwrap_or(""),
                            usage.total_tokens,
                            usage.tool_uses
                        )
                    }
                    Event::AsyncTaskStateChanged {
                        id,
                        state,
                        tool_call_id,
                        ..
                    } => format!(
                        "AsyncTaskStateChanged:{id}:{state}:{}",
                        tool_call_id.as_deref().unwrap_or("")
                    ),
                    Event::SubagentStateChanged { id, state, .. } => {
                        format!("SubagentStateChanged:{id}:{state}")
                    }
                    other => format!("{other:?}"),
                })
                .collect();
            assert_eq!(events, want_events, "{raw}");
            let signal = extension_lifecycle_signal(ext).map(|s| format!("{s:?}"));
            assert_eq!(signal.as_deref(), want_signal, "{raw}");
        }
    }

    #[test]
    fn standard_updates_and_positional_params_pass_through() {
        let mut params = json!({"sessionId": "s1", "update": {"sessionUpdate": "session_info_update", "title": "t"}});
        let before = params.clone();
        tunnel_extension_update(&mut params);
        assert_eq!(params, before, "a standard update is left alone");

        let mut positional =
            json!(["s1", {"sessionUpdate": "notice", "severity": "info", "title": "Hi"}]);
        tunnel_extension_update(&mut positional);
        assert_eq!(positional[1]["sessionUpdate"], "session_info_update");
        assert_eq!(positional[1]["_meta"][TUNNEL_META_KEY]["title"], "Hi");
    }
}
