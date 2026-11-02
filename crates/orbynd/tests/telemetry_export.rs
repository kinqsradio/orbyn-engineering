//! OTLP export through the real service: endpoints apply at the next start, and an
//! unset or unusable endpoint sends nothing.

mod support;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::{Options, Service, TempDir};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn collector() -> (String, Arc<Mutex<Vec<(String, Value)>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let log = log.clone();
            tokio::spawn(async move {
                let mut raw = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    let read = stream.read(&mut chunk).await.unwrap_or(0);
                    raw.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                        let length = head
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|n| n.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if rest.len() >= length {
                            let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
                            let body = serde_json::from_str(rest).unwrap_or(Value::Null);
                            log.lock().unwrap().push((path, body));
                            break;
                        }
                    }
                    if read == 0 {
                        break;
                    }
                }
                let _ = stream
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                    .await;
            });
        }
    });
    (base, seen)
}

fn fast() -> Options {
    Options {
        env: vec![("ORBYN_TELEMETRY_INTERVAL_MS".to_owned(), "100".to_owned())],
        ..Options::default()
    }
}

async fn save(service: &Service, value: Value) {
    let response = service
        .client
        .put(format!("{}/api/preferences", service.url))
        .bearer_auth(&service.token)
        .json(&json!({ "values": { "observability": value } }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn saved_endpoints_apply_on_the_next_start_and_never_before() {
    let dir = TempDir::new();
    let data = dir.path().join("data");
    let (base, seen) = collector().await;
    let first = Service::start(&data, fast());
    save(
        &first,
        json!({ "metrics_url": format!("{base}/v1/metrics"), "logs_url": format!("{base}/v1/logs") }),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(
        seen.lock().unwrap().is_empty(),
        "a saved edit must wait for restart"
    );
    first.stop().await;

    let second = Service::start(&data, fast());
    let deadline = Instant::now() + Duration::from_secs(10);
    while seen.lock().unwrap().is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let requests = seen.lock().unwrap().clone();
    assert!(!requests.is_empty(), "no metrics arrived");
    assert!(
        requests.iter().all(|(path, _)| path == "/v1/metrics"),
        "{requests:?}"
    );
    let metrics = &requests[0].1["resourceMetrics"][0]["scopeMetrics"][0]["metrics"];
    assert_eq!(metrics[0]["name"], "orbyn.service.memory");
    assert!(
        metrics[0]["gauge"]["dataPoints"][0]["asInt"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            > 0
    );
    second.stop().await;
}

#[tokio::test]
async fn an_empty_or_unusable_endpoint_sends_nothing_and_does_not_stop_the_service() {
    let dir = TempDir::new();
    let data = dir.path().join("data");
    let (base, seen) = collector().await;
    let first = Service::start(&data, fast());
    save(
        &first,
        json!({ "traces_url": format!("{base}/v1/traces"), "metrics_url": "", "logs_url": "file:///etc/passwd" }),
    )
    .await;
    first.stop().await;
    let second = Service::start(&data, fast());
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(
        seen.lock().unwrap().is_empty(),
        "{:?}",
        seen.lock().unwrap()
    );
    assert_eq!(second.get("/api/info").send().await.unwrap().status(), 200);
    second.stop().await;
}

#[tokio::test]
async fn a_dead_collector_does_not_stop_the_service() {
    let dir = TempDir::new();
    let data = dir.path().join("data");
    let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/metrics", dead.local_addr().unwrap());
    drop(dead);
    let first = Service::start(&data, fast());
    save(&first, json!({ "metrics_url": url })).await;
    first.stop().await;
    let second = Service::start(&data, fast());
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(second.get("/api/info").send().await.unwrap().status(), 200);
    second.stop().await;
}

#[tokio::test]
async fn a_bad_interval_is_refused_at_startup() {
    let dir = TempDir::new();
    let options = Options {
        env: vec![("ORBYN_TELEMETRY_INTERVAL_MS".to_owned(), "0".to_owned())],
        ..Options::default()
    };
    let error = Service::try_start(&dir.path().join("data"), options)
        .err()
        .expect("refused");
    assert!(error.contains("ORBYN_TELEMETRY_INTERVAL_MS"), "{error}");
}
