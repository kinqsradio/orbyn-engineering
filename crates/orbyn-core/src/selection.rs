//! What a turn asks of its engine: model, effort and each model's other options.
//! A choice is checked against what the engine reported, so a value the model does
//! not offer is refused rather than dropped on the way to the engine.

use std::collections::BTreeMap;

use orbyn_contracts::{EngineModels, ModelInfo, ModelOption, ModelSelection, Thread};

use crate::app::Core;
use crate::error::{CoreError, Result};

pub const EFFORT: &str = "effort";
pub const SERVICE_TIER: &str = "service_tier";
pub const FAST_MODE: &str = "fast_mode";
pub const MODE: &str = "mode";
/// The service tier that means no tier was asked for.
pub const STANDARD_TIER: &str = "default";

pub fn of_thread(thread: &Thread) -> ModelSelection {
    ModelSelection {
        model: thread.model.clone(),
        effort: thread.effort.clone(),
        options: thread.options.clone(),
    }
}

/// `changes` over `base`, by the rules of a thread update: an empty string goes
/// back to the engine's default.
pub fn merged(base: &ModelSelection, changes: &ModelSelection) -> ModelSelection {
    let pick = |change: &Option<String>, current: &Option<String>| match change.as_deref() {
        Some(value) if value.trim().is_empty() => None,
        Some(value) => Some(value.trim().to_owned()),
        None => current.clone(),
    };
    let mut options: BTreeMap<String, String> = base.options.clone();
    for (key, value) in &changes.options {
        if value.trim().is_empty() {
            options.remove(key);
        } else {
            options.insert(key.clone(), value.trim().to_owned());
        }
    }
    ModelSelection {
        model: pick(&changes.model, &base.model),
        effort: pick(&changes.effort, &base.effort),
        options,
    }
}

pub fn is_empty(selection: &ModelSelection) -> bool {
    selection.model.is_none() && selection.effort.is_none() && selection.options.is_empty()
}

/// The model a selection means: the one named, or the engine's default.
fn chosen<'a>(catalog: &'a EngineModels, selection: &ModelSelection) -> Option<&'a ModelInfo> {
    match &selection.model {
        Some(id) => catalog.models.iter().find(|model| model.id == *id),
        None => catalog.models.iter().find(|model| model.is_default),
    }
}

/// True when this list is the engine's own answer. A stand-in list, a failed
/// listing and an engine that cannot list say nothing about what it accepts.
fn authoritative(catalog: &EngineModels) -> bool {
    catalog.source == "engine" && !catalog.fallback && catalog.error.is_none()
}

fn check_value(option: &ModelOption, model: &str, value: &str) -> Result<()> {
    if option.values.iter().any(|known| known.id == value) {
        return Ok(());
    }
    let offered: Vec<&str> = option
        .values
        .iter()
        .map(|known| known.id.as_str())
        .collect();
    Err(CoreError::UnsupportedOption(format!(
        "{model} does not offer {value} for {}. It offers: {}.",
        option.label,
        offered.join(", ")
    )))
}

/// Refuses a value the chosen model does not offer. A model the engine did not
/// list can still be a custom one, so only its engine-wide options are checked.
pub fn check(catalog: &EngineModels, selection: &ModelSelection) -> Result<()> {
    if !authoritative(catalog) {
        return Ok(());
    }
    let model = chosen(catalog, selection);
    let listed_any = !catalog.models.is_empty();
    let name = model.map_or("This model", |model| model.label.as_str());
    let find = |id: &str| {
        model
            .into_iter()
            .flat_map(|model| &model.options)
            .chain(&catalog.options)
            .find(|option| option.id == id)
    };
    let unknown_model = selection.model.is_some() && model.is_none();
    if let Some(effort) = &selection.effort {
        match find(EFFORT) {
            Some(option) => check_value(option, name, effort)?,
            None if unknown_model || !listed_any => {}
            None => {
                return Err(CoreError::UnsupportedOption(format!(
                    "{name} has no effort setting."
                )));
            }
        }
    }
    for (id, value) in &selection.options {
        match find(id) {
            Some(option) => check_value(option, name, value)?,
            None if unknown_model => {}
            None => {
                return Err(CoreError::UnsupportedOption(format!(
                    "{name} has no {id} setting."
                )));
            }
        }
    }
    Ok(())
}

/// Fills in the catalog's defaults, for an engine that keeps a turn's overrides for
/// the turns after it: leaving a value out there would keep the old one, so going
/// back to the default has to be said.
pub fn with_defaults(catalog: &EngineModels, selection: &ModelSelection) -> ModelSelection {
    let mut filled = selection.clone();
    let Some(model) = chosen(catalog, selection) else {
        return filled;
    };
    filled.model.get_or_insert_with(|| model.id.clone());
    let default_of = |id: &str| {
        let option = model.options.iter().find(|option| option.id == id)?;
        let value = option.values.iter().find(|value| value.default)?;
        Some(value.id.clone())
    };
    if filled.effort.is_none() {
        filled.effort = default_of(EFFORT);
    }
    if !filled.options.contains_key(SERVICE_TIER)
        && let Some(tier) = default_of(SERVICE_TIER)
    {
        filled.options.insert(SERVICE_TIER.to_owned(), tier);
    }
    filled
}

impl Core {
    /// Refuses `changes` if this thread could not run with them. It asks the engine
    /// first, so the check does not depend on someone having opened the picker.
    pub async fn check_turn(&self, thread_id: &str, changes: &ModelSelection) -> Result<()> {
        let thread = self.store.thread(thread_id)?;
        let wanted = merged(&of_thread(&thread), changes);
        if is_empty(&wanted) {
            return Ok(());
        }
        check(&self.engines.models(&thread.engine, false).await?, &wanted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use orbyn_contracts::ModelOptionValue;

    fn value(id: &str, default: bool) -> ModelOptionValue {
        ModelOptionValue {
            id: id.into(),
            label: id.into(),
            default,
            description: None,
        }
    }

    fn option(id: &str, values: &[(&str, bool)]) -> ModelOption {
        ModelOption {
            id: id.into(),
            label: id.into(),
            values: values.iter().map(|(id, on)| value(id, *on)).collect(),
        }
    }

    fn model(id: &str, default: bool, options: Vec<ModelOption>) -> ModelInfo {
        ModelInfo {
            id: id.into(),
            label: id.into(),
            description: None,
            is_default: default,
            custom: false,
            options,
            input_modalities: Vec::new(),
            upgrade: None,
        }
    }

    fn catalog() -> EngineModels {
        EngineModels {
            engine: "e".into(),
            source: "engine".into(),
            models: vec![
                model(
                    "big",
                    true,
                    vec![
                        option(EFFORT, &[("low", false), ("high", true)]),
                        option(SERVICE_TIER, &[(STANDARD_TIER, false), ("flex", true)]),
                    ],
                ),
                model("small", false, Vec::new()),
            ],
            error: None,
            checked_at: String::new(),
            fallback: false,
            options: vec![option(MODE, &[("plan", false)])],
            agents: Vec::new(),
            output_styles: Vec::new(),
            output_style: None,
            remembered: None,
        }
    }

    fn pick(model: Option<&str>, effort: Option<&str>, options: &[(&str, &str)]) -> ModelSelection {
        ModelSelection {
            model: model.map(str::to_owned),
            effort: effort.map(str::to_owned),
            options: options
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
        }
    }

    #[test]
    fn a_value_the_model_offers_passes_and_any_other_is_refused_with_a_stable_code() {
        let catalog = catalog();
        check(&catalog, &pick(Some("big"), Some("low"), &[])).unwrap();
        check(&catalog, &pick(None, Some("high"), &[(MODE, "plan")])).unwrap();
        let refused = check(&catalog, &pick(Some("big"), Some("max"), &[])).unwrap_err();
        assert_eq!(refused.code(), "unsupported_option");
        assert!(refused.to_string().contains("low, high"), "{refused}");
        assert_eq!(
            check(&catalog, &pick(Some("small"), Some("low"), &[]))
                .unwrap_err()
                .code(),
            "unsupported_option"
        );
        assert_eq!(
            check(
                &catalog,
                &pick(Some("small"), None, &[(SERVICE_TIER, "flex")])
            )
            .unwrap_err()
            .code(),
            "unsupported_option"
        );
    }

    #[test]
    fn a_custom_model_passes_but_an_engine_wide_option_still_counts() {
        let catalog = catalog();
        check(&catalog, &pick(Some("mine"), Some("anything"), &[])).unwrap();
        assert!(check(&catalog, &pick(Some("mine"), None, &[(MODE, "nope")])).is_err());
    }

    #[test]
    fn a_list_that_is_not_the_engines_answer_refuses_nothing() {
        let mut stand_in = catalog();
        stand_in.fallback = true;
        check(&stand_in, &pick(Some("big"), Some("max"), &[])).unwrap();
        let mut failed = catalog();
        failed.error = Some("no".into());
        check(&failed, &pick(Some("big"), Some("max"), &[])).unwrap();
        let mut unknown = catalog();
        unknown.source = "none".into();
        check(&unknown, &pick(None, Some("max"), &[])).unwrap();
    }

    #[test]
    fn defaults_fill_what_is_unset_and_leave_a_choice_alone() {
        let filled = with_defaults(&catalog(), &ModelSelection::default());
        assert_eq!(filled.model.as_deref(), Some("big"));
        assert_eq!(filled.effort.as_deref(), Some("high"));
        assert_eq!(filled.options[SERVICE_TIER], "flex");
        let kept = with_defaults(
            &catalog(),
            &pick(Some("big"), Some("low"), &[(SERVICE_TIER, STANDARD_TIER)]),
        );
        assert_eq!(kept.effort.as_deref(), Some("low"));
        assert_eq!(kept.options[SERVICE_TIER], STANDARD_TIER);
        let bare = with_defaults(&catalog(), &pick(Some("small"), None, &[]));
        assert_eq!(bare.effort, None);
        assert!(bare.options.is_empty());
    }

    #[test]
    fn merging_follows_the_update_rules() {
        let base = pick(Some("big"), Some("low"), &[("a", "1"), ("b", "2")]);
        let result = merged(&base, &pick(None, Some(""), &[("a", ""), ("c", "3")]));
        assert_eq!(result.model.as_deref(), Some("big"));
        assert_eq!(result.effort, None);
        assert_eq!(
            result.options.into_iter().collect::<Vec<_>>(),
            vec![
                ("b".to_owned(), "2".to_owned()),
                ("c".to_owned(), "3".to_owned())
            ]
        );
    }
}
