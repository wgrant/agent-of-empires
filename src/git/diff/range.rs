//! Diffs of a commit range: what `head` adds over `base`.
//!
//! A range diffs the merge-base of `base` and `head` against `head`'s tree,
//! git's three-dot `base...head`. For a branch stacked on another this is the
//! layer's own changes, without anything `base` gained after `head` forked from
//! it. Both ends are commits, so the working tree never enters.

use std::path::Path;

use super::{files_of_diff, get_blob_bytes, is_binary_bytes, DiffFile, FileContents};
use crate::git::error::{GitError, Result};

/// A range resolved within one repository: the tree to diff from and the
/// commit to diff to. Commits never change, so neither does its diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CommitRange {
    /// The merge-base of base and head, or base itself when they share no history.
    pub from: git2::Oid,
    pub head: git2::Oid,
}

#[derive(Debug, Clone)]
pub struct ResolvedRange {
    pub range: CommitRange,
    /// Set when base and head share no history, so the diff runs from base's
    /// tip and may include changes unrelated to head.
    pub warning: Option<String>,
}

/// Resolve `base` and `head` the way `git rev-parse` would, each to a commit.
pub fn resolve_range(repo_path: &Path, base: &str, head: &str) -> Result<ResolvedRange> {
    let repo = crate::git::open_repo_at(repo_path)?;
    let base_commit = revision(&repo, base)?;
    let head_commit = revision(&repo, head)?;
    let (from, warning) = match repo.merge_base(base_commit, head_commit) {
        Ok(from) => (from, None),
        Err(_) => (
            base_commit,
            Some(format!(
                "'{base}' and '{head}' share no history, so this compares '{head}' with the tip \
                 of '{base}' and may include unrelated changes."
            )),
        ),
    };
    Ok(ResolvedRange {
        range: CommitRange {
            from,
            head: head_commit,
        },
        warning,
    })
}

fn revision(repo: &git2::Repository, rev: &str) -> Result<git2::Oid> {
    let not_found = || GitError::RevisionNotFound(rev.to_string());
    if rev.trim().is_empty() {
        return Err(not_found());
    }
    let object = repo.revparse_single(rev).map_err(|_| not_found())?;
    let commit = object.peel_to_commit().map_err(|_| not_found())?;
    Ok(commit.id())
}

/// The files `range` changes, with renames, sorted by path.
pub fn range_changed_files(repo_path: &Path, range: CommitRange) -> Result<Vec<DiffFile>> {
    let repo = crate::git::open_repo_at(repo_path)?;
    let from = repo.find_commit(range.from)?.tree()?;
    let head = repo.find_commit(range.head)?.tree()?;
    let diff = repo.diff_tree_to_tree(Some(&from), Some(&head), None)?;
    let mut files = files_of_diff(diff)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// One changed file's contents on each side of `range`: the old side from its
/// pre-rename path, and a unified patch between them.
pub fn range_file_contents(
    repo_path: &Path,
    range: CommitRange,
    file: &DiffFile,
) -> Result<FileContents> {
    let repo = crate::git::open_repo_at(repo_path)?;
    let from = repo.find_commit(range.from)?.tree()?;
    let head = repo.find_commit(range.head)?.tree()?;
    let old_path = file.old_path.as_deref().unwrap_or(&file.path);
    let old = get_blob_bytes(&repo, &from, old_path).unwrap_or_default();
    let new = get_blob_bytes(&repo, &head, &file.path).unwrap_or_default();
    let is_binary = is_binary_bytes(&old) || is_binary_bytes(&new);
    let patch = if is_binary {
        String::new()
    } else {
        let mut opts = git2::DiffOptions::new();
        opts.context_lines(3);
        let mut patch = git2::Patch::from_buffers(
            &old,
            Some(old_path),
            &new,
            Some(&file.path),
            Some(&mut opts),
        )?;
        String::from_utf8_lossy(&patch.to_buf()?).into_owned()
    };
    let text = |bytes: Vec<u8>| {
        if is_binary {
            String::new()
        } else {
            String::from_utf8(bytes).unwrap_or_default()
        }
    };
    Ok(FileContents {
        path: file.path.clone(),
        old_path: file.old_path.clone(),
        status: file.status,
        old_content: text(old),
        new_content: text(new),
        patch,
        is_binary,
    })
}

/// A file as `commit` has it, if it is a blob there.
pub fn file_at_commit(repo_path: &Path, commit: git2::Oid, path: &Path) -> Result<Option<Vec<u8>>> {
    let repo = crate::git::open_repo_at(repo_path)?;
    let tree = repo.find_commit(commit)?.tree()?;
    Ok(get_blob_bytes(&repo, &tree, path))
}

/// Whether the repository's checked-out HEAD is `commit`.
pub fn is_checked_out(repo_path: &Path, commit: git2::Oid) -> bool {
    crate::git::open_repo_at(repo_path)
        .ok()
        .and_then(|repo| repo.head().ok()?.peel_to_commit().ok().map(|c| c.id()))
        == Some(commit)
}

/// A file as the commit `rev` names has it, if it is a blob there.
pub fn file_at_revision(repo_path: &Path, rev: &str, path: &Path) -> Result<Option<Vec<u8>>> {
    let commit = revision(&crate::git::open_repo_at(repo_path)?, rev)?;
    file_at_commit(repo_path, commit, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::diff::FileStatus;
    use crate::git::test_support::{commit, run_git};

    /// `main` gains a commit after `layer` forks from it: the range shows the
    /// layer's own change, where a two-dot diff would also undo main's.
    #[test]
    fn a_range_shows_what_head_adds_over_its_fork_point() {
        let dir = tempfile::TempDir::new().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let root = commit(
            &repo,
            Some("refs/heads/main"),
            &[("a.txt", b"a\n")],
            &[],
            Some(1),
        );
        let layer = commit(
            &repo,
            Some("refs/heads/layer"),
            &[("b.txt", b"b\n"), ("old.txt", b"moved\nkeep\nall\nlines\n")],
            &[root],
            Some(2),
        );
        commit(
            &repo,
            Some("refs/heads/main"),
            &[("a.txt", b"a2\n")],
            &[root],
            Some(3),
        );
        // The layer on top renames a file and edits another.
        let mut top_files = repo
            .treebuilder(Some(&repo.find_commit(layer).unwrap().tree().unwrap()))
            .unwrap();
        top_files.remove("old.txt").unwrap();
        top_files
            .insert(
                "new.txt",
                repo.blob(b"moved\nkeep\nall\nlines\n").unwrap(),
                0o100644,
            )
            .unwrap();
        top_files
            .insert("b.txt", repo.blob(b"b\nb2\n").unwrap(), 0o100644)
            .unwrap();
        let tree = repo.find_tree(top_files.write().unwrap()).unwrap();
        let sig = git2::Signature::new("T", "t@e", &git2::Time::new(4, 0)).unwrap();
        let parent = repo.find_commit(layer).unwrap();
        repo.commit(Some("refs/heads/top"), &sig, &sig, "top", &tree, &[&parent])
            .unwrap();

        let files = |base: &str, head: &str| {
            let resolved = resolve_range(dir.path(), base, head).unwrap();
            assert!(resolved.warning.is_none());
            range_changed_files(dir.path(), resolved.range)
                .unwrap()
                .into_iter()
                .map(|f| {
                    (
                        f.path.to_string_lossy().into_owned(),
                        f.old_path.map(|p| p.to_string_lossy().into_owned()),
                        f.status,
                    )
                })
                .collect::<Vec<_>>()
        };
        type Listed = Vec<(String, Option<String>, FileStatus)>;
        let cases: [(&str, &str, Listed); 2] = [
            (
                "main",
                "layer",
                vec![
                    ("b.txt".into(), None, FileStatus::Added),
                    ("old.txt".into(), None, FileStatus::Added),
                ],
            ),
            (
                "layer",
                "top",
                vec![
                    ("b.txt".into(), None, FileStatus::Modified),
                    (
                        "new.txt".into(),
                        Some("old.txt".into()),
                        FileStatus::Renamed,
                    ),
                ],
            ),
        ];
        for (base, head, want) in cases {
            assert_eq!(files(base, head), want, "{base}...{head}");
        }
        // git agrees on the three-dot form, and a two-dot diff would differ.
        let three_dot = run_git(dir.path(), &["diff", "--name-status", "main...layer"]);
        assert_eq!(three_dot, "A\tb.txt\nA\told.txt\n");
        let two_dot = run_git(dir.path(), &["diff", "--name-status", "main..layer"]);
        assert!(two_dot.contains("a.txt"), "{two_dot}");

        // A renamed file's contents come from its old path, and match git's patch.
        let resolved = resolve_range(dir.path(), "layer", "top").unwrap();
        let listed = range_changed_files(dir.path(), resolved.range).unwrap();
        let edited = listed
            .iter()
            .find(|f| f.path == Path::new("b.txt"))
            .unwrap();
        let contents = range_file_contents(dir.path(), resolved.range, edited).unwrap();
        assert_eq!(
            (contents.old_content.as_str(), contents.new_content.as_str()),
            ("b\n", "b\nb2\n")
        );
        assert!(contents.patch.contains("+b2"), "{}", contents.patch);
        let renamed = listed
            .iter()
            .find(|f| f.path == Path::new("new.txt"))
            .unwrap();
        let contents = range_file_contents(dir.path(), resolved.range, renamed).unwrap();
        assert_eq!(contents.old_content, contents.new_content);
        assert_eq!(contents.old_path.as_deref(), Some(Path::new("old.txt")));
    }

    /// A ref that names no commit is an error naming it, and unrelated
    /// histories diff from base's tip with a warning.
    #[test]
    fn missing_refs_fail_and_unrelated_histories_warn() {
        let dir = tempfile::TempDir::new().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let main = commit(
            &repo,
            Some("refs/heads/main"),
            &[("a.txt", b"a\n")],
            &[],
            Some(1),
        );
        let blob = repo.blob(b"x").unwrap().to_string();
        for (base, head) in [
            ("main", "nope"),
            ("nope", "main"),
            ("main", ""),
            ("main", blob.as_str()),
        ] {
            let err = resolve_range(dir.path(), base, head).unwrap_err();
            assert!(
                matches!(err, GitError::RevisionNotFound(_)),
                "{base}...{head}: {err}"
            );
        }
        let orphan = commit(
            &repo,
            Some("refs/heads/orphan"),
            &[("z.txt", b"z\n")],
            &[],
            Some(2),
        );
        let resolved = resolve_range(dir.path(), "main", "orphan").unwrap();
        assert_eq!(
            resolved.range,
            CommitRange {
                from: main,
                head: orphan
            }
        );
        assert!(resolved.warning.is_some());
    }
}
