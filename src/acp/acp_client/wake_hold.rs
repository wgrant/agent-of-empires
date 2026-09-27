//! A wakeup or monitor that a tool call announces takes effect only once that
//! call succeeds. Its arguments stream in over several updates, and a failed
//! `ScheduleWakeup` schedules nothing.

use std::collections::HashMap;

use agent_client_protocol::schema::v1::SessionUpdate;

use crate::acp::state::Event;

/// Tool calls whose announcement is held at once; a call that never ends is
/// dropped rather than growing the map.
const MAX_HELD: usize = 32;

#[derive(Default)]
pub(super) struct WakeHold {
    held: HashMap<String, Event>,
}

/// The tool call an update belongs to, when it is one.
pub(super) fn tool_call_id(update: &SessionUpdate) -> Option<String> {
    match update {
        SessionUpdate::ToolCall(call) => Some(call.tool_call_id.0.to_string()),
        SessionUpdate::ToolCallUpdate(update) => Some(update.tool_call_id.0.to_string()),
        _ => None,
    }
}

impl WakeHold {
    /// Hold the announcement in `events` from tool call `id`, and release a
    /// held one when its call completes successfully.
    pub(super) fn apply(&mut self, id: Option<&str>, events: Vec<Event>) -> Vec<Event> {
        let Some(id) = id else {
            return events;
        };
        let mut out = Vec::with_capacity(events.len());
        for event in events {
            match event {
                Event::WakeupScheduled { .. } | Event::MonitorArmed { .. } => {
                    if self.held.len() >= MAX_HELD && !self.held.contains_key(id) {
                        self.held.clear();
                    }
                    self.held.insert(id.to_string(), event);
                }
                Event::ToolCallCompleted {
                    ref tool_call_id,
                    is_error,
                    ..
                } => {
                    let held = self.held.remove(tool_call_id);
                    out.push(event);
                    if !is_error {
                        out.extend(held);
                    }
                }
                other => out.push(other),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wakeup(delay: i64) -> Event {
        Event::WakeupScheduled {
            at: chrono::DateTime::UNIX_EPOCH + chrono::Duration::seconds(delay),
            reason: None,
        }
    }

    fn completed(id: &str, is_error: bool) -> Event {
        Event::ToolCallCompleted {
            tool_call_id: id.into(),
            is_error,
            content: String::new(),
            output: Vec::new(),
            completed_at: chrono::DateTime::UNIX_EPOCH,
            async_subagent: false,
        }
    }

    #[test]
    fn a_wakeup_takes_effect_only_when_its_call_succeeds() {
        let mut hold = WakeHold::default();
        // Arguments stream in; the latest wins.
        assert!(hold.apply(Some("w1"), vec![wakeup(1)]).is_empty());
        assert!(hold.apply(Some("w1"), vec![wakeup(60)]).is_empty());
        let released = hold.apply(Some("w1"), vec![completed("w1", false)]);
        assert!(matches!(
            released.as_slice(),
            [Event::ToolCallCompleted { .. }, Event::WakeupScheduled { at, .. }]
                if at.timestamp() == 60
        ));

        assert!(hold.apply(Some("w2"), vec![wakeup(5)]).is_empty());
        let failed = hold.apply(Some("w2"), vec![completed("w2", true)]);
        assert!(matches!(
            failed.as_slice(),
            [Event::ToolCallCompleted { .. }]
        ));
    }
}
