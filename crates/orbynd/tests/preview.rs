//! Preview tabs in a real headless Chrome, and servers a thread started.

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
/// Opens a dialog once it has loaded, which holds the page until it is answered.
const ALERT_PAGE: &str = "<script>setTimeout(() => alert('hi'), 1500)</script>";

fn serve_page() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut buffer = [0u8; 2048];
            let _ = stream.read(&mut buffer);
            let page = if buffer.starts_with(b"GET /alert") {
                ALERT_PAGE
            } else {
                PAGE
            };
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{page}",
                page.len()
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

fn decode(text: &str) -> Vec<u8> {
    let value = |byte: u8| match byte {
        b'A'..=b'Z' => byte - b'A',
        b'a'..=b'z' => byte - b'a' + 26,
        b'0'..=b'9' => byte - b'0' + 52,
        b'+' => 62,
        _ => 63,
    };
    let mut out = Vec::new();
    let (mut bits, mut count) = (0u32, 0);
    for byte in text.bytes().filter(|byte| *byte != b'=') {
        bits = (bits << 6) | u32::from(value(byte));
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    out
}

/// Width and height from a JPEG's start-of-frame marker.
fn jpeg_size(bytes: &[u8]) -> (u32, u32) {
    let mut at = 2;
    while at + 9 < bytes.len() {
        let marker = bytes[at + 1];
        let length = usize::from(bytes[at + 2]) << 8 | usize::from(bytes[at + 3]);
        if (0xc0..=0xc2).contains(&marker) {
            let height = u32::from(bytes[at + 5]) << 8 | u32::from(bytes[at + 6]);
            let width = u32::from(bytes[at + 7]) << 8 | u32::from(bytes[at + 8]);
            return (width, height);
        }
        at += 2 + length;
    }
    panic!("no frame header");
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

    // Back, forward and size, on a second address of the same server.
    let step = |back: bool| json!({ "back": back });
    let history = format!("{base}/{id}/history");
    let (code, stayed) = service.send(&history, step(true)).await;
    assert_eq!(code, 200, "{stayed}");
    assert_eq!(
        stayed["can_go_back"], false,
        "the blank page does not count"
    );
    let (_, there) = service
        .send(
            &format!("{base}/{id}/navigate"),
            json!({ "url": format!("http://127.0.0.1:{port}/second") }),
        )
        .await;
    assert_eq!(there["can_go_back"], true);
    let (_, back) = service.send(&history, step(true)).await;
    assert_eq!(back["url"], format!("http://127.0.0.1:{port}/"));
    assert_eq!(back["can_go_forward"], true);
    let (_, forward) = service.send(&history, step(false)).await;
    assert_eq!(forward["url"], format!("http://127.0.0.1:{port}/second"));
    assert_eq!(forward["can_go_forward"], false);

    let (code, resized) = service
        .send(
            &format!("{base}/{id}/resize"),
            json!({ "width": 320, "height": 240 }),
        )
        .await;
    assert_eq!(code, 200, "{resized}");
    assert_eq!(
        (resized["width"].as_u64(), resized["height"].as_u64()),
        (Some(320), Some(240))
    );
    let framed = next_frame(&mut socket).await;
    let jpeg = decode(&framed);
    assert_eq!(jpeg_size(&jpeg), (320, 240), "a frame at the new size");
    let (code, _) = service
        .send(
            &format!("{base}/{id}/resize"),
            json!({ "width": 0, "height": 240 }),
        )
        .await;
    assert_eq!(code, 400);

    assert_eq!(put_json(&service, &format!("{base}/{id}")).await, 204);
    assert_eq!(service.json(&base).await.as_array().unwrap().len(), 0);
    tokio::time::sleep(Duration::from_millis(800)).await;
    let profiles = dir.path().join("data/preview-profiles").join(id);
    assert!(!profiles.exists(), "the profile goes with the tab");
    service.stop().await;
}

#[tokio::test]
#[ignore = "needs an installed browser"]
async fn an_agent_records_a_page_in_its_own_tab() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let (code, _) = service
        .patch(&thread, json!({ "permission_mode": "full_access" }))
        .await;
    assert_eq!(code, 200);
    let port = serve_page();
    let mut seen = None;
    let mut call = async |name: &str, args: serde_json::Value| {
        service
            .admit(&thread, &format!("[mcp-call:{name}]{args}[/mcp-call]"))
            .await;
        let events = service
            .events_until(&thread, seen, |event| {
                event["event"]["type"] == "RUN_FINISHED"
            })
            .await;
        seen = events.last().unwrap()["seq"].as_i64();
        service.finished(&thread).await;
        let text = support::text_of(&events);
        assert!(text.contains("tool error=false"), "{name}: {text}");
        let reply = text.rsplit("tool error=false ").next().unwrap().trim();
        serde_json::from_str::<serde_json::Value>(reply).unwrap()
    };
    let tab = call(
        "orbyn_preview_open",
        json!({ "url": format!("http://127.0.0.1:{port}/") }),
    )
    .await;
    let id = tab["id"].as_str().unwrap().to_owned();
    let listed = call("orbyn_preview_list", json!({})).await;
    assert_eq!(listed[0]["id"], id.as_str());
    call("orbyn_preview_recording_start", json!({ "tab_id": id })).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    let done = call("orbyn_preview_recording_stop", json!({ "tab_id": id })).await;
    assert!(done["frames"].as_u64().unwrap() >= 1, "{done}");
    let moved = call(
        "orbyn_preview_navigate",
        json!({ "tab_id": id, "url": format!("http://127.0.0.1:{port}/two") }),
    )
    .await;
    assert_eq!(moved["can_go_back"], true);
    let back = call(
        "orbyn_preview_navigate",
        json!({ "tab_id": id, "back": true }),
    )
    .await;
    assert_eq!(back["url"], format!("http://127.0.0.1:{port}/"));
    let shown = call(
        "orbyn_preview_set_appearance",
        json!({ "tab_id": id, "appearance": "dark" }),
    )
    .await;
    assert_eq!(shown["appearance"], "dark");
    let status = call("orbyn_preview_status", json!({ "tab_id": id })).await;
    assert_eq!(status["id"], id.as_str());
    assert_eq!(status["appearance"], "dark");
    let none = call(
        "orbyn_preview_dialog",
        json!({ "tab_id": id, "accept": true }),
    )
    .await;
    assert_eq!(none["handled"], false);
    call(
        "orbyn_preview_navigate",
        json!({ "tab_id": id, "url": format!("http://127.0.0.1:{port}/alert") }),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(2000)).await;
    let answered = call(
        "orbyn_preview_dialog",
        json!({ "tab_id": id, "accept": true }),
    )
    .await;
    assert_eq!(answered["handled"], true);
    call("orbyn_preview_close", json!({ "tab_id": id })).await;
    service.stop().await;
}

#[tokio::test]
async fn preview_controls_refuse_an_unknown_tab_and_a_bad_size() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let base = format!("/api/threads/{thread}/previews");
    let (code, _) = service
        .send(&format!("{base}/none/history"), json!({ "back": true }))
        .await;
    assert_eq!(code, 404);
    let (code, _) = service
        .send(
            &format!("{base}/none/resize"),
            json!({ "width": 320, "height": 240 }),
        )
        .await;
    assert_eq!(code, 404);
    for (width, height) in [(0, 240), (320, 99), (5000, 240)] {
        let (code, _) = service
            .send(
                &format!("{base}/none/resize"),
                json!({ "width": width, "height": height }),
            )
            .await;
        assert_eq!(code, 400, "{width}x{height}");
        let (code, _) = service
            .send(
                &base,
                json!({ "url": "http://127.0.0.1:1/", "width": width, "height": height }),
            )
            .await;
        assert_eq!(code, 400, "{width}x{height}");
    }
    let (code, _) = service
        .send(&format!("{base}/none/history"), json!({}))
        .await;
    assert_eq!(code, 400);
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

/// A listener that holds for 30 seconds, from a program every machine of this kind has.
fn listener_in(cwd: &str) -> std::process::Child {
    let mut command = if cfg!(windows) {
        let mut command = std::process::Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$l.Start();Start-Sleep 30",
        ]);
        command
    } else {
        let mut command = std::process::Command::new("python3");
        command.args([
            "-c",
            "import socket,time;s=socket.socket();s.bind(('127.0.0.1',0));s.listen();time.sleep(30)",
        ]);
        command
    };
    command.current_dir(cwd).spawn().unwrap()
}

#[tokio::test]
async fn servers_are_those_running_from_the_checkout_and_only_they_can_be_stopped() {
    if cfg!(unix)
        && (std::process::Command::new("lsof")
            .arg("-v")
            .output()
            .is_err()
            || std::process::Command::new("python3")
                .arg("-V")
                .output()
                .is_err())
    {
        return;
    }
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let body = service.json(&format!("/api/threads/{thread}")).await;
    let checkout = body["cwd"].as_str().unwrap();
    let mut inside = listener_in(checkout);
    let elsewhere = dir.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let mut outside = listener_in(elsewhere.to_str().unwrap());
    let path = format!("/api/threads/{thread}/servers");
    let row_of = |listed: &serde_json::Value, pid: u32| {
        listed
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["pid"] == pid)
            .cloned()
    };
    let mut listed = serde_json::Value::Null;
    for _ in 0..200 {
        listed = service.json(&path).await;
        if row_of(&listed, inside.id()).is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let row = row_of(&listed, inside.id()).unwrap_or_else(|| panic!("{listed}"));
    assert_eq!(row["in_checkout"], true);
    assert!(row_of(&listed, outside.id()).is_none(), "{listed}");
    let (code, _) = service
        .send(&format!("{path}/{}/stop", outside.id()), json!({}))
        .await;
    assert_eq!(code, 404, "another folder's server is out of reach");
    assert!(outside.try_wait().unwrap().is_none());
    let (code, _) = service
        .send(&format!("{path}/{}/stop", inside.id()), json!({}))
        .await;
    assert_eq!(code, 204);
    let status = inside.wait().unwrap();
    assert!(!status.success(), "it was stopped before it finished");
    outside.kill().unwrap();
    let _ = outside.wait();
    service.stop().await;
}

#[tokio::test]
#[ignore = "needs an installed browser"]
async fn a_tab_is_shown_as_asked_and_reads_an_element() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let port = serve_page();
    let base = format!("/api/threads/{thread}/previews");
    let (code, tab) = service
        .send(
            &base,
            json!({ "url": format!("http://127.0.0.1:{port}/"), "width": 600, "height": 400, "private": true }),
        )
        .await;
    assert_eq!(code, 201, "{tab}");
    assert_eq!(tab["private"], true);
    assert_eq!(tab["opened_by"], "person");
    assert_eq!(tab["title"], "t");
    let at = format!("{base}/{}", tab["id"].as_str().unwrap());

    let (code, view) = service
        .send(
            &format!("{at}/view"),
            json!({ "zoom": 2.0, "appearance": "dark", "mobile": true }),
        )
        .await;
    assert_eq!(code, 200, "{view}");
    assert_eq!(
        (view["zoom"].as_f64(), view["mobile"].as_bool()),
        (Some(2.0), Some(true))
    );
    let (code, _) = service
        .send(&format!("{at}/view"), json!({ "zoom": 9.0 }))
        .await;
    assert_eq!(code, 400);

    // The button is 400 wide and the page is at twice its size.
    let (code, picked) = service
        .send(&format!("{at}/pick"), json!({ "x": 100.0, "y": 100.0 }))
        .await;
    assert_eq!(code, 200, "{picked}");
    assert_eq!(picked["tag"], "button");
    assert_eq!(picked["selector"], "#b");
    assert_eq!(picked["text"], "go");

    let (code, _) = service
        .send(&format!("{at}/reload"), json!({ "hard": true }))
        .await;
    assert_eq!(code, 200);
    let (code, _) = service
        .send(
            &format!("{at}/clear"),
            json!({ "cookies": true, "cache": true }),
        )
        .await;
    assert_eq!(code, 204);
    service.stop().await;
}

#[tokio::test]
#[ignore = "needs an installed browser"]
async fn a_named_profile_outlives_its_tab_and_holds_one_at_a_time() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let port = serve_page();
    let url = format!("http://127.0.0.1:{port}/");
    let base = format!("/api/threads/{thread}/previews");
    let (code, profile) = service
        .send("/api/browser-profiles", json!({ "name": "Work" }))
        .await;
    assert_eq!(code, 201, "{profile}");
    let id = profile["id"].as_str().unwrap();
    let (code, tab) = service
        .send(&base, json!({ "url": url, "profile": id }))
        .await;
    assert_eq!(code, 201, "{tab}");
    let (code, _) = service
        .send(&base, json!({ "url": url, "profile": id }))
        .await;
    assert_eq!(code, 400, "the browser has it locked");
    assert_eq!(
        service.json("/api/browser-profiles").await[0]["in_use"],
        true
    );
    let (code, _) = service
        .send(&format!("/api/browser-profiles/{id}/clear"), json!({}))
        .await;
    assert_eq!(code, 400, "not while a tab has it");

    let closed = service
        .client
        .delete(format!(
            "{}{base}/{}",
            service.url,
            tab["id"].as_str().unwrap()
        ))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(closed.status(), 204);
    let folder = dir.path().join("data/browser-profiles").join(id);
    assert!(folder.exists(), "a named profile stays");
    let (code, _) = service
        .send(&format!("/api/browser-profiles/{id}/clear"), json!({}))
        .await;
    assert_eq!(code, 204);
    assert!(!folder.exists());
    assert_eq!(
        service.json("/api/browser-profiles").await[0]["name"],
        "Work"
    );
    let gone = service
        .client
        .delete(format!("{}/api/browser-profiles/{id}", service.url))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), 204);
    assert_eq!(service.json("/api/browser-profiles").await, json!([]));
    service.stop().await;
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "needs an installed browser"]
async fn a_crashed_browser_comes_back_on_its_page() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let port = serve_page();
    let base = format!("/api/threads/{thread}/previews");
    let (code, tab) = service
        .send(&base, json!({ "url": format!("http://127.0.0.1:{port}/") }))
        .await;
    assert_eq!(code, 201, "{tab}");
    let id = tab["id"].as_str().unwrap();
    let url = format!(
        "{}/ws/preview/{thread}/{id}?token={}",
        service.url.replacen("http", "ws", 1),
        service.token
    );
    let (mut socket, _) = connect_async(url).await.unwrap();
    next_frame(&mut socket).await;
    let killed = std::process::Command::new("pkill")
        .args(["-9", "-f", &format!("preview-profiles/{id}")])
        .status()
        .unwrap();
    assert!(killed.success());
    // The page didn't change, so only a working browser proves it came back.
    let mut working = false;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let (code, reloaded) = service
            .send(&format!("{base}/{id}/reload"), json!({}))
            .await;
        if code == 200 {
            working = reloaded["crashed"] == false;
            break;
        }
    }
    assert!(working, "the browser never came back");
    service.stop().await;
}
