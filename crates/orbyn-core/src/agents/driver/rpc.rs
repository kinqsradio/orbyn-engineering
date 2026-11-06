//! Line-delimited JSON-RPC over a child's stdio, shared by Codex app-server
//! (which omits the `jsonrpc` header) and ACP (which requires it).
//!
//! One reader task routes responses to their callers and queues everything else
//! in arrival order, so a notification that outruns a reply is simply handled
//! after it, and a dead child fails every caller instead of hanging them.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot};

use super::pipes::lines;
use crate::error::{CoreError, Result};

type RpcResult = std::result::Result<Value, RpcCallError>;
type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<RpcResult>>>>;

/// Protocol error identity is kept separate from its human-readable diagnostic.
#[derive(Debug)]
pub(crate) struct RpcCallError {
    pub code: Option<i64>,
    pub error: CoreError,
}

impl From<CoreError> for RpcCallError {
    fn from(error: CoreError) -> Self {
        Self { code: None, error }
    }
}

struct PendingCall {
    pending: Pending,
    id: i64,
}
impl Drop for PendingCall {
    fn drop(&mut self) {
        lock(&self.pending).remove(&self.id);
    }
}

#[derive(Debug)]
pub enum Inbound {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

#[derive(Clone)]
pub struct RpcClient {
    out: mpsc::Sender<String>,
    pending: Pending,
    next_id: Arc<AtomicI64>,
    header: bool,
}

impl RpcClient {
    /// Starts the reader and writer tasks. Closing `Inbound` means stdout ended.
    pub fn start(
        stdin: ChildStdin,
        stdout: ChildStdout,
        header: bool,
    ) -> (Self, mpsc::UnboundedReceiver<Inbound>) {
        let (out, mut outgoing) = mpsc::channel::<String>(256);
        let pending: Pending = Arc::default();
        let (inbound_tx, inbound) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = outgoing.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    break;
                }
            }
        });
        let router = pending.clone();
        tokio::spawn(async move {
            let mut stream = lines(stdout);
            while let Some(line) = stream.next().await {
                let Ok(line) = line else {
                    tracing::warn!("engine sent an oversized or undecodable line");
                    continue;
                };
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    tracing::debug!("skipping a non-JSON engine line");
                    continue;
                };
                route(message, &router, &inbound_tx);
            }
            lock(&router).clear();
        });
        (
            Self {
                out,
                pending,
                next_id: Arc::new(AtomicI64::new(1)),
                header,
            },
            inbound,
        )
    }

    pub async fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        self.call_detailed(method, params, timeout)
            .await
            .map_err(|error| error.error)
    }

    pub(crate) async fn call_detailed(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> RpcResult {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        lock(&self.pending).insert(id, sender);
        let _pending = PendingCall {
            pending: self.pending.clone(),
            id,
        };
        let mut message = json!({ "id": id, "method": method, "params": params });
        self.frame(&mut message);
        tokio::time::timeout(timeout, async {
            self.send(message).await.map_err(RpcCallError::from)?;
            receiver.await.map_err(|_| {
                RpcCallError::from(CoreError::EngineUnavailable(format!(
                    "The engine closed before answering {method}."
                )))
            })?
        })
        .await
        .map_err(|_| {
            RpcCallError::from(CoreError::EngineUnavailable(format!(
                "The engine did not answer {method} in time."
            )))
        })?
    }

    pub async fn notify(&self, method: &str, params: Option<Value>) -> Result<()> {
        let mut message = json!({ "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.frame(&mut message);
        self.send(message).await
    }

    pub async fn respond(&self, id: Value, result: Value) -> Result<()> {
        let mut message = json!({ "id": id, "result": result });
        self.frame(&mut message);
        self.send(message).await
    }

    pub async fn respond_error(&self, id: Value, code: i64, text: &str) -> Result<()> {
        let mut message = json!({ "id": id, "error": { "code": code, "message": text } });
        self.frame(&mut message);
        self.send(message).await
    }

    fn frame(&self, message: &mut Value) {
        if self.header {
            message["jsonrpc"] = json!("2.0");
        }
    }

    async fn send(&self, message: Value) -> Result<()> {
        self.out
            .send(message.to_string())
            .await
            .map_err(|_| CoreError::EngineUnavailable("The engine's input is closed.".into()))
    }
}

fn lock(pending: &Pending) -> std::sync::MutexGuard<'_, HashMap<i64, oneshot::Sender<RpcResult>>> {
    pending
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn route(message: Value, pending: &Pending, inbound: &mpsc::UnboundedSender<Inbound>) {
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id").filter(|id| !id.is_null());
    match (method, id) {
        (Some(method), Some(id)) => {
            let _ = inbound.send(Inbound::Request {
                id: id.clone(),
                method: method.to_owned(),
                params: message.get("params").cloned().unwrap_or(Value::Null),
            });
        }
        (Some(method), None) => {
            let _ = inbound.send(Inbound::Notification {
                method: method.to_owned(),
                params: message.get("params").cloned().unwrap_or(Value::Null),
            });
        }
        (None, Some(id)) => {
            let Some(sender) = id.as_i64().and_then(|id| lock(pending).remove(&id)) else {
                return;
            };
            let result = match message.get("error") {
                Some(error) => Err(RpcCallError {
                    code: error.get("code").and_then(Value::as_i64),
                    error: CoreError::EngineUnavailable(
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("The engine returned an error.")
                            .to_owned(),
                    ),
                }),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = sender.send(result);
        }
        (None, None) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_errors_preserve_code_without_classifying_text() {
        let pending: Pending = Arc::default();
        let (tx, rx) = oneshot::channel();
        lock(&pending).insert(1, tx);
        let (inbound, _) = mpsc::unbounded_channel();
        route(
            json!({"id":1,"error":{"code":-32002,"message":"arbitrary diagnostic"}}),
            &pending,
            &inbound,
        );
        let error = rx.blocking_recv().unwrap().unwrap_err();
        assert_eq!(error.code, Some(-32002));
        assert!(matches!(error.error, CoreError::EngineUnavailable(_)));
        assert!(lock(&pending).is_empty());
    }

    #[tokio::test]
    async fn cancelled_and_timed_out_calls_remove_pending_registration() {
        let (out, mut requests) = mpsc::channel(1);
        let pending: Pending = Arc::default();
        let rpc = RpcClient {
            out,
            pending: pending.clone(),
            next_id: Arc::new(AtomicI64::new(1)),
            header: true,
        };
        let caller = rpc.clone();
        let task = tokio::spawn(async move {
            caller
                .call_detailed("session/load", json!({}), Duration::from_secs(60))
                .await
        });
        requests.recv().await.unwrap();
        assert_eq!(lock(&pending).len(), 1);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(lock(&pending).is_empty());
        assert!(
            rpc.call("session/list", json!({}), Duration::from_millis(1))
                .await
                .is_err()
        );
        assert!(lock(&pending).is_empty());
    }
}
