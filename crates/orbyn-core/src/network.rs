//! Every request Orbyn makes without being asked, for a person to read. A new
//! automatic request belongs in this list in the same change.

use orbyn_contracts::NetworkRequest;

use crate::app::Core;
use crate::error::Result;

const UPDATE_CHECKS: &str = "The background_update_checks setting, or ORBYN_OFFLINE for versions";
const UPDATE_SETTING: &str = "background_update_checks";
const PULLS_SETTING: &str = "poll_pull_requests";
const AUTO_PULL_SETTING: &str = "auto_pull";
const TITLES_SETTING: &str = crate::titles::AUTO_TITLES_SETTING;

/// The list with no state filled in, which is what stays true of it.
fn listed() -> Vec<NetworkRequest> {
    let row = |purpose: &str, host: &str, cadence: &str, control: &str| NetworkRequest {
        purpose: purpose.to_owned(),
        host: host.to_owned(),
        cadence: cadence.to_owned(),
        control: control.to_owned(),
        setting: None,
        enabled: false,
    };
    vec![
        row(
            "Latest engine versions",
            "registry.npmjs.org",
            "At startup, every six hours and on Refresh",
            UPDATE_CHECKS,
        ),
        row(
            "Skills library updates (git fetch)",
            "The library's origin",
            "At startup, every six hours and on Refresh",
            UPDATE_CHECKS,
        ),
        row(
            "App update check",
            "The configured update endpoint or manifest",
            "At startup and every six hours",
            UPDATE_CHECKS,
        ),
        row(
            "Linked pull requests, through the forge's own CLI",
            "The forge of each linked repository",
            "Every two minutes while a pull request is linked",
            "The poll_pull_requests preference, or unlink the pull request",
        ),
        row(
            "Fast-forward of a clean checkout",
            "That checkout's origin",
            "Every 30 minutes where turned on",
            "The auto_pull preference, off by default",
        ),
        row(
            "A thread's title, through the engine's own CLI",
            "The thread's engine",
            "Once, when a new thread gets its first message",
            "The auto_thread_titles preference",
        ),
        row(
            "OTLP connection check",
            "The configured collector",
            "Only when asked to test it",
            "Leave it unconfigured",
        ),
    ]
}

impl Core {
    /// Every automatic request, and whether it is happening now.
    pub fn network_requests(&self) -> Result<Vec<NetworkRequest>> {
        let settings = self.store.settings()?;
        let updates = settings.background_update_checks != Some(false);
        let on = |key: &str| -> Result<bool> { Ok(self.preference(key, None)? == true) };
        let (pulls, auto_pull) = (on(PULLS_SETTING)?, on(AUTO_PULL_SETTING)?);
        let titles = on(TITLES_SETTING)?;
        Ok(listed()
            .into_iter()
            .map(|mut row| {
                let (setting, enabled) = if row.control == UPDATE_CHECKS {
                    (Some(UPDATE_SETTING), updates)
                } else if row.control.contains(PULLS_SETTING) {
                    (Some(PULLS_SETTING), pulls)
                } else if row.control.contains(AUTO_PULL_SETTING) {
                    (Some(AUTO_PULL_SETTING), auto_pull)
                } else if row.control.contains(TITLES_SETTING) {
                    (Some(TITLES_SETTING), titles)
                } else {
                    (None, false)
                };
                row.setting = setting.map(str::to_owned);
                row.enabled = enabled;
                row
            })
            .collect())
    }
}
