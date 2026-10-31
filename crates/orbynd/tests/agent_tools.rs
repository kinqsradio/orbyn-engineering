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

async fn full_access(service: &Service, thread: &str) {
    let (code, _) = service
        .patch(thread, json!({ "permission_mode": "full_access" }))
        .await;
    assert_eq!(code, 200);
}

#[tokio::test]
async fn an_agent_starts_threads_changes_project_preferences_and_renames_only_its_own_project() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(), "codex").await;
    full_access(&service, &thread).await;
    let mut seen = None;
    let made = tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_threads_create",
        json!({ "threads": [
            { "prompt": "one", "title": "One" },
            { "prompt": "two", "engine": "nope" },
        ]}),
    )
    .await;
    assert!(made.contains("thread_id"), "{made}");
    assert!(
        made.contains("error"),
        "one failure does not stop the rest: {made}"
    );

    tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_environment_preferences_update",
        json!({ "values": { "branch_name_prefix": "wip" } }),
    )
    .await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let project = body["project_id"].as_str().unwrap();
    let prefs = service
        .json(&format!("/api/preferences?project_id={project}"))
        .await;
    let prefix = prefs
        .as_array()
        .unwrap()
        .iter()
        .find(|view| view["key"] == "branch_name_prefix")
        .unwrap();
    assert_eq!(prefix["value"], "wip");

    tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_project_update",
        json!({ "name": "Renamed" }),
    )
    .await;
    let projects = service.json("/api/projects").await;
    assert!(
        projects
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == project && row["name"] == "Renamed")
    );

    let refused = call(
        "orbyn_environment_preferences_update",
        json!({ "values": { "prefer_saved_login": true } }),
    );
    service.admit(&thread, &refused).await;
    let events = service
        .events_until(&thread, seen, |event| {
            event["event"]["type"] == "RUN_FINISHED"
        })
        .await;
    service.finished(&thread).await;
    let text = text_of(&events);
    assert!(text.contains("tool error=true"), "a global key: {text}");
    service.stop().await;
}

#[tokio::test]
async fn attachments_come_from_this_checkout_and_previews_from_this_thread() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(), "codex").await;
    full_access(&service, &thread).await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let checkout = std::path::PathBuf::from(body["cwd"].as_str().unwrap());
    std::fs::write(checkout.join("note.txt"), "hello").unwrap();
    std::fs::write(dir.path().join("outside.txt"), "no").unwrap();
    let sibling = service
        .thread(body["project_id"].as_str().unwrap(), "codex")
        .await;
    let mut seen = None;
    let added = tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_attachment_add",
        json!({ "thread_id": sibling, "path": "note.txt" }),
    )
    .await;
    let reply: Value =
        serde_json::from_str(added.rsplit("tool error=false ").next().unwrap().trim()).unwrap();
    let id = reply["id"].as_str().unwrap();
    assert_eq!(
        service
            .json(&format!("/api/threads/{sibling}/attachments"))
            .await[0]["id"],
        id
    );
    tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_attachment_discard",
        json!({ "thread_id": sibling, "attachment_id": id }),
    )
    .await;

    for (name, args) in [
        (
            "orbyn_attachment_add",
            json!({ "thread_id": sibling, "path": "../outside.txt" }),
        ),
        ("orbyn_preview_close", json!({ "tab_id": "not-mine" })),
        (
            "orbyn_preview_resize",
            json!({ "tab_id": "not-mine", "width": 300, "height": 300 }),
        ),
    ] {
        service.admit(&thread, &call(name, args)).await;
        let events = service
            .events_until(&thread, seen, |event| {
                event["event"]["type"] == "RUN_FINISHED"
            })
            .await;
        seen = events.last().unwrap()["seq"].as_i64();
        service.finished(&thread).await;
        assert!(text_of(&events).contains("tool error=true"), "{name}");
    }
    let status = tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_worktree_status",
        json!({}),
    )
    .await;
    assert!(status.contains("\"worktree\":false"), "{status}");
    let abilities = tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_orchestrator_capabilities",
        json!({}),
    )
    .await;
    assert!(abilities.contains("\"can_delegate\":true"), "{abilities}");
    service.stop().await;
}

#[tokio::test]
async fn a_handoff_starts_a_thread_in_a_new_worktree() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(), "codex").await;
    full_access(&service, &thread).await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let checkout = std::path::Path::new(body["cwd"].as_str().unwrap()).to_path_buf();
    support::run_git(&checkout, &["config", "user.email", "t@example.com"]);
    support::run_git(&checkout, &["config", "user.name", "T"]);
    support::run_git(&checkout, &["commit", "-q", "--allow-empty", "-m", "base"]);
    let mut seen = None;
    let text = tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_worktree_handoff",
        json!({ "purpose": "tidy", "prompt": "carry on" }),
    )
    .await;
    let reply: Value =
        serde_json::from_str(text.rsplit("tool error=false ").next().unwrap().trim()).unwrap();
    let child = service
        .json(&format!(
            "/api/threads/{}",
            reply["thread_id"].as_str().unwrap()
        ))
        .await;
    assert!(
        child["cwd"].as_str().unwrap().contains("-wt/tidy"),
        "{child}"
    );
    service.stop().await;
}

#[tokio::test]
async fn a_thread_is_organized_and_configured_inside_its_project_only() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(), "codex").await;
    full_access(&service, &thread).await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let sibling = service
        .thread(body["project_id"].as_str().unwrap(), "codex")
        .await;
    let mut seen = None;
    tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_thread_organize",
        json!({ "thread_id": sibling, "pinned": true }),
    )
    .await;
    tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_thread_configure",
        json!({ "thread_id": sibling, "plan_mode": true, "effort": "high" }),
    )
    .await;
    let changed = service.json(&format!("/api/threads/{sibling}")).await;
    assert_eq!(changed["effort"], "high");
    assert_eq!(changed["lifecycle"]["plan_mode"], true);
    assert!(!changed["lifecycle"]["pinned_at"].is_null() || changed["lifecycle"]["pinned"] == true);

    let elsewhere = dir.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let foreign_project = service.project(&elsewhere, true).await;
    let foreign = service.thread(&foreign_project, "codex").await;
    for (name, args) in [
        (
            "orbyn_thread_organize",
            json!({ "thread_id": foreign, "archived": true }),
        ),
        (
            "orbyn_thread_configure",
            json!({ "thread_id": sibling, "permission_mode": "root" }),
        ),
    ] {
        service.admit(&thread, &call(name, args)).await;
        let events = service
            .events_until(&thread, seen, |event| {
                event["event"]["type"] == "RUN_FINISHED"
            })
            .await;
        seen = events.last().unwrap()["seq"].as_i64();
        service.finished(&thread).await;
        assert!(text_of(&events).contains("tool error=true"), "{name}");
    }
    service.stop().await;
}
