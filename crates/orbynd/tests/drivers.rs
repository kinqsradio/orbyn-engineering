//! Each driver against the fake engine, over real subprocess pipes and through
//! the real service, so parsing, approvals and cleanup are all exercised.

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use support::{FAKE, Options, Service, TempDir, setup, text_of, types_of};

fn pid_env(dir: &TempDir) -> (std::path::PathBuf, Options) {
    let file = dir.path().join("pids");
    let options = Options {
        env: vec![(
            "ORBYN_FAKE_PID_FILE".into(),
            file.to_string_lossy().into_owned(),
        )],
        ..Options::default()
    };
    (file, options)
}

/// A freshly built binary can take a moment to exec, so wait for the engine
/// itself rather than for a fixed delay.
async fn engine_started(pid_file: &std::path::Path) {
    for _ in 0..1000 {
        if std::fs::read_to_string(pid_file).is_ok_and(|text| !text.is_empty()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the engine never started");
}

#[cfg(unix)]
fn alive(pid: i32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success()
}

#[cfg(unix)]
async fn assert_all_dead(pid_file: &std::path::Path) {
    let text = std::fs::read_to_string(pid_file).unwrap_or_default();
    let pids: Vec<i32> = text.lines().filter_map(|line| line.parse().ok()).collect();
    for _ in 0..300 {
        if pids.iter().all(|pid| !alive(*pid)) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("engine processes survived: {pids:?}");
}

#[tokio::test]
async fn codex_turn_maps_to_events_and_ignores_subagents() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "say hi").await;
    let events = service.all_events(&thread).await;
    assert_eq!(service.finished(&thread).await, "completed");
    assert_eq!(text_of(&events), "hello from codex");
    let types = types_of(&events);
    assert_eq!(types[0], "RUN_STARTED");
    for wanted in [
        "REASONING_MESSAGE_START",
        "REASONING_MESSAGE_CONTENT",
        "REASONING_MESSAGE_END",
        "ACTIVITY_SNAPSHOT",
        "TEXT_MESSAGE_END",
    ] {
        assert!(types.iter().any(|t| t == wanted), "{wanted} in {types:?}");
    }
    assert_eq!(types.last().unwrap(), "RUN_FINISHED");
}

#[tokio::test]
async fn codex_approval_round_trips_and_second_run_resumes() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[approve]").await;
    let approval = service.pending().await;
    assert_eq!(approval["kind"], "command");
    assert_eq!(service.run_state(&thread).await, "awaiting_approval");
    let id = approval["id"].as_str().unwrap();
    let (status, decided) = service.decide(id, true).await;
    assert_eq!(status, 200, "{decided}");
    assert_eq!(service.finished(&thread).await, "completed");
    let events = service.all_events(&thread).await;
    assert_eq!(text_of(&events), "decision accept");
    let types = types_of(&events);
    assert!(types.iter().any(|t| t == "TOOL_CALL_START"));
    assert!(types.iter().any(|t| t == "TOOL_CALL_RESULT"));
    let diff = events
        .iter()
        .find(|event| event["event"]["activityType"] == "diff")
        .unwrap();
    assert_eq!(diff["event"]["content"]["files"][0]["path"], "x");
}

#[tokio::test]
async fn codex_denial_reaches_the_engine() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[approve]").await;
    let approval = service.pending().await;
    service
        .decide(approval["id"].as_str().unwrap(), false)
        .await;
    assert_eq!(service.finished(&thread).await, "completed");
    assert_eq!(
        text_of(&service.all_events(&thread).await),
        "decision decline"
    );
}

#[tokio::test]
async fn codex_unknown_server_request_is_refused() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[unknown-request]").await;
    service.finished(&thread).await;
    assert_eq!(
        text_of(&service.all_events(&thread).await),
        "refused -32601"
    );
}

#[tokio::test]
async fn codex_token_refresh_request_is_refused_over_the_wire() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[token-refresh]").await;
    assert_eq!(service.finished(&thread).await, "completed");
    assert_eq!(
        text_of(&service.all_events(&thread).await),
        "token refresh error -32601 result null"
    );
}

#[tokio::test]
async fn codex_cancel_interrupts_and_cleans_up() {
    let dir = TempDir::new();
    let (pids, options) = pid_env(&dir);
    let (service, thread) = setup(&dir, options, "codex").await;
    let run = service.admit(&thread, "[hang]").await;
    engine_started(&pids).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (status, _) = service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    assert_eq!(status, 202);
    assert_eq!(service.finished(&thread).await, "cancelled");
    #[cfg(unix)]
    assert_all_dead(&pids).await;
    drop(pids);
}

#[tokio::test]
async fn codex_exit_during_approval_fails_and_expires() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[crash-in-approval]").await;
    let approval = service.pending().await;
    assert_eq!(service.finished(&thread).await, "failed");
    let (status, body) = service.decide(approval["id"].as_str().unwrap(), true).await;
    assert_eq!(status, 409);
    assert_eq!(body["code"], "already_decided");
    assert_eq!(body["detail"]["state"], "expired");
}

#[tokio::test]
async fn codex_failed_turn_reports_its_error_and_late_frames_are_dropped() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[fail][late]").await;
    assert_eq!(service.finished(&thread).await, "failed");
    let events = service.all_events(&thread).await;
    let last = events.last().unwrap();
    assert_eq!(last["event"]["type"], "RUN_ERROR");
    assert_eq!(last["event"]["message"], "fake failure");
    assert!(!text_of(&events).contains("too late"));
}

#[tokio::test]
async fn codex_gets_the_mcp_server_without_approve() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[mcp-tools]").await;
    service.finished(&thread).await;
    assert_eq!(
        text_of(&service.all_events(&thread).await),
        "mcp 200 tools 7"
    );
}

#[tokio::test]
async fn claude_stream_maps_to_events() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "claude").await;
    service.admit(&thread, "say hi").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let events = service.all_events(&thread).await;
    assert_eq!(text_of(&events), "hello from claude");
    assert!(
        types_of(&events)
            .iter()
            .any(|t| t == "REASONING_MESSAGE_CONTENT")
    );
}

#[tokio::test]
async fn claude_permission_goes_through_mcp_approve() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "claude").await;
    service.admit(&thread, "[approve]").await;
    let approval = service.pending().await;
    assert_eq!(approval["kind"], "command");
    assert_eq!(approval["summary"], "Run ls");
    service.decide(approval["id"].as_str().unwrap(), true).await;
    assert_eq!(service.finished(&thread).await, "completed");
    let events = service.all_events(&thread).await;
    assert_eq!(text_of(&events), "permission allow");
    let result = events
        .iter()
        .find(|event| event["event"]["type"] == "TOOL_CALL_RESULT")
        .unwrap();
    assert_eq!(result["event"]["content"], "tool allow");
}

#[tokio::test]
async fn claude_denial_reaches_the_engine() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "claude").await;
    service.admit(&thread, "[approve]").await;
    let approval = service.pending().await;
    service
        .decide(approval["id"].as_str().unwrap(), false)
        .await;
    service.finished(&thread).await;
    assert_eq!(
        text_of(&service.all_events(&thread).await),
        "permission deny"
    );
}

#[tokio::test]
async fn claude_exit_during_approval_fails_and_expires() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "claude").await;
    service.admit(&thread, "[crash-in-approval]").await;
    let approval = service.pending().await;
    assert_eq!(service.finished(&thread).await, "failed");
    let (status, body) = service.decide(approval["id"].as_str().unwrap(), true).await;
    assert_eq!(status, 409);
    assert_eq!(body["detail"]["state"], "expired");
}

#[tokio::test]
async fn claude_error_result_fails_the_run() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "claude").await;
    service.admit(&thread, "[fail]").await;
    assert_eq!(service.finished(&thread).await, "failed");
    let events = service.all_events(&thread).await;
    assert_eq!(events.last().unwrap()["event"]["message"], "fake failure");
}

#[tokio::test]
async fn claude_cancel_closes_the_process() {
    let dir = TempDir::new();
    let (pids, options) = pid_env(&dir);
    let (service, thread) = setup(&dir, options, "claude").await;
    let run = service.admit(&thread, "[hang]").await;
    engine_started(&pids).await;
    service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    assert_eq!(service.finished(&thread).await, "cancelled");
    #[cfg(unix)]
    assert_all_dead(&pids).await;
    drop(pids);
}

async fn custom_engine(service: &Service, tier: &str, target: &str, args: Value) {
    let (status, body) = service
        .send(
            "/api/engines/custom",
            json!({ "id": "custom", "name": "Custom", "tier": tier, "target": target, "args": args }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
}

#[tokio::test]
async fn acp_agent_runs_and_is_gated() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    custom_engine(&service, "acp", FAKE, json!(["acp"])).await;
    let projects = service.json("/api/projects").await;
    let thread = service
        .thread(projects[0]["id"].as_str().unwrap(), "custom")
        .await;
    service.admit(&thread, "[approve]").await;
    let approval = service.pending().await;
    assert_eq!(approval["kind"], "command");
    service.decide(approval["id"].as_str().unwrap(), true).await;
    assert_eq!(service.finished(&thread).await, "completed");
    let events = service.all_events(&thread).await;
    assert_eq!(text_of(&events), "option once");
    assert!(types_of(&events).iter().any(|t| t == "TOOL_CALL_RESULT"));
}

#[tokio::test]
async fn acp_cancel_reaches_the_agent() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    custom_engine(&service, "acp", FAKE, json!(["acp"])).await;
    let projects = service.json("/api/projects").await;
    let thread = service
        .thread(projects[0]["id"].as_str().unwrap(), "custom")
        .await;
    let run = service.admit(&thread, "[hang]").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    assert_eq!(service.finished(&thread).await, "cancelled");
}

/// The fake AG-UI agent, stopped with its test.
struct Agent(std::process::Child);

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn_agui(dir: &TempDir) -> (Agent, String) {
    let port_file = dir.path().join("agui-port");
    let agent = Agent(
        std::process::Command::new(FAKE)
            .args(["agui", port_file.to_str().unwrap()])
            .spawn()
            .unwrap(),
    );
    for _ in 0..500 {
        if let Ok(port) = std::fs::read_to_string(&port_file)
            && !port.is_empty()
        {
            return (agent, format!("http://127.0.0.1:{port}/"));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("agui fake did not start");
}

#[tokio::test]
async fn agui_agent_streams_and_keeps_unknown_events_visible() {
    let dir = TempDir::new();
    let (_agent, url) = spawn_agui(&dir);
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    custom_engine(&service, "agui", &url, json!([])).await;
    let projects = service.json("/api/projects").await;
    let thread = service
        .thread(projects[0]["id"].as_str().unwrap(), "custom")
        .await;
    service.admit(&thread, "say hi").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let events = service.all_events(&thread).await;
    assert_eq!(text_of(&events), "hello from agui");
    assert!(types_of(&events).iter().any(|t| t == "RAW"));
}

#[tokio::test]
async fn agui_interrupt_becomes_an_approval_and_resumes() {
    let dir = TempDir::new();
    let (_agent, url) = spawn_agui(&dir);
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    custom_engine(&service, "agui", &url, json!([])).await;
    let projects = service.json("/api/projects").await;
    let thread = service
        .thread(projects[0]["id"].as_str().unwrap(), "custom")
        .await;
    service.admit(&thread, "[approve]").await;
    let approval = service.pending().await;
    assert_eq!(approval["summary"], "Deploy now?");
    service
        .decide(approval["id"].as_str().unwrap(), false)
        .await;
    assert_eq!(service.finished(&thread).await, "completed");
    let events = service.all_events(&thread).await;
    assert_eq!(text_of(&events), "resumed approved=false");
}

#[tokio::test]
async fn agui_run_error_fails_the_run() {
    let dir = TempDir::new();
    let (_agent, url) = spawn_agui(&dir);
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    custom_engine(&service, "agui", &url, json!([])).await;
    let projects = service.json("/api/projects").await;
    let thread = service
        .thread(projects[0]["id"].as_str().unwrap(), "custom")
        .await;
    service.admit(&thread, "[fail]").await;
    assert_eq!(service.finished(&thread).await, "failed");
}

#[tokio::test]
async fn terminal_tier_is_labelled_unmanaged_and_runs_in_a_pty() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    custom_engine(&service, "terminal", FAKE, json!(["pty"])).await;
    let engines = service.json("/api/engines").await;
    let custom = engines
        .as_array()
        .unwrap()
        .iter()
        .find(|engine| engine["id"] == "custom")
        .unwrap();
    assert_eq!(custom["capabilities"]["managed"], false);
    assert_eq!(custom["capabilities"]["approvals"], false);
    let projects = service.json("/api/projects").await;
    let thread = service
        .thread(projects[0]["id"].as_str().unwrap(), "custom")
        .await;
    service.admit(&thread, "exit").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let events = service.all_events(&thread).await;
    let notice = events
        .iter()
        .find(|event| event["event"]["activityType"] == "unmanaged");
    assert!(notice.is_some());
}

#[tokio::test]
async fn probes_read_version_and_login_without_a_session() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    let engines = service.json("/api/engines").await;
    let codex = engines
        .as_array()
        .unwrap()
        .iter()
        .find(|engine| engine["id"] == "codex")
        .unwrap();
    assert_eq!(codex["installed"], true);
    assert_eq!(codex["version"], "0.166.0");
    assert_eq!(codex["support"], "tested");
    assert_eq!(codex["auth"], "logged_in");
    assert_eq!(codex["installer"], "unknown");
    assert!(codex["update_command"].is_null());
}
