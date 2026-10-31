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
            } else if kind.is_file() {
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
    assert_eq!(name_from_url("https://x.test/a/b/"), Some("b"));
}

#[tokio::test]
async fn create_makes_a_nested_repository() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("App").await.unwrap();
    let path = PathBuf::from(&project.path);
    assert_eq!(path, core.workspace.repo_dir().unwrap().join("app"));
    assert!(path.join(".git").exists());
    assert!(!project.trusted);
    assert!(core.new_project("app").await.is_err(), "slugs are unique");
}

#[tokio::test]
async fn clone_lands_under_repo_and_a_failed_clone_leaves_nothing() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let source = source_repo(&dir.path().join("upstream"));
    let project = core
        .clone_project(source.to_str().unwrap(), None)
        .await
        .unwrap();
    assert!(project.path.ends_with("repo/upstream"));
    assert!(Path::new(&project.path).join("a.txt").exists());

    let missing = dir.path().join("nowhere");
    assert!(
        core.clone_project(missing.to_str().unwrap(), None)
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
        core.clone_project("--upload-pack=evil", None)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn import_leaves_the_source_byte_identical_and_reports_what_stayed() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let source = source_repo(&dir.path().join("mine"));
    run_git(
        &source,
        &["remote", "add", "origin", "https://example.com/o/mine.git"],
    );
    run_git(&source, &["checkout", "-q", "-b", "side"]);
    std::fs::write(source.join("side.txt"), "x").unwrap();
    commit_all(&source, "side work");
    run_git(&source, &["checkout", "-q", "main"]);
    std::fs::write(source.join("a.txt"), "changed\n").unwrap();
    std::fs::write(source.join("new.txt"), "untracked").unwrap();
    let before = snapshot(&source);

    let report = core
        .import_project(source.to_str().unwrap(), None)
        .await
        .unwrap();

    assert_eq!(snapshot(&source), before);
    assert_eq!(report.dirty_files.len(), 2, "{:?}", report.dirty_files);
    assert_eq!(report.unpushed_branches, ["side"]);
    let path = PathBuf::from(&report.project.path);
    assert_eq!(
        text(&git(&path, &["remote", "get-url", "origin"]).await.unwrap()),
        "https://example.com/o/mine.git"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("a.txt")).unwrap(),
        "one\n"
    );
    assert!(!path.join("new.txt").exists());
    assert!(
        strings(&path, &["for-each-ref", "refs/remotes"])
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn import_refuses_folders_it_should_not_take() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let plain = dir.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    assert!(
        core.import_project(plain.to_str().unwrap(), None)
            .await
            .is_err()
    );
    let source = source_repo(&dir.path().join("mine"));
    std::fs::create_dir_all(source.join("sub")).unwrap();
    assert!(
        core.import_project(source.join("sub").to_str().unwrap(), None)
            .await
            .is_err()
    );
    assert!(core.import_project("relative", None).await.is_err());
    let root = core.workspace.root().unwrap();
    assert!(
        core.import_project(root.to_str().unwrap(), None)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn an_external_path_cannot_be_registered() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let outside = source_repo(&dir.path().join("outside"));
    let root = core.workspace.root().unwrap();
    assert!(matches!(
        check_target(&root, &outside).await,
        Err(CoreError::WorkspaceRefused(_))
    ));
}

#[tokio::test]
async fn removing_a_dirty_or_unpushed_project_needs_confirmation_and_never_cleans() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app").await.unwrap();
    let path = PathBuf::from(&project.path);
    run_git(&path, &["config", "user.email", "t@example.com"]);
    run_git(&path, &["config", "user.name", "T"]);
    std::fs::write(path.join("a.txt"), "x").unwrap();
    commit_all(&path, "unpushed");
    std::fs::write(path.join("b.txt"), "dirty").unwrap();

    match core.remove_project(&project.id, false).await {
        Err(CoreError::ProjectHasWork { detail, .. }) => {
            assert_eq!(detail["unpushed_branches"][0], "main");
            assert_eq!(detail["dirty_files"].as_array().unwrap().len(), 1);
        }
        other => panic!("{other:?}"),
    }
    assert!(core.store.project(&project.id).is_ok());

    let removal = core.remove_project(&project.id, true).await.unwrap();
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
        .clone_project(source.to_str().unwrap(), None)
        .await
        .unwrap();
    let removal = core.remove_project(&project.id, false).await.unwrap();
    assert!(removal.files_removed);
    assert!(!Path::new(&project.path).exists());
}

#[tokio::test]
async fn nothing_is_added_to_a_target_by_being_a_project() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let project = core.new_project("app").await.unwrap();
    let path = PathBuf::from(&project.path);
    let before = snapshot(&path);
    core.workspace
        .status(std::slice::from_ref(&project))
        .await
        .unwrap();
    assert_eq!(snapshot(&path), before);
}
