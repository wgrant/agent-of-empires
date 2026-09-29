//! Listing, recent projects, and workspace ordering endpoints.

use std::collections::HashSet;
use std::path::Path;

use super::*;

#[derive(serde::Serialize)]
pub struct RecentProjectsResponse {
    pub projects: Vec<crate::session::RecentProjectEntry>,
}

/// Persisted recent projects for the new-session wizard, newest first.
/// Read-time pruning drops entries whose directory no longer exists, leaving
/// the stored file untouched, so a GET stays side-effect free.
pub async fn get_recent_projects() -> Json<RecentProjectsResponse> {
    let projects = crate::session::load_recent_projects()
        .unwrap_or_else(|e| {
            tracing::warn!(target: "http.api.sessions", "failed to load recent projects: {e}");
            Vec::new()
        })
        .into_iter()
        .filter(|p| std::path::Path::new(&p.path).is_dir())
        .collect();
    Json(RecentProjectsResponse { projects })
}

pub async fn list_sessions(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<ListSessionsQuery>,
) -> Json<SessionsEnvelope> {
    // The registry is released before any per-row I/O: a writer queued
    // behind this read would stall every later reader, including each ACP
    // connect, for as long as the listing runs.
    let rows: Vec<Instance> = state
        .instances
        .read()
        .await
        .iter()
        // CityHall only creates structured sessions, so a plain session from
        // the TUI or another client must not be visible or actionable to a
        // locked-down client. The lifecycle routes apply the matching gate (#7).
        .filter(|inst| !state.cityhall_mode || inst.is_structured())
        .filter(|inst| crate::session::SessionScope::matches(query.state, inst))
        .cloned()
        .collect();
    // Snapshot the supervisor's worker lifecycle map once per request
    // rather than locking it per row. See #1088.
    let worker_states = state.acp_supervisor.worker_states_snapshot().await;
    // Config files, SQLite and git are all blocking I/O.
    match tokio::task::spawn_blocking(move || list_rows(&state, &rows, &worker_states)).await {
        Ok(envelope) => Json(envelope),
        Err(e) => std::panic::resume_unwind(e.into_panic()),
    }
}

/// The listing of `rows`, which is parallel to the `sessions` it returns.
fn list_rows(
    state: &AppState,
    rows: &[Instance],
    worker_states: &HashMap<String, crate::daemon::AcpWorkerState>,
) -> SessionsEnvelope {
    let claude_fullscreen = crate::claude_settings::read_tui_fullscreen();
    let resolved_before = state.resolved_config.resolutions();
    let configs: Vec<_> = rows
        .iter()
        .map(|inst| {
            state
                .resolved_config
                .with_repo(&inst.source_profile, Path::new(&inst.project_path))
        })
        .collect();

    let mut sessions: Vec<SessionResponse> = rows
        .iter()
        .map(|inst| {
            let plan_summary = if inst.is_structured() {
                state
                    .acp_event_store
                    .latest_plan(&inst.id)
                    .map(plan_summary_from_plan)
            } else {
                None
            };
            // An archived session is sunk, so its wakeup/monitor badge is
            // meaningless and the per-poll SQLite lookups are skipped.
            // latest_plan stays ungated: a collapsed archived row may still
            // show a plan summary.
            let structured_live = inst.is_structured() && !inst.is_archived() && !inst.is_trashed();
            let (next_wakeup_at, next_wakeup_reason) = if structured_live {
                match state.acp_event_store.latest_pending_wakeup(&inst.id) {
                    Some((at, reason)) => (Some(at.to_rfc3339()), reason),
                    None => (None, None),
                }
            } else {
                (None, None)
            };
            let active_monitor = if structured_live {
                state.acp_event_store.latest_active_monitor(&inst.id)
            } else {
                None
            };
            let acp_worker_state = worker_states
                .get(&inst.id)
                .copied()
                .unwrap_or(crate::daemon::AcpWorkerState::Absent);
            let mut session = SessionResponse::from_instance_with_plan(
                inst,
                claude_fullscreen,
                plan_summary,
                acp_worker_state,
                next_wakeup_at,
                next_wakeup_reason,
                active_monitor,
            );
            if structured_live && acp_worker_state == crate::daemon::AcpWorkerState::Running {
                // Gate on a live worker: a pending nonce only exists on a
                // running worker, and spawn/attach sweep orphaned nonces out of
                // the durable log, so projecting a non-running row would surface
                // a phantom approval the resolver can only 404 on.
                session.pending_approvals = state
                    .acp_event_store
                    .pending_approval_requests(&inst.id)
                    .into_iter()
                    .map(|approval| PendingApproval {
                        nonce: approval.nonce.0,
                        target: crate::acp::approvals::summarize_target(
                            &approval.tool_call.kind,
                            &approval.tool_call.args_preview,
                        ),
                        tool_name: approval.tool_call.name,
                        destructive: approval.destructive,
                        choice: approval.choice,
                    })
                    .collect();
                session.background =
                    state
                        .acp_event_store
                        .background_activity(&inst.id)
                        .map(|activity| crate::daemon::BackgroundSummary {
                            running: activity.running,
                            reporting: activity.reporting,
                            last_active_at: activity.last_active_at.map(|at| at.to_rfc3339()),
                        });
            }
            // A live worker is never parked, so only workerless sessions pay
            // for the probe.
            if structured_live {
                session.rate_limit = (acp_worker_state != crate::daemon::AcpWorkerState::Running)
                    .then(|| {
                        state.acp_event_store.rate_limit_park(&inst.id).map(|park| {
                            park.info
                                .unwrap_or_else(crate::acp::state::RateLimitInfo::undated)
                        })
                    })
                    .flatten();
            }
            session
        })
        .collect();

    let mut project_override_cache = ProjectRegistryCache::new();
    let inflight: HashSet<String> = state
        .smart_rename_inflight
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    let attempted: HashSet<String> = state
        .smart_rename_attempted
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    for ((resp, inst), cfg) in sessions.iter_mut().zip(rows).zip(&configs) {
        // Built-in agents' ACP capability was resolved in the constructor.
        if !resp.acp_capable {
            resp.acp_capable = custom_agent_acp_capable(&cfg.session, &inst.tool);
        }

        let profile_cfg = state.resolved_config.profile(&resp.profile);
        resp.cleanup_defaults = CleanupDefaults {
            delete_worktree: profile_cfg.worktree.auto_cleanup,
            delete_branch: profile_cfg.worktree.should_delete_branch_on_cleanup(),
            delete_sandbox: profile_cfg.sandbox.auto_cleanup,
            delete_to_trash: profile_cfg.session.delete_to_trash,
        };
        // Lets the sidebar collapse the standalone workdir action (#1927).
        if resp.has_managed_worktree {
            resp.tie_workdir_to_name = profile_cfg.session.tie_workdir_to_name;
        }
        if inst.is_structured() && !inst.is_archived() && !inst.is_trashed() {
            resp.rate_limit_auto_resume = Some(
                state
                    .resolved_config
                    .profile(&inst.source_profile)
                    .acp
                    .rate_limit_auto_resume,
            );
        }

        // The smart-rename indicator: `Running` from the live in-flight set,
        // `Pending` from the shared eligibility predicate, so it cannot drift
        // from the runtime gate.
        use crate::session::smart_rename::{
            check_eligible_resolved, resolve_smart_rename_config, SmartRenameState,
        };
        resp.default_name = crate::session::civilizations::is_default_civ_name(&inst.title);
        if inflight.contains(&inst.id) {
            resp.smart_rename = SmartRenameState::Running;
            continue;
        }
        // A session whose one-shot already ran, and failed since the name
        // is still default, will not retry, so it is not pending either.
        if attempted.contains(&inst.id) {
            continue;
        }
        let smart_rename_override = project_override_cache.smart_rename_override(
            &inst.source_profile,
            inst.scratch,
            inst.repo_path(),
            &cfg.session,
        );
        let rename = resolve_smart_rename_config(&cfg.session, smart_rename_override);
        let eligible = check_eligible_resolved(
            inst.is_structured(),
            rename.setting_on,
            false,
            &inst.title,
            &inst.tool,
            rename.rename_agent,
            inst.is_sandboxed(),
            &inst.command,
            rename.overrides,
        )
        .is_ok();
        if eligible {
            resp.smart_rename = SmartRenameState::Pending;
        }
    }

    let resolved = state.resolved_config.resolutions();
    tracing::debug!(
        target: "http.api.sessions",
        rows = sessions.len(),
        profile_resolutions = resolved.profiles - resolved_before.profiles,
        repo_resolutions = resolved.repos - resolved_before.repos,
        "list_sessions resolved config"
    );

    fill_remote_owners(state, &mut sessions);

    let workspace_ordering =
        merge_workspace_ordering(&sessions, state.read_only).unwrap_or_else(|e| {
            tracing::error!(target: "http.api.sessions", "Failed to merge workspace ordering: {e}");
            Vec::new()
        });

    SessionsEnvelope {
        sessions,
        workspace_ordering,
    }
}

/// Each session's remote owner, from a cache that lasts the process.
fn fill_remote_owners(state: &AppState, sessions: &mut [SessionResponse]) {
    let repo_of = |s: &SessionResponse| {
        s.main_repo_path
            .clone()
            .unwrap_or_else(|| s.project_path.clone())
    };
    let uncached: HashSet<String> = {
        let cache = state.remote_owner_cache.blocking_read();
        sessions
            .iter()
            .map(repo_of)
            .filter(|path| !cache.contains_key(path))
            .collect()
    };
    // Resolved before taking the write lock, so readers are not held behind git.
    let resolved: Vec<_> = uncached
        .into_iter()
        .map(|path| {
            let owner = crate::git::get_remote_owner_with_key(Path::new(&path));
            (path, owner)
        })
        .collect();
    let mut cache = state.remote_owner_cache.blocking_write();
    cache.extend(resolved);
    for session in sessions {
        if let Some(Some((owner, key))) = cache.get(&repo_of(session)) {
            session.remote_owner = Some(owner.clone());
            session.remote_owner_key = Some(key.clone());
        }
    }
}

// Workspace id derivation, mirroring `useWorkspaces.ts`: a session with a
// branch collapses to `${repoPath}::${branch}`, a branchless one gets
// `${repoPath}::__session__::${id}`. `repoPath` strips trailing slashes so
// server and client compute the same string.
fn workspace_id_for_session(s: &SessionResponse) -> String {
    let raw = s.main_repo_path.as_deref().unwrap_or(&s.project_path);
    let repo_path = raw.trim_end_matches('/');
    match &s.branch {
        Some(branch) => format!("{repo_path}::{branch}"),
        None => format!("{repo_path}::__session__::{}", s.id),
    }
}

// Merge newly observed workspace ids on top of the existing ordering,
// deduplicating and putting unknowns first (newest-first). Done server-side so
// concurrent clients converge without each racing to PUT its own prepend. In
// read-only mode the merge is still computed for the response but not written.
// Extracted so it runs from both the read-only path and the locked closure,
// where it operates on `ord.order` directly rather than a pre-lock snapshot.
fn compute_merged_ordering(sessions: &[SessionResponse], current_order: &[String]) -> Vec<String> {
    let known: std::collections::HashSet<&str> = current_order.iter().map(String::as_str).collect();
    let mut seen_unknown: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut new_ids: Vec<String> = Vec::new();
    for s in sessions {
        let id = workspace_id_for_session(s);
        if known.contains(id.as_str()) {
            continue;
        }
        if seen_unknown.insert(id.clone()) {
            new_ids.push(id);
        }
    }
    if new_ids.is_empty() {
        return current_order.to_vec();
    }
    new_ids.reverse();
    new_ids.extend_from_slice(current_order);
    new_ids
}

fn merge_workspace_ordering(
    sessions: &[SessionResponse],
    read_only: bool,
) -> anyhow::Result<Vec<String>> {
    if read_only {
        let current = crate::session::load_workspace_ordering()
            .map(|w| w.order)
            .unwrap_or_default();
        return Ok(compute_merged_ordering(sessions, &current));
    }
    crate::session::update_workspace_ordering(|ord| {
        let merged = compute_merged_ordering(sessions, &ord.order);
        ord.order = merged.clone();
        Ok(merged)
    })
}

// `PUT /api/workspace-ordering` overwrites the persisted workspace order with a
// client-supplied list. Workspaces are a client construct, so the entries are
// opaque strings. New workspaces are folded in by `merge_workspace_ordering` on
// every `GET /api/sessions`, so this PUT only reorders existing entries.
// Persisted globally, not per-profile, because the sidebar spans profiles (#1169).
//

// Caps on the inbound body. Workspaces map 1:1 to sessions in the worst case,
// so 4096 is far above any realistic ceiling; the per-entry cap covers a long
// repo path plus a long branch name.
const MAX_ORDER_ENTRIES: usize = 4096;
const MAX_ORDER_ENTRY_LEN: usize = 1024;

#[derive(Deserialize)]
pub struct UpdateWorkspaceOrderingBody {
    pub order: Vec<String>,
}

pub async fn update_workspace_ordering(
    State(state): State<Arc<AppState>>,
    body: Result<Json<UpdateWorkspaceOrderingBody>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    if state.read_only {
        return crate::server::api::read_only_response();
    }
    let Json(body) = match body {
        Ok(b) => b,
        Err(rej) => return rej.into_response(),
    };

    if body.order.len() > MAX_ORDER_ENTRIES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({
                "message": format!("order has {} entries, max is {}", body.order.len(), MAX_ORDER_ENTRIES)
            })),
        )
            .into_response();
    }
    if let Some(bad) = body.order.iter().find(|e| e.len() > MAX_ORDER_ENTRY_LEN) {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({
                "message": format!("order entry is {} bytes, max is {}", bad.len(), MAX_ORDER_ENTRY_LEN)
            })),
        )
            .into_response();
    }

    let new_order = body.order;
    let result = crate::session::update_workspace_ordering(|ord| {
        ord.order = new_order.clone();
        Ok(())
    });
    if let Err(e) = result {
        tracing::error!(target: "http.api.sessions", "Failed to persist workspace ordering: {e}");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "message": "Failed to persist ordering" })),
        )
            .into_response();
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({ "order": new_order })),
    )
        .into_response()
}

#[cfg(test)]
mod context_resume_tests {
    use super::*;

    #[test]
    fn context_resume_projects_structured_and_terminal_states() {
        let mut structured = Instance::new("structured", "/tmp/structured");
        structured.view = crate::session::View::Structured;
        assert_eq!(
            context_resume_for(&structured),
            ContextResumeAvailability::Unavailable {
                reason: ContextResumeUnavailableReason::NoTarget,
            }
        );

        structured.acp_session_id = Some("opaque-server-target".to_string());
        assert_eq!(
            context_resume_for(&structured),
            ContextResumeAvailability::Indeterminate {
                reason: ContextResumeIndeterminateReason::AgentHandshakeRequired,
            }
        );

        structured.acp_load_session_capable = Some(false);
        assert_eq!(
            context_resume_for(&structured),
            ContextResumeAvailability::Unavailable {
                reason: ContextResumeUnavailableReason::AgentUnsupported,
            }
        );

        structured.acp_load_session_capable = Some(true);
        assert_eq!(
            context_resume_for(&structured),
            ContextResumeAvailability::Available
        );

        structured.fork_pending = Some("opaque-parent".to_string());
        assert_eq!(
            context_resume_for(&structured),
            ContextResumeAvailability::Unavailable {
                reason: ContextResumeUnavailableReason::ForkPending,
            }
        );

        let mut terminal = Instance::new("terminal", "/tmp/terminal");
        terminal.tool = "claude".to_string();
        terminal.agent_session_id = Some("terminal-context".to_string());
        assert_eq!(
            context_resume_for(&terminal),
            ContextResumeAvailability::Indeterminate {
                reason: ContextResumeIndeterminateReason::RuntimeCheckRequired,
            }
        );
    }
}

#[cfg(test)]
mod workspace_ordering_tests {
    use super::*;
    use crate::session::test_support::{isolate_app_dir_at, AppDirGuard};
    use serial_test::serial;
    use tempfile::tempdir;

    fn setup_test_home(temp: &std::path::Path) -> AppDirGuard {
        isolate_app_dir_at(temp)
    }

    fn mock_response(id: &str, project_path: &str, branch: Option<&str>) -> SessionResponse {
        SessionResponse {
            id: id.to_string(),
            title: id.to_string(),
            project_path: project_path.to_string(),
            artifact_dir: String::new(),
            group_path: String::new(),
            tool: "claude".to_string(),
            status: "Idle".to_string(),
            dormant: false,
            yolo_mode: false,
            created_at: "2025-01-01T00:00:00Z".to_string(),
            last_accessed_at: None,
            idle_entered_at: None,
            last_error: None,
            branch: branch.map(str::to_string),
            main_repo_path: None,
            base_branch: None,
            base_branch_override: None,
            is_sandboxed: false,
            scratch: false,
            has_managed_worktree: false,
            has_cleanable_worktree: false,
            tie_workdir_to_name: false,
            smart_rename: crate::session::smart_rename::SmartRenameState::Inactive,
            default_name: false,
            has_terminal: false,
            profile: "default".to_string(),
            cleanup_defaults: CleanupDefaults {
                delete_worktree: false,
                delete_branch: false,
                delete_sandbox: false,
                delete_to_trash: true,
            },
            trashed_at: None,
            retired_at: None,
            remote_owner: None,
            remote_owner_key: None,
            notify_on_waiting: None,
            notify_on_idle: None,
            notify_on_error: None,
            view: crate::session::View::Terminal,
            pending_approvals: Vec::new(),
            background: None,
            acp_worker_state: crate::daemon::AcpWorkerState::Absent,
            context_resume: Some(ContextResumeAvailability::Unavailable {
                reason: ContextResumeUnavailableReason::NoTarget,
            }),
            rate_limit: None,
            rate_limit_auto_resume: None,
            queued_prompts: Vec::new(),
            acp_capable: false,
            acp_session_id: None,
            acp_agent: None,
            acp_can_fork: false,
            keeps_context: false,
            clear_aliases: Vec::new(),
            claude_fullscreen: false,
            workspace_repos: Vec::new(),
            warnings: Vec::new(),
            plan_summary: None,
            next_wakeup_at: None,
            next_wakeup_reason: None,
            monitor_active: false,
            monitor_description: None,
            favorited: false,
            color: None,
            urgent: false,
            pinned_at: None,
            archived_at: None,
            snoozed_until: None,
            unread: false,
        }
    }

    #[test]
    fn workspace_id_keys_on_repo_and_branch() {
        let mut worktree = mock_response("s1", "/tmp/worktree", Some("main"));
        worktree.main_repo_path = Some("/tmp/repo".to_string());
        for (response, expected) in [
            (
                mock_response("s1", "/tmp/repo", Some("feature/x")),
                "/tmp/repo::feature/x",
            ),
            (
                mock_response("abc123", "/tmp/repo", None),
                "/tmp/repo::__session__::abc123",
            ),
            // Matches the client's `normalizePath`, which strips trailing slashes.
            (
                mock_response("s1", "/tmp/repo/", Some("main")),
                "/tmp/repo::main",
            ),
            (worktree, "/tmp/repo::main"),
        ] {
            assert_eq!(workspace_id_for_session(&response), expected);
        }
    }

    #[test]
    #[serial]
    fn merge_prepends_unseen_newest_first() -> anyhow::Result<()> {
        let temp = tempdir()?;
        let _guard = setup_test_home(temp.path());

        // Persisted ordering already contains `b`. Sessions arrive oldest
        // first as `[b, a, c]`; the unseen `a` and `c` land on top in
        // newest-first order.
        crate::session::update_workspace_ordering(|ord| {
            ord.order = vec!["/tmp/repo::b".to_string()];
            Ok(())
        })?;

        let sessions = vec![
            mock_response("sb", "/tmp/repo", Some("b")),
            mock_response("sa", "/tmp/repo", Some("a")),
            mock_response("sc", "/tmp/repo", Some("c")),
        ];

        let merged = merge_workspace_ordering(&sessions, /* read_only */ false)?;
        assert_eq!(
            merged,
            vec![
                "/tmp/repo::c".to_string(),
                "/tmp/repo::a".to_string(),
                "/tmp/repo::b".to_string(),
            ]
        );

        // And the merge was persisted.
        let on_disk = crate::session::load_workspace_ordering()?;
        assert_eq!(on_disk.order, merged);

        Ok(())
    }

    #[test]
    #[serial]
    fn merge_read_only_returns_merged_but_does_not_write() -> anyhow::Result<()> {
        let temp = tempdir()?;
        let _guard = setup_test_home(temp.path());

        // Empty starting state: a read-only request observes a new workspace,
        // so the response includes it but disk is untouched.
        let sessions = vec![mock_response("sa", "/tmp/repo", Some("a"))];

        let merged = merge_workspace_ordering(&sessions, /* read_only */ true)?;
        assert_eq!(merged, vec!["/tmp/repo::a".to_string()]);

        let on_disk = crate::session::load_workspace_ordering()?;
        assert!(on_disk.order.is_empty(), "read-only path must not persist");

        Ok(())
    }

    #[test]
    fn compute_merged_ordering_prepends_unknowns_newest_first_once() {
        let known = |id: &str, path: &str, branch: &str| mock_response(id, path, Some(branch));
        let existing = vec!["/repo/x::main".to_string(), "/repo/y::dev".to_string()];
        let cases = [
            (
                vec![
                    known("s1", "/repo/a", "main"),
                    known("s2", "/repo/b", "dev"),
                ],
                vec![],
                vec!["/repo/b::dev", "/repo/a::main"],
            ),
            (
                vec![
                    known("s1", "/repo/a", "main"),
                    known("s2", "/repo/a", "main"),
                    known("s3", "/repo/b", "dev"),
                ],
                vec![],
                vec!["/repo/b::dev", "/repo/a::main"],
            ),
            (
                vec![known("s1", "/repo/z", "feat")],
                existing.clone(),
                vec!["/repo/z::feat", "/repo/x::main", "/repo/y::dev"],
            ),
            (
                vec![
                    known("s1", "/repo/x", "main"),
                    known("s2", "/repo/y", "dev"),
                ],
                existing,
                vec!["/repo/x::main", "/repo/y::dev"],
            ),
        ];
        for (sessions, existing, expected) in cases {
            assert_eq!(compute_merged_ordering(&sessions, &existing), expected);
        }
    }
}
