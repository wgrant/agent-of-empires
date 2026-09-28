use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::EventStore;
use crate::acp::state::Event;
use crate::events;

const EVENT_COMPACTION_VERSION: i64 = 5;

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChunkKind {
    Message,
    Thought,
}

struct ChunkRun {
    session_id: String,
    kind: ChunkKind,
    /// The run's first and last stored rows.
    start_seq: u64,
    end_seq: u64,
    /// Each chunk, or snapshot of a block, as (block start, text).
    pieces: Vec<(u64, String)>,
    rows: usize,
}

#[derive(Debug, PartialEq, Eq)]
struct CompactionReport {
    tool_content_rows: usize,
    stream_chunk_rows: usize,
}

impl ChunkRun {
    fn snapshot(&self) -> Event {
        let block_start_seq = self
            .pieces
            .first()
            .map_or(self.start_seq, |(start, _)| *start);
        let text = self.pieces.iter().map(|(_, text)| text.as_str()).collect();
        match self.kind {
            ChunkKind::Message => Event::AgentMessageSnapshot {
                block_start_seq,
                text,
            },
            ChunkKind::Thought => Event::AgentThoughtSnapshot {
                block_start_seq,
                text,
            },
        }
    }

    /// The chunk and snapshot discriminants of the run's kind.
    fn source_discriminants(&self) -> [&'static str; 2] {
        match self.kind {
            ChunkKind::Message => ["AgentMessageChunk", "AgentMessageSnapshot"],
            ChunkKind::Thought => ["AgentThoughtChunk", "AgentThoughtSnapshot"],
        }
    }

    fn snapshot_discriminant(&self) -> &'static str {
        self.source_discriminants()[1]
    }
}

/// A streamed text row: its kind, the block a snapshot restates, and its text.
fn stream_text(event: &Event) -> Option<(ChunkKind, Option<u64>, &str)> {
    match event {
        Event::AgentMessageChunk { text } => Some((ChunkKind::Message, None, text)),
        Event::AgentThoughtChunk { text } => Some((ChunkKind::Thought, None, text)),
        Event::AgentMessageSnapshot {
            block_start_seq,
            text,
        } => Some((ChunkKind::Message, Some(*block_start_seq), text)),
        Event::AgentThoughtSnapshot {
            block_start_seq,
            text,
        } => Some((ChunkKind::Thought, Some(*block_start_seq), text)),
        _ => None,
    }
}

/// Groups a session's stored rows into the runs the transcript shows as one
/// reply or thought, as `TranscriptModel` does live.
struct TextRuns {
    session_id: String,
    runs: Vec<ChunkRun>,
    current: Option<ChunkRun>,
}

impl TextRuns {
    fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_owned(),
            runs: Vec::new(),
            current: None,
        }
    }

    fn observe(&mut self, seq: u64, event: &Event) {
        let Some((kind, block_start, text)) = stream_text(event) else {
            if !event.leaves_text_run_open() {
                self.close();
            }
            return;
        };
        if self.current.as_ref().is_some_and(|run| run.kind != kind) {
            self.close();
        }
        let run = self.current.get_or_insert_with(|| ChunkRun {
            session_id: self.session_id.clone(),
            kind,
            start_seq: seq,
            end_seq: seq,
            pieces: Vec::new(),
            rows: 0,
        });
        // A snapshot restates its block from its start.
        if let Some(start) = block_start {
            run.pieces.retain(|(piece, _)| *piece < start);
        }
        run.pieces
            .push((block_start.unwrap_or(seq), text.to_owned()));
        run.end_seq = seq;
        run.rows += 1;
    }

    /// An unreadable row ends the run, since nothing shows what it held.
    fn close(&mut self) {
        if let Some(run) = self.current.take().filter(|run| run.rows > 1) {
            self.runs.push(run);
        }
    }

    fn finish(mut self) -> Vec<ChunkRun> {
        self.close();
        self.runs
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
        let [chunk, snapshot] = run.source_discriminants();
        removed += transaction.execute(
            &format!(
                "DELETE FROM {table}
                 WHERE session_id = ?1 AND seq >= ?2 AND seq < ?3
                   AND discriminant IN (?4, ?5)"
            ),
            params![
                run.session_id,
                run.start_seq as i64,
                run.end_seq as i64,
                chunk,
                snapshot
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
    // From the previous turn's end, so an agent-initiated turn that a prompt
    // interrupted before it stopped is sealed along with that prompt's turn.
    let boundary: Option<i64> = conn
        .query_row(
            &format!(
                "SELECT MAX(seq) FROM {table}
                 WHERE session_id = ?1 AND seq < ?2 AND discriminant = 'Stopped'"
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
    let mut runs = TextRuns::new(session_id);
    let mut outputs = OutputRuns::default();
    for row in rows {
        let (seq, json) = row?;
        match serde_json::from_str::<Event>(&json) {
            Ok(event) => {
                outputs.observe(seq, &event);
                runs.observe(seq, &event);
            }
            Err(_) => runs.close(),
        }
    }
    let runs = runs.finish();
    drop(stmt);

    Ok(apply_chunk_runs(conn, &store.schema, runs)?
        + outputs.apply(conn, &store.schema, session_id)?
        + drop_turn_scratch(conn, &store.schema, session_id)?)
}

/// A finished turn's output-token count, and hooks that succeeded silently,
/// which nothing shows once the turn is over.
fn drop_turn_scratch(
    conn: &Connection,
    schema: &events::Schema,
    session_id: &str,
) -> Result<usize> {
    conn.execute(
        &format!(
            "DELETE FROM {} WHERE session_id = ?1 AND (
                 discriminant = 'TurnOutputTokens'
                 OR (discriminant = 'HookUpdated'
                     AND json_extract(event_json, '$.HookUpdated.status') = 'success'
                     AND trim(coalesce(json_extract(event_json, '$.HookUpdated.output'), ''),
                              ' ' || char(9) || char(10) || char(13)) = ''))",
            schema.events_table()
        ),
        params![session_id],
    )
    .context("drop finished turn scratch events")
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

    let stream_chunk_rows = seal_history_text_runs(conn, schema)?;
    Ok(CompactionReport {
        tool_content_rows,
        stream_chunk_rows,
    })
}

/// Stored events that `Event::leaves_text_run_open` can pass over; the
/// history scan reads only these and the text rows themselves.
const TEXT_RUN_TRANSPARENT: &[&str] = &[
    "TurnOutputTokens",
    "PromptSuggested",
    "ToolUseSummarized",
    "UsageUpdated",
    "RawAgentUpdate",
    "SubagentUpdate",
    "HookUpdated",
];

/// Merges each finished turn's split text runs across the whole log, as the
/// transcript joins them live. Only runs after a session's last `Stopped` may
/// still be streaming.
fn seal_history_text_runs(conn: &Connection, schema: &events::Schema) -> Result<usize> {
    let table = schema.events_table();
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
    let readable = [
        "AgentMessageChunk",
        "AgentThoughtChunk",
        "AgentMessageSnapshot",
        "AgentThoughtSnapshot",
    ]
    .iter()
    .chain(TEXT_RUN_TRANSPARENT)
    .map(|d| format!("'{d}'"))
    .collect::<Vec<_>>()
    .join(", ");
    let mut merged = 0;
    for session_id in session_ids {
        let sealed = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT seq, discriminant,
                            CASE WHEN discriminant IN ({readable}) THEN event_json ELSE NULL END
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
            let mut runs = TextRuns::new(&session_id);
            let mut sealed = Vec::new();
            for row in rows {
                let (seq, discriminant, json) = row.context("read historical stream row")?;
                match json.and_then(|json| serde_json::from_str::<Event>(&json).ok()) {
                    Some(event) => runs.observe(seq, &event),
                    None => runs.close(),
                }
                if discriminant == "Stopped" {
                    sealed.append(&mut runs.runs);
                }
            }
            sealed
        };
        merged += apply_chunk_runs(conn, schema, sealed)?;
    }
    Ok(merged)
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
    let terminal_output_rows = if version < 2 {
        convert_raw_terminal_output(conn, schema)?
    } else {
        0
    };
    // Replies and thoughts split by events that no longer end a run, or left
    // in agent-initiated turns that a prompt interrupted.
    let rejoined_text_rows = if (1..5).contains(&version) {
        seal_history_text_runs(conn, schema)?
    } else {
        0
    };
    // Claude's raw tool results, read at ingest and otherwise stored twice.
    let raw_tool_result_rows = conn
        .execute(
            &format!(
                "DELETE FROM {} WHERE discriminant = 'RawAgentUpdate'
                   AND json_extract(event_json, '$.RawAgentUpdate.payload._meta.claudeCode.toolResponse') IS NOT NULL",
                schema.events_table()
            ),
            [],
        )
        .context("drop stored raw tool results")?;
    conn.execute(
        "INSERT INTO acp_event_store_meta (key, value) VALUES ('compaction_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![EVENT_COMPACTION_VERSION],
    )
    .context("store event compaction version")?;
    // Now, not at the next turn's end, where it would stall live sessions.
    if report.tool_content_rows
        + report.stream_chunk_rows
        + terminal_output_rows
        + raw_tool_result_rows
        + rejoined_text_rows
        > 0
    {
        events::reclaim_free_pages(conn)?;
    }
    tracing::debug!(
        target: "acp.event_store",
        tool_content_rows = report.tool_content_rows,
        stream_chunk_rows = report.stream_chunk_rows,
        terminal_output_rows,
        raw_tool_result_rows,
        rejoined_text_rows,
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

    /// Replacing events keep only their latest, and a finished turn drops its
    /// token count and silent hooks but keeps a hook worth reading.
    #[test]
    fn replaced_and_finished_turn_scratch_events_are_dropped() {
        use crate::acp::event_store::test_support::{record_from, stopped};
        let (_tmp, store) = open_store(1000);
        let hook = |id: &str, status: &str, output: &str| Event::HookUpdated {
            id: id.into(),
            name: "PreToolUse:Bash".into(),
            event: "PreToolUse".into(),
            status: status.into(),
            output: output.into(),
            exit_code: None,
        };
        let suggestion = |text: &str| Event::PromptSuggested { text: text.into() };
        record_from(
            &store,
            "s",
            1,
            [
                user_prompt("go"),
                hook("quiet", "running", ""),
                hook("loud", "running", ""),
                Event::TurnOutputTokens { tokens: 10 },
                hook("quiet", "success", "\n"),
                hook("loud", "error", "blocked"),
                Event::TurnOutputTokens { tokens: 20 },
                suggestion("old"),
            ],
        );
        let kept = |store: &EventStore| -> Vec<String> {
            store
                .replay_from("s", 0)
                .into_iter()
                .filter(|(_, e)| !matches!(e, Event::UserPromptSent { .. } | Event::Stopped { .. }))
                .map(|(seq, e)| format!("{seq}:{e:?}").chars().take(40).collect())
                .collect()
        };
        assert_eq!(
            kept(&store),
            [
                "5:HookUpdated { id: \"quiet\", name: \"PreT",
                "6:HookUpdated { id: \"loud\", name: \"PreTo",
                "7:TurnOutputTokens { tokens: 20 }",
                "8:PromptSuggested { text: \"old\" }",
            ]
        );
        record_from(&store, "s", 9, [stopped("end_turn"), suggestion("new")]);
        assert_eq!(
            kept(&store),
            [
                "6:HookUpdated { id: \"loud\", name: \"PreTo",
                "10:PromptSuggested { text: \"new\" }",
            ]
        );
    }

    #[test]
    fn stopped_turn_seals_consecutive_message_and_thought_runs() {
        let (_tmp, store) = open_store(1000);
        let stopped = || Event::Stopped {
            reason: "prompt_complete".into(),
        };
        // An agent-initiated turn that a prompt interrupts has no `Stopped`.
        let events = [
            stopped(),
            agent_chunk("Hel"),
            Event::SubagentUpdate {
                id: "a1".into(),
                event: Box::new(agent_chunk("sub")),
            },
            // Nor does a token count, which the finished turn drops.
            Event::TurnOutputTokens { tokens: 5 },
            agent_chunk("lo"),
            Event::AgentThoughtChunk {
                text: "plan".into(),
            },
            Event::AgentThoughtChunk {
                text: "ning".into(),
            },
            user_prompt("go on"),
            agent_chunk("Done"),
            agent_chunk("!"),
            stopped(),
        ];
        for (index, event) in events.iter().enumerate() {
            store.record("s-1", index as u64 + 1, event).unwrap();
        }

        let replay = store.replay_from("s-1", 0);
        assert_eq!(
            replay.iter().map(|(seq, _)| *seq).collect::<Vec<_>>(),
            vec![1, 3, 5, 7, 8, 10, 11]
        );
        assert!(matches!(
            &replay[2].1,
            Event::AgentMessageSnapshot { block_start_seq: 2, text } if text == "Hello"
        ));
        assert!(matches!(
            &replay[3].1,
            Event::AgentThoughtSnapshot { block_start_seq: 6, text } if text == "planning"
        ));
        assert!(matches!(
            &replay[5].1,
            Event::AgentMessageSnapshot { block_start_seq: 9, text } if text == "Done!"
        ));
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

    /// A turn's reply sealed at its end stays one snapshot across events that
    /// show nothing, and splits at a hook card.
    #[test]
    fn sealing_ends_a_run_only_at_something_shown() {
        let hook = |status: &str, output: &str| Event::HookUpdated {
            id: "h".into(),
            name: "Stop".into(),
            event: "Stop".into(),
            status: status.into(),
            output: output.into(),
            exit_code: None,
        };
        let cases: Vec<(Vec<Event>, Vec<&str>)> = vec![
            (
                vec![
                    agent_chunk("rem"),
                    Event::TurnOutputTokens { tokens: 9 },
                    agent_chunk("o"),
                    hook("success", ""),
                    agent_chunk("ve"),
                ],
                vec!["remove"],
            ),
            (
                vec![
                    agent_chunk("be"),
                    agent_chunk("fore"),
                    hook("error", "failed"),
                    agent_chunk("af"),
                    agent_chunk("ter"),
                ],
                vec!["before", "after"],
            ),
        ];
        for (events, want) in cases {
            let (_tmp, store) = open_store(1000);
            let turn = std::iter::once(user_prompt("go"))
                .chain(events.clone())
                .chain([Event::Stopped {
                    reason: "prompt_complete".into(),
                }]);
            for (index, event) in turn.enumerate() {
                store.record("s-1", index as u64 + 1, &event).unwrap();
            }
            let texts: Vec<String> = store
                .replay_from("s-1", 0)
                .into_iter()
                .filter_map(|(_, e)| match e {
                    Event::AgentMessageSnapshot { text, .. }
                    | Event::AgentMessageChunk { text } => Some(text),
                    _ => None,
                })
                .collect();
            assert_eq!(texts, want, "{events:?}");
        }
    }

    /// The upgrade rejoins replies split by a token count the finished turn
    /// deleted, and seals an agent-initiated turn that a prompt interrupted.
    #[test]
    fn upgrade_rejoins_split_and_interrupted_replies() {
        let (_tmp, store) = open_store(1000);
        let history = [
            (1, user_prompt("go")),
            (
                5,
                Event::AgentMessageSnapshot {
                    block_start_seq: 2,
                    text: "Once this ships, rem".into(),
                },
            ),
            // Seq 6 held the deleted token count.
            (7, agent_chunk("ove the line.")),
            (
                8,
                Event::Stopped {
                    reason: "prompt_complete".into(),
                },
            ),
            (9, agent_chunk("Tests ")),
            (10, agent_chunk("pass.")),
            (11, user_prompt("next")),
            (
                12,
                Event::Stopped {
                    reason: "prompt_complete".into(),
                },
            ),
        ];
        let conn = store.conn.lock().unwrap();
        for (seq, event) in &history {
            let json = serde_json::to_string(event).unwrap();
            events::insert_event(&conn, &store.schema, "s-1", *seq, &json, *seq as i64).unwrap();
        }
        conn.execute(
            "UPDATE acp_event_store_meta SET value = 4 WHERE key = 'compaction_version'",
            [],
        )
        .unwrap();
        run_legacy_compaction(&conn, &store.schema).unwrap();
        drop(conn);
        let replay = store.replay_from("s-1", 0);
        assert_eq!(
            replay.iter().map(|(seq, _)| *seq).collect::<Vec<_>>(),
            vec![1, 7, 8, 10, 11, 12]
        );
        assert!(matches!(
            &replay[1].1,
            Event::AgentMessageSnapshot { block_start_seq: 2, text } if text == "Once this ships, remove the line."
        ));
        assert!(matches!(
            &replay[3].1,
            Event::AgentMessageSnapshot { block_start_seq: 9, text } if text == "Tests pass."
        ));
    }

    /// The history scan reads only the stored events the predicate can pass over.
    #[test]
    fn history_scan_reads_every_event_that_leaves_a_run_open() {
        let events = [
            Event::TurnOutputTokens { tokens: 1 },
            Event::PromptSuggested { text: "x".into() },
            Event::ToolUseSummarized {
                summary: "x".into(),
                tool_call_ids: Vec::new(),
            },
            Event::RawAgentUpdate {
                payload: serde_json::Value::Null,
            },
            Event::SubagentUpdate {
                id: "a".into(),
                event: Box::new(agent_chunk("x")),
            },
            Event::HookUpdated {
                id: "h".into(),
                name: "Stop".into(),
                event: "Stop".into(),
                status: "running".into(),
                output: String::new(),
                exit_code: None,
            },
        ];
        for event in events {
            assert!(event.leaves_text_run_open());
            let json = serde_json::to_value(&event).unwrap();
            let discriminant = json.as_object().unwrap().keys().next().unwrap().clone();
            assert!(
                TEXT_RUN_TRANSPARENT.contains(&discriminant.as_str()),
                "{discriminant}"
            );
        }
        assert!(TEXT_RUN_TRANSPARENT.contains(&"UsageUpdated"));
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
            Event::RawAgentUpdate {
                payload: serde_json::json!({
                    "toolCallId": "toolu_1",
                    "_meta": { "claudeCode": { "toolResponse": { "stdout": "dup" } } }
                }),
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
