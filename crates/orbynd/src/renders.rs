//! `POST /api/threads/:id/renders` and the two routes that serve what it stored.
//! What a page may contain was decided in core; this file is the HTTP around it,
//! including the headers that stop a published page from reaching this service.

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use orbyn_core::conversation::renders::RenderFile;
use serde::Deserialize;
use serde_json::json;

use crate::api::{ApiJson, ApiResult, AppState};

/// Stops a published page from reading the API, the network, this origin's storage
/// or a form. `img-src 'self'` is what lets the page show the images the publish
/// copied, and `data:` keeps an inline picture working. `script-src 'unsafe-inline'`
/// lets an inline script draw a chart; it grants no external script, and there is no
/// `connect-src`, so nothing can be fetched. The `sandbox` attribute the web frame
/// adds is the other half of this: `allow-scripts` without `allow-same-origin` gives
/// the page an opaque origin, so it has no storage, no cookie and no API, and the
/// only credential its URL carries is a frame token scoped to that one render. That
/// token cannot be used on another render, another route or with `POST`, so a script
/// that reads or leaks it has nothing it can do with it. `allow-same-origin` must
/// never be added to either half.
const PAGE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

#[derive(Deserialize)]
pub struct Publish {
    html: String,
}

pub async fn publish(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Publish>,
) -> ApiResult<impl IntoResponse> {
    let render = state.core.publish_render(&id, &body.html)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": render.id,
            "url": render.url,
            "frame_token": render.frame_token,
            "images": render.images,
            "bytes": render.bytes,
        })),
    ))
}

pub async fn page(
    State(state): State<AppState>,
    Path((id, render_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    Ok(hardened(state.core.open_render_page(&id, &render_id)?).into_response())
}

pub async fn image(
    State(state): State<AppState>,
    Path((id, render_id, file)): Path<(String, String, String)>,
) -> ApiResult<Response> {
    Ok(hardened(state.core.open_render_image(&id, &render_id, &file)?).into_response())
}

/// Every render response carries the same hardening: a closed page, no sniffing, no
/// referrer, no other origin and never a shared cache.
fn hardened(file: RenderFile) -> (StatusCode, HeaderMap, Body) {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(file.content_type),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(PAGE_CSP),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(file.bytes.len()));
    (StatusCode::OK, headers, Body::from(file.bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_policy_allows_an_inline_script_and_nothing_it_could_reach() {
        assert!(PAGE_CSP.starts_with("default-src 'none'"));
        assert!(PAGE_CSP.contains("img-src 'self' data:"));
        assert!(PAGE_CSP.contains("frame-ancestors 'self'"));
        // An agent's page may draw a chart, so inline script is allowed. That is only
        // safe with the frame's opaque origin and the closed network below.
        assert!(PAGE_CSP.contains("script-src 'unsafe-inline'"));
        for open in [
            "connect-src",
            // No external or same-origin script: the page cannot load code from here.
            "script-src 'self'",
            "'unsafe-eval'",
            "allow-same-origin",
            "http:",
            "https:",
        ] {
            assert!(!PAGE_CSP.contains(open), "{open}");
        }
    }
}
