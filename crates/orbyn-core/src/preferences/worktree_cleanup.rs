//! The project policy is separate from environment artifact/log retention.
use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::app::Core;
use crate::error::{CoreError, Result};

fn invalid() -> CoreError {
    CoreError::Invalid("That is not a valid value for worktree_cleanup.".into())
}

pub(super) fn validate_patch(value: &Value) -> Result<()> {
    let object = value.as_object().ok_or_else(invalid)?;
    if let Some(mode) = object.get("mode")
        && !matches!(mode.as_str(), Some("off" | "custom"))
    {
        return Err(invalid());
    }
    if let Some(rules) = object.get("rules") {
        let rules = rules.as_object().ok_or_else(invalid)?;
        if let Some(days) = rules.get("settled_after_days")
            && !days.is_null()
            && !days.as_u64().is_some_and(|days| days <= 3650)
        {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(super) fn validate(value: &Value) -> Result<()> {
    validate_patch(value)?;
    match value.get("mode").and_then(Value::as_str) {
        Some("custom") if value.get("rules").is_none() => Err(invalid()),
        None if value.get("rules").is_some() => Err(invalid()),
        _ => Ok(()),
    }
}

pub(super) fn merge(current: &mut Map<String, Value>, patch: &Map<String, Value>) -> Result<()> {
    let mut patch = patch.clone();
    if let Some(rules) = patch.remove("rules") {
        let mut merged = current.get("rules").map_or_else(
            || Ok(Map::new()),
            |value| value.as_object().cloned().ok_or_else(invalid),
        )?;
        merged.extend(rules.as_object().ok_or_else(invalid)?.clone());
        current.insert("rules".into(), Value::Object(merged));
    }
    current.extend(patch);
    Ok(())
}

enum Policy {
    Inherit,
    Explicit(Option<i64>),
}

fn policy(value: &Value) -> Result<Policy> {
    validate(value)?;
    Ok(match value.get("mode").and_then(Value::as_str) {
        Some("off") => Policy::Explicit(None),
        Some("custom") => Policy::Explicit(
            value
                .pointer("/rules/settled_after_days")
                .and_then(Value::as_i64),
        ),
        _ => Policy::Inherit,
    })
}

impl Core {
    pub(super) fn cleanup_policy_write<'a>(
        &self,
        keys: impl IntoIterator<Item = &'a str>,
        environment: bool,
    ) -> Result<Option<tokio::sync::RwLockReadGuard<'_, ()>>> {
        if keys
            .into_iter()
            .any(|key| key == "worktree_cleanup" || environment && key == "storage_cleanup")
        {
            return self
                .cleanup_policy_gate
                .try_read()
                .map(Some)
                .map_err(|_| CoreError::SettingsConflict);
        }
        Ok(None)
    }

    /// Resolve every policy before any cleanup effects. Legacy project artifact
    /// objects are deliberately not read, even when their JSON is corrupt.
    pub(crate) fn worktree_retention(&self) -> Result<BTreeMap<String, Option<i64>>> {
        let snapshot = self.store.settings_snapshot()?;
        let environment: Value = snapshot
            .globals
            .get("pref:worktree_cleanup")
            .map(|value| serde_json::from_str(value))
            .transpose()?
            .unwrap_or_else(|| json!({}));
        let legacy: Value = snapshot
            .globals
            .get("pref:storage_cleanup")
            .map(|value| serde_json::from_str(value))
            .transpose()?
            .unwrap_or_else(|| json!({}));
        let inherited = match policy(&environment)? {
            Policy::Explicit(days) => days,
            Policy::Inherit => legacy
                .get("worktree_settled_after_days")
                .and_then(Value::as_i64)
                .filter(|days| (0..=3650).contains(days)),
        };
        snapshot
            .projects
            .iter()
            .map(|project| {
                let local = snapshot
                    .overrides
                    .get(&project.id)
                    .and_then(|values| values.get("worktree_cleanup"));
                let days = match local {
                    Some(value) => match policy(&serde_json::from_str(value)?)? {
                        Policy::Explicit(days) => days,
                        Policy::Inherit => inherited,
                    },
                    None => inherited,
                };
                Ok((project.id.clone(), days))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::CoreConfig;
    use crate::testing::TempDir;

    #[tokio::test]
    async fn cleanup_admission_fences_policy_writers_and_release_allows_current_writer() {
        let dir = TempDir::new();
        let core = Core::open(CoreConfig::new(
            dir.path().join("data"),
            "http://127.0.0.1:1".into(),
        ))
        .unwrap();
        let values = BTreeMap::from([("worktree_cleanup".into(), json!({"mode":"off"}))]);
        let guard = core.cleanup_policy_gate.write().await;
        assert!(matches!(
            core.set_preferences(None, &values),
            Err(CoreError::SettingsConflict)
        ));
        assert!(
            core.store
                .setting("pref:worktree_cleanup")
                .unwrap()
                .is_none()
        );
        assert!(matches!(
            core.cleanup_policy_write(["storage_cleanup"], true),
            Err(CoreError::SettingsConflict)
        ));
        assert!(
            core.cleanup_policy_write(["storage_cleanup"], false)
                .unwrap()
                .is_none()
        );
        drop(guard);
        core.set_preferences(None, &values).unwrap();
        assert_eq!(
            core.preference("worktree_cleanup", None).unwrap(),
            json!({"mode":"off"})
        );
    }

    #[tokio::test]
    async fn corrupt_persisted_policy_prevents_even_environment_cleanup_effects() {
        let dir = TempDir::new();
        let core = Core::open(CoreConfig::new(
            dir.path().join("data"),
            "http://127.0.0.1:1".into(),
        ))
        .unwrap();
        let logs = core.config.data_dir.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let file = logs.join("keep.log");
        std::fs::write(&file, "keep").unwrap();
        core.store
            .set_setting("pref:storage_cleanup", r#"{"logs_after_days":0}"#)
            .unwrap();
        core.store
            .set_setting("pref:worktree_cleanup", r#"{"mode":"corrupt"}"#)
            .unwrap();
        assert!(core.storage_cleanup(false).await.is_err());
        assert!(file.exists());
        assert!(core.cleanup_report().unwrap().is_none());
    }

    #[test]
    fn corrupt_known_policy_fails_closed_and_forward_fields_survive_nested_patch() {
        for value in [
            json!({"mode":"future"}),
            json!({"rules":{}}),
            json!({"mode":"custom","rules":null}),
            json!({"mode":"custom","rules":{"settled_after_days":"0"}}),
        ] {
            assert!(policy(&value).is_err());
        }
        let mut current = json!({"mode":"custom","future":7,"rules":{"future_rule":8}})
            .as_object()
            .unwrap()
            .clone();
        merge(
            &mut current,
            json!({"rules":{"settled_after_days":0}})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            Value::Object(current),
            json!({"mode":"custom","future":7,"rules":{"future_rule":8,"settled_after_days":0}})
        );
    }
}
