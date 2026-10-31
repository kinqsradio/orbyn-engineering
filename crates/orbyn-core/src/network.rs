//! Every request Orbyn makes without being asked, for a person to read. A new
//! automatic request belongs in this list in the same change.

use orbyn_contracts::NetworkRequest;

const UPDATE_CHECKS: &str = "The background_update_checks setting, or ORBYN_OFFLINE for versions";

pub fn automatic_requests() -> Vec<NetworkRequest> {
    let row = |purpose: &str, host: &str, cadence: &str, control: &str| NetworkRequest {
        purpose: purpose.to_owned(),
        host: host.to_owned(),
        cadence: cadence.to_owned(),
        control: control.to_owned(),
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
            "Unlink the pull request",
        ),
        row(
            "Fast-forward of a clean checkout",
            "That checkout's origin",
            "Every 30 minutes where turned on",
            "The auto_pull preference, off by default",
        ),
        row(
            "OTLP connection check",
            "The configured collector",
            "Only when asked to test it",
            "Leave it unconfigured",
        ),
    ]
}
