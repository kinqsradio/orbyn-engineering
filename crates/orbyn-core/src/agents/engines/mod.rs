//! Engine registry, status and updates. Updates run only through the installer
//! that provably owns the binary, and never while a run is active.

pub mod catalog_cache;
pub mod instances;
pub mod known;
pub mod maintenance;
pub mod manifest;
pub mod probe;
pub mod warm;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use orbyn_contracts::{
    AuthState, CustomEngine, EngineCompatibility, EngineFeedbackReceipt, EngineFeedbackRequest,
    EngineModels, EngineStatus, EngineTier, EngineUpdateProgress, InstallerKind, ModelSelection,
    ProviderInstance, VersionSupport,
};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use crate::agents::driver::acp::AcpDriver;
use crate::agents::driver::agui::AguiDriver;
use crate::agents::driver::claude::ClaudeDriver;
use crate::agents::driver::codex::CodexDriver;
use crate::agents::driver::terminal::TerminalDriver;
use crate::agents::driver::{EngineDriver, ModelCatalog, UpdatePlan};
use crate::error::{CoreError, Result};
use crate::host::process::{ManagedChild, engine_command, resolve};
use crate::host::terminal::TerminalManager;
use crate::store::{AuditRecord, Store};
use crate::util::tail;
use catalog_cache::{CatalogCache, Entry};
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
/// The longest installer line sent as progress, in characters.
const PROGRESS_LINE: usize = 500;

#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub claude_program: String,
    pub codex_program: String,
    pub codex_sandbox: String,
    pub lookup_latest: bool,
    pub update_timeout: Duration,
    /// Automatic known-provider discovery; explicit registrations remain available.
    pub known_engine_ids: Option<Vec<String>>,
    /// Where the last good model lists are kept. `None` keeps them in memory only.
    pub cache_dir: Option<PathBuf>,
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
            cache_dir: None,
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
    /// Short native-session operations and run startup. Configuration and updates
    /// cannot replace the command until the operation has settled.
    native_operations: Arc<Mutex<HashSet<String>>>,
    installer_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    statuses: tokio::sync::Mutex<Option<Vec<EngineStatus>>>,
    models: tokio::sync::Mutex<HashMap<String, CachedModels>>,
    /// The last good list of each engine, for checks that cannot wait for an engine.
    known_models: Mutex<HashMap<String, EngineModels>>,
    /// The same lists on disk, so a restart keeps what the engine last said.
    catalog: CatalogCache,
    /// Processes started ahead of each thread's next turn, by thread.
    warm: Mutex<HashMap<String, warm::WarmEntry>>,
    /// Warm processes being started. An update cannot begin while any is.
    warming: Arc<Mutex<usize>>,
    /// Each step of an update while it runs. Nothing is kept for a late listener.
    progress: tokio::sync::broadcast::Sender<EngineUpdateProgress>,
}

/// A warm process being started; updates wait until it is dropped.
pub struct WarmStart(Arc<Mutex<usize>>);

impl Drop for WarmStart {
    fn drop(&mut self) {
        let mut count = lock(&self.0);
        *count = count.saturating_sub(1);
    }
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
            catalog: CatalogCache::new(config.cache_dir.clone()),
            store,
            terminals,
            http,
            config,
            manifest: TestedManifest::embedded(),
            drivers: Mutex::new(drivers),
            updating: Mutex::new(HashSet::new()),
            native_operations: Arc::default(),
            installer_locks: Mutex::new(HashMap::new()),
            warm: Mutex::new(HashMap::new()),
            warming: Arc::new(Mutex::new(0)),
            progress: tokio::sync::broadcast::channel(256).0,
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
        let base = self.base_driver(&instance.driver)?;
        if instance.driver == instances::LOCAL_ACP_DRIVER && base.is_none() {
            let target = instance
                .program
                .clone()
                .filter(|program| {
                    !program.trim().is_empty() && !program.contains('\0') && program.len() <= 4096
                })
                .ok_or_else(|| {
                    CoreError::Invalid("A local ACP instance needs a program.".into())
                })?;
            return Ok(Arc::new(AcpDriver::new(CustomEngine {
                id: instance.id.clone(),
                name: instance.name.clone().unwrap_or_else(|| instance.id.clone()),
                tier: EngineTier::Acp,
                target,
                args: instance.args.clone(),
            })));
        }
        let base =
            base.ok_or_else(|| CoreError::NotFound(format!("engine {}", instance.driver)))?;
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
        let value = crate::settings::preferences::stored_preference(
            &self.store,
            instances::PREFERENCE,
            None,
        )?;
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

    /// Holds off every engine update while a warm process starts, or refuses while
    /// one is running.
    pub fn begin_warm(&self) -> Option<WarmStart> {
        let updating = lock(&self.updating);
        if !updating.is_empty() {
            return None;
        }
        *lock(&self.warming) += 1;
        Some(WarmStart(self.warming.clone()))
    }

    /// True while `thread` has a process waiting for its next turn.
    pub fn has_warm(&self, thread: &str) -> bool {
        lock(&self.warm).contains_key(thread)
    }

    /// Keeps a process for `thread`'s next turn, replacing any earlier one. Refused
    /// while an engine updates, since it would hold the binary being replaced.
    pub fn park_warm(&self, thread: &str, entry: warm::WarmEntry) -> bool {
        let updating = lock(&self.updating);
        if !updating.is_empty() {
            return false;
        }
        lock(&self.warm).insert(thread.to_owned(), entry);
        true
    }

    /// The process kept for `thread`, which is no longer kept either way.
    pub fn take_warm(&self, thread: &str) -> Option<warm::WarmEntry> {
        lock(&self.warm).remove(thread)
    }

    /// Ends `thread`'s warm process if it is still the one named `id`.
    pub fn expire_warm(&self, thread: &str, id: &str) {
        let mut warm = lock(&self.warm);
        if warm.get(thread).is_some_and(|entry| entry.id == id) {
            let entry = warm.remove(thread);
            drop(warm);
            drop(entry);
        }
    }

    /// Ends every warm process, as the service stops.
    pub fn end_warm(&self) {
        let warm = std::mem::take(&mut *lock(&self.warm));
        drop(warm);
    }

    /// Instances may share a binary, so no run starts during any engine update.
    pub fn admit_with<T>(&self, engine: &str, admit: impl FnOnce() -> Result<T>) -> Result<T> {
        let updating = lock(&self.updating);
        let operations = lock(&self.native_operations);
        if !updating.is_empty() || operations.contains(engine) {
            return Err(CoreError::EngineBusy(engine.to_owned()));
        }
        admit()
    }

    /// Begins one bounded operation for an effective instance. An active model
    /// turn alone does not block management of other native session IDs.
    pub fn begin_native_operation(&self, engine: &str) -> Result<NativeOperation> {
        let updating = lock(&self.updating);
        let mut operations = lock(&self.native_operations);
        if !updating.is_empty() || !operations.insert(engine.to_owned()) {
            return Err(CoreError::EngineBusy(engine.to_owned()));
        }
        Ok(NativeOperation {
            set: self.native_operations.clone(),
            id: engine.to_owned(),
        })
    }

    /// Holds admission exclusion while provider configuration is committed, so no
    /// command is replaced under a native-session operation or an update. Keep the
    /// gate only across the synchronous commit.
    pub fn configuration_gate(&self) -> Result<ConfigurationGate<'_>> {
        let updating = lock(&self.updating);
        let operations = lock(&self.native_operations);
        if let Some(engine) = operations.iter().next().or_else(|| updating.iter().next()) {
            return Err(CoreError::EngineBusy(engine.clone()));
        }
        Ok(ConfigurationGate {
            _updating: updating,
            _operations: operations,
        })
    }

    /// Runs `change` under the configuration gate.
    pub fn change_provider_configuration<T>(
        &self,
        change: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let _gate = self.configuration_gate()?;
        change()
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
            if status.tier == EngineTier::Acp {
                status.sign_in_command = crate::agents::driver::acp::known_sign_in(&status.id);
            }
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

    /// Sends a report through the engine's own feedback route.
    pub async fn feedback(
        &self,
        id: &str,
        request: &EngineFeedbackRequest,
    ) -> Result<EngineFeedbackReceipt> {
        self.driver(id)?.feedback(request).await
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
        if !refresh_can_replace(&catalog, &error) {
            let failure = catalog.fallback.clone().or_else(|| error.clone());
            let mut known = lock(&self.known_models);
            if let Some(stored) = known.get(id) {
                let mut kept = stored.clone();
                kept.error = failure;
                return Ok(kept);
            }
            // A list from another key belongs to a binary or login that is no longer
            // there, so it cannot answer for this one. Only a failed or stand-in
            // read may fall back: a good empty answer means the engine really has
            // no models, and an old list would hide that.
            if failure.is_some()
                && let Some(entry) = self
                    .catalog
                    .load(id)
                    .filter(|entry| entry.key.as_ref() == key.as_ref())
            {
                let mut kept = entry.models;
                kept.error = failure;
                known.insert(id.to_owned(), kept.clone());
                return Ok(kept);
            }
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
            // An empty answer is not a list worth restoring, so it does not replace
            // the last non-empty one a later failure would fall back to.
            if !models.models.is_empty() {
                self.catalog.save(
                    id,
                    &Entry {
                        key: key.clone(),
                        models: models.clone(),
                    },
                );
            }
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
            Some(catalog) => crate::agents::selection::check(catalog, selection),
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
        let compatibility = if descriptor.tier == EngineTier::Native {
            probe.version.as_deref().and_then(|installed| {
                compatibility(&self.manifest, &family, installed, plan.as_ref())
            })
        } else {
            None
        };
        let manual_hint = if plan.is_none() {
            driver.manual_hint()
        } else {
            None
        };
        let (inherited_credentials, endpoint_origin) =
            crate::host::child_env::inherited_login(&family);
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
            compatibility,
            update_command: plan.as_ref().map(UpdatePlan::display),
            manual_hint,
            sign_in_command: probe.sign_in_command,
            updating: false,
            problem: probe.problem,
            account: probe.account,
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

    /// Each step of every update from now on: the installer's command, the lines
    /// it prints, then how it ended.
    pub fn update_events(&self) -> tokio::sync::broadcast::Receiver<EngineUpdateProgress> {
        self.progress.subscribe()
    }

    fn emit(&self, event: EngineUpdateProgress) {
        // No listener is not an error: progress is only for whoever is watching.
        let _ = self.progress.send(event);
    }

    /// Updates an engine through its owning installer, then verifies by probing.
    pub async fn update(&self, id: &str, actor: &str) -> Result<EngineStatus> {
        self.update_to(id, actor, None).await
    }

    /// Updates, one at a time, every engine reporting a newer version that an owning
    /// installer can update. Instances and engines sharing one binary update once, and
    /// an engine with a signed warning is left to its recommended install. Each one
    /// goes through `update`, so a busy engine or a failed installer is reported and
    /// the rest still run.
    pub async fn update_all(
        &self,
        actor: &str,
    ) -> Result<Vec<orbyn_contracts::EngineUpdateOutcome>> {
        let mut binaries = std::collections::HashSet::new();
        let mut outcomes = Vec::new();
        for status in self.statuses(true).await? {
            if !wants_update(&status) {
                continue;
            }
            if let Some(path) = &status.path
                && !binaries.insert(path.clone())
            {
                continue;
            }
            let outcome = match self.update(&status.id, actor).await {
                Ok(after) => orbyn_contracts::EngineUpdateOutcome {
                    id: status.id,
                    name: status.name,
                    version: after.version,
                    error: None,
                },
                Err(error) => orbyn_contracts::EngineUpdateOutcome {
                    id: status.id,
                    name: status.name,
                    version: None,
                    error: Some(error.to_string()),
                },
            };
            outcomes.push(outcome);
        }
        Ok(outcomes)
    }

    /// Installs the version the signed manifest recommends, through the installer
    /// that owns the binary. Refused when the manifest recommends nothing, when
    /// that installer cannot install one exact version, or while a run is active.
    pub async fn install_recommended(&self, id: &str, actor: &str) -> Result<EngineStatus> {
        let driver = self.driver(id)?;
        let recommended = self.manifest.recommended(&driver.family()).ok_or_else(|| {
            CoreError::UpdateUnavailable(format!("No recommended version is recorded for {id}."))
        })?;
        self.update_to(id, actor, Some(&recommended)).await
    }

    async fn update_to(
        &self,
        id: &str,
        actor: &str,
        version: Option<&str>,
    ) -> Result<EngineStatus> {
        let driver = self.driver(id)?;
        let before = driver.probe().await;
        let plan = driver.update_plan(&before).await.ok_or_else(|| {
            CoreError::UpdateUnavailable(driver.manual_hint().unwrap_or_else(|| {
                "Orbyn cannot prove which installer owns this engine.".to_owned()
            }))
        })?;
        let plan = match version {
            None => plan,
            Some(version) => {
                if self.manifest.recommended(&driver.family()).as_deref() != Some(version) {
                    return Err(CoreError::Invalid(format!(
                        "{version} is not the recommended version for {id}."
                    )));
                }
                if before.version.as_deref() == Some(version) {
                    return Err(CoreError::UpdateUnavailable(format!(
                        "{id} is already on {version}."
                    )));
                }
                maintenance::pinned(&plan, version).ok_or_else(|| {
                    CoreError::UpdateUnavailable(driver.manual_hint().unwrap_or_else(|| {
                        "Orbyn cannot prove which installer owns this engine.".to_owned()
                    }))
                })?
            }
        };
        let _marker = self.begin_update(id)?;
        let installer_lock = {
            let mut locks = lock(&self.installer_locks);
            locks.entry(plan.lock_key.clone()).or_default().clone()
        };
        let _installer = installer_lock.lock().await;
        self.emit(EngineUpdateProgress::Started {
            engine: id.to_owned(),
            command: plan.display(),
        });
        let mut finish = Finish {
            engines: self,
            id: id.to_owned(),
            sent: false,
        };
        let result = self
            .apply_update(id, driver.as_ref(), &plan, before.version, actor)
            .await;
        finish.sent = true;
        self.emit(EngineUpdateProgress::Finished {
            engine: id.to_owned(),
            version: result.as_ref().ok().and_then(|after| after.version.clone()),
            error: result.as_ref().err().map(ToString::to_string),
        });
        result
    }

    /// Runs the installer and checks what it did. The caller holds the update marker
    /// and the installer lock.
    async fn apply_update(
        &self,
        id: &str,
        driver: &dyn EngineDriver,
        plan: &UpdatePlan,
        before: Option<String>,
        actor: &str,
    ) -> Result<EngineStatus> {
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: "engine.update".into(),
            target: plan.display(),
            decision: None,
            source: "user".into(),
            thread_id: None,
            run_id: None,
            detail: json!({ "engine": id, "from": before }),
        })?;
        let result = self.run_update(id, plan).await;
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
                "from": before,
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
        if after.version == before {
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
        let operations = lock(&self.native_operations);
        if updating.contains(id)
            || !operations.is_empty()
            || *lock(&self.warming) > 0
            || !self.store.active_runs()?.is_empty()
        {
            return Err(CoreError::EngineBusy(id.to_owned()));
        }
        updating.insert(id.to_owned());
        // Instances can share the binary, and Windows cannot replace a running one.
        let warm = std::mem::take(&mut *lock(&self.warm));
        drop(warm);
        Ok(UpdateMarker {
            set: &self.updating,
            id: id.to_owned(),
        })
    }

    /// Runs the installer to the end, sending each line it prints as progress. It is
    /// never stopped partway by a person: that could leave a half-written engine.
    async fn run_update(&self, id: &str, plan: &UpdatePlan) -> Result<String> {
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
            let progress = |line: String| {
                self.emit(EngineUpdateProgress::Output {
                    engine: id.to_owned(),
                    line,
                });
            };
            let (_, _, status) = tokio::join!(
                read_lines(stdout.as_mut(), &mut out, progress),
                read_lines(stderr.as_mut(), &mut err, progress),
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

/// The signed manifest's warning about an installed version, with the version it
/// recommends and whether the owning installer can install exactly that version.
/// Only a signed manifest can produce one, and only for a version it mentions.
fn compatibility(
    manifest: &TestedManifest,
    family: &str,
    installed: &str,
    plan: Option<&UpdatePlan>,
) -> Option<EngineCompatibility> {
    let (status, base) = manifest.problem(family, installed)?;
    let recommended = manifest
        .recommended(family)
        .filter(|recommended| recommended != installed);
    let message = match &recommended {
        Some(recommended) => format!("{base} Use {recommended}."),
        None => base,
    };
    let recommended_command = recommended
        .as_deref()
        .and_then(|version| plan.and_then(|plan| maintenance::pinned(plan, version)))
        .map(|plan| plan.display());
    Some(EngineCompatibility {
        status,
        message,
        recommended_version: recommended,
        recommended_command,
    })
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

/// Reads to the end, keeping every byte, and hands over each line as it finishes.
/// A carriage return ends a line too, because progress bars redraw with one.
async fn read_lines(
    source: Option<&mut (impl tokio::io::AsyncRead + Unpin)>,
    into: &mut Vec<u8>,
    line: impl Fn(String),
) {
    let Some(source) = source else { return };
    let mut chunk = [0u8; 4096];
    let mut start = into.len();
    loop {
        let read = match source.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        into.extend_from_slice(&chunk[..read]);
        while let Some(end) = into[start..]
            .iter()
            .position(|byte| *byte == b'\n' || *byte == b'\r')
        {
            send_line(&into[start..start + end], &line);
            start += end + 1;
        }
    }
    send_line(&into[start..], &line);
}

/// One printable line, without colour codes or other control characters, cut to
/// `PROGRESS_LINE` characters. Blank lines are skipped.
fn send_line(bytes: &[u8], line: &impl Fn(String)) {
    let text = strip_escapes(&String::from_utf8_lossy(bytes));
    let text = text.trim();
    if !text.is_empty() {
        line(text.chars().take(PROGRESS_LINE).collect());
    }
}

/// Drops ANSI escape sequences and the remaining control characters.
fn strip_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.next() {
                // A CSI sequence ends at its first character in @..~.
                Some('[') => {
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                // An OSC sequence, such as a window title, ends at BEL or ESC \.
                Some(']') => {
                    while let Some(next) = chars.next() {
                        if next == '\u{7}'
                            || (next == '\u{1b}' && chars.next_if_eq(&'\\').is_some())
                        {
                            break;
                        }
                    }
                }
                // A character-set choice carries one more character.
                Some('(' | ')') => {
                    chars.next();
                }
                _ => {}
            }
        } else if !c.is_control() || c == '\t' {
            out.push(c);
        }
    }
    out
}

/// Exclusion held for one configuration commit.
pub struct ConfigurationGate<'a> {
    _updating: MutexGuard<'a, HashSet<String>>,
    _operations: MutexGuard<'a, HashSet<String>>,
}

/// Dropping the operation releases admission even on cancellation or failure.
pub struct NativeOperation {
    set: Arc<Mutex<HashSet<String>>>,
    id: String,
}

impl Drop for NativeOperation {
    fn drop(&mut self) {
        lock(&self.set).remove(&self.id);
    }
}

/// Sends `finished` for an update dropped before it ended, so no listener is left
/// showing it as running.
struct Finish<'a> {
    engines: &'a EngineManager,
    id: String,
    sent: bool,
}

impl Drop for Finish<'_> {
    fn drop(&mut self) {
        if !self.sent {
            self.engines.emit(EngineUpdateProgress::Finished {
                engine: std::mem::take(&mut self.id),
                version: None,
                error: Some("The update stopped before it finished.".into()),
            });
        }
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

/// An engine `update_all` takes: not an instance, with an update an owning installer
/// can run, a newer version than the installed one, and no signed warning.
fn wants_update(status: &EngineStatus) -> bool {
    status.instance_of.is_none()
        && status.update_command.is_some()
        && status.compatibility.is_none()
        && status
            .latest
            .as_deref()
            .is_some_and(|latest| status.version.as_deref() != Some(latest))
}

#[cfg(test)]
mod tests {
    #[test]
    fn update_all_takes_only_an_owned_newer_engine_that_is_not_an_instance() {
        let base = serde_json::json!({
            "id": "codex", "name": "Codex", "tier": "native",
            "capabilities": {"streaming": true, "approvals": true, "resume": true, "mcp": true,
                "sandbox": true, "managed": true, "skill_delivery": [], "goal_control": false,
                "decline_feedback": false, "permission_modes": []},
            "installed": true, "path": "/bin/codex", "version": "0.166.0", "auth": "unknown",
            "installer": "npm", "latest": "0.167.0", "support": "unknown",
            "update_command": "npm install -g @openai/codex@latest", "manual_hint": null,
            "sign_in_command": null, "updating": false, "problem": null
        });
        let status = |change: serde_json::Value| -> EngineStatus {
            let mut value = base.clone();
            value
                .as_object_mut()
                .unwrap()
                .extend(change.as_object().unwrap().clone());
            serde_json::from_value(value).unwrap()
        };
        assert!(wants_update(&status(serde_json::json!({}))));
        assert!(!wants_update(&status(
            serde_json::json!({"latest": "0.166.0"})
        )));
        assert!(!wants_update(&status(serde_json::json!({"latest": null}))));
        assert!(!wants_update(&status(
            serde_json::json!({"update_command": null})
        )));
        assert!(!wants_update(&status(
            serde_json::json!({"instance_of": "codex"})
        )));
    }

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
    async fn native_operations_exclude_command_changes_and_same_instance_admission() {
        let dir = TempDir::new();
        let engines = manager(&dir);
        let operation = engines.begin_native_operation("work").unwrap();
        assert!(matches!(
            engines.begin_native_operation("work"),
            Err(CoreError::EngineBusy(_))
        ));
        let mut changed = false;
        assert!(matches!(
            engines.change_provider_configuration(|| {
                changed = true;
                Ok(())
            }),
            Err(CoreError::EngineBusy(_))
        ));
        assert!(!changed);
        assert!(matches!(
            engines.admit_with("work", || Ok(())),
            Err(CoreError::EngineBusy(_))
        ));
        assert!(engines.admit_with("other", || Ok(())).is_ok());
        assert!(matches!(
            engines.begin_update("claude"),
            Err(CoreError::EngineBusy(_))
        ));
        drop(operation);
        engines
            .change_provider_configuration(|| {
                changed = true;
                Ok(())
            })
            .unwrap();
        assert!(changed);
        assert!(engines.admit_with("work", || Ok(())).is_ok());
        let update = engines.begin_update("claude").unwrap();
        assert!(matches!(
            engines.begin_native_operation("work"),
            Err(CoreError::EngineBusy(_))
        ));
        drop(update);
        assert!(engines.begin_native_operation("work").is_ok());
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

    struct KeyedDriver {
        key: Option<String>,
        failing: bool,
        empty: bool,
    }

    #[async_trait::async_trait]
    impl EngineDriver for KeyedDriver {
        fn descriptor(&self) -> crate::agents::driver::EngineDescriptor {
            crate::agents::driver::EngineDescriptor {
                id: "keyed".into(),
                name: "Keyed".into(),
                tier: orbyn_contracts::EngineTier::Terminal,
                capabilities: orbyn_contracts::EngineCapabilities {
                    streaming: false,
                    approvals: false,
                    resume: false,
                    mcp: false,
                    sandbox: false,
                    managed: true,
                    skill_delivery: Vec::new(),
                    goal_control: false,
                    decline_feedback: false,
                    permission_modes: orbyn_contracts::PermissionMode::ALL.to_vec(),
                },
            }
        }

        async fn probe(&self) -> crate::agents::driver::EngineProbe {
            crate::agents::driver::EngineProbe::default()
        }

        async fn start_run(
            &self,
            _spec: crate::agents::driver::RunSpec,
            _events: tokio::sync::mpsc::Sender<crate::agents::driver::EngineEvent>,
        ) -> Result<crate::agents::driver::RunHandle> {
            Err(CoreError::Unsupported("no run".into()))
        }

        async fn models(&self) -> Result<Option<ModelCatalog>> {
            if self.failing {
                return Err(CoreError::EngineUnavailable("the engine is gone".into()));
            }
            if self.empty {
                return Ok(Some(ModelCatalog::engine(Vec::new())));
            }
            Ok(Some(ModelCatalog::engine(vec![
                orbyn_contracts::ModelInfo {
                    id: "keyed-model".into(),
                    label: "Keyed Model".into(),
                    description: None,
                    is_default: true,
                    custom: false,
                    options: Vec::new(),
                    input_modalities: Vec::new(),
                    upgrade: None,
                },
            ])))
        }

        async fn catalog_key(&self) -> Option<String> {
            self.key.clone()
        }
    }

    fn keyed_manager(
        dir: &TempDir,
        key: Option<&str>,
        failing: bool,
        empty: bool,
    ) -> EngineManager {
        let config = EngineConfig {
            cache_dir: Some(dir.path().join("model-cache")),
            ..EngineConfig::default()
        };
        let engines = EngineManager::new(
            Arc::new(Store::open(&dir.path().join("store.sqlite3"), "test").unwrap()),
            Arc::new(TerminalManager::default()),
            reqwest::Client::new(),
            config,
        );
        engines.register(Arc::new(KeyedDriver {
            key: key.map(str::to_owned),
            failing,
            empty,
        }));
        engines
    }

    /// A restart has no memory, so the disk copy answers only for its own key.
    #[tokio::test]
    async fn a_stored_catalog_is_served_only_under_its_own_key() {
        let dir = TempDir::new();
        let good = keyed_manager(&dir, Some("one"), false, false)
            .models("keyed", true)
            .await
            .unwrap();
        assert!(good.error.is_none());

        let changed = keyed_manager(&dir, Some("two"), true, false)
            .models("keyed", true)
            .await
            .unwrap();
        assert!(changed.models.is_empty(), "{changed:?}");
        assert!(changed.error.is_some());

        let remembered = keyed_manager(&dir, Some("one"), true, false)
            .models("keyed", true)
            .await
            .unwrap();
        assert_eq!(remembered.models, good.models);
        assert_eq!(remembered.checked_at, good.checked_at);
        assert!(remembered.error.unwrap().contains("engine is gone"));
    }

    /// A failing first read leaves nothing behind for the next start to trust.
    #[tokio::test]
    async fn a_failure_is_not_saved() {
        let dir = TempDir::new();
        let failed = keyed_manager(&dir, None, true, false)
            .models("keyed", true)
            .await
            .unwrap();
        assert!(failed.models.is_empty());
        assert!(!dir.path().join("model-cache/catalog.json").exists());
    }

    /// A good answer with no models means the engine has none, so a remembered
    /// list must not stand in for it and look freshly reported.
    #[tokio::test]
    async fn an_empty_answer_is_not_replaced_by_the_stored_catalog() {
        let dir = TempDir::new();
        let good = keyed_manager(&dir, Some("one"), false, false)
            .models("keyed", true)
            .await
            .unwrap();
        assert!(!good.models.is_empty());

        let empty = keyed_manager(&dir, Some("one"), false, true)
            .models("keyed", true)
            .await
            .unwrap();
        assert!(empty.models.is_empty(), "{empty:?}");
        assert!(empty.error.is_none(), "{empty:?}");

        let stored = std::fs::read_to_string(dir.path().join("model-cache/catalog.json")).unwrap();
        assert!(stored.contains("keyed-model"));
    }

    /// Only the signed manifest raises a warning, and only its own installer may
    /// install the version it recommends.
    #[test]
    fn compatibility_comes_from_the_signed_manifest_alone() {
        let manifest = TestedManifest::embedded();
        let plan = UpdatePlan {
            installer: InstallerKind::Npm,
            program: "npm".into(),
            args: ["install", "-g", "@openai/codex@latest"]
                .iter()
                .map(|arg| (*arg).to_string())
                .collect(),
            lock_key: "npm".into(),
        };
        let below = compatibility(&manifest, "codex", "0.160.0", Some(&plan)).unwrap();
        assert_eq!(
            below.status,
            orbyn_contracts::CompatibilityStatus::Unsupported
        );
        assert_eq!(below.recommended_version.as_deref(), Some("0.166.0"));
        assert_eq!(
            below.recommended_command.as_deref(),
            Some("npm install -g @openai/codex@0.166.0")
        );
        assert_eq!(
            below.message,
            "This engine version is outside the supported range for this Orbyn release. Use 0.166.0."
        );
        // Without an installer that can pin the version, the card keeps its manual route.
        let manual = compatibility(&manifest, "codex", "0.160.0", None).unwrap();
        assert_eq!(manual.recommended_command, None);
        assert_eq!(manual.message, below.message);
        // Supported, untested and unknown versions raise nothing at all.
        assert!(compatibility(&manifest, "codex", "0.166.0", Some(&plan)).is_none());
        assert!(compatibility(&manifest, "claude", "2.1.318", Some(&plan)).is_none());
        assert!(compatibility(&manifest, "other", "1.0.0", Some(&plan)).is_none());
    }

    /// An installer that prints, waits to be told to go on, then writes the new
    /// version. Arguments: the version file, the go-on file.
    const INSTALLER: &str = r#"
const fs = require('fs');
const [version, go] = process.argv.slice(1);
process.stdout.write('fetching\n');
process.stderr.write('\x1b[32mhalf\x1b[0m\rlinked\n');
const wait = setInterval(() => {
  if (!fs.existsSync(go)) return;
  clearInterval(wait);
  fs.writeFileSync(version, '2.0.0');
  process.stdout.write('added 1 package');
}, 20);
"#;

    struct PlannedDriver {
        version: PathBuf,
        go: PathBuf,
    }

    #[async_trait::async_trait]
    impl EngineDriver for PlannedDriver {
        fn descriptor(&self) -> crate::agents::driver::EngineDescriptor {
            let mut descriptor = KeyedDriver {
                key: None,
                failing: false,
                empty: false,
            }
            .descriptor();
            descriptor.id = "planned".into();
            descriptor
        }

        async fn probe(&self) -> crate::agents::driver::EngineProbe {
            crate::agents::driver::EngineProbe {
                path: Some(self.version.clone()),
                version: std::fs::read_to_string(&self.version).ok(),
                ..Default::default()
            }
        }

        async fn update_plan(
            &self,
            _probe: &crate::agents::driver::EngineProbe,
        ) -> Option<UpdatePlan> {
            Some(UpdatePlan {
                installer: InstallerKind::Npm,
                program: "node".into(),
                args: vec![
                    "-e".into(),
                    INSTALLER.into(),
                    self.version.to_string_lossy().into_owned(),
                    self.go.to_string_lossy().into_owned(),
                ],
                lock_key: "planned".into(),
            })
        }

        async fn start_run(
            &self,
            _spec: crate::agents::driver::RunSpec,
            _events: tokio::sync::mpsc::Sender<crate::agents::driver::EngineEvent>,
        ) -> Result<crate::agents::driver::RunHandle> {
            Err(CoreError::Unsupported("no run".into()))
        }
    }

    async fn next(
        events: &mut tokio::sync::broadcast::Receiver<EngineUpdateProgress>,
    ) -> EngineUpdateProgress {
        tokio::time::timeout(Duration::from_secs(20), events.recv())
            .await
            .expect("an update step in time")
            .unwrap()
    }

    #[tokio::test]
    async fn an_update_reports_each_installer_line_while_it_runs() {
        let dir = TempDir::new();
        let engines = Arc::new(manager(&dir));
        let version = dir.path().join("version");
        let go = dir.path().join("go");
        std::fs::write(&version, "1.0.0").unwrap();
        engines.register(Arc::new(PlannedDriver {
            version: version.clone(),
            go: go.clone(),
        }));
        let mut events = engines.update_events();
        let update = tokio::spawn({
            let engines = engines.clone();
            async move { engines.update("planned", "test").await }
        });

        let EngineUpdateProgress::Started { engine, command } = next(&mut events).await else {
            panic!("the update did not start first");
        };
        assert_eq!(engine, "planned");
        assert!(command.starts_with("node -e"));
        let mut lines = Vec::new();
        while lines.len() < 3 {
            match next(&mut events).await {
                EngineUpdateProgress::Output { engine, line } => {
                    assert_eq!(engine, "planned");
                    lines.push(line);
                }
                other => panic!("expected a line, got {other:?}"),
            }
        }
        // Stdout and stderr arrive in either order; each keeps its own.
        lines.sort();
        assert_eq!(lines, ["fetching", "half", "linked"]);
        // The installer is still waiting, so the lines came while it ran.
        assert!(!update.is_finished());

        std::fs::write(&go, "").unwrap();
        assert_eq!(
            next(&mut events).await,
            EngineUpdateProgress::Output {
                engine: "planned".into(),
                line: "added 1 package".into(),
            }
        );
        assert_eq!(
            next(&mut events).await,
            EngineUpdateProgress::Finished {
                engine: "planned".into(),
                version: Some("2.0.0".into()),
                error: None,
            }
        );
        assert_eq!(
            update.await.unwrap().unwrap().version.as_deref(),
            Some("2.0.0")
        );
    }

    #[tokio::test]
    async fn an_update_that_changes_nothing_finishes_with_its_error() {
        let dir = TempDir::new();
        let engines = manager(&dir);
        let version = dir.path().join("version");
        std::fs::write(&version, "2.0.0").unwrap();
        engines.register(Arc::new(PlannedDriver {
            version,
            go: dir.path().join("go"),
        }));
        std::fs::write(dir.path().join("go"), "").unwrap();
        let mut events = engines.update_events();
        let error = engines.update("planned", "test").await.unwrap_err();
        let mut last = None;
        while let Ok(event) = events.try_recv() {
            last = Some(event);
        }
        assert_eq!(
            last,
            Some(EngineUpdateProgress::Finished {
                engine: "planned".into(),
                version: None,
                error: Some(error.to_string()),
            })
        );
    }

    #[tokio::test]
    async fn a_dropped_update_still_finishes_for_its_listeners() {
        let dir = TempDir::new();
        let engines = Arc::new(manager(&dir));
        let version = dir.path().join("version");
        std::fs::write(&version, "1.0.0").unwrap();
        engines.register(Arc::new(PlannedDriver {
            version,
            go: dir.path().join("go"),
        }));
        let mut events = engines.update_events();
        let update = tokio::spawn({
            let engines = engines.clone();
            async move { engines.update("planned", "test").await }
        });
        assert!(matches!(
            next(&mut events).await,
            EngineUpdateProgress::Started { .. }
        ));
        update.abort();
        loop {
            if let EngineUpdateProgress::Finished { version, error, .. } = next(&mut events).await {
                assert_eq!(version, None);
                assert!(error.unwrap().contains("stopped"));
                break;
            }
        }
    }

    #[test]
    fn a_progress_line_drops_colour_codes_and_control_characters() {
        assert_eq!(
            strip_escapes("\u{1b}[1;31merror\u{1b}[0m\u{7} done"),
            "error done"
        );
        assert_eq!(
            strip_escapes("\u{1b}]0;npm install\u{7}\u{1b}(Badded\u{1b}]8;;x\u{1b}\\ 1"),
            "added 1"
        );
    }
}
