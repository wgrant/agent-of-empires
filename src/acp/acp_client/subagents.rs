//! Native subagent sessions (ACP RFD #1992). With `clientCapabilities.subagents`
//! declared, an adapter announces each child with `subagent_spawned` on its
//! parent's session, then streams the child's work under the child's own
//! session id on the same connection.

use agent_client_protocol::schema::v1::{SessionId, SessionUpdate};
use std::collections::HashMap;

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

/// The child an update reports ended. A woken teammate runs under a new
/// session id, so an ended one never speaks again.
pub(super) fn ended_child(update: &SessionUpdate) -> Option<SessionId> {
    let update = extension_update(update)?;
    let ended = update.get("sessionUpdate")?.as_str()? == "subagent_state_update"
        && matches!(
            update.get("state")?.as_str()?,
            "completed" | "failed" | "cancelled" | "disconnected"
        );
    ended
        .then(|| update.get("subagentSessionId")?.as_str())
        .flatten()
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
                persistent,
                ..
            } => Some(Event::SubagentSpawned {
                id: child,
                parent: Some(id.to_string()),
                name,
                task,
                at,
                persistent,
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
            | Event::ToolCallOutputDelta { .. }
            | Event::ToolCallCompleted { .. }
            | Event::DiffEmitted { .. }
            | Event::PlanUpdated { .. }
            | Event::TodoListUpdated { .. }
            | Event::AgentNotice { .. } => Some(scoped(Some(id), event)),
            _ => None,
        })
        .collect()
}

/// Tool calls a workflow's agents make arrive on the main session with no
/// link to the workflow. While no prompt runs and exactly one workflow does,
/// a newly started call can only be one of its agents'; its later updates
/// follow it even once a prompt starts.
#[derive(Default)]
pub(super) struct WorkflowAttribution {
    running: Vec<String>,
    tools: HashMap<String, String>,
}

/// Attributed calls remembered per session, well past any real workflow.
const MAX_ATTRIBUTED_TOOLS: usize = 4096;

impl WorkflowAttribution {
    /// Track the main session's workflow tasks.
    pub(super) fn observe(&mut self, event: &Event) {
        match event {
            Event::AsyncTaskSpawned { id, task_type, .. } if task_type == "workflow" => {
                if !self.running.contains(id) {
                    self.running.push(id.clone());
                }
            }
            Event::AsyncTaskStateChanged { id, state, .. }
                if !matches!(state.as_str(), "running" | "paused") =>
            {
                self.running.retain(|running| running != id);
                self.tools.retain(|_, owner| owner != id);
            }
            _ => {}
        }
    }

    /// The workflow owning this tool call, claiming it when it is newly
    /// `started` while no prompt runs and exactly one workflow does.
    pub(super) fn owner(
        &mut self,
        tool_call_id: &str,
        started: bool,
        prompt_active: bool,
    ) -> Option<String> {
        if let Some(owner) = self.tools.get(tool_call_id) {
            return Some(owner.clone());
        }
        let [workflow] = self.running.as_slice() else {
            return None;
        };
        if !started || prompt_active || self.tools.len() >= MAX_ATTRIBUTED_TOOLS {
            return None;
        }
        self.tools
            .insert(tool_call_id.to_string(), workflow.clone());
        Some(workflow.clone())
    }
}

/// The tool call an update is about, and whether it starts that call.
pub(super) fn tool_call_of(update: &SessionUpdate) -> Option<(&str, bool)> {
    match update {
        SessionUpdate::ToolCall(call) => Some((call.tool_call_id.0.as_ref(), true)),
        SessionUpdate::ToolCallUpdate(update) => Some((update.tool_call_id.0.as_ref(), false)),
        _ => None,
    }
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
            persistent: false,
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
                Event::ToolCallOutputDelta {
                    tool_call_id: "t1".into(),
                    data: "out".into(),
                    replace: false,
                },
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
        assert!(matches!(
            &events[3],
            Event::SubagentUpdate { event, .. } if matches!(event.as_ref(), Event::ToolCallOutputDelta { .. })
        ));
        assert_eq!(events.len(), 4);
    }
}

#[cfg(test)]
mod workflow_attribution_tests {
    use super::*;

    #[test]
    fn only_new_calls_while_idle_under_one_workflow_are_claimed() {
        let spawned = |id: &str| Event::AsyncTaskSpawned {
            id: id.into(),
            name: "n".into(),
            task_type: "workflow".into(),
            description: None,
            tool_call_id: None,
            can_stop: true,
            at: chrono::Utc::now(),
        };
        let ended = |id: &str| Event::AsyncTaskStateChanged {
            id: id.into(),
            state: "completed".into(),
            summary: None,
            tool_call_id: None,
            at: chrono::Utc::now(),
        };
        let mut w = WorkflowAttribution::default();
        assert_eq!(w.owner("t0", true, false), None, "no workflow running");
        w.observe(&spawned("wf1"));
        assert_eq!(
            w.owner("launcher", false, false),
            None,
            "an update to an unclaimed call"
        );
        assert_eq!(w.owner("t1", true, true), None, "a prompt is running");
        assert_eq!(w.owner("t1", true, false).as_deref(), Some("wf1"));
        assert_eq!(
            w.owner("t1", false, true).as_deref(),
            Some("wf1"),
            "follows its claim"
        );
        w.observe(&spawned("wf2"));
        assert_eq!(
            w.owner("t2", true, false),
            None,
            "ambiguous between two workflows"
        );
        w.observe(&ended("wf1"));
        assert_eq!(
            w.owner("t1", false, false),
            None,
            "forgotten with its workflow"
        );
        assert_eq!(w.owner("t3", true, false).as_deref(), Some("wf2"));
    }
}
