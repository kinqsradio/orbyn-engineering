//! Who may reach the service. Every route checks `Host` and `Origin`, which
//! defeats DNS rebinding; `/api`, `/agui` and `/ws` also need the per-launch
//! token or a remote session cookie.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, header};
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
}

struct Remote {
    key_sha256: String,
    sessions: Mutex<HashMap<String, Instant>>,
}

impl Access {
    pub fn new(token: &str, allowed_hosts: Vec<String>, remote_key_sha256: Option<String>) -> Self {
        Self {
            token_sha256: sha256_hex(token.as_bytes()),
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
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        let allowed = origin
            .to_str()
            .is_ok_and(|origin| origin_matches(origin, host));
        if !allowed {
            return Err(ApiFailure::forbidden(
                "origin_not_allowed",
                "This origin is not allowed.",
            ));
        }
    }
    Ok(next.run(request).await)
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
    // Browsers cannot set headers on EventSource or WebSocket, so only those
    // read routes take the token in the URL.
    let streaming = request.method() == Method::GET
        && (request.uri().path().starts_with("/ws/") || request.uri().path().ends_with("/events"));
    streaming && query_token(request).is_some_and(|token| access.token_valid(token))
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
