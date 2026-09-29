//! Retiring an archived session: its worktree directory and sandbox container
//! are removed to free the disk, while its branch, transcript and agent stores
//! stay. A retired session remains archived and cannot start again.

use std::path::{Path, PathBuf};

use super::deletion::{is_protected_default_branch, with_paths_in_use_locked};
use super::{Instance, Storage};
use crate::containers::{DockerContainer, Teardown};
use crate::git::cleanup::{
    cleanup_sandbox_worktree, remove_managed_worktree, stashes_on_branch, try_list_dirty_files,
};
use crate::git::GitWorktree;

#[derive(Debug, thiserror::Error)]
pub enum RetireError {
    #[error("session not found")]
    NotFound,
    /// The session is not in a state to retire, or retiring would lose work.
    #[error("{0}")]
    Refused(String),
    /// Removal was attempted and failed; the session is not retired.
    #[error("{}", .0.join("; "))]
    Failed(Vec<String>),
    #[error(transparent)]
    Storage(#[from] anyhow::Error),
}

/// The retired session, and what retiring removed.
pub struct Retired {
    pub instance: Instance,
    pub messages: Vec<String>,
}

/// The worktree a session owns: its path, its repository, and its branch.
struct OwnedWorktree {
    path: PathBuf,
    main_repo: PathBuf,
    branch: String,
}

/// Retire `id`, which must be archived and have nothing uncommitted. Holds
/// the session's lifecycle lock throughout, so nothing starts it meanwhile.
/// A structured session's worker must already be stopped.
pub fn retire_session(storage: &Storage, id: &str) -> Result<Retired, RetireError> {
    let _lifecycle = storage.acquire_instance_lifecycle_lock(id)?;
    let instance = storage
        .load()?
        .into_iter()
        .find(|instance| instance.id == id)
        .ok_or(RetireError::NotFound)?;
    let worktree = check_retirable(&instance)?;

    instance.kill_all_tmux_sessions_locked();
    let messages = with_paths_in_use_locked(id, |in_use| {
        if let Some(worktree) = &worktree {
            if in_use.covers(&worktree.path) {
                return Err(RetireError::Refused(format!(
                    "{} is also used by another session",
                    worktree.path.display()
                )));
            }
        }
        remove(&instance, worktree.as_ref())
    })?;

    let instance = storage.update(|instances, _groups| {
        let instance = instances
            .iter_mut()
            .find(|instance| instance.id == id)
            .ok_or_else(|| anyhow::anyhow!("session disappeared while retiring"))?;
        instance.retire();
        Ok(instance.clone())
    })?;
    Ok(Retired { instance, messages })
}

/// The worktree to remove, once nothing would be lost by removing it.
fn check_retirable(instance: &Instance) -> Result<Option<OwnedWorktree>, RetireError> {
    let refuse = |reason: String| Err(RetireError::Refused(reason));
    if instance.is_trashed() {
        return refuse("session is in the trash".into());
    }
    if instance.is_retired() {
        return refuse("session is already retired".into());
    }
    if !instance.is_archived() {
        return refuse("only an archived session can be retired".into());
    }
    if instance.workspace_info.is_some() {
        return refuse("a multi-repo workspace session cannot be retired yet".into());
    }
    let Some(info) = instance
        .worktree_info
        .as_ref()
        .filter(|wt| wt.managed_by_aoe)
    else {
        return Ok(None);
    };
    let worktree = OwnedWorktree {
        path: PathBuf::from(&instance.project_path),
        main_repo: PathBuf::from(&info.main_repo_path),
        branch: info.branch.clone(),
    };
    if is_protected_default_branch(&worktree.main_repo, &worktree.branch) {
        return refuse(format!(
            "{} is the repository's default branch",
            worktree.branch
        ));
    }
    // A worktree already gone has nothing left to lose.
    if !worktree.path.exists() {
        return Ok(Some(worktree));
    }
    let dirty = try_list_dirty_files(&worktree.path).map_err(|error| {
        RetireError::Refused(format!(
            "could not read the worktree at {}: {error}",
            worktree.path.display()
        ))
    })?;
    if !dirty.is_empty() {
        return refuse(format!(
            "the worktree has uncommitted changes:\n{}",
            listing(&dirty)
        ));
    }
    let stashes = stashes_on_branch(&worktree.main_repo, &worktree.branch)
        .map_err(|error| RetireError::Refused(format!("could not list stashes: {error}")))?;
    if !stashes.is_empty() {
        return refuse(format!(
            "{} has stashed changes:\n{}",
            worktree.branch,
            listing(&stashes)
        ));
    }
    Ok(Some(worktree))
}

fn listing(lines: &[String]) -> String {
    const SHOWN: usize = 10;
    let mut out: Vec<String> = lines.iter().take(SHOWN).map(|l| format!("  {l}")).collect();
    if lines.len() > SHOWN {
        out.push(format!("  and {} more", lines.len() - SHOWN));
    }
    out.join("\n")
}

/// Remove the container, then the worktree, keeping the branch.
fn remove(
    instance: &Instance,
    worktree: Option<&OwnedWorktree>,
) -> Result<Vec<String>, RetireError> {
    let mut messages = Vec::new();
    if instance.is_sandboxed() {
        // Files the container created may be unremovable from the host, so
        // the worktree is emptied from inside the container while it runs.
        if worktree.is_some_and(|wt| wt.path.exists()) {
            cleanup_sandbox_worktree(instance);
        }
        match DockerContainer::from_session_id(&instance.id).teardown(&instance.id) {
            Teardown::Removed => messages.push("Container removed".to_string()),
            Teardown::AlreadyGone => {}
            Teardown::Failed(error) => {
                return Err(RetireError::Failed(vec![format!("Container: {error}")]))
            }
        }
    }
    if let Some(worktree) = worktree.filter(|wt| wt.path.exists()) {
        let git = GitWorktree::new(worktree.main_repo.clone())
            .map_err(|error| RetireError::Failed(vec![format!("Worktree: {error}")]))?;
        remove_managed_worktree(
            &git,
            &worktree.path,
            Path::new(&worktree.main_repo),
            instance,
            false,
            true,
        )
        .map_err(RetireError::Failed)?;
        messages.push(format!("Worktree removed; branch {} kept", worktree.branch));
    }
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::instance::StartBlocked;
    use crate::session::test_support::isolate_app_dir_at;
    use crate::session::WorktreeInfo;
    use serial_test::serial;

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(["-c", "user.name=T", "-c", "user.email=t@e"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn store(storage: &Storage, instance: Instance) {
        storage
            .update(|instances, _| {
                instances.push(instance);
                Ok(())
            })
            .unwrap();
    }

    /// Before each retire attempt: whether the session is archived, and what to
    /// do to its worktree. Afterwards: whether it retired.
    #[test]
    #[serial]
    fn retires_only_an_archived_worktree_with_nothing_to_lose() {
        type Setup = fn(&Path, &Path, &Storage);
        let cases: [(&str, bool, Setup, bool); 5] = [
            ("not archived", false, |_, _, _| {}, false),
            (
                "uncommitted file",
                true,
                |wt, _, _| std::fs::write(wt.join("new"), "x").unwrap(),
                false,
            ),
            (
                "stash on its branch",
                true,
                |wt, _, _| {
                    std::fs::write(wt.join("tracked"), "changed").unwrap();
                    git(wt, &["stash"]);
                },
                false,
            ),
            (
                "path used by another session",
                true,
                |wt, _, storage| {
                    store(storage, Instance::new("other", wt.to_str().unwrap()));
                },
                false,
            ),
            // An ignored file is build output, not work.
            (
                "clean but for ignored files",
                true,
                |wt, _, _| std::fs::write(wt.join("build.log"), "x").unwrap(),
                true,
            ),
        ];
        for (name, archived, setup, retires) in cases {
            let tmp = tempfile::tempdir().unwrap();
            let _home = isolate_app_dir_at(&tmp.path().join("home"));
            let repo = tmp.path().join("repo");
            let worktree = tmp.path().join("worktree");
            std::fs::create_dir_all(&repo).unwrap();
            git(&repo, &["init", "-q", "-b", "main"]);
            std::fs::write(repo.join("tracked"), "base").unwrap();
            std::fs::write(repo.join(".gitignore"), "*.log\n").unwrap();
            git(&repo, &["add", "."]);
            git(&repo, &["commit", "-qm", "base"]);
            git(
                &repo,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    "feature",
                    worktree.to_str().unwrap(),
                ],
            );

            let storage = Storage::new_unwatched("default").unwrap();
            let mut instance = Instance::new("s", worktree.to_str().unwrap());
            instance.source_profile = "default".into();
            instance.worktree_info = Some(WorktreeInfo {
                branch: "feature".into(),
                main_repo_path: repo.to_string_lossy().into(),
                managed_by_aoe: true,
                created_at: chrono::Utc::now(),
                base_branch: None,
            });
            if archived {
                instance.archive();
            }
            let id = instance.id.clone();
            store(&storage, instance);
            setup(&worktree, &repo, &storage);

            let result = retire_session(&storage, &id);
            let stored = storage
                .load()
                .unwrap()
                .into_iter()
                .find(|i| i.id == id)
                .unwrap();
            let branch_kept = std::process::Command::new("git")
                .args(["rev-parse", "--verify", "-q", "refs/heads/feature"])
                .current_dir(&repo)
                .status()
                .unwrap()
                .success();
            if retires {
                assert!(result.is_ok(), "{name}: {:?}", result.err());
                assert!(!worktree.exists(), "{name}: worktree removed");
                assert_eq!(
                    stored.ensure_startable(),
                    Err(StartBlocked::Retired),
                    "{name}"
                );
            } else {
                assert!(
                    matches!(result, Err(RetireError::Refused(_))),
                    "{name}: {:?}",
                    result.err()
                );
                assert!(worktree.exists(), "{name}: worktree kept");
                assert!(!stored.is_retired(), "{name}");
            }
            assert!(branch_kept, "{name}: branch kept");
        }
    }
}
