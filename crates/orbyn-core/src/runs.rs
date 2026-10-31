//! The run manager: admission, execution and cleanup. Admission is durable
//! before any process exists. The event loop is the single writer of a run's
//! progress, and cleanup runs on every path out of it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orbyn_contracts::{
    AgUiEvent, EngineTier, PermissionMode, QueuedMessage, Run, RunState, Thread,
};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::approvals::{ActionAsk, ApprovalGate, RunScope, WriteScope};
use crate::composer::check_prompt;
use crate::driver::{EngineEvent, EngineOutcome, PermissionRequest, RunHandle, RunKind, RunSpec};
use crate::engines::EngineManager;
use crate::error::{CoreError, Result};
use crate::git::{git, text};
use crate::mcp::{McpBinding, McpService};
use crate::skills::{SkillRoute, SkillService};
use crate::store::{Admission, Store};
use crate::util::new_id;
use crate::workspace::{Workspace, check_target};

/// Longest a driver gets to stop before its task is aborted, which drops the
/// process owner and kills the tree.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
const EVENT_BUFFER: usize = 1024;

/// Where a thread's run may write: its checkout, and on a library thread never
/// the nested projects.
fn write_scope(root: &Path, checkout: &Path) -> WriteScope {
    WriteScope {
        checkout: checkout.to_path_buf(),
        engine_cwd: root.to_path_buf(),
        excluded: if checkout == root {
            vec![root.join("repo")]
        } else {
            Vec::new()
        },
    }
}

async fn branch_name(checkout: &Path) -> Option<String> {
    let name = git(checkout, &["symbolic-ref", "--short", "-q", "HEAD"])
        .await
        .ok()?;
    Some(text(&name))
}

/// A worktree's target Git root is its primary clone.
async fn target_root(checkout: &Path) -> PathBuf {
    let common = git(
        checkout,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await;
    common
        .ok()
        .and_then(|path| PathBuf::from(text(&path)).parent().map(Path::to_path_buf))
        .unwrap_or_else(|| checkout.to_path_buf())
}

struct RunContext<'a> {
    library: &'a Path,
    revision: &'a str,
    dirty: bool,
    target_root: &'a Path,
    checkout: &'a Path,
    branch: Option<&'a str>,
    library_thread: bool,
    route: &'a SkillRoute,
    plan: bool,
    files: &'a [PathBuf],
}

/// The short bootstrap in front of each run's prompt. Nesting does not prove an
/// engine loaded a target's rules, so this tells it to read them.
fn run_context(context: &RunContext<'_>) -> String {
    let mut text = format!(
        "<orbyn_context>\nShared library: {} at {}{}.\nTarget Git root: {}.\n\
         Selected checkout: {} on {}.\n",
        context.library.display(),
        context.revision,
        if context.dirty {
            " with local edits"
        } else {
            ""
        },
        context.target_root.display(),
        context.checkout.display(),
        context.branch.unwrap_or("a detached HEAD"),
    );
    if context.library_thread {
        text.push_str("This thread works on the library itself. Leave repo/ alone.\n");
    } else {
        text.push_str(
            "Work and write only in the selected checkout. The library is read-only here.\n\
             Read the target's root and applicable nested instructions directly (AGENTS.md, \
             AGENT.md, CLAUDE.md, codex.md, .cursorrules, CONTRIBUTING.md): discovery across a \
             Git boundary is not guaranteed. Target rules specialize shared methods.\n",
        );
    }
    if !context.route.native {
        text.push_str("Find skills with the skill_search and skill_load tools.\n");
    }
    if !context.route.selection.is_empty() {
        text.push_str("Skills in scope: ");
        text.push_str(&context.route.selection.join(", "));
        text.push_str(".\n");
    }
    if context.plan {
        text.push_str("Plan mode: read and propose a plan. Change nothing.\n");
    }
    if !context.files.is_empty() {
        text.push_str("Attached files:\n");
        for file in context.files {
            text.push_str(&format!("- {}\n", file.display()));
        }
    }
    text.push_str("</orbyn_context>");
    text
}

/// What the run manager is built from.
pub struct RunServices {
    pub store: Arc<Store>,
    pub gate: Arc<ApprovalGate>,
    pub engines: Arc<EngineManager>,
    pub skills: Arc<SkillService>,
    pub workspace: Arc<Workspace>,
    pub mcp: Arc<McpService>,
    pub base_url: String,
    pub runs_dir: PathBuf,
}

pub struct RunManager {
    store: Arc<Store>,
    gate: Arc<ApprovalGate>,
    engines: Arc<EngineManager>,
    skills: Arc<SkillService>,
    workspace: Arc<Workspace>,
    mcp: Arc<McpService>,
    base_url: String,
    runs_dir: PathBuf,
    active: Mutex<HashMap<String, ActiveRun>>,
}

struct ActiveRun {
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
    input: Option<mpsc::UnboundedSender<String>>,
}

impl RunManager {
    pub fn new(services: RunServices) -> Self {
        let RunServices {
            store,
            gate,
            engines,
            skills,
            workspace,
            mcp,
            base_url,
            runs_dir,
        } = services;
        Self {
            store,
            gate,
            engines,
            skills,
            workspace,
            mcp,
            base_url,
            runs_dir,
            active: Mutex::new(HashMap::new()),
        }
    }

    /// Admits a run and starts it. The `202` reply and the first events can
    /// reach a client in either order; both are consistent with the log.
    pub fn admit(self: &Arc<Self>, thread_id: &str, prompt: &str, actor: &str) -> Result<Run> {
        self.admit_with(thread_id, prompt, &[], actor)
    }

    pub fn admit_with(
        self: &Arc<Self>,
        thread_id: &str,
        prompt: &str,
        attachments: &[String],
        actor: &str,
    ) -> Result<Run> {
        check_prompt(prompt)?;
        let thread = self.store.thread(thread_id)?;
        self.engines.driver(&thread.engine)?;
        self.attachment_files(thread_id, attachments)?;
        let root = self.workspace.root()?;
        let run = self.workspace.admit_with(|| {
            self.engines.admit_with(&thread.engine, || {
                self.store.admit_run(Admission {
                    thread_id,
                    prompt,
                    actor,
                })
            })
        })?;
        self.launch(thread, run.clone(), prompt.to_owned(), attachments, &root)?;
        Ok(run)
    }

    fn attachment_files(&self, thread_id: &str, ids: &[String]) -> Result<Vec<PathBuf>> {
        let stored = self.store.list_attachments(thread_id)?;
        ids.iter()
            .map(|id| {
                stored
                    .iter()
                    .find(|(attachment, _)| attachment.id == *id)
                    .map(|(_, path)| PathBuf::from(path))
                    .ok_or_else(|| CoreError::Invalid("That attachment is not ready.".into()))
            })
            .collect()
    }

    fn launch(
        self: &Arc<Self>,
        thread: Thread,
        run: Run,
        prompt: String,
        attachments: &[String],
        root: &Path,
    ) -> Result<()> {
        let files = self.attachment_files(&thread.id, attachments)?;
        let scope = write_scope(root, Path::new(&thread.cwd));
        let cancel = CancellationToken::new();
        // Registered before the task starts, so a cancel cannot miss it.
        self.lock().insert(
            run.id.clone(),
            ActiveRun {
                cancel: cancel.clone(),
                task: None,
                input: None,
            },
        );
        let manager = self.clone();
        let thread_id = thread.id.clone();
        let task = tokio::spawn({
            let run_id = run.id.clone();
            async move {
                let supervised = {
                    let manager = manager.clone();
                    let run_id = run_id.clone();
                    tokio::spawn(async move {
                        manager
                            .execute(thread, run_id, prompt, files, scope, cancel)
                            .await;
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
                manager.drain(&thread_id);
            }
        });
        if let Some(active) = self.lock().get_mut(&run.id) {
            active.task = Some(task);
        }
        Ok(())
    }

    /// Starts the next queued message if the thread is free. A failure leaves
    /// the message queued, so nothing typed is lost.
    pub fn drain(self: &Arc<Self>, thread_id: &str) {
        if let Err(error) = self.try_drain(thread_id) {
            tracing::warn!(%error, "could not start the next queued message");
        }
    }

    fn try_drain(self: &Arc<Self>, thread_id: &str) -> Result<()> {
        let thread = self.store.thread(thread_id)?;
        let root = self.workspace.root()?;
        let next = self.workspace.admit_with(|| {
            self.engines
                .admit_with(&thread.engine, || self.store.admit_next(thread_id, "user"))
        })?;
        if let Some((run, message)) = next {
            self.launch(thread, run, message.prompt, &message.attachment_ids, &root)?;
        }
        Ok(())
    }

    /// Queues a message and starts it at once if the thread is idle.
    pub fn enqueue(
        self: &Arc<Self>,
        thread_id: &str,
        prompt: &str,
        attachments: &[String],
    ) -> Result<QueuedMessage> {
        check_prompt(prompt)?;
        let thread = self.store.thread(thread_id)?;
        if thread.lifecycle.and_then(|l| l.archived_at).is_some() {
            return Err(CoreError::ThreadArchived);
        }
        self.attachment_files(thread_id, attachments)?;
        let message = self.store.enqueue(thread_id, prompt, attachments)?;
        self.drain(thread_id);
        Ok(message)
    }

    /// Sends one queued message next. A running turn is stopped for it.
    pub fn send_now(self: &Arc<Self>, id: &str) -> Result<()> {
        let message = self.store.mark_urgent(id)?;
        match self.store.thread(&message.thread_id)?.active_run {
            Some(run) => self.cancel(&run.id),
            None => {
                self.drain(&message.thread_id);
                Ok(())
            }
        }
    }

    pub fn resume_queue(self: &Arc<Self>, thread_id: &str) -> Result<()> {
        self.store.thread(thread_id)?;
        self.store.release_queue(thread_id)?;
        self.drain(thread_id);
        Ok(())
    }

    /// Adds text to the running turn, for engines that accept it.
    pub fn steer(&self, thread_id: &str, prompt: &str) -> Result<()> {
        check_prompt(prompt)?;
        let run = self
            .store
            .thread(thread_id)?
            .active_run
            .ok_or_else(|| CoreError::Invalid("Nothing is running to steer.".into()))?;
        let input = self
            .lock()
            .get(&run.id)
            .and_then(|active| active.input.clone())
            .ok_or_else(|| CoreError::Unsupported("This engine cannot be steered.".into()))?;
        let message_id = format!("{}:{}:prompt", run.id, new_id());
        for event in [
            AgUiEvent::TextMessageStart {
                message_id: message_id.clone(),
                role: "user".into(),
            },
            AgUiEvent::TextMessageContent {
                message_id: message_id.clone(),
                delta: prompt.to_owned(),
            },
            AgUiEvent::TextMessageEnd { message_id },
        ] {
            self.store.append_run_event(&run.id, &event)?;
        }
        input
            .send(prompt.to_owned())
            .map_err(|_| CoreError::RunClosed)
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
        files: Vec<PathBuf>,
        write_scope: WriteScope,
        cancel: CancellationToken,
    ) {
        let lifecycle = thread.lifecycle.clone();
        let scope = RunScope {
            run_id: run_id.clone(),
            thread_id: thread.id.clone(),
            engine: thread.engine.clone(),
            write_scope: Some(write_scope),
            mode: lifecycle
                .as_ref()
                .map_or(PermissionMode::Supervised, |l| l.permission_mode),
            plan: lifecycle.is_some_and(|l| l.plan_mode),
        };
        let run_dir = self.runs_dir.join(&run_id);
        let mut token = None;
        let outcome = self
            .drive(
                &thread,
                &scope,
                (prompt, files),
                &run_dir,
                &mut token,
                &cancel,
            )
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
        message: (String, Vec<PathBuf>),
        run_dir: &Path,
        token: &mut Option<String>,
        cancel: &CancellationToken,
    ) -> EngineOutcome {
        match self
            .start(thread, scope, message, run_dir, token, cancel)
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
        (prompt, files): (String, Vec<PathBuf>),
        run_dir: &Path,
        token: &mut Option<String>,
        cancel: &CancellationToken,
    ) -> Result<Option<(RunHandle, mpsc::Receiver<EngineEvent>)>> {
        self.store.mark_starting(&scope.run_id)?;
        let driver = self.engines.driver(&thread.engine)?;
        let descriptor = driver.descriptor();
        let root = self.workspace.root()?;
        let library_thread = Path::new(&thread.cwd) == root;
        let checkout = if library_thread {
            root.clone()
        } else {
            check_target(&root, Path::new(&thread.cwd)).await?
        };
        let route = self.skills.route(
            &descriptor.capabilities.skill_delivery,
            thread.skill_profile.as_deref(),
        )?;
        std::fs::create_dir_all(run_dir)?;
        let mcp_url = if descriptor.capabilities.mcp {
            let issued = self.mcp.register(McpBinding {
                scope: scope.clone(),
                permission_prompt: descriptor.id == "claude",
                skills: route.selection.clone(),
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
        let (revision, dirty) = self.workspace.identity().await?;
        let context = run_context(&RunContext {
            library: &root,
            revision: &revision,
            dirty,
            target_root: &target_root(&checkout).await,
            checkout: &checkout,
            branch: branch_name(&checkout).await.as_deref(),
            library_thread,
            route: &route,
            plan: scope.plan,
            files: &files,
        });
        let native = descriptor.tier == EngineTier::Native;
        let spec = RunSpec {
            run_id: scope.run_id.clone(),
            thread_id: thread.id.clone(),
            cwd: if native { root } else { checkout.clone() },
            checkout,
            prompt: format!("{context}\n\n{prompt}"),
            kind: RunKind::parse(&prompt),
            plan: scope.plan,
            user_prompt: prompt,
            model: thread.model.clone(),
            resume: self.store.engine_session(&thread.id)?,
            mcp_url,
            run_dir: run_dir.to_path_buf(),
        };
        let (sender, receiver) = mpsc::channel(EVENT_BUFFER);
        let handle = driver.start_run(spec, sender).await?;
        if let Some(active) = self.lock().get_mut(&scope.run_id) {
            active.input.clone_from(&handle.input);
        }
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
                paths,
                reply,
            } = request;
            let ask = ActionAsk {
                kind,
                target,
                summary,
                detail,
                paths,
            };
            let verdict = gate.request(&scope, ask).await;
            let _ = reply.send(verdict);
        });
    }
}

#[cfg(test)]
mod tests;
