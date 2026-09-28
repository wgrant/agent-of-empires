//! Read endpoints: transcript replay, context primer, workspace files, worker
//! log, and importable Claude sessions.

use serde::{Deserialize, Serialize};

use crate::acp::protocol::{
    ContextPrimerQuery, ContextPrimerResponse, FilesResponse, ReplayQuery, ReplayResponse,
};
use crate::server::api::{find_instance, instance_exists};

use super::*;

const DEFAULT_REPLAY_PAGE: usize = 1000;
const MAX_REPLAY_PAGE: usize = 2000;

const WORKER_LOG_DEFAULT_TAIL: usize = 200;
const WORKER_LOG_MAX_TAIL: usize = 2000;
/// Read window cap so a runaway log cannot pin the daemon.
const WORKER_LOG_MAX_READ_BYTES: u64 = 4 * 1024 * 1024;

const MAX_LISTED_FILES: usize = 5000;

fn blocking_failed(context: &str, e: impl std::fmt::Display) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("{context}: {e}")).into_response()
}

/// Workspace files for the @-mention picker.
pub async fn acp_files(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if let Some(resp) = cityhall_block(&state) {
        return resp;
    }
    let Some(inst) = find_instance(&state, &id).await else {
        return session_not_found();
    };
    let root = PathBuf::from(&inst.project_path);
    match tokio::task::spawn_blocking(move || list_files(&root, MAX_LISTED_FILES)).await {
        Ok(Ok((files, truncated))) => Json(FilesResponse { files, truncated }).into_response(),
        Ok(Err(e)) => blocking_failed("file listing failed", e),
        Err(e) => blocking_failed("blocking task failed", e),
    }
}

/// Relative file paths under `root`, skipping dotfiles and build/VCS dirs.
/// Entries are walked in name order so the capped subset is deterministic.
fn list_files(root: &std::path::Path, cap: usize) -> std::io::Result<(Vec<String>, bool)> {
    const SKIP_DIRS: &[&str] = &[
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        ".venv",
        ".cache",
        ".turbo",
        ".idea",
        ".vscode",
    ];
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut truncated = false;
    while let Some(dir) = stack.pop() {
        if out.len() >= cap {
            truncated = true;
            break;
        }
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = read.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') || SKIP_DIRS.contains(&name_str.as_ref()) {
                continue;
            }
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                if let Ok(rel) = path.strip_prefix(root) {
                    out.push(rel.to_string_lossy().to_string());
                    if out.len() >= cap {
                        truncated = true;
                        break;
                    }
                }
            }
        }
    }
    out.sort();
    Ok((out, truncated))
}

#[derive(Debug, Deserialize)]
pub struct WorkerLogQuery {
    pub tail: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct WorkerLogResponse {
    pub path: String,
    pub exists: bool,
    pub tail: String,
    pub lines_returned: usize,
    /// The file exceeded the read window, so the tail starts mid-file.
    pub truncated: bool,
}

/// Tail of the per-session runner log (what `aoe acp logs` reads).
pub async fn acp_worker_log(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<WorkerLogQuery>,
) -> impl IntoResponse {
    if let Some(resp) = cityhall_block(&state) {
        return resp;
    }
    if !instance_exists(&state, &id).await {
        return session_not_found();
    }
    let log_path = match crate::process::worker_registry::log_path_for(&id) {
        Ok(p) => p,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, format!("invalid session id: {e}")).into_response();
        }
    };
    let tail = q
        .tail
        .unwrap_or(WORKER_LOG_DEFAULT_TAIL)
        .clamp(1, WORKER_LOG_MAX_TAIL);
    let path = log_path.display().to_string();
    match tokio::task::spawn_blocking(move || read_log_tail(&log_path, tail)).await {
        Ok(Ok((lines, truncated, exists))) => Json(WorkerLogResponse {
            path,
            exists,
            tail: lines.join("\n"),
            lines_returned: lines.len(),
            truncated,
        })
        .into_response(),
        Ok(Err(e)) => blocking_failed("worker log read failed", e),
        Err(e) => blocking_failed("blocking task failed", e),
    }
}

/// The last `tail` lines within the read window, as `(lines, truncated, exists)`.
pub(crate) fn read_log_tail(
    path: &std::path::Path,
    tail: usize,
) -> std::io::Result<(Vec<String>, bool, bool)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), false, false));
        }
        Err(e) => return Err(e),
    };
    let len = file.metadata()?.len();
    let read_from = len.saturating_sub(WORKER_LOG_MAX_READ_BYTES);
    let truncated = len > WORKER_LOG_MAX_READ_BYTES;

    // The first line is partial unless the window starts right after a newline.
    let prev_is_newline = if truncated && read_from > 0 {
        let mut prev_byte = [0u8; 1];
        file.seek(SeekFrom::Start(read_from - 1))?;
        file.read_exact(&mut prev_byte)?;
        prev_byte[0] == b'\n'
    } else {
        false
    };

    file.seek(SeekFrom::Start(read_from))?;
    let window_len = len - read_from;
    let mut raw = Vec::with_capacity(window_len as usize);
    // `take` keeps a concurrent append from growing past the window.
    (&mut file).take(window_len).read_to_end(&mut raw)?;
    let buf = String::from_utf8_lossy(&raw);
    let mut lines: Vec<String> = buf.lines().map(|l| l.to_string()).collect();
    if truncated && !prev_is_newline && !lines.is_empty() {
        lines.remove(0);
    }
    let start = lines.len().saturating_sub(tail);
    Ok((lines[start..].to_vec(), truncated, true))
}

/// A markdown recap of the persisted transcript, offered after a failed
/// `session/load` left the agent without context (#1004).
pub async fn acp_context_primer(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<ContextPrimerQuery>,
) -> impl IntoResponse {
    let events = state.acp_event_store.replay_before(&id, q.before_seq);
    let primer = crate::acp::context_primer::build_context_primer(
        &events,
        crate::acp::context_primer::PrimerOptions {
            before_seq: Some(q.before_seq),
            ..Default::default()
        },
    );
    Json(ContextPrimerResponse {
        primer: primer.text,
        included_event_count: primer.included_event_count,
        included_turn_count: primer.included_turn_count,
        truncated: primer.truncated,
        max_chars: primer.max_chars,
        unprocessed_prompt: primer.unprocessed_prompt,
    })
    .into_response()
}

/// The rows the events in `first..=last` appended, patched or removed, as a
/// fold of the whole log now holds them. A row created before the page but
/// changed in it arrives current, and an older page never rolls back a row a
/// newer one already carried.
fn page_rows(
    store: &crate::acp::event_store::EventStore,
    session_id: &str,
    first: u64,
    last: u64,
) -> (Vec<crate::acp::transcript::TranscriptRow>, Vec<String>) {
    let mut model = crate::acp::transcript::TranscriptModel::new();
    let mut changes = crate::acp::transcript::ChangedRows::default();
    for e in store.replay_recorded_from(session_id, 0) {
        let deltas = model.apply_event_at(e.seq, &e.event, e.recorded_at);
        if (first..=last).contains(&e.seq) {
            changes.record(deltas);
        }
    }
    changes.resolve(&model)
}

/// Paged transcript replay from the durable event store. `before` pages
/// backward; `view=rows` returns the rows the page's events changed, see
/// [`page_rows`], with identical paging metadata.
pub async fn acp_replay(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<ReplayQuery>,
) -> impl IntoResponse {
    let limit = q
        .limit
        .map(|l| l as usize)
        .unwrap_or(DEFAULT_REPLAY_PAGE)
        .clamp(1, MAX_REPLAY_PAGE);
    let backward = q.before.is_some();
    // One store call so the page and its seq bounds are a consistent snapshot.
    let page = match q.before {
        Some(before) => state
            .acp_event_store
            .replay_page_before(&id, before, Some(limit)),
        None => state.acp_event_store.replay_page(&id, q.since, Some(limit)),
    };
    let (highest_seq, lowest_seq, next_cursor, has_more) = (
        page.highest_seq,
        page.lowest_seq,
        page.last_scanned_seq,
        page.has_more,
    );
    let (frames, rows, removed) = if q.view.as_deref() == Some("rows") {
        match (page.events.first(), page.events.last()) {
            (Some(first), Some(last)) => {
                let store = Arc::clone(&state.acp_event_store);
                let session_id = id.clone();
                let (first, last) = (first.seq, last.seq);
                match tokio::task::spawn_blocking(move || {
                    page_rows(&store, &session_id, first, last)
                })
                .await
                {
                    Ok((rows, removed)) => (Vec::new(), Some(rows), removed),
                    Err(e) => return blocking_failed("blocking task failed", e),
                }
            }
            _ => (Vec::new(), Some(Vec::new()), Vec::new()),
        }
    } else {
        let frames = page
            .events
            .into_iter()
            .map(|crate::acp::event_store::StoredEvent { seq, event, .. }| {
                crate::server::AcpBroadcastFrame {
                    session_id: id.clone(),
                    seq,
                    event: Arc::new(event),
                    worker_generation: None,
                }
            })
            .collect();
        (frames, None, Vec::new())
    };
    // A forward cursor older than the oldest retained event lost history.
    let lost = match (backward, lowest_seq) {
        (false, Some(lo)) => q.since < lo.saturating_sub(1),
        _ => false,
    };
    Json(ReplayResponse {
        frames,
        lost,
        highest_seq,
        lowest_seq,
        next_cursor,
        has_more,
        rows,
        removed,
    })
    .into_response()
}

/// Claude Code sessions on disk for the import picker, newest first. Blocked in
/// read-only mode: it exposes titles and paths outside AoE state (#2276).
pub async fn list_claude_sessions(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    if let Some(resp) = read_only_block(&state) {
        return resp;
    }
    let mut sessions = tokio::task::spawn_blocking(crate::session::claude_import::scan_sessions)
        .await
        .unwrap_or_default();
    // Drop sessions AoE owns: by stored session id, or by cwd inside an
    // AoE-provisioned dir (scratch, managed worktree, workspace). A plain
    // project path is not enough: a user's own `claude` run there is importable.
    let (managed_ids, managed_dirs): (std::collections::HashSet<String>, Vec<PathBuf>) = {
        let instances = state.instances.read().await;
        let ids = instances
            .iter()
            .flat_map(|i| {
                i.acp_session_id
                    .iter()
                    .chain(i.agent_session_id.iter())
                    .cloned()
            })
            .collect();
        let dirs = instances
            .iter()
            .filter(|i| {
                i.scratch
                    || i.worktree_info.as_ref().is_some_and(|w| w.managed_by_aoe)
                    || i.workspace_info.is_some()
            })
            .map(|i| PathBuf::from(&i.project_path))
            .filter(|p| !p.as_os_str().is_empty())
            .collect();
        (ids, dirs)
    };
    sessions.retain(|s| {
        !managed_ids.contains(&s.session_id)
            && !managed_dirs
                .iter()
                .any(|d| std::path::Path::new(&s.cwd).starts_with(d))
    });
    // Capped after filtering so managed sessions cannot crowd out real ones.
    sessions.truncate(crate::session::claude_import::MAX_SESSIONS);
    Json(sessions).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::state::Event;
    use std::io::Write;

    #[test]
    fn read_log_tail_windows_and_partial_lines() {
        let dir = tempfile::tempdir().unwrap();

        let (lines, truncated, exists) =
            read_log_tail(&dir.path().join("missing.log"), 100).unwrap();
        assert!(lines.is_empty() && !truncated && !exists);

        let path = dir.path().join("a.log");
        let mut f = std::fs::File::create(&path).unwrap();
        for i in 0..10 {
            writeln!(f, "line {i}").unwrap();
        }
        drop(f);
        assert_eq!(
            read_log_tail(&path, 3).unwrap(),
            (
                vec!["line 7".to_string(), "line 8".into(), "line 9".into()],
                false,
                true
            )
        );
        assert_eq!(read_log_tail(&path, 999).unwrap().0.len(), 10);

        // (padding past the window, expected first line when truncated)
        let window = WORKER_LOG_MAX_READ_BYTES as usize;
        for (big_len, first) in [(window - 1, Some("first")), (window + 64, None)] {
            let path = dir.path().join(format!("big-{big_len}.log"));
            let mut f = std::fs::File::create(&path).unwrap();
            let big_line = "x".repeat(big_len);
            writeln!(f, "{big_line}").unwrap();
            writeln!(f, "first").unwrap();
            writeln!(f, "second").unwrap();
            drop(f);
            let (lines, truncated, exists) = read_log_tail(&path, 10).unwrap();
            assert!(truncated && exists);
            assert_eq!(lines.last().map(String::as_str), Some("second"));
            assert!(!lines.contains(&big_line));
            if let Some(first) = first {
                assert_eq!(lines.first().map(String::as_str), Some(first));
            }
        }
    }

    #[test]
    fn list_files_sorts_skips_and_caps() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("b.rs"), "").unwrap();
        std::fs::write(root.join("a.rs"), "").unwrap();
        std::fs::write(root.join(".hidden"), "").unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub").join("c.rs"), "").unwrap();
        // Dotfiles are skipped at every level.
        std::fs::write(root.join("sub").join(".env"), "").unwrap();
        for skip in [".git", "node_modules", "target"] {
            std::fs::create_dir(root.join(skip)).unwrap();
            std::fs::write(root.join(skip).join("junk"), "").unwrap();
        }

        assert_eq!(
            list_files(root, 5000).unwrap(),
            (vec!["a.rs".into(), "b.rs".into(), "sub/c.rs".into()], false)
        );
        assert_eq!(
            list_files(root, 2).unwrap(),
            (vec!["a.rs".into(), "b.rs".into()], true)
        );
    }

    #[tokio::test]
    async fn acp_replay_view_rows_matches_frames_pagination() {
        use crate::acp::transcript::TranscriptRowKind;

        let inst = crate::session::Instance::new("t", "/tmp");
        let id = inst.id.clone();
        let state = crate::server::test_support::build_test_app_state(vec![inst]);
        let events = [
            Event::UserPromptSent {
                text: "hello".into(),
                attachments: Vec::new(),
                prompt_id: None,
                synthesized: false,
            },
            Event::AgentMessageChunk { text: "hi".into() },
            Event::AgentMessageChunk {
                text: " there".into(),
            },
            Event::Stopped {
                reason: "prompt_complete".into(),
            },
        ];
        for (i, ev) in events.iter().enumerate() {
            state
                .acp_event_store
                .record(&id, i as u64 + 1, ev)
                .expect("record");
        }

        let read = |since: u64, view: Option<&str>| {
            let state = Arc::clone(&state);
            let id = id.clone();
            let q = ReplayQuery {
                since,
                limit: Some(2),
                before: None,
                view: view.map(str::to_string),
            };
            async move {
                let resp = acp_replay(State(state), Path(id), axum::extract::Query(q))
                    .await
                    .into_response();
                let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
                    .await
                    .unwrap();
                serde_json::from_slice::<ReplayResponse>(&bytes).unwrap()
            }
        };

        let frames_resp = read(0, None).await;
        assert_eq!(frames_resp.frames.len(), 2);
        assert!(frames_resp.rows.is_none());
        assert!(frames_resp.has_more);

        let rows_resp = read(0, Some("rows")).await;
        assert!(rows_resp.frames.is_empty());
        assert_eq!(
            rows_resp
                .rows
                .as_ref()
                .expect("rows present")
                .iter()
                .map(|r| r.kind)
                .collect::<Vec<_>>(),
            vec![TranscriptRowKind::UserPrompt, TranscriptRowKind::Message]
        );
        assert_eq!(rows_resp.next_cursor, frames_resp.next_cursor);
        assert_eq!(rows_resp.has_more, frames_resp.has_more);
        assert_eq!(rows_resp.highest_seq, frames_resp.highest_seq);
        assert_eq!(rows_resp.lowest_seq, frames_resp.lowest_seq);
        assert_eq!(rows_resp.lost, frames_resp.lost);

        let second_rows = read(2, Some("rows")).await;
        let rows = second_rows.rows.expect("rows present");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "msg-2");
        assert_eq!(rows[0].text, "hi there");
    }
    fn at(secs: i64) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::from_timestamp(secs, 0).unwrap()
    }

    fn start(id: &str) -> Event {
        Event::ToolCallStarted {
            tool_call: crate::acp::state::ToolCall {
                id: id.into(),
                name: format!("run {id}"),
                kind: "execute".into(),
                args_preview: "{}".into(),
                started_at: at(1),
                parent_tool_call_id: None,
                memory_recall: None,
                diffs: Vec::new(),
            },
        }
    }

    fn done(id: &str, content: &str) -> Event {
        Event::ToolCallCompleted {
            tool_call_id: id.into(),
            is_error: false,
            content: content.into(),
            output: Vec::new(),
            completed_at: at(2),
            async_subagent: false,
        }
    }

    fn output(id: &str, data: &str) -> Event {
        Event::ToolCallOutputDelta {
            tool_call_id: id.into(),
            data: data.into(),
            replace: false,
        }
    }

    fn hook(status: &str, output: &str) -> Event {
        Event::HookUpdated {
            id: "h1".into(),
            name: "PreToolUse:Bash".into(),
            event: "PreToolUse".into(),
            status: status.into(),
            output: output.into(),
            exit_code: None,
        }
    }

    fn spawned(id: &str) -> Event {
        Event::SubagentSpawned {
            id: id.into(),
            parent: None,
            name: "teammate".into(),
            task: format!("task for {id}"),
            at: at(3),
            persistent: true,
        }
    }

    fn subagent_state(id: &str, state: &str) -> Event {
        Event::SubagentStateChanged {
            id: id.into(),
            state: state.into(),
            at: at(4),
        }
    }

    fn in_subagent(id: &str, event: Event) -> Event {
        Event::SubagentUpdate {
            id: id.into(),
            event: Box::new(event),
        }
    }

    fn workflow(id: &str) -> Event {
        Event::AsyncTaskSpawned {
            id: id.into(),
            name: "review".into(),
            task_type: "workflow".into(),
            description: Some("Review the change".into()),
            tool_call_id: None,
            can_stop: true,
            at: at(5),
        }
    }

    fn workflow_progress(id: &str, step: &str) -> Event {
        Event::AsyncTaskProgress {
            id: id.into(),
            description: Some(step.into()),
            usage: None,
            tool_call_id: None,
            at: at(6),
        }
    }

    fn workflow_state(id: &str, state: &str) -> Event {
        Event::AsyncTaskStateChanged {
            id: id.into(),
            state: state.into(),
            summary: None,
            tool_call_id: None,
            at: at(7),
        }
    }

    fn summarized(id: &str) -> Event {
        Event::ToolUseSummarized {
            summary: "Ran the tests".into(),
            tool_call_ids: vec![id.into()],
        }
    }

    fn prompt(text: &str) -> Event {
        Event::UserPromptSent {
            text: text.into(),
            attachments: Vec::new(),
            prompt_id: None,
            synthesized: false,
        }
    }

    fn stopped() -> Event {
        Event::Stopped {
            reason: "prompt_complete".into(),
        }
    }

    fn chunk(text: &str) -> Event {
        Event::AgentMessageChunk { text: text.into() }
    }

    fn asked(tool_call_id: &str) -> Event {
        Event::ElicitationRequested {
            elicitation: crate::acp::elicitations::Elicitation {
                nonce: crate::acp::approvals::Nonce("e-1".into()),
                message: "Pick one".into(),
                title: None,
                description: None,
                tool_call_id: Some(tool_call_id.into()),
                questions: Vec::new(),
                requested_at: at(8),
                resolved: None,
            },
        }
    }

    /// Every row a whole-log fold holds through `through`, keyed by id.
    fn cold_rows(
        store: &crate::acp::event_store::EventStore,
        id: &str,
        through: u64,
    ) -> std::collections::BTreeMap<String, crate::acp::transcript::TranscriptRow> {
        cold_model_rows(store, id, through)
            .into_iter()
            .map(|row| (row.id.clone(), row))
            .collect()
    }

    /// A whole-log fold's rows through `through`, in order.
    fn cold_model_rows(
        store: &crate::acp::event_store::EventStore,
        id: &str,
        through: u64,
    ) -> Vec<crate::acp::transcript::TranscriptRow> {
        let mut model = crate::acp::transcript::TranscriptModel::new();
        for e in store.replay_recorded_from(id, 0) {
            if e.seq <= through {
                model.apply_event_at(e.seq, &e.event, e.recorded_at);
            }
        }
        model.rows().to_vec()
    }

    async fn rows_since(state: &Arc<AppState>, id: &str, since: u64) -> ReplayResponse {
        let q = ReplayQuery {
            since,
            limit: None,
            before: None,
            view: Some("rows".into()),
        };
        let resp = acp_replay(
            State(Arc::clone(state)),
            Path(id.to_string()),
            axum::extract::Query(q),
        )
        .await
        .into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// A page that patches a row created before it returns that row as a
    /// cold load shows it.
    #[tokio::test]
    async fn acp_replay_rows_page_returns_rows_it_patches_from_before_it() {
        let cases: Vec<(&str, Vec<Event>, Vec<Event>, Vec<&str>)> = vec![
            (
                "teammate ends",
                vec![spawned("a1")],
                vec![subagent_state("a1", "completed")],
                vec!["subagent-a1"],
            ),
            (
                "teammate woken",
                vec![spawned("a1"), subagent_state("a1", "completed")],
                vec![spawned("a1:generation:2")],
                vec!["subagent-a1", "woken-a1:generation:2"],
            ),
            (
                "teammate ends with a call open",
                vec![spawned("a1"), in_subagent("a1", start("t1"))],
                vec![subagent_state("a1", "cancelled")],
                vec!["subagent-a1", "stopped-t1-3"],
            ),
            (
                "workflow progresses",
                vec![workflow("w1")],
                vec![workflow_progress("w1", "Reading files")],
                vec!["subagent-w1"],
            ),
            (
                "workflow ends",
                vec![workflow("w1"), workflow_progress("w1", "Reading files")],
                vec![workflow_state("w1", "completed")],
                vec!["subagent-w1"],
            ),
            (
                "earlier call summarized",
                vec![start("t1"), done("t1", "ok")],
                vec![summarized("t1")],
                vec!["start-t1"],
            ),
            (
                "call completes with output streamed before the page",
                vec![start("t1"), output("t1", "line one\n")],
                vec![done("t1", "")],
                vec!["start-t1", "done-t1"],
            ),
            (
                "hook finishes",
                vec![prompt("go"), hook("running", "")],
                vec![hook("error", "blocked")],
                vec!["hook-h1"],
            ),
            (
                "turn end cuts a running hook short",
                vec![prompt("go"), hook("running", "")],
                vec![stopped()],
                vec!["hook-h1"],
            ),
            (
                "reply continues",
                vec![prompt("go"), chunk("Hel")],
                vec![chunk("lo")],
                vec!["msg-2"],
            ),
        ];
        for (name, origin, patch, want) in cases {
            let inst = crate::session::Instance::new("t", "/tmp");
            let id = inst.id.clone();
            let state = crate::server::test_support::build_test_app_state(vec![inst]);
            for (i, event) in origin.iter().chain(&patch).enumerate() {
                state
                    .acp_event_store
                    .record(&id, i as u64 + 1, event)
                    .unwrap();
            }
            let page = rows_since(&state, &id, origin.len() as u64).await;
            let cold = cold_rows(&state.acp_event_store, &id, u64::MAX);
            let rows = page.rows.expect("rows present");
            for want in want {
                let row = rows.iter().find(|row| row.id == want);
                assert_eq!(row, cold.get(want), "{name}: {want}");
            }
        }
    }

    /// Catching up with forward pages from any cursor, at any page size,
    /// leaves a client with exactly the rows of a cold load.
    #[test]
    fn rows_pages_from_any_cursor_rebuild_the_cold_transcript() {
        let (_tmp, store) = {
            let tmp = tempfile::tempdir().unwrap();
            let store =
                crate::acp::event_store::EventStore::open(&tmp.path().join("events.db"), 10_000)
                    .unwrap();
            (tmp, store)
        };
        let id = "s-1";
        let stream = [
            prompt("go"),
            chunk("Look"),
            chunk("ing."),
            hook("running", ""),
            start("t1"),
            output("t1", "one\n"),
            hook("error", "blocked"),
            output("t1", "two\n"),
            done("t1", ""),
            summarized("t1"),
            start("t2"),
            asked("t2"),
            spawned("a1"),
            in_subagent("a1", chunk("sub ")),
            in_subagent("a1", start("t3")),
            in_subagent("a1", chunk("work")),
            workflow("w1"),
            workflow_progress("w1", "Reading files"),
            subagent_state("a1", "completed"),
            workflow_progress("w1", "Writing report"),
            chunk("Done"),
            stopped(),
            spawned("a1:generation:2"),
            in_subagent("a1:generation:2", chunk("again")),
            workflow_state("w1", "completed"),
            subagent_state("a1:generation:2", "completed"),
            prompt("next"),
            start("t4"),
            stopped(),
        ];
        for (i, event) in stream.iter().enumerate() {
            store.record(id, i as u64 + 1, event).unwrap();
        }
        let seqs: Vec<u64> = store
            .replay_from(id, 0)
            .iter()
            .map(|(seq, _)| *seq)
            .collect();
        let cold = cold_rows(&store, id, u64::MAX);
        let cold_order = cold_model_rows(&store, id, u64::MAX);
        let page_rows_of = |page: &crate::acp::event_store::ReplayPage| match (
            page.events.first(),
            page.events.last(),
        ) {
            (Some(first), Some(last)) => page_rows(&store, id, first.seq, last.seq),
            _ => Default::default(),
        };
        for limit in [1, 2, 5] {
            // Forward from every cursor a client can hold.
            for cursor in std::iter::once(0).chain(seqs.iter().copied()) {
                let mut rows = cold_model_rows(&store, id, cursor);
                let mut since = cursor;
                loop {
                    let page = store.replay_page(id, since, Some(limit));
                    let (changed, removed) = page_rows_of(&page);
                    for row in changed {
                        crate::acp::transcript::upsert_transcript_row(&mut rows, row);
                    }
                    rows.retain(|row| !removed.contains(&row.id));
                    match page.last_scanned_seq {
                        Some(next) if page.has_more => since = next,
                        _ => break,
                    }
                }
                assert_eq!(rows, cold_order, "forward from {cursor}, limit {limit}");
            }
            // Backward from the tail: every row a page carries is current, and
            // together the pages hold every row.
            let mut seen = std::collections::BTreeMap::new();
            let mut before = u64::MAX;
            loop {
                let page = store.replay_page_before(id, before, Some(limit));
                for row in page_rows_of(&page).0 {
                    assert_eq!(Some(&row), cold.get(&row.id), "backward, limit {limit}");
                    seen.insert(row.id.clone(), row);
                }
                match page.last_scanned_seq {
                    Some(next) if page.has_more && next < before => before = next,
                    _ => break,
                }
            }
            assert_eq!(seen, cold, "backward, limit {limit}");
        }
    }
}
