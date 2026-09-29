//! Background work a session still has running, for the sidebar.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};

use super::{logged, query_strings, EventStore};

/// Async tasks spawned and not yet in a terminal state.
const UNFINISHED_TASKS: &str = "FROM acp_events
     WHERE session_id = ?1
       AND discriminant = 'AsyncTaskSpawned'
       AND json_extract(event_json, '$.AsyncTaskSpawned.id') NOT IN (
           SELECT json_extract(event_json, '$.AsyncTaskStateChanged.id')
           FROM acp_events
           WHERE session_id = ?1
             AND discriminant = 'AsyncTaskStateChanged'
             AND json_extract(event_json, '$.AsyncTaskStateChanged.state')
                 NOT IN ('running', 'paused')
       )";

/// A session's unfinished subagents and background tasks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackgroundActivity {
    pub running: usize,
    /// The running items that report progress, unlike a background shell or
    /// monitor, which is silent until it ends.
    pub reporting: usize,
    /// The latest progress any background work reported.
    pub last_active_at: Option<DateTime<Utc>>,
}

impl EventStore {
    pub fn unfinished_workflow_ids(&self, session_id: &str) -> Vec<String> {
        query_strings(
            &self.conn(),
            &format!(
                "SELECT json_extract(event_json, '$.AsyncTaskSpawned.id') {UNFINISHED_TASKS}
                   AND json_extract(event_json, '$.AsyncTaskSpawned.task_type') = 'workflow'"
            ),
            "unfinished_workflow_ids",
            session_id,
        )
    }

    pub fn unfinished_async_task_ids(&self, session_id: &str) -> Vec<String> {
        query_strings(
            &self.conn(),
            &format!("SELECT json_extract(event_json, '$.AsyncTaskSpawned.id') {UNFINISHED_TASKS}"),
            "unfinished_async_task_ids",
            session_id,
        )
    }

    /// `None` when nothing runs in the background.
    pub fn background_activity(&self, session_id: &str) -> Option<BackgroundActivity> {
        // A woken teammate runs as `<id>:generation:<n>`; count the agent once.
        let agents: HashSet<String> = self
            .unresolved_native_subagents(session_id)
            .into_iter()
            .map(|id| match id.split_once(":generation:") {
                Some((agent, _)) => agent.to_string(),
                None => id,
            })
            .collect();
        let tailed = self.unresolved_background_agent_ids(session_id).len();
        let conn = self.conn();
        let task_types = query_strings(
            &conn,
            &format!(
                "SELECT json_extract(event_json, '$.AsyncTaskSpawned.task_type') {UNFINISHED_TASKS}"
            ),
            "background_activity tasks",
            session_id,
        );
        let silent = task_types
            .iter()
            .filter(|t| matches!(t.as_str(), "shell" | "monitor"))
            .count();
        let running = agents.len() + tailed + task_types.len();
        if running == 0 {
            return None;
        }
        // The latest event by seq, which `(session_id, discriminant, seq)`
        // finds per discriminant without reading every matching row.
        let last_ms: Option<i64> = logged(
            conn.query_row(
                "SELECT created_at FROM acp_events
                 WHERE session_id = ?1 AND seq = (
                   SELECT MAX(seq) FROM acp_events
                   WHERE session_id = ?1
                     AND discriminant IN ('SubagentSpawned', 'SubagentUpdate', 'AsyncTaskSpawned',
                                          'AsyncTaskProgress', 'BackgroundAgentLaunched',
                                          'BackgroundAgentProgress'))",
                params![session_id],
                |row| row.get(0),
            )
            .optional(),
            "background_activity last",
            session_id,
        )
        .flatten();
        Some(BackgroundActivity {
            running,
            reporting: running - silent,
            last_active_at: last_ms.and_then(DateTime::from_timestamp_millis),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use crate::acp::state::Event;

    #[test]
    fn counts_unfinished_work_and_when_it_last_reported() {
        let (_tmp, store) = open_store(1000);
        let spawned = |id: &str| Event::SubagentSpawned {
            id: id.into(),
            parent: None,
            name: "n".into(),
            task: "t".into(),
            at: chrono::Utc::now(),
            persistent: false,
        };
        let task = |id: &str, task_type: &str| Event::AsyncTaskSpawned {
            id: id.into(),
            name: id.into(),
            task_type: task_type.into(),
            description: None,
            tool_call_id: None,
            can_stop: true,
            at: chrono::Utc::now(),
        };
        assert!(store.background_activity("s-1").is_none());
        store.record_at("s-1", 1, &spawned("t"), 1_000).unwrap();
        store
            .record_at(
                "s-1",
                2,
                &Event::SubagentStateChanged {
                    id: "t".into(),
                    state: "completed".into(),
                    at: chrono::Utc::now(),
                },
                2_000,
            )
            .unwrap();
        // Woken again: the same agent, running.
        store
            .record_at("s-1", 3, &spawned("t:generation:2"), 3_000)
            .unwrap();
        store
            .record_at("s-1", 4, &task("sh", "shell"), 4_000)
            .unwrap();
        let activity = store.background_activity("s-1").expect("running");
        assert_eq!(
            (
                activity.running,
                activity.reporting,
                activity.last_active_at.map(|t| t.timestamp_millis())
            ),
            (2, 1, Some(4_000))
        );
        assert_eq!(store.unfinished_async_task_ids("s-1"), ["sh"]);
        assert!(store.unfinished_workflow_ids("s-1").is_empty());
        store
            .record_at("s-1", 5, &task("wf", "workflow"), 5_000)
            .unwrap();
        assert_eq!(store.unfinished_workflow_ids("s-1"), ["wf"]);
    }
}
