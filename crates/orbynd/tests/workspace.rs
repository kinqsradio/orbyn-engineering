//! The managed workspace through the real service.

mod support;

use serde_json::{Value, json};
use support::{Options, Service, TempDir, library, run_git, setup};

#[tokio::test]
async fn first_run_is_blocked_until_setup() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    let status = service.json("/api/workspace").await;
    assert_eq!(status["configured"], false);
    assert!(
        status["default_url"]
            .as_str()
            .unwrap()
            .contains("orbyn-fullstack-skills")
    );
    let (code, body) = service
        .send("/api/projects/create", json!({ "name": "app" }))
        .await;
    assert_eq!(code, 409);
    assert_eq!(body["code"], "workspace_required");
}

#[tokio::test]
async fn the_old_register_by_path_route_is_gone() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    let (code, _) = service
        .send("/api/projects", json!({ "path": "/tmp" }))
        .await;
    assert_eq!(code, 405);
}

#[tokio::test]
async fn clone_setup_uses_the_configured_url() {
    let dir = TempDir::new();
    let upstream = library(&dir.path().join("upstream"));
    let service = Service::start(
        &dir.path().join("data"),
        Options {
            env: vec![(
                "ORBYN_WORKSPACE_URL".into(),
                upstream.to_string_lossy().into_owned(),
            )],
            ..Options::default()
        },
    );
    let (code, body) = service.send("/api/workspace/setup", json!({})).await;
    assert_eq!(code, 200, "{body}");
    assert!(body["targets"].as_array().unwrap().is_empty());
    assert_eq!(body["library"]["adopted"], false);
    assert!(
        std::path::Path::new(body["library"]["path"].as_str().unwrap())
            .ends_with(std::path::Path::new("data").join("workspace"))
    );
    assert_eq!(body["library"]["upstream"], "origin/main");
}

fn launches(file: &std::path::Path, mode: &str) -> Vec<Value> {
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|entry| entry["mode"] == mode)
        // A model list check can land first, from a folder of its own.
        .filter(|entry| {
            !entry["cwd"]
                .as_str()
                .is_some_and(|cwd| cwd.contains("orbyn-probe"))
        })
        .collect()
}

fn launch_options(dir: &TempDir) -> (std::path::PathBuf, Options) {
    let file = dir.path().join("launches");
    (
        file.clone(),
        Options {
            env: vec![(
                "ORBYN_FAKE_LAUNCH_FILE".into(),
                file.to_string_lossy().into_owned(),
            )],
            ..Options::default()
        },
    )
}

#[tokio::test]
async fn claude_starts_at_the_workspace_root_with_no_plugin_dir() {
    let dir = TempDir::new();
    let (file, options) = launch_options(&dir);
    let (service, thread) = setup(&dir, options, "claude").await;
    service.admit(&thread, "hi").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let launch = &launches(&file, "claude")[0];
    let root = dir.path().join("library");
    assert_eq!(launch["cwd"], root.to_str().unwrap());
    let args: Vec<&str> = launch["args"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(!args.contains(&"--plugin-dir"), "{args:?}");
    assert!(!args.contains(&"--bare"));
}

#[tokio::test]
async fn codex_thread_discovers_at_the_root_and_turns_write_in_the_checkout() {
    let dir = TempDir::new();
    let (file, options) = launch_options(&dir);
    let (service, thread) = setup(&dir, options, "codex").await;
    service.admit(&thread, "hi").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let root = dir.path().join("library");
    let checkout = root.join("repo").join("project");
    // The first launch can be the short one that reads the model list.
    let run = launches(&file, "codex");
    assert_eq!(run.last().unwrap()["cwd"], root.to_str().unwrap());
    let parse = |mode: &str| -> Value {
        serde_json::from_str(launches(&file, mode)[0]["args"][0].as_str().unwrap()).unwrap()
    };
    assert_eq!(parse("codex-thread")["cwd"], root.to_str().unwrap());
    let turn = parse("codex-turn");
    assert_eq!(turn["cwd"], checkout.to_str().unwrap());
    assert_eq!(turn["sandboxPolicy"]["type"], "workspaceWrite");
    assert_eq!(turn["sandboxPolicy"]["writableRoots"], json!([checkout]));
    let text = turn["input"][0]["text"].as_str().unwrap();
    assert!(text.contains("Checkout: "), "{text}");
    assert!(text.contains("open its files directly"), "{text}");
    assert!(text.contains("skill_search"), "{text}");
    assert!(text.len() < 1_000, "the first turn stays short: {text}");
    assert!(text.ends_with("hi"));
}

#[tokio::test]
async fn write_outside_the_selected_checkout_is_denied_without_asking() {
    let dir = TempDir::new();
    let target = dir.path().join("library/skills/how/SKILL.md");
    let (service, thread) = setup(
        &dir,
        Options {
            env: vec![(
                "ORBYN_FAKE_WRITE_PATH".into(),
                target.to_string_lossy().into_owned(),
            )],
            ..Options::default()
        },
        "codex",
    )
    .await;
    service.admit(&thread, "[outside-write]").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let events = service.all_events(&thread).await;
    assert_eq!(support::text_of(&events), "write decline");
    let audit = service.audit(&thread).await;
    assert!(audit.iter().any(|row| row["source"] == "write_scope"));
    assert!(
        service
            .json("/api/approvals?state=pending")
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn write_inside_the_checkout_still_asks() {
    let dir = TempDir::new();
    let target = dir.path().join("library/repo/project/a.txt");
    let (service, thread) = setup(
        &dir,
        Options {
            env: vec![(
                "ORBYN_FAKE_WRITE_PATH".into(),
                target.to_string_lossy().into_owned(),
            )],
            ..Options::default()
        },
        "codex",
    )
    .await;
    service.admit(&thread, "[outside-write]").await;
    let approval = service.pending().await;
    assert_eq!(approval["kind"], "file_change");
    service.decide(approval["id"].as_str().unwrap(), true).await;
    assert_eq!(service.finished(&thread).await, "completed");
    assert_eq!(
        support::text_of(&service.all_events(&thread).await),
        "write accept"
    );
}

/// Every file, except the objects and hidden refs that checkpoints add to Git's
/// own store. Config, excludes, hooks and the index must all stay untouched.
fn tree(root: &std::path::Path, into: &mut Vec<(std::path::PathBuf, Vec<u8>)>) {
    for entry in std::fs::read_dir(root).unwrap().flatten() {
        let path = entry.path();
        if path.ends_with(".git/objects") || path.ends_with(".git/refs/orbyn") {
            continue;
        }
        if entry.file_type().unwrap().is_dir() {
            tree(&path, into);
        } else {
            into.push((path.clone(), std::fs::read(&path).unwrap()));
        }
    }
}

#[tokio::test]
async fn a_full_run_writes_nothing_into_the_target() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "claude").await;
    let target = dir.path().join("library/repo/project");
    let mut before = Vec::new();
    tree(&target, &mut before);
    before.sort();
    service.admit(&thread, "hi").await;
    service.finished(&thread).await;
    service.json("/api/workspace").await;
    let mut after = Vec::new();
    tree(&target, &mut after);
    after.sort();
    assert_eq!(before, after);
}

#[tokio::test]
async fn status_reports_library_and_targets() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    std::fs::create_dir_all(dir.path().join("library/repo/project/.claude/skills/how")).unwrap();
    std::fs::write(dir.path().join("library/repo/project/AGENTS.md"), "rules").unwrap();
    let status = service.json("/api/workspace").await;
    assert_eq!(status["library"]["revision"].as_str().unwrap().len(), 40);
    assert_eq!(status["library"]["dirty"], false);
    let target = &status["targets"][0];
    assert_eq!(target["dirty"], true);
    assert_eq!(target["instructions"][0], "AGENTS.md");
    assert_eq!(target["same_name_skills"][0], ".claude/skills/how");
}

#[tokio::test]
async fn update_is_refused_while_a_run_is_active_and_removal_with_work_needs_confirmation() {
    let dir = TempDir::new();
    let upstream = library(&dir.path().join("upstream"));
    let service = Service::start(
        &dir.path().join("data"),
        Options {
            env: vec![(
                "ORBYN_WORKSPACE_URL".into(),
                upstream.to_string_lossy().into_owned(),
            )],
            ..Options::default()
        },
    );
    service.send("/api/workspace/setup", json!({})).await;
    let (_, project) = service
        .send("/api/projects/create", json!({ "name": "app" }))
        .await;
    let id = project["id"].as_str().unwrap();
    service
        .send(&format!("/api/projects/{id}/trust"), json!({}))
        .await;
    let thread = service.thread(id, "codex").await;
    std::fs::write(upstream.join("new"), "x").unwrap();
    run_git(&upstream, &["add", "."]);
    run_git(&upstream, &["commit", "-q", "-m", "new"]);

    let run = service.admit(&thread, "[hang]").await;
    let (code, body) = service
        .send("/api/workspace/update", json!({ "apply": true }))
        .await;
    assert_eq!(code, 409, "{body}");
    assert_eq!(body["code"], "runs_active");
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    service.finished(&thread).await;
    let (code, body) = service
        .send("/api/workspace/update", json!({ "apply": true }))
        .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["applied"], true);

    let checkout = project["path"].as_str().unwrap();
    std::fs::write(std::path::Path::new(checkout).join("wip"), "x").unwrap();
    let response = service
        .client
        .delete(format!(
            "{}/api/projects/{id}?delete_files=true",
            service.url
        ))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 409);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["code"], "project_has_work");
    assert_eq!(body["detail"]["dirty_files"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_library_thread_is_explicit_and_cannot_reach_nested_projects() {
    let dir = TempDir::new();
    let inside = dir.path().join("library/repo/project/a.txt");
    let (service, _) = setup(
        &dir,
        Options {
            env: vec![(
                "ORBYN_FAKE_WRITE_PATH".into(),
                inside.to_string_lossy().into_owned(),
            )],
            ..Options::default()
        },
        "codex",
    )
    .await;
    let projects = service.json("/api/projects").await;
    let library = projects
        .as_array()
        .unwrap()
        .iter()
        .find(|project| project["name"] == "Skills library")
        .unwrap();
    let id = library["id"].as_str().unwrap();
    assert_eq!(library["trusted"], false, "opening the library is a choice");
    let thread = service.thread(id, "codex").await;
    let (code, _) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "x" }),
        )
        .await;
    assert_eq!(code, 403);
    service
        .send(&format!("/api/projects/{id}/trust"), json!({}))
        .await;
    service.admit(&thread, "[outside-write]").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let events = service.all_events(&thread).await;
    assert_eq!(support::text_of(&events), "write decline");
    let response = service
        .client
        .delete(format!("{}/api/projects/{id}", service.url))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn a_host_session_never_reaches_an_engine_and_a_preference_clears_a_key() {
    let dir = TempDir::new();
    let (file, mut options) = launch_options(&dir);
    for (name, value) in [
        ("CLAUDECODE", "1"),
        ("CLAUDE_CODE_SIMPLE", "1"),
        ("CLAUDE_CONFIG_DIR", "/tmp/kept"),
        ("ANTHROPIC_API_KEY", "not-a-real-key"),
    ] {
        options.env.push((name.to_owned(), value.to_owned()));
    }
    options.env.push((
        "ANTHROPIC_BASE_URL".to_owned(),
        "https://u:p@proxy.test/v1".to_owned(),
    ));
    let (service, thread) = setup(&dir, options, "claude").await;
    service.admit(&thread, "hi").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let run = launches(&file, "claude");
    let seen = run.last().unwrap()["env"].to_string();
    assert!(!seen.contains("\"CLAUDECODE\""), "{seen}");
    assert!(!seen.contains("CLAUDE_CODE_SIMPLE"), "{seen}");
    assert!(seen.contains("CLAUDE_CONFIG_DIR"), "{seen}");
    assert!(
        seen.contains("ANTHROPIC_API_KEY"),
        "kept until asked: {seen}"
    );

    let engines = service.json("/api/engines").await;
    let claude = engines
        .as_array()
        .unwrap()
        .iter()
        .find(|engine| engine["id"] == "claude")
        .unwrap();
    assert_eq!(
        claude["inherited_credentials"],
        json!(["ANTHROPIC_API_KEY"])
    );
    assert_eq!(claude["endpoint_origin"], "https://proxy.test");
    assert!(!claude.to_string().contains("not-a-real-key"));

    let response = service
        .client
        .put(format!("{}/api/preferences", service.url))
        .bearer_auth(&service.token)
        .json(&json!({ "values": { "prefer_saved_login": true } }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    service.admit(&thread, "again").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let run = launches(&file, "claude");
    let seen = run.last().unwrap()["env"].to_string();
    assert!(!seen.contains("ANTHROPIC_API_KEY"), "{seen}");
    assert!(!seen.contains("ANTHROPIC_BASE_URL"), "{seen}");
    service.stop().await;
}
