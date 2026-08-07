use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitError {
    #[error("Path is not in a git repository")]
    NotAGitRepo,

    #[error("Worktree already exists at {}", .0.display())]
    WorktreeAlreadyExists(PathBuf),

    #[error("Branch '{0}' is already in use by another worktree")]
    BranchAlreadyCheckedOut(String),

    #[error("Worktree not found at {}", .0.display())]
    WorktreeNotFound(PathBuf),

    #[error("Branch '{0}' not found")]
    BranchNotFound(String),

    #[error("Git error: {0}")]
    Git2Error(#[from] git2::Error),

    #[error("Git worktree command failed: {0}")]
    WorktreeCommandFailed(String),

    #[error("Git clone failed: {0}")]
    CloneFailed(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

impl GitError {
    /// True when the underlying failure is `open_repo_at` finding no git
    /// repository at the given path at all, as opposed to a repo-internal
    /// error (corrupt object, bad ref, etc). Callers use this to distinguish
    /// "this session's project directory just isn't version-controlled"
    /// (recoverable: fall back to plain filesystem access) from a genuine
    /// git failure worth surfacing as a 500.
    pub fn is_repository_not_found(&self) -> bool {
        match self {
            GitError::NotAGitRepo => true,
            GitError::Git2Error(e) => {
                e.code() == git2::ErrorCode::NotFound && e.class() == git2::ErrorClass::Repository
            }
            _ => false,
        }
    }
}

pub type Result<T> = std::result::Result<T, GitError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_repository_not_found_detects_missing_repo_but_not_other_git2_errors() {
        let dir = tempfile::TempDir::new().unwrap();
        let missing_repo: GitError = match crate::git::open_repo_at(dir.path()) {
            Err(e) => e.into(),
            Ok(_) => panic!("empty tempdir must not be a git repository"),
        };
        assert!(missing_repo.is_repository_not_found());
        assert!(GitError::NotAGitRepo.is_repository_not_found());

        let unrelated = GitError::BranchNotFound("feature".into());
        assert!(!unrelated.is_repository_not_found());
    }
}
