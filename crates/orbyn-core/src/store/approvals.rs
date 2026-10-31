//! Approval writes. The first decision wins by compare-and-set; losers get the
//! existing outcome. The audit row is committed with the decision and therefore
//! before the engine hears about it.

use orbyn_contracts::{
    ActionKind, AgUiEvent, Approval, ApprovalState, PolicyDecision, PolicyEffect, RunState,
};
use rusqlite::{OptionalExtension, Row, params};
use serde_json::{Value, json};

use super::runs::{guard_active, set_state};
use super::{AuditRecord, Store, insert_audit, insert_event, parse_json, parse_wire, wire_name};
use crate::error::{CoreError, Result};
use crate::util::{new_id, now};

pub struct NewApproval {
    /// Chosen by the caller so its waiter is registered before the row exists.
    pub id: String,
    pub run_id: String,
    pub engine: String,
    pub kind: ActionKind,
    pub target: String,
    pub summary: String,
    pub detail: Value,
    pub decision: PolicyDecision,
}

/// The allow rule stored by a `remember` decision.
pub struct RememberRule {
    pub kind: ActionKind,
    pub target: String,
    pub engine: String,
}

pub(super) fn activity_event(approval: &Approval) -> Result<AgUiEvent> {
    Ok(AgUiEvent::ActivitySnapshot {
        message_id: approval.id.clone(),
        activity_type: "approval".into(),
        content: serde_json::to_value(approval)?,
        replace: Some(true),
    })
}

/// An approval with its stored target.
pub(super) fn approval_row(row: &Row<'_>) -> rusqlite::Result<(Approval, String)> {
    let detail: String = row.get("detail")?;
    Ok((
        Approval {
            id: row.get("id")?,
            thread_id: row.get("thread_id")?,
            run_id: row.get("run_id")?,
            kind: parse_wire(4, row.get("kind")?)?,
            summary: row.get("summary")?,
            detail: parse_json(7, &detail)?,
            state: parse_wire(8, row.get("state")?)?,
            decided_by: row.get("decided_by")?,
            decided_at: row.get("decided_at")?,
            created_at: row.get("created_at")?,
        },
        row.get("target")?,
    ))
}

impl Store {
    /// Creates a pending approval and moves the run to `awaiting_approval`.
    /// Fails for a finished run, which the caller must treat as a denial.
    pub fn create_approval(&self, new: NewApproval) -> Result<Approval> {
        self.commit(|tx, appended| {
            let guard = guard_active(tx, &self.epoch, &new.run_id)?;
            let approval = Approval {
                id: new.id,
                thread_id: guard.thread_id.clone(),
                run_id: new.run_id.clone(),
                kind: new.kind,
                summary: new.summary,
                detail: new.detail,
                state: ApprovalState::Pending,
                decided_by: None,
                decided_at: None,
                created_at: now(),
            };
            insert_audit(
                tx,
                &AuditRecord {
                    actor: format!("engine:{}", new.engine),
                    action: "approval.request".into(),
                    target: new.target.clone(),
                    decision: Some(new.decision.effect),
                    source: new.decision.source.clone(),
                    thread_id: Some(guard.thread_id.clone()),
                    run_id: Some(new.run_id.clone()),
                    detail: json!({ "approval_id": approval.id, "reason": new.decision.reason }),
                },
            )?;
            tx.execute(
                "INSERT INTO approvals (id, thread_id, run_id, engine, kind, target, summary,
                    detail, state, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9)",
                params![
                    approval.id,
                    approval.thread_id,
                    approval.run_id,
                    new.engine,
                    wire_name(approval.kind)?,
                    new.target,
                    approval.summary,
                    serde_json::to_string(&approval.detail)?,
                    approval.created_at
                ],
            )?;
            // A question for you ends a snooze early.
            super::threads::wake_early(tx, &guard.thread_id)?;
            match guard.state {
                RunState::Starting => set_state(
                    tx,
                    &new.run_id,
                    RunState::Starting,
                    RunState::AwaitingApproval,
                )?,
                RunState::Running => set_state(
                    tx,
                    &new.run_id,
                    RunState::Running,
                    RunState::AwaitingApproval,
                )?,
                _ => {}
            }
            let record = insert_event(
                tx,
                appended,
                &guard.thread_id,
                Some(&new.run_id),
                &activity_event(&approval)?,
            )?;
            tx.execute(
                "UPDATE approvals SET event_seq = ?2 WHERE id = ?1",
                params![approval.id, record.seq],
            )?;
            Ok(approval)
        })
    }

    /// Records the first decision. A later decision fails with `AlreadyDecided`
    /// carrying the outcome that stands.
    pub fn decide_approval(
        &self,
        id: &str,
        allow: bool,
        remember: bool,
        actor: &str,
    ) -> Result<Approval> {
        let state = if allow {
            ApprovalState::Allowed
        } else {
            ApprovalState::Denied
        };
        self.resolve(id, state, remember && allow, actor)
    }

    /// Expires one approval, leaving an existing decision untouched. Returns the
    /// outcome that stands either way.
    pub fn expire_approval(&self, id: &str, actor: &str) -> Result<Approval> {
        match self.resolve(id, ApprovalState::Expired, false, actor) {
            Err(CoreError::AlreadyDecided(existing)) => Ok(*existing),
            other => other,
        }
    }

    fn resolve(
        &self,
        id: &str,
        state: ApprovalState,
        remember: bool,
        actor: &str,
    ) -> Result<Approval> {
        self.commit(|tx, appended| {
            let row = tx
                .query_row("SELECT * FROM approvals WHERE id = ?1", [id], approval_row)
                .optional()?;
            let (mut approval, target) =
                row.ok_or_else(|| CoreError::NotFound("approval".into()))?;
            if approval.state != ApprovalState::Pending {
                return Err(CoreError::AlreadyDecided(Box::new(approval)));
            }
            let guard = guard_active(tx, &self.epoch, &approval.run_id)?;
            let engine: String =
                tx.query_row("SELECT engine FROM approvals WHERE id = ?1", [id], |row| {
                    row.get(0)
                })?;
            let effect = if state == ApprovalState::Allowed {
                PolicyEffect::Allow
            } else {
                PolicyEffect::Deny
            };
            insert_audit(
                tx,
                &AuditRecord {
                    actor: actor.to_owned(),
                    action: format!("approval.{}", wire_name(state)?),
                    target: target.clone(),
                    decision: Some(effect),
                    source: "user".into(),
                    thread_id: Some(guard.thread_id.clone()),
                    run_id: Some(approval.run_id.clone()),
                    detail: json!({ "approval_id": id, "remember": remember }),
                },
            )?;
            let stamp = now();
            let changed = tx.execute(
                "UPDATE approvals SET state = ?2, decided_by = ?3, decided_at = ?4
                 WHERE id = ?1 AND state = 'pending'",
                params![id, wire_name(state)?, actor, stamp],
            )?;
            if changed == 0 {
                return Err(CoreError::Internal(
                    "approval changed in transaction".into(),
                ));
            }
            approval.state = state;
            approval.decided_by = Some(actor.to_owned());
            approval.decided_at = Some(stamp.clone());
            if remember {
                self.remember_rule(
                    tx,
                    &RememberRule {
                        kind: approval.kind,
                        target,
                        engine,
                    },
                    actor,
                    &stamp,
                )?;
            }
            let remaining = super::questions::open_requests(tx, &approval.run_id)?;
            if remaining == 0 && guard.state == RunState::AwaitingApproval {
                set_state(
                    tx,
                    &approval.run_id,
                    RunState::AwaitingApproval,
                    RunState::Running,
                )?;
            }
            insert_event(
                tx,
                appended,
                &guard.thread_id,
                Some(&approval.run_id),
                &activity_event(&approval)?,
            )?;
            Ok(approval)
        })
    }

    fn remember_rule(
        &self,
        tx: &rusqlite::Transaction<'_>,
        rule: &RememberRule,
        actor: &str,
        stamp: &str,
    ) -> Result<()> {
        // `=` keeps a target such as `rm *` from becoming a wildcard grant.
        let pattern = format!("={}", rule.target);
        insert_audit(
            tx,
            &AuditRecord {
                actor: actor.to_owned(),
                action: "policy.remember".into(),
                target: pattern.clone(),
                decision: Some(PolicyEffect::Allow),
                source: "user".into(),
                thread_id: None,
                run_id: None,
                detail: json!({ "engine": rule.engine }),
            },
        )?;
        tx.execute(
            "INSERT INTO policy_rules (id, effect, kind, pattern, engine, note, created_at)
             VALUES (?1, 'allow', ?2, ?3, ?4, 'Remembered from an approval', ?5)",
            params![new_id(), wire_name(rule.kind)?, pattern, rule.engine, stamp],
        )?;
        Ok(())
    }

    pub fn approval(&self, id: &str) -> Result<Approval> {
        self.reader()
            .query_row("SELECT * FROM approvals WHERE id = ?1", [id], approval_row)
            .optional()?
            .map(|(approval, _)| approval)
            .ok_or_else(|| CoreError::NotFound("approval".into()))
    }

    /// The target an approval was requested for, and the log position of its
    /// request, which is where an external resume continues from.
    pub fn approval_position(&self, id: &str) -> Result<(String, i64)> {
        self.reader()
            .query_row(
                "SELECT target, event_seq FROM approvals WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound("approval".into()))
    }

    pub fn list_approvals(&self, state: Option<ApprovalState>) -> Result<Vec<Approval>> {
        let conn = self.reader();
        let state = state.map(wire_name).transpose()?;
        let mut statement = conn.prepare(
            "SELECT * FROM approvals WHERE (?1 IS NULL OR state = ?1)
             ORDER BY created_at DESC LIMIT 500",
        )?;
        let rows = statement.query_map([state], approval_row)?;
        rows.map(|row| Ok(row?.0)).collect()
    }

    pub fn pending_for_thread(&self, thread_id: &str) -> Result<Vec<Approval>> {
        let conn = self.reader();
        let mut statement = conn.prepare(
            "SELECT * FROM approvals WHERE thread_id = ?1 AND state = 'pending'
             ORDER BY created_at",
        )?;
        let rows = statement.query_map([thread_id], approval_row)?;
        rows.map(|row| Ok(row?.0)).collect()
    }
}
