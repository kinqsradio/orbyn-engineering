//! Usage from local history and permission modes through the real service.

mod support;

use serde_json::{Value, json};
use support::{Options, TempDir, setup, text_of};

fn write(path: std::path::PathBuf, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[tokio::test]
async fn usage_comes_from_history_alone_and_never_from_credentials() {
    let dir = TempDir::new();
    let claude = dir.path().join("claude-home");
    let codex = dir.path().join("codex-home");
    write(
        claude.join("projects/p/s.jsonl"),
        r#"{"timestamp":"2026-10-30T01:00:00Z","message":{"id":"m","model":"opus","usage":{"input_tokens":10,"output_tokens":2}}}"#,
    );
    write(
        claude.join(".credentials.json"),
        r#"{"token":"SECRET-MARKER"}"#,
    );
    write(codex.join("auth.json"), r#"{"token":"SECRET-MARKER"}"#);
    let options = Options {
        env: vec![
            (
                "CLAUDE_CONFIG_DIR".into(),
                claude.to_string_lossy().into_owned(),
            ),
            ("CODEX_HOME".into(), codex.to_string_lossy().into_owned()),
        ],
        ..Options::default()
    };
    let (service, _) = setup(&dir, options, "codex").await;
    let report = service.json("/api/usage").await;
    assert!(!report.to_string().contains("SECRET-MARKER"));
    assert_eq!(
        report["host_id"],
        service.json("/api/usage").await["host_id"]
    );
    let engine = |name: &str| {
        report["engines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["engine"] == name)
            .unwrap()
            .clone()
    };
    assert_eq!(engine("codex")["status"], "no_history");
    let usage = engine("claude");
    assert_eq!(usage["files_scanned"], 1);
    assert_eq!(usage["models"][0]["input_tokens"], 10);
    assert_eq!(usage["models"][0]["estimated_cost"], Value::Null);
    assert_eq!(usage["days"][0]["date"], "2026-10-30");

    // A new price shows on the next read, and a changed file is read again.
    let mut settings = service.json("/api/settings").await;
    settings["model_prices"] = json!([
        { "model": "opus", "input": 1000000.0, "output": 0.0, "cache_read": 0.0, "cache_write": 0.0 }
    ]);
    service
        .client
        .put(format!("{}/api/settings", service.url))
        .bearer_auth(&service.token)
        .json(&settings)
        .send()
        .await
        .unwrap();
    let priced = service.json("/api/usage").await;
    assert_eq!(priced["engines"][0]["models"][0]["estimated_cost"], 10.0);
}

#[tokio::test]
async fn limits_come_from_the_engine_and_only_where_it_reports_them() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    let limits = service.json("/api/engines/codex/limits").await;
    assert_eq!(limits["limits"]["rateLimits"]["primary"]["usedPercent"], 12);
    let again = service.json("/api/engines/codex/limits").await;
    assert_eq!(
        again["checked_at"], limits["checked_at"],
        "cached for five minutes"
    );
    assert_eq!(limits["plan"], "plus");
    assert_eq!(limits["windows"][0]["label"], "5 hours");
    assert_eq!(limits["windows"][1]["label"], "7 days");
    assert_eq!(limits["windows"][0]["resets_at"], "2027-01-15T08:00:00Z");
    let forced = service.json("/api/engines/codex/limits?force=true").await;
    assert_ne!(forced["checked_at"], limits["checked_at"]);
    let overview = service.json("/api/limits").await;
    assert_eq!(overview["pooled"][0]["used_percent"], 12.0);
    assert_eq!(overview["pooled"][0]["engines"][0], "codex");
    let refreshed = service
        .post("/api/usage/refresh?days=7")
        .send()
        .await
        .unwrap();
    assert_eq!(refreshed.status(), 200);
    let claude = service
        .get("/api/engines/claude/limits")
        .send()
        .await
        .unwrap();
    assert_eq!(claude.status(), 422);
}

#[tokio::test]
async fn a_turn_can_set_the_mode_and_full_access_never_widens_codex_writes() {
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
    let (code, _) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "[approve]", "permission_mode": "full_access" }),
        )
        .await;
    assert_eq!(code, 202);
    assert_eq!(service.finished(&thread).await, "completed");
    assert_eq!(
        text_of(&service.all_events(&thread).await),
        "decision accept"
    );
    let current = service.json(&format!("/api/threads/{thread}")).await;
    assert_eq!(current["lifecycle"]["permission_mode"], "full_access");
    let log = std::fs::read_to_string(&file).unwrap();
    let turn = log
        .lines()
        .find(|l| l.contains(r#""mode":"codex-turn""#))
        .unwrap();
    let entry: Value = serde_json::from_str(turn).unwrap();
    let params: Value = serde_json::from_str(entry["args"][0].as_str().unwrap()).unwrap();
    assert_eq!(params["approvalPolicy"], "never");
    assert_eq!(params["sandboxPolicy"]["type"], "workspaceWrite");
    assert_eq!(params["sandboxPolicy"]["networkAccess"], true);
    let root = dir.path().join("library").join("repo").join("project");
    assert_eq!(params["sandboxPolicy"]["writableRoots"], json!([root]));
}

#[tokio::test]
async fn claude_stays_on_the_gate_in_every_mode() {
    let dir = TempDir::new();
    let file = dir.path().join("launches");
    let target = dir.path().join("library/AGENTS.md");
    let options = Options {
        env: vec![
            (
                "ORBYN_FAKE_LAUNCH_FILE".into(),
                file.to_string_lossy().into_owned(),
            ),
            (
                "ORBYN_FAKE_WRITE_PATH".into(),
                target.to_string_lossy().into_owned(),
            ),
        ],
        ..Options::default()
    };
    let (service, thread) = setup(&dir, options, "claude").await;
    service
        .patch(&thread, json!({ "permission_mode": "full_access" }))
        .await;
    service.admit(&thread, "[approve]").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let log = std::fs::read_to_string(&file).unwrap();
    assert!(log.contains(r#""--permission-mode","default""#));
    assert!(log.contains("--permission-prompt-tool"));
    assert!(!log.contains("bypassPermissions"));
    assert!(!log.contains("acceptEdits"));
    assert_eq!(
        text_of(&service.all_events(&thread).await),
        "permission allow"
    );
}
