//! One view of what can be updated: the skills library, the app and the engines.
//! Checks only read, and nothing here applies on its own. A failed check keeps
//! what was known, since the last good answer beats no answer.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use orbyn_contracts::{
    AppMode, AppUpdateStatus, ApplyAllResult, EngineStatus, EngineUpdateStatus,
    LibraryUpdateStatus, UpdateStatus, UpdateStep,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::engines::EngineManager;
use crate::engines::manifest::is_newer;
use crate::error::{CoreError, Result};
use crate::store::{AuditRecord, Store};
use crate::util::now;
use crate::workspace::Workspace;

/// How long nobody must have done anything before an automatic install.
const IDLE_BEFORE_INSTALL: Duration = Duration::from_secs(2 * 60);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(8);
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Default)]
struct Known {
    app_latest: Option<String>,
    app_notes: Option<String>,
    unconfigured: bool,
    downloaded: Option<u64>,
    total: Option<u64>,
    /// The latest version each engine last reported, kept across failed lookups.
    engine_latest: HashMap<String, String>,
    checked_at: Option<String>,
    error: Option<String>,
}

pub struct UpdateCenter {
    store: Arc<Store>,
    workspace: Arc<Workspace>,
    engines: Arc<EngineManager>,
    http: reqwest::Client,
    manifest_url: Option<String>,
    known: Mutex<Known>,
    /// Lines for the desktop shell. Present exactly when one is attached.
    shell: Mutex<Option<mpsc::UnboundedSender<Value>>>,
    changes: watch::Sender<u64>,
    /// When someone last did something through a client.
    last_activity: Mutex<Instant>,
}

#[derive(Deserialize)]
struct ReleaseManifest {
    version: String,
    #[serde(default)]
    notes: Option<String>,
}

impl UpdateCenter {
    pub fn new(
        store: Arc<Store>,
        workspace: Arc<Workspace>,
        engines: Arc<EngineManager>,
        http: reqwest::Client,
        manifest_url: Option<String>,
    ) -> Self {
        Self {
            store,
            workspace,
            engines,
            http,
            manifest_url,
            known: Mutex::new(Known::default()),
            shell: Mutex::new(None),
            changes: watch::channel(0).0,
            last_activity: Mutex::new(Instant::now()),
        }
    }

    /// Marks a person as present, which puts off an automatic install.
    pub fn note_activity(&self) {
        *lock(&self.last_activity) = Instant::now();
    }

    fn idle_for(&self) -> Duration {
        lock(&self.last_activity).elapsed()
    }

    /// Installs an app update only with `automatic` chosen, nothing running and nobody
    /// at the app for two minutes. Engines and the library always wait to be asked.
    pub async fn auto_install(&self, mode: &str) {
        self.auto_install_after(mode, IDLE_BEFORE_INSTALL).await;
    }

    async fn auto_install_after(&self, mode: &str, idle: Duration) -> bool {
        if mode != "automatic" || self.idle_for() < idle {
            return false;
        }
        if !self.status().await.app.can_apply {
            return false;
        }
        match self.apply_app("system:auto-update").await {
            Ok(()) => true,
            Err(error) => {
                tracing::debug!(%error, "an automatic update did not start");
                false
            }
        }
    }

    /// Connects the desktop shell. The receiver yields lines for its stdout.
    pub fn attach_shell(&self) -> mpsc::UnboundedReceiver<Value> {
        let (sender, receiver) = mpsc::unbounded_channel();
        *lock(&self.shell) = Some(sender);
        receiver
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    fn changed(&self) {
        self.changes.send_modify(|version| *version += 1);
    }

    fn mode(&self) -> AppMode {
        if lock(&self.shell).is_some() {
            AppMode::Desktop
        } else {
            AppMode::Server
        }
    }

    fn to_shell(&self, line: Value) -> bool {
        lock(&self.shell)
            .as_ref()
            .is_some_and(|sender| sender.send(line).is_ok())
    }

    /// Reads one line from the shell. Anything unrecognized is ignored, so the
    /// two sides can be upgraded apart from each other.
    pub fn on_shell_line(&self, line: &str) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            tracing::debug!("ignoring a malformed shell line");
            return;
        };
        let text = |key: &str| message.get(key).and_then(Value::as_str).map(str::to_owned);
        {
            let mut known = lock(&self.known);
            match message.get("type").and_then(Value::as_str) {
                Some("app_update_available") => {
                    known.app_latest = text("version");
                    known.app_notes = text("notes");
                    known.unconfigured = false;
                }
                Some("app_update_none") => {
                    known.app_latest = None;
                    known.app_notes = None;
                    known.unconfigured = false;
                }
                Some("app_update_unconfigured") => {
                    known.app_latest = None;
                    known.unconfigured = true;
                }
                Some("app_update_progress") => {
                    known.downloaded = message.get("downloaded").and_then(Value::as_u64);
                    known.total = message.get("total").and_then(Value::as_u64);
                }
                Some("app_update_failed") => {
                    known.error = text("message");
                    known.downloaded = None;
                    known.total = None;
                    self.workspace.release_install();
                }
                _ => return,
            }
        }
        self.changed();
    }

    /// Looks at the world without changing it. Each source fails on its own.
    pub async fn check(&self) -> UpdateStatus {
        let mut errors = Vec::new();
        if self.workspace.root().is_ok()
            && let Err(error) = self.workspace.fetch().await
        {
            errors.push(format!("Library: {}", error.public_message()));
        }
        match self.engines.statuses(true).await {
            Ok(statuses) => {
                let mut known = lock(&self.known);
                for status in statuses {
                    if let Some(latest) = status.latest {
                        known.engine_latest.insert(status.id, latest);
                    }
                }
            }
            Err(error) => errors.push(format!("Engines: {}", error.public_message())),
        }
        if self.mode() == AppMode::Desktop {
            self.to_shell(json!({ "type": "check_app_update" }));
        } else if let Err(message) = self.check_manifest().await {
            errors.push(format!("App: {message}"));
        }
        {
            let mut known = lock(&self.known);
            if errors.is_empty() {
                known.checked_at = Some(now());
                known.error = None;
            } else {
                known.error = Some(errors.join(" "));
            }
        }
        self.changed();
        self.status().await
    }

    async fn check_manifest(&self) -> std::result::Result<(), String> {
        let Some(url) = &self.manifest_url else {
            lock(&self.known).unconfigured = true;
            return Ok(());
        };
        let response = self
            .http
            .get(url)
            .timeout(MANIFEST_TIMEOUT)
            .send()
            .await
            .map_err(|_| "The release manifest could not be reached.".to_owned())?;
        if !response.status().is_success() {
            return Err("The release manifest could not be read.".to_owned());
        }
        let manifest: ReleaseManifest = response
            .json()
            .await
            .map_err(|_| "The release manifest is malformed.".to_owned())?;
        let mut known = lock(&self.known);
        known.unconfigured = false;
        known.app_notes = manifest.notes;
        known.app_latest = Some(manifest.version);
        Ok(())
    }

    /// The current picture: local Git state and run activity are read fresh, and
    /// the network's answers come from the last check.
    pub async fn status(&self) -> UpdateStatus {
        let runs_active = self.store.active_runs().is_ok_and(|runs| !runs.is_empty());
        let library = self.library_status(runs_active).await;
        let engines = self.engine_statuses().await;
        let known = lock(&self.known);
        UpdateStatus {
            library,
            app: self.app_status(&known, runs_active),
            engines,
            checked_at: known.checked_at.clone(),
            error: known.error.clone(),
        }
    }

    async fn library_status(&self, runs_active: bool) -> LibraryUpdateStatus {
        let identity = self.workspace.identity().await.ok();
        let (ahead, behind, incoming) =
            self.workspace
                .local_position()
                .await
                .unwrap_or((0, 0, Vec::new()));
        let dirty = identity.as_ref().is_some_and(|(_, dirty)| *dirty);
        let blocked_reason = if identity.is_none() {
            Some("Set up the workspace first.".to_owned())
        } else if behind == 0 {
            Some("The library is up to date.".to_owned())
        } else if dirty {
            Some("The library has local edits.".to_owned())
        } else if ahead > 0 {
            Some("The library has its own commits, so it cannot fast-forward.".to_owned())
        } else if runs_active {
            Some("Finish or stop active runs first.".to_owned())
        } else {
            None
        };
        LibraryUpdateStatus {
            current: identity.map(|(revision, _)| revision),
            latest: self.workspace.upstream_revision().await,
            behind,
            ahead,
            dirty,
            incoming,
            can_apply: blocked_reason.is_none(),
            blocked_reason,
        }
    }

    async fn engine_statuses(&self) -> Vec<EngineUpdateStatus> {
        let statuses = self.engines.statuses(false).await.unwrap_or_default();
        let mut engines = Vec::with_capacity(statuses.len());
        for status in statuses {
            let latest = status
                .latest
                .clone()
                .or_else(|| lock(&self.known).engine_latest.get(&status.id).cloned());
            let busy = self
                .store
                .active_runs_for_engine(&status.id)
                .map_or(true, |count| count > 0);
            let blocked_reason = engine_block(&status, latest.as_deref(), busy);
            engines.push(EngineUpdateStatus {
                id: status.id,
                current: status.version,
                latest,
                support: status.support,
                can_apply: blocked_reason.is_none(),
                blocked_reason,
            });
        }
        engines
    }

    fn app_status(&self, known: &Known, runs_active: bool) -> AppUpdateStatus {
        let mode = self.mode();
        let newer = known
            .app_latest
            .as_deref()
            .is_some_and(|latest| is_newer(latest, APP_VERSION));
        let blocked_reason = match mode {
            AppMode::Server => Some(if known.unconfigured {
                "No release manifest is configured. Set --update-manifest to check for releases."
                    .to_owned()
            } else {
                "A server cannot replace itself. Install the new release and restart it.".to_owned()
            }),
            AppMode::Desktop if known.unconfigured => {
                Some("This build has no update channel.".to_owned())
            }
            AppMode::Desktop if !newer => Some("Orbyn is up to date.".to_owned()),
            AppMode::Desktop if runs_active => Some("Finish or stop active runs first.".to_owned()),
            AppMode::Desktop => None,
        };
        AppUpdateStatus {
            current: APP_VERSION.to_owned(),
            latest: known.app_latest.clone(),
            notes: known.app_notes.clone(),
            mode,
            can_apply: blocked_reason.is_none(),
            blocked_reason,
            unconfigured: known.unconfigured,
            downloaded: known.downloaded,
            total: known.total,
        }
    }

    /// Asks the shell to install. Admission stays held until exit, or until the
    /// shell reports that the install failed.
    pub async fn apply_app(&self, actor: &str) -> Result<()> {
        let app = self.status().await.app;
        if app.mode == AppMode::Server {
            return Err(CoreError::UpdateUnavailable(
                app.blocked_reason.unwrap_or_default(),
            ));
        }
        self.workspace.hold_for_install()?;
        if !app.can_apply {
            self.workspace.release_install();
            return Err(CoreError::UpdateUnavailable(
                app.blocked_reason.unwrap_or_default(),
            ));
        }
        self.audit(
            actor,
            "app.update.install",
            app.latest.as_deref().unwrap_or(""),
        )?;
        if !self.to_shell(json!({ "type": "install_app_update" })) {
            self.workspace.release_install();
            return Err(CoreError::UpdateFailed("The desktop shell is gone.".into()));
        }
        self.changed();
        Ok(())
    }

    /// Applies what can be applied, in order, stopping at the first failure.
    pub async fn apply_all(&self, actor: &str) -> Result<ApplyAllResult> {
        if !self.store.active_runs()?.is_empty() {
            return Err(CoreError::RunsActive);
        }
        let status = self.status().await;
        self.audit(actor, "updates.apply_all", "all")?;
        let mut steps = Vec::new();
        for engine in status.engines.iter().filter(|engine| engine.can_apply) {
            let outcome = self.engines.update(&engine.id, actor).await.map(|_| ());
            if !record(&mut steps, format!("engine:{}", engine.id), outcome) {
                return Ok(self.finish(steps));
            }
        }
        if status.library.can_apply {
            let outcome = self.workspace.update(true).await.map(|_| ());
            if !record(&mut steps, "library".to_owned(), outcome) {
                return Ok(self.finish(steps));
            }
        }
        if status.app.can_apply {
            let outcome = self.apply_app(actor).await;
            record(&mut steps, "app".to_owned(), outcome);
        }
        Ok(self.finish(steps))
    }

    fn finish(&self, steps: Vec<UpdateStep>) -> ApplyAllResult {
        self.changed();
        ApplyAllResult { steps }
    }

    fn audit(&self, actor: &str, action: &str, target: &str) -> Result<()> {
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: action.to_owned(),
            target: target.to_owned(),
            decision: None,
            source: "user".into(),
            thread_id: None,
            run_id: None,
            detail: Value::Null,
        })?;
        Ok(())
    }

    /// Checks at startup, then every six hours, unless the setting turns it off.
    pub async fn run_checks(&self, stop: CancellationToken) {
        let mut ticks = tokio::time::interval(CHECK_INTERVAL);
        loop {
            tokio::select! {
                () = stop.cancelled() => return,
                _ = ticks.tick() => {
                    let enabled = self
                        .store
                        .settings()
                        .map_or(true, |settings| settings.background_update_checks != Some(false));
                    if enabled {
                        self.check().await;
                    }
                }
            }
        }
    }
}

fn engine_block(status: &EngineStatus, latest: Option<&str>, busy: bool) -> Option<String> {
    let newer = matches!(
        (latest, status.version.as_deref()),
        (Some(latest), Some(current)) if is_newer(latest, current)
    );
    if !newer {
        Some("This engine is up to date.".to_owned())
    } else if status.update_command.is_none() {
        Some(
            status
                .manual_hint
                .clone()
                .unwrap_or_else(|| "Update this engine with the installer you used.".to_owned()),
        )
    } else if busy {
        Some("This engine has an active run.".to_owned())
    } else {
        None
    }
}

fn record(steps: &mut Vec<UpdateStep>, target: String, outcome: Result<()>) -> bool {
    let ok = outcome.is_ok();
    steps.push(UpdateStep {
        target,
        ok,
        message: outcome.err().map(|error| error.public_message()),
    });
    ok
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(all(test, unix))]
mod tests;
