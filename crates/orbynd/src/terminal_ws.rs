//! `GET /ws/terminal/:thread_id`: binary in and out; a JSON text frame
//! `{cols,rows}` resizes. Trust is checked before the socket upgrades. The same
//! with `/:terminal` attaches to a named terminal, and `?observe=true` watches
//! one without being able to type or resize.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use orbyn_contracts::{OpenTerminal, RenameTerminal, RunScript, TerminalScrollback};
use orbyn_core::CoreError;
use orbyn_core::store::AuditRecord;
use orbyn_core::terminal::{MAIN_TERMINAL, PtySession, PtySpec, TerminalLabel, default_shell};
use orbyn_core::util::new_id;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

use crate::api::{ApiFailure, ApiJson, ApiResult, AppState, LOCAL_USER};

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
    Ok(upgrade.on_upgrade(move |socket| {
        serve(
            state,
            thread_id,
            MAIN_TERMINAL.to_owned(),
            session,
            socket,
            false,
        )
    }))
}

fn trusted_thread(state: &AppState, id: &str) -> ApiResult<orbyn_contracts::Thread> {
    let thread = state.core.store.thread(id)?;
    if !state.core.store.project(&thread.project_id)?.trusted {
        return Err(CoreError::FolderUntrusted.into());
    }
    Ok(thread)
}

fn not_found() -> ApiFailure {
    CoreError::NotFound("terminal".into()).into()
}

pub async fn attach(
    State(state): State<AppState>,
    Path((thread_id, terminal)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
    upgrade: WebSocketUpgrade,
) -> ApiResult<Response> {
    trusted_thread(&state, &thread_id)?;
    let session = state
        .core
        .terminals
        .named(&thread_id, &terminal)
        .ok_or_else(not_found)?;
    let observe = query.get("observe").is_some_and(|value| value == "true");
    Ok(upgrade
        .on_upgrade(move |socket| serve(state, thread_id, terminal, session, socket, observe)))
}

pub async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    state.core.store.thread(&id)?;
    Ok(Json(state.core.terminals.list(&id)))
}

pub async fn open(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<OpenTerminal>,
) -> ApiResult<impl IntoResponse> {
    let thread = trusted_thread(&state, &id)?;
    let group = match &body.split_of {
        Some(other) => Some(
            state
                .core
                .terminals
                .group_of(&id, other)
                .ok_or_else(not_found)?,
        ),
        None => None,
    };
    let terminal = new_id();
    state.core.store.append_audit(&AuditRecord {
        actor: LOCAL_USER.to_owned(),
        action: "terminal.open".into(),
        target: thread.cwd.clone(),
        decision: None,
        source: "user".into(),
        thread_id: Some(id.clone()),
        run_id: None,
        detail: json!({ "managed": false, "terminal": terminal }),
    })?;
    let info = state.core.terminals.open_named(
        &id,
        &terminal,
        TerminalLabel {
            title: body.title,
            group,
            direction: body.direction,
            script: None,
        },
        PtySpec {
            program: default_shell(),
            args: Vec::new(),
            cwd: thread.cwd.into(),
            cols: body.cols.unwrap_or(120),
            rows: body.rows.unwrap_or(32),
        },
    )?;
    Ok((StatusCode::CREATED, Json(info)))
}

pub async fn rename(
    State(state): State<AppState>,
    Path((id, terminal)): Path<(String, String)>,
    ApiJson(body): ApiJson<RenameTerminal>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.terminals.rename(
        &id,
        &terminal,
        &body.title,
    )?))
}

pub async fn close(
    State(state): State<AppState>,
    Path((id, terminal)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    state.core.terminals.close_one(&id, &terminal)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn scrollback(
    State(state): State<AppState>,
    Path((id, terminal)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let session = state
        .core
        .terminals
        .named(&id, &terminal)
        .ok_or_else(not_found)?;
    let text = String::from_utf8_lossy(&session.scrollback()).into_owned();
    Ok(Json(TerminalScrollback { text }))
}

pub async fn clear(
    State(state): State<AppState>,
    Path((id, terminal)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    state
        .core
        .terminals
        .named(&id, &terminal)
        .ok_or_else(not_found)?
        .clear();
    Ok(StatusCode::NO_CONTENT)
}

pub async fn scripts(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.project_file(&id)?))
}

pub async fn run_script(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<RunScript>,
) -> ApiResult<impl IntoResponse> {
    Ok((
        StatusCode::CREATED,
        Json(state.core.run_script(&id, &body.name, LOCAL_USER)?),
    ))
}

async fn serve(
    state: AppState,
    thread_id: String,
    terminal: String,
    session: Arc<PtySession>,
    socket: WebSocket,
    observe: bool,
) {
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
                Some(Ok(Message::Binary(_) | Message::Text(_))) if observe => {}
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
    // Named terminals stay until closed, or until their thread settles.
    if terminal == MAIN_TERMINAL && !observe {
        tokio::spawn(reap_if_idle(state, thread_id, session));
    }
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
        let _ = state.core.terminals.close_one(&thread_id, MAIN_TERMINAL);
    }
}
