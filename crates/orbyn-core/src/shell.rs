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
use tokio::sync::{broadcast, mpsc};

use crate::app::Core;
use crate::error::{CoreError, Result};

/// Events kept for a window that has not connected yet, as with a link that
/// launched the app.
const HELD_EVENTS: usize = 8;
const ID_LIMIT: usize = 128;
/// How often the shell's picture of running work is brought up to date.
const ACTIVITY_EVERY: Duration = Duration::from_secs(2);

pub struct ShellBridge {
    lines: Mutex<Option<mpsc::UnboundedSender<Value>>>,
    events: broadcast::Sender<ShellEvent>,
    held: Mutex<VecDeque<ShellEvent>>,
    windows: Arc<AtomicUsize>,
    facts: Mutex<ShellFacts>,
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
        Self {
            lines: Mutex::new(None),
            events: broadcast::channel(32).0,
            held: Mutex::new(VecDeque::new()),
            windows: Arc::default(),
            facts: Mutex::default(),
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
                match text("url").and_then(link_route) {
                    Some(href) => self.publish(ShellEvent::Navigate { href }),
                    None => tracing::warn!("ignoring a link this app does not know"),
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
    pub keep_awake: bool,
}

impl Activity {
    fn line(self) -> Value {
        json!({
            "type": "activity",
            "running": self.running,
            "waiting": self.waiting,
            "keep_awake": self.keep_awake,
        })
    }
}

impl Core {
    fn activity(&self) -> Result<Activity> {
        let runs = self.store.active_runs()?;
        let waiting = runs
            .iter()
            .filter(|run| run.state == RunState::AwaitingApproval)
            .count();
        let allowed = self.preference("keep_awake_during_runs", None)? != json!(false);
        Ok(Activity {
            running: runs.len(),
            waiting,
            keep_awake: allowed && !runs.is_empty(),
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
