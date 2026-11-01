//! Git through the installed CLI. Worktrees live in the sibling `<repo>-wt`
//! root, never inside the repository. Repository config can name helpers that
//! run code, so every read disables them.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use orbyn_contracts::{CommitInfo, FileDiff, Worktree};
use tokio::process::Command;

use crate::error::{CoreError, Result};

/// Git's well-known empty tree, the parent side of a root commit's diff.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Refuses repository-configured programs on read paths.
const SAFE_CONFIG: &[&str] = &[
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "diff.external=",
];

/// Checkpoints hold the files' own bytes. Line-ending settings and attributes would
/// rewrite them on the way in or out, so neither applies to a snapshot or a restore.
const BYTE_EXACT: &[&str] = &[
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "core.attributesFile=",
];

/// The repository's own empty tree. Reading attributes from it hides `.gitattributes`.
async fn no_attributes(cwd: &Path) -> Result<String> {
    Ok(text(
        &git(cwd, &["hash-object", "-t", "tree", "--stdin"]).await?,
    ))
}

pub(crate) async fn git(cwd: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output = git_raw(cwd, args).await?;
    if !output.status.success() {
        return Err(CoreError::Git(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    Ok(output.stdout)
}

pub(crate) async fn git_raw(cwd: &Path, args: &[&str]) -> Result<std::process::Output> {
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
    crate::child_env::for_tool(command.as_std_mut());
    let output = async { crate::process::ManagedChild::spawn(command)?.output().await }.await;
    output.map_err(|error| CoreError::Git(format!("Could not run git: {error}")))
}

pub(crate) fn text(bytes: &[u8]) -> String {
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

/// A registered worktree of a primary clone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegisteredWorktree {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub revision: String,
}

/// Linked worktrees, without the primary checkout.
pub async fn linked_worktrees(repo: &Path) -> Result<Vec<RegisteredWorktree>> {
    let listing = git(repo, &["worktree", "list", "--porcelain", "-z"]).await?;
    let mut worktrees = Vec::new();
    let mut current: Option<RegisteredWorktree> = None;
    for field in listing.split(|byte| *byte == 0) {
        let line = String::from_utf8_lossy(field);
        if let Some(path) = line.strip_prefix("worktree ") {
            worktrees.extend(current.take());
            current = Some(RegisteredWorktree {
                path: PathBuf::from(path),
                branch: None,
                revision: String::new(),
            });
        } else if let Some(entry) = current.as_mut() {
            if let Some(head) = line.strip_prefix("HEAD ") {
                entry.revision = head.to_owned();
            } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
                entry.branch = Some(branch.to_owned());
            }
        }
    }
    worktrees.extend(current);
    if !worktrees.is_empty() {
        worktrees.remove(0);
    }
    Ok(worktrees)
}

/// How a new worktree starts, from the settings and the project file.
#[derive(Clone, Debug)]
pub struct WorktreeOptions {
    pub prefix: String,
    pub base: Option<String>,
    pub from_origin: bool,
    /// `recursive`, `top-level` or `none`; legacy spellings remain readable.
    pub submodules: String,
    /// An absolute folder for new worktrees, instead of beside the repository.
    pub directory: Option<PathBuf>,
}

impl Default for WorktreeOptions {
    fn default() -> Self {
        Self {
            prefix: "feat".to_owned(),
            base: None,
            from_origin: false,
            submodules: "none".to_owned(),
            directory: None,
        }
    }
}

/// Finds or creates the purpose's worktree at `<repo>-wt/<purpose>`. A registered
/// worktree already at that path is reused; its base is where it left the
/// primary clone's HEAD.
pub async fn create_worktree(
    repo: &Path,
    purpose: &str,
    options: &WorktreeOptions,
) -> Result<Worktree> {
    if !valid_purpose(purpose) {
        return Err(CoreError::Invalid(
            "Use lowercase letters, digits and hyphens for the worktree name.".into(),
        ));
    }
    let path = match &options.directory {
        Some(directory) if !directory.is_absolute() => {
            return Err(CoreError::Invalid(
                "The worktree location must be an absolute path.".into(),
            ));
        }
        Some(directory) => {
            let name = repo
                .file_name()
                .ok_or_else(|| CoreError::Git("This repository has no folder name.".into()))?;
            directory.join(name).join(purpose)
        }
        None => worktree_path(repo, purpose)?,
    };
    let path_text = path.to_string_lossy().into_owned();
    let head = text(&git(repo, &["rev-parse", "HEAD"]).await?);
    for registered in linked_worktrees(repo).await? {
        // One made before the location changed is still this purpose's worktree.
        if registered.path.exists()
            && registered.path.file_name() == Some(std::ffi::OsStr::new(purpose))
        {
            let base = text(&git(repo, &["merge-base", "HEAD", &registered.revision]).await?);
            // Git's spelling of a path differs on Windows, so keep ours when it is the same place.
            let same = crate::util::canonicalize(&registered.path).ok().as_ref()
                == crate::util::canonicalize(&path).ok().as_ref();
            return Ok(Worktree {
                path: if same {
                    path_text
                } else {
                    registered.path.to_string_lossy().into_owned()
                },
                branch: registered.branch.unwrap_or_else(|| "HEAD".to_owned()),
                base,
            });
        }
    }
    if path.exists() {
        return Err(CoreError::Invalid(format!(
            "{} already exists.",
            path.display()
        )));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let branch = format!("{}/{purpose}", options.prefix);
    if git(repo, &["check-ref-format", "--branch", &branch])
        .await
        .is_err()
    {
        return Err(CoreError::Invalid(
            "That branch prefix is not valid.".into(),
        ));
    }
    let start = worktree_start(repo, options).await.unwrap_or(head);
    git(
        repo,
        &["worktree", "add", "-b", &branch, &path_text, &start],
    )
    .await?;
    let submodules: &[&str] = match options.submodules.as_str() {
        "none" | "skip" => &[],
        "top-level" | "top_level" => &["submodule", "update", "--init"],
        _ => &["submodule", "update", "--init", "--recursive"],
    };
    // A submodule that cannot be fetched leaves the worktree usable.
    if !submodules.is_empty()
        && path.join(".gitmodules").exists()
        && let Err(error) = git(&path, submodules).await
    {
        tracing::warn!(%error, "could not populate submodules");
    }
    Ok(Worktree {
        path: path_text,
        branch,
        base: start,
    })
}

/// A chosen base, or the remote's head when asked for. `None` means this clone's HEAD.
async fn worktree_start(repo: &Path, options: &WorktreeOptions) -> Option<String> {
    if let Some(base) = &options.base {
        if base.starts_with('-') {
            return None;
        }
        return Some(text(
            &git(repo, &["rev-parse", "--verify", base]).await.ok()?,
        ));
    }
    if !options.from_origin {
        return None;
    }
    let default = git(
        repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .await
    .ok()?;
    let default = text(&default);
    let branch = default.strip_prefix("origin/")?;
    git(repo, &["fetch", "-q", "origin", branch]).await.ok()?;
    Some(text(
        &git(repo, &["rev-parse", "--verify", &default]).await.ok()?,
    ))
}

/// Refs and index entries only: a snapshot leaves the real index and every working
/// file alone. Ignored files are not captured.
pub async fn snapshot(cwd: &Path, reference: Option<&str>, index: &Path) -> Result<String> {
    let index_text = index.to_string_lossy().into_owned();
    let attributes = no_attributes(cwd).await?;
    let with_index = |args: Vec<String>| {
        let index_text = index_text.clone();
        let attributes = attributes.clone();
        let cwd = cwd.to_path_buf();
        async move {
            let mut command = Command::new("git");
            command
                .args(SAFE_CONFIG)
                .args(BYTE_EXACT)
                .args(["-c", "user.name=Orbyn", "-c", "user.email=orbyn@localhost"])
                .args(&args)
                .current_dir(&cwd)
                .env("GIT_INDEX_FILE", &index_text)
                .env("GIT_ATTR_SOURCE", &attributes)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            crate::child_env::for_tool(command.as_std_mut());
            let output = command
                .output()
                .await
                .map_err(|error| CoreError::Git(format!("Could not run git: {error}")))?;
            if !output.status.success() {
                return Err(CoreError::Git(text(&output.stderr)));
            }
            Ok(text(&output.stdout))
        }
    };
    let _ = std::fs::remove_file(index);
    let head = git(cwd, &["rev-parse", "--verify", "-q", "HEAD"])
        .await
        .ok();
    if let Some(head) = &head {
        with_index(vec!["read-tree".into(), text(head)]).await?;
    }
    with_index(vec!["add".into(), "-A".into()]).await?;
    let tree = with_index(vec!["write-tree".into()]).await?;
    let mut commit = vec![
        "commit-tree".to_owned(),
        tree,
        "-m".into(),
        "checkpoint".into(),
    ];
    if let Some(head) = &head {
        commit.extend(["-p".to_owned(), text(head)]);
    }
    let sha = with_index(commit).await?;
    let _ = std::fs::remove_file(index);
    if let Some(reference) = reference {
        git(cwd, &["update-ref", reference, &sha]).await?;
    }
    Ok(sha)
}

/// What changed between two commits.
pub async fn diff_between(cwd: &Path, from: &str, to: &str) -> Result<Vec<FileDiff>> {
    tracked_diff(cwd, &[from, to]).await
}

/// The changes one commit made.
pub async fn commit_diff(cwd: &Path, sha: &str) -> Result<Vec<FileDiff>> {
    if !is_revision(sha) {
        return Err(CoreError::Invalid("That is not a commit.".into()));
    }
    let parent = format!("{sha}^");
    let base = match git(cwd, &["rev-parse", "--verify", "-q", &parent]).await {
        Ok(found) => text(&found),
        Err(_) => EMPTY_TREE.to_owned(),
    };
    diff_between(cwd, &base, sha).await
}

/// Everything since this branch left `base`, untracked work included.
pub async fn branch_diff(cwd: &Path, base: &str) -> Result<Vec<FileDiff>> {
    if base.starts_with('-') || base.is_empty() {
        return Err(CoreError::Invalid("That is not a branch.".into()));
    }
    let shared = text(&git(cwd, &["merge-base", base, "HEAD"]).await?);
    diff(cwd, Some(&shared)).await
}

pub fn is_revision(text: &str) -> bool {
    (7..=64).contains(&text.len()) && text.chars().all(|c| c.is_ascii_hexdigit())
}

pub async fn recent_commits(cwd: &Path, limit: u32) -> Result<Vec<CommitInfo>> {
    let limit = format!("-{}", limit.min(100));
    let Ok(log) = git(cwd, &["log", &limit, "--format=%H%x09%an%x09%aI%x09%s"]).await else {
        // A repository with no commits has no history to show.
        return Ok(Vec::new());
    };
    Ok(String::from_utf8_lossy(&log)
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(4, '\t');
            Some(CommitInfo {
                sha: fields.next()?.to_owned(),
                author: fields.next()?.to_owned(),
                date: fields.next()?.to_owned(),
                subject: fields.next()?.to_owned(),
            })
        })
        .collect())
}

/// Makes the working files match `target`, leaving HEAD, the index and ignored
/// files alone. `current` is a snapshot of the files as they are now.
pub async fn restore_worktree(cwd: &Path, current: &str, target: &str) -> Result<()> {
    let added = git(
        cwd,
        &[
            "diff",
            "--no-renames",
            "--name-only",
            "-z",
            "--diff-filter=A",
            target,
            current,
        ],
    )
    .await?;
    for path in added
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let path = cwd.join(String::from_utf8_lossy(path).as_ref());
        std::fs::remove_file(path)?;
    }
    let mut command = Command::new("git");
    command
        .args(SAFE_CONFIG)
        .args(BYTE_EXACT)
        .args([
            "restore",
            &format!("--source={target}"),
            "--worktree",
            "--",
            ".",
        ])
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_ATTR_SOURCE", no_attributes(cwd).await?)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::child_env::for_tool(command.as_std_mut());
    let output = command
        .output()
        .await
        .map_err(|error| CoreError::Git(format!("Could not run git: {error}")))?;
    if !output.status.success() {
        return Err(CoreError::Git(text(&output.stderr)));
    }
    Ok(())
}

/// Changes against `base` (or HEAD), including untracked files.
pub async fn diff(cwd: &Path, base: Option<&str>) -> Result<Vec<FileDiff>> {
    let base = base.unwrap_or("HEAD");
    let mut files = tracked_diff(cwd, &[base]).await?;
    let listing = git(cwd, &["ls-files", "--others", "--exclude-standard", "-z"]).await?;
    for path in listing.split(|byte| *byte == 0).filter(|p| !p.is_empty()) {
        files.push(untracked_diff(cwd, &String::from_utf8_lossy(path)).await?);
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

async fn tracked_diff(cwd: &Path, range: &[&str]) -> Result<Vec<FileDiff>> {
    let mut statuses_args = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-status",
        "-z",
    ];
    statuses_args.extend(range);
    let statuses = git(cwd, &statuses_args).await?;
    let mut numstat_args = vec!["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z"];
    numstat_args.extend(range);
    let numstat = git(cwd, &numstat_args).await?;
    let counts = parse_numstat(&numstat);
    let mut files = Vec::new();
    for (status, path) in parse_name_status(&statuses) {
        let mut patch_args = vec!["diff", "--no-ext-diff", "--no-textconv"];
        patch_args.extend(range);
        patch_args.extend(["--", &path]);
        let patch = git(cwd, &patch_args).await?;
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

    #[tokio::test]
    async fn a_finished_git_leader_does_not_leave_helpers_holding_output() {
        let dir = TempDir::new();
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            git_raw(
                dir.path(),
                &[
                    "-c",
                    "alias.detach=!(sleep 1; echo escaped > escaped) &",
                    "detach",
                ],
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(output.status.success(), "{}", text(&output.stderr));
        assert!(
            !dir.path().join("escaped").exists(),
            "Git waited for a detached helper to finish"
        );
    }

    #[tokio::test]
    async fn cancelling_git_stops_its_helper_descendants() {
        let dir = TempDir::new();
        let root = dir.path().to_path_buf();
        let ready = root.join("ready");
        let escaped = root.join("escaped");
        let task = tokio::spawn(async move {
            // Git runs ! aliases through its shell on both supported platforms.
            // The descendant has a bounded lifetime even on the failing baseline.
            git_raw(
                &root,
                &[
                    "-c",
                    "alias.hold=!(sleep 1; echo escaped > escaped) & echo ready > ready; wait",
                    "hold",
                ],
            )
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !ready.exists() {
                assert!(
                    !task.is_finished(),
                    "Git fixture exited before its handshake"
                );
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        let escaped = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !escaped.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await;
        assert!(escaped.is_err(), "Git's descendant survived cancellation");
    }

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
    async fn a_worktree_location_is_used_and_earlier_worktrees_stay_found() {
        let dir = TempDir::new();
        let repo = repo(dir.path()).await;
        let earlier = create_worktree(&repo, "before", &WorktreeOptions::default())
            .await
            .unwrap();
        let elsewhere = WorktreeOptions {
            directory: Some(dir.path().join("elsewhere")),
            ..WorktreeOptions::default()
        };
        let made = create_worktree(&repo, "fresh", &elsewhere).await.unwrap();
        assert_eq!(
            Path::new(&made.path),
            dir.path().join("elsewhere/project/fresh")
        );
        let kept = create_worktree(&repo, "before", &elsewhere).await.unwrap();
        assert_eq!(
            crate::util::canonicalize(Path::new(&kept.path)).unwrap(),
            crate::util::canonicalize(Path::new(&earlier.path)).unwrap()
        );
        let relative = WorktreeOptions {
            directory: Some(PathBuf::from("not/absolute")),
            ..WorktreeOptions::default()
        };
        assert!(create_worktree(&repo, "other", &relative).await.is_err());
    }

    #[tokio::test]
    async fn worktree_is_a_sibling_and_diff_sees_tracked_and_untracked() {
        let dir = TempDir::new();
        let repo = repo(dir.path()).await;
        let worktree = create_worktree(&repo, "fix-bug", &WorktreeOptions::default())
            .await
            .unwrap();
        let path = PathBuf::from(&worktree.path);
        assert_eq!(path, dir.path().join("project-wt").join("fix-bug"));
        assert_eq!(worktree.branch, "feat/fix-bug");
        let again = create_worktree(&repo, "fix-bug", &WorktreeOptions::default())
            .await
            .unwrap();
        assert_eq!(again, worktree, "a registered worktree is reused");

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
