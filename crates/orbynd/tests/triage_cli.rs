//! No installed provider is discovered or invoked by these tests.
mod support;

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use support::TempDir;
use tokio::io::AsyncWriteExt;

#[path = "support/cli_capture.rs"]
#[allow(dead_code)]
mod capture;

const ORBYN: &str = env!("CARGO_BIN_EXE_orbyn");

fn command(root: &Path) -> Command {
    let mut command = Command::new(ORBYN);
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    command
        .arg("--data-dir")
        .arg(root.join("data"))
        .env("ORBYN_CLAUDE_BIN", root.join("missing-claude"))
        .env("ORBYN_CODEX_BIN", root.join("missing-codex"))
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("APPDATA", &home)
        .env("LOCALAPPDATA", &home)
        .env("XDG_CONFIG_HOME", &home)
        .env("XDG_DATA_HOME", &home)
        .env_remove("N_PREFIX")
        .env_remove("NVM_SYMLINK")
        .env_remove("NPM_CONFIG_PREFIX");
    command
}

#[test]
fn help_and_manual_fallback_need_no_service_or_provider() {
    let dir = TempDir::new();
    let mut help = command(dir.path());
    help.args(["triage", "--help"]);
    let output = capture::capture(help, Duration::from_secs(15)).unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    for item in ["--agent", "claude", "codex", "--model"] {
        assert!(text.contains(item), "{text}");
    }
    assert!(!dir.path().join("data").exists());
    let mut manual = command(dir.path());
    manual.arg("triage");
    let output = capture::capture(manual, Duration::from_secs(15)).unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("Paste"));
    let sessions = std::fs::read_dir(dir.path().join("data/triage")).unwrap();
    let paths: Vec<_> = sessions.map(|entry| entry.unwrap().path()).collect();
    assert_eq!(paths.len(), 1);
    assert!(paths[0].join("prompt.md").is_file());
    assert!(paths[0].join("context.md").is_file());
    assert!(!dir.path().join("data/service.json").exists());

    let mut missing = command(dir.path());
    missing.args(["triage", "--agent", "claude"]);
    let output = capture::capture(missing, Duration::from_secs(15)).unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("claude was not found"));
}

#[tokio::test]
async fn native_double_gets_literal_arguments_cwd_streams_and_exit_codes() {
    let dir = TempDir::new();
    let fixture = dir.path().join(if cfg!(windows) {
        "provider-double.exe"
    } else {
        "provider-double"
    });
    let mut compiler = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()));
    compiler
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/triage_child.rs"))
        .args(["--crate-name", "triage_child", "-C", "debuginfo=0"])
        .arg("-o")
        .arg(&fixture);
    let output =
        tokio::task::spawn_blocking(move || capture::capture(compiler, Duration::from_secs(60)))
            .await
            .unwrap()
            .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    #[cfg(windows)]
    let launcher = {
        let shim = dir.path().join("native-shim.cmd");
        std::fs::write(&shim, "@echo off\r\n\"%~dp0\\provider-double.exe\" %*\r\n").unwrap();
        shim
    };
    #[cfg(not(windows))]
    let launcher = fixture.clone();

    let cases = [
        ("claude", 0, true, true),
        ("codex", 7, true, true),
        ("codex", 0, false, false),
    ];
    #[cfg(windows)]
    let cases = cases
        .into_iter()
        .chain([("claude", 257, true, true), ("codex", -1, true, true)]);
    for (agent, code, explicit, with_model) in cases {
        let record = dir.path().join(format!("{agent}-record"));
        let mut cmd = command(dir.path());
        cmd.arg("triage");
        if explicit {
            cmd.args(["--agent", agent]);
            cmd.current_dir(dir.path()).env(
                "ORBYN_CLAUDE_BIN",
                Path::new(".").join(fixture.file_name().unwrap()),
            );
        }
        if with_model {
            cmd.args(["--model", "space % & \" \\ 模型"]);
        }
        cmd.env("ORBYN_CODEX_BIN", &launcher)
            .env("TRIAGE_TEST_RECORD", &record)
            .env("TRIAGE_TEST_EXIT", code.to_string());
        let mut cmd = tokio::process::Command::from(cmd);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"synthetic input")
            .await
            .unwrap();
        let output = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
            .await
            .expect("fixture deadline")
            .unwrap();
        assert_eq!(output.status.code(), Some(code));
        assert!(String::from_utf8_lossy(&output.stdout).contains("fixture-out:synthetic input"));
        assert!(String::from_utf8_lossy(&output.stderr).contains("fixture-err:synthetic input"));
        let record = std::fs::read_to_string(record).unwrap();
        let lines: Vec<_> = record.lines().collect();
        if with_model {
            assert_eq!(lines.len(), 4, "{record}");
            assert_eq!(lines[1], "arg=--model");
            assert_eq!(lines[2], "arg=space % & \" \\ 模型");
        } else {
            assert_eq!(lines.len(), 2, "{record}");
        }
        assert!(lines.last().unwrap().starts_with("arg=Read prompt.md"));
        let cwd = Path::new(lines[0].strip_prefix("cwd=").unwrap());
        assert_eq!(cwd.parent().unwrap(), dir.path().join("data/triage"));
        assert!(cwd.join("prompt.md").is_file());
        assert!(cwd.join("context.md").is_file());
    }

    let mut both = command(dir.path());
    both.arg("triage")
        .env("ORBYN_CLAUDE_BIN", &fixture)
        .env("ORBYN_CODEX_BIN", &fixture);
    let output =
        tokio::task::spawn_blocking(move || capture::capture(both, Duration::from_secs(15)))
            .await
            .unwrap()
            .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Use --agent"));

    let invalid = dir.path().join(if cfg!(windows) {
        "bad-wrapper.cmd"
    } else {
        "invalid-executable"
    });
    std::fs::write(&invalid, "this is not a runnable provider").unwrap();
    let mut broken = command(dir.path());
    broken
        .args(["triage", "--agent", "claude"])
        .env("ORBYN_CLAUDE_BIN", invalid);
    let output =
        tokio::task::spawn_blocking(move || capture::capture(broken, Duration::from_secs(15)))
            .await
            .unwrap()
            .unwrap();
    assert!(!output.status.success());
    #[cfg(windows)]
    assert!(String::from_utf8_lossy(&output.stderr).contains("launcher is unsupported"));
    #[cfg(not(windows))]
    assert!(String::from_utf8_lossy(&output.stderr).contains("Could not start claude"));
}
