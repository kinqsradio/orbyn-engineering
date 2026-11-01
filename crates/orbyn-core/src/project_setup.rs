//! First-turn admission for a worktree's captured setup action. The database owns
//! the fence; the terminal manager owns processes. There are no detached waiters.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::error::{CoreError, Result};
use crate::store::{SetupState, Store};
use crate::terminal::PtySession;

pub(crate) struct SetupManager {
    store: Arc<Store>,
    sessions: Mutex<HashMap<String, OwnedSetup>>,
    changes: watch::Sender<u64>,
}

#[derive(Clone)]
struct OwnedSetup {
    terminal_id: String,
    session: Arc<PtySession>,
}

impl SetupManager {
    pub(crate) fn new(store: Arc<Store>) -> Result<Self> {
        store.recover_setups()?;
        let (changes, _) = watch::channel(0);
        Ok(Self {
            store,
            sessions: Mutex::new(HashMap::new()),
            changes,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, OwnedSetup>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn notify(&self) {
        self.changes
            .send_modify(|version| *version = version.wrapping_add(1));
    }

    /// Created before committing the thread, so every later early return records
    /// a failed preparation instead of leaving another caller waiting forever.
    pub(crate) fn registration(&self, thread: &str) -> Registration<'_> {
        Registration {
            manager: self,
            thread: thread.into(),
            armed: true,
        }
    }

    pub(crate) fn launch(
        &self,
        thread: &str,
        spawn: impl FnOnce() -> Result<(String, Arc<PtySession>)>,
    ) -> Result<()> {
        // Cancellation and process creation use the same owner lock. If cancel
        // wins, project code never starts later while the handler is finishing.
        let mut sessions = self.lock();
        let pending = self.store.setup(thread)?.is_some_and(|record| {
            record.owner == self.store.epoch() && matches!(record.state, SetupState::Preparing)
        });
        if !pending {
            return Err(CoreError::StaleOwner);
        }
        let (terminal, session) = spawn()?;
        if let Err(error) = self.store.start_setup(thread, &terminal) {
            session.kill();
            return Err(error);
        }
        sessions.insert(
            thread.into(),
            OwnedSetup {
                terminal_id: terminal,
                session,
            },
        );
        drop(sessions);
        self.notify();
        Ok(())
    }

    fn cancel(&self, thread: &str) -> Result<()> {
        let mut sessions = self.lock();
        self.store.fail_setup(thread)?;
        if let Some(owned) = sessions.remove(thread) {
            owned.session.kill();
        }
        drop(sessions);
        self.notify();
        Ok(())
    }

    /// Only the first admitted turn belongs to worktree creation. A later user
    /// retry is a new turn, rather than an implicit rerun of project code.
    pub(crate) async fn before_first_turn(
        &self,
        thread: &str,
        run: &str,
        cancel: &CancellationToken,
    ) -> Result<bool> {
        if !self.store.is_first_run(thread, run)? {
            return Ok(true);
        }
        let mut guard = Waiting {
            manager: self,
            thread,
            armed: true,
        };
        let result = self.wait_for_setup(thread, cancel).await;
        if matches!(result, Ok(true)) {
            guard.armed = false;
        }
        result
    }

    async fn wait_for_setup(&self, thread: &str, cancel: &CancellationToken) -> Result<bool> {
        let mut changes = self.changes.subscribe();
        loop {
            if cancel.is_cancelled() {
                self.cancel(thread)?;
                return Ok(false);
            }
            let Some(record) = self.store.setup(thread)? else {
                return Ok(true);
            };
            let failed = || {
                CoreError::Invalid(format!(
                    "Setup script {} did not finish successfully.",
                    record.name
                ))
            };
            match record.state {
                SetupState::Finished { code } => {
                    return if !record.wait_for_exit || code == 0 {
                        Ok(true)
                    } else {
                        Err(failed())
                    };
                }
                SetupState::Failed { started } => {
                    return if started && !record.wait_for_exit {
                        Ok(true)
                    } else {
                        Err(failed())
                    };
                }
                SetupState::Preparing | SetupState::Running { .. }
                    if record.owner != self.store.epoch() =>
                {
                    return Err(failed());
                }
                SetupState::Running { terminal_id } => {
                    let owned = self
                        .lock()
                        .get(thread)
                        .filter(|entry| entry.terminal_id == terminal_id)
                        .cloned();
                    if let Some(owned) = owned {
                        let session = owned.session;
                        if !record.wait_for_exit {
                            return Ok(true);
                        }
                        let mut exited = session.exited();
                        loop {
                            let code = *exited.borrow_and_update();
                            if let Some(code) = code {
                                self.store.finish_setup(thread, code)?;
                                self.lock().remove(thread);
                                return if code == 0 { Ok(true) } else { Err(failed()) };
                            }
                            tokio::select! {
                                () = cancel.cancelled() => {
                                    self.cancel(thread)?;
                                    return Ok(false);
                                }
                                changed = exited.changed() => {
                                    if changed.is_err() { return Err(failed()); }
                                }
                            }
                        }
                    }
                    // Registration commits before installing its process handle.
                    // The notification after installation closes that small gap.
                }
                SetupState::Preparing => {}
            }
            tokio::select! {
                () = cancel.cancelled() => { self.cancel(thread)?; return Ok(false); }
                changed = changes.changed() => { if changed.is_err() { return Err(failed()); } }
            }
        }
    }

    pub(crate) fn forget(&self, thread: &str) {
        if let Some(owned) = self.lock().remove(thread) {
            owned.session.kill();
        }
        self.notify();
    }

    /// Called while the Core still owns its data lock. Completed actions survive
    /// a normal restart; unknown or still-running synchronous work stays failed.
    pub(crate) fn shutdown(&self) {
        for (thread, owned) in self.lock().drain() {
            let session = owned.session;
            let result = if let Some(code) = session.exit_code() {
                self.store.finish_setup(&thread, code)
            } else {
                self.store.fail_setup(&thread)
            };
            session.kill();
            if let Err(error) = result {
                tracing::warn!(%error, "could not close project setup");
            }
        }
        self.notify();
    }
}

pub(crate) struct Registration<'a> {
    manager: &'a SetupManager,
    thread: String,
    armed: bool,
}

impl Registration<'_> {
    pub(crate) fn complete(mut self) {
        self.armed = false;
    }
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if self.armed {
            if let Err(error) = self.manager.store.fail_setup(&self.thread) {
                tracing::warn!(%error, "could not close failed setup preparation");
            }
            self.manager.notify();
        }
    }
}

struct Waiting<'a> {
    manager: &'a SetupManager,
    thread: &'a str,
    armed: bool,
}
impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        if self.armed
            && let Err(error) = self.manager.cancel(self.thread)
        {
            tracing::warn!(%error, "could not cancel project setup");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        store::{Admission, NewProject, NewSetup, NewThread},
        testing::TempDir,
    };

    fn fixture() -> (TempDir, Arc<Store>, SetupManager, String) {
        let dir = TempDir::new();
        let store = Arc::new(Store::open(&dir.path().join("state.db"), "fixture").unwrap());
        let project = store
            .add_project(NewProject {
                path: dir.path().to_str().unwrap(),
                name: "Fixture",
                is_git: false,
                managed: false,
                scratch: false,
            })
            .unwrap();
        store.trust_project(&project.id, "fixture").unwrap();
        let manager = SetupManager::new(store.clone()).unwrap();
        store
            .create_registered_thread(
                "thread",
                NewThread {
                    project_id: project.id,
                    title: "Fixture".into(),
                    engine: "fixture".into(),
                    model: None,
                    cwd: dir.path().to_string_lossy().into_owned(),
                    worktree: None,
                    skill_profile: None,
                    parent_thread_id: None,
                    relation: None,
                    scratch: false,
                },
                Some(&NewSetup {
                    name: "Setup".into(),
                    wait_for_exit: true,
                }),
            )
            .unwrap();
        let run = store
            .admit_run(Admission {
                thread_id: "thread",
                prompt: "First turn",
                actor: "fixture",
            })
            .unwrap();
        (dir, store, manager, run.id)
    }

    #[tokio::test]
    async fn a_cancelled_first_turn_fences_process_creation_before_it_happens() {
        let (_dir, store, manager, run) = fixture();
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(
            !manager
                .before_first_turn("thread", &run, &cancelled)
                .await
                .unwrap()
        );
        let invoked = std::cell::Cell::new(false);
        assert!(
            manager
                .launch("thread", || {
                    invoked.set(true);
                    Err(CoreError::Invalid("should not run".into()))
                })
                .is_err()
        );
        assert!(!invoked.get(), "Project code started after cancellation");
        assert!(matches!(
            store.setup("thread").unwrap().unwrap().state,
            SetupState::Failed { started: false }
        ));
    }

    #[tokio::test]
    async fn dropping_preparation_wakes_an_admitted_first_turn_with_failure() {
        let (_dir, _store, manager, run) = fixture();
        let cancel = CancellationToken::new();
        let wait = manager.before_first_turn("thread", &run, &cancel);
        tokio::pin!(wait);
        assert!(futures_util::poll!(&mut wait).is_pending());
        drop(manager.registration("thread"));
        assert!(wait.await.is_err());
    }
    #[tokio::test]
    async fn dropping_a_wait_fences_preparation_before_process_creation() {
        let (_dir, store, manager, run) = fixture();
        let cancel = CancellationToken::new();
        {
            let wait = manager.before_first_turn("thread", &run, &cancel);
            tokio::pin!(wait);
            assert!(futures_util::poll!(&mut wait).is_pending());
        }
        assert!(matches!(
            store.setup("thread").unwrap().unwrap().state,
            SetupState::Failed { started: false }
        ));
        assert!(
            manager
                .launch("thread", || panic!(
                    "Setup started after its wait was dropped"
                ))
                .is_err()
        );
    }
    #[tokio::test]
    async fn a_later_admission_does_not_change_which_run_owns_preparation() {
        let (_dir, store, manager, run) = fixture();
        store
            .finish_run(&run, orbyn_contracts::RunState::Cancelled, None)
            .unwrap();
        let next = store
            .admit_run(Admission {
                thread_id: "thread",
                prompt: "New turn",
                actor: "user",
            })
            .unwrap();
        assert!(store.is_first_run("thread", &run).unwrap());
        assert!(!store.is_first_run("thread", &next.id).unwrap());
        let cancel = CancellationToken::new();
        let wait = manager.before_first_turn("thread", &run, &cancel);
        tokio::pin!(wait);
        assert!(futures_util::poll!(&mut wait).is_pending());
        drop(manager.registration("thread"));
        assert!(wait.await.is_err());
    }
}
