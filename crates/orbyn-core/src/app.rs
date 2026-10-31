//! Assembles the core from its parts and owns process-wide startup rules.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use orbyn_contracts::{Project, Thread};

use crate::approvals::ApprovalGate;
use crate::computer::{ComputerBackend, ComputerConfig, ComputerGateway, LocalBackend};
use crate::engines::{EngineConfig, EngineManager};
use crate::error::{CoreError, Result};
use crate::git;
use crate::mcp::McpService;
use crate::runs::RunManager;
use crate::skills::SkillService;
use crate::store::{NewThread, Recovery, Store};
use crate::terminal::TerminalManager;
use crate::util::new_id;

/// A wait of this length covers an unattended person without a run hanging forever.
pub const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug)]
pub struct CoreConfig {
    pub data_dir: PathBuf,
    /// Loopback origin the per-run MCP URL is built from.
    pub base_url: String,
    pub skills_dir: Option<PathBuf>,
    pub engines: EngineConfig,
    pub approval_timeout: Duration,
    pub desktop_program: Option<String>,
    pub browser_path: Option<PathBuf>,
    pub browser_headless: bool,
}

impl CoreConfig {
    pub fn new(data_dir: PathBuf, base_url: String) -> Self {
        Self {
            data_dir,
            base_url,
            skills_dir: None,
            engines: EngineConfig::default(),
            approval_timeout: DEFAULT_APPROVAL_TIMEOUT,
            desktop_program: None,
            browser_path: None,
            browser_headless: false,
        }
    }
}

pub struct Core {
    pub config: CoreConfig,
    pub store: Arc<Store>,
    pub gate: Arc<ApprovalGate>,
    pub engines: Arc<EngineManager>,
    pub skills: Arc<SkillService>,
    pub computer: Arc<ComputerGateway>,
    pub mcp: Arc<McpService>,
    pub runs: Arc<RunManager>,
    pub terminals: Arc<TerminalManager>,
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
        }));
        Self::open_with(config, backend)
    }

    pub fn open_with(config: CoreConfig, backend: Arc<dyn ComputerBackend>) -> Result<Self> {
        std::fs::create_dir_all(&config.data_dir)?;
        let lock = take_owner_lock(&config.data_dir)?;
        // A new epoch per process start fences anything the last process left.
        let epoch = new_id();
        let store = Arc::new(Store::open(&config.data_dir.join("orbyn.sqlite3"), epoch)?);
        let recovery = store.recover()?;
        if recovery != Recovery::default() {
            tracing::info!(?recovery, "recovered runs from a previous process");
        }
        let gate = Arc::new(ApprovalGate::new(store.clone(), config.approval_timeout));
        let terminals = Arc::new(TerminalManager::default());
        let http = reqwest::Client::builder()
            .user_agent(concat!("orbyn/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        let engines = Arc::new(EngineManager::new(
            store.clone(),
            terminals.clone(),
            http,
            config.engines.clone(),
        ));
        let skills = Arc::new(SkillService::new(
            store.clone(),
            &config.data_dir,
            config.skills_dir.clone(),
        ));
        if let Err(error) = skills.startup() {
            tracing::warn!(%error, "skill pack is unavailable");
        }
        let computer = Arc::new(ComputerGateway::new(store.clone(), gate.clone(), backend));
        let mcp = Arc::new(McpService::new(
            gate.clone(),
            skills.clone(),
            computer.clone(),
        ));
        let runs = Arc::new(RunManager::new(
            store.clone(),
            gate.clone(),
            engines.clone(),
            skills.clone(),
            mcp.clone(),
            config.base_url.clone(),
            config.data_dir.join("runs"),
        ));
        clean_stale_run_dirs(&config.data_dir.join("runs"));
        Ok(Self {
            config,
            store,
            gate,
            engines,
            skills,
            computer,
            mcp,
            runs,
            terminals,
            recovery,
            _lock: lock,
        })
    }

    /// Registers a folder. Nothing runs in it; trust is a separate step.
    pub fn add_project(&self, path: &str) -> Result<Project> {
        let path = Path::new(path);
        if !path.is_absolute() {
            return Err(CoreError::Invalid("Choose an absolute folder path.".into()));
        }
        let canonical = crate::util::canonicalize(path)
            .map_err(|_| CoreError::Invalid(format!("{} does not exist.", path.display())))?;
        if !canonical.is_dir() {
            return Err(CoreError::Invalid(format!(
                "{} is not a folder.",
                canonical.display()
            )));
        }
        let name = canonical
            .file_name()
            .map_or_else(|| "root".to_owned(), |n| n.to_string_lossy().into_owned());
        self.store.add_project(
            &canonical.to_string_lossy(),
            &name,
            git::is_git_repo(&canonical),
        )
    }

    /// Creates a thread, with a worktree when asked. `git worktree add` runs repo
    /// hooks, so it needs a trusted folder like an engine does.
    pub async fn create_thread(&self, request: orbyn_contracts::CreateThread) -> Result<Thread> {
        let project = self.store.project(&request.project_id)?;
        self.engines.driver(&request.engine)?;
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
                Some(git::create_worktree(Path::new(&project.path), purpose).await?)
            }
            None => None,
        };
        let cwd = worktree
            .as_ref()
            .map_or_else(|| project.path.clone(), |worktree| worktree.path.clone());
        self.store.create_thread(NewThread {
            project_id: project.id,
            title: request.title.unwrap_or_else(|| "New thread".to_owned()),
            engine: request.engine,
            model: request.model,
            cwd,
            worktree,
            skill_profile: request.skill_profile,
            parent_thread_id: None,
            relation: None,
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
        self.computer.shutdown().await;
    }
}

/// One live owner per data directory: a second process must not fence the first.
fn take_owner_lock(data_dir: &Path) -> Result<File> {
    let file = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data_dir.join("orbynd.lock"))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => Err(CoreError::DataDirLocked),
        Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
    }
}

/// Run directories can hold an MCP token, which died with its process anyway.
fn clean_stale_run_dirs(runs_dir: &Path) {
    if let Err(error) = std::fs::remove_dir_all(runs_dir)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(%error, "could not clear old run directories");
    }
}
