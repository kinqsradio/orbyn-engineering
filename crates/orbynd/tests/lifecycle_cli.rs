//! `orbyn update` and `orbyn uninstall` against the real service.

mod support;

use std::io::{BufRead, Write};
use std::path::Path;
use std::process::{Command, Output};
use std::time::Duration;

use serde_json::Value;
use support::{Options, Service, TempDir};

const ORBYN: &str = env!("CARGO_BIN_EXE_orbyn");

async fn orbyn(data: &Path, args: &[&str]) -> Output {
    let data = data.to_path_buf();
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    tokio::task::spawn_blocking(move || {
        Command::new(ORBYN)
            .arg("--data-dir")
            .arg(&data)
            .args(&args)
            .output()
            .unwrap()
    })
    .await
    .unwrap()
}

fn refused(output: &Output, words: &str) {
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains(words), "{stderr}");
}

fn desktop() -> Options {
    Options {
        args: vec!["--parent-stdin".into()],
        ..Options::default()
    }
}

fn say(service: &mut Service, line: &str) {
    let stdin = service.child.stdin.as_mut().unwrap();
    writeln!(stdin, "{line}").unwrap();
    stdin.flush().unwrap();
}

async fn until_latest(service: &Service, version: &str) {
    for _ in 0..500 {
        if service.json("/api/updates").await["app"]["latest"] == version {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the shell's message never arrived");
}

#[tokio::test]
async fn update_checks_refuses_other_versions_and_installs_the_latest_through_the_shell() {
    let dir = TempDir::new();
    let data = dir.path().join("data");
    let mut service = Service::start(&data, desktop());
    say(
        &mut service,
        r#"{"type":"app_update_available","version":"99.0.0","notes":"n"}"#,
    );
    until_latest(&service, "99.0.0").await;

    let output = orbyn(&data, &["--json", "update", "--check"]).await;
    assert!(output.status.success(), "{output:?}");
    let app: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(app["latest"], "99.0.0");
    assert_eq!(app["can_apply"], true);
    let output = orbyn(&data, &["update", "--check"]).await;
    assert!(String::from_utf8_lossy(&output.stdout).contains("99.0.0 is available"));

    refused(
        &orbyn(&data, &["update", "--downgrade"]).await,
        "Downgrading",
    );
    refused(
        &orbyn(&data, &["update", "--channel", "beta"]).await,
        "no `beta` channel",
    );
    refused(
        &orbyn(&data, &["update", "--version", "98.0.0"]).await,
        "98.0.0 is not available",
    );
    refused(
        &orbyn(&data, &["update", "--version", "0.0.1"]).await,
        "downgrading is not supported",
    );
    let output = orbyn(&data, &["update", "--version", env!("CARGO_PKG_VERSION")]).await;
    assert!(String::from_utf8_lossy(&output.stdout).contains("already installed"));
    let output = orbyn(&data, &["update", "--version", "v99.0.0"]).await;
    assert!(output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("Installing Orbyn 99.0.0"));

    let mut line = String::new();
    while !line.contains("install_app_update") {
        line.clear();
        service.stdout.read_line(&mut line).unwrap();
        assert!(!line.is_empty(), "stdout closed");
    }
}

#[tokio::test]
async fn a_server_without_a_shell_reports_and_cannot_install() {
    let dir = TempDir::new();
    let data = dir.path().join("data");
    let _service = Service::start(&data, Options::default());
    let output = orbyn(&data, &["update", "--check"]).await;
    assert!(output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("No release manifest"));
    let output = orbyn(&data, &["update"]).await;
    assert!(output.status.success(), "{output:?}");
}

#[tokio::test]
async fn update_with_no_service_says_so_with_its_own_code() {
    let dir = TempDir::new();
    let output = orbyn(&dir.path().join("data"), &["update"]).await;
    assert_eq!(output.status.code(), Some(2));
}

fn profile(dir: &TempDir) -> std::path::PathBuf {
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    home
}

fn orbyn_at_home(data: &Path, home: &Path, args: &[&str]) -> Output {
    Command::new(ORBYN)
        .arg("--data-dir")
        .arg(data)
        .args(args)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .output()
        .unwrap()
}

#[test]
#[cfg(not(windows))]
fn uninstall_dry_run_plans_the_service_removal_and_keeps_everything_else() {
    let dir = TempDir::new();
    let home = profile(&dir);
    let data = dir.path().join("data");
    let output = orbyn_at_home(&data, &home, &["--json", "uninstall", "--dry-run"]);
    assert!(output.status.success(), "{output:?}");
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["dry_run"], true);
    let removed = report["service"]["remove"].as_str().unwrap();
    assert!(Path::new(removed).starts_with(&home), "{removed}");
    assert!(report["launcher"].is_null());
    assert_eq!(report["versions"], serde_json::json!([]));
    assert!(report["running"].is_null());
    assert_eq!(report["data"], data.to_string_lossy().as_ref());
    let output = orbyn_at_home(&data, &home, &["uninstall", "--dry-run"]);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("Would remove"), "{text}");
    assert!(text.contains("stay in"), "{text}");
    // A plan touches nothing: no profile file, and no data folder appears.
    assert_eq!(std::fs::read_dir(&home).unwrap().count(), 0);
    assert!(!data.exists());
}

#[test]
#[cfg(windows)]
fn uninstall_on_windows_has_no_service_and_points_at_installed_apps() {
    let dir = TempDir::new();
    let home = profile(&dir);
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("keep.txt"), "x").unwrap();
    let output = orbyn_at_home(&data, &home, &["uninstall"]);
    assert!(output.status.success(), "{output:?}");
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("No background service"), "{text}");
    assert!(text.contains("Installed apps"), "{text}");
    assert_eq!(std::fs::read_dir(&home).unwrap().count(), 0);
    assert!(data.join("keep.txt").exists());
}

#[tokio::test]
async fn uninstall_names_a_service_that_is_still_running() {
    let dir = TempDir::new();
    let home = profile(&dir);
    let data = dir.path().join("data");
    let service = Service::start(&data, Options::default());
    let (data2, home2) = (data.clone(), home.clone());
    let output = tokio::task::spawn_blocking(move || {
        orbyn_at_home(&data2, &home2, &["--json", "uninstall", "--dry-run"])
    })
    .await
    .unwrap();
    assert!(output.status.success(), "{output:?}");
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["running"], service.url.as_str());
}
