//! Rich diff, file-contents, and volume-ignores preview endpoints.

use super::*;

// --- Rich Diff (per-file, merge-base aware) ---

#[derive(Serialize)]
pub struct RichDiffFileInfo {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    /// Workspace repo this file belongs to, `None` for single-repo sessions.
    /// The frontend groups the sidebar list by it and uses it to disambiguate
    /// path collisions across repos (#1047).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_name: Option<String>,
}

#[derive(Serialize)]
pub struct RepoBase {
    /// None for single-repo sessions; Some for each workspace member.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_name: Option<String>,
    pub base_branch: String,
    /// Worktree path this entry's diff was computed in. The web base picker
    /// queries it so a workspace member's typeahead lists its own branches
    /// rather than the launch repo's (#3329).
    pub repo_path: String,
    /// This entry's explicit override, when set. Absent means `base_branch`
    /// came from the creation base, the profile default, or auto-detection, so
    /// the client hides its reset affordance (#3329).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_override: Option<String>,
    /// Set when this entry shows the commit range `base_branch...head`
    /// rather than the working tree.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    /// Why this entry's diff could not be computed, such as a ref that names
    /// no commit. Its files are then absent rather than silently empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What one repo's diff shows for a client instead of its default: another
/// base against the working tree, or with `head` the commit range
/// `base...head`, from their merge-base to head. Per request, never saved, so
/// each client can view its own and the saved base override is untouched.
#[derive(Debug, Default, Deserialize)]
pub struct DiffView {
    /// Workspace member name; omitted for a single-repo session.
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub head: Option<String>,
}

#[derive(Deserialize)]
pub struct DiffFilesQuery {
    /// A JSON array of [`DiffView`], one per repo shown other than by default.
    #[serde(default)]
    pub views: Option<String>,
}

/// Longest ref a view may name.
const MAX_VIEW_REF_LEN: usize = 256;

/// A view ref, trimmed, if it is one: git resolves it, never a shell, but a
/// control character or an outsized string is no ref and is refused.
fn view_ref(value: Option<&str>) -> Result<Option<String>, &'static str> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if value.len() > MAX_VIEW_REF_LEN || value.chars().any(char::is_control) {
        return Err("invalid ref in diff view");
    }
    Ok(Some(value.to_string()))
}

/// Parse and check a files request's views against the session's repos.
fn parse_views(raw: Option<&str>, repos: &[DiffRepo]) -> Result<Vec<DiffView>, &'static str> {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return Ok(Vec::new());
    };
    let views: Vec<DiffView> = serde_json::from_str(raw).map_err(|_| "malformed diff views")?;
    let mut seen = std::collections::HashSet::new();
    views
        .into_iter()
        .map(|view| {
            if !repos.iter().any(|r| r.name == view.repo) {
                return Err("diff view names a repo this session does not have");
            }
            if !seen.insert(view.repo.clone()) {
                return Err("two diff views name the same repo");
            }
            Ok(DiffView {
                repo: view.repo,
                base: view_ref(view.base.as_deref())?,
                head: view_ref(view.head.as_deref())?,
            })
        })
        .collect()
}

#[derive(Serialize)]
pub struct RichDiffFilesResponse {
    pub files: Vec<RichDiffFileInfo>,
    /// One entry per repo whose diff was computed: one element with
    /// `repo_name: None` for single-repo sessions, one per member for workspace
    /// sessions, since each member can have a different default (#1047).
    pub per_repo_bases: Vec<RepoBase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Contents-based diff response: raw old/new text that the web client parses
/// and renders itself via `@pierre/diffs`. See [`MAX_CONTENTS_BYTES`].
#[derive(Serialize)]
pub struct RichFileContentsResponse {
    pub file: RichDiffFileInfo,
    pub old_content: String,
    pub new_content: String,
    /// Server-computed unified diff of old to new. The client parses it as
    /// text rather than re-diffing, which would block the main thread on large
    /// files. Empty for binary files.
    pub patch: String,
    pub is_binary: bool,
    /// True if the file was too large to send inline; contents are omitted.
    pub truncated: bool,
    /// For a commit range, the commits it resolved to, so a comment made on it
    /// can tell later whether its lines still mean the same.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_commits: Option<RangeCommits>,
}

#[derive(Serialize)]
pub struct RangeCommits {
    pub head: String,
    /// The merge-base the range diffs from.
    pub from: String,
    /// Whether the worktree has `head` checked out, so edits there change it.
    pub head_checked_out: bool,
}

/// Caps for the contents-based diff endpoint. The client renders with a
/// virtualized, off-main-thread highlighter, so the real cost is JSON payload
/// size: the byte cap guards against pathological payloads and the line cap is
/// a backstop.
const MAX_CONTENTS_BYTES: usize = 5_000_000;
const MAX_CONTENTS_LINES: usize = 200_000;

/// Validate a user-supplied relative file path against a workdir.
///
/// Returns `(canonical_path, is_changed)` when the path is safe to read (not
/// absolute, no `..`, no symlink escape). `is_changed` marks a diffable path;
/// false marks an in-repo file with no diff against the base, served via the
/// full-file fallback (#1810).
///
/// A path neither in the changed set nor on disk yields `NOT_FOUND`. The
/// non-canonical fallback is reserved for the changed-set case, where a file
/// deleted in the working tree is still diffable.
pub(super) fn validate_diff_path(
    workdir: &std::path::Path,
    requested: &std::path::Path,
    changed_files: &[crate::git::diff::DiffFile],
) -> Result<(std::path::PathBuf, bool), (StatusCode, &'static str)> {
    relative_repo_path(requested).map_err(|msg| (StatusCode::BAD_REQUEST, msg))?;

    let is_changed = changed_files.iter().any(|f| f.path == requested);

    // Canonicalize both sides and verify containment, as defense in depth
    // against symlinks pointing outside the workdir.
    let canonical_workdir = workdir.canonicalize().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "workdir canonicalize failed",
        )
    })?;
    let full = canonical_workdir.join(requested);
    match full.canonicalize() {
        Ok(c) => {
            if !c.starts_with(&canonical_workdir) {
                return Err((StatusCode::BAD_REQUEST, "path escapes workdir"));
            }
            Ok((c, is_changed))
        }
        // Not on disk. A changed file may have been deleted in the working
        // tree but is still diffable, so fall back to the component-vetted
        // path; an unchanged path that is not on disk has nothing to show.
        Err(_) if is_changed => Ok((full, true)),
        Err(_) => Err((StatusCode::NOT_FOUND, "file not found")),
    }
}

/// One repo's worth of diff context: a name for workspace members, the path
/// the diff helper walks, and the two base-branch layers that vary per repo.
#[derive(Clone, Debug)]
pub(super) struct DiffRepo {
    /// Workspace member name, or None for single-repo sessions.
    pub(super) name: Option<String>,
    pub(super) path: String,
    /// Explicit override for this entry's diff base, set via
    /// `PATCH /api/sessions/{id}/diff-base`, `aoe session set-base`, or the TUI
    /// diff view's `b` keybind (#970, #3329).
    pub(super) base_override: Option<String>,
    /// The branch this entry's worktree was created from. Slots below the
    /// explicit override but above the profile default and auto-detection
    /// (#1951, #3329).
    pub(super) recorded_base: Option<String>,
}

struct DiffContext {
    repos: Vec<DiffRepo>,
}

/// Expand a session into the repos whose diffs the sidebar cares about:
/// one entry per `workspace_info.repos` member, or a one-element
/// `[project_path]` list for a single-repo session (#1047).
async fn resolve_diff_repos(
    state: &AppState,
    id: &str,
) -> Result<DiffContext, axum::response::Response> {
    let instances = state.instances.read().await;
    let inst = instances
        .iter()
        .find(|i| i.id == id)
        .ok_or_else(crate::server::api::session_not_found)?;
    Ok(DiffContext {
        repos: diff_repos_of(inst),
    })
}

/// Pick the repo a per-file request names. An omitted `?repo=` defaults to the
/// first member, matching the legacy single-repo URL contract. A named repo that
/// does not exist is rejected, so a stale link cannot quietly read the wrong one
/// (#1047).
fn select_diff_repo(
    ctx: DiffContext,
    repo: Option<&str>,
) -> Result<DiffRepo, axum::response::Response> {
    let selected = match repo {
        Some(name) => ctx
            .repos
            .into_iter()
            .find(|r| r.name.as_deref() == Some(name))
            .ok_or("unknown workspace repo"),
        // A workspace row can persist with `repos: []`.
        None => ctx.repos.into_iter().next().ok_or("workspace has no repos"),
    };
    selected.map_err(|msg| api_error(StatusCode::BAD_REQUEST, "bad_request", msg))
}

/// The repo entries for one session, split out of [`resolve_diff_repos`] so the
/// per-repo base plumbing is testable without an `AppState`.
pub(super) fn diff_repos_of(inst: &crate::session::Instance) -> Vec<DiffRepo> {
    // A session with any repo record lists one entry per repo; a session with
    // none falls back to its project_path.
    let mut repos: Vec<DiffRepo> = inst
        .all_repos()
        .iter()
        .map(|r| DiffRepo {
            name: Some(r.name.clone()),
            path: r.worktree_path.clone(),
            base_override: r.base_branch_override.clone(),
            recorded_base: r.base_branch.clone(),
        })
        .collect();
    if inst.workspace_info.is_none() {
        // A session with no repo records is single-repo, so the session-level
        // override is that entry's override. `attach_project` converts a session
        // into a workspace, so a named entry and this one never coexist (#3329).
        repos.insert(
            0,
            DiffRepo {
                name: None,
                path: inst.project_path.clone(),
                base_override: inst.base_branch_override.clone(),
                recorded_base: inst
                    .worktree_info
                    .as_ref()
                    .and_then(|w| w.base_branch.clone()),
            },
        );
    }
    repos
}

/// Resolve the diff base for one repo: the repo's own override, then the base
/// its worktree was recorded as forked from, then the profile's
/// `DiffConfig.default_branch`, then auto-detection. Every layer above the
/// config default is per repo (#970, #1951, #3329).
pub(super) fn resolve_diff_base(
    override_value: Option<&str>,
    recorded_base: Option<&str>,
    config_default: Option<&str>,
    repo_path: &std::path::Path,
) -> String {
    if let Some(v) = override_value.map(str::trim).filter(|v| !v.is_empty()) {
        return v.to_string();
    }
    if let Some(v) = recorded_base.map(str::trim).filter(|v| !v.is_empty()) {
        return v.to_string();
    }
    if let Some(v) = config_default.map(str::trim).filter(|v| !v.is_empty()) {
        return v.to_string();
    }
    crate::git::diff::get_default_base_ref(repo_path).unwrap_or_else(|_| "main".to_string())
}

pub async fn session_diff_files(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<DiffFilesQuery>,
) -> impl IntoResponse {
    if let Some(resp) = crate::server::api::cityhall_block(&state) {
        return resp;
    }
    let ctx = match resolve_diff_repos(&state, &id).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let views = match parse_views(query.views.as_deref(), &ctx.repos) {
        Ok(views) => views,
        Err(msg) => return api_error(StatusCode::BAD_REQUEST, "bad_request", msg),
    };

    let scan_state = state.clone();
    let result = tokio::task::spawn_blocking(move || {
        use crate::git::diff;

        let config_default = crate::session::Config::load_or_warn()
            .diff
            .default_branch
            .clone();
        let mut all_files: Vec<RichDiffFileInfo> = Vec::new();
        let mut per_repo_bases: Vec<RepoBase> = Vec::new();
        let mut warnings: Vec<String> = Vec::new();

        for repo in &ctx.repos {
            let path = std::path::Path::new(&repo.path);
            let view = views.iter().find(|v| v.repo == repo.name);
            let base_branch = match view.and_then(|v| v.base.clone()) {
                Some(base) => base,
                None => resolve_diff_base(
                    repo.base_override.as_deref(),
                    repo.recorded_base.as_deref(),
                    config_default.as_deref(),
                    path,
                ),
            };
            let head = view.and_then(|v| v.head.clone());
            let mut error = None;
            let (warning, changed) = match &head {
                None => (
                    diff::check_merge_base_status(path, &base_branch),
                    scan_state
                        .changed_files_cached(path, &base_branch)
                        .unwrap_or_default(),
                ),
                Some(head) => match scan_state.range_files_cached(path, &base_branch, head) {
                    Ok((resolved, files)) => (resolved.warning, files),
                    Err(e) => {
                        error = Some(e.to_string());
                        (None, Vec::new())
                    }
                },
            };

            for f in changed {
                all_files.push(RichDiffFileInfo {
                    path: f.path.to_string_lossy().to_string(),
                    old_path: f.old_path.map(|p| p.to_string_lossy().to_string()),
                    status: f.status.label().to_string(),
                    additions: f.additions,
                    deletions: f.deletions,
                    repo_name: repo.name.clone(),
                });
            }
            per_repo_bases.push(RepoBase {
                repo_name: repo.name.clone(),
                base_branch: base_branch.clone(),
                repo_path: repo.path.clone(),
                base_override: repo.base_override.clone(),
                head,
                error,
            });
            if let Some(w) = warning {
                match repo.name.as_deref() {
                    Some(n) => warnings.push(format!("{n}: {w}")),
                    None => warnings.push(w),
                }
            }
        }

        RichDiffFilesResponse {
            files: all_files,
            per_repo_bases,
            warning: if warnings.is_empty() {
                None
            } else {
                Some(warnings.join("\n"))
            },
        }
    })
    .await;

    match result {
        Ok(resp) => (
            StatusCode::OK,
            Json(serde_json::to_value(resp).expect("RichDiffFilesResponse is always serializable")),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(target: "http.api.sessions", "Diff files panicked: {}", e);
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Internal server error",
            )
        }
    }
}

#[derive(Deserialize)]
pub struct FileDiffQuery {
    pub path: String,
    /// Workspace repo name, omitted for single-repo sessions. A workspace
    /// session that omits it defaults to the first member, so the legacy
    /// single-repo URL keeps working (#1047).
    #[serde(default)]
    pub repo: Option<String>,
    /// The file's repo's [`DiffView`] base, if the client views another.
    #[serde(default)]
    pub base: Option<String>,
    /// With it, the file as the range `base...head` changes it.
    #[serde(default)]
    pub head: Option<String>,
}

/// Response for a rejected diff request (bad path, file not changed, etc.).
enum DiffFileError {
    BadRequest(&'static str),
    NotFound(&'static str),
    /// A view ref that names no commit, said so plainly for the pane.
    Unresolved(String),
    Internal(anyhow::Error),
}

impl From<crate::git::error::GitError> for DiffFileError {
    fn from(e: crate::git::error::GitError) -> Self {
        match e {
            crate::git::error::GitError::RevisionNotFound(_) => Self::Unresolved(e.to_string()),
            e => Self::Internal(e.into()),
        }
    }
}

/// A file's contents response, with the contents dropped past the size caps.
fn contents_response(
    file: RichDiffFileInfo,
    old_content: String,
    new_content: String,
    patch: String,
    is_binary: bool,
) -> serde_json::Value {
    let total_bytes = old_content.len() + new_content.len() + patch.len();
    let total_lines = old_content.lines().count() + new_content.lines().count();
    let resp = if total_bytes > MAX_CONTENTS_BYTES || total_lines > MAX_CONTENTS_LINES {
        RichFileContentsResponse {
            file,
            old_content: String::new(),
            new_content: String::new(),
            patch: String::new(),
            is_binary,
            truncated: true,
            range_commits: None,
        }
    } else {
        RichFileContentsResponse {
            file,
            old_content,
            new_content,
            patch,
            is_binary,
            truncated: false,
            range_commits: None,
        }
    };
    serde_json::to_value(resp).expect("RichFileContentsResponse is always serializable")
}

/// Refuse a path that is absolute or climbs out of the repo.
fn relative_repo_path(requested: &std::path::Path) -> Result<(), &'static str> {
    use std::path::Component;
    if requested.as_os_str().is_empty() {
        return Err("empty path");
    }
    if requested.is_absolute() {
        return Err("absolute path not allowed");
    }
    if requested.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("path escapes workdir");
    }
    Ok(())
}

/// One file as the range `base...head` changes it, or as `head` has it when
/// the range leaves it alone. Reads only git objects, never the worktree.
fn range_file_response(
    state: &AppState,
    repo_path: &std::path::Path,
    file_path: &std::path::Path,
    base: &str,
    head: &str,
    repo_name: Option<String>,
) -> Result<serde_json::Value, DiffFileError> {
    use crate::git::diff;
    relative_repo_path(file_path).map_err(DiffFileError::BadRequest)?;
    let (resolved, files) = state.range_files_cached(repo_path, base, head)?;
    let commits = serde_json::to_value(RangeCommits {
        head: resolved.range.head.to_string(),
        from: resolved.range.from.to_string(),
        head_checked_out: diff::is_checked_out(repo_path, resolved.range.head),
    })
    .expect("RangeCommits is always serializable");
    let with_commits = |mut value: serde_json::Value| {
        value["range_commits"] = commits.clone();
        value
    };
    let Some(changed) = files.iter().find(|f| f.path == file_path) else {
        let bytes = diff::file_at_commit(repo_path, resolved.range.head, file_path)?
            .ok_or(DiffFileError::NotFound("file not found"))?;
        let is_binary = bytes.contains(&0);
        let file = RichDiffFileInfo {
            path: file_path.to_string_lossy().into_owned(),
            old_path: None,
            status: "unchanged".to_string(),
            additions: 0,
            deletions: 0,
            repo_name,
        };
        let content = if is_binary {
            String::new()
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        };
        return Ok(with_commits(contents_response(
            file,
            String::new(),
            content,
            String::new(),
            is_binary,
        )));
    };
    let contents = diff::range_file_contents(repo_path, resolved.range, changed)?;
    let file = RichDiffFileInfo {
        path: contents.path.to_string_lossy().into_owned(),
        old_path: contents.old_path.map(|p| p.to_string_lossy().into_owned()),
        status: contents.status.label().to_string(),
        additions: changed.additions,
        deletions: changed.deletions,
        repo_name,
    };
    Ok(with_commits(contents_response(
        file,
        contents.old_content,
        contents.new_content,
        contents.patch,
        contents.is_binary,
    )))
}

pub async fn session_diff_file(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<FileDiffQuery>,
) -> impl IntoResponse {
    if let Some(resp) = crate::server::api::cityhall_block(&state) {
        return resp;
    }
    let selected_repo = match resolve_diff_repos(&state, &id)
        .await
        .and_then(|ctx| select_diff_repo(ctx, query.repo.as_deref()))
    {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let project_path = selected_repo.path;
    let selected_repo_name = selected_repo.name;
    let base_override = selected_repo.base_override;
    let recorded_base = selected_repo.recorded_base;
    let scan_state = state.clone();

    let result =
        tokio::task::spawn_blocking(move || -> Result<serde_json::Value, DiffFileError> {
            use crate::git::diff;

            let repo_path = std::path::Path::new(&project_path);
            let file_path = std::path::Path::new(&query.path);

            let config_default = crate::session::Config::load_or_warn()
                .diff
                .default_branch
                .clone();
            let base_branch =
                match view_ref(query.base.as_deref()).map_err(DiffFileError::BadRequest)? {
                    Some(base) => base,
                    None => resolve_diff_base(
                        base_override.as_deref(),
                        recorded_base.as_deref(),
                        config_default.as_deref(),
                        repo_path,
                    ),
                };
            if let Some(head) =
                view_ref(query.head.as_deref()).map_err(DiffFileError::BadRequest)?
            {
                return range_file_response(
                    &scan_state,
                    repo_path,
                    file_path,
                    &base_branch,
                    &head,
                    selected_repo_name,
                );
            }

            // Validate the requested path. Files in the changed set are diffed;
            // an in-repo file with no diff against the base is served through
            // the full-file fallback below. The path-traversal and containment
            // checks are the security boundary preventing arbitrary reads.
            // Scratch project directories use the full-file fallback below.
            let changed_files = match scan_state.changed_files_cached(repo_path, &base_branch) {
                Ok(files) => files,
                Err(e) if e.is_repository_not_found() => Vec::new(),
                Err(e) => return Err(DiffFileError::Internal(e.into())),
            };
            let (canonical_path, is_changed) =
                match validate_diff_path(repo_path, file_path, &changed_files) {
                    Ok(v) => v,
                    Err((status, msg)) => {
                        return Err(if status == StatusCode::NOT_FOUND {
                            DiffFileError::NotFound(msg)
                        } else {
                            DiffFileError::BadRequest(msg)
                        });
                    }
                };

            // Full-file fallback: an agent-cited file with no diff against the
            // base renders its current contents instead of a dead end (#1810).
            if !is_changed {
                let full =
                    diff::compute_unchanged_file_contents(repo_path, file_path, &canonical_path)
                        .map_err(|e| DiffFileError::Internal(e.into()))?
                        .ok_or(DiffFileError::NotFound("file not found"))?;
                let file = RichDiffFileInfo {
                    path: query.path.clone(),
                    old_path: None,
                    status: "unchanged".to_string(),
                    additions: 0,
                    deletions: 0,
                    repo_name: selected_repo_name.clone(),
                };
                return Ok(contents_response(
                    file,
                    String::new(),
                    full.content,
                    String::new(),
                    full.is_binary,
                ));
            }

            // Hand the client raw old/new text plus a server-computed unified
            // patch, which it renders virtualized and off-main-thread without
            // re-running the diff algorithm.
            let contents = diff::compute_file_contents(repo_path, file_path, &base_branch)
                .map_err(|e| DiffFileError::Internal(e.into()))?;
            // additions/deletions are not computed on this path; reuse the
            // counts the changed-files scan already produced.
            let (additions, deletions) = changed_files
                .iter()
                .find(|f| f.path == *file_path)
                .map(|f| (f.additions, f.deletions))
                .unwrap_or((0, 0));
            let file = RichDiffFileInfo {
                path: contents.path.to_string_lossy().to_string(),
                old_path: contents.old_path.map(|p| p.to_string_lossy().to_string()),
                status: contents.status.label().to_string(),
                additions,
                deletions,
                repo_name: selected_repo_name.clone(),
            };
            Ok(contents_response(
                file,
                contents.old_content,
                contents.new_content,
                contents.patch,
                contents.is_binary,
            ))
        })
        .await;

    match result {
        Ok(Ok(value)) => (StatusCode::OK, Json(value)).into_response(),
        Ok(Err(DiffFileError::BadRequest(msg))) => {
            api_error(StatusCode::BAD_REQUEST, "bad_request", msg)
        }
        Ok(Err(DiffFileError::NotFound(msg))) => api_error(StatusCode::NOT_FOUND, "not_found", msg),
        Ok(Err(DiffFileError::Unresolved(msg))) => {
            api_error(StatusCode::BAD_REQUEST, "unresolved_ref", &msg)
        }
        Ok(Err(DiffFileError::Internal(e))) => {
            tracing::error!(target: "http.api.sessions", "File diff failed: {}", e);
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "diff_failed",
                "Failed to compute file diff",
            )
        }
        Err(e) => {
            tracing::error!(target: "http.api.sessions", "File diff panicked: {}", e);
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Internal server error",
            )
        }
    }
}

/// Serve the current worktree bytes of a diffed file for the dashboard's
/// "Open file". The path is confined to the selected repo's worktree with the
/// session file reader's checks and no provenance fallback, so a file deleted
/// from the worktree is a 404.
pub async fn session_diff_file_raw(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<FileDiffQuery>,
) -> impl IntoResponse {
    if let Some(resp) = crate::server::api::cityhall_block(&state) {
        return resp;
    }
    let repo = match resolve_diff_repos(&state, &id)
        .await
        .and_then(|ctx| select_diff_repo(ctx, query.repo.as_deref()))
    {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    let head = match view_ref(query.head.as_deref()) {
        Ok(head) => head,
        Err(msg) => return api_error(StatusCode::BAD_REQUEST, "bad_request", msg),
    };
    // A range shows the file as its head commit has it, not the worktree's.
    if let Some(head) = head {
        return serve_bytes(query.path, move |requested| {
            relative_repo_path(requested).map_err(|msg| (StatusCode::BAD_REQUEST, msg))?;
            crate::git::diff::file_at_revision(std::path::Path::new(&repo.path), &head, requested)
                .ok()
                .flatten()
                .ok_or((StatusCode::NOT_FOUND, "file not found"))
        })
        .await;
    }
    open_file(query.path, move |requested| {
        // Diff paths are repo-relative, and refusing the rest keeps this from
        // probing host paths outside the worktree.
        if requested.is_absolute() {
            return Err((StatusCode::BAD_REQUEST, "absolute path not allowed"));
        }
        let root = std::path::Path::new(&repo.path)
            .canonicalize()
            .map_err(|_| (StatusCode::NOT_FOUND, "file not found"))?;
        crate::server::api::file_provenance::confine_path(
            std::slice::from_ref(&root),
            std::collections::HashSet::new,
            requested,
        )
    })
    .await
}

/// Serve "Open file" off the async runtime: the path `confine` admits, typed by
/// the name it was requested under.
async fn open_file(
    requested: String,
    confine: impl FnOnce(
            &std::path::Path,
        )
            -> Result<crate::server::api::file_provenance::Confined, (StatusCode, &'static str)>
        + Send
        + 'static,
) -> axum::response::Response {
    serve_bytes(requested, move |requested| {
        let confined = confine(requested)?;
        crate::server::api::file_provenance::read_confined_bytes(
            &confined,
            super::artifacts::MAX_RAW_FILE_BYTES,
        )
    })
    .await
}

/// Serve the bytes `read` finds for `requested` off the async runtime, typed by
/// the name it was requested under.
async fn serve_bytes(
    requested: String,
    read: impl FnOnce(&std::path::Path) -> Result<Vec<u8>, (StatusCode, &'static str)> + Send + 'static,
) -> axum::response::Response {
    let result = tokio::task::spawn_blocking(move || {
        let requested = std::path::Path::new(&requested);
        let bytes = read(requested)?;
        Ok::<_, (StatusCode, &'static str)>((open_file_mime(requested, &bytes), bytes))
    })
    .await;

    match result {
        Ok(Ok((mime, bytes))) => {
            super::artifacts::raw_file_response(&mime, !renders_inline(&mime), "no-store", bytes)
        }
        Ok(Err((status, msg))) => (
            status,
            Json(serde_json::json!({"error": "file_read", "message": msg})),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(target: "http.api.sessions", "Raw file read panicked: {}", e);
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Internal server error",
            )
        }
    }
}

/// The type "Open file" serves a worktree file as. Text goes out as UTF-8 plain
/// text, since `mime_guess` misnames many source types (`.ts` is a video type)
/// and every browser shows plain text. A PDF can be plain ASCII yet still needs
/// the viewer, and a scriptable type keeps its type so it is downloaded.
fn open_file_mime(path: &std::path::Path, bytes: &[u8]) -> mime_guess::Mime {
    use mime_guess::mime;
    let guessed = mime_guess::from_path(path).first_or_octet_stream();
    let is_text = !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok();
    if is_text
        && guessed != mime::APPLICATION_PDF
        && !super::artifacts::is_scriptable(guessed.essence_str())
    {
        mime::TEXT_PLAIN_UTF_8
    } else {
        guessed
    }
}

/// Types a browser renders in a tab. Anything else is sent as an attachment,
/// which the dashboard saves under the file's own name.
fn renders_inline(ty: &mime_guess::Mime) -> bool {
    use mime_guess::mime;
    let top = ty.type_();
    top == mime::IMAGE
        || top == mime::AUDIO
        || top == mime::VIDEO
        || ty.essence_str() == "text/plain"
        || *ty == mime::APPLICATION_PDF
}

#[derive(Deserialize)]
pub struct SessionFileQuery {
    pub path: String,
}

/// Response for the session file-read endpoint, mirroring
/// [`RichFileContentsResponse`]. `content` is empty for a binary or truncated
/// file, and the client renders a notice.
#[derive(Serialize)]
pub struct SessionFileResponse {
    pub content: String,
    pub is_binary: bool,
    pub truncated: bool,
}

/// What a session file read may reach, gathered before the blocking read. It is
/// git-agnostic, so it works on non-git scratch sessions (#3088).
struct SessionFileScope {
    roots: Vec<std::path::PathBuf>,
    store: Arc<crate::acp::event_store::EventStore>,
    session_id: String,
}

impl SessionFileScope {
    async fn of(state: &AppState, id: &str) -> Result<Self, axum::response::Response> {
        let instances = state.instances.read().await;
        let inst = instances
            .iter()
            .find(|i| i.id == id)
            .ok_or_else(crate::server::api::session_not_found)?;
        // The session root comes first because relative paths resolve against
        // it: the Files pane lists them from there, and in a workspace it holds
        // every repo.
        let roots = std::iter::once(inst.project_path.as_str())
            .chain(inst.all_repos().iter().map(|r| r.worktree_path.as_str()))
            .map(std::path::PathBuf::from)
            .collect();
        Ok(Self {
            roots,
            store: state.acp_event_store.clone(),
            session_id: id.to_string(),
        })
    }

    /// Admit a path under a root or one the agent touched this session. Blocks.
    fn confine(
        &self,
        requested: &std::path::Path,
    ) -> Result<crate::server::api::file_provenance::Confined, (StatusCode, &'static str)> {
        // A root that no longer resolves is dropped, so a stale worktree cannot
        // break or widen confinement.
        let roots: Vec<std::path::PathBuf> = self
            .roots
            .iter()
            .filter_map(|p| p.canonicalize().ok())
            .collect();

        // Provenance fallback, deferred behind a closure so the whole session
        // log is only paged when the target is outside every project root.
        // ponytail: per-request scan on the miss path; cache per session keyed
        // on highest_seq if it shows up hot.
        let touched = || {
            let mut events = Vec::new();
            let mut since = 0u64;
            loop {
                let page = self.store.replay_page(&self.session_id, since, Some(1000));
                let advance = page.last_scanned_seq;
                events.extend(page.events.into_iter().map(|e| (e.seq, e.event)));
                match (page.has_more, advance) {
                    (true, Some(seq)) => since = seq,
                    _ => break,
                }
            }
            crate::server::api::file_provenance::collect_touched_paths(&events)
        };

        crate::server::api::file_provenance::confine_path(&roots, touched, requested)
    }
}

/// Read a session file for the dashboard file viewer.
pub async fn session_file(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<SessionFileQuery>,
) -> impl IntoResponse {
    // Reads workspace file contents, the same inspection surface as the diff
    // reads, and the Files pane is hidden in CityHall.
    if let Some(resp) = crate::server::api::cityhall_block(&state) {
        return resp;
    }
    let scope = match SessionFileScope::of(&state, &id).await {
        Ok(s) => s,
        Err(resp) => return resp,
    };

    let result = tokio::task::spawn_blocking(move || {
        let confined = scope.confine(std::path::Path::new(&query.path))?;
        let (content, is_binary, truncated) =
            crate::server::api::file_provenance::read_confined(&confined, MAX_CONTENTS_BYTES)?;
        Ok::<_, (StatusCode, &'static str)>(SessionFileResponse {
            content,
            is_binary,
            truncated,
        })
    })
    .await;

    match result {
        Ok(Ok(value)) => (StatusCode::OK, Json(value)).into_response(),
        Ok(Err((status, msg))) => (
            status,
            Json(serde_json::json!({"error": "file_read", "message": msg})),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(target: "http.api.sessions", "session_file panicked: {}", e);
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Internal server error",
            )
        }
    }
}

/// Serve a session file's raw bytes for the Files pane's "Open file", confined
/// like [`session_file`] and typed like [`session_diff_file_raw`].
pub async fn session_file_raw(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<SessionFileQuery>,
) -> impl IntoResponse {
    if let Some(resp) = crate::server::api::cityhall_block(&state) {
        return resp;
    }
    let scope = match SessionFileScope::of(&state, &id).await {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    open_file(query.path, move |requested| scope.confine(requested)).await
}

#[derive(Deserialize)]
pub struct VolumeIgnoresPreviewQuery {
    pub path: String,
    #[serde(default)]
    pub profile: Option<String>,
}

/// Serve a transcript-cited file only when its bytes are a passive raster
/// image. The path is an untrusted label, so the type comes from the content,
/// and SVG is refused because a same-origin blob of it can run script.
pub async fn session_file_image(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<SessionFileQuery>,
) -> impl IntoResponse {
    if let Some(resp) = crate::server::api::cityhall_block(&state) {
        return resp;
    }
    let scope = match SessionFileScope::of(&state, &id).await {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking(move || {
        let confined = scope.confine(std::path::Path::new(&query.path))?;
        let bytes = crate::server::api::file_provenance::read_confined_bytes(
            &confined,
            super::artifacts::MAX_RAW_FILE_BYTES,
        )?;
        let media_type = crate::server::api::file_provenance::raster_media_type(&bytes)
            .ok_or((StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported image type"))?;
        Ok::<_, (StatusCode, &'static str)>((bytes, media_type))
    })
    .await;

    match result {
        Ok(Ok((bytes, media_type))) => {
            use axum::http::{header, HeaderMap, HeaderValue};
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(media_type));
            headers.insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=60"),
            );
            (StatusCode::OK, headers, bytes).into_response()
        }
        Ok(Err((status, message))) => (
            status,
            Json(serde_json::json!({"error": "file_read", "message": message})),
        )
            .into_response(),
        Err(error) => {
            tracing::error!(target: "http.api.sessions", "session_file_image panicked: {error}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Serialize)]
pub struct VolumeIgnoresGlobPreview {
    pub pattern: String,
    pub matched_paths: Vec<String>,
}

#[derive(Serialize)]
pub struct VolumeIgnoresPreviewResponse {
    /// True once the user has acknowledged snapshot expansion, so the wizard
    /// can skip the confirm modal without another round trip.
    pub acknowledged: bool,
    /// One entry per glob `volume_ignores` pattern with the directories it
    /// currently matches (container-side paths). Empty when none are configured.
    pub globs: Vec<VolumeIgnoresGlobPreview>,
}

/// Dry-run how glob `volume_ignores` entries would expand for a session rooted
/// at `path`, creating nothing. The wizard calls it before a sandbox create to
/// decide whether to show the confirm modal (#2045). Read-only, so no
/// `read_only` guard; closed in CityHall, since it resolves repo config for a
/// caller-supplied host path.
pub async fn preview_volume_ignores_globs(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<VolumeIgnoresPreviewQuery>,
) -> impl IntoResponse {
    if let Some(resp) = crate::server::api::cityhall_block(&state) {
        return resp;
    }
    let result = tokio::task::spawn_blocking(move || {
        let profile = query.profile.unwrap_or_default();
        let config = crate::session::config::repo_config::resolve_config_with_repo(
            &profile,
            std::path::Path::new(&query.path),
        )?;
        let expansions = crate::session::config::container_config::preview_glob_volume_ignores(
            &query.path,
            None,
            &config.sandbox.volume_ignores,
        )?;
        let acknowledged = crate::session::Config::load()
            .map(|c| c.app_state.has_acknowledged_volume_ignores_globs)
            .unwrap_or(false);
        Ok::<_, anyhow::Error>((acknowledged, expansions))
    })
    .await;

    match result {
        Ok(Ok((acknowledged, expansions))) => {
            let globs = expansions
                .into_iter()
                .map(|e| VolumeIgnoresGlobPreview {
                    pattern: e.pattern,
                    matched_paths: e.matched_container_paths,
                })
                .collect();
            (
                StatusCode::OK,
                Json(VolumeIgnoresPreviewResponse {
                    acknowledged,
                    globs,
                }),
            )
                .into_response()
        }
        Ok(Err(e)) => {
            tracing::warn!(target: "http.api.sessions", "volume_ignores glob preview failed: {}", e);
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "preview_failed",
                "Failed to preview volume_ignores",
            )
        }
        Err(e) => {
            tracing::error!(target: "http.api.sessions", "volume_ignores glob preview panicked: {}", e);
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Internal server error",
            )
        }
    }
}
