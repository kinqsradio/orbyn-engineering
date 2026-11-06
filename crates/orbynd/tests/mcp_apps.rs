//! MCP Apps through the real service: a Codex tool call whose descriptor names a
//! `ui://` page is stored as one of the thread's renders and framed by token.

mod support;

use std::path::Path;

use serde_json::{Value, json};
use support::{Options, Service, TempDir, setup};

fn options(launches: &Path) -> Options {
    Options {
        env: vec![(
            "ORBYN_FAKE_LAUNCH_FILE".to_owned(),
            launches.display().to_string(),
        )],
        ..Options::default()
    }
}

fn launches(path: &Path, mode: &str) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|entry| entry["mode"] == mode)
        .collect()
}

async fn markers(service: &Service, thread: &str) -> Vec<Value> {
    service
        .all_events(thread)
        .await
        .into_iter()
        .map(|row| row["event"].clone())
        .filter(|event| event["type"] == "CUSTOM" && event["name"] == "mcp_app")
        .map(|event| event["value"].clone())
        .collect()
}

#[tokio::test]
async fn a_codex_app_page_is_stored_as_a_render_and_opened_only_by_its_token() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("launches.jsonl");
    let (service, thread) = setup(&dir, options(&launch_file), "codex").await;
    std::fs::write(dir.path().join("project/secret.png"), b"png").unwrap();
    service.admit(&thread, "[mcp-app]").await;
    assert_eq!(service.finished(&thread).await, "completed");

    let reads = launches(&launch_file, "codex-app-read");
    assert_eq!(reads.len(), 1, "one read on the run's own app-server");
    let read: Value = serde_json::from_str(reads[0]["args"][0].as_str().unwrap()).unwrap();
    assert_eq!(read["server"], "demo");
    assert_eq!(read["uri"], "ui://demo/widget.html");
    assert_eq!(read["originCallId"], "app-call-1");
    assert!(read["threadId"].is_string());

    let found = markers(&service, &thread).await;
    assert_eq!(found.len(), 1, "{found:?}");
    let marker = &found[0];
    assert_eq!(marker["toolCallId"], "app-call-1");
    assert_eq!(marker["server"], "demo");
    assert_eq!(marker["tool"], "show_widget");
    assert_eq!(marker["resourceUri"], "ui://demo/widget.html");
    assert_eq!(marker["displayMode"], "inline");
    assert_eq!(marker["prefersBorder"], true);
    assert_eq!(marker["structuredContent"], json!({ "text": "hello" }));
    assert!(!marker.to_string().contains(&service.token));
    let render = marker["renderId"].as_str().unwrap();
    let frame = marker["frameToken"].as_str().unwrap();
    let url = format!("{}/api/threads/{thread}/renders/{render}", service.url);

    let page = service
        .client
        .get(format!("{url}?render={frame}"))
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), 200);
    let csp = page
        .headers()
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        !csp.contains("connect-src"),
        "the app has no network: {csp}"
    );
    assert_eq!(
        page.text().await.unwrap(),
        "<!doctype html><p id=v>demo widget</p><img src=\"secret.png\">",
        "an app page never gets checkout images copied in"
    );
    let image = service
        .client
        .get(format!("{url}/image-1.png?render={frame}"))
        .send()
        .await
        .unwrap();
    assert_eq!(image.status(), 404);
    for wrong in ["render=wrong", "render="] {
        let refused = service
            .client
            .get(format!("{url}?{wrong}"))
            .send()
            .await
            .unwrap();
        assert!(refused.status().is_client_error(), "{wrong}");
    }
    service.stop().await;
}

#[tokio::test]
async fn an_app_page_over_the_render_limit_leaves_an_ordinary_tool_row() {
    let dir = TempDir::new();
    let launch_file = dir.path().join("launches.jsonl");
    let (service, thread) = setup(&dir, options(&launch_file), "codex").await;
    service.admit(&thread, "[mcp-app] [mcp-app-huge]").await;
    assert_eq!(service.finished(&thread).await, "completed");
    assert_eq!(launches(&launch_file, "codex-app-read").len(), 1);
    assert!(markers(&service, &thread).await.is_empty());
    let events = service.all_events(&thread).await;
    assert!(
        events
            .iter()
            .any(|row| row["event"]["type"] == "TOOL_CALL_RESULT"
                && row["event"]["toolCallId"] == "app-call-1"),
        "the tool row stays"
    );
    service.stop().await;
}
