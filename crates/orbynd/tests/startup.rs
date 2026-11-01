//! Cancellation before the service announces readiness, through real processes.
mod support;

use orbyn_core::process::{ManagedChild, ProcessTree};
use std::{path::Path, process::Stdio, time::Duration};
use support::{Options, Service, TempDir};
use tokio::{io::AsyncReadExt, process::Command};

struct GitFixture(std::path::PathBuf);
impl Drop for GitFixture {
    fn drop(&mut self) {
        // The Git leader owns its own group/job. Clean up even on assertion failure.
        if let Ok(pid) = std::fs::read_to_string(self.0.with_extension("pid")) {
            let pid: u32 = pid.parse().unwrap();
            #[cfg(unix)]
            let tree = ProcessTree::from_group(pid as i32);
            #[cfg(windows)]
            let tree = ProcessTree::from_pid(pid);
            tree.kill();
        }
    }
}

async fn wait_for_file(path: &Path) -> String {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(path)
                && !text.is_empty()
            {
                return text;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("fixture started")
}

#[tokio::test]
async fn parent_eof_during_provisioning_stops_without_readiness_and_removes_staging() {
    let dir = TempDir::new();
    let bin = dir.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let git = bin.join(if cfg!(windows) { "git.exe" } else { "git" });
    let status = std::process::Command::new("rustc")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stalled_git.rs"))
        .arg("-o")
        .arg(&git)
        .status()
        .expect("compile fixture with workspace toolchain");
    assert!(status.success());
    let record = GitFixture(dir.path().join("git-record"));
    let data = dir.path().join("data");
    let paths = std::iter::once(bin)
        .chain(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ))
        .collect::<Vec<_>>();
    let mut command = Command::new(env!("CARGO_BIN_EXE_orbynd"));
    command
        .args(["serve", "--parent-stdin", "--data-dir"])
        .arg(&data)
        .env("ORBYN_OFFLINE", "1")
        .env_remove("ORBYN_LIBRARY_BUNDLE")
        .env("PATH", std::env::join_paths(paths).unwrap())
        .env("ORBYN_TEST_GIT_RECORD", &record.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut daemon = ManagedChild::spawn(command).unwrap();
    let leader = wait_for_file(&record.0.with_extension("leader")).await;
    let helper = wait_for_file(&record.0.with_extension("helper")).await;
    for address in [&leader, &helper] {
        assert!(
            std::net::TcpStream::connect_timeout(
                &address.parse().unwrap(),
                Duration::from_millis(50)
            )
            .is_ok()
        );
    }
    assert!(!data.join("service.json").exists());
    drop(daemon.child_mut().stdin.take());
    let status = tokio::time::timeout(Duration::from_secs(5), daemon.wait())
        .await
        .expect("pre-ready EOF must stop the daemon")
        .unwrap();
    assert!(status.success());
    let mut stdout = String::new();
    tokio::time::timeout(
        Duration::from_secs(3),
        daemon
            .child_mut()
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut stdout),
    )
    .await
    .expect("cancelled Git must release its inherited output pipes")
    .unwrap();
    assert!(
        stdout.is_empty(),
        "cancelled startup must not announce readiness"
    );
    assert!(!data.join("service.json").exists());
    assert!(!std::fs::read_dir(&data).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".workspace-")
    }));
    tokio::time::timeout(Duration::from_secs(3), async {
        while [&leader, &helper].iter().any(|address| {
            std::net::TcpStream::connect_timeout(
                &address.parse().unwrap(),
                Duration::from_millis(50),
            )
            .is_ok()
        }) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Git leader and descendant must stop");
    // Cancellation releases the data directory too; the next normal owner works.
    let restarted = Service::start(&data, Options::default());
    assert!(restarted.json("/api/info").await.is_object());
}

#[tokio::test]
async fn parent_link_still_allows_normal_startup_and_shutdown() {
    let dir = TempDir::new();
    let data = dir.path().join("data");
    let mut service = Service::start(
        &data,
        Options {
            args: vec!["--parent-stdin".into()],
            ..Options::default()
        },
    );
    assert_eq!(
        service.json("/api/info").await["version"],
        env!("CARGO_PKG_VERSION")
    );
    drop(service.child.stdin.take());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(status) = service.child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("normal shutdown");
    assert!(!data.join("service.json").exists());
}
