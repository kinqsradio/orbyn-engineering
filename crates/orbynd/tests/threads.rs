//! Thread lifecycle through the real service.

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use support::{Options, Service, TempDir, setup};

/// A snooze time safely in the future.
const LATER: &str = "2999-01-01T00:00:00Z";

async fn list(service: &Service, project: &str, archived: bool) -> Vec<String> {
    service
        .json(&format!(
            "/api/threads?project_id={project}&archived={archived}"
        ))
        .await
        .as_array()
        .unwrap()
        .iter()
        .map(|thread| thread["id"].as_str().unwrap().to_owned())
        .collect()
}

async fn listed(service: &Service, project: &str, archived: bool) -> Vec<String> {
    list(service, project, archived).await
}

async fn project_of(service: &Service) -> String {
    service.json("/api/projects").await[0]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn new_threads_open_on_top_and_order_survives_activity() {
    let dir = TempDir::new();
    let (service, first) = setup(&dir, Options::default(), "codex").await;
    let project = project_of(&service).await;
    let second = service.thread(&project, "codex").await;
    let third = service.thread(&project, "codex").await;
    assert_eq!(
        listed(&service, &project, false).await,
        [third.as_str(), second.as_str(), first.as_str()]
    );
    service.admit(&first, "hi").await;
    service.finished(&first).await;
    assert_eq!(
        listed(&service, &project, false).await,
        [third.as_str(), second.as_str(), first.as_str()]
    );

    let (status, _) = service
        .send(
            "/api/threads/order",
            json!({ "ids": [first, third, second] }),
        )
        .await;
    assert_eq!(status, 204);
    assert_eq!(
        listed(&service, &project, false).await,
        [first.as_str(), third.as_str(), second.as_str()]
    );

    // A stale id rejects the whole list.
    let (status, _) = service
        .send(
            "/api/threads/order",
            json!({ "ids": [second, "missing", third] }),
        )
        .await;
    assert_eq!(status, 404);
    assert_eq!(
        listed(&service, &project, false).await,
        [first.as_str(), third.as_str(), second.as_str()]
    );

    let (status, pinned) = service.patch(&second, json!({ "pinned": true })).await;
    assert_eq!(status, 200);
    assert!(pinned["lifecycle"]["pinned_at"].is_string());
    assert_eq!(
        listed(&service, &project, false).await,
        [second.as_str(), first.as_str(), third.as_str()]
    );
}

#[tokio::test]
async fn archive_hides_blocks_runs_and_restores() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let project = project_of(&service).await;
    assert_eq!(
        service.patch(&thread, json!({ "archived": true })).await.0,
        200
    );
    assert!(list(&service, &project, false).await.is_empty());
    assert_eq!(listed(&service, &project, true).await, [thread.as_str()]);
    let (status, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "x" }),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(body["code"], "thread_archived");
    assert_eq!(
        service.patch(&thread, json!({ "archived": false })).await.0,
        200
    );
    service.admit(&thread, "works").await;
    service.finished(&thread).await;
}

#[tokio::test]
async fn busy_threads_refuse_settle_and_archive_and_the_patch_is_all_or_nothing() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let run = service.admit(&thread, "[hang]").await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let (status, body) = service
        .patch(
            &thread,
            json!({ "pinned": true, "title": "T", "settled": true }),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(body["code"], "thread_busy");
    let current = service.json(&format!("/api/threads/{thread}")).await;
    assert!(current["lifecycle"]["pinned_at"].is_null());
    assert_ne!(current["title"], "T");
    assert_eq!(
        service.patch(&thread, json!({ "archived": true })).await.0,
        409
    );
    service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    service.finished(&thread).await;
}

#[tokio::test]
async fn settle_unpins_and_a_new_message_restores_the_thread() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.patch(&thread, json!({ "pinned": true })).await;
    let (_, settled) = service.patch(&thread, json!({ "settled": true })).await;
    assert!(settled["lifecycle"]["settled_at"].is_string());
    assert!(settled["lifecycle"]["pinned_at"].is_null());
    service.admit(&thread, "back to work").await;
    let current = service.json(&format!("/api/threads/{thread}")).await;
    assert!(current["lifecycle"]["settled_at"].is_null());
    service.finished(&thread).await;
}

#[tokio::test]
async fn snooze_needs_a_future_time_and_wake_rules_end_it() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    for bad in ["2001-01-01T00:00:00Z", "tomorrow"] {
        let (status, _) = service
            .patch(&thread, json!({ "snoozed_until": bad }))
            .await;
        assert_eq!(status, 400, "{bad}");
    }
    let snoozed_until = |value: &Value| value["lifecycle"]["snoozed_until"].clone();
    let (_, body) = service
        .patch(&thread, json!({ "snoozed_until": LATER }))
        .await;
    assert!(snoozed_until(&body).is_string());
    let (_, body) = service.patch(&thread, json!({ "wake": true })).await;
    assert!(snoozed_until(&body).is_null());

    // A question for you ends the snooze while the run is still going.
    let run = service.admit(&thread, "[approve]").await;
    assert!(!run.is_empty());
    service
        .patch(&thread, json!({ "snoozed_until": LATER }))
        .await;
    let approval = service.pending().await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    assert!(snoozed_until(&body).is_null(), "{body}");

    // So does the answer.
    service
        .patch(&thread, json!({ "snoozed_until": LATER }))
        .await;
    service.decide(approval["id"].as_str().unwrap(), true).await;
    service.finished(&thread).await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    assert!(snoozed_until(&body).is_null(), "{body}");
}

#[tokio::test]
async fn delete_takes_descendants_but_refuses_a_busy_family() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    assert_eq!(
        service.patch(&thread, json!({ "unread": true })).await.1["lifecycle"]["unread"],
        true
    );
    let client = reqwest::Client::new();
    let response = client
        .delete(format!("{}/api/threads/{thread}", service.url))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);
    let audit = service.json("/api/audit?limit=5").await;
    assert_eq!(audit[0]["action"], "thread.delete");
}

#[tokio::test]
async fn rename_validates_and_audits() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    assert_eq!(
        service.patch(&thread, json!({ "title": "   " })).await.0,
        400
    );
    let (status, body) = service
        .patch(&thread, json!({ "title": "  Named  " }))
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["title"], "Named");
    assert!(
        service
            .audit(&thread)
            .await
            .iter()
            .any(|row| row["action"] == "thread.rename")
    );
}

fn title_options(dir: &TempDir) -> (std::path::PathBuf, Options) {
    let record = dir.path().join("one-shot");
    let options = Options {
        env: vec![(
            "ORBYN_FAKE_ONE_SHOT_FILE".into(),
            record.to_string_lossy().into_owned(),
        )],
        ..Options::default()
    };
    (record, options)
}

#[tokio::test]
async fn title_call_spends_usage_only_when_requested() {
    let dir = TempDir::new();
    let (record, options) = title_options(&dir);
    let (service, thread) = setup(&dir, options, "codex").await;
    let (status, _) = service
        .send(&format!("/api/threads/{thread}/title"), json!({}))
        .await;
    assert_eq!(status, 400, "an empty thread has nothing to title");
    service.admit(&thread, "please fix the login bug").await;
    service.finished(&thread).await;
    service
        .patch(&thread, json!({ "pinned": true, "unread": true }))
        .await;
    service.json("/api/threads").await;
    assert!(
        !record.exists(),
        "nothing but a request may call the engine"
    );

    let (status, body) = service
        .send(&format!("/api/threads/{thread}/title"), json!({}))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["title"], "A fresh title");
    let prompt = std::fs::read_to_string(&record).unwrap();
    assert!(prompt.contains("please fix the login bug"));
    let actions = service.audit(&thread).await;
    assert!(actions.iter().any(|row| row["action"] == "engine.one_shot"));
}

#[tokio::test]
async fn rename_during_title_generation_wins() {
    let dir = TempDir::new();
    let (_record, options) = title_options(&dir);
    let (service, thread) = setup(&dir, options, "claude").await;
    service.admit(&thread, "[slow-title]").await;
    service.finished(&thread).await;
    let path = format!("/api/threads/{thread}/title");
    let (generated, renamed) = tokio::join!(service.send(&path, json!({})), async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        service.patch(&thread, json!({ "title": "Mine" })).await
    });
    assert_eq!(renamed.0, 200);
    assert_eq!(generated.1["title"], "Mine");
}

#[tokio::test]
async fn failed_title_call_keeps_the_title_and_says_why() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "claude").await;
    service.patch(&thread, json!({ "title": "Kept" })).await;
    service.admit(&thread, "[bad-title]").await;
    service.finished(&thread).await;
    let (status, body) = service
        .send(&format!("/api/threads/{thread}/title"), json!({}))
        .await;
    assert_eq!(status, 502);
    assert!(body["message"].as_str().unwrap().contains("title failure"));
    assert_eq!(
        service.json(&format!("/api/threads/{thread}")).await["title"],
        "Kept"
    );
}

#[tokio::test]
async fn settings_round_trip_and_validate() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    let mut settings = service.json("/api/settings").await;
    assert_eq!(settings["auto_settle"]["after_days"], 3);
    settings["title_instructions"] = json!("Use sentence case");
    let response = service
        .client
        .put(format!("{}/api/settings", service.url))
        .bearer_auth(&service.token)
        .json(&settings)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        service.json("/api/settings").await["title_instructions"],
        "Use sentence case"
    );
    settings["snooze_presets"] = json!(vec![json!({ "label": "x", "minutes": 5 }); 9]);
    let response = service
        .client
        .put(format!("{}/api/settings", service.url))
        .bearer_auth(&service.token)
        .json(&settings)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
}
