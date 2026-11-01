//! Usage from local history and permission modes through the real service.

mod support;

use serde_json::{Value, json};
use support::{Options, TempDir, setup, text_of};

#[tokio::test]
async fn claude_subscription_windows_use_control_ipc_without_a_prompt_or_account_data() {
    let dir = TempDir::new();
    let controls = dir.path().join("controls");
    let launches = dir.path().join("launches");
    let service = support::Service::start(
        &dir.path().join("data"),
        Options {
            env: vec![
                ("ORBYN_FAKE_CLAUDE_USAGE".into(), "available".into()),
                (
                    "ORBYN_FAKE_CLAUDE_CONTROL_FILE".into(),
                    controls.to_string_lossy().into_owned(),
                ),
                (
                    "ORBYN_FAKE_LAUNCH_FILE".into(),
                    launches.to_string_lossy().into_owned(),
                ),
            ],
            ..Options::default()
        },
    );
    let response = service
        .get("/api/engines/claude/limits")
        .send()
        .await
        .unwrap();
    let code = response.status();
    let limits: Value = response.json().await.unwrap();
    assert_eq!(code, 200, "{limits}");
    assert_eq!(limits["plan"], "pro");
    assert_eq!(limits["windows"][0]["label"], "Session");
    assert_eq!(limits["windows"][0]["used_percent"], 54.0);
    assert_eq!(limits["windows"][0]["window_minutes"], 300);
    assert_eq!(limits["windows"][0]["resets_at"], "2027-01-15T08:00:00Z");
    assert_eq!(limits["windows"][1]["label"], "Weekly");
    assert!(limits["windows"][1]["resets_at"].is_null());
    assert_eq!(limits["windows"][2]["label"], "Weekly · Fable");
    assert_eq!(limits["windows"][3]["label"], "Monthly spend");
    assert_eq!(limits["windows"][3]["used_percent"], 25.0);
    assert!(!limits.to_string().contains("SECRET-MARKER"));
    assert!(!limits.to_string().contains("account"));
    assert!(!limits.to_string().contains("session"));
    let frames = std::fs::read_to_string(&controls).unwrap();
    let frames: Vec<Value> = frames
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(frames.len(), 2);
    assert!(
        frames
            .iter()
            .all(|frame| frame["type"] == "control_request")
    );
    assert_eq!(frames[0]["request"], json!({ "subtype": "initialize" }));
    assert_eq!(frames[1]["request"], json!({ "subtype": "get_usage" }));
    let log = std::fs::read_to_string(&launches).unwrap();
    let probe: Value = log
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|entry| entry["mode"] == "claude-probe")
        .unwrap();
    let cwd = std::path::Path::new(probe["cwd"].as_str().unwrap());
    assert!(
        !cwd.exists(),
        "the probe is reaped and its isolated cwd removed"
    );
    assert_ne!(cwd, dir.path());
    let cached = service.json("/api/engines/claude/limits").await;
    assert_eq!(cached, limits);
    assert_eq!(
        std::fs::read_to_string(&controls).unwrap().lines().count(),
        2
    );
    let forced = service.json("/api/engines/claude/limits?force=true").await;
    assert!(!forced.to_string().contains("SECRET-MARKER"));
    assert_eq!(
        std::fs::read_to_string(&controls).unwrap().lines().count(),
        4
    );
    let overview = service.json("/api/limits").await;
    let weekly = overview["pooled"]
        .as_array()
        .unwrap()
        .iter()
        .find(|window| window["window_minutes"] == 10080)
        .unwrap();
    assert_eq!(weekly["used_percent"], 73.0);
    assert_eq!(
        weekly["engines"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|engine| **engine == "claude")
            .count(),
        1
    );
    service.stop().await;
}

#[tokio::test]
async fn claude_limits_stay_unknown_for_unavailable_errors_malformed_and_timed_out_replies() {
    for (mode, expected) in [
        ("error", 502),
        ("unavailable", 422),
        ("malformed", 502),
        ("silent", 502),
    ] {
        let dir = TempDir::new();
        let service = support::Service::start(
            &dir.path().join("data"),
            Options {
                env: vec![("ORBYN_FAKE_CLAUDE_USAGE".into(), mode.into())],
                ..Options::default()
            },
        );
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            service.get("/api/engines/claude/limits").send(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status(), expected, "{mode}");
        let body: Value = response.json().await.unwrap();
        assert!(
            !body.to_string().contains("SECRET-MARKER"),
            "{mode}: {body}"
        );
        assert!(body.get("windows").is_none(), "{mode}: {body}");
        if mode == "error" {
            let overview = service.json("/api/limits").await;
            let unavailable = overview["unavailable"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["engine"] == "claude")
                .expect("an untyped error must remain visible as unavailable");
            assert!(!unavailable.to_string().contains("SECRET-MARKER"));
        }
        service.stop().await;
    }
}

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
