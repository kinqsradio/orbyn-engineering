//! Preview tabs and local servers. `GET /ws/preview/:thread/:tab` sends each changed
//! frame as a text message of base64 JPEG. Watching takes no control: input goes
//! through `POST .../input`, and only after taking the page.

use axum::Json;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use orbyn_contracts::{NavigatePreview, OpenPreview, PreviewControl, PreviewInput};
use tokio::sync::broadcast::error::RecvError;

use crate::api::{ApiJson, ApiResult, AppState, LOCAL_USER};

pub async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    state.core.store.thread(&id)?;
    Ok(Json(state.core.previews.list(&id)))
}

pub async fn open(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<OpenPreview>,
) -> ApiResult<impl IntoResponse> {
    let tab = state
        .core
        .open_preview(&id, &body.url, (body.width, body.height), LOCAL_USER)
        .await?;
    Ok((StatusCode::CREATED, Json(tab)))
}

pub async fn navigate(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
    ApiJson(body): ApiJson<NavigatePreview>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state.core.previews.navigate(&id, &tab, &body.url).await?,
    ))
}

pub async fn control(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
    ApiJson(body): ApiJson<PreviewControl>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state.core.previews.set_control(&id, &tab, body.human)?,
    ))
}

pub async fn input(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
    ApiJson(body): ApiJson<PreviewInput>,
) -> ApiResult<StatusCode> {
    state.core.previews.input(&id, &tab, &body).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn start_recording(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    state.core.start_preview_recording(&id, &tab)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn stop_recording(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.previews.stop_recording(&id, &tab)?))
}

pub async fn close(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    state.core.previews.close(&id, &tab)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn stream(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
    upgrade: WebSocketUpgrade,
) -> ApiResult<Response> {
    let frames = state.core.previews.subscribe(&id, &tab)?;
    Ok(upgrade.on_upgrade(move |socket| serve(socket, frames)))
}

async fn serve(
    mut socket: WebSocket,
    mut frames: tokio::sync::broadcast::Receiver<std::sync::Arc<str>>,
) {
    loop {
        tokio::select! {
            frame = frames.recv() => match frame {
                Ok(frame) => {
                    if socket.send(Message::Text(frame.as_ref().into())).await.is_err() {
                        return;
                    }
                }
                // A slow viewer skips frames; the next one is a whole picture.
                Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => return,
            },
            message = socket.recv() => {
                if !matches!(message, Some(Ok(_))) {
                    return;
                }
            }
        }
    }
}

pub async fn servers(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.local_servers(&id).await?))
}

pub async fn stop_server(
    State(state): State<AppState>,
    Path((id, pid)): Path<(String, u32)>,
) -> ApiResult<StatusCode> {
    state.core.stop_server(&id, pid, LOCAL_USER).await?;
    Ok(StatusCode::NO_CONTENT)
}
