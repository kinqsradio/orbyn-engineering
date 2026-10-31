//! Static UI with SPA fallback and a strict content security policy.

use std::path::{Component, Path, PathBuf};

use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};

use crate::api::{ApiFailure, AppState};

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
    img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; \
    base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const SERVICE_PREFIXES: &[&str] = &["/api", "/agui", "/ws", "/mcp", "/auth"];

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Maps a URL path into `root`, refusing anything but plain components.
fn resolve(root: &Path, url_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(url_path)?;
    let relative = Path::new(decoded.trim_start_matches('/'));
    relative
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
        .then(|| root.join(relative))
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(pair, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub async fn serve(State(state): State<AppState>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    if SERVICE_PREFIXES
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
    {
        return ApiFailure::new(StatusCode::NOT_FOUND, "not_found", "No such route.")
            .into_response();
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Some(root) = state.ui_dir.as_deref() else {
        return ApiFailure::new(StatusCode::NOT_FOUND, "no_ui", "No UI is installed.")
            .into_response();
    };
    let target = resolve(root, &path)
        .filter(|candidate| candidate.is_file())
        .unwrap_or_else(|| root.join("index.html"));
    match tokio::fs::read(&target).await {
        Ok(bytes) => {
            let mut response = bytes.into_response();
            let headers = response.headers_mut();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(content_type(&target)),
            );
            headers.insert(
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(CSP),
            );
            headers.insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            headers.insert(
                header::REFERRER_POLICY,
                HeaderValue::from_static("no-referrer"),
            );
            response
        }
        Err(_) => {
            ApiFailure::new(StatusCode::NOT_FOUND, "no_ui", "No UI is installed.").into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_is_refused_in_any_spelling() {
        let root = Path::new("/ui");
        assert_eq!(
            resolve(root, "/assets/a.js"),
            Some(PathBuf::from("/ui/assets/a.js"))
        );
        assert_eq!(resolve(root, "/../secret"), None);
        assert_eq!(resolve(root, "/a/%2e%2e/%2e%2e/secret"), None);
        assert_eq!(resolve(root, "/%ff"), None);
    }
}
