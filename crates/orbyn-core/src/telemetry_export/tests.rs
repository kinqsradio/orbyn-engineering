use std::sync::Arc;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

/// A collector that records each request body and answers with the next status.
struct Collector {
    url: String,
    bodies: Arc<Mutex<Vec<Value>>>,
}

async fn collector(statuses: Vec<u16>) -> Collector {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/signal", listener.local_addr().unwrap());
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let seen = bodies.clone();
    tokio::spawn(async move {
        let mut statuses = statuses.into_iter();
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut raw = Vec::new();
            let mut chunk = [0u8; 4096];
            let body = loop {
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
                    if rest.len() >= length || read == 0 {
                        break rest.to_owned();
                    }
                } else if read == 0 {
                    break String::new();
                }
            };
            lock(&seen).push(serde_json::from_str(&body).unwrap_or(Value::Null));
            let status = statuses.next().unwrap_or(200);
            let _ = stream
                .write_all(
                    format!(
                        "HTTP/1.1 {status} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await;
        }
    });
    Collector { url, bodies }
}

fn seed(at: &str) -> ResourceSample {
    ResourceSample {
        at: at.to_owned(),
        memory_bytes: 4096,
        processes: 3,
    }
}

fn endpoints(logs: Option<&str>, metrics: Option<&str>) -> Endpoints {
    Endpoints {
        logs: logs.map(str::to_owned),
        metrics: metrics.map(str::to_owned),
    }
}

#[test]
fn only_absolute_http_urls_are_endpoints() {
    let read = |value: Value| Endpoints::from_preference(&value);
    let good = read(
        json!({ "logs_url": " http://localhost:4318/v1/logs ", "metrics_url": "https://c.example/m" }),
    );
    assert_eq!(good.logs.as_deref(), Some("http://localhost:4318/v1/logs"));
    assert_eq!(good.metrics.as_deref(), Some("https://c.example/m"));
    for bad in [
        "",
        "   ",
        "ftp://c.example",
        "file:///etc/passwd",
        "collector:4318",
        "//c.example",
        "http://",
        "not a url",
    ] {
        assert!(
            read(json!({ "logs_url": bad, "metrics_url": bad })).is_empty(),
            "{bad}"
        );
    }
    assert!(read(json!({ "logs_url": 7, "metrics_url": null })).is_empty());
    assert!(read(json!([])).is_empty());
    assert!(read(json!({ "traces_url": "http://c.example" })).is_empty());
}

#[tokio::test]
async fn warnings_and_errors_arrive_as_otlp_logs_and_nothing_else_does() {
    let sink = collector(vec![]).await;
    let exporter = Exporter::new(endpoints(Some(&sink.url), None)).unwrap();
    exporter.offer("2026-11-02T01:02:03Z", "WARN", "orbyn_core::x", "careful");
    exporter.offer("2026-11-02T01:02:04Z", "ERROR", "orbyn_core::y", "broken");
    exporter.offer("2026-11-02T01:02:05Z", "INFO", "orbyn_core::z", "chatter");
    exporter.offer("2026-11-02T01:02:05Z", "DEBUG", "orbyn_core::z", "noise");
    exporter.offer("2026-11-02T01:02:06Z", "ERROR", OWN_TARGET, "would loop");
    exporter.flush().await;
    exporter.flush().await;
    let bodies = lock(&sink.bodies).clone();
    assert_eq!(bodies.len(), 1, "an empty queue sends nothing");
    let records = &bodies[0]["resourceLogs"][0]["scopeLogs"][0]["logRecords"];
    assert_eq!(records.as_array().unwrap().len(), 2);
    assert_eq!(records[0]["severityText"], "WARN");
    assert_eq!(records[0]["severityNumber"], 13);
    assert_eq!(records[0]["body"]["stringValue"], "careful");
    assert_eq!(records[0]["timeUnixNano"], "1793581323000000000");
    assert_eq!(records[1]["severityNumber"], 17);
    assert_eq!(
        bodies[0]["resourceLogs"][0]["resource"]["attributes"][0]["value"]["stringValue"],
        "orbynd"
    );
}

#[tokio::test]
async fn an_unset_signal_queues_and_sends_nothing() {
    let sink = collector(vec![]).await;
    let exporter = Exporter::new(endpoints(None, Some(&sink.url))).unwrap();
    exporter.offer("2026-11-02T01:02:03Z", "ERROR", "t", "private");
    assert!(lock(&exporter.logs).is_empty());
    exporter
        .flush_with(Some(seed("2026-11-02T01:00:00Z")))
        .await;
    let bodies = lock(&sink.bodies).clone();
    assert_eq!(bodies.len(), 1);
    assert!(bodies[0].get("resourceLogs").is_none());
}

#[tokio::test]
async fn a_refused_batch_is_kept_and_sent_again_in_order() {
    let sink = collector(vec![503, 200]).await;
    let exporter = Exporter::new(endpoints(Some(&sink.url), None)).unwrap();
    exporter.offer("2026-11-02T01:02:03Z", "WARN", "t", "first");
    exporter.flush().await;
    exporter.offer("2026-11-02T01:02:04Z", "WARN", "t", "second");
    exporter.flush().await;
    let bodies = lock(&sink.bodies).clone();
    assert_eq!(bodies.len(), 2);
    let resent = bodies[1]["resourceLogs"][0]["scopeLogs"][0]["logRecords"]
        .as_array()
        .unwrap();
    let order: Vec<_> = resent
        .iter()
        .map(|row| row["body"]["stringValue"].as_str().unwrap())
        .collect();
    assert_eq!(order, ["first", "second"]);
}

#[tokio::test]
async fn a_dead_collector_never_grows_the_queue_past_its_limit() {
    let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/logs", dead.local_addr().unwrap());
    drop(dead);
    let exporter = Exporter::new(endpoints(Some(&url), None)).unwrap();
    for number in 0..(QUEUE_LIMIT * 2) {
        exporter.offer("2026-11-02T01:02:03Z", "WARN", "t", &number.to_string());
    }
    exporter.flush().await;
    exporter.flush().await;
    let queue = lock(&exporter.logs);
    assert_eq!(queue.len(), QUEUE_LIMIT);
    assert_eq!(queue.front().unwrap().message, QUEUE_LIMIT.to_string());
}

#[tokio::test]
async fn a_redirect_is_not_followed_with_the_batch() {
    let target = collector(vec![]).await;
    let redirect = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/logs", redirect.local_addr().unwrap());
    let location = target.url.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = redirect.accept().await {
            let mut sink = [0u8; 8192];
            let _ = stream.read(&mut sink).await;
            let _ = stream
                .write_all(
                    format!("HTTP/1.1 307 X\r\nlocation: {location}\r\ncontent-length: 0\r\n\r\n")
                        .as_bytes(),
                )
                .await;
        }
    });
    let exporter = Exporter::new(endpoints(Some(&url), None)).unwrap();
    exporter.offer("2026-11-02T01:02:03Z", "WARN", "t", "stay");
    exporter.flush().await;
    assert!(lock(&target.bodies).is_empty());
    assert_eq!(lock(&exporter.logs).len(), 1);
}

#[tokio::test]
async fn a_metric_sample_is_sent_once() {
    let sink = collector(vec![]).await;
    let exporter = Exporter::new(endpoints(None, Some(&sink.url))).unwrap();
    let first = seed("2026-11-02T01:00:00Z");
    exporter.flush_with(Some(first.clone())).await;
    exporter.flush_with(Some(first)).await;
    exporter.flush_with(None).await;
    assert_eq!(lock(&sink.bodies).len(), 1);
    exporter
        .flush_with(Some(seed("2026-11-02T01:01:00Z")))
        .await;
    let bodies = lock(&sink.bodies).clone();
    assert_eq!(bodies.len(), 2);
    let metrics = &bodies[0]["resourceMetrics"][0]["scopeMetrics"][0]["metrics"];
    assert_eq!(metrics[0]["name"], "orbyn.service.memory");
    assert_eq!(metrics[1]["name"], "orbyn.service.processes");
    assert_eq!(metrics[0]["gauge"]["dataPoints"][0]["asInt"], "4096");
    assert_eq!(metrics[1]["gauge"]["dataPoints"][0]["asInt"], "3");
}
