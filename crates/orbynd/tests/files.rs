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
    // The editor runs detached, and on a busy machine it can take a while.
    let mut seen = String::new();
    for _ in 0..6000 {
        seen = std::fs::read_to_string(&record).unwrap_or_default();
        if !seen.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(seen.trim(), checkout.join("a.txt").to_str().unwrap());
}

async fn raw(service: &Service, thread: &str, path: &str) -> reqwest::RequestBuilder {
    service
        .get(&format!("/api/threads/{thread}/files/raw"))
        .query(&[("path", path)])
}

fn header<'a>(response: &'a reqwest::Response, name: &str) -> &'a str {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

async fn checkout(service: &Service, thread: &str) -> std::path::PathBuf {
    let body = service.json(&format!("/api/threads/{thread}")).await;
    body["cwd"].as_str().unwrap().into()
}

#[tokio::test]
async fn raw_bytes_serve_ranges_and_never_run_a_page_in_this_origin() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let root = checkout(&service, &thread).await;
    let bytes: Vec<u8> = (0..=255).collect();
    std::fs::write(root.join("clip.mp4"), &bytes).unwrap();
    std::fs::write(root.join("page.html"), "<script>1</script>").unwrap();
    std::fs::write(root.join("mark.svg"), "<svg/>").unwrap();
    std::fs::write(root.join("doc.pdf"), "%PDF").unwrap();

    let whole = raw(&service, &thread, "clip.mp4")
        .await
        .send()
        .await
        .unwrap();
    assert_eq!(whole.status(), 200);
    assert_eq!(header(&whole, "content-type"), "video/mp4");
    assert_eq!(header(&whole, "accept-ranges"), "bytes");
    assert_eq!(header(&whole, "x-content-type-options"), "nosniff");
    assert!(header(&whole, "content-disposition").starts_with("inline"));
    let tag = header(&whole, "etag").to_owned();
    assert_eq!(whole.bytes().await.unwrap().as_ref(), &bytes[..]);

    let part = raw(&service, &thread, "clip.mp4")
        .await
        .header("Range", "bytes=10-19")
        .send()
        .await
        .unwrap();
    assert_eq!(part.status(), 206);
    assert_eq!(header(&part, "content-range"), "bytes 10-19/256");
    assert_eq!(header(&part, "content-length"), "10");
    assert_eq!(part.bytes().await.unwrap().as_ref(), &bytes[10..20]);

    let tail = raw(&service, &thread, "clip.mp4")
        .await
        .header("Range", "bytes=-6")
        .send()
        .await
        .unwrap();
    assert_eq!(tail.bytes().await.unwrap().as_ref(), &bytes[250..]);

    let past = raw(&service, &thread, "clip.mp4")
        .await
        .header("Range", "bytes=256-")
        .send()
        .await
        .unwrap();
    assert_eq!(past.status(), 416);
    assert_eq!(header(&past, "content-range"), "bytes */256");

    // A file that changed answers in full, so two versions are never stitched.
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(root.join("clip.mp4"), b"newer").unwrap();
    let stale = raw(&service, &thread, "clip.mp4")
        .await
        .header("Range", "bytes=0-1")
        .header("If-Range", &tag)
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), 200);
    assert_eq!(stale.bytes().await.unwrap().as_ref(), b"newer");

    let fresh = raw(&service, &thread, "clip.mp4")
        .await
        .send()
        .await
        .unwrap();
    let tag = header(&fresh, "etag").to_owned();
    let same = raw(&service, &thread, "clip.mp4")
        .await
        .header("If-None-Match", &tag)
        .send()
        .await
        .unwrap();
    assert_eq!(same.status(), 304);

    let page = raw(&service, &thread, "page.html")
        .await
        .send()
        .await
        .unwrap();
    assert_eq!(header(&page, "content-type"), "application/octet-stream");
    assert!(header(&page, "content-disposition").starts_with("attachment"));

    let svg = raw(&service, &thread, "mark.svg")
        .await
        .send()
        .await
        .unwrap();
    assert_eq!(header(&svg, "content-type"), "image/svg+xml");
    assert!(header(&svg, "content-security-policy").contains("sandbox"));

    let pdf = raw(&service, &thread, "doc.pdf")
        .await
        .send()
        .await
        .unwrap();
    assert_eq!(header(&pdf, "content-type"), "application/pdf");
    assert_eq!(header(&pdf, "content-security-policy"), "");

    let forced = service
        .get(&format!("/api/threads/{thread}/files/raw"))
        .query(&[("path", "mark.svg"), ("download", "true")])
        .send()
        .await
        .unwrap();
    assert!(header(&forced, "content-disposition").starts_with("attachment"));
}

#[tokio::test]
async fn raw_bytes_stay_inside_the_checkout_and_behind_the_token() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let root = checkout(&service, &thread).await;
    std::fs::write(dir.path().join("outside.png"), "secret").unwrap();
    std::fs::write(root.join("in.png"), "ok").unwrap();
    std::fs::create_dir_all(root.join("sub")).unwrap();

    for path in [
        "../outside.png",
        "sub/../../outside.png",
        "/etc/hosts",
        ".git/config",
        ".GIT/config",
    ] {
        let response = raw(&service, &thread, path).await.send().await.unwrap();
        assert_eq!(response.status(), 400, "{path}");
    }
    let folder = raw(&service, &thread, "sub").await.send().await.unwrap();
    assert_eq!(folder.status(), 400);
    let missing = raw(&service, &thread, "none.png")
        .await
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.path().join("outside.png"), root.join("link.png")).unwrap();
        std::os::unix::fs::symlink(".git/config", root.join("cfg.png")).unwrap();
        for path in ["link.png", "cfg.png"] {
            let linked = raw(&service, &thread, path).await.send().await.unwrap();
            assert_eq!(linked.status(), 400, "{path}");
        }
    }

    // An image element cannot set a header, so this route takes the token in the URL,
    // and no other route gains that.
    let url = format!("{}/api/threads/{thread}/files/raw", service.url);
    let anonymous = service
        .client
        .get(&url)
        .query(&[("path", "in.png")])
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), 401);
    let wrong = service
        .client
        .get(&url)
        .query(&[("path", "in.png"), ("token", "wrong")])
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 401);
    let good = service
        .client
        .get(&url)
        .query(&[("path", "in.png"), ("token", service.token.as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(good.status(), 200);
    let other = service
        .client
        .get(format!(
            "{}/api/threads/{thread}/files/content",
            service.url
        ))
        .query(&[("path", "in.png"), ("token", service.token.as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(other.status(), 401);
}

#[tokio::test]
async fn raw_bytes_need_a_trusted_folder() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    let folder = dir.path().join("project");
    std::fs::create_dir_all(&folder).unwrap();
    let project = service.project(&folder, false).await;
    let thread = service.thread(&project, "codex").await;
    let response = raw(&service, &thread, "a.png").await.send().await.unwrap();
    assert_eq!(response.status(), 403);
}

#[tokio::test]
async fn raw_bytes_refuse_a_file_past_the_limit() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let root = checkout(&service, &thread).await;
    // A sparse file, so this takes no disk.
    let huge = std::fs::File::create(root.join("huge.mp4")).unwrap();
    huge.set_len(orbyn_core::file_bytes::MAX_RAW_BYTES + 1)
        .unwrap();
    let response = raw(&service, &thread, "huge.mp4")
        .await
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 413);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["code"], "file_too_large");
}
