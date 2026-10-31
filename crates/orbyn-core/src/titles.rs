//! Thread titles from a short engine call. Each call spends the person's engine
//! usage, so there are two ways in: the first message of a thread, unless
//! `auto_thread_titles` is off, and an explicit request.

use orbyn_contracts::{ModelInfo, Thread};
use serde_json::json;

use crate::driver::EngineDriver;
use crate::engines::EngineManager;
use crate::error::{CoreError, Result};
use crate::preferences::stored_preference;
use crate::store::{AuditRecord, Store};

pub const NEW_THREAD_TITLE: &str = "New thread";
pub const AUTO_TITLES_SETTING: &str = "auto_thread_titles";
const TEXT_MODEL_SETTING: &str = "text_generation_model";

/// How much of a first message a title sees; the start names the task.
const FIRST_MESSAGE_CHARS: usize = 2_000;
const TITLE_MAX_CHARS: usize = 80;
/// Families engines use for their small models, preferred in this order.
const SMALL_MODELS: &[&str] = &["haiku", "luna", "mini", "flash", "small"];

/// What a generated title is drawn from.
pub struct TitleCall<'a> {
    pub thread: &'a Thread,
    pub conversation: &'a str,
    pub actor: &'a str,
    pub source: &'a str,
}

/// Whether a thread in this project titles itself. An unknown project reads the
/// global value: scratch threads and the library have no project settings to win.
pub fn auto_titles_on(store: &Store, project_id: &str) -> bool {
    stored_preference(store, AUTO_TITLES_SETTING, Some(project_id))
        .or_else(|_| stored_preference(store, AUTO_TITLES_SETTING, None))
        .is_ok_and(|value| value == true)
}

/// What the first message of a thread gives a title to go on.
pub fn first_message(prompt: &str) -> String {
    prompt.chars().take(FIRST_MESSAGE_CHARS).collect()
}

/// The small model in a list, if one is recognisable by name.
fn smallest(models: &[ModelInfo]) -> Option<String> {
    SMALL_MODELS.iter().find_map(|family| {
        models
            .iter()
            .find(|model| model.id.to_lowercase().contains(family))
            .map(|model| model.id.clone())
    })
}

/// The chosen text model when this engine offers it, else its small one, else
/// the thread's own. The setting is one name and threads differ in engine, so a
/// name this engine does not list is passed over, not sent.
async fn title_model(store: &Store, engines: &EngineManager, thread: &Thread) -> Option<String> {
    let chosen = stored_preference(store, TEXT_MODEL_SETTING, None)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|model| !model.is_empty());
    let models = engines
        .models(&thread.engine, false)
        .await
        .map(|catalog| catalog.models)
        .unwrap_or_default();
    chosen
        .filter(|model| models.iter().any(|known| known.id == *model))
        .or_else(|| smallest(&models))
        .or_else(|| thread.model.clone())
}

/// Asks the engine for a title and saves it. A rename that lands while the engine
/// is answering wins, because the save names the title it replaces.
pub async fn generate_title(
    store: &Store,
    engines: &EngineManager,
    driver: &dyn EngineDriver,
    call: TitleCall<'_>,
) -> Result<bool> {
    let TitleCall {
        thread,
        conversation,
        actor,
        source,
    } = call;
    let own = crate::preferences::stored_preference(
        store,
        "project_title_instructions",
        Some(&thread.project_id),
    )?;
    let instructions = own
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
        .or(store.settings()?.title_instructions);
    let prompt = format!(
        "Write a short title of at most eight words for this conversation. \
         Reply with only the title.{}\n\n<conversation>\n{conversation}\n</conversation>\n",
        instructions.map_or_else(String::new, |text| format!("\n\n{text}"))
    );
    let model = title_model(store, engines, thread).await;
    store.append_audit(&AuditRecord {
        actor: actor.to_owned(),
        action: "engine.one_shot".into(),
        target: thread.engine.clone(),
        decision: None,
        source: source.to_owned(),
        thread_id: Some(thread.id.clone()),
        run_id: None,
        detail: json!({ "purpose": "title", "model": model }),
    })?;
    let reply = driver.one_shot(&prompt, model.as_deref()).await?;
    let title = clean_title(&reply)
        .ok_or_else(|| CoreError::EngineUnavailable("The engine returned no title.".into()))?;
    if title == NEW_THREAD_TITLE {
        return Ok(false);
    }
    store.apply_generated_title(&thread.id, &thread.title, &title)
}

fn clean_title(reply: &str) -> Option<String> {
    let line = reply.lines().map(str::trim).find(|line| !line.is_empty())?;
    let line = line.trim_matches(['"', '\'', '`', '#', '*', ' ']);
    let title: String = line.chars().take(TITLE_MAX_CHARS).collect();
    let title = title.trim().trim_end_matches('.').to_owned();
    (!title.is_empty()).then_some(title)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str) -> ModelInfo {
        ModelInfo {
            id: id.to_owned(),
            label: id.to_owned(),
            description: None,
            is_default: false,
            custom: false,
            options: Vec::new(),
            input_modalities: Vec::new(),
            upgrade: None,
        }
    }

    #[test]
    fn titles_lose_quotes_markup_and_extra_lines() {
        assert_eq!(
            clean_title("\n\"Fix the bug.\"\nmore").as_deref(),
            Some("Fix the bug")
        );
        assert_eq!(clean_title("## Heading").as_deref(), Some("Heading"));
        assert_eq!(clean_title("  \n \"\" "), None);
        assert_eq!(
            clean_title(&"x".repeat(200)).unwrap().len(),
            TITLE_MAX_CHARS
        );
    }

    #[test]
    fn the_small_model_is_found_by_family() {
        let list = [model("opus"), model("gpt-6-mini"), model("haiku")];
        assert_eq!(smallest(&list).as_deref(), Some("haiku"));
        assert_eq!(smallest(&[model("opus")]), None);
    }

    #[test]
    fn a_first_message_is_cut_on_characters() {
        assert_eq!(
            first_message(&"é".repeat(5_000)).chars().count(),
            FIRST_MESSAGE_CHARS
        );
    }
}
