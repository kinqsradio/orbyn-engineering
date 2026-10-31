//! Ordered, forward-only schema. Each entry applies once inside a transaction
//! and is recorded in `schema_migrations`. Published entries never change.

pub const MIGRATIONS: &[(i64, &str)] = &[
    (1, INITIAL),
    (2, THREAD_LIFECYCLE),
    (3, COMPOSER),
    (4, TIMELINE),
    (5, CHECKPOINTS),
    (6, PULL_REQUESTS),
    (7, MODELS_AND_QUESTIONS),
    (8, PULL_WATCHES),
    (9, IN_PLACE_PROJECTS),
    (10, PROJECT_PREFERENCES),
    (11, AUTOMATIONS),
    (12, MODEL_OPTIONS),
    (13, STOP_REQUESTS),
    (14, MESSAGE_SEARCH),
    (15, RUN_FILE_CHANGES),
];

// What a run changed, as bytes, for reading and restoring later whatever the folder
// holds by then. A state is `absent`, `stored`, or `unknown` when it was not captured.
const RUN_FILE_CHANGES: &str = r#"
CREATE TABLE run_file_changes (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    before_state TEXT NOT NULL,
    before_bytes BLOB,
    after_state TEXT NOT NULL,
    after_bytes BLOB,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (run_id, path)
) WITHOUT ROWID;
"#;

// Whole messages for search, since a message is split over many events. Written with
// each event; this fills it from the log for threads that already exist.
const MESSAGE_SEARCH: &str = r#"
CREATE TABLE thread_messages (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    ts TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (thread_id, message_id)
) WITHOUT ROWID;
CREATE INDEX thread_messages_by_time ON thread_messages(ts);

INSERT INTO thread_messages (thread_id, message_id, seq, role, ts, text)
SELECT body.thread_id, body.message_id, MIN(body.seq),
       COALESCE(head.role, 'assistant'), MIN(body.ts),
       group_concat(body.delta, '' ORDER BY body.seq)
FROM (
    SELECT thread_id, seq, ts,
           json_extract(event, '$.messageId') AS message_id,
           json_extract(event, '$.delta') AS delta
    FROM thread_events
    WHERE json_extract(event, '$.type') = 'TEXT_MESSAGE_CONTENT'
) AS body
LEFT JOIN (
    SELECT thread_id,
           json_extract(event, '$.messageId') AS message_id,
           MIN(json_extract(event, '$.role')) AS role
    FROM thread_events
    WHERE json_extract(event, '$.type') = 'TEXT_MESSAGE_START'
    GROUP BY thread_id, message_id
) AS head ON head.thread_id = body.thread_id AND head.message_id = body.message_id
WHERE body.message_id IS NOT NULL
GROUP BY body.thread_id, body.message_id;
"#;

const STOP_REQUESTS: &str = r#"
ALTER TABLE runs ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0;
"#;

const MODEL_OPTIONS: &str = r#"
ALTER TABLE threads ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
ALTER TABLE queued_messages ADD COLUMN model TEXT;
ALTER TABLE queued_messages ADD COLUMN effort TEXT;
ALTER TABLE queued_messages ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
"#;

const AUTOMATIONS: &str = r#"
CREATE TABLE scheduled_tasks (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    next_run_at INTEGER,
    token_sha256 TEXT,
    secret TEXT
);
CREATE INDEX scheduled_tasks_due ON scheduled_tasks(next_run_at);

CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
    delivery TEXT NOT NULL,
    dedupe_key TEXT,
    received_unix INTEGER NOT NULL
);
CREATE INDEX deliveries_by_task ON webhook_deliveries(task_id, received_unix);
"#;

const PROJECT_PREFERENCES: &str = r#"
CREATE TABLE project_preferences (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (project_id, key)
) WITHOUT ROWID;
"#;

// Until now every project was cloned or created by Orbyn, so all are managed.
const IN_PLACE_PROJECTS: &str = r#"
ALTER TABLE projects ADD COLUMN managed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN scratch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN scratch INTEGER NOT NULL DEFAULT 0;
UPDATE projects SET managed = 1;
"#;

const PULL_WATCHES: &str = r#"
CREATE TABLE pull_watches (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    snapshot TEXT,
    comment_wakes INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, number)
) WITHOUT ROWID;

CREATE TABLE pull_files_viewed (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY (project_id, number, path)
) WITHOUT ROWID;
"#;

const MODELS_AND_QUESTIONS: &str = r#"
ALTER TABLE threads ADD COLUMN effort TEXT;
ALTER TABLE threads ADD COLUMN goal TEXT;

CREATE TABLE question_requests (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    questions TEXT NOT NULL,
    state TEXT NOT NULL,
    answers TEXT,
    decided_by TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX questions_by_run ON question_requests(run_id, state);
CREATE INDEX questions_by_thread ON question_requests(thread_id, state);
"#;

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

const COMPOSER: &str = r#"
ALTER TABLE threads ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'supervised';
ALTER TABLE threads ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0;
CREATE TABLE queued_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    attachment_ids TEXT NOT NULL,
    held INTEGER NOT NULL DEFAULT 0,
    -- Sent next, ahead of the order, and not held by the stop it caused.
    urgent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX queued_by_thread ON queued_messages(thread_id, urgent);
CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX attachments_by_thread ON attachments(thread_id);
"#;

const TIMELINE: &str = r#"
CREATE TABLE thread_items (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    run_id TEXT,
    kind TEXT NOT NULL,
    raw TEXT NOT NULL,
    exit_code INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, item_id)
) WITHOUT ROWID;
ALTER TABLE threads ADD COLUMN usage TEXT;
"#;

const CHECKPOINTS: &str = r#"
CREATE TABLE checkpoints (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    start_sha TEXT NOT NULL,
    end_sha TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX checkpoints_by_thread ON checkpoints(thread_id, created_at);
-- Conversation carried into the next run when no engine session can continue it.
ALTER TABLE threads ADD COLUMN handoff TEXT;
"#;

const PULL_REQUESTS: &str = r#"
CREATE TABLE thread_pull_requests (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    head TEXT NOT NULL,
    base TEXT NOT NULL,
    author TEXT,
    PRIMARY KEY (thread_id, number)
);
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
