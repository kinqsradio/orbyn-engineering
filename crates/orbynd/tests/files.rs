//! Timeline data and file operations through the real service.

mod support;

use serde_json::{Value, json};
use support::{Options, Service, TempDir, run_git, setup};

async fn write(service: &Service, thread: &str, body: Value) -> (u16, Value) {
    let response = service
        .client
        .put(format!(
            "{}/api/threads/{thread}/files/content",
            service.url
        ))
        .bearer_auth(&service.token)
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn read(service: &Service, thread: &str, path: &str) -> (u16, Value) {
    let response = service
        .get(&format!("/api/threads/{thread}/files/content"))
        .query(&[("path", path)])
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

#[tokio::test]
async fn items_keep_raw_engine_data_and_usage_is_reported() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[approve]").await;
    let approval = service.pending().await;
    service.decide(approval["id"].as_str().unwrap(), true).await;
    service.finished(&thread).await;
    let item = service
        .json(&format!("/api/threads/{thread}/items/cmd1"))
        .await;
    assert_eq!(item["kind"], "commandExecution");
    assert_eq!(item["exit_code"], 0);
    assert_eq!(item["raw"]["aggregatedOutput"], "listing");
    let usage = service.json(&format!("/api/threads/{thread}/usage")).await;
    assert_eq!(usage["total_tokens"], 120);
    assert_eq!(usage["context_window"], 1000);
    let events = service.all_events(&thread).await;
    assert!(
        events
            .iter()
            .any(|event| event["event"]["name"] == "tool.output")
    );
    assert!(
        events
            .iter()
            .any(|event| event["event"]["name"] == "tool.finished")
    );
    assert!(events.iter().any(|event| event["event"]["name"] == "usage"));
    let missing = service
        .get(&format!("/api/threads/{thread}/items/none"))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);
}

#[tokio::test]
async fn edits_detect_conflicts_and_create_only_when_absent() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let (code, created) = write(
        &service,
        &thread,
        json!({ "path": "src/a.txt", "content": "one", "base_revision": null }),
    )
    .await;
    assert_eq!(code, 200, "{created}");
    let revision = created["revision"].as_str().unwrap().to_owned();

    // Creating over an existing file is a conflict, not an overwrite.
    let (code, body) = write(
        &service,
        &thread,
        json!({ "path": "src/a.txt", "content": "two", "base_revision": null }),
    )
    .await;
    assert_eq!(code, 409);
    assert_eq!(body["code"], "file_conflict");
    assert_eq!(body["detail"]["revision"], revision.as_str());

    // Someone else moves the file on, as an engine would.
    let file = dir.path().join("library/repo/project/src/a.txt");
    std::fs::write(&file, "engine edit").unwrap();
    let (code, _) = write(
        &service,
        &thread,
        json!({ "path": "src/a.txt", "content": "mine", "base_revision": revision }),
    )
    .await;
    assert_eq!(code, 409);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "engine edit");

    let (_, current) = read(&service, &thread, "src/a.txt").await;
    assert_eq!(current["content"], "engine edit");
    let (code, _) = write(
        &service,
        &thread,
        json!({ "path": "src/a.txt", "content": "mine", "base_revision": current["revision"] }),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
    let leftovers = std::fs::read_dir(file.parent().unwrap()).unwrap().count();
    assert_eq!(leftovers, 1, "no partial save remains");
    assert!(
        service
            .audit(&thread)
            .await
            .iter()
            .any(|row| row["action"] == "file.write")
    );
}

#[tokio::test]
async fn paths_cannot_leave_the_checkout_or_touch_git_metadata() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        dir.path().join("library"),
        dir.path().join("library/repo/project/escape"),
    )
    .unwrap();
    for path in [
        "../../AGENTS.md",
        ".git/config",
        "/etc/hosts",
        "escape/AGENTS.md",
    ] {
        if path.starts_with("escape") && cfg!(not(unix)) {
            continue;
        }
        let (code, _) = read(&service, &thread, path).await;
        assert_eq!(code, 400, "read {path}");
        let (code, _) = write(
            &service,
            &thread,
            json!({ "path": path, "content": "x", "base_revision": null }),
        )
        .await;
        assert_eq!(code, 400, "write {path}");
    }
    assert_eq!(
        std::fs::read_to_string(dir.path().join("library/AGENTS.md")).unwrap(),
        "shared policy\n"
    );
}

#[tokio::test]
async fn untrusted_folders_are_not_browsed() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    let folder = dir.path().join("project");
    let project = service.project(&folder, false).await;
    let thread = service.thread(&project, "codex").await;
    let response = service
        .get(&format!("/api/threads/{thread}/files"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
}

#[tokio::test]
async fn tree_marks_ignored_and_search_finds_names_and_lines() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let checkout = dir.path().join("library/repo/project");
    std::fs::write(checkout.join(".gitignore"), "build/\n").unwrap();
    std::fs::create_dir_all(checkout.join("build")).unwrap();
    std::fs::write(checkout.join("build/out.bin"), "needle").unwrap();
    std::fs::write(checkout.join("main.rs"), "fn main() {}\n// Needle: here\n").unwrap();
    run_git(&checkout, &["add", "main.rs"]);

    let tree = service.json(&format!("/api/threads/{thread}/files")).await;
    let entry = |name: &str| {
        tree.as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == name)
            .unwrap()
            .clone()
    };
    assert_eq!(entry("build")["ignored"], true);
    assert_eq!(entry("build")["is_dir"], true);
    assert_eq!(entry("main.rs")["ignored"], false);
    assert!(
        tree.as_array()
            .unwrap()
            .iter()
            .all(|row| row["name"] != ".git")
    );

    let ignored = service
        .json(&format!("/api/threads/{thread}/files/ignored"))
        .await;
    assert_eq!(ignored, json!(["build/"]));

    let names = service
        .json(&format!("/api/threads/{thread}/files/search?q=MAIN"))
        .await;
    assert_eq!(names[0]["path"], "main.rs");
    let lines = service
        .json(&format!(
            "/api/threads/{thread}/files/search?q=needle&content=true"
        ))
        .await;
    assert_eq!(
        lines.as_array().unwrap().len(),
        1,
        "ignored files stay out: {lines}"
    );
    assert_eq!(lines[0]["line"], 2);
    let none = service
        .json(&format!(
            "/api/threads/{thread}/files/search?q=absent&content=true"
        ))
        .await;
    assert!(none.as_array().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn open_in_editor_runs_only_a_known_editor_on_a_checkout_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new();
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let record = dir.path().join("opened");
    let code = bin.join("code");
    std::fs::write(
        &code,
        format!("#!/bin/sh\necho \"$1\" > '{}'\n", record.display()),
    )
    .unwrap();
    std::fs::set_permissions(&code, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    let (service, thread) = setup(
        &dir,
        Options {
            env: vec![("PATH".into(), path)],
            ..Options::default()
        },
        "codex",
    )
    .await;
    assert!(
        service
            .json("/api/editors")
            .await
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["id"] == "vscode")
    );
    let checkout = dir.path().join("library/repo/project");
    std::fs::write(checkout.join("a.txt"), "x").unwrap();
    let opened = format!("/api/threads/{thread}/files/open");
    let (status, _) = service
        .send(
            &opened,
            json!({ "path": "a.txt", "editor": "not-an-editor" }),
        )
        .await;
    assert_eq!(status, 400);
    let (status, _) = service
        .send(
            &opened,
            json!({ "path": "../../AGENTS.md", "editor": "vscode" }),
        )
        .await;
    assert_eq!(status, 400);
    assert!(!record.exists());
    let (status, _) = service
        .send(&opened, json!({ "path": "a.txt", "editor": "vscode" }))
        .await;
    assert_eq!(status, 202);
    for _ in 0..200 {
        if record.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let seen = std::fs::read_to_string(&record).unwrap();
    assert_eq!(seen.trim(), checkout.join("a.txt").to_str().unwrap());
}
