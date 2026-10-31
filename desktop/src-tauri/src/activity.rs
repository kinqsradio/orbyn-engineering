//! Shows running work and keeps the machine awake for it. The service decides; this
//! only applies what it says.

use crate::core_process::Activity;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub const TRAY: &str = "main";

/// Text for the tray's tooltip.
pub fn summary(activity: Activity) -> String {
    match (activity.running, activity.waiting) {
        (0, _) => "Orbyn Engineering".to_owned(),
        (running, 0) => format!("Orbyn Engineering: {running} running"),
        (running, waiting) => format!("Orbyn Engineering: {running} running, {waiting} need you"),
    }
}

/// What the Dock badge counts: only what is waiting on a person.
pub fn badge(activity: Activity) -> Option<i64> {
    (activity.waiting > 0).then_some(i64::from(activity.waiting))
}

pub fn apply(app: &AppHandle, activity: Activity) {
    if let Some(tray) = app.tray_by_id(TRAY) {
        let _ = tray.set_tooltip(Some(summary(activity)));
        #[cfg(target_os = "macos")]
        let _ = tray.set_title((activity.running > 0).then(|| activity.running.to_string()));
    }
    // Windows has no badge count; its tray tooltip carries this instead.
    #[cfg(target_os = "macos")]
    if let Some(window) = crate::main_window(app) {
        let _ = window.set_badge_count(badge(activity));
    }
    app.state::<KeepAwake>().set(activity.keep_awake);
}

/// Holds off idle sleep while set. The display may still sleep, and a closed lid
/// still sleeps: this asks, it does not overrule the person.
#[derive(Default)]
pub struct KeepAwake(Mutex<Option<Hold>>);

impl KeepAwake {
    pub fn set(&self, on: bool) {
        let mut hold = self.0.lock().expect("keep awake");
        match (on, hold.is_some()) {
            (true, false) => *hold = Hold::start(),
            (false, true) => *hold = None,
            _ => {}
        }
    }
}

/// `caffeinate` ends by itself if this process dies, through `-w`.
#[cfg(target_os = "macos")]
struct Hold(std::process::Child);

#[cfg(target_os = "macos")]
impl Hold {
    fn start() -> Option<Self> {
        std::process::Command::new("/usr/bin/caffeinate")
            .args(["-i", "-w", &std::process::id().to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()
            .map(Self)
    }
}

#[cfg(target_os = "macos")]
impl Drop for Hold {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The request belongs to the thread that made it, so one thread holds it.
#[cfg(windows)]
struct Hold(std::sync::mpsc::Sender<()>);

#[cfg(windows)]
impl Hold {
    fn start() -> Option<Self> {
        use windows_sys::Win32::System::Power::{
            ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
        };
        let (sender, receiver) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            // SAFETY: takes only flags and touches no memory of ours.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            let _ = receiver.recv();
            // SAFETY: as above.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        });
        Some(Self(sender))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
struct Hold;

#[cfg(not(any(target_os = "macos", windows)))]
impl Hold {
    fn start() -> Option<Self> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn activity(running: u32, waiting: u32) -> Activity {
        Activity {
            running,
            waiting,
            keep_awake: running > 0,
        }
    }

    #[test]
    fn the_badge_counts_only_what_waits_on_a_person() {
        assert_eq!(badge(activity(0, 0)), None);
        assert_eq!(badge(activity(3, 0)), None);
        assert_eq!(badge(activity(3, 2)), Some(2));
    }

    #[test]
    fn the_tooltip_says_what_is_going_on() {
        assert_eq!(summary(activity(0, 0)), "Orbyn Engineering");
        assert_eq!(summary(activity(2, 0)), "Orbyn Engineering: 2 running");
        assert_eq!(
            summary(activity(2, 1)),
            "Orbyn Engineering: 2 running, 1 need you"
        );
    }
}
