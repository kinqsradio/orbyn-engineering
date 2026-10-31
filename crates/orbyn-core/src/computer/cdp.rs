//! Chrome DevTools Protocol against an installed Chrome or Edge, using a
//! dedicated profile directory so the user's own browser data is never touched.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use crate::error::{CoreError, Result};
use crate::process::ManagedChild;

const START_TIMEOUT: Duration = Duration::from_secs(20);
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
/// A step in history is usually instant, and a same-page entry fires no load at all.
const HISTORY_LOAD_TIMEOUT: Duration = Duration::from_secs(5);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn failed(text: impl std::fmt::Display) -> CoreError {
    CoreError::Computer(format!("Browser control failed: {text}"))
}

/// Only web pages can be opened. `file:`, `chrome:` and `javascript:` cannot.
pub fn normalize_url(input: &str) -> Result<String> {
    let trimmed = input.trim();
    let invalid = || CoreError::Invalid(format!("{trimmed} is not an http or https URL."));
    let (scheme, rest) = trimmed.split_once("://").ok_or_else(invalid)?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(invalid());
    }
    let (host, path) = match rest.find(['/', '?', '#']) {
        Some(end) => rest.split_at(end),
        None => (rest, "/"),
    };
    if host.is_empty() || host.contains(char::is_whitespace) {
        return Err(invalid());
    }
    Ok(format!("{scheme}://{}{path}", host.to_ascii_lowercase()))
}

/// The first installed Chrome or Edge.
pub fn find_browser() -> Option<PathBuf> {
    candidates().into_iter().find(|path| path.is_file())
}

#[cfg(target_os = "macos")]
fn candidates() -> Vec<PathBuf> {
    [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

#[cfg(windows)]
fn candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for root in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(root) {
            let root = PathBuf::from(root);
            paths.push(root.join(r"Google\Chrome\Application\chrome.exe"));
            paths.push(root.join(r"Microsoft\Edge\Application\msedge.exe"));
        }
    }
    paths
}

#[cfg(not(any(target_os = "macos", windows)))]
fn candidates() -> Vec<PathBuf> {
    [
        "google-chrome",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
    ]
    .iter()
    .filter_map(|name| crate::process::resolve(name).map(|command| command.path))
    .collect()
}

/// The extra switches a browser needs. The headless shell's separate GPU process exits
/// once a page composites on macOS and Linux, which ends the browser, so that work stays
/// in-process there. `forced` covers a shell behind a wrapper or another name.
fn launch_flags(path: &Path, headless: bool, forced: bool) -> Vec<&'static str> {
    let name = path
        .file_stem()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let shell = name.contains("headless") && name.contains("shell");
    let mut flags = Vec::new();
    if headless && !shell {
        flags.push("--headless=new");
    }
    if forced || (shell && !cfg!(windows)) {
        flags.push("--in-process-gpu");
    }
    flags
}

/// How to start a browser.
#[derive(Clone, Copy, Debug, Default)]
pub struct LaunchOptions {
    pub headless: bool,
    pub in_process_gpu: bool,
}

/// Where a tab stands in its history. Only web pages count, so the blank page every
/// browser starts on is not somewhere to go back to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HistoryState {
    pub url: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    back: Option<i64>,
    forward: Option<i64>,
}

fn is_web(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// Reads `Page.getNavigationHistory`.
fn read_history(reply: &Value) -> HistoryState {
    let empty = Vec::new();
    let entries = reply
        .get("entries")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let current = reply
        .get("currentIndex")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok())
        .unwrap_or(0);
    fn url_of(entry: &Value) -> &str {
        entry.get("url").and_then(Value::as_str).unwrap_or("")
    }
    let id_of = |entry: &Value| entry.get("id").and_then(Value::as_i64);
    let back = entries
        .iter()
        .take(current)
        .rev()
        .find(|entry| is_web(url_of(entry)))
        .and_then(id_of);
    let forward = entries
        .iter()
        .skip(current + 1)
        .find(|entry| is_web(url_of(entry)))
        .and_then(id_of);
    HistoryState {
        url: entries.get(current).map(url_of).unwrap_or("").to_owned(),
        can_go_back: back.is_some(),
        can_go_forward: forward.is_some(),
        back,
        forward,
    }
}

pub struct BrowserSession {
    socket: Socket,
    session_id: String,
    next_id: u64,
    _child: Option<ManagedChild>,
}

impl BrowserSession {
    pub async fn launch(path: &Path, profile: &Path, options: LaunchOptions) -> Result<Self> {
        std::fs::create_dir_all(profile)?;
        let port_file = profile.join("DevToolsActivePort");
        let _ = std::fs::remove_file(&port_file);
        let mut profile_arg = OsString::from("--user-data-dir=");
        profile_arg.push(profile);
        let mut command = Command::new(path);
        command
            .arg("--remote-debugging-port=0")
            .arg(profile_arg)
            .args(["--no-first-run", "--no-default-browser-check"]);
        command.args(launch_flags(path, options.headless, options.in_process_gpu));
        command
            .arg("about:blank")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        crate::child_env::for_tool(command.as_std_mut());
        let child = ManagedChild::spawn(command)?;
        let url = tokio::time::timeout(START_TIMEOUT, read_port_file(&port_file))
            .await
            .map_err(|_| failed("the browser did not open its debugging port"))?;
        Self::connect(&url, Some(child)).await
    }

    /// Attaches to a browser-level WebSocket endpoint.
    pub async fn connect(url: &str, child: Option<ManagedChild>) -> Result<Self> {
        let (socket, _) = connect_async(url).await.map_err(failed)?;
        let mut session = Self {
            socket,
            session_id: String::new(),
            next_id: 0,
            _child: child,
        };
        let targets = session.browser_call("Target.getTargets", json!({})).await?;
        let page = targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .and_then(|targets| {
                targets
                    .iter()
                    .find(|target| target.get("type").and_then(Value::as_str) == Some("page"))
            })
            .and_then(|target| target.get("targetId").and_then(Value::as_str))
            .map(str::to_owned);
        let target_id = match page {
            Some(id) => id,
            None => session
                .browser_call("Target.createTarget", json!({ "url": "about:blank" }))
                .await?
                .get("targetId")
                .and_then(Value::as_str)
                .ok_or_else(|| failed("no page target"))?
                .to_owned(),
        };
        session.session_id = session
            .browser_call(
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
            )
            .await?
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| failed("no page session"))?
            .to_owned();
        session.call("Page.enable", json!({})).await?;
        Ok(session)
    }

    async fn browser_call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.send(method, params, None).await
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let session = self.session_id.clone();
        self.send(method, params, Some(session)).await
    }

    async fn send(
        &mut self,
        method: &str,
        params: Value,
        session: Option<String>,
    ) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        self.socket
            .send(Message::text(message.to_string()))
            .await
            .map_err(failed)?;
        tokio::time::timeout(CALL_TIMEOUT, async {
            loop {
                let frame = self
                    .socket
                    .next()
                    .await
                    .ok_or_else(|| failed("the browser closed the connection"))?
                    .map_err(failed)?;
                let Ok(text) = frame.to_text() else { continue };
                let Ok(reply) = serde_json::from_str::<Value>(text) else {
                    continue;
                };
                if reply.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if let Some(error) = reply.get("error") {
                    return Err(failed(
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("command refused"),
                    ));
                }
                return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
            }
        })
        .await
        .map_err(|_| failed("the browser did not answer"))?
    }

    async fn evaluate(&mut self, expression: &str) -> Result<Value> {
        let reply = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
            )
            .await?;
        if reply.get("exceptionDetails").is_some() {
            return Err(failed("the page raised an error"));
        }
        Ok(reply
            .pointer("/result/value")
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub async fn is_alive(&mut self) -> bool {
        self.evaluate("1").await.is_ok()
    }

    pub async fn current_url(&mut self) -> Result<String> {
        Ok(self
            .evaluate("location.href")
            .await?
            .as_str()
            .unwrap_or("about:blank")
            .to_owned())
    }

    pub async fn navigate(&mut self, url: &str) -> Result<Value> {
        let reply = self.call("Page.navigate", json!({ "url": url })).await?;
        if let Some(error) = reply.get("errorText").and_then(Value::as_str) {
            return Err(failed(error));
        }
        self.wait_for_load(LOAD_TIMEOUT).await;
        Ok(json!({ "url": self.current_url().await? }))
    }

    /// Load completion is best effort; a slow page is still navigated.
    async fn wait_for_load(&mut self, limit: Duration) {
        let _ = tokio::time::timeout(limit, async {
            while let Some(Ok(frame)) = self.socket.next().await {
                let Ok(text) = frame.to_text() else { continue };
                if let Ok(event) = serde_json::from_str::<Value>(text)
                    && matches!(
                        event.get("method").and_then(Value::as_str),
                        Some("Page.loadEventFired" | "Page.navigatedWithinDocument")
                    )
                {
                    return;
                }
            }
        })
        .await;
    }

    pub async fn history(&mut self) -> Result<HistoryState> {
        let reply = self.call("Page.getNavigationHistory", json!({})).await?;
        Ok(read_history(&reply))
    }

    /// Goes one web page back or forward. At the end of history it stays put.
    pub async fn step_history(&mut self, back: bool) -> Result<HistoryState> {
        let state = self.history().await?;
        let target = if back { state.back } else { state.forward };
        let Some(entry) = target else {
            return Ok(state);
        };
        self.call("Page.navigateToHistoryEntry", json!({ "entryId": entry }))
            .await?;
        self.wait_for_load(HISTORY_LOAD_TIMEOUT).await;
        self.history().await
    }

    pub async fn text(&mut self) -> Result<Value> {
        let value = self
            .evaluate("document.body ? document.body.innerText : ''")
            .await?;
        Ok(json!({ "text": value }))
    }

    pub async fn screenshot(&mut self) -> Result<Value> {
        let reply = self
            .call("Page.captureScreenshot", json!({ "format": "png" }))
            .await?;
        Ok(json!({ "format": "png", "data": reply.get("data") }))
    }

    /// One frame for a preview, as base64 JPEG.
    pub async fn frame(&mut self, quality: u32) -> Result<String> {
        let reply = self
            .call(
                "Page.captureScreenshot",
                json!({ "format": "jpeg", "quality": quality }),
            )
            .await?;
        reply
            .get("data")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| failed("the browser returned no frame"))
    }

    pub async fn set_viewport(&mut self, width: u32, height: u32) -> Result<()> {
        self.call(
            "Emulation.setDeviceMetricsOverride",
            json!({ "width": width, "height": height, "deviceScaleFactor": 1, "mobile": false }),
        )
        .await
        .map(|_| ())
    }

    /// A DevTools input call, for a person driving a preview.
    pub async fn input(&mut self, method: &str, params: Value) -> Result<()> {
        self.call(method, params).await.map(|_| ())
    }

    /// Clicks through input events, so the page sees a trusted click.
    pub async fn click(&mut self, selector: &str) -> Result<Value> {
        let locate = format!(
            "(() => {{ const el = document.querySelector({}); if (!el) return null; \
             el.scrollIntoView({{block: 'center'}}); const box = el.getBoundingClientRect(); \
             return {{ x: box.x + box.width / 2, y: box.y + box.height / 2 }}; }})()",
            Value::String(selector.to_owned())
        );
        let point = self.evaluate(&locate).await?;
        let (Some(x), Some(y)) = (
            point.get("x").and_then(Value::as_f64),
            point.get("y").and_then(Value::as_f64),
        ) else {
            return Err(failed(format!("nothing matches {selector}")));
        };
        for kind in ["mousePressed", "mouseReleased"] {
            self.call(
                "Input.dispatchMouseEvent",
                json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 }),
            )
            .await?;
        }
        Ok(json!({ "clicked": selector }))
    }
}

async fn read_port_file(path: &Path) -> String {
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            let mut lines = text.lines();
            if let (Some(port), Some(endpoint)) = (lines.next(), lines.next())
                && !port.is_empty()
            {
                return format!("ws://127.0.0.1:{port}{endpoint}");
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_headless_shell_gets_the_gpu_switch() {
        let shell = Path::new("/x/chrome-headless-shell");
        let chrome = Path::new("/Applications/Google Chrome");
        assert_eq!(launch_flags(chrome, true, false), ["--headless=new"]);
        assert!(launch_flags(chrome, false, false).is_empty());
        let flags = launch_flags(shell, true, false);
        assert!(!flags.contains(&"--headless=new"), "a shell has one mode");
        assert_eq!(flags.contains(&"--in-process-gpu"), !cfg!(windows));
        assert!(launch_flags(chrome, true, true).contains(&"--in-process-gpu"));
    }

    fn history(current: u64, urls: &[&str]) -> HistoryState {
        let entries: Vec<Value> = urls
            .iter()
            .enumerate()
            .map(|(index, url)| json!({ "id": index + 10, "url": url }))
            .collect();
        read_history(&json!({ "currentIndex": current, "entries": entries }))
    }

    #[test]
    fn history_never_leads_off_the_web() {
        let first = history(1, &["about:blank", "http://a/"]);
        assert!(!first.can_go_back, "the blank start page does not count");
        assert!(!first.can_go_forward);
        assert_eq!(first.url, "http://a/");
        let middle = history(2, &["about:blank", "http://a/", "http://b/", "http://c/"]);
        assert_eq!((middle.back, middle.forward), (Some(11), Some(13)));
        let around = history(2, &["http://a/", "data:text/html,x", "http://b/"]);
        assert_eq!(around.back, Some(10), "skips what is not a web page");
        assert_eq!(read_history(&json!({})), HistoryState::default());
    }

    #[test]
    fn urls_are_web_only_and_lowercase_the_host() {
        assert_eq!(
            normalize_url(" HTTPS://Example.COM/Path?q=A ").unwrap(),
            "https://example.com/Path?q=A"
        );
        assert_eq!(normalize_url("http://a.test").unwrap(), "http://a.test/");
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "chrome://settings",
            "example.com",
        ] {
            assert!(normalize_url(bad).is_err(), "{bad}");
        }
    }
}
