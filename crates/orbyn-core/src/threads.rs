//! Thread operations that reach beyond the store: closing terminals on settle,
//! the requested title call and the periodic lifecycle tick.

use orbyn_contracts::{Thread, UpdateThread};
use serde_json::json;

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::store::{AuditRecord, LifecycleRules, TickReport};
use crate::util::unix_now;

const TITLE_CONTEXT_CHARS: usize = 8_000;
const TITLE_MAX_CHARS: usize = 80;
/// Linked pull requests are polled every second lifecycle tick.
const PULL_WATCH_TICKS: u32 = 2;

impl Core {
    pub fn update_thread(&self, id: &str, patch: &UpdateThread, actor: &str) -> Result<Thread> {
        let thread = self.store.update_thread(id, patch, actor)?;
        if patch.settled == Some(true) || patch.archived == Some(true) {
            self.terminals.close(id);
        }
        Ok(thread)
    }

    pub fn delete_thread(&self, id: &str, actor: &str) -> Result<()> {
        let files = self.store.family_attachment_paths(id)?;
        for deleted in self.store.delete_thread(id, actor)? {
            self.terminals.close(&deleted);
        }
        for file in files {
            let _ = std::fs::remove_file(file);
        }
        Ok(())
    }

    /// Asks the thread's engine for a title. This is the only path that spends
    /// usage for a title, and it runs only on request. A rename that lands while
    /// the engine is answering wins.
    pub async fn regenerate_title(&self, id: &str, actor: &str) -> Result<Thread> {
        let thread = self.store.thread(id)?;
        let conversation = self.store.transcript(id, TITLE_CONTEXT_CHARS)?;
        if conversation.trim().is_empty() {
            return Err(CoreError::Invalid(
                "This thread has no conversation to title yet.".into(),
            ));
        }
        let instructions = self.store.settings()?.title_instructions;
        let driver = self.engines.driver(&thread.engine)?;
        let prompt = format!(
            "Write a short title of at most eight words for this conversation. \
             Reply with only the title.{}\n\n<conversation>\n{conversation}\n</conversation>\n",
            instructions.map_or_else(String::new, |text| format!("\n\n{text}"))
        );
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: "engine.one_shot".into(),
            target: thread.engine.clone(),
            decision: None,
            source: "user".into(),
            thread_id: Some(id.to_owned()),
            run_id: None,
            detail: json!({ "purpose": "title" }),
        })?;
        let reply = driver.one_shot(&prompt, thread.model.as_deref()).await?;
        let title = clean_title(&reply)
            .ok_or_else(|| CoreError::EngineUnavailable("The engine returned no title.".into()))?;
        self.store
            .apply_generated_title(id, &thread.title, &title)?;
        self.store.thread(id)
    }

    /// One pass of the periodic rules. `now` is passed in so tests can move time.
    pub fn lifecycle_tick(&self, now: i64) -> Result<TickReport> {
        let settings = self.store.settings()?.auto_settle;
        let report = self.store.lifecycle_tick(LifecycleRules {
            now,
            idle_seconds: settings
                .after_days
                .map(|days| i64::from(days) * 24 * 60 * 60),
            keep_pull_requests: settings.keep_pull_requests,
        })?;
        for id in &report.settled {
            self.terminals.close(id);
        }
        Ok(report)
    }

    /// Runs the periodic rules until `stop` fires.
    pub async fn run_lifecycle(&self, stop: tokio_util::sync::CancellationToken) {
        let mut ticks = tokio::time::interval(std::time::Duration::from_secs(60));
        let mut watched: u32 = 0;
        loop {
            tokio::select! {
                () = stop.cancelled() => return,
                _ = ticks.tick() => {
                    if let Err(error) = self.lifecycle_tick(unix_now()) {
                        tracing::warn!(%error, "lifecycle tick failed");
                    }
                    watched += 1;
                    if watched.is_multiple_of(PULL_WATCH_TICKS) {
                        self.watch_pulls().await;
                    }
                }
            }
        }
    }
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
}
