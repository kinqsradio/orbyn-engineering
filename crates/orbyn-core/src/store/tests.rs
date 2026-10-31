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
    let project = store
        .add_project(crate::store::NewProject {
            path: "/repo",
            name: "repo",
            is_git: true,
            managed: false,
            scratch: false,
        })
        .unwrap();
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
            parent_thread_id: None,
            relation: None,
            scratch: false,
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
    let project = f
        .store
        .add_project(crate::store::NewProject {
            path: "/other",
            name: "other",
            is_git: false,
            managed: false,
            scratch: false,
        })
        .unwrap();
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
            expired_approvals: 1,
            ..Recovery::default()
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
fn a_stop_saved_before_a_crash_ends_cancelled_rather_than_interrupted() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    f.store.request_stop(&run).unwrap();
    let successor = Store::open(&f.path, "epoch-b").unwrap();
    let recovery = successor.recover().unwrap();
    assert_eq!(recovery.stopped_runs, 1);
    assert_eq!(recovery.interrupted_runs, 0);
    assert_eq!(successor.run(&run).unwrap().state, RunState::Cancelled);
}

#[test]
fn a_tool_left_open_by_a_crash_is_closed_with_a_note() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    for (id, close) in [("open", false), ("done", true)] {
        let start = AgUiEvent::ToolCallStart {
            tool_call_id: id.into(),
            tool_call_name: "x".into(),
        };
        f.store.append_run_event(&run, &start).unwrap();
        if close {
            let end = AgUiEvent::ToolCallEnd {
                tool_call_id: id.into(),
            };
            f.store.append_run_event(&run, &end).unwrap();
        }
    }
    let successor = Store::open(&f.path, "epoch-b").unwrap();
    successor.recover().unwrap();
    let notes: Vec<String> = successor
        .events_after(&f.thread, 0, 1000)
        .unwrap()
        .into_iter()
        .filter_map(|event| match event.event {
            AgUiEvent::ToolCallResult {
                tool_call_id,
                content,
                ..
            } => Some(format!("{tool_call_id}: {content}")),
            _ => None,
        })
        .collect();
    assert_eq!(notes, ["open: Interrupted before a result."]);
}

#[test]
fn a_message_that_never_reached_an_engine_returns_held_to_the_queue() {
    let f = fixture();
    let run = f
        .store
        .admit_run(Admission {
            thread_id: &f.thread,
            prompt: "typed by hand",
            actor: "t",
        })
        .unwrap();
    let successor = Store::open(&f.path, "epoch-b").unwrap();
    let recovery = successor.recover().unwrap();
    assert_eq!(recovery.returned_messages, 1);
    assert_eq!(successor.run(&run.id).unwrap().state, RunState::Interrupted);
    let queue = successor.list_queue(&f.thread).unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].prompt, "typed by hand");
    assert!(queue[0].held, "nothing is sent again without a person");
    assert_eq!(successor.recover().unwrap(), Recovery::default());
}

#[test]
fn a_running_message_is_not_sent_twice() {
    let f = fixture();
    running(&f.store, &f.thread);
    let successor = Store::open(&f.path, "epoch-b").unwrap();
    assert_eq!(successor.recover().unwrap().returned_messages, 0);
    assert!(successor.list_queue(&f.thread).unwrap().is_empty());
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

fn rules(now: i64, days: Option<i64>) -> LifecycleRules {
    LifecycleRules {
        now,
        idle_seconds: days.map(|days| days * 86_400),
        keep_pull_requests: false,
    }
}

const DAY: i64 = 86_400;

fn patch() -> orbyn_contracts::UpdateThread {
    orbyn_contracts::UpdateThread::default()
}

#[test]
fn idle_threads_settle_but_recent_or_opted_out_ones_stay() {
    let f = fixture();
    let now = crate::util::unix_now();
    assert!(
        f.store
            .lifecycle_tick(rules(now, Some(3)))
            .unwrap()
            .settled
            .is_empty()
    );
    let later = now + 4 * DAY;
    assert!(
        f.store
            .lifecycle_tick(rules(later, None))
            .unwrap()
            .settled
            .is_empty()
    );

    let mut disabled = patch();
    disabled.auto_settle = Some(orbyn_contracts::AutoSettleChoice::Disabled);
    f.store.update_thread(&f.thread, &disabled, "t").unwrap();
    assert!(
        f.store
            .lifecycle_tick(rules(later, Some(3)))
            .unwrap()
            .settled
            .is_empty()
    );

    let mut enabled = patch();
    enabled.auto_settle = Some(orbyn_contracts::AutoSettleChoice::Enabled);
    f.store.update_thread(&f.thread, &enabled, "t").unwrap();
    let report = f.store.lifecycle_tick(rules(later, None)).unwrap();
    assert_eq!(report.settled, std::slice::from_ref(&f.thread));
}

#[test]
fn a_running_thread_or_child_never_auto_settles() {
    let f = fixture();
    let later = crate::util::unix_now() + 10 * DAY;
    let project = f.store.thread(&f.thread).unwrap().project_id;
    let child = f
        .store
        .create_thread(NewThread {
            project_id: project,
            title: "child".into(),
            engine: "fake".into(),
            model: None,
            cwd: "/repo".into(),
            worktree: None,
            skill_profile: None,
            parent_thread_id: Some(f.thread.clone()),
            relation: Some("subagent".into()),
            scratch: false,
        })
        .unwrap();
    let run = running(&f.store, &child.id);
    let report = f.store.lifecycle_tick(rules(later, Some(3))).unwrap();
    assert!(report.settled.is_empty(), "{report:?}");
    assert!(matches!(
        f.store.delete_thread(&f.thread, "t"),
        Err(CoreError::ThreadBusy)
    ));
    f.store.finish_run(&run, RunState::Completed, None).unwrap();
    assert_eq!(f.store.delete_thread(&f.thread, "t").unwrap().len(), 2);
    assert!(f.store.thread(&child.id).is_err());
}

#[test]
fn unsettle_holds_off_auto_settle_until_new_activity() {
    let f = fixture();
    let later = crate::util::unix_now() + 10 * DAY;
    let mut settle = patch();
    settle.settled = Some(true);
    f.store.update_thread(&f.thread, &settle, "t").unwrap();
    let mut unsettle = patch();
    unsettle.settled = Some(false);
    f.store.update_thread(&f.thread, &unsettle, "t").unwrap();
    assert!(
        f.store
            .lifecycle_tick(rules(later, Some(3)))
            .unwrap()
            .settled
            .is_empty()
    );
    let run = running(&f.store, &f.thread);
    f.store.finish_run(&run, RunState::Completed, None).unwrap();
    let report = f.store.lifecycle_tick(rules(later, Some(3))).unwrap();
    assert_eq!(report.settled, std::slice::from_ref(&f.thread));
}

#[test]
fn due_snooze_wakes_unread_and_early_one_stays() {
    let f = fixture();
    let now = crate::util::unix_now();
    let mut snooze = patch();
    snooze.snoozed_until = Some("2999-01-01T00:00:00Z".into());
    f.store.update_thread(&f.thread, &snooze, "t").unwrap();
    assert!(
        f.store
            .lifecycle_tick(rules(now, None))
            .unwrap()
            .woken
            .is_empty()
    );
    let end = crate::util::parse_time("2999-01-01T00:00:01Z").unwrap();
    let report = f.store.lifecycle_tick(rules(end, None)).unwrap();
    assert_eq!(report.woken, std::slice::from_ref(&f.thread));
    let thread = f.store.thread(&f.thread).unwrap();
    let lifecycle = thread.lifecycle.unwrap();
    assert!(lifecycle.snoozed_until.is_none());
    assert!(lifecycle.unread);
}

#[test]
fn snoozed_threads_do_not_auto_settle_and_lifecycle_changes_reach_followers() {
    let f = fixture();
    let receiver = f.store.hub().subscribe(&f.thread);
    let mut snooze = patch();
    snooze.snoozed_until = Some("2999-01-01T00:00:00Z".into());
    f.store.update_thread(&f.thread, &snooze, "t").unwrap();
    assert!(receiver.has_changed().unwrap());
    let later = crate::util::unix_now() + 10 * DAY;
    assert!(
        f.store
            .lifecycle_tick(rules(later, Some(3)))
            .unwrap()
            .settled
            .is_empty()
    );
}

#[test]
fn old_rows_gain_lifecycle_defaults() {
    let f = fixture();
    let lifecycle = f.store.thread(&f.thread).unwrap().lifecycle.unwrap();
    assert!(!lifecycle.unread);
    assert!(lifecycle.parent_thread_id.is_none());
}

fn say(store: &Store, run: &str, id: &str, role: &str, parts: &[&str]) {
    let start = AgUiEvent::TextMessageStart {
        message_id: id.into(),
        role: role.into(),
    };
    store.append_run_event(run, &start).unwrap();
    for part in parts {
        let content = AgUiEvent::TextMessageContent {
            message_id: id.into(),
            delta: (*part).into(),
        };
        store.append_run_event(run, &content).unwrap();
    }
}

#[test]
fn every_word_must_be_in_one_message_even_across_events() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    say(&f.store, &run, "a", "user", &["fix the lo", "gin page"]);
    say(&f.store, &run, "b", "assistant", &["the login"]);
    say(&f.store, &run, "c", "assistant", &["page only"]);
    let scope = crate::search::SearchScope::default();
    let found = f.store.search_messages("PAGE login", &scope).unwrap();
    assert_eq!(found.hits.len(), 1, "{found:?}");
    assert_eq!(found.hits[0].message_id, "a");
    assert_eq!(found.hits[0].role, "user");
    assert_eq!(found.hits[0].snippet, "fix the login page");
    assert!(found.hits[0].seq > 0);
}

#[test]
fn an_id_reused_on_a_later_turn_is_a_second_message() {
    let f = fixture();
    let first = running(&f.store, &f.thread);
    say(&f.store, &first, "msg", "assistant", &["alpha words"]);
    f.store
        .finish_run(&first, RunState::Completed, None)
        .unwrap();
    let second = running(&f.store, &f.thread);
    say(&f.store, &second, "msg", "assistant", &["bravo words"]);
    let scope = crate::search::SearchScope::default();
    assert_eq!(
        f.store.search_messages("words", &scope).unwrap().hits.len(),
        2
    );
    assert!(
        f.store
            .search_messages("alpha bravo", &scope)
            .unwrap()
            .hits
            .is_empty()
    );
}

#[test]
fn search_folds_any_script_and_short_queries_read_nothing() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    say(&f.store, &run, "a", "assistant", &["ÉCOLE 登录页面 ok"]);
    let scope = crate::search::SearchScope::default();
    let search = |query: &str| f.store.search_messages(query, &scope).unwrap();
    assert_eq!(search("école").hits.len(), 1, "non-ASCII case folds");
    assert_eq!(
        search("登录").hits.len(),
        1,
        "two CJK characters are enough"
    );
    let lone = search("登");
    assert!(lone.too_short && lone.hits.is_empty());
    assert!(search("ok").too_short);
    assert!(search("   ").too_short);
    assert_eq!(
        search("登录 ok").hits.len(),
        1,
        "a short word must still match"
    );
    assert!(search("登录 no").hits.is_empty());
    assert!(
        search("100%").hits.is_empty(),
        "a percent is not a wildcard"
    );
    assert!(search("o_k").hits.is_empty(), "nor is an underscore");
}

#[test]
fn old_logs_fill_the_search_table_with_the_migration() {
    let f = fixture();
    let run = running(&f.store, &f.thread);
    say(&f.store, &run, "a", "user", &["part one ", "part two"]);
    say(&f.store, &run, "b", "assistant", &["other"]);
    let conn = rusqlite::Connection::open(&f.path).unwrap();
    conn.execute_batch("DROP TABLE thread_messages").unwrap();
    let (_, migration) = super::migrations::MIGRATIONS
        .iter()
        .find(|(version, _)| *version == 14)
        .unwrap();
    conn.execute_batch(migration).unwrap();
    let scope = crate::search::SearchScope::default();
    let found = f.store.search_messages("one two", &scope).unwrap();
    assert_eq!(found.hits.len(), 1);
    assert_eq!(found.hits[0].role, "user");
    assert_eq!(found.hits[0].snippet, "part one part two");
}

#[test]
fn a_limit_stop_schedules_only_what_was_asked_and_settling_clears_it() {
    let f = fixture();
    let later = "2999-01-01T00:00:00Z";
    let stop = |resume, snooze, resets_at: Option<&str>| LimitStop {
        message: "Out of usage".into(),
        resets_at: resets_at.map(str::to_owned),
        resume,
        snooze,
    };
    let lifecycle = |store: &Store| store.thread(&f.thread).unwrap().lifecycle.unwrap();
    f.store
        .stop_on_limit(&f.thread, &stop(false, true, None))
        .unwrap();
    let saved = lifecycle(&f.store);
    assert_eq!(saved.limit.as_ref().unwrap().message, "Out of usage");
    assert_eq!(saved.limit.unwrap().resume_at, None);
    assert_eq!(
        saved.snoozed_until, None,
        "no reset, nothing to snooze until"
    );

    f.store
        .stop_on_limit(&f.thread, &stop(true, true, Some(later)))
        .unwrap();
    let saved = lifecycle(&f.store);
    assert_eq!(saved.limit.unwrap().resume_at.as_deref(), Some(later));
    assert_eq!(saved.snoozed_until.as_deref(), Some(later));
    let now = crate::util::unix_now();
    assert!(f.store.due_resumes(now).unwrap().is_empty());
    let end = crate::util::parse_time(later).unwrap();
    assert_eq!(
        f.store.due_resumes(end).unwrap(),
        std::slice::from_ref(&f.thread)
    );

    let mut settle = patch();
    settle.settled = Some(true);
    f.store.update_thread(&f.thread, &settle, "t").unwrap();
    assert!(lifecycle(&f.store).limit.is_none());
    assert!(f.store.due_resumes(end).unwrap().is_empty());
}

#[test]
fn only_an_early_end_to_a_snooze_leaves_a_note() {
    let f = fixture();
    let woke = |store: &Store| store.thread(&f.thread).unwrap().lifecycle.unwrap().woke_at;
    let mut snooze = patch();
    snooze.snoozed_until = Some("2999-01-01T00:00:00Z".into());
    f.store.update_thread(&f.thread, &snooze, "t").unwrap();
    let mut wake = patch();
    wake.wake = Some(true);
    f.store.update_thread(&f.thread, &wake, "t").unwrap();
    assert!(
        woke(&f.store).is_none(),
        "waking it yourself is no surprise"
    );

    let run = running(&f.store, &f.thread);
    f.store.update_thread(&f.thread, &snooze, "t").unwrap();
    f.store.finish_run(&run, RunState::Failed, None).unwrap();
    assert!(woke(&f.store).is_some());

    let mut dismiss = patch();
    dismiss.dismiss_woke = Some(true);
    f.store.update_thread(&f.thread, &dismiss, "t").unwrap();
    assert!(woke(&f.store).is_none());
}
