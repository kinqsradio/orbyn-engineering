//! Review guides: an agent's stop-by-stop reading order for one pull request.
//! The guide itself is written by the agent through `orbyn_pull_guide_write`;
//! this module shows it and starts the thread that writes it. A guide is this
//! service's own and never reaches the forge.

use std::path::Path;

use orbyn_contracts::{CreateThread, GeneratePullGuide, PullGuideState, Thread};
use serde_json::{Value, json};

use crate::Core;
use crate::error::{CoreError, Result};
use crate::forge;

const ENABLED: &str = "review_guides_enabled";
const INSTRUCTIONS: &str = "review_guide_instructions";
const MODEL: &str = "review_guide_model";

fn text_preference(value: Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

impl Core {
    fn guides_enabled(&self, project_id: &str) -> Result<bool> {
        Ok(self.preference(ENABLED, Some(project_id))? == json!(true))
    }

    /// The asked model, else the project's review guide model, else the
    /// engine's own default.
    fn guide_model(&self, project_id: &str, asked: &Option<String>) -> Result<Option<String>> {
        Ok(match asked.as_deref().map(str::trim) {
            Some(model) if !model.is_empty() => Some(model.to_owned()),
            _ => text_preference(self.preference(MODEL, Some(project_id))?),
        })
    }

    pub fn pull_guide_state(&self, project_id: &str, number: u64) -> Result<PullGuideState> {
        self.store.project(project_id)?;
        Ok(PullGuideState {
            enabled: self.guides_enabled(project_id)?,
            guide: self.store.pull_guide(project_id, number)?,
        })
    }

    /// A thread in the project root, linked to the pull request, whose first
    /// message asks the agent to read the change and write the guide.
    pub async fn generate_pull_guide(
        &self,
        project_id: &str,
        number: u64,
        request: &GeneratePullGuide,
    ) -> Result<Thread> {
        if !self.guides_enabled(project_id)? {
            return Err(CoreError::Invalid(
                "Review guides are off for this project.".into(),
            ));
        }
        let project = self.store.project(project_id)?;
        let detail = self.project_pull(project_id, number).await?;
        let program = forge::forge_of(Path::new(&project.path))
            .await?
            .program()
            .unwrap_or("gh");
        let instructions = text_preference(self.preference(INSTRUCTIONS, Some(project_id))?);
        let prompt = guide_prompt(
            number,
            &detail.pull.title,
            detail.head_sha.as_deref(),
            program,
            instructions.as_deref(),
        );
        let thread = self
            .create_thread(CreateThread {
                project_id: Some(project_id.to_owned()),
                engine: request.engine.clone(),
                model: self.guide_model(project_id, &request.model)?,
                title: Some(format!("Review guide for #{number}")),
                worktree: None,
                skill_profile: None,
                base_branch: None,
                effort: None,
                options: Default::default(),
            })
            .await?;
        self.store.link_pull(&thread.id, &detail.pull)?;
        self.runs.enqueue(&thread.id, &prompt, &[])?;
        self.store.thread(&thread.id)
    }
}

fn guide_prompt(
    number: u64,
    title: &str,
    head_sha: Option<&str>,
    program: &str,
    instructions: Option<&str>,
) -> String {
    let head = head_sha.map_or_else(String::new, |sha| format!(" at commit {sha}"));
    let pass_head = head_sha.map_or_else(String::new, |sha| format!(", head_sha \"{sha}\""));
    let mut prompt = format!(
        "Write a review guide for pull request #{number}, \"{title}\"{head}.\n\n\
         Read the pull request and its diff with `{program}`. Change nothing: no edits, \
         commits, comments or reviews.\n\n\
         Then call `orbyn_pull_guide_write` once with number {number}{pass_head} and the \
         stops a reviewer should take, in reading order, at most 30. Each stop has a short \
         title, a summary of what changed and why, the files it covers with a note on what \
         to check in each, and the questions a reviewer should ask there."
    );
    if let Some(instructions) = instructions {
        prompt.push_str("\n\nThis project's guide instructions:\n");
        prompt.push_str(instructions);
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_names_the_tool_the_head_and_the_instructions() {
        let prompt = guide_prompt(7, "Add X", Some("abc123"), "glab", Some("Be brief."));
        assert!(prompt.contains("#7, \"Add X\" at commit abc123"));
        assert!(prompt.contains("`glab`"));
        assert!(
            prompt.contains("`orbyn_pull_guide_write` once with number 7, head_sha \"abc123\"")
        );
        assert!(prompt.ends_with("This project's guide instructions:\nBe brief."));
        let bare = guide_prompt(7, "Add X", None, "gh", None);
        assert!(!bare.contains("head_sha"));
        assert!(!bare.contains("instructions:"));
    }
}
