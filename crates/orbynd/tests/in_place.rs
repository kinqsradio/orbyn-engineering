//! Projects that stay where they are: registration, trust, engine launch and the
//! write scope, with the engine at the library and the work elsewhere.

mod support;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use support::{FAKE, Options, Service, TempDir, run_git};

fn options(launches: &Path, checkout: Option<&Path>) -> Options {
    let mut env = vec![
        ("ORBYN_CLAUDE_BIN".to_owned(), FAKE.to_owned()),
        ("ORBYN_CODEX_BIN".to_owned(), FAKE.to_owned()),
        (
            "ORBYN_FAKE_LAUNCH_FILE".to_owned(),
            launches.to_string_lossy().into_owned(),
        ),
    ];
    if let Some(checkout) = checkout {
        env.push((
            "ORBYN_FAKE_CHECKOUT".to_owned(),
            checkout.to_string_lossy().into_owned(),
        ));
    }
    Options {
        env,
        ..Options::default()
    }
}

/// Every file under `root`, with its bytes, `.git` included.
fn tree(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut folders = vec![root.to_path_buf()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(folder).unwrap().flatten() {
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                folders.push(path);
            } else {
                files.insert(path.clone(), std::fs::read(path).unwrap_or_default());
            }
        }
    }
    files
}

fn external_repo(path: &Path) -> PathBuf {
    std::fs::create_dir_all(path).unwrap();
    run_git(path, &["init", "-q", "-b", "main"]);
    run_git(path, &["config", "user.email", "t@example.com"]);
    run_git(path, &["config", "user.name", "T"]);
    std::fs::write(path.join("base.txt"), "base\n").unwrap();
    run_git(path, &["add", "."]);
    run_git(path, &["commit", "-q", "-m", "first"]);
    support::canonical(path)
}

async fn added(service: &Service, path: &Path) -> Value {
    let (code, body) = service
        .send("/api/projects/add", json!({ "path": path }))
        .await;
    assert_eq!(code, 201, "{body}");
    body
}

async fn trust(service: &Service, project: &str) {
    let (code, _) = service
        .send(&format!("/api/projects/{project}/trust"), json!({}))
        .await;
    assert_eq!(code, 200);
}

async fn start(dir: &TempDir, options: Options) -> Service {
    let service = Service::start(&dir.path().join("data"), options);
    service.ensure_workspace(dir.path()).await;
    service
}

fn launches(path: &Path, mode: &str) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|entry| entry["mode"] == mode)
        .collect()
}

#[tokio::test]
async fn adding_and_removing_write_nothing_and_a_run_leaves_working_files_alone() {
    let dir = TempDir::new();
    let service = start(&dir, options(&dir.path().join("l"), None)).await;
    let repo = external_repo(&dir.path().join("work/app"));
    std::fs::write(repo.join("dirty.txt"), "unsaved").unwrap();
    let before = tree(&repo);
    let project = added(&service, &repo).await;
    assert_eq!(project["path"], repo.to_str().unwrap());
    assert_eq!(project["trusted"], false);
    assert_eq!(project["managed"], false);
    assert_eq!(tree(&repo), before, "adding writes nothing, in .git either");
    let id = project["id"].as_str().unwrap();
    trust(&service, id).await;
    let thread = service.thread(id, "claude").await;
    service.admit(&thread, "hi").await;
    assert_eq!(service.finished(&thread).await, "completed");
    // Checkpoints are the one thing a run adds, as Git metadata under `.git`.
    let working = |files: BTreeMap<PathBuf, Vec<u8>>| {
        let git = repo.join(".git");
        files
            .into_iter()
            .filter(|(path, _)| !path.starts_with(&git))
            .collect::<BTreeMap<_, _>>()
    };
    assert_eq!(working(tree(&repo)), working(before));
    let before = tree(&repo);
    let remove = |query: &'static str| {
        service
            .client
            .delete(format!("{}/api/projects/{id}{query}", service.url))
            .bearer_auth(&service.token)
            .send()
    };
    let refused = remove("?delete_files=true").await.unwrap();
    assert_eq!(refused.status(), 400, "never a folder Orbyn did not make");
    let gone = remove("").await.unwrap();
    assert_eq!(gone.status(), 200);
    let body: Value = gone.json().await.unwrap();
    assert_eq!(body["files_removed"], false);
    assert_eq!(tree(&repo), before, "the folder is byte-identical");
    let projects = service.json("/api/projects").await;
    assert!(
        projects
            .as_array()
            .unwrap()
            .iter()
            .all(|project| project["path"] != repo.to_str().unwrap())
    );
    service.stop().await;
}

#[tokio::test]
async fn the_library_and_duplicates_are_refused_however_they_are_named() {
    let dir = TempDir::new();
    let service = start(&dir, options(&dir.path().join("l"), None)).await;
    let library = support::canonical(dir.path().join("library"));
    for bad in [
        library.clone(),
        library.join("skills"),
        dir.path().to_path_buf(),
    ] {
        let (code, body) = service
            .send("/api/projects/add", json!({ "path": bad }))
            .await;
        assert_eq!(code, 403, "{bad:?}: {body}");
    }
    let (code, _) = service
        .send("/api/projects/add", json!({ "path": "relative/path" }))
        .await;
    assert_eq!(code, 403);
    let repo = external_repo(&dir.path().join("app"));
    #[cfg_attr(not(unix), allow(unused_variables))]
    let project = added(&service, &repo).await;
    #[cfg(unix)]
    {
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&repo, &link).unwrap();
        let (code, body) = service
            .send("/api/projects/add", json!({ "path": link }))
            .await;
        assert_eq!((code, body["code"].as_str()), (409, Some("project_exists")));
        assert_eq!(body["detail"]["id"], project["id"]);
        let into = dir.path().join("into-library");
        std::os::unix::fs::symlink(&library, &into).unwrap();
        let (code, _) = service
            .send("/api/projects/add", json!({ "path": into }))
            .await;
        assert_eq!(code, 403, "a link to the library is the library");
    }
    service.stop().await;
}

#[tokio::test]
async fn an_added_folder_still_needs_trust_before_anything_runs() {
    let dir = TempDir::new();
    let service = start(&dir, options(&dir.path().join("l"), None)).await;
    let repo = external_repo(&dir.path().join("app"));
    let project = added(&service, &repo).await;
    let thread = service
        .thread(project["id"].as_str().unwrap(), "claude")
        .await;
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "hi" }),
        )
        .await;
    assert_eq!(
        (code, body["code"].as_str()),
        (403, Some("folder_untrusted"))
    );
    service.stop().await;
}

#[tokio::test]
async fn claude_starts_at_the_library_and_reaches_the_checkout_by_path() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let service = start(&dir, options(&launch_file, None)).await;
    let library = support::canonical(dir.path().join("library"));
    let repo = external_repo(&dir.path().join("app"));
    let project = added(&service, &repo).await;
    let id = project["id"].as_str().unwrap();
    trust(&service, id).await;
    let thread = service.thread(id, "claude").await;
    service.admit(&thread, "hi").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let launch = &launches(&launch_file, "claude")[0];
    assert_eq!(launch["cwd"], library.to_str().unwrap());
    let args: Vec<&str> = launch["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|arg| arg.as_str().unwrap())
        .collect();
    let at = args.iter().position(|arg| *arg == "--add-dir").unwrap();
    assert_eq!(args[at + 1], repo.to_str().unwrap());
    let prompt = launches(&launch_file, "claude-prompt");
    let prompt = prompt[0]["args"][0].as_str().unwrap();
    let head = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&repo)
        .output()
        .unwrap();
    let head = String::from_utf8_lossy(&head.stdout).trim().to_owned();
    assert!(prompt.contains(&format!("Checkout: {} on main at {head}", repo.display())));
    assert!(prompt.contains("use absolute paths"), "{prompt}");
    service.stop().await;
}

#[tokio::test]
async fn codex_runs_its_turn_in_the_checkout_so_the_library_stays_read_only() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let service = start(&dir, options(&launch_file, None)).await;
    let library = support::canonical(dir.path().join("library"));
    let repo = external_repo(&dir.path().join("app"));
    let project = added(&service, &repo).await;
    let id = project["id"].as_str().unwrap();
    trust(&service, id).await;
    let thread = service.thread(id, "codex").await;
    service.admit(&thread, "hi").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let opened = &launches(&launch_file, "codex-thread")[0];
    let opened: Value = serde_json::from_str(opened["args"][0].as_str().unwrap()).unwrap();
    assert_eq!(opened["cwd"], library.to_str().unwrap());
    let turn = &launches(&launch_file, "codex-turn")[0];
    let turn: Value = serde_json::from_str(turn["args"][0].as_str().unwrap()).unwrap();
    assert_eq!(turn["cwd"], repo.to_str().unwrap());
    assert_eq!(
        turn["sandboxPolicy"]["writableRoots"][0],
        repo.to_str().unwrap()
    );
    service.stop().await;
}

#[tokio::test]
async fn diffs_and_checkpoints_read_the_checkout_not_the_library() {
    let dir = TempDir::new();
    let repo_path = dir.path().join("app");
    let launch_file = dir.path().join("l");
    let service = start(&dir, options(&launch_file, Some(&repo_path))).await;
    let repo = external_repo(&repo_path);
    let project = added(&service, &repo).await;
    let id = project["id"].as_str().unwrap();
    trust(&service, id).await;
    let thread = service.thread(id, "codex").await;
    service.admit(&thread, "[write:from-engine.txt]").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let points = service
        .json(&format!("/api/threads/{thread}/checkpoints"))
        .await;
    assert_eq!(points.as_array().unwrap().len(), 1, "{points}");
    assert!(points[0]["end"].is_string());
    let run = points[0]["run_id"].as_str().unwrap();
    let diff = service
        .json(&format!("/api/threads/{thread}/diff?scope=turn&run={run}"))
        .await;
    assert_eq!(diff[0]["path"], "from-engine.txt", "{diff}");
    let library = support::canonical(dir.path().join("library"));
    assert!(!library.join("from-engine.txt").exists());
    service.stop().await;
}

#[tokio::test]
async fn a_non_git_folder_runs_without_git_features() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let service = start(&dir, options(&launch_file, None)).await;
    let folder = dir.path().join("plain");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("note.txt"), "x").unwrap();
    let folder = support::canonical(folder);
    let before = tree(&folder);
    let project = added(&service, &folder).await;
    assert_eq!(project["is_git"], false);
    let id = project["id"].as_str().unwrap();
    trust(&service, id).await;
    let thread = service.thread(id, "claude").await;
    service.admit(&thread, "hi").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let prompt = launches(&launch_file, "claude-prompt");
    assert!(
        prompt[0]["args"][0]
            .as_str()
            .unwrap()
            .contains("on no branch")
    );
    let mentions = service
        .json(&format!("/api/threads/{thread}/mentions?q=note"))
        .await;
    assert_eq!(mentions["files"][0], "note.txt");
    assert_eq!(tree(&folder), before, "not even a snapshot lands here");
    service.stop().await;
}

#[tokio::test]
async fn a_worktree_is_a_sibling_of_the_primary_clone_wherever_it_lives() {
    let dir = TempDir::new();
    let service = start(&dir, options(&dir.path().join("l"), None)).await;
    let repo = external_repo(&dir.path().join("work/app"));
    let project = added(&service, &repo).await;
    let id = project["id"].as_str().unwrap();
    trust(&service, id).await;
    let (code, body) = service
        .send(
            "/api/threads",
            json!({ "project_id": id, "engine": "claude", "model": null, "title": null,
                    "worktree": "feature-x", "skill_profile": null }),
        )
        .await;
    assert_eq!(code, 201, "{body}");
    let expected = repo.with_file_name("app-wt").join("feature-x");
    assert_eq!(body["cwd"], expected.to_str().unwrap());
    assert!(expected.join("base.txt").exists());
    service.admit(body["id"].as_str().unwrap(), "hi").await;
    assert_eq!(
        service.finished(body["id"].as_str().unwrap()).await,
        "completed"
    );
    service.stop().await;
}

async fn scratch_thread(service: &Service) -> Value {
    let (code, body) = service
        .send(
            "/api/threads",
            json!({ "engine": "claude", "model": null, "title": null, "worktree": null,
                    "skill_profile": null }),
        )
        .await;
    assert_eq!(code, 201, "{body}");
    body
}

#[tokio::test]
async fn a_thread_without_a_project_gets_a_dated_folder_that_outlives_it() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let service = start(&dir, options(&launch_file, None)).await;
    let library = support::canonical(dir.path().join("library"));
    let body = scratch_thread(&service).await;
    assert_eq!(body["scratch"], true);
    let cwd = PathBuf::from(body["cwd"].as_str().unwrap());
    assert!(cwd.is_dir());
    let scratch = support::canonical(dir.path().join("data/scratch"));
    assert!(cwd.starts_with(&scratch), "{cwd:?}");
    let name = cwd.file_name().unwrap().to_str().unwrap();
    assert_eq!(&name[4..5], "-", "dated: {name}");
    let projects = service.json("/api/projects").await;
    assert!(
        projects
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["id"] != body["project_id"]),
        "scratch stays out of the project list"
    );
    let thread = body["id"].as_str().unwrap();
    service.admit(thread, "hi").await;
    assert_eq!(service.finished(thread).await, "completed");
    let launch = &launches(&launch_file, "claude")[0];
    assert_eq!(launch["cwd"], library.to_str().unwrap());
    let quoted = json!(cwd.to_str().unwrap()).to_string();
    assert!(launch.to_string().contains(quoted.trim_matches('"')));
    let gone = service
        .client
        .delete(format!("{}/api/threads/{thread}", service.url))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), 204);
    assert!(cwd.is_dir(), "the folder is kept after the thread goes");
    service.stop().await;
}

#[tokio::test]
async fn a_draft_can_change_project_until_its_first_message() {
    let dir = TempDir::new();
    let service = start(&dir, options(&dir.path().join("l"), None)).await;
    let body = scratch_thread(&service).await;
    let thread = body["id"].as_str().unwrap();
    let repo = external_repo(&dir.path().join("app"));
    let project = added(&service, &repo).await;
    let id = project["id"].as_str().unwrap();
    trust(&service, id).await;
    let (code, moved) = service
        .send(
            &format!("/api/threads/{thread}/project"),
            json!({ "project_id": id }),
        )
        .await;
    assert_eq!(code, 200, "{moved}");
    assert_eq!(moved["cwd"], repo.to_str().unwrap());
    assert_eq!(moved["scratch"], false);
    let (code, back) = service
        .send(&format!("/api/threads/{thread}/project"), json!({}))
        .await;
    assert_eq!(code, 200);
    assert_eq!(back["scratch"], true);
    service.admit(thread, "hi").await;
    assert_eq!(service.finished(thread).await, "completed");
    let (code, _) = service
        .send(
            &format!("/api/threads/{thread}/project"),
            json!({ "project_id": id }),
        )
        .await;
    assert_eq!(code, 400, "a thread that has run stays where it ran");
    service.stop().await;
}

#[tokio::test]
async fn a_scratch_folder_becomes_a_project_in_place_with_its_threads() {
    let dir = TempDir::new();
    let service = start(&dir, options(&dir.path().join("l"), None)).await;
    let body = scratch_thread(&service).await;
    let thread = body["id"].as_str().unwrap();
    service.admit(thread, "hi").await;
    assert_eq!(service.finished(thread).await, "completed");
    let (code, fork) = service
        .send(&format!("/api/threads/{thread}/fork"), json!({}))
        .await;
    assert!(code < 300, "{fork}");
    assert_eq!(fork["scratch"], true);
    let (code, project) = service
        .send(
            &format!("/api/threads/{thread}/adopt"),
            json!({ "name": "Kept" }),
        )
        .await;
    assert_eq!(code, 200, "{project}");
    assert_eq!(project["path"], body["cwd"], "adopted where it is");
    assert_eq!(project["scratch"], false);
    let projects = service.json("/api/projects").await;
    assert!(
        projects
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "Kept")
    );
    let sibling = service
        .json(&format!("/api/threads/{}", fork["id"].as_str().unwrap()))
        .await;
    assert_eq!(sibling["scratch"], false);
    let (code, _) = service
        .send(&format!("/api/threads/{thread}/adopt"), json!({}))
        .await;
    assert_eq!(code, 400);
    tokio::time::sleep(Duration::from_millis(1)).await;
    service.stop().await;
}
