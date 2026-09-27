use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::EventStore;
use crate::acp::state::Event;
use crate::events;

const EVENT_COMPACTION_VERSION: i64 = 2;

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChunkKind {
    Message,
    Thought,
}

struct ChunkRun {
    session_id: String,
    kind: ChunkKind,
    start_seq: u64,
    end_seq: u64,
    text: String,
    chunks: usize,
}

#[derive(Debug, PartialEq, Eq)]
struct CompactionReport {
    tool_content_rows: usize,
    stream_chunk_rows: usize,
}

impl ChunkRun {
    fn snapshot(&self) -> Event {
        match self.kind {
            ChunkKind::Message => Event::AgentMessageSnapshot {
                block_start_seq: self.start_seq,
                text: self.text.clone(),
            },
            ChunkKind::Thought => Event::AgentThoughtSnapshot {
                block_start_seq: self.start_seq,
                text: self.text.clone(),
            },
        }
    }

    fn source_discriminant(&self) -> &'static str {
        match self.kind {
            ChunkKind::Message => "AgentMessageChunk",
            ChunkKind::Thought => "AgentThoughtChunk",
        }
    }

    fn snapshot_discriminant(&self) -> &'static str {
        match self.kind {
            ChunkKind::Message => "AgentMessageSnapshot",
            ChunkKind::Thought => "AgentThoughtSnapshot",
        }
    }
}

fn stream_chunk(event: &Event) -> Option<(ChunkKind, &str)> {
    match event {
        Event::AgentMessageChunk { text } => Some((ChunkKind::Message, text)),
        Event::AgentThoughtChunk { text } => Some((ChunkKind::Thought, text)),
        _ => None,
    }
}

fn apply_chunk_runs(
    conn: &Connection,
    schema: &events::Schema,
    runs: Vec<ChunkRun>,
) -> Result<usize> {
    if runs.is_empty() {
        return Ok(0);
    }
    let table = schema.events_table();
    let transaction = conn
        .unchecked_transaction()
        .context("begin stream compaction transaction")?;
    let mut removed = 0;
    for run in runs {
        let json = serde_json::to_string(&run.snapshot()).context("serialize stream snapshot")?;
        transaction.execute(
            &format!(
                "UPDATE {table} SET event_json = ?1, discriminant = ?2
                 WHERE session_id = ?3 AND seq = ?4"
            ),
            params![
                json,
                run.snapshot_discriminant(),
                run.session_id,
                run.end_seq as i64
            ],
        )?;
        removed += transaction.execute(
            &format!(
                "DELETE FROM {table}
                 WHERE session_id = ?1 AND seq >= ?2 AND seq < ?3 AND discriminant = ?4"
            ),
            params![
                run.session_id,
                run.start_seq as i64,
                run.end_seq as i64,
                run.source_discriminant()
            ],
        )?;
    }
    transaction
        .commit()
        .context("commit stream compaction transaction")?;
    Ok(removed)
}

pub(super) fn compact_completed_stream_runs(
    conn: &Connection,
    store: &EventStore,
    session_id: &str,
    stopped_seq: u64,
) -> Result<usize> {
    let table = store.schema.events_table();
    let boundary: Option<i64> = conn
        .query_row(
            &format!(
                "SELECT MAX(seq) FROM {table}
                 WHERE session_id = ?1 AND seq < ?2
                   AND discriminant IN ('UserPromptSent', 'UserDiffCommentsPrompt', 'Stopped')"
            ),
            params![session_id, stopped_seq as i64],
            |row| row.get(0),
        )
        .optional()
        .context("find stream compaction boundary")?
        .flatten();
    let start_seq = boundary.map_or(0, |seq| seq.saturating_add(1));
    let mut stmt = conn.prepare(&format!(
        "SELECT seq, event_json FROM {table}
         WHERE session_id = ?1 AND seq >= ?2 AND seq < ?3 ORDER BY seq ASC"
    ))?;
    let rows = stmt.query_map(params![session_id, start_seq, stopped_seq as i64], |row| {
        Ok((row.get::<_, i64>(0)? as u64, row.get::<_, String>(1)?))
    })?;
    let mut runs = Vec::new();
    let mut current: Option<ChunkRun> = None;
    let mut outputs = OutputRuns::default();
    for row in rows {
        let (seq, json) = row?;
        let event = match serde_json::from_str::<Event>(&json) {
            Ok(event) => {
                outputs.observe(seq, &event);
                event
            }
            Err(_) => {
                if let Some(run) = current.take().filter(|run| run.chunks > 1) {
                    runs.push(run);
                }
                continue;
            }
        };
        // A subagent's events interleave with the main agent's text without ending it.
        if matches!(event, Event::SubagentUpdate { .. }) {
            continue;
        }
        let Some((kind, text)) = stream_chunk(&event) else {
            if let Some(run) = current.take().filter(|run| run.chunks > 1) {
                runs.push(run);
            }
            continue;
        };
        if let Some(run) = current.as_mut().filter(|run| run.kind == kind) {
            run.end_seq = seq;
            run.text.push_str(text);
            run.chunks += 1;
        } else {
            if let Some(run) = current.take().filter(|run| run.chunks > 1) {
                runs.push(run);
            }
            current = Some(ChunkRun {
                session_id: session_id.to_owned(),
                kind,
                start_seq: seq,
                end_seq: seq,
                text: text.to_owned(),
                chunks: 1,
            });
        }
    }
    if let Some(run) = current.filter(|run| run.chunks > 1) {
        runs.push(run);
    }
    drop(stmt);

    Ok(apply_chunk_runs(conn, &store.schema, runs)?
        + outputs.apply(conn, &store.schema, session_id)?)
}

/// Each tool call's streamed output chunks in a finished turn, keyed by the
/// subagent that ran it (if any) and its tool call id.
#[derive(Default)]
struct OutputRuns {
    runs: std::collections::HashMap<(Option<String>, String), (Vec<u64>, String)>,
}

impl OutputRuns {
    fn observe(&mut self, seq: u64, event: &Event) {
        let (subagent, inner) = match event {
            Event::SubagentUpdate { id, event } => (Some(id.clone()), event.as_ref()),
            other => (None, other),
        };
        if let Event::ToolCallOutputDelta {
            tool_call_id,
            data,
            replace,
        } = inner
        {
            let (seqs, text) = self
                .runs
                .entry((subagent, tool_call_id.clone()))
                .or_default();
            seqs.push(seq);
            if *replace {
                text.clear();
            }
            text.push_str(data);
        }
    }

    /// Keep one delta per tool, at its last chunk's seq, holding the whole output.
    fn apply(self, conn: &Connection, schema: &events::Schema, session_id: &str) -> Result<usize> {
        let table = schema.events_table();
        let transaction = conn
            .unchecked_transaction()
            .context("begin output compaction transaction")?;
        let mut removed = 0;
        for ((subagent, tool_call_id), (seqs, text)) in self.runs {
            let Some((&last, earlier)) = seqs.split_last() else {
                continue;
            };
            if earlier.is_empty() {
                continue;
            }
            let delta = Event::ToolCallOutputDelta {
                tool_call_id,
                data: crate::acp::transcript::cap_tool_output(&text),
                replace: false,
            };
            let event = match subagent {
                Some(id) => Event::SubagentUpdate {
                    id,
                    event: Box::new(delta),
                },
                None => delta,
            };
            let json = serde_json::to_string(&event).context("serialize output snapshot")?;
            transaction.execute(
                &format!("UPDATE {table} SET event_json = ?1 WHERE session_id = ?2 AND seq = ?3"),
                params![json, session_id, last as i64],
            )?;
            for seq in earlier {
                removed += transaction.execute(
                    &format!("DELETE FROM {table} WHERE session_id = ?1 AND seq = ?2"),
                    params![session_id, *seq as i64],
                )?;
            }
        }
        transaction
            .commit()
            .context("commit output compaction transaction")?;
        Ok(removed)
    }
}

fn compact_legacy_history(conn: &Connection, schema: &events::Schema) -> Result<CompactionReport> {
    let table = schema.events_table();
    let tool_content_rows = conn
        .execute(
            &format!(
                "DELETE FROM {table}
                 WHERE rowid IN (
                   SELECT rowid FROM (
                     SELECT rowid,
                            row_number() OVER (
                              PARTITION BY session_id,
                                json_extract(event_json, '$.ToolCallContent.tool_call_id')
                              ORDER BY seq DESC
                            ) AS replacement_rank
                     FROM {table}
                     WHERE discriminant = 'ToolCallContent'
                   )
                   WHERE replacement_rank > 1
                 )"
            ),
            [],
        )
        .context("compact historical tool content snapshots")?;

    let session_ids = {
        let mut stmt = conn
            .prepare(&format!("SELECT DISTINCT session_id FROM {table}"))
            .context("prepare historical session scan")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .context("scan historical sessions")?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("read historical sessions")?
    };
    let mut stream_chunk_rows = 0;
    for session_id in session_ids {
        let sealed = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT seq, discriminant,
                            CASE WHEN discriminant IN ('AgentMessageChunk', 'AgentThoughtChunk')
                                 THEN event_json ELSE NULL END
                     FROM {table}
                     WHERE session_id = ?1
                     ORDER BY seq"
                ))
                .context("prepare historical stream scan")?;
            let rows = stmt
                .query_map(params![session_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)? as u64,
                        row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .context("scan historical streams")?;
            let mut current: Option<ChunkRun> = None;
            let mut pending = Vec::new();
            let mut sealed = Vec::new();
            for row in rows {
                let (seq, discriminant, json) = row.context("read historical stream row")?;
                let parsed_chunk = json
                    .as_deref()
                    .and_then(|json| serde_json::from_str::<Event>(json).ok())
                    .and_then(|event| {
                        stream_chunk(&event).map(|(kind, text)| (kind, text.to_owned()))
                    });
                if let Some((kind, text)) = parsed_chunk {
                    match current.as_mut() {
                        Some(run) if run.kind == kind => {
                            run.end_seq = seq;
                            run.text.push_str(&text);
                            run.chunks += 1;
                        }
                        _ => {
                            if let Some(run) = current.take().filter(|run| run.chunks > 1) {
                                pending.push(run);
                            }
                            current = Some(ChunkRun {
                                session_id: session_id.clone(),
                                kind,
                                start_seq: seq,
                                end_seq: seq,
                                text,
                                chunks: 1,
                            });
                        }
                    }
                    continue;
                }
                if let Some(run) = current.take().filter(|run| run.chunks > 1) {
                    pending.push(run);
                }
                if discriminant == "Stopped" {
                    sealed.append(&mut pending);
                } else if matches!(
                    discriminant.as_str(),
                    "UserPromptSent" | "UserDiffCommentsPrompt" | "SessionCleared"
                ) {
                    pending.clear();
                }
            }
            sealed
        };
        stream_chunk_rows += apply_chunk_runs(conn, schema, sealed)?;
    }
    Ok(CompactionReport {
        tool_content_rows,
        stream_chunk_rows,
    })
}

pub(super) fn run_legacy_compaction(conn: &Connection, schema: &events::Schema) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS acp_event_store_meta (
             key   TEXT PRIMARY KEY,
             value INTEGER NOT NULL
         );",
    )
    .context("create event store metadata")?;
    let version: i64 = conn
        .query_row(
            "SELECT value FROM acp_event_store_meta WHERE key = 'compaction_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .context("read event compaction version")?
        .unwrap_or(0);
    if version >= EVENT_COMPACTION_VERSION {
        return Ok(());
    }
    let report = if version < 1 {
        compact_legacy_history(conn, schema)?
    } else {
        CompactionReport {
            tool_content_rows: 0,
            stream_chunk_rows: 0,
        }
    };
    let terminal_output_rows = convert_raw_terminal_output(conn, schema)?;
    conn.execute(
        "INSERT INTO acp_event_store_meta (key, value) VALUES ('compaction_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![EVENT_COMPACTION_VERSION],
    )
    .context("store event compaction version")?;
    tracing::debug!(
        target: "acp.event_store",
        tool_content_rows = report.tool_content_rows,
        stream_chunk_rows = report.stream_chunk_rows,
        terminal_output_rows,
        "compacted historical structured view events"
    );
    Ok(())
}

/// Command output stored before AoE understood `terminal_output_delta` sits in
/// raw updates, one per chunk. Fold each command's chunks into one
/// `ToolCallOutputDelta` at its last chunk, so its card shows the output.
fn convert_raw_terminal_output(conn: &Connection, schema: &events::Schema) -> Result<usize> {
    const DELTA: &str = "'$.RawAgentUpdate.payload._meta.terminal_output_delta'";
    let table = schema.events_table();
    let sessions = {
        let mut stmt = conn.prepare(&format!(
            "SELECT DISTINCT session_id FROM {table}
             WHERE discriminant = 'RawAgentUpdate' AND json_extract(event_json, {DELTA}) IS NOT NULL"
        ))?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut removed = 0;
    for session_id in sessions {
        // Tool call id -> (last seq, output), in chunk order.
        let mut outputs: std::collections::HashMap<String, (u64, String)> = Default::default();
        {
            let mut stmt = conn.prepare(&format!(
                "SELECT seq,
                        json_extract(event_json, '$.RawAgentUpdate.payload.toolCallId'),
                        json_extract(event_json, {DELTA} || '.data')
                 FROM {table}
                 WHERE session_id = ?1 AND discriminant = 'RawAgentUpdate'
                   AND json_extract(event_json, {DELTA}) IS NOT NULL
                 ORDER BY seq"
            ))?;
            let rows = stmt.query_map(params![session_id], |row| {
                Ok((
                    row.get::<_, i64>(0)? as u64,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?;
            for row in rows {
                let (seq, Some(tool_call_id), Some(data)) = row? else {
                    continue;
                };
                let (last, text) = outputs.entry(tool_call_id).or_default();
                *last = seq;
                text.push_str(&data);
                if text.len() > 2 * crate::acp::transcript::TOOL_OUTPUT_CAP {
                    *text = crate::acp::transcript::cap_tool_output(text);
                }
            }
        }
        let transaction = conn
            .unchecked_transaction()
            .context("begin terminal output conversion")?;
        for (tool_call_id, (last, text)) in outputs {
            let event = Event::ToolCallOutputDelta {
                tool_call_id,
                data: crate::acp::transcript::cap_tool_output(&text),
                replace: false,
            };
            transaction.execute(
                &format!(
                    "UPDATE {table} SET event_json = ?1, discriminant = 'ToolCallOutputDelta'
                     WHERE session_id = ?2 AND seq = ?3"
                ),
                params![serde_json::to_string(&event)?, session_id, last as i64],
            )?;
        }
        removed += transaction.execute(
            &format!(
                "DELETE FROM {table}
                 WHERE session_id = ?1 AND discriminant = 'RawAgentUpdate'
                   AND json_extract(event_json, {DELTA}) IS NOT NULL"
            ),
            params![session_id],
        )?;
        transaction
            .commit()
            .context("commit terminal output conversion")?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::event_store::test_support::{agent_chunk, open_store, user_prompt};

    #[test]
    fn stopped_turn_seals_consecutive_message_and_thought_runs() {
        let (_tmp, store) = open_store(1000);
        let events = [
            agent_chunk("Hel"),
            Event::SubagentUpdate {
                id: "a1".into(),
                event: Box::new(agent_chunk("sub")),
            },
            agent_chunk("lo"),
            Event::AgentThoughtChunk {
                text: "plan".into(),
            },
            Event::AgentThoughtChunk {
                text: "ning".into(),
            },
            agent_chunk("Done"),
            Event::Stopped {
                reason: "prompt_complete".into(),
            },
        ];
        for (index, event) in events.iter().enumerate() {
            store.record("s-1", index as u64 + 1, event).unwrap();
        }

        let replay = store.replay_from("s-1", 0);
        assert_eq!(
            replay.iter().map(|(seq, _)| *seq).collect::<Vec<_>>(),
            vec![2, 3, 5, 6, 7]
        );
        assert!(matches!(
            &replay[1].1,
            Event::AgentMessageSnapshot { block_start_seq: 1, text } if text == "Hello"
        ));
        assert!(matches!(
            &replay[2].1,
            Event::AgentThoughtSnapshot { block_start_seq: 4, text } if text == "planning"
        ));
        assert!(matches!(&replay[3].1, Event::AgentMessageChunk { text } if text == "Done"));
    }

    #[test]
    fn stopped_turn_keeps_one_output_delta_per_tool() {
        let (_tmp, store) = open_store(1000);
        let delta = |id: &str, data: &str| Event::ToolCallOutputDelta {
            tool_call_id: id.into(),
            data: data.into(),
            replace: false,
        };
        let in_subagent = |event: Event| Event::SubagentUpdate {
            id: "a1".into(),
            event: Box::new(event),
        };
        let events = [
            delta("t1", "one\n"),
            in_subagent(delta("t2", "sub\n")),
            delta("t1", "two\n"),
            in_subagent(delta("t2", "done\n")),
            delta("t3", "alone\n"),
            Event::Stopped {
                reason: "prompt_complete".into(),
            },
        ];
        for (index, event) in events.iter().enumerate() {
            store.record("s-1", index as u64 + 1, event).unwrap();
        }

        let replay = store.replay_from("s-1", 0);
        assert_eq!(
            replay.iter().map(|(seq, _)| *seq).collect::<Vec<_>>(),
            vec![3, 4, 5, 6]
        );
        assert!(matches!(
            &replay[0].1,
            Event::ToolCallOutputDelta { tool_call_id, data, .. } if tool_call_id == "t1" && data == "one\ntwo\n"
        ));
        assert!(matches!(
            &replay[1].1,
            Event::SubagentUpdate { event, .. }
                if matches!(event.as_ref(), Event::ToolCallOutputDelta { data, .. } if data == "sub\ndone\n")
        ));
    }

    #[test]
    fn legacy_compaction_rewrites_only_completed_streams_and_latest_tool_content() {
        let (_tmp, store) = open_store(1000);
        let legacy = [
            Event::ToolCallContent {
                tool_call_id: "tool-a".into(),
                content: "first".into(),
            },
            Event::ToolCallContent {
                tool_call_id: "tool-a".into(),
                content: "final".into(),
            },
            user_prompt("completed"),
            agent_chunk("Hel"),
            agent_chunk("lo"),
            Event::AgentThoughtChunk {
                text: "plan".into(),
            },
            Event::AgentThoughtChunk {
                text: "ning".into(),
            },
            Event::Stopped {
                reason: "prompt_complete".into(),
            },
            user_prompt("still running"),
            agent_chunk("keep "),
            agent_chunk("streaming"),
        ];
        {
            let conn = store.conn.lock().unwrap();
            for (index, event) in legacy.iter().enumerate() {
                let seq = index as u64 + 1;
                let json = serde_json::to_string(event).unwrap();
                events::insert_event(&conn, &store.schema, "s-1", seq, &json, seq as i64).unwrap();
            }

            conn.execute(
                "UPDATE acp_event_store_meta SET value = 0 WHERE key = 'compaction_version'",
                [],
            )
            .unwrap();
            run_legacy_compaction(&conn, &store.schema).unwrap();
            let version: i64 = conn
                .query_row(
                    "SELECT value FROM acp_event_store_meta WHERE key = 'compaction_version'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(version, EVENT_COMPACTION_VERSION);
            assert_eq!(
                compact_legacy_history(&conn, &store.schema).unwrap(),
                CompactionReport {
                    tool_content_rows: 0,
                    stream_chunk_rows: 0,
                }
            );
        }

        let replay = store.replay_from("s-1", 0);
        assert_eq!(
            replay.iter().map(|(seq, _)| *seq).collect::<Vec<_>>(),
            vec![2, 3, 5, 7, 8, 9, 10, 11]
        );
        assert!(matches!(
            &replay[0].1,
            Event::ToolCallContent { content, .. } if content == "final"
        ));
        assert!(matches!(
            &replay[2].1,
            Event::AgentMessageSnapshot { block_start_seq: 4, text } if text == "Hello"
        ));
        assert!(matches!(
            &replay[3].1,
            Event::AgentThoughtSnapshot { block_start_seq: 6, text } if text == "planning"
        ));
        assert!(matches!(
            &replay[6].1,
            Event::AgentMessageChunk { text } if text == "keep "
        ));
        assert!(matches!(
            &replay[7].1,
            Event::AgentMessageChunk { text } if text == "streaming"
        ));
    }

    #[test]
    fn raw_terminal_output_folds_into_one_delta_per_command() {
        let (_tmp, store) = open_store(1000);
        let raw = |id: &str, data: &str| Event::RawAgentUpdate {
            payload: serde_json::json!({
                "toolCallId": id,
                "_meta": { "terminal_output_delta": { "terminal_id": id, "data": data } }
            }),
        };
        let legacy = [
            raw("exec-1", "one\n"),
            raw("exec-2", "other\n"),
            raw("exec-1", "two\n"),
            Event::RawAgentUpdate {
                payload: serde_json::json!({ "unrelated": true }),
            },
        ];
        {
            let conn = store.conn.lock().unwrap();
            for (index, event) in legacy.iter().enumerate() {
                let seq = index as u64 + 1;
                let json = serde_json::to_string(event).unwrap();
                events::insert_event(&conn, &store.schema, "s-1", seq, &json, seq as i64).unwrap();
            }
            conn.execute(
                "UPDATE acp_event_store_meta SET value = 1 WHERE key = 'compaction_version'",
                [],
            )
            .unwrap();
            run_legacy_compaction(&conn, &store.schema).unwrap();
        }
        let replay = store.replay_from("s-1", 0);
        assert_eq!(
            replay.iter().map(|(seq, _)| *seq).collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
        assert!(matches!(
            &replay[0].1,
            Event::ToolCallOutputDelta { tool_call_id, data, .. } if tool_call_id == "exec-2" && data == "other\n"
        ));
        assert!(matches!(
            &replay[1].1,
            Event::ToolCallOutputDelta { tool_call_id, data, .. } if tool_call_id == "exec-1" && data == "one\ntwo\n"
        ));
        assert!(matches!(&replay[2].1, Event::RawAgentUpdate { .. }));
    }
}
