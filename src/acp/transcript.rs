//! `TranscriptModel`: the server-side render model for the structured-view transcript.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::elicitations::ElicitationAnswer;
use super::state::{DiffComment, DiffPreview, Event, ToolCall, ToolOutputBlock};
use crate::daemon::PromptAttachmentRef;

/// One renderable row of the transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscriptRow {
    pub id: String,
    pub group_id: String,
    pub kind: TranscriptRowKind,
    pub at: DateTime<Utc>,
    pub text: String,
    /// Set on tool-lifecycle rows so a client pairs a completion with its start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Full tool payload on `tool_start` rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolCall>,
    /// Structured completion payload on `tool_complete` / `tool_error` rows.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output: Vec<ToolOutputBlock>,
    /// Attachment metadata on a `user_prompt` row; bytes are fetched lazily.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<PromptAttachmentRef>,
    /// Structured payload on a `user_diff_comments` row; `text` holds the markdown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_comments: Option<DiffCommentsPayload>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub elicitation_answers: Vec<ElicitationAnswer>,
    /// A `tool_complete` row that launched an async sub-agent.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub async_subagent: bool,
    /// An `agent_notice` row's severity: `info`, `warning`, or `error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    /// The native subagent whose session produced this row; on a `subagent`
    /// row, the one that spawned it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_id: Option<String>,
    /// The subagent a `subagent` row introduces; `text` holds its task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<SubagentInfo>,
    /// The compaction a `compacted` row reports; `text` holds its kept summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<CompactionInfo>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CompactionInfo {
    /// `running`, then `completed`, `failed`, `cancelled`, or `interrupted`
    /// when the turn ended without a verdict.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// `automatic` or `manual`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// When it stopped running, whatever the outcome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubagentInfo {
    pub id: String,
    pub name: String,
    /// `workflow` for a Claude workflow run; a native subagent has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// What a workflow is doing now, such as its current agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    /// `None` while it runs; then `completed`, `failed`, `cancelled`, or `disconnected`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<DateTime<Utc>>,
    /// A teammate that waits for messages between runs: a finished run leaves
    /// it idle.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub persistent: bool,
}

impl CompactionInfo {
    /// One line naming the outcome and what the agent measured.
    pub fn headline(&self) -> String {
        let outcome = match self.state.as_str() {
            "running" => "Compacting context".to_string(),
            "failed" => match &self.error {
                Some(error) => format!("Compaction failed: {error}"),
                None => "Compaction failed".to_string(),
            },
            "cancelled" => "Compaction cancelled".to_string(),
            "interrupted" => "Compaction interrupted".to_string(),
            _ => "Context compacted".to_string(),
        };
        let mut facts = Vec::new();
        if let Some(trigger) = &self.trigger {
            facts.push(trigger.clone());
        }
        match (self.pre_tokens, self.post_tokens) {
            (Some(pre), Some(post)) => facts.push(format!(
                "{} → {} tokens",
                compact_count(pre),
                compact_count(post)
            )),
            (Some(pre), None) => facts.push(format!("from {} tokens", compact_count(pre))),
            _ => {}
        }
        if let Some(ms) = self.duration_ms {
            facts.push(format!("{}s", ms.div_ceil(1000)));
        }
        if facts.is_empty() {
            outcome
        } else {
            format!("{outcome} ({})", facts.join(", "))
        }
    }
}

fn compact_count(n: u64) -> String {
    match n {
        0..1_000 => n.to_string(),
        1_000..1_000_000 => format!("{}k", n / 1_000),
        _ => format!("{:.1}M", n as f64 / 1_000_000.0),
    }
}

/// The kind discriminant for a [`TranscriptRow`]. Mirrors the web
/// `ActivityRow["kind"]` union. Reasoning text is a transcript row, while the
/// live thinking phase remains control state on `AcpState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptRowKind {
    ToolStart,
    ToolComplete,
    ToolError,
    ToolStopped,
    Message,
    Thinking,
    UserPrompt,
    UserDiffComments,
    ElicitationAnswered,
    EmptyOutput,
    ContextReset,
    SessionCleared,
    /// One compaction, from its start to its verdict and kept summary.
    Compacted,
    Summary,
    /// An error or lifecycle notice the user needs in the timeline.
    Notice,
    /// An agent session advisory. Unlike `Notice`, every surface keeps it in
    /// the timeline, since its banner is capped and retired by the next turn.
    Advisory,
    /// An advisory from the agent itself, carrying a severity.
    AgentNotice,
    /// A native subagent the agent delegated to; its own rows name it in `subagent_id`.
    Subagent,
    /// A message that woke a waiting subagent for another run; `text` holds it.
    SubagentWoken,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiffCommentsPayload {
    pub intro: String,
    pub outro: String,
    pub is_multi_repo: bool,
    pub comments: Vec<DiffComment>,
}

/// An incremental change to the row list, emitted per event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TranscriptDelta {
    Append(TranscriptRow),
    Patch {
        id: String,
        row: TranscriptRow,
    },
    /// A row was removed (an AskUserQuestion card superseded by its form).
    Remove(String),
}

/// The row carries no severity field, so the text spells it out.
fn session_notice_text(severity: &str, title: &str, description: &Option<String>) -> String {
    match description
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        Some(description) => format!("{severity}: {title}: {description}"),
        None => format!("{severity}: {title}"),
    }
}

/// Folds the ACP `Event` stream into an ordered [`TranscriptRow`] list.
#[derive(Debug, Clone, Default)]
pub struct TranscriptModel {
    rows: Vec<TranscriptRow>,
    row_ids: HashSet<String>,
    /// Tool calls that reached a terminal row, so nothing closes them twice.
    terminal_tools: HashSet<String>,
    /// Streamed `ToolCallContent`, keyed by tool call id.
    tool_outputs: HashMap<String, String>,
    /// Tool calls surfaced as an elicitation (AskUserQuestion); their cards are suppressed.
    elicitation_tool_ids: HashSet<String>,
    /// The row receiving the current consecutive message or thought stream.
    open_text_run: Option<(TranscriptRowKind, usize)>,
    /// Each subagent's own open run, so its text never joins the main agent's.
    subagent_text_runs: HashMap<String, (TranscriptRowKind, usize)>,
    /// The subagent whose event is being applied; stamped on the rows it appends.
    scope: Option<String>,
    /// This turn's latest compaction row per scope, which the compaction's
    /// later events, and repeats of them, update.
    compactions: HashMap<Option<String>, usize>,
    group_counter: u64,
    /// Frames at or below this seq are dropped, so replay overlap is harmless.
    last_seq: u64,
    turn_active: bool,
    /// Whether the running turn produced visible output, for the empty-output notice.
    turn_has_output: bool,
    /// Whether a mid-turn prompt steers the running turn rather than opening a new one.
    steering: bool,
    /// When the event being applied was recorded; stamps the rows it creates.
    now: DateTime<Utc>,
}

impl TranscriptModel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn rows(&self) -> &[TranscriptRow] {
        &self.rows
    }

    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    /// Apply one live event at `seq`, returning the row changes it produced.
    pub fn apply_event(&mut self, seq: u64, event: &Event) -> Vec<TranscriptDelta> {
        self.apply_event_at(seq, event, Utc::now())
    }

    /// Apply one event recorded at `at`, such as one replayed from the store.
    pub fn apply_event_at(
        &mut self,
        seq: u64,
        event: &Event,
        at: DateTime<Utc>,
    ) -> Vec<TranscriptDelta> {
        if seq <= self.last_seq {
            return Vec::new();
        }
        self.last_seq = seq;
        self.now = at;
        self.apply(seq, event)
    }

    fn apply(&mut self, seq: u64, event: &Event) -> Vec<TranscriptDelta> {
        if let Event::SubagentUpdate { id, event } = event {
            return self.apply_in_subagent(seq, agent_id(id), event);
        }
        let incoming_text_kind = match event {
            Event::AgentMessageChunk { .. } | Event::AgentMessageSnapshot { .. } => {
                Some(TranscriptRowKind::Message)
            }
            Event::AgentThoughtChunk { .. } | Event::AgentThoughtSnapshot { .. } => {
                Some(TranscriptRowKind::Thinking)
            }
            _ => None,
        };
        if self.open_text_run.map(|(kind, _)| kind) != incoming_text_kind {
            self.open_text_run = None;
        }

        match event {
            Event::AgentMessageChunk { text } => {
                self.turn_has_output = true;
                self.apply_stream_text(
                    TranscriptRowKind::Message,
                    format!("msg-{seq}"),
                    text,
                    false,
                )
            }
            Event::AgentMessageSnapshot {
                block_start_seq,
                text,
            } => {
                self.turn_has_output = true;
                self.apply_stream_text(
                    TranscriptRowKind::Message,
                    format!("msg-{block_start_seq}"),
                    text,
                    true,
                )
            }
            Event::AgentThoughtChunk { text } => {
                self.turn_has_output = true;
                self.apply_stream_text(
                    TranscriptRowKind::Thinking,
                    format!("thinking-{seq}"),
                    text,
                    false,
                )
            }
            Event::AgentThoughtSnapshot {
                block_start_seq,
                text,
            } => {
                self.turn_has_output = true;
                self.apply_stream_text(
                    TranscriptRowKind::Thinking,
                    format!("thinking-{block_start_seq}"),
                    text,
                    true,
                )
            }
            Event::UserPromptSent {
                text,
                attachments,
                prompt_id,
                synthesized,
            } => {
                self.begin_turn();
                // A rate-limit resume continuation replays a prompt the user
                // already saw once, before the park; render nothing so the
                // transcript reads as an uninterrupted continuation instead
                // of the same message appearing twice.
                if *synthesized {
                    Vec::new()
                } else {
                    let id = match prompt_id {
                        Some(pid) if !pid.is_empty() => pid.clone(),
                        _ => format!("user-seq-{seq}"),
                    };
                    let mut row = self.grouped_row(id, TranscriptRowKind::UserPrompt, text.clone());
                    row.attachments = attachments.clone();
                    vec![self.append(row)]
                }
            }
            Event::UserDiffCommentsPrompt {
                intro,
                outro,
                is_multi_repo,
                comments,
                assembled_markdown,
            } => {
                self.begin_turn();
                let mut row = self.grouped_row(
                    format!("user-seq-{seq}"),
                    TranscriptRowKind::UserDiffComments,
                    assembled_markdown.clone(),
                );
                row.diff_comments = Some(DiffCommentsPayload {
                    intro: intro.clone(),
                    outro: outro.clone(),
                    is_multi_repo: *is_multi_repo,
                    comments: comments.clone(),
                });
                vec![self.append(row)]
            }
            Event::ToolCallStarted { tool_call } => self.on_tool_started(tool_call),
            Event::ToolCallCompleted {
                tool_call_id,
                is_error,
                content,
                output,
                completed_at,
                async_subagent,
            } => {
                if self.elicitation_tool_ids.contains(tool_call_id) {
                    return Vec::new();
                }
                let mut deltas =
                    self.ensure_tool_start(tool_call_id, None, None, *completed_at, None);
                let mut row = self.completion_row(seq, tool_call_id, *is_error, content);
                row.at = *completed_at;
                row.output = output.clone();
                row.async_subagent = *async_subagent;
                deltas.push(self.append(row));
                deltas
            }
            Event::ToolCallContent {
                tool_call_id,
                content,
            } => {
                // Each content frame replaces the previous snapshot.
                self.tool_outputs
                    .insert(tool_call_id.clone(), content.clone());
                Vec::new()
            }
            Event::ToolCallUpdated {
                tool_call_id,
                title,
                args_preview,
                started_at,
                diffs,
            } => self.on_tool_updated(
                tool_call_id,
                title.as_deref(),
                args_preview.as_deref(),
                *started_at,
                diffs.as_deref(),
            ),
            Event::ElicitationRequested { elicitation } => {
                let Some(tool_call_id) = elicitation.tool_call_id.as_ref() else {
                    return Vec::new();
                };
                self.elicitation_tool_ids.insert(tool_call_id.clone());
                self.remove_rows_for_tool(tool_call_id)
            }
            Event::ElicitationResolved { nonce, answers, .. } => {
                let id = format!("elicitation-{}", nonce.0);
                if answers.is_empty() || self.row_ids.contains(&id) {
                    return Vec::new();
                }
                let text = answers
                    .iter()
                    .map(|a| format!("{}: {}", a.question, a.answer))
                    .collect::<Vec<_>>()
                    .join("\n");
                let mut row = self.grouped_row(id, TranscriptRowKind::ElicitationAnswered, text);
                row.elicitation_answers = answers.clone();
                vec![self.append(row)]
            }
            Event::Stopped { .. } => {
                let empty = self.turn_active && !self.turn_has_output;
                let mut deltas = self.sweep_open_tools(seq);
                deltas.extend(self.interrupt_compactions());
                // Some slash commands produce neither a chunk nor a tool call.
                if empty {
                    deltas.push(self.push(
                        format!("empty-{seq}"),
                        TranscriptRowKind::EmptyOutput,
                        "Command produced no output.".to_string(),
                    ));
                }
                self.turn_active = false;
                deltas
            }
            // The failure itself is the turn's visible product, so no empty-output notice.
            Event::AgentStartupError { message } => {
                let mut deltas = self.sweep_open_tools(seq);
                self.turn_active = false;
                self.turn_has_output = true;
                deltas.push(self.notice(seq, format!("agent startup failed: {message}")));
                deltas
            }
            // A dedicated remediation screen renders this, so the timeline stays quiet.
            Event::IncompatibleAgent { .. } => {
                let deltas = self.sweep_open_tools(seq);
                self.turn_active = false;
                deltas
            }
            Event::AgentSwitched { from, to, reason } => {
                let mut deltas = self.sweep_open_tools(seq);
                // Clients render the handoff with the session_cleared divider.
                deltas.push(self.push(
                    format!("agent-switched-{seq}"),
                    TranscriptRowKind::SessionCleared,
                    format!("Switched structured view agent from {from} to {to} ({reason})."),
                ));
                deltas
            }
            Event::SessionCleared => vec![self.push(
                format!("cleared-{seq}"),
                TranscriptRowKind::SessionCleared,
                "Conversation cleared, the model no longer remembers earlier turns.".to_string(),
            )],
            Event::ConversationCompactionStarted => {
                if self.compaction().is_some_and(|c| c.state == "running") {
                    return Vec::new();
                }
                vec![self.push_compaction(seq, "running", String::new())]
            }
            Event::ConversationCompacted => self.update_compaction(seq, |row| {
                let info = row.compaction.get_or_insert_with(Default::default);
                (info.state != "completed").then(|| info.state = "completed".into())
            }),
            Event::SessionContextReset { reason } => {
                let has_prior_prompt = self.rows.iter().any(|r| {
                    matches!(
                        r.kind,
                        TranscriptRowKind::UserPrompt | TranscriptRowKind::UserDiffComments
                    )
                });
                if !has_prior_prompt
                    && (reason.is_empty() || reason.starts_with("session/load failed"))
                {
                    return Vec::new();
                }
                let text = if reason.is_empty() {
                    "Conversation context reset; agent transcript was unavailable.".to_string()
                } else {
                    reason.clone()
                };
                self.turn_has_output = true;
                vec![self.push(
                    format!("reset-{seq}"),
                    TranscriptRowKind::ContextReset,
                    text,
                )]
            }
            Event::PromptRuntimeError { message } => {
                self.turn_has_output = true;
                vec![self.notice(seq, format!("prompt failed: {message}"))]
            }
            Event::ModeSwitchFailed { mode_id, reason } => vec![self.notice(
                seq,
                format!("mode switch to \"{mode_id}\" failed: {reason}"),
            )],
            Event::SessionNotice {
                severity,
                title,
                description,
            } => vec![self.push(
                format!("notice-{seq}"),
                TranscriptRowKind::Advisory,
                session_notice_text(severity, title, description),
            )],
            Event::RateLimitAutoResumed { resets_at, manual } => {
                let how = if *manual { "resumed" } else { "auto-resumed" };
                vec![self.notice(seq, format!("{how} at {resets_at} after rate-limit park"))]
            }
            Event::ConversationSummary { text, .. } => vec![self.push(
                format!("summary-{seq}"),
                TranscriptRowKind::Summary,
                text.clone(),
            )],
            Event::ConversationCompactionSummary { text } => self.update_compaction(seq, |row| {
                (row.text != *text).then(|| row.text = text.clone())
            }),
            Event::ConversationCompactionEnded {
                status,
                error,
                trigger,
                pre_tokens,
                post_tokens,
                duration_ms,
            } => self.update_compaction(seq, |row| {
                let info = row.compaction.get_or_insert_with(Default::default);
                let before = info.clone();
                // A late failure never overturns a reported completion.
                if info.state != "completed" {
                    info.state = status.clone();
                }
                info.error = error.clone().or(info.error.take());
                info.trigger = trigger.clone().or(info.trigger.take());
                info.pre_tokens = pre_tokens.or(info.pre_tokens);
                info.post_tokens = post_tokens.or(info.post_tokens);
                info.duration_ms = duration_ms.or(info.duration_ms);
                (*info != before).then_some(())
            }),
            Event::AgentNotice {
                severity,
                title,
                description,
            } => {
                let text = match description {
                    Some(description) => format!("{title}\n{description}"),
                    None => title.clone(),
                };
                let mut row = self.grouped_row(
                    format!("agent-notice-{seq}"),
                    TranscriptRowKind::AgentNotice,
                    text,
                );
                row.severity = Some(severity.clone());
                vec![self.append(row)]
            }
            Event::SubagentSpawned {
                id: session_id,
                parent,
                name,
                task,
                at,
                persistent,
            } => {
                let id = agent_id(session_id);
                let row_id = format!("subagent-{id}");
                if self.row_ids.contains(&row_id) {
                    return self.wake_subagent(id, session_id, task, *at);
                }
                self.turn_has_output = true;
                let mut row = self.grouped_row(row_id, TranscriptRowKind::Subagent, task.clone());
                row.at = *at;
                row.subagent_id = parent.as_deref().map(|p| agent_id(p).to_string());
                row.subagent = Some(SubagentInfo {
                    id: id.to_string(),
                    name: name.clone(),
                    kind: None,
                    activity: None,
                    state: None,
                    ended_at: None,
                    persistent: *persistent,
                });
                vec![self.append(row)]
            }
            // A workflow's agents report into it like a subagent's session does.
            Event::AsyncTaskSpawned {
                id,
                name,
                task_type,
                description,
                at,
                ..
            } if task_type == "workflow" => {
                let row_id = format!("subagent-{id}");
                if self.row_ids.contains(&row_id) {
                    return Vec::new();
                }
                self.turn_has_output = true;
                let text = description.clone().unwrap_or_default();
                let mut row = self.grouped_row(row_id, TranscriptRowKind::Subagent, text);
                row.at = *at;
                row.subagent = Some(SubagentInfo {
                    id: id.clone(),
                    name: name.clone(),
                    kind: Some("workflow".into()),
                    activity: None,
                    state: None,
                    ended_at: None,
                    persistent: false,
                });
                vec![self.append(row)]
            }
            Event::AsyncTaskProgress {
                id,
                description: Some(activity),
                ..
            } => self.patch_subagent(id, |info| {
                (info.activity.as_ref() != Some(activity))
                    .then(|| info.activity = Some(activity.clone()))
            }),
            Event::AsyncTaskStateChanged { id, state, at, .. } => {
                let state = match state.as_str() {
                    "running" | "paused" => return Vec::new(),
                    "stopped" => "cancelled",
                    other => other,
                };
                let mut deltas = self.patch_subagent(id, |info| {
                    info.state = Some(state.to_string());
                    info.ended_at = Some(*at);
                    Some(())
                });
                // claude-agent-acp never forwards a workflow agent's tool
                // result, and reports `stopped` just before `completed`.
                deltas.extend(self.close_open_tools(
                    seq,
                    Some(id),
                    TranscriptRowKind::ToolComplete,
                    *at,
                ));
                deltas
            }
            Event::SubagentStateChanged { id, state, at } => {
                let id = agent_id(id);
                let mut deltas = self.patch_subagent(id, |info| {
                    info.state = Some(state.clone());
                    info.ended_at = Some(*at);
                    Some(())
                });
                // An interrupted subagent's open calls were cut short too.
                let kind = if state == "completed" {
                    TranscriptRowKind::ToolComplete
                } else {
                    TranscriptRowKind::ToolStopped
                };
                deltas.extend(self.close_open_tools(seq, Some(id), kind, *at));
                deltas
            }
            Event::ThinkingStarted => {
                self.turn_active = true;
                self.turn_has_output = true;
                Vec::new()
            }
            Event::PromptCapabilities { steering, .. } => {
                self.steering = *steering;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn on_tool_started(&mut self, tool_call: &ToolCall) -> Vec<TranscriptDelta> {
        if self.elicitation_tool_ids.contains(&tool_call.id) {
            return Vec::new();
        }
        let Some(idx) = self.find_tool_start(&tool_call.id) else {
            self.turn_has_output = true;
            return vec![self.append(tool_start_row(tool_call.clone()))];
        };
        let row = &mut self.rows[idx];
        let merged = merge_tool_start(row.tool.as_ref().unwrap_or(tool_call), tool_call);
        row.text = merged.name.clone();
        row.at = merged.started_at;
        row.tool = Some(merged);
        vec![patch(row)]
    }

    fn on_tool_updated(
        &mut self,
        tool_call_id: &str,
        title: Option<&str>,
        args_preview: Option<&str>,
        started_at: Option<DateTime<Utc>>,
        diffs: Option<&[DiffPreview]>,
    ) -> Vec<TranscriptDelta> {
        // A non-empty diff list replaces wholesale; none or empty keeps earlier diffs.
        let diffs = diffs.filter(|d| !d.is_empty());
        let synthesized = self.ensure_tool_start(
            tool_call_id,
            title,
            args_preview,
            started_at.unwrap_or_else(Utc::now),
            diffs,
        );
        if !synthesized.is_empty() {
            return synthesized;
        }
        let idx = self
            .find_tool_start(tool_call_id)
            .expect("tool_start present");
        let row = &mut self.rows[idx];
        if let Some(title) = title {
            row.text = title.to_string();
        }
        if let Some(tool) = row.tool.as_mut() {
            if let Some(title) = title {
                tool.name = title.to_string();
            }
            if let Some(args_preview) = args_preview {
                tool.args_preview = args_preview.to_string();
            }
            if let Some(started_at) = started_at {
                tool.started_at = started_at;
            }
            if let Some(diffs) = diffs {
                tool.diffs = diffs.to_vec();
            }
        }
        vec![patch(row)]
    }

    /// Synthesize a `tool_start` for a call first seen by a later frame, so a card renders.
    fn ensure_tool_start(
        &mut self,
        tool_call_id: &str,
        name: Option<&str>,
        args_preview: Option<&str>,
        started_at: DateTime<Utc>,
        diffs: Option<&[DiffPreview]>,
    ) -> Vec<TranscriptDelta> {
        if self.find_tool_start(tool_call_id).is_some() {
            return Vec::new();
        }
        self.turn_has_output = true;
        let tool = ToolCall {
            id: tool_call_id.to_string(),
            name: name
                .filter(|n| !n.is_empty())
                .unwrap_or("tool call")
                .to_string(),
            kind: "other".to_string(),
            args_preview: args_preview.unwrap_or_default().to_string(),
            started_at,
            parent_tool_call_id: None,
            memory_recall: None,
            diffs: diffs.map(<[_]>::to_vec).unwrap_or_default(),
        };
        vec![self.append(tool_start_row(tool))]
    }

    fn completion_row(
        &mut self,
        seq: u64,
        tool_call_id: &str,
        is_error: bool,
        content: &str,
    ) -> TranscriptRow {
        // Completion content wins, then streamed output, then a status word.
        let buffered = self.tool_outputs.remove(tool_call_id).unwrap_or_default();
        let text = if !content.is_empty() {
            content.to_string()
        } else if !buffered.is_empty() {
            buffered
        } else if is_error {
            "tool failed".to_string()
        } else {
            "completed".to_string()
        };
        // Adapters can reuse a tool call id after reconnecting; keep row ids unique.
        let base_id = format!("done-{tool_call_id}");
        let row_id = if self.row_ids.contains(&base_id) {
            format!("{base_id}-{seq}")
        } else {
            base_id
        };
        self.terminal_tools.insert(tool_call_id.to_string());
        let kind = if is_error {
            TranscriptRowKind::ToolError
        } else {
            TranscriptRowKind::ToolComplete
        };
        let mut row =
            TranscriptRow::new(row_id, format!("tool-{tool_call_id}"), kind, text, self.now);
        row.tool_call_id = Some(tool_call_id.to_string());
        row
    }

    /// Close every `tool_start` without a terminal row with a `tool_stopped`
    /// carrying any buffered output.
    fn sweep_open_tools(&mut self, seq: u64) -> Vec<TranscriptDelta> {
        self.close_open_tools(seq, None, TranscriptRowKind::ToolStopped, self.now)
    }

    /// Close tool calls that never reported an end, all of them or one
    /// subagent's. A closing row keeps its call's subagent so a client pairs it.
    fn close_open_tools(
        &mut self,
        seq: u64,
        owner: Option<&str>,
        kind: TranscriptRowKind,
        at: DateTime<Utc>,
    ) -> Vec<TranscriptDelta> {
        let mut seen = self.terminal_tools.clone();
        let open: Vec<(String, Option<String>)> = self
            .rows
            .iter()
            .filter(|row| row.kind == TranscriptRowKind::ToolStart)
            .filter(|row| owner.is_none_or(|owner| row.subagent_id.as_deref() == Some(owner)))
            .filter_map(|row| Some((row.tool_call_id.clone()?, row.subagent_id.clone())))
            .filter(|(id, _)| seen.insert(id.clone()))
            .collect();
        let prefix = if kind == TranscriptRowKind::ToolStopped {
            "stopped"
        } else {
            "done"
        };
        open.into_iter()
            .map(|(id, subagent_id)| {
                self.terminal_tools.insert(id.clone());
                let buffered = self.tool_outputs.remove(&id).unwrap_or_default();
                let mut row = TranscriptRow::new(
                    format!("{prefix}-{id}-{seq}"),
                    format!("tool-{id}"),
                    kind,
                    buffered,
                    at,
                );
                row.tool_call_id = Some(id);
                row.subagent_id = subagent_id;
                self.append(row)
            })
            .collect()
    }

    fn remove_rows_for_tool(&mut self, tool_call_id: &str) -> Vec<TranscriptDelta> {
        let mut removed = Vec::new();
        self.rows.retain(|r| {
            let keep = r.tool_call_id.as_deref() != Some(tool_call_id);
            if !keep {
                removed.push(TranscriptDelta::Remove(r.id.clone()));
            }
            keep
        });
        if !removed.is_empty() {
            self.row_ids = self.rows.iter().map(|r| r.id.clone()).collect();
        }
        removed
    }

    /// Patch a subagent row's info; `update` returns `None` when nothing changed.
    fn patch_subagent(
        &mut self,
        id: &str,
        update: impl FnOnce(&mut SubagentInfo) -> Option<()>,
    ) -> Vec<TranscriptDelta> {
        let Some(row) = self
            .rows
            .iter_mut()
            .find(|row| row.subagent.as_ref().is_some_and(|s| s.id == id))
        else {
            return Vec::new();
        };
        match row.subagent.as_mut().and_then(update) {
            Some(()) => vec![patch(row)],
            None => Vec::new(),
        }
    }

    /// A later generation of a subagent: its card runs again, and the
    /// message that woke it opens the new run.
    fn wake_subagent(
        &mut self,
        id: &str,
        session_id: &str,
        message: &str,
        at: DateTime<Utc>,
    ) -> Vec<TranscriptDelta> {
        let row_id = format!("woken-{session_id}");
        if session_id == id || self.row_ids.contains(&row_id) {
            return Vec::new();
        }
        self.turn_has_output = true;
        let mut deltas = self.patch_subagent(id, |info| {
            info.state = None;
            info.ended_at = None;
            info.activity = None;
            // Woken for another run, it outlives each one.
            info.persistent = true;
            Some(())
        });
        self.subagent_text_runs.remove(id);
        let mut row = self.grouped_row(row_id, TranscriptRowKind::SubagentWoken, message.into());
        row.at = at;
        row.subagent_id = Some(id.to_string());
        deltas.push(self.append(row));
        deltas
    }

    /// Apply a subagent's event with its own text run, its rows stamped with its id.
    fn apply_in_subagent(&mut self, seq: u64, id: &str, event: &Event) -> Vec<TranscriptDelta> {
        let subagent_run = self.subagent_text_runs.remove(id);
        let main_run = std::mem::replace(&mut self.open_text_run, subagent_run);
        let main_scope = self.scope.replace(id.to_string());
        let deltas = self.apply(seq, event);
        self.scope = main_scope;
        if let Some(run) = std::mem::replace(&mut self.open_text_run, main_run) {
            self.subagent_text_runs.insert(id.to_string(), run);
        }
        deltas
    }

    fn append(&mut self, mut row: TranscriptRow) -> TranscriptDelta {
        if row.subagent_id.is_none() {
            row.subagent_id = self.scope.clone();
        }
        self.row_ids.insert(row.id.clone());
        self.rows.push(row.clone());
        TranscriptDelta::Append(row)
    }

    fn grouped_row(&mut self, id: String, kind: TranscriptRowKind, text: String) -> TranscriptRow {
        let group_id = self.fresh_group();
        TranscriptRow::new(id, group_id, kind, text, self.now)
    }

    /// Append a row in its own fresh group.
    fn push(&mut self, id: String, kind: TranscriptRowKind, text: String) -> TranscriptDelta {
        let row = self.grouped_row(id, kind, text);
        self.append(row)
    }

    fn notice(&mut self, seq: u64, text: String) -> TranscriptDelta {
        self.push(format!("notice-{seq}"), TranscriptRowKind::Notice, text)
    }

    fn apply_stream_text(
        &mut self,
        kind: TranscriptRowKind,
        canonical_id: String,
        text: &str,
        replacement: bool,
    ) -> Vec<TranscriptDelta> {
        if let Some((open_kind, index)) = self.open_text_run {
            if open_kind == kind {
                let row = &mut self.rows[index];
                if !replacement || row.id == canonical_id {
                    if replacement {
                        row.text = text.to_owned();
                    } else {
                        row.text.push_str(text);
                    }
                    return vec![TranscriptDelta::Patch {
                        id: row.id.clone(),
                        row: row.clone(),
                    }];
                }
            }
        }

        let group = self.fresh_group();
        let index = self.rows.len();
        let delta = self.append(TranscriptRow::new(
            canonical_id,
            group,
            kind,
            text.to_owned(),
            self.now,
        ));
        self.open_text_run = Some((kind, index));
        vec![delta]
    }

    fn fresh_group(&mut self) -> String {
        self.group_counter += 1;
        format!("g{}", self.group_counter)
    }

    fn compaction(&self) -> Option<&CompactionInfo> {
        let index = *self.compactions.get(&self.scope)?;
        self.rows[index].compaction.as_ref()
    }

    fn push_compaction(&mut self, seq: u64, state: &str, text: String) -> TranscriptDelta {
        self.turn_has_output = true;
        let mut row = self.grouped_row(
            format!("compacted-{seq}"),
            TranscriptRowKind::Compacted,
            text,
        );
        row.compaction = Some(CompactionInfo {
            state: state.into(),
            ..Default::default()
        });
        self.compactions.insert(self.scope.clone(), self.rows.len());
        self.append(row)
    }

    /// Apply a compaction event to this turn's compaction row, or to a new
    /// completed one when the agent never announced a start; `update` returns
    /// `None` when nothing changed.
    fn update_compaction(
        &mut self,
        seq: u64,
        update: impl FnOnce(&mut TranscriptRow) -> Option<()>,
    ) -> Vec<TranscriptDelta> {
        let index = match self.compactions.get(&self.scope) {
            Some(&index) => index,
            None => {
                self.push_compaction(seq, "completed", String::new());
                self.rows.len() - 1
            }
        };
        let fresh = self.rows[index].id == format!("compacted-{seq}");
        let now = self.now;
        let row = &mut self.rows[index];
        let changed = update(row).is_some();
        let ended = row
            .compaction
            .as_mut()
            .filter(|info| info.state != "running" && info.ended_at.is_none())
            .map(|info| info.ended_at = Some(now))
            .is_some();
        let changed = changed || ended;
        let row = &self.rows[index];
        if fresh {
            vec![TranscriptDelta::Append(row.clone())]
        } else if changed {
            vec![patch(row)]
        } else {
            Vec::new()
        }
    }

    /// A turn that ends mid-compaction leaves it with no verdict.
    fn interrupt_compactions(&mut self) -> Vec<TranscriptDelta> {
        let mut deltas = Vec::new();
        for &index in self.compactions.values() {
            let row = &mut self.rows[index];
            if let Some(info) = row.compaction.as_mut().filter(|c| c.state == "running") {
                info.state = "interrupted".into();
                info.ended_at = Some(self.now);
                deltas.push(patch(row));
            }
        }
        deltas
    }

    fn begin_turn(&mut self) {
        self.compactions.clear();
        let steered_continuation = self.turn_active && self.steering;
        self.turn_active = true;
        if !steered_continuation {
            self.turn_has_output = false;
        }
    }

    fn find_tool_start(&self, tool_call_id: &str) -> Option<usize> {
        self.rows.iter().position(|r| {
            r.kind == TranscriptRowKind::ToolStart
                && r.tool_call_id.as_deref() == Some(tool_call_id)
        })
    }
}

/// The agent a subagent session belongs to: claude-agent-acp names each
/// later run of a woken teammate `<id>:generation:<n>`.
fn agent_id(session_id: &str) -> &str {
    session_id
        .split_once(":generation:")
        .map_or(session_id, |(id, _)| id)
}

impl TranscriptRow {
    fn new(
        id: String,
        group_id: String,
        kind: TranscriptRowKind,
        text: String,
        at: DateTime<Utc>,
    ) -> Self {
        Self {
            id,
            group_id,
            kind,
            at,
            text,
            tool_call_id: None,
            tool: None,
            output: Vec::new(),
            attachments: Vec::new(),
            diff_comments: None,
            elicitation_answers: Vec::new(),
            async_subagent: false,
            severity: None,
            subagent_id: None,
            subagent: None,
            compaction: None,
        }
    }
}

fn tool_start_row(tool: ToolCall) -> TranscriptRow {
    let mut row = TranscriptRow::new(
        format!("start-{}", tool.id),
        format!("tool-{}", tool.id),
        TranscriptRowKind::ToolStart,
        tool.name.clone(),
        tool.started_at,
    );
    row.tool_call_id = Some(tool.id.clone());
    row.tool = Some(tool);
    row
}

fn patch(row: &TranscriptRow) -> TranscriptDelta {
    TranscriptDelta::Patch {
        id: row.id.clone(),
        row: row.clone(),
    }
}

/// Merge a repeated `ToolCallStarted` without letting a sparser frame clobber richer data.
pub(crate) fn merge_tool_start(prev: &ToolCall, incoming: &ToolCall) -> ToolCall {
    let pick = |use_incoming: bool, incoming: &String, prev: &String| {
        (if use_incoming { incoming } else { prev }).clone()
    };
    ToolCall {
        id: incoming.id.clone(),
        name: pick(!incoming.name.is_empty(), &incoming.name, &prev.name),
        kind: pick(
            !incoming.kind.is_empty() && incoming.kind != "other",
            &incoming.kind,
            &prev.kind,
        ),
        args_preview: pick(
            !incoming.args_preview.trim().is_empty(),
            &incoming.args_preview,
            &prev.args_preview,
        ),
        started_at: incoming.started_at.max(prev.started_at),
        parent_tool_call_id: incoming
            .parent_tool_call_id
            .clone()
            .or_else(|| prev.parent_tool_call_id.clone()),
        memory_recall: incoming
            .memory_recall
            .clone()
            .or_else(|| prev.memory_recall.clone()),
        diffs: (if incoming.diffs.is_empty() {
            &prev.diffs
        } else {
            &incoming.diffs
        })
        .clone(),
    }
}

/// Reconcile one server-folded row into a client's rows by id, merging a
/// repeated tool start (the twin of the web's `mergeServerRows` step).
pub(crate) fn upsert_transcript_row(rows: &mut Vec<TranscriptRow>, incoming: TranscriptRow) {
    let Some(idx) = rows.iter().position(|r| r.id == incoming.id) else {
        rows.push(incoming);
        return;
    };
    let row = &mut rows[idx];
    if row.kind == TranscriptRowKind::ToolStart && incoming.kind == TranscriptRowKind::ToolStart {
        if let (Some(prev_tool), Some(inc_tool)) = (row.tool.as_ref(), incoming.tool.as_ref()) {
            let merged = merge_tool_start(prev_tool, inc_tool);
            row.text = merged.name.clone();
            row.at = merged.started_at;
            row.tool = Some(merged);
            return;
        }
    }
    *row = incoming;
}

/// Replace the row with `row.id` by the server's full row, appending when absent.
pub(crate) fn patch_transcript_row(rows: &mut Vec<TranscriptRow>, row: TranscriptRow) {
    match rows.iter().position(|r| r.id == row.id) {
        Some(idx) => rows[idx] = row,
        None => rows.push(row),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::approvals::Nonce;
    use crate::acp::elicitations::{Elicitation, ElicitationOutcome};
    use crate::acp::state::test_support::{chunk, prompt, stopped};
    use crate::acp::state::MemoryRecall;
    use crate::daemon::PromptAttachmentKind;
    use chrono::TimeZone;

    fn at(secs: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(secs, 0).single().expect("valid ts")
    }

    fn tool(id: &str, name: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            kind: "execute".into(),
            args_preview: "{}".into(),
            started_at: at(100),
            parent_tool_call_id: None,
            memory_recall: None,
            diffs: Vec::new(),
        }
    }

    fn started(tool_call: ToolCall) -> Event {
        Event::ToolCallStarted { tool_call }
    }

    fn completed(id: &str, is_error: bool, content: &str) -> Event {
        Event::ToolCallCompleted {
            tool_call_id: id.into(),
            is_error,
            content: content.into(),
            output: Vec::new(),
            completed_at: at(200),
            async_subagent: false,
        }
    }

    fn updated(
        id: &str,
        title: Option<&str>,
        args: Option<&str>,
        diffs: Option<Vec<DiffPreview>>,
    ) -> Event {
        Event::ToolCallUpdated {
            tool_call_id: id.into(),
            title: title.map(Into::into),
            args_preview: args.map(Into::into),
            started_at: None,
            diffs,
        }
    }

    fn content(id: &str, text: &str) -> Event {
        Event::ToolCallContent {
            tool_call_id: id.into(),
            content: text.into(),
        }
    }

    fn elicitation_requested(tool_call_id: &str) -> Event {
        Event::ElicitationRequested {
            elicitation: Elicitation {
                nonce: Nonce("e-1".into()),
                message: "Pick one".into(),
                title: None,
                description: None,
                tool_call_id: Some(tool_call_id.into()),
                questions: Vec::new(),
                requested_at: at(50),
                resolved: None,
            },
        }
    }

    #[test]
    fn a_workflow_task_heads_the_rows_its_agents_report() {
        let model = fold([
            prompt("run it"),
            Event::AsyncTaskSpawned {
                id: "wf1".into(),
                name: "calc-bug-check".into(),
                task_type: "workflow".into(),
                description: Some("Check calc.py".into()),
                tool_call_id: None,
                can_stop: true,
                at: at(10),
            },
            // A shell task has no card of its own.
            Event::AsyncTaskSpawned {
                id: "sh1".into(),
                name: "npm run dev".into(),
                task_type: "shell".into(),
                description: None,
                tool_call_id: None,
                can_stop: true,
                at: at(11),
            },
            Event::AsyncTaskProgress {
                id: "wf1".into(),
                description: Some("Review: review:clamp".into()),
                usage: None,
                tool_call_id: None,
                at: at(12),
            },
            Event::SubagentUpdate {
                id: "wf1".into(),
                event: Box::new(started(tool("t1", "Bash"))),
            },
            Event::AsyncTaskStateChanged {
                id: "wf1".into(),
                state: "stopped".into(),
                summary: None,
                tool_call_id: None,
                at: at(20),
            },
        ]);
        // The adapter never forwards a workflow agent's tool result, so its end closes the call.
        assert_eq!(
            kinds(&model),
            [
                TranscriptRowKind::UserPrompt,
                TranscriptRowKind::Subagent,
                TranscriptRowKind::ToolStart,
                TranscriptRowKind::ToolComplete
            ]
        );
        assert_eq!(model.rows()[3].subagent_id.as_deref(), Some("wf1"));
        assert_eq!(model.rows()[3].at, at(20));
        let header = &model.rows()[1];
        let info = header.subagent.as_ref().unwrap();
        assert_eq!(
            (
                header.text.as_str(),
                info.kind.as_deref(),
                info.activity.as_deref(),
                info.state.as_deref(),
                info.ended_at
            ),
            (
                "Check calc.py",
                Some("workflow"),
                Some("Review: review:clamp"),
                Some("cancelled"),
                Some(at(20))
            )
        );
        assert_eq!(model.rows()[2].subagent_id.as_deref(), Some("wf1"));
    }

    #[test]
    fn a_woken_subagent_generation_continues_its_agent() {
        let spawned = |id: &str, parent: Option<&str>, task: &str, t| Event::SubagentSpawned {
            id: id.into(),
            parent: parent.map(Into::into),
            name: "tester".into(),
            task: task.into(),
            at: at(t),
            persistent: false,
        };
        let ended = |id: &str, t| Event::SubagentStateChanged {
            id: id.into(),
            state: "completed".into(),
            at: at(t),
        };
        let in_run = |id: &str, event: Event| Event::SubagentUpdate {
            id: id.into(),
            event: Box::new(event),
        };
        let gen2 = "t1:generation:2";
        let mut model = TranscriptModel::new();
        let events = [
            prompt("team up"),
            spawned("t1", None, "Wait for the bugs", 10),
            ended("t1", 11),
            spawned(gen2, None, "add() subtracts", 20),
            in_run(gen2, chunk("writing tests")),
            spawned("n1", Some(gen2), "Nested", 22),
        ];
        for (i, event) in events.iter().enumerate() {
            model.apply_event(i as u64 + 1, event);
        }
        let rows: Vec<(TranscriptRowKind, Option<&str>, &str)> = model
            .rows()
            .iter()
            .map(|r| (r.kind, r.subagent_id.as_deref(), r.text.as_str()))
            .collect();
        assert_eq!(
            rows,
            [
                (TranscriptRowKind::UserPrompt, None, "team up"),
                (TranscriptRowKind::Subagent, None, "Wait for the bugs"),
                (
                    TranscriptRowKind::SubagentWoken,
                    Some("t1"),
                    "add() subtracts"
                ),
                (TranscriptRowKind::Message, Some("t1"), "writing tests"),
                (TranscriptRowKind::Subagent, Some("t1"), "Nested"),
            ]
        );
        let state = |m: &TranscriptModel| {
            let info = m.rows()[1].subagent.clone().unwrap();
            (info.state, info.ended_at, info.persistent)
        };
        // Woken, it runs again and outlives each run; its generation's end
        // ends the agent's run.
        assert_eq!(state(&model), (None, None, true));
        model.apply_event(7, &ended(gen2, 30));
        assert_eq!(
            state(&model),
            (Some("completed".into()), Some(at(30)), true)
        );
    }

    #[test]
    fn subagent_rows_are_scoped_and_keep_their_own_text_runs() {
        let child = |event: Event| Event::SubagentUpdate {
            id: "c1".into(),
            event: Box::new(event),
        };
        let model = fold([
            prompt("delegate"),
            Event::SubagentSpawned {
                id: "c1".into(),
                parent: None,
                name: "Explorer".into(),
                task: "Find it".into(),
                at: at(10),
                persistent: false,
            },
            chunk("main "),
            child(chunk("child ")),
            chunk("text"),
            child(chunk("more")),
            child(started(tool("t1", "Read"))),
            Event::SubagentStateChanged {
                id: "c1".into(),
                state: "completed".into(),
                at: at(20),
            },
        ]);
        let rows: Vec<(TranscriptRowKind, Option<&str>, &str)> = model
            .rows()
            .iter()
            .map(|r| (r.kind, r.subagent_id.as_deref(), r.text.as_str()))
            .collect();
        assert_eq!(
            rows,
            [
                (TranscriptRowKind::UserPrompt, None, "delegate"),
                (TranscriptRowKind::Subagent, None, "Find it"),
                (TranscriptRowKind::Message, None, "main text"),
                (TranscriptRowKind::Message, Some("c1"), "child more"),
                (TranscriptRowKind::ToolStart, Some("c1"), "Read"),
                // A completed subagent finished what it started.
                (TranscriptRowKind::ToolComplete, Some("c1"), ""),
            ]
        );
        let header = &model.rows()[1];
        let info = header.subagent.as_ref().unwrap();
        assert_eq!(
            (
                info.name.as_str(),
                info.state.as_deref(),
                header.at,
                info.ended_at
            ),
            ("Explorer", Some("completed"), at(10), Some(at(20)))
        );
    }

    fn fold(events: impl IntoIterator<Item = Event>) -> TranscriptModel {
        let mut m = TranscriptModel::new();
        for (i, e) in events.into_iter().enumerate() {
            m.apply_event(i as u64 + 1, &e);
        }
        m
    }

    fn kinds(m: &TranscriptModel) -> Vec<TranscriptRowKind> {
        m.rows().iter().map(|r| r.kind).collect()
    }

    fn count(m: &TranscriptModel, kind: TranscriptRowKind) -> usize {
        m.rows().iter().filter(|r| r.kind == kind).count()
    }

    fn row<'a>(m: &'a TranscriptModel, id: &str) -> &'a TranscriptRow {
        m.rows()
            .iter()
            .find(|r| r.id == id)
            .unwrap_or_else(|| panic!("no row {id}"))
    }

    fn tool_of<'a>(m: &'a TranscriptModel, id: &str) -> &'a ToolCall {
        row(m, id).tool.as_ref().expect("tool payload")
    }

    #[test]
    fn rows_carry_the_time_their_event_was_recorded() {
        let mut m = TranscriptModel::new();
        m.apply_event_at(1, &prompt("go"), at(10));
        m.apply_event_at(2, &chunk("Hel"), at(20));
        m.apply_event_at(3, &chunk("lo"), at(30));
        let times: Vec<_> = m.rows().iter().map(|r| (r.kind, r.at)).collect();
        // A streamed reply keeps the time it started.
        assert_eq!(
            times,
            [
                (TranscriptRowKind::UserPrompt, at(10)),
                (TranscriptRowKind::Message, at(20)),
            ]
        );
    }

    #[test]
    fn a_compaction_spans_from_its_start_to_its_verdict() {
        let mut m = TranscriptModel::new();
        m.apply_event_at(1, &prompt("go"), at(0));
        m.apply_event_at(2, &Event::ConversationCompactionStarted, at(10));
        m.apply_event_at(3, &Event::ConversationCompacted, at(70));
        // A repeat of the verdict does not move its end.
        m.apply_event_at(4, &Event::ConversationCompacted, at(90));
        let row = &m.rows()[1];
        let ended = row.compaction.as_ref().and_then(|c| c.ended_at);
        assert_eq!((row.at, ended), (at(10), Some(at(70))));
    }

    #[test]
    fn a_compaction_folds_into_one_row() {
        let ended = |status: &str, facts: bool| Event::ConversationCompactionEnded {
            status: status.into(),
            error: (status == "failed").then(|| "too long".into()),
            trigger: facts.then(|| "automatic".into()),
            pre_tokens: facts.then_some(966_795),
            post_tokens: facts.then_some(10_147),
            duration_ms: facts.then_some(71_200),
        };
        let summary = || Event::ConversationCompactionSummary {
            text: "kept the plan".into(),
        };
        let stopped = || Event::Stopped {
            reason: "prompt_complete".into(),
        };
        // (events, each compaction row's headline and summary)
        let cases: Vec<(Vec<Event>, Vec<(&str, &str)>)> = vec![
            // claude-agent-acp repeats the completion to add its measurements.
            (
                vec![
                    prompt("go"),
                    Event::ConversationCompactionStarted,
                    Event::ConversationCompacted,
                    summary(),
                    ended("completed", false),
                    Event::ConversationCompacted,
                    ended("completed", true),
                    stopped(),
                ],
                vec![(
                    "Context compacted (automatic, 966k → 10k tokens, 72s)",
                    "kept the plan",
                )],
            ),
            // No start announced, as a legacy completion or on attach.
            (
                vec![prompt("go"), Event::ConversationCompacted],
                vec![("Context compacted", "")],
            ),
            (
                vec![
                    prompt("go"),
                    Event::ConversationCompactionStarted,
                    ended("failed", false),
                ],
                vec![("Compaction failed: too long", "")],
            ),
            (
                vec![
                    prompt("go"),
                    Event::ConversationCompactionStarted,
                    stopped(),
                ],
                vec![("Compaction interrupted", "")],
            ),
            (
                vec![prompt("go"), Event::ConversationCompactionStarted],
                vec![("Compacting context", "")],
            ),
            // Each turn's compaction is its own row.
            (
                vec![
                    prompt("one"),
                    Event::ConversationCompacted,
                    prompt("two"),
                    Event::ConversationCompacted,
                ],
                vec![("Context compacted", ""), ("Context compacted", "")],
            ),
        ];
        for (events, want) in cases {
            let m = fold(events);
            let got: Vec<(String, &str)> = m
                .rows()
                .iter()
                .filter(|r| r.kind == TranscriptRowKind::Compacted)
                .map(|r| {
                    let info = r.compaction.as_ref().expect("compaction info");
                    (info.headline(), r.text.as_str())
                })
                .collect();
            let want: Vec<(String, &str)> = want
                .into_iter()
                .map(|(headline, text)| (headline.to_string(), text))
                .collect();
            assert_eq!(got, want);
        }
    }

    #[test]
    fn notice_divider_and_control_events_render_per_event() {
        let resets_at = at(1_767_225_600);
        let switched = Event::AgentSwitched {
            from: "claude".into(),
            to: "codex".into(),
            reason: "rate_limit".into(),
        };
        // (event, row id, kind, text)
        let cases = [
            (
                Event::AgentStartupError {
                    message: "node missing".into(),
                },
                "notice-1",
                TranscriptRowKind::Notice,
                "agent startup failed: node missing".to_string(),
            ),
            (
                Event::PromptRuntimeError {
                    message: "stream died".into(),
                },
                "notice-1",
                TranscriptRowKind::Notice,
                "prompt failed: stream died".to_string(),
            ),
            (
                Event::ModeSwitchFailed {
                    mode_id: "bypassPermissions".into(),
                    reason: "denied".into(),
                },
                "notice-1",
                TranscriptRowKind::Notice,
                "mode switch to \"bypassPermissions\" failed: denied".to_string(),
            ),
            (
                Event::SessionNotice {
                    severity: "warning".into(),
                    title: "Model fallback".into(),
                    description: Some("Switched to Sonnet.".into()),
                },
                "notice-1",
                TranscriptRowKind::Advisory,
                "warning: Model fallback: Switched to Sonnet.".to_string(),
            ),
            (
                Event::SessionNotice {
                    severity: "info".into(),
                    title: "Task stopped by user".into(),
                    description: None,
                },
                "notice-1",
                TranscriptRowKind::Advisory,
                "info: Task stopped by user".to_string(),
            ),
            (
                Event::RateLimitAutoResumed {
                    resets_at,
                    manual: false,
                },
                "notice-1",
                TranscriptRowKind::Notice,
                format!("auto-resumed at {resets_at} after rate-limit park"),
            ),
            // RESUME NOW is the user's own resume, so it is not called automatic.
            (
                Event::RateLimitAutoResumed {
                    resets_at,
                    manual: true,
                },
                "notice-1",
                TranscriptRowKind::Notice,
                format!("resumed at {resets_at} after rate-limit park"),
            ),
            (
                Event::SessionCleared,
                "cleared-1",
                TranscriptRowKind::SessionCleared,
                "Conversation cleared, the model no longer remembers earlier turns.".to_string(),
            ),
            (
                Event::ConversationSummary {
                    text: "did the thing".into(),
                    summarized_until_seq: 0,
                },
                "summary-1",
                TranscriptRowKind::Summary,
                "did the thing".to_string(),
            ),
            (
                Event::AgentNotice {
                    severity: "warning".into(),
                    title: "Config".into(),
                    description: Some("deprecated key".into()),
                },
                "agent-notice-1",
                TranscriptRowKind::AgentNotice,
                "Config\ndeprecated key".to_string(),
            ),
            (
                switched,
                "agent-switched-1",
                TranscriptRowKind::SessionCleared,
                "Switched structured view agent from claude to codex (rate_limit).".to_string(),
            ),
        ];
        for (event, id, kind, text) in cases {
            let m = fold([event]);
            let got = row(&m, id);
            assert_eq!((got.kind, got.text.as_str()), (kind, text.as_str()), "{id}");
            let want_severity = (kind == TranscriptRowKind::AgentNotice).then_some("warning");
            assert_eq!(got.severity.as_deref(), want_severity, "{id}");
        }

        // Control-only events produce no rows.
        let m = fold([
            Event::PlanUpdated {
                plan: crate::acp::state::Plan {
                    plan_id: "p".into(),
                    version: 1,
                    steps: Vec::new(),
                },
            },
            Event::ThinkingEnded,
            Event::RawAgentUpdate {
                payload: serde_json::json!({"x": 1}),
            },
            Event::TodoListUpdated { todos: Vec::new() },
        ]);
        assert!(m.rows().is_empty());
        assert_eq!(m.last_seq(), 4);

        // A context-reset divider needs a reason or a prior prompt.
        let reset = |reason: &str| Event::SessionContextReset {
            reason: reason.into(),
        };
        assert!(fold([reset("")]).rows().is_empty());
        assert!(fold([reset("session/load failed: bad id")])
            .rows()
            .is_empty());

        let isolated = fold([reset("Sandbox native history was isolated")]);
        let last = isolated.rows().last().unwrap();
        assert_eq!(last.kind, TranscriptRowKind::ContextReset);
        assert!(last.text.contains("isolated"));

        let m = fold([prompt("hi"), reset("session/load failed: bad id")]);
        let last = m.rows().last().unwrap();
        assert_eq!(
            (last.kind, last.text.as_str()),
            (
                TranscriptRowKind::ContextReset,
                "session/load failed: bad id"
            )
        );
        let m = fold([prompt("hi"), reset("")]);
        assert!(m.rows().last().unwrap().text.contains("context reset"));
    }

    #[test]
    fn prompts_append_keyed_rows_and_replays_are_dropped() {
        let mut m = TranscriptModel::new();
        assert_eq!(m.apply_event(1, &prompt("hi")).len(), 1);
        assert!(m.apply_event(1, &prompt("ignored")).is_empty());
        assert!(m.apply_event(0, &prompt("older")).is_empty());
        assert_eq!((m.rows().len(), m.last_seq()), (1, 1));

        let with_attachment = Event::UserPromptSent {
            text: "look".into(),
            attachments: vec![PromptAttachmentRef {
                id: "att-1".into(),
                kind: PromptAttachmentKind::Image,
                mime_type: "image/png".into(),
                name: Some("shot.png".into()),
                size: 1234,
            }],
            prompt_id: None,
            synthesized: false,
        };
        let mut m = TranscriptModel::new();
        let deltas = m.apply_event(3, &with_attachment);
        assert!(matches!(deltas.as_slice(), [TranscriptDelta::Append(_)]));
        let prompt_row = row(&m, "user-seq-3");
        assert_eq!(prompt_row.kind, TranscriptRowKind::UserPrompt);
        assert_eq!(prompt_row.attachments[0].id, "att-1");

        for (prompt_id, want) in [
            (Some("cmp-abc"), "cmp-abc"),
            (None, "user-seq-7"),
            (Some(""), "user-seq-7"),
        ] {
            let mut m = TranscriptModel::new();
            m.apply_event(
                7,
                &Event::UserPromptSent {
                    text: "hi".into(),
                    attachments: Vec::new(),
                    prompt_id: prompt_id.map(Into::into),
                    synthesized: false,
                },
            );
            assert_eq!(m.rows()[0].id, want, "prompt_id={prompt_id:?}");
        }

        let m = fold([Event::UserDiffCommentsPrompt {
            intro: "look".into(),
            outro: "thanks".into(),
            is_multi_repo: true,
            comments: Vec::new(),
            assembled_markdown: "# body".into(),
        }]);
        let diff_row = row(&m, "user-seq-1");
        assert_eq!(
            (diff_row.kind, diff_row.text.as_str()),
            (TranscriptRowKind::UserDiffComments, "# body")
        );
        let payload = diff_row.diff_comments.as_ref().expect("payload");
        assert!(payload.is_multi_repo && payload.intro == "look");

        // A synthesized resume prompt (#3028, #4040) renders no row but still
        // opens the turn.
        let ev = Event::UserPromptSent {
            text: "run the nightly task".into(),
            attachments: Vec::new(),
            prompt_id: None,
            synthesized: true,
        };
        let mut m = TranscriptModel::new();
        let deltas = m.apply_event(1, &ev);
        assert!(deltas.is_empty());
        assert!(m.rows().is_empty());
        assert!(m.turn_active);
        assert!(!m.turn_has_output);
    }

    #[test]
    fn adjacent_stream_chunks_patch_one_stable_row_until_broken() {
        let mut m = TranscriptModel::new();
        let first = m.apply_event(1, &chunk("Hello"));
        let second = m.apply_event(2, &chunk(", world"));
        let thought = m.apply_event(
            3,
            &Event::AgentThoughtChunk {
                text: "checking".into(),
            },
        );
        let thought_tail = m.apply_event(
            4,
            &Event::AgentThoughtChunk {
                text: " this".into(),
            },
        );
        let third = m.apply_event(5, &chunk("second"));

        assert!(matches!(first.as_slice(), [TranscriptDelta::Append(_)]));
        assert!(matches!(
            second.as_slice(),
            [TranscriptDelta::Patch { id, .. }] if id == "msg-1"
        ));
        assert!(matches!(thought.as_slice(), [TranscriptDelta::Append(_)]));
        assert!(matches!(
            thought_tail.as_slice(),
            [TranscriptDelta::Patch { id, .. }] if id == "thinking-3"
        ));
        assert!(matches!(third.as_slice(), [TranscriptDelta::Append(_)]));
        assert_eq!(m.rows().len(), 3);
        assert_eq!(m.rows()[0].text, "Hello, world");
        assert_eq!(m.rows()[1].text, "checking this");
        assert_eq!(m.rows()[2].text, "second");
    }

    #[test]
    fn tool_rows_pick_their_text_stay_unique_and_synthesize_late_starts() {
        let m = fold([
            started(tool("t-1", "Bash")),
            completed("t-1", false, "abc\ndef\n"),
        ]);
        assert_eq!(
            kinds(&m),
            [
                TranscriptRowKind::ToolStart,
                TranscriptRowKind::ToolComplete
            ]
        );
        assert_eq!(tool_of(&m, "start-t-1").name, "Bash");
        assert_eq!(row(&m, "done-t-1").text, "abc\ndef\n");
        assert_eq!(row(&m, "start-t-1").group_id, row(&m, "done-t-1").group_id);

        // (buffered stream, completion content, error, text, kind)
        let cases = [
            (
                Some("streamed"),
                "final",
                false,
                "final",
                TranscriptRowKind::ToolComplete,
            ),
            (
                Some("line1\n"),
                "",
                false,
                "line1\n",
                TranscriptRowKind::ToolComplete,
            ),
            (
                None,
                "",
                false,
                "completed",
                TranscriptRowKind::ToolComplete,
            ),
            (None, "", true, "tool failed", TranscriptRowKind::ToolError),
        ];
        for (i, (buffered, text, is_error, want_text, want_kind)) in cases.into_iter().enumerate() {
            let mut events = vec![started(tool("t", "Bash"))];
            events.extend(buffered.map(|b| content("t", b)));
            events.push(completed("t", is_error, text));
            let m = fold(events);
            let done = row(&m, "done-t");
            assert_eq!(
                (done.text.as_str(), done.kind),
                (want_text, want_kind),
                "case {i}"
            );
            assert!(
                !m.tool_outputs.contains_key("t"),
                "case {i}: buffer drained"
            );
        }

        let m = fold([
            started(tool("t", "Bash")),
            completed("t", false, "first"),
            completed("t", false, "second"),
        ]);
        assert_eq!(
            row(&m, "done-t-3").text,
            "second",
            "a reused id is seq-disambiguated"
        );
        assert_eq!(count(&m, TranscriptRowKind::ToolComplete), 2);

        let mut m = fold([started(tool("task-1", "Task"))]);
        assert!(
            m.apply_event(2, &content("task-1", "streaming")).is_empty(),
            "buffering emits nothing"
        );
        m.apply_event(
            3,
            &Event::ToolCallCompleted {
                tool_call_id: "task-1".into(),
                is_error: false,
                content: "Async agent launched successfully".into(),
                output: Vec::new(),
                completed_at: at(200),
                async_subagent: true,
            },
        );
        assert!(row(&m, "done-task-1").async_subagent);

        // Late frames synthesize a tool start.
        let m = fold([completed("orphan-1", false, "done output")]);
        assert_eq!(
            kinds(&m),
            [
                TranscriptRowKind::ToolStart,
                TranscriptRowKind::ToolComplete
            ]
        );
        assert_eq!(tool_of(&m, "start-orphan-1").name, "tool call");
        assert!(
            m.turn_has_output,
            "a synthesized card counts as turn output"
        );

        let m = fold([updated(
            "orphan-2",
            Some("run_shell_command"),
            Some(r#"{"command":"ls"}"#),
            None,
        )]);
        let synth = tool_of(&m, "start-orphan-2");
        assert_eq!(
            (synth.name.as_str(), synth.args_preview.as_str()),
            ("run_shell_command", r#"{"command":"ls"}"#)
        );
        assert_eq!(synth.kind, "other");
    }

    #[test]
    fn repeated_starts_and_updates_merge_without_losing_richer_fields() {
        let diff = |path: &str| DiffPreview {
            path: path.into(),
            old_text: None,
            new_text: Some("x".into()),
            created_at: at(100),
        };
        let mut m = fold([
            started(ToolCall {
                args_preview: r#"{"x":1}"#.into(),
                started_at: at(110),
                diffs: vec![diff("a.rs")],
                ..tool("dup", "Bash")
            }),
            started(tool("other", "Other")),
        ]);
        let deltas = m.apply_event(
            3,
            &started(ToolCall {
                kind: "other".into(),
                args_preview: "".into(),
                started_at: at(105),
                parent_tool_call_id: Some("parent-9".into()),
                memory_recall: Some(MemoryRecall {
                    mode: "recall".into(),
                    paths: vec!["/a".into()],
                    synthesized_text: None,
                }),
                ..tool("dup", "Bash")
            }),
        );
        assert!(
            matches!(deltas.as_slice(), [TranscriptDelta::Patch { id, .. }] if id == "start-dup")
        );
        assert_eq!(count(&m, TranscriptRowKind::ToolStart), 2);
        let merged = tool_of(&m, "start-dup");
        assert_eq!(merged.args_preview, r#"{"x":1}"#, "richer args survive");
        assert_eq!(
            merged.kind, "execute",
            "richer kind survives a sparse 'other'"
        );
        assert_eq!(merged.started_at, at(110), "the later started_at wins");
        assert_eq!(merged.parent_tool_call_id.as_deref(), Some("parent-9"));
        assert_eq!(merged.memory_recall.as_ref().unwrap().mode, "recall");

        let deltas = m.apply_event(
            4,
            &updated(
                "dup",
                Some("Edit a.rs"),
                Some(r#"{"command":"git log"}"#),
                None,
            ),
        );
        assert!(
            matches!(deltas.as_slice(), [TranscriptDelta::Patch { id, .. }] if id == "start-dup")
        );
        assert_eq!(row(&m, "start-dup").text, "Edit a.rs");
        assert_eq!(
            tool_of(&m, "start-dup").diffs,
            [diff("a.rs")],
            "no diffs keeps the old ones"
        );
        assert_eq!(
            tool_of(&m, "start-other").args_preview,
            "{}",
            "other rows untouched"
        );
        m.apply_event(5, &updated("dup", None, None, Some(vec![diff("b.rs")])));
        assert_eq!(
            tool_of(&m, "start-dup").diffs,
            [diff("b.rs")],
            "diffs replace wholesale"
        );
        assert_eq!(tool_of(&m, "start-dup").name, "Edit a.rs");
    }

    #[test]
    fn ask_user_question_cards_are_suppressed_in_either_order() {
        let mut m = fold([started(tool("tc-ask", "Asking"))]);
        let deltas = m.apply_event(2, &elicitation_requested("tc-ask"));
        assert!(matches!(deltas.as_slice(), [TranscriptDelta::Remove(id)] if id == "start-tc-ask"));
        assert!(m
            .apply_event(3, &completed("tc-ask", false, "x"))
            .is_empty());
        assert!(m.rows().is_empty());

        let mut m = fold([elicitation_requested("tc-ask")]);
        assert!(m
            .apply_event(2, &started(tool("tc-ask", "Asking")))
            .is_empty());
        assert!(m.rows().is_empty());

        let answer = |nonce: &str, answers: Vec<ElicitationAnswer>| Event::ElicitationResolved {
            nonce: Nonce(nonce.into()),
            outcome: ElicitationOutcome::Accepted,
            answers,
        };
        let yes = || {
            vec![ElicitationAnswer {
                question: "Proceed?".into(),
                answer: "Yes".into(),
            }]
        };
        let mut m = fold([answer("el-1", yes())]);
        let answered = row(&m, "elicitation-el-1");
        assert_eq!(
            (answered.kind, answered.text.as_str()),
            (TranscriptRowKind::ElicitationAnswered, "Proceed?: Yes")
        );
        assert_eq!(answered.elicitation_answers.len(), 1);
        assert!(
            m.apply_event(2, &answer("el-1", yes())).is_empty(),
            "re-broadcast deduped"
        );
        assert!(
            m.apply_event(3, &answer("el-2", Vec::new())).is_empty(),
            "no answers, no row"
        );
    }

    #[test]
    fn turn_endings_sweep_open_tools_once() {
        let m = fold([
            prompt("run"),
            started(tool("open-1", "LongTask")),
            content("open-1", "partial out"),
            stopped("prompt_complete"),
        ]);
        let swept = row(&m, "stopped-open-1-4");
        assert_eq!(
            (swept.kind, swept.text.as_str()),
            (TranscriptRowKind::ToolStopped, "partial out")
        );
        assert!(!m.tool_outputs.contains_key("open-1"));

        let mut m = fold([
            started(tool("a", "A")),
            started(tool("b", "B")),
            completed("a", false, ""),
            stopped("user_stopped"),
        ]);
        m.apply_event(10, &stopped("prompt_complete"));
        let swept: Vec<&str> = m
            .rows()
            .iter()
            .filter(|r| r.kind == TranscriptRowKind::ToolStopped)
            .filter_map(|r| r.tool_call_id.as_deref())
            .collect();
        assert_eq!(swept, ["b"], "only the open tool is swept, and only once");

        let closers = [
            stopped("cancelled"),
            Event::AgentStartupError {
                message: "boom".into(),
            },
            Event::IncompatibleAgent {
                detail: crate::acp::state::StartupErrorDetail::UnsupportedProtocolVersion {
                    expected: "1".into(),
                    received: "2".into(),
                },
            },
            Event::AgentSwitched {
                from: "claude".into(),
                to: "codex".into(),
                reason: "rate_limit".into(),
            },
        ];
        for closer in closers {
            let label = format!("{closer:?}");
            let m = fold([started(tool("t1", "T")), closer]);
            assert_eq!(count(&m, TranscriptRowKind::ToolStopped), 1, "{label}");
        }
    }

    #[test]
    fn empty_output_notice_needs_an_output_less_unsteered_turn() {
        let caps = Event::PromptCapabilities {
            image: false,
            audio: false,
            embedded_context: false,
            load_session: None,
            steering: true,
        };
        let runtime_error = Event::PromptRuntimeError {
            message: "boom".into(),
        };
        // (events between the prompt and its stop, notice expected)
        let cases = [
            (vec![], true),
            (vec![chunk("hi")], false),
            (vec![Event::ThinkingStarted], false),
            (vec![runtime_error], false),
        ];
        for (i, (mid, notice)) in cases.into_iter().enumerate() {
            let mut events = vec![prompt("/usage")];
            events.extend(mid);
            events.push(stopped("prompt_complete"));
            assert_eq!(
                count(&fold(events), TranscriptRowKind::EmptyOutput) == 1,
                notice,
                "case {i}"
            );
        }

        let m = fold([
            caps,
            prompt("read src/acp"),
            chunk("on it"),
            prompt("just acp_client.rs"),
            stopped("prompt_complete"),
        ]);
        assert_eq!(
            count(&m, TranscriptRowKind::EmptyOutput),
            0,
            "a steered prompt keeps the turn's output"
        );
        assert_eq!(count(&m, TranscriptRowKind::UserPrompt), 2);
    }
}
