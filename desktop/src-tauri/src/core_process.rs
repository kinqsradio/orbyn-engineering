//! Owns the `orbynd` child. Its stdin is the lifetime link: `--parent-stdin`
//! makes the service exit when this process dies, even after a crash.

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
        let mut command = Command::new(sidecar_path()?);
        command
            .arg("serve")
            .arg("--parent-stdin")
            .arg("--ui-dir")
            .arg(resources.join("ui"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot start the local service: {error}."))?;
        let stdin = child.stdin.take().ok_or("The service has no input pipe.")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("The service has no output pipe.")?;

        let (sender, receiver) = std::sync::mpsc::channel();
        let child = Arc::new(std::sync::Mutex::new(child));
        let stopping = Arc::new(AtomicBool::new(false));
        let watched = child.clone();
        let stop_flag = stopping.clone();
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
                on_exit(format!("Exit status: {status}."));
            }
        });

        let line = receiver
            .recv_timeout(START_TIMEOUT)
            .map_err(|_| "The local service did not start in time.".to_string())?;
        let ready: Ready = serde_json::from_str(&line)
            .map_err(|_| "The local service sent an unexpected start message.".to_string())?;
        let mut app_url = url::Url::parse(&ready.url)
            .map_err(|_| "The local service sent an invalid address.".to_string())?;
        app_url.query_pairs_mut().append_pair("token", &ready.token);
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
        let child = self.child;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(5));
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        });
    }
}
