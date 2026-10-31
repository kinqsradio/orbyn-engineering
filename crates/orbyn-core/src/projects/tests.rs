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
        source,
        "the Git root is the project"
    );
    assert!(!project.trusted);
    assert!(!project.managed);
    assert_eq!(snapshot(&source), before);
    let repeat = core.add_project(source.to_str().unwrap()).await;
    assert!(matches!(repeat, Err(CoreError::ProjectExists(_))));
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
    assert!(core.store.project(&project.id).is_err());
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
