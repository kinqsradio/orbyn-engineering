//! What the local environment says about itself to its viewers: the theme it
//! publishes. Nothing here identifies a remote environment.

use orbyn_contracts::EnvironmentTheme;

use crate::app::Core;
use crate::error::Result;

impl Core {
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
