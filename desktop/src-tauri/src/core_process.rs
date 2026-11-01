//! Owns the `orbynd` child. Its stdin is the lifetime link: `--parent-stdin`
//! makes the service exit when this process dies, even after a crash.

mod child_owner;

use child_owner::{StartupGuard, reap_after_grace};
use serde::Deserialize;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const START_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Deserialize)]
struct Ready {
    url: String,
    token: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServiceMessage {
    CheckAppUpdate,
    InstallAppUpdate,
    ShellAction { action: ShellAction },
    Activity(Activity),
}

/// Running work, and whether the machine should stay awake for it.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
pub struct Activity {
    pub running: u32,
    pub waiting: u32,
    pub keep_awake: bool,
}

/// The closed list in `ShellAction` on the service's side. A newer one is ignored.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ShellAction {
    ZoomIn,
    ZoomOut,
    ZoomReset,
    InstallCli,
    RemoveCli,
    OpenAccessibilitySettings,
    OpenScreenRecordingSettings,
}

pub struct CoreProcess {
    stdin: std::sync::Mutex<ChildStdin>,
    child: Arc<std::sync::Mutex<Child>>,
    stopping: Arc<AtomicBool>,
    app_url: url::Url,
}

fn sidecar_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("Cannot find the app: {error}."))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "Cannot find the app folder.".to_string())?;
    let name = if cfg!(windows) {
        "orbynd.exe"
    } else {
        "orbynd"
    };
    Ok(dir.join(name))
}

fn service_log(app: &AppHandle) -> Result<PathBuf, String> {
    let folder = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Cannot find the log folder: {error}."))?;
    std::fs::create_dir_all(&folder)
        .map_err(|error| format!("Cannot make the log folder: {error}."))?;
    Ok(folder.join("orbynd.log"))
}

fn last_line(log: &std::path::Path) -> String {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    text.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .to_owned()
}

/// What a person is told, with the service's last words if it had any. Its log lines
/// carry a timestamp and level, which mean nothing here.
fn failure_text(status: &str, said: &str) -> String {
    let said = said.rsplit("  ").next().unwrap_or(said).trim();
    if said.is_empty() {
        format!("It ended with {status}.")
    } else {
        format!("{said} ({status})")
    }
}

impl CoreProcess {
    pub fn start(
        app: &AppHandle,
        on_message: impl Fn(ServiceMessage) + Send + 'static,
        on_exit: impl FnOnce(String) + Send + 'static,
    ) -> Result<Self, String> {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|error| format!("Cannot find app resources: {error}."))?;
        // A file, not a pipe: the service must be able to log its own shutdown after
        // this process is gone, and a write to a dead pipe would stop it halfway.
        let log = service_log(app)?;
        let stderr = std::fs::File::create(&log)
            .map_err(|error| format!("Cannot write the service log: {error}."))?;
        let mut command = Command::new(sidecar_path()?);
        command
            .arg("serve")
            .arg("--parent-stdin")
            .arg("--ui-dir")
            .arg(resources.join("ui"))
            .arg("--library-bundle")
            .arg(resources.join("library"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .env("NO_COLOR", "1");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("Cannot start the local service: {error}."))?;
        let child = Arc::new(std::sync::Mutex::new(child));
        let stopping = Arc::new(AtomicBool::new(false));
        // Declared before stdin: every early return closes the parent pipe before
        // the guard starts bounded cleanup, including timeout and malformed ready.
        let mut startup = StartupGuard::new(child.clone(), stopping.clone());
        let stdin = child
            .lock()
            .expect("core child")
            .stdin
            .take()
            .ok_or("The service has no input pipe.")?;
        let stdout = child
            .lock()
            .expect("core child")
            .stdout
            .take()
            .ok_or("The service has no output pipe.")?;

        let (sender, receiver) = std::sync::mpsc::channel();
        let watched = child.clone();
        let stop_flag = stopping.clone();
        let watched_log = log.clone();
        std::thread::spawn(move || {
            let mut lines = BufReader::new(stdout).lines();
            let first = lines.next().and_then(Result::ok).unwrap_or_default();
            let _ = sender.send(first);
            for line in lines.by_ref().map_while(Result::ok) {
                // Unknown lines are ignored so newer services can add messages.
                if let Ok(message) = serde_json::from_str::<ServiceMessage>(&line) {
                    on_message(message);
                }
            }
            // Poll so `stop` can still take the lock and force a kill.
            let status = loop {
                match watched.lock().expect("core child").try_wait() {
                    Ok(Some(status)) => break status.to_string(),
                    Ok(None) => {}
                    Err(_) => break "unknown".to_string(),
                }
                std::thread::sleep(Duration::from_millis(200));
            };
            if !stop_flag.load(Ordering::SeqCst) {
                on_exit(failure_text(&status, &last_line(&watched_log)));
            }
        });

        let line = receiver
            .recv_timeout(START_TIMEOUT)
            .map_err(|_| "The local service did not start in time.".to_string())?;
        let ready: Ready = serde_json::from_str(&line)
            .map_err(|_| failure_text("no start message", &last_line(&log)))?;
        let mut app_url = url::Url::parse(&ready.url)
            .map_err(|_| "The local service sent an invalid address.".to_string())?;
        app_url.query_pairs_mut().append_pair("token", &ready.token);
        startup.disarm();
        Ok(Self {
            stdin: std::sync::Mutex::new(stdin),
            child,
            stopping,
            app_url,
        })
    }

    pub fn app_url(&self) -> url::Url {
        self.app_url.clone()
    }

    /// Sends one newline-delimited JSON message to the service.
    pub fn send(&self, message: &serde_json::Value) {
        if let Ok(mut stdin) = self.stdin.lock() {
            let _ = writeln!(stdin, "{message}");
            let _ = stdin.flush();
        }
    }

    /// Closing stdin asks the service to shut down cleanly and stop its engines.
    pub fn stop(self) {
        self.stopping.store(true, Ordering::SeqCst);
        drop(self.stdin);
        reap_after_grace(self.child);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_says_what_the_service_said() {
        assert_eq!(failure_text("exit 1", ""), "It ended with exit 1.");
        assert_eq!(
            failure_text("exit 1", "Another service holds this folder."),
            "Another service holds this folder. (exit 1)"
        );
        assert_eq!(
            failure_text("exit 1", "2026-10-31T20:06:16Z  INFO orbynd: stopping"),
            "INFO orbynd: stopping (exit 1)"
        );
    }
}
