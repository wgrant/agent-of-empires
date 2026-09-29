//! Resolved config reused across calls until a file it came from changes.
//!
//! Resolving reads and parses the global, profile and repo TOML and opens the
//! project with libgit2 to find a worktree's main repo. A hit costs a few
//! `stat`s: every file a resolution read, or whose absence it relied on, is
//! stamped and compared on each lookup, so an edit from any process is seen.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use super::profile_config::resolve_config_or_warn;
use super::repo_config::{merge_repo_config_or_warn, repo_config_files, repo_config_source_path};
use super::Config;

/// Past this many projects the cache starts over rather than tracking use.
const MAX_REPO_ENTRIES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stamp {
    Missing,
    /// A directory's contents change its mtime, so only its kind counts.
    Dir,
    File {
        modified: Option<SystemTime>,
        len: u64,
    },
}

fn stamp(path: &Path) -> Stamp {
    match std::fs::metadata(path) {
        Err(_) => Stamp::Missing,
        Ok(meta) if meta.is_dir() => Stamp::Dir,
        Ok(meta) => Stamp::File {
            modified: meta.modified().ok(),
            len: meta.len(),
        },
    }
}

/// An empty path is a scratch session's, which has no repo; joining onto it
/// would stamp files in the launch directory.
fn stamp_under(base: &Path, rel: &str) -> Stamp {
    if base.as_os_str().is_empty() {
        Stamp::Missing
    } else {
        stamp(&base.join(rel))
    }
}

fn repo_stamps(source: &Path) -> [Stamp; 2] {
    if source.as_os_str().is_empty() {
        return [Stamp::Missing; 2];
    }
    repo_config_files(source).map(|path| stamp(&path))
}

fn profile_stamps(profile: &str) -> Vec<Stamp> {
    let Ok(app_dir) = crate::session::get_app_dir_path() else {
        return Vec::new();
    };
    let mut stamps = vec![
        stamp(&app_dir.join("config.toml")),
        stamp(&app_dir.join("state.toml")),
    ];
    if let Ok(dir) = crate::session::get_profile_dir_path(profile) {
        stamps.push(stamp(&dir.join("config.toml")));
    }
    stamps
}

struct ProfileEntry {
    stamps: Vec<Stamp>,
    config: Arc<Config>,
}

struct RepoEntry {
    /// The profile config this was merged over.
    base: Arc<Config>,
    /// `<project>/.git`, which decides the repo whose config applies.
    git: Stamp,
    source: PathBuf,
    files: [Stamp; 2],
    config: Arc<Config>,
}

/// How many resolutions ran, as opposed to lookups served from the cache.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Resolutions {
    pub profiles: usize,
    pub repos: usize,
}

#[derive(Default)]
pub struct ResolvedConfigCache {
    profiles: Mutex<HashMap<String, ProfileEntry>>,
    repos: Mutex<HashMap<(String, PathBuf), RepoEntry>>,
    profile_resolutions: AtomicUsize,
    repo_resolutions: AtomicUsize,
}

impl ResolvedConfigCache {
    pub fn resolutions(&self) -> Resolutions {
        Resolutions {
            profiles: self.profile_resolutions.load(Ordering::Relaxed),
            repos: self.repo_resolutions.load(Ordering::Relaxed),
        }
    }

    /// As [`resolve_config_or_warn`].
    pub fn profile(&self, profile: &str) -> Arc<Config> {
        // Stamped before reading, so an edit racing the read is caught next time.
        let stamps = profile_stamps(profile);
        let mut profiles = self.profiles.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = profiles.get(profile) {
            if entry.stamps == stamps {
                return Arc::clone(&entry.config);
            }
        }
        self.profile_resolutions.fetch_add(1, Ordering::Relaxed);
        let config = Arc::new(resolve_config_or_warn(profile));
        profiles.insert(
            profile.to_string(),
            ProfileEntry {
                stamps,
                config: Arc::clone(&config),
            },
        );
        config
    }

    /// As [`super::repo_config::resolve_config_with_repo_or_warn`].
    pub fn with_repo(&self, profile: &str, project_path: &Path) -> Arc<Config> {
        let base = self.profile(profile);
        let git = stamp_under(project_path, ".git");
        let key = (profile.to_string(), project_path.to_path_buf());
        let mut repos = self.repos.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = repos.get(&key) {
            if Arc::ptr_eq(&entry.base, &base)
                && entry.git == git
                && entry.files == repo_stamps(&entry.source)
            {
                return Arc::clone(&entry.config);
            }
        }
        self.repo_resolutions.fetch_add(1, Ordering::Relaxed);
        let source = repo_config_source_path(project_path);
        let files = repo_stamps(&source);
        let config = Arc::new(merge_repo_config_or_warn((*base).clone(), &source));
        if repos.len() >= MAX_REPO_ENTRIES {
            repos.clear();
        }
        repos.insert(
            key,
            RepoEntry {
                base,
                git,
                source,
                files,
                config: Arc::clone(&config),
            },
        );
        config
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::test_support::isolate_app_dir_at;
    use serial_test::serial;

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    /// Each lookup resolves only when a file it depends on changed, and a
    /// change reaches exactly the entries that read that file.
    #[test]
    #[serial]
    fn resolves_again_only_what_a_changed_file_feeds() {
        let home = tempfile::tempdir().unwrap();
        let _guard = isolate_app_dir_at(home.path());
        let repos = tempfile::tempdir().unwrap();
        let repo_a = repos.path().join("a");
        let repo_b = repos.path().join("b");
        for repo in [&repo_a, &repo_b] {
            git2::Repository::init(repo).unwrap();
        }
        let config_a = repo_a.join(".agent-of-empires/config.toml");
        write(&config_a, "[sandbox]\nmemory_limit = \"1g\"\n");

        let cache = ResolvedConfigCache::default();
        let lookup = || {
            for _ in 0..3 {
                for repo in [&repo_a, &repo_b] {
                    cache.with_repo("default", repo);
                }
            }
        };
        let resolved = |profiles, repos| Resolutions { profiles, repos };

        lookup();
        assert_eq!(cache.resolutions(), resolved(1, 2), "cold");
        lookup();
        assert_eq!(cache.resolutions(), resolved(1, 2), "warm");

        write(&config_a, "[sandbox]\nmemory_limit = \"16g\"\n");
        lookup();
        assert_eq!(cache.resolutions(), resolved(1, 3), "repo a's config");
        assert_eq!(
            cache
                .with_repo("default", &repo_a)
                .sandbox
                .memory_limit
                .as_deref(),
            Some("16g")
        );

        write(
            &repo_b.join(".aoe/config.toml"),
            "[sandbox]\nmemory_limit = \"2g\"\n",
        );
        lookup();
        assert_eq!(
            cache.resolutions(),
            resolved(1, 4),
            "repo b's new legacy config"
        );

        let global = crate::session::get_app_dir_path()
            .unwrap()
            .join("config.toml");
        write(&global, "[session]\n");
        lookup();
        assert_eq!(cache.resolutions(), resolved(2, 6), "global config");
    }
}
