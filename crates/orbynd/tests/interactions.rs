//! Model lists, questions, goals and session recovery through the real service
//! and the fake engine.

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use support::{FAKE, Options, Service, TempDir, setup, text_of};

fn engines(claude: bool, launches: &std::path::Path) -> Options {
    let mut env = vec![(
        "ORBYN_FAKE_LAUNCH_FILE".to_owned(),
        launches.to_string_lossy().into_owned(),
    )];
    if claude {
        env.push(("ORBYN_CLAUDE_BIN".to_owned(), FAKE.to_owned()));
    } else {
        env.push(("ORBYN_CODEX_BIN".to_owned(), FAKE.to_owned()));
    }
    Options {
        env,
        ..Options::default()
    }
}

async fn open_question(service: &Service, thread: &str) -> Value {
    for _ in 0..2000 {
        let list = service
            .json(&format!("/api/questions?thread_id={thread}&state=pending"))
            .await;
        if let Some(first) = list.as_array().and_then(|list| list.first()) {
            return first.clone();
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("no question opened");
}

fn launches(path: &std::path::Path, mode: &str) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|entry| entry["mode"] == mode)
        .map(|entry| entry["args"][0].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[tokio::test]
async fn codex_lists_its_visible_models_with_their_efforts() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, engines(false, &dir.path().join("l")), "codex").await;
    let models = service.json("/api/engines/codex/models").await;
    assert_eq!(models["source"], "engine");
    let list = models["models"].as_array().unwrap();
    assert_eq!(list.len(), 2, "{models}");
    assert!(!models.to_string().contains("fake-old"), "hidden: {models}");
    assert_eq!(list[0]["id"], "fake-big");
    assert_eq!(list[0]["is_default"], true);
    let values = &list[0]["options"][0]["values"];
    assert_eq!(values[0]["id"], "medium");
    assert_eq!(values[0]["default"], true);
    assert_eq!(values[1]["label"], "Extra high");
    service.stop().await;
}

#[tokio::test]
async fn claude_lists_what_initialize_says_and_never_passes_on_the_account() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let (service, thread) = setup(&dir, engines(true, &launch_file), "claude").await;
    let models = service.json("/api/engines/claude/models").await;
    assert_eq!(models["source"], "engine");
    assert!(models.get("fallback").is_none(), "{models}");
    assert!(
        !models.to_string().contains("person@example.com"),
        "{models}"
    );
    assert_eq!(models["models"][2]["id"], "haiku");
    assert!(
        models["models"][2]["options"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let fable = &models["models"][1]["options"];
    assert_eq!(fable[0]["values"].as_array().unwrap().len(), 1);
    assert_eq!(fable[1]["id"], "fast_mode");
    assert_eq!(models["output_styles"][1], "Learning");
    assert_eq!(models["agents"][0]["name"], "Explore");

    service.json("/api/engines/claude/models").await;
    assert_eq!(launches(&launch_file, "claude-probe").len(), 1, "cached");
    service
        .json("/api/engines/claude/models?refresh=true")
        .await;
    assert_eq!(launches(&launch_file, "claude-probe").len(), 2, "refreshed");

    let args = std::fs::read_to_string(&launch_file).unwrap();
    assert!(args.contains("--strict-mcp-config"), "{args}");

    let commands = service
        .json(&format!("/api/threads/{thread}/commands"))
        .await;
    let found = |name: &str| {
        commands
            .as_array()
            .unwrap()
            .iter()
            .find(|command| command["name"] == name)
            .cloned()
            .unwrap_or_default()
    };
    assert_eq!(found("review")["description"], "Review a change");
    assert_eq!(found("Explore")["source"], "agent");
    service.stop().await;
}

#[tokio::test]
async fn a_claude_that_will_not_say_falls_back_to_a_marked_list() {
    let dir = TempDir::new();
    let mut options = engines(true, &dir.path().join("l"));
    options
        .env
        .push(("ORBYN_FAKE_NO_INITIALIZE".to_owned(), "1".to_owned()));
    let (service, thread) = setup(&dir, options, "claude").await;
    let models = service.json("/api/engines/claude/models").await;
    assert_eq!(models["source"], "documented");
    assert_eq!(models["fallback"], true);
    assert!(models["error"].is_string(), "{models}");
    assert!(
        models["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["id"] == "opus")
    );
    // A stand-in list has no standing to refuse anything.
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/queue"),
            json!({ "prompt": "hi", "effort": "max" }),
        )
        .await;
    assert_eq!(code, 201, "{body}");
    service.stop().await;
}

#[tokio::test]
async fn fast_mode_reaches_claude_as_a_setting_only_on_a_model_that_has_it() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let (service, thread) = setup(&dir, engines(true, &launch_file), "claude").await;
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "hi", "model": "haiku", "options": { "fast_mode": "on" } }),
        )
        .await;
    assert_eq!(code, 422, "{body}");
    assert_eq!(body["code"], "unsupported_option");
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "hi", "model": "fable", "options": { "fast_mode": "on" } }),
        )
        .await;
    assert_eq!(code, 202, "{body}");
    assert_eq!(service.finished(&thread).await, "completed");
    let launched = std::fs::read_to_string(&launch_file).unwrap();
    let run = launched
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|entry| entry["mode"] == "claude")
        .unwrap();
    assert!(run["args"].to_string().contains("settings.json"), "{run}");
    service.stop().await;
}

#[tokio::test]
async fn codex_refuses_what_a_model_does_not_offer_and_keeps_nothing() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let (service, thread) = setup(&dir, engines(false, &launch_file), "codex").await;
    for (path, status) in [("runs", 422), ("queue", 422)] {
        let (code, body) = service
            .send(
                &format!("/api/threads/{thread}/{path}"),
                json!({ "prompt": "hi", "model": "fake-small", "effort": "xhigh" }),
            )
            .await;
        assert_eq!(code, status, "{body}");
        assert_eq!(body["code"], "unsupported_option");
    }
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "hi", "model": "fake-small", "options": { "service_tier": "priority" } }),
        )
        .await;
    assert_eq!(code, 422, "{body}");
    assert_eq!(body["code"], "unsupported_option");
    let body = service.json(&format!("/api/threads/{thread}")).await;
    assert!(body.get("effort").is_none(), "{body}");
    assert!(body.get("model").is_none_or(Value::is_null), "{body}");
    assert!(launches(&launch_file, "codex-turn").is_empty());

    // A value stored by a plain update is refused when a run asks to use it.
    let (code, _) = service.patch(&thread, json!({ "effort": "never" })).await;
    assert_eq!(code, 200);
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "hi" }),
        )
        .await;
    assert_eq!(code, 422, "{body}");
    service.stop().await;
}

#[tokio::test]
async fn every_codex_turn_states_its_selection_and_a_new_model_keeps_the_thread() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let (service, thread) = setup(&dir, engines(false, &launch_file), "codex").await;
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "one", "effort": "xhigh", "options": { "service_tier": "priority" } }),
        )
        .await;
    assert_eq!(code, 202, "{body}");
    assert_eq!(service.finished(&thread).await, "completed");
    // Cleared here, so the next turn has to say so or Codex keeps the old values.
    service
        .patch(
            &thread,
            json!({ "effort": "", "options": { "service_tier": "" } }),
        )
        .await;
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "two" }),
        )
        .await;
    assert_eq!(code, 202, "{body}");
    assert_eq!(service.finished(&thread).await, "completed");
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "three", "model": "fake-small" }),
        )
        .await;
    assert_eq!(code, 202, "{body}");
    assert_eq!(service.finished(&thread).await, "completed");

    let turns: Vec<Value> = launches(&launch_file, "codex-turn")
        .iter()
        .map(|turn| serde_json::from_str(turn).unwrap())
        .collect();
    assert_eq!(turns[0]["model"], "fake-big");
    assert_eq!(turns[0]["effort"], "xhigh");
    assert_eq!(turns[0]["serviceTier"], "priority");
    assert_eq!(turns[1]["effort"], "medium", "back to the model's default");
    assert!(
        turns[1].get("serviceTier").is_some_and(Value::is_null),
        "standard clears the tier: {}",
        turns[1]
    );
    assert_eq!(turns[2]["model"], "fake-small");
    assert_eq!(turns[2]["threadId"], turns[0]["threadId"]);
    assert!(turns[2].get("serviceTier").is_none(), "{}", turns[2]);
    let threads: Vec<Value> = launches(&launch_file, "codex-thread")
        .iter()
        .map(|start| serde_json::from_str(start).unwrap())
        .collect();
    assert_eq!(threads[2]["threadId"], turns[0]["threadId"], "a resume");
    assert_eq!(threads[2]["model"], "fake-small");
    service.stop().await;
}

#[tokio::test]
async fn the_configured_tier_is_the_default_and_goes_out_with_a_turn() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let mut options = engines(false, &launch_file);
    options
        .env
        .push(("ORBYN_FAKE_CODEX_TIER".to_owned(), "fast".to_owned()));
    let (service, thread) = setup(&dir, options, "codex").await;
    let models = service.json("/api/engines/codex/models").await;
    let tiers = &models["models"][0]["options"][1];
    assert_eq!(tiers["id"], "service_tier");
    assert_eq!(tiers["values"][1]["id"], "priority");
    assert_eq!(tiers["values"][1]["default"], true);
    assert_eq!(models["models"][0]["input_modalities"][1], "image");
    service.admit(&thread, "hi").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let turn: Value = serde_json::from_str(&launches(&launch_file, "codex-turn")[0]).unwrap();
    assert_eq!(turn["serviceTier"], "priority");
    assert_eq!(turn["effort"], "medium");
    service.stop().await;
}

#[tokio::test]
async fn leaving_full_access_is_stated_on_the_resume_and_the_turn() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let (service, thread) = setup(&dir, engines(false, &launch_file), "codex").await;
    service
        .patch(&thread, json!({ "permission_mode": "full_access" }))
        .await;
    service.admit(&thread, "one").await;
    assert_eq!(service.finished(&thread).await, "completed");
    service
        .patch(
            &thread,
            json!({ "permission_mode": "supervised", "plan_mode": true }),
        )
        .await;
    service.admit(&thread, "two").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let parsed = |mode: &str| -> Vec<Value> {
        launches(&launch_file, mode)
            .iter()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    };
    let (threads, turns) = (parsed("codex-thread"), parsed("codex-turn"));
    assert_eq!(threads[0]["approvalPolicy"], "never");
    assert_eq!(turns[0]["approvalPolicy"], "never");
    assert_eq!(threads[1]["threadId"], turns[0]["threadId"], "a resume");
    assert_eq!(threads[1]["approvalPolicy"], "on-request");
    assert_eq!(threads[1]["sandbox"], "read-only");
    assert_eq!(turns[1]["approvalPolicy"], "on-request");
    assert_eq!(turns[1]["sandboxPolicy"]["type"], "readOnly");
    service.stop().await;
}

#[tokio::test]
async fn a_missing_login_points_at_the_vendors_command() {
    let dir = TempDir::new();
    let mut options = engines(true, &dir.path().join("l"));
    options
        .env
        .push(("ORBYN_FAKE_NOT_LOGGED_IN".to_owned(), "1".to_owned()));
    let (service, thread) = setup(&dir, options, "claude").await;
    service.admit(&thread, "hi").await;
    assert_eq!(service.finished(&thread).await, "failed");
    let events = service.all_events(&thread).await;
    let shown = serde_json::to_string(&events).unwrap();
    assert!(shown.contains("claude auth login"), "{shown}");
    assert!(!shown.contains("sk-ant"), "{shown}");
    assert!(shown.contains("engine.sign_in_required"), "{shown}");
    service.stop().await;
}

#[tokio::test]
async fn a_failed_refresh_keeps_the_list_and_says_why() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let (service, thread) = setup(&dir, engines(false, &launch_file), "codex").await;
    let good = service.json("/api/engines/codex/models").await;
    std::fs::write(dir.path().join("lost-models"), "").unwrap();
    let kept = service.json("/api/engines/codex/models?refresh=true").await;
    assert_eq!(kept["models"], good["models"]);
    assert!(kept["error"].is_string(), "{kept}");
    // The last good list still refuses what it knows a model does not offer.
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/queue"),
            json!({ "prompt": "hi", "effort": "never" }),
        )
        .await;
    assert_eq!(code, 422, "{body}");
    service.stop().await;
}

#[tokio::test]
async fn an_oversized_mcp_request_is_refused() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, engines(false, &dir.path().join("l")), "codex").await;
    let response = service
        .post("/mcp/anything")
        .header("content-type", "application/json")
        .body(format!("\"{}\"", "x".repeat(600 * 1024)))
        .send()
        .await
        .unwrap();
    // A body under the limit would get as far as the unknown token, which is a 404.
    assert_eq!(response.status().as_u16(), 400);
    service.stop().await;
}

#[tokio::test]
async fn a_selection_follows_the_queue_a_fork_and_new_threads() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let (service, thread) = setup(&dir, engines(false, &launch_file), "codex").await;
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/queue"),
            json!({
                "prompt": "hi", "model": "fake-big", "effort": "xhigh",
                "options": { "service_tier": "priority" },
            }),
        )
        .await;
    assert_eq!(code, 201, "{body}");
    assert_eq!(service.finished(&thread).await, "completed");
    let saved = service.json(&format!("/api/threads/{thread}")).await;
    assert_eq!(saved["effort"], "xhigh");
    assert_eq!(saved["options"]["service_tier"], "priority");

    let (code, fork) = service
        .send(&format!("/api/threads/{thread}/fork"), json!({}))
        .await;
    assert_eq!(code, 201, "{fork}");
    assert_eq!(fork["model"], "fake-big");
    assert_eq!(fork["effort"], "xhigh");
    assert_eq!(fork["options"]["service_tier"], "priority");

    let models = service.json("/api/engines/codex/models").await;
    assert_eq!(models["remembered"]["effort"], "xhigh");
    let project = saved["project_id"].as_str().unwrap();
    let fresh = service.thread(project, "codex").await;
    let fresh = service.json(&format!("/api/threads/{fresh}")).await;
    assert_eq!(fresh["model"], "fake-big");
    assert_eq!(fresh["effort"], "xhigh");
    assert_eq!(fresh["options"]["service_tier"], "priority");
    service.stop().await;
}

#[tokio::test]
async fn switching_engines_leaves_the_old_engines_selection_behind() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let mut options = engines(false, &launch_file);
    options
        .env
        .push(("ORBYN_CLAUDE_BIN".to_owned(), FAKE.to_owned()));
    let (service, thread) = setup(&dir, options, "codex").await;
    service
        .patch(
            &thread,
            json!({ "model": "fake-big", "effort": "xhigh", "options": { "service_tier": "priority" } }),
        )
        .await;
    let (code, moved) = service
        .send(
            &format!("/api/threads/{thread}/switch-engine"),
            json!({ "engine": "claude", "model": "fable", "effort": "low" }),
        )
        .await;
    assert_eq!(code, 200, "{moved}");
    assert_eq!(moved["model"], "fable");
    assert_eq!(moved["effort"], "low");
    assert!(moved.get("options").is_none(), "{moved}");
    service.stop().await;
}

#[tokio::test]
async fn a_project_default_model_and_mode_reach_a_new_thread() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(false, &dir.path().join("l")), "codex").await;
    let saved = service.json(&format!("/api/threads/{thread}")).await;
    let project = saved["project_id"].as_str().unwrap().to_owned();
    let response = service
        .client
        .put(format!(
            "{}/api/projects/{project}/preferences",
            service.url
        ))
        .bearer_auth(&service.token)
        .json(&json!({ "values": {
            "default_model": "fake-small", "default_engine": "codex",
            "default_permission_mode": "auto",
        }}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success(), "{}", response.status());
    let codex = service.thread(&project, "codex").await;
    let codex = service.json(&format!("/api/threads/{codex}")).await;
    assert_eq!(codex["model"], "fake-small");
    assert_eq!(codex["lifecycle"]["permission_mode"], "auto");
    let claude = service.thread(&project, "claude").await;
    let claude = service.json(&format!("/api/threads/{claude}")).await;
    assert!(claude.get("model").is_none_or(Value::is_null), "{claude}");
    service.stop().await;
}

#[tokio::test]
async fn acp_models_come_from_a_session_and_a_choice_reaches_the_agent() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let (service, _) = setup(&dir, engines(true, &launch_file), "claude").await;
    let (code, body) = service
        .send(
            "/api/engines/custom",
            json!({ "id": "acp1", "name": "Acp", "tier": "acp", "target": FAKE, "args": ["acp"] }),
        )
        .await;
    assert!(code < 300, "{body}");
    let models = service.json("/api/engines/acp1/models").await;
    assert_eq!(models["models"][0]["is_default"], true);
    assert_eq!(models["models"][1]["label"], "ACP Large");
    let project = service.json("/api/projects").await[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let thread = service.thread(&project, "acp1").await;
    let (code, _) = service
        .patch(&thread, json!({ "model": "acp-large" }))
        .await;
    assert_eq!(code, 200);
    service.admit(&thread, "hi").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let chosen = launches(&launch_file, "acp-model");
    assert!(chosen.last().unwrap().contains("acp-large"));
    service.stop().await;
}

#[tokio::test]
async fn an_acp_probe_reads_each_models_options_and_deletes_its_session() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let mut options = engines(true, &launch_file);
    options
        .env
        .push(("ORBYN_FAKE_ACP_SESSIONS".into(), "1".into()));
    let (service, _) = setup(&dir, options, "claude").await;
    let (code, body) = service
        .send(
            "/api/engines/custom",
            json!({ "id": "acp1", "name": "Acp", "tier": "acp", "target": FAKE, "args": ["acp"] }),
        )
        .await;
    assert!(code < 300, "{body}");
    let models = service.json("/api/engines/acp1/models").await;
    assert_eq!(models["models"][0]["options"], json!([]));
    let large = &models["models"][1]["options"];
    assert_eq!(large[0]["id"], "config:effort");
    assert_eq!(large[0]["values"][1]["id"], "max");
    assert_eq!(models["options"][0]["id"], "mode", "the session's own stay");
    let deleted = launches(&launch_file, "acp-delete");
    assert_eq!(deleted.len(), 1, "{deleted:?}");
    assert!(deleted[0].contains("acp-session-1"));
    service.stop().await;
}

#[tokio::test]
async fn an_agent_that_refuses_a_probe_keeps_its_model_list() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let mut options = engines(true, &launch_file);
    options
        .env
        .push(("ORBYN_FAKE_ACP_REFUSE_MODEL".into(), "1".into()));
    let (service, _) = setup(&dir, options, "claude").await;
    let (code, body) = service
        .send(
            "/api/engines/custom",
            json!({ "id": "acp1", "name": "Acp", "tier": "acp", "target": FAKE, "args": ["acp"] }),
        )
        .await;
    assert!(code < 300, "{body}");
    let models = service.json("/api/engines/acp1/models").await;
    assert_eq!(models["models"].as_array().unwrap().len(), 2);
    assert_eq!(models["error"], Value::Null);
    assert!(
        launches(&launch_file, "acp-delete").is_empty(),
        "not offered"
    );
    service.stop().await;
}

#[tokio::test]
async fn acp_modes_and_options_are_listed_and_applied_in_order_before_the_prompt() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let (service, _) = setup(&dir, engines(true, &launch_file), "claude").await;
    let (code, body) = service
        .send(
            "/api/engines/custom",
            json!({ "id": "acp1", "name": "Acp", "tier": "acp", "target": FAKE, "args": ["acp"] }),
        )
        .await;
    assert!(code < 300, "{body}");
    let models = service.json("/api/engines/acp1/models").await;
    assert_eq!(models["options"][0]["id"], "mode");
    assert_eq!(models["options"][1]["id"], "config:think");
    let project = service.json("/api/projects").await[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let thread = service.thread(&project, "acp1").await;
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "hi", "options": { "mode": "nope" } }),
        )
        .await;
    assert_eq!(code, 422, "{body}");
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "hi", "options": { "mode": "code", "config:think": "on" } }),
        )
        .await;
    assert_eq!(code, 202, "{body}");
    assert_eq!(service.finished(&thread).await, "completed");
    let steps = launches(&launch_file, "acp-config");
    assert!(
        steps[0].contains("set_mode") && steps[0].contains("code"),
        "{steps:?}"
    );
    assert!(
        steps[1].contains("set_config_option") && steps[1].contains("think"),
        "{steps:?}"
    );
    service.stop().await;
}

#[tokio::test]
async fn acp_fails_the_turn_when_a_chosen_mode_is_gone_and_sends_no_prompt() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let (service, _) = setup(&dir, engines(true, &launch_file), "claude").await;
    let (code, body) = service
        .send(
            "/api/engines/custom",
            json!({ "id": "acp2", "name": "Acp", "tier": "acp", "target": FAKE, "args": ["acp"] }),
        )
        .await;
    assert!(code < 300, "{body}");
    let project = service.json("/api/projects").await[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let thread = service.thread(&project, "acp2").await;
    // The catalog offered `code` when it was read; this session no longer does.
    service.json("/api/engines/acp2/models").await;
    std::fs::write(dir.path().join("lost-mode"), "").unwrap();
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "hi", "options": { "mode": "code" } }),
        )
        .await;
    assert_eq!(code, 202, "{body}");
    assert_eq!(service.finished(&thread).await, "failed");
    assert!(launches(&launch_file, "acp-config").is_empty());
    service.stop().await;
}

#[tokio::test]
async fn a_turn_can_set_model_and_effort_and_they_stay() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let (service, thread) = setup(&dir, engines(false, &launch_file), "codex").await;
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "hi", "model": "fake-big", "effort": "xhigh" }),
        )
        .await;
    assert_eq!(code, 202, "{body}");
    assert_eq!(service.finished(&thread).await, "completed");
    let turn: Value = serde_json::from_str(&launches(&launch_file, "codex-turn")[0]).unwrap();
    assert_eq!(turn["model"], "fake-big");
    assert_eq!(turn["effort"], "xhigh");
    let body = service.json(&format!("/api/threads/{thread}")).await;
    assert_eq!(body["effort"], "xhigh");
    let (_, patched) = service.patch(&thread, json!({ "effort": "" })).await;
    assert!(patched.get("effort").is_none(), "{patched}");
    service.stop().await;
}

#[tokio::test]
async fn claude_question_is_answered_and_the_run_returns_to_running() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(true, &dir.path().join("l")), "claude").await;
    service.admit(&thread, "[question]").await;
    let question = open_question(&service, &thread).await;
    assert_eq!(service.run_state(&thread).await, "awaiting_approval");
    assert_eq!(question["questions"][0]["id"], "Which color?");
    assert_eq!(question["questions"][0]["multi_select"], true);
    let id = question["id"].as_str().unwrap();
    let (code, _) = service
        .send(
            &format!("/api/questions/{id}/answer"),
            json!({ "answers": { "Nope": ["x"] } }),
        )
        .await;
    assert_eq!(code, 400);
    let (code, body) = service
        .send(
            &format!("/api/questions/{id}/answer"),
            json!({ "answers": { "Which color?": ["Red", "Blue"] } }),
        )
        .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(service.finished(&thread).await, "completed");
    let events = service.all_events(&thread).await;
    assert!(text_of(&events).contains("question allow Red, Blue"));
    let (code, body) = service
        .send(&format!("/api/questions/{id}/dismiss"), json!({}))
        .await;
    assert_eq!(
        (code, body["code"].as_str()),
        (409, Some("already_decided"))
    );
    service.stop().await;
}

#[tokio::test]
async fn a_dismissal_reaches_claude_as_a_denial() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(true, &dir.path().join("l")), "claude").await;
    service.admit(&thread, "[question]").await;
    let question = open_question(&service, &thread).await;
    let id = question["id"].as_str().unwrap();
    let (code, body) = service
        .send(&format!("/api/questions/{id}/dismiss"), json!({}))
        .await;
    assert_eq!((code, body["state"].as_str()), (200, Some("dismissed")));
    assert_eq!(service.finished(&thread).await, "completed");
    assert!(text_of(&service.all_events(&thread).await).contains("question deny"));
    service.stop().await;
}

#[tokio::test]
async fn codex_secret_answers_reach_the_engine_and_never_the_record() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(false, &dir.path().join("l")), "codex").await;
    service.admit(&thread, "[question]").await;
    let question = open_question(&service, &thread).await;
    assert_eq!(question["questions"][0]["secret"], true);
    let id = question["id"].as_str().unwrap();
    let (code, body) = service
        .send(
            &format!("/api/questions/{id}/answer"),
            json!({ "answers": { "q1": ["s3cret"] } }),
        )
        .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["answers"]["q1"][0], "[hidden]");
    assert_eq!(service.finished(&thread).await, "completed");
    let events = service.all_events(&thread).await;
    assert!(text_of(&events).contains("s3cret"), "the engine got it");
    let snapshots = events
        .iter()
        .filter(|event| event["event"]["activityType"] == "question")
        .collect::<Vec<_>>();
    assert_eq!(snapshots.len(), 2);
    assert!(!snapshots[1].to_string().contains("s3cret"));
    service.stop().await;
}

#[tokio::test]
async fn cancelling_a_run_expires_its_question() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(false, &dir.path().join("l")), "codex").await;
    let run = service.admit(&thread, "[question]").await;
    let question = open_question(&service, &thread).await;
    let (code, _) = service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    assert!(code < 300);
    assert_eq!(service.finished(&thread).await, "cancelled");
    let id = question["id"].as_str().unwrap();
    let closed = service
        .json(&format!("/api/questions?thread_id={thread}&state=expired"))
        .await;
    assert_eq!(closed[0]["id"].as_str(), Some(id));
    service.stop().await;
}

#[tokio::test]
async fn codex_goal_pauses_resumes_and_clears_natively() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let (service, thread) = setup(&dir, engines(false, &launch_file), "codex").await;
    service.admit(&thread, "/goal tests pass").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let body = service.json(&format!("/api/threads/{thread}")).await;
    assert_eq!(body["goal"]["objective"], "tests pass");
    assert_eq!(body["goal"]["status"], "active");
    assert_eq!(body["goal"]["tokens_used"], 5);
    service.admit(&thread, "/goal pause").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let body = service.json(&format!("/api/threads/{thread}")).await;
    assert_eq!(body["goal"]["status"], "paused");
    service.admit(&thread, "/goal resume").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let turns = launches(&launch_file, "codex-turn");
    assert!(turns.last().unwrap().contains("Continue working"));
    service.admit(&thread, "/goal clear").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let body = service.json(&format!("/api/threads/{thread}")).await;
    assert!(body.get("goal").is_none(), "{body}");
    let goals = launches(&launch_file, "codex-goal");
    assert_eq!(goals.last().unwrap(), "clear");
    assert!(goals[1].contains("paused"), "{goals:?}");
    service.stop().await;
}

#[tokio::test]
async fn claude_refuses_goal_pause_before_anything_runs() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(true, &dir.path().join("l")), "claude").await;
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "/goal pause" }),
        )
        .await;
    assert_eq!((code, body["code"].as_str()), (422, Some("unsupported")));
    service.stop().await;
}

async fn recovers(claude: bool) {
    let dir = TempDir::new();
    let launch_file = dir.path().join("l");
    let engine = if claude { "claude" } else { "codex" };
    let mut options = engines(claude, &launch_file);
    let (service, thread) = setup(&dir, options_clone(&options), engine).await;
    service.admit(&thread, "remember the word heron").await;
    assert_eq!(service.finished(&thread).await, "completed");
    service.stop().await;
    options
        .env
        .push(("ORBYN_FAKE_LOSE_SESSION".to_owned(), "1".to_owned()));
    let service = Service::start(&dir.path().join("data"), options);
    service.admit(&thread, "what was the word").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let lost = service
        .events_until(&thread, None, |event| {
            event["event"]["name"] == "engine.session_lost"
        })
        .await;
    assert!(!lost.is_empty());
    service.stop().await;
    let mode = if claude {
        "claude-prompt"
    } else {
        "codex-turn"
    };
    let prompts = launches(&launch_file, mode);
    assert!(prompts.last().unwrap().contains("heron"), "{prompts:?}");
}

fn options_clone(options: &Options) -> Options {
    Options {
        env: options.env.clone(),
        args: options.args.clone(),
    }
}

#[tokio::test]
async fn a_lost_claude_session_restarts_fresh_with_the_handoff() {
    recovers(true).await;
}

#[tokio::test]
async fn a_lost_codex_session_restarts_fresh_with_the_handoff() {
    recovers(false).await;
}

#[tokio::test]
async fn mentions_and_commands_return_real_results() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, engines(true, &dir.path().join("l")), "claude").await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let folder = std::path::PathBuf::from(body["cwd"].as_str().unwrap());
    std::fs::create_dir_all(folder.join(".claude/commands")).unwrap();
    std::fs::write(
        folder.join(".claude/commands/ship.md"),
        "---\ndescription: Ship it\n---\nbody",
    )
    .unwrap();
    std::fs::write(folder.join("alpha.rs"), "x").unwrap();
    let body = service
        .json(&format!("/api/threads/{thread}/mentions?q=alph"))
        .await;
    assert_eq!(body["files"][0], "alpha.rs");
    service.admit(&thread, "hi").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let commands = service
        .json(&format!("/api/threads/{thread}/commands"))
        .await;
    let source_of = |name: &str| {
        commands
            .as_array()
            .unwrap()
            .iter()
            .find(|command| command["name"] == name)
            .map(|command| command["source"].as_str().unwrap().to_owned())
    };
    assert_eq!(source_of("compact").as_deref(), Some("orbyn"));
    assert_eq!(source_of("fake-command").as_deref(), Some("engine"));
    assert_eq!(source_of("ship").as_deref(), Some("engine"));
    service.stop().await;
}
