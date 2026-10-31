//! Adverse orderings around one run, against a scripted in-process driver.
//! Wire-format behavior is covered against the fake engine in `orbynd/tests`.

use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use orbyn_contracts::{
    ActionKind, AgUiEvent, ApprovalState, CreateThread, EngineCapabilities, EngineTier, RunState,
    SkillDelivery,
};
use serde_json::{Value, json};

use super::*;
use crate::Core;
use crate::app::CoreConfig;
use crate::approvals::Verdict;
use crate::driver::{EngineDescriptor, EngineDriver, EngineProbe, UpdatePlan, ask};
use crate::testing::TempDir;

type Script = Arc<
    dyn Fn(RunSpec, mpsc::Sender<EngineEvent>, CancellationToken) -> JoinHandle<()> + Send + Sync,
>;

struct ScriptDriver {
    script: Script,
    capabilities: EngineCapabilities,
    update_script: String,
}

fn capabilities() -> EngineCapabilities {
    EngineCapabilities {
        streaming: true,
        approvals: true,
        resume: true,
        mcp: true,
        sandbox: false,
        managed: true,
        skill_delivery: vec![SkillDelivery::McpSkillServer],
    }
}

#[async_trait]
impl EngineDriver for ScriptDriver {
    fn descriptor(&self) -> EngineDescriptor {
        EngineDescriptor {
            id: "script".into(),
            name: "Script".into(),
            tier: EngineTier::Terminal,
            capabilities: self.capabilities.clone(),
        }
    }

    async fn probe(&self) -> EngineProbe {
        EngineProbe {
            path: Some("/bin/echo".into()),
            version: Some("1.0.0".into()),
            ..EngineProbe::default()
        }
    }

    async fn update_plan(&self, _: &EngineProbe) -> Option<UpdatePlan> {
        Some(UpdatePlan {
            installer: orbyn_contracts::InstallerKind::SelfManaged,
            program: "/bin/sh".into(),
            args: vec!["-c".into(), self.update_script.clone()],
            lock_key: "script".into(),
        })
    }

    async fn start_run(
        &self,
        spec: RunSpec,
        events: mpsc::Sender<EngineEvent>,
    ) -> Result<RunHandle> {
        let cancel = CancellationToken::new();
        let task = (self.script)(spec, events, cancel.clone());
        Ok(RunHandle {
            cancel,
            task,
            input: None,
        })
    }
}

struct Fixture {
    _dir: TempDir,
    core: Core,
    thread: String,
}

async fn fixture(script: Script) -> Fixture {
    fixture_with(script, "echo updated", Duration::from_secs(30)).await
}

async fn fixture_with(script: Script, update: &str, update_timeout: Duration) -> Fixture {
    let dir = TempDir::new();
    let root = crate::testing::library(&dir.path().join("library"));
    let mut config = CoreConfig::new(dir.path().join("data"), "http://127.0.0.1:1".into());
    config.engines.lookup_latest = false;
    config.engines.update_timeout = update_timeout;
    let core = Core::open(config).unwrap();
    core.engines.register(Arc::new(ScriptDriver {
        script,
        capabilities: capabilities(),
        update_script: update.to_owned(),
    }));
    core.workspace
        .setup(orbyn_contracts::WorkspaceSetup {
            url: None,
            adopt_path: Some(root.to_string_lossy().into_owned()),
        })
        .await
        .unwrap();
    let project = core.new_project("project").await.unwrap();
    core.store.trust_project(&project.id, "t").unwrap();
    let thread = core
        .create_thread(CreateThread {
            project_id: project.id,
            engine: "script".into(),
            model: None,
            title: None,
            worktree: None,
            skill_profile: None,
        })
        .await
        .unwrap();
    Fixture {
        _dir: dir,
        core,
        thread: thread.id,
    }
}

async fn until_state(core: &Core, run: &str, wanted: RunState) {
    for _ in 0..2000 {
        if core.store.run(run).unwrap().state == wanted {
            return;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!(
        "run stayed {:?}, wanted {wanted:?}",
        core.store.run(run).unwrap().state
    );
}

async fn until_terminal(core: &Core, run: &str) -> RunState {
    for _ in 0..4000 {
        let state = core.store.run(run).unwrap().state;
        if state.is_terminal() {
            return state;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("run never ended");
}

async fn until_pending(core: &Core, thread: &str) -> orbyn_contracts::Approval {
    for _ in 0..2000 {
        if let Some(found) = core.store.pending_for_thread(thread).unwrap().pop() {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("no approval appeared");
}

fn text(delta: &str) -> EngineEvent {
    AgUiEvent::TextMessageContent {
        message_id: "m".into(),
        delta: delta.into(),
    }
    .into()
}

async fn request(events: &mpsc::Sender<EngineEvent>) -> Verdict {
    ask(
        events,
        ActionKind::Command,
        "ls".into(),
        "Run ls".into(),
        Value::Null,
    )
    .await
}

fn finished() -> Script {
    Arc::new(|_, events, _| {
        tokio::spawn(async move {
            let _ = events.send(text("hello")).await;
            let _ = events
                .send(EngineEvent::Finished(EngineOutcome::Completed))
                .await;
        })
    })
}

#[tokio::test]
async fn completed_run_logs_in_order_and_leaves_no_residue() {
    let f = fixture(finished()).await;
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    assert_eq!(until_terminal(&f.core, &run.id).await, RunState::Completed);
    let events = f.core.store.events_after(&f.thread, 0, 100).unwrap();
    assert!(matches!(events[0].event, AgUiEvent::RunStarted { .. }));
    assert!(matches!(
        events.last().unwrap().event,
        AgUiEvent::RunFinished { .. }
    ));
    for _ in 0..500 {
        if f.core.runs.active_count() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert_eq!(f.core.runs.active_count(), 0);
    assert!(!f.core.config.data_dir.join("runs").join(&run.id).exists());
}

#[tokio::test]
async fn admission_is_durable_before_the_engine_starts() {
    let seen: Arc<Mutex<Option<RunState>>> = Arc::default();
    let store_slot: Arc<Mutex<Option<Arc<Store>>>> = Arc::default();
    let script: Script = {
        let seen = seen.clone();
        let store_slot = store_slot.clone();
        Arc::new(move |spec, events, _| {
            let store = store_slot.lock().unwrap().clone().unwrap();
            *seen.lock().unwrap() = Some(store.run(&spec.run_id).unwrap().state);
            tokio::spawn(async move {
                let _ = events
                    .send(EngineEvent::Finished(EngineOutcome::Completed))
                    .await;
            })
        })
    };
    let f = fixture(script).await;
    *store_slot.lock().unwrap() = Some(f.core.store.clone());
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    until_terminal(&f.core, &run.id).await;
    assert_eq!(*seen.lock().unwrap(), Some(RunState::Starting));
}

#[tokio::test]
async fn second_admission_is_thread_busy() {
    let script: Script = Arc::new(|_, events, cancel| {
        tokio::spawn(async move {
            cancel.cancelled().await;
            let _ = events
                .send(EngineEvent::Finished(EngineOutcome::Cancelled))
                .await;
        })
    });
    let f = fixture(script).await;
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    until_state(&f.core, &run.id, RunState::Running).await;
    assert!(matches!(
        f.core.runs.admit(&f.thread, "again", "t"),
        Err(CoreError::ThreadBusy)
    ));
    f.core.runs.cancel(&run.id).unwrap();
    assert_eq!(until_terminal(&f.core, &run.id).await, RunState::Cancelled);
}

#[tokio::test]
async fn cancel_during_approval_denies_the_engine_and_expires_it() {
    let heard: Arc<Mutex<Option<Verdict>>> = Arc::default();
    let script: Script = {
        let heard = heard.clone();
        Arc::new(move |_, events, cancel| {
            let heard = heard.clone();
            tokio::spawn(async move {
                let verdict = request(&events).await;
                *heard.lock().unwrap() = Some(verdict);
                cancel.cancelled().await;
                let _ = events
                    .send(EngineEvent::Finished(EngineOutcome::Cancelled))
                    .await;
            })
        })
    };
    let f = fixture(script).await;
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    let approval = until_pending(&f.core, &f.thread).await;
    assert_eq!(
        f.core.store.run(&run.id).unwrap().state,
        RunState::AwaitingApproval
    );
    f.core.runs.cancel(&run.id).unwrap();
    assert_eq!(until_terminal(&f.core, &run.id).await, RunState::Cancelled);
    assert!(!heard.lock().unwrap().clone().unwrap().is_allowed());
    assert_eq!(
        f.core.store.approval(&approval.id).unwrap().state,
        ApprovalState::Expired
    );
}

#[tokio::test]
async fn engine_exit_during_approval_fails_the_run_and_expires() {
    let script: Script = Arc::new(|_, events, _| {
        tokio::spawn(async move {
            let (reply, _verdict) = tokio::sync::oneshot::channel();
            let _ = events
                .send(EngineEvent::Permission(PermissionRequest {
                    kind: ActionKind::Command,
                    target: "ls".into(),
                    summary: "ls".into(),
                    detail: Value::Null,
                    paths: Vec::new(),
                    reply,
                }))
                .await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            // Dropping `events` is the engine disappearing without a word.
        })
    });
    let f = fixture(script).await;
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    let approval = until_pending(&f.core, &f.thread).await;
    assert_eq!(until_terminal(&f.core, &run.id).await, RunState::Failed);
    assert_eq!(
        f.core.store.approval(&approval.id).unwrap().state,
        ApprovalState::Expired
    );
}

#[tokio::test]
async fn decision_racing_run_end_cannot_land_on_a_finished_run() {
    let script: Script = Arc::new(|_, events, _| {
        tokio::spawn(async move {
            let asker = events.clone();
            tokio::spawn(async move { request(&asker).await });
            tokio::time::sleep(Duration::from_millis(20)).await;
            let _ = events
                .send(EngineEvent::Finished(EngineOutcome::Completed))
                .await;
        })
    });
    let f = fixture(script).await;
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    let approval = until_pending(&f.core, &f.thread).await;
    until_terminal(&f.core, &run.id).await;
    assert!(matches!(
        f.core.gate.decide(&approval.id, true, true, "late"),
        Err(CoreError::AlreadyDecided(_))
    ));
    assert!(f.core.store.list_rules().unwrap().is_empty());
}

#[tokio::test]
async fn late_events_after_finish_change_nothing() {
    let sent_late = Arc::new(AtomicBool::new(false));
    let script: Script = {
        let sent_late = sent_late.clone();
        Arc::new(move |_, events, cancel| {
            let sent_late = sent_late.clone();
            tokio::spawn(async move {
                let _ = events
                    .send(EngineEvent::Finished(EngineOutcome::Completed))
                    .await;
                cancel.cancelled().await;
                // The receiver is gone or the run is closed; either way nothing lands.
                let _ = events.send(text("too late")).await;
                sent_late.store(true, Ordering::SeqCst);
            })
        })
    };
    let f = fixture(script).await;
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    assert_eq!(until_terminal(&f.core, &run.id).await, RunState::Completed);
    assert!(sent_late.load(Ordering::SeqCst));
    let events = f.core.store.events_after(&f.thread, 0, 100).unwrap();
    assert!(matches!(
        events.last().unwrap().event,
        AgUiEvent::RunFinished { .. }
    ));
    assert_eq!(
        f.core.store.run(&run.id).unwrap().state,
        RunState::Completed
    );
}

#[tokio::test]
async fn driver_that_ignores_cancel_is_still_torn_down() {
    let script: Script = Arc::new(|_, events, _| {
        tokio::spawn(async move {
            let _held_open = events;
            std::future::pending::<()>().await;
        })
    });
    let f = fixture(script).await;
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    until_state(&f.core, &run.id, RunState::Running).await;
    tokio::time::pause();
    f.core.runs.cancel(&run.id).unwrap();
    tokio::time::sleep(STOP_TIMEOUT * 3).await;
    tokio::time::resume();
    assert_eq!(until_terminal(&f.core, &run.id).await, RunState::Cancelled);
}

#[tokio::test]
async fn panicking_engine_task_fails_the_run() {
    let script: Script = Arc::new(|_, _events, _| {
        tokio::spawn(async move {
            panic!("driver bug");
        })
    });
    let f = fixture(script).await;
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    assert_eq!(until_terminal(&f.core, &run.id).await, RunState::Failed);
}

#[tokio::test]
async fn mcp_token_lives_exactly_as_long_as_the_run() {
    let url: Arc<Mutex<Option<String>>> = Arc::default();
    let script: Script = {
        let url = url.clone();
        Arc::new(move |spec, events, cancel| {
            *url.lock().unwrap() = spec.mcp_url.clone();
            tokio::spawn(async move {
                cancel.cancelled().await;
                let _ = events
                    .send(EngineEvent::Finished(EngineOutcome::Cancelled))
                    .await;
            })
        })
    };
    let f = fixture(script).await;
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    until_state(&f.core, &run.id, RunState::Running).await;
    let url = url.lock().unwrap().clone().unwrap();
    let token = url.rsplit('/').next().unwrap().to_owned();
    assert!(f.core.mcp.is_valid(&token));
    f.core.runs.cancel(&run.id).unwrap();
    until_terminal(&f.core, &run.id).await;
    assert!(!f.core.mcp.is_valid(&token));
    let reply = f
        .core
        .mcp
        .handle(
            &token,
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
        )
        .await;
    assert!(reply.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn update_is_refused_during_a_run_and_admission_during_an_update() {
    let script: Script = Arc::new(|_, events, cancel| {
        tokio::spawn(async move {
            cancel.cancelled().await;
            let _ = events
                .send(EngineEvent::Finished(EngineOutcome::Cancelled))
                .await;
        })
    });
    let f = fixture(script).await;
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    until_state(&f.core, &run.id, RunState::Running).await;
    let refused = f.core.engines.update("script", "t").await;
    assert!(matches!(refused, Err(CoreError::EngineBusy(_))));
    let audit = f.core.store.list_audit(None, 50).unwrap();
    assert!(audit.iter().all(|row| row.action != "engine.update"));
    f.core.runs.cancel(&run.id).unwrap();
    until_terminal(&f.core, &run.id).await;

    assert!(f.core.engines.update("script", "t").await.is_ok());
    let audit = f.core.store.list_audit(None, 50).unwrap();
    let positions: Vec<_> = audit
        .iter()
        .map(|row| row.action.as_str())
        .filter(|action| action.starts_with("engine.update"))
        .collect();
    assert_eq!(positions, ["engine.update.result", "engine.update"]);
}

#[cfg(unix)]
#[tokio::test]
async fn failed_update_keeps_its_output_and_clears_the_lock() {
    let f = fixture_with(
        finished(),
        "echo broken registry >&2; exit 3",
        Duration::from_secs(30),
    )
    .await;
    let failed = f.core.engines.update("script", "t").await;
    match failed {
        Err(CoreError::UpdateFailed(output)) => assert!(output.contains("broken registry")),
        other => panic!("{other:?}"),
    }
    assert!(f.core.engines.admit_with("script", || Ok(())).is_ok());
    let audit = f.core.store.list_audit(None, 10).unwrap();
    assert_eq!(audit[0].action, "engine.update.result");
    assert_eq!(audit[0].detail["ok"], json!(false));
}

#[cfg(unix)]
#[tokio::test]
async fn hung_update_is_stopped_at_its_timeout_with_its_children() {
    let dir = TempDir::new();
    let marker = dir.path().join("survived");
    let script = format!("(sleep 1; touch '{}') & wait", marker.display());
    let f = fixture_with(finished(), &script, Duration::from_millis(100)).await;
    let timed_out = f.core.engines.update("script", "t").await;
    match timed_out {
        Err(CoreError::UpdateFailed(output)) => assert!(output.contains("in time")),
        other => panic!("{other:?}"),
    }
    tokio::time::sleep(Duration::from_millis(1300)).await;
    assert!(!marker.exists(), "the update's child outlived its timeout");
}

#[cfg(unix)]
#[tokio::test]
async fn admission_is_refused_while_an_update_runs() {
    let f = fixture_with(finished(), "sleep 1", Duration::from_secs(30)).await;
    let engines = f.core.engines.clone();
    let updating = tokio::spawn(async move { engines.update("script", "t").await });
    for _ in 0..500 {
        let statuses = f.core.engines.statuses(false).await.unwrap();
        if statuses.iter().any(|status| status.updating) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert!(matches!(
        f.core.runs.admit(&f.thread, "go", "t"),
        Err(CoreError::EngineBusy(_))
    ));
    assert_eq!(f.core.store.latest_seq(&f.thread).unwrap(), 0);
    assert!(updating.await.unwrap().is_ok());
    assert!(f.core.runs.admit(&f.thread, "go", "t").is_ok());
}

#[tokio::test]
async fn run_context_names_the_checkout_and_the_prompt_stays_clean_in_the_log() {
    let seen: Arc<Mutex<Option<RunSpec>>> = Arc::default();
    let script: Script = {
        let seen = seen.clone();
        Arc::new(move |spec, events, _| {
            *seen.lock().unwrap() = Some(spec);
            tokio::spawn(async move {
                let _ = events
                    .send(EngineEvent::Finished(EngineOutcome::Completed))
                    .await;
            })
        })
    };
    let f = fixture(script).await;
    let run = f.core.runs.admit(&f.thread, "do the thing", "t").unwrap();
    until_terminal(&f.core, &run.id).await;
    let spec = seen.lock().unwrap().clone().unwrap();
    let root = f.core.workspace.root().unwrap();
    assert_eq!(spec.checkout, root.join("repo/project"));
    assert_eq!(
        spec.cwd, spec.checkout,
        "a non-native engine works in the checkout"
    );
    assert!(spec.prompt.ends_with("do the thing"));
    assert_eq!(spec.user_prompt, "do the thing");
    for needle in [
        root.to_str().unwrap(),
        spec.checkout.to_str().unwrap(),
        "Target rules specialize shared methods",
        "discovery across a Git boundary",
        "Skills in scope: how",
    ] {
        assert!(spec.prompt.contains(needle), "{needle}");
    }
    assert_eq!(
        f.core.store.transcript(&f.thread, 1000).unwrap().trim(),
        "do the thing"
    );
}

#[tokio::test]
async fn a_moved_checkout_fails_the_run_instead_of_escaping() {
    let f = fixture(finished()).await;
    let thread = f.core.store.thread(&f.thread).unwrap();
    std::fs::remove_dir_all(&thread.cwd).unwrap();
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    assert_eq!(until_terminal(&f.core, &run.id).await, RunState::Failed);
}

#[tokio::test]
async fn second_owner_of_a_data_dir_is_refused() {
    let f = fixture(finished()).await;
    let config = f.core.config.clone();
    assert!(matches!(Core::open(config), Err(CoreError::DataDirLocked)));
}

#[tokio::test]
async fn shutdown_ends_runs_as_cancelled() {
    let script: Script = Arc::new(|_, events, cancel| {
        tokio::spawn(async move {
            cancel.cancelled().await;
            let _ = events
                .send(EngineEvent::Finished(EngineOutcome::Cancelled))
                .await;
        })
    });
    let f = fixture(script).await;
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    until_state(&f.core, &run.id, RunState::Running).await;
    f.core.shutdown().await;
    assert_eq!(
        f.core.store.run(&run.id).unwrap().state,
        RunState::Cancelled
    );
}

#[tokio::test]
async fn empty_prompt_is_rejected_before_admission() {
    let f = fixture(finished()).await;
    assert!(matches!(
        f.core.runs.admit(&f.thread, "  ", "t"),
        Err(CoreError::Invalid(_))
    ));
    assert_eq!(f.core.store.latest_seq(&f.thread).unwrap(), 0);
}

#[tokio::test]
async fn resume_passes_the_stored_session() {
    let resumes: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let script: Script = {
        let resumes = resumes.clone();
        Arc::new(move |spec, events, _| {
            resumes.lock().unwrap().push(spec.resume.clone());
            tokio::spawn(async move {
                let _ = events.send(EngineEvent::Session("session-1".into())).await;
                let _ = events
                    .send(EngineEvent::Finished(EngineOutcome::Completed))
                    .await;
            })
        })
    };
    let f = fixture(script).await;
    for _ in 0..2 {
        let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
        until_terminal(&f.core, &run.id).await;
        for _ in 0..2500 {
            if f.core.runs.active_count() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
    assert_eq!(
        *resumes.lock().unwrap(),
        [None, Some("session-1".to_owned())]
    );
}
