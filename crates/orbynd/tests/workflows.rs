//! Claude Code workflows through the real service and the fake CLI: the run stays
//! open while a launched workflow runs, its script can be read, and it can be
//! stopped while the run works.

mod support;

use std::time::Duration;

use serde_json::Value;
use support::{Options, Service, TempDir, setup, text_of};

const SCRIPT: &str =
    "export const meta = { name: 'probe', description: 'probe' }\nawait agent('look')\n";

async fn workflow_state(service: &Service, thread: &str) -> Option<String> {
    let response = service
        .get(&format!("/api/threads/{thread}/items/toolu_wf:workflow"))
        .send()
        .await
        .unwrap();
    if !response.status().is_success() {
        return None;
    }
    let item: Value = response.json().await.unwrap();
    item["raw"]["state"].as_str().map(str::to_owned)
}

async fn until_workflow(service: &Service, thread: &str, wanted: &str) {
    for _ in 0..1000 {
        if workflow_state(service, thread).await.as_deref() == Some(wanted) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the workflow never reached {wanted}");
}

fn workflow_states(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|event| event["event"]["name"] == "workflow.state")
        .filter_map(|event| event["event"]["value"]["state"].as_str().map(str::to_owned))
        .collect()
}

#[tokio::test]
async fn a_running_workflow_shows_its_script_and_stops() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "claude").await;
    service.admit(&thread, "go [workflow]").await;
    until_workflow(&service, &thread, "running").await;

    // The turn's result has arrived, but the workflow it launched still runs.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    assert!(
        !body["active_run"].is_null(),
        "the run closed under its workflow"
    );

    let script = service
        .json(&format!("/api/threads/{thread}/workflows/toolu_wf/script"))
        .await;
    assert_eq!(script["contents"], SCRIPT);
    assert_eq!(script["truncated"], false);

    let (status, body) = service
        .send(
            &format!("/api/threads/{thread}/workflows/toolu_wf/stop"),
            serde_json::json!({}),
        )
        .await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["requested"], true);
    until_workflow(&service, &thread, "stopped").await;
    assert_eq!(service.finished(&thread).await, "completed");

    let events = service.all_events(&thread).await;
    assert_eq!(workflow_states(&events), ["running", "stopped"]);
    assert_eq!(text_of(&events), "launched");
    let audit = service.audit(&thread).await;
    assert!(
        audit
            .iter()
            .any(|row| row["action"] == "workflow.stop" && row["target"] == "toolu_wf"),
        "{audit:?}"
    );

    // Once it has ended there is nothing to stop.
    let (status, _) = service
        .send(
            &format!("/api/threads/{thread}/workflows/toolu_wf/stop"),
            serde_json::json!({}),
        )
        .await;
    assert_eq!(status, 400);
    // The script stays readable after the run.
    let script = service
        .json(&format!("/api/threads/{thread}/workflows/toolu_wf/script"))
        .await;
    assert_eq!(script["contents"], SCRIPT);
}

#[tokio::test]
async fn a_finished_workflow_ends_the_run_after_its_follow_up_turn() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "claude").await;
    service.admit(&thread, "go [workflow-finish]").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let events = service.all_events(&thread).await;
    assert_eq!(workflow_states(&events), ["running", "completed"]);
    assert_eq!(text_of(&events), "launched workflow finished");
    assert_eq!(
        workflow_state(&service, &thread).await.as_deref(),
        Some("completed")
    );
}

#[tokio::test]
async fn only_a_workflow_call_has_a_script_or_a_stop() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "claude").await;
    service.admit(&thread, "say hi").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let response = service
        .get(&format!("/api/threads/{thread}/workflows/missing/script"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    let (status, _) = service
        .send(
            &format!("/api/threads/{thread}/workflows/missing/stop"),
            serde_json::json!({}),
        )
        .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn cancelling_a_held_run_reports_its_workflow_stopped() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "claude").await;
    let run = service.admit(&thread, "go [workflow]").await;
    until_workflow(&service, &thread, "running").await;
    let (status, body) = service
        .send(&format!("/api/runs/{run}/cancel"), serde_json::json!({}))
        .await;
    assert!(status < 300, "{status} {body}");
    assert_eq!(service.finished(&thread).await, "cancelled");
    assert_eq!(
        workflow_state(&service, &thread).await.as_deref(),
        Some("stopped")
    );
    let events = service.all_events(&thread).await;
    assert_eq!(workflow_states(&events), ["running", "stopped"]);
}
