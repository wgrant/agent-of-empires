//! Native subagent sessions (ACP RFD #1992). With `clientCapabilities.subagents`
//! declared, an adapter announces each child with `subagent_spawned` on its
//! parent's session, then streams the child's work under the child's own
//! session id on the same connection.

use agent_client_protocol::schema::v1::{SessionId, SessionUpdate};

use super::extension_updates::extension_update;
use crate::acp::state::Event;

/// Children admitted per native session; later announcements are ignored.
pub(super) const MAX_SUBAGENTS: usize = 256;

/// The child a tunnelled `subagent_spawned` announces.
pub(super) fn spawned_child(update: &SessionUpdate) -> Option<SessionId> {
    let update = extension_update(update)?;
    (update.get("sessionUpdate")?.as_str()? == "subagent_spawned")
        .then(|| update.get("subagentSessionId")?.as_str())
        .flatten()
        .filter(|id| !id.is_empty())
        .map(|id| SessionId::new(id.to_string()))
}

/// Tag a transcript event with the subagent it came from, if any.
pub(super) fn scoped(subagent: Option<&str>, event: Event) -> Event {
    match subagent {
        Some(id) => Event::SubagentUpdate {
            id: id.to_string(),
            event: Box::new(event),
        },
        None => event,
    }
}

/// A child session's events as the parent records them: its transcript is
/// wrapped so it never merges into the main reply, a nested spawn names its
/// parent, and session-wide state (usage, commands, config, titles) is the
/// main agent's alone.
pub(super) fn child_events(id: &str, events: Vec<Event>) -> Vec<Event> {
    events
        .into_iter()
        .filter_map(|event| match event {
            Event::SubagentSpawned {
                id: child,
                name,
                task,
                at,
                ..
            } => Some(Event::SubagentSpawned {
                id: child,
                parent: Some(id.to_string()),
                name,
                task,
                at,
            }),
            // A child's background tasks are the session's, like the main agent's.
            Event::SubagentStateChanged { .. }
            | Event::AsyncTaskSpawned { .. }
            | Event::AsyncTaskProgress { .. }
            | Event::AsyncTaskStateChanged { .. } => Some(event),
            Event::AgentMessageChunk { .. }
            | Event::AgentMessageSnapshot { .. }
            | Event::AgentThoughtChunk { .. }
            | Event::AgentThoughtSnapshot { .. }
            | Event::ToolCallStarted { .. }
            | Event::ToolCallUpdated { .. }
            | Event::ToolCallContent { .. }
            | Event::ToolCallCompleted { .. }
            | Event::DiffEmitted { .. }
            | Event::PlanUpdated { .. }
            | Event::TodoListUpdated { .. }
            | Event::AgentNotice { .. } => Some(scoped(Some(id), event)),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_events_keep_the_transcript_apart_and_drop_session_state() {
        let spawn = Event::SubagentSpawned {
            id: "grandchild".into(),
            parent: None,
            name: "n".into(),
            task: "t".into(),
            at: chrono::Utc::now(),
        };
        let events = child_events(
            "child",
            vec![
                Event::AgentMessageChunk { text: "hi".into() },
                spawn,
                Event::SubagentStateChanged {
                    id: "grandchild".into(),
                    state: "completed".into(),
                    at: chrono::Utc::now(),
                },
                Event::ThinkingStarted,
                Event::SessionTitleSuggested { title: "t".into() },
            ],
        );
        assert!(matches!(
            &events[0],
            Event::SubagentUpdate { id, event } if id == "child"
                && matches!(event.as_ref(), Event::AgentMessageChunk { text } if text == "hi")
        ));
        assert!(
            matches!(&events[1], Event::SubagentSpawned { parent: Some(p), .. } if p == "child")
        );
        assert!(matches!(&events[2], Event::SubagentStateChanged { .. }));
        assert_eq!(events.len(), 3);
    }
}
