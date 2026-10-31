//! The desktop shell's side of the service. The UI holds no native access, so it
//! asks here and the shell acts, and what the shell sees (a link, a menu item) comes
//! back through here to the windows. The channel is newline JSON on the service's
//! stdin and stdout, shared with the app update messages in `updates`.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use orbyn_contracts::{ShellEvent, ShellStatus};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc};

/// Events kept for a window that has not connected yet, as with a link that
/// launched the app.
const HELD_EVENTS: usize = 8;
const ID_LIMIT: usize = 128;

pub struct ShellBridge {
    lines: Mutex<Option<mpsc::UnboundedSender<Value>>>,
    events: broadcast::Sender<ShellEvent>,
    held: Mutex<VecDeque<ShellEvent>>,
    windows: Arc<AtomicUsize>,
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

    pub fn status(&self) -> ShellStatus {
        ShellStatus {
            attached: lock(&self.lines).is_some(),
            windows: self.windows.load(Ordering::SeqCst),
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
            _ => false,
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
