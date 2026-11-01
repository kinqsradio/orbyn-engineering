//! Run lifecycle writes. Every transition is a compare-and-set on the previous
//! state and the owner epoch, so a late event or a stale process cannot move a run.

use orbyn_contracts::{
    AgUiEvent, Approval, ApprovalState, Run, RunState, ThreadEvent, ThreadItemRecord, ThreadUsage,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::approvals::{activity_event, approval_row};
use super::{Appended, AuditRecord, Store, insert_audit, insert_event, run_row, wire_name};
use crate::driver::ItemRecord;
use crate::error::{CoreError, Result};
use crate::util::{new_id, now};

const RUN_COLUMNS: &str = "id, thread_id, state, error, started_at, ended_at";

pub struct Admission<'a> {
    pub thread_id: &'a str,
    pub prompt: &'a str,
    pub actor: &'a str,
}

/// What startup recovery changed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Recovery {
    pub interrupted_runs: usize,
    pub expired_approvals: usize,
    /// Someone had already pressed stop, so these ended cancelled.
    pub stopped_runs: usize,
    /// Admitted runs whose message never reached an engine, now back in the queue.
    pub returned_messages: usize,
    /// Threads whose run a dead process left mid-work.
    pub interrupted_threads: Vec<String>,
}

/// The owner and state read inside the writing transaction.
pub(super) struct Guard {
    pub thread_id: String,
    pub state: RunState,
}

/// Rejects a write from a non-owner or against a finished run.
pub(super) fn guard_active(tx: &Transaction<'_>, epoch: &str, run_id: &str) -> Result<Guard> {
    let row: Option<(String, String, String)> = tx
        .query_row(
            "SELECT thread_id, state, owner_epoch FROM runs WHERE id = ?1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let (thread_id, state, owner) = row.ok_or_else(|| CoreError::NotFound("run".into()))?;
    let state: RunState = super::parse_wire(1, state)?;
    if state.is_terminal() {
        return Err(CoreError::RunClosed);
    }
    if owner != epoch {
        return Err(CoreError::StaleOwner);
    }
    Ok(Guard { thread_id, state })
}

pub(super) fn set_state(
    tx: &Transaction<'_>,
    run_id: &str,
    from: RunState,
    to: RunState,
) -> Result<()> {
    let changed = tx.execute(
        "UPDATE runs SET state = ?2 WHERE id = ?1 AND state = ?3",
        params![run_id, wire_name(to)?, wire_name(from)?],
    )?;
    if changed == 0 {
        return Err(CoreError::InvalidTransition {
            from: wire_name(from)?,
            to: wire_name(to)?,
        });
    }
    Ok(())
}

impl Store {
    /// Makes the run durable before any process exists. The partial unique
    /// index, not a prior read, is what makes the second admission lose.
    pub fn admit_run(&self, admission: Admission<'_>) -> Result<Run> {
        self.commit(|tx, appended| admit_in(tx, appended, &self.epoch, &admission))
    }

    pub fn run(&self, id: &str) -> Result<Run> {
        self.reader()
            .query_row(
                &format!("SELECT {RUN_COLUMNS} FROM runs WHERE id = ?1"),
                [id],
                run_row,
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound("run".into()))
    }

    pub fn mark_starting(&self, run_id: &str) -> Result<()> {
        self.commit(|tx, _| {
            guard_active(tx, &self.epoch, run_id)?;
            set_state(tx, run_id, RunState::Admitted, RunState::Starting)
        })
    }

    /// `starting -> running`. An engine can ask for approval before this runs,
    /// which already advanced the state, so an already-started run is left alone.
    pub fn mark_running(&self, run_id: &str) -> Result<()> {
        self.commit(|tx, _| {
            let guard = guard_active(tx, &self.epoch, run_id)?;
            match guard.state {
                RunState::Starting => set_state(tx, run_id, RunState::Starting, RunState::Running),
                RunState::Running | RunState::AwaitingApproval => Ok(()),
                other => Err(CoreError::InvalidTransition {
                    from: wire_name(other)?,
                    to: wire_name(RunState::Running)?,
                }),
            }
        })
    }

    /// Appends an engine event for a live run owned by this process.
    pub fn append_run_event(&self, run_id: &str, event: &AgUiEvent) -> Result<ThreadEvent> {
        self.commit(|tx, appended| {
            let guard = guard_active(tx, &self.epoch, run_id)?;
            insert_event(tx, appended, &guard.thread_id, Some(run_id), event)
        })
    }

    pub fn set_engine_session(&self, run_id: &str, session: &str) -> Result<()> {
        self.commit(|tx, _| {
            let guard = guard_active(tx, &self.epoch, run_id)?;
            tx.execute(
                "UPDATE threads SET engine_session = ?2 WHERE id = ?1
                   AND engine = (SELECT engine FROM runs WHERE id = ?3)",
                params![guard.thread_id, session, run_id],
            )?;
            Ok(())
        })
    }

    /// Keeps an engine item for the inspector. Later reports replace earlier ones.
    pub fn record_item(&self, run_id: &str, item: &ItemRecord) -> Result<()> {
        self.commit(|tx, _| {
            let guard = guard_active(tx, &self.epoch, run_id)?;
            tx.execute(
                "INSERT INTO thread_items (thread_id, item_id, run_id, kind, raw, exit_code, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (thread_id, item_id) DO UPDATE SET run_id = excluded.run_id,
                    kind = excluded.kind, raw = excluded.raw, exit_code = excluded.exit_code,
                    updated_at = excluded.updated_at",
                params![
                    guard.thread_id,
                    item.id,
                    run_id,
                    item.kind,
                    item.raw.to_string(),
                    item.exit_code,
                    now()
                ],
            )?;
            Ok(())
        })
    }

    pub fn items(&self, thread_id: &str, limit: u32) -> Result<Vec<ThreadItemRecord>> {
        let conn = self.reader();
        let mut statement = conn.prepare_cached(
            "SELECT * FROM thread_items WHERE thread_id = ?1 ORDER BY updated_at DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![thread_id, limit.min(1000)], item_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// The raw items of one run, oldest first.
    pub fn run_items(&self, thread_id: &str, run_id: &str) -> Result<Vec<ThreadItemRecord>> {
        let conn = self.reader();
        let mut statement = conn.prepare_cached(
            "SELECT * FROM thread_items WHERE thread_id = ?1 AND run_id = ?2 ORDER BY updated_at, item_id",
        )?;
        let rows = statement.query_map([thread_id, run_id], item_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn item(&self, thread_id: &str, item_id: &str) -> Result<ThreadItemRecord> {
        self.reader()
            .query_row(
                "SELECT * FROM thread_items WHERE thread_id = ?1 AND item_id = ?2",
                [thread_id, item_id],
                item_row,
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound("item".into()))
    }

    pub fn record_usage(&self, run_id: &str, usage: &ThreadUsage) -> Result<()> {
        let text = serde_json::to_string(usage)?;
        self.commit(|tx, _| {
            let guard = guard_active(tx, &self.epoch, run_id)?;
            tx.execute(
                "UPDATE threads SET usage = ?2 WHERE id = ?1",
                params![guard.thread_id, text],
            )?;
            Ok(())
        })
    }

    pub fn usage(&self, thread_id: &str) -> Result<Option<ThreadUsage>> {
        let text: Option<String> = self
            .reader()
            .query_row(
                "SELECT usage FROM threads WHERE id = ?1",
                [thread_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound("thread".into()))?;
        Ok(text.and_then(|text| serde_json::from_str(&text).ok()))
    }

    pub(crate) fn run_owns_engine(&self, run: &str) -> Result<bool> {
        Ok(self.reader().query_row("SELECT t.engine = r.engine FROM runs r JOIN threads t ON t.id = r.thread_id WHERE r.id = ?1", [run], |row| row.get(0))?)
    }

    pub(crate) fn run_engine_session(&self, run: &str) -> Result<Option<String>> {
        Ok(self.reader().query_row("SELECT t.engine_session FROM runs r JOIN threads t ON t.id = r.thread_id WHERE r.id = ?1 AND t.engine = r.engine", [run], |row| row.get(0)).optional()?.flatten())
    }

    pub(crate) fn run_handoff(&self, run: &str) -> Result<Option<String>> {
        Ok(self.reader().query_row("SELECT CASE WHEN t.engine = r.engine THEN t.handoff ELSE r.preparation_handoff END FROM runs r JOIN threads t ON t.id = r.thread_id WHERE r.id = ?1", [run], |row| row.get(0)).optional()?.flatten())
    }

    pub(crate) fn clear_run_handoff(&self, run: &str) -> Result<()> {
        self.commit(|tx, _| {
            let guard = guard_active(tx, &self.epoch, run)?;
            tx.execute("UPDATE threads SET handoff = NULL WHERE id = ?1 AND engine = (SELECT engine FROM runs WHERE id = ?2)", params![guard.thread_id, run])?;
            tx.execute("UPDATE runs SET preparation_handoff = NULL WHERE id = ?1", [run])?;
            Ok(())
        })
    }

    pub(crate) fn set_run_handoff(&self, run: &str, handoff: &str) -> Result<()> {
        self.commit(|tx, _| {
            let guard = guard_active(tx, &self.epoch, run)?;
            let changed = tx.execute("UPDATE threads SET handoff = ?2, engine_session = NULL WHERE id = ?1 AND engine = (SELECT engine FROM runs WHERE id = ?3)", params![guard.thread_id, handoff, run])?;
            if changed != 1 { return Err(CoreError::StaleOwner); }
            Ok(())
        })
    }

    pub fn engine_session(&self, thread_id: &str) -> Result<Option<String>> {
        Ok(self
            .reader()
            .query_row(
                "SELECT engine_session FROM threads WHERE id = ?1",
                [thread_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten())
    }

    /// Ends a run. Pending approvals expire in the same transaction, so there is
    /// no instant at which a decision can land on a finished run.
    pub fn finish_run(
        &self,
        run_id: &str,
        to: RunState,
        error: Option<&str>,
    ) -> Result<(Run, Vec<Approval>)> {
        if !matches!(
            to,
            RunState::Completed | RunState::Failed | RunState::Cancelled
        ) {
            return Err(CoreError::InvalidTransition {
                from: "active".into(),
                to: wire_name(to)?,
            });
        }
        self.commit(|tx, appended| {
            let guard = guard_active(tx, &self.epoch, run_id)?;
            close_run(
                tx,
                appended,
                run_id,
                &guard.thread_id,
                to,
                error,
                "system:run",
            )
        })
    }

    /// Fences every run a dead process owned. Called once at startup, before
    /// this process admits anything.
    pub fn recover(&self) -> Result<Recovery> {
        self.commit(|tx, appended| {
            let mut statement = tx.prepare(&format!(
                "SELECT id, thread_id, state, stop_requested FROM runs
                 WHERE state IN {} AND owner_epoch <> ?1",
                super::ACTIVE_STATES
            ))?;
            let orphans = statement
                .query_map([&self.epoch], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, bool>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            let mut recovery = Recovery::default();
            for (run_id, thread_id, state, stopped) in orphans {
                close_open_tools(tx, appended, &run_id, &thread_id)?;
                let preparation: Option<String> = tx.query_row("SELECT name FROM thread_setup WHERE thread_id = ?1 AND run_id = ?2 AND (status = 'preparing' OR (status = 'running' AND wait_for_exit = 1))", params![thread_id, run_id], |row| row.get(0)).optional()?;
                let preparation = preparation.filter(|_| !stopped);
                if preparation.is_some() {
                    tx.execute("UPDATE thread_setup SET owner_epoch = ?2, status = 'failed', exit_code = NULL WHERE thread_id = ?1", params![thread_id, self.epoch])?;
                }
                let unsent = !stopped && preparation.is_none() && state == wire_name(RunState::Admitted)?;
                let preparation_message = preparation.map(|name| format!("Setup script {name} did not finish successfully."));
                let (to, message) = match (stopped, unsent) {
                    (true, _) => (RunState::Cancelled, None),
                    (_, true) => (
                        RunState::Interrupted,
                        Some("Orbyn stopped before this message reached the engine."),
                    ),
                    _ => (
                        RunState::Interrupted,
                        Some("Orbyn stopped while this run was active."),
                    ),
                };
                let (to, message) = if let Some(message) = preparation_message.as_deref() { (RunState::Failed, Some(message)) } else { (to, message) };
                let (_, expired) = close_run(
                    tx,
                    appended,
                    &run_id,
                    &thread_id,
                    to,
                    message,
                    "system:recovery",
                )?;
                if stopped {
                    recovery.stopped_runs += 1;
                } else {
                    recovery.interrupted_runs += 1;
                    if !unsent {
                        recovery.interrupted_threads.push(thread_id.clone());
                    }
                }
                recovery.expired_approvals += expired.len();
                if unsent && return_message(tx, &run_id, &thread_id)? {
                    recovery.returned_messages += 1;
                }
            }
            Ok(recovery)
        })
    }

    /// Records a stop before anything is signalled, so a process that dies in between
    /// still reads as a stop and not as a crash that interrupted the work.
    pub fn request_stop(&self, run_id: &str) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute("UPDATE runs SET stop_requested = 1 WHERE id = ?1", [run_id])?;
            Ok(())
        })
    }

    pub fn active_runs(&self) -> Result<Vec<Run>> {
        let conn = self.reader();
        let mut statement = conn.prepare(&format!(
            "SELECT {RUN_COLUMNS} FROM runs WHERE state IN {}",
            super::ACTIVE_STATES
        ))?;
        let rows = statement.query_map([], run_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn active_runs_for_engine(&self, engine: &str) -> Result<i64> {
        Ok(self.reader().query_row(
            &format!(
                "SELECT COUNT(*) FROM runs WHERE engine = ?1 AND state IN {}",
                super::ACTIVE_STATES
            ),
            [engine],
            |row| row.get(0),
        )?)
    }
}

fn item_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadItemRecord> {
    let raw: String = row.get("raw")?;
    Ok(ThreadItemRecord {
        item_id: row.get("item_id")?,
        run_id: row.get("run_id")?,
        kind: row.get("kind")?,
        raw: super::parse_json(4, &raw)?,
        exit_code: row.get("exit_code")?,
        updated_at: row.get("updated_at")?,
    })
}

/// Every event a run logged, oldest first.
fn events_of_run(tx: &Transaction<'_>, run_id: &str) -> Result<Vec<AgUiEvent>> {
    let mut statement =
        tx.prepare("SELECT event FROM thread_events WHERE run_id = ?1 ORDER BY seq")?;
    let rows = statement.query_map([run_id], |row| row.get::<_, String>(0))?;
    let mut events = Vec::new();
    for text in rows {
        events.push(serde_json::from_str(&text?)?);
    }
    Ok(events)
}

/// A tool the dead process left open would show as running forever.
fn close_open_tools(
    tx: &Transaction<'_>,
    appended: &mut Appended,
    run_id: &str,
    thread_id: &str,
) -> Result<()> {
    let mut open: Vec<String> = Vec::new();
    for event in events_of_run(tx, run_id)? {
        match event {
            AgUiEvent::ToolCallStart { tool_call_id, .. } => open.push(tool_call_id),
            AgUiEvent::ToolCallEnd { tool_call_id }
            | AgUiEvent::ToolCallResult { tool_call_id, .. } => {
                open.retain(|id| *id != tool_call_id);
            }
            _ => {}
        }
    }
    for tool_call_id in open {
        for event in [
            AgUiEvent::ToolCallEnd {
                tool_call_id: tool_call_id.clone(),
            },
            AgUiEvent::ToolCallResult {
                message_id: new_id(),
                tool_call_id,
                content: "Interrupted before a result.".to_owned(),
                role: Some("tool".to_owned()),
            },
        ] {
            insert_event(tx, appended, thread_id, Some(run_id), &event)?;
        }
    }
    Ok(())
}

/// Puts a message that never reached an engine back at the front of a held queue, so
/// what was typed is neither lost nor sent again without someone choosing to. Its
/// attachment ids went with the queue row; the files stay on the thread.
fn return_message(tx: &Transaction<'_>, run_id: &str, thread_id: &str) -> Result<bool> {
    let wanted = format!("{run_id}:prompt");
    let prompt = events_of_run(tx, run_id)?
        .into_iter()
        .find_map(|event| match event {
            AgUiEvent::TextMessageContent { message_id, delta } if message_id == wanted => {
                Some(delta)
            }
            _ => None,
        });
    let Some(prompt) = prompt else {
        return Ok(false);
    };
    tx.execute(
        "INSERT INTO queued_messages (id, thread_id, prompt, attachment_ids, held, urgent, created_at)
         VALUES (?1, ?2, ?3, '[]', 1, 1, ?4)",
        params![new_id(), thread_id, prompt, now()],
    )?;
    Ok(true)
}

pub(super) fn admit_in(
    tx: &Transaction<'_>,
    appended: &mut Appended,
    epoch: &str,
    admission: &Admission<'_>,
) -> Result<Run> {
    admit_in_for_engine(tx, appended, epoch, admission, None)
}

/// The preparation retry owns an immutable provider choice; thread preferences
/// remain the owner's current selection.
pub(super) fn admit_in_for_engine(
    tx: &Transaction<'_>,
    appended: &mut Appended,
    epoch: &str,
    admission: &Admission<'_>,
    captured_engine: Option<&str>,
) -> Result<Run> {
    let &Admission {
        thread_id,
        prompt,
        actor,
    } = admission;
    let row: Option<(String, bool, bool)> = tx
        .query_row(
            "SELECT threads.engine, projects.trusted, threads.archived_at IS NOT NULL
             FROM threads JOIN projects ON projects.id = threads.project_id
             WHERE threads.id = ?1",
            [thread_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let (engine, trusted, archived) = row.ok_or_else(|| CoreError::NotFound("thread".into()))?;
    if !trusted {
        return Err(CoreError::FolderUntrusted);
    }
    if archived {
        return Err(CoreError::ThreadArchived);
    }
    if actor.starts_with("system:") && super::setup::failed(tx, thread_id)? {
        return Err(CoreError::Invalid(
            "Project setup did not finish successfully.".into(),
        ));
    }
    let engine = captured_engine.unwrap_or(&engine).to_owned();
    // Your own message wakes the thread and restores it to active work.
    tx.execute(
        "UPDATE threads SET snoozed_until = NULL, settled_at = NULL, settle_hold = 0, woke_at = NULL
         WHERE id = ?1",
        [thread_id],
    )?;
    super::threads::clear_limit(tx, thread_id)?;
    if !admission.actor.starts_with("system:") {
        tx.execute(
            "UPDATE threads SET resume_tries = 0 WHERE id = ?1",
            [thread_id],
        )?;
    }
    let run = Run {
        id: new_id(),
        thread_id: thread_id.to_owned(),
        state: RunState::Admitted,
        error: None,
        started_at: now(),
        ended_at: None,
    };
    let inserted = tx.execute(
        "INSERT INTO runs (id, thread_id, engine, state, owner_epoch, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            run.id,
            run.thread_id,
            engine,
            wire_name(run.state)?,
            epoch,
            run.started_at
        ],
    );
    match inserted {
        Err(rusqlite::Error::SqliteFailure(failure, _))
            if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            return Err(CoreError::ThreadBusy);
        }
        other => other?,
    };
    insert_audit(
        tx,
        &AuditRecord {
            actor: actor.to_owned(),
            action: "run.admit".into(),
            target: engine,
            decision: None,
            source: "user".into(),
            thread_id: Some(run.thread_id.clone()),
            run_id: Some(run.id.clone()),
            detail: json!({ "prompt_bytes": prompt.len() }),
        },
    )?;
    let events = [
        AgUiEvent::RunStarted {
            thread_id: run.thread_id.clone(),
            run_id: run.id.clone(),
        },
        AgUiEvent::TextMessageStart {
            message_id: format!("{}:prompt", run.id),
            role: "user".into(),
        },
        AgUiEvent::TextMessageContent {
            message_id: format!("{}:prompt", run.id),
            delta: prompt.to_owned(),
        },
        AgUiEvent::TextMessageEnd {
            message_id: format!("{}:prompt", run.id),
        },
    ];
    for event in &events {
        insert_event(tx, appended, thread_id, Some(&run.id), event)?;
    }
    super::setup::capture_input(tx, &run, prompt, &[])?;
    Ok(run)
}

fn close_run(
    tx: &Transaction<'_>,
    appended: &mut Appended,
    run_id: &str,
    thread_id: &str,
    to: RunState,
    error: Option<&str>,
    actor: &str,
) -> Result<(Run, Vec<Approval>)> {
    let expired = expire_pending(tx, appended, run_id, thread_id, actor)?;
    super::questions::expire_questions(tx, appended, run_id, actor)?;
    // A stop, failure or crash keeps queued work from starting on its own, except
    // a message whose send-now caused the stop.
    if to != RunState::Completed {
        let preparation =
            to == RunState::Failed && super::setup::owns_failure(tx, thread_id, run_id)?;
        tx.execute(
            "UPDATE queued_messages SET preparation_run_id = CASE WHEN ?2 AND held = 0 THEN ?3 WHEN ?2 THEN preparation_run_id ELSE NULL END, held = 1 WHERE thread_id = ?1 AND urgent = 0",
            params![thread_id, preparation, run_id],
        )?;
    }
    // An answer or a failure ends a snooze early.
    super::threads::wake_early(tx, thread_id)?;
    let target = wire_name(to)?;
    insert_audit(
        tx,
        &AuditRecord {
            actor: actor.to_owned(),
            action: "run.finish".into(),
            target,
            decision: None,
            source: "system".into(),
            thread_id: Some(thread_id.to_owned()),
            run_id: Some(run_id.to_owned()),
            detail: error.map_or(Value::Null, |message| json!({ "error": message })),
        },
    )?;
    tx.execute(
        "UPDATE runs SET state = ?2, error = ?3, ended_at = ?4 WHERE id = ?1",
        params![run_id, wire_name(to)?, error, now()],
    )?;
    let event = match to {
        RunState::Completed => AgUiEvent::RunFinished {
            thread_id: thread_id.to_owned(),
            run_id: run_id.to_owned(),
            outcome: Some(json!({ "type": "success" })),
        },
        RunState::Cancelled => AgUiEvent::RunFinished {
            thread_id: thread_id.to_owned(),
            run_id: run_id.to_owned(),
            outcome: Some(json!({ "type": "cancelled" })),
        },
        RunState::Interrupted => AgUiEvent::RunError {
            message: error.unwrap_or("Run interrupted.").to_owned(),
            code: Some("interrupted".into()),
        },
        _ => AgUiEvent::RunError {
            message: error.unwrap_or("The engine failed.").to_owned(),
            code: Some(if super::setup::owns_failure(tx, thread_id, run_id)? {
                let captured: bool = tx.query_row("SELECT script IS NOT NULL AND run_id = ?2 FROM thread_setup WHERE thread_id = ?1", params![thread_id, run_id], |row| row.get(0))?;
                if captured { "workspace_preparation_failed" } else { "workspace_preparation_unavailable" }
            } else { "engine_failed" }.into()),
        },
    };
    insert_event(tx, appended, thread_id, Some(run_id), &event)?;
    let run = tx.query_row(
        &format!("SELECT {RUN_COLUMNS} FROM runs WHERE id = ?1"),
        [run_id],
        run_row,
    )?;
    Ok((run, expired))
}

fn expire_pending(
    tx: &Transaction<'_>,
    appended: &mut Appended,
    run_id: &str,
    thread_id: &str,
    actor: &str,
) -> Result<Vec<Approval>> {
    let mut statement = tx.prepare(
        "SELECT * FROM approvals WHERE run_id = ?1 AND state = 'pending' ORDER BY created_at",
    )?;
    let pending = statement
        .query_map([run_id], approval_row)?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let mut expired = Vec::with_capacity(pending.len());
    for (mut approval, target) in pending {
        let stamp = now();
        tx.execute(
            "UPDATE approvals SET state = 'expired', decided_by = ?2, decided_at = ?3
             WHERE id = ?1 AND state = 'pending'",
            params![approval.id, actor, stamp],
        )?;
        approval.state = ApprovalState::Expired;
        approval.decided_by = Some(actor.to_owned());
        approval.decided_at = Some(stamp);
        insert_audit(
            tx,
            &AuditRecord {
                actor: actor.to_owned(),
                action: "approval.expire".into(),
                target,
                decision: Some(orbyn_contracts::PolicyEffect::Deny),
                source: "system".into(),
                thread_id: Some(thread_id.to_owned()),
                run_id: Some(run_id.to_owned()),
                detail: json!({ "approval_id": approval.id }),
            },
        )?;
        insert_event(
            tx,
            appended,
            thread_id,
            Some(run_id),
            &activity_event(&approval)?,
        )?;
        expired.push(approval);
    }
    Ok(expired)
}
