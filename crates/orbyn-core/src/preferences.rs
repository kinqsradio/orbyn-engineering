//! Settings beyond `ServerSettings`, each with a default, and project overrides for
//! the ones a project may set for itself. A key not listed here cannot be stored,
//! and a value of the wrong shape is refused. Reading resolves project, then global,
//! then the project file for its two supported keys, then default. Provider
//! environments and tokens are left out under rule 1.

use std::collections::BTreeMap;

use orbyn_contracts::PreferenceView;

mod scoped;
use serde_json::{Value, json};

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::store::Store;

#[derive(Clone, Copy)]
enum Kind {
    Bool,
    Text,
    Number,
    OneOf(&'static [&'static str]),
    List,
    Object,
    Days,
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
const SUBMODULES: &[&str] = &["recursive", "top-level", "none", "top_level", "skip"];

/// Preserve older stored values without exposing their retired wire spellings.
pub(crate) fn submodule_mode(value: &str) -> &str {
    match value {
        "top_level" => "top-level",
        "skip" => "none",
        value => value,
    }
}

fn normalized(key: &str, value: Value) -> Value {
    if key == "worktree_submodules"
        && let Some(text) = value.as_str()
    {
        return json!(submodule_mode(text));
    }
    value
}
const NAMING: &[&str] = &["static", "semantic", "custom"];
const ENV_MODE: &[&str] = &["local", "worktree"];
const MERGE: &[&str] = &["", "merge", "squash", "rebase"];
const IDLE: &[&str] = &["on_return", "before_cache_expiry", "never"];

const DEFINITIONS: &[Definition] = defs![
    "response_streaming_mode" Kind::OneOf(STREAMING), "paragraph", true;
    "enable_provider_update_checks" Kind::Bool, true, false;
    "continue_threads_after_update" Kind::Bool, true, true;
    "enable_agent_browser_access" Kind::Bool, true, true;
    "preview_zoom" Kind::Number, 1, false;
    "preview_appearance" Kind::OneOf(&["system", "light", "dark"]), "system", false;
    "preview_profiles" Kind::List, [], false;
    "enable_agent_device_access" Kind::Bool, false, true;
    "auto_settle_after_days" Kind::Days, 3, true;
    "auto_settle_on_merge" Kind::Bool, true, true;
    "auto_settle_keep_pull_requests" Kind::Bool, false, true;
    "auto_pull" Kind::Bool, false, true;
    "poll_pull_requests" Kind::Bool, true, false;
    "default_project_scripts" Kind::List, [], true;
    "default_model" Kind::Text, "", true;
    "prefer_saved_login" Kind::Bool, false, false;
    "app_update_mode" Kind::OneOf(&["automatic", "notify", "off"]), "notify", false;
    "keep_awake_during_runs" Kind::Bool, true, false;
    "default_engine" Kind::Text, "", true;
    "fallback_model" Kind::Text, "", false;
    "default_permission_mode" Kind::OneOf(&["supervised", "auto_edits", "auto", "full_access"]), "supervised", true;
    "default_thread_env_mode" Kind::OneOf(ENV_MODE), "local", true;
    "new_worktrees_start_from_origin" Kind::Bool, true, true;
    "worktree_submodules" Kind::OneOf(SUBMODULES), "recursive", true;
    "worktree_location" Kind::Text, "", true;
    "add_project_base_directory" Kind::Text, "", false;
    "text_generation_model" Kind::Text, "", true;
    "auto_thread_titles" Kind::Bool, true, true;
    "project_title_instructions" Kind::Text, "", true;
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
        Kind::Days => {
            value.is_null() || value.as_u64().is_some_and(|days| (1..=365).contains(&days))
        }
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

/// Every setting as it applies globally, or in `project_id`.
pub(crate) fn stored_preferences(
    store: &Store,
    project_id: Option<&str>,
) -> Result<Vec<PreferenceView>> {
    let snapshot = store.settings_snapshot()?;
    // A no-project thread has a hidden scratch row for run ownership. Its
    // settings are environment defaults; it is not a selectable project scope.
    let project_id = match project_id {
        Some(id) if !snapshot.projects.iter().any(|project| project.id == id) => {
            if store.project(id)?.scratch {
                None
            } else {
                return Err(CoreError::NotFound("project".into()));
            }
        }
        id => id,
    };
    let files = scoped::observe_files(&snapshot, project_id)?;
    scoped::resolved_views(&snapshot, &files, project_id)
}

/// One setting's effective value.
pub(crate) fn stored_preference(
    store: &Store,
    key: &str,
    project_id: Option<&str>,
) -> Result<Value> {
    stored_preferences(store, project_id)?
        .into_iter()
        .find(|view| view.key == key)
        .map(|view| view.value)
        .ok_or_else(|| CoreError::Invalid(format!("Unknown setting {key}.")))
}

impl Core {
    pub(crate) fn project_lifecycle_settings(
        &self,
    ) -> Result<BTreeMap<String, (Option<i64>, bool)>> {
        let snapshot = self.store.settings_snapshot()?;
        snapshot
            .projects
            .iter()
            .map(|project| {
                let views = scoped::resolved_views(&snapshot, &BTreeMap::new(), Some(&project.id))?;
                let value = |key: &str| {
                    &views
                        .iter()
                        .find(|view| view.key == key)
                        .expect("fixed catalog")
                        .value
                };
                let days = value("auto_settle_after_days")
                    .as_i64()
                    .map(|days| days * 24 * 60 * 60);
                Ok((
                    project.id.clone(),
                    (
                        days,
                        value("auto_settle_keep_pull_requests") == &json!(true),
                    ),
                ))
            })
            .collect()
    }

    /// Every setting as it applies globally, or in `project_id`.
    pub fn preferences(&self, project_id: Option<&str>) -> Result<Vec<PreferenceView>> {
        stored_preferences(&self.store, project_id)
    }

    /// One setting's effective value.
    pub fn preference(&self, key: &str, project_id: Option<&str>) -> Result<Value> {
        stored_preference(&self.store, key, project_id)
    }

    /// Validates every value, then commits all preference changes in one transaction.
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
            if key == crate::engines::instances::PREFERENCE && !value.is_null() {
                let list = crate::engines::instances::parse(value)?;
                self.engines.check_instances(&list)?;
            }
        }
        self.store.change_settings(|snapshot| {
            if let Some(id) = project_id
                && !snapshot.projects.iter().any(|project| project.id == id)
            {
                return Err(CoreError::NotFound("project".into()));
            }
            let mut writes = Vec::new();
            for (key, value) in values {
                scoped::prepare_write(
                    &mut writes,
                    key,
                    project_id,
                    (!value.is_null()).then_some(value),
                );
            }
            Ok(((), writes))
        })?;
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
        self.engines.check_enabled(engine)?;
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
    fn scoped_edits_are_explicit_and_null_is_only_a_nullable_value() {
        use orbyn_contracts::{PreferenceEdit, ScopedPreferencesQuery};
        assert!(serde_json::from_value::<PreferenceEdit>(json!({"op":"set"})).is_err());
        assert!(
            serde_json::from_value::<PreferenceEdit>(json!({"op":"inherit","value":null})).is_err()
        );
        assert!(serde_json::from_value::<ScopedPreferencesQuery>(json!({})).is_err());
        assert!(serde_json::from_value::<ScopedPreferencesQuery>(json!({"scope":null})).is_err());
        assert!(check(definition("auto_settle_after_days").unwrap(), &Value::Null).is_ok());
        assert!(check(definition("auto_pull").unwrap(), &Value::Null).is_err());
    }

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

#[cfg(test)]
mod scoped_consumer_tests {
    use super::*;
    use crate::{
        CoreConfig,
        store::{NewProject, NewThread},
        testing::TempDir,
    };

    #[test]
    fn lifecycle_uses_each_projects_nullable_window_and_keeps_global_defaults_separate() {
        let dir = TempDir::new();
        let mut config = CoreConfig::new(dir.path().join("data"), "http://127.0.0.1:1".into());
        config.engines.lookup_latest = false;
        let core = Core::open(config).unwrap();
        let mut projects = Vec::new();
        let mut threads = Vec::new();
        for name in ["one", "two"] {
            let path = dir.path().join(name);
            std::fs::create_dir_all(&path).unwrap();
            let project = core
                .store
                .add_project(NewProject {
                    path: path.to_str().unwrap(),
                    name,
                    is_git: false,
                    managed: false,
                    scratch: false,
                })
                .unwrap();
            threads.push(
                core.store
                    .create_thread(NewThread {
                        project_id: project.id.clone(),
                        title: name.into(),
                        engine: "fixture".into(),
                        model: None,
                        cwd: project.path.clone(),
                        worktree: None,
                        skill_profile: None,
                        parent_thread_id: None,
                        relation: None,
                        scratch: false,
                    })
                    .unwrap(),
            );
            projects.push(project);
        }
        core.store
            .change_settings(|_| {
                Ok((
                    (),
                    vec![crate::store::scoped_settings::SettingWrite::ServerField {
                        field:
                            crate::store::scoped_settings::ServerSettingField::AutoSettleAfterDays,
                        value: Value::Null,
                    }],
                ))
            })
            .unwrap();
        core.set_preferences(
            Some(&projects[0].id),
            &BTreeMap::from([("auto_settle_after_days".into(), json!(1))]),
        )
        .unwrap();
        assert!(
            core.preference("auto_settle_after_days", None)
                .unwrap()
                .is_null()
        );
        let report = core
            .lifecycle_tick(crate::util::unix_now() + 4 * 24 * 60 * 60)
            .unwrap();
        assert_eq!(report.settled, vec![threads[0].id.clone()]);
        core.set_preferences(
            None,
            &BTreeMap::from([("response_streaming_mode".into(), json!("turn"))]),
        )
        .unwrap();
        let scratch_path = dir.path().join("scratch");
        std::fs::create_dir_all(&scratch_path).unwrap();
        let scratch = core
            .store
            .add_project(NewProject {
                path: scratch_path.to_str().unwrap(),
                name: "scratch",
                is_git: false,
                managed: false,
                scratch: true,
            })
            .unwrap();
        assert_eq!(
            core.preference("response_streaming_mode", Some(&scratch.id))
                .unwrap(),
            json!("turn")
        );
        assert!(matches!(
            core.preference("response_streaming_mode", Some("missing")),
            Err(CoreError::NotFound(_))
        ));
        assert!(
            core.store
                .thread(&threads[1].id)
                .unwrap()
                .lifecycle
                .unwrap()
                .settled_at
                .is_none()
        );
    }
}
