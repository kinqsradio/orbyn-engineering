//! Preview tabs in a real headless Chrome, and servers a thread started.

#![cfg(unix)]

mod support;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::json;
use support::{Options, Service, TempDir, setup};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const PAGE: &str = "<!doctype html><title>t</title>\
<body style='margin:0;background:#fff'><button id=b style='width:400px;height:300px'>go</button>\
<script>document.getElementById('b').addEventListener('click',\
()=>{document.body.style.background='#f00';document.getElementById('b').remove()})</script>";

/// A one-page server, so the test needs no network.
fn serve_page() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut buffer = [0u8; 2048];
            let _ = stream.read(&mut buffer);
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{PAGE}",
                PAGE.len()
            );
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    port
}

async fn next_frame<S>(socket: &mut S) -> String
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let wait = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(Ok(message)) = socket.next().await {
            if let Message::Text(text) = message {
                return text.to_string();
            }
        }
        panic!("the stream ended");
    });
    wait.await.expect("no frame arrived")
}

async fn put_json(service: &Service, path: &str) -> u16 {
    service
        .client
        .delete(format!("{}{path}", service.url))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[tokio::test]
#[ignore = "needs an installed browser"]
async fn a_tab_streams_frames_and_a_person_must_take_it_to_click() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let port = serve_page();
    let base = format!("/api/threads/{thread}/previews");
    let (code, tab) = service
        .send(
            &base,
            json!({ "url": format!("http://127.0.0.1:{port}/"), "width": 600, "height": 400 }),
        )
        .await;
    assert_eq!(code, 201, "{tab}");
    assert_eq!(tab["control"], "none");
    let id = tab["id"].as_str().unwrap();
    let url = format!(
        "{}/ws/preview/{thread}/{id}?token={}",
        service.url.replacen("http", "ws", 1),
        service.token
    );
    let (mut socket, _) = connect_async(url).await.unwrap();
    let first = next_frame(&mut socket).await;
    assert!(first.starts_with("/9j/"), "a JPEG: {}", &first[..16]);
    let list = service.json(&base).await;
    assert_eq!(list[0]["viewers"], 1);

    let click = json!({ "kind": "click", "x": 100.0, "y": 100.0 });
    let (code, _) = service
        .send(&format!("{base}/{id}/input"), click.clone())
        .await;
    assert_eq!(code, 400, "watching gives no control");

    let (code, _) = service
        .send(&format!("{base}/{id}/recording"), json!({}))
        .await;
    assert_eq!(code, 204);
    let (code, held) = service
        .send(&format!("{base}/{id}/control"), json!({ "human": true }))
        .await;
    assert_eq!((code, held["control"].as_str()), (200, Some("human")));
    let (code, body) = service.send(&format!("{base}/{id}/input"), click).await;
    assert_eq!(code, 204, "{body}");
    let changed = next_frame(&mut socket).await;
    assert_ne!(changed, first, "the click changed the page");
    tokio::time::sleep(Duration::from_millis(500)).await;

    let stop = service
        .client
        .delete(format!("{}{base}/{id}/recording", service.url))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(stop.status(), 200);
    let recording: serde_json::Value = stop.json().await.unwrap();
    assert!(recording["frames"].as_u64().unwrap() >= 1, "{recording}");
    let folder = recording["path"].as_str().unwrap();
    let saved = std::fs::read(format!("{folder}/000000.jpg")).unwrap();
    assert_eq!(&saved[..3], [0xff, 0xd8, 0xff], "a real JPEG on disk");

    assert_eq!(put_json(&service, &format!("{base}/{id}")).await, 204);
    assert_eq!(service.json(&base).await.as_array().unwrap().len(), 0);
    tokio::time::sleep(Duration::from_millis(800)).await;
    let profiles = dir.path().join("data/preview-profiles").join(id);
    assert!(!profiles.exists(), "the profile goes with the tab");
    service.stop().await;
}

#[tokio::test]
async fn a_preview_refuses_other_schemes_and_an_untrusted_folder() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    let folder = dir.path().join("project");
    std::fs::create_dir_all(&folder).unwrap();
    let project = service.project(&folder, false).await;
    let thread = service.thread(&project, "codex").await;
    let base = format!("/api/threads/{thread}/previews");
    let (code, _) = service
        .send(&base, json!({ "url": "http://127.0.0.1:1/" }))
        .await;
    assert_eq!(code, 403);
    let (code, _) = service
        .send(&format!("/api/projects/{project}/trust"), json!({}))
        .await;
    assert_eq!(code, 200);
    let (code, _) = service
        .send(&base, json!({ "url": "file:///etc/passwd" }))
        .await;
    assert!(code >= 400, "{code}");
    assert_eq!(service.json(&base).await.as_array().unwrap().len(), 0);
    service.stop().await;
}

#[tokio::test]
async fn servers_are_those_running_from_the_checkout_and_only_they_can_be_stopped() {
    if std::process::Command::new("lsof")
        .arg("-v")
        .output()
        .is_err()
        || std::process::Command::new("python3")
            .arg("-V")
            .output()
            .is_err()
    {
        return;
    }
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let checkout = body["cwd"].as_str().unwrap();
    let listen =
        "import socket,time;s=socket.socket();s.bind(('127.0.0.1',0));s.listen();time.sleep(30)";
    let spawn = |cwd: &str| {
        std::process::Command::new("python3")
            .args(["-c", listen])
            .current_dir(cwd)
            .spawn()
            .unwrap()
    };
    let mut inside = spawn(checkout);
    let elsewhere = dir.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let mut outside = spawn(elsewhere.to_str().unwrap());
    let path = format!("/api/threads/{thread}/servers");
    let mut listed = serde_json::Value::Null;
    for _ in 0..100 {
        listed = service.json(&path).await;
        if !listed.as_array().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(listed.as_array().unwrap().len(), 1, "{listed}");
    assert_eq!(listed[0]["pid"], inside.id());
    assert_eq!(listed[0]["in_checkout"], true);
    let (code, _) = service
        .send(&format!("{path}/{}/stop", outside.id()), json!({}))
        .await;
    assert_eq!(code, 404, "another folder's server is out of reach");
    assert!(outside.try_wait().unwrap().is_none());
    let (code, _) = service
        .send(&format!("{path}/{}/stop", inside.id()), json!({}))
        .await;
    assert_eq!(code, 204);
    assert!(inside.wait().unwrap().code().is_none(), "it was signalled");
    outside.kill().unwrap();
    let _ = outside.wait();
    service.stop().await;
}
