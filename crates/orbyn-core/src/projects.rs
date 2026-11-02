//! A project is any folder the person points at, registered where it is, or one
//! Orbyn clones or creates, by default at `<workspace>/repo/<slug>`. Registering
//! writes nothing into the folder, and only a folder Orbyn made can ever be deleted.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use orbyn_contracts::{CloneJob, CloneState, Project, ProjectRemoval};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::git::{git, is_git_repo, linked_worktrees, text};
use crate::store::{AuditRecord, NewProject};
use crate::util::{canonicalize, new_id, now};
use crate::workspace::{ProjectRoot, guard_library, resolve_project};

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

/// The last segment of a clone URL or local path, without `.git`. A local path on
/// Windows uses backslashes and a drive letter.
fn name_from_url(url: &str) -> Option<&str> {
    let trimmed = url.trim_end_matches(['/', '\\']);
    let last = trimmed.rsplit(['/', '\\', ':']).next()?;
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

const MAX_PROJECT_NAME: usize = 120;

impl Core {
    /// Sets up the workspace and registers the library as a project of its own,
    /// which is how a thread is explicitly opened on it.
    pub async fn setup_workspace(
        &self,
        request: orbyn_contracts::WorkspaceSetup,
    ) -> Result<orbyn_contracts::WorkspaceStatus> {
        let before = self.workspace.root().ok();
        self.workspace.setup(request).await?;
        let root = self.workspace.root()?;
        if let Some(old) = before.filter(|old| *old != root) {
            self.drop_unused_library_project(&old)?;
        }
        self.ensure_library_project()?;
        let projects = self.store.list_projects()?;
        self.workspace.status(&projects).await
    }

    /// The library is a project of its own, from startup on, and only once.
    pub fn ensure_library_project(&self) -> Result<()> {
        let root = self.workspace.root()?;
        let path = root.to_string_lossy();
        if self.store.list_projects()?.iter().any(|p| p.path == path) {
            return Ok(());
        }
        self.register_project(
            &ProjectRoot {
                is_git: is_git_repo(&root),
                path: root,
            },
            "Skills library",
            false,
        )?;
        Ok(())
    }

    /// A library left behind stays a project only if a thread still lives there.
    fn drop_unused_library_project(&self, old: &Path) -> Result<()> {
        let path = old.to_string_lossy();
        let projects = self.store.list_projects()?;
        let Some(project) = projects.iter().find(|p| p.path == path) else {
            return Ok(());
        };
        let live = self.store.list_threads(Some(&project.id), false)?;
        let archived = self.store.list_threads(Some(&project.id), true)?;
        if live.is_empty() && archived.is_empty() {
            self.store.delete_project(&project.id)?;
        }
        Ok(())
    }

    /// Where a new project goes: the folder asked for, which must not hold anything
    /// yet, or the next free slug under `repo/`.
    async fn slot(&self, name: &str, chosen: Option<&str>) -> Result<(String, PathBuf)> {
        if let Some(chosen) = chosen {
            let chosen = Path::new(chosen);
            let (Some(parent), Some(leaf), true) =
                (chosen.parent(), chosen.file_name(), chosen.is_absolute())
            else {
                return Err(CoreError::Invalid("Choose an absolute folder path.".into()));
            };
            let parent = canonicalize(parent)
                .map_err(|_| CoreError::Invalid(format!("{} does not exist.", parent.display())))?;
            let path = parent.join(leaf);
            guard_library(&self.workspace.root()?, &path)?;
            let occupied = std::fs::read_dir(&path).is_ok_and(|mut items| items.next().is_some())
                || path.is_file()
                || std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink());
            if occupied {
                return Err(CoreError::Invalid(format!(
                    "{} is not empty.",
                    path.display()
                )));
            }
            return Ok((slug_of(&leaf.to_string_lossy())?, path));
        }
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

    async fn adopt_staged(&self, staging: &Path, path: &Path, slug: &str) -> Result<Project> {
        // An empty chosen folder gives way to the finished clone.
        if path.is_dir() {
            std::fs::remove_dir(path)?;
        }
        std::fs::rename(staging, path)?;
        let resolved = resolve_project(&self.workspace.root()?, path).await?;
        self.register_project(&resolved, slug, true)
    }

    fn register_project(
        &self,
        project: &ProjectRoot,
        name: &str,
        managed: bool,
    ) -> Result<Project> {
        self.store.add_project(NewProject {
            path: &project.path.to_string_lossy(),
            name,
            is_git: project.is_git,
            managed,
            scratch: false,
        })
    }

    /// Registers an existing folder where it is. It starts untrusted, and nothing
    /// is cloned, moved, copied or written. A folder already registered is refused
    /// by its real path, so a symlink to it cannot make a second project.
    /// Only the name Orbyn shows changes. The folder stays where it is.
    pub fn rename_project(&self, id: &str, name: &str) -> Result<Project> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > MAX_PROJECT_NAME {
            return Err(CoreError::Invalid(format!(
                "A project name is 1 to {MAX_PROJECT_NAME} characters."
            )));
        }
        self.store.rename_project(id, name)
    }

    pub async fn add_project(&self, path: &str) -> Result<Project> {
        let root = self.workspace.root()?;
        let resolved = resolve_project(&root, Path::new(path)).await?;
        let known = self.store.list_projects()?;
        let existing = known.iter().find(|project| {
            canonicalize(Path::new(&project.path)).is_ok_and(|real| real == resolved.path)
        });
        if let Some(existing) = existing {
            return Err(CoreError::ProjectExists(Box::new(existing.clone())));
        }
        let name = resolved.path.file_name().map_or_else(
            || "Project".to_owned(),
            |name| name.to_string_lossy().into_owned(),
        );
        let text = resolved.path.to_string_lossy().into_owned();
        self.audit_project("project.add", &text, json!({ "is_git": resolved.is_git }))?;
        self.register_project(&resolved, &name, false)
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

    pub async fn clone_project(
        &self,
        url: &str,
        name: Option<&str>,
        path: Option<&str>,
    ) -> Result<Project> {
        self.clone_into_workspace(url, name, path)
            .await
            .map(|(project, _)| project)
    }

    /// Clones into a staging folder that removes itself if this future is dropped,
    /// which is how a cancel leaves nothing behind. An SSH URL the server refuses
    /// is tried once over HTTPS.
    async fn clone_into_workspace(
        &self,
        url: &str,
        name: Option<&str>,
        chosen: Option<&str>,
    ) -> Result<(Project, bool)> {
        if url.starts_with('-') || url.trim().is_empty() {
            return Err(CoreError::Invalid("That URL is not valid.".into()));
        }
        let name = name
            .or_else(|| name_from_url(url))
            .ok_or_else(|| CoreError::Invalid("Name this project.".into()))?;
        let (slug, path) = self.slot(name, chosen).await?;
        // Beside the destination, so finishing is a rename on one filesystem.
        let repo_dir = path
            .parent()
            .ok_or_else(|| CoreError::Invalid("Choose a folder.".into()))?
            .to_path_buf();
        std::fs::create_dir_all(&repo_dir)?;
        let staging = Staging(repo_dir.join(format!(".incoming-{}", new_id())));
        self.audit_project("project.clone", url, json!({ "slug": slug }))?;
        let mut used_https = false;
        let mut cloned = clone_to(&repo_dir, url, &staging.0).await;
        if let (Err(error), Some(https)) = (&cloned, https_url(url))
            && ssh_refused(&error.to_string())
        {
            let _ = std::fs::remove_dir_all(&staging.0);
            cloned = clone_to(&repo_dir, &https, &staging.0).await;
            used_https = cloned.is_ok();
        }
        cloned?;
        let project = self.adopt_staged(&staging.0, &path, &slug).await?;
        Ok((project, used_https))
    }

    pub fn clone_jobs(&self) -> Vec<CloneJob> {
        self.clones.list()
    }

    /// Starts a clone and returns at once. Its job reports how it went.
    pub fn start_clone(
        self: &Arc<Self>,
        url: &str,
        name: Option<&str>,
        path: Option<&str>,
    ) -> Result<CloneJob> {
        if url.starts_with('-') || url.trim().is_empty() {
            return Err(CoreError::Invalid("That URL is not valid.".into()));
        }
        let job = CloneJob {
            id: new_id(),
            url: url.to_owned(),
            name: name.map(str::to_owned),
            path: path.map(str::to_owned),
            state: CloneState::Running,
            project: None,
            error: None,
            used_https: false,
            started_at: now(),
        };
        self.run_clone(job.clone());
        Ok(job)
    }

    fn run_clone(self: &Arc<Self>, job: CloneJob) {
        let stop = CancellationToken::new();
        self.clones.keep(job.clone(), stop.clone());
        let core = self.clone();
        tokio::spawn(async move {
            let work =
                core.clone_into_workspace(&job.url, job.name.as_deref(), job.path.as_deref());
            let outcome = tokio::select! {
                () = stop.cancelled() => None,
                outcome = work => Some(outcome),
            };
            core.clones.finish(&job.id, outcome);
        });
    }

    pub fn cancel_clone(&self, id: &str) -> Result<()> {
        self.clones.cancel(id)
    }

    /// Runs a failed or cancelled clone again under the same job.
    pub fn retry_clone(self: &Arc<Self>, id: &str) -> Result<CloneJob> {
        let mut job = self.clones.job(id)?;
        if job.state == CloneState::Running || job.state == CloneState::Done {
            return Err(CoreError::Invalid("This clone cannot be retried.".into()));
        }
        job.state = CloneState::Running;
        job.error = None;
        job.started_at = now();
        self.run_clone(job.clone());
        Ok(job)
    }

    /// Starts an empty repository, with a README and first commit when asked.
    pub async fn new_project(
        &self,
        name: &str,
        readme: bool,
        chosen: Option<&str>,
    ) -> Result<Project> {
        let (slug, path) = self.slot(name, chosen).await?;
        let path_text = path.to_string_lossy().into_owned();
        self.audit_project("project.create", &slug, serde_json::Value::Null)?;
        let parent = path
            .parent()
            .ok_or_else(|| CoreError::Invalid("Choose a folder.".into()))?;
        std::fs::create_dir_all(parent)?;
        git(parent, &["init", "--quiet", "-b", "main", &path_text]).await?;
        let root = self.workspace.root()?;
        let resolved = resolve_project(&root, &path).await?;
        if readme {
            std::fs::write(path.join("README.md"), format!("# {name}\n"))?;
            git(&path, &["add", "README.md"]).await?;
            // With no Git identity the file still stands, and the person commits it.
            if let Err(error) = git(&path, &["commit", "-q", "-m", "Initial commit"]).await {
                tracing::debug!(%error, "could not make the first commit");
            }
        }
        self.register_project(&resolved, &slug, true)
    }

    /// Forgets a project and its threads. The folder stays, always, unless Orbyn
    /// made it, `delete_files` asks, and it holds nothing to lose. Dirty or unpushed
    /// work then needs `confirm`, and even that only keeps the folder.
    pub async fn remove_project(
        &self,
        id: &str,
        confirm: bool,
        delete_files: bool,
    ) -> Result<ProjectRemoval> {
        let project = self.store.project(id)?;
        let path = PathBuf::from(&project.path);
        if self.workspace.root().is_ok_and(|root| root == path) {
            return Err(CoreError::Invalid(
                "The skills library cannot be removed.".into(),
            ));
        }
        if delete_files && !project.managed {
            return Err(CoreError::Invalid(
                "Orbyn did not create this folder, so it can only be removed from the list.".into(),
            ));
        }
        let threads = self.store.list_all_threads(id)?;
        if threads.iter().any(|thread| thread.active_run.is_some()) {
            return Err(CoreError::ThreadBusy);
        }
        let git_ok = delete_files && path.exists() && is_git_repo(&path);
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
        if delete_files && !confirm && !(dirty.is_empty() && unpushed.is_empty()) {
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
            json!({ "confirmed": confirm, "delete_files": delete_files }),
        )?;
        // A deleted family's descendants may still appear later in this list.
        let mut deleted_threads = HashSet::new();
        for thread in threads {
            if deleted_threads.contains(&thread.id) {
                continue;
            }
            for deleted in self.store.delete_thread(&thread.id, "user")? {
                if deleted_threads.insert(deleted.clone()) {
                    self.setups.forget(&deleted);
                    self.terminals.close(&deleted);
                }
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

/// A clone's temporary folder. Dropping it removes whatever is still there, so a
/// cancelled clone leaves nothing; after a rename nothing is there to remove.
struct Staging(PathBuf);

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn clone_to(repo_dir: &Path, url: &str, target: &Path) -> Result<()> {
    let target = target.to_string_lossy().into_owned();
    git(
        repo_dir,
        &[
            "-c",
            "core.symlinks=true",
            "-c",
            "protocol.ext.allow=never",
            "clone",
            "--",
            url,
            &target,
        ],
    )
    .await
    .map(|_| ())
}

/// `git@host:a/b.git` and `ssh://git@host/a/b.git` as an HTTPS URL.
fn https_url(url: &str) -> Option<String> {
    if let Some(rest) = url.strip_prefix("ssh://") {
        let rest = rest.split_once('@').map_or(rest, |(_, rest)| rest);
        let (host, path) = rest.split_once('/')?;
        let host = host.split(':').next()?;
        return Some(format!("https://{host}/{path}"));
    }
    let (user, rest) = url.split_once('@')?;
    if user.contains('/') || user.contains(':') {
        return None;
    }
    let (host, path) = rest.split_once(':')?;
    Some(format!("https://{host}/{path}"))
}

fn ssh_refused(message: &str) -> bool {
    [
        "Permission denied",
        "publickey",
        "Could not read from remote",
        "Host key verification failed",
        "Connection refused",
    ]
    .iter()
    .any(|sign| message.contains(sign))
}

/// Background clones this process started.
#[derive(Default)]
pub struct ClonePool {
    jobs: Mutex<HashMap<String, (CloneJob, CancellationToken)>>,
}

impl ClonePool {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, (CloneJob, CancellationToken)>> {
        self.jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn keep(&self, job: CloneJob, stop: CancellationToken) {
        self.lock().insert(job.id.clone(), (job, stop));
    }

    fn list(&self) -> Vec<CloneJob> {
        let mut jobs: Vec<CloneJob> = self.lock().values().map(|(job, _)| job.clone()).collect();
        jobs.sort_by(|a, b| a.started_at.cmp(&b.started_at));
        jobs
    }

    fn job(&self, id: &str) -> Result<CloneJob> {
        self.lock()
            .get(id)
            .map(|(job, _)| job.clone())
            .ok_or_else(|| CoreError::NotFound("clone".into()))
    }

    fn cancel(&self, id: &str) -> Result<()> {
        let jobs = self.lock();
        let (job, stop) = jobs
            .get(id)
            .ok_or_else(|| CoreError::NotFound("clone".into()))?;
        if job.state != CloneState::Running {
            return Err(CoreError::Invalid("This clone is not running.".into()));
        }
        stop.cancel();
        Ok(())
    }

    fn finish(&self, id: &str, outcome: Option<Result<(Project, bool)>>) {
        if let Some((job, _)) = self.lock().get_mut(id) {
            match outcome {
                None => job.state = CloneState::Cancelled,
                Some(Ok((project, used_https))) => {
                    job.state = CloneState::Done;
                    job.project = Some(project);
                    job.used_https = used_https;
                }
                Some(Err(error)) => {
                    job.state = CloneState::Failed;
                    job.error = Some(error.public_message());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
