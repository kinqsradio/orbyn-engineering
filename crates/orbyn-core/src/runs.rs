//! The run manager: admission, execution and cleanup. Admission is durable
//! before any process exists. The event loop is the single writer of a run's
//! progress, and cleanup runs on every path out of it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orbyn_contracts::{Run, RunState, Thread};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::approvals::{ActionAsk, ApprovalGate, RunScope};
use crate::driver::{EngineEvent, EngineOutcome, PermissionRequest, RunHandle, RunSpec};
use crate::engines::EngineManager;
use crate::error::{CoreError, Result};
use crate::mcp::{McpBinding, McpService};
use crate::skills::SkillService;
use crate::store::{Admission, Store};

/// Longest a driver gets to stop before its task is aborted, which drops the
/// process owner and kills the tree.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
const EVENT_BUFFER: usize = 1024;
const MAX_PROMPT_BYTES: usize = 1024 * 1024;

pub struct RunManager {
    store: Arc<Store>,
    gate: Arc<ApprovalGate>,
    engines: Arc<EngineManager>,
    skills: Arc<SkillService>,
    mcp: Arc<McpService>,
    base_url: String,
    runs_dir: PathBuf,
    active: Mutex<HashMap<String, ActiveRun>>,
}

struct ActiveRun {
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl RunManager {
    pub fn new(
        store: Arc<Store>,
        gate: Arc<ApprovalGate>,
        engines: Arc<EngineManager>,
        skills: Arc<SkillService>,
        mcp: Arc<McpService>,
        base_url: String,
        runs_dir: PathBuf,
    ) -> Self {
        Self {
            store,
            gate,
            engines,
            skills,
            mcp,
            base_url,
            runs_dir,
            active: Mutex::new(HashMap::new()),
        }
    }

    /// Admits a run and starts it. The `202` reply and the first events can
    /// reach a client in either order; both are consistent with the log.
    pub fn admit(self: &Arc<Self>, thread_id: &str, prompt: &str, actor: &str) -> Result<Run> {
        if prompt.trim().is_empty() {
            return Err(CoreError::Invalid("Enter a prompt to start a run.".into()));
        }
        if prompt.len() > MAX_PROMPT_BYTES {
            return Err(CoreError::Invalid("This prompt is too long.".into()));
        }
        let thread = self.store.thread(thread_id)?;
        self.engines.driver(&thread.engine)?;
        let run = self.engines.admit_with(&thread.engine, || {
            self.store.admit_run(Admission {
                thread_id,
                prompt,
                actor,
            })
        })?;
        let cancel = CancellationToken::new();
        // Registered before the task starts, so a cancel cannot miss it.
        self.lock().insert(
            run.id.clone(),
            ActiveRun {
                cancel: cancel.clone(),
                task: None,
            },
        );
        let manager = self.clone();
        let task = tokio::spawn({
            let run_id = run.id.clone();
            let prompt = prompt.to_owned();
            async move {
                let supervised = {
                    let manager = manager.clone();
                    let run_id = run_id.clone();
                    tokio::spawn(async move {
                        manager.execute(thread, run_id, prompt, cancel).await;
                    })
                };
                // A panic in the run must not strand it as active.
                if supervised.await.is_err() {
                    manager.close_run(
                        &run_id,
                        RunState::Failed,
                        Some("The run stopped unexpectedly."),
                    );
                }
                manager.lock().remove(&run_id);
            }
        });
        if let Some(active) = self.lock().get_mut(&run.id) {
            active.task = Some(task);
        }
        Ok(run)
    }

    /// Requests cancellation. The run reaches `cancelled` once its engine is down.
    pub fn cancel(&self, run_id: &str) -> Result<()> {
        let run = self.store.run(run_id)?;
        if run.state.is_terminal() {
            return Err(CoreError::RunClosed);
        }
        match self.lock().get(run_id) {
            Some(active) => {
                active.cancel.cancel();
                Ok(())
            }
            None => Err(CoreError::StaleOwner),
        }
    }

    /// Stops every run and waits for their cleanup.
    pub async fn shutdown(&self) {
        let tasks: Vec<JoinHandle<()>> = {
            let mut active = self.lock();
            active
                .values_mut()
                .filter_map(|run| {
                    run.cancel.cancel();
                    run.task.take()
                })
                .collect()
        };
        for task in tasks {
            let _ = tokio::time::timeout(STOP_TIMEOUT * 2, task).await;
        }
    }

    pub fn active_count(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ActiveRun>> {
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    async fn execute(
        self: Arc<Self>,
        thread: Thread,
        run_id: String,
        prompt: String,
        cancel: CancellationToken,
    ) {
        let scope = RunScope {
            run_id: run_id.clone(),
            thread_id: thread.id.clone(),
            engine: thread.engine.clone(),
        };
        let run_dir = self.runs_dir.join(&run_id);
        let mut token = None;
        let outcome = self
            .drive(&thread, &scope, prompt, &run_dir, &mut token, &cancel)
            .await;
        if let Some(token) = token {
            self.mcp.revoke(&token);
        }
        if let Err(error) = std::fs::remove_dir_all(&run_dir)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%error, "could not remove a run directory");
        }
        let (state, message) = match outcome {
            EngineOutcome::Completed => (RunState::Completed, None),
            EngineOutcome::Cancelled => (RunState::Cancelled, None),
            EngineOutcome::Failed(message) => (RunState::Failed, Some(message)),
        };
        self.close_run(&run_id, state, message.as_deref());
    }

    /// Writes the terminal state and hands expired approvals back to their waiters.
    fn close_run(&self, run_id: &str, state: RunState, error: Option<&str>) {
        match self.store.finish_run(run_id, state, error) {
            Ok((_, expired)) => self.gate.settle(&expired),
            Err(CoreError::RunClosed) => {}
            Err(failure) => tracing::error!(%failure, %run_id, "could not close a run"),
        }
    }

    async fn drive(
        &self,
        thread: &Thread,
        scope: &RunScope,
        prompt: String,
        run_dir: &Path,
        token: &mut Option<String>,
        cancel: &CancellationToken,
    ) -> EngineOutcome {
        match self
            .start(thread, scope, prompt, run_dir, token, cancel)
            .await
        {
            Ok(Some((handle, events))) => self.pump(thread, scope, handle, events, cancel).await,
            Ok(None) => EngineOutcome::Cancelled,
            Err(CoreError::RunClosed | CoreError::StaleOwner) => EngineOutcome::Cancelled,
            Err(error) => EngineOutcome::Failed(error.public_message()),
        }
    }

    async fn start(
        &self,
        thread: &Thread,
        scope: &RunScope,
        prompt: String,
        run_dir: &Path,
        token: &mut Option<String>,
        cancel: &CancellationToken,
    ) -> Result<Option<(RunHandle, mpsc::Receiver<EngineEvent>)>> {
        self.store.mark_starting(&scope.run_id)?;
        let driver = self.engines.driver(&thread.engine)?;
        let descriptor = driver.descriptor();
        let (skills, selection) = self.skills.plan(
            &descriptor.capabilities.skill_delivery,
            thread.skill_profile.as_deref(),
        )?;
        std::fs::create_dir_all(run_dir)?;
        let mcp_url = if descriptor.capabilities.mcp {
            let issued = self.mcp.register(McpBinding {
                scope: scope.clone(),
                permission_prompt: descriptor.id == "claude",
                skills: selection,
            })?;
            let url = format!("{}/mcp/{issued}", self.base_url);
            *token = Some(issued);
            Some(url)
        } else {
            None
        };
        if cancel.is_cancelled() {
            return Ok(None);
        }
        let spec = RunSpec {
            run_id: scope.run_id.clone(),
            thread_id: thread.id.clone(),
            cwd: PathBuf::from(&thread.cwd),
            prompt,
            model: thread.model.clone(),
            resume: self.store.engine_session(&thread.id)?,
            mcp_url,
            skills,
            run_dir: run_dir.to_path_buf(),
        };
        let (sender, receiver) = mpsc::channel(EVENT_BUFFER);
        let handle = driver.start_run(spec, sender).await?;
        if let Err(error) = self.store.mark_running(&scope.run_id) {
            handle.cancel.cancel();
            handle.task.abort();
            return Err(error);
        }
        Ok(Some((handle, receiver)))
    }

    /// Commits engine events in order until the engine finishes or the run is
    /// cancelled, then brings the engine down before reporting the outcome.
    async fn pump(
        &self,
        thread: &Thread,
        scope: &RunScope,
        handle: RunHandle,
        mut events: mpsc::Receiver<EngineEvent>,
        cancel: &CancellationToken,
    ) -> EngineOutcome {
        let mut cancelling = false;
        let stop_deadline = tokio::time::sleep(Duration::MAX / 4);
        tokio::pin!(stop_deadline);
        let outcome = loop {
            tokio::select! {
                biased;
                () = cancel.cancelled(), if !cancelling => {
                    cancelling = true;
                    stop_deadline
                        .as_mut()
                        .reset(tokio::time::Instant::now() + STOP_TIMEOUT);
                    // A blocked engine must hear its denial before it can stop.
                    if let Err(error) = self.gate.expire_run(&thread.id, &scope.run_id, "system:cancel") {
                        tracing::warn!(%error, "could not expire approvals on cancel");
                    }
                    handle.cancel.cancel();
                }
                () = &mut stop_deadline, if cancelling => break EngineOutcome::Cancelled,
                event = events.recv() => {
                    let Some(event) = event else {
                        break if cancelling {
                            EngineOutcome::Cancelled
                        } else {
                            EngineOutcome::Failed("The engine stopped without finishing.".into())
                        };
                    };
                    match event {
                        EngineEvent::Agui(event) => {
                            match self.store.append_run_event(&scope.run_id, &event) {
                                Ok(_) => {}
                                Err(CoreError::RunClosed | CoreError::StaleOwner) => {
                                    break EngineOutcome::Cancelled;
                                }
                                Err(error) => break EngineOutcome::Failed(error.public_message()),
                            }
                        }
                        EngineEvent::Session(session) => {
                            if let Err(error) = self.store.set_engine_session(&scope.run_id, &session) {
                                tracing::warn!(%error, "could not store the engine session");
                            }
                        }
                        EngineEvent::Permission(request) => {
                            self.answer(scope, request);
                        }
                        EngineEvent::Finished(outcome) => break outcome,
                    }
                }
            }
        };
        // Blocked engines hear a denial even when the engine ended on its own.
        if let Err(error) = self
            .gate
            .expire_run(&thread.id, &scope.run_id, "system:run_end")
        {
            tracing::warn!(%error, "could not expire approvals at run end");
        }
        drop(events);
        handle.cancel.cancel();
        let mut task = handle.task;
        if tokio::time::timeout(STOP_TIMEOUT, &mut task).await.is_err() {
            task.abort();
            let _ = task.await;
        }
        if cancelling {
            EngineOutcome::Cancelled
        } else {
            outcome
        }
    }

    /// Runs the gate on its own task so a long wait does not stall the event log.
    fn answer(&self, scope: &RunScope, request: PermissionRequest) {
        let gate = self.gate.clone();
        let scope = scope.clone();
        tokio::spawn(async move {
            let PermissionRequest {
                kind,
                target,
                summary,
                detail,
                reply,
            } = request;
            let ask = ActionAsk {
                kind,
                target,
                summary,
                detail,
            };
            let verdict = gate.request(&scope, ask).await;
            let _ = reply.send(verdict);
        });
    }
}

#[cfg(test)]
mod tests;
