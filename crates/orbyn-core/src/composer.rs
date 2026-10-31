//! What a message needs before it can be sent: attachments and their limits,
//! mention lookups and the slash command list. Attachments live in app data,
//! never in a target.

use std::path::{Path, PathBuf};

use orbyn_contracts::{Attachment, EngineTier, Mentions, SlashCommand};

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::git::git;
use crate::util::{new_id, now};

pub const MAX_PROMPT_CHARS: usize = 120_000;
pub const MAX_ATTACHMENTS: usize = 100;
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_IMAGES_TOTAL: u64 = 80 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_FILE_RESULTS: usize = 50;

pub fn check_prompt(prompt: &str) -> Result<()> {
    if prompt.trim().is_empty() {
        return Err(CoreError::Invalid("Enter a prompt to start a run.".into()));
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(CoreError::Invalid(format!(
            "Messages can be up to {MAX_PROMPT_CHARS} characters."
        )));
    }
    Ok(())
}

fn is_image(mime: &str) -> bool {
    mime.starts_with("image/")
}

/// The file name alone, so a name cannot steer where the upload lands.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.');
    if trimmed.is_empty() {
        "attachment".to_owned()
    } else {
        trimmed.chars().take(200).collect()
    }
}

fn check_limits(existing: &[Attachment], mime: &str, size: u64) -> Result<()> {
    if existing.len() >= MAX_ATTACHMENTS {
        return Err(CoreError::Invalid(
            "A thread can hold 100 attachments.".into(),
        ));
    }
    if is_image(mime) {
        if size > MAX_IMAGE_BYTES {
            return Err(CoreError::Invalid("Images can be up to 10 MiB.".into()));
        }
        let total: u64 = existing
            .iter()
            .filter(|attachment| is_image(&attachment.mime))
            .map(|attachment| attachment.size)
            .sum();
        if total + size > MAX_IMAGES_TOTAL {
            return Err(CoreError::Invalid("Images can total up to 80 MiB.".into()));
        }
    } else if size > MAX_FILE_BYTES {
        return Err(CoreError::Invalid("Files can be up to 50 MiB.".into()));
    }
    Ok(())
}

impl Core {
    fn attachments_dir(&self) -> PathBuf {
        self.config.data_dir.join("attachments")
    }

    /// Stores an upload. The record exists only once the bytes are in place, so a
    /// message can never reference a half-written file.
    pub fn add_attachment(
        &self,
        thread_id: &str,
        name: &str,
        mime: &str,
        bytes: &[u8],
    ) -> Result<Attachment> {
        self.store.thread(thread_id)?;
        let existing: Vec<Attachment> = self
            .store
            .list_attachments(thread_id)?
            .into_iter()
            .map(|(attachment, _)| attachment)
            .collect();
        check_limits(&existing, mime, bytes.len() as u64)?;
        let id = new_id();
        let name = safe_name(name);
        let dir = self.attachments_dir();
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{id}-{name}"));
        let partial = dir.join(format!("{id}.partial"));
        std::fs::write(&partial, bytes)?;
        std::fs::rename(&partial, &path)?;
        let attachment = Attachment {
            id,
            thread_id: thread_id.to_owned(),
            name,
            mime: mime.to_owned(),
            size: bytes.len() as u64,
            created_at: now(),
        };
        if let Err(error) = self
            .store
            .add_attachment(&attachment, &path.to_string_lossy())
        {
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
        Ok(attachment)
    }

    pub fn remove_attachment(&self, id: &str) -> Result<()> {
        let path = self.store.remove_attachment(id)?;
        let _ = std::fs::remove_file(path);
        Ok(())
    }

    pub async fn mentions(&self, thread_id: &str, query: &str) -> Result<Mentions> {
        let thread = self.store.thread(thread_id)?;
        let needle = query.to_lowercase();
        let driver = self.engines.driver(&thread.engine)?;
        let route = self.skills.route(
            &driver.descriptor().capabilities.skill_delivery,
            thread.skill_profile.as_deref(),
        )?;
        let skills = route
            .selection
            .into_iter()
            .filter(|name| name.to_lowercase().contains(&needle))
            .collect();
        Ok(Mentions {
            skills,
            files: matching_files(Path::new(&thread.cwd), &needle).await,
        })
    }

    pub fn slash_commands(&self, thread_id: &str) -> Result<Vec<SlashCommand>> {
        let thread = self.store.thread(thread_id)?;
        let tier = self.engines.driver(&thread.engine)?.descriptor().tier;
        let command = |name: &str, description: &str| SlashCommand {
            name: name.to_owned(),
            description: description.to_owned(),
        };
        Ok(if tier == EngineTier::Native {
            vec![
                command("compact", "Summarize the conversation to free up context"),
                command("goal", "Keep working across turns until this is true"),
            ]
        } else {
            Vec::new()
        })
    }
}

/// Tracked and untracked paths, ignoring what the repository ignores.
async fn matching_files(checkout: &Path, needle: &str) -> Vec<String> {
    let Ok(listing) = git(
        checkout,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )
    .await
    else {
        return Vec::new();
    };
    listing
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .filter(|path| path.to_lowercase().contains(needle))
        .take(MAX_FILE_RESULTS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(mime: &str, size: u64) -> Attachment {
        Attachment {
            id: "a".into(),
            thread_id: "t".into(),
            name: "n".into(),
            mime: mime.into(),
            size,
            created_at: String::new(),
        }
    }

    #[test]
    fn prompt_limit_counts_characters_not_bytes() {
        assert!(check_prompt(&"é".repeat(MAX_PROMPT_CHARS)).is_ok());
        assert!(check_prompt(&"x".repeat(MAX_PROMPT_CHARS + 1)).is_err());
        assert!(check_prompt("   ").is_err());
    }

    #[test]
    fn limits_follow_kind_and_totals() {
        assert!(check_limits(&[], "image/png", MAX_IMAGE_BYTES).is_ok());
        assert!(check_limits(&[], "image/png", MAX_IMAGE_BYTES + 1).is_err());
        assert!(check_limits(&[], "text/plain", MAX_FILE_BYTES).is_ok());
        assert!(check_limits(&[], "text/plain", MAX_FILE_BYTES + 1).is_err());
        let images = vec![stored("image/png", MAX_IMAGE_BYTES); 8];
        assert!(check_limits(&images, "image/png", 1).is_err());
        assert!(check_limits(&images, "text/plain", 1).is_ok());
        let full = vec![stored("text/plain", 1); MAX_ATTACHMENTS];
        assert!(check_limits(&full, "text/plain", 1).is_err());
    }

    #[test]
    fn names_cannot_steer_the_path() {
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name(r"C:\x\report.pdf"), "report.pdf");
        assert_eq!(safe_name(".."), "attachment");
        assert_eq!(safe_name(""), "attachment");
        assert_eq!(safe_name(".hidden"), "hidden");
    }
}
