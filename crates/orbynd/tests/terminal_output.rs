//! Terminal output completion is independent from direct-child exit.
mod support;

use std::path::PathBuf;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::json;
use support::{Options, Service, TempDir, setup};
use tokio_tungstenite::{connect_async, tungstenite::Message};

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct ReleaseOutput(PathBuf);
impl Drop for ReleaseOutput {
    fn drop(&mut self) {
        let _ = std::fs::write(self.0.join("release-output"), "release");
    }
}

async fn receive_to_close(
    socket: &mut Socket,
    service: &Service,
    thread: &str,
    id: &str,
) -> String {
    let mut received = String::new();
    let closed = tokio::time::timeout(Duration::from_secs(45), async {
        while let Some(frame) = socket.next().await {
            match frame.unwrap() {
                Message::Binary(bytes) => received.push_str(&String::from_utf8_lossy(&bytes)),
                Message::Close(_) => return,
                _ => {}
            }
        }
        panic!("terminal ended without its WebSocket close frame");
    })
    .await;
    if closed.is_err() {
        // Keep the close deadline unchanged. On failure distinguish a missing
        // final read from a completed child whose observer never received EOF.
        let state = tokio::time::timeout(Duration::from_secs(2), async {
            let terminals = service
                .json(&format!("/api/threads/{thread}/terminals"))
                .await;
            let terminal = terminals
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["id"] == id));
            json!({
                "alive": terminal.map(|row| &row["alive"]),
                "exit_code": terminal.map(|row| &row["exit_code"]),
            })
        })
        .await;
        panic!(
            "terminal observer did not close: received_bytes={}, final_marker={}, state={state:?}",
            received.len(),
            received.contains("final-output-finished"),
        );
    }
    received
}

#[tokio::test]
async fn final_action_output_and_late_observer_replay_are_delivered_before_close() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let thread_info = service.json(&format!("/api/threads/{thread}")).await;
    let cwd = PathBuf::from(thread_info["cwd"].as_str().unwrap());
    let _release = ReleaseOutput(cwd.clone());
    std::fs::write(
        cwd.join("output.cjs"),
        r#"
const fs = require('node:fs');
process.stdout.write('observer-ready\n');
const gate = setInterval(() => {
  if (fs.existsSync('release-output')) {
    clearInterval(gate);
    process.stdout.write('x'.repeat(96 * 1024) + 'final-output-finished\n', () => process.exit(0));
  }
}, 10);
setTimeout(() => process.exit(72), 30000).unref();
"#,
    )
    .unwrap();
    std::fs::write(
        cwd.join("orbyn.json"),
        json!({"scripts":[{"name":"Final output", "command":"node output.cjs"}]}).to_string(),
    )
    .unwrap();
    let (code, terminal) = service
        .send(
            &format!("/api/threads/{thread}/scripts"),
            json!({"name":"Final output"}),
        )
        .await;
    assert_eq!(code, 201, "{terminal}");
    let id = terminal["id"].as_str().unwrap();
    let url = format!(
        "{}/ws/terminal/{thread}/{id}?token={}&observe=true",
        service.url.replacen("http", "ws", 1),
        service.token
    );
    let (mut socket, _) = connect_async(&url).await.unwrap();
    let mut received = tokio::time::timeout(Duration::from_secs(45), async {
        let mut text = String::new();
        while let Some(Ok(frame)) = socket.next().await {
            if let Message::Binary(bytes) = frame {
                text.push_str(&String::from_utf8_lossy(&bytes));
                if text.contains("observer-ready") {
                    return text;
                }
            }
        }
        panic!("observer closed before the output gate");
    })
    .await
    .unwrap();
    std::fs::write(cwd.join("release-output"), "release").unwrap();
    received.push_str(&receive_to_close(&mut socket, &service, &thread, id).await);
    let back = service
        .json(&format!("/api/threads/{thread}/terminals/{id}/scrollback"))
        .await;
    assert!(
        received.contains("final-output-finished"),
        "observer closed before final stdout"
    );
    assert_eq!(received, back["text"].as_str().unwrap());
    let (mut late, _) = connect_async(&url).await.unwrap();
    assert_eq!(
        receive_to_close(&mut late, &service, &thread, id).await,
        received,
        "a completed terminal replays once and closes"
    );
    service.stop().await;
}

#[tokio::test]
async fn explicit_close_finishes_an_observer_while_a_process_holds_the_pty() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let thread_info = service.json(&format!("/api/threads/{thread}")).await;
    let cwd = PathBuf::from(thread_info["cwd"].as_str().unwrap());
    let _release = ReleaseOutput(cwd.clone());
    std::fs::write(
        cwd.join("holding.cjs"),
        r#"
const fs = require('node:fs');
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', `
  const fs = require('node:fs');
  process.stdout.write('descendant-holds-output\\n');
  const gate = setInterval(() => {
    if (fs.existsSync('release-output')) { clearInterval(gate); process.exit(0); }
  }, 10);
  setTimeout(() => process.exit(72), 30000).unref();
`], { stdio: 'inherit' });
const gate = setInterval(() => {
  if (fs.existsSync('release-output')) { clearInterval(gate); process.exit(0); }
}, 10);
setTimeout(() => process.exit(73), 30000).unref();
"#,
    )
    .unwrap();
    std::fs::write(
        cwd.join("orbyn.json"),
        json!({"scripts":[{"name":"Holding output", "command":"node holding.cjs"}]}).to_string(),
    )
    .unwrap();
    let (code, terminal) = service
        .send(
            &format!("/api/threads/{thread}/scripts"),
            json!({"name":"Holding output"}),
        )
        .await;
    assert_eq!(code, 201, "{terminal}");
    let id = terminal["id"].as_str().unwrap();
    let url = format!(
        "{}/ws/terminal/{thread}/{id}?token={}&observe=true",
        service.url.replacen("http", "ws", 1),
        service.token
    );
    let (mut socket, _) = connect_async(&url).await.unwrap();
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut text = String::new();
        while let Some(Ok(frame)) = socket.next().await {
            if let Message::Binary(bytes) = frame {
                text.push_str(&String::from_utf8_lossy(&bytes));
                if text.contains("descendant-holds-output") {
                    return;
                }
            }
        }
        panic!("descendant did not retain the PTY before close");
    })
    .await
    .unwrap();
    let response = service
        .client
        .delete(format!(
            "{}/api/threads/{thread}/terminals/{id}",
            service.url
        ))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    receive_to_close(&mut socket, &service, &thread, id).await;
    assert!(
        service
            .json(&format!("/api/threads/{thread}/terminals"))
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
    service.stop().await;
}
