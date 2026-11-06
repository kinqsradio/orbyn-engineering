//! Web links another app hands to the desktop app, through the real binary's stdin.
//! The shell only forwards them; the service decides whether and where they open.

mod support;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use serde_json::{Value, json};
use support::{Options, Service, TempDir, setup};

fn desktop(env: Vec<(String, String)>) -> Options {
    Options {
        args: vec!["--parent-stdin".into()],
        env,
    }
}

fn say(service: &mut Service, line: &str) {
    let stdin = service.child.stdin.as_mut().unwrap();
    writeln!(stdin, "{line}").unwrap();
    stdin.flush().unwrap();
}

fn link(url: &str) -> String {
    json!({ "type": "open_link", "url": url }).to_string()
}

async fn allow_links(service: &Service, on: bool) {
    let response = service
        .client
        .put(format!("{}/api/preferences", service.url))
        .bearer_auth(&service.token)
        .json(&json!({ "values": { "open_web_links_in_app": on } }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
}

/// The next shell event a window sees.
async fn next_event(stream: &mut reqwest::Response, seen: &mut String) -> Value {
    loop {
        if let Some(end) = seen.find("\n\n") {
            let frame: String = seen.drain(..end + 2).collect();
            if let Some(data) = frame.lines().find_map(|line| line.strip_prefix("data:")) {
                return serde_json::from_str(data.trim()).unwrap();
            }
            continue;
        }
        let chunk = tokio::time::timeout(Duration::from_secs(20), stream.chunk())
            .await
            .expect("no shell event arrived")
            .unwrap()
            .expect("the stream closed");
        seen.push_str(&String::from_utf8_lossy(&chunk));
    }
}

#[tokio::test]
async fn a_web_link_is_refused_until_the_person_turns_it_on() {
    let dir = TempDir::new();
    let missing = dir.path().join("no-browser").to_string_lossy().into_owned();
    let (mut service, thread) = setup(
        &dir,
        desktop(vec![("ORBYN_BROWSER".into(), missing)]),
        "codex",
    )
    .await;
    let mut stream = service.get("/api/shell/events").send().await.unwrap();
    let mut seen = String::new();

    say(&mut service, &link("https://example.com/"));
    let event = next_event(&mut stream, &mut seen).await;
    assert_eq!(event["type"], "failed", "{event}");
    assert!(
        event["message"]
            .as_str()
            .unwrap()
            .contains("Open links from other apps here"),
        "{event}"
    );
    let tabs = service
        .json(&format!("/api/threads/{thread}/previews"))
        .await;
    assert_eq!(tabs, json!([]));

    // Other schemes never reach the decision, whatever the setting.
    allow_links(&service, true).await;
    say(&mut service, &link("file:///etc/passwd"));
    say(&mut service, &link("javascript:alert(1)"));
    // A browser that cannot start shows the decision was made without opening anything.
    say(&mut service, &link("https://example.com/second"));
    let event = next_event(&mut stream, &mut seen).await;
    assert_eq!(event["type"], "failed", "{event}");
    assert!(
        !event["message"]
            .as_str()
            .unwrap()
            .contains("Open links from other apps here"),
        "{event}"
    );
}

#[tokio::test]
async fn a_web_link_needs_a_thread_in_a_trusted_project() {
    let dir = TempDir::new();
    let mut service = Service::start(&dir.path().join("data"), desktop(Vec::new()));
    let folder = dir.path().join("project");
    std::fs::create_dir_all(&folder).unwrap();
    let project = service.project(&folder, false).await;
    service.thread(&project, "codex").await;
    allow_links(&service, true).await;
    let mut stream = service.get("/api/shell/events").send().await.unwrap();
    let mut seen = String::new();
    say(&mut service, &link("https://example.com/"));
    let event = next_event(&mut stream, &mut seen).await;
    assert_eq!(event["type"], "failed", "{event}");
    assert!(
        event["message"]
            .as_str()
            .unwrap()
            .contains("no thread in a trusted project"),
        "{event}"
    );
}

fn serve_page() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut buffer = [0u8; 2048];
            let _ = stream.read(&mut buffer);
            let page = "<!doctype html><title>linked</title><p>from another app</p>";
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
                page.len()
            );
        }
    });
    port
}

/// Drives an installed Chrome or Edge. Run with `--ignored` where one exists.
#[tokio::test]
#[ignore = "needs an installed browser"]
async fn a_web_link_opens_a_preview_on_the_latest_trusted_thread() {
    let dir = TempDir::new();
    let (mut service, first) = setup(
        &dir,
        desktop(vec![("ORBYN_BROWSER_HEADLESS".into(), "1".into())]),
        "codex",
    )
    .await;
    let project = service.json(&format!("/api/threads/{first}")).await["project_id"]
        .as_str()
        .unwrap()
        .to_owned();
    tokio::time::sleep(Duration::from_millis(20)).await;
    let latest = service.thread(&project, "codex").await;
    allow_links(&service, true).await;
    let mut stream = service.get("/api/shell/events").send().await.unwrap();
    let mut seen = String::new();

    let url = format!("http://127.0.0.1:{}/linked", serve_page());
    say(&mut service, &link(&url));
    let event = next_event(&mut stream, &mut seen).await;
    assert_eq!(event["type"], "show_preview", "{event}");
    assert_eq!(event["thread_id"], latest.as_str());
    let tabs = service
        .json(&format!("/api/threads/{latest}/previews"))
        .await;
    let tab = &tabs.as_array().unwrap()[0];
    assert_eq!(tab["id"], event["tab_id"]);
    assert_eq!(tab["url"], url);
    assert_eq!(
        service
            .json(&format!("/api/threads/{first}/previews"))
            .await,
        json!([])
    );
}
