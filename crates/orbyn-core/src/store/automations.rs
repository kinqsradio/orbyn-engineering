//! Scheduled tasks and the webhook delivery log.

use orbyn_contracts::{Run, ScheduledTask, WebhookDelivery};
use rusqlite::{OptionalExtension, params};

use super::{Store, run_row};
use crate::error::{CoreError, Result};

/// A task's delivery log keeps this many rows.
const MAX_DELIVERIES: i64 = 200;

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
