//! Checkpoints and the conversation handoff that carries a thread across engine
//! sessions: rewinds, forks and engine switches all use it.

use orbyn_contracts::{AgUiEvent, Checkpoint, Thread};
use rusqlite::{OptionalExtension, Row, params};

use super::{NewThread, Store, thread_row, with_run_state};
use crate::error::{CoreError, Result};
use crate::util::{new_id, now};

/// The most conversation a handoff carries. Older text is dropped first.
pub const HANDOFF_BUDGET_CHARS: usize = 16_000;

fn checkpoint_row(row: &Row<'_>) -> rusqlite::Result<Checkpoint> {
    Ok(Checkpoint {
        run_id: row.get("run_id")?,
        start: row.get("start_sha")?,
        end: row.get("end_sha")?,
        created_at: row.get("created_at")?,
    })
}

impl Store {
    pub fn add_checkpoint(&self, thread_id: &str, run_id: &str, sha: &str) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute(
                "INSERT INTO checkpoints (run_id, thread_id, start_sha, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![run_id, thread_id, sha, now()],
            )?;
            Ok(())
        })
    }

    pub fn finish_checkpoint(&self, run_id: &str, sha: &str) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute(
                "UPDATE checkpoints SET end_sha = ?2 WHERE run_id = ?1",
                params![run_id, sha],
            )?;
            Ok(())
        })
    }

    pub fn checkpoint(&self, run_id: &str) -> Result<Option<Checkpoint>> {
        Ok(self
            .reader()
            .query_row(
                "SELECT * FROM checkpoints WHERE run_id = ?1",
                [run_id],
                checkpoint_row,
            )
            .optional()?)
    }

    pub fn checkpoints(&self, thread_id: &str) -> Result<Vec<Checkpoint>> {
        let conn = self.reader();
        let mut statement =
            conn.prepare("SELECT * FROM checkpoints WHERE thread_id = ?1 ORDER BY rowid")?;
        let rows = statement.query_map([thread_id], checkpoint_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Other live threads working in the same folder as `thread`.
    pub fn threads_sharing_checkout(&self, thread: &Thread) -> Result<Vec<String>> {
        let conn = self.reader();
        let mut statement = conn.prepare(
            "SELECT id FROM threads WHERE cwd = ?1 AND id <> ?2 AND archived_at IS NULL",
        )?;
        let rows = statement.query_map([&thread.cwd, &thread.id], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// The last log position before a run began.
    pub fn seq_before_run(&self, thread_id: &str, run_id: &str) -> Result<i64> {
        let seq: Option<i64> = self.reader().query_row(
            "SELECT MIN(seq) FROM thread_events WHERE thread_id = ?1 AND run_id = ?2",
            [thread_id, run_id],
            |row| row.get(0),
        )?;
        seq.map(|seq| seq - 1)
            .ok_or_else(|| CoreError::NotFound("run".into()))
    }

    pub fn last_seq_of_run(&self, thread_id: &str, run_id: &str) -> Result<i64> {
        let seq: Option<i64> = self.reader().query_row(
            "SELECT MAX(seq) FROM thread_events WHERE thread_id = ?1 AND run_id = ?2",
            [thread_id, run_id],
            |row| row.get(0),
        )?;
        seq.ok_or_else(|| CoreError::NotFound("run".into()))
    }

    /// The conversation up to `through`, within budget, keeping the newest text.
    pub fn handoff_text(&self, thread_id: &str, through: i64) -> Result<String> {
        let mut roles = std::collections::HashMap::new();
        let mut lines: Vec<(String, String)> = Vec::new();
        let mut cursor = 0;
        'log: loop {
            let batch = self.events_after(thread_id, cursor, 500)?;
            let Some(last) = batch.last() else { break };
            cursor = last.seq;
            for event in batch {
                if event.seq > through {
                    break 'log;
                }
                match event.event {
                    AgUiEvent::TextMessageStart { message_id, role } => {
                        roles.insert(message_id, role);
                    }
                    AgUiEvent::TextMessageContent { message_id, delta } => {
                        let role = roles.get(&message_id).cloned().unwrap_or_default();
                        match lines.last_mut() {
                            Some((id, text)) if *id == message_id => text.push_str(&delta),
                            _ => lines.push((message_id, format!("{role}: {delta}"))),
                        }
                    }
                    _ => {}
                }
            }
        }
        let text = lines
            .into_iter()
            .map(|(_, line)| line)
            .collect::<Vec<_>>()
            .join("\n");
        let count = text.chars().count();
        Ok(if count > HANDOFF_BUDGET_CHARS {
            text.chars().skip(count - HANDOFF_BUDGET_CHARS).collect()
        } else {
            text
        })
    }

    /// Everything logged so far, up to the handoff budget.
    pub fn recovery_handoff(&self, thread_id: &str) -> Result<String> {
        self.handoff_text(thread_id, self.latest_seq(thread_id)?)
    }

    /// Ends the engine session and leaves `handoff` for the next run.
    pub fn set_handoff(&self, thread_id: &str, handoff: &str) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute(
                "UPDATE threads SET handoff = ?2, engine_session = NULL WHERE id = ?1",
                params![thread_id, handoff],
            )?;
            Ok(())
        })
    }

    /// Hands the text to one run only.
    pub fn take_handoff(&self, thread_id: &str) -> Result<Option<String>> {
        self.commit(|tx, _| {
            let text: Option<String> = tx.query_row(
                "SELECT handoff FROM threads WHERE id = ?1",
                [thread_id],
                |row| row.get(0),
            )?;
            tx.execute(
                "UPDATE threads SET handoff = NULL WHERE id = ?1",
                [thread_id],
            )?;
            Ok(text)
        })
    }

    pub fn switch_thread_engine(&self, id: &str, engine: &str, model: Option<&str>) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute(
                "UPDATE threads SET engine = ?2, model = ?3, engine_session = NULL WHERE id = ?1",
                params![id, engine, model],
            )?;
            Ok(())
        })
    }

    /// Creates a child thread holding the parent's log up to `through`.
    pub fn fork_thread(&self, parent: &Thread, through: i64, title: &str) -> Result<Thread> {
        let id = new_id();
        let stamp = now();
        let handoff = self.handoff_text(&parent.id, through)?;
        let new = NewThread {
            project_id: parent.project_id.clone(),
            title: title.to_owned(),
            engine: parent.engine.clone(),
            model: parent.model.clone(),
            cwd: parent.cwd.clone(),
            worktree: parent.worktree.clone(),
            skill_profile: parent.skill_profile.clone(),
            parent_thread_id: Some(parent.id.clone()),
            relation: Some("fork".to_owned()),
            scratch: parent.scratch,
        };
        self.commit(|tx, _| {
            let worktree = new.worktree.as_ref();
            tx.execute(
                "INSERT INTO threads (id, project_id, title, engine, model, cwd, worktree_path,
                    worktree_branch, worktree_base, skill_profile, created_at, updated_at, position,
                    parent_thread_id, relation, next_seq, handoff, scratch)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11,
                    (SELECT COALESCE(MIN(position), 0) - 1 FROM threads), ?12, ?13, ?14 + 1, ?15,
                    ?16",
                params![
                    id,
                    new.project_id,
                    new.title,
                    new.engine,
                    new.model,
                    new.cwd,
                    worktree.map(|w| &w.path),
                    worktree.map(|w| &w.branch),
                    worktree.map(|w| &w.base),
                    new.skill_profile,
                    stamp,
                    new.parent_thread_id,
                    new.relation,
                    through,
                    handoff,
                    new.scratch,
                ],
            )?;
            // A fork shows the conversation it came from, without the parent's runs.
            tx.execute(
                "INSERT INTO thread_events (thread_id, seq, run_id, ts, event)
                 SELECT ?1, seq, NULL, ts, event FROM thread_events
                 WHERE thread_id = ?2 AND seq <= ?3",
                params![id, new.parent_thread_id, through],
            )?;
            Ok(())
        })?;
        let conn = self.reader();
        let thread = conn.query_row("SELECT * FROM threads WHERE id = ?1", [&id], thread_row)?;
        with_run_state(&conn, thread)
    }
}
