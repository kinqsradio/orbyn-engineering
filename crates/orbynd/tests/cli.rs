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
    // The service announces itself a moment before it writes the file.
    for _ in 0..500 {
        if file.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let found: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(found["token"], service.token.as_str());
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&file).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    service.stop().await;
    assert!(!file.exists());
}

fn orbyn_with(data: &std::path::Path, args: &[&str], env: &[(&str, &std::path::Path)]) -> Output {
    let mut command = Command::new(ORBYN);
    command.arg("--data-dir").arg(data).args(args);
    for (name, value) in env {
        command.env(name, value);
    }
    command.output().unwrap()
}

#[tokio::test]
async fn start_finds_a_running_service_and_opens_the_folder_asked_for() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    let data = dir.path().join("data");
    let folder = dir.path().join("elsewhere");
    std::fs::create_dir_all(&folder).unwrap();
    let path = folder.to_string_lossy().into_owned();
    let (data_arg, opener) = (data.clone(), std::path::PathBuf::from("-"));
    let output = tokio::task::spawn_blocking(move || {
        orbyn_with(&data_arg, &["--json", &path], &[("ORBYN_OPENER", &opener)])
    })
    .await
    .unwrap();
    let text = stdout(&output);
    let mut lines = text.lines();
    let opened = lines.next().unwrap();
    assert!(
        opened.starts_with(&format!("{}/?token=", service.url)),
        "{opened}"
    );
    assert!(opened.contains("#/new/"));
    let report: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
    assert_eq!(report["started"], false);
    assert!(
        !report.to_string().contains(&service.token),
        "never printed as a result"
    );
    let project = report["project"].as_str().unwrap().to_owned();
    // The same folder is the same project.
    let again = run(
        &data,
        &["start", "--no-open", "--json", &folder.to_string_lossy()],
    )
    .await;
    let again: Value = serde_json::from_str(stdout(&again).trim()).unwrap();
    assert_eq!(again["project"], project.as_str());
    let projects = service.json("/api/projects").await;
    let same = projects.as_array().unwrap().iter();
    assert_eq!(same.filter(|p| p["id"] == project.as_str()).count(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn start_leaves_a_service_running_after_it_exits() {
    let dir = TempDir::new();
    let data = dir.path().join("data");
    let (data_arg, offline) = (data.clone(), std::path::PathBuf::from("1"));
    let output = tokio::task::spawn_blocking(move || {
        orbyn_with(
            &data_arg,
            &["start", "--no-open", "--json"],
            &[("ORBYN_OFFLINE", &offline)],
        )
    })
    .await
    .unwrap();
    let report: Value = serde_json::from_str(stdout(&output).trim()).unwrap();
    assert_eq!(report["started"], true);
    let found: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("service.json")).unwrap()).unwrap();
    let pid = found["pid"].as_u64().unwrap().to_string();
    let status = run(&data, &["status", "--json"]).await;
    assert!(stdout(&status).contains("running") || status.status.success());
    Command::new("kill").arg(&pid).status().unwrap();
}

#[test]
fn a_bare_name_that_is_no_folder_is_an_error_and_opens_nothing() {
    let dir = TempDir::new();
    let output = orbyn(&dir.path().join("data"), &["no-such-thing-here"]);
    assert_eq!(output.status.code(), Some(1));
    let text = String::from_utf8_lossy(&output.stderr);
    assert!(text.contains("neither a command nor a folder"), "{text}");
    assert!(!dir.path().join("data").exists(), "nothing was started");
}

#[test]
fn app_goes_through_the_link_and_the_shell_keeps_the_rest() {
    let dir = TempDir::new();
    let opener = std::path::PathBuf::from("-");
    let output = orbyn_with(
        &dir.path().join("data"),
        &["app"],
        &[("ORBYN_OPENER", &opener)],
    );
    assert_eq!(stdout(&output).trim(), "orbyn://");
}

#[test]
fn a_service_dry_run_says_what_it_would_do_and_does_nothing() {
    let dir = TempDir::new();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let env: &[(&str, &std::path::Path)] = &[("HOME", &home), ("USERPROFILE", &home)];
    let data = dir.path().join("data");
    let output = orbyn_with(&data, &["--json", "service", "install", "--dry-run"], env);
    let plan: Value = serde_json::from_str(stdout(&output).trim()).unwrap();
    assert!(!plan["steps"].as_array().unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&home).unwrap().count(), 0);
    if let Some(file) = plan["file"].as_str() {
        assert!(std::path::Path::new(file).starts_with(&home));
        assert!(plan["text"].as_str().unwrap().contains("service"));
    }
    let output = orbyn_with(&data, &["service", "uninstall", "--dry-run"], env);
    assert!(stdout(&output).contains("Would"));
}

#[test]
fn a_service_env_that_cannot_be_read_stops_the_start_and_says_why() {
    let dir = TempDir::new();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("service.env"), "not a variable\n").unwrap();
    let output = orbyn(&data, &["service", "run"]);
    assert_eq!(output.status.code(), Some(1));
    let text = String::from_utf8_lossy(&output.stderr);
    assert!(text.contains("service.env: Line 1"), "{text}");
}
