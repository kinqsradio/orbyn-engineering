//! Narrow project registration and removal for approved agent tool calls.
//!
//! A removal must check its target, descendants and active runs in the same
//! writer transaction that deletes the metadata. A later admission then either
//! wins first and blocks removal or finds its thread already gone.

use orbyn_contracts::Project;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::json;

use super::{ACTIVE_STATES, AuditRecord, Store, insert_audit, project_row};
use crate::error::{CoreError, Result};
use crate::governance::approvals::RunScope;
use crate::util::{new_id, now};

const MAX_PROJECT_THREADS: usize = 256;

/// IDs shown in a removal approval. A changed membership requires a new approval.
fn project_threads(conn: &Connection, project_id: &str) -> Result<Vec<String>> {
    let mut statement = conn.prepare("SELECT id FROM threads WHERE project_id = ?1 LIMIT ?2")?;
    let mut ids = statement
        .query_map(
            params![project_id, (MAX_PROJECT_THREADS + 1) as i64],
            |row| row.get(0),
        )?
        .collect::<std::result::Result<Vec<String>, _>>()?;
    if ids.len() > MAX_PROJECT_THREADS {
        return Err(CoreError::Invalid(format!(
            "An agent may remove a project with at most {MAX_PROJECT_THREADS} threads."
        )));
    }
    ids.sort_unstable();
    Ok(ids)
}

/// Recheck the engine run at the effect, including accepted cancellation.
fn active_caller(tx: &Transaction<'_>, store: &Store, scope: &RunScope) -> Result<String> {
    if scope.plan {
        return Err(CoreError::Invalid("Plan mode changes nothing.".into()));
    }
    let guard = super::runs::guard_active(tx, store.epoch(), &scope.run_id)?;
    if guard.thread_id != scope.thread_id {
        return Err(CoreError::StaleOwner);
    }
    let stopped: bool = tx.query_row(
        "SELECT stop_requested FROM runs WHERE id = ?1",
        [&scope.run_id],
        |row| row.get(0),
    )?;
    if stopped {
        return Err(CoreError::RunClosed);
    }
    tx.query_row(
        "SELECT project_id FROM threads WHERE id = ?1",
        [&scope.thread_id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| CoreError::NotFound("thread".into()))
}

fn agent_audit(
    scope: &RunScope,
    action: &str,
    target: &str,
    detail: serde_json::Value,
) -> AuditRecord {
    AuditRecord {
        actor: format!("engine:{}", scope.engine),
        action: action.to_owned(),
        target: target.to_owned(),
        decision: None,
        source: "tool".into(),
        thread_id: Some(scope.thread_id.clone()),
        run_id: Some(scope.run_id.clone()),
        detail,
    }
}

impl Store {
    /// Register exactly the approved path as a new, untrusted in-place project.
    /// Existing registrations are refused, including a concurrent winner.
    pub(crate) fn insert_agent_project(
        &self,
        path: &str,
        name: &str,
        is_git: bool,
        scope: &RunScope,
    ) -> Result<Project> {
        self.commit(|tx, _| {
            active_caller(tx, self, scope)?;
            let exists: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM projects WHERE path = ?1)",
                [path],
                |row| row.get(0),
            )?;
            if exists {
                return Err(CoreError::Invalid("This folder is already a project.".into()));
            }
            let project = Project {
                id: new_id(),
                name: name.to_owned(),
                path: path.to_owned(),
                trusted: false,
                is_git,
                created_at: now(),
                managed: false,
                scratch: false,
                library: false,
                project_icon: None,
                favicon_path: None,
                metadata_revision: "0".into(),
            };
            insert_audit(
                tx,
                &agent_audit(scope, "project.add", path, json!({ "is_git": is_git })),
            )?;
            tx.execute(
                "INSERT INTO projects (id, name, path, trusted, is_git, created_at, managed, scratch)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![project.id, project.name, project.path, project.trusted, project.is_git,
                    project.created_at, project.managed, project.scratch],
            )?;
            Ok(project)
        })
    }

    /// A bounded, deterministic removal preview; the write checks it again.
    pub(crate) fn agent_project_threads(&self, id: &str) -> Result<Vec<String>> {
        let conn = self.reader();
        let exists: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM projects WHERE id = ?1)",
            [id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(CoreError::NotFound("project".into()));
        }
        project_threads(&conn, id)
    }

    /// Forget one approved project's metadata and threads. Never touches files.
    pub(crate) fn remove_agent_project(
        &self,
        id: &str,
        expected_path: &str,
        expected_threads: &[String],
        library_path: &str,
        scope: &RunScope,
    ) -> Result<Vec<String>> {
        let deleted = self.commit(|tx, appended| {
            let caller_project = active_caller(tx, self, scope)?;
            let project = tx
                .query_row("SELECT * FROM projects WHERE id = ?1", [id], project_row)
                .optional()?
                .ok_or_else(|| CoreError::NotFound("project".into()))?;
            if project.id == caller_project || project.scratch || project.path == library_path {
                return Err(CoreError::Invalid("This project cannot be removed by an agent.".into()));
            }
            let threads = project_threads(tx, id)?;
            if project.path != expected_path || threads != expected_threads {
                return Err(CoreError::Invalid(
                    "The project changed since approval. Request approval again.".into(),
                ));
            }
            let busy: bool = tx.query_row(
                &format!("SELECT EXISTS (SELECT 1 FROM runs JOIN threads ON threads.id = runs.thread_id WHERE threads.project_id = ?1 AND runs.state IN {ACTIVE_STATES})"),
                [id],
                |row| row.get(0),
            )?;
            if busy {
                return Err(CoreError::ThreadBusy);
            }
            let foreign_descendant: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM threads AS parent JOIN threads AS child ON child.parent_thread_id = parent.id WHERE parent.project_id = ?1 AND child.project_id <> ?1)",
                [id],
                |row| row.get(0),
            )?;
            if foreign_descendant {
                return Err(CoreError::Invalid(
                    "A thread in another project depends on this project.".into(),
                ));
            }
            insert_audit(
                tx,
                &agent_audit(scope, "project.remove", &project.path,
                    json!({ "project_id": id, "thread_count": threads.len(), "files_removed": false })),
            )?;
            // The threads stay, archived under the project's name.
            super::tombstone_project(tx, appended, &project)?;
            Ok(threads)
        })?;
        Ok(deleted)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use orbyn_contracts::{PermissionMode, RunState};

    use super::*;
    use crate::store::{Admission, NewProject, NewThread};
    use crate::testing::TempDir;

    struct Fixture {
        store: Arc<Store>,
        scope: RunScope,
        own_project: String,
        // Close SQLite connections before the temporary directory is removed.
        _dir: TempDir,
    }

    fn project(store: &Store, path: &str, scratch: bool) -> Project {
        store
            .add_project(NewProject {
                path,
                name: path,
                is_git: false,
                managed: false,
                scratch,
            })
            .unwrap()
    }

    fn thread(store: &Store, project_id: &str, parent: Option<&str>) -> String {
        store
            .create_thread(NewThread {
                project_id: project_id.into(),
                title: "test".into(),
                engine: "fake".into(),
                model: None,
                cwd: "/fixture".into(),
                worktree: None,
                skill_profile: None,
                parent_thread_id: parent.map(str::to_owned),
                relation: parent.map(|_| "subagent".to_owned()),
                scratch: false,
            })
            .unwrap()
            .id
    }

    fn admit(store: &Store, thread_id: &str) -> Result<orbyn_contracts::Run> {
        store.admit_run(Admission {
            thread_id,
            prompt: "test",
            actor: "tester",
        })
    }

    fn fixture() -> Fixture {
        let dir = TempDir::new();
        let store = Arc::new(Store::open(&dir.path().join("store.db"), "epoch").unwrap());
        let own = project(&store, "/own", false);
        store.trust_project(&own.id, "tester").unwrap();
        let caller = thread(&store, &own.id, None);
        let run = admit(&store, &caller).unwrap();
        Fixture {
            _dir: dir,
            store,
            scope: RunScope {
                run_id: run.id,
                thread_id: caller,
                engine: "fake".into(),
                family: "fake".into(),
                write_scope: None,
                mode: PermissionMode::Supervised,
                plan: false,
            },
            own_project: own.id,
        }
    }

    fn remove(
        f: &Fixture,
        target: &Project,
        preview: &[String],
        library: &str,
    ) -> Result<Vec<String>> {
        f.store
            .remove_agent_project(&target.id, &target.path, preview, library, &f.scope)
    }

    #[test]
    fn registration_is_new_untrusted_audited_and_duplicate_does_not_return_existing() {
        let f = fixture();
        let added = f
            .store
            .insert_agent_project("/new", "new", false, &f.scope)
            .unwrap();
        assert!(!added.trusted && !added.managed && !added.scratch);
        f.store.trust_project(&added.id, "tester").unwrap();
        assert!(matches!(
            f.store.insert_agent_project("/new", "new", false, &f.scope),
            Err(CoreError::Invalid(_))
        ));
        assert!(f.store.project(&added.id).unwrap().trusted);
        let (actor, run, source): (String, String, String) = f.store.reader().query_row(
            "SELECT actor, run_id, source FROM audit_events WHERE action = 'project.add' AND target = '/new'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(
            (actor.as_str(), run.as_str(), source.as_str()),
            ("engine:fake", f.scope.run_id.as_str(), "tool")
        );
    }

    #[test]
    fn protected_and_busy_projects_are_refused_without_deletion() {
        let f = fixture();
        let own = f.store.project(&f.own_project).unwrap();
        let own_threads = f.store.agent_project_threads(&own.id).unwrap();
        assert!(matches!(
            remove(&f, &own, &own_threads, "/library"),
            Err(CoreError::Invalid(_))
        ));
        let library = project(&f.store, "/library", false);
        assert!(matches!(
            remove(&f, &library, &[], "/library"),
            Err(CoreError::Invalid(_))
        ));
        let scratch = project(&f.store, "/scratch", true);
        assert!(matches!(
            remove(&f, &scratch, &[], "/library"),
            Err(CoreError::Invalid(_))
        ));
        let target = project(&f.store, "/busy", false);
        f.store.trust_project(&target.id, "tester").unwrap();
        let target_thread = thread(&f.store, &target.id, None);
        let run = admit(&f.store, &target_thread).unwrap();
        let preview = f.store.agent_project_threads(&target.id).unwrap();
        assert!(matches!(
            remove(&f, &target, &preview, "/library"),
            Err(CoreError::ThreadBusy)
        ));
        assert!(f.store.project(&target.id).is_ok());
        assert!(f.store.thread(&target_thread).is_ok());
        f.store
            .finish_run(&run.id, RunState::Cancelled, None)
            .unwrap();
    }

    #[test]
    fn a_changed_preview_and_cross_project_descendant_leave_all_rows_intact() {
        let f = fixture();
        let target = project(&f.store, "/target", false);
        let parent = thread(&f.store, &target.id, None);
        let old_preview = f.store.agent_project_threads(&target.id).unwrap();
        let extra = thread(&f.store, &target.id, None);
        assert!(matches!(
            remove(&f, &target, &old_preview, "/library"),
            Err(CoreError::Invalid(_))
        ));
        let other = project(&f.store, "/other", false);
        let descendant = thread(&f.store, &other.id, Some(&parent));
        let preview = f.store.agent_project_threads(&target.id).unwrap();
        assert!(matches!(
            remove(&f, &target, &preview, "/library"),
            Err(CoreError::Invalid(_))
        ));
        for id in [parent, extra, descendant] {
            assert!(f.store.thread(&id).is_ok(), "{id}");
        }
        assert!(f.store.project(&target.id).is_ok());
        assert!(f.store.project(&other.id).is_ok());
    }

    #[test]
    fn successful_removal_is_audited_and_keeps_unrelated_projects() {
        let f = fixture();
        let target = project(&f.store, "/target", false);
        let one = thread(&f.store, &target.id, None);
        let two = thread(&f.store, &target.id, Some(&one));
        let other = project(&f.store, "/other", false);
        let other_thread = thread(&f.store, &other.id, None);
        let preview = f.store.agent_project_threads(&target.id).unwrap();
        assert_eq!(remove(&f, &target, &preview, "/library").unwrap(), preview);
        assert!(
            f.store
                .list_projects()
                .unwrap()
                .iter()
                .all(|p| p.id != target.id)
        );
        assert!(f.store.thread(&one).unwrap().project_removed);
        assert!(f.store.thread(&two).unwrap().project_removed);
        assert!(f.store.thread(&other_thread).is_ok());
        let (actor, run, detail): (String, String, String) = f.store.reader().query_row(
            "SELECT actor, run_id, detail FROM audit_events WHERE action = 'project.remove' AND target = '/target'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(actor, "engine:fake");
        assert_eq!(run, f.scope.run_id);
        let detail: serde_json::Value = serde_json::from_str(&detail).unwrap();
        assert_eq!(detail["files_removed"], false);
        assert_eq!(detail["thread_count"], 2);
    }

    #[test]
    fn audit_failure_rolls_back_and_stopped_caller_cannot_mutate() {
        let f = fixture();
        let target = project(&f.store, "/target", false);
        let child = thread(&f.store, &target.id, None);
        let preview = f.store.agent_project_threads(&target.id).unwrap();
        f.store.writer().execute_batch(
            "CREATE TRIGGER reject_agent_project_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'project.remove' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;",
        ).unwrap();
        assert!(remove(&f, &target, &preview, "/library").is_err());
        assert!(f.store.project(&target.id).is_ok() && f.store.thread(&child).is_ok());
        f.store.request_stop(&f.scope.run_id).unwrap();
        assert!(matches!(
            f.store
                .insert_agent_project("/late", "late", false, &f.scope),
            Err(CoreError::RunClosed)
        ));
        assert!(matches!(
            remove(&f, &target, &preview, "/library"),
            Err(CoreError::RunClosed)
        ));
    }

    #[test]
    fn plan_mode_refuses_agent_project_mutations_at_the_store_boundary() {
        let f = fixture();
        let target = project(&f.store, "/target", false);
        let mut plan = f.scope.clone();
        plan.plan = true;
        assert!(matches!(
            f.store.insert_agent_project("/new", "new", false, &plan),
            Err(CoreError::Invalid(_))
        ));
        assert!(matches!(
            f.store
                .remove_agent_project(&target.id, &target.path, &[], "/library", &plan),
            Err(CoreError::Invalid(_))
        ));
        assert!(f.store.project(&target.id).is_ok());
        assert!(
            !f.store
                .list_projects()
                .unwrap()
                .iter()
                .any(|p| p.path == "/new")
        );
    }

    #[test]
    fn admission_and_removal_serialize_without_deleting_an_active_run() {
        let f = fixture();
        let target = project(&f.store, "/target", false);
        f.store.trust_project(&target.id, "tester").unwrap();
        let target_thread = thread(&f.store, &target.id, None);
        let preview = f.store.agent_project_threads(&target.id).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let other_store = Arc::clone(&f.store);
        let other_barrier = Arc::clone(&barrier);
        let to_admit = target_thread.clone();
        let worker = std::thread::spawn(move || {
            other_barrier.wait();
            admit(&other_store, &to_admit)
        });
        barrier.wait();
        let removed = remove(&f, &target, &preview, "/library");
        let admitted = worker.join().unwrap();
        match (removed, admitted) {
            (Ok(_), Err(_)) => assert!(f.store.thread(&target_thread).unwrap().project_removed),
            (Err(CoreError::ThreadBusy), Ok(run)) => {
                assert!(f.store.thread(&target_thread).is_ok());
                f.store
                    .finish_run(&run.id, RunState::Cancelled, None)
                    .unwrap();
            }
            other => panic!("unexpected admission/removal result: {other:?}"),
        }
    }

    #[test]
    fn previews_are_sorted_bounded_and_missing_projects_are_refused() {
        let f = fixture();
        let target = project(&f.store, "/many", false);
        for _ in 0..MAX_PROJECT_THREADS {
            thread(&f.store, &target.id, None);
        }
        let ids = f.store.agent_project_threads(&target.id).unwrap();
        assert_eq!(ids.len(), MAX_PROJECT_THREADS);
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
        thread(&f.store, &target.id, None);
        assert!(matches!(
            f.store.agent_project_threads(&target.id),
            Err(CoreError::Invalid(_))
        ));
        assert!(matches!(
            f.store.agent_project_threads("missing"),
            Err(CoreError::NotFound(_))
        ));
    }
}
