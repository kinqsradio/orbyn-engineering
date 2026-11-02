//! Engine registry, status and updates. Updates run only through the installer
//! that provably owns the binary, and never while a run is active.

pub mod instances;
pub mod known;
pub mod maintenance;
pub mod manifest;
pub mod probe;

use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use orbyn_contracts::{
    AuthState, CustomEngine, EngineModels, EngineStatus, EngineTier, InstallerKind, ModelSelection,
    ProviderInstance, VersionSupport,
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
use known::{KNOWN_ENGINES, known_engine};
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
    /// Automatic known-provider discovery; explicit registrations remain available.
    pub known_engine_ids: Option<Vec<String>>,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            claude_program: "claude".into(),
            codex_program: "codex".into(),
            codex_sandbox: "workspace-write".into(),
            lookup_latest: true,
            update_timeout: UPDATE_TIMEOUT,
            known_engine_ids: None,
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
        let id = engine.id.clone();
        self.custom_driver_for(engine, &id)
    }

    /// `engine`, launched the way the known engine `base` has to be, if it is one.
    fn custom_driver_for(&self, engine: CustomEngine, base: &str) -> Result<Arc<dyn EngineDriver>> {
        let known = known_engine(base);
        match engine.tier {
            EngineTier::Acp => Ok(Arc::new(match known {
                Some(known) => AcpDriver::known(engine, known),
                None => AcpDriver::new(engine),
            })),
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
        if let Some(driver) = self.base_driver(id)? {
            return Ok(driver);
        }
        let instance = self
            .instances()?
            .into_iter()
            .find(|instance| instance.id == id)
            .ok_or_else(|| CoreError::NotFound(format!("engine {id}")))?;
        self.instance_driver(&instance)
    }

    /// A built-in, custom or known engine: anything that is not an instance. Custom
    /// comes before known, so a person's own launch of an agent wins.
    fn base_driver(&self, id: &str) -> Result<Option<Arc<dyn EngineDriver>>> {
        if let Some(driver) = lock(&self.drivers)
            .iter()
            .find(|driver| driver.descriptor().id == id)
        {
            return Ok(Some(driver.clone()));
        }
        let custom = self
            .store
            .list_custom_engines()?
            .into_iter()
            .find(|engine| engine.id == id);
        match custom.or_else(|| known_engine(id).map(known::KnownEngine::as_custom)) {
            Some(engine) => self.custom_driver(engine).map(Some),
            None => Ok(None),
        }
    }

    fn instance_driver(&self, instance: &ProviderInstance) -> Result<Arc<dyn EngineDriver>> {
        let base = self
            .base_driver(&instance.driver)?
            .ok_or_else(|| CoreError::NotFound(format!("engine {}", instance.driver)))?;
        if let Some(driver) = base.instance(instance) {
            return Ok(driver);
        }
        let custom = self
            .store
            .list_custom_engines()?
            .into_iter()
            .find(|engine| engine.id == instance.driver)
            .or_else(|| known_engine(&instance.driver).map(known::KnownEngine::as_custom))
            .ok_or_else(|| {
                CoreError::Invalid(format!("{} cannot have instances.", instance.driver))
            })?;
        let mut args = custom.args;
        args.extend(instance.args.iter().cloned());
        let target = instance.program.clone().unwrap_or(custom.target);
        let name = instance.name.clone().unwrap_or(custom.name);
        self.custom_driver_for(
            CustomEngine {
                id: instance.id.clone(),
                name,
                tier: custom.tier,
                target,
                args,
            },
            &instance.driver,
        )
    }

    fn instances(&self) -> Result<Vec<ProviderInstance>> {
        let value =
            crate::preferences::stored_preference(&self.store, instances::PREFERENCE, None)?;
        instances::parse(&value)
    }

    /// Refuses a list of instances that could not launch as written.
    pub fn check_instances(&self, list: &[ProviderInstance]) -> Result<()> {
        instances::check(list, |id| {
            self.base_driver(id)
                .ok()
                .flatten()
                .map(|driver| driver.descriptor().tier)
        })
    }

    /// Refuses a new run on an instance that was turned off.
    pub fn check_enabled(&self, id: &str) -> Result<()> {
        let off = self
            .instances()?
            .iter()
            .any(|instance| instance.id == id && !instance.enabled);
        if off {
            return Err(CoreError::Invalid(format!("{id} is turned off.")));
        }
        Ok(())
    }

    fn all_drivers(&self) -> Result<Vec<Arc<dyn EngineDriver>>> {
        let mut drivers = lock(&self.drivers).clone();
        let custom = self.store.list_custom_engines()?;
        for engine in KNOWN_ENGINES {
            if self
                .config
                .known_engine_ids
                .as_ref()
                .is_none_or(|ids| ids.iter().any(|id| id == engine.id))
                && engine.is_installed()
                && !custom.iter().any(|own| own.id == engine.id)
            {
                drivers.push(self.custom_driver(engine.as_custom())?);
            }
        }
        for engine in custom {
            drivers.push(self.custom_driver(engine)?);
        }
        for instance in self.instances()? {
            if !instance.enabled {
                continue;
            }
            // A driver since removed leaves the instance listed nowhere, not the
            // whole engine list failed.
            if let Ok(driver) = self.instance_driver(&instance) {
                drivers.push(driver);
            }
        }
        Ok(drivers)
    }

    /// Instances may share a binary, so no run starts during any engine update.
    pub fn admit_with<T>(&self, engine: &str, admit: impl FnOnce() -> Result<T>) -> Result<T> {
        let updating = lock(&self.updating);
        if !updating.is_empty() {
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

    /// An instance id can now launch another driver, whose old models cannot apply.
    pub async fn instances_changed(&self) {
        self.invalidate().await;
        // Keep the catalog lock until both caches are cleared: an in-flight read
        // must not restore the old driver's validation after this returns.
        let mut models = self.models.lock().await;
        models.clear();
        lock(&self.known_models).clear();
    }

    /// What the engine says it offers. A failure is reported with the list empty,
    /// so custom models still work, and only a good answer is kept for long.
    pub async fn models(&self, id: &str, refresh: bool) -> Result<EngineModels> {
        let mut cache = self.models.lock().await;
        let driver = self.driver(id)?;
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
        // An answer that lost every model says less than the list already held, so it
        // cannot replace it. Nor can a stand-in or a failure.
        if !refresh_can_replace(&catalog, &error)
            && let Some(known) = lock(&self.known_models).get(id)
        {
            let mut kept = known.clone();
            kept.error = catalog.fallback.or(error);
            return Ok(kept);
        }
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
        let family = driver.family();
        let support = if descriptor.tier == EngineTier::Native {
            self.manifest.support(&family, probe.version.as_deref())
        } else {
            VersionSupport::Unknown
        };
        let manual_hint = if plan.is_none() {
            driver.manual_hint()
        } else {
            None
        };
        let (inherited_credentials, endpoint_origin) = crate::child_env::inherited_login(&family);
        let instance = self
            .instances()
            .unwrap_or_default()
            .into_iter()
            .find(|instance| instance.id == descriptor.id);
        EngineStatus {
            instance_of: instance.as_ref().map(|one| one.driver.clone()),
            accent: instance.and_then(|one| one.accent),
            inherited_credentials,
            endpoint_origin,
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
        // An installer's exit code says it finished, not that anything changed.
        if after.version == before.version {
            self.invalidate().await;
            return Err(CoreError::UpdateFailed(format!(
                "The update ran, but this is still version {}.",
                after.version.unwrap_or_default()
            )));
        }
        self.invalidate().await;
        self.status(id).await
    }

    /// Instances may share the installation being updated. Admission holds this
    /// same lock through its durable write, so either the run or update wins.
    fn begin_update(&self, id: &str) -> Result<UpdateMarker<'_>> {
        let mut updating = lock(&self.updating);
        if updating.contains(id) || !self.store.active_runs()?.is_empty() {
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

fn refresh_can_replace(catalog: &ModelCatalog, error: &Option<String>) -> bool {
    error.is_none() && catalog.fallback.is_none() && !catalog.models.is_empty()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Admission, NewProject, NewThread};
    use crate::testing::TempDir;

    fn manager(dir: &TempDir) -> EngineManager {
        EngineManager::new(
            Arc::new(Store::open(&dir.path().join("store.sqlite3"), "test").unwrap()),
            Arc::new(TerminalManager::default()),
            reqwest::Client::new(),
            EngineConfig::default(),
        )
    }

    #[tokio::test]
    async fn an_instance_run_blocks_updates_of_the_shared_engine() {
        let dir = TempDir::new();
        let engines = manager(&dir);
        let project = engines
            .store
            .add_project(NewProject {
                path: "/project",
                name: "project",
                is_git: false,
                managed: false,
                scratch: false,
            })
            .unwrap();
        engines.store.trust_project(&project.id, "test").unwrap();
        let thread = engines
            .store
            .create_thread(NewThread {
                project_id: project.id,
                title: "test".into(),
                engine: "claude-beta".into(),
                model: None,
                cwd: "/project".into(),
                worktree: None,
                skill_profile: None,
                parent_thread_id: None,
                relation: None,
                scratch: false,
            })
            .unwrap();
        let run = engines
            .admit_with("claude-beta", || {
                engines.store.admit_run(Admission {
                    thread_id: &thread.id,
                    prompt: "test",
                    actor: "test",
                })
            })
            .unwrap();
        assert!(matches!(
            engines.begin_update("claude"),
            Err(CoreError::EngineBusy(_))
        ));
        engines
            .store
            .finish_run(&run.id, orbyn_contracts::RunState::Completed, None)
            .unwrap();
        assert!(engines.begin_update("claude").is_ok());
    }

    #[tokio::test]
    async fn an_engine_update_blocks_admission_through_an_instance() {
        let dir = TempDir::new();
        let engines = manager(&dir);
        let marker = engines.begin_update("claude").unwrap();
        assert!(matches!(
            engines.admit_with("claude-beta", || Ok(())),
            Err(CoreError::EngineBusy(_))
        ));
        drop(marker);
        assert!(engines.admit_with("claude-beta", || Ok(())).is_ok());
    }
}
