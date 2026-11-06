//! The engine's own console, resumed on a thread's session, through the real service.

mod support;

use std::path::Path;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use support::{Options, Service, TempDir, setup};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

fn options(file: &Path) -> Options {
    Options {
        env: vec![(
            "ORBYN_FAKE_LAUNCH_FILE".into(),
            file.to_string_lossy().into_owned(),
        )],
        ..Options::default()
    }
}

/// The console launches the fake engine recorded, in order.
fn consoles(file: &Path) -> Vec<Value> {
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|entry| {
            entry["mode"]
                .as_str()
                .is_some_and(|mode| mode.ends_with("-console"))
        })
        .collect()
}

async fn until_seen(service: &Service, thread: &str, text: &str) -> bool {
    let url = format!(
        "{}/ws/terminal/{thread}/engine-console?token={}",
        service.url.replacen("http", "ws", 1),
        service.token
    );
    let mut socket = connect_async(url).await.unwrap().0;
    socket
        .send(Message::binary(b"hello console\r".to_vec()))
        .await
        .unwrap();
    let mut seen = String::new();
    tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(Ok(frame)) = socket.next().await {
            if let Message::Binary(bytes) = frame {
                seen.push_str(&String::from_utf8_lossy(&bytes));
                if seen.contains(text) {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false)
}

async fn close_console(service: &Service, thread: &str) {
    let gone = service
        .client
        .delete(format!(
            "{}/api/threads/{thread}/terminals/engine-console",
            service.url
        ))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), 204);
}

#[tokio::test]
async fn claude_console_resumes_the_thread_session_and_holds_runs() {
    let dir = TempDir::new();
    let file = dir.path().join("launches");
    let (service, thread) = setup(&dir, options(&file), "claude").await;
    let path = format!("/api/threads/{thread}/console");

    let (code, body) = service.send(&path, json!({})).await;
    assert_eq!(code, 422, "{body}");
    assert!(
        body.to_string().contains("no Claude Code session yet"),
        "{body}"
    );

    service.admit(&thread, "hello").await;
    service.finished(&thread).await;
    let (code, info) = service
        .send(&path, json!({ "cols": 100, "rows": 30 }))
        .await;
    assert_eq!(code, 201, "{info}");
    assert_eq!(info["id"], "engine-console");
    assert_eq!(info["title"], "Claude console");
    assert!(until_seen(&service, &thread, "console heard hello console").await);
    let launched = consoles(&file);
    assert_eq!(launched.len(), 1, "{launched:?}");
    assert_eq!(launched[0]["mode"], "claude-console");
    let args = launched[0]["args"].as_array().unwrap();
    assert_eq!(
        args[..5],
        [
            json!("--resume"),
            json!("claude-session-1"),
            json!("--permission-mode"),
            json!("default"),
            json!("--add-dir"),
        ]
    );
    // Claude starts at the library, where its runs keep the session, and reaches
    // the nested checkout with `--add-dir`.
    let checkout = std::path::PathBuf::from(args[5].as_str().unwrap());
    assert!(checkout.ends_with("repo/project"), "{checkout:?}");
    let cwd = std::fs::canonicalize(launched[0]["cwd"].as_str().unwrap()).unwrap();
    let library = checkout.parent().and_then(Path::parent).unwrap();
    assert_eq!(cwd, std::fs::canonicalize(library).unwrap());

    // The console owns the session: no run, and a second open reuses it.
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "again" }),
        )
        .await;
    assert_eq!(code, 409, "{body}");
    assert_eq!(body["code"], "console_open", "{body}");
    let (code, again) = service.send(&path, json!({})).await;
    assert_eq!(code, 201, "{again}");
    assert_eq!(again["created_at"], info["created_at"]);
    assert_eq!(consoles(&file).len(), 1);

    close_console(&service, &thread).await;
    service.admit(&thread, "again").await;
    service.finished(&thread).await;

    // Plan mode reaches the console as Claude's own plan permission mode.
    service.patch(&thread, json!({ "plan_mode": true })).await;
    let (code, body) = service.send(&path, json!({})).await;
    assert_eq!(code, 201, "{body}");
    assert!(until_seen(&service, &thread, "fake console on claude-session-1").await);
    let launched = consoles(&file);
    assert_eq!(launched.last().unwrap()["args"][3], "plan", "{launched:?}");
    assert!(
        service
            .audit(&thread)
            .await
            .iter()
            .any(|entry| entry["action"] == "engine.console")
    );
    service.stop().await;
}

#[tokio::test]
async fn console_keeps_to_the_saved_login_when_asked() {
    let dir = TempDir::new();
    let file = dir.path().join("launches");
    let mut options = options(&file);
    for (name, value) in [
        ("ANTHROPIC_API_KEY", "not-a-real-key"),
        ("CLAUDE_CODE_OAUTH_TOKEN", "not-a-real-token"),
        ("ANTHROPIC_BASE_URL", "https://proxy.test"),
    ] {
        options.env.push((name.to_owned(), value.to_owned()));
    }
    let (service, thread) = setup(&dir, options, "claude").await;
    let response = service
        .client
        .put(format!("{}/api/preferences", service.url))
        .bearer_auth(&service.token)
        .json(&json!({ "values": { "prefer_saved_login": true } }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    service.admit(&thread, "hello").await;
    service.finished(&thread).await;
    let (code, body) = service
        .send(&format!("/api/threads/{thread}/console"), json!({}))
        .await;
    assert_eq!(code, 201, "{body}");
    assert!(until_seen(&service, &thread, "fake console on claude-session-1").await);
    let seen = consoles(&file)[0]["env"].to_string();
    for name in [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
    ] {
        assert!(!seen.contains(name), "{name} reached the console: {seen}");
    }
    service.stop().await;
}

#[tokio::test]
async fn codex_console_resumes_in_the_checkout() {
    let dir = TempDir::new();
    let file = dir.path().join("launches");
    let (service, thread) = setup(&dir, options(&file), "codex").await;
    service.admit(&thread, "hello").await;
    service.finished(&thread).await;
    let (code, info) = service
        .send(&format!("/api/threads/{thread}/console"), json!({}))
        .await;
    assert_eq!(code, 201, "{info}");
    assert_eq!(info["title"], "Codex console");
    assert!(until_seen(&service, &thread, "fake console on codex-thread-1").await);
    let launched = consoles(&file);
    let args = launched[0]["args"].as_array().unwrap();
    assert_eq!(
        args[..7],
        [
            json!("resume"),
            json!("codex-thread-1"),
            json!("--sandbox"),
            json!("workspace-write"),
            json!("--ask-for-approval"),
            json!("on-request"),
            json!("--cd"),
        ]
    );
    // Codex starts where its runs work: the thread's checkout.
    let same = |value: &Value| std::fs::canonicalize(value.as_str().unwrap()).unwrap();
    assert_eq!(same(&args[7]), same(&launched[0]["cwd"]));
    service.stop().await;
}
