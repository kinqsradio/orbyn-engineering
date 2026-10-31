use std::path::PathBuf;
use std::sync::Arc;

use orbyn_contracts::{
    ActionKind, AgUiEvent, ApprovalState, PolicyDecision, PolicyEffect, RunState,
};
use serde_json::json;

use super::*;
use crate::error::CoreError;
use crate::testing::TempDir;

struct Fixture {
    _dir: TempDir,
    path: PathBuf,
    store: Store,
    thread: String,
}

fn fixture() -> Fixture {
    let dir = TempDir::new();
    let path = dir.path().join("orbyn.sqlite3");
    let store = Store::open(&path, "epoch-a").unwrap();
    let project = store.add_project("/repo", "repo", true).unwrap();
    store.trust_project(&project.id, "tester").unwrap();
    let thread = thread_in(&store, &project.id);
    Fixture {
        _dir: dir,
        path,
        store,
        thread,
    }
}

fn thread_in(store: &Store, project: &str) -> String {
    store
        .create_thread(NewThread {
            project_id: project.to_owned(),
            title: "t".into(),
            engine: "fake".into(),
            model: None,
            cwd: "/repo".into(),
            worktree: None,
            skill_profile: None,
        })
        .unwrap()
        .id
}

fn admit(store: &Store, thread: &str) -> Result<orbyn_contracts::Run> {
    store.admit_run(Admission {
        thread_id: thread,
        prompt: "hi",
        actor: "tester",
    })
}

fn pending(store: &Store, run: &str) -> orbyn_contracts::Approval {
    store
        .create_approval(NewApproval {
            id: new_id(),
            run_id: run.to_owned(),
            engine: "fake".into(),
            kind: ActionKind::Command,
            target: "ls *".into(),
            summary: "ls".into(),
            detail: json!({}),
            decision: PolicyDecision {
                effect: PolicyEffect::Ask,
                rule_id: None,
                source: "default".into(),
                reason: "no rule".into(),
            },
        })
        .unwrap()
}

fn running(store: &Store, thread: &str) -> String {
    let run = admit(store, thread).unwrap();
    store.mark_starting(&run.id).unwrap();
    store.mark_running(&run.id).unwrap();
    run.id
}

fn delta() -> AgUiEvent {
    AgUiEvent::TextMessageContent {
        message_id: "m".into(),
        delta: "x".into(),
    }
}

#[test]
fn second_admission_loses_while_a_run_is_active() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    assert!(matches!(
        admit(&f.store, &f.thread),
        Err(CoreError::ThreadBusy)
    ));
    f.store.finish_run(&run, RunState::Completed, None).unwrap();
    assert!(admit(&f.store, &f.thread).is_ok());
}

#[test]
fn racing_admissions_produce_exactly_one_run() {
    let f = fixture();
    let store = Arc::new(f.store);
    let wins = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let store = store.clone();
                let thread = f.thread.clone();
                scope.spawn(move || admit(&store, &thread).is_ok())
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|won| *won)
            .count()
    });
    assert_eq!(wins, 1);
}

#[test]
fn untrusted_folder_is_refused_at_admission() {
    let f = fixture();
    let project = f.store.add_project("/other", "other", false).unwrap();
    let thread = thread_in(&f.store, &project.id);
    assert!(matches!(
        admit(&f.store, &thread),
        Err(CoreError::FolderUntrusted)
    ));
    assert_eq!(f.store.latest_seq(&thread).unwrap(), 0);
}

#[test]
fn late_event_after_terminal_state_is_rejected_and_not_logged() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    f.store.finish_run(&run, RunState::Completed, None).unwrap();
    let before = f.store.latest_seq(&f.thread).unwrap();
    assert!(matches!(
        f.store.append_run_event(&run, &delta()),
        Err(CoreError::RunClosed)
    ));
    assert_eq!(f.store.latest_seq(&f.thread).unwrap(), before);
    assert_eq!(f.store.run(&run).unwrap().state, RunState::Completed);
}

#[test]
fn terminal_state_never_changes_even_by_direct_sql() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    f.store
        .finish_run(&run, RunState::Failed, Some("no"))
        .unwrap();
    assert!(matches!(
        f.store.finish_run(&run, RunState::Completed, None),
        Err(CoreError::RunClosed)
    ));
    let result = f
        .store
        .writer()
        .execute("UPDATE runs SET state = 'running' WHERE id = ?1", [&run]);
    assert!(result.is_err());
}

#[test]
fn interrupted_is_reserved_for_recovery() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    assert!(matches!(
        f.store.finish_run(&run, RunState::Interrupted, None),
        Err(CoreError::InvalidTransition { .. })
    ));
}

#[test]
fn stale_owner_cannot_write_run_or_decide() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    let approval = pending(&f.store, &run);
    let stale = Store::open(&f.path, "epoch-b").unwrap();
    assert!(matches!(
        stale.append_run_event(&run, &delta()),
        Err(CoreError::StaleOwner)
    ));
    assert!(matches!(
        stale.finish_run(&run, RunState::Completed, None),
        Err(CoreError::StaleOwner)
    ));
    assert!(matches!(
        stale.decide_approval(&approval.id, true, false, "x"),
        Err(CoreError::StaleOwner)
    ));
    assert!(matches!(
        stale.set_engine_session(&run, "s"),
        Err(CoreError::StaleOwner)
    ));
}

#[test]
fn recovery_interrupts_dead_owners_runs_and_expires_their_approvals() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    let approval = pending(&f.store, &run);
    let successor = Store::open(&f.path, "epoch-b").unwrap();
    let recovery = successor.recover().unwrap();
    assert_eq!(
        recovery,
        Recovery {
            interrupted_runs: 1,
            expired_approvals: 1
        }
    );
    assert_eq!(successor.run(&run).unwrap().state, RunState::Interrupted);
    assert_eq!(
        successor.approval(&approval.id).unwrap().state,
        ApprovalState::Expired
    );
    // The dead owner, if it were somehow alive, is shut out too.
    assert!(matches!(
        f.store.append_run_event(&run, &delta()),
        Err(CoreError::RunClosed)
    ));
    // Recovery is idempotent and the thread is usable again.
    assert_eq!(successor.recover().unwrap(), Recovery::default());
    assert!(admit(&successor, &f.thread).is_ok());
}

#[test]
fn recovery_leaves_the_current_owners_runs_alone() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    assert_eq!(f.store.recover().unwrap(), Recovery::default());
    assert_eq!(f.store.run(&run).unwrap().state, RunState::Running);
}

#[test]
fn first_decision_wins_and_duplicate_reports_it() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    let approval = pending(&f.store, &run);
    assert_eq!(f.store.run(&run).unwrap().state, RunState::AwaitingApproval);
    let first = f
        .store
        .decide_approval(&approval.id, true, false, "a")
        .unwrap();
    assert_eq!(first.state, ApprovalState::Allowed);
    assert_eq!(f.store.run(&run).unwrap().state, RunState::Running);
    match f.store.decide_approval(&approval.id, false, false, "b") {
        Err(CoreError::AlreadyDecided(existing)) => {
            assert_eq!(existing.state, ApprovalState::Allowed);
            assert_eq!(existing.decided_by.as_deref(), Some("a"));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn racing_decisions_have_one_winner() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    let approval = pending(&f.store, &run);
    let store = Arc::new(f.store);
    let results: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let store = store.clone();
                let id = approval.id.clone();
                scope.spawn(move || store.decide_approval(&id, index % 2 == 0, false, "racer"))
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(CoreError::AlreadyDecided(_))))
            .count(),
        7
    );
}

#[test]
fn timeout_cannot_overturn_a_decision() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    let approval = pending(&f.store, &run);
    f.store
        .decide_approval(&approval.id, true, false, "a")
        .unwrap();
    let standing = f.store.expire_approval(&approval.id, "timeout").unwrap();
    assert_eq!(standing.state, ApprovalState::Allowed);
}

#[test]
fn finishing_expires_pending_approvals_and_blocks_new_ones() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    let approval = pending(&f.store, &run);
    let (_, expired) = f.store.finish_run(&run, RunState::Cancelled, None).unwrap();
    assert_eq!(expired.len(), 1);
    assert!(matches!(
        f.store.decide_approval(&approval.id, true, false, "late"),
        Err(CoreError::AlreadyDecided(_))
    ));
    let late = f.store.create_approval(NewApproval {
        id: new_id(),
        run_id: run.clone(),
        engine: "fake".into(),
        kind: ActionKind::Command,
        target: "x".into(),
        summary: "x".into(),
        detail: json!({}),
        decision: PolicyDecision {
            effect: PolicyEffect::Ask,
            rule_id: None,
            source: "default".into(),
            reason: String::new(),
        },
    });
    assert!(matches!(late, Err(CoreError::RunClosed)));
}

#[test]
fn remember_stores_an_exact_rule_never_a_wildcard() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    let approval = pending(&f.store, &run);
    f.store
        .decide_approval(&approval.id, true, true, "a")
        .unwrap();
    let rules = f.store.list_rules().unwrap();
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0].effect, PolicyEffect::Allow);
    assert_eq!(rules[0].pattern, "=ls *");
    assert_eq!(rules[0].engine.as_deref(), Some("fake"));
}

#[test]
fn denied_decision_does_not_remember() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    let approval = pending(&f.store, &run);
    f.store
        .decide_approval(&approval.id, false, true, "a")
        .unwrap();
    assert!(f.store.list_rules().unwrap().is_empty());
}

#[test]
fn audit_is_append_only_at_the_database() {
    let f = fixture();
    assert!(!f.store.list_audit(None, 10).unwrap().is_empty());
    let conn = f.store.writer();
    let update = conn.execute("UPDATE audit_events SET actor = 'x'", []);
    assert!(update.unwrap_err().to_string().contains("append-only"));
    let delete = conn.execute("DELETE FROM audit_events", []);
    assert!(delete.unwrap_err().to_string().contains("append-only"));
}

#[test]
fn newer_database_is_refused_unchanged() {
    let f = fixture();
    f.store
        .writer()
        .execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (9999, 'x')",
            [],
        )
        .unwrap();
    assert!(matches!(
        Store::open(&f.path, "epoch-b").err(),
        Some(CoreError::DatabaseTooNew { found: 9999, .. })
    ));
}

#[test]
fn migrations_apply_once() {
    let f = fixture();
    drop(Store::open(&f.path, "epoch-b").unwrap());
    let count: i64 = f
        .store
        .reader()
        .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, migrations::MIGRATIONS.len() as i64);
}

#[test]
fn events_are_gapless_per_thread_and_survive_reopen() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    f.store.append_run_event(&run, &delta()).unwrap();
    f.store.finish_run(&run, RunState::Completed, None).unwrap();
    let reopened = Store::open(&f.path, "epoch-b").unwrap();
    let events = reopened.events_after(&f.thread, 0, 100).unwrap();
    let seqs: Vec<i64> = events.iter().map(|event| event.seq).collect();
    assert_eq!(seqs, (1..=seqs.len() as i64).collect::<Vec<_>>());
    assert!(matches!(events[0].event, AgUiEvent::RunStarted { .. }));
    assert!(matches!(
        events.last().unwrap().event,
        AgUiEvent::RunFinished { .. }
    ));
}

#[test]
fn hub_wakes_only_after_commit() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    let receiver = f.store.hub().subscribe(&f.thread);
    assert!(!receiver.has_changed().unwrap());
    // A rejected write commits nothing, so nothing wakes.
    let _ = f.store.append_run_event("missing", &delta());
    assert!(!receiver.has_changed().unwrap());
    let event = f.store.append_run_event(&run, &delta()).unwrap();
    assert!(receiver.has_changed().unwrap());
    assert_eq!(*receiver.borrow(), event.seq);
}

#[test]
fn deleting_an_active_thread_is_refused_and_audit_survives_deletion() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    assert!(matches!(
        f.store.delete_thread(&f.thread, "a"),
        Err(CoreError::ThreadBusy)
    ));
    f.store.finish_run(&run, RunState::Completed, None).unwrap();
    f.store.delete_thread(&f.thread, "a").unwrap();
    assert!(!f.store.list_audit(Some(&f.thread), 50).unwrap().is_empty());
}
