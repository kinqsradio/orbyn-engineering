//! Git through the installed CLI. Worktrees live in the sibling `<repo>-wt`
//! root, never inside the repository. Repository config can name helpers that
//! run code, so every read disables them.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use orbyn_contracts::{FileDiff, Worktree};
use tokio::process::Command;

use crate::error::{CoreError, Result};

/// Refuses repository-configured programs on read paths.
const SAFE_CONFIG: &[&str] = &[
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "diff.external=",
];

async fn git(cwd: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output = git_raw(cwd, args).await?;
    if !output.status.success() {
        return Err(CoreError::Git(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    Ok(output.stdout)
}

async fn git_raw(cwd: &Path, args: &[&str]) -> Result<std::process::Output> {
    let mut command = Command::new("git");
    command
        .args(SAFE_CONFIG)
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
        .output()
        .await
        .map_err(|error| CoreError::Git(format!("Could not run git: {error}")))
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_owned()
}

/// Filesystem-only check, so adding an untrusted folder runs nothing in it.
pub fn is_git_repo(path: &Path) -> bool {
    path.join(".git").exists()
}

pub fn valid_purpose(purpose: &str) -> bool {
    !purpose.is_empty()
        && purpose.len() <= 64
        && purpose
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !purpose.starts_with('-')
}

/// `<repo>-wt/<purpose>` beside the primary clone.
pub fn worktree_path(repo: &Path, purpose: &str) -> Result<PathBuf> {
    let name = repo
        .file_name()
        .ok_or_else(|| CoreError::Git("This repository has no folder name.".into()))?;
    let mut root = name.to_owned();
    root.push("-wt");
    Ok(repo.with_file_name(root).join(purpose))
}

/// Creates a branch and worktree from the current HEAD.
pub async fn create_worktree(repo: &Path, purpose: &str) -> Result<Worktree> {
    if !valid_purpose(purpose) {
        return Err(CoreError::Invalid(
            "Use lowercase letters, digits and hyphens for the worktree name.".into(),
        ));
    }
    let path = worktree_path(repo, purpose)?;
    if path.exists() {
        return Err(CoreError::Invalid(format!(
            "{} already exists.",
            path.display()
        )));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let base = text(&git(repo, &["rev-parse", "HEAD"]).await?);
    let branch = format!("orbyn/{purpose}");
    let path_text = path.to_string_lossy().into_owned();
    git(repo, &["worktree", "add", "-b", &branch, &path_text, &base]).await?;
    Ok(Worktree {
        path: path_text,
        branch,
        base,
    })
}

/// Changes against `base` (or HEAD), including untracked files.
pub async fn diff(cwd: &Path, base: Option<&str>) -> Result<Vec<FileDiff>> {
    let base = base.unwrap_or("HEAD");
    let mut files = tracked_diff(cwd, base).await?;
    let listing = git(cwd, &["ls-files", "--others", "--exclude-standard", "-z"]).await?;
    for path in listing.split(|byte| *byte == 0).filter(|p| !p.is_empty()) {
        files.push(untracked_diff(cwd, &String::from_utf8_lossy(path)).await?);
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

async fn tracked_diff(cwd: &Path, base: &str) -> Result<Vec<FileDiff>> {
    let statuses = git(
        cwd,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-status",
            "-z",
            base,
        ],
    )
    .await?;
    let numstat = git(
        cwd,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            "-z",
            base,
        ],
    )
    .await?;
    let counts = parse_numstat(&numstat);
    let mut files = Vec::new();
    for (status, path) in parse_name_status(&statuses) {
        let patch = git(
            cwd,
            &["diff", "--no-ext-diff", "--no-textconv", base, "--", &path],
        )
        .await?;
        let (additions, deletions) = counts.get(&path).copied().unwrap_or((0, 0));
        files.push(FileDiff {
            path,
            status,
            additions,
            deletions,
            patch: String::from_utf8_lossy(&patch).into_owned(),
        });
    }
    Ok(files)
}

async fn untracked_diff(cwd: &Path, path: &str) -> Result<FileDiff> {
    let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
    // `--no-index` exits 1 when files differ, which is the expected case.
    let output = git_raw(
        cwd,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-index",
            "--",
            null_device,
            path,
        ],
    )
    .await?;
    if output.status.code() != Some(1) {
        return Err(CoreError::Git(text(&output.stderr)));
    }
    let patch = String::from_utf8_lossy(&output.stdout).into_owned();
    let additions = patch
        .lines()
        .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
        .count() as u32;
    Ok(FileDiff {
        path: path.to_owned(),
        status: "added".into(),
        additions,
        deletions: 0,
        patch,
    })
}

fn parse_name_status(bytes: &[u8]) -> Vec<(String, String)> {
    let mut fields = bytes
        .split(|byte| *byte == 0)
        .map(|field| String::from_utf8_lossy(field).into_owned());
    let mut entries = Vec::new();
    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        let renamed = status.starts_with('R') || status.starts_with('C');
        let Some(mut path) = fields.next() else {
            break;
        };
        if renamed && let Some(new_path) = fields.next() {
            path = new_path;
        }
        let name = match status.chars().next() {
            Some('A') => "added",
            Some('D') => "deleted",
            Some('R') => "renamed",
            Some('C') => "copied",
            _ => "modified",
        };
        entries.push((name.to_owned(), path));
    }
    entries
}

/// `git diff --numstat -z`: a rename puts its two paths in separate fields.
fn parse_numstat(bytes: &[u8]) -> std::collections::HashMap<String, (u32, u32)> {
    let mut counts = std::collections::HashMap::new();
    let mut fields = bytes.split(|byte| *byte == 0);
    while let Some(field) = fields.next() {
        let line = String::from_utf8_lossy(field);
        let mut parts = line.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let added = added.parse().unwrap_or(0);
        let deleted = deleted.parse().unwrap_or(0);
        let path = if path.is_empty() {
            let _old = fields.next();
            fields
                .next()
                .map(|new| String::from_utf8_lossy(new).into_owned())
                .unwrap_or_default()
        } else {
            path.to_owned()
        };
        counts.insert(path, (added, deleted));
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    async fn repo(dir: &Path) -> PathBuf {
        let repo = dir.join("project");
        std::fs::create_dir_all(&repo).unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "T"],
        ] {
            git(&repo, &args).await.unwrap();
        }
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "."]).await.unwrap();
        git(&repo, &["commit", "-q", "-m", "first"]).await.unwrap();
        repo
    }

    #[tokio::test]
    async fn worktree_is_a_sibling_and_diff_sees_tracked_and_untracked() {
        let dir = TempDir::new();
        let repo = repo(dir.path()).await;
        let worktree = create_worktree(&repo, "fix-bug").await.unwrap();
        let path = PathBuf::from(&worktree.path);
        assert_eq!(path, dir.path().join("project-wt").join("fix-bug"));
        assert_eq!(worktree.branch, "orbyn/fix-bug");

        std::fs::write(path.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(path.join("new file.txt"), "fresh\nlines\n").unwrap();
        let files = diff(&path, Some(&worktree.base)).await.unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].status, "modified");
        assert_eq!((files[0].additions, files[0].deletions), (1, 0));
        assert!(files[0].patch.contains("+two"));
        assert_eq!(files[1].path, "new file.txt");
        assert_eq!(files[1].status, "added");
        assert_eq!(files[1].additions, 2);
        assert!(files[1].patch.contains("+fresh"));
    }

    #[tokio::test]
    async fn diff_includes_committed_work_since_the_base() {
        let dir = TempDir::new();
        let repo = repo(dir.path()).await;
        let base = text(&git(&repo, &["rev-parse", "HEAD"]).await.unwrap());
        std::fs::write(repo.join("b.txt"), "b\n").unwrap();
        git(&repo, &["add", "."]).await.unwrap();
        git(&repo, &["commit", "-q", "-m", "second"]).await.unwrap();
        let files = diff(&repo, Some(&base)).await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "added");
    }

    #[tokio::test]
    async fn repository_helpers_do_not_run_on_read() {
        let dir = TempDir::new();
        let repo = repo(dir.path()).await;
        let marker = dir.path().join("ran");
        let script = dir.path().join("helper.sh");
        std::fs::write(
            &script,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let helper = script.to_string_lossy().into_owned();
        git(&repo, &["config", "diff.external", &helper])
            .await
            .unwrap();
        git(&repo, &["config", "core.fsmonitor", &helper])
            .await
            .unwrap();
        std::fs::write(repo.join("a.txt"), "changed\n").unwrap();
        let files = diff(&repo, None).await.unwrap();
        assert_eq!(files.len(), 1);
        assert!(!marker.exists());
    }

    #[test]
    fn purposes_are_slugs() {
        assert!(valid_purpose("fix-bug-2"));
        assert!(!valid_purpose("../escape"));
        assert!(!valid_purpose("-flag"));
        assert!(!valid_purpose(""));
        assert!(!valid_purpose("Upper"));
    }

    #[test]
    fn name_status_handles_renames() {
        let raw = b"M\0a.txt\0R100\0old.txt\0new.txt\0A\0c.txt\0";
        assert_eq!(
            parse_name_status(raw),
            [
                ("modified".to_owned(), "a.txt".to_owned()),
                ("renamed".to_owned(), "new.txt".to_owned()),
                ("added".to_owned(), "c.txt".to_owned()),
            ]
        );
    }
}
