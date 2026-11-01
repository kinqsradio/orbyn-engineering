//! The `orbyn` command against the real service.

mod support;

use std::process::{Command, Output};

use serde_json::Value;
#[cfg(unix)]
use support::Service;
use support::{Options, TempDir, setup};

const ORBYN: &str = env!("CARGO_BIN_EXE_orbyn");

fn orbyn(data: &std::path::Path, args: &[&str]) -> Output {
    orbyn_with(data, args, &[])
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
    cli_capture::capture(command, std::time::Duration::from_secs(30))
        .unwrap_or_else(|error| panic!("CLI command capture: {error}"))
}

#[cfg(unix)]
#[tokio::test]
async fn ready_means_the_handle_exists_and_an_immediate_stop_is_graceful() {
    for _ in 0..8 {
        let dir = TempDir::new();
        let data = dir.path().join("data");
        let mut service = Service::start(&data, Options::default());
        let file = data.join("service.json");
        let found: Value = serde_json::from_slice(
            &std::fs::read(&file).expect("ready includes the service handle"),
        )
        .unwrap();
        assert_eq!(found["pid"], service.child.id());
        assert!(
            Command::new("kill")
                .arg(service.child.id().to_string())
                .status()
                .unwrap()
                .success()
        );
        let status = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Some(status) = service.child.try_wait().unwrap() {
                    break status;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("an immediate stop finishes");
        assert!(
            status.success(),
            "ready must include installed stop handlers: {status}"
        );
        assert!(!file.exists(), "a graceful stop removes its handle");
    }
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

#[tokio::test]
async fn start_reuses_a_registered_repository_from_a_child_folder() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let project = service.json(&format!("/api/threads/{thread}")).await["project_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let projects = service.json("/api/projects").await;
    let root = std::path::PathBuf::from(
        projects
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == project)
            .unwrap()["path"]
            .as_str()
            .unwrap(),
    );
    let child = root.join("src");
    std::fs::create_dir(&child).unwrap();
    let report = parsed(
        &run(
            &dir.path().join("data"),
            &["start", "--no-open", "--json", &child.to_string_lossy()],
        )
        .await,
    );
    assert_eq!(report["project"], project);
    assert_eq!(
        service
            .json("/api/projects")
            .await
            .as_array()
            .unwrap()
            .len(),
        projects.as_array().unwrap().len()
    );
}

#[tokio::test]
async fn a_packaged_cli_serves_its_bundled_ui_on_a_fresh_start() {
    for (binary_folder, resource_folder) in
        [("Contents/MacOS", "Contents/Resources"), ("bin", "bin")]
    {
        let dir = TempDir::new();
        let bin = dir.path().join(binary_folder);
        let ui = dir.path().join(resource_folder).join("ui");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&ui).unwrap();
        std::fs::write(
            ui.join("index.html"),
            "<!doctype html><title>Bundled UI</title>",
        )
        .unwrap();
        let cli = bin.join(format!("orbyn{}", std::env::consts::EXE_SUFFIX));
        std::fs::copy(ORBYN, &cli).unwrap();
        std::fs::copy(
            env!("CARGO_BIN_EXE_orbynd"),
            bin.join(format!("orbynd{}", std::env::consts::EXE_SUFFIX)),
        )
        .unwrap();
        let data = dir.path().join("data");
        let data_arg = data.clone();
        let output = tokio::task::spawn_blocking(move || {
            let mut command = Command::new(cli);
            command
                .arg("--data-dir")
                .arg(data_arg)
                .args(["start", "--no-open", "--json"])
                .env("ORBYN_OFFLINE", "1");
            cli_capture::capture(command, std::time::Duration::from_secs(30))
                .unwrap_or_else(|error| panic!("packaged CLI capture ({binary_folder}): {error}"))
        })
        .await
        .unwrap();
        let report = parsed(&output);
        assert_eq!(report["started"], true);
        let found: Value =
            serde_json::from_slice(&std::fs::read(data.join("service.json")).unwrap()).unwrap();
        struct Stop(u64);
        impl Drop for Stop {
            fn drop(&mut self) {
                #[cfg(unix)]
                let _ = Command::new("kill").arg(self.0.to_string()).status();
                #[cfg(windows)]
                let _ = Command::new("taskkill")
                    .args(["/PID", &self.0.to_string(), "/T", "/F"])
                    .stdout(std::process::Stdio::null())
                    .status();
            }
        }
        let _stop = Stop(found["pid"].as_u64().unwrap());
        let response = reqwest::get(found["url"].as_str().unwrap()).await.unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.text().await.unwrap().contains("Bundled UI"));
    }
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

#[path = "support/cli_capture.rs"]
mod cli_capture;

#[test]
fn capture_deadline_cleans_a_descendant_that_inherited_output_pipes() {
    use std::{io::Write, time::Duration};
    let dir = TempDir::new();
    let executable = dir
        .path()
        .join(format!("inherited-pipe{}", std::env::consts::EXE_SUFFIX));
    assert!(
        Command::new("rustc")
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/inherited_pipe.rs")
            )
            .arg("-o")
            .arg(&executable)
            .status()
            .unwrap()
            .success()
    );
    let record = dir.path().join("helper");
    let mut command = Command::new(executable);
    command.env("ORBYN_PIPE_RECORD", &record);
    let (send, receive) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        send.send(cli_capture::capture(command, Duration::from_secs(5)))
            .unwrap();
    });
    let result = receive.recv_timeout(Duration::from_secs(10));
    // Independent cleanup bounds the old, unbounded implementation as well.
    if result.is_err()
        && let Ok(text) = std::fs::read_to_string(&record)
    {
        let pid = text.split_whitespace().next().unwrap();
        #[cfg(unix)]
        let _ = Command::new("kill").args(["-KILL", pid]).status();
        #[cfg(windows)]
        let _ = Command::new("taskkill")
            .args(["/PID", pid, "/T", "/F"])
            .status();
    }
    let result = result.unwrap_or_else(|_| {
        receive
            .recv_timeout(Duration::from_secs(5))
            .expect("fixture cleanup releases inherited pipes")
    });
    worker.join().unwrap();
    let error = result.expect_err(
        "inherited pipes must fail at capture deadline, not return success after external cleanup",
    );
    let mut evidence = std::fs::File::create(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/cli-capture-regression.txt"),
    )
    .unwrap();
    writeln!(evidence, "{error}").unwrap();
    assert!(error.contains("timed out"), "{error}");
    assert!(
        error.contains("leader_exited_before_deadline=true"),
        "{error}"
    );
    assert!(error.contains("leader stdout"), "{error}");
    assert!(error.contains("leader stderr"), "{error}");
    let text = std::fs::read_to_string(&record).unwrap();
    let address = text.split_whitespace().nth(1).unwrap().parse().unwrap();
    assert!(
        std::net::TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_err(),
        "descendant exited"
    );
}
