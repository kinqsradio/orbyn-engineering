//! F23: a worktree's setup action reports where it stands and can be cancelled,
//! through the real Core and HTTP transport with disposable setup processes.
//! Engine protocol doubles count turns; these tests do not qualify live engines.
mod support;

use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use support::{Options, Service, TempDir, run_git};

fn options(dir: &TempDir) -> Options {
    Options {
        env: vec![
            ("HOME".into(), dir.path().to_string_lossy().into_owned()),
            (
                "CODEX_HOME".into(),
                dir.path().join("codex").to_string_lossy().into_owned(),
            ),
            (
                "CLAUDE_CONFIG_DIR".into(),
                dir.path().join("claude").to_string_lossy().into_owned(),
            ),
            (
                "ORBYN_FAKE_LAUNCH_FILE".into(),
                dir.path()
                    .join("launch.ndjson")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ],
        ..Options::default()
    }
}

/// A repository whose setup waits for a `release` file, then exits with its code.
async fn fixture(dir: &TempDir, asynchronous: bool) -> (Service, String, PathBuf) {
    let service = Service::start(&dir.path().join("data"), options(dir));
    let repo = dir.path().join("project");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::write(
        repo.join("setup.cjs"),
        r"
const fs = require('node:fs');
fs.writeFileSync('started', 'yes');
const timer = setInterval(() => {
  if (fs.existsSync('release')) { clearInterval(timer); fs.writeFileSync('finished', 'done'); process.exit(Number(fs.readFileSync('release','utf8'))); }
}, 20);
setTimeout(() => process.exit(71), 30000).unref();
",
    )
    .unwrap();
    std::fs::write(
        repo.join("orbyn.json"),
        json!({"scripts":[{"name":"Setup","command":"node setup.cjs","runOnWorktreeCreate":true,"async":asynchronous}]})
            .to_string(),
    )
    .unwrap();
    run_git(&repo, &["init", "-q", "-b", "main"]);
    run_git(&repo, &["add", "."]);
    run_git(
        &repo,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "Setup fixture",
        ],
    );
    let project = service.project(&repo, true).await;
    let response = service
        .client
        .put(format!("{}/api/preferences", service.url))
        .bearer_auth(&service.token)
        .json(&json!({"values":{"auto_thread_titles":false}}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let (status, thread) = service
        .send(
            "/api/threads",
            json!({"project_id":project,"engine":"codex","worktree":"setup-card","title":"Setup"}),
        )
        .await;
    assert_eq!(status, 201, "{thread}");
    let cwd = PathBuf::from(thread["cwd"].as_str().unwrap());
    wait_for(|| cwd.join("started").exists()).await;
    (service, thread["id"].as_str().unwrap().into(), cwd)
}

async fn wait_for(mut done: impl FnMut() -> bool) {
    for _ in 0..1000 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition never held");
}

async fn setup(service: &Service, thread: &str) -> Value {
    service.json(&format!("/api/threads/{thread}/setup")).await
}

async fn phase_becomes(service: &Service, thread: &str, phase: &str) -> Value {
    for _ in 0..1000 {
        let current = setup(service, thread).await;
        if current["phase"] == phase {
            return current;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("setup never reached {phase}");
}

async fn cancel(service: &Service, thread: &str) -> (u16, Value) {
    service
        .send(&format!("/api/threads/{thread}/setup/cancel"), json!({}))
        .await
}

fn turns(dir: &TempDir) -> usize {
    std::fs::read_to_string(dir.path().join("launch.ndjson"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|row| row["mode"] == "codex-turn")
        .count()
}

async fn terminal_alive(service: &Service, thread: &str) -> Option<bool> {
    let terminals = service
        .json(&format!("/api/threads/{thread}/terminals"))
        .await;
    terminals
        .as_array()?
        .iter()
        .find(|terminal| terminal["script"] == "Setup")
        .map(|terminal| terminal["alive"] == true)
}

#[tokio::test]
async fn a_running_setup_reports_its_terminal_and_its_exit() {
    let dir = TempDir::new();
    let (service, thread, cwd) = fixture(&dir, true).await;
    let running = phase_becomes(&service, &thread, "running").await;
    assert_eq!(running["name"], "Setup");
    assert_eq!(running["blocking"], false);
    assert_eq!(running["cancellable"], true);
    assert!(running["terminal_id"].as_str().is_some(), "{running}");
    std::fs::write(cwd.join("release"), "0").unwrap();
    let finished = phase_becomes(&service, &thread, "finished").await;
    assert_eq!(finished["exit_code"], 0);
    assert_eq!(finished["cancellable"], false);
    let (status, again) = cancel(&service, &thread).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(
        again["phase"], "finished",
        "a finished setup stays finished"
    );
    service.stop().await;
}

#[tokio::test]
async fn cancelling_a_synchronous_setup_stops_it_and_fails_the_waiting_turn() {
    let dir = TempDir::new();
    let (service, thread, cwd) = fixture(&dir, false).await;
    phase_becomes(&service, &thread, "running").await;
    let run = service.admit(&thread, "waits-for-setup").await;
    assert!(!run.is_empty());
    let (status, stopped) = cancel(&service, &thread).await;
    assert_eq!(status, 200, "{stopped}");
    assert_eq!(stopped["phase"], "stopped");
    assert_eq!(stopped["cancellable"], false);
    assert_eq!(service.finished(&thread).await, "failed");
    for _ in 0..500 {
        if terminal_alive(&service, &thread).await == Some(false) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(terminal_alive(&service, &thread).await, Some(false));
    assert_eq!(turns(&dir), 0, "the engine never started");
    assert!(!cwd.join("finished").exists());
    let retry = service
        .json(&format!("/api/threads/{thread}/preparation"))
        .await;
    assert_eq!(
        retry["run_id"],
        run.as_str(),
        "the failed turn keeps its Retry"
    );
    let audit = service.audit(&thread).await;
    assert!(
        audit.iter().any(|row| row["action"] == "setup.cancel"),
        "{audit:?}"
    );
    service.stop().await;
}

#[tokio::test]
async fn cancelling_an_async_setup_leaves_the_first_turn_free() {
    let dir = TempDir::new();
    let (service, thread, _cwd) = fixture(&dir, true).await;
    phase_becomes(&service, &thread, "running").await;
    let (status, stopped) = cancel(&service, &thread).await;
    assert_eq!(status, 200, "{stopped}");
    assert_eq!(stopped["phase"], "stopped");
    service.admit(&thread, "after-async-cancel").await;
    assert_eq!(service.finished(&thread).await, "completed");
    assert_eq!(turns(&dir), 1);
    service.stop().await;
}

#[tokio::test]
async fn a_thread_without_setup_reports_none_and_unknown_threads_are_not_found() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), options(&dir));
    let repo = dir.path().join("plain");
    std::fs::create_dir_all(&repo).unwrap();
    let project = service.project(Path::new(&repo), true).await;
    let thread = service.thread(&project, "codex").await;
    assert_eq!(setup(&service, &thread).await, Value::Null);
    let (status, _) = cancel(&service, &thread).await;
    assert_eq!(status, 404);
    let response = service
        .get("/api/threads/missing/setup")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    service.stop().await;
}
