//! The durable first-turn setup fence. No setup process is owned by SQLite.
use crate::project_setup::PreparationCapture;
use orbyn_contracts::{ModelSelection, ProjectScript, Run};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use super::Store;
use crate::error::{CoreError, Result};

pub(crate) struct NewSetup {
    pub name: String,
    pub wait_for_exit: bool,
    pub script: Option<ProjectScript>,
}

pub(crate) struct SetupRecord {
    pub owner: String,
    pub run_id: Option<String>,
    pub name: String,
    pub wait_for_exit: bool,
    pub state: SetupState,
}

pub(crate) enum SetupState {
    Preparing,
    Running { terminal_id: String },
    Finished { code: i32 },
    Failed { started: bool },
}

pub(super) fn insert(tx: &Transaction<'_>, id: &str, epoch: &str, setup: &NewSetup) -> Result<()> {
    tx.execute("INSERT INTO thread_setup(thread_id, owner_epoch, name, wait_for_exit, status, script) VALUES (?1, ?2, ?3, ?4, 'preparing', ?5)", params![id, epoch, setup.name, setup.wait_for_exit, setup.script.as_ref().map(serde_json::to_string).transpose()?])?;
    Ok(())
}

/// Failed preparation holds queued work independently of the latest run. A new
/// user turn may run, but does not acknowledge or release preparation's queue.
pub(super) fn failed(tx: &Transaction<'_>, thread: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM thread_setup WHERE thread_id = ?1 AND
          ((status = 'failed' AND (wait_for_exit = 1 OR terminal_id IS NULL)) OR
           (status = 'finished' AND wait_for_exit = 1 AND exit_code <> 0)))",
        [thread],
        |row| row.get(0),
    )?)
}

/// The run whose preparation owns a hold, including late messages after failure.
pub(super) fn hold_owner(tx: &Transaction<'_>, thread: &str) -> Result<Option<String>> {
    if !failed(tx, thread)? {
        return Ok(None);
    }
    Ok(tx.query_row("SELECT COALESCE(run_id, (SELECT id FROM runs WHERE thread_id = ?1 ORDER BY rowid LIMIT 1)) FROM thread_setup WHERE thread_id = ?1", [thread], |row| row.get(0)).optional()?.flatten())
}

pub(super) fn owns_failure(tx: &Transaction<'_>, thread: &str, run: &str) -> Result<bool> {
    Ok(hold_owner(tx, thread)?.as_deref() == Some(run))
}

pub(super) fn capture_input(
    tx: &Transaction<'_>,
    run: &Run,
    prompt: &str,
    attachments: &[String],
) -> Result<()> {
    let selection = tx
        .query_row(
            "SELECT t.engine, t.model, t.effort, t.options FROM threads t
        JOIN thread_setup s ON s.thread_id = t.id
        WHERE t.id = ?1 AND (s.run_id IS NULL OR s.run_id = ?2)
          AND NOT EXISTS (SELECT 1 FROM runs WHERE thread_id = ?1 AND id <> ?2)",
            params![run.thread_id, run.id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    if let Some((engine, model, effort, options)) = selection {
        let selection = ModelSelection {
            model,
            effort,
            options: serde_json::from_str(&options)?,
        };
        tx.execute("UPDATE thread_setup SET run_id = ?2, prompt = ?3, attachment_ids = ?4, engine = ?5, model_selection = ?6
            WHERE thread_id = ?1", params![run.thread_id, run.id, prompt, serde_json::to_string(attachments)?, engine, serde_json::to_string(&selection)?])?;
    }
    Ok(())
}

fn load_capture(conn: &Connection, thread: &str, failed_run: &str) -> Result<PreparationCapture> {
    let captured = conn
        .query_row(
            "SELECT script, prompt, attachment_ids, engine, model_selection FROM thread_setup
        WHERE thread_id = ?1 AND run_id = ?2
          AND EXISTS (SELECT 1 FROM runs WHERE id = ?2 AND thread_id = ?1 AND state = 'failed')",
            params![thread, failed_run],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((Some(script), Some(prompt), Some(attachments), Some(engine), Some(selection))) =
        captured
    else {
        return Err(CoreError::Invalid(
            "This run has no captured preparation to retry.".into(),
        ));
    };
    Ok(PreparationCapture {
        script: serde_json::from_str(&script)?,
        prompt,
        attachments: serde_json::from_str(&attachments)?,
        engine,
        selection: serde_json::from_str(&selection)?,
    })
}

pub(crate) struct PreparationRetry {
    pub run: Run,
    pub thread: orbyn_contracts::Thread,
    pub prompt: String,
    pub attachments: Vec<String>,
    pub script: ProjectScript,
}

impl Store {
    pub(crate) fn preparation_capture(
        &self,
        thread: &str,
        failed_run: &str,
    ) -> Result<PreparationCapture> {
        load_capture(&self.reader(), thread, failed_run)
    }

    pub(crate) fn is_preparation_retry(&self, run: &str) -> Result<bool> {
        Ok(self.reader().query_row(
            "SELECT preparation_retry_of IS NOT NULL FROM runs WHERE id = ?1",
            [run],
            |row| row.get(0),
        )?)
    }

    /// The failure item, rather than the latest user turn, owns the Retry action.
    pub fn preparation_retry_run(&self, thread: &str) -> Result<Option<String>> {
        self.thread(thread)?;
        Ok(self
            .reader()
            .query_row(
                "SELECT run_id FROM thread_setup
             WHERE thread_id = ?1 AND script IS NOT NULL AND prompt IS NOT NULL
               AND attachment_ids IS NOT NULL AND engine IS NOT NULL AND model_selection IS NOT NULL
               AND ((status = 'failed' AND (wait_for_exit = 1 OR terminal_id IS NULL))
                 OR (status = 'finished' AND wait_for_exit = 1 AND exit_code <> 0))
               AND EXISTS (SELECT 1 FROM runs WHERE id = thread_setup.run_id
                           AND thread_id = ?1 AND state = 'failed')
               AND NOT EXISTS (SELECT 1 FROM runs WHERE thread_id = ?1
                 AND state IN ('admitted', 'starting', 'running', 'awaiting_approval'))
               AND EXISTS (SELECT 1 FROM threads WHERE id = ?1 AND archived_at IS NULL)",
                [thread],
                |row| row.get(0),
            )
            .optional()?
            .flatten())
    }

    /// Capture the first admission and its attachments in the same transaction.
    pub(crate) fn admit_prepared_run(
        &self,
        admission: super::Admission<'_>,
        attachments: &[String],
    ) -> Result<Run> {
        self.commit(|tx, appended| {
            let run = super::runs::admit_in(tx, appended, &self.epoch, &admission)?;
            capture_input(tx, &run, admission.prompt, attachments)?;
            Ok(run)
        })
    }

    /// Terminal run history stays immutable. Retry creates a new admission and
    /// moves only the captured preparation fence to that attempt, atomically.
    pub(crate) fn retry_preparation(
        &self,
        thread: &str,
        failed_run: &str,
        actor: &str,
        expected: &PreparationCapture,
    ) -> Result<PreparationRetry> {
        self.commit(|tx, appended| {
            let capture = load_capture(tx, thread, failed_run)?;
            if &capture != expected { return Err(CoreError::StaleOwner); }
            if !owns_failure(tx, thread, failed_run)? {
                return Err(CoreError::Invalid("This preparation has not failed.".into()));
            }
            let latest: bool = tx.query_row("SELECT id = ?2 FROM runs WHERE thread_id = ?1 ORDER BY rowid DESC LIMIT 1", params![thread, failed_run], |row| row.get(0))?;
            let mut execution_thread = tx.query_row("SELECT * FROM threads WHERE id = ?1", [thread], super::thread_row)?;
            let handoff = if execution_thread.engine != capture.engine {
                let through: i64 = tx.query_row("SELECT next_seq - 1 FROM threads WHERE id = ?1", [thread], |row| row.get(0))?;
                Some(self.handoff_text(thread, through)?)
            } else { None };
            execution_thread.engine.clone_from(&capture.engine);
            execution_thread.model.clone_from(&capture.selection.model);
            execution_thread.effort.clone_from(&capture.selection.effort);
            execution_thread.options.clone_from(&capture.selection.options);
            let run = super::runs::admit_in_for_engine(tx, appended, &self.epoch, &super::Admission { thread_id: thread, prompt: &capture.prompt, actor }, Some(&capture.engine))?;
            tx.execute("UPDATE runs SET preparation_retry_of = ?2, preparation_handoff = ?3 WHERE id = ?1", params![run.id, failed_run, handoff])?;
            tx.execute("UPDATE thread_setup SET owner_epoch = ?2, run_id = ?3, status = 'preparing', terminal_id = NULL, exit_code = NULL WHERE thread_id = ?1", params![thread, self.epoch, run.id])?;
            if latest {
                tx.execute("UPDATE queued_messages SET preparation_run_id = ?3 WHERE thread_id = ?1 AND preparation_run_id = ?2", params![thread, failed_run, run.id])?;
            }
            Ok(PreparationRetry { run, thread: execution_thread, prompt: capture.prompt, attachments: capture.attachments, script: capture.script })
        })
    }
    pub(crate) fn owns_preparation(&self, thread: &str, run: &str) -> Result<bool> {
        Ok(self.reader().query_row(
            "SELECT EXISTS (SELECT 1 FROM runs WHERE id = ?2 AND thread_id = ?1 AND id =
             COALESCE((SELECT run_id FROM thread_setup WHERE thread_id = ?1),
               (SELECT id FROM runs WHERE thread_id = ?1 ORDER BY rowid LIMIT 1)))",
            params![thread, run],
            |row| row.get(0),
        )?)
    }

    pub(crate) fn setup(&self, id: &str) -> Result<Option<SetupRecord>> {
        let row = self.reader().query_row(
            "SELECT owner_epoch, name, wait_for_exit, status, terminal_id, exit_code, run_id FROM thread_setup WHERE thread_id = ?1", [id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, bool>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<i32>>(5)?, row.get::<_, Option<String>>(6)?)),
        ).optional()?;
        row.map(
            |(owner, name, wait_for_exit, status, terminal_id, exit_code, run_id)| {
                let state = match (status.as_str(), terminal_id, exit_code) {
                    ("preparing", None, None) => SetupState::Preparing,
                    ("running", Some(terminal_id), None) => SetupState::Running { terminal_id },
                    ("finished", Some(_), Some(code)) => SetupState::Finished { code },
                    ("failed", terminal, None) => SetupState::Failed {
                        started: terminal.is_some(),
                    },
                    _ => return Err(CoreError::Internal("Invalid project setup record.".into())),
                };
                Ok(SetupRecord {
                    owner,
                    run_id,
                    name,
                    wait_for_exit,
                    state,
                })
            },
        )
        .transpose()
    }

    /// A new Core fences pending writers before accepting any engine runs.
    pub(crate) fn recover_setups(&self) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute("UPDATE thread_setup SET owner_epoch = ?1, status = 'failed', exit_code = NULL WHERE owner_epoch <> ?1 AND status IN ('preparing', 'running')", [&self.epoch])?;
            Ok(())
        })
    }

    pub(crate) fn start_setup(&self, id: &str, terminal: &str) -> Result<()> {
        self.commit(|tx, _| {
            let changed = tx.execute("UPDATE thread_setup SET status = 'running', terminal_id = ?3 WHERE thread_id = ?1 AND owner_epoch = ?2 AND status = 'preparing'", params![id, self.epoch, terminal])?;
            if changed != 1 { return Err(CoreError::StaleOwner); }
            // An async preparation has succeeded for admission once its process
            // exists. It must not wait for a terminal exit to release its hold.
            tx.execute("UPDATE queued_messages SET held = 0, preparation_run_id = NULL
                WHERE thread_id = ?1 AND preparation_run_id =
                  (SELECT run_id FROM thread_setup WHERE thread_id = ?1 AND wait_for_exit = 0)", [id])?;
            Ok(())
        })
    }

    pub(crate) fn finish_owned_setup(&self, id: &str, terminal: &str, code: i32) -> Result<()> {
        self.commit(|tx, _| {
            let changed = tx.execute("UPDATE thread_setup SET status = 'finished', exit_code = ?4 WHERE thread_id = ?1 AND owner_epoch = ?2 AND terminal_id = ?3 AND status = 'running'", params![id, self.epoch, terminal, code])?;
            if changed != 1 { return Err(CoreError::StaleOwner); }
            if code == 0 {
                tx.execute("UPDATE queued_messages SET held = 0, preparation_run_id = NULL WHERE thread_id = ?1 AND preparation_run_id = (SELECT run_id FROM thread_setup WHERE thread_id = ?1)", [id])?;
            }
            Ok(())
        })
    }

    #[cfg(test)]
    pub(crate) fn finish_setup(&self, id: &str, code: i32) -> Result<()> {
        self.commit(|tx, _| {
            let changed = tx.execute("UPDATE thread_setup SET status = 'finished', exit_code = ?3 WHERE thread_id = ?1 AND owner_epoch = ?2 AND status = 'running'", params![id, self.epoch, code])?;
            if changed != 1 { return Err(CoreError::StaleOwner); }
            Ok(())
        })
    }

    pub(crate) fn cancel_preparation_run(&self, thread: &str, run: &str) -> Result<bool> {
        self.commit(|tx, _| {
            Ok(tx.execute(
                "UPDATE thread_setup SET status = 'failed', exit_code = NULL
                WHERE thread_id = ?1 AND run_id = ?2 AND owner_epoch = ?3
                  AND (status = 'preparing' OR (status = 'running' AND wait_for_exit = 1))",
                params![thread, run, self.epoch],
            )? == 1)
        })
    }

    pub(crate) fn fail_setup(&self, id: &str) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute("UPDATE thread_setup SET status = 'failed', exit_code = NULL WHERE thread_id = ?1 AND owner_epoch = ?2 AND status IN ('preparing', 'running')", params![id, self.epoch])?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        store::{NewProject, NewThread},
        testing::TempDir,
    };

    fn retry_capture(store: &Store, thread: &str, run: &str) -> Result<PreparationRetry> {
        let capture = store.preparation_capture(thread, run)?;
        store.retry_preparation(thread, run, "user", &capture)
    }

    fn thread(
        store: &Store,
        root: &std::path::Path,
        id: &str,
        name: &str,
    ) -> Result<orbyn_contracts::Thread> {
        let project = store
            .add_project(NewProject {
                path: root.to_str().unwrap(),
                name: "Fixture",
                is_git: false,
                managed: false,
                scratch: false,
            })
            .unwrap();
        store.create_registered_thread(
            id,
            NewThread {
                project_id: project.id,
                title: "Fixture".into(),
                engine: "fixture".into(),
                model: None,
                cwd: root.to_string_lossy().into_owned(),
                worktree: None,
                skill_profile: None,
                parent_thread_id: None,
                relation: None,
                scratch: false,
            },
            Some(&NewSetup {
                name: name.into(),
                wait_for_exit: true,
                script: None,
            }),
        )
    }

    #[test]
    fn thread_and_setup_creation_are_atomic_and_deletion_cascades() {
        let dir = TempDir::new();
        let store = Store::open(&dir.path().join("state.db"), "one").unwrap();
        assert!(thread(&store, dir.path(), "invalid", "").is_err());
        assert!(store.thread("invalid").is_err());
        assert!(store.setup("invalid").unwrap().is_none());
        let made = thread(&store, dir.path(), "valid", "Setup").unwrap();
        assert!(matches!(
            store.setup(&made.id).unwrap().unwrap().state,
            SetupState::Preparing
        ));
        store.delete_thread(&made.id, "fixture").unwrap();
        assert!(store.setup(&made.id).unwrap().is_none());
    }

    #[test]
    fn recovery_fences_old_writers_and_preserves_finished_work() {
        let dir = TempDir::new();
        let path = dir.path().join("state.db");
        let old = Store::open(&path, "one").unwrap();
        thread(&old, dir.path(), "pending", "Pending").unwrap();
        thread(&old, dir.path(), "complete", "Complete").unwrap();
        old.start_setup("complete", "terminal").unwrap();
        old.finish_setup("complete", 0).unwrap();
        let new = Store::open(&path, "two").unwrap();
        new.recover_setups().unwrap();
        assert!(matches!(
            new.setup("pending").unwrap().unwrap().state,
            SetupState::Failed { started: false }
        ));
        assert!(matches!(
            old.start_setup("pending", "late"),
            Err(CoreError::StaleOwner)
        ));
        assert!(matches!(
            new.setup("complete").unwrap().unwrap().state,
            SetupState::Finished { code: 0 }
        ));
        new.recover_setups().unwrap();
        assert!(matches!(
            new.setup("pending").unwrap().unwrap().state,
            SetupState::Failed { .. }
        ));
    }
    #[test]
    fn failed_setup_holds_late_messages_and_rejects_automatic_continuations() {
        use crate::store::Admission;
        use orbyn_contracts::{ModelSelection, RunState};
        let dir = TempDir::new();
        let store = Store::open(&dir.path().join("state.db"), "one").unwrap();
        let made = thread(&store, dir.path(), "failed", "Setup").unwrap();
        store.trust_project(&made.project_id, "user").unwrap();
        store.start_setup(&made.id, "setup-terminal").unwrap();
        store.finish_setup(&made.id, 7).unwrap();
        let queued = store
            .enqueue(&made.id, "Keep me", &[], &ModelSelection::default())
            .unwrap();
        assert!(queued.held);
        // Even an explicit queue release must not acknowledge preparation.
        store.release_queue(&made.id).unwrap();
        assert!(
            store
                .admit_next(&made.id, "system:queue")
                .unwrap()
                .is_none()
        );
        assert!(store.queued(&queued.id).unwrap().held);
        assert!(
            store
                .admit_run(Admission {
                    thread_id: &made.id,
                    prompt: "Continue",
                    actor: "system:restart",
                })
                .is_err()
        );
        assert_eq!(store.run_count(&made.id).unwrap(), 0);
        // A new user turn is permitted, but leaves the preparation hold intact.
        let run = store
            .admit_run(Admission {
                thread_id: &made.id,
                prompt: "New turn",
                actor: "user",
            })
            .unwrap();
        store
            .finish_run(&run.id, RunState::Completed, None)
            .unwrap();
        assert!(
            store
                .admit_next(&made.id, "system:queue")
                .unwrap()
                .is_none()
        );
        assert!(store.queued(&queued.id).unwrap().held);
    }

    #[test]
    fn an_async_exit_does_not_hold_queued_messages() {
        let dir = TempDir::new();
        let store = Store::open(&dir.path().join("state.db"), "one").unwrap();
        let made = thread(&store, dir.path(), "async", "Setup").unwrap();
        store.trust_project(&made.project_id, "user").unwrap();
        store
            .commit(|tx, _| {
                tx.execute(
                    "UPDATE thread_setup SET wait_for_exit = 0 WHERE thread_id = ?1",
                    [&made.id],
                )?;
                Ok(())
            })
            .unwrap();
        store.start_setup(&made.id, "setup-terminal").unwrap();
        store.finish_setup(&made.id, 7).unwrap();
        let queued = store
            .enqueue(
                &made.id,
                "Run me",
                &[],
                &orbyn_contracts::ModelSelection::default(),
            )
            .unwrap();
        assert!(!queued.held);
        assert!(
            store
                .admit_next(&made.id, "system:queue")
                .unwrap()
                .is_some()
        );
    }
    #[test]
    fn schema_18_capture_stays_unavailable_and_migration_is_repeatable() {
        let dir = TempDir::new();
        let path = dir.path().join("state.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
        )
        .unwrap();
        for (version, sql) in super::super::migrations::MIGRATIONS
            .iter()
            .filter(|(version, _)| *version <= 18)
        {
            conn.execute_batch(sql).unwrap();
            conn.execute(
                "INSERT INTO schema_migrations VALUES (?1, 'fixture')",
                [version],
            )
            .unwrap();
        }
        conn.execute("INSERT INTO projects(id,name,path,trusted,is_git,created_at) VALUES ('project','Fixture','/fixture',1,0,'fixture')", []).unwrap();
        conn.execute("INSERT INTO threads(id,project_id,title,engine,cwd,created_at,updated_at) VALUES ('legacy','project','Fixture','fixture','/fixture','fixture','fixture')", []).unwrap();
        conn.execute("INSERT INTO thread_setup(thread_id,owner_epoch,name,wait_for_exit,status) VALUES ('legacy','old','Setup',1,'failed')", []).unwrap();
        drop(conn);
        let store = Store::open(&path, "new").unwrap();
        assert!(matches!(
            store.setup("legacy").unwrap().unwrap().state,
            SetupState::Failed { started: false }
        ));
        assert!(retry_capture(&store, "legacy", "missing").is_err());
        assert_eq!(store.run_count("legacy").unwrap(), 0);
        drop(store);
        let store = Store::open(&path, "again").unwrap();
        let captured: Option<String> = store
            .reader()
            .query_row(
                "SELECT script FROM thread_setup WHERE thread_id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(captured.is_none());
        assert_eq!(
            store
                .reader()
                .query_row(
                    "SELECT COUNT(*) FROM schema_migrations WHERE version = 19",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn retry_captures_attachments_and_fences_old_terminal_and_writer() {
        use crate::store::Admission;
        use orbyn_contracts::RunState;
        let dir = TempDir::new();
        let path = dir.path().join("state.db");
        let old = Store::open(&path, "old").unwrap();
        let made = thread(&old, dir.path(), "retry", "Setup").unwrap();
        old.trust_project(&made.project_id, "user").unwrap();
        let script: ProjectScript = serde_json::from_value(
            serde_json::json!({"name":"Setup", "command":"saved-command", "async":false}),
        )
        .unwrap();
        old.writer()
            .execute(
                "UPDATE thread_setup SET script = ?1 WHERE thread_id = 'retry'",
                [serde_json::to_string(&script).unwrap()],
            )
            .unwrap();
        let first = old
            .admit_prepared_run(
                Admission {
                    thread_id: &made.id,
                    prompt: "original",
                    actor: "user",
                },
                &["attachment".into()],
            )
            .unwrap();
        old.start_setup(&made.id, "first-terminal").unwrap();
        old.finish_owned_setup(&made.id, "first-terminal", 7)
            .unwrap();
        old.finish_run(&first.id, RunState::Failed, Some("preparation failed"))
            .unwrap();
        let queued = old
            .enqueue(
                &made.id,
                "queued",
                &[],
                &orbyn_contracts::ModelSelection::default(),
            )
            .unwrap();
        let owner = || {
            old.reader()
                .query_row(
                    "SELECT preparation_run_id FROM queued_messages WHERE id = ?1",
                    [&queued.id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap()
        };
        assert_eq!(owner().as_deref(), Some(first.id.as_str()));
        old.release_queue(&made.id).unwrap();
        assert!(owner().is_none());
        assert!(old.admit_next(&made.id, "system:queue").unwrap().is_none());
        assert_eq!(owner().as_deref(), Some(first.id.as_str()));
        old.mark_urgent(&queued.id).unwrap();
        assert!(owner().is_none());
        assert_eq!(
            old.preparation_retry_run(&made.id).unwrap().as_deref(),
            Some(first.id.as_str())
        );
        let retry = retry_capture(&old, &made.id, &first.id).unwrap();
        assert!(old.preparation_retry_run(&made.id).unwrap().is_none());
        assert_eq!(retry.prompt, "original");
        assert_eq!(retry.attachments, ["attachment"]);
        assert_eq!(retry.script.command, "saved-command");
        assert!(old.owns_preparation(&made.id, &retry.run.id).unwrap());
        assert!(!old.owns_preparation(&made.id, &first.id).unwrap());
        assert!(retry_capture(&old, &made.id, &first.id).is_err());
        old.start_setup(&made.id, "retry-terminal").unwrap();
        assert!(matches!(
            old.finish_owned_setup(&made.id, "first-terminal", 0),
            Err(CoreError::StaleOwner)
        ));
        let current = Store::open(&path, "current").unwrap();
        current.recover().unwrap();
        current.recover_setups().unwrap();
        assert_eq!(current.run(&retry.run.id).unwrap().state, RunState::Failed);
        let next = retry_capture(&current, &made.id, &retry.run.id).unwrap();
        current.start_setup(&made.id, "current-terminal").unwrap();
        assert!(
            !current
                .cancel_preparation_run(&made.id, &retry.run.id)
                .unwrap()
        );
        assert!(matches!(
            old.finish_owned_setup(&made.id, "retry-terminal", 0),
            Err(CoreError::StaleOwner)
        ));
        assert!(matches!(
            old.start_setup(&made.id, "late-terminal"),
            Err(CoreError::StaleOwner)
        ));
        current
            .finish_owned_setup(&made.id, "current-terminal", 0)
            .unwrap();
        current
            .finish_run(&next.run.id, RunState::Completed, None)
            .unwrap();
        assert_eq!(current.run(&first.id).unwrap().state, RunState::Failed);
    }
    #[test]
    fn retrying_async_startup_failure_releases_its_hold_when_the_process_starts() {
        use crate::store::Admission;
        use orbyn_contracts::{ModelSelection, RunState};
        let dir = TempDir::new();
        let store = Store::open(&dir.path().join("state.db"), "owner").unwrap();
        let made = thread(&store, dir.path(), "async-retry", "Setup").unwrap();
        store.trust_project(&made.project_id, "user").unwrap();
        let script: ProjectScript = serde_json::from_value(
            serde_json::json!({"name":"Setup", "command":"saved-command", "async":true}),
        )
        .unwrap();
        store
            .writer()
            .execute(
                "UPDATE thread_setup SET wait_for_exit = 0, script = ?1 WHERE thread_id = ?2",
                params![serde_json::to_string(&script).unwrap(), made.id],
            )
            .unwrap();
        let run = store
            .admit_run(Admission {
                thread_id: &made.id,
                prompt: "original",
                actor: "user",
            })
            .unwrap();
        store.fail_setup(&made.id).unwrap();
        store
            .finish_run(
                &run.id,
                RunState::Failed,
                Some("could not start preparation"),
            )
            .unwrap();
        let queued = store
            .enqueue(&made.id, "queued", &[], &ModelSelection::default())
            .unwrap();
        assert!(queued.held);
        let retry = retry_capture(&store, &made.id, &run.id).unwrap();
        assert!(store.queued(&queued.id).unwrap().held);
        store.start_setup(&made.id, "async-retry-terminal").unwrap();
        assert!(
            !store
                .cancel_preparation_run(&made.id, &retry.run.id)
                .unwrap()
        );
        assert!(!store.queued(&queued.id).unwrap().held);
        assert!(matches!(
            store.setup(&made.id).unwrap().unwrap().state,
            SetupState::Running { .. }
        ));
        store
            .finish_owned_setup(&made.id, "async-retry-terminal", 7)
            .unwrap();
        store
            .finish_run(&retry.run.id, RunState::Completed, None)
            .unwrap();
        assert!(!store.queued(&queued.id).unwrap().held);
    }
    #[test]
    fn exact_capture_and_provider_session_handoff_ownership_are_fenced() {
        use crate::store::Admission;
        use orbyn_contracts::RunState;
        let dir = TempDir::new();
        let store = Store::open(&dir.path().join("state.db"), "owner").unwrap();
        let made = thread(&store, dir.path(), "captured", "Setup").unwrap();
        store.trust_project(&made.project_id, "user").unwrap();
        let script: ProjectScript = serde_json::from_value(
            serde_json::json!({"name":"Setup", "command":"saved-command", "async":false}),
        )
        .unwrap();
        store
            .writer()
            .execute(
                "UPDATE thread_setup SET script = ?1 WHERE thread_id = ?2",
                params![serde_json::to_string(&script).unwrap(), made.id],
            )
            .unwrap();
        let run = store
            .admit_run(Admission {
                thread_id: &made.id,
                prompt: "original-context",
                actor: "user",
            })
            .unwrap();
        store.fail_setup(&made.id).unwrap();
        store
            .finish_run(
                &run.id,
                RunState::Failed,
                Some("could not start preparation"),
            )
            .unwrap();
        let captured = store.preparation_capture(&made.id, &run.id).unwrap();
        let mut changed_prompt = captured.clone();
        changed_prompt.prompt.push_str("changed");
        let mut changed_script = captured.clone();
        changed_script.script.command.push_str("changed");
        let mut changed_attachments = captured.clone();
        changed_attachments.attachments.push("changed".into());
        let mut changed_selection = captured.clone();
        changed_selection.selection.model = Some("changed".into());
        let mut changed_provider = captured.clone();
        changed_provider.engine = "changed".into();
        for changed in [
            changed_prompt,
            changed_script,
            changed_attachments,
            changed_selection,
            changed_provider,
        ] {
            assert!(matches!(
                store.retry_preparation(&made.id, &run.id, "user", &changed),
                Err(CoreError::StaleOwner)
            ));
            assert_eq!(store.run_count(&made.id).unwrap(), 1);
        }
        store
            .switch_thread_engine(
                &made.id,
                "other",
                &ModelSelection::default(),
                "other-handoff",
            )
            .unwrap();
        store
            .writer()
            .execute(
                "UPDATE threads SET engine_session = 'other-session' WHERE id = ?1",
                [&made.id],
            )
            .unwrap();
        let retry = store
            .retry_preparation(&made.id, &run.id, "user", &captured)
            .unwrap();
        assert_eq!(retry.thread.engine, "fixture");
        assert!(!store.run_owns_engine(&retry.run.id).unwrap());
        assert!(store.run_engine_session(&retry.run.id).unwrap().is_none());
        let context = store.run_handoff(&retry.run.id).unwrap().unwrap();
        assert!(context.contains("original-context"));
        assert!(!context.contains("other-handoff"));
        store
            .set_engine_session(&retry.run.id, "wrong-provider-session")
            .unwrap();
        assert_eq!(
            store.engine_session(&made.id).unwrap().as_deref(),
            Some("other-session")
        );
        assert!(matches!(
            store.set_run_handoff(&retry.run.id, "wrong-provider-recovery"),
            Err(CoreError::StaleOwner)
        ));
        store
            .finish_run(&retry.run.id, RunState::Completed, None)
            .unwrap();
        assert_eq!(
            store.pending_handoff(&made.id).unwrap().as_deref(),
            Some("other-handoff")
        );
        assert_eq!(
            store.engine_session(&made.id).unwrap().as_deref(),
            Some("other-session")
        );
    }
}
