//! Orbyn's own MCP tools, called by a running engine through the real service.

mod support;

use serde_json::{Value, json};
use support::{FAKE, Options, Service, TempDir, setup, text_of};

fn engines() -> Options {
    Options {
        env: vec![("ORBYN_CODEX_BIN".to_owned(), FAKE.to_owned())],
        ..Options::default()
    }
}

fn call(tool: &str, args: Value) -> String {
    format!("[mcp-call:{tool}]{args}[/mcp-call]")
}

async fn one_turn(service: &Service, thread: &str, prompt: &str) -> String {
    service.admit(thread, prompt).await;
    assert_eq!(service.finished(thread).await, "completed");
    text_of(&service.all_events(thread).await)
}

#[tokio::test]
async fn reading_needs_no_approval_and_stays_in_the_project() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(), "codex").await;
    let other_folder = dir.path().join("other");
    std::fs::create_dir_all(&other_folder).unwrap();
    let other = service.project(&other_folder, true).await;
    let foreign = service.thread(&other, "codex").await;
    let prompt = call("orbyn_thread_read", json!({ "thread_id": foreign }));
    let text = one_turn(&service, &thread, &prompt).await;
    assert!(text.contains("tool error=true"), "{text}");
    assert!(text.contains("not found"), "{text}");
    service.stop().await;
}

#[tokio::test]
async fn a_tool_with_an_effect_asks_and_a_denial_changes_nothing() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(), "codex").await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let sibling = service
        .thread(body["project_id"].as_str().unwrap(), "codex")
        .await;
    let prompt = call(
        "orbyn_thread_send",
        json!({ "thread_id": sibling, "prompt": "hello" }),
    );
    service.admit(&thread, &prompt).await;
    let approval = service.pending().await;
    assert_eq!(approval["kind"], "tool");
    assert!(
        approval["summary"]
            .as_str()
            .unwrap()
            .contains("orbyn_thread_send")
    );
    let (code, _) = service
        .decide(approval["id"].as_str().unwrap(), false)
        .await;
    assert!(code < 300);
    assert_eq!(service.finished(&thread).await, "completed");
    let text = text_of(&service.all_events(&thread).await);
    assert!(text.contains("tool error=true"), "{text}");
    let queue = service.json(&format!("/api/threads/{sibling}/queue")).await;
    assert_eq!(queue.as_array().unwrap().len(), 0);
    let audit = service.audit(&thread).await;
    assert!(audit.iter().any(|row| row["action"] == "tool.call"));
    service.stop().await;
}

#[tokio::test]
async fn full_access_passes_and_a_delegated_thread_cannot_delegate_again() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(), "codex").await;
    let (code, _) = service
        .patch(&thread, json!({ "permission_mode": "full_access" }))
        .await;
    assert_eq!(code, 200);
    let prompt = call(
        "orbyn_delegate_task",
        json!({ "prompt": "work", "title": "Child" }),
    );
    let text = one_turn(&service, &thread, &prompt).await;
    assert!(text.contains("tool error=false"), "{text}");
    let reply: Value =
        serde_json::from_str(text.rsplit("tool error=false ").next().unwrap().trim()).unwrap();
    let child = reply["thread_id"].as_str().unwrap();
    assert_eq!(service.finished(child).await, "completed");
    assert_eq!(
        service
            .patch(child, json!({ "permission_mode": "full_access" }))
            .await
            .0,
        200
    );
    let first = service.all_events(child).await;
    let seen = first.last().unwrap()["seq"].as_i64();
    let nested = call("orbyn_delegate_task", json!({ "prompt": "more" }));
    service.admit(child, &nested).await;
    let later = service
        .events_until(child, seen, |event| {
            event["event"]["type"] == "RUN_FINISHED"
        })
        .await;
    let text = text_of(&later);
    assert!(text.contains("cannot delegate further"), "{text}");
    service.stop().await;
}

/// Runs one tool in its own turn and returns what it answered.
async fn tool(
    service: &Service,
    thread: &str,
    seen: &mut Option<i64>,
    name: &str,
    args: Value,
) -> String {
    service.admit(thread, &call(name, args)).await;
    let events = service
        .events_until(thread, *seen, |event| {
            event["event"]["type"] == "RUN_FINISHED"
        })
        .await;
    *seen = events.last().unwrap()["seq"].as_i64();
    assert_eq!(service.finished(thread).await, "completed");
    let text = text_of(&events);
    assert!(text.contains("tool error=false"), "{name}: {text}");
    text
}

#[tokio::test]
async fn every_thread_and_schedule_tool_works_from_a_real_run() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(), "codex").await;
    service
        .patch(&thread, json!({ "permission_mode": "full_access" }))
        .await;
    let mut seen = None;
    let s = &service;
    let t = thread.as_str();
    let text = tool(s, t, &mut seen, "orbyn_environment_read", json!({})).await;
    assert!(text.contains(t));
    assert!(
        tool(s, t, &mut seen, "orbyn_project_read", json!({}))
            .await
            .contains("project")
    );
    tool(s, t, &mut seen, "orbyn_worktree_list", json!({})).await;
    assert!(
        tool(s, t, &mut seen, "orbyn_thread_list", json!({}))
            .await
            .contains(t)
    );
    tool(s, t, &mut seen, "orbyn_pull_list", json!({})).await;
    let launched = tool(
        s,
        t,
        &mut seen,
        "orbyn_thread_launch",
        json!({ "prompt": "first words", "title": "Launched" }),
    )
    .await;
    let launched: Value =
        serde_json::from_str(launched.rsplit("tool error=false ").next().unwrap().trim()).unwrap();
    let other = launched["thread_id"].as_str().unwrap();
    assert_eq!(s.finished(other).await, "completed");
    let waited = tool(
        s,
        t,
        &mut seen,
        "orbyn_thread_wait",
        json!({ "thread_id": other, "seconds": 5 }),
    )
    .await;
    assert!(waited.contains("\"ended\":true"), "{waited}");
    let hits = tool(
        s,
        t,
        &mut seen,
        "orbyn_thread_search",
        json!({ "query": "words first" }),
    )
    .await;
    assert!(hits.contains(other), "{hits}");
    tool(
        s,
        t,
        &mut seen,
        "orbyn_thread_send",
        json!({ "thread_id": other, "prompt": "again" }),
    )
    .await;
    assert_eq!(s.finished(other).await, "completed");
    tool(
        s,
        t,
        &mut seen,
        "orbyn_queue_list",
        json!({ "thread_id": other }),
    )
    .await;
    tool(
        s,
        t,
        &mut seen,
        "orbyn_pending_requests",
        json!({ "thread_id": other }),
    )
    .await;
    tool(
        s,
        t,
        &mut seen,
        "orbyn_task_status",
        json!({ "thread_id": other }),
    )
    .await;
    tool(
        s,
        t,
        &mut seen,
        "orbyn_thread_update",
        json!({ "thread_id": other, "title": "Renamed" }),
    )
    .await;
    let renamed = s.json(&format!("/api/threads/{other}")).await;
    assert_eq!(renamed["title"], "Renamed");
    let task = tool(
        s,
        t,
        &mut seen,
        "orbyn_schedule_task",
        json!({ "name": "Tick", "prompt": "hi", "every_minutes": 5 }),
    )
    .await;
    let task: Value =
        serde_json::from_str(task.rsplit("tool error=false ").next().unwrap().trim()).unwrap();
    let id = task["id"].as_str().unwrap();
    assert!(
        tool(s, t, &mut seen, "orbyn_schedule_list", json!({}))
            .await
            .contains(id)
    );
    tool(
        s,
        t,
        &mut seen,
        "orbyn_schedule_run",
        json!({ "task_id": id }),
    )
    .await;
    tool(
        s,
        t,
        &mut seen,
        "orbyn_schedule_delete",
        json!({ "task_id": id }),
    )
    .await;
    assert_eq!(s.json("/api/tasks").await.as_array().unwrap().len(), 0);
    service.stop().await;
}
