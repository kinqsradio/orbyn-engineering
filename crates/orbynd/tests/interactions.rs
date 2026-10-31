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
    assert_eq!(list.len(), 1, "{models}");
    assert_eq!(list[0]["id"], "fake-big");
    assert_eq!(list[0]["is_default"], true);
    let values = &list[0]["options"][0]["values"];
    assert_eq!(values[0]["id"], "medium");
    assert_eq!(values[0]["default"], true);
    assert_eq!(values[1]["label"], "Extra high");
    service.stop().await;
}

#[tokio::test]
async fn claude_lists_documented_aliases() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, engines(true, &dir.path().join("l")), "claude").await;
    let models = service.json("/api/engines/claude/models").await;
    assert_eq!(models["source"], "documented");
    assert!(
        models["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["id"] == "opus")
    );
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
    assert!(launches(&launch_file, "acp-model")[0].contains("acp-large"));
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
