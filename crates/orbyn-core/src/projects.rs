//! Projects live at `<workspace>/repo/<slug>`, and only there. They arrive by
//! clone, by `git init`, or by import, which clones a local folder and leaves it
//! exactly as it was. Nothing here writes a file into a target.

use std::path::{Path, PathBuf};

use orbyn_contracts::{ImportReport, Project, ProjectRemoval};
use serde_json::json;

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::git::{git, is_git_repo, linked_worktrees, text};
use crate::store::AuditRecord;
use crate::util::{canonicalize, new_id};
use crate::workspace::check_target;

const WORKTREE_SUFFIX: &str = "-wt";

fn slug_of(name: &str) -> Result<String> {
    let lowered: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let slug = lowered.trim_matches(['-', '.']).to_owned();
    if slug.is_empty() || slug.len() > 64 || slug.ends_with(WORKTREE_SUFFIX) {
        return Err(CoreError::Invalid("Choose another project name.".into()));
    }
    Ok(slug)
}

/// The last path segment of a clone URL, without `.git`.
fn name_from_url(url: &str) -> Option<&str> {
    let trimmed = url.trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    (!name.is_empty()).then_some(name)
}

async fn strings(cwd: &Path, args: &[&str]) -> Result<Vec<String>> {
    let output = git(cwd, args).await?;
    Ok(String::from_utf8_lossy(&output)
        .lines()
        .map(str::to_owned)
        .collect())
}

/// Local branches with commits no remote has. `current` is left out when asked.
async fn unpushed_branches(repo: &Path, skip_current: bool) -> Result<Vec<String>> {
    let current = text(&git(repo, &["branch", "--show-current"]).await?);
    let mut found = Vec::new();
    for branch in strings(
        repo,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )
    .await?
    {
        if skip_current && branch == current {
            continue;
        }
        let range = ["rev-list", "--count", branch.as_str(), "--not", "--remotes"];
        if text(&git(repo, &range).await?) != "0" {
            found.push(branch);
        }
    }
    Ok(found)
}

impl Core {
    /// Sets up the workspace and registers the library as a project of its own,
    /// which is how a thread is explicitly opened on it.
    pub async fn setup_workspace(
        &self,
        request: orbyn_contracts::WorkspaceSetup,
    ) -> Result<orbyn_contracts::WorkspaceStatus> {
        self.workspace.setup(request).await?;
        let root = self.workspace.root()?;
        self.register_project(&root, "Skills library")?;
        let projects = self.store.list_projects()?;
        self.workspace.status(&projects).await
    }

    async fn slot(&self, name: &str) -> Result<(String, PathBuf)> {
        let repo = self.workspace.repo_dir()?;
        let slug = slug_of(name)?;
        let path = repo.join(&slug);
        if std::fs::symlink_metadata(&path).is_ok()
            || std::fs::symlink_metadata(repo.join(format!("{slug}{WORKTREE_SUFFIX}"))).is_ok()
        {
            return Err(CoreError::Invalid(format!("{slug} already exists.")));
        }
        Ok((slug, path))
    }

    /// Moves a finished staging checkout into place, then registers it. A
    /// failure removes only the staging folder this call made.
    async fn adopt_staged(&self, staging: &Path, path: &Path, slug: &str) -> Result<Project> {
        std::fs::rename(staging, path)?;
        let root = self.workspace.root()?;
        check_target(&root, path).await?;
        self.register_project(path, slug)
    }

    fn register_project(&self, path: &Path, name: &str) -> Result<Project> {
        self.store
            .add_project(&path.to_string_lossy(), name, is_git_repo(path))
    }

    fn audit_project(&self, action: &str, target: &str, detail: serde_json::Value) -> Result<()> {
        self.store.append_audit(&AuditRecord {
            actor: "user".into(),
            action: action.to_owned(),
            target: target.to_owned(),
            decision: None,
            source: "user".into(),
            thread_id: None,
            run_id: None,
            detail,
        })?;
        Ok(())
    }

    pub async fn clone_project(&self, url: &str, name: Option<&str>) -> Result<Project> {
        if url.starts_with('-') || url.trim().is_empty() {
            return Err(CoreError::Invalid("That URL is not valid.".into()));
        }
        let name = name
            .or_else(|| name_from_url(url))
            .ok_or_else(|| CoreError::Invalid("Name this project.".into()))?;
        let (slug, path) = self.slot(name).await?;
        let staging = self
            .workspace
            .repo_dir()?
            .join(format!(".incoming-{}", new_id()));
        let staging_text = staging.to_string_lossy().into_owned();
        self.audit_project("project.clone", url, json!({ "slug": slug }))?;
        let cloned = git(
            &self.workspace.repo_dir()?,
            &[
                "-c",
                "core.symlinks=true",
                "-c",
                "protocol.ext.allow=never",
                "clone",
                "--",
                url,
                &staging_text,
            ],
        )
        .await;
        if let Err(error) = cloned {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
        self.adopt_staged(&staging, &path, &slug).await
    }

    pub async fn new_project(&self, name: &str) -> Result<Project> {
        let (slug, path) = self.slot(name).await?;
        let path_text = path.to_string_lossy().into_owned();
        self.audit_project("project.create", &slug, serde_json::Value::Null)?;
        git(
            &self.workspace.repo_dir()?,
            &["init", "--quiet", "-b", "main", &path_text],
        )
        .await?;
        let root = self.workspace.root()?;
        check_target(&root, &path).await?;
        self.register_project(&path, &slug)
    }

    /// Clones a local folder into the workspace and keeps its origin URL. The
    /// source is only read. What the clone could not carry is reported.
    pub async fn import_project(&self, source: &str, name: Option<&str>) -> Result<ImportReport> {
        let source = Path::new(source);
        if !source.is_absolute() {
            return Err(CoreError::Invalid("Choose an absolute folder path.".into()));
        }
        let source = canonicalize(source)
            .map_err(|_| CoreError::Invalid(format!("{} does not exist.", source.display())))?;
        let root = self.workspace.root()?;
        if source.starts_with(&root) {
            return Err(CoreError::Invalid(
                "That folder is already in the workspace.".into(),
            ));
        }
        let top = git(&source, &["rev-parse", "--show-toplevel"])
            .await
            .map_err(|_| CoreError::Invalid("Choose a Git repository to import.".into()))?;
        if canonicalize(Path::new(&text(&top)))? != source {
            return Err(CoreError::Invalid(
                "Choose the repository's root folder.".into(),
            ));
        }
        let fallback = source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (slug, path) = self.slot(name.unwrap_or(&fallback)).await?;
        let dirty_files = strings(&source, &["status", "--porcelain"]).await?;
        let unpushed = unpushed_branches(&source, true).await?;
        let origin = git(&source, &["remote", "get-url", "origin"])
            .await
            .ok()
            .map(|url| text(&url));
        let source_text = source.to_string_lossy().into_owned();
        self.audit_project("project.import", &source_text, json!({ "slug": slug }))?;

        let staging = self
            .workspace
            .repo_dir()?
            .join(format!(".incoming-{}", new_id()));
        let staging_text = staging.to_string_lossy().into_owned();
        let prepared = async {
            git(
                &self.workspace.repo_dir()?,
                &[
                    "-c",
                    "core.symlinks=true",
                    "clone",
                    "--no-hardlinks",
                    "--",
                    &source_text,
                    &staging_text,
                ],
            )
            .await?;
            // The clone's origin is the source folder. Point it where the source
            // does, and drop tracking refs that described the folder, not the remote.
            match &origin {
                Some(url) => {
                    git(&staging, &["remote", "set-url", "origin", url]).await?;
                }
                None => {
                    git(&staging, &["remote", "remove", "origin"]).await?;
                }
            }
            for reference in strings(
                &staging,
                &["for-each-ref", "--format=%(refname)", "refs/remotes"],
            )
            .await?
            {
                git(&staging, &["update-ref", "-d", &reference]).await?;
            }
            Ok::<_, CoreError>(())
        }
        .await;
        if let Err(error) = prepared {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
        let project = self.adopt_staged(&staging, &path, &slug).await?;
        Ok(ImportReport {
            project,
            dirty_files,
            unpushed_branches: unpushed,
        })
    }

    /// Removes a project from the app. Its files go only when they hold nothing
    /// to lose; anything else stays on disk and is reported. Nothing is force-cleaned.
    pub async fn remove_project(&self, id: &str, confirm: bool) -> Result<ProjectRemoval> {
        let project = self.store.project(id)?;
        let path = PathBuf::from(&project.path);
        if self.workspace.root().is_ok_and(|root| root == path) {
            return Err(CoreError::Invalid(
                "The skills library cannot be removed.".into(),
            ));
        }
        let threads = self.store.list_all_threads(id)?;
        if threads.iter().any(|thread| thread.active_run.is_some()) {
            return Err(CoreError::ThreadBusy);
        }
        let git_ok = path.exists() && is_git_repo(&path);
        let dirty = if git_ok {
            strings(&path, &["status", "--porcelain"]).await?
        } else {
            Vec::new()
        };
        let unpushed = if git_ok {
            unpushed_branches(&path, false).await?
        } else {
            Vec::new()
        };
        if !confirm && !(dirty.is_empty() && unpushed.is_empty()) {
            return Err(CoreError::ProjectHasWork {
                message: "This project has unsaved work. Confirm to remove it from Orbyn.".into(),
                detail: json!({ "dirty_files": dirty, "unpushed_branches": unpushed }),
            });
        }
        let ignored = if git_ok {
            strings(&path, &["status", "--porcelain", "--ignored"]).await?
        } else {
            Vec::new()
        };
        let worktrees = if git_ok {
            linked_worktrees(&path).await?
        } else {
            Vec::new()
        };
        self.audit_project(
            "project.remove",
            &project.path,
            json!({ "confirmed": confirm }),
        )?;
        for thread in threads {
            for deleted in self.store.delete_thread(&thread.id, "user")? {
                self.terminals.close(&deleted);
            }
        }
        self.store.delete_project(id)?;
        let holds_work = !(dirty.is_empty() && unpushed.is_empty() && ignored.is_empty())
            || !worktrees.is_empty()
            || !git_ok;
        if holds_work || self.workspace.root().is_err() {
            return Ok(ProjectRemoval {
                files_removed: false,
                kept_path: Some(project.path),
            });
        }
        std::fs::remove_dir_all(&path)?;
        Ok(ProjectRemoval {
            files_removed: true,
            kept_path: None,
        })
    }
}

#[cfg(test)]
mod tests;
