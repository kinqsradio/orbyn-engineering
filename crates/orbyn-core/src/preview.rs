//! The page a person watches beside a thread, and the servers a thread started. A
//! tab is a headless Chrome of its own, on a profile of its own, separate from the
//! governed browser agents use. Frames are polled and go out only while someone
//! watches or records. This is local: a client watches over the same access as the
//! rest of the API, and nothing here reaches another machine.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orbyn_contracts::{LocalServer, PreviewInput, PreviewRecording, PreviewTab};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tokio::process::Command;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use crate::app::Core;
use crate::computer::cdp::{
    BrowserSession, HistoryState, LaunchOptions, find_browser, normalize_url,
};
use crate::error::{CoreError, Result};
use crate::store::AuditRecord;
use crate::util::new_id;

const MAX_TABS: usize = 4;
const FRAME_EVERY: Duration = Duration::from_millis(200);
const FRAME_QUALITY: u32 = 60;
const DEFAULT_SIZE: (u32, u32) = (1280, 800);
const CLI_TIMEOUT: Duration = Duration::from_secs(5);
const PROFILE_GRACE: Duration = Duration::from_millis(500);
/// Bounds a page's size, which sets how much memory each frame takes.
const SIZES: std::ops::RangeInclusive<u32> = 100..=4096;
/// How many frame ticks pass between looks at history, about one a second. A link
/// clicked in the page changes it with nobody telling this side.
const HISTORY_TICKS: u32 = 5;

struct Recording {
    folder: PathBuf,
    frames: Arc<AtomicU64>,
}

struct Tab {
    info: Mutex<PreviewTab>,
    session: tokio::sync::Mutex<BrowserSession>,
    frames: broadcast::Sender<Arc<str>>,
    recording: Mutex<Option<Recording>>,
    stop: CancellationToken,
    profile: PathBuf,
}

#[derive(Default)]
pub struct PreviewManager {
    tabs: Mutex<HashMap<String, Arc<Tab>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Tab {
    fn view(&self) -> PreviewTab {
        let mut info = lock(&self.info).clone();
        info.viewers = self.frames.receiver_count();
        info.recording = lock(&self.recording).is_some();
        info
    }

    fn note_history(&self, history: &HistoryState) {
        let mut info = lock(&self.info);
        if !history.url.is_empty() {
            history.url.clone_into(&mut info.url);
        }
        info.can_go_back = history.can_go_back;
        info.can_go_forward = history.can_go_forward;
    }
}

fn check_size(width: u32, height: u32) -> Result<()> {
    if SIZES.contains(&width) && SIZES.contains(&height) {
        return Ok(());
    }
    Err(CoreError::Invalid(format!(
        "A preview is {} to {} pixels each way.",
        SIZES.start(),
        SIZES.end()
    )))
}

fn decode_base64(text: &str) -> Vec<u8> {
    let value = |byte: u8| match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut bits, mut count) = (0u32, 0u8);
    for six in text.bytes().filter_map(value) {
        bits = (bits << 6) | u32::from(six);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    out
}

/// Polls frames while anyone wants them. A page that did not change sends nothing,
/// and a tab that stops answering just skips that frame.
async fn pump(tab: Arc<Tab>) {
    let mut last = Vec::new();
    let mut ticks = tokio::time::interval(FRAME_EVERY);
    let mut since_history = 0;
    loop {
        tokio::select! {
            () = tab.stop.cancelled() => {
                // Dropping the last handle ends the browser; only then is its
                // profile finished with.
                let profile = tab.profile.clone();
                drop(tab);
                tokio::time::sleep(PROFILE_GRACE).await;
                let _ = std::fs::remove_dir_all(profile);
                return;
            }
            _ = ticks.tick() => {}
        }
        let recording = lock(&tab.recording)
            .as_ref()
            .map(|rec| (rec.folder.clone(), rec.frames.clone()));
        if tab.frames.receiver_count() == 0 && recording.is_none() {
            continue;
        }
        since_history += 1;
        if since_history >= HISTORY_TICKS {
            since_history = 0;
            if let Ok(history) = tab.session.lock().await.history().await {
                tab.note_history(&history);
            }
        }
        let Ok(frame) = tab.session.lock().await.frame(FRAME_QUALITY).await else {
            continue;
        };
        let digest = Sha256::digest(frame.as_bytes()).to_vec();
        if digest == last {
            continue;
        }
        last = digest;
        if let Some((folder, count)) = recording {
            let index = count.fetch_add(1, Ordering::Relaxed);
            let path = folder.join(format!("{index:06}.jpg"));
            if let Err(error) = std::fs::write(path, decode_base64(&frame)) {
                tracing::warn!(%error, "could not keep a recorded frame");
            }
        }
        let _ = tab.frames.send(Arc::from(frame));
    }
}

impl PreviewManager {
    fn tab(&self, thread_id: &str, id: &str) -> Result<Arc<Tab>> {
        lock(&self.tabs)
            .get(id)
            .filter(|tab| lock(&tab.info).thread_id == thread_id)
            .cloned()
            .ok_or_else(|| CoreError::NotFound("preview".into()))
    }

    pub fn list(&self, thread_id: &str) -> Vec<PreviewTab> {
        lock(&self.tabs)
            .values()
            .map(|tab| tab.view())
            .filter(|tab| tab.thread_id == thread_id)
            .collect()
    }

    /// Everything a new viewer needs: the stream of frames.
    pub fn subscribe(&self, thread_id: &str, id: &str) -> Result<broadcast::Receiver<Arc<str>>> {
        Ok(self.tab(thread_id, id)?.frames.subscribe())
    }

    /// Takes the page or hands it back.
    pub fn set_control(&self, thread_id: &str, id: &str, human: bool) -> Result<PreviewTab> {
        let tab = self.tab(thread_id, id)?;
        let word = if human { "human" } else { "none" };
        word.clone_into(&mut lock(&tab.info).control);
        Ok(tab.view())
    }

    pub async fn navigate(&self, thread_id: &str, id: &str, url: &str) -> Result<PreviewTab> {
        let url = normalize_url(url)?;
        let tab = self.tab(thread_id, id)?;
        let mut session = tab.session.lock().await;
        session.navigate(&url).await?;
        let history = session.history().await?;
        drop(session);
        lock(&tab.info).url = url;
        tab.note_history(&history);
        Ok(tab.view())
    }

    /// One page back or forward. At either end this changes nothing.
    pub async fn step(&self, thread_id: &str, id: &str, back: bool) -> Result<PreviewTab> {
        let tab = self.tab(thread_id, id)?;
        let history = tab.session.lock().await.step_history(back).await?;
        tab.note_history(&history);
        Ok(tab.view())
    }

    pub async fn resize(
        &self,
        thread_id: &str,
        id: &str,
        width: u32,
        height: u32,
    ) -> Result<PreviewTab> {
        check_size(width, height)?;
        let tab = self.tab(thread_id, id)?;
        tab.session.lock().await.set_viewport(width, height).await?;
        {
            let mut info = lock(&tab.info);
            info.width = width;
            info.height = height;
        }
        Ok(tab.view())
    }

    /// A person's input, which needs them to hold the page, so a watcher cannot
    /// type into it by accident.
    pub async fn input(&self, thread_id: &str, id: &str, input: &PreviewInput) -> Result<()> {
        let tab = self.tab(thread_id, id)?;
        if lock(&tab.info).control != "human" {
            return Err(CoreError::Invalid(
                "Take control of this page first.".into(),
            ));
        }
        let mut session = tab.session.lock().await;
        let mouse = |kind: &str, buttons: u32, count: u32| {
            json!({
                "type": kind, "x": input.x, "y": input.y, "button": "left",
                "buttons": buttons, "clickCount": count,
            })
        };
        match input.kind.as_str() {
            "move" => {
                session
                    .input("Input.dispatchMouseEvent", mouse("mouseMoved", 0, 0))
                    .await
            }
            "click" => {
                session
                    .input("Input.dispatchMouseEvent", mouse("mousePressed", 1, 1))
                    .await?;
                session
                    .input("Input.dispatchMouseEvent", mouse("mouseReleased", 0, 1))
                    .await
            }
            "scroll" => {
                session
                    .input(
                        "Input.dispatchMouseEvent",
                        json!({
                            "type": "mouseWheel", "x": input.x, "y": input.y,
                            "deltaX": 0, "deltaY": input.delta_y,
                        }),
                    )
                    .await
            }
            "text" => {
                session
                    .input("Input.insertText", json!({ "text": input.text }))
                    .await
            }
            "key" => {
                for kind in ["keyDown", "keyUp"] {
                    session
                        .input(
                            "Input.dispatchKeyEvent",
                            json!({ "type": kind, "key": input.text, "code": input.text }),
                        )
                        .await?;
                }
                Ok(())
            }
            _ => Err(CoreError::Invalid("Unknown input.".into())),
        }
    }

    pub fn start_recording(&self, thread_id: &str, id: &str, folder: PathBuf) -> Result<()> {
        let tab = self.tab(thread_id, id)?;
        let mut recording = lock(&tab.recording);
        if recording.is_some() {
            return Err(CoreError::Invalid("This page is already recording.".into()));
        }
        std::fs::create_dir_all(&folder)?;
        *recording = Some(Recording {
            folder,
            frames: Arc::default(),
        });
        Ok(())
    }

    pub fn stop_recording(&self, thread_id: &str, id: &str) -> Result<PreviewRecording> {
        let tab = self.tab(thread_id, id)?;
        let finished = lock(&tab.recording)
            .take()
            .ok_or_else(|| CoreError::Invalid("This page is not recording.".into()))?;
        Ok(PreviewRecording {
            path: finished.folder.to_string_lossy().into_owned(),
            frames: finished.frames.load(Ordering::Relaxed),
        })
    }

    /// Ends a tab, its browser and its profile.
    pub fn close(&self, thread_id: &str, id: &str) -> Result<()> {
        self.tab(thread_id, id)?;
        if let Some(tab) = lock(&self.tabs).remove(id) {
            forget(&tab);
        }
        Ok(())
    }

    /// Ends every tab of a thread.
    pub fn close_thread(&self, thread_id: &str) {
        lock(&self.tabs).retain(|_, tab| {
            let keep = lock(&tab.info).thread_id != thread_id;
            if !keep {
                forget(tab);
            }
            keep
        });
    }

    pub fn close_all(&self) {
        for (_, tab) in lock(&self.tabs).drain() {
            forget(&tab);
        }
    }
}

/// Stops the pump, which holds the last handle and clears up after the browser.
fn forget(tab: &Tab) {
    tab.stop.cancel();
}

impl Core {
    /// Opens a page. It needs a trusted folder because the usual target is a server
    /// that folder's code is running, and a browser that Orbyn can find.
    pub async fn open_preview(
        &self,
        thread_id: &str,
        url: &str,
        size: (Option<u32>, Option<u32>),
        actor: &str,
    ) -> Result<PreviewTab> {
        let thread = self.store.thread(thread_id)?;
        if !self.store.project(&thread.project_id)?.trusted {
            return Err(CoreError::FolderUntrusted);
        }
        let url = normalize_url(url)?;
        let (width, height) = (
            size.0.unwrap_or(DEFAULT_SIZE.0),
            size.1.unwrap_or(DEFAULT_SIZE.1),
        );
        check_size(width, height)?;
        if lock(&self.previews.tabs).len() >= MAX_TABS {
            return Err(CoreError::Invalid(format!(
                "Close a preview first: {MAX_TABS} can be open at once."
            )));
        }
        let browser = self
            .config
            .browser_path
            .clone()
            .or_else(find_browser)
            .ok_or_else(|| CoreError::Unsupported("Install Chrome to use the preview.".into()))?;
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: "preview.open".into(),
            target: url.clone(),
            decision: None,
            source: "user".into(),
            thread_id: Some(thread_id.to_owned()),
            run_id: None,
            detail: Value::Null,
        })?;
        let id = new_id();
        let profile = self.config.data_dir.join("preview-profiles").join(&id);
        let options = LaunchOptions {
            headless: true,
            in_process_gpu: self.config.browser_in_process_gpu,
        };
        let mut session = BrowserSession::launch(&browser, &profile, options).await?;
        session.set_viewport(width, height).await?;
        session.navigate(&url).await?;
        let (frames, _) = broadcast::channel(8);
        let tab = Arc::new(Tab {
            info: Mutex::new(PreviewTab {
                id: id.clone(),
                thread_id: thread_id.to_owned(),
                url,
                control: "none".to_owned(),
                recording: false,
                viewers: 0,
                width,
                height,
                can_go_back: false,
                can_go_forward: false,
            }),
            session: tokio::sync::Mutex::new(session),
            frames,
            recording: Mutex::new(None),
            stop: CancellationToken::new(),
            profile,
        });
        lock(&self.previews.tabs).insert(id, tab.clone());
        let view = tab.view();
        tokio::spawn(pump(tab));
        Ok(view)
    }

    pub fn start_preview_recording(&self, thread_id: &str, id: &str) -> Result<()> {
        let folder = self
            .config
            .data_dir
            .join("browser-artifacts")
            .join(format!("{id}-{}", new_id()));
        self.previews.start_recording(thread_id, id, folder)
    }

    /// Servers listening from this thread's checkout. Where a process's folder
    /// cannot be read, every loopback listener is shown and marked as such.
    pub async fn local_servers(&self, thread_id: &str) -> Result<Vec<LocalServer>> {
        let thread = self.store.thread(thread_id)?;
        let checkout = crate::util::canonicalize(Path::new(&thread.cwd))?;
        Ok(listeners(&checkout).await)
    }

    /// Stops a server, only one this thread's checkout is running.
    pub async fn stop_server(&self, thread_id: &str, pid: u32, actor: &str) -> Result<()> {
        let servers = self.local_servers(thread_id).await?;
        if !servers
            .iter()
            .any(|server| server.pid == pid && server.in_checkout)
        {
            return Err(CoreError::NotFound("server".into()));
        }
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: "server.stop".into(),
            target: pid.to_string(),
            decision: None,
            source: "user".into(),
            thread_id: Some(thread_id.to_owned()),
            run_id: None,
            detail: Value::Null,
        })?;
        let pid = pid.to_string();
        let (program, args): (&str, Vec<&str>) = if cfg!(windows) {
            // A server has no window to ask politely, and its children hold the port.
            ("taskkill", vec!["/PID", &pid, "/T", "/F"])
        } else {
            ("kill", vec![&pid])
        };
        let status = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await?;
        if status.success() {
            Ok(())
        } else {
            Err(CoreError::Internal("The server did not stop.".into()))
        }
    }
}

async fn output(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    crate::child_env::for_tool(command.as_std_mut());
    let run = command.output();
    let done = tokio::time::timeout(CLI_TIMEOUT, run).await.ok()?.ok()?;
    Some(String::from_utf8_lossy(&done.stdout).into_owned())
}

/// `lsof -F` output: `p<pid>`, `c<command>`, `n<address>` lines.
fn parse_lsof(text: &str) -> Vec<(u32, String, u16)> {
    let mut found: Vec<(u32, String, u16)> = Vec::new();
    let (mut pid, mut name) = (0, String::new());
    for line in text.lines() {
        match line.split_at_checked(1) {
            Some(("p", rest)) => pid = rest.parse().unwrap_or(0),
            Some(("c", rest)) => rest.clone_into(&mut name),
            Some(("n", rest)) => {
                if let Some(port) = rest.rsplit(':').next().and_then(|port| port.parse().ok())
                    && !found.iter().any(|known| known.0 == pid && known.2 == port)
                {
                    found.push((pid, name.clone(), port));
                }
            }
            _ => {}
        }
    }
    found
}

/// Lists TCP listeners as JSON. Arguments, not a command line, and no profile runs.
const WINDOWS_LISTENERS: &[&str] = &[
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ \
     address = $_.LocalAddress; port = $_.LocalPort; pid = $_.OwningProcess; \
     process = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName \
     } } | ConvertTo-Json -Compress",
];

/// The output of `WINDOWS_LISTENERS`, which is an object for one row and a list for
/// more. Only loopback and wildcard addresses count, each port once.
fn parse_windows_listeners(text: &str) -> Vec<(u32, String, u16)> {
    let Ok(parsed) = serde_json::from_str::<Value>(text.trim()) else {
        return Vec::new();
    };
    let rows = match parsed {
        Value::Array(rows) => rows,
        row @ Value::Object(_) => vec![row],
        _ => Vec::new(),
    };
    let mut found: Vec<(u32, String, u16)> = Vec::new();
    for row in rows {
        let address = row.get("address").and_then(Value::as_str).unwrap_or("");
        if !["127.0.0.1", "::1", "0.0.0.0", "::"].contains(&address) {
            continue;
        }
        let number = |key: &str| row.get(key).and_then(Value::as_u64);
        let (Some(port), Some(pid)) = (number("port"), number("pid")) else {
            continue;
        };
        let (Ok(port), Ok(pid)) = (u16::try_from(port), u32::try_from(pid)) else {
            continue;
        };
        if !found.iter().any(|(_, _, seen)| *seen == port) {
            let process = row.get("process").and_then(Value::as_str).unwrap_or("");
            found.push((pid, process.to_owned(), port));
        }
    }
    found
}

/// `netstat -ano` lines for loopback or wildcard listeners.
fn parse_netstat(text: &str) -> Vec<(u32, String, u16)> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let [protocol, local, _, state, pid] = fields[..] else {
                return None;
            };
            if protocol != "TCP" || state != "LISTENING" {
                return None;
            }
            let port = local.rsplit(':').next()?.parse().ok()?;
            Some((pid.parse().ok()?, String::new(), port))
        })
        .collect()
}

/// The folder a process runs in, or `None` where the OS won't say, as for another
/// user's process.
fn process_folder(pid: u32) -> Option<PathBuf> {
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
    );
    system.process(pid)?.cwd().map(Path::to_path_buf)
}

/// Whether a process runs from the checkout, and `None` where that can't be known.
fn in_folder(pid: u32, checkout: &Path) -> Option<bool> {
    let folder = process_folder(pid)?;
    let folder = crate::util::canonicalize(&folder).ok()?;
    Some(folder.starts_with(checkout))
}

async fn listeners(checkout: &Path) -> Vec<LocalServer> {
    if cfg!(windows) {
        // PowerShell also names the process; `netstat` is here for when it cannot run.
        let found = match output("powershell.exe", WINDOWS_LISTENERS).await {
            Some(text) if !text.trim().is_empty() => parse_windows_listeners(&text),
            _ => Vec::new(),
        };
        let found = if found.is_empty() {
            let text = output("netstat", &["-ano", "-p", "TCP"])
                .await
                .unwrap_or_default();
            parse_netstat(&text)
        } else {
            found
        };
        // A service of the system won't name its folder, so it shows and can't be
        // stopped. One that does name a folder elsewhere is another project's.
        return found
            .into_iter()
            .filter_map(|(pid, process, port)| {
                let in_checkout = in_folder(pid, checkout);
                (in_checkout != Some(false)).then_some(LocalServer {
                    port,
                    pid,
                    process,
                    in_checkout: in_checkout == Some(true),
                })
            })
            .collect();
    }
    let text = output("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
        .await
        .unwrap_or_default();
    let mut servers = Vec::new();
    for (pid, process, port) in parse_lsof(&text) {
        if in_folder(pid, checkout) == Some(true) {
            servers.push(LocalServer {
                port,
                pid,
                process,
                in_checkout: true,
            });
        }
    }
    servers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_listeners_keep_local_ones_once_and_survive_bad_output() {
        let rows = r#"[
            {"address":"127.0.0.1","port":3000,"pid":10,"process":"node"},
            {"address":"::1","port":3000,"pid":10,"process":"node"},
            {"address":"192.168.1.4","port":22,"pid":11,"process":"ssh"},
            {"address":"0.0.0.0","port":99999,"pid":12,"process":"bad"},
            {"address":"::","port":5173,"pid":13,"process":null}
        ]"#;
        assert_eq!(
            parse_windows_listeners(rows),
            vec![(10, "node".to_owned(), 3000), (13, String::new(), 5173)]
        );
        let one = r#"{"address":"127.0.0.1","port":80,"pid":1,"process":"x"}"#;
        assert_eq!(parse_windows_listeners(one).len(), 1);
        assert!(parse_windows_listeners("Access denied").is_empty());
    }

    #[test]
    fn a_process_folder_is_read_on_this_platform() {
        let here = crate::util::canonicalize(&std::env::current_dir().unwrap()).unwrap();
        assert_eq!(in_folder(std::process::id(), &here), Some(true));
        let other = here.join("not-the-checkout");
        assert_eq!(in_folder(std::process::id(), &other), Some(false));
        assert_eq!(in_folder(u32::MAX - 1, &here), None);
    }

    #[test]
    fn base64_round_trips_jpeg_bytes() {
        assert_eq!(decode_base64("Zm9vYmFy"), b"foobar");
        assert_eq!(decode_base64("Zm8="), b"fo");
        assert_eq!(decode_base64("/9j/"), [0xff, 0xd8, 0xff]);
    }

    #[test]
    fn listeners_are_read_from_each_tool() {
        let lsof = "p12\ncnode\nf20\nn*:3000\nf21\nn[::1]:3000\np30\ncvite\nf1\nn127.0.0.1:5173\n";
        assert_eq!(
            parse_lsof(lsof),
            [(12, "node".to_owned(), 3000), (30, "vite".to_owned(), 5173)]
        );
        let netstat = "  TCP    127.0.0.1:8080   0.0.0.0:0   LISTENING   4242\n\
                       TCP    10.0.0.1:50000   1.2.3.4:443   ESTABLISHED   7\n";
        assert_eq!(parse_netstat(netstat), [(4242, String::new(), 8080)]);
    }
}
