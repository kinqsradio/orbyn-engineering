//! Scheduled tasks and the webhook delivery log.

use orbyn_contracts::{Run, ScheduledTask, TaskRun, WebhookDelivery};
use rusqlite::{OptionalExtension, params};

use super::{Store, run_row};
use crate::error::{CoreError, Result};

/// A task's delivery log keeps this many rows.
const MAX_DELIVERIES: i64 = 200;
/// A task's run history keeps this many rows.
const MAX_TASK_RUNS: i64 = 50;

impl Store {
    /// Saves a task. A `None` secret leaves the stored one alone.
    pub fn save_task(
        &self,
        task: &ScheduledTask,
        next_run: Option<i64>,
        secret: Option<&str>,
    ) -> Result<()> {
        let text = serde_json::to_string(task)?;
        self.commit(|tx, _| {
            tx.execute(
                "INSERT INTO scheduled_tasks (id, task, next_run_at, secret)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (id) DO UPDATE SET task = excluded.task,
                    next_run_at = excluded.next_run_at,
                    secret = COALESCE(excluded.secret, secret)",
                params![task.id, text, next_run, secret],
            )?;
            Ok(())
        })
    }

    pub fn task(&self, id: &str) -> Result<ScheduledTask> {
        let text: String = self
            .reader()
            .query_row(
                "SELECT task FROM scheduled_tasks WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound("scheduled task".into()))?;
        Ok(serde_json::from_str(&text)?)
    }

    pub fn tasks(&self) -> Result<Vec<ScheduledTask>> {
        let conn = self.reader();
        let mut statement = conn.prepare("SELECT task FROM scheduled_tasks ORDER BY id")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|text| Ok(serde_json::from_str(&text?)?)).collect()
    }

    pub fn due_tasks(&self, now: i64) -> Result<Vec<ScheduledTask>> {
        let conn = self.reader();
        let mut statement =
            conn.prepare("SELECT task FROM scheduled_tasks WHERE next_run_at <= ?1")?;
        let rows = statement.query_map([now], |row| row.get::<_, String>(0))?;
        rows.map(|text| Ok(serde_json::from_str(&text?)?)).collect()
    }

    /// A thread's newest run, active or ended.
    pub fn latest_run(&self, thread_id: &str) -> Result<Option<Run>> {
        Ok(self
            .reader()
            .query_row(
                "SELECT id, thread_id, state, error, started_at, ended_at FROM runs
                 WHERE thread_id = ?1 ORDER BY started_at DESC, id DESC LIMIT 1",
                [thread_id],
                run_row,
            )
            .optional()?)
    }

    pub fn delete_task(&self, id: &str) -> Result<()> {
        self.commit(|tx, _| {
            let gone = tx.execute("DELETE FROM scheduled_tasks WHERE id = ?1", [id])?;
            if gone == 0 {
                return Err(CoreError::NotFound("scheduled task".into()));
            }
            Ok(())
        })
    }

    pub fn set_task_token(&self, id: &str, digest: &str) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute(
                "UPDATE scheduled_tasks SET token_sha256 = ?2 WHERE id = ?1",
                params![id, digest],
            )?;
            Ok(())
        })
    }

    /// The token digest and shared secret a request is checked against.
    pub fn task_keys(&self, id: &str) -> Result<(Option<String>, Option<String>)> {
        self.reader()
            .query_row(
                "SELECT token_sha256, secret FROM scheduled_tasks WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound("scheduled task".into()))
    }

    pub fn record_delivery(
        &self,
        delivery: &WebhookDelivery,
        dedupe_key: Option<&str>,
        received: i64,
    ) -> Result<()> {
        let text = serde_json::to_string(delivery)?;
        self.commit(|tx, _| {
            tx.execute(
                "INSERT INTO webhook_deliveries (id, task_id, delivery, dedupe_key, received_unix)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![delivery.id, delivery.task_id, text, dedupe_key, received],
            )?;
            tx.execute(
                "DELETE FROM webhook_deliveries WHERE task_id = ?1 AND id NOT IN
                    (SELECT id FROM webhook_deliveries WHERE task_id = ?1
                     ORDER BY received_unix DESC, id DESC LIMIT ?2)",
                params![delivery.task_id, MAX_DELIVERIES],
            )?;
            Ok(())
        })
    }

    /// True when an accepted delivery with this key landed since `since`.
    pub fn seen_delivery(&self, task_id: &str, key: &str, since: i64) -> Result<bool> {
        Ok(self.reader().query_row(
            "SELECT EXISTS (SELECT 1 FROM webhook_deliveries
             WHERE task_id = ?1 AND dedupe_key = ?2 AND received_unix >= ?3)",
            params![task_id, key, since],
            |row| row.get(0),
        )?)
    }

    pub fn deliveries(&self, task_id: &str) -> Result<Vec<WebhookDelivery>> {
        let conn = self.reader();
        let mut statement = conn.prepare(
            "SELECT delivery FROM webhook_deliveries WHERE task_id = ?1
             ORDER BY received_unix DESC, id DESC",
        )?;
        let rows = statement.query_map([task_id], |row| row.get::<_, String>(0))?;
        rows.map(|text| Ok(serde_json::from_str(&text?)?)).collect()
    }

    /// Notes a firing before it starts, so its time is not later than any run it
    /// creates. Returns the row to `finish_task_run` once the outcome is known.
    pub fn begin_task_run(&self, task_id: &str, source: &str) -> Result<String> {
        let id = crate::util::new_id();
        self.record_task_row(&id, task_id, source, None, "starting", None)?;
        Ok(id)
    }

    /// Settles a firing begun with `begin_task_run`: `started` with its thread, or
    /// `refused` with the reason.
    pub fn finish_task_run(
        &self,
        id: &str,
        thread_id: Option<&str>,
        queued_id: Option<&str>,
        status: &str,
        error: Option<&str>,
    ) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute(
                "UPDATE task_runs SET thread_id = ?2, queued_id = ?3, status = ?4, error = ?5
                 WHERE id = ?1",
                params![id, thread_id, queued_id, status, error],
            )?;
            Ok(())
        })
    }

    /// Notes one finished firing. `status` is `started`, `refused` or `skipped`.
    pub fn record_task_run(
        &self,
        task_id: &str,
        source: &str,
        thread_id: Option<&str>,
        status: &str,
        error: Option<&str>,
    ) -> Result<()> {
        self.record_task_row(
            &crate::util::new_id(),
            task_id,
            source,
            thread_id,
            status,
            error,
        )
    }

    fn record_task_row(
        &self,
        id: &str,
        task_id: &str,
        source: &str,
        thread_id: Option<&str>,
        status: &str,
        error: Option<&str>,
    ) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute(
                "INSERT INTO task_runs (id, task_id, source, started_at, started_unix,
                    thread_id, status, error)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    id,
                    task_id,
                    source,
                    crate::util::now(),
                    crate::util::unix_now(),
                    thread_id,
                    status,
                    error
                ],
            )?;
            tx.execute(
                "DELETE FROM task_runs WHERE task_id = ?1 AND id NOT IN
                    (SELECT id FROM task_runs WHERE task_id = ?1
                     ORDER BY started_unix DESC, rowid DESC LIMIT ?2)",
                params![task_id, MAX_TASK_RUNS],
            )?;
            Ok(())
        })
    }

    /// The task's history, newest first. How a started firing ended is read from the
    /// first run its thread began since, so it is as current as the thread.
    pub fn task_runs(&self, task_id: &str) -> Result<Vec<TaskRun>> {
        let conn = self.reader();
        let mut statement = conn.prepare(
            "SELECT id, source, started_at, thread_id, status, error, queued_id FROM task_runs
             WHERE task_id = ?1 ORDER BY started_unix DESC, rowid DESC",
        )?;
        let rows = statement
            .query_map([task_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(
                |(id, source, started_at, thread_id, status, error, queued_id)| {
                    let (outcome, ended_at) = match (status.as_str(), queued_id.as_deref()) {
                        ("started", Some(queued)) => {
                            let run: Option<(String, Option<String>)> = conn
                                .query_row(
                                    "SELECT state, ended_at FROM runs WHERE queued_message_id = ?1
                                 ORDER BY rowid DESC LIMIT 1",
                                    [queued],
                                    |row| Ok((row.get(0)?, row.get(1)?)),
                                )
                                .optional()?;
                            match run {
                                Some((state, ended)) => (run_outcome(&state), ended),
                                None => {
                                    // Still waiting, or taken out of the queue by hand.
                                    let waiting: bool = conn.query_row(
                                    "SELECT EXISTS (SELECT 1 FROM queued_messages WHERE id = ?1)",
                                    [queued],
                                    |row| row.get(0),
                                )?;
                                    let word = if waiting { "queued" } else { "cancelled" };
                                    (word.to_owned(), None)
                                }
                            }
                        }
                        (other, _) => (other.to_owned(), None),
                    };
                    Ok(TaskRun {
                        id,
                        task_id: task_id.to_owned(),
                        source,
                        started_at,
                        ended_at,
                        outcome,
                        thread_id,
                        error,
                    })
                },
            )
            .collect()
    }

    /// Delegated threads of `parent`.
    pub fn child_threads(&self, parent: &str) -> Result<Vec<String>> {
        let conn = self.reader();
        let mut statement = conn.prepare(
            "SELECT id FROM threads WHERE parent_thread_id = ?1 AND relation = 'subagent'",
        )?;
        let rows = statement.query_map([parent], |row| row.get(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}

/// A run's stored state as a history outcome: every live state reads as `running`.
fn run_outcome(state: &str) -> String {
    match state {
        "completed" | "failed" | "cancelled" | "interrupted" => state.to_owned(),
        _ => "running".to_owned(),
    }
}
