//! Threads that carry an agent's own saved session. The session id on the thread
//! is the only link, so removing the thread also removes the link.
use orbyn_contracts::{AgUiEvent, Thread};
use rusqlite::{OptionalExtension, params};

use super::{NewThread, Store, insert_event};
use crate::error::Result;
use crate::util::{new_id, now};

impl Store {
    /// The thread already holding `session` for `engine`, if any.
    pub fn thread_for_native_session(
        &self,
        engine: &str,
        project_id: &str,
        session: &str,
    ) -> Result<Option<String>> {
        Ok(self
            .reader()
            .query_row(
                "SELECT id FROM threads WHERE engine = ?1 AND project_id = ?2
                   AND engine_session = ?3 ORDER BY created_at, id LIMIT 1",
                params![engine, project_id, session],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Whether any thread of `engine` holds `session`, in any project.
    pub fn native_session_in_use(&self, engine: &str, session: &str) -> Result<bool> {
        Ok(self.reader().query_row(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE engine = ?1 AND engine_session = ?2)",
            params![engine, session],
            |row| row.get(0),
        )?)
    }

    /// Creates the thread, its replayed history and its session link together, or
    /// returns the thread that already holds the session. The flag says whether a
    /// thread was created.
    pub fn import_native_thread(
        &self,
        new: NewThread,
        session: &str,
        history: &[AgUiEvent],
    ) -> Result<(Thread, bool)> {
        let id = new_id();
        let created = self.commit(|tx, appended| {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM threads WHERE engine = ?1 AND project_id = ?2
                       AND engine_session = ?3 ORDER BY created_at, id LIMIT 1",
                    params![new.engine, new.project_id, session],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(existing) = existing {
                return Ok((existing, false));
            }
            let stamp = now();
            tx.execute(
                "INSERT INTO threads (id, project_id, title, engine, model, cwd,
                    created_at, updated_at, position, engine_session, scratch)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7,
                    (SELECT COALESCE(MIN(position), 0) - 1 FROM threads), ?8, ?9)",
                params![
                    id,
                    new.project_id,
                    new.title,
                    new.engine,
                    new.model,
                    new.cwd,
                    stamp,
                    session,
                    new.scratch
                ],
            )?;
            for event in history {
                insert_event(tx, appended, &id, None, event)?;
            }
            Ok((id.clone(), true))
        })?;
        Ok((self.thread(&created.0)?, created.1))
    }
}
