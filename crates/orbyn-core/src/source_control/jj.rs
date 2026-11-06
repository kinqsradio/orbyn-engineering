//! Jujutsu checkouts that are not colocated with Git, read through the person's
//! installed `jj`. Orbyn ships no jj, links no jj library and writes nothing
//! itself; a missing `jj` is `422 unsupported`.
//!
//! Like any jj command, a read snapshots the working copy into jj's operation
//! log, so the caller checks folder trust first. Diffs use jj's built-in Git
//! format, so no configured diff tool runs, and the file monitor is turned off.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use orbyn_contracts::{FileDiff, JjStatus};
use tokio::process::Command;

use crate::error::{CoreError, Result};

/// Fields of the working-copy change, one per line so a description cannot
/// shift them. The description's first line comes last.
const TEMPLATE: &str = concat!(
    r#"change_id.short() ++ "\n" ++ commit_id.short() ++ "\n" ++ "#,
    r#"bookmarks.map(|b| b.name()).join(",") ++ "\n" ++ "#,
    r#"if(conflict, "1", "0") ++ "\n" ++ description.first_line() ++ "\n""#
);

/// The jj root at or above `path` but never above `project`, when it is a jj
/// checkout with no Git checkout of its own. A colocated checkout has `.git`
/// beside `.jj` and stays on Git. A project folder inside a larger jj repository
/// is not that repository: reading it would snapshot folders outside the project.
pub fn root(path: &Path, project: &Path) -> Option<PathBuf> {
    if !path.starts_with(project) {
        return None;
    }
    let mut current = Some(path);
    while let Some(dir) = current {
        if dir.join(".jj").is_dir() {
            return (!dir.join(".git").exists()).then(|| dir.to_path_buf());
        }
        if dir.join(".git").exists() || dir == project {
            return None;
        }
        current = dir.parent();
    }
    None
}

async fn jj(cwd: &Path, args: &[&str]) -> Result<String> {
    let resolved = crate::host::process::resolve("jj").ok_or_else(|| {
        CoreError::Unsupported("This is a Jujutsu checkout, and jj is not installed.".into())
    })?;
    let mut command = Command::new(&resolved.program);
    command
        .args(&resolved.prefix)
        .args([
            "--no-pager",
            "--color",
            "never",
            "--config",
            "fsmonitor.backend=none",
        ])
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::host::child_env::for_tool(command.as_std_mut());
    let output = crate::host::process::ManagedChild::spawn(command)
        .map_err(|error| CoreError::Git(format!("Could not run jj: {error}")))?
        .output()
        .await
        .map_err(|error| CoreError::Git(format!("Could not run jj: {error}")))?;
    if !output.status.success() {
        return Err(CoreError::Git(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The working-copy change and what it changes.
pub async fn status(root: &Path) -> Result<JjStatus> {
    let described = jj(root, &["log", "-r", "@", "--no-graph", "-T", TEMPLATE]).await?;
    let mut lines = described.lines();
    let mut field = || lines.next().unwrap_or_default().trim().to_owned();
    let change_id = field();
    let commit_id = field();
    let bookmarks = field();
    let conflict = field() == "1";
    let description = field();
    if change_id.is_empty() || commit_id.is_empty() {
        return Err(CoreError::Git(
            "jj did not describe the working copy.".into(),
        ));
    }
    let files = diff(root).await?;
    Ok(JjStatus {
        change_id,
        commit_id,
        bookmarks: bookmarks
            .split(',')
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect(),
        description,
        conflict,
        changed_files: u32::try_from(files.len()).unwrap_or(u32::MAX),
        additions: files.iter().map(|file| file.additions).sum(),
        deletions: files.iter().map(|file| file.deletions).sum(),
    })
}

/// The working-copy change against its parent, one entry per file.
pub async fn diff(root: &Path) -> Result<Vec<FileDiff>> {
    let patch = jj(root, &["diff", "--git", "-r", "@"]).await?;
    let mut files = split_git_patch(&patch);
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

/// Splits Git-format diff output into files. Paths come from the `---`/`+++`
/// lines, which jj writes unquoted, falling back to the header for renames and
/// mode-only changes.
fn split_git_patch(patch: &str) -> Vec<FileDiff> {
    let mut files = Vec::new();
    let mut current: Option<Vec<&str>> = None;
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            if let Some(lines) = current.take() {
                files.extend(file_of(&lines));
            }
            current = Some(Vec::new());
        }
        if let Some(lines) = current.as_mut() {
            lines.push(line);
        }
    }
    if let Some(lines) = current {
        files.extend(file_of(&lines));
    }
    files
}

fn file_of(lines: &[&str]) -> Option<FileDiff> {
    let header = lines.first()?.trim_end();
    let mut old = None;
    let mut new = None;
    let mut status = "modified";
    let mut additions = 0u32;
    let mut deletions = 0u32;
    let mut in_hunk = false;
    for line in &lines[1..] {
        let text = line.trim_end_matches(['\n', '\r']);
        if text.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        if in_hunk {
            if text.starts_with('+') {
                additions += 1;
            } else if text.starts_with('-') {
                deletions += 1;
            }
            continue;
        }
        if text.starts_with("new file mode") {
            status = "added";
        } else if text.starts_with("deleted file mode") {
            status = "deleted";
        } else if let Some(path) = text.strip_prefix("rename to ") {
            status = "renamed";
            new = Some(path.to_owned());
        } else if let Some(path) = text.strip_prefix("rename from ") {
            old = Some(path.to_owned());
        } else if let Some(path) = text.strip_prefix("--- ") {
            old = old.or_else(|| path.strip_prefix("a/").map(str::to_owned));
        } else if let Some(path) = text.strip_prefix("+++ ") {
            new = new.or_else(|| path.strip_prefix("b/").map(str::to_owned));
        }
    }
    let from_header = || {
        header
            .strip_prefix("diff --git a/")
            .and_then(|rest| rest.rsplit_once(" b/"))
            .map(|(_, path)| path.to_owned())
    };
    let path = new.or(old).or_else(from_header)?;
    Some(FileDiff {
        path,
        status: status.into(),
        additions,
        deletions,
        patch: lines.concat(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATCH: &str = "diff --git a/src/lib.rs b/src/lib.rs
index 1111111..2222222 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,2 +1,2 @@
-old line
+new line
 kept
diff --git a/notes.txt b/notes.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/notes.txt
@@ -0,0 +1,2 @@
+one
+--two
diff --git a/gone.md b/gone.md
deleted file mode 100644
index 4444444..0000000
--- a/gone.md
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/before.txt b/after.txt
rename from before.txt
rename to after.txt
";

    #[test]
    fn a_git_format_patch_splits_into_files_with_counts() {
        let files = split_git_patch(PATCH);
        let summary: Vec<_> = files
            .iter()
            .map(|file| {
                (
                    file.path.as_str(),
                    file.status.as_str(),
                    file.additions,
                    file.deletions,
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("src/lib.rs", "modified", 1, 1),
                ("notes.txt", "added", 2, 0),
                ("gone.md", "deleted", 0, 1),
                ("after.txt", "renamed", 0, 0),
            ]
        );
        assert!(files[0].patch.starts_with("diff --git a/src/lib.rs"));
        assert!(files[1].patch.ends_with("+--two\n"));
    }

    #[test]
    fn only_a_checkout_without_its_own_git_is_a_jj_root() {
        let dir = crate::testing::TempDir::new();
        let plain = dir.path().join("plain");
        let jj_only = dir.path().join("jj-only");
        let colocated = dir.path().join("colocated");
        for path in [&plain, &jj_only.join(".jj"), &colocated.join(".jj")] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::create_dir_all(colocated.join(".git")).unwrap();
        std::fs::create_dir_all(jj_only.join("src")).unwrap();
        assert_eq!(root(&plain, &plain), None);
        assert_eq!(root(&colocated, &colocated), None);
        assert_eq!(root(&jj_only, &jj_only), Some(jj_only.clone()));
        assert_eq!(root(&jj_only.join("src"), &jj_only), Some(jj_only.clone()));
    }

    #[test]
    fn a_project_inside_a_larger_jj_repository_is_not_that_repository() {
        let dir = crate::testing::TempDir::new();
        let parent = dir.path().join("home");
        let project = parent.join("projects").join("plain");
        std::fs::create_dir_all(parent.join(".jj")).unwrap();
        std::fs::create_dir_all(project.join("src")).unwrap();
        assert_eq!(root(&project, &project), None);
        assert_eq!(root(&project.join("src"), &project), None);
        assert_eq!(root(&parent, &project), None, "outside the project");
    }
}
