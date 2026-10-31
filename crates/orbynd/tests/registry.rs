//! The ACP registry against a local server, and an installed agent running a turn.

mod support;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;

use serde_json::{Value, json};
#[cfg(unix)]
use sha2::{Digest, Sha256};
#[cfg(unix)]
use support::{FAKE, text_of};
use support::{Options, TempDir, setup};

/// Serves `registry.json` and any file in `folder`, so nothing leaves this machine.
fn serve(folder: &Path, registry: impl Fn(u16) -> Value + Send + 'static) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let folder = folder.to_path_buf();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut buffer = [0u8; 2048];
            let read = stream.read(&mut buffer).unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
            let path = request.split_whitespace().nth(1).unwrap_or("/").to_owned();
            let body = if path == "/registry.json" {
                registry(port).to_string().into_bytes()
            } else {
                std::fs::read(folder.join(path.trim_start_matches('/'))).unwrap_or_default()
            };
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
        }
    });
    port
}

fn options(port: u16) -> Options {
    Options {
        env: vec![(
            "ORBYN_ACP_REGISTRY_URL".into(),
            format!("http://127.0.0.1:{port}/registry.json"),
        )],
        ..Options::default()
    }
}

#[cfg(unix)]
fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

#[cfg(unix)]
fn digest(path: &Path) -> String {
    orbyn_core::util::hex(&Sha256::digest(std::fs::read(path).unwrap()))
}

/// An archive whose agent is the fake engine in ACP mode.
#[cfg(unix)]
fn pack_agent(dir: &Path) -> std::path::PathBuf {
    let source = dir.join("source");
    std::fs::create_dir_all(source.join("bin")).unwrap();
    std::fs::write(
        source.join("bin/agent"),
        format!("#!/bin/sh\nexec '{FAKE}' acp\n"),
    )
    .unwrap();
    let archive = dir.join("agent.tar.gz");
    let status = std::process::Command::new("tar")
        .args(["-czf"])
        .arg(&archive)
        .arg("-C")
        .arg(&source)
        .arg("bin")
        .status()
        .unwrap();
    assert!(status.success());
    archive
}

#[cfg(unix)]
#[tokio::test]
async fn a_checked_binary_installs_runs_a_turn_and_removes_cleanly() {
    let dir = TempDir::new();
    let files = dir.path().join("served");
    std::fs::create_dir_all(&files).unwrap();
    let archive = pack_agent(&files);
    let sum = digest(&archive);
    let key = platform();
    let port = serve(&files, move |port| {
        let archive = format!("http://127.0.0.1:{port}/agent.tar.gz");
        json!({ "agents": [
            { "id": "good", "name": "Good Agent", "version": "1.0.0", "description": "Helpful",
              "distribution": { "binary": { &key: {
                  "archive": archive, "cmd": "bin/agent", "sha256": sum,
              }}}},
            { "id": "wrong", "name": "Wrong Sum", "version": "1.0.0",
              "distribution": { "binary": { &key: {
                  "archive": archive, "cmd": "bin/agent", "sha256": "0".repeat(64),
              }}}},
            { "id": "unsummed", "name": "No Sum", "version": "1.0.0",
              "distribution": { "binary": { &key: { "archive": archive, "cmd": "bin/agent" }}}},
            { "id": "climber", "name": "Climber", "version": "1.0.0",
              "distribution": { "binary": { &key: {
                  "archive": archive, "cmd": "../../outside", "sha256": sum,
              }}}},
            { "id": "../evil", "name": "Evil", "version": "1.0.0" },
        ]})
    });
    let (service, thread) = setup(&dir, options(port), "codex").await;

    let all = service.json("/api/acp/registry").await;
    let names: Vec<&str> = all
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["id"].as_str())
        .collect();
    assert_eq!(names, ["good", "wrong", "unsummed", "climber"], "{all}");
    assert_eq!(all[0]["installable"], json!(["binary"]));
    assert_eq!(all[2]["installable"], json!([]), "no digest, no install");
    let found = service.json("/api/acp/registry?q=helpful").await;
    assert_eq!(found.as_array().unwrap().len(), 1);

    let (code, body) = service.send("/api/acp/registry/wrong", json!({})).await;
    assert_eq!(code, 422, "{body}");
    assert!(body["message"].as_str().unwrap().contains("digest"));
    let (code, _) = service.send("/api/acp/registry/unsummed", json!({})).await;
    assert_eq!(code, 422);
    let (code, _) = service.send("/api/acp/registry/climber", json!({})).await;
    assert_eq!(code, 422);
    let (code, _) = service.send("/api/acp/registry/none", json!({})).await;
    assert_eq!(code, 404);
    let (code, _) = service
        .send("/api/acp/registry/good", json!({ "distribution": "uvx" }))
        .await;
    assert_eq!(code, 422, "not offered that way");
    let left = dir.path().join("data/acp-agents");
    for agent in ["wrong", "climber"] {
        let folder = left.join(agent);
        let leftovers = std::fs::read_dir(&folder).map_or(0, Iterator::count);
        assert_eq!(leftovers, 0, "{agent} left files");
    }

    let (code, engine) = service.send("/api/acp/registry/good", json!({})).await;
    assert_eq!(code, 201, "{engine}");
    assert_eq!(engine["id"], "acp-good");
    let listed = service.json("/api/acp/registry?q=good").await;
    assert_eq!(listed[0]["engine"], "acp-good");

    let body = service.json(&format!("/api/threads/{thread}")).await;
    let run_on = service
        .thread(body["project_id"].as_str().unwrap(), "acp-good")
        .await;
    service.admit(&run_on, "hi").await;
    assert_eq!(service.finished(&run_on).await, "completed");
    assert!(!text_of(&service.all_events(&run_on).await).is_empty());

    let response = service
        .client
        .delete(format!("{}/api/acp/registry/good", service.url))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);
    assert!(!left.join("good").exists());
    let engines = service.json("/api/engines").await;
    assert!(
        !engines
            .as_array()
            .unwrap()
            .iter()
            .any(|engine| engine["id"] == "acp-good")
    );
    let again = service
        .client
        .delete(format!("{}/api/acp/registry/good", service.url))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 404);
    service.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_package_agent_goes_through_its_tool_and_a_flag_cannot_pose_as_a_package() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new();
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let npx = bin.join("npx");
    std::fs::write(&npx, format!("#!/bin/sh\nexec '{FAKE}' acp\n")).unwrap();
    std::fs::set_permissions(&npx, std::fs::Permissions::from_mode(0o755)).unwrap();
    let port = serve(dir.path(), |_| {
        json!({ "agents": [
            { "id": "pkg", "name": "Pkg", "version": "2.0.0",
              "distribution": { "npx": { "package": "@acme/agent@2.0.0", "args": ["--acp"] }}},
            { "id": "flag", "name": "Flag", "version": "2.0.0",
              "distribution": { "npx": { "package": "--registry=http://evil" }}},
        ]})
    });
    let mut options = options(port);
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    options.env.push(("PATH".into(), path));
    let (service, _) = setup(&dir, options, "codex").await;
    let (code, body) = service.send("/api/acp/registry/flag", json!({})).await;
    assert_eq!(code, 422, "{body}");
    let (code, engine) = service.send("/api/acp/registry/pkg", json!({})).await;
    assert_eq!(code, 201, "{engine}");
    let audit = service.json("/api/audit?limit=200").await;
    assert!(
        audit
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["action"] == "acp.install" && row["target"] == "pkg")
    );
    service.stop().await;
}

#[tokio::test]
async fn a_registry_that_is_down_or_garbled_is_reported() {
    let dir = TempDir::new();
    let port = serve(dir.path(), |_| json!("not a registry"));
    let (service, _) = setup(&dir, options(port), "codex").await;
    let response = service.get("/api/acp/registry").send().await.unwrap();
    assert_eq!(response.status(), 502);
    service.stop().await;

    let other = TempDir::new();
    let options = Options {
        env: vec![(
            "ORBYN_ACP_REGISTRY_URL".into(),
            "http://example.com/registry.json".into(),
        )],
        ..Options::default()
    };
    let (service, _) = setup(&other, options, "codex").await;
    let response = service.get("/api/acp/registry").send().await.unwrap();
    assert_eq!(response.status(), 400, "plain http off this machine");
    service.stop().await;
}
