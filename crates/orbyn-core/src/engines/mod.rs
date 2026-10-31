//! Engine registry, status and updates. Updates run only through the installer
//! that provably owns the binary, and never while that engine has a run.

pub mod maintenance;
pub mod manifest;
pub mod probe;

use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use orbyn_contracts::{
    AuthState, CustomEngine, EngineModels, EngineStatus, EngineTier, InstallerKind, ModelSelection,
    VersionSupport,
};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use crate::driver::acp::AcpDriver;
use crate::driver::agui::AguiDriver;
use crate::driver::claude::ClaudeDriver;
use crate::driver::codex::CodexDriver;
use crate::driver::terminal::TerminalDriver;
use crate::driver::{EngineDriver, ModelCatalog, UpdatePlan};
use crate::error::{CoreError, Result};
use crate::process::{ManagedChild, engine_command, resolve};
use crate::store::{AuditRecord, Store};
use crate::terminal::TerminalManager;
use crate::util::tail;
use manifest::TestedManifest;

const LATEST_TIMEOUT: Duration = Duration::from_secs(4);
pub const UPDATE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MODELS_TTL: Duration = Duration::from_secs(5 * 60);
/// How often an engine's catalog key is compared. Reading it starts processes.
const MODELS_KEY_CHECK: Duration = Duration::from_secs(60);
/// A stand-in list is kept only long enough not to start a process per read.
const MODELS_RETRY: Duration = Duration::from_secs(30);
const MODELS_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub claude_program: String,
    pub codex_program: String,
    pub codex_sandbox: String,
    pub lookup_latest: bool,
    pub update_timeout: Duration,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            claude_program: "claude".into(),
            codex_program: "codex".into(),
            codex_sandbox: "workspace-write".into(),
            lookup_latest: true,
            update_timeout: UPDATE_TIMEOUT,
        }
    }
}

pub struct EngineManager {
    store: Arc<Store>,
    terminals: Arc<TerminalManager>,
    http: reqwest::Client,
    config: EngineConfig,
    manifest: TestedManifest,
    drivers: Mutex<Vec<Arc<dyn EngineDriver>>>,
    /// Engines being updated. This lock also serializes the admission check
    /// against the update check, so neither can slip past the other.
    updating: Mutex<HashSet<String>>,
    installer_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    statuses: tokio::sync::Mutex<Option<Vec<EngineStatus>>>,
    models: tokio::sync::Mutex<HashMap<String, CachedModels>>,
    /// The last good list of each engine, for checks that cannot wait for an engine.
    known_models: Mutex<HashMap<String, EngineModels>>,
}

struct CachedModels {
    checked: Instant,
    key: Option<String>,
    models: EngineModels,
}

impl EngineManager {
    pub fn new(
        store: Arc<Store>,
        terminals: Arc<TerminalManager>,
        http: reqwest::Client,
        config: EngineConfig,
    ) -> Self {
        let drivers: Vec<Arc<dyn EngineDriver>> = vec![
            Arc::new(ClaudeDriver::new(config.claude_program.clone())),
            Arc::new(CodexDriver::new(
                config.codex_program.clone(),
                config.codex_sandbox.clone(),
            )),
        ];
        Self {
            store,
            terminals,
            http,
            config,
            manifest: TestedManifest::embedded(),
            drivers: Mutex::new(drivers),
            updating: Mutex::new(HashSet::new()),
            installer_locks: Mutex::new(HashMap::new()),
            statuses: tokio::sync::Mutex::new(None),
            models: tokio::sync::Mutex::new(HashMap::new()),
            known_models: Mutex::new(HashMap::new()),
        }
    }

    /// Adds a driver alongside the built-ins.
    pub fn register(&self, driver: Arc<dyn EngineDriver>) {
        lock(&self.drivers).push(driver);
    }

    fn custom_driver(&self, engine: CustomEngine) -> Result<Arc<dyn EngineDriver>> {
        match engine.tier {
            EngineTier::Acp => Ok(Arc::new(AcpDriver::new(engine))),
            EngineTier::Agui => Ok(Arc::new(AguiDriver::new(engine, self.http.clone()))),
            EngineTier::Terminal => Ok(Arc::new(TerminalDriver::new(
                engine,
                self.terminals.clone(),
            ))),
            EngineTier::Native => Err(CoreError::Invalid(
                "Custom engines use the ACP, AG-UI or terminal tier.".into(),
            )),
        }
    }

    pub fn driver(&self, id: &str) -> Result<Arc<dyn EngineDriver>> {
        if let Some(driver) = lock(&self.drivers)
            .iter()
            .find(|driver| driver.descriptor().id == id)
        {
            return Ok(driver.clone());
        }
        let engine = self
            .store
            .list_custom_engines()?
            .into_iter()
            .find(|engine| engine.id == id)
            .ok_or_else(|| CoreError::NotFound(format!("engine {id}")))?;
        self.custom_driver(engine)
    }

    fn all_drivers(&self) -> Result<Vec<Arc<dyn EngineDriver>>> {
        let mut drivers = lock(&self.drivers).clone();
        for engine in self.store.list_custom_engines()? {
            drivers.push(self.custom_driver(engine)?);
        }
        Ok(drivers)
    }

    /// Runs an admission while no update of `engine` can start.
    pub fn admit_with<T>(&self, engine: &str, admit: impl FnOnce() -> Result<T>) -> Result<T> {
        let updating = lock(&self.updating);
        if updating.contains(engine) {
            return Err(CoreError::EngineBusy(engine.to_owned()));
        }
        admit()
    }

    pub async fn statuses(&self, refresh: bool) -> Result<Vec<EngineStatus>> {
        let mut cached = self.statuses.lock().await;
        if refresh || cached.is_none() {
            let mut statuses = Vec::new();
            for driver in self.all_drivers()? {
                statuses.push(self.status_of(driver.as_ref()).await);
            }
            *cached = Some(statuses);
        }
        let mut statuses = cached.clone().unwrap_or_default();
        let updating = lock(&self.updating);
        for status in &mut statuses {
            status.updating = updating.contains(&status.id);
        }
        Ok(statuses)
    }

    /// Drops the cached list so the next read sees a changed engine set.
    pub async fn invalidate(&self) {
        *self.statuses.lock().await = None;
    }

    /// What the engine says it offers. A failure is reported with the list empty,
    /// so custom models still work, and only a good answer is kept for long.
    pub async fn models(&self, id: &str, refresh: bool) -> Result<EngineModels> {
        let driver = self.driver(id)?;
        let mut cache = self.models.lock().await;
        if !refresh
            && let Some(cached) = cache.get(id)
            && cached.key.is_some()
            && cached.checked.elapsed() < MODELS_KEY_CHECK
        {
            return Ok(cached.models.clone());
        }
        let key = driver.catalog_key().await;
        if !refresh
            && let Some(cached) = cache.get_mut(id)
            && still_good(cached, key.as_ref())
        {
            return Ok(cached.models.clone());
        }
        let report = tokio::time::timeout(MODELS_TIMEOUT, driver.models()).await;
        let (catalog, error) = match report {
            Ok(Ok(Some(catalog))) => (catalog, None),
            Ok(Ok(None)) => (empty_catalog(), None),
            Ok(Err(error)) => (empty_catalog(), Some(error.public_message())),
            Err(_) => (
                empty_catalog(),
                Some("The engine did not list its models in time.".to_owned()),
            ),
        };
        let fallback = catalog.fallback.is_some();
        let models = EngineModels {
            engine: id.to_owned(),
            source: catalog.source.to_owned(),
            models: catalog.models,
            error: catalog.fallback.or(error),
            checked_at: crate::util::now(),
            fallback,
            options: catalog.options,
            agents: catalog.agents,
            output_styles: catalog.output_styles,
            output_style: catalog.output_style,
            remembered: None,
        };
        if models.error.is_none() {
            if !catalog.commands.is_empty() {
                self.store.add_engine_commands(id, &catalog.commands)?;
            }
            self.store.set_engine_agents(id, &models.agents)?;
            lock(&self.known_models).insert(id.to_owned(), models.clone());
        }
        if models.error.is_none() || fallback {
            let cached = CachedModels {
                checked: Instant::now(),
                key: key.filter(|_| !fallback),
                models: models.clone(),
            };
            cache.insert(id.to_owned(), cached);
        }
        Ok(models)
    }

    /// Refuses what the last good list says the model does not offer, without
    /// waiting on an engine. With no list yet, the run's own start checks it.
    pub fn check_selection(&self, engine: &str, selection: &ModelSelection) -> Result<()> {
        match lock(&self.known_models).get(engine) {
            Some(catalog) => crate::selection::check(catalog, selection),
            None => Ok(()),
        }
    }

    pub async fn status(&self, id: &str) -> Result<EngineStatus> {
        let driver = self.driver(id)?;
        Ok(self.status_of(driver.as_ref()).await)
    }

    async fn status_of(&self, driver: &dyn EngineDriver) -> EngineStatus {
        let descriptor = driver.descriptor();
        let probe = driver.probe().await;
        let plan = driver.update_plan(&probe).await;
        let installed = probe.path.is_some();
        let installer = plan
            .as_ref()
            .map_or(InstallerKind::Unknown, |plan| plan.installer);
        let latest = match (driver.latest_version().await, driver.npm_package()) {
            (Some(latest), _) => Some(latest),
            (None, Some(package)) if self.config.lookup_latest && installed => {
                self.latest_version(package).await
            }
            _ => None,
        };
        let support = if descriptor.tier == EngineTier::Native {
            self.manifest
                .support(&descriptor.id, probe.version.as_deref())
        } else {
            VersionSupport::Unknown
        };
        let manual_hint = if plan.is_none() {
            driver.manual_hint()
        } else {
            None
        };
        EngineStatus {
            id: descriptor.id,
            name: descriptor.name,
            tier: descriptor.tier,
            capabilities: descriptor.capabilities,
            installed,
            path: probe.path.map(|path| path.to_string_lossy().into_owned()),
            version: probe.version,
            auth: probe.auth.unwrap_or(AuthState::Unknown),
            installer,
            latest,
            support,
            update_command: plan.as_ref().map(UpdatePlan::display),
            manual_hint,
            sign_in_command: probe.sign_in_command,
            updating: false,
            problem: probe.problem,
        }
    }

    async fn latest_version(&self, package: &str) -> Option<String> {
        let url = format!(
            "https://registry.npmjs.org/{}/latest",
            package.replace('/', "%2f")
        );
        let body: Value = self
            .http
            .get(url)
            .timeout(LATEST_TIMEOUT)
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        body.get("version")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    /// Updates an engine through its owning installer, then verifies by probing.
    pub async fn update(&self, id: &str, actor: &str) -> Result<EngineStatus> {
        let driver = self.driver(id)?;
        let before = driver.probe().await;
        let plan = driver.update_plan(&before).await.ok_or_else(|| {
            CoreError::UpdateUnavailable(driver.manual_hint().unwrap_or_else(|| {
                "Orbyn cannot prove which installer owns this engine.".to_owned()
            }))
        })?;
        let _marker = self.begin_update(id)?;
        let installer_lock = {
            let mut locks = lock(&self.installer_locks);
            locks.entry(plan.lock_key.clone()).or_default().clone()
        };
        let _installer = installer_lock.lock().await;
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: "engine.update".into(),
            target: plan.display(),
            decision: None,
            source: "user".into(),
            thread_id: None,
            run_id: None,
            detail: json!({ "engine": id, "from": before.version }),
        })?;
        let result = self.run_update(&plan).await;
        let after = driver.probe().await;
        self.store.append_audit(&AuditRecord {
            actor: "system:update".into(),
            action: "engine.update.result".into(),
            target: id.to_owned(),
            decision: None,
            source: "system".into(),
            thread_id: None,
            run_id: None,
            detail: json!({
                "ok": result.is_ok(),
                "from": before.version,
                "to": after.version,
                "output": result.as_ref().map_or_else(|error| error.to_string(), Clone::clone),
            }),
        })?;
        result?;
        if after.version.is_none() {
            return Err(CoreError::UpdateFailed(
                "The update ran, but the engine no longer reports a version.".into(),
            ));
        }
        self.invalidate().await;
        self.status(id).await
    }

    /// Marks the engine as updating unless it has a run. Admission takes the same
    /// lock, so a run admitted first blocks the update and vice versa.
    fn begin_update(&self, id: &str) -> Result<UpdateMarker<'_>> {
        let mut updating = lock(&self.updating);
        if updating.contains(id) || self.store.active_runs_for_engine(id)? > 0 {
            return Err(CoreError::EngineBusy(id.to_owned()));
        }
        updating.insert(id.to_owned());
        Ok(UpdateMarker {
            set: &self.updating,
            id: id.to_owned(),
        })
    }

    async fn run_update(&self, plan: &UpdatePlan) -> Result<String> {
        let command = resolve(&plan.program)
            .ok_or_else(|| CoreError::UpdateFailed(format!("{} was not found.", plan.program)))?;
        let args: Vec<std::ffi::OsString> = plan.args.iter().map(Into::into).collect();
        let mut builder = engine_command(&command, &args, &std::env::temp_dir());
        builder.stdin(Stdio::null());
        let mut child = ManagedChild::spawn(builder)?;
        let mut stdout = child.child_mut().stdout.take();
        let mut stderr = child.child_mut().stderr.take();
        let outcome = tokio::time::timeout(self.config.update_timeout, async {
            let mut out = Vec::new();
            let mut err = Vec::new();
            let (_, _, status) = tokio::join!(
                read_all(stdout.as_mut(), &mut out),
                read_all(stderr.as_mut(), &mut err),
                child.wait()
            );
            (status, out, err)
        })
        .await;
        let Ok((status, out, err)) = outcome else {
            return Err(CoreError::UpdateFailed(
                "The update did not finish in time and was stopped.".into(),
            ));
        };
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out),
            String::from_utf8_lossy(&err)
        );
        match status {
            Ok(status) if status.success() => Ok(tail(&text, 4096)),
            _ => Err(CoreError::UpdateFailed(tail(&text, 1024))),
        }
    }
}

fn empty_catalog() -> ModelCatalog {
    ModelCatalog {
        source: "none",
        ..ModelCatalog::default()
    }
}

/// A keyed list lasts until its key changes. Anything else ages out.
fn still_good(cached: &mut CachedModels, key: Option<&String>) -> bool {
    let age = cached.checked.elapsed();
    match &cached.key {
        Some(known) if key == Some(known) => {
            cached.checked = Instant::now();
            true
        }
        Some(_) => false,
        None if cached.models.fallback => age < MODELS_RETRY,
        None => age < MODELS_TTL,
    }
}

async fn read_all(source: Option<&mut (impl tokio::io::AsyncRead + Unpin)>, into: &mut Vec<u8>) {
    if let Some(source) = source {
        let _ = source.read_to_end(into).await;
    }
}

struct UpdateMarker<'a> {
    set: &'a Mutex<HashSet<String>>,
    id: String,
}

impl Drop for UpdateMarker<'_> {
    fn drop(&mut self) {
        lock(self.set).remove(&self.id);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
