//! Ordered, forward-only schema. Each entry applies once inside a transaction
//! and is recorded in `schema_migrations`. Published entries never change.

pub const MIGRATIONS: &[(i64, &str)] = &[(1, INITIAL), (2, THREAD_LIFECYCLE)];

const THREAD_LIFECYCLE: &str = r#"
ALTER TABLE threads ADD COLUMN parent_thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE;
ALTER TABLE threads ADD COLUMN relation TEXT;
ALTER TABLE threads ADD COLUMN pinned_at TEXT;
ALTER TABLE threads ADD COLUMN archived_at TEXT;
ALTER TABLE threads ADD COLUMN settled_at TEXT;
ALTER TABLE threads ADD COLUMN snoozed_until TEXT;
ALTER TABLE threads ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN auto_settle INTEGER;
-- Un-settling holds off automatic settling until new activity.
ALTER TABLE threads ADD COLUMN settle_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN position REAL NOT NULL DEFAULT 0;
CREATE INDEX threads_by_parent ON threads(parent_thread_id);
"#;

const INITIAL: &str = r#"
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    trusted INTEGER NOT NULL DEFAULT 0,
    is_git INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT,
    cwd TEXT NOT NULL,
    worktree_path TEXT,
    worktree_branch TEXT,
    worktree_base TEXT,
    skill_profile TEXT,
    engine_session TEXT,
    next_seq INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX threads_by_project ON threads(project_id, updated_at);

CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    engine TEXT NOT NULL,
    state TEXT NOT NULL,
    owner_epoch TEXT NOT NULL,
    error TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
);
-- One active run per thread, enforced by the database.
CREATE UNIQUE INDEX runs_one_active ON runs(thread_id)
    WHERE state IN ('admitted', 'starting', 'running', 'awaiting_approval');
CREATE INDEX runs_by_thread ON runs(thread_id, started_at);
-- Terminal states never change, whichever code path tries.
CREATE TRIGGER runs_terminal_is_final BEFORE UPDATE ON runs
    WHEN OLD.state IN ('completed', 'failed', 'cancelled', 'interrupted')
BEGIN
    SELECT RAISE(ABORT, 'terminal run is final');
END;

CREATE TABLE thread_events (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    run_id TEXT,
    ts TEXT NOT NULL,
    event TEXT NOT NULL,
    PRIMARY KEY (thread_id, seq)
) WITHOUT ROWID;

CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    engine TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail TEXT NOT NULL,
    state TEXT NOT NULL,
    decided_by TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL,
    event_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX approvals_by_state ON approvals(state, created_at);
CREATE INDEX approvals_by_run ON approvals(run_id, state);

CREATE TABLE policy_rules (
    id TEXT PRIMARY KEY,
    effect TEXT NOT NULL,
    kind TEXT NOT NULL,
    pattern TEXT NOT NULL,
    engine TEXT,
    note TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    decision TEXT,
    source TEXT NOT NULL,
    thread_id TEXT,
    run_id TEXT,
    detail TEXT NOT NULL
);
CREATE INDEX audit_by_thread ON audit_events(thread_id, id);
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'audit log is append-only');
END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TABLE skill_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    skills TEXT NOT NULL
);

CREATE TABLE custom_engines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tier TEXT NOT NULL,
    target TEXT NOT NULL,
    args TEXT NOT NULL
);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;
