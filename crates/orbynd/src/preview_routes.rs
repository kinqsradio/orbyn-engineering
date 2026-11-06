//! Preview tabs and local servers. `GET /ws/preview/:thread/:tab` sends each changed
//! frame as a text message of base64 JPEG. Watching takes no control: input goes
//! through `POST .../input`, and only after taking the page.

use axum::Json;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use orbyn_contracts::{
    AnswerFileChooser, ClearPreview, CreateBrowserProfile, NavigatePreview, OpenPreview,
    OpenPreviewFile, PickPreview, PreviewControl, PreviewCopy, PreviewInput,
    PreviewRecordingOptions, PreviewUpload, PreviewView, ReloadPreview, ResizePreview, StepPreview,
};
use orbyn_core::preview::OpenHow;
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;
use tokio_util::io::ReaderStream;

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
        .open_preview(
            &id,
            &body.url,
            (body.width, body.height),
            LOCAL_USER,
            OpenHow {
                private: body.private,
                profile: body.profile,
            },
        )
        .await?;
    Ok((StatusCode::CREATED, Json(tab)))
}

pub async fn open_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<OpenPreviewFile>,
) -> ApiResult<impl IntoResponse> {
    let tab = state
        .core
        .open_preview_file(&id, &body.path, LOCAL_USER)
        .await?;
    Ok((StatusCode::CREATED, Json(tab)))
}

/// Open a second viewer of an existing tab in the desktop shell.
pub async fn window(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    state.core.store.thread(&id)?;
    // The manager checks that this tab actually belongs to this thread.
    drop(state.core.previews.subscribe(&id, &tab)?);
    state.core.shell.preview_window(&id, &tab)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn view(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
    ApiJson(body): ApiJson<PreviewView>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.previews.set_view(&id, &tab, &body).await?))
}

pub async fn reload(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
    ApiJson(body): ApiJson<ReloadPreview>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state.core.previews.reload(&id, &tab, body.hard).await?,
    ))
}

pub async fn clear(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
    ApiJson(body): ApiJson<ClearPreview>,
) -> ApiResult<StatusCode> {
    state
        .core
        .previews
        .clear(&id, &tab, body.cookies, body.cache)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn pick(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
    ApiJson(body): ApiJson<PickPreview>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state.core.previews.pick(&id, &tab, body.x, body.y).await?,
    ))
}

pub async fn profiles(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.browser_profiles()?))
}

pub async fn create_profile(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateBrowserProfile>,
) -> ApiResult<impl IntoResponse> {
    Ok((
        StatusCode::CREATED,
        Json(state.core.create_browser_profile(&body.name)?),
    ))
}

pub async fn clear_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.clear_browser_profile(&id)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.delete_browser_profile(&id)?;
    Ok(StatusCode::NO_CONTENT)
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

pub async fn history(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
    ApiJson(body): ApiJson<StepPreview>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.previews.step(&id, &tab, body.back).await?))
}

pub async fn resize(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
    ApiJson(body): ApiJson<ResizePreview>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state
            .core
            .previews
            .resize(&id, &tab, body.width, body.height)
            .await?,
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

/// The text a person selected in the page they hold, for their own clipboard.
pub async fn copy(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let text = state.core.copy_from_preview(&id, &tab).await?;
    Ok(Json(PreviewCopy { text }))
}

#[derive(Deserialize)]
pub struct UploadName {
    #[serde(default)]
    name: String,
}

/// One file a person chose for the page's open file chooser, as the raw body.
pub async fn upload(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
    Query(query): Query<UploadName>,
    body: axum::body::Bytes,
) -> ApiResult<impl IntoResponse> {
    let upload = state
        .core
        .stage_preview_upload(&id, &tab, &query.name, &body)?;
    Ok((StatusCode::CREATED, Json(PreviewUpload { id: upload })))
}

pub async fn answer_chooser(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
    ApiJson(body): ApiJson<AnswerFileChooser>,
) -> ApiResult<StatusCode> {
    state
        .core
        .answer_preview_files(&id, &tab, &body.files, LOCAL_USER)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A finished download's bytes, always as an attachment, so nothing the page made
/// runs in this origin.
pub async fn download(
    State(state): State<AppState>,
    Path((id, tab, download)): Path<(String, String, String)>,
) -> ApiResult<Response> {
    let (path, name) = state
        .core
        .preview_download(&id, &tab, &download, LOCAL_USER)?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| orbyn_core::CoreError::NotFound("download".into()))?;
    let disposition = format!(
        "attachment; filename*=UTF-8''{}",
        crate::raw_files::encoded_name(&name)
    );
    let mut response = Body::from_stream(ReaderStream::new(file)).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition)
            .map_err(|_| orbyn_core::CoreError::Invalid("That name cannot be sent.".into()))?,
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(crate::raw_files::SANDBOX),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

pub async fn start_recording(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
    Query(options): Query<PreviewRecordingOptions>,
) -> ApiResult<StatusCode> {
    state.core.start_preview_recording(&id, &tab, options)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn stop_recording(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.previews.stop_recording(&id, &tab).await?))
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

/// Server-produced cues only; client messages never publish input events.
pub async fn pointers(
    State(state): State<AppState>,
    Path((id, tab)): Path<(String, String)>,
    upgrade: WebSocketUpgrade,
) -> ApiResult<Response> {
    let mut events = state.core.previews.subscribe_pointers(&id, &tab)?;
    Ok(upgrade.on_upgrade(move |mut socket| async move {
        loop {
            tokio::select! {
                event = events.recv() => match event {
                    Ok(event) => {
                        let Ok(text) = serde_json::to_string(&event) else { return };
                        if socket.send(Message::Text(text.into())).await.is_err() { return; }
                    },
                    Err(RecvError::Lagged(_)) => {},
                    Err(RecvError::Closed) => return,
                },
                message = socket.recv() => {
                    if !matches!(message, Some(Ok(_))) { return; }
                }
            }
        }
    }))
}
