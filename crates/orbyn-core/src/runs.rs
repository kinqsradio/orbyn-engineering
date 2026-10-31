//! The run manager: admission, execution and cleanup. Admission is durable
//! before any process exists. The event loop is the single writer of a run's
//! progress, and cleanup runs on every path out of it.

mod shape;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orbyn_contracts::{
    AgUiEvent, EngineTier, ForcedStop, ModelSelection, PermissionMode, QueuedMessage, Run,
    RunState, Thread, ThreadGoal,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::approvals::{ActionAsk, ApprovalGate, RunScope, WriteScope};
use crate::checkpoints::checkpoint_ref;
use crate::composer::check_prompt;
use crate::driver::diagnostics;
use crate::driver::{
    EngineDriver, EngineEvent, EngineOutcome, GoalAction, PermissionRequest, RunHandle, RunKind,
    RunSpec,
};
use crate::engines::EngineManager;
use crate::error::{CoreError, Result};
use crate::git::{git, snapshot, text};
use crate::mcp::{McpBinding, McpService};
use crate::questions::QuestionDesk;
use crate::selection;
use crate::skills::{SkillRoute, SkillService};
use crate::store::{Admission, AuditRecord, Store};
use crate::util::new_id;
use crate::workspace::{Workspace, check_target};
use shape::EventShaper;

/// Longest a driver gets to stop before its task is aborted, which drops the
/// process owner and kills the tree.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a forced stop lets a stage finish before dropping it.
const FORCE_GRACE: Duration = Duration::from_secs(1);
/// How long a forced stop waits for a run to close before closing it itself.
const FORCE_WAIT: Duration = Duration::from_secs(4);
const FORCE_POLL: Duration = Duration::from_millis(20);
/// A delegated run this quiet is stuck: twice the longest a tool may take.
const SILENCE_LIMIT: Duration = Duration::from_secs(2 * 240);
const EVENT_BUFFER: usize = 1024;

/// Where a thread's run may write: its checkout, and on a library thread never
/// the nested projects. `engine_cwd` is where the engine's relative paths land.
fn write_scope(root: &Path, checkout: &Path, from_checkout: bool) -> WriteScope {
    WriteScope {
        checkout: checkout.to_path_buf(),
        engine_cwd: if from_checkout { checkout } else { root }.to_path_buf(),
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

async fn checkout_revision(checkout: &Path) -> Option<String> {
    let head = git(checkout, &["rev-parse", "HEAD"]).await.ok()?;
    Some(text(&head))
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
        .and_then(|path| crate::util::canonicalize(Path::new(&text(&path))).ok())
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| checkout.to_path_buf())
}

struct RunContext<'a> {
    library: &'a Path,
    revision: &'a str,
    dirty: bool,
    target_root: &'a Path,
    checkout: &'a Path,
    branch: Option<&'a str>,
    /// `None` outside Git.
    checkout_revision: Option<&'a str>,
    /// The engine's working directory is the library, not the checkout.
    runs_at_library: bool,
    library_thread: bool,
    route: &'a SkillRoute,
    /// The engine has the MCP server, and so `skill_search` and `skill_load`.
    skill_tools: bool,
    plan: bool,
    files: &'a [PathBuf],
    handoff: Option<&'a str>,
}

/// The short bootstrap in front of each run's prompt. It leads with what the engine
/// can do, since a first turn that read mostly limits once said it had no files to
/// look at. Nesting does not prove an engine loaded a target's rules, so
/// this tells it to read them.
fn run_context(context: &RunContext<'_>) -> String {
    let library = format!(
        "{} at {}{}",
        context.library.display(),
        context.revision,
        if context.dirty {
            " with local edits"
        } else {
            ""
        },
    );
    let mut text = String::from("<orbyn_context>\n");
    if context.library_thread {
        text.push_str(&format!(
            "Checkout: the shared library, {library}. Leave repo/ alone.\n"
        ));
    } else {
        text.push_str(&format!(
            "Checkout: {} on {}{}.\n",
            context.checkout.display(),
            context
                .branch
                .unwrap_or(if context.checkout_revision.is_some() {
                    "a detached HEAD"
                } else {
                    "no branch"
                }),
            context
                .checkout_revision
                .map_or_else(String::new, |revision| format!(" at {revision}")),
        ));
        if context.target_root != context.checkout {
            text.push_str(&format!(
                "It is a worktree of {}.\n",
                context.target_root.display()
            ));
        }
        text.push_str(&format!(
            "You can read it with your usual file and shell tools, so open its files directly.\n\
             Make changes only in the checkout. The shared library is for reference: {library}.\n\
             Before changing code, read the instructions at the checkout's root and near the \
             files you touch (AGENTS.md, AGENT.md, CLAUDE.md, codex.md, .cursorrules, \
             CONTRIBUTING.md). They specialize shared methods.\n"
        ));
    }
    if context.runs_at_library && !context.library_thread {
        text.push_str(
            "Your shell starts in the library, so use absolute paths under the checkout and run \
             commands from there.\n",
        );
    }
    text.push_str(&skills_line(context));
    if context.plan {
        text.push_str("Plan mode: read and propose a plan. Change nothing.\n");
    }
    if !context.files.is_empty() {
        text.push_str("Attached files:\n");
        for file in context.files {
            text.push_str(&format!("- {}\n", file.display()));
        }
    }
    if let Some(handoff) = context.handoff {
        text.push_str("Earlier conversation, carried over from another session:\n");
        text.push_str(handoff);
        text.push('\n');
    }
    text.push_str("</orbyn_context>");
    text
}

/// Names skills only where nothing else can: native discovery and the tools already
/// know the selection, and every name here is read on every first turn.
fn skills_line(context: &RunContext<'_>) -> String {
    let route = context.route;
    let names = route.selection.join(", ");
    if route.selection.is_empty() {
        String::new()
    } else if !route.native && context.skill_tools {
        "Find shared skills with the skill_search and skill_load tools.\n".to_owned()
    } else if !route.native {
        format!("Shared skills, each at skills/<name>/SKILL.md in the library: {names}.\n")
    } else if route.limited {
        format!("Use only these shared skills: {names}.\n")
    } else {
        String::new()
    }
}

/// What the run manager is built from.
pub struct RunServices {
    pub store: Arc<Store>,
    pub gate: Arc<ApprovalGate>,
    pub questions: Arc<QuestionDesk>,
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
    questions: Arc<QuestionDesk>,
    engines: Arc<EngineManager>,
    skills: Arc<SkillService>,
    workspace: Arc<Workspace>,
    mcp: Arc<McpService>,
    base_url: String,
    runs_dir: PathBuf,
    active: Mutex<HashMap<String, ActiveRun>>,
}

/// How a run is asked to end. `cancel` lets the engine stop itself; `force` ends it
/// now and is for an engine that stopped answering.
#[derive(Clone, Default)]
struct Stops {
    cancel: CancellationToken,
    force: CancellationToken,
}

struct ActiveRun {
    stops: Stops,
    task: Option<JoinHandle<()>>,
    input: Option<mpsc::UnboundedSender<String>>,
}

async fn sleep_until_due(due: Option<tokio::time::Instant>) {
    match due {
        Some(due) => tokio::time::sleep_until(due).await,
        None => std::future::pending().await,
    }
}

impl RunManager {
    pub fn new(services: RunServices) -> Self {
        let RunServices {
            store,
            gate,
            questions,
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
            questions,
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
        self.check_goal_action(&thread, prompt)?;
        self.attachment_files(thread_id, attachments)?;
        self.engines
            .check_selection(&thread.engine, &selection::of_thread(&thread))?;
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

    /// Pausing and resuming a goal is the engine's own feature, so an engine
    /// without it refuses here rather than reading the words as a prompt.
    fn check_goal_action(&self, thread: &Thread, prompt: &str) -> Result<()> {
        let driver = self.engines.driver(&thread.engine)?;
        let kind = RunKind::parse(prompt);
        // These reach the engine bare, so earlier conversation has no way along.
        if kind != RunKind::Turn && self.store.pending_handoff(&thread.id)?.is_some() {
            return Err(CoreError::Unsupported(
                "Send a message first: this thread's earlier conversation has not reached \
                 the engine yet."
                    .into(),
            ));
        }
        let held = matches!(kind, RunKind::Goal(GoalAction::Pause | GoalAction::Resume));
        if held && !driver.descriptor().capabilities.goal_control {
            return Err(CoreError::Unsupported(
                "This engine cannot pause or resume a goal.".into(),
            ));
        }
        Ok(())
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
        let from_checkout = self
            .engines
            .driver(&thread.engine)?
            .resolves_from_checkout();
        let scope = write_scope(root, Path::new(&thread.cwd), from_checkout);
        let stops = Stops::default();
        // Registered before the task starts, so a cancel cannot miss it.
        self.lock().insert(
            run.id.clone(),
            ActiveRun {
                stops: stops.clone(),
                task: None,
                input: None,
            },
        );
        self.remember_selection(&thread);
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
                            .execute(thread, run_id, prompt, files, scope, stops)
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
                manager.report_to_parent(&thread_id, &run_id);
            }
        });
        if let Some(active) = self.lock().get_mut(&run.id) {
            active.task = Some(task);
        }
        Ok(())
    }

    /// What a person chose carries to new threads on this engine. A delegated
    /// thread's choices are the parent's, not theirs.
    fn remember_selection(&self, thread: &Thread) {
        let relation = thread
            .lifecycle
            .as_ref()
            .and_then(|l| l.relation.as_deref());
        if relation == Some("subagent") {
            return;
        }
        let chosen = selection::of_thread(thread);
        if let Err(error) = self.store.remember_selection(&thread.engine, &chosen) {
            tracing::debug!(%error, "could not remember a selection");
        }
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
            // The message's own selection reached the thread with its admission.
            let thread = self.store.thread(thread_id)?;
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
        self.enqueue_with(thread_id, prompt, attachments, &ModelSelection::default())
    }

    /// `enqueue`, with what the message sets on the thread when it starts. A value
    /// the model does not offer is refused here, so nothing waits in line to fail.
    pub fn enqueue_with(
        self: &Arc<Self>,
        thread_id: &str,
        prompt: &str,
        attachments: &[String],
        wanted: &ModelSelection,
    ) -> Result<QueuedMessage> {
        check_prompt(prompt)?;
        let thread = self.store.thread(thread_id)?;
        if thread
            .lifecycle
            .as_ref()
            .and_then(|l| l.archived_at.as_ref())
            .is_some()
        {
            return Err(CoreError::ThreadArchived);
        }
        self.check_goal_action(&thread, prompt)?;
        self.attachment_files(thread_id, attachments)?;
        let chosen = selection::merged(&selection::of_thread(&thread), wanted);
        self.engines.check_selection(&thread.engine, &chosen)?;
        let message = self.store.enqueue(thread_id, prompt, attachments, wanted)?;
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
        if matches!(run.state, RunState::Admitted | RunState::Starting) {
            return Err(CoreError::Invalid("This run is still starting.".into()));
        }
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

    /// A delegated thread with nothing left to do tells its parent, through the
    /// parent's queue, so the report waits its turn and wakes the parent.
    fn report_to_parent(self: &Arc<Self>, thread_id: &str, run_id: &str) {
        let report = || -> Result<()> {
            let thread = self.store.thread(thread_id)?;
            let lifecycle = thread.lifecycle.as_ref();
            let parent = lifecycle
                .filter(|l| l.relation.as_deref() == Some("subagent"))
                .and_then(|l| l.parent_thread_id.clone());
            let Some(parent) = parent else { return Ok(()) };
            if thread.active_run.is_some() || !self.store.list_queue(thread_id)?.is_empty() {
                return Ok(());
            }
            let state = self.store.run(run_id)?.state;
            let state = serde_json::to_value(state)?;
            // The newest text, within the handoff budget: the ending is the result.
            let transcript = self.store.recovery_handoff(thread_id)?;
            let prompt = crate::automations::child_report(
                &thread.title,
                state.as_str().unwrap_or("ended"),
                &transcript,
            );
            self.enqueue(&parent, &prompt, &[]).map(|_| ())
        };
        if let Err(error) = report() {
            tracing::warn!(%error, "a delegated thread could not report back");
        }
    }

    /// Requests cancellation, with any delegated threads running under this one.
    /// The run reaches `cancelled` once its engine is down.
    pub fn cancel(&self, run_id: &str) -> Result<()> {
        let run = self.store.run(run_id)?;
        if run.state.is_terminal() {
            return Err(CoreError::RunClosed);
        }
        for child in self.store.child_threads(&run.thread_id)? {
            if let Some(active) = self.store.thread(&child)?.active_run {
                let _ = self.cancel(&active.id);
            }
        }
        self.store.request_stop(run_id)?;
        match self.lock().get(run_id) {
            Some(active) => {
                active.stops.cancel.cancel();
                Ok(())
            }
            None => Err(CoreError::StaleOwner),
        }
    }

    /// Ends a thread's run without waiting for its engine, whose process tree is
    /// killed, with those of its delegated threads. If a stage before or after the
    /// engine is what hangs, the run is closed anyway, and fencing keeps anything it
    /// does later out of the log. Nothing running is not a failure, so a second click
    /// changes nothing.
    pub async fn force_stop(&self, thread_id: &str, actor: &str) -> Result<ForcedStop> {
        let thread = self.store.thread(thread_id)?;
        let Some(active) = thread.active_run else {
            return Ok(ForcedStop {
                run_id: None,
                state: thread.last_run_state,
            });
        };
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: "run.force_stop".into(),
            target: active.id.clone(),
            decision: None,
            source: "user".into(),
            thread_id: Some(thread_id.to_owned()),
            run_id: Some(active.id.clone()),
            detail: Value::Null,
        })?;
        self.store.request_stop(&active.id)?;
        for child in self.store.child_threads(thread_id)? {
            if self.store.thread(&child)?.active_run.is_some() {
                Box::pin(self.force_stop(&child, actor)).await?;
            }
        }
        if let Some(run) = self.lock().get(&active.id) {
            run.stops.force.cancel();
            run.stops.cancel.cancel();
        }
        let deadline = tokio::time::Instant::now() + FORCE_WAIT;
        while tokio::time::Instant::now() < deadline {
            if self.store.run(&active.id)?.state.is_terminal() {
                break;
            }
            tokio::time::sleep(FORCE_POLL).await;
        }
        if !self.store.run(&active.id)?.state.is_terminal() {
            tracing::warn!(run = %active.id, "closing a run that did not stop");
            self.close_run(&active.id, RunState::Cancelled, None);
            self.mcp.revoke_run(&active.id);
            if let Err(error) = self
                .questions
                .expire_run(thread_id, &active.id, "system:cancel")
            {
                tracing::warn!(%error, "could not expire questions on a forced stop");
            }
        }
        if let Err(error) = self.store.note_thread_event(
            thread_id,
            "run.force_stopped",
            json!({ "runId": active.id }),
        ) {
            tracing::debug!(%error, "could not note a forced stop");
        }
        Ok(ForcedStop {
            state: Some(self.store.run(&active.id)?.state),
            run_id: Some(active.id),
        })
    }

    /// Stops every run and waits for their cleanup.
    pub async fn shutdown(&self) {
        let tasks: Vec<JoinHandle<()>> = {
            let mut active = self.lock();
            active
                .values_mut()
                .filter_map(|run| {
                    run.stops.cancel.cancel();
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
        stops: Stops,
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
        let outcome = {
            let drive = self.drive(
                &thread,
                &scope,
                (prompt, files),
                &run_dir,
                &mut token,
                &stops,
            );
            // The stream below answers a forced stop itself. This is for a stage
            // around it that hangs, such as a snapshot on a stuck disk.
            let forced = async {
                stops.force.cancelled().await;
                tokio::time::sleep(FORCE_GRACE).await;
            };
            tokio::select! {
                outcome = drive => outcome,
                () = forced => EngineOutcome::Cancelled,
            }
        };
        if let Some(token) = token {
            self.mcp.revoke(&token);
        }
        let end = self.checkpoint_end(&scope, &thread, &run_dir);
        tokio::select! {
            () = end => {}
            () = async {
                stops.force.cancelled().await;
                tokio::time::sleep(FORCE_GRACE).await;
            } => {}
        }
        if let Err(error) = std::fs::remove_dir_all(&run_dir)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%error, "could not remove a run directory");
        }
        let (state, message) = match outcome {
            EngineOutcome::Completed => {
                if let Err(error) = self.store.clear_handoff(&scope.thread_id) {
                    tracing::warn!(%error, "could not clear a used handoff");
                }
                (RunState::Completed, None)
            }
            EngineOutcome::Cancelled => (RunState::Cancelled, None),
            EngineOutcome::Failed(message) => {
                let sign_in = self.engines.driver(&scope.engine).ok();
                let sign_in = sign_in.as_ref().and_then(|driver| driver.sign_in_command());
                if diagnostics::is_sign_in_failure(&message) {
                    let note = json!({ "command": sign_in });
                    if let Err(error) = self.store.note_thread_event(
                        &scope.thread_id,
                        "engine.sign_in_required",
                        note,
                    ) {
                        tracing::debug!(%error, "could not note a sign-in failure");
                    }
                }
                let message = diagnostics::failure_message(&message, sign_in);
                (RunState::Failed, Some(message))
            }
            EngineOutcome::SessionLost => (
                RunState::Failed,
                Some("The engine lost this conversation.".to_owned()),
            ),
        };
        self.close_run(&run_id, state, message.as_deref());
    }

    /// A failed snapshot costs that run its checkpoint, never the run itself.
    async fn checkpoint_start(&self, scope: &RunScope, checkout: &Path, run_dir: &Path) {
        let reference = checkpoint_ref(&scope.thread_id, &scope.run_id, "start");
        let index = run_dir.join("checkpoint-index");
        match snapshot(checkout, Some(&reference), &index).await {
            Ok(sha) => {
                if let Err(error) = self
                    .store
                    .add_checkpoint(&scope.thread_id, &scope.run_id, &sha)
                {
                    tracing::warn!(%error, "could not record a checkpoint");
                }
            }
            Err(error) => tracing::warn!(%error, "could not take a checkpoint"),
        }
    }

    async fn checkpoint_end(&self, scope: &RunScope, thread: &Thread, run_dir: &Path) {
        if !matches!(self.store.checkpoint(&scope.run_id), Ok(Some(_))) {
            return;
        }
        let reference = checkpoint_ref(&scope.thread_id, &scope.run_id, "end");
        let index = run_dir.join("checkpoint-index");
        match snapshot(Path::new(&thread.cwd), Some(&reference), &index).await {
            Ok(sha) => {
                if let Err(error) = self.store.finish_checkpoint(&scope.run_id, &sha) {
                    tracing::warn!(%error, "could not record a checkpoint");
                }
            }
            Err(error) => tracing::warn!(%error, "could not take a checkpoint"),
        }
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
        stops: &Stops,
    ) -> EngineOutcome {
        let first = self
            .attempt(thread, scope, message.clone(), run_dir, token, stops, false)
            .await;
        if first != EngineOutcome::SessionLost {
            return first;
        }
        // The engine's session is gone, so a fresh one gets the budgeted history
        // from the log instead, once.
        if let Err(error) = self.recover_session(thread) {
            return EngineOutcome::Failed(error.public_message());
        }
        self.attempt(thread, scope, message, run_dir, token, stops, true)
            .await
    }

    fn recover_session(&self, thread: &Thread) -> Result<()> {
        let handoff = self.store.recovery_handoff(&thread.id)?;
        self.store.set_handoff(&thread.id, &handoff)?;
        self.store
            .note_thread_event(&thread.id, "engine.session_lost", json!({}))
    }

    #[allow(clippy::too_many_arguments)]
    async fn attempt(
        &self,
        thread: &Thread,
        scope: &RunScope,
        message: (String, Vec<PathBuf>),
        run_dir: &Path,
        token: &mut Option<String>,
        stops: &Stops,
        retry: bool,
    ) -> EngineOutcome {
        match self
            .start(thread, scope, message, run_dir, token, &stops.cancel, retry)
            .await
        {
            Ok(Some((handle, events))) => self.pump(thread, scope, handle, events, stops).await,
            Ok(None) => EngineOutcome::Cancelled,
            Err(CoreError::RunClosed | CoreError::StaleOwner) => EngineOutcome::Cancelled,
            Err(CoreError::SessionLost) => EngineOutcome::SessionLost,
            Err(error) => EngineOutcome::Failed(error.public_message()),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn start(
        &self,
        thread: &Thread,
        scope: &RunScope,
        (prompt, files): (String, Vec<PathBuf>),
        run_dir: &Path,
        token: &mut Option<String>,
        cancel: &CancellationToken,
        retry: bool,
    ) -> Result<Option<(RunHandle, mpsc::Receiver<EngineEvent>)>> {
        if !retry {
            self.store.mark_starting(&scope.run_id)?;
        }
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
        if !retry {
            self.checkpoint_start(scope, &checkout, run_dir).await;
        }
        if let Some(token) = token.take() {
            self.mcp.revoke(&token);
        }
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
        let handoff = self.store.pending_handoff(&thread.id)?;
        let context = run_context(&RunContext {
            library: &root,
            revision: &revision,
            dirty,
            target_root: &target_root(&checkout).await,
            checkout: &checkout,
            branch: branch_name(&checkout).await.as_deref(),
            checkout_revision: checkout_revision(&checkout).await.as_deref(),
            runs_at_library: !driver.resolves_from_checkout(),
            library_thread,
            route: &route,
            skill_tools: descriptor.capabilities.mcp,
            plan: scope.plan,
            files: &files,
            handoff: handoff.as_deref(),
        });
        let native = descriptor.tier == EngineTier::Native;
        let kind = RunKind::parse(&prompt);
        let chosen = self.selection_for_run(thread, driver.as_ref()).await?;
        match &kind {
            RunKind::Goal(GoalAction::Set(objective)) => self.store.set_goal(
                &thread.id,
                Some(&ThreadGoal {
                    objective: objective.clone(),
                    status: "active".into(),
                    tokens_used: None,
                    token_budget: None,
                    seconds_used: None,
                }),
            )?,
            RunKind::Goal(GoalAction::Clear) => self.store.set_goal(&thread.id, None)?,
            _ => {}
        }
        let spec = RunSpec {
            run_id: scope.run_id.clone(),
            thread_id: thread.id.clone(),
            cwd: if native { root } else { checkout.clone() },
            checkout,
            prompt: format!("{context}\n\n{prompt}"),
            kind,
            mode: scope.mode,
            plan: scope.plan,
            user_prompt: prompt,
            model: chosen.model.clone(),
            effort: chosen.effort.clone(),
            options: chosen.options.clone(),
            resume: self.store.engine_session(&thread.id)?,
            mcp_url,
            run_dir: run_dir.to_path_buf(),
        };
        let (sender, receiver) = mpsc::channel(EVENT_BUFFER);
        let handle = driver.start_run(spec, sender).await?;
        self.store
            .note_thread_event(&thread.id, "engine.selection", json!(chosen))?;
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

    /// The selection this run goes out with, checked against the engine's current
    /// list: admission may have had none to hand, and a queued message can outlive
    /// a model. Nothing is asked of the engine when there is nothing to check.
    async fn selection_for_run(
        &self,
        thread: &Thread,
        driver: &dyn EngineDriver,
    ) -> Result<ModelSelection> {
        let chosen = selection::of_thread(thread);
        let keeps = driver.keeps_turn_overrides();
        if !keeps && selection::is_empty(&chosen) {
            return Ok(chosen);
        }
        let catalog = self.engines.models(&thread.engine, false).await?;
        selection::check(&catalog, &chosen)?;
        Ok(if keeps {
            selection::with_defaults(&catalog, &chosen)
        } else {
            chosen
        })
    }

    /// Commits engine events in order until the engine finishes or the run is
    /// cancelled, then brings the engine down before reporting the outcome.
    async fn pump(
        &self,
        thread: &Thread,
        scope: &RunScope,
        handle: RunHandle,
        mut events: mpsc::Receiver<EngineEvent>,
        stops: &Stops,
    ) -> EngineOutcome {
        let cancel = &stops.cancel;
        let mut cancelling = false;
        let mut shaper = EventShaper::default();
        let stop_deadline = tokio::time::sleep(Duration::MAX / 4);
        tokio::pin!(stop_deadline);
        // Only a delegated run, which nobody is watching, is stopped for going quiet.
        let delegated = thread
            .lifecycle
            .as_ref()
            .is_some_and(|l| l.relation.as_deref() == Some("subagent"));
        let silence = tokio::time::sleep(SILENCE_LIMIT);
        tokio::pin!(silence);
        let outcome = loop {
            let text_due = shaper.due();
            tokio::select! {
                biased;
                () = stops.force.cancelled() => {
                    cancelling = true;
                    break EngineOutcome::Cancelled;
                }
                () = cancel.cancelled(), if !cancelling => {
                    cancelling = true;
                    stop_deadline
                        .as_mut()
                        .reset(tokio::time::Instant::now() + STOP_TIMEOUT);
                    // A blocked engine must hear its denial before it can stop.
                    if let Err(error) = self.gate.expire_run(&thread.id, &scope.run_id, "system:cancel") {
                        tracing::warn!(%error, "could not expire approvals on cancel");
                    }
                    if let Err(error) = self.questions.expire_run(&thread.id, &scope.run_id, "system:cancel") {
                        tracing::warn!(%error, "could not expire questions on cancel");
                    }
                    handle.cancel.cancel();
                }
                () = &mut stop_deadline, if cancelling => break EngineOutcome::Cancelled,
                () = &mut silence, if delegated && !cancelling => {
                    // Waiting on a person is not silence.
                    let waiting = self.store.run(&scope.run_id).is_ok_and(|run| {
                        run.state == RunState::AwaitingApproval
                    });
                    silence.as_mut().reset(tokio::time::Instant::now() + SILENCE_LIMIT);
                    if !waiting {
                        break EngineOutcome::Failed(
                            "This delegated run stopped responding, so it was ended.".into(),
                        );
                    }
                }
                () = sleep_until_due(text_due), if text_due.is_some() => {
                    if let Some(outcome) = self.write_events(scope, shaper.flush()) {
                        break outcome;
                    }
                }
                event = events.recv() => {
                    silence.as_mut().reset(tokio::time::Instant::now() + SILENCE_LIMIT);
                    let Some(event) = event else {
                        break if cancelling {
                            EngineOutcome::Cancelled
                        } else {
                            EngineOutcome::Failed("The engine stopped without finishing.".into())
                        };
                    };
                    // Anything else keeps its place after the text before it.
                    if !matches!(event, EngineEvent::Agui(_))
                        && let Some(outcome) = self.write_events(scope, shaper.flush())
                    {
                        break outcome;
                    }
                    match event {
                        EngineEvent::Agui(event) => {
                            if let Some(outcome) = self.write_events(scope, shaper.push(event)) {
                                break outcome;
                            }
                        }
                        EngineEvent::Session(session) => {
                            if let Err(error) = self.store.set_engine_session(&scope.run_id, &session) {
                                tracing::warn!(%error, "could not store the engine session");
                            }
                        }
                        EngineEvent::Item(item) => {
                            if let Err(error) = self.store.record_item(&scope.run_id, &item) {
                                tracing::debug!(%error, "could not keep an engine item");
                            }
                        }
                        EngineEvent::Files(paths) => {
                            crate::file_changes::finished(&self.store, scope, &paths).await;
                        }
                        EngineEvent::Usage(usage) => {
                            if let Err(error) = self.store.record_usage(&scope.run_id, &usage) {
                                tracing::debug!(%error, "could not keep usage");
                            }
                        }
                        EngineEvent::Commands(commands) => {
                            if let Err(error) = self.store.set_engine_commands(&thread.engine, &commands) {
                                tracing::debug!(%error, "could not keep engine commands");
                            }
                        }
                        EngineEvent::Goal(goal) => {
                            if let Err(error) = self.store.set_goal(&thread.id, goal.as_ref()) {
                                tracing::debug!(%error, "could not keep the goal");
                            }
                        }
                        EngineEvent::Question(ask) => {
                            let desk = self.questions.clone();
                            let run_id = scope.run_id.clone();
                            tokio::spawn(async move {
                                let _ = ask.reply.send(desk.ask(&run_id, ask.questions).await);
                            });
                        }
                        EngineEvent::Permission(request) => {
                            self.answer(scope, request);
                        }
                        EngineEvent::Finished(outcome) => break outcome,
                    }
                }
            }
        };
        let _ = self.write_events(scope, shaper.flush());
        // Blocked engines hear a denial even when the engine ended on its own.
        if let Err(error) = self
            .gate
            .expire_run(&thread.id, &scope.run_id, "system:run_end")
        {
            tracing::warn!(%error, "could not expire approvals at run end");
        }
        if let Err(error) = self
            .questions
            .expire_run(&thread.id, &scope.run_id, "system:run_end")
        {
            tracing::warn!(%error, "could not expire questions at run end");
        }
        drop(events);
        handle.cancel.cancel();
        let mut task = handle.task;
        if stops.force.is_cancelled() {
            // Dropping the task's process handle kills the tree.
            task.abort();
            let _ = tokio::time::timeout(FORCE_GRACE, &mut task).await;
        } else if tokio::time::timeout(STOP_TIMEOUT, &mut task).await.is_err() {
            task.abort();
            let _ = task.await;
        }
        if cancelling {
            EngineOutcome::Cancelled
        } else {
            outcome
        }
    }

    /// Writes events in order. Returns how the run ends if it can no longer write.
    fn write_events(&self, scope: &RunScope, events: Vec<AgUiEvent>) -> Option<EngineOutcome> {
        for event in events {
            match self.store.append_run_event(&scope.run_id, &event) {
                Ok(_) => {}
                Err(CoreError::RunClosed | CoreError::StaleOwner) => {
                    return Some(EngineOutcome::Cancelled);
                }
                Err(error) => return Some(EngineOutcome::Failed(error.public_message())),
            }
        }
        None
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
