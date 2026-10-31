//! The one managed workspace: a library checkout whose ignored `repo/` holds every
//! target. Boundary checks use Git metadata only; nothing here runs project code,
//! and no file is ever written into a target. Library updates are fast-forward only
//! and happen only when asked for.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use orbyn_contracts::{
    IncomingCommit, LibraryStatus, LibraryUpdateResult, TargetStatus, TargetWorktree,
    WorkspaceSetup, WorkspaceStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{CoreError, Result};
use crate::git::{git, git_raw, linked_worktrees, text};
use crate::store::{AuditRecord, Store};
use crate::util::{canonicalize, new_id};

pub const DEFAULT_LIBRARY_URL: &str = "https://github.com/kinqsradio/orbyn-fullstack-skills";
const STATE_KEY: &str = "workspace";
const INSTRUCTIONS: &[&str] = &[
    "AGENTS.md",
    "AGENT.md",
    "CLAUDE.md",
    ".cursorrules",
    "codex.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
];
const HOSTS: &[&str] = &[".agents", ".claude", ".cursor"];
/// Skill link directories that must materialize for native discovery.
const LINK_ROOTS: &[&str] = &[".claude/skills", ".agents/skills"];
const CLONE_SYMLINKS: &str = "core.symlinks=true";

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Rollback {
    from: String,
    to: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct WorkspaceState {
    root: PathBuf,
    adopted: bool,
    url: Option<String>,
    rollback: Option<Rollback>,
}

pub struct Workspace {
    store: Arc<Store>,
    data_dir: PathBuf,
    default_url: String,
    state: RwLock<Option<WorkspaceState>>,
    /// True while the library is moving. Admission takes this lock too, so a run
    /// and an update can never slip past each other's check.
    moving: Mutex<bool>,
}

fn refused(message: impl Into<String>) -> CoreError {
    CoreError::WorkspaceRefused(message.into())
}

/// Refuses a path with a symlink anywhere along it.
pub fn real_path(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(refused("Use an absolute path."));
    }
    let mut walked = PathBuf::new();
    for part in path.components() {
        walked.push(part);
        if std::fs::symlink_metadata(&walked).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(refused(format!(
                "{} is a symlink, which is not supported here.",
                walked.display()
            )));
        }
    }
    canonicalize(path).map_err(|_| refused(format!("{} does not exist.", path.display())))
}

async fn is_ignored(root: &Path, relative: &str) -> Result<bool> {
    let output = git_raw(
        root,
        &["check-ignore", "--no-index", "--quiet", "--", relative],
    )
    .await?;
    Ok(output.status.success())
}

async fn top_level(path: &Path) -> Result<PathBuf> {
    let root = git(path, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(|_| refused(format!("{} is not a Git checkout.", path.display())))?;
    canonicalize(Path::new(&text(&root))).map_err(Into::into)
}

/// The library boundary: a real Git root with its catalog, policy and an ignored,
/// untracked `repo/`.
pub async fn validate_library(path: &Path) -> Result<PathBuf> {
    let root = real_path(path)?;
    if top_level(&root).await? != root {
        return Err(refused("Choose the library's Git root."));
    }
    if !root.join("skills/catalog.json").is_file() || !root.join("AGENTS.md").is_file() {
        return Err(refused("That folder is not a complete skills library."));
    }
    let repo = root.join("repo");
    if let Ok(meta) = std::fs::symlink_metadata(&repo)
        && !meta.is_dir()
    {
        return Err(refused("repo/ must be a real directory."));
    }
    if !git(&root, &["ls-files", "-z", "--", "repo"])
        .await?
        .is_empty()
    {
        return Err(refused("The library must not track anything under repo/."));
    }
    if !is_ignored(&root, "repo/__workspace_probe__/file").await? {
        return Err(refused("The library must ignore repo/."));
    }
    Ok(root)
}

/// The target boundary. Refuses external paths, the `repo/` folder itself, a
/// subdirectory or ancestor of a Git root, and a linked worktree whose common Git
/// directory lies outside the workspace.
pub async fn check_target(root: &Path, target: &Path) -> Result<PathBuf> {
    let repo = root.join("repo");
    let target = real_path(target)?;
    if target == repo || !target.starts_with(&repo) {
        return Err(refused(
            "Projects live under the workspace's repo/ folder. Import this folder instead.",
        ));
    }
    if top_level(&target).await? != target {
        return Err(refused("Choose the project's Git root."));
    }
    let common = git(
        &target,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await?;
    let common = canonicalize(Path::new(&text(&common)))?;
    if !common.starts_with(&repo) {
        return Err(refused(
            "This checkout's Git data is outside the workspace.",
        ));
    }
    let relative = target
        .strip_prefix(root)
        .map_err(|error| CoreError::Internal(error.to_string()))?
        .to_string_lossy()
        .replace('\\', "/");
    if !is_ignored(root, &relative).await? {
        return Err(refused("The library's ignore rules expose this checkout."));
    }
    Ok(target)
}

/// True when every skill entry under the host link roots is a real link. Windows
/// without Developer Mode leaves plain text files instead.
pub fn native_skills_available(root: &Path) -> bool {
    LINK_ROOTS.iter().all(|links| {
        let Ok(entries) = std::fs::read_dir(root.join(links)) else {
            return false;
        };
        let mut seen = false;
        for entry in entries.flatten() {
            seen = true;
            let is_link = entry.file_type().is_ok_and(|kind| kind.is_symlink());
            if !is_link || !entry.path().join("SKILL.md").is_file() {
                return false;
            }
        }
        seen
    })
}

async fn head(root: &Path) -> Result<String> {
    Ok(text(&git(root, &["rev-parse", "HEAD"]).await?))
}

async fn dirty_files(root: &Path) -> Result<Vec<String>> {
    let status = git(root, &["status", "--porcelain"]).await?;
    Ok(String::from_utf8_lossy(&status)
        .lines()
        .map(str::to_owned)
        .collect())
}

async fn branch_of(root: &Path) -> Option<String> {
    let name = git(root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .await
        .ok()?;
    Some(text(&name))
}

async fn upstream_of(root: &Path) -> Option<String> {
    let name = git(root, &["rev-parse", "--abbrev-ref", "@{upstream}"])
        .await
        .ok()?;
    Some(text(&name))
}

async fn ahead_behind(root: &Path) -> Result<(u32, u32)> {
    let counts = git(
        root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )
    .await?;
    let counts = text(&counts);
    let mut parts = counts.split_whitespace().map(|n| n.parse().unwrap_or(0));
    Ok((parts.next().unwrap_or(0), parts.next().unwrap_or(0)))
}

async fn incoming(root: &Path) -> Result<Vec<IncomingCommit>> {
    let log = git(root, &["log", "--format=%H%x09%s", "HEAD..@{upstream}"]).await?;
    Ok(String::from_utf8_lossy(&log)
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(sha, subject)| IncomingCommit {
            sha: sha.to_owned(),
            subject: subject.to_owned(),
        })
        .collect())
}

impl Workspace {
    pub fn new(store: Arc<Store>, data_dir: PathBuf, default_url: String) -> Result<Self> {
        let state = store
            .setting(STATE_KEY)?
            .and_then(|text| serde_json::from_str(&text).ok());
        Ok(Self {
            store,
            data_dir,
            default_url,
            state: RwLock::new(state),
            moving: Mutex::new(false),
        })
    }

    fn current(&self) -> Option<WorkspaceState> {
        self.state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn save(&self, state: WorkspaceState) -> Result<()> {
        self.store
            .set_setting(STATE_KEY, &serde_json::to_string(&state)?)?;
        *self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(state);
        Ok(())
    }

    pub fn root(&self) -> Result<PathBuf> {
        self.current()
            .map(|state| state.root)
            .ok_or(CoreError::WorkspaceRequired)
    }

    pub fn repo_dir(&self) -> Result<PathBuf> {
        Ok(self.root()?.join("repo"))
    }

    fn audit(&self, action: &str, target: &str, detail: Value) -> Result<()> {
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

    /// Clones the library, or adopts a checkout the user chose. Adoption leaves
    /// the checkout where it is and only ensures its ignored `repo/` exists.
    pub async fn setup(&self, request: WorkspaceSetup) -> Result<WorkspaceStatus> {
        if self.current().is_some() {
            return Err(CoreError::Invalid(
                "The workspace is already set up.".into(),
            ));
        }
        let state = match (request.url, request.adopt_path) {
            (Some(_), Some(_)) => {
                return Err(CoreError::Invalid(
                    "Choose a URL or a folder, not both.".into(),
                ));
            }
            (_, Some(path)) => {
                let root = validate_library(Path::new(&path)).await?;
                WorkspaceState {
                    root,
                    adopted: true,
                    url: None,
                    rollback: None,
                }
            }
            (url, None) => {
                let url = url.unwrap_or_else(|| self.default_url.clone());
                self.clone_library(&url).await?
            }
        };
        std::fs::create_dir_all(state.root.join("repo"))?;
        // Recheck: a concurrent writer could have changed the boundary.
        validate_library(&state.root).await?;
        self.audit(
            "workspace.setup",
            &state.root.to_string_lossy(),
            json!({ "adopted": state.adopted, "url": state.url }),
        )?;
        self.save(state)?;
        self.status(&[]).await
    }

    async fn clone_library(&self, url: &str) -> Result<WorkspaceState> {
        if url.starts_with('-') {
            return Err(CoreError::Invalid("That URL is not valid.".into()));
        }
        let data = canonicalize(&self.data_dir)?;
        let root = data.join("workspace");
        if root.exists() {
            return Err(CoreError::Invalid(format!(
                "{} already exists.",
                root.display()
            )));
        }
        let staging = data.join(format!(".workspace-{}", new_id()));
        let staging_text = staging.to_string_lossy().into_owned();
        let cloned = git(
            &data,
            &["-c", CLONE_SYMLINKS, "clone", "--", url, &staging_text],
        )
        .await;
        let checked = match cloned {
            Ok(_) => validate_library(&staging).await.map(|_| ()),
            Err(error) => Err(error),
        };
        if let Err(error) = checked {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
        std::fs::rename(&staging, &root)?;
        Ok(WorkspaceState {
            root,
            adopted: false,
            url: Some(url.to_owned()),
            rollback: None,
        })
    }

    /// Reads the library's identity for prompts and the skills view.
    pub async fn identity(&self) -> Result<(String, bool)> {
        let root = self.root()?;
        let dirty = !dirty_files(&root).await?.is_empty();
        Ok((head(&root).await?, dirty))
    }

    /// Runs `admit` while the library cannot start moving.
    pub fn admit_with<T>(&self, admit: impl FnOnce() -> Result<T>) -> Result<T> {
        let moving = self.moving_lock();
        if *moving {
            return Err(CoreError::RunsActive);
        }
        admit()
    }

    fn moving_lock(&self) -> std::sync::MutexGuard<'_, bool> {
        self.moving
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Takes the library for a move: refuses local edits and any active run.
    async fn begin_move(&self, root: &Path) -> Result<MoveGuard<'_>> {
        if !dirty_files(root).await?.is_empty() {
            return Err(CoreError::LibraryDirty(
                "The library has local edits. Commit or move them first.".into(),
            ));
        }
        let mut moving = self.moving_lock();
        if *moving || !self.store.active_runs()?.is_empty() {
            return Err(CoreError::RunsActive);
        }
        *moving = true;
        Ok(MoveGuard { workspace: self })
    }

    /// Fetches only: the merge is a separate, explicit step.
    pub async fn fetch(&self) -> Result<Vec<IncomingCommit>> {
        let root = self.root()?;
        git(&root, &["fetch", "--quiet", "--no-recurse-submodules"]).await?;
        incoming(&root).await
    }

    /// The library's position against what was last fetched, without a fetch.
    pub async fn local_position(&self) -> Result<(u32, u32, Vec<IncomingCommit>)> {
        let root = self.root()?;
        if upstream_of(&root).await.is_none() {
            return Ok((0, 0, Vec::new()));
        }
        let (ahead, behind) = ahead_behind(&root).await?;
        Ok((ahead, behind, incoming(&root).await?))
    }

    /// Fetches, and with `apply` fast-forwards. Local edits are never touched.
    pub async fn update(&self, apply: bool) -> Result<LibraryUpdateResult> {
        let root = self.root()?;
        let pending = self.fetch().await?;
        let revision = head(&root).await?;
        if !apply || pending.is_empty() {
            return Ok(LibraryUpdateResult {
                applied: false,
                previous_revision: None,
                revision,
                incoming: pending,
            });
        }
        let _guard = self.begin_move(&root).await?;
        let (ahead, _) = ahead_behind(&root).await?;
        if ahead > 0 {
            return Err(CoreError::NotFastForward(
                "The library has its own commits, so it cannot fast-forward.".into(),
            ));
        }
        self.audit(
            "workspace.update",
            &root.to_string_lossy(),
            json!({ "from": revision, "incoming": pending.len() }),
        )?;
        git(&root, &["merge", "--ff-only", "--quiet", "@{upstream}"]).await?;
        let updated = head(&root).await?;
        self.audit(
            "workspace.update.result",
            &root.to_string_lossy(),
            json!({ "to": updated }),
        )?;
        if let Some(mut state) = self.current() {
            state.rollback = Some(Rollback {
                from: revision.clone(),
                to: updated.clone(),
            });
            self.save(state)?;
        }
        Ok(LibraryUpdateResult {
            applied: true,
            previous_revision: Some(revision),
            revision: updated,
            incoming: pending,
        })
    }

    /// Returns to the revision before the last update, only from exactly where
    /// that update left the library. `reset --keep` refuses to lose local work.
    pub async fn rollback(&self) -> Result<LibraryUpdateResult> {
        let root = self.root()?;
        let state = self.current().ok_or(CoreError::WorkspaceRequired)?;
        let rollback = state
            .rollback
            .clone()
            .ok_or_else(|| CoreError::Invalid("There is no update to roll back.".into()))?;
        let _guard = self.begin_move(&root).await?;
        let revision = head(&root).await?;
        if revision != rollback.to {
            return Err(CoreError::NotFastForward(
                "The library moved since that update, so rolling back could lose work.".into(),
            ));
        }
        self.audit(
            "workspace.rollback",
            &root.to_string_lossy(),
            json!({ "from": revision, "to": rollback.from }),
        )?;
        git(&root, &["reset", "--keep", "--quiet", &rollback.from]).await?;
        let mut state = state;
        state.rollback = None;
        self.save(state)?;
        Ok(LibraryUpdateResult {
            applied: true,
            previous_revision: Some(revision),
            revision: rollback.from,
            incoming: Vec::new(),
        })
    }

    pub async fn status(&self, projects: &[orbyn_contracts::Project]) -> Result<WorkspaceStatus> {
        let Some(state) = self.current() else {
            return Ok(WorkspaceStatus {
                configured: false,
                default_url: self.default_url.clone(),
                library: None,
                targets: Vec::new(),
            });
        };
        let library = library_status(&state).await;
        let mut targets = Vec::new();
        for project in projects {
            if Path::new(&project.path) != state.root {
                targets.push(target_status(&state.root, project).await);
            }
        }
        Ok(WorkspaceStatus {
            configured: true,
            default_url: self.default_url.clone(),
            library: Some(library),
            targets,
        })
    }
}

struct MoveGuard<'a> {
    workspace: &'a Workspace,
}

impl Drop for MoveGuard<'_> {
    fn drop(&mut self) {
        *self.workspace.moving_lock() = false;
    }
}

async fn library_status(state: &WorkspaceState) -> LibraryStatus {
    let root = &state.root;
    let problem = validate_library(root).await.err().map(|e| e.to_string());
    let dirty = dirty_files(root).await.unwrap_or_default();
    let upstream = upstream_of(root).await;
    let (ahead, behind) = if upstream.is_some() {
        ahead_behind(root).await.unwrap_or((0, 0))
    } else {
        (0, 0)
    };
    let native_skills = native_skills_available(root);
    let problem = problem.or_else(|| {
        (!native_skills).then(|| {
            "Skill links did not materialize, so engines use the MCP skill route. On Windows, \
             enable Developer Mode and set core.symlinks to true, then clone again."
                .to_owned()
        })
    });
    LibraryStatus {
        path: root.to_string_lossy().into_owned(),
        adopted: state.adopted,
        revision: head(root).await.unwrap_or_default(),
        branch: branch_of(root).await,
        dirty: !dirty.is_empty(),
        dirty_files: dirty,
        upstream,
        ahead,
        behind,
        previous_revision: state
            .rollback
            .as_ref()
            .map(|rollback| rollback.from.clone()),
        native_skills,
        problem,
    }
}

fn same_name_skills(root: &Path, target: &Path) -> Vec<String> {
    let names: Vec<String> = std::fs::read(root.join("skills/catalog.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|catalog| {
            catalog.get("skills")?.as_array().map(|skills| {
                skills
                    .iter()
                    .filter_map(|skill| skill.get("name")?.as_str().map(str::to_owned))
                    .collect()
            })
        })
        .unwrap_or_default();
    let mut overlaps = Vec::new();
    for host in HOSTS {
        let base = target.join(host).join("skills");
        for name in &names {
            if std::fs::symlink_metadata(base.join(name)).is_ok() {
                overlaps.push(format!("{host}/skills/{name}"));
            }
        }
    }
    overlaps
}

async fn target_status(root: &Path, project: &orbyn_contracts::Project) -> TargetStatus {
    let path = Path::new(&project.path);
    let mut status = TargetStatus {
        project_id: Some(project.id.clone()),
        path: project.path.clone(),
        git_root: None,
        revision: None,
        branch: None,
        dirty: false,
        worktrees: Vec::new(),
        instructions: Vec::new(),
        same_name_skills: Vec::new(),
        problem: None,
    };
    match check_target(root, path).await {
        Ok(checked) => status.git_root = Some(checked.to_string_lossy().into_owned()),
        Err(error) => {
            status.problem = Some(error.to_string());
            return status;
        }
    }
    status.revision = head(path).await.ok();
    status.branch = branch_of(path).await;
    status.dirty = dirty_files(path)
        .await
        .map_or(true, |files| !files.is_empty());
    status.instructions = INSTRUCTIONS
        .iter()
        .filter(|name| path.join(name).is_file())
        .map(|name| (*name).to_owned())
        .collect();
    status.same_name_skills = same_name_skills(root, path);
    for worktree in linked_worktrees(path).await.unwrap_or_default() {
        status.worktrees.push(TargetWorktree {
            dirty: dirty_files(&worktree.path)
                .await
                .map_or(true, |files| !files.is_empty()),
            path: worktree.path.to_string_lossy().into_owned(),
            branch: worktree.branch,
            revision: worktree.revision,
        });
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{TempDir, library, run_git};

    async fn service(dir: &TempDir) -> Workspace {
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let store = Arc::new(Store::open(&data.join("db"), "e").unwrap());
        Workspace::new(store, data, DEFAULT_LIBRARY_URL.into()).unwrap()
    }

    fn adopt(path: &Path) -> WorkspaceSetup {
        WorkspaceSetup {
            url: None,
            adopt_path: Some(path.to_string_lossy().into_owned()),
        }
    }

    /// An upstream library and a clone of it set up as the workspace.
    async fn cloned(dir: &TempDir) -> (Workspace, PathBuf) {
        let upstream = library(&dir.path().join("upstream"));
        let workspace = service(dir).await;
        workspace
            .setup(WorkspaceSetup {
                url: Some(upstream.to_string_lossy().into_owned()),
                adopt_path: None,
            })
            .await
            .unwrap();
        (workspace, upstream)
    }

    fn upstream_commit(upstream: &Path, name: &str) {
        std::fs::write(upstream.join(name), "new").unwrap();
        run_git(upstream, &["add", "."]);
        run_git(upstream, &["commit", "-q", "-m", name]);
    }

    #[tokio::test]
    async fn everything_waits_for_setup() {
        let dir = TempDir::new();
        let workspace = service(&dir).await;
        assert!(matches!(
            workspace.root(),
            Err(CoreError::WorkspaceRequired)
        ));
        assert!(!workspace.status(&[]).await.unwrap().configured);
    }

    #[tokio::test]
    async fn clone_lands_in_data_and_a_second_setup_is_refused() {
        let dir = TempDir::new();
        let (workspace, upstream) = cloned(&dir).await;
        let root = workspace.root().unwrap();
        assert_eq!(
            root,
            canonicalize(&dir.path().join("data/workspace")).unwrap()
        );
        assert!(root.join("repo").is_dir());
        let again = workspace.setup(adopt(&upstream)).await;
        assert!(matches!(again, Err(CoreError::Invalid(_))));
    }

    #[tokio::test]
    async fn adoption_stays_in_place_and_validates_the_boundary() {
        let dir = TempDir::new();
        let path = library(&dir.path().join("mine"));
        let workspace = service(&dir).await;
        let status = workspace.setup(adopt(&path)).await.unwrap();
        let library = status.library.unwrap();
        assert!(library.adopted);
        assert_eq!(Path::new(&library.path), path);
        assert!(library.native_skills || cfg!(windows));
    }

    #[tokio::test]
    async fn adoption_refuses_incomplete_exposed_or_subdirectory_folders() {
        let dir = TempDir::new();
        let path = library(&dir.path().join("mine"));
        let workspace = service(&dir).await;
        let sub = workspace.setup(adopt(&path.join("skills"))).await;
        assert!(
            matches!(sub, Err(CoreError::WorkspaceRefused(_))),
            "{sub:?}"
        );

        std::fs::write(path.join(".gitignore"), "").unwrap();
        let exposed = workspace.setup(adopt(&path)).await;
        assert!(
            matches!(exposed, Err(CoreError::WorkspaceRefused(_))),
            "{exposed:?}"
        );

        std::fs::write(path.join(".gitignore"), "repo/\n").unwrap();
        std::fs::remove_file(path.join("AGENTS.md")).unwrap();
        let incomplete = workspace.setup(adopt(&path)).await;
        assert!(matches!(incomplete, Err(CoreError::WorkspaceRefused(_))));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_roots_and_targets_are_refused() {
        let dir = TempDir::new();
        let path = library(&dir.path().join("mine"));
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        let workspace = service(&dir).await;
        assert!(matches!(
            workspace.setup(adopt(&link)).await,
            Err(CoreError::WorkspaceRefused(_))
        ));

        std::fs::create_dir_all(path.join("repo")).unwrap();
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        run_git(&outside, &["init", "-q"]);
        let escape = path.join("repo/escape");
        std::os::unix::fs::symlink(&outside, &escape).unwrap();
        assert!(matches!(
            check_target(&path, &escape).await,
            Err(CoreError::WorkspaceRefused(_))
        ));
    }

    #[tokio::test]
    async fn targets_must_be_nested_git_roots_with_git_data_inside() {
        let dir = TempDir::new();
        let root = library(&dir.path().join("mine"));
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("app/src")).unwrap();
        run_git(&repo.join("app"), &["init", "-q"]);
        run_git(
            &repo.join("app"),
            &["config", "user.email", "t@example.com"],
        );
        run_git(&repo.join("app"), &["config", "user.name", "T"]);
        run_git(
            &repo.join("app"),
            &["commit", "-q", "--allow-empty", "-m", "x"],
        );
        assert!(check_target(&root, &repo.join("app")).await.is_ok());

        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        for bad in [
            outside.clone(),
            repo.clone(),
            repo.join("app/src"),
            root.clone(),
        ] {
            assert!(
                matches!(
                    check_target(&root, &bad).await,
                    Err(CoreError::WorkspaceRefused(_))
                ),
                "{bad:?}"
            );
        }

        // A linked worktree of an external clone has its Git data outside.
        let external = dir.path().join("external");
        std::fs::create_dir_all(&external).unwrap();
        run_git(&external, &["init", "-q"]);
        run_git(&external, &["config", "user.email", "t@example.com"]);
        run_git(&external, &["config", "user.name", "T"]);
        run_git(&external, &["commit", "-q", "--allow-empty", "-m", "x"]);
        let linked = repo.join("linked");
        run_git(
            &external,
            &["worktree", "add", "-q", linked.to_str().unwrap()],
        );
        assert!(matches!(
            check_target(&root, &linked).await,
            Err(CoreError::WorkspaceRefused(_))
        ));
    }

    #[tokio::test]
    async fn fetch_only_shows_incoming_without_moving() {
        let dir = TempDir::new();
        let (workspace, upstream) = cloned(&dir).await;
        let before = head(&workspace.root().unwrap()).await.unwrap();
        upstream_commit(&upstream, "new-file");
        let result = workspace.update(false).await.unwrap();
        assert!(!result.applied);
        assert_eq!(result.incoming.len(), 1);
        assert_eq!(result.incoming[0].subject, "new-file");
        assert_eq!(head(&workspace.root().unwrap()).await.unwrap(), before);
    }

    #[tokio::test]
    async fn update_fast_forwards_audits_and_rolls_back() {
        let dir = TempDir::new();
        let (workspace, upstream) = cloned(&dir).await;
        let root = workspace.root().unwrap();
        let before = head(&root).await.unwrap();
        upstream_commit(&upstream, "new-file");
        let result = workspace.update(true).await.unwrap();
        assert!(result.applied);
        assert!(root.join("new-file").exists());
        let back = workspace.rollback().await.unwrap();
        assert_eq!(back.revision, before);
        assert_eq!(head(&root).await.unwrap(), before);
        assert!(!root.join("new-file").exists());
        assert!(matches!(
            workspace.rollback().await,
            Err(CoreError::Invalid(_))
        ));
        let actions: Vec<String> = workspace
            .store
            .list_audit(None, 10)
            .unwrap()
            .into_iter()
            .map(|row| row.action)
            .collect();
        for action in [
            "workspace.update",
            "workspace.update.result",
            "workspace.rollback",
        ] {
            assert!(actions.iter().any(|row| row == action), "{action}");
        }
    }

    #[tokio::test]
    async fn dirty_library_is_not_updated_and_its_edits_stay() {
        let dir = TempDir::new();
        let (workspace, upstream) = cloned(&dir).await;
        let root = workspace.root().unwrap();
        upstream_commit(&upstream, "new-file");
        std::fs::write(root.join("AGENTS.md"), "local edit").unwrap();
        assert!(matches!(
            workspace.update(true).await,
            Err(CoreError::LibraryDirty(_))
        ));
        assert_eq!(
            std::fs::read_to_string(root.join("AGENTS.md")).unwrap(),
            "local edit"
        );
        assert!(workspace.status(&[]).await.unwrap().library.unwrap().dirty);
    }

    #[tokio::test]
    async fn diverged_library_is_not_a_fast_forward() {
        let dir = TempDir::new();
        let (workspace, upstream) = cloned(&dir).await;
        let root = workspace.root().unwrap();
        run_git(&root, &["config", "user.email", "t@example.com"]);
        run_git(&root, &["config", "user.name", "T"]);
        run_git(&root, &["commit", "-q", "--allow-empty", "-m", "local"]);
        let before = head(&root).await.unwrap();
        upstream_commit(&upstream, "new-file");
        assert!(matches!(
            workspace.update(true).await,
            Err(CoreError::NotFastForward(_))
        ));
        assert_eq!(head(&root).await.unwrap(), before);
    }

    #[tokio::test]
    async fn rollback_refuses_once_the_library_moved_on() {
        let dir = TempDir::new();
        let (workspace, upstream) = cloned(&dir).await;
        let root = workspace.root().unwrap();
        upstream_commit(&upstream, "new-file");
        workspace.update(true).await.unwrap();
        run_git(&root, &["config", "user.email", "t@example.com"]);
        run_git(&root, &["config", "user.name", "T"]);
        run_git(&root, &["commit", "-q", "--allow-empty", "-m", "local"]);
        assert!(matches!(
            workspace.rollback().await,
            Err(CoreError::NotFastForward(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn plain_files_where_links_belong_turn_native_skills_off() {
        let dir = TempDir::new();
        let root = library(&dir.path().join("mine"));
        assert!(native_skills_available(&root));
        let link = root.join(".claude/skills/how");
        std::fs::remove_file(&link).unwrap();
        std::fs::write(&link, "../../skills/how").unwrap();
        assert!(!native_skills_available(&root));
    }

    #[tokio::test]
    async fn same_name_target_skills_are_reported_not_touched() {
        let dir = TempDir::new();
        let root = library(&dir.path().join("mine"));
        let target = root.join("repo/app");
        std::fs::create_dir_all(target.join(".claude/skills/how")).unwrap();
        assert_eq!(same_name_skills(&root, &target), [".claude/skills/how"]);
    }
}
