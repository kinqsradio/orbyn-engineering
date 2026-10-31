//! Run lifecycle writes. Every transition is a compare-and-set on the previous
//! state and the owner epoch, so a late event or a stale process cannot move a run.

use orbyn_contracts::{AgUiEvent, Approval, ApprovalState, Run, RunState, ThreadEvent};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::approvals::{activity_event, approval_row};
use super::{Appended, AuditRecord, Store, insert_audit, insert_event, run_row, wire_name};
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
                "UPDATE threads SET engine_session = ?2 WHERE id = ?1",
                params![guard.thread_id, session],
            )?;
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
                "SELECT id, thread_id FROM runs
                 WHERE state IN {} AND owner_epoch <> ?1",
                super::ACTIVE_STATES
            ))?;
            let orphans = statement
                .query_map([&self.epoch], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            let mut recovery = Recovery::default();
            for (run_id, thread_id) in orphans {
                let (_, expired) = close_run(
                    tx,
                    appended,
                    &run_id,
                    &thread_id,
                    RunState::Interrupted,
                    Some("Orbyn stopped while this run was active."),
                    "system:recovery",
                )?;
                recovery.interrupted_runs += 1;
                recovery.expired_approvals += expired.len();
            }
            Ok(recovery)
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

pub(super) fn admit_in(
    tx: &Transaction<'_>,
    appended: &mut Appended,
    epoch: &str,
    admission: &Admission<'_>,
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
    // Your own message wakes the thread and restores it to active work.
    tx.execute(
        "UPDATE threads SET snoozed_until = NULL, settled_at = NULL, settle_hold = 0
         WHERE id = ?1",
        [thread_id],
    )?;
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
    // A stop, failure or crash keeps queued work from starting on its own, except
    // a message whose send-now caused the stop.
    if to != RunState::Completed {
        tx.execute(
            "UPDATE queued_messages SET held = 1 WHERE thread_id = ?1 AND urgent = 0",
            [thread_id],
        )?;
    }
    // An answer or a failure ends a snooze early.
    tx.execute(
        "UPDATE threads SET snoozed_until = NULL WHERE id = ?1",
        [thread_id],
    )?;
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
            code: Some("engine_failed".into()),
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
