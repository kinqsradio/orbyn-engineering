//! Queue, steering, permission modes, attachments and slash commands through the
//! real service and the fake engine.

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use support::{Options, Service, TempDir, setup, text_of};

async fn queue(service: &Service, thread: &str) -> Vec<Value> {
    service
        .json(&format!("/api/threads/{thread}/queue"))
        .await
        .as_array()
        .unwrap()
        .clone()
}

async fn enqueue(service: &Service, thread: &str, prompt: &str) -> Value {
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/queue"),
            json!({ "prompt": prompt }),
        )
        .await;
    assert_eq!(code, 201, "{body}");
    body
}

async fn until_running(service: &Service, thread: &str) {
    for _ in 0..2000 {
        if service.run_state(thread).await == "running" {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the run never started");
}

/// Waits until `count` runs have been admitted and the last one has ended.
async fn until_prompts(service: &Service, thread: &str, count: usize) {
    for _ in 0..2000 {
        let body = service.json(&format!("/api/threads/{thread}")).await;
        let audit = service.audit(thread).await;
        let admitted = audit
            .iter()
            .filter(|row| row["action"] == "run.admit")
            .count();
        if body["active_run"].is_null() && admitted >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("queued work never ran");
}

#[tokio::test]
async fn queue_runs_in_order_after_the_active_run_and_idle_starts_at_once() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[hang]").await;
    until_running(&service, &thread).await;
    enqueue(&service, &thread, "first").await;
    enqueue(&service, &thread, "second").await;
    assert_eq!(queue(&service, &thread).await.len(), 2);

    // A queued message waits for a turn that finishes on its own.
    let (code, _) = service
        .send(
            &format!("/api/threads/{thread}/steer"),
            json!({ "prompt": "finish" }),
        )
        .await;
    assert_eq!(code, 202);
    until_prompts(&service, &thread, 3).await;
    assert!(queue(&service, &thread).await.is_empty());
    let events = service
        .events_until(&thread, None, |event| event["event"]["delta"] == "second")
        .await;
    let prompts: Vec<&str> = events
        .iter()
        .filter(|event| {
            event["event"]["messageId"]
                .as_str()
                .is_some_and(|id| id.ends_with(":prompt"))
                && event["event"]["type"] == "TEXT_MESSAGE_CONTENT"
        })
        .filter_map(|event| event["event"]["delta"].as_str())
        .collect();
    assert_eq!(prompts, ["[hang]", "finish", "first", "second"]);
}

#[tokio::test]
async fn a_stop_holds_the_queue_until_resume() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let run = service.admit(&thread, "[hang]").await;
    enqueue(&service, &thread, "later").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    assert_eq!(service.finished(&thread).await, "cancelled");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let held = queue(&service, &thread).await;
    assert_eq!(held[0]["held"], true);
    assert!(service.json(&format!("/api/threads/{thread}")).await["active_run"].is_null());

    // New messages join a held queue instead of jumping past it.
    let added = enqueue(&service, &thread, "newer").await;
    assert_eq!(added["held"], true);

    let (code, _) = service
        .send(&format!("/api/threads/{thread}/queue/resume"), json!({}))
        .await;
    assert_eq!(code, 202);
    until_prompts(&service, &thread, 3).await;
    assert!(queue(&service, &thread).await.is_empty());
}

#[tokio::test]
async fn a_crash_holds_the_queue_across_restart() {
    let dir = TempDir::new();
    let data = dir.path().join("data");
    let (mut service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[hang]").await;
    let started = async {
        while !queue(&service, &thread).await.is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), started)
        .await
        .unwrap();
    enqueue(&service, &thread, "kept").await;
    service.kill();
    let reopened = Service::start(&data, Options::default());
    let held = queue(&reopened, &thread).await;
    assert_eq!(held[0]["prompt"], "kept");
    assert_eq!(held[0]["held"], true);
}

#[tokio::test]
async fn send_now_stops_the_turn_and_goes_first_edit_and_remove_work() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[hang]").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let waiting = enqueue(&service, &thread, "waiting").await;
    let edited = enqueue(&service, &thread, "tpyo").await;
    let dropped = enqueue(&service, &thread, "dropped").await;

    let edit = service
        .client
        .patch(format!(
            "{}/api/queue/{}",
            service.url,
            edited["id"].as_str().unwrap()
        ))
        .bearer_auth(&service.token)
        .json(&json!({ "prompt": "typo fixed" }))
        .send()
        .await
        .unwrap();
    assert_eq!(edit.status(), 200);
    let remove = service
        .client
        .delete(format!(
            "{}/api/queue/{}",
            service.url,
            dropped["id"].as_str().unwrap()
        ))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(remove.status(), 204);

    let (code, _) = service
        .send(
            &format!("/api/queue/{}/send-now", edited["id"].as_str().unwrap()),
            json!({}),
        )
        .await;
    assert_eq!(code, 202);
    let events = service
        .events_until(&thread, None, |event| {
            event["event"]["delta"] == "typo fixed"
        })
        .await;
    assert!(!events.is_empty());
    assert_eq!(queue(&service, &thread).await[0]["id"], waiting["id"]);
    assert_eq!(
        queue(&service, &thread).await[0]["held"],
        true,
        "the stop held the rest"
    );
}

#[tokio::test]
async fn steering_reaches_claude_and_is_refused_when_idle_or_unsupported() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "claude").await;
    let (code, _) = service
        .send(
            &format!("/api/threads/{thread}/steer"),
            json!({ "prompt": "x" }),
        )
        .await;
    assert_eq!(code, 400);
    service.admit(&thread, "[hang]").await;
    until_running(&service, &thread).await;
    let (code, _) = service
        .send(
            &format!("/api/threads/{thread}/steer"),
            json!({ "prompt": "go left" }),
        )
        .await;
    assert_eq!(code, 202);
    assert_eq!(service.finished(&thread).await, "completed");
    assert_eq!(
        text_of(&service.all_events(&thread).await),
        "steered: go left"
    );
}

#[tokio::test]
async fn oversize_prompts_are_refused_everywhere() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let long = "x".repeat(120_001);
    for path in [
        format!("/api/threads/{thread}/runs"),
        format!("/api/threads/{thread}/queue"),
    ] {
        let (code, body) = service.send(&path, json!({ "prompt": long })).await;
        assert_eq!(code, 400, "{path}");
        assert_eq!(body["code"], "invalid_input");
    }
    assert!(service.json(&format!("/api/threads/{thread}")).await["active_run"].is_null());
}

#[tokio::test]
async fn permission_modes_answer_in_the_gate_and_stop_at_the_write_scope() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let (code, body) = service
        .patch(&thread, json!({ "permission_mode": "auto" }))
        .await;
    assert_eq!(code, 200);
    assert_eq!(body["lifecycle"]["permission_mode"], "auto");
    service.admit(&thread, "[approve]").await;
    assert_eq!(service.finished(&thread).await, "completed");
    assert_eq!(
        text_of(&service.all_events(&thread).await),
        "decision accept"
    );
    assert!(
        service
            .audit(&thread)
            .await
            .iter()
            .any(|row| row["source"] == "permission_mode")
    );
    assert!(
        service
            .json("/api/approvals?state=pending")
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn plan_mode_reaches_both_engines() {
    let dir = TempDir::new();
    let file = dir.path().join("launches");
    let options = || Options {
        env: vec![(
            "ORBYN_FAKE_LAUNCH_FILE".into(),
            file.to_string_lossy().into_owned(),
        )],
        ..Options::default()
    };
    let (service, thread) = setup(&dir, options(), "claude").await;
    service.patch(&thread, json!({ "plan_mode": true })).await;
    service.admit(&thread, "plan it").await;
    service.finished(&thread).await;
    let project = service.json("/api/projects").await;
    let id = project
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["trusted"] == true)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let codex = service.thread(&id, "codex").await;
    service.patch(&codex, json!({ "plan_mode": true })).await;
    service.admit(&codex, "plan it").await;
    service.finished(&codex).await;
    let log = std::fs::read_to_string(&file).unwrap();
    assert!(log.contains(r#""--permission-mode","plan""#));
    assert!(
        log.contains(r#"\"sandboxPolicy\":{\"type\":\"readOnly\"}"#),
        "{log}"
    );
}

#[tokio::test]
async fn compact_and_goal_use_the_engines_own_commands() {
    let dir = TempDir::new();
    let file = dir.path().join("launches");
    let options = Options {
        env: vec![(
            "ORBYN_FAKE_LAUNCH_FILE".into(),
            file.to_string_lossy().into_owned(),
        )],
        ..Options::default()
    };
    let (service, thread) = setup(&dir, options, "codex").await;
    let commands = service
        .json(&format!("/api/threads/{thread}/commands"))
        .await;
    assert_eq!(commands[0]["name"], "compact");
    service.admit(&thread, "/compact").await;
    assert_eq!(service.finished(&thread).await, "completed");
    service.admit(&thread, "/goal tests pass").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let log = std::fs::read_to_string(&file).unwrap();
    assert!(log.contains("codex-compact"));
    assert!(log.contains(r#"\"objective\":\"tests pass\""#), "{log}");
}

#[tokio::test]
async fn claude_gets_slash_commands_bare() {
    let dir = TempDir::new();
    let file = dir.path().join("launches");
    let options = Options {
        env: vec![(
            "ORBYN_FAKE_LAUNCH_FILE".into(),
            file.to_string_lossy().into_owned(),
        )],
        ..Options::default()
    };
    let (service, thread) = setup(&dir, options, "claude").await;
    service.admit(&thread, "/compact").await;
    service.finished(&thread).await;
    let log = std::fs::read_to_string(&file).unwrap();
    assert!(log.contains(r#""args":["/compact"]"#), "{log}");
}

async fn upload(
    service: &Service,
    thread: &str,
    name: &str,
    mime: &str,
    bytes: Vec<u8>,
) -> (u16, Value) {
    let response = service
        .post(&format!("/api/threads/{thread}/attachments"))
        .query(&[("name", name)])
        .header("Content-Type", mime)
        .body(bytes)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

#[tokio::test]
async fn attachments_stay_out_of_the_target_reach_the_prompt_and_die_with_the_thread() {
    let dir = TempDir::new();
    let file = dir.path().join("launches");
    let options = Options {
        env: vec![(
            "ORBYN_FAKE_LAUNCH_FILE".into(),
            file.to_string_lossy().into_owned(),
        )],
        ..Options::default()
    };
    let (service, thread) = setup(&dir, options, "codex").await;
    let (code, attachment) = upload(
        &service,
        &thread,
        "../../evil.txt",
        "text/plain",
        b"hi".to_vec(),
    )
    .await;
    assert_eq!(code, 201, "{attachment}");
    assert_eq!(attachment["name"], "evil.txt");
    let (code, _) = upload(
        &service,
        &thread,
        "big.png",
        "image/png",
        vec![0; 10 * 1024 * 1024 + 1],
    )
    .await;
    assert_eq!(code, 400);

    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "read it", "attachment_ids": ["missing"] }),
        )
        .await;
    assert_eq!(code, 400, "{body}");
    assert!(service.json(&format!("/api/threads/{thread}")).await["active_run"].is_null());

    let id = attachment["id"].as_str().unwrap();
    let (code, _) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "read it", "attachment_ids": [id] }),
        )
        .await;
    assert_eq!(code, 202);
    service.finished(&thread).await;
    let log = std::fs::read_to_string(&file).unwrap();
    assert!(log.contains("Attached files"), "{log}");
    assert!(!dir.path().join("library/repo/project/evil.txt").exists());

    let stored = dir.path().join("data/attachments");
    assert_eq!(std::fs::read_dir(&stored).unwrap().count(), 1);
    let response = service
        .client
        .delete(format!("{}/api/threads/{thread}", service.url))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);
    assert_eq!(std::fs::read_dir(&stored).unwrap().count(), 0);
}

#[tokio::test]
async fn mentions_cover_profile_skills_and_unignored_files() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let checkout = dir.path().join("library/repo/project");
    std::fs::write(checkout.join("how-to.md"), "x").unwrap();
    std::fs::write(checkout.join(".gitignore"), "secret.md\n").unwrap();
    std::fs::write(checkout.join("secret.md"), "x").unwrap();
    let found = service
        .json(&format!("/api/threads/{thread}/mentions?q=ho"))
        .await;
    assert_eq!(found["skills"], json!(["how"]));
    assert_eq!(found["files"], json!(["how-to.md"]));
    let none = service
        .json(&format!("/api/threads/{thread}/mentions?q=secret"))
        .await;
    assert!(none["files"].as_array().unwrap().is_empty());
}
