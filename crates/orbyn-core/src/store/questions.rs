//! Engine questions. Like an approval, an open question holds its run in
//! `awaiting_approval`, and the first answer wins by compare-and-set.

use std::collections::BTreeMap;

use orbyn_contracts::{AgUiEvent, Question, QuestionRequest, QuestionState, RunState};
use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde_json::json;

use super::runs::{guard_active, set_state};
use super::{
    Appended, AuditRecord, Store, insert_audit, insert_event, parse_json, parse_wire, wire_name,
};
use crate::error::{CoreError, Result};
use crate::util::now;

/// Stands in for a secret answer anywhere it could be read back.
const HIDDEN: &str = "[hidden]";

fn activity(request: &QuestionRequest) -> Result<AgUiEvent> {
    Ok(AgUiEvent::ActivitySnapshot {
        message_id: request.id.clone(),
        activity_type: "question".into(),
        content: serde_json::to_value(request)?,
        replace: Some(true),
    })
}

fn question_row(row: &Row<'_>) -> rusqlite::Result<QuestionRequest> {
    let questions: String = row.get("questions")?;
    let answers: Option<String> = row.get("answers")?;
    Ok(QuestionRequest {
        id: row.get("id")?,
        thread_id: row.get("thread_id")?,
        run_id: row.get("run_id")?,
        questions: parse_json(3, &questions)?,
        state: parse_wire(4, row.get("state")?)?,
        answers: answers.map(|text| parse_json(5, &text)).transpose()?,
        decided_by: row.get("decided_by")?,
        decided_at: row.get("decided_at")?,
        created_at: row.get("created_at")?,
    })
}

/// Open approvals and questions together: the run waits until both are done.
pub(super) fn open_requests(tx: &Transaction<'_>, run_id: &str) -> Result<i64> {
    Ok(tx.query_row(
        "SELECT (SELECT COUNT(*) FROM approvals WHERE run_id = ?1 AND state = 'pending')
              + (SELECT COUNT(*) FROM question_requests WHERE run_id = ?1 AND state = 'pending')",
        [run_id],
        |row| row.get(0),
    )?)
}

fn close(
    tx: &Transaction<'_>,
    appended: &mut Appended,
    request: &mut QuestionRequest,
    state: QuestionState,
    answers: Option<BTreeMap<String, Vec<String>>>,
    actor: &str,
) -> Result<()> {
    let stamp = now();
    let stored = answers.as_ref().map(serde_json::to_string).transpose()?;
    tx.execute(
        "UPDATE question_requests SET state = ?2, answers = ?3, decided_by = ?4, decided_at = ?5
         WHERE id = ?1 AND state = 'pending'",
        params![request.id, wire_name(state)?, stored, actor, stamp],
    )?;
    request.state = state;
    request.answers = answers;
    request.decided_by = Some(actor.to_owned());
    request.decided_at = Some(stamp);
    insert_audit(
        tx,
        &AuditRecord {
            actor: actor.to_owned(),
            action: format!("question.{}", wire_name(state)?),
            target: request.id.clone(),
            decision: None,
            source: "user".into(),
            thread_id: Some(request.thread_id.clone()),
            run_id: Some(request.run_id.clone()),
            detail: json!({}),
        },
    )?;
    insert_event(
        tx,
        appended,
        &request.thread_id,
        Some(&request.run_id),
        &activity(request)?,
    )
    .map(|_| ())
}

/// Expires a run's open questions in the transaction that ends it.
pub(super) fn expire_questions(
    tx: &Transaction<'_>,
    appended: &mut Appended,
    run_id: &str,
    actor: &str,
) -> Result<()> {
    let mut statement =
        tx.prepare("SELECT * FROM question_requests WHERE run_id = ?1 AND state = 'pending'")?;
    let pending = statement
        .query_map([run_id], question_row)?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for mut request in pending {
        close(
            tx,
            appended,
            &mut request,
            QuestionState::Expired,
            None,
            actor,
        )?;
    }
    Ok(())
}

impl Store {
    /// Opens a question and moves the run to `awaiting_approval`. Fails for a
    /// finished run, which the caller treats as no answer.
    pub fn create_question(
        &self,
        id: &str,
        run_id: &str,
        questions: &[Question],
    ) -> Result<QuestionRequest> {
        self.commit(|tx, appended| {
            let guard = guard_active(tx, &self.epoch, run_id)?;
            let request = QuestionRequest {
                id: id.to_owned(),
                thread_id: guard.thread_id.clone(),
                run_id: run_id.to_owned(),
                questions: questions.to_vec(),
                state: QuestionState::Pending,
                answers: None,
                decided_by: None,
                decided_at: None,
                created_at: now(),
            };
            tx.execute(
                "INSERT INTO question_requests (id, thread_id, run_id, questions, state, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'pending', ?5)",
                params![
                    request.id,
                    request.thread_id,
                    request.run_id,
                    serde_json::to_string(questions)?,
                    request.created_at
                ],
            )?;
            // A question for you ends a snooze early.
            super::threads::wake_early(tx, &guard.thread_id)?;
            if matches!(guard.state, RunState::Starting | RunState::Running) {
                set_state(tx, run_id, guard.state, RunState::AwaitingApproval)?;
            }
            insert_event(
                tx,
                appended,
                &guard.thread_id,
                Some(run_id),
                &activity(&request)?,
            )?;
            Ok(request)
        })
    }

    pub fn question(&self, id: &str) -> Result<QuestionRequest> {
        self.reader()
            .query_row(
                "SELECT * FROM question_requests WHERE id = ?1",
                [id],
                question_row,
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound("question".into()))
    }

    pub fn list_questions(
        &self,
        thread_id: Option<&str>,
        state: Option<QuestionState>,
    ) -> Result<Vec<QuestionRequest>> {
        let state = state.map(wire_name).transpose()?;
        let reader = self.reader();
        let mut statement = reader.prepare(
            "SELECT * FROM question_requests
             WHERE (?1 IS NULL OR thread_id = ?1) AND (?2 IS NULL OR state = ?2)
             ORDER BY created_at LIMIT 500",
        )?;
        let rows = statement.query_map(params![thread_id, state], question_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// The first decision wins. `answers` is `None` for a dismissal or expiry;
    /// secret answers are masked here, so they never reach disk.
    pub fn settle_question(
        &self,
        id: &str,
        state: QuestionState,
        answers: Option<&BTreeMap<String, Vec<String>>>,
        actor: &str,
    ) -> Result<QuestionRequest> {
        self.commit(|tx, appended| {
            let mut request = tx
                .query_row(
                    "SELECT * FROM question_requests WHERE id = ?1",
                    [id],
                    question_row,
                )
                .optional()?
                .ok_or_else(|| CoreError::NotFound("question".into()))?;
            if request.state != QuestionState::Pending {
                return Err(CoreError::QuestionClosed(Box::new(request)));
            }
            let masked = answers.map(|answers| {
                answers
                    .iter()
                    .map(|(key, value)| {
                        let secret = request
                            .questions
                            .iter()
                            .any(|question| question.id == *key && question.secret);
                        let shown = if secret {
                            vec![HIDDEN.to_owned()]
                        } else {
                            value.clone()
                        };
                        (key.clone(), shown)
                    })
                    .collect()
            });
            close(tx, appended, &mut request, state, masked, actor)?;
            let guard = guard_active(tx, &self.epoch, &request.run_id);
            if open_requests(tx, &request.run_id)? == 0
                && let Ok(guard) = guard
                && guard.state == RunState::AwaitingApproval
            {
                set_state(
                    tx,
                    &request.run_id,
                    RunState::AwaitingApproval,
                    RunState::Running,
                )?;
            }
            Ok(request)
        })
    }

    /// The last goal reported for a thread.
    pub fn set_goal(
        &self,
        thread_id: &str,
        goal: Option<&orbyn_contracts::ThreadGoal>,
    ) -> Result<()> {
        let text = goal.map(serde_json::to_string).transpose()?;
        self.commit(|tx, appended| {
            tx.execute(
                "UPDATE threads SET goal = ?2 WHERE id = ?1",
                params![thread_id, text],
            )?;
            insert_event(
                tx,
                appended,
                thread_id,
                None,
                &AgUiEvent::Custom {
                    name: "goal.updated".into(),
                    value: json!(goal),
                },
            )
            .map(|_| ())
        })
    }
}
