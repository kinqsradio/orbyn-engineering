//! The desktop shell's side of the service. The UI holds no native access, so it
//! asks here and the shell acts, and what the shell sees (a link, a menu item) comes
//! back through here to the windows. The channel is newline JSON on the service's
//! stdin and stdout, shared with the app update messages in `updates`.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orbyn_contracts::{RunState, ShellAction, ShellEvent, ShellFacts, ShellStatus};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::app::Core;
use crate::error::{CoreError, Result};

/// Events kept for a window that has not connected yet, as with a link that
/// launched the app.
const HELD_EVENTS: usize = 8;
const ID_LIMIT: usize = 128;
/// Web links from other apps waiting to open. More than this at once are dropped.
const WAITING_WEB_LINKS: usize = 8;
/// The longest web link another app may hand over.
const WEB_LINK_LIMIT: usize = 2048;
/// Who opened a preview for a link another app handed to the desktop app.
const LINK_ACTOR: &str = "desktop_link";
/// How often the shell's picture of running work is brought up to date.
const ACTIVITY_EVERY: Duration = Duration::from_secs(2);
/// How long a native file dialog may stay open before the request gives up.
const PICK_WAIT: Duration = Duration::from_secs(15 * 60);

/// The one native image dialog that may be open, and where its answer goes.
struct Pick {
    id: String,
    answer: oneshot::Sender<Option<std::path::PathBuf>>,
}

pub struct ShellBridge {
    lines: Mutex<Option<mpsc::UnboundedSender<Value>>>,
    events: broadcast::Sender<ShellEvent>,
    held: Mutex<VecDeque<ShellEvent>>,
    windows: Arc<AtomicUsize>,
    facts: Mutex<ShellFacts>,
    pick: Mutex<Option<Pick>>,
    web_links: mpsc::Sender<String>,
    waiting_web_links: Mutex<Option<mpsc::Receiver<String>>>,
}

/// One window following events. Dropping it stops counting that window.
pub struct ShellWatch {
    pub events: broadcast::Receiver<ShellEvent>,
    /// What arrived while no window was there.
    pub held: Vec<ShellEvent>,
    windows: Arc<AtomicUsize>,
}

impl Drop for ShellWatch {
    fn drop(&mut self) {
        self.windows.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Default for ShellBridge {
    fn default() -> Self {
        let (web_links, waiting) = mpsc::channel(WAITING_WEB_LINKS);
        Self {
            web_links,
            waiting_web_links: Mutex::new(Some(waiting)),
            lines: Mutex::new(None),
            events: broadcast::channel(32).0,
            held: Mutex::new(VecDeque::new()),
            windows: Arc::default(),
            facts: Mutex::default(),
            pick: Mutex::new(None),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl ShellBridge {
    /// Connects the shell. `lines` go to the service's stdout.
    pub fn attach(&self, lines: mpsc::UnboundedSender<Value>) {
        *lock(&self.lines) = Some(lines);
    }

    /// Sends one line. False means no shell is listening.
    pub fn send(&self, line: Value) -> bool {
        lock(&self.lines)
            .as_ref()
            .is_some_and(|lines| lines.send(line).is_ok())
    }

    /// Passes a window's request on. A plain server has no shell to ask.
    pub fn request(&self, action: ShellAction) -> Result<()> {
        if self.send(json!({ "type": "shell_action", "action": action })) {
            Ok(())
        } else {
            Err(CoreError::Unsupported(
                "This needs the desktop app.".to_owned(),
            ))
        }
    }

    /// Ask the shell to show a preview already checked by the service.
    pub fn preview_window(&self, thread_id: &str, tab_id: &str) -> Result<()> {
        if !is_id(thread_id) || !is_id(tab_id) {
            return Err(CoreError::NotFound("preview".to_owned()));
        }
        if self.send(json!({ "type": "preview_window", "thread_id": thread_id, "tab_id": tab_id }))
        {
            Ok(())
        } else {
            Err(CoreError::Unsupported(
                "This needs the desktop app.".to_owned(),
            ))
        }
    }

    /// Opens the desktop app's own image dialog and waits for the person. The shell
    /// returns only the chosen path, or none when cancelled; deciding what that file
    /// may become is the caller's. One dialog at a time.
    pub async fn choose_image(&self) -> Result<Option<std::path::PathBuf>> {
        let id = crate::util::new_id();
        let (answer, chosen) = oneshot::channel();
        {
            let mut pick = lock(&self.pick);
            if pick.as_ref().is_some_and(|open| !open.answer.is_closed()) {
                return Err(CoreError::Invalid(
                    "An image dialog is already open.".into(),
                ));
            }
            *pick = Some(Pick {
                id: id.clone(),
                answer,
            });
        }
        if !self.send(json!({ "type": "choose_project_image", "request_id": id })) {
            lock(&self.pick).take();
            return Err(CoreError::Unsupported(
                "This needs the desktop app.".to_owned(),
            ));
        }
        let outcome = tokio::time::timeout(PICK_WAIT, chosen).await;
        // Whatever happened, this request no longer owns the dialog.
        let mut pick = lock(&self.pick);
        if pick.as_ref().is_some_and(|open| open.id == id) {
            pick.take();
        }
        match outcome {
            Ok(Ok(path)) => Ok(path),
            Ok(Err(_)) => Ok(None),
            Err(_) => Err(CoreError::Invalid("The image dialog didn't answer.".into())),
        }
    }

    pub fn status(&self) -> ShellStatus {
        ShellStatus {
            attached: lock(&self.lines).is_some(),
            windows: self.windows.load(Ordering::SeqCst),
            facts: lock(&self.facts).clone(),
        }
    }

    pub fn watch(&self) -> ShellWatch {
        // Under the same lock as `publish`, so an event is either held or received.
        let mut held = lock(&self.held);
        self.windows.fetch_add(1, Ordering::SeqCst);
        ShellWatch {
            events: self.events.subscribe(),
            held: held.drain(..).collect(),
            windows: self.windows.clone(),
        }
    }

    fn publish(&self, event: ShellEvent) {
        let mut held = lock(&self.held);
        if self.events.send(event.clone()).is_err() {
            if held.len() == HELD_EVENTS {
                held.pop_front();
            }
            held.push_back(event);
        }
    }

    /// Takes the lines meant for this side. False leaves the line for `updates`.
    pub fn on_line(&self, line: &str) -> bool {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        let text = |key: &str| message.get(key).and_then(Value::as_str);
        match text("type") {
            Some("open_link") => {
                let url = text("url").unwrap_or_default();
                if let Some(href) = link_route(url) {
                    self.publish(ShellEvent::Navigate { href });
                } else if let Some(link) = web_link(url) {
                    // Core decides whether and where it opens; see `Core::open_web_link`.
                    if self.web_links.try_send(link).is_err() {
                        tracing::warn!("dropping a web link: too many are waiting");
                    }
                } else {
                    tracing::warn!("ignoring a link this app does not know");
                }
                true
            }
            Some("menu_command") => {
                if let Some(command) = text("command") {
                    self.publish(ShellEvent::Command {
                        command: command.to_owned(),
                    });
                }
                true
            }
            Some("shell_facts") => {
                match serde_json::from_value::<ShellFacts>(message.clone()) {
                    Ok(facts) => {
                        *lock(&self.facts) = facts;
                        // Windows reread the status on connecting, so none need holding.
                        let _ = self.events.send(ShellEvent::Changed);
                    }
                    Err(error) => tracing::debug!(%error, "ignoring shell facts"),
                }
                true
            }
            Some("project_image_chosen") => {
                let mut pick = lock(&self.pick);
                if pick
                    .as_ref()
                    .is_some_and(|open| Some(open.id.as_str()) == text("request_id"))
                    && let Some(open) = pick.take()
                {
                    // Only an absolute path counts; anything else reads as cancelled.
                    let path = text("path")
                        .map(std::path::PathBuf::from)
                        .filter(|path| path.is_absolute());
                    let _ = open.answer.send(path);
                }
                true
            }
            Some("shell_failed") => {
                if let Some(message) = text("message") {
                    self.publish(ShellEvent::Failed {
                        message: message.to_owned(),
                    });
                }
                true
            }
            _ => false,
        }
    }
}

/// What the shell shows and holds while work runs: the Dock badge, the tray and the
/// lock against sleep. The rule lives here, so the shell only applies the answer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Activity {
    pub running: usize,
    pub waiting: usize,
    /// Threads flagged unread and not archived.
    pub unread: usize,
    pub keep_awake: bool,
    /// `quit_confirmation`: the shell keeps `Cmd+Q` on its menu only for `direct`.
    pub quit_confirmation: &'static str,
}

impl Activity {
    fn line(self) -> Value {
        json!({
            "type": "activity",
            "running": self.running,
            "waiting": self.waiting,
            "unread": self.unread,
            "keep_awake": self.keep_awake,
            "quit_confirmation": self.quit_confirmation,
        })
    }
}

impl Core {
    /// Opens a web link another app handed to the desktop app in a preview tab, when
    /// the person turned that on. It goes to the live thread in a trusted project
    /// that changed last, since a preview belongs to a thread and runs that thread's
    /// browser. The link never goes back to the system: if this app is the system's
    /// default browser, that would hand it straight back here.
    pub async fn open_web_link(&self, url: &str) -> Result<orbyn_contracts::PreviewTab> {
        if self.preference("open_web_links_in_app", None)? != json!(true) {
            return Err(CoreError::Unsupported(
                "Another app sent Orbyn a link. To open links like this in the Browser panel, turn on Open links from other apps here in Settings.".to_owned(),
            ));
        }
        let Some(thread) = self.store.latest_trusted_thread()? else {
            return Err(CoreError::Unsupported(
                "Another app sent Orbyn a link, but there's no thread in a trusted project to open it in.".to_owned(),
            ));
        };
        self.open_preview(
            &thread.id,
            url,
            (None, None),
            LINK_ACTOR,
            crate::preview::OpenHow::default(),
        )
        .await
    }

    /// Opens web links from the shell one at a time, until `stop` fires.
    pub async fn run_web_links(&self, stop: tokio_util::sync::CancellationToken) {
        let Some(mut links) = lock(&self.shell.waiting_web_links).take() else {
            return;
        };
        loop {
            let link = tokio::select! {
                () = stop.cancelled() => return,
                link = links.recv() => match link {
                    Some(link) => link,
                    None => return,
                },
            };
            let event = match self.open_web_link(&link).await {
                Ok(tab) => {
                    tracing::info!(thread = %tab.thread_id, tab = %tab.id, "opened a web link from another app");
                    ShellEvent::ShowPreview {
                        thread_id: tab.thread_id,
                        tab_id: tab.id,
                    }
                }
                Err(error) => {
                    tracing::info!(%error, "did not open a web link from another app");
                    ShellEvent::Failed {
                        message: error.to_string(),
                    }
                }
            };
            self.shell.publish(event);
        }
    }

    fn activity(&self) -> Result<Activity> {
        let runs = self.store.active_runs()?;
        let waiting = runs
            .iter()
            .filter(|run| run.state == RunState::AwaitingApproval)
            .count();
        let allowed = self.preference("keep_awake_during_runs", None)? != json!(false);
        let quit = self.preference("quit_confirmation", None)?;
        let quit_confirmation = match quit.as_str() {
            Some("hold") => "hold",
            Some("double_press") => "double_press",
            _ => "direct",
        };
        Ok(Activity {
            running: runs.len(),
            waiting,
            unread: self.store.unread_threads()?,
            keep_awake: allowed && !runs.is_empty(),
            quit_confirmation,
        })
    }

    /// Tells the shell whenever the picture changes, until `stop` fires.
    pub async fn run_shell_activity(&self, stop: tokio_util::sync::CancellationToken) {
        let mut ticks = tokio::time::interval(ACTIVITY_EVERY);
        let mut told = Activity::default();
        loop {
            tokio::select! {
                () = stop.cancelled() => return,
                _ = ticks.tick() => {}
            }
            match self.activity() {
                Ok(now) if now != told && self.shell.send(now.line()) => told = now,
                Ok(_) => {}
                Err(error) => tracing::debug!(%error, "could not read running work"),
            }
        }
    }
}

fn is_id(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= ID_LIMIT
        && text
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || char == '-' || char == '_')
}

/// A web link another app handed over, if it is one: `http` or `https`, short, and
/// with no control characters. The preview checks it again before opening it.
pub fn web_link(url: &str) -> Option<String> {
    if url.len() > WEB_LINK_LIMIT || url.chars().any(char::is_control) {
        return None;
    }
    crate::computer::cdp::normalize_url(url).ok()
}

/// The route an `orbyn://` link names. A link comes from outside the app, so it can
/// only move the window, and only to a place spelled exactly as a route.
pub fn link_route(url: &str) -> Option<String> {
    let rest = url.strip_prefix("orbyn://")?;
    let path = rest.split(['?', '#']).next().unwrap_or_default();
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    match parts[..] {
        [] | ["home"] => Some("#/".to_owned()),
        ["thread" | "threads", id] if is_id(id) => Some(format!("#/threads/{id}")),
        ["new"] => Some("#/new".to_owned()),
        ["new", project] if is_id(project) => Some(format!("#/new/{project}")),
        ["settings"] => Some("#/settings".to_owned()),
        ["settings", section] if is_id(section) => Some(format!("#/settings/{section}")),
        ["usage"] => Some("#/usage".to_owned()),
        ["pulls"] => Some("#/pulls".to_owned()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_reach_only_known_routes() {
        let route = |url: &str| link_route(url);
        assert_eq!(route("orbyn://").as_deref(), Some("#/"));
        assert_eq!(
            route("orbyn://thread/abc-1").as_deref(),
            Some("#/threads/abc-1")
        );
        assert_eq!(
            route("orbyn://threads/abc/").as_deref(),
            Some("#/threads/abc")
        );
        assert_eq!(route("orbyn://new/p1?x=1").as_deref(), Some("#/new/p1"));
        assert_eq!(
            route("orbyn://settings/about").as_deref(),
            Some("#/settings/about")
        );
        assert_eq!(route("orbyn://thread/..%2F..").as_deref(), None);
        assert_eq!(route("orbyn://thread/a/b").as_deref(), None);
        assert_eq!(route("orbyn://run/start").as_deref(), None);
        assert_eq!(route("https://example.com/thread/a").as_deref(), None);
    }

    #[test]
    fn only_short_web_links_go_on_to_core() {
        assert_eq!(
            web_link("HTTPS://Example.com/a?b=1").as_deref(),
            Some("https://example.com/a?b=1")
        );
        assert_eq!(
            web_link("http://127.0.0.1:5000").as_deref(),
            Some("http://127.0.0.1:5000/")
        );
        assert_eq!(web_link("file:///etc/passwd"), None);
        assert_eq!(web_link("javascript:alert(1)"), None);
        assert_eq!(web_link("vscode://file/x"), None);
        assert_eq!(web_link("https://"), None);
        assert_eq!(web_link("https://example.com/\nx"), None);
        assert_eq!(web_link("https://example.com/a\u{7}"), None);
        let long = format!("https://example.com/{}", "a".repeat(WEB_LINK_LIMIT));
        assert_eq!(web_link(&long), None);
    }

    #[tokio::test]
    async fn a_web_link_waits_for_core_and_a_flood_is_dropped() {
        let shell = ShellBridge::default();
        assert!(shell.on_line(r#"{"type":"open_link","url":"https://example.com/"}"#));
        for _ in 0..WAITING_WEB_LINKS + 4 {
            shell.on_line(r#"{"type":"open_link","url":"https://example.com/more"}"#);
        }
        // Nothing reaches a window on its own: Core decides and then publishes.
        assert!(shell.watch().held.is_empty());
        let mut waiting = lock(&shell.waiting_web_links).take().unwrap();
        assert_eq!(
            waiting.recv().await.as_deref(),
            Some("https://example.com/")
        );
        let mut rest = 0;
        while waiting.try_recv().is_ok() {
            rest += 1;
        }
        assert_eq!(rest, WAITING_WEB_LINKS - 1);
    }

    #[test]
    fn events_wait_for_the_first_window_and_are_counted_out() {
        let shell = ShellBridge::default();
        assert!(shell.on_line(r#"{"type":"open_link","url":"orbyn://usage"}"#));
        assert!(!shell.on_line(r#"{"type":"app_update_none"}"#));
        assert!(!shell.on_line("not json"));
        let mut first = shell.watch();
        assert_eq!(shell.status().windows, 1);
        assert_eq!(
            first.held,
            [ShellEvent::Navigate {
                href: "#/usage".into()
            }]
        );
        assert!(shell.on_line(r#"{"type":"menu_command","command":"chat.new"}"#));
        assert_eq!(
            first.events.try_recv().unwrap(),
            ShellEvent::Command {
                command: "chat.new".into()
            }
        );
        drop(first);
        assert_eq!(shell.status().windows, 0);
        assert!(shell.watch().held.is_empty());
    }

    #[tokio::test]
    async fn an_image_dialog_returns_only_its_own_absolute_answer() {
        let bridge = Arc::new(ShellBridge::default());
        assert!(matches!(
            bridge.choose_image().await,
            Err(CoreError::Unsupported(_))
        ));
        let (lines, mut sent) = mpsc::unbounded_channel();
        bridge.attach(lines);
        let waiting = tokio::spawn({
            let bridge = bridge.clone();
            async move { bridge.choose_image().await }
        });
        let asked = sent.recv().await.unwrap();
        assert_eq!(asked["type"], "choose_project_image");
        let id = asked["request_id"].as_str().unwrap().to_owned();
        // A second dialog is refused while the first is open.
        assert!(matches!(
            bridge.choose_image().await,
            Err(CoreError::Invalid(_))
        ));
        // Another request's answer changes nothing.
        assert!(
            bridge.on_line(
                &json!({ "type": "project_image_chosen", "request_id": "other", "path": "/x.png" })
                    .to_string()
            )
        );
        let chosen = if cfg!(windows) {
            "C:\\images\\logo.png"
        } else {
            "/images/logo.png"
        };
        bridge.on_line(
            &json!({ "type": "project_image_chosen", "request_id": id, "path": chosen })
                .to_string(),
        );
        assert_eq!(
            waiting.await.unwrap().unwrap(),
            Some(std::path::PathBuf::from(chosen))
        );

        let waiting = tokio::spawn({
            let bridge = bridge.clone();
            async move { bridge.choose_image().await }
        });
        let id = sent.recv().await.unwrap()["request_id"]
            .as_str()
            .unwrap()
            .to_owned();
        bridge.on_line(
            &json!({ "type": "project_image_chosen", "request_id": id, "path": "relative.png" })
                .to_string(),
        );
        assert_eq!(
            waiting.await.unwrap().unwrap(),
            None,
            "a relative path reads as cancelled"
        );
    }

    #[test]
    fn a_request_reaches_the_shell_and_fails_without_one() {
        let shell = ShellBridge::default();
        assert!(shell.request(ShellAction::ZoomIn).is_err());
        let (lines, mut out) = mpsc::unbounded_channel();
        shell.attach(lines);
        shell.request(ShellAction::ZoomReset).unwrap();
        assert_eq!(
            out.try_recv().unwrap(),
            json!({ "type": "shell_action", "action": "zoom_reset" })
        );
    }

    #[test]
    fn preview_window_uses_only_validated_identifiers_and_requires_a_shell() {
        let shell = ShellBridge::default();
        assert!(shell.preview_window("thread-1", "tab_1").is_err());
        let (lines, mut out) = mpsc::unbounded_channel();
        shell.attach(lines);
        assert!(shell.preview_window("../other", "tab_1").is_err());
        assert!(out.try_recv().is_err());
        shell.preview_window("thread-1", "tab_1").unwrap();
        assert_eq!(
            out.try_recv().unwrap(),
            json!({
                "type": "preview_window", "thread_id": "thread-1", "tab_id": "tab_1"
            })
        );
    }

    #[test]
    fn facts_replace_what_was_known_and_tell_the_windows() {
        let shell = ShellBridge::default();
        let mut watch = shell.watch();
        let line = r#"{"type":"shell_facts","cli":{"path":"/x/orbyn","installed":true},
            "permissions":[{"id":"accessibility","granted":false}]}"#;
        assert!(shell.on_line(&line.replace('\n', "")));
        assert_eq!(watch.events.try_recv().unwrap(), ShellEvent::Changed);
        let facts = shell.status().facts;
        assert!(facts.cli.unwrap().installed);
        assert_eq!(facts.permissions.len(), 1);
        assert!(shell.on_line(r#"{"type":"shell_facts"}"#));
        assert_eq!(shell.status().facts, ShellFacts::default());
    }

    #[test]
    fn a_long_wait_keeps_the_newest_events() {
        let shell = ShellBridge::default();
        for _ in 0..HELD_EVENTS + 3 {
            shell.on_line(r#"{"type":"menu_command","command":"a"}"#);
        }
        shell.on_line(r#"{"type":"menu_command","command":"last"}"#);
        let held = shell.watch().held.clone();
        assert_eq!(held.len(), HELD_EVENTS);
        assert_eq!(
            held.last(),
            Some(&ShellEvent::Command {
                command: "last".into()
            })
        );
    }
}
