//! Agent history found in the engines' own folders and imported as threads, through
//! the real service, with private history folders.

mod support;

use serde_json::json;
use support::{Options, TempDir, setup};

#[tokio::test]
async fn a_saved_codex_session_imports_once_into_its_trusted_project() {
    let dir = TempDir::new();
    let codex_home = dir.path().join("codex-home");
    let claude_home = dir.path().join("claude-home");
    let options = Options {
        env: vec![
            (
                "CODEX_HOME".into(),
                codex_home.to_string_lossy().into_owned(),
            ),
            (
                "CLAUDE_CONFIG_DIR".into(),
                claude_home.to_string_lossy().into_owned(),
            ),
        ],
        ..Options::default()
    };
    let (service, _thread) = setup(&dir, options, "codex").await;
    let projects = service.json("/api/projects").await;
    let project = projects
        .as_array()
        .unwrap()
        .iter()
        .find(|project| project["scratch"] != true)
        .unwrap()["path"]
        .as_str()
        .unwrap()
        .to_owned();
    let rollout = codex_home.join("sessions/2026/11/06/rollout-a.jsonl");
    std::fs::create_dir_all(rollout.parent().unwrap()).unwrap();
    let lines = [
        json!({"type": "session_meta", "payload": {"id": "s-1", "cwd": project}}),
        json!({"type": "event_msg", "payload": {"type": "user_message", "message": "Make the build green"}}),
    ];
    let text: Vec<String> = lines.iter().map(ToString::to_string).collect();
    std::fs::write(&rollout, text.join("\n")).unwrap();

    let scan = service.json("/api/history/sessions").await;
    let session = &scan["sessions"][0];
    assert_eq!(session["engine"], "codex");
    assert_eq!(session["title"], "Make the build green");
    assert_eq!(session["importable"], true, "{scan}");
    assert!(session["thread_id"].is_null());

    let body = json!({ "engine": "codex", "session_id": "s-1" });
    let (code, first) = service.send("/api/history/import", body.clone()).await;
    assert_eq!(code, 200, "{first}");
    assert_eq!(first["imported"], true);
    let (_, again) = service.send("/api/history/import", body).await;
    assert_eq!(again["thread_id"], first["thread_id"]);
    assert_eq!(again["imported"], false);
    let thread_id = first["thread_id"].as_str().unwrap();
    let thread = service.json(&format!("/api/threads/{thread_id}")).await;
    assert_eq!(thread["title"], "Make the build green");

    let (code, _) = service
        .send(
            "/api/history/import",
            json!({ "engine": "codex", "session_id": "missing" }),
        )
        .await;
    assert_eq!(code, 404);
    service.stop().await;
}
