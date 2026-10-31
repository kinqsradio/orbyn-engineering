//! Queued messages and attachment records. A queued message becomes a run in one
//! transaction, so it can neither start twice nor vanish between the two steps.

use orbyn_contracts::{Attachment, QueuedMessage, Run};
use rusqlite::{OptionalExtension, Row, params};

use super::runs::admit_in;
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
    ) -> Result<QueuedMessage> {
        let id = new_id();
        let stamp = now();
        let ids = serde_json::to_string(attachments)?;
        self.commit(|tx, _| {
            // A new message joins any held queue rather than jumping past it.
            let held: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM queued_messages WHERE thread_id = ?1 AND held = 1)",
                [thread_id],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT INTO queued_messages (id, thread_id, prompt, attachment_ids, held, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, thread_id, prompt, ids, held, stamp],
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
