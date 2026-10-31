//! Checkpoints, diffs and moving a thread back, through the real service.

mod support;

use serde_json::{Value, json};
use support::{Options, Service, TempDir, run_git, setup, text_of};

fn options(dir: &TempDir, launches: bool) -> Options {
    let mut env = vec![(
        "ORBYN_FAKE_CHECKOUT".to_owned(),
        dir.path()
            .join("library/repo/project")
            .to_string_lossy()
            .into_owned(),
    )];
    if launches {
        env.push((
            "ORBYN_FAKE_LAUNCH_FILE".to_owned(),
            dir.path().join("launches").to_string_lossy().into_owned(),
        ));
    }
    Options {
        env,
        ..Options::default()
    }
}

async fn run(service: &Service, thread: &str, prompt: &str) -> String {
    let id = service.admit(thread, prompt).await;
    assert_eq!(service.finished(thread).await, "completed");
    id
}

/// A project with one commit, so HEAD exists.
fn seed(dir: &TempDir) {
    let checkout = dir.path().join("library/repo/project");
    run_git(&checkout, &["config", "user.email", "t@example.com"]);
    run_git(&checkout, &["config", "user.name", "T"]);
    // Bytes are compared below; Git on Windows may convert line endings by default.
    run_git(&checkout, &["config", "core.autocrlf", "false"]);
    std::fs::write(checkout.join("base.txt"), "base\n").unwrap();
    run_git(&checkout, &["add", "."]);
    run_git(&checkout, &["commit", "-q", "-m", "first"]);
}

fn paths(diff: &Value) -> Vec<String> {
    diff.as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn turn_end_checkpoints_stay_in_hidden_refs_and_diffs_separate_turns() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, options(&dir, false), "codex").await;
    seed(&dir);
    let checkout = dir.path().join("library/repo/project");
    let first = run(&service, &thread, "[write:one.txt]").await;
    let second = run(&service, &thread, "[write:two.txt]").await;

    let checkpoints = service
        .json(&format!("/api/threads/{thread}/checkpoints"))
        .await;
    assert_eq!(checkpoints.as_array().unwrap().len(), 2);
    assert!(checkpoints[0]["end"].is_string());

    let turn = |run: &str| format!("/api/threads/{thread}/diff?scope=turn&run={run}");
    assert_eq!(paths(&service.json(&turn(&first)).await), ["one.txt"]);
    assert_eq!(paths(&service.json(&turn(&second)).await), ["two.txt"]);
    let whole = service
        .json(&format!("/api/threads/{thread}/diff?scope=thread"))
        .await;
    assert_eq!(paths(&whole), ["one.txt", "two.txt"]);

    // No checkpoint touched the real index, branch or log.
    let status = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&checkout)
        .output()
        .unwrap();
    let status = String::from_utf8(status.stdout).unwrap();
    assert!(status.contains("?? one.txt"), "{status}");
    let commits = service
        .json(&format!("/api/threads/{thread}/commits"))
        .await;
    assert_eq!(commits.as_array().unwrap().len(), 1);
    assert_eq!(commits[0]["subject"], "first");
    let single = service
        .json(&format!(
            "/api/threads/{thread}/diff?scope=commit&sha={}",
            commits[0]["sha"].as_str().unwrap()
        ))
        .await;
    assert_eq!(
        paths(&single),
        ["base.txt"],
        "a root commit diffs against nothing"
    );
}

#[tokio::test]
async fn branch_comparison_covers_everything_since_the_base() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, options(&dir, false), "codex").await;
    seed(&dir);
    let checkout = dir.path().join("library/repo/project");
    run_git(&checkout, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(checkout.join("committed.txt"), "x").unwrap();
    run_git(&checkout, &["add", "."]);
    run_git(&checkout, &["commit", "-q", "-m", "work"]);
    std::fs::write(checkout.join("untracked.txt"), "y").unwrap();
    let diff = service
        .json(&format!(
            "/api/threads/{thread}/diff?scope=branch&base=main"
        ))
        .await;
    assert_eq!(paths(&diff), ["committed.txt", "untracked.txt"]);
    let bad = service
        .get(&format!(
            "/api/threads/{thread}/diff?scope=branch&base=--output=/tmp/x"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);
}

#[tokio::test]
async fn restore_returns_files_keeps_ignored_ones_and_can_be_undone() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, options(&dir, false), "codex").await;
    seed(&dir);
    let checkout = dir.path().join("library/repo/project");
    std::fs::write(checkout.join(".gitignore"), "cache/\n").unwrap();
    std::fs::create_dir_all(checkout.join("cache")).unwrap();
    std::fs::write(checkout.join("cache/data"), "keep").unwrap();
    std::fs::write(checkout.join("base.txt"), "edited before the run\n").unwrap();
    let id = run(&service, &thread, "[write:one.txt]").await;
    std::fs::write(checkout.join("base.txt"), "later edit\n").unwrap();
    std::fs::write(checkout.join("later.txt"), "later").unwrap();

    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/restore"),
            json!({ "run_id": id, "point": "start" }),
        )
        .await;
    assert_eq!(code, 204, "{body}");
    assert!(!checkout.join("one.txt").exists());
    assert!(!checkout.join("later.txt").exists());
    assert_eq!(
        std::fs::read_to_string(checkout.join("base.txt")).unwrap(),
        "edited before the run\n"
    );
    assert_eq!(
        std::fs::read_to_string(checkout.join("cache/data")).unwrap(),
        "keep"
    );

    let audit = service.audit(&thread).await;
    let row = audit
        .iter()
        .find(|row| row["action"] == "workspace.restore")
        .unwrap();
    let safety = row["detail"]["safety"].as_str().unwrap();
    let kept = std::process::Command::new("git")
        .args(["show", &format!("{safety}:later.txt")])
        .current_dir(&checkout)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8(kept.stdout).unwrap(), "later");
}

#[tokio::test]
async fn restored_bytes_match_the_checkpoint_whatever_git_would_convert() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, options(&dir, false), "codex").await;
    seed(&dir);
    let checkout = dir.path().join("library/repo/project");
    run_git(&checkout, &["config", "core.autocrlf", "true"]);
    std::fs::write(checkout.join(".gitattributes"), "*.crlf text eol=crlf\n").unwrap();
    let kept: [(&str, &[u8]); 4] = [
        ("base.txt", b"line ending\n"),
        ("windows.txt", b"carriage\r\nreturn\r\n"),
        ("mixed.txt", b"one\r\ntwo\n"),
        ("attr.crlf", b"forced\n"),
    ];
    for (name, bytes) in kept {
        std::fs::write(checkout.join(name), bytes).unwrap();
    }
    let id = run(&service, &thread, "[write:one.txt]").await;
    for (name, _) in kept {
        std::fs::write(checkout.join(name), "changed later\n").unwrap();
    }

    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/restore"),
            json!({ "run_id": id, "point": "start" }),
        )
        .await;
    assert_eq!(code, 204, "{body}");
    for (name, bytes) in kept {
        assert_eq!(std::fs::read(checkout.join(name)).unwrap(), bytes, "{name}");
    }
}

#[tokio::test]
async fn restore_refuses_a_shared_folder_and_a_busy_thread() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, options(&dir, false), "codex").await;
    seed(&dir);
    let id = run(&service, &thread, "[write:one.txt]").await;
    let project = service.json(&format!("/api/threads/{thread}")).await["project_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let neighbor = service.thread(&project, "codex").await;
    let path = format!("/api/threads/{thread}/restore");
    let body = json!({ "run_id": id, "point": "start" });
    let (code, refused) = service.send(&path, body.clone()).await;
    assert_eq!(code, 409);
    assert_eq!(refused["code"], "shared_directory");
    assert!(dir.path().join("library/repo/project/one.txt").exists());

    service.patch(&neighbor, json!({ "archived": true })).await;
    let hanging = service.admit(&thread, "[hang]").await;
    let (code, refused) = service.send(&path, body.clone()).await;
    assert_eq!(code, 409);
    assert_eq!(refused["code"], "thread_busy");
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    service
        .send(&format!("/api/runs/{hanging}/cancel"), json!({}))
        .await;
    service.finished(&thread).await;
    assert_eq!(service.send(&path, body).await.0, 204);
}

#[tokio::test]
async fn rewind_drops_the_session_and_hands_the_earlier_conversation_on_once() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, options(&dir, true), "codex").await;
    seed(&dir);
    run(&service, &thread, "remember the first thing").await;
    let second = run(&service, &thread, "[write:one.txt] second thing").await;
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/rewind"),
            json!({ "run_id": second, "restore_files": true }),
        )
        .await;
    assert_eq!(code, 204, "{body}");
    assert!(!dir.path().join("library/repo/project/one.txt").exists());

    run(&service, &thread, "third thing").await;
    run(&service, &thread, "fourth thing").await;
    let log = std::fs::read_to_string(dir.path().join("launches")).unwrap();
    let starts: Vec<&str> = log
        .lines()
        .filter(|l| l.contains(r#""mode":"codex-turn""#))
        .collect();
    let third = starts[2];
    assert!(third.contains("remember the first thing"), "{third}");
    assert!(!third.contains("second thing"), "{third}");
    assert!(!starts[3].contains("remember the first thing"), "used once");
    let threads: Vec<&str> = log
        .lines()
        .filter(|l| l.contains(r#""mode":"codex-thread""#))
        .collect();
    assert!(threads[2].contains("\\\"cwd\\\""));
    assert!(
        !threads[2].contains("threadId"),
        "a rewind starts a new session: {}",
        threads[2]
    );
    let events = service.all_events(&thread).await;
    assert!(!events.is_empty());
}

#[tokio::test]
async fn a_runs_changes_are_what_its_engine_reported_and_stay_with_that_thread() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, options(&dir, true), "codex").await;
    seed(&dir);
    let wrote = run(&service, &thread, "[write:one.txt] write it").await;
    let quiet = run(&service, &thread, "say hello").await;
    // Another thread's file in the same checkout is not this run's change.
    std::fs::write(dir.path().join("library/repo/project/other.txt"), "x").unwrap();
    let changes = service
        .json(&format!("/api/threads/{thread}/runs/{wrote}/changes"))
        .await;
    assert_eq!(changes["paths"].as_array().unwrap().len(), 1, "{changes}");
    assert!(changes["paths"][0].as_str().unwrap().ends_with("one.txt"));
    let none = service
        .json(&format!("/api/threads/{thread}/runs/{quiet}/changes"))
        .await;
    assert_eq!(none["paths"], json!([]));

    let project = service.json("/api/projects").await[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let other = service.thread(&project, "codex").await;
    let response = service
        .get(&format!("/api/threads/{other}/runs/{wrote}/changes"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 404);
}

#[tokio::test]
async fn a_handoff_survives_a_failed_run_and_goes_only_with_a_finished_one() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, options(&dir, true), "codex").await;
    seed(&dir);
    run(&service, &thread, "remember the first thing").await;
    let second = run(&service, &thread, "second thing").await;
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/rewind"),
            json!({ "run_id": second, "restore_files": false }),
        )
        .await;
    assert_eq!(code, 204, "{body}");
    // A bare command has no way to carry the earlier conversation.
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "/compact" }),
        )
        .await;
    assert_eq!(code, 422, "{body}");
    assert_eq!(body["code"], "unsupported");

    service.admit(&thread, "[fail] third").await;
    assert_eq!(service.finished(&thread).await, "failed");
    service.admit(&thread, "fourth").await;
    assert_eq!(service.finished(&thread).await, "completed");
    service.admit(&thread, "fifth").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let log = std::fs::read_to_string(dir.path().join("launches")).unwrap();
    let starts: Vec<&str> = log
        .lines()
        .filter(|l| l.contains(r#""mode":"codex-turn""#))
        .collect();
    let at = |prompt: &str| starts.iter().find(|turn| turn.contains(prompt)).unwrap();
    assert!(at("third").contains("remember the first thing"));
    assert!(at("fourth").contains("remember the first thing"), "kept");
    assert!(!at("fifth").contains("remember the first thing"), "cleared");
}

#[tokio::test]
async fn a_side_chat_stays_apart_until_brought_back_into_the_next_run() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, options(&dir, true), "codex").await;
    seed(&dir);
    run(&service, &thread, "the main work").await;
    let (code, side) = service
        .send(
            &format!("/api/threads/{thread}/fork"),
            json!({ "side": true }),
        )
        .await;
    assert_eq!(code, 201, "{side}");
    assert_eq!(side["lifecycle"]["relation"], "side");
    assert_eq!(
        side["cwd"],
        service.json(&format!("/api/threads/{thread}")).await["cwd"]
    );
    let side = side["id"].as_str().unwrap().to_owned();
    let (code, body) = service
        .send(&format!("/api/threads/{side}/bring-back"), json!({}))
        .await;
    assert_eq!(code, 400, "nothing said yet: {body}");
    run(&service, &side, "a quiet aside").await;
    run(&service, &thread, "before the bring back").await;
    let (code, body) = service
        .send(&format!("/api/threads/{side}/bring-back"), json!({}))
        .await;
    assert_eq!(code, 204, "{body}");
    run(&service, &thread, "after the bring back").await;
    run(&service, &thread, "and after that").await;
    let log = std::fs::read_to_string(dir.path().join("launches")).unwrap();
    let turn = |prompt: &str| {
        log.lines()
            .filter(|line| line.contains(r#""mode":"codex-turn""#))
            .find(|line| line.contains(prompt))
            .unwrap()
    };
    assert!(!turn("before the bring back").contains("From a side chat"));
    assert!(turn("after the bring back").contains("From a side chat"));
    assert!(turn("after the bring back").contains("a quiet aside"));
    assert!(
        !turn("after the bring back").contains("the main work\\n"),
        "only the aside travels"
    );
    assert!(!turn("and after that").contains("From a side chat"));
}

#[tokio::test]
async fn fork_shows_the_history_up_to_its_point_and_leaves_the_parent_alone() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, options(&dir, false), "codex").await;
    seed(&dir);
    let first = run(&service, &thread, "first").await;
    run(&service, &thread, "second").await;
    let (code, fork) = service
        .send(
            &format!("/api/threads/{thread}/fork"),
            json!({ "run_id": first }),
        )
        .await;
    assert_eq!(code, 201, "{fork}");
    assert_eq!(fork["lifecycle"]["relation"], "fork");
    assert_eq!(fork["lifecycle"]["parent_thread_id"], thread.as_str());
    let id = fork["id"].as_str().unwrap();
    let events = service.all_events(id).await;
    assert_eq!(text_of(&events), "hello from codex");
    assert_eq!(events.last().unwrap()["run_id"], Value::Null);

    // New work in the fork continues its own numbering and spends no parent state.
    run(&service, id, "fork work").await;
    let parent = service.all_events(&thread).await;
    assert!(!parent.is_empty());
}

#[tokio::test]
async fn switching_engines_hands_off_within_budget_and_refuses_when_busy() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, options(&dir, true), "codex").await;
    seed(&dir);
    let long = "x".repeat(40_000);
    run(&service, &thread, &format!("oldest marker {long}")).await;
    run(&service, &thread, "newest marker").await;
    let path = format!("/api/threads/{thread}/switch-engine");
    let (code, _) = service
        .send(&path, json!({ "engine": "missing", "model": null }))
        .await;
    assert_eq!(code, 404);
    let (code, body) = service
        .send(&path, json!({ "engine": "claude", "model": null }))
        .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["engine"], "claude");
    run(&service, &thread, "carry on").await;
    let log = std::fs::read_to_string(dir.path().join("launches")).unwrap();
    let prompt = log
        .lines()
        .rfind(|line| line.contains("claude-prompt"))
        .unwrap();
    assert!(prompt.contains("newest marker"));
    assert!(
        !prompt.contains("oldest marker"),
        "the budget drops the oldest text first"
    );
    assert!(prompt.len() < 25_000, "{}", prompt.len());

    let hanging = service.admit(&thread, "[hang]").await;
    let (code, _) = service
        .send(&path, json!({ "engine": "codex", "model": null }))
        .await;
    assert_eq!(code, 409);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    service
        .send(&format!("/api/runs/{hanging}/cancel"), json!({}))
        .await;
    service.finished(&thread).await;
}

async fn changes_of(service: &Service, thread: &str, run: &str) -> Value {
    service
        .json(&format!("/api/threads/{thread}/runs/{run}/changes"))
        .await
}

async fn restore(service: &Service, thread: &str, run: &str, body: Value) -> (u16, Value) {
    service
        .send(
            &format!("/api/threads/{thread}/runs/{run}/changes/restore"),
            body,
        )
        .await
}

#[tokio::test]
async fn a_run_keeps_both_ends_of_a_file_and_restores_them_without_touching_later_work() {
    let dir = TempDir::new();
    let checkout = dir.path().join("library/repo/project");
    let options = Options {
        env: vec![(
            "ORBYN_FAKE_CHECKOUT".into(),
            checkout.to_string_lossy().into_owned(),
        )],
        ..Options::default()
    };
    let (service, thread) = setup(&dir, options, "codex").await;
    std::fs::write(checkout.join("a.txt"), "before\n").unwrap();
    let run = service.admit(&thread, "[write:a.txt]").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let new = service.admit(&thread, "[write:b.txt]").await;
    assert_eq!(service.finished(&thread).await, "completed");

    let changes = changes_of(&service, &thread, &run).await;
    assert_eq!(changes["files"][0]["path"], "a.txt");
    assert_eq!(changes["files"][0]["status"], "modified");
    assert_eq!(changes["files"][0]["restorable"], true);
    let added = changes_of(&service, &thread, &new).await;
    assert_eq!(added["files"][0]["status"], "added");

    // Saved content answers, whatever the folder holds now.
    std::fs::write(checkout.join("a.txt"), "someone else\n").unwrap();
    let saved = service
        .get(&format!("/api/threads/{thread}/runs/{run}/changes/file"))
        .query(&[("path", "a.txt")])
        .send()
        .await
        .unwrap();
    let saved: Value = saved.json().await.unwrap();
    assert_eq!(saved["before"], "before\n");
    assert_eq!(saved["after"], "written by turn\n");

    // Later work is reported and left where it is.
    let (code, report) = restore(&service, &thread, &run, json!({ "point": "start" })).await;
    assert_eq!(code, 200, "{report}");
    assert_eq!(report[0]["outcome"], "conflict");
    let held = std::fs::read_to_string(checkout.join("a.txt")).unwrap();
    assert_eq!(held, "someone else\n");

    std::fs::write(checkout.join("a.txt"), "written by turn\n").unwrap();
    let (_, report) = restore(&service, &thread, &run, json!({ "point": "start" })).await;
    assert_eq!(report[0]["outcome"], "restored");
    assert_eq!(
        std::fs::read_to_string(checkout.join("a.txt")).unwrap(),
        "before\n"
    );
    let (_, again) = restore(&service, &thread, &run, json!({ "point": "start" })).await;
    assert_eq!(again[0]["outcome"], "unchanged");
    let (_, report) = restore(&service, &thread, &new, json!({ "point": "start" })).await;
    assert_eq!(report[0]["outcome"], "restored");
    assert!(!checkout.join("b.txt").exists(), "an added file goes");

    let (code, _) = restore(
        &service,
        &thread,
        &run,
        json!({ "point": "start", "paths": ["never.txt"] }),
    )
    .await;
    assert_eq!(code, 400);
    let other = service
        .thread(
            service.json(&format!("/api/threads/{thread}")).await["project_id"]
                .as_str()
                .unwrap(),
            "codex",
        )
        .await;
    let (code, _) = restore(&service, &other, &run, json!({ "point": "start" })).await;
    assert_eq!(code, 404, "a run belongs to its thread");
    let audit = service.audit(&thread).await;
    assert!(
        audit
            .iter()
            .any(|row| row["action"] == "run.restore_changes")
    );
}

#[tokio::test]
async fn a_restore_waits_for_the_run_to_end() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let run = service.admit(&thread, "[hang]").await;
    let (code, _) = restore(&service, &thread, &run, json!({ "point": "start" })).await;
    assert_eq!(code, 409);
    let (code, _) = service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    assert_eq!(code, 202);
}
