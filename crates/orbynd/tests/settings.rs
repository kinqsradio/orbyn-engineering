//! Settings with project overrides, keybindings, diagnostics and storage cleanup
//! through the real service.

mod support;

use serde_json::{Value, json};
use support::{FAKE, Options, Service, TempDir, run_git, setup};

fn value(views: &Value, key: &str) -> Value {
    views
        .as_array()
        .unwrap()
        .iter()
        .find(|view| view["key"] == key)
        .unwrap()
        .clone()
}

async fn put(service: &Service, path: &str, body: Value) -> (u16, Value) {
    let response = service
        .client
        .put(format!("{}{path}", service.url))
        .bearer_auth(&service.token)
        .json(&body)
        .send()
        .await
        .unwrap();
    let code = response.status().as_u16();
    (code, response.json().await.unwrap_or(Value::Null))
}

fn fake_engines() -> Options {
    Options {
        env: vec![("ORBYN_CLAUDE_BIN".to_owned(), FAKE.to_owned())],
        ..Options::default()
    }
}

#[tokio::test]
async fn project_values_win_over_global_ones_and_reset_to_them() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, fake_engines(), "claude").await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let project = body["project_id"].as_str().unwrap();
    let start = service.json("/api/preferences").await;
    assert_eq!(value(&start, "auto_pull")["source"], "default");
    let (code, _) = put(
        &service,
        "/api/preferences",
        json!({ "values": { "branch_name_prefix": "team" } }),
    )
    .await;
    assert_eq!(code, 200);
    let path = format!("/api/projects/{project}/preferences");
    let (code, views) = put(
        &service,
        &path,
        json!({ "values": { "branch_name_prefix": "mine", "auto_pull": true } }),
    )
    .await;
    assert_eq!(code, 200, "{views}");
    assert_eq!(value(&views, "branch_name_prefix")["value"], "mine");
    assert_eq!(value(&views, "branch_name_prefix")["source"], "project");
    let global = service.json("/api/preferences").await;
    assert_eq!(value(&global, "branch_name_prefix")["value"], "team");
    let (_, views) = put(
        &service,
        &path,
        json!({ "values": { "branch_name_prefix": null } }),
    )
    .await;
    assert_eq!(value(&views, "branch_name_prefix")["source"], "global");
    for (target, values) in [
        ("/api/preferences".to_owned(), json!({ "nope": 1 })),
        ("/api/preferences".to_owned(), json!({ "auto_pull": "yes" })),
        (path.clone(), json!({ "observability": {} })),
    ] {
        let (code, _) = put(&service, &target, json!({ "values": values })).await;
        assert_eq!(code, 400, "{values}");
    }
    let (code, _) = put(
        &service,
        "/api/preferences",
        json!({ "values": { "default_theme": "dark", "worktree_submodules": "bad" } }),
    )
    .await;
    assert_eq!(code, 400);
    let after = service.json("/api/preferences").await;
    assert_eq!(
        value(&after, "default_theme")["source"],
        "default",
        "all or none"
    );
    service.stop().await;
}

#[tokio::test]
async fn preference_maps_roll_back_global_writes_after_a_database_failure() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    let (code, start) = put(
        &service,
        "/api/preferences",
        json!({ "values": { "auto_pull": false, "default_model": "initial", "branch_name_prefix": "keep" } }),
    )
    .await;
    assert_eq!(code, 200, "{start}");
    let db = rusqlite::Connection::open(dir.path().join("data/orbyn.sqlite3")).unwrap();
    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    db.execute_batch(
        "CREATE TRIGGER fail_later_global_preference BEFORE INSERT ON settings
         WHEN NEW.key = 'pref:default_model'
         BEGIN SELECT RAISE(ABORT, 'fixture rejects the later preference'); END;",
    )
    .unwrap();
    let change = json!({ "values": { "auto_pull": true, "default_model": "changed" } });
    let (code, error) = put(&service, "/api/preferences", change.clone()).await;
    assert_eq!(code, 500, "{error}");
    let after = service.json("/api/preferences").await;
    assert_eq!(
        value(&after, "auto_pull"),
        value(&start, "auto_pull"),
        "the earlier write must roll back"
    );
    assert_eq!(
        value(&after, "default_model"),
        value(&start, "default_model")
    );
    assert_eq!(
        value(&after, "branch_name_prefix"),
        value(&start, "branch_name_prefix")
    );
    db.execute_batch("DROP TRIGGER fail_later_global_preference;")
        .unwrap();
    let (code, retried) = put(&service, "/api/preferences", change).await;
    assert_eq!(code, 200, "{retried}");
    assert_eq!(value(&retried, "auto_pull")["value"], true);
    assert_eq!(value(&retried, "default_model")["value"], "changed");
    let (code, reset) = put(
        &service,
        "/api/preferences",
        json!({ "values": { "auto_pull": null, "default_model": null } }),
    )
    .await;
    assert_eq!(code, 200, "{reset}");
    assert_eq!(value(&reset, "auto_pull")["source"], "default");
    assert_eq!(value(&reset, "default_model")["source"], "default");
    assert_eq!(value(&reset, "branch_name_prefix")["value"], "keep");
    drop(db);
    service.stop().await;
}

#[tokio::test]
async fn preference_maps_roll_back_project_resets_after_a_database_failure() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let project = body["project_id"].as_str().unwrap();
    let path = format!("/api/projects/{project}/preferences");
    let (code, global) = put(
        &service,
        "/api/preferences",
        json!({ "values": { "auto_pull": false, "default_model": "global" } }),
    )
    .await;
    assert_eq!(code, 200, "{global}");
    let (code, start) = put(
        &service,
        &path,
        json!({ "values": { "auto_pull": true, "default_model": "project", "branch_name_prefix": "keep" } }),
    )
    .await;
    assert_eq!(code, 200, "{start}");
    let db = rusqlite::Connection::open(dir.path().join("data/orbyn.sqlite3")).unwrap();
    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    db.execute_batch(
        "CREATE TRIGGER fail_later_project_reset BEFORE DELETE ON project_preferences
         WHEN OLD.key = 'default_model'
         BEGIN SELECT RAISE(ABORT, 'fixture rejects the later reset'); END;",
    )
    .unwrap();
    let change = json!({ "values": { "auto_pull": null, "default_model": null } });
    let (code, error) = put(&service, &path, change.clone()).await;
    assert_eq!(code, 500, "{error}");
    let read = format!("/api/preferences?project_id={project}");
    let after = service.json(&read).await;
    assert_eq!(
        value(&after, "auto_pull"),
        value(&start, "auto_pull"),
        "the earlier reset must roll back"
    );
    assert_eq!(
        value(&after, "default_model"),
        value(&start, "default_model")
    );
    assert_eq!(service.json("/api/preferences").await, global);
    db.execute_batch("DROP TRIGGER fail_later_project_reset;")
        .unwrap();
    let (code, retried) = put(&service, &path, change.clone()).await;
    assert_eq!(code, 200, "{retried}");
    assert_eq!(value(&retried, "auto_pull")["source"], "global");
    assert_eq!(value(&retried, "default_model")["value"], "global");
    assert_eq!(value(&retried, "branch_name_prefix")["value"], "keep");
    let (code, repeated) = put(&service, &path, change).await;
    assert_eq!(code, 200, "{repeated}");
    assert_eq!(repeated, retried, "retrying a reset stays safe");
    drop(db);
    service.stop().await;
}

#[tokio::test]
async fn a_project_can_turn_an_engine_off_and_models_can_be_added_or_hidden() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, fake_engines(), "claude").await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let project = body["project_id"].as_str().unwrap();
    put(
        &service,
        &format!("/api/projects/{project}/preferences"),
        json!({ "values": { "disabled_engines": ["claude"] } }),
    )
    .await;
    let (code, _) = service
        .send(
            "/api/threads",
            json!({ "project_id": project, "engine": "claude", "model": null, "title": null,
                    "worktree": null, "skill_profile": null }),
        )
        .await;
    assert_eq!(code, 400);
    put(
        &service,
        "/api/preferences",
        json!({ "values": {
            "custom_models": [{ "engine": "claude", "id": "claude-x", "label": "X" }],
            "hidden_models": ["claude:haiku"],
            "model_order": ["claude:claude-x"],
        }}),
    )
    .await;
    let models = service.json("/api/engines/claude/models").await;
    assert_eq!(models["models"][0]["id"], "claude-x");
    assert_eq!(models["models"][0]["custom"], true);
    assert!(
        models["models"]
            .as_array()
            .unwrap()
            .iter()
            .all(|model| model["id"] != "haiku")
    );
    service.stop().await;
}

#[tokio::test]
async fn keybindings_merge_the_file_and_survive_a_bad_entry() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, fake_engines(), "claude").await;
    let start = service.json("/api/keybindings").await;
    assert!(start["conflicts"].as_array().unwrap().is_empty());
    let (code, view) = service
        .send(
            "/api/keybindings",
            json!({ "key": "mod+y", "command": "sidebar.toggle" }),
        )
        .await;
    assert_eq!(code, 200, "{view}");
    let rules = view["rules"].as_array().unwrap();
    assert!(rules.iter().any(|rule| rule["key"] == "mod+y"));
    assert!(!rules.iter().any(|rule| rule["key"] == "mod+b"));
    let path = view["path"].as_str().unwrap();
    std::fs::write(
        path,
        "[ // hand edit\n{ \"key\": \"mod+y\", \"command\": \"sidebar.toggle\" },\n{ \"key\": \"\" },\n]",
    )
    .unwrap();
    let view = service.json("/api/keybindings").await;
    assert_eq!(view["issues"].as_array().unwrap().len(), 1);
    let rules = view["rules"].as_array().unwrap();
    assert!(rules.iter().any(|rule| rule["key"] == "mod+y"));
    service.stop().await;
}

#[tokio::test]
async fn diagnostics_cleanup_and_the_otlp_check_report_what_happened() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, fake_engines(), "claude").await;
    let found = service.json("/api/diagnostics").await;
    assert_eq!(found["active_runs"], 0);
    assert_eq!(found["database"]["repair_suggested"], false);
    assert!(found["database"]["bytes"].as_u64().unwrap() > 0);
    let (code, _) = service.send("/api/diagnostics/repair", json!({})).await;
    assert_eq!(code, 204);
    let (_, closed) = service
        .send(
            "/api/diagnostics/otlp",
            json!({ "url": "http://127.0.0.1:9/v1/traces" }),
        )
        .await;
    assert_eq!(closed["ok"], false);
    let (_, bad) = service
        .send(
            "/api/diagnostics/otlp",
            json!({ "url": "file:///etc/passwd" }),
        )
        .await;
    assert_eq!(bad["ok"], false);
    let logs = dir.path().join("data/logs");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(logs.join("old.log"), "x").unwrap();
    put(
        &service,
        "/api/preferences",
        json!({ "values": { "storage_cleanup": { "logs_after_days": 0 } } }),
    )
    .await;
    let (code, dry) = service
        .send("/api/storage/cleanup?dry_run=true", json!({}))
        .await;
    assert_eq!(code, 200, "{dry}");
    assert_eq!(dry["entries"][0]["kind"], "log");
    assert_eq!(dry["entries"][0]["removed"], false);
    assert!(logs.join("old.log").exists(), "a dry run changes nothing");
    let (_, real) = service.send("/api/storage/cleanup", json!({})).await;
    assert_eq!(real["entries"][0]["removed"], true);
    assert!(!logs.join("old.log").exists());
    let report = service.json("/api/storage/cleanup").await;
    assert_eq!(report["dry_run"], false);
    let _ = thread;
    service.stop().await;
}

#[tokio::test]
async fn worktrees_follow_the_prefix_the_chosen_base_and_a_settled_one_is_cleaned() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, fake_engines(), "claude").await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let project = body["project_id"].as_str().unwrap().to_owned();
    let cwd = std::path::PathBuf::from(body["cwd"].as_str().unwrap());
    run_git(&cwd, &["config", "user.email", "t@example.com"]);
    run_git(&cwd, &["config", "user.name", "T"]);
    std::fs::write(cwd.join("a.txt"), "one").unwrap();
    run_git(&cwd, &["add", "."]);
    run_git(&cwd, &["commit", "-q", "-m", "one"]);
    run_git(&cwd, &["branch", "older"]);
    std::fs::write(cwd.join("b.txt"), "two").unwrap();
    run_git(&cwd, &["add", "."]);
    run_git(&cwd, &["commit", "-q", "-m", "two"]);
    put(
        &service,
        &format!("/api/projects/{project}/preferences"),
        json!({ "values": { "branch_name_prefix": "wip" } }),
    )
    .await;
    let (code, made) = service
        .send(
            "/api/threads",
            json!({ "project_id": project, "engine": "claude", "model": null, "title": null,
                    "worktree": "topic", "skill_profile": null, "base_branch": "older" }),
        )
        .await;
    assert_eq!(code, 201, "{made}");
    assert_eq!(made["worktree"]["branch"], "wip/topic");
    let path = std::path::PathBuf::from(made["cwd"].as_str().unwrap());
    assert!(path.join("a.txt").exists());
    assert!(
        !path.join("b.txt").exists(),
        "it started from the chosen base"
    );
    let id = made["id"].as_str().unwrap();
    assert_eq!(service.patch(id, json!({ "settled": true })).await.0, 200);
    put(
        &service,
        "/api/preferences",
        json!({ "values": { "storage_cleanup": { "worktree_settled_after_days": 0 } } }),
    )
    .await;
    std::fs::write(path.join("unsaved.txt"), "keep").unwrap();
    let (_, kept) = service.send("/api/storage/cleanup", json!({})).await;
    assert_eq!(kept["entries"][0]["removed"], false, "{kept}");
    assert!(
        path.join("unsaved.txt").exists(),
        "Git keeps uncommitted work"
    );
    std::fs::remove_file(path.join("unsaved.txt")).unwrap();
    let (_, gone) = service.send("/api/storage/cleanup", json!({})).await;
    assert_eq!(gone["entries"][0]["removed"], true, "{gone}");
    assert!(!path.exists());
    service.stop().await;
}

#[tokio::test]
async fn the_network_list_names_each_switch_and_reports_it() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    let row = |rows: &Value, key: &str| {
        rows.as_array()
            .unwrap()
            .iter()
            .find(|row| row["setting"] == key)
            .unwrap_or_else(|| panic!("no row for {key}"))
            .clone()
    };
    let rows = service.json("/api/network").await;
    assert_eq!(row(&rows, "poll_pull_requests")["enabled"], true);
    assert_eq!(row(&rows, "auto_pull")["enabled"], false, "off by default");
    assert_eq!(row(&rows, "background_update_checks")["enabled"], true);
    assert_eq!(row(&rows, "auto_thread_titles")["enabled"], true);
    let (code, _) = put_value(
        &service,
        "/api/preferences",
        json!({ "values": { "poll_pull_requests": false, "auto_pull": true } }),
    )
    .await;
    assert_eq!(code, 200);
    let rows = service.json("/api/network").await;
    assert_eq!(row(&rows, "poll_pull_requests")["enabled"], false);
    assert_eq!(row(&rows, "auto_pull")["enabled"], true);
    let settings = service.json("/api/settings").await;
    let mut settings = settings;
    settings["background_update_checks"] = json!(false);
    let (code, _) = put_value(&service, "/api/settings", settings).await;
    assert_eq!(code, 200);
    let rows = service.json("/api/network").await;
    assert_eq!(row(&rows, "background_update_checks")["enabled"], false);
    assert!(
        rows.as_array()
            .unwrap()
            .iter()
            .any(|row| row["setting"].is_null()),
        "a request made only on demand has no switch"
    );
}

async fn put_value(service: &Service, path: &str, body: Value) -> (u16, Value) {
    let response = service
        .client
        .put(format!("{}{path}", service.url))
        .bearer_auth(&service.token)
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

#[tokio::test]
async fn concurrent_keybinding_edits_preserve_each_unrelated_command() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    let mut edits = tokio::task::JoinSet::new();
    for index in 0..12 {
        let client = service.client.clone();
        let url = format!("{}/api/keybindings", service.url);
        let token = service.token.clone();
        edits.spawn(async move {
            let response = client.post(url).bearer_auth(token).json(&json!({
                "key":format!("ctrl+alt+f{}", index+1), "command":format!("script.fixture-{index}.run"), "when":null, "remove":false
            })).send().await.unwrap();
            assert_eq!(response.status(), 200);
        });
    }
    while let Some(result) = edits.join_next().await {
        result.unwrap();
    }
    let view = service.json("/api/keybindings").await;
    for index in 0..12 {
        assert!(
            view["rules"]
                .as_array()
                .unwrap()
                .iter()
                .any(|rule| rule["command"] == format!("script.fixture-{index}.run"))
        );
    }
    assert!(view["issues"].as_array().unwrap().is_empty());
    service.stop().await;
}
