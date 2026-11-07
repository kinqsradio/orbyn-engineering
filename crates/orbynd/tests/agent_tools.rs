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

/// Project mutations expose their normalized target in the real approval gate.
async fn project_tool_reply(
    service: &Service,
    thread: &str,
    seen: &mut Option<i64>,
    name: &str,
    args: Value,
    decision: Option<bool>,
) -> String {
    let run = service.admit(thread, &call(name, args)).await;
    if let Some(allow) = decision {
        let approval = service.pending().await;
        assert_eq!(approval["kind"], "tool");
        let summary = approval["summary"].as_str().unwrap();
        let audit = service.audit(thread).await;
        assert!(audit.iter().any(|row| {
            row["action"] == "approval.request"
                && row["target"] == name
                && row["detail"]["approval_id"] == approval["id"]
        }));
        assert!(approval["detail"]["path"].as_str().unwrap().len() <= 4096);
        if name == "orbyn_project_create" {
            assert!(summary.starts_with("Add existing folder "), "{summary}");
            assert_eq!(approval["detail"]["trusted"], false);
        } else {
            assert!(summary.starts_with("Remove project "), "{summary}");
            assert_eq!(approval["detail"]["files_removed"], false);
        }
        assert!(summary.contains(approval["detail"]["path"].as_str().unwrap()));
        assert_eq!(
            service
                .decide(approval["id"].as_str().unwrap(), allow)
                .await
                .0,
            200
        );
    }
    let events = service
        .events_until(thread, *seen, |event| {
            event["event"]["type"] == "RUN_FINISHED" && event["event"]["runId"] == run
        })
        .await;
    *seen = events.last().unwrap()["seq"].as_i64();
    assert_eq!(service.finished(thread).await, "completed");
    text_of(&events)
}

#[tokio::test]
async fn project_add_remove_needs_approval_keeps_files_and_refuses_busy_projects() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(), "codex").await;
    let candidate = dir.path().join("external-project");
    std::fs::create_dir_all(&candidate).unwrap();
    let sentinel = candidate.join("keep.txt");
    std::fs::write(&sentinel, b"uncommitted user bytes").unwrap();
    let mut seen = None;
    let denied = project_tool_reply(
        &service,
        &thread,
        &mut seen,
        "orbyn_project_create",
        json!({ "path": candidate }),
        Some(false),
    )
    .await;
    assert!(denied.contains("tool error=true"), "{denied}");
    let catalog = service.json("/api/projects").await;
    assert!(
        !catalog
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["path"].as_str().unwrap().ends_with("external-project"))
    );
    let added = project_tool_reply(
        &service,
        &thread,
        &mut seen,
        "orbyn_project_create",
        json!({ "path": candidate, "trusted": true }),
        Some(true),
    )
    .await;
    assert!(added.contains("tool error=false"), "{added}");
    let project: Value =
        serde_json::from_str(added.rsplit("tool error=false ").next().unwrap().trim()).unwrap();
    assert_eq!(project["trusted"], false);
    assert_eq!(project["managed"], false);
    let id = project["id"].as_str().unwrap();
    assert_eq!(std::fs::read(&sentinel).unwrap(), b"uncommitted user bytes");

    let own = service.json(&format!("/api/threads/{thread}")).await;
    let listed = tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_project_list",
        json!({}),
    )
    .await;
    let listed: Value =
        serde_json::from_str(listed.rsplit("tool error=false ").next().unwrap().trim()).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], own["project_id"]);
    let read = tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_project_read",
        json!({ "project_id": id }),
    )
    .await;
    let read: Value =
        serde_json::from_str(read.rsplit("tool error=false ").next().unwrap().trim()).unwrap();
    assert_eq!(read["project"]["id"], own["project_id"]);

    let denied = project_tool_reply(
        &service,
        &thread,
        &mut seen,
        "orbyn_project_delete",
        json!({ "project_id": id, "delete_files": true }),
        Some(false),
    )
    .await;
    assert!(denied.contains("tool error=true"), "{denied}");
    assert!(
        service
            .json("/api/projects")
            .await
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == id)
    );
    assert_eq!(
        service
            .send(&format!("/api/projects/{id}/trust"), json!({}))
            .await
            .0,
        200
    );
    let duplicate = project_tool_reply(
        &service,
        &thread,
        &mut seen,
        "orbyn_project_create",
        json!({ "path": candidate }),
        Some(true),
    )
    .await;
    assert!(duplicate.contains("tool error=true"), "{duplicate}");

    let foreign = service.thread(id, "codex").await;
    service.admit(&foreign, "[hang]").await;
    service
        .events_until(&foreign, None, |event| {
            event["event"]["type"] == "ACTIVITY_SNAPSHOT"
        })
        .await;
    let busy = project_tool_reply(
        &service,
        &thread,
        &mut seen,
        "orbyn_project_delete",
        json!({ "project_id": id, "thread_ids": [] }),
        Some(true),
    )
    .await;
    assert!(busy.contains("tool error=true"), "{busy}");
    assert!(!service.json(&format!("/api/threads/{foreign}")).await["active_run"].is_null());
    assert_eq!(
        service
            .send(&format!("/api/threads/{foreign}/force-stop"), json!({}))
            .await
            .0,
        200
    );
    assert_eq!(service.finished(&foreign).await, "cancelled");
    let removed = project_tool_reply(
        &service,
        &thread,
        &mut seen,
        "orbyn_project_delete",
        json!({ "project_id": id, "delete_files": true }),
        Some(true),
    )
    .await;
    assert!(removed.contains("tool error=false"), "{removed}");
    assert!(removed.contains("\"files_removed\":false"), "{removed}");
    assert!(
        !service
            .json("/api/projects")
            .await
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == id)
    );
    let kept = service.json(&format!("/api/threads/{foreign}")).await;
    assert_eq!(kept["project_removed"], true, "{kept}");
    assert_eq!(std::fs::read(&sentinel).unwrap(), b"uncommitted user bytes");
    assert_eq!(std::fs::read_dir(&candidate).unwrap().count(), 1);

    for args in [
        json!({}),
        json!({"path": "relative"}),
        json!({"path": "x".repeat(4097)}),
    ] {
        let invalid = project_tool_reply(
            &service,
            &thread,
            &mut seen,
            "orbyn_project_create",
            args,
            None,
        )
        .await;
        assert!(invalid.contains("tool error=true"), "{invalid}");
    }
    for args in [
        json!({"project_id": own["project_id"]}),
        json!({"project_id": "missing"}),
        json!({"project_id": "x".repeat(129)}),
    ] {
        let invalid = project_tool_reply(
            &service,
            &thread,
            &mut seen,
            "orbyn_project_delete",
            args,
            None,
        )
        .await;
        assert!(invalid.contains("tool error=true"), "{invalid}");
    }
    let audit = service.audit(&thread).await;
    assert!(
        audit
            .iter()
            .any(|row| row["action"] == "project.add" && row["actor"] == "engine:codex")
    );
    assert!(
        audit
            .iter()
            .any(|row| row["action"] == "project.remove" && row["actor"] == "engine:codex")
    );
    assert_eq!(
        service.patch(&thread, json!({"plan_mode": true})).await.0,
        200
    );
    let planned = project_tool_reply(
        &service,
        &thread,
        &mut seen,
        "orbyn_project_create",
        json!({"path": candidate}),
        None,
    )
    .await;
    assert!(
        planned.contains("Plan mode does not add or remove projects"),
        "{planned}"
    );
    service.stop().await;
}

#[tokio::test]
async fn reading_needs_no_approval_and_stays_in_the_project() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(), "codex").await;
    let other_folder = dir.path().join("other");
    std::fs::create_dir_all(&other_folder).unwrap();
    let other = service.project(&other_folder, true).await;
    let foreign = service.thread(&other, "codex").await;
    let own = service.json(&format!("/api/threads/{thread}")).await;
    let listed = one_turn(&service, &thread, &call("orbyn_project_list", json!({}))).await;
    assert!(listed.contains("tool error=false"), "{listed}");
    let projects: Value =
        serde_json::from_str(listed.rsplit("tool error=false ").next().unwrap().trim()).unwrap();
    assert_eq!(projects.as_array().unwrap().len(), 1);
    assert_eq!(projects[0]["id"], own["project_id"]);
    assert_ne!(projects[0]["id"], other);
    let prompt = call("orbyn_thread_read", json!({ "thread_id": foreign }));
    let seen = service.all_events(&thread).await.last().unwrap()["seq"].as_i64();
    service.admit(&thread, &prompt).await;
    let events = service
        .events_until(&thread, seen, |event| {
            event["event"]["type"] == "RUN_FINISHED"
        })
        .await;
    let text = text_of(&events);
    assert!(text.contains("tool error=true"), "{text}");
    assert!(text.contains("not found"), "{text}");
    service.stop().await;
}

#[tokio::test]
async fn delegated_work_stop_asks_and_only_stops_the_callers_child() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(), "codex").await;
    let own = service.json(&format!("/api/threads/{thread}")).await;
    let sibling = service
        .thread(own["project_id"].as_str().unwrap(), "codex")
        .await;
    let (status, child) = service
        .send(
            &format!("/api/threads/{thread}/delegate"),
            json!({ "prompt": "[hang]", "title": "Delegated work" }),
        )
        .await;
    assert_eq!(status, 201);
    let child = child["id"].as_str().unwrap();
    service
        .events_until(child, None, |event| {
            event["event"]["type"] == "ACTIVITY_SNAPSHOT"
        })
        .await;

    service
        .admit(
            &thread,
            &call("orbyn_workflow_stop", json!({ "thread_id": child })),
        )
        .await;
    let approval = service.pending().await;
    assert!(
        approval["summary"]
            .as_str()
            .unwrap()
            .contains("orbyn_workflow_stop")
    );
    assert_eq!(
        service
            .decide(approval["id"].as_str().unwrap(), false)
            .await
            .0,
        200
    );
    assert_eq!(service.finished(&thread).await, "completed");
    assert!(!service.json(&format!("/api/threads/{child}")).await["active_run"].is_null());
    full_access(&service, &thread).await;

    let outside_folder = dir.path().join("outside");
    std::fs::create_dir_all(&outside_folder).unwrap();
    let outside_project = service.project(&outside_folder, true).await;
    let outside = service.thread(&outside_project, "codex").await;
    let (status, other_child) = service
        .send(
            &format!("/api/threads/{sibling}/delegate"),
            json!({ "prompt": "[hang]", "title": "Other parent's work" }),
        )
        .await;
    assert_eq!(status, 201);
    let other_child = other_child["id"].as_str().unwrap();
    service
        .events_until(other_child, None, |event| {
            event["event"]["type"] == "ACTIVITY_SNAPSHOT"
        })
        .await;
    let mut seen = service.all_events(&thread).await.last().unwrap()["seq"].as_i64();
    for id in [
        thread.as_str(),
        sibling.as_str(),
        outside.as_str(),
        other_child,
    ] {
        service
            .admit(
                &thread,
                &call("orbyn_workflow_stop", json!({ "thread_id": id })),
            )
            .await;
        let events = service
            .events_until(&thread, seen, |event| {
                event["event"]["type"] == "RUN_FINISHED"
            })
            .await;
        seen = events.last().unwrap()["seq"].as_i64();
        let text = text_of(&events);
        assert!(
            text.contains("tool error=true") && text.contains("not found"),
            "{text}"
        );
    }
    assert!(!service.json(&format!("/api/threads/{other_child}")).await["active_run"].is_null());
    let waiting = tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_thread_wait",
        json!({ "thread_id": child, "seconds": 0 }),
    )
    .await;
    assert!(waiting.contains("\"ended\":false"), "{waiting}");
    let stop_run = service
        .admit(
            &thread,
            &call("orbyn_workflow_stop", json!({ "thread_id": child })),
        )
        .await;
    let stopped = service
        .events_until(&thread, seen, |event| {
            event["event"]["type"] == "RUN_FINISHED" && event["event"]["runId"] == stop_run
        })
        .await;
    seen = stopped.last().unwrap()["seq"].as_i64();
    let stop = text_of(&stopped);
    assert!(stop.contains("tool error=false"), "{stop}");
    assert!(stop.contains("\"stopped\":true"), "{stop}");
    assert_eq!(service.finished(child).await, "cancelled");

    // Completion reports start another parent run. Its transcript contains the
    // fake engine's [hang] marker, so explicitly stop that report before sending
    // more tools; never mistake its terminal event for a tool's reply.
    let report = service
        .events_until(&thread, seen, |event| {
            event["event"]["type"] == "RUN_STARTED"
        })
        .await;
    let report_start = report.last().unwrap();
    let report_run = report_start["event"]["runId"].as_str().unwrap();
    assert_ne!(report_run, stop_run);
    assert_eq!(
        service
            .send(&format!("/api/threads/{thread}/force-stop"), json!({}))
            .await
            .0,
        200
    );
    let finished = service
        .events_until(&thread, report_start["seq"].as_i64(), |event| {
            event["event"]["type"] == "RUN_FINISHED" && event["event"]["runId"] == report_run
        })
        .await;
    seen = finished.last().unwrap()["seq"].as_i64();
    let waiting = tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_thread_wait",
        json!({ "thread_id": child, "seconds": 0 }),
    )
    .await;
    assert!(waiting.contains("\"ended\":true"), "{waiting}");
    let stop = tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_workflow_stop",
        json!({ "thread_id": child }),
    )
    .await;
    assert!(stop.contains("\"stopped\":false"), "{stop}");
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
        ("orbyn_preview_status", json!({ "tab_id": "not-mine" })),
        (
            "orbyn_preview_dialog",
            json!({ "tab_id": "not-mine", "accept": true }),
        ),
        (
            "orbyn_preview_set_appearance",
            json!({ "tab_id": "not-mine", "appearance": "dark" }),
        ),
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
    let cwd = std::path::Path::new(child["cwd"].as_str().unwrap());
    assert!(cwd.ends_with("tidy"), "{child}");
    assert!(
        cwd.parent().unwrap().to_string_lossy().ends_with("-wt"),
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
    assert!(changed["lifecycle"]["pinned_at"].is_string(), "{changed}");

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

#[tokio::test]
async fn a_page_is_published_from_a_thread_and_its_frame_token_serves_it() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(), "codex").await;
    full_access(&service, &thread).await;
    let html = "<!doctype html><script>draw()</script><p>tides</p>";
    let mut seen = None;
    let text = tool(
        &service,
        &thread,
        &mut seen,
        "orbyn_html_render",
        json!({ "html": html, "title": "  Tide chart  ", "height": 9000 }),
    )
    .await;
    let reply: Value =
        serde_json::from_str(text.rsplit("tool error=false ").next().unwrap().trim()).unwrap();
    let id = reply["id"].as_str().unwrap();
    let frame = reply["frame_token"].as_str().unwrap();
    assert_eq!(reply["title"], "Tide chart");
    assert_eq!(reply["height"], 2000);
    assert_eq!(reply["images"], 0);
    assert_eq!(reply["bytes"], html.len());
    assert_eq!(reply["url"], format!("/api/threads/{thread}/renders/{id}"));
    assert_eq!(frame.len(), 64);

    // The frame token opens the page with no header at all, and the service token in
    // that slot does not.
    let url = reply["url"].as_str().unwrap();
    let page = service
        .client
        .get(format!("{}{url}?render={frame}", service.url))
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), 200);
    assert_eq!(page.text().await.unwrap(), html);
    let refused = service
        .client
        .get(format!("{}{url}?render={}", service.url, service.token))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 401);

    // The page is this thread's render, not another thread's.
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let sibling = service
        .thread(body["project_id"].as_str().unwrap(), "codex")
        .await;
    let elsewhere = service
        .client
        .get(format!(
            "{}/api/threads/{sibling}/renders/{id}?render={frame}",
            service.url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(elsewhere.status(), 401);
    service.stop().await;
}

/// Runs one tool in its own turn and returns the run's text, whatever it answered.
async fn tool_turn(
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
    text_of(&events)
}

fn reply_of(text: &str) -> Value {
    serde_json::from_str(text.rsplit("tool error=false ").next().unwrap().trim()).unwrap()
}

#[tokio::test]
async fn a_review_guide_is_written_through_the_gate_and_read_inside_its_project() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(), "codex").await;
    let mut seen = None;
    let s = &service;
    let t = thread.as_str();
    let guide = json!({
        "number": 7,
        "head_sha": "ABCDEF1234567",
        "stops": [
            {
                "title": "Entry point",
                "summary": "Start with the route.",
                "files": [{ "path": "src/main.rs", "note": "wires the route" }],
                "questions": ["Is the timeout right?"],
                "ignored": true,
            },
            { "title": "Tests" },
        ],
    });

    let empty = tool(
        s,
        t,
        &mut seen,
        "orbyn_pull_guide_read",
        json!({ "number": 7 }),
    )
    .await;
    assert_eq!(reply_of(&empty)["guide"], Value::Null, "{empty}");

    let run = service
        .admit(t, &call("orbyn_pull_guide_write", guide.clone()))
        .await;
    let approval = service.pending().await;
    assert_eq!(approval["kind"], "tool");
    assert!(
        approval["summary"]
            .as_str()
            .unwrap()
            .contains("orbyn_pull_guide_write")
    );
    assert!(
        service
            .decide(approval["id"].as_str().unwrap(), false)
            .await
            .0
            < 300
    );
    let events = service
        .events_until(t, seen, |event| {
            event["event"]["type"] == "RUN_FINISHED" && event["event"]["runId"] == run
        })
        .await;
    seen = events.last().unwrap()["seq"].as_i64();
    assert_eq!(service.finished(t).await, "completed");
    assert!(text_of(&events).contains("tool error=true"));
    let denied = tool(
        s,
        t,
        &mut seen,
        "orbyn_pull_guide_read",
        json!({ "number": 7 }),
    )
    .await;
    assert_eq!(
        reply_of(&denied)["guide"],
        Value::Null,
        "a denial stores nothing"
    );

    full_access(s, t).await;
    let off = tool_turn(s, t, &mut seen, "orbyn_pull_guide_write", guide.clone()).await;
    assert!(off.contains("tool error=true"), "{off}");
    assert!(off.contains("Review guides are off"), "{off}");

    tool(
        s,
        t,
        &mut seen,
        "orbyn_environment_preferences_update",
        json!({ "values": { "review_guides_enabled": true } }),
    )
    .await;
    let bad = tool_turn(
        s,
        t,
        &mut seen,
        "orbyn_pull_guide_write",
        json!({ "number": 7, "stops": [{ "title": "x".repeat(201) }] }),
    )
    .await;
    assert!(bad.contains("tool error=true"), "{bad}");

    let written = tool(s, t, &mut seen, "orbyn_pull_guide_write", guide).await;
    let written = reply_of(&written);
    assert_eq!(written["number"], 7);
    assert_eq!(written["stops"], 2);
    assert_eq!(written["head_sha"], "abcdef1234567");

    let read = tool(
        s,
        t,
        &mut seen,
        "orbyn_pull_guide_read",
        json!({ "number": 7 }),
    )
    .await;
    let read = reply_of(&read)["guide"].clone();
    assert_eq!(read["head_sha"], "abcdef1234567");
    assert_eq!(read["thread_id"], t);
    assert_eq!(read["stops"].as_array().unwrap().len(), 2);
    assert_eq!(read["stops"][0]["title"], "Entry point");
    assert_eq!(read["stops"][0]["files"][0]["path"], "src/main.rs");
    assert!(read["stops"][0].get("ignored").is_none());
    assert_eq!(read["stops"][1]["questions"], json!([]));

    let replaced = tool(
        s,
        t,
        &mut seen,
        "orbyn_pull_guide_write",
        json!({ "number": 7, "stops": [{ "title": "Only stop" }] }),
    )
    .await;
    assert_eq!(reply_of(&replaced)["head_sha"], Value::Null);
    let read = tool(
        s,
        t,
        &mut seen,
        "orbyn_pull_guide_read",
        json!({ "number": 7 }),
    )
    .await;
    let read = reply_of(&read)["guide"].clone();
    assert_eq!(read["stops"].as_array().unwrap().len(), 1);
    assert_eq!(read["head_sha"], Value::Null);

    let audit = service.audit(t).await;
    assert!(
        audit
            .iter()
            .any(|row| row["action"] == "tool.call" && row["target"] == "orbyn_pull_guide_write")
    );

    let other_folder = dir.path().join("other");
    std::fs::create_dir_all(&other_folder).unwrap();
    let other = service.project(&other_folder, true).await;
    let foreign = service.thread(&other, "codex").await;
    let mut foreign_seen = None;
    let elsewhere = tool(
        s,
        &foreign,
        &mut foreign_seen,
        "orbyn_pull_guide_read",
        json!({ "number": 7 }),
    )
    .await;
    assert_eq!(
        reply_of(&elsewhere)["guide"],
        Value::Null,
        "a guide belongs to its own project"
    );

    // The guide tab reads the same guide over HTTP, typed.
    let project = service.json(&format!("/api/threads/{t}")).await["project_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let shown = service
        .json(&format!("/api/projects/{project}/pulls/7/guide"))
        .await;
    assert_eq!(shown["enabled"], true);
    assert_eq!(shown["guide"]["number"], 7);
    assert_eq!(shown["guide"]["stops"][0]["title"], "Only stop");
    assert_eq!(shown["guide"]["stops"][0]["files"], json!([]));
    let none = service
        .json(&format!("/api/projects/{other}/pulls/7/guide"))
        .await;
    assert_eq!(none, json!({ "enabled": false, "guide": null }));

    // Asking about a stop opens a thread with the stop as its draft; nothing is sent.
    let ask = format!("/api/projects/{project}/pulls/7/guide/ask");
    let (code, asked) = service
        .send(&ask, json!({ "engine": "codex", "stop": 0 }))
        .await;
    assert_eq!(code, 201, "{asked}");
    assert_eq!(asked["thread"]["title"], "#7: Only stop");
    assert_eq!(asked["thread"]["project_id"], project.as_str());
    let draft = asked["draft"].as_str().unwrap();
    assert!(draft.starts_with("About stop 1 of the review guide for pull request #7: Only stop"));
    assert!(draft.ends_with("My question: "));
    let asked_thread = asked["thread"]["id"].as_str().unwrap();
    assert!(
        service.json(&format!("/api/threads/{asked_thread}")).await["last_run_state"].is_null(),
        "the question is the person's to send"
    );
    let (code, _) = service
        .send(&ask, json!({ "engine": "codex", "stop": 1 }))
        .await;
    assert_eq!(code, 404, "a stop past the end");
    let (code, _) = service
        .send(
            &format!("/api/projects/{other}/pulls/7/guide/ask"),
            json!({ "engine": "codex", "stop": 0 }),
        )
        .await;
    assert_eq!(code, 404, "another project has no guide");
    service.stop().await;
}
