//! The update channel through the real binary and its real stdin and stdout.

mod support;

use std::io::{BufRead, Write};
use std::time::Duration;

use serde_json::{Value, json};
use support::{Options, Service, TempDir, setup};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn desktop() -> Options {
    Options {
        args: vec!["--parent-stdin".into()],
        ..Options::default()
    }
}

fn say(service: &mut Service, line: &str) {
    let stdin = service.child.stdin.as_mut().unwrap();
    writeln!(stdin, "{line}").unwrap();
    stdin.flush().unwrap();
}

async fn app(service: &Service) -> Value {
    service.json("/api/updates").await["app"].clone()
}

async fn until_can_apply(service: &Service) {
    for _ in 0..500 {
        if app(service).await["can_apply"] == true {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the shell's message never arrived");
}

#[tokio::test]
async fn shell_channel_survives_junk_and_install_holds_admission() {
    let dir = TempDir::new();
    let (mut service, thread) = setup(&dir, desktop(), "codex").await;
    assert_eq!(app(&service).await["mode"], "desktop");
    say(&mut service, "not json at all");
    say(&mut service, r#"{"type":"from_the_future","x":1}"#);
    say(
        &mut service,
        r#"{"type":"app_update_available","version":"99.0.0","notes":"n"}"#,
    );
    until_can_apply(&service).await;
    assert_eq!(app(&service).await["latest"], "99.0.0");

    let run = service.admit(&thread, "[hang]").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (code, body) = service.send("/api/updates/app/apply", json!({})).await;
    assert_eq!(code, 409);
    assert_eq!(body["code"], "runs_active");
    service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    service.finished(&thread).await;

    let (code, _) = service.send("/api/updates/app/apply", json!({})).await;
    assert_eq!(code, 202);
    let mut line = String::new();
    while !line.contains("install_app_update") {
        line.clear();
        service.stdout.read_line(&mut line).unwrap();
        assert!(!line.is_empty(), "stdout closed");
    }
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap()["type"],
        "install_app_update"
    );
    let (code, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "x" }),
        )
        .await;
    assert_eq!(code, 503);
    assert_eq!(body["code"], "updating");
}

#[tokio::test]
async fn server_compares_a_release_manifest_and_keeps_it_when_it_disappears() {
    let dir = TempDir::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = [0u8; 2048];
        let _ = socket.read(&mut buffer).await;
        let body = r#"{"version":"99.0.0","notes":"Big release"}"#;
        let reply = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(reply.as_bytes()).await.unwrap();
    });
    let service = Service::start(
        &dir.path().join("data"),
        Options {
            args: vec![
                "--update-manifest".into(),
                format!("http://127.0.0.1:{port}/manifest.json"),
            ],
            ..Options::default()
        },
    );
    server.await.unwrap();
    for _ in 0..500 {
        if app(&service).await["latest"] == "99.0.0" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let status = app(&service).await;
    assert_eq!(status["latest"], "99.0.0");
    assert_eq!(status["notes"], "Big release");
    assert_eq!(status["can_apply"], false, "a server cannot replace itself");
    assert_eq!(status["unconfigured"], false);

    let (code, after) = service.send("/api/updates/check", json!({})).await;
    assert_eq!(code, 200);
    assert_eq!(after["app"]["latest"], "99.0.0");
    assert!(after["error"].as_str().unwrap().contains("manifest"));
    let (code, _) = service.send("/api/updates/app/apply", json!({})).await;
    assert_eq!(code, 422);
}

#[tokio::test]
async fn update_events_send_the_status_then_each_change() {
    let dir = TempDir::new();
    let (mut service, _) = setup(&dir, desktop(), "codex").await;
    let response = service
        .get("/api/updates/events")
        .header("Accept", "text/event-stream")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let mut body = response.bytes_stream();
    let mut parser = orbyn_core::sse::SseParser::default();
    use futures_util::StreamExt;
    say(
        &mut service,
        r#"{"type":"app_update_available","version":"99.0.0"}"#,
    );
    let found = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(Ok(chunk)) = body.next().await {
            for frame in parser.push(&chunk) {
                let status: Value = serde_json::from_str(&frame).unwrap();
                if status["app"]["latest"] == "99.0.0" {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap();
    assert!(found);
}

#[tokio::test]
async fn a_link_waits_for_the_window_and_arrives_as_a_route() {
    let dir = TempDir::new();
    let (mut service, _thread) = setup(&dir, desktop(), "codex").await;
    let status = service.json("/api/shell").await;
    assert_eq!(status["attached"], true);
    assert_eq!(status["windows"], 0);
    say(
        &mut service,
        r#"{"type":"open_link","url":"orbyn://run/start"}"#,
    );
    say(
        &mut service,
        r#"{"type":"open_link","url":"orbyn://thread/t1"}"#,
    );
    say(&mut service, r#"{"type":"app_update_none"}"#);
    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut stream = service.get("/api/shell/events").send().await.unwrap();
    let mut seen = String::new();
    while !seen.contains("\n\n") {
        let chunk = tokio::time::timeout(Duration::from_secs(5), stream.chunk())
            .await
            .expect("the held link never arrived")
            .unwrap()
            .expect("the stream closed");
        seen.push_str(&String::from_utf8_lossy(&chunk));
    }
    assert!(
        seen.contains(r##"{"type":"navigate","href":"#/threads/t1"}"##),
        "{seen}"
    );
    assert_eq!(service.json("/api/shell").await["windows"], 1);
}

#[tokio::test]
async fn a_window_reaches_the_shell_only_through_listed_actions() {
    let dir = TempDir::new();
    let (mut service, _thread) = setup(&dir, desktop(), "codex").await;
    let (code, _) = service
        .send("/api/shell/actions", json!({ "action": "zoom_in" }))
        .await;
    assert_eq!(code, 202);
    let mut line = String::new();
    while !line.contains("shell_action") {
        line.clear();
        service.stdout.read_line(&mut line).unwrap();
        assert!(!line.is_empty(), "stdout closed");
    }
    assert!(line.contains("zoom_in"), "{line}");
    let (code, _) = service
        .send("/api/shell/actions", json!({ "action": "open_anything" }))
        .await;
    assert_eq!(code, 400);

    let dir = TempDir::new();
    let (server, _thread) = setup(&dir, Options::default(), "codex").await;
    let (code, _) = server
        .send("/api/shell/actions", json!({ "action": "zoom_in" }))
        .await;
    assert_eq!(code, 422);
    assert_eq!(server.json("/api/shell").await["attached"], false);
}

#[tokio::test]
async fn the_shell_hears_when_work_starts_and_ends() {
    let dir = TempDir::new();
    let (mut service, thread) = setup(&dir, desktop(), "codex").await;
    let activity = async |service: &mut Service, running: u64| {
        let mut line = String::new();
        loop {
            line.clear();
            service.stdout.read_line(&mut line).unwrap();
            assert!(!line.is_empty(), "stdout closed");
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value["type"] == "activity" && value["running"] == running {
                return value;
            }
        }
    };
    let run = service.admit(&thread, "[hang]").await;
    let seen = activity(&mut service, 1).await;
    assert_eq!(seen["keep_awake"], true);
    assert_eq!(seen["waiting"], 0);
    service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    service.finished(&thread).await;
    let seen = activity(&mut service, 0).await;
    assert_eq!(seen["keep_awake"], false);
}
