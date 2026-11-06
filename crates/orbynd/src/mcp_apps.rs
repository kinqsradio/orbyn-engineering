//! The host's half of an MCP App page: the web asks here for what the page asked
//! the host for. These routes need the service token like any other; the page
//! itself only ever holds its render's frame token, which cannot reach them.

use axum::Json;
use axum::extract::{Path, State};
use axum::response::IntoResponse;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::{ApiJson, ApiResult, AppState, LOCAL_USER};

#[derive(Deserialize)]
pub struct ToolCall {
    name: String,
    #[serde(default)]
    arguments: Option<Value>,
    /// The person confirmed this call in the host's own dialog.
    #[serde(default)]
    confirmed: bool,
}

pub async fn tool_call(
    State(state): State<AppState>,
    Path((id, render_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<ToolCall>,
) -> ApiResult<impl IntoResponse> {
    let arguments = body.arguments.unwrap_or_else(|| json!({}));
    let result = state
        .core
        .mcp_app_tool_call(
            &id,
            &render_id,
            &body.name,
            &arguments,
            body.confirmed,
            LOCAL_USER,
        )
        .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct Message {
    text: String,
    #[serde(default)]
    confirmed: bool,
}

pub async fn message(
    State(state): State<AppState>,
    Path((id, render_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<Message>,
) -> ApiResult<impl IntoResponse> {
    let queued =
        state
            .core
            .mcp_app_message(&id, &render_id, &body.text, body.confirmed, LOCAL_USER)?;
    Ok(Json(queued))
}

#[derive(Deserialize)]
pub struct Context {
    text: String,
}

/// The page's latest note for the model, sent with the thread's next turn.
pub async fn context(
    State(state): State<AppState>,
    Path((id, render_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<Context>,
) -> ApiResult<impl IntoResponse> {
    state
        .core
        .mcp_app_context(&id, &render_id, &body.text, LOCAL_USER)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// Drops the thread's unsent app note.
pub async fn clear_context(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    state.core.clear_mcp_app_context(&id)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}
