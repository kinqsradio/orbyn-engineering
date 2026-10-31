//! The `orbyn` command against the real service.

mod support;

use std::process::{Command, Output};

use serde_json::Value;
#[cfg(unix)]
use support::Service;
use support::{Options, TempDir, setup};

const ORBYN: &str = env!("CARGO_BIN_EXE_orbyn");

fn orbyn(data: &std::path::Path, args: &[&str]) -> Output {
    Command::new(ORBYN)
        .arg("--data-dir")
        .arg(data)
        .args(args)
        .output()
        .unwrap()
}

/// Runs off the test's own thread, since a command may wait for the service.
async fn run(data: &std::path::Path, args: &[&str]) -> Output {
    let data = data.to_path_buf();
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    tokio::task::spawn_blocking(move || {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        orbyn(&data, &args)
    })
    .await
    .unwrap()
}

fn stdout(output: &Output) -> String {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn parsed(output: &Output) -> Value {
    serde_json::from_str(&stdout(output)).unwrap()
}

#[tokio::test]
async fn threads_start_wait_and_show_from_the_command_line() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let data = dir.path().join("data");
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let project = body["project_id"].as_str().unwrap();

    let status = parsed(&run(&data, &["status", "--json"]).await);
    assert_eq!(status["url"], service.url.as_str());
    assert!(status.get("token").is_none(), "the token stays in its file");

    let started = run(
        &data,
        &[
            "thread",
            "start",
            "hello there",
            "--project",
            project,
            "--engine",
            "codex",
            "--wait",
            "--json",
        ],
    )
    .await;
    let id = parsed(&started)["id"].as_str().unwrap().to_owned();
    let shown = parsed(&run(&data, &["thread", "show", &id, "--json"]).await);
    assert_eq!(shown["thread"]["last_run_state"], "completed");
    assert_eq!(shown["messages"][0]["text"], "hello there");
    assert_eq!(shown["messages"][1]["text"], "hello from codex");

    let sent = run(&data, &["thread", "send", &id, "[fail]", "--wait"]).await;
    assert_eq!(
        sent.status.code(),
        Some(1),
        "a failed run fails the command"
    );
    let listed = stdout(&run(&data, &["thread", "list", "--project", project]).await);
    assert!(listed.contains(&id), "{listed}");

    let missing = run(&data, &["thread", "show", "nothing"]).await;
    assert_eq!(missing.status.code(), Some(1));
    let hostile = run(&data, &["thread", "show", "../../api/info"]).await;
    assert_eq!(hostile.status.code(), Some(1), "an id stays an id");
    service.stop().await;
}

#[tokio::test]
async fn projects_and_the_theme_change_from_the_command_line() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    let data = dir.path().join("data");
    let folder = dir.path().join("elsewhere");
    std::fs::create_dir_all(&folder).unwrap();
    let path = folder.to_str().unwrap();
    let added = parsed(&run(&data, &["project", "add", path, "--json"]).await);
    assert_eq!(added["trusted"], false);
    let id = added["id"].as_str().unwrap().to_owned();
    let renamed = parsed(&run(&data, &["project", "rename", &id, "Shiny", "--json"]).await);
    assert_eq!(renamed["name"], "Shiny");
    let blank = run(&data, &["project", "rename", &id, "   "]).await;
    assert_eq!(blank.status.code(), Some(1));
    stdout(&run(&data, &["project", "remove", &id]).await);
    assert!(folder.exists(), "removing leaves the folder");

    stdout(&run(&data, &["theme", "set", "dusk"]).await);
    assert_eq!(stdout(&run(&data, &["theme", "show"]).await).trim(), "dusk");
    stdout(&run(&data, &["theme", "clear"]).await);
    assert_eq!(stdout(&run(&data, &["theme", "show"]).await).trim(), "");

    let report = parsed(&run(&data, &["doctor", "--dry-run", "--json"]).await);
    assert_eq!(report["repaired"], false);
    let fixed = parsed(&run(&data, &["doctor", "--fix", "--json"]).await);
    assert_eq!(fixed["repaired"], true);
    service.stop().await;
}

#[tokio::test]
async fn with_no_service_the_command_says_so_with_its_own_code() {
    let dir = TempDir::new();
    let data = dir.path().join("data");
    let nothing = run(&data, &["status"]).await;
    assert_eq!(nothing.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&nothing.stderr).contains("orbyn serve"));

    // A file left by a crash reads as stopped, not as an error about a socket.
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(
        data.join("service.json"),
        r#"{"url":"http://127.0.0.1:1","token":"t","pid":1}"#,
    )
    .unwrap();
    assert_eq!(run(&data, &["status"]).await.status.code(), Some(2));
    std::fs::write(data.join("service.json"), "nonsense").unwrap();
    assert_eq!(run(&data, &["status"]).await.status.code(), Some(1));
}

// Only Unix can ask a test's service to stop gracefully.
#[cfg(unix)]
#[tokio::test]
async fn the_service_file_is_private_and_goes_when_the_service_does() {
    let dir = TempDir::new();
    let data = dir.path().join("data");
    let service = Service::start(&data, Options::default());
    let file = data.join("service.json");
    let found: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(found["token"], service.token.as_str());
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&file).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    service.stop().await;
    assert!(!file.exists());
}
