//! Thread operations that reach beyond the store: closing terminals on settle,
//! the requested title call and the periodic lifecycle tick.

use orbyn_contracts::{Thread, UpdateThread};

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::store::{LifecycleRules, TickReport};
use crate::titles::{TitleCall, generate_title};
use crate::util::unix_now;

const TITLE_CONTEXT_CHARS: usize = 8_000;
/// Linked pull requests are polled every second lifecycle tick.
const PULL_WATCH_TICKS: u32 = 2;

/// Automatic pull runs every 30 minutes.
const AUTO_PULL_TICKS: u32 = 30;

const LIMIT_CONTINUATION: &str = "Continue where you left off.";
/// Automatic continuations after a restart before a thread waits for you.
const MAX_RESUME_TRIES: i64 = 3;

impl Core {
    pub fn update_thread(&self, id: &str, patch: &UpdateThread, actor: &str) -> Result<Thread> {
        let thread = self.store.update_thread(id, patch, actor)?;
        if patch.settled == Some(true) || patch.archived == Some(true) {
            self.terminals.close(id);
            self.previews.close_thread(id);
        }
        if patch.settled == Some(true) {
            self.run_hook_scripts(id, |script| script.run_on_settle);
        }
        Ok(thread)
    }

    pub fn delete_thread(&self, id: &str, actor: &str) -> Result<()> {
        let files = self.store.family_attachment_paths(id)?;
        for deleted in self.store.delete_thread(id, actor)? {
            self.terminals.close(&deleted);
            self.previews.close_thread(&deleted);
        }
        for file in files {
            let _ = std::fs::remove_file(file);
        }
        Ok(())
    }

    /// Asks the thread's engine for a title again, on request.
    pub async fn regenerate_title(&self, id: &str, actor: &str) -> Result<Thread> {
        let thread = self.store.thread(id)?;
        let conversation = self.store.transcript(id, TITLE_CONTEXT_CHARS)?;
        if conversation.trim().is_empty() {
            return Err(CoreError::Invalid(
                "This thread has no conversation to title yet.".into(),
            ));
        }
        let driver = self.engines.driver(&thread.engine)?;
        generate_title(
            &self.store,
            &self.engines,
            driver.as_ref(),
            TitleCall {
                thread: &thread,
                conversation: &conversation,
                actor,
                source: "user",
            },
        )
        .await?;
        self.store.thread(id)
    }

    /// One pass of the periodic rules. `now` is passed in so tests can move time.
    pub fn lifecycle_tick(&self, now: i64) -> Result<TickReport> {
        let settings = self.store.settings()?.auto_settle;
        let report = self.store.lifecycle_tick_with_projects(
            LifecycleRules {
                now,
                idle_seconds: settings
                    .after_days
                    .map(|days| i64::from(days) * 24 * 60 * 60),
                keep_pull_requests: settings.keep_pull_requests,
            },
            &self.project_lifecycle_settings()?,
        )?;
        for id in &report.settled {
            self.terminals.close(id);
            self.previews.close_thread(id);
            self.run_hook_scripts(id, |script| script.run_on_settle);
        }
        Ok(report)
    }

    /// Starts the continuations that are due, overdue ones after a restart included.
    /// One that can't start yet stays scheduled for the next pass.
    pub fn resume_limited(&self) {
        for id in self.store.due_resumes(unix_now()).unwrap_or_default() {
            if let Err(error) = self.runs.admit(&id, LIMIT_CONTINUATION, "system:limit") {
                tracing::debug!(%error, "a limit continuation did not start");
            }
        }
    }

    /// Picks up threads a restart interrupted, unless the setting is off. A thread that
    /// keeps dying stops after a few tries, and your own message resets the count.
    pub fn continue_interrupted(&self) {
        for id in &self.recovery.interrupted_threads {
            let enabled = self.store.thread(id).ok().is_some_and(|thread| {
                self.preference("continue_threads_after_update", Some(&thread.project_id))
                    .is_ok_and(|on| on == serde_json::json!(true))
            });
            if !enabled {
                continue;
            }
            if !self
                .store
                .take_resume_try(id, MAX_RESUME_TRIES)
                .unwrap_or(false)
            {
                continue;
            }
            if let Err(error) = self.runs.admit(id, LIMIT_CONTINUATION, "system:restart") {
                tracing::debug!(%error, "a thread did not continue after the restart");
            }
        }
    }

    /// Runs the periodic rules until `stop` fires.
    pub async fn run_lifecycle(&self, stop: tokio_util::sync::CancellationToken) {
        self.continue_interrupted();
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
                    let polling = self.preference("poll_pull_requests", None);
                    if watched.is_multiple_of(PULL_WATCH_TICKS)
                        && polling.is_ok_and(|on| on != serde_json::json!(false))
                    {
                        self.watch_pulls().await;
                    }
                    self.resume_limited();
                    self.run_due_tasks().await;
                    if let Ok(mode) = self.preference("app_update_mode", None) {
                        self.updates.auto_install(mode.as_str().unwrap_or_default()).await;
                    }
                    if watched.is_multiple_of(AUTO_PULL_TICKS) {
                        self.auto_pull().await;
                    }
                }
            }
        }
    }
}
