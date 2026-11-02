//! Who may reach the service. Every route checks `Host` and `Origin`, which
//! defeats DNS rebinding; `/api`, `/agui` and `/ws` also need the per-launch
//! token or a remote session cookie.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;
use orbyn_core::util::{random_token, secrets_match, sha256_hex};

use crate::api::ApiFailure;

const SESSION_COOKIE: &str = "orbyn_session";
const SESSION_LIFETIME: Duration = Duration::from_secs(12 * 60 * 60);

pub struct Access {
    token_sha256: String,
    allowed_hosts: Vec<String>,
    remote: Option<Remote>,
    desktop: bool,
}

struct Remote {
    key_sha256: String,
    sessions: Mutex<HashMap<String, Instant>>,
}

impl Access {
    pub fn new(token: &str, allowed_hosts: Vec<String>, remote_key_sha256: Option<String>) -> Self {
        Self {
            token_sha256: sha256_hex(token.as_bytes()),
            desktop: false,
            allowed_hosts: allowed_hosts
                .into_iter()
                .map(|host| host.to_ascii_lowercase())
                .collect(),
            remote: remote_key_sha256.map(|key_sha256| Remote {
                key_sha256,
                sessions: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Only a shell-owned process accepts the two exact native asset origins.
    pub fn with_desktop(mut self, desktop: bool) -> Self {
        self.desktop = desktop;
        self
    }

    fn host_allowed(&self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        let name = host_name(&host);
        matches!(name, "localhost" | "127.0.0.1" | "[::1]")
            || self.allowed_hosts.iter().any(|allowed| {
                *allowed == host || (!allowed.contains(':') && allowed.as_str() == name)
            })
    }

    fn token_valid(&self, candidate: &str) -> bool {
        secrets_match(candidate, &self.token_sha256)
    }

    fn cookie_valid(&self, headers: &HeaderMap) -> bool {
        let Some(remote) = &self.remote else {
            return false;
        };
        let Some(value) = cookie_value(headers) else {
            return false;
        };
        let digest = sha256_hex(value.as_bytes());
        let mut sessions = remote
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        sessions.retain(|_, expires| *expires > Instant::now());
        sessions.contains_key(&digest)
    }

    /// Exchanges the remote access key for a session. `None` means refused.
    pub fn open_session(&self, key: &str) -> Option<String> {
        let remote = self.remote.as_ref()?;
        if !secrets_match(key, &remote.key_sha256) {
            return None;
        }
        let session = random_token().ok()?;
        remote
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                sha256_hex(session.as_bytes()),
                Instant::now() + SESSION_LIFETIME,
            );
        Some(session)
    }

    pub fn session_cookie(session: &str, secure: bool) -> String {
        format!(
            "{SESSION_COOKIE}={session}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{}",
            SESSION_LIFETIME.as_secs(),
            if secure { "; Secure" } else { "" }
        )
    }
}

/// The host without its port, keeping IPv6 brackets.
fn host_name(host: &str) -> &str {
    if host.starts_with('[') {
        return host.split_inclusive(']').next().unwrap_or(host);
    }
    host.split(':').next().unwrap_or(host)
}

fn cookie_value(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|pair| pair.trim().strip_prefix(&format!("{SESSION_COOKIE}=")))
}

fn origin_matches(origin: &str, host: &str) -> bool {
    origin
        .split_once("://")
        .is_some_and(|(_, authority)| authority.eq_ignore_ascii_case(host))
}

/// Applies to every route, static files and MCP included.
pub async fn guard_origin(
    State(access): State<Arc<Access>>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, ApiFailure> {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            request
                .uri()
                .authority()
                .map(|authority| authority.as_str())
        });
    let Some(host) = host.filter(|host| access.host_allowed(host)) else {
        return Err(ApiFailure::forbidden(
            "host_not_allowed",
            "This host is not allowed.",
        ));
    };
    let origin = request.headers().get(header::ORIGIN).cloned();
    let native = access.desktop
        && matches!(host_name(host), "127.0.0.1" | "localhost" | "[::1]")
        && origin
            .as_ref()
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| matches!(value, "tauri://localhost" | "http://tauri.localhost"));
    if let Some(origin) = &origin
        && !native
        && !origin
            .to_str()
            .is_ok_and(|origin| origin_matches(origin, host))
    {
        return Err(ApiFailure::forbidden(
            "origin_not_allowed",
            "This origin is not allowed.",
        ));
    }
    if native && request.method() == Method::OPTIONS {
        if !native_preflight(&request) {
            return Err(ApiFailure::forbidden(
                "origin_not_allowed",
                "This request is not allowed.",
            ));
        }
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        native_headers(response.headers_mut(), origin.expect("native origin"));
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, HEAD, POST, PUT, PATCH, DELETE"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(NATIVE_HEADERS),
        );
        return Ok(response);
    }
    let mut response = next.run(request).await;
    if native {
        native_headers(response.headers_mut(), origin.expect("native origin"));
    }
    Ok(response)
}

const NATIVE_HEADERS: &str =
    "authorization, content-type, accept, last-event-id, range, if-range, if-none-match";

fn native_preflight(request: &Request<Body>) -> bool {
    let path = request.uri().path();
    if !(path.starts_with("/api/") || path.starts_with("/ws/")) {
        return false;
    }
    let method = request
        .headers()
        .get(header::ACCESS_CONTROL_REQUEST_METHOD)
        .and_then(|value| value.to_str().ok());
    if !matches!(
        method,
        Some("GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE")
    ) {
        return false;
    }
    request
        .headers()
        .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
        .is_none_or(|value| {
            value.to_str().is_ok_and(|text| {
                text.split(',').all(|name| {
                    NATIVE_HEADERS
                        .split(',')
                        .any(|allowed| allowed.trim().eq_ignore_ascii_case(name.trim()))
                })
            })
        })
}

fn native_headers(headers: &mut HeaderMap, origin: HeaderValue) {
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.append(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("content-range, accept-ranges, etag, content-disposition"),
    );
}

/// Applies to `/api`, `/agui` and `/ws`.
pub async fn require_auth(
    State(access): State<Arc<Access>>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, ApiFailure> {
    if authorized(&access, &request) {
        Ok(next.run(request).await)
    } else {
        Err(ApiFailure::unauthorized())
    }
}

fn authorized(access: &Access, request: &Request<Body>) -> bool {
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if bearer.is_some_and(|token| access.token_valid(token)) {
        return true;
    }
    if access.cookie_valid(request.headers()) {
        return true;
    }
    // Browsers cannot set headers on EventSource, WebSocket or an image or video
    // element, so only those read routes take the token in the URL.
    let path = request.uri().path();
    let streaming = matches!(*request.method(), Method::GET | Method::HEAD)
        && (path.starts_with("/ws/")
            || path.ends_with("/events")
            || path.ends_with("/files/raw")
            || project_image_read(path));
    streaming && query_token(request).is_some_and(|token| access.token_valid(token))
}

/// Image elements may address only these registered-project image capabilities.
fn project_image_read(path: &str) -> bool {
    let Some(tail) = path.strip_prefix("/api/projects/") else {
        return false;
    };
    let mut parts = tail.split('/');
    matches!((parts.next(), parts.next(), parts.next(), parts.next()),
        (Some(id), Some("icon" | "images"), Some("raw"), None) if !id.is_empty())
}

fn query_token(request: &Request<Body>) -> Option<&str> {
    request
        .uri()
        .query()?
        .split('&')
        .find_map(|pair| pair.strip_prefix("token="))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn access() -> Access {
        Access::new(
            "secret",
            vec!["box.tailnet.ts.net".into(), "proxy.test:8443".into()],
            Some(sha256_hex(b"key")),
        )
    }

    #[test]
    fn loopback_and_configured_hosts_pass_and_others_fail() {
        let access = access();
        for host in [
            "127.0.0.1:1234",
            "localhost:1",
            "LOCALHOST",
            "[::1]:9",
            "box.tailnet.ts.net:80",
            "proxy.test:8443",
        ] {
            assert!(access.host_allowed(host), "{host}");
        }
        for host in [
            "evil.test",
            "127.0.0.1.evil.test",
            "localhost.evil.test:1",
            "proxy.test:9999",
        ] {
            assert!(!access.host_allowed(host), "{host}");
        }
    }

    #[test]
    fn project_image_query_tokens_are_only_for_exact_read_routes() {
        let access = access();
        for path in ["/api/projects/p/icon/raw", "/api/projects/p/images/raw"] {
            for method in [Method::GET, Method::HEAD] {
                let request = Request::builder()
                    .method(method)
                    .uri(format!("{path}?token=secret"))
                    .body(Body::empty())
                    .unwrap();
                assert!(authorized(&access, &request), "{path}");
            }
            let request = Request::builder()
                .method(Method::POST)
                .uri(format!("{path}?token=secret"))
                .body(Body::empty())
                .unwrap();
            assert!(!authorized(&access, &request), "{path}");
        }
        for path in [
            "/api/projects/p/icon/resource",
            "/api/settings/projects/image",
            "/api/projects/p/nested/icon/raw",
            "/api/projects//images/raw",
            "/other/projects/p/icon/raw",
        ] {
            let request = Request::builder()
                .uri(format!("{path}?token=secret"))
                .body(Body::empty())
                .unwrap();
            assert!(!authorized(&access, &request), "{path}");
        }
    }

    #[test]
    fn origin_must_match_host_exactly() {
        assert!(origin_matches("http://127.0.0.1:5", "127.0.0.1:5"));
        assert!(!origin_matches("http://127.0.0.1:6", "127.0.0.1:5"));
        assert!(!origin_matches("http://evil.test", "127.0.0.1:5"));
        assert!(!origin_matches("null", "127.0.0.1:5"));
    }

    #[test]
    fn session_needs_the_key_and_is_stored_hashed() {
        let access = access();
        assert!(access.open_session("wrong").is_none());
        let session = access.open_session("key").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("a=b; orbyn_session={session}").parse().unwrap(),
        );
        assert!(access.cookie_valid(&headers));
        headers.insert(header::COOKIE, "orbyn_session=forged".parse().unwrap());
        assert!(!access.cookie_valid(&headers));
    }

    #[test]
    fn local_mode_has_no_sessions() {
        let access = Access::new("secret", Vec::new(), None);
        assert!(access.open_session("anything").is_none());
    }

    #[test]
    fn cookie_attributes_match_the_contract() {
        let cookie = Access::session_cookie("v", false);
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(!cookie.contains("Secure"));
        assert!(Access::session_cookie("v", true).contains("Secure"));
    }
}
