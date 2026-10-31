use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use orbyn_contracts::{
    CreateThread, EngineCapabilities, EngineTier, InstallerKind, RunState, ServerSettings,
    WorkspaceSetup,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::CoreConfig;
use crate::app::Core;
use crate::driver::{
    EngineDescriptor, EngineDriver, EngineEvent, EngineOutcome, EngineProbe, RunHandle, RunSpec,
    UpdatePlan,
};
use crate::testing::{TempDir, library, run_git};

struct Fake {
    update: &'static str,
    version: &'static str,
}

#[async_trait]
impl EngineDriver for Fake {
    fn descriptor(&self) -> EngineDescriptor {
        EngineDescriptor {
            id: "fake".into(),
            name: "Fake".into(),
            tier: EngineTier::Terminal,
            capabilities: EngineCapabilities {
                streaming: true,
                approvals: true,
                resume: false,
                mcp: false,
                sandbox: false,
                managed: true,
                skill_delivery: Vec::new(),
                goal_control: false,
            },
        }
    }

    async fn probe(&self) -> EngineProbe {
        EngineProbe {
            path: Some("/bin/sh".into()),
            version: Some(self.version.into()),
            ..EngineProbe::default()
        }
    }

    async fn update_plan(&self, _: &EngineProbe) -> Option<UpdatePlan> {
        Some(UpdatePlan {
            installer: InstallerKind::SelfManaged,
            program: "/bin/sh".into(),
            args: vec!["-c".into(), self.update.into()],
            lock_key: "fake".into(),
        })
    }

    async fn latest_version(&self) -> Option<String> {
        Some("9.9.9".into())
    }

    async fn start_run(
        &self,
        _spec: RunSpec,
        events: mpsc::Sender<EngineEvent>,
    ) -> crate::error::Result<RunHandle> {
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let task = tokio::spawn(async move {
            stop.cancelled().await;
            let _ = events
                .send(EngineEvent::Finished(EngineOutcome::Cancelled))
                .await;
        });
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
    upstream: PathBuf,
    thread: String,
}

async fn fixture(update: &'static str) -> Fixture {
    let dir = TempDir::new();
    let upstream = library(&dir.path().join("upstream"));
    let mut config = CoreConfig::new(dir.path().join("data"), "http://127.0.0.1:1".into());
    config.engines.lookup_latest = false;
    let core = Core::open(config).unwrap();
    core.engines.register(Arc::new(Fake {
        update,
        version: "1.0.0",
    }));
    core.setup_workspace(WorkspaceSetup {
        url: Some(upstream.to_string_lossy().into_owned()),
        adopt_path: None,
    })
    .await
    .unwrap();
    let project = core.new_project("app").await.unwrap();
    core.store.trust_project(&project.id, "t").unwrap();
    let thread = core
        .create_thread(CreateThread {
            project_id: project.id,
            engine: "fake".into(),
            model: None,
            title: None,
            worktree: None,
            skill_profile: None,
        })
        .await
        .unwrap()
        .id;
    Fixture {
        _dir: dir,
        core,
        upstream,
        thread,
    }
}

fn upstream_commit(upstream: &Path) {
    std::fs::write(upstream.join("incoming"), "x").unwrap();
    run_git(upstream, &["add", "."]);
    run_git(upstream, &["commit", "-q", "-m", "incoming change"]);
}

async fn wait_running(core: &Core, run: &str) {
    for _ in 0..2500 {
        if core.store.run(run).unwrap().state == RunState::Running {
            return;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("run stayed {:?}", core.store.run(run).unwrap());
}

async fn wait_stopped(core: &Core, run: &str) {
    for _ in 0..2500 {
        if core.store.run(run).unwrap().state.is_terminal() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("run never ended");
}

#[tokio::test]
async fn a_check_reads_and_applies_nothing() {
    let f = fixture("exit 0").await;
    upstream_commit(&f.upstream);
    let before = f.core.workspace.identity().await.unwrap().0;
    let status = f.core.updates.check().await;
    assert_eq!(status.library.behind, 1);
    assert_eq!(status.library.incoming[0].subject, "incoming change");
    assert!(status.library.can_apply);
    assert!(status.checked_at.is_some());
    assert_eq!(f.core.workspace.identity().await.unwrap().0, before);
    let fake = status
        .engines
        .iter()
        .find(|engine| engine.id == "fake")
        .unwrap();
    assert!(fake.can_apply);
    let audit = f.core.store.list_audit(None, 50).unwrap();
    assert!(audit.iter().all(|row| !row.action.contains("update")));
}

#[tokio::test]
async fn a_failed_fetch_keeps_the_prior_result() {
    let f = fixture("exit 0").await;
    upstream_commit(&f.upstream);
    let good = f.core.updates.check().await;
    assert!(good.error.is_none());
    std::fs::remove_dir_all(&f.upstream).unwrap();
    let failed = f.core.updates.check().await;
    assert!(failed.error.unwrap().contains("Library"));
    assert_eq!(failed.checked_at, good.checked_at);
    assert_eq!(failed.library.behind, 1, "what was known stays");
    assert_eq!(failed.library.incoming, good.library.incoming);
}

#[tokio::test]
async fn a_dirty_library_is_shown_but_not_applied() {
    let f = fixture("exit 0").await;
    upstream_commit(&f.upstream);
    let root = f.core.workspace.root().unwrap();
    std::fs::write(root.join("AGENTS.md"), "local edit").unwrap();
    let status = f.core.updates.check().await;
    assert!(status.library.dirty);
    assert!(!status.library.can_apply);
    let result = f.core.updates.apply_all("t").await.unwrap();
    assert!(result.steps.iter().all(|step| step.target != "library"));
    assert_eq!(f.core.updates.status().await.library.behind, 1);
    assert_eq!(
        std::fs::read_to_string(root.join("AGENTS.md")).unwrap(),
        "local edit"
    );
}

#[tokio::test]
async fn apply_all_is_refused_while_a_run_is_active() {
    let f = fixture("exit 0").await;
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    wait_running(&f.core, &run.id).await;
    assert!(matches!(
        f.core.updates.apply_all("t").await,
        Err(CoreError::RunsActive)
    ));
    let fake = f
        .core
        .updates
        .check()
        .await
        .engines
        .into_iter()
        .find(|engine| engine.id == "fake")
        .unwrap();
    assert!(!fake.can_apply);
    f.core.runs.cancel(&run.id).unwrap();
    wait_stopped(&f.core, &run.id).await;
}

#[tokio::test]
async fn apply_all_runs_engines_then_library_and_stops_at_the_first_failure() {
    let f = fixture("echo no registry >&2; exit 3").await;
    upstream_commit(&f.upstream);
    f.core.updates.check().await;
    let before = f.core.workspace.identity().await.unwrap().0;
    let result = f.core.updates.apply_all("t").await.unwrap();
    let last = result.steps.last().unwrap();
    assert_eq!(last.target, "engine:fake");
    assert!(!last.ok);
    assert!(last.message.as_deref().unwrap().contains("no registry"));
    assert_eq!(
        f.core.workspace.identity().await.unwrap().0,
        before,
        "the library waited"
    );

    let f = fixture("exit 0").await;
    upstream_commit(&f.upstream);
    f.core.updates.check().await;
    let result = f.core.updates.apply_all("t").await.unwrap();
    let order: Vec<&str> = result
        .steps
        .iter()
        .map(|step| step.target.as_str())
        .collect();
    assert_eq!(order, ["engine:fake", "library"]);
    assert!(result.steps.iter().all(|step| step.ok));
    let actions: Vec<String> = f
        .core
        .store
        .list_audit(None, 20)
        .unwrap()
        .into_iter()
        .map(|row| row.action)
        .collect();
    for action in ["updates.apply_all", "engine.update", "workspace.update"] {
        assert!(actions.iter().any(|row| row == action), "{action}");
    }
}

#[tokio::test]
async fn server_mode_cannot_replace_itself() {
    let f = fixture("exit 0").await;
    let status = f.core.updates.check().await;
    assert_eq!(status.app.mode, AppMode::Server);
    assert!(status.app.unconfigured);
    assert!(!status.app.can_apply);
    assert!(
        status
            .app
            .blocked_reason
            .unwrap()
            .contains("--update-manifest")
    );
    assert!(matches!(
        f.core.updates.apply_app("t").await,
        Err(CoreError::UpdateUnavailable(_))
    ));
}

#[tokio::test]
async fn shell_lines_drive_app_state_and_junk_is_ignored() {
    let f = fixture("exit 0").await;
    let mut lines = f.core.updates.attach_shell();
    let updates = &f.core.updates;
    let version = updates.subscribe();
    for junk in ["not json", "{", "[]", "{\"type\":\"from_the_future\"}", ""] {
        updates.on_shell_line(junk);
    }
    assert_eq!(*version.borrow(), 0, "ignored lines change nothing");
    updates.check().await;
    assert_eq!(lines.recv().await.unwrap()["type"], "check_app_update");
    updates.on_shell_line(r#"{"type":"app_update_available","version":"99.0.0","notes":"new"}"#);
    let app = updates.status().await.app;
    assert_eq!(app.mode, AppMode::Desktop);
    assert!(app.can_apply);
    assert_eq!(app.notes.as_deref(), Some("new"));
    updates.on_shell_line(r#"{"type":"app_update_progress","downloaded":5,"total":10}"#);
    assert_eq!(updates.status().await.app.downloaded, Some(5));
    updates.on_shell_line(r#"{"type":"app_update_none"}"#);
    assert!(!updates.status().await.app.can_apply);
    updates.on_shell_line(r#"{"type":"app_update_unconfigured"}"#);
    assert!(updates.status().await.app.unconfigured);
}

#[tokio::test]
async fn install_is_refused_during_a_run_then_holds_admission_until_failure() {
    let f = fixture("exit 0").await;
    let mut lines = f.core.updates.attach_shell();
    let updates = &f.core.updates;
    updates.on_shell_line(r#"{"type":"app_update_available","version":"99.0.0"}"#);
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    wait_running(&f.core, &run.id).await;
    assert!(matches!(
        updates.apply_app("t").await,
        Err(CoreError::RunsActive)
    ));
    assert!(lines.try_recv().is_err(), "the shell heard nothing");
    f.core.runs.cancel(&run.id).unwrap();
    wait_stopped(&f.core, &run.id).await;

    updates.apply_app("t").await.unwrap();
    assert_eq!(lines.recv().await.unwrap()["type"], "install_app_update");
    assert!(matches!(
        f.core.runs.admit(&f.thread, "go", "t"),
        Err(CoreError::Updating)
    ));
    updates.on_shell_line(r#"{"type":"app_update_failed","message":"disk full"}"#);
    assert_eq!(updates.status().await.error.as_deref(), Some("disk full"));
    let run = f.core.runs.admit(&f.thread, "go", "t").unwrap();
    f.core.runs.cancel(&run.id).unwrap();
    wait_stopped(&f.core, &run.id).await;
}

#[tokio::test]
async fn install_needs_a_newer_version() {
    let f = fixture("exit 0").await;
    let _lines = f.core.updates.attach_shell();
    assert!(matches!(
        f.core.updates.apply_app("t").await,
        Err(CoreError::UpdateUnavailable(_))
    ));
    assert!(
        f.core.runs.admit(&f.thread, "go", "t").is_ok(),
        "no hold remains"
    );
}

#[tokio::test]
async fn the_setting_turns_background_checks_off() {
    let f = fixture("exit 0").await;
    let settings = ServerSettings {
        background_update_checks: Some(false),
        ..f.core.store.settings().unwrap()
    };
    f.core.store.save_settings(&settings, "t").unwrap();
    upstream_commit(&f.upstream);
    let stop = CancellationToken::new();
    let checks = {
        let (updates, stop) = (f.core.updates.clone(), stop.clone());
        tokio::spawn(async move { updates.run_checks(stop).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    stop.cancel();
    checks.await.unwrap();
    assert_eq!(f.core.updates.status().await.library.behind, 0);
    assert!(f.core.updates.status().await.checked_at.is_none());
}
