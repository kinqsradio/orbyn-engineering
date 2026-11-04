//! HTTP adapter for Core's bounded remote image capability.

use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use crate::api::{ApiFailure, ApiResult, AppState};

#[derive(Deserialize)]
pub struct ImageQuery {
    url: String,
    #[serde(default)]
    download: bool,
}

pub async fn serve(
    State(state): State<AppState>,
    Query(query): Query<ImageQuery>,
) -> ApiResult<Response> {
    let image = state.images.get(&query.url).await.map_err(|_| {
        ApiFailure::new(
            StatusCode::BAD_GATEWAY,
            "image_unavailable",
            "Remote image is unavailable.",
        )
    })?;
    Ok((
        [
            (header::CONTENT_TYPE, image.content_type),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::REFERRER_POLICY, "no-referrer"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; sandbox",
            ),
            (
                header::CONTENT_DISPOSITION,
                if query.download {
                    match image.content_type {
                        "image/png" => "attachment; filename=\"image.png\"",
                        "image/jpeg" => "attachment; filename=\"image.jpg\"",
                        "image/gif" => "attachment; filename=\"image.gif\"",
                        "image/webp" => "attachment; filename=\"image.webp\"",
                        _ => "attachment; filename=\"image.ico\"",
                    }
                } else {
                    "inline"
                },
            ),
        ],
        image.bytes.as_ref().clone(),
    )
        .into_response())
}
