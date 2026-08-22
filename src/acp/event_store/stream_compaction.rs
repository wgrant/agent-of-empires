use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::EventStore;
use crate::acp::state::Event;

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChunkKind {
    Message,
    Thought,
}

struct ChunkRun {
    kind: ChunkKind,
    start_seq: u64,
    end_seq: u64,
    text: String,
    chunks: usize,
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
    for row in rows {
        let (seq, json) = row?;
        let event = match serde_json::from_str::<Event>(&json) {
            Ok(event) => event,
            Err(_) => {
                if let Some(run) = current.take().filter(|run| run.chunks > 1) {
                    runs.push(run);
                }
                continue;
            }
        };
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

    let transaction = conn.unchecked_transaction()?;
    let mut removed = 0;
    for run in runs {
        let json = serde_json::to_string(&run.snapshot())?;
        transaction.execute(
            &format!(
                "UPDATE {table} SET event_json = ?1, discriminant = ?2
                 WHERE session_id = ?3 AND seq = ?4"
            ),
            params![
                json,
                run.snapshot_discriminant(),
                session_id,
                run.end_seq as i64
            ],
        )?;
        removed += transaction.execute(
            &format!(
                "DELETE FROM {table}
                 WHERE session_id = ?1 AND seq >= ?2 AND seq < ?3 AND discriminant = ?4"
            ),
            params![
                session_id,
                run.start_seq as i64,
                run.end_seq as i64,
                run.source_discriminant()
            ],
        )?;
    }
    transaction.commit()?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::event_store::test_support::{agent_chunk, open_store};

    #[test]
    fn stopped_turn_seals_consecutive_message_and_thought_runs() {
        let (_tmp, store) = open_store(1000);
        let events = [
            agent_chunk("Hel"),
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
            vec![2, 4, 5, 6]
        );
        assert!(matches!(
            &replay[0].1,
            Event::AgentMessageSnapshot { block_start_seq: 1, text } if text == "Hello"
        ));
        assert!(matches!(
            &replay[1].1,
            Event::AgentThoughtSnapshot { block_start_seq: 3, text } if text == "planning"
        ));
        assert!(matches!(&replay[2].1, Event::AgentMessageChunk { text } if text == "Done"));
    }
}
