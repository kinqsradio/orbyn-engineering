//! The durable first-turn setup fence. No setup process is owned by SQLite.
use rusqlite::{OptionalExtension, Transaction, params};

use super::Store;
use crate::error::{CoreError, Result};

pub(crate) struct NewSetup {
    pub name: String,
    pub wait_for_exit: bool,
}

pub(crate) struct SetupRecord {
    pub owner: String,
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
    tx.execute("INSERT INTO thread_setup(thread_id, owner_epoch, name, wait_for_exit, status) VALUES (?1, ?2, ?3, ?4, 'preparing')", params![id, epoch, setup.name, setup.wait_for_exit])?;
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

impl Store {
    pub(crate) fn is_first_run(&self, thread: &str, run: &str) -> Result<bool> {
        Ok(self.reader().query_row(
            "SELECT EXISTS (SELECT 1 FROM runs WHERE id = ?2 AND id =
             (SELECT id FROM runs WHERE thread_id = ?1 ORDER BY rowid LIMIT 1))",
            params![thread, run],
            |row| row.get(0),
        )?)
    }

    pub(crate) fn setup(&self, id: &str) -> Result<Option<SetupRecord>> {
        let row = self.reader().query_row(
            "SELECT owner_epoch, name, wait_for_exit, status, terminal_id, exit_code FROM thread_setup WHERE thread_id = ?1", [id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, bool>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<i32>>(5)?)),
        ).optional()?;
        row.map(
            |(owner, name, wait_for_exit, status, terminal_id, exit_code)| {
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
            Ok(())
        })
    }

    pub(crate) fn finish_setup(&self, id: &str, code: i32) -> Result<()> {
        self.commit(|tx, _| {
            let changed = tx.execute("UPDATE thread_setup SET status = 'finished', exit_code = ?3 WHERE thread_id = ?1 AND owner_epoch = ?2 AND status = 'running'", params![id, self.epoch, code])?;
            if changed != 1 { return Err(CoreError::StaleOwner); }
            Ok(())
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
}
