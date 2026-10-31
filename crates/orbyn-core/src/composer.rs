//! What a message needs before it can be sent: attachments and their limits,
//! mention lookups and the slash command list. Attachments live in app data,
//! never in a target.

use std::path::{Path, PathBuf};

use orbyn_contracts::{Attachment, EngineTier, Mentions, SlashCommand, ThreadMention};

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
const MAX_THREAD_RESULTS: usize = 20;
const MAX_WALKED_FILES: usize = 50_000;
const MAX_COMMAND_FILES: usize = 500;

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
        );
        // A library still being set up has no skills, but files still resolve.
        let skills = route
            .map(|route| route.selection)
            .unwrap_or_default()
            .into_iter()
            .filter(|name| name.to_lowercase().contains(&needle))
            .collect();
        let threads = self
            .store
            .list_threads(Some(&thread.project_id), false)?
            .into_iter()
            .filter(|other| other.id != thread.id)
            .filter(|other| other.title.to_lowercase().contains(&needle))
            .take(MAX_THREAD_RESULTS)
            .map(|other| ThreadMention {
                id: other.id,
                title: other.title,
            })
            .collect();
        Ok(Mentions {
            skills,
            files: matching_files(Path::new(&thread.cwd), &needle).await,
            threads,
        })
    }

    /// What `/` can offer here: the commands Orbyn handles, the commands the
    /// engine reported at its last start, and custom command files, which are
    /// only listed and never run by Orbyn. `with_skills` adds the library skills.
    pub async fn slash_commands(
        &self,
        thread_id: &str,
        with_skills: bool,
    ) -> Result<Vec<SlashCommand>> {
        let thread = self.store.thread(thread_id)?;
        // Asking for the list also fills in commands and agents for an engine that
        // has not had a session yet. A failure just leaves what is stored.
        self.engines.models(&thread.engine, false).await?;
        let driver = self.engines.driver(&thread.engine)?;
        let descriptor = driver.descriptor();
        let native = descriptor.tier == EngineTier::Native;
        let mut commands = Vec::new();
        let mut push = |name: &str, description: &str, source: &str| {
            if !commands.iter().any(|c: &SlashCommand| c.name == name) {
                commands.push(SlashCommand {
                    name: name.to_owned(),
                    description: description.to_owned(),
                    source: source.to_owned(),
                });
            }
        };
        if native {
            push(
                "compact",
                "Summarize the conversation to free up context",
                "orbyn",
            );
            push(
                "goal",
                "Keep working across turns until this is true",
                "orbyn",
            );
        }
        push("plan", "Plan without changing anything", "orbyn");
        push("default", "Leave plan mode", "orbyn");
        push("usage-limits", "Show what is left of your limits", "orbyn");
        for (name, description) in self.store.engine_commands(&thread.engine)? {
            push(&name, &description, "engine");
        }
        for agent in self.store.engine_agents(&thread.engine)? {
            push(&agent.name, &agent.description, "agent");
        }
        for folder in command_folders(&driver.family(), Path::new(&thread.cwd)) {
            for (name, description) in command_files(&folder) {
                push(&name, &description, "engine");
            }
        }
        if with_skills {
            let route = self.skills.route(
                &descriptor.capabilities.skill_delivery,
                thread.skill_profile.as_deref(),
            );
            for name in route.map(|route| route.selection).unwrap_or_default() {
                push(&name, "Library skill", "skill");
            }
        }
        Ok(commands)
    }
}

/// Where this engine keeps custom commands. Target files are only read.
fn command_folders(engine: &str, checkout: &Path) -> Vec<PathBuf> {
    let home = || {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
    };
    let dir = |name: &str, fallback: &str| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .or_else(|| home().map(|home| home.join(fallback)))
    };
    match engine {
        "claude" => [
            Some(checkout.join(".claude/commands")),
            dir("CLAUDE_CONFIG_DIR", ".claude").map(|base| base.join("commands")),
        ]
        .into_iter()
        .flatten()
        .collect(),
        "codex" => dir("CODEX_HOME", ".codex")
            .map(|base| base.join("prompts"))
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

/// `name.md` files with the `description:` line of their front matter, sorted.
fn command_files(folder: &Path) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut found: Vec<(String, String)> = entries
        .flatten()
        .take(MAX_COMMAND_FILES)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                return None;
            }
            let name = path.file_stem()?.to_str()?.to_owned();
            Some((name, front_matter_description(&path).unwrap_or_default()))
        })
        .collect();
    found.sort();
    found
}

fn front_matter_description(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    let mut lines = BufReader::new(file)
        .lines()
        .take(20)
        .map_while(|line| line.ok());
    if lines.next()?.trim() != "---" {
        return None;
    }
    lines
        .take_while(|line| line.trim() != "---")
        .find_map(|line| {
            line.strip_prefix("description:")
                .map(|text| text.trim().trim_matches(['"', '\'']).to_owned())
        })
}

/// Lower is better: a name match beats a path match, a prefix beats a substring,
/// and a shorter path breaks the tie.
fn match_rank(path: &str, needle: &str) -> Option<(u8, usize)> {
    let lower = path.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let tier = if needle.is_empty() {
        3
    } else if name == needle {
        0
    } else if name.starts_with(needle) {
        1
    } else if name.contains(needle) {
        2
    } else if lower.contains(needle) {
        3
    } else {
        return None;
    };
    Some((tier, path.len()))
}

fn rank_files(paths: impl Iterator<Item = String>, needle: &str) -> Vec<String> {
    let mut ranked: Vec<((u8, usize), String)> = paths
        .filter_map(|path| Some((match_rank(&path, needle)?, path)))
        .collect();
    ranked.sort();
    ranked
        .into_iter()
        .take(MAX_FILE_RESULTS)
        .map(|(_, path)| path)
        .collect()
}

/// A bounded walk for a folder Git does not track.
fn walk_files(root: &Path) -> Vec<String> {
    const SKIPPED: &[&str] = &[".git", "node_modules", "target", "dist", "build"];
    let mut found = Vec::new();
    let mut folders = vec![root.to_path_buf()];
    while let Some(folder) = folders.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            if found.len() >= MAX_WALKED_FILES {
                return found;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if !SKIPPED.contains(&name) {
                    folders.push(entry.path());
                }
            } else if kind.is_file()
                && let Ok(relative) = entry.path().strip_prefix(root)
            {
                found.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    found
}

/// Tracked and untracked paths, ignoring what the repository ignores.
async fn matching_files(checkout: &Path, needle: &str) -> Vec<String> {
    let listing = git(
        checkout,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )
    .await;
    match listing {
        Ok(listing) => rank_files(
            listing
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
                .map(|path| String::from_utf8_lossy(path).into_owned()),
            needle,
        ),
        Err(_) => {
            let root = checkout.to_path_buf();
            let walked = tokio::task::spawn_blocking(move || walk_files(&root))
                .await
                .unwrap_or_default();
            rank_files(walked.into_iter(), needle)
        }
    }
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
    fn file_matches_rank_names_above_paths() {
        let paths = [
            "src/app/main.rs",
            "main.rs",
            "docs/main-notes.md",
            "maintainers/a",
        ];
        let ranked = rank_files(paths.iter().map(|path| (*path).to_owned()), "main.rs");
        assert_eq!(ranked, ["main.rs", "src/app/main.rs"]);
        let ranked = rank_files(paths.iter().map(|path| (*path).to_owned()), "main");
        assert_eq!(ranked[0], "main.rs");
        assert_eq!(ranked.last().unwrap(), "maintainers/a");
    }

    #[test]
    fn command_files_keep_their_front_matter_description() {
        let dir = std::env::temp_dir().join(new_id());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("ship.md"),
            "---\ndescription: \"Ship it\"\n---\nbody",
        )
        .unwrap();
        std::fs::write(dir.join("plain.md"), "no front matter").unwrap();
        std::fs::write(dir.join("notes.txt"), "not a command").unwrap();
        assert_eq!(
            command_files(&dir),
            [
                ("plain".to_owned(), String::new()),
                ("ship".to_owned(), "Ship it".to_owned())
            ]
        );
        std::fs::remove_dir_all(dir).unwrap();
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
