//! Assembles the core from its parts and owns process-wide startup rules.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use orbyn_contracts::Thread;
use orbyn_contracts::{PermissionMode, UpdateThread};

use crate::approvals::ApprovalGate;
use crate::computer::{ComputerBackend, ComputerConfig, ComputerGateway, LocalBackend};
use crate::engines::{EngineConfig, EngineManager};
use crate::error::{CoreError, Result};
use crate::git;
use crate::mcp::McpService;
use crate::preview::PreviewManager;
use crate::projects::ClonePool;
use crate::questions::QuestionDesk;
use crate::runs::{RunManager, RunServices};
use crate::skills::SkillService;
use crate::store::{NewThread, Recovery, Store};
use crate::terminal::TerminalManager;
use crate::updates::UpdateCenter;
use crate::usage::UsageCenter;
use crate::util::new_id;
use crate::workspace::Workspace;

/// A wait of this length covers an unattended person without a run hanging forever.
pub const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug)]
pub struct CoreConfig {
    pub data_dir: PathBuf,
    /// Loopback origin the per-run MCP URL is built from.
    pub base_url: String,
    /// Where a first-run clone of the library comes from.
    pub workspace_url: String,
    /// Release manifest for a server with no desktop shell.
    pub update_manifest: Option<String>,
    pub engines: EngineConfig,
    pub approval_timeout: Duration,
    pub desktop_program: Option<String>,
    pub browser_path: Option<PathBuf>,
    pub browser_headless: bool,
    /// Forces `--in-process-gpu`, which the headless shell gets by itself.
    pub browser_in_process_gpu: bool,
}

impl CoreConfig {
    pub fn new(data_dir: PathBuf, base_url: String) -> Self {
        Self {
            data_dir,
            base_url,
            workspace_url: crate::workspace::DEFAULT_LIBRARY_URL.to_owned(),
            update_manifest: None,
            engines: EngineConfig::default(),
            approval_timeout: DEFAULT_APPROVAL_TIMEOUT,
            desktop_program: None,
            browser_path: None,
            browser_headless: false,
            browser_in_process_gpu: false,
        }
    }
}

pub struct Core {
    pub config: CoreConfig,
    pub store: Arc<Store>,
    pub gate: Arc<ApprovalGate>,
    pub questions: Arc<QuestionDesk>,
    pub engines: Arc<EngineManager>,
    pub workspace: Arc<Workspace>,
    pub skills: Arc<SkillService>,
    pub computer: Arc<ComputerGateway>,
    pub mcp: Arc<McpService>,
    pub runs: Arc<RunManager>,
    pub terminals: Arc<TerminalManager>,
    pub updates: Arc<UpdateCenter>,
    pub usage: Arc<UsageCenter>,
    pub clones: ClonePool,
    pub previews: PreviewManager,
    pub recovery: Recovery,
    _lock: File,
}

impl Core {
    /// Opens the data directory, takes its owner lock and fences dead owners.
    pub fn open(config: CoreConfig) -> Result<Self> {
        let backend: Arc<dyn ComputerBackend> = Arc::new(LocalBackend::new(ComputerConfig {
            desktop_program: config.desktop_program.clone(),
            browser_path: config.browser_path.clone(),
            profile_dir: config.data_dir.join("browser-profile"),
            headless: config.browser_headless,
            in_process_gpu: config.browser_in_process_gpu,
        }));
        Self::open_with(config, backend)
    }

    pub fn open_with(config: CoreConfig, backend: Arc<dyn ComputerBackend>) -> Result<Self> {
        std::fs::create_dir_all(&config.data_dir)?;
        let lock = take_owner_lock(&config.data_dir)?;
        // A preview outlives no process, so any profile here is a leftover.
        let _ = std::fs::remove_dir_all(config.data_dir.join("preview-profiles"));
        // A new epoch per process start fences anything the last process left.
        let epoch = new_id();
        let store = Arc::new(Store::open(&config.data_dir.join("orbyn.sqlite3"), epoch)?);
        let recovery = store.recover()?;
        if recovery != Recovery::default() {
            tracing::info!(?recovery, "recovered runs from a previous process");
        }
        let gate = Arc::new(ApprovalGate::new(store.clone(), config.approval_timeout));
        let questions = Arc::new(QuestionDesk::new(store.clone(), config.approval_timeout));
        let terminals = Arc::new(TerminalManager::default());
        let http = reqwest::Client::builder()
            .user_agent(concat!("orbyn/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        let engines = Arc::new(EngineManager::new(
            store.clone(),
            terminals.clone(),
            http.clone(),
            config.engines.clone(),
        ));
        let workspace = Arc::new(Workspace::new(
            store.clone(),
            config.data_dir.clone(),
            config.workspace_url.clone(),
        )?);
        let skills = Arc::new(SkillService::new(store.clone(), workspace.clone()));
        let computer = Arc::new(ComputerGateway::new(store.clone(), gate.clone(), backend));
        let mcp = Arc::new(McpService::new(
            gate.clone(),
            questions.clone(),
            skills.clone(),
            computer.clone(),
        ));
        let runs = Arc::new(RunManager::new(RunServices {
            store: store.clone(),
            gate: gate.clone(),
            questions: questions.clone(),
            engines: engines.clone(),
            skills: skills.clone(),
            workspace: workspace.clone(),
            mcp: mcp.clone(),
            base_url: config.base_url.clone(),
            runs_dir: config.data_dir.join("runs"),
        }));
        clean_stale_run_dirs(&config.data_dir.join("runs"));
        let usage = Arc::new(UsageCenter::new(&config.data_dir)?);
        let updates = Arc::new(UpdateCenter::new(
            store.clone(),
            workspace.clone(),
            engines.clone(),
            http,
            config.update_manifest.clone(),
        ));
        let core = Self {
            config,
            store,
            gate,
            questions,
            engines,
            workspace,
            skills,
            computer,
            mcp,
            runs,
            terminals,
            updates,
            usage,
            clones: ClonePool::default(),
            previews: PreviewManager::default(),
            recovery,
            _lock: lock,
        };
        core.apply_login_preference()?;
        Ok(core)
    }

    /// Creates a thread, with a worktree when asked. `git worktree add` runs repo
    /// hooks, so it needs a trusted folder like an engine does.
    pub async fn create_thread(&self, request: orbyn_contracts::CreateThread) -> Result<Thread> {
        self.workspace.root()?;
        let project = match self.scratch_request(&request)? {
            Some(scratch) => scratch,
            None => self
                .store
                .project(request.project_id.as_deref().unwrap_or_default())?,
        };
        self.engines.driver(&request.engine)?;
        self.check_engine_enabled(&request.engine, &project.id)?;
        if let Some(profile) = request.skill_profile.as_deref()
            && profile != crate::skills::DEFAULT_PROFILE
            && self.store.profile(profile)?.is_none()
        {
            return Err(CoreError::NotFound("skill profile".into()));
        }
        let worktree = match &request.worktree {
            Some(purpose) => {
                if !project.trusted {
                    return Err(CoreError::FolderUntrusted);
                }
                if !project.is_git {
                    return Err(CoreError::Invalid(
                        "Worktrees need a Git repository.".into(),
                    ));
                }
                let options = self.worktree_options(&project.id, &project.path, &request)?;
                Some(git::create_worktree(Path::new(&project.path), purpose, &options).await?)
            }
            None => None,
        };
        let cwd = worktree
            .as_ref()
            .map_or_else(|| project.path.clone(), |worktree| worktree.path.clone());
        let project_id = project.id.clone();
        let remembered = self.store.remembered_selection(&request.engine)?;
        let model = request
            .model
            .clone()
            .or(self.project_default_model(&request.engine, &project_id)?)
            .or(remembered.model.clone());
        // Effort and options belong to a model, so they carry only with that model.
        let carried = (model == remembered.model).then_some(remembered);
        let effort = request
            .effort
            .clone()
            .or(carried.as_ref().and_then(|last| last.effort.clone()));
        let options = if request.options.is_empty() {
            carried.map(|last| last.options).unwrap_or_default()
        } else {
            request.options.clone()
        };
        let thread = self.store.create_thread(NewThread {
            project_id: project.id,
            title: request.title.unwrap_or_else(|| "New thread".to_owned()),
            engine: request.engine,
            model,
            cwd,
            worktree,
            skill_profile: request.skill_profile,
            parent_thread_id: None,
            relation: None,
            scratch: project.scratch,
        })?;
        let mode = self.preference("default_permission_mode", Some(&project_id))?;
        let mode: PermissionMode = serde_json::from_value(mode)?;
        let patch = UpdateThread {
            effort,
            options: Some(options).filter(|options| !options.is_empty()),
            permission_mode: Some(mode).filter(|mode| *mode != PermissionMode::Supervised),
            ..UpdateThread::default()
        };
        let thread = if patch == UpdateThread::default() {
            thread
        } else {
            self.store.update_thread(&thread.id, &patch, "system")?
        };
        self.run_hook_scripts(&thread.id, |script| script.run_on_worktree_create);
        Ok(thread)
    }

    /// The settings for a new worktree. The project file's submodule choice wins,
    /// since it travels with the branch being checked out.
    fn worktree_options(
        &self,
        project_id: &str,
        path: &str,
        request: &orbyn_contracts::CreateThread,
    ) -> Result<git::WorktreeOptions> {
        let text = |key: &str| -> Result<String> {
            Ok(self
                .preference(key, Some(project_id))?
                .as_str()
                .unwrap_or_default()
                .to_owned())
        };
        let file = crate::project_file::read_project_file(Path::new(path)).file;
        Ok(git::WorktreeOptions {
            prefix: text("branch_name_prefix")?,
            base: request.base_branch.clone(),
            from_origin: self.preference("new_worktrees_start_from_origin", Some(project_id))?
                == serde_json::json!(true),
            submodules: match file.and_then(|file| file.worktree_submodules) {
                Some(choice) => choice,
                None => text("worktree_submodules")?,
            },
        })
    }

    pub async fn thread_diff(&self, thread_id: &str) -> Result<Vec<orbyn_contracts::FileDiff>> {
        let thread = self.store.thread(thread_id)?;
        let project = self.store.project(&thread.project_id)?;
        if !project.is_git {
            return Ok(Vec::new());
        }
        if !project.trusted {
            return Err(CoreError::FolderUntrusted);
        }
        let base = thread
            .worktree
            .as_ref()
            .map(|worktree| worktree.base.as_str());
        git::diff(Path::new(&thread.cwd), base).await
    }

    /// Stops every engine, terminal and browser this process owns.
    pub async fn shutdown(&self) {
        self.runs.shutdown().await;
        self.terminals.close_all();
        self.previews.close_all();
        self.computer.shutdown().await;
    }
}

/// One live owner per data directory: a second process must not fence the first.
fn take_owner_lock(data_dir: &Path) -> Result<File> {
    let path = data_dir.join("orbynd.lock");
    let mut file = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)?;
    let give_up = std::time::Instant::now() + OWNER_LOCK_WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) => {
                let owner = std::fs::read_to_string(&path).ok();
                if owner_is_alive(owner.as_deref()) || std::time::Instant::now() >= give_up {
                    return Err(CoreError::DataDirLocked);
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
        }
    }
    file.set_len(0)?;
    file.write_all(std::process::id().to_string().as_bytes())?;
    Ok(file)
}

/// How long a lock whose owner has died may stay held. A child caught between fork and
/// exec when its parent died shares the lock until the exec finishes, and on macOS a
/// first exec can be scanned for seconds.
const OWNER_LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(8);

/// True when the lock file names a live process, or says nothing usable.
#[cfg(unix)]
fn owner_is_alive(owner: Option<&str>) -> bool {
    let Some(pid) = owner.and_then(|text| text.trim().parse::<i32>().ok()) else {
        return true;
    };
    // SAFETY: signal 0 delivers nothing; it only asks whether the process exists.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// Windows drops the lock with the process, and a child does not inherit it.
#[cfg(not(unix))]
fn owner_is_alive(_owner: Option<&str>) -> bool {
    true
}

/// Run directories can hold an MCP token, which died with its process anyway.
fn clean_stale_run_dirs(runs_dir: &Path) {
    if let Err(error) = std::fs::remove_dir_all(runs_dir)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(%error, "could not clear old run directories");
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_lock_left_by_a_dead_owner_clears_and_a_live_owner_refuses_at_once() {
        let dir = crate::testing::TempDir::new();
        let path = dir.path().join("orbynd.lock");
        let holder = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .unwrap();
        holder.lock().unwrap();

        std::fs::write(&path, std::process::id().to_string()).unwrap();
        let started = std::time::Instant::now();
        assert!(matches!(
            take_owner_lock(dir.path()),
            Err(CoreError::DataDirLocked)
        ));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));

        let mut gone = std::process::Command::new("true").spawn().unwrap();
        let dead = gone.id();
        gone.wait().unwrap();
        std::fs::write(&path, dead.to_string()).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            drop(holder);
        });
        let file = take_owner_lock(dir.path()).unwrap();
        release.join().unwrap();
        drop(file);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            std::process::id().to_string()
        );
    }
}
