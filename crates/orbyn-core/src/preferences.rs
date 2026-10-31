//! Settings beyond `ServerSettings`, each with a default, and project overrides for
//! the ones a project may set for itself. A key not listed here cannot be stored,
//! and a value of the wrong shape is refused. Reading resolves project, then global,
//! then default. Nothing here holds a secret: provider environments and tokens are
//! left out under rule 1.

use std::collections::BTreeMap;

use orbyn_contracts::PreferenceView;
use serde_json::{Value, json};

use crate::app::Core;
use crate::error::{CoreError, Result};

#[derive(Clone, Copy)]
enum Kind {
    Bool,
    Text,
    Number,
    OneOf(&'static [&'static str]),
    List,
    Object,
}

struct Definition {
    key: &'static str,
    kind: Kind,
    default: fn() -> Value,
    project: bool,
}

macro_rules! defs {
    ($($key:literal $kind:expr, $default:tt, $project:literal;)*) => {
        &[$(Definition { key: $key, kind: $kind, default: || json!($default), project: $project },)*]
    };
}

const BACKGROUND: &[&str] = &["balanced", "saver", "performance"];
const STREAMING: &[&str] = &["paragraph", "turn"];
const SUBMODULES: &[&str] = &["recursive", "top_level", "skip"];
const NAMING: &[&str] = &["static", "semantic", "custom"];
const ENV_MODE: &[&str] = &["local", "worktree"];
const MERGE: &[&str] = &["", "merge", "squash", "rebase"];
const IDLE: &[&str] = &["on_return", "before_cache_expiry", "never"];

const DEFINITIONS: &[Definition] = defs![
    "response_streaming_mode" Kind::OneOf(STREAMING), "paragraph", false;
    "enable_provider_update_checks" Kind::Bool, true, false;
    "continue_threads_after_update" Kind::Bool, true, false;
    "enable_agent_browser_access" Kind::Bool, true, true;
    "enable_agent_device_access" Kind::Bool, false, false;
    "auto_pull" Kind::Bool, false, true;
    "default_project_scripts" Kind::List, [], true;
    "default_model" Kind::Text, "", true;
    "prefer_saved_login" Kind::Bool, false, false;
    "app_update_mode" Kind::OneOf(&["automatic", "notify", "off"]), "notify", false;
    "default_engine" Kind::Text, "", true;
    "fallback_model" Kind::Text, "", false;
    "default_permission_mode" Kind::OneOf(&["supervised", "auto_edits", "auto", "full_access"]), "supervised", true;
    "default_thread_env_mode" Kind::OneOf(ENV_MODE), "local", true;
    "new_worktrees_start_from_origin" Kind::Bool, true, true;
    "worktree_submodules" Kind::OneOf(SUBMODULES), "recursive", true;
    "add_project_base_directory" Kind::Text, "", false;
    "text_generation_model" Kind::Text, "", false;
    "branch_naming_mode" Kind::OneOf(NAMING), "static", true;
    "branch_name_prefix" Kind::Text, "feat", true;
    "branch_name_instructions" Kind::Text, "", true;
    "remove_agent_credits_on_merge" Kind::Bool, false, true;
    "source_control_writing_style" Kind::Object, {}, true;
    "review_guides_enabled" Kind::Bool, false, true;
    "review_guide_instructions" Kind::Text, "", true;
    "pull_request_merge_method" Kind::OneOf(MERGE), "", true;
    "compact_idle_threads" Kind::Bool, false, false;
    "idle_compaction" Kind::OneOf(IDLE), "never", false;
    "snooze_limited_threads" Kind::Bool, false, false;
    "auto_resume_limited_threads" Kind::Bool, false, false;
    "background_activity_profile" Kind::OneOf(BACKGROUND), "balanced", false;
    "automatic_git_fetch_minutes" Kind::Number, 5, false;
    "provider_health_refresh_minutes" Kind::Number, 5, false;
    "default_theme" Kind::Text, "", false;
    "environment_icon" Kind::Text, "", false;
    "observability" Kind::Object, {}, false;
    "storage_cleanup" Kind::Object, {}, true;
    "favorite_models" Kind::List, [], false;
    "hidden_models" Kind::List, [], false;
    "model_order" Kind::List, [], false;
    "custom_models" Kind::List, [], false;
    "disabled_engines" Kind::List, [], true;
    "provider_instances" Kind::List, [], false;
];

fn definition(key: &str) -> Result<&'static Definition> {
    DEFINITIONS
        .iter()
        .find(|definition| definition.key == key)
        .ok_or_else(|| CoreError::Invalid(format!("Unknown setting {key}.")))
}

fn check(definition: &Definition, value: &Value) -> Result<()> {
    let fits = match definition.kind {
        Kind::Bool => value.is_boolean(),
        Kind::Text => value.is_string(),
        Kind::Number => value.as_f64().is_some_and(|number| number >= 0.0),
        Kind::OneOf(choices) => value.as_str().is_some_and(|text| choices.contains(&text)),
        Kind::List => value.is_array(),
        Kind::Object => value.is_object(),
    };
    if fits {
        Ok(())
    } else {
        Err(CoreError::Invalid(format!(
            "That is not a valid value for {}.",
            definition.key
        )))
    }
}

fn setting_key(key: &str) -> String {
    format!("pref:{key}")
}

impl Core {
    /// Every setting as it applies globally, or in `project_id`.
    pub fn preferences(&self, project_id: Option<&str>) -> Result<Vec<PreferenceView>> {
        let own: BTreeMap<String, String> = match project_id {
            Some(project) => {
                self.store.project(project)?;
                self.store
                    .project_preferences(project)?
                    .into_iter()
                    .collect()
            }
            None => BTreeMap::new(),
        };
        DEFINITIONS
            .iter()
            .map(|definition| {
                let default = (definition.default)();
                let global = self.store.setting(&setting_key(definition.key))?;
                let local = own.get(definition.key).filter(|_| definition.project);
                let (value, source) = match (local, global) {
                    (Some(text), _) => (serde_json::from_str(text)?, "project"),
                    (None, Some(text)) => (serde_json::from_str(&text)?, "global"),
                    (None, None) => (default.clone(), "default"),
                };
                Ok(PreferenceView {
                    key: definition.key.to_owned(),
                    value,
                    default,
                    source: source.to_owned(),
                    project_scoped: definition.project,
                })
            })
            .collect()
    }

    /// One setting's effective value.
    pub fn preference(&self, key: &str, project_id: Option<&str>) -> Result<Value> {
        self.preferences(project_id)?
            .into_iter()
            .find(|view| view.key == key)
            .map(|view| view.value)
            .ok_or_else(|| CoreError::Invalid(format!("Unknown setting {key}.")))
    }

    /// Applies all of a change or none: every value is checked before any is kept.
    pub fn set_preferences(
        &self,
        project_id: Option<&str>,
        values: &BTreeMap<String, Value>,
    ) -> Result<()> {
        for (key, value) in values {
            let definition = definition(key)?;
            if project_id.is_some() && !definition.project {
                return Err(CoreError::Invalid(format!("{key} is not set per project.")));
            }
            if !value.is_null() {
                check(definition, value)?;
            }
        }
        for (key, value) in values {
            let text = (!value.is_null()).then(|| value.to_string());
            match (project_id, text) {
                (Some(project), text) => {
                    self.store
                        .set_project_preference(project, key, text.as_deref())?;
                }
                (None, Some(text)) => self.store.set_setting(&setting_key(key), &text)?,
                (None, None) => self.store.clear_setting(&setting_key(key))?,
            }
        }
        self.apply_login_preference()
    }

    /// Spawning has no store, so this preference is handed to it directly.
    pub(crate) fn apply_login_preference(&self) -> Result<()> {
        let prefer = self.preference("prefer_saved_login", None)?;
        crate::child_env::set_prefer_saved_login(prefer == json!(true));
        Ok(())
    }

    /// The project's default model, when it applies to this engine.
    pub fn project_default_model(&self, engine: &str, project_id: &str) -> Result<Option<String>> {
        let text = |key: &str| -> Result<String> {
            Ok(self
                .preference(key, Some(project_id))?
                .as_str()
                .unwrap_or_default()
                .to_owned())
        };
        let default_engine = text("default_engine")?;
        let model = text("default_model")?;
        let applies = default_engine.is_empty() || default_engine == engine;
        Ok((applies && !model.is_empty()).then_some(model))
    }

    /// Refuses an engine this project turned off.
    pub fn check_engine_enabled(&self, engine: &str, project_id: &str) -> Result<()> {
        let disabled = self.preference("disabled_engines", Some(project_id))?;
        let off = disabled
            .as_array()
            .is_some_and(|list| list.iter().any(|item| item.as_str() == Some(engine)));
        if off {
            return Err(CoreError::Invalid(format!(
                "{engine} is turned off for this project."
            )));
        }
        Ok(())
    }

    /// The engine's models with custom ones added and hidden ones removed, in the
    /// saved order, then the engine's own.
    pub async fn engine_models(
        &self,
        id: &str,
        refresh: bool,
    ) -> Result<orbyn_contracts::EngineModels> {
        let mut models = self.engines.models(id, refresh).await?;
        let list = |key: &str| -> Result<Vec<Value>> {
            Ok(self
                .preference(key, None)?
                .as_array()
                .cloned()
                .unwrap_or_default())
        };
        for custom in list("custom_models")? {
            let field = |key: &str| custom.get(key).and_then(Value::as_str);
            let (Some(engine), Some(model)) = (field("engine"), field("id")) else {
                continue;
            };
            if engine == id && !models.models.iter().any(|known| known.id == model) {
                models.models.push(orbyn_contracts::ModelInfo {
                    id: model.to_owned(),
                    label: field("label").unwrap_or(model).to_owned(),
                    description: None,
                    is_default: false,
                    custom: true,
                    options: Vec::new(),
                    input_modalities: Vec::new(),
                    upgrade: None,
                });
            }
        }
        let named = |model: &str| json!(format!("{id}:{model}"));
        let hidden = list("hidden_models")?;
        models
            .models
            .retain(|model| !hidden.contains(&named(&model.id)));
        let order = list("model_order")?;
        models.models.sort_by_key(|model| {
            order
                .iter()
                .position(|entry| *entry == named(&model.id))
                .unwrap_or(usize::MAX)
        });
        let remembered = self.store.remembered_selection(id)?;
        models.remembered = (!crate::selection::is_empty(&remembered)).then_some(remembered);
        Ok(models)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_fit_their_own_rules_and_keys_are_unique() {
        for definition in DEFINITIONS {
            check(definition, &(definition.default)()).unwrap();
            let same = DEFINITIONS
                .iter()
                .filter(|d| d.key == definition.key)
                .count();
            assert_eq!(same, 1, "{}", definition.key);
        }
    }

    #[test]
    fn shapes_are_enforced() {
        let submodules = definition("worktree_submodules").unwrap();
        assert!(check(submodules, &json!("skip")).is_ok());
        assert!(check(submodules, &json!("sometimes")).is_err());
        assert!(check(definition("auto_pull").unwrap(), &json!("yes")).is_err());
        assert!(definition("api_token").is_err());
    }
}
