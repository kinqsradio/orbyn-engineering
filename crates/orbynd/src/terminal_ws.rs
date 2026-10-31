//! `GET /ws/terminal/:thread_id`: binary in and out; a JSON text frame
//! `{cols,rows}` resizes. Trust is checked before the socket upgrades.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use orbyn_core::CoreError;
use orbyn_core::store::AuditRecord;
use orbyn_core::terminal::{PtySession, PtySpec, default_shell};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

use crate::api::{ApiResult, AppState, LOCAL_USER};

/// A shell with no client attached survives this long, for reconnects.
const IDLE_SHELL: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
struct Resize {
    cols: u16,
    rows: u16,
}

pub async fn terminal(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    upgrade: WebSocketUpgrade,
) -> ApiResult<Response> {
    let thread = state.core.store.thread(&thread_id)?;
    let project = state.core.store.project(&thread.project_id)?;
    if !project.trusted {
        return Err(CoreError::FolderUntrusted.into());
    }
    let session = match state.core.terminals.session(&thread_id) {
        Some(session) => session,
        None => {
            state.core.store.append_audit(&AuditRecord {
                actor: LOCAL_USER.to_owned(),
                action: "terminal.open".into(),
                target: thread.cwd.clone(),
                decision: None,
                source: "user".into(),
                thread_id: Some(thread_id.clone()),
                run_id: None,
                detail: json!({ "managed": false }),
            })?;
            state.core.terminals.open(
                &thread_id,
                PtySpec {
                    program: default_shell(),
                    args: Vec::new(),
                    cwd: thread.cwd.clone().into(),
                    cols: 120,
                    rows: 32,
                },
            )?
        }
    };
    Ok(upgrade.on_upgrade(move |socket| serve(state, thread_id, session, socket)))
}

async fn serve(state: AppState, thread_id: String, session: Arc<PtySession>, socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();
    let (scrollback, mut output) = session.attach();
    let mut exited = session.exited();
    if !scrollback.is_empty()
        && sender
            .send(Message::Binary(scrollback.into()))
            .await
            .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            chunk = output.recv() => match chunk {
                Ok(bytes) => {
                    if sender.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => break,
            },
            changed = exited.changed() => {
                if changed.is_err() || exited.borrow().is_some() {
                    let _ = sender.send(Message::Close(None)).await;
                    break;
                }
            }
            message = receiver.next() => match message {
                Some(Ok(Message::Binary(bytes))) => {
                    if session.write(&bytes).is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Text(text))) => {
                    if let Ok(size) = serde_json::from_str::<Resize>(&text)
                        && let Err(error) = session.resize(size.cols, size.rows)
                    {
                        tracing::debug!(%error, "resize failed");
                    }
                }
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
    drop(output);
    tokio::spawn(reap_if_idle(state, thread_id, session));
}

/// Closes a plain shell nobody came back to. A terminal-tier run owns its PTY and
/// ends it through the run, so it is left alone.
async fn reap_if_idle(state: AppState, thread_id: String, session: Arc<PtySession>) {
    tokio::time::sleep(IDLE_SHELL).await;
    let attached = session.attached_clients();
    let running = state
        .core
        .store
        .thread(&thread_id)
        .is_ok_and(|thread| thread.active_run.is_some());
    if attached == 0 && !running {
        state.core.terminals.close(&thread_id);
    }
}
