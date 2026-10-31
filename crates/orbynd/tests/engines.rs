//! Named setups of an engine, and CLIs found on this machine, through the service.

mod support;

use serde_json::{Value, json};
use support::*;

async fn set_instances(service: &Service, list: Value) -> (u16, Value) {
    let response = service
        .client
        .put(format!("{}/api/preferences", service.url))
        .bearer_auth(&service.token)
        .json(&json!({ "values": { "provider_instances": list } }))
        .send()
        .await
        .unwrap();
    let code = response.status().as_u16();
    (code, response.json().await.unwrap())
}

async fn listed(service: &Service, id: &str) -> Option<Value> {
    let engines = service.json("/api/engines").await;
    engines.as_array()?.iter().find(|e| e["id"] == id).cloned()
}

fn launches(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test]
async fn an_instance_launches_its_own_program_under_its_own_name() {
    let dir = TempDir::new();
    let launch = dir.path().join("launches");
    let options = Options {
        env: vec![
            ("ORBYN_CLAUDE_BIN".into(), "/nowhere/claude".into()),
            (
                "ORBYN_FAKE_LAUNCH_FILE".into(),
                launch.to_string_lossy().into_owned(),
            ),
        ],
        ..Options::default()
    };
    let (service, _) = setup(&dir, options, "codex").await;
    let fake = env!("CARGO_BIN_EXE_orbyn-fake-engine");
    let (code, body) = set_instances(
        &service,
        json!([{ "id": "claude-beta", "driver": "claude", "name": "Beta", "accent": "#336699",
                 "program": fake }]),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    let engine = listed(&service, "claude-beta").await.unwrap();
    assert_eq!(engine["name"], "Beta");
    assert_eq!(engine["instance_of"], "claude");
    assert_eq!(engine["accent"], "#336699");
    assert_eq!(engine["installed"], true, "{engine}");
    assert_eq!(
        listed(&service, "claude").await.unwrap()["installed"],
        false
    );

    let project = service.json("/api/projects").await[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let thread = service.thread(&project, "claude-beta").await;
    service.admit(&thread, "hello").await;
    assert_eq!(service.finished(&thread).await, "completed");
    // Still Claude: the gate is on, however this one is named.
    let gated = launches(&launch).iter().any(|entry| {
        entry["args"]
            .to_string()
            .contains("mcp__orbyn_engineering__approve")
    });
    assert!(gated);

    // Turned off: gone from the list, no new thread and no new run.
    let (code, _) = set_instances(
        &service,
        json!([{ "id": "claude-beta", "driver": "claude", "enabled": false, "program": fake }]),
    )
    .await;
    assert_eq!(code, 200);
    assert!(listed(&service, "claude-beta").await.is_none());
    let (code, _) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "again" }),
        )
        .await;
    assert_eq!(code, 400);
    let (code, _) = service
        .send(
            "/api/threads",
            json!({ "project_id": project, "engine": "claude-beta" }),
        )
        .await;
    assert_eq!(code, 400);
}

#[tokio::test]
async fn an_acp_instance_adds_to_its_driver_launch() {
    let dir = TempDir::new();
    let launch = dir.path().join("launches");
    let options = Options {
        env: vec![(
            "ORBYN_FAKE_LAUNCH_FILE".into(),
            launch.to_string_lossy().into_owned(),
        )],
        ..Options::default()
    };
    let (service, _) = setup(&dir, options, "codex").await;
    let fake = env!("CARGO_BIN_EXE_orbyn-fake-engine");
    let (code, body) = service
        .send(
            "/api/engines/custom",
            json!({ "id": "agent", "name": "Agent", "tier": "acp", "target": fake,
                    "args": ["acp"] }),
        )
        .await;
    assert_eq!(code, 201, "{body}");
    let (code, _) = set_instances(
        &service,
        json!([{ "id": "agent-two", "driver": "agent", "args": ["--profile", "two"] }]),
    )
    .await;
    assert_eq!(code, 200);
    let project = service.json("/api/projects").await[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let thread = service.thread(&project, "agent-two").await;
    service.admit(&thread, "hello").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let seen = launches(&launch);
    let run = seen.iter().rfind(|entry| entry["mode"] == "acp").unwrap();
    assert_eq!(run["args"], json!(["acp", "--profile", "two"]));
}

#[tokio::test]
async fn a_list_that_could_not_launch_is_refused_whole() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    for list in [
        json!([{ "id": "claude", "driver": "claude" }]),
        json!([{ "id": "a", "driver": "nothing" }]),
        json!([{ "id": "a", "driver": "claude", "args": ["--dangerously-skip-permissions"] }]),
        json!([{ "id": "a", "driver": "claude" }, { "id": "b", "driver": "a" }]),
        json!("not a list"),
    ] {
        let (code, body) = set_instances(&service, list.clone()).await;
        assert_eq!(code, 400, "{list}: {body}");
    }
    let stored = service.json("/api/preferences").await;
    let row = stored
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["key"] == "provider_instances");
    assert_eq!(row.unwrap()["value"], json!([]));
}

#[tokio::test]
async fn a_tool_cannot_reach_the_instance_list() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let project = service.json(&format!("/api/threads/{thread}")).await["project_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let response = service
        .client
        .put(format!(
            "{}/api/projects/{project}/preferences",
            service.url
        ))
        .bearer_auth(&service.token)
        .json(&json!({ "values": { "provider_instances": [] } }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        400,
        "it is global, so no project sets it"
    );
}

#[tokio::test]
async fn a_cli_on_this_machine_is_an_engine_with_its_own_launch() {
    let dir = TempDir::new();
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let fake = std::path::Path::new(env!("CARGO_BIN_EXE_orbyn-fake-engine"));
    let name = format!("kimi{}", std::env::consts::EXE_SUFFIX);
    std::fs::copy(fake, bin.join(name)).unwrap();
    let path = std::env::join_paths(
        std::iter::once(bin).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    let launch = dir.path().join("launches");
    let options = Options {
        env: vec![
            ("PATH".into(), path.to_string_lossy().into_owned()),
            (
                "ORBYN_FAKE_LAUNCH_FILE".into(),
                launch.to_string_lossy().into_owned(),
            ),
        ],
        ..Options::default()
    };
    let (service, _) = setup(&dir, options, "codex").await;
    service.post("/api/engines/refresh").send().await.unwrap();
    let engine = listed(&service, "kimi").await.expect("found on PATH");
    assert_eq!(engine["tier"], "acp");
    assert_eq!(engine["installed"], true);
    let project = service.json("/api/projects").await[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let thread = service.thread(&project, "kimi").await;
    service.admit(&thread, "hello").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let seen = launches(&launch);
    let run = seen.iter().rfind(|entry| entry["mode"] == "acp").unwrap();
    assert_eq!(run["args"], json!(["acp"]));
}
