//! Terminals through the real service: several per thread, read-only observers,
//! scrollback and project scripts.

#![cfg(unix)]

mod support;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use support::{Options, Service, TempDir, setup};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn socket(service: &Service, thread: &str, terminal: &str, observe: bool) -> Socket {
    let url = format!(
        "{}/ws/terminal/{thread}/{terminal}?token={}&observe={observe}",
        service.url.replacen("http", "ws", 1),
        service.token
    );
    connect_async(url).await.unwrap().0
}

async fn until_seen(socket: &mut Socket, text: &str) -> bool {
    let mut seen = String::new();
    tokio::time::timeout(Duration::from_secs(10), async {
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

async fn open(service: &Service, thread: &str, body: Value) -> Value {
    let (code, info) = service
        .send(&format!("/api/threads/{thread}/terminals"), body)
        .await;
    assert_eq!(code, 201, "{info}");
    info
}

#[tokio::test]
async fn a_thread_holds_several_terminals_with_their_own_output_and_splits() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let first = open(&service, &thread, json!({ "title": "One" })).await;
    let id = first["id"].as_str().unwrap();
    let second = open(
        &service,
        &thread,
        json!({ "split_of": id, "direction": "vertical" }),
    )
    .await;
    assert_eq!(second["group"], first["group"]);
    assert_eq!(second["direction"], "vertical");
    let other = second["id"].as_str().unwrap();

    let mut one = socket(&service, &thread, id, false).await;
    one.send(Message::binary(b"echo first-$((1+1))\r".to_vec()))
        .await
        .unwrap();
    assert!(until_seen(&mut one, "first-2").await);
    let back = service
        .json(&format!(
            "/api/threads/{thread}/terminals/{other}/scrollback"
        ))
        .await;
    assert!(!back["text"].as_str().unwrap().contains("first-2"));

    let list = service
        .json(&format!("/api/threads/{thread}/terminals"))
        .await;
    assert_eq!(list.as_array().unwrap().len(), 2);
    assert_eq!(list[0]["alive"], true);
    assert_eq!(list[0]["clients"], 1);

    let rename = service
        .client
        .patch(format!(
            "{}/api/threads/{thread}/terminals/{id}",
            service.url
        ))
        .bearer_auth(&service.token)
        .json(&json!({ "title": "Build" }))
        .send()
        .await
        .unwrap();
    assert_eq!(rename.status(), 200);
    let gone = service
        .client
        .delete(format!(
            "{}/api/threads/{thread}/terminals/{other}",
            service.url
        ))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), 204);
    let list = service
        .json(&format!("/api/threads/{thread}/terminals"))
        .await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["title"], "Build");
    let (code, _) = service.patch(&thread, json!({ "settled": true })).await;
    assert_eq!(code, 200);
    let list = service
        .json(&format!("/api/threads/{thread}/terminals"))
        .await;
    assert_eq!(list.as_array().unwrap().len(), 0, "settling closes them");
    service.stop().await;
}

#[tokio::test]
async fn an_observer_sees_output_and_cannot_type() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let info = open(&service, &thread, json!({})).await;
    let id = info["id"].as_str().unwrap();
    let mut owner = socket(&service, &thread, id, false).await;
    let mut observer = socket(&service, &thread, id, true).await;
    observer
        .send(Message::binary(b"echo intruder-$((3+4))\r".to_vec()))
        .await
        .unwrap();
    owner
        .send(Message::binary(b"echo owner-$((2+3))\r".to_vec()))
        .await
        .unwrap();
    assert!(until_seen(&mut observer, "owner-5").await);
    let back = service
        .json(&format!("/api/threads/{thread}/terminals/{id}/scrollback"))
        .await;
    assert!(!back["text"].as_str().unwrap().contains("intruder-7"));
    let cleared = service
        .client
        .delete(format!(
            "{}/api/threads/{thread}/terminals/{id}/scrollback",
            service.url
        ))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(cleared.status(), 204);
    let back = service
        .json(&format!("/api/threads/{thread}/terminals/{id}/scrollback"))
        .await;
    assert!(!back["text"].as_str().unwrap().contains("owner-5"));
    service.stop().await;
}

#[tokio::test]
async fn scripts_come_from_the_project_file_and_need_trust() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let cwd = std::path::PathBuf::from(body["cwd"].as_str().unwrap());
    std::fs::write(
        cwd.join("orbyn.json"),
        r#"{"scripts":[{"name":"Say hi","command":"echo script-$((5+6))"}]}"#,
    )
    .unwrap();
    let view = service
        .json(&format!("/api/threads/{thread}/scripts"))
        .await;
    assert_eq!(view["path"], "orbyn.json");
    assert_eq!(view["file"]["scripts"][0]["name"], "Say hi");
    let (code, info) = service
        .send(
            &format!("/api/threads/{thread}/scripts"),
            json!({ "name": "Say hi" }),
        )
        .await;
    assert_eq!(code, 201, "{info}");
    assert_eq!(info["script"], "Say hi");
    let id = info["id"].as_str().unwrap();
    let mut found = false;
    for _ in 0..400 {
        let back = service
            .json(&format!("/api/threads/{thread}/terminals/{id}/scrollback"))
            .await;
        if back["text"].as_str().unwrap().contains("script-11") {
            found = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(found, "the script's output stays readable");
    let (code, _) = service
        .send(
            &format!("/api/threads/{thread}/scripts"),
            json!({ "name": "Not there" }),
        )
        .await;
    assert_eq!(code, 404);
    let audit = service.audit(&thread).await;
    assert!(audit.iter().any(|row| row["action"] == "script.run"));
    service.stop().await;
}

#[tokio::test]
async fn an_untrusted_folder_opens_no_terminal() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    let folder = dir.path().join("project");
    std::fs::create_dir_all(&folder).unwrap();
    let project = service.project(&folder, false).await;
    let thread = service.thread(&project, "codex").await;
    let (code, body) = service
        .send(&format!("/api/threads/{thread}/terminals"), json!({}))
        .await;
    assert_eq!(
        (code, body["code"].as_str()),
        (403, Some("folder_untrusted"))
    );
    service.stop().await;
}
