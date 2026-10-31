//! Queued messages and attachment records. A queued message becomes a run in one
//! transaction, so it can neither start twice nor vanish between the two steps.

use std::collections::HashSet;

use orbyn_contracts::{Attachment, ModelSelection, PullRequest, PullWatch, QueuedMessage, Run};
use rusqlite::{OptionalExtension, Row, params};

use super::runs::admit_in;
use super::threads::apply_selection;
use super::{Admission, Store, parse_json};
use crate::error::{CoreError, Result};
use crate::util::{new_id, now};

fn queued_row(row: &Row<'_>) -> rusqlite::Result<QueuedMessage> {
    let ids: String = row.get("attachment_ids")?;
    Ok(QueuedMessage {
        id: row.get("id")?,
        thread_id: row.get("thread_id")?,
        prompt: row.get("prompt")?,
        attachment_ids: parse_json(3, &ids)?,
        held: row.get("held")?,
        created_at: row.get("created_at")?,
        model: row.get("model")?,
        effort: row.get("effort")?,
        options: parse_json(0, &row.get::<_, String>("options")?)?,
    })
}

/// A stored watch, with what its last pass saw.
#[derive(Clone, Debug)]
pub struct WatchRow {
    pub thread_id: String,
    pub number: u64,
    pub snapshot: Option<String>,
    pub comment_wakes: i64,
    pub failures: i64,
    pub created_at: String,
}

#[derive(Clone, Debug, Default)]
pub struct WatchUpdate {
    pub snapshot: Option<String>,
    pub comment_wakes: i64,
    pub failures: i64,
}

impl WatchUpdate {
    /// A failed read: the wake count and snapshot stand, so only this rises.
    pub fn failed(failures: i64) -> Self {
        Self {
            failures,
            ..Self::default()
        }
    }
}

fn pull_row(row: &Row<'_>) -> rusqlite::Result<PullRequest> {
    Ok(PullRequest {
        number: row.get::<_, i64>("number")? as u64,
        title: row.get("title")?,
        url: row.get("url")?,
        state: row.get("state")?,
        head: row.get("head")?,
        base: row.get("base")?,
        author: row.get("author")?,
        draft: false,
        updated_at: None,
        labels: Vec::new(),
        review_state: None,
        checks_state: None,
    })
}

fn attachment_row(row: &Row<'_>) -> rusqlite::Result<(Attachment, String)> {
    Ok((
        Attachment {
            id: row.get("id")?,
            thread_id: row.get("thread_id")?,
            name: row.get("name")?,
            mime: row.get("mime")?,
            size: row.get::<_, i64>("size")? as u64,
            created_at: row.get("created_at")?,
        },
        row.get("path")?,
    ))
}

impl Store {
    pub fn enqueue(
        &self,
        thread_id: &str,
        prompt: &str,
        attachments: &[String],
        selection: &ModelSelection,
    ) -> Result<QueuedMessage> {
        let id = new_id();
        let stamp = now();
        let ids = serde_json::to_string(attachments)?;
        let options = serde_json::to_string(&selection.options)?;
        self.commit(|tx, _| {
            // A new message joins any held queue rather than jumping past it.
            let held: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM queued_messages WHERE thread_id = ?1 AND held = 1)",
                [thread_id],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT INTO queued_messages (id, thread_id, prompt, attachment_ids, held,
                    created_at, model, effort, options)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    id,
                    thread_id,
                    prompt,
                    ids,
                    held,
                    stamp,
                    selection.model,
                    selection.effort,
                    options,
                ],
            )?;
            Ok(())
        })?;
        self.queued(&id)
    }

    pub fn queued(&self, id: &str) -> Result<QueuedMessage> {
        self.reader()
            .query_row(
                "SELECT * FROM queued_messages WHERE id = ?1",
                [id],
                queued_row,
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound("queued message".into()))
    }

    pub fn list_queue(&self, thread_id: &str) -> Result<Vec<QueuedMessage>> {
        let conn = self.reader();
        let mut statement = conn.prepare_cached(
            "SELECT * FROM queued_messages WHERE thread_id = ?1 ORDER BY urgent DESC, rowid",
        )?;
        let rows = statement.query_map([thread_id], queued_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn edit_queued(&self, id: &str, prompt: &str) -> Result<QueuedMessage> {
        self.commit(|tx, _| {
            let changed = tx.execute(
                "UPDATE queued_messages SET prompt = ?2 WHERE id = ?1",
                params![id, prompt],
            )?;
            if changed == 0 {
                return Err(CoreError::NotFound("queued message".into()));
            }
            Ok(())
        })?;
        self.queued(id)
    }

    pub fn remove_queued(&self, id: &str) -> Result<()> {
        self.commit(|tx, _| {
            let changed = tx.execute("DELETE FROM queued_messages WHERE id = ?1", [id])?;
            if changed == 0 {
                return Err(CoreError::NotFound("queued message".into()));
            }
            Ok(())
        })
    }

    /// Puts one message next in line, past any hold.
    pub fn mark_urgent(&self, id: &str) -> Result<QueuedMessage> {
        self.commit(|tx, _| {
            let changed = tx.execute(
                "UPDATE queued_messages SET urgent = 1, held = 0 WHERE id = ?1",
                [id],
            )?;
            if changed == 0 {
                return Err(CoreError::NotFound("queued message".into()));
            }
            Ok(())
        })?;
        self.queued(id)
    }

    pub fn release_queue(&self, thread_id: &str) -> Result<usize> {
        self.commit(|tx, _| {
            Ok(tx.execute(
                "UPDATE queued_messages SET held = 0 WHERE thread_id = ?1",
                [thread_id],
            )?)
        })
    }

    /// Turns the next message into a run, or does nothing if there is none, it is
    /// held, or the thread is busy. Losing the race leaves the message queued.
    pub fn admit_next(&self, thread_id: &str, actor: &str) -> Result<Option<(Run, QueuedMessage)>> {
        let outcome = self.commit(|tx, appended| {
            let next = tx
                .query_row(
                    "SELECT * FROM queued_messages WHERE thread_id = ?1
                     ORDER BY urgent DESC, rowid LIMIT 1",
                    [thread_id],
                    queued_row,
                )
                .optional()?;
            let Some(message) = next else { return Ok(None) };
            if message.held {
                return Ok(None);
            }
            let run = admit_in(
                tx,
                appended,
                &self.epoch,
                &Admission {
                    thread_id,
                    prompt: &message.prompt,
                    actor,
                },
            )?;
            tx.execute("DELETE FROM queued_messages WHERE id = ?1", [&message.id])?;
            apply_selection(
                tx,
                appended,
                thread_id,
                message.model.as_deref(),
                message.effort.as_deref(),
                Some(&message.options),
            )?;
            Ok(Some((run, message)))
        });
        match outcome {
            Err(CoreError::ThreadBusy) => Ok(None),
            other => other,
        }
    }

    pub fn add_attachment(&self, attachment: &Attachment, path: &str) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute(
                "INSERT INTO attachments (id, thread_id, name, mime, size, path, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    attachment.id,
                    attachment.thread_id,
                    attachment.name,
                    attachment.mime,
                    attachment.size as i64,
                    path,
                    attachment.created_at
                ],
            )?;
            Ok(())
        })
    }

    pub fn list_attachments(&self, thread_id: &str) -> Result<Vec<(Attachment, String)>> {
        let conn = self.reader();
        let mut statement =
            conn.prepare_cached("SELECT * FROM attachments WHERE thread_id = ?1 ORDER BY rowid")?;
        let rows = statement.query_map([thread_id], attachment_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn link_pull(&self, thread_id: &str, pull: &PullRequest) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute(
                "INSERT INTO thread_pull_requests
                    (thread_id, number, url, title, state, head, base, author)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (thread_id, number) DO UPDATE SET url = excluded.url,
                    title = excluded.title, state = excluded.state, head = excluded.head,
                    base = excluded.base, author = excluded.author",
                params![
                    thread_id,
                    pull.number as i64,
                    pull.url,
                    pull.title,
                    pull.state,
                    pull.head,
                    pull.base,
                    pull.author
                ],
            )?;
            Ok(())
        })
    }

    pub fn linked_pulls(&self, thread_id: &str) -> Result<Vec<PullRequest>> {
        let conn = self.reader();
        let mut statement = conn.prepare_cached(
            "SELECT * FROM thread_pull_requests WHERE thread_id = ?1 ORDER BY number",
        )?;
        let rows = statement.query_map([thread_id], pull_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Threads with a pull request not yet known to be finished.
    pub fn threads_with_open_pulls(&self) -> Result<Vec<String>> {
        let conn = self.reader();
        let mut statement = conn
            .prepare("SELECT DISTINCT thread_id FROM thread_pull_requests WHERE state = 'open'")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn watch_pull(&self, thread_id: &str, number: u64) -> Result<PullWatch> {
        let created_at = now();
        self.commit(|tx, _| {
            tx.execute(
                "INSERT INTO pull_watches (thread_id, number, created_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (thread_id, number) DO NOTHING",
                params![thread_id, number as i64, created_at],
            )?;
            Ok(())
        })?;
        Ok(PullWatch {
            thread_id: thread_id.to_owned(),
            number,
            created_at,
        })
    }

    pub fn unwatch_pull(&self, thread_id: &str, number: u64) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute(
                "DELETE FROM pull_watches WHERE thread_id = ?1 AND number = ?2",
                params![thread_id, number as i64],
            )?;
            Ok(())
        })
    }

    pub fn update_watch(&self, thread_id: &str, number: u64, update: WatchUpdate) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute(
                "UPDATE pull_watches SET snapshot = COALESCE(?3, snapshot), comment_wakes = ?4,
                    failures = ?5 WHERE thread_id = ?1 AND number = ?2",
                params![
                    thread_id,
                    number as i64,
                    update.snapshot,
                    update.comment_wakes,
                    update.failures
                ],
            )?;
            Ok(())
        })
    }

    /// One thread's watches, or every watch when `None`.
    pub fn pull_watches(&self, thread_id: Option<&str>) -> Result<Vec<WatchRow>> {
        let conn = self.reader();
        let mut statement = conn.prepare(
            "SELECT * FROM pull_watches WHERE ?1 IS NULL OR thread_id = ?1 ORDER BY created_at",
        )?;
        let rows = statement.query_map([thread_id], |row| {
            Ok(WatchRow {
                thread_id: row.get("thread_id")?,
                number: row.get::<_, i64>("number")? as u64,
                snapshot: row.get("snapshot")?,
                comment_wakes: row.get("comment_wakes")?,
                failures: row.get("failures")?,
                created_at: row.get("created_at")?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn viewed_files(&self, project_id: &str, number: u64) -> Result<HashSet<String>> {
        let conn = self.reader();
        let mut statement = conn
            .prepare("SELECT path FROM pull_files_viewed WHERE project_id = ?1 AND number = ?2")?;
        let rows = statement.query_map(params![project_id, number as i64], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn set_files_viewed(
        &self,
        project_id: &str,
        number: u64,
        paths: &[String],
        viewed: bool,
    ) -> Result<()> {
        self.commit(|tx, _| {
            for path in paths {
                let sql = if viewed {
                    "INSERT OR IGNORE INTO pull_files_viewed (project_id, number, path)
                     VALUES (?1, ?2, ?3)"
                } else {
                    "DELETE FROM pull_files_viewed
                     WHERE project_id = ?1 AND number = ?2 AND path = ?3"
                };
                tx.execute(sql, params![project_id, number as i64, path])?;
            }
            Ok(())
        })
    }

    pub fn unlink_pull(&self, thread_id: &str, number: u64) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute(
                "DELETE FROM pull_watches WHERE thread_id = ?1 AND number = ?2",
                params![thread_id, number as i64],
            )?;
            let changed = tx.execute(
                "DELETE FROM thread_pull_requests WHERE thread_id = ?1 AND number = ?2",
                params![thread_id, number as i64],
            )?;
            if changed == 0 {
                return Err(CoreError::NotFound("pull request".into()));
            }
            Ok(())
        })
    }

    /// Stored files of a thread and its descendants, for cleanup after deletion.
    pub fn family_attachment_paths(&self, thread_id: &str) -> Result<Vec<String>> {
        let conn = self.reader();
        let mut statement = conn.prepare(
            "WITH RECURSIVE family(id) AS (
                SELECT id FROM threads WHERE id = ?1
                UNION SELECT threads.id FROM threads
                    JOIN family ON threads.parent_thread_id = family.id
             ) SELECT path FROM attachments WHERE thread_id IN (SELECT id FROM family)",
        )?;
        let rows = statement.query_map([thread_id], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Deletes the record and returns the stored file's path.
    pub fn remove_attachment(&self, id: &str) -> Result<String> {
        self.commit(|tx, _| {
            let path: String = tx
                .query_row("SELECT path FROM attachments WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .optional()?
                .ok_or_else(|| CoreError::NotFound("attachment".into()))?;
            tx.execute("DELETE FROM attachments WHERE id = ?1", [id])?;
            Ok(path)
        })
    }
}
