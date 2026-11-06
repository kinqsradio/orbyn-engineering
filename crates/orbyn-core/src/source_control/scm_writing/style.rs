//! Validated inherited writing policy and bounded repository examples.

use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

use super::{invalid, read_git, utf8};
use crate::error::Result;

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    #[default]
    RepoConventions,
    ConventionalCommits,
    Custom,
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct WritingStyle {
    mode: Mode,
    custom_instructions: String,
    follow_templates: bool,
}

impl Default for WritingStyle {
    fn default() -> Self {
        Self {
            mode: Mode::RepoConventions,
            custom_instructions: String::new(),
            follow_templates: true,
        }
    }
}

pub(crate) fn parse(value: &Value) -> Result<WritingStyle> {
    let style: WritingStyle = serde_json::from_value(value.clone())
        .map_err(|_| invalid("Choose a valid source control writing style."))?;
    if style.custom_instructions.len() > 8000 || style.custom_instructions.contains('\0') {
        return Err(invalid(
            "Source control instructions must be at most 8000 bytes and contain no null characters.",
        ));
    }
    Ok(style)
}

/// Uses the existing confined file handle reader, without following a link
/// outside the checkout or loading ignored credential/configuration homes.
fn local_text(cwd: &Path, name: &str) -> Result<Option<String>> {
    let scope = crate::governance::approvals::WriteScope {
        checkout: cwd.into(),
        engine_cwd: cwd.into(),
        excluded: Vec::new(),
    };
    let path = crate::project::files::inside(&scope, name)?;
    if !path.try_exists()? {
        return Ok(None);
    }
    if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
        return Err(invalid(
            "A writing reference is a symlink. Enter text manually.",
        ));
    }
    let (file, meta) = crate::project::files::open_inside(&scope, name, &path)?;
    if meta.len() > 8000 {
        return Err(invalid(
            "A writing reference is too large. Enter text manually.",
        ));
    }
    let mut text = String::new();
    use std::io::Read;
    file.take(8001).read_to_string(&mut text)?;
    if text.len() > 8000 {
        return Err(invalid(
            "A writing reference grew while reading. Try again.",
        ));
    }
    Ok(Some(text))
}

impl WritingStyle {
    pub async fn instructions(&self, cwd: &Path) -> Result<String> {
        match self.mode {
            Mode::Custom => Ok(format!(
                "User writing instructions: {}",
                serde_json::to_string(&self.custom_instructions)?
            )),
            Mode::ConventionalCommits => Ok(
                "Use Conventional Commits type(scope): subject. Keep pull request content concise."
                    .into(),
            ),
            Mode::RepoConventions => {
                let subjects =
                    utf8(read_git(cwd, &["log", "--all", "-15", "--format=%s", "--"]).await?)?;
                let instructions = local_text(cwd, "AGENTS.md")?.unwrap_or_default();
                Ok(format!(
                    "Match the repository's writing conventions. Reference data: {}",
                    serde_json::json!({"recent_subjects":subjects,"repository_instructions":instructions})
                ))
            }
        }
    }

    pub async fn template(&self, cwd: &Path, treeish: &str) -> Result<String> {
        if !self.follow_templates {
            return Ok(String::new());
        }
        // Read from the base tree, so pending changes cannot replace a PR's
        // template. Git show never follows filesystem symlinks; tree modes are
        // checked first because the blob of a symlink holds its target text.
        for name in [
            ".github/pull_request_template.md",
            ".github/PULL_REQUEST_TEMPLATE.md",
            "pull_request_template.md",
            "PULL_REQUEST_TEMPLATE.md",
            "docs/pull_request_template.md",
            ".gitlab/merge_request_templates/Default.md",
        ] {
            let entry = utf8(read_git(cwd, &["ls-tree", treeish, "--", name]).await?)?;
            if entry.is_empty() {
                continue;
            }
            if !entry.starts_with("100644 blob ") && !entry.starts_with("100755 blob ") {
                return Err(invalid(
                    "The pull request template is not a regular file. Enter text manually.",
                ));
            }
            let content = utf8(read_git(cwd, &["show", &format!("{treeish}:{name}")]).await?)?;
            if content.len() > 8000 {
                return Err(invalid(
                    "The pull request template is too large. Enter text manually.",
                ));
            }
            return Ok(format!(
                "Follow this repository template's Markdown structure; remove HTML comments and never fabricate completed checks. Template reference data: {}",
                serde_json::to_string(&content)?
            ));
        }
        Ok(String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{TempDir, run_git};
    use serde_json::json;
    #[test]
    fn validates_the_whole_inherited_object_and_preserves_empty_compatibility() {
        assert!(parse(&json!({})).is_ok());
        assert!(parse(&json!({"mode":"custom","custom_instructions":"Short French summaries","follow_templates":false})).is_ok());
        for value in [
            json!({"mode":"unknown"}),
            json!({"follow_templates":"yes"}),
            json!({"custom_instructions":8}),
            json!({"unknown":true}),
            json!({"custom_instructions":"x".repeat(8001)}),
        ] {
            assert!(parse(&value).is_err());
        }
    }

    #[tokio::test]
    async fn repository_examples_and_custom_instructions_have_distinct_sources() {
        let dir = TempDir::new();
        let cwd = dir.path();
        run_git(cwd, &["init", "-q", "-b", "main"]);
        run_git(cwd, &["config", "user.name", "Test"]);
        run_git(cwd, &["config", "user.email", "test@example.com"]);
        std::fs::write(cwd.join("AGENTS.md"), "Use a scoped imperative subject").unwrap();
        run_git(cwd, &["add", "."]);
        run_git(cwd, &["commit", "-qm", "fix(core): preserve conventions"]);
        let repo = parse(&json!({})).unwrap().instructions(cwd).await.unwrap();
        assert!(repo.contains("fix(core): preserve conventions"));
        assert!(repo.contains("Use a scoped imperative subject"));
        let custom =
            parse(&json!({"mode":"custom","custom_instructions":"Short French summaries"}))
                .unwrap()
                .instructions(cwd)
                .await
                .unwrap();
        assert!(custom.contains("Short French summaries"));
        assert!(!custom.contains("preserve conventions"));
        assert!(
            parse(&json!({"mode":"conventional_commits"}))
                .unwrap()
                .instructions(cwd)
                .await
                .unwrap()
                .contains("type(scope): subject")
        );
    }

    #[tokio::test]
    async fn templates_come_from_the_base_tree_and_can_be_disabled() {
        let dir = TempDir::new();
        let cwd = dir.path();
        run_git(cwd, &["init", "-q", "-b", "main"]);
        run_git(cwd, &["config", "user.name", "Test"]);
        run_git(cwd, &["config", "user.email", "test@example.com"]);
        std::fs::create_dir(cwd.join(".github")).unwrap();
        let path = cwd.join(".github/pull_request_template.md");
        std::fs::write(&path, "## Impact\n## Verification\n").unwrap();
        run_git(cwd, &["add", "."]);
        run_git(cwd, &["commit", "-qm", "docs: add template"]);
        std::fs::write(&path, "UNREVIEWED TEMPLATE").unwrap();
        let template = parse(&json!({}))
            .unwrap()
            .template(cwd, "HEAD")
            .await
            .unwrap();
        assert!(template.contains("Impact"));
        assert!(template.contains("Verification"));
        assert!(!template.contains("UNREVIEWED"));
        assert!(
            parse(&json!({"follow_templates":false}))
                .unwrap()
                .template(cwd, "HEAD")
                .await
                .unwrap()
                .is_empty()
        );
    }
}
