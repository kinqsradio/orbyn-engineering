//! Sends the signals the service already keeps to the collector a person set up in
//! Settings: warnings and errors as OTLP logs, and the memory and process samples as
//! OTLP gauges. Endpoints are read once at startup, as the Settings page says. Nothing
//! is sent, queued or retained for a signal whose URL is empty, and a collector that
//! is down or refuses a batch costs a bounded queue, never the service's work.
//! Traces have no producer here: the service records no spans, so that URL is only
//! checked, not exported to.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orbyn_contracts::ResourceSample;
use serde_json::{Value, json};

use crate::app::Core;
use crate::error::Result;

pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(15);
const QUEUE_LIMIT: usize = 256;
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const FINAL_FLUSH: Duration = Duration::from_secs(2);
const OWN_TARGET: &str = module_path!();

static ACTIVE: Mutex<Option<Arc<Exporter>>> = Mutex::new(None);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The endpoints that are usable. Anything that is not an absolute http or https URL
/// is ignored rather than guessed at.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Endpoints {
    pub logs: Option<String>,
    pub metrics: Option<String>,
}

impl Endpoints {
    pub fn from_preference(value: &Value) -> Self {
        let read = |key: &str| {
            let text = value.get(key)?.as_str()?.trim();
            let url = reqwest::Url::parse(text).ok()?;
            matches!(url.scheme(), "http" | "https")
                .then(|| url.host_str().is_some().then(|| text.to_owned()))
                .flatten()
        };
        Self {
            logs: read("logs_url"),
            metrics: read("metrics_url"),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.logs.is_none() && self.metrics.is_none()
    }
}

struct LogRecord {
    nanos: i128,
    level: &'static str,
    target: String,
    message: String,
}

pub struct Exporter {
    endpoints: Endpoints,
    client: reqwest::Client,
    logs: Mutex<VecDeque<LogRecord>>,
    last_sample: Mutex<Option<String>>,
}

fn nanos(at: &str) -> i128 {
    time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339)
        .map(time::OffsetDateTime::unix_timestamp_nanos)
        .unwrap_or(0)
}

fn attribute(key: &str, value: &str) -> Value {
    json!({ "key": key, "value": { "stringValue": value } })
}

fn resource() -> Value {
    json!({ "attributes": [
        attribute("service.name", "orbynd"),
        attribute("service.version", env!("CARGO_PKG_VERSION")),
    ] })
}

impl Exporter {
    pub fn new(endpoints: Endpoints) -> Result<Arc<Self>> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(SEND_TIMEOUT)
            .build()
            .map_err(|error| crate::error::CoreError::Internal(error.without_url().to_string()))?;
        Ok(Arc::new(Self {
            endpoints,
            client,
            logs: Mutex::new(VecDeque::new()),
            last_sample: Mutex::new(None),
        }))
    }

    /// Keeps a warning or error for the next batch. The oldest is dropped at the limit.
    pub fn offer(&self, at: &str, level: &str, target: &str, message: &str) {
        if self.endpoints.logs.is_none() || target.starts_with(OWN_TARGET) {
            return;
        }
        let level = match level {
            "ERROR" => "ERROR",
            "WARN" => "WARN",
            _ => return,
        };
        let mut queue = lock(&self.logs);
        if queue.len() == QUEUE_LIMIT {
            queue.pop_front();
        }
        queue.push_back(LogRecord {
            nanos: nanos(at),
            level,
            target: target.to_owned(),
            message: message.to_owned(),
        });
    }

    fn logs_body(records: &[LogRecord]) -> Value {
        let rows: Vec<Value> = records
            .iter()
            .map(|record| {
                json!({
                    "timeUnixNano": record.nanos.to_string(),
                    "severityNumber": if record.level == "ERROR" { 17 } else { 13 },
                    "severityText": record.level,
                    "body": { "stringValue": record.message },
                    "attributes": [attribute("target", &record.target)],
                })
            })
            .collect();
        json!({ "resourceLogs": [{
            "resource": resource(),
            "scopeLogs": [{ "scope": { "name": "orbynd" }, "logRecords": rows }],
        }] })
    }

    fn metrics_body(sample: &ResourceSample) -> Value {
        let point = |value: u64| json!([{ "timeUnixNano": nanos(&sample.at).to_string(), "asInt": value.to_string() }]);
        json!({ "resourceMetrics": [{
            "resource": resource(),
            "scopeMetrics": [{ "scope": { "name": "orbynd" }, "metrics": [
                { "name": "orbyn.service.memory", "unit": "By",
                  "gauge": { "dataPoints": point(sample.memory_bytes) } },
                { "name": "orbyn.service.processes", "unit": "{process}",
                  "gauge": { "dataPoints": point(sample.processes as u64) } },
            ] }],
        }] })
    }

    async fn post(&self, url: &str, body: &Value) -> bool {
        match self.client.post(url).json(body).send().await {
            Ok(response) if response.status().is_success() => true,
            Ok(response) => {
                tracing::debug!(
                    status = response.status().as_u16(),
                    "collector refused a batch"
                );
                false
            }
            Err(error) => {
                tracing::debug!(%error, "collector could not be reached");
                false
            }
        }
    }

    /// Sends what is waiting. A batch the collector did not accept goes back to the
    /// front of the queue, within the limit, and is tried again on the next pass.
    pub async fn flush(&self) {
        self.flush_with(crate::diagnostics::resource_history().pop())
            .await;
    }

    async fn flush_with(&self, sample: Option<ResourceSample>) {
        if let Some(url) = &self.endpoints.logs {
            let batch: Vec<LogRecord> = lock(&self.logs).drain(..).collect();
            if !batch.is_empty() && !self.post(url, &Self::logs_body(&batch)).await {
                let mut queue = lock(&self.logs);
                for record in batch.into_iter().rev() {
                    if queue.len() == QUEUE_LIMIT {
                        break;
                    }
                    queue.push_front(record);
                }
            }
        }
        if let (Some(url), Some(sample)) = (&self.endpoints.metrics, sample) {
            let fresh = lock(&self.last_sample).as_deref() != Some(sample.at.as_str());
            if fresh && self.post(url, &Self::metrics_body(&sample)).await {
                *lock(&self.last_sample) = Some(sample.at);
            }
        }
    }
}

/// Sends one warning or error to the running exporter, if any.
pub fn offer_log(at: &str, level: &str, target: &str, message: &str) {
    let active = lock(&ACTIVE).clone();
    if let Some(exporter) = active {
        exporter.offer(at, level, target, message);
    }
}

impl Core {
    /// Starts exporting to the endpoints saved at this moment. Later edits apply on
    /// the next start. With none saved, nothing runs and nothing is queued.
    pub fn start_telemetry_export(&self, interval: Duration) -> Result<()> {
        let endpoints = Endpoints::from_preference(&self.preference("observability", None)?);
        if endpoints.is_empty() {
            return Ok(());
        }
        let exporter = Exporter::new(endpoints)?;
        *lock(&ACTIVE) = Some(exporter.clone());
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            tick.tick().await;
            loop {
                tick.tick().await;
                exporter.flush().await;
            }
        });
        Ok(())
    }

    /// Whether an endpoint is saved; the network list reports it.
    pub fn telemetry_export_configured(&self) -> Result<bool> {
        Ok(!Endpoints::from_preference(&self.preference("observability", None)?).is_empty())
    }
}

/// One last, bounded attempt so a stopping service still reports its last warnings.
pub async fn finish() {
    let active = lock(&ACTIVE).take();
    if let Some(exporter) = active {
        let _ = tokio::time::timeout(FINAL_FLUSH, exporter.flush()).await;
    }
}

#[cfg(test)]
mod tests;
