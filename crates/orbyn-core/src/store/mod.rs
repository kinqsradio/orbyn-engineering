//! Durable state. Every run, approval and event write is a transaction that
//! checks the current owner and state first; followers are woken only after
//! commit. Calls are short local SQLite operations and never span an await.

mod approvals;
mod catalog;
mod checkpoints;
mod hub;
mod migrations;
mod questions;
mod queue;
mod runs;
#[cfg(test)]
mod tests;
mod threads;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use orbyn_contracts::{
    AgUiEvent, AuditEvent, Project, Run, RunState, Thread, ThreadEvent, ThreadLifecycle, Worktree,
};
use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{CoreError, Result};
use crate::util::{new_id, now};

pub use approvals::{NewApproval, RememberRule};
pub use hub::EventHub;
pub use queue::{WatchRow, WatchUpdate};
pub use runs::{Admission, Recovery};
use threads::thread_family;
pub use threads::{LifecycleRules, TickReport, default_settings};

const ACTIVE_STATES: &str = "('admitted', 'starting', 'running', 'awaiting_approval')";

pub struct Store {
    write: Mutex<Connection>,
    read: Mutex<Connection>,
    epoch: String,
    hub: EventHub,
}

/// One audit row. Rows are only ever inserted.
#[derive(Clone, Debug)]
pub struct AuditRecord {
    pub actor: String,
    pub action: String,
    pub target: String,
    pub decision: Option<orbyn_contracts::PolicyEffect>,
    pub source: String,
    pub thread_id: Option<String>,
    pub run_id: Option<String>,
    pub detail: Value,
}

pub struct NewThread {
    pub project_id: String,
    pub title: String,
    pub engine: String,
    pub model: Option<String>,
    pub cwd: String,
    pub worktree: Option<Worktree>,
    pub skill_profile: Option<String>,
    pub parent_thread_id: Option<String>,
    pub relation: Option<String>,
    pub scratch: bool,
}

/// A folder to register.
pub struct NewProject<'a> {
    pub path: &'a str,
    pub name: &'a str,
    pub is_git: bool,
    pub managed: bool,
    pub scratch: bool,
}

impl Store {
    /// Opens the database and applies migrations. `epoch` identifies this
    /// process as the owner of the runs it admits.
    pub fn open(path: &Path, epoch: impl Into<String>) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut write = connect(path)?;
        refuse_newer(&write)?;
        write.pragma_update(None, "journal_mode", "WAL")?;
        write.pragma_update(None, "synchronous", "NORMAL")?;
        migrate(&mut write)?;
        let read = connect(path)?;
        Ok(Self {
            write: Mutex::new(write),
            read: Mutex::new(read),
            epoch: epoch.into(),
            hub: EventHub::default(),
        })
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    pub fn hub(&self) -> &EventHub {
        &self.hub
    }

    fn writer(&self) -> MutexGuard<'_, Connection> {
        self.write
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn reader(&self) -> MutexGuard<'_, Connection> {
        self.read
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Runs `work` in an immediate transaction, then wakes followers for any
    /// event it appended. A failed transaction wakes nobody.
    fn commit<T>(
        &self,
        work: impl FnOnce(&Transaction<'_>, &mut Appended) -> Result<T>,
    ) -> Result<T> {
        let mut conn = self.writer();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut appended = Appended::default();
        let value = work(&tx, &mut appended)?;
        tx.commit()?;
        drop(conn);
        for (thread_id, seq) in appended.0 {
            self.hub.committed(&thread_id, seq);
        }
        Ok(value)
    }

    /// Registers a folder, untrusted, or returns the row it already has.
    pub fn add_project(&self, new: NewProject<'_>) -> Result<Project> {
        self.commit(|tx, _| {
            let existing = tx
                .query_row(
                    "SELECT * FROM projects WHERE path = ?1",
                    [new.path],
                    project_row,
                )
                .optional()?;
            if let Some(project) = existing {
                return Ok(project);
            }
            let project = Project {
                id: new_id(),
                name: new.name.to_owned(),
                path: new.path.to_owned(),
                // Orbyn made a scratch folder itself, so there is nothing to vouch for.
                trusted: new.scratch,
                is_git: new.is_git,
                created_at: now(),
                managed: new.managed,
                scratch: new.scratch,
            };
            tx.execute(
                "INSERT INTO projects (id, name, path, trusted, is_git, created_at, managed,
                    scratch)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    project.id,
                    project.name,
                    project.path,
                    project.trusted,
                    project.is_git,
                    project.created_at,
                    project.managed,
                    project.scratch
                ],
            )?;
            Ok(project)
        })
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let conn = self.reader();
        let mut statement =
            conn.prepare("SELECT * FROM projects WHERE scratch = 0 ORDER BY created_at DESC")?;
        let rows = statement.query_map([], project_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn project(&self, id: &str) -> Result<Project> {
        self.reader()
            .query_row("SELECT * FROM projects WHERE id = ?1", [id], project_row)
            .optional()?
            .ok_or_else(|| CoreError::NotFound("project".into()))
    }

    /// Records the trust decision, audit first, in one transaction.
    pub fn trust_project(&self, id: &str, actor: &str) -> Result<Project> {
        self.commit(|tx, _| {
            let path: String = tx
                .query_row("SELECT path FROM projects WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .optional()?
                .ok_or_else(|| CoreError::NotFound("project".into()))?;
            insert_audit(
                tx,
                &AuditRecord {
                    actor: actor.to_owned(),
                    action: "project.trust".into(),
                    target: path,
                    decision: None,
                    source: "user".into(),
                    thread_id: None,
                    run_id: None,
                    detail: Value::Null,
                },
            )?;
            tx.execute("UPDATE projects SET trusted = 1 WHERE id = ?1", [id])?;
            Ok(tx.query_row("SELECT * FROM projects WHERE id = ?1", [id], project_row)?)
        })
    }

    pub fn delete_project(&self, id: &str) -> Result<()> {
        self.commit(|tx, _| {
            tx.execute("DELETE FROM projects WHERE id = ?1", [id])?;
            Ok(())
        })
    }

    /// Every thread of a project, archived ones included.
    pub fn list_all_threads(&self, project_id: &str) -> Result<Vec<Thread>> {
        let mut threads = self.list_threads(Some(project_id), false)?;
        threads.extend(self.list_threads(Some(project_id), true)?);
        Ok(threads)
    }

    pub fn create_thread(&self, new: NewThread) -> Result<Thread> {
        let id = new_id();
        let stamp = now();
        let worktree = new.worktree.as_ref();
        self.commit(|tx, _| {
            // New threads open at the top of the active list.
            tx.execute(
                "INSERT INTO threads (id, project_id, title, engine, model, cwd,
                    worktree_path, worktree_branch, worktree_base, skill_profile,
                    created_at, updated_at, position, parent_thread_id, relation, scratch)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11,
                    (SELECT COALESCE(MIN(position), 0) - 1 FROM threads), ?12, ?13, ?14)",
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
                    new.scratch,
                ],
            )?;
            Ok(())
        })?;
        self.thread(&id)
    }

    /// Points a thread with no runs at another folder. A scratch project nobody
    /// uses any more goes; its folder stays.
    pub fn move_thread(&self, id: &str, target: &Project) -> Result<Thread> {
        self.commit(|tx, _| {
            let runs: i64 = tx.query_row(
                "SELECT COUNT(*) FROM runs WHERE thread_id = ?1",
                [id],
                |row| row.get(0),
            )?;
            if runs > 0 {
                return Err(CoreError::Invalid(
                    "A thread can change project only before its first message.".into(),
                ));
            }
            let moved = tx.execute(
                "UPDATE threads SET project_id = ?2, cwd = ?3, scratch = ?4,
                    worktree_path = NULL, worktree_branch = NULL, worktree_base = NULL
                 WHERE id = ?1",
                params![id, target.id, target.path, target.scratch],
            )?;
            if moved == 0 {
                return Err(CoreError::NotFound("thread".into()));
            }
            prune_scratch(tx)
        })?;
        self.thread(id)
    }

    /// Makes a scratch folder an ordinary project for every thread in it.
    pub fn adopt_scratch(&self, project_id: &str, name: &str) -> Result<Project> {
        self.commit(|tx, _| {
            tx.execute(
                "UPDATE projects SET scratch = 0, name = ?2 WHERE id = ?1",
                params![project_id, name],
            )?;
            tx.execute(
                "UPDATE threads SET scratch = 0 WHERE project_id = ?1",
                [project_id],
            )?;
            Ok(())
        })?;
        self.project(project_id)
    }

    pub fn thread(&self, id: &str) -> Result<Thread> {
        let conn = self.reader();
        let thread = conn
            .query_row("SELECT * FROM threads WHERE id = ?1", [id], thread_row)
            .optional()?
            .ok_or_else(|| CoreError::NotFound("thread".into()))?;
        with_run_state(&conn, thread)
    }

    /// Live threads, or archived ones, pinned first and then by saved position.
    pub fn list_threads(&self, project_id: Option<&str>, archived: bool) -> Result<Vec<Thread>> {
        let conn = self.reader();
        let mut statement = conn.prepare(
            "SELECT * FROM threads
             WHERE (?1 IS NULL OR project_id = ?1) AND (archived_at IS NOT NULL) = ?2
             ORDER BY pinned_at IS NULL, position, created_at DESC",
        )?;
        let threads = statement
            .query_map(params![project_id, archived], thread_row)?
            .collect::<Result<Vec<_>, _>>()?;
        threads
            .into_iter()
            .map(|thread| with_run_state(&conn, thread))
            .collect()
    }

    /// Deletes a thread with its descendants and their logs. Refused while any
    /// of them has a run, because that owner still has effects in flight. Audit
    /// rows outlive the threads. Returns every deleted id.
    pub fn delete_thread(&self, id: &str, actor: &str) -> Result<Vec<String>> {
        let deleted = self.commit(|tx, _| {
            let family = thread_family(tx, id)?;
            for member in &family {
                let active: i64 = tx.query_row(
                    &format!(
                        "SELECT COUNT(*) FROM runs WHERE thread_id = ?1
                         AND state IN {ACTIVE_STATES}"
                    ),
                    [member],
                    |row| row.get(0),
                )?;
                if active > 0 {
                    return Err(CoreError::ThreadBusy);
                }
            }
            insert_audit(
                tx,
                &AuditRecord {
                    actor: actor.to_owned(),
                    action: "thread.delete".into(),
                    target: id.to_owned(),
                    decision: None,
                    source: "user".into(),
                    thread_id: Some(id.to_owned()),
                    run_id: None,
                    detail: serde_json::json!({ "family": family }),
                },
            )?;
            let deleted = tx.execute("DELETE FROM threads WHERE id = ?1", [id])?;
            if deleted == 0 {
                return Err(CoreError::NotFound("thread".into()));
            }
            prune_scratch(tx)?;
            Ok(family)
        })?;
        for member in &deleted {
            self.hub.remove(member);
        }
        Ok(deleted)
    }

    /// Events after `after` in `seq` order.
    pub fn events_after(
        &self,
        thread_id: &str,
        after: i64,
        limit: u32,
    ) -> Result<Vec<ThreadEvent>> {
        let conn = self.reader();
        let mut statement = conn.prepare_cached(
            "SELECT thread_id, seq, run_id, ts, event FROM thread_events
             WHERE thread_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
        )?;
        let rows = statement.query_map(params![thread_id, after, limit], event_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn latest_seq(&self, thread_id: &str) -> Result<i64> {
        Ok(self.reader().query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM thread_events WHERE thread_id = ?1",
            [thread_id],
            |row| row.get(0),
        )?)
    }

    pub fn append_audit(&self, record: &AuditRecord) -> Result<i64> {
        self.commit(|tx, _| insert_audit(tx, record))
    }

    pub fn list_audit(&self, thread_id: Option<&str>, limit: u32) -> Result<Vec<AuditEvent>> {
        let conn = self.reader();
        let mut statement = conn.prepare(
            "SELECT id, ts, actor, action, target, decision, source, thread_id, run_id, detail
             FROM audit_events WHERE (?1 IS NULL OR thread_id = ?1)
             ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![thread_id, limit.min(1000)], audit_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

/// Events appended in the current transaction, published after commit.
#[derive(Default)]
struct Appended(Vec<(String, i64)>);

fn connect(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

fn refuse_newer(conn: &Connection) -> Result<()> {
    let has_table: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations')",
        [],
        |row| row.get(0),
    )?;
    if !has_table {
        return Ok(());
    }
    let found: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    let supported = migrations::MIGRATIONS
        .last()
        .map_or(0, |(version, _)| *version);
    if found > supported {
        return Err(CoreError::DatabaseTooNew { found, supported });
    }
    Ok(())
}

/// Forgets scratch projects with no thread left. The folders stay on disk.
fn prune_scratch(tx: &Transaction<'_>) -> Result<()> {
    tx.execute(
        "DELETE FROM projects WHERE scratch = 1
         AND id NOT IN (SELECT project_id FROM threads)",
        [],
    )?;
    Ok(())
}

fn migrate(conn: &mut Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        )",
    )?;
    for (version, sql) in migrations::MIGRATIONS {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let applied: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = ?1)",
            [version],
            |row| row.get(0),
        )?;
        if !applied {
            tx.execute_batch(sql)?;
            tx.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                params![version, now()],
            )?;
        }
        tx.commit()?;
    }
    Ok(())
}

fn with_run_state(conn: &Connection, mut thread: Thread) -> Result<Thread> {
    let latest: Option<Run> = conn
        .query_row(
            "SELECT id, thread_id, state, error, started_at, ended_at FROM runs
             WHERE thread_id = ?1 ORDER BY started_at DESC, id DESC LIMIT 1",
            [&thread.id],
            run_row,
        )
        .optional()?;
    if let Some(run) = latest {
        thread.last_run_state = Some(run.state);
        if !run.state.is_terminal() {
            thread.active_run = Some(run);
        }
    }
    Ok(thread)
}

fn insert_event(
    tx: &Transaction<'_>,
    appended: &mut Appended,
    thread_id: &str,
    run_id: Option<&str>,
    event: &AgUiEvent,
) -> Result<ThreadEvent> {
    let seq: i64 = tx.query_row(
        "UPDATE threads SET next_seq = next_seq + 1, updated_at = ?2 WHERE id = ?1
         RETURNING next_seq - 1",
        params![thread_id, now()],
        |row| row.get(0),
    )?;
    let record = ThreadEvent {
        seq,
        thread_id: thread_id.to_owned(),
        run_id: run_id.map(str::to_owned),
        ts: now(),
        event: event.clone(),
    };
    tx.execute(
        "INSERT INTO thread_events (thread_id, seq, run_id, ts, event)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            record.thread_id,
            record.seq,
            record.run_id,
            record.ts,
            serde_json::to_string(event)?
        ],
    )?;
    appended.0.push((thread_id.to_owned(), seq));
    Ok(record)
}

fn insert_audit(tx: &Transaction<'_>, record: &AuditRecord) -> Result<i64> {
    tx.execute(
        "INSERT INTO audit_events
            (ts, actor, action, target, decision, source, thread_id, run_id, detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            now(),
            record.actor,
            record.action,
            record.target,
            record.decision.map(wire_name).transpose()?,
            record.source,
            record.thread_id,
            record.run_id,
            serde_json::to_string(&record.detail)?,
        ],
    )?;
    Ok(tx.last_insert_rowid())
}

/// The serde name of a unit enum, which is also its stored form.
fn wire_name<T: Serialize>(value: T) -> Result<String> {
    match serde_json::to_value(value)? {
        Value::String(name) => Ok(name),
        other => Err(CoreError::Internal(format!("not a unit enum: {other}"))),
    }
}

fn parse_wire<T: DeserializeOwned>(index: usize, text: String) -> rusqlite::Result<T> {
    serde_json::from_value(Value::String(text)).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn parse_json<T: DeserializeOwned>(index: usize, text: &str) -> rusqlite::Result<T> {
    serde_json::from_str(text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn project_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get("id")?,
        name: row.get("name")?,
        path: row.get("path")?,
        trusted: row.get("trusted")?,
        is_git: row.get("is_git")?,
        created_at: row.get("created_at")?,
        managed: row.get("managed")?,
        scratch: row.get("scratch")?,
    })
}

fn thread_row(row: &Row<'_>) -> rusqlite::Result<Thread> {
    let path: Option<String> = row.get("worktree_path")?;
    let branch: Option<String> = row.get("worktree_branch")?;
    let base: Option<String> = row.get("worktree_base")?;
    let worktree = match (path, branch, base) {
        (Some(path), Some(branch), Some(base)) => Some(Worktree { path, branch, base }),
        _ => None,
    };
    Ok(Thread {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        title: row.get("title")?,
        engine: row.get("engine")?,
        model: row.get("model")?,
        effort: row.get("effort")?,
        goal: row
            .get::<_, Option<String>>("goal")?
            .and_then(|text| serde_json::from_str(&text).ok()),
        scratch: row.get("scratch")?,
        cwd: row.get("cwd")?,
        worktree,
        skill_profile: row.get("skill_profile")?,
        active_run: None,
        last_run_state: None,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        lifecycle: Some(ThreadLifecycle {
            pinned_at: row.get("pinned_at")?,
            archived_at: row.get("archived_at")?,
            settled_at: row.get("settled_at")?,
            snoozed_until: row.get("snoozed_until")?,
            unread: row.get("unread")?,
            auto_settle: row.get("auto_settle")?,
            position: row.get("position")?,
            parent_thread_id: row.get("parent_thread_id")?,
            relation: row.get("relation")?,
            permission_mode: parse_wire(0, row.get("permission_mode")?)?,
            plan_mode: row.get("plan_mode")?,
        }),
    })
}

fn run_row(row: &Row<'_>) -> rusqlite::Result<Run> {
    let state: RunState = parse_wire(2, row.get("state")?)?;
    Ok(Run {
        id: row.get("id")?,
        thread_id: row.get("thread_id")?,
        state,
        error: row.get("error")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
    })
}

fn event_row(row: &Row<'_>) -> rusqlite::Result<ThreadEvent> {
    let text: String = row.get("event")?;
    Ok(ThreadEvent {
        seq: row.get("seq")?,
        thread_id: row.get("thread_id")?,
        run_id: row.get("run_id")?,
        ts: row.get("ts")?,
        event: parse_json(4, &text)?,
    })
}

fn audit_row(row: &Row<'_>) -> rusqlite::Result<AuditEvent> {
    let decision: Option<String> = row.get("decision")?;
    let detail: String = row.get("detail")?;
    Ok(AuditEvent {
        id: row.get("id")?,
        ts: row.get("ts")?,
        actor: row.get("actor")?,
        action: row.get("action")?,
        target: row.get("target")?,
        decision: decision.map(|text| parse_wire(5, text)).transpose()?,
        source: row.get("source")?,
        thread_id: row.get("thread_id")?,
        run_id: row.get("run_id")?,
        detail: parse_json(9, &detail)?,
    })
}
