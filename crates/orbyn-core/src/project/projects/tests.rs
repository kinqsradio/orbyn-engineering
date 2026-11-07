use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use orbyn_contracts::WorkspaceSetup;

use super::*;
use crate::CoreConfig;
use crate::testing::{TempDir, library, run_git};

async fn core(dir: &TempDir) -> Core {
    let root = library(&dir.path().join("library"));
    let mut config = CoreConfig::new(dir.path().join("data"), "http://127.0.0.1:1".into());
    config.engines.lookup_latest = false;
    let core = Core::open(config).unwrap();
    core.workspace
        .setup(WorkspaceSetup {
            url: None,
            adopt_path: Some(root.to_string_lossy().into_owned()),
        })
        .await
        .unwrap();
    core
}

fn commit_all(repo: &Path, message: &str) {
    run_git(repo, &["add", "."]);
    run_git(repo, &["commit", "-q", "-m", message]);
}

fn source_repo(path: &Path) -> PathBuf {
    std::fs::create_dir_all(path).unwrap();
    run_git(path, &["init", "-q", "-b", "main"]);
    run_git(path, &["config", "user.email", "t@example.com"]);
    run_git(path, &["config", "user.name", "T"]);
    // Background maintenance would change `.git` while a test snapshots it.
    run_git(path, &["config", "gc.auto", "0"]);
    run_git(path, &["config", "maintenance.auto", "false"]);
    std::fs::write(path.join("a.txt"), "one\n").unwrap();
    commit_all(path, "first");
    crate::util::canonicalize(path).unwrap()
}

/// Every file under a folder with its bytes, `.git` included.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(dir: &Path, into: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                walk(&path, into);
            } else if kind.is_file() && path.extension().is_none_or(|e| e != "lock") {
                into.insert(path.clone(), std::fs::read(&path).unwrap());
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(root, &mut files);
    files
}

#[test]
fn slugs_are_plain_and_never_a_worktree_root() {
    assert_eq!(slug_of("My Project").unwrap(), "my-project");
    assert!(slug_of("app-wt").is_err());
    assert!(slug_of("..").is_err());
    assert!(slug_of("  ").is_err());
    assert_eq!(
        slug_of("../../etc").unwrap(),
        "etc",
        "separators cannot survive"
    );
    assert_eq!(name_from_url("git@github.com:a/b.git"), Some("b"));
    assert_eq!(name_from_url(r"C:\Users\me\source\tool.git\"), Some("tool"));
    assert_eq!(name_from_url(r"\\?\D:\work\app"), Some("app"));
    assert_eq!(name_from_url("https://x.test/a/b/"), Some("b"));
}

#[tokio::test]
async fn create_makes_a_nested_repository() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("App", false, None).await.unwrap();
    let path = PathBuf::from(&project.path);
    assert_eq!(path, core.workspace.repo_dir().unwrap().join("app"));
    assert!(path.join(".git").exists());
    assert!(!project.trusted);
    assert!(
        core.new_project("app", false, None).await.is_err(),
        "slugs are unique"
    );
}

#[tokio::test]
async fn clone_lands_under_repo_and_a_failed_clone_leaves_nothing() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let source = source_repo(&dir.path().join("upstream"));
    let project = core
        .clone_project(source.to_str().unwrap(), None, None)
        .await
        .unwrap();
    assert!(Path::new(&project.path).ends_with(Path::new("repo").join("upstream")));
    assert!(Path::new(&project.path).join("a.txt").exists());

    let missing = dir.path().join("nowhere");
    assert!(
        core.clone_project(missing.to_str().unwrap(), None, None)
            .await
            .is_err()
    );
    let leftovers: Vec<_> = std::fs::read_dir(core.workspace.repo_dir().unwrap())
        .unwrap()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(".incoming"))
        .collect();
    assert!(leftovers.is_empty());
    assert!(
        core.clone_project("--upload-pack=evil", None, None)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn adding_registers_in_place_untrusted_and_touches_nothing() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let source = source_repo(&dir.path().join("mine"));
    std::fs::create_dir_all(source.join("sub")).unwrap();
    std::fs::write(source.join("new.txt"), "dirty").unwrap();
    let before = snapshot(&source);
    let picked = source.join("sub");
    let project = core.add_project(picked.to_str().unwrap()).await.unwrap();
    assert_eq!(
        PathBuf::from(&project.path),
        picked,
        "the selected physical folder is the project"
    );
    assert!(!project.trusted);
    assert!(!project.managed);
    assert_eq!(snapshot(&source), before);
    let repeat = core.add_project(picked.to_str().unwrap()).await;
    assert!(matches!(repeat, Err(CoreError::ProjectExists(_))));
    let parent = core.add_project(source.to_str().unwrap()).await.unwrap();
    assert_ne!(parent.id, project.id);
    assert_eq!(PathBuf::from(parent.path), source);
    assert!(!parent.trusted);
    let plain = dir.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    assert!(
        !core
            .add_project(plain.to_str().unwrap())
            .await
            .unwrap()
            .is_git
    );
    assert!(core.add_project("relative").await.is_err());
}

#[tokio::test]
async fn a_chosen_folder_takes_a_clone_or_a_new_project_and_stays_managed() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let source = source_repo(&dir.path().join("upstream"));
    let chosen = dir.path().join("chosen");
    let project = core
        .clone_project(
            source.to_str().unwrap(),
            None,
            Some(chosen.to_str().unwrap()),
        )
        .await
        .unwrap();
    assert_eq!(PathBuf::from(&project.path), chosen);
    assert!(project.managed);
    assert!(chosen.join("a.txt").exists());
    let again = core
        .new_project("x", false, Some(chosen.to_str().unwrap()))
        .await;
    assert!(again.is_err(), "a folder with files is not a destination");
    let root = core.workspace.root().unwrap();
    let inside = root.join("skills/new");
    assert!(
        core.new_project("x", false, Some(inside.to_str().unwrap()))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn removing_a_dirty_or_unpushed_project_needs_confirmation_and_never_cleans() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let path = PathBuf::from(&project.path);
    run_git(&path, &["config", "user.email", "t@example.com"]);
    run_git(&path, &["config", "user.name", "T"]);
    std::fs::write(path.join("a.txt"), "x").unwrap();
    commit_all(&path, "unpushed");
    std::fs::write(path.join("b.txt"), "dirty").unwrap();

    match core.remove_project(&project.id, false, true).await {
        Err(CoreError::ProjectHasWork { detail, .. }) => {
            assert_eq!(detail["unpushed_branches"][0], "main");
            assert_eq!(detail["dirty_files"].as_array().unwrap().len(), 1);
        }
        other => panic!("{other:?}"),
    }
    assert!(core.store.project(&project.id).is_ok());

    let removal = core.remove_project(&project.id, true, true).await.unwrap();
    assert!(!removal.files_removed);
    assert_eq!(removal.kept_path.as_deref(), Some(project.path.as_str()));
    assert!(
        path.join("b.txt").exists(),
        "confirmation never force-cleans"
    );
    assert!(core.store.list_projects().unwrap().is_empty());
}

#[tokio::test]
async fn a_clean_pushed_project_is_removed_with_its_files() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let source = source_repo(&dir.path().join("upstream"));
    let project = core
        .clone_project(source.to_str().unwrap(), None, None)
        .await
        .unwrap();
    let removal = core.remove_project(&project.id, false, true).await.unwrap();
    assert!(removal.files_removed);
    assert!(!Path::new(&project.path).exists());
}

#[tokio::test]
async fn nothing_is_added_to_a_target_by_being_a_project() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let path = PathBuf::from(&project.path);
    let before = snapshot(&path);
    core.workspace
        .status(std::slice::from_ref(&project))
        .await
        .unwrap();
    assert_eq!(snapshot(&path), before);
}

#[test]
fn ssh_urls_have_an_https_form_and_others_do_not() {
    assert_eq!(
        https_url("git@github.com:a/b.git").as_deref(),
        Some("https://github.com/a/b.git")
    );
    assert_eq!(
        https_url("ssh://git@host.io:2222/a/b.git").as_deref(),
        Some("https://host.io/a/b.git")
    );
    assert_eq!(https_url("https://github.com/a/b.git"), None);
    assert_eq!(https_url("/tmp/repo"), None);
    assert!(ssh_refused("git@x: Permission denied (publickey)."));
    assert!(!ssh_refused("repository not found"));
}

#[tokio::test]
async fn a_new_project_can_start_with_a_readme_and_first_commit() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("Notes", true, None).await.unwrap();
    let path = Path::new(&project.path);
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "# Notes\n"
    );
}

#[tokio::test]
async fn a_background_clone_finishes_and_a_failed_one_can_retry() {
    let dir = TempDir::new();
    let core = Arc::new(core(&dir).await);
    let source = source_repo(&dir.path().join("upstream"));
    let job = core
        .start_clone(source.to_str().unwrap(), None, None)
        .unwrap();
    let finished = until_settled(&core, &job.id).await;
    assert_eq!(finished.state, CloneState::Done);
    assert!(finished.project.is_some());

    let missing = dir.path().join("later");
    let job = core
        .start_clone(missing.to_str().unwrap(), None, None)
        .unwrap();
    let failed = until_settled(&core, &job.id).await;
    assert_eq!(failed.state, CloneState::Failed);
    assert!(failed.error.is_some());
    source_repo(&missing);
    core.retry_clone(&job.id).unwrap();
    assert_eq!(until_settled(&core, &job.id).await.state, CloneState::Done);
    assert!(
        core.retry_clone(&job.id).is_err(),
        "a finished clone stays finished"
    );
    assert!(core.cancel_clone(&job.id).is_err());
}

async fn until_settled(core: &Arc<Core>, id: &str) -> CloneJob {
    for _ in 0..2000 {
        let job = core.clones.job(id).unwrap();
        if job.state != CloneState::Running {
            return job;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("the clone never finished");
}

#[tokio::test]
async fn the_clock_fires_due_tasks_and_a_refusal_is_recorded_and_rescheduled() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let task = core
        .save_task(
            orbyn_contracts::UpsertTask {
                id: None,
                project_id: project.id,
                thread_id: None,
                name: "Tick".into(),
                prompt: "hi".into(),
                engine: "claude".into(),
                schedule: orbyn_contracts::TaskSchedule {
                    kind: "interval".into(),
                    every_minutes: Some(5),
                    time: None,
                    weekdays: Vec::new(),
                    utc_offset_minutes: 0,
                    after_thread: None,
                    only_on_success: false,
                },
                signature: None,
                secret: None,
                filters: Vec::new(),
                dedupe: None,
                max_age_seconds: None,
                timestamp_path: None,
            },
            "user",
        )
        .unwrap();
    let start = crate::util::unix_now();
    assert!(core.store.due_tasks(start).unwrap().is_empty());
    core.store.save_task(&task, Some(start - 1), None).unwrap();
    core.run_due_tasks().await;
    let after = core.store.task(&task.id).unwrap();
    assert!(after.last_status.contains("rust"), "{}", after.last_status);
    assert!(
        core.store.due_tasks(start).unwrap().is_empty(),
        "it moved on"
    );
}

async fn thread_in(core: &Core, project: &Project) -> orbyn_contracts::Thread {
    core.store.trust_project(&project.id, "t").unwrap();
    core.store
        .create_thread(crate::store::NewThread {
            project_id: project.id.clone(),
            title: "work".into(),
            engine: "claude-beta".into(),
            model: None,
            cwd: project.path.clone(),
            worktree: None,
            skill_profile: None,
            parent_thread_id: None,
            relation: None,
            scratch: false,
        })
        .unwrap()
}

#[tokio::test]
async fn removing_a_project_archives_its_threads_with_the_project_name() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let thread = thread_in(&core, &project).await;

    core.remove_project(&project.id, false, false)
        .await
        .unwrap();

    assert!(core.store.list_projects().unwrap().is_empty());
    assert!(
        !core
            .store
            .project_including_removed(&project.id)
            .unwrap()
            .trusted
    );
    let kept = core.store.thread(&thread.id).unwrap();
    assert!(kept.project_removed);
    assert_eq!(kept.removed_project_name.as_deref(), Some("app"));
    assert!(kept.lifecycle.unwrap().archived_at.is_some());
}

#[tokio::test]
async fn a_thread_of_a_removed_project_cannot_be_unarchived() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let thread = thread_in(&core, &project).await;
    core.remove_project(&project.id, false, false)
        .await
        .unwrap();

    let patch = orbyn_contracts::UpdateThread {
        archived: Some(false),
        ..Default::default()
    };
    match core.update_thread(&thread.id, &patch, "t") {
        Err(CoreError::ProjectRemoved(name)) => assert_eq!(name, "app"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn adding_the_folder_back_restores_the_threads_and_unarchive_works() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let thread = thread_in(&core, &project).await;
    core.remove_project(&project.id, false, false)
        .await
        .unwrap();

    let again = core.add_project(&project.path).await.unwrap();
    assert_eq!(again.id, project.id);
    assert!(!again.trusted, "a restored project must be trusted again");
    let restored = core.store.thread(&thread.id).unwrap();
    assert!(!restored.project_removed);

    let patch = orbyn_contracts::UpdateThread {
        archived: Some(false),
        ..Default::default()
    };
    let live = core.update_thread(&thread.id, &patch, "t").unwrap();
    assert!(live.lifecycle.unwrap().archived_at.is_none());
}

fn interval_task(project: &str) -> orbyn_contracts::UpsertTask {
    orbyn_contracts::UpsertTask {
        id: None,
        project_id: project.to_owned(),
        thread_id: None,
        name: "Tick".into(),
        prompt: "hi".into(),
        engine: "claude".into(),
        schedule: orbyn_contracts::TaskSchedule {
            kind: "interval".into(),
            every_minutes: Some(5),
            time: None,
            weekdays: Vec::new(),
            utc_offset_minutes: 0,
            after_thread: None,
            only_on_success: false,
        },
        signature: None,
        secret: None,
        filters: Vec::new(),
        dedupe: None,
        max_age_seconds: None,
        timestamp_path: None,
    }
}

#[tokio::test]
async fn a_refused_firing_is_in_the_history_with_its_reason() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let task = core.save_task(interval_task(&project.id), "user").unwrap();

    assert!(core.run_task(&task.id).await.is_err());

    let history = core.task_runs(&task.id).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].outcome, "refused");
    assert_eq!(history[0].source, "manual");
    assert!(history[0].error.is_some() && history[0].thread_id.is_none());
}

#[tokio::test]
async fn the_history_keeps_the_last_fifty_firings_newest_first() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let task = core.save_task(interval_task(&project.id), "user").unwrap();
    for n in 0..55 {
        core.store
            .record_task_run(&task.id, "schedule", None, "refused", Some(&n.to_string()))
            .unwrap();
    }

    let history = core.task_runs(&task.id).unwrap();
    assert_eq!(history.len(), 50);
    assert_eq!(history[0].error.as_deref(), Some("54"));
    assert_eq!(history[49].error.as_deref(), Some("5"));
}

/// A firing as production makes it: noted, queued, then linked to its message.
fn fire_into(core: &Core, task: &str, thread: &str) -> String {
    let began = core.store.begin_task_run(task, "manual").unwrap();
    let message = core
        .store
        .enqueue(
            thread,
            "go",
            &[],
            &orbyn_contracts::ModelSelection::default(),
        )
        .unwrap();
    core.store
        .finish_task_run(&began, Some(thread), Some(&message.id), "started", None)
        .unwrap();
    message.id
}

#[tokio::test]
async fn a_started_firing_reports_how_its_threads_run_ended() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let task = core.save_task(interval_task(&project.id), "user").unwrap();
    let thread = thread_in(&core, &project).await;
    fire_into(&core, &task.id, &thread.id);
    assert_eq!(core.task_runs(&task.id).unwrap()[0].outcome, "queued");

    let (run, _) = core.store.admit_next(&thread.id, "t").unwrap().unwrap();
    assert_eq!(core.task_runs(&task.id).unwrap()[0].outcome, "running");
    core.store
        .finish_run(&run.id, orbyn_contracts::RunState::Completed, None)
        .unwrap();

    let ended = &core.task_runs(&task.id).unwrap()[0];
    assert_eq!(ended.outcome, "completed");
    assert!(ended.ended_at.is_some());
}

#[tokio::test]
async fn firings_into_one_fixed_thread_each_show_their_own_run() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let task = core.save_task(interval_task(&project.id), "user").unwrap();
    let thread = thread_in(&core, &project).await;
    // A person's own message was already waiting in the thread.
    core.store
        .enqueue(
            &thread.id,
            "mine",
            &[],
            &orbyn_contracts::ModelSelection::default(),
        )
        .unwrap();
    fire_into(&core, &task.id, &thread.id);
    fire_into(&core, &task.id, &thread.id);

    let (mine, _) = core.store.admit_next(&thread.id, "t").unwrap().unwrap();
    core.store
        .finish_run(&mine.id, orbyn_contracts::RunState::Completed, None)
        .unwrap();
    assert_eq!(core.task_runs(&task.id).unwrap()[0].outcome, "queued");
    let (first, _) = core.store.admit_next(&thread.id, "t").unwrap().unwrap();
    core.store
        .finish_run(&first.id, orbyn_contracts::RunState::Completed, None)
        .unwrap();
    let (_second, _) = core.store.admit_next(&thread.id, "t").unwrap().unwrap();

    let history = core.task_runs(&task.id).unwrap();
    assert_eq!(
        history[0].outcome, "running",
        "the newer firing has the second run"
    );
    assert_eq!(
        history[1].outcome, "completed",
        "the older one has the first"
    );
}

#[tokio::test]
async fn a_firing_taken_out_of_the_queue_by_hand_is_cancelled() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let task = core.save_task(interval_task(&project.id), "user").unwrap();
    let thread = thread_in(&core, &project).await;
    let message = fire_into(&core, &task.id, &thread.id);
    core.store.remove_queued(&message).unwrap();
    assert_eq!(core.task_runs(&task.id).unwrap()[0].outcome, "cancelled");
}

#[tokio::test]
async fn a_firing_still_starting_is_settled_as_interrupted_when_the_service_restarts() {
    let dir = TempDir::new();
    let path = dir.path().join("db.sqlite");
    let store = crate::store::Store::open(&path, "a").unwrap();
    let project = store
        .add_project(crate::store::NewProject {
            path: "/p",
            name: "p",
            is_git: false,
            managed: false,
            scratch: false,
        })
        .unwrap();
    let task = interval_task(&project.id);
    let scheduled = orbyn_contracts::ScheduledTask {
        id: "t1".into(),
        project_id: project.id,
        thread_id: None,
        name: task.name,
        prompt: task.prompt,
        engine: task.engine,
        schedule: task.schedule,
        enabled: true,
        signature: None,
        has_secret: false,
        filters: Vec::new(),
        dedupe: None,
        max_age_seconds: None,
        timestamp_path: None,
        next_run_at: None,
        last_run_at: None,
        last_status: "never".into(),
        created_at: crate::util::now(),
        after_run: None,
    };
    store.save_task(&scheduled, None, None).unwrap();
    store.begin_task_run("t1", "manual").unwrap();
    assert_eq!(store.task_runs("t1").unwrap()[0].outcome, "starting");
    drop(store);

    let reopened = crate::store::Store::open(&path, "b").unwrap();
    assert_eq!(reopened.task_runs("t1").unwrap()[0].outcome, "interrupted");
}

fn nearly_used(engine: &str) -> orbyn_contracts::EngineLimits {
    orbyn_contracts::EngineLimits {
        engine: engine.to_owned(),
        checked_at: crate::util::now(),
        limits: serde_json::Value::Null,
        windows: vec![orbyn_contracts::LimitWindow {
            id: "primary".into(),
            label: "5 hours".into(),
            used_percent: 95.0,
            window_minutes: Some(300),
            resets_at: None,
        }],
        plan: None,
    }
}

async fn due(core: &Core, task: &orbyn_contracts::ScheduledTask) {
    core.store
        .save_task(task, Some(crate::util::unix_now() - 1), None)
        .unwrap();
    core.run_due_tasks().await;
}

#[tokio::test]
async fn a_due_task_waits_when_its_engine_is_near_a_limit_and_the_preference_is_on() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let task = core.save_task(interval_task(&project.id), "user").unwrap();
    core.usage.keep_limits(&nearly_used("claude"));
    core.set_preferences(
        None,
        &BTreeMap::from([("task_skip_near_limit".into(), true.into())]),
    )
    .unwrap();

    due(&core, &task).await;

    let after = core.store.task(&task.id).unwrap();
    assert!(
        after.last_status.starts_with("skipped"),
        "{}",
        after.last_status
    );
    assert!(after.last_run_at.is_none());
    assert_eq!(core.task_runs(&task.id).unwrap()[0].outcome, "skipped");
}

#[tokio::test]
async fn a_due_task_fires_near_a_limit_when_the_preference_is_off() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let task = core.save_task(interval_task(&project.id), "user").unwrap();
    core.usage.keep_limits(&nearly_used("claude"));

    due(&core, &task).await;

    assert_eq!(core.task_runs(&task.id).unwrap()[0].outcome, "refused");
}

async fn removed_project(core: &Core) -> Project {
    let project = core.new_project("app", false, None).await.unwrap();
    core.remove_project(&project.id, false, false)
        .await
        .unwrap();
    project
}

fn refused<T: std::fmt::Debug>(result: Result<T>) {
    match result {
        Err(CoreError::ProjectRemoved(name)) => assert_eq!(name, "app"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn the_store_refuses_a_removed_project_but_can_still_read_it() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = removed_project(&core).await;
    refused(core.store.project(&project.id));
    assert!(core.store.project_including_removed(&project.id).is_ok());
}

#[tokio::test]
async fn a_thread_cannot_start_in_a_removed_project() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = removed_project(&core).await;
    refused(
        core.create_thread(orbyn_contracts::CreateThread {
            project_id: Some(project.id),
            engine: "claude".into(),
            model: None,
            title: None,
            worktree: None,
            skill_profile: None,
            base_branch: None,
            effort: None,
            options: BTreeMap::new(),
        })
        .await,
    );
}

#[tokio::test]
async fn a_removed_project_cannot_be_renamed_or_trusted() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = removed_project(&core).await;
    refused(core.rename_project(&project.id, "other"));
    refused(core.store.trust_project(&project.id, "t"));
}

#[tokio::test]
async fn a_removed_project_takes_no_preferences() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = removed_project(&core).await;
    refused(core.set_preferences(
        Some(&project.id),
        &BTreeMap::from([("auto_pull".to_owned(), true.into())]),
    ));
}

#[tokio::test]
async fn a_removed_project_takes_no_task_and_checks_out_no_pull() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let live = core.new_project("live", false, None).await.unwrap();
    let task = core.save_task(interval_task(&live.id), "user").unwrap();
    let project = removed_project(&core).await;
    refused(core.save_task(interval_task(&project.id), "user"));
    refused(
        core.checkout_pull(
            &project.id,
            1,
            &orbyn_contracts::CheckoutPull { worktree: false },
            "t",
        )
        .await,
    );
    assert!(core.set_task_enabled(&task.id, true).is_ok());
}

#[tokio::test]
async fn removing_a_project_pauses_its_tasks_and_they_cannot_be_resumed() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let task = core.save_task(interval_task(&project.id), "user").unwrap();
    core.remove_project(&project.id, false, false)
        .await
        .unwrap();

    let paused = core.store.task(&task.id).unwrap();
    assert!(!paused.enabled && paused.next_run_at.is_none());
    assert!(paused.last_status.starts_with("paused"));
    refused(core.set_task_enabled(&task.id, true));
}

#[tokio::test]
async fn a_stale_due_task_of_a_removed_project_is_refused_and_starts_no_thread() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let task = core.save_task(interval_task(&project.id), "user").unwrap();
    core.remove_project(&project.id, false, false)
        .await
        .unwrap();
    // A row that was due before the removal, as if the pause were missed.
    let mut stale = core.store.task(&task.id).unwrap();
    stale.enabled = true;
    core.store
        .save_task(&stale, Some(crate::util::unix_now() - 1), None)
        .unwrap();

    core.run_due_tasks().await;

    let history = core.task_runs(&task.id).unwrap();
    assert_eq!(history[0].outcome, "refused");
    assert!(history[0].thread_id.is_none());
    assert!(core.store.list_all_threads(&project.id).unwrap().is_empty());
}

#[tokio::test]
async fn removal_refuses_a_run_that_began_after_the_callers_look() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let thread = thread_in(&core, &project).await;
    core.store
        .admit_run(crate::store::Admission {
            thread_id: &thread.id,
            prompt: "go",
            actor: "t",
        })
        .unwrap();

    // The store is what decides, whatever the caller saw before.
    assert!(matches!(
        core.store.remove_project_keeping_threads(&project.id, "t"),
        Err(CoreError::ThreadBusy)
    ));
    assert!(!core.store.thread(&thread.id).unwrap().project_removed);
}

#[tokio::test]
async fn a_thread_of_a_removed_project_cannot_be_moved() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app", false, None).await.unwrap();
    let other = core.new_project("other", false, None).await.unwrap();
    let thread = thread_in(&core, &project).await;
    core.remove_project(&project.id, false, false)
        .await
        .unwrap();

    refused(core.move_thread(&thread.id, Some(&other.id)));
    refused(core.move_thread(&thread.id, None));
}
