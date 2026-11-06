//! What the local environment says about itself to its viewers: the theme it
//! publishes and the release channel it was built for. Nothing here identifies a
//! remote environment.

use orbyn_contracts::{EnvironmentTheme, ReleaseChannel};

use crate::app::Core;
use crate::error::Result;

/// The channel this build belongs to, fixed when it was compiled.
pub fn release_channel() -> ReleaseChannel {
    channel_of(option_env!("ORBYN_CHANNEL"), cfg!(debug_assertions))
}

fn channel_of(named: Option<&str>, debug: bool) -> ReleaseChannel {
    match named {
        Some("nightly") => ReleaseChannel::Nightly,
        Some("dev") => ReleaseChannel::Dev,
        Some("stable") => ReleaseChannel::Stable,
        _ if debug => ReleaseChannel::Dev,
        _ => ReleaseChannel::Stable,
    }
}

impl Core {
    /// The machine kind chosen for this environment, if any.
    pub fn environment_icon(&self) -> Result<Option<String>> {
        let icon = self.preference("environment_icon", None)?;
        Ok(icon
            .as_str()
            .filter(|icon| !icon.is_empty())
            .map(str::to_owned))
    }

    /// The published theme, or none while `default_theme` is empty.
    pub fn environment_theme(&self) -> Result<Option<EnvironmentTheme>> {
        let name = self.preference("default_theme", None)?;
        let name = name.as_str().unwrap_or_default();
        if name.is_empty() {
            return Ok(None);
        }
        let set_at = self
            .preference("default_theme_set_at", None)?
            .as_i64()
            .unwrap_or(0);
        Ok(Some(EnvironmentTheme {
            name: name.to_owned(),
            set_at,
        }))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use crate::{CoreConfig, app::Core, testing::TempDir};

    fn core(dir: &TempDir) -> Core {
        let mut config = CoreConfig::new(dir.path().join("data"), "http://127.0.0.1:1".into());
        config.engines.lookup_latest = false;
        Core::open(config).unwrap()
    }

    #[test]
    fn setting_the_theme_stamps_a_newer_time_and_clearing_removes_it() {
        let dir = TempDir::new();
        let core = core(&dir);
        assert!(core.environment_theme().unwrap().is_none());
        let set =
            |value| core.set_preferences(None, &BTreeMap::from([("default_theme".into(), value)]));
        set(json!("dusk")).unwrap();
        let first = core.environment_theme().unwrap().unwrap();
        assert_eq!(first.name, "dusk");
        assert!(first.set_at > 0);
        std::thread::sleep(std::time::Duration::from_millis(5));
        set(json!("dusk")).unwrap();
        let second = core.environment_theme().unwrap().unwrap();
        assert!(
            second.set_at > first.set_at,
            "a repeat set is published again"
        );
        set(serde_json::Value::Null).unwrap();
        assert!(core.environment_theme().unwrap().is_none());
        assert_eq!(
            core.preference("default_theme_set_at", None).unwrap(),
            json!(0)
        );
    }

    #[test]
    fn the_icon_is_a_known_machine_kind() {
        let dir = TempDir::new();
        let core = core(&dir);
        assert_eq!(core.environment_icon().unwrap(), None);
        let set = |value| {
            core.set_preferences(None, &BTreeMap::from([("environment_icon".into(), value)]))
        };
        set(json!("laptop")).unwrap();
        assert_eq!(core.environment_icon().unwrap().as_deref(), Some("laptop"));
        assert!(set(json!("toaster")).is_err());
        set(json!("")).unwrap();
        assert_eq!(core.environment_icon().unwrap(), None);
    }

    #[test]
    fn a_named_channel_wins_and_debug_builds_are_dev() {
        use super::channel_of;
        use orbyn_contracts::ReleaseChannel;
        assert_eq!(channel_of(Some("nightly"), false), ReleaseChannel::Nightly);
        assert_eq!(channel_of(Some("stable"), true), ReleaseChannel::Stable);
        assert_eq!(channel_of(None, true), ReleaseChannel::Dev);
        assert_eq!(channel_of(Some("other"), false), ReleaseChannel::Stable);
    }

    #[test]
    fn the_time_is_the_services_and_names_are_checked() {
        let dir = TempDir::new();
        let core = core(&dir);
        let write = |key: &str, value| {
            core.set_preferences(None, &BTreeMap::from([(key.to_owned(), value)]))
        };
        assert!(write("default_theme_set_at", json!(9)).is_err());
        for bad in ["Dark", "dusk ", "a--b", "../x"] {
            assert!(write("default_theme", json!(bad)).is_err(), "{bad}");
        }
        for good in ["", "system", "dark", "my-theme-2"] {
            write("default_theme", json!(good)).unwrap();
        }
    }
}
