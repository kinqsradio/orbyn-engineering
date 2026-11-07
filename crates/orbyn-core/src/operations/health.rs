//! Whether the app's outside dependencies answer from here: GitHub, and each
//! provider's service. Asked for, never scheduled. A check sends one empty `GET` to
//! the host's front door and reads only the status line, so no credential, project
//! or thread detail leaves the machine.

use std::time::{Duration, Instant};

use orbyn_contracts::{DependencyCheck, DependencyHealth, ProviderHealth};

use crate::app::Core;
use crate::error::Result;
use crate::util::now;

const CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const GITHUB: &str = "https://api.github.com/";

/// The front door of a provider family's service.
fn provider_service(family: &str) -> Option<&'static str> {
    match family {
        "claude" => Some("https://api.anthropic.com/"),
        "codex" => Some("https://api.openai.com/"),
        _ => None,
    }
}

fn host_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| url.to_owned())
}

/// One `GET` to `url`. Any HTTP answer, even an error status, means the host is reachable.
pub(crate) async fn check_url(client: &reqwest::Client, url: &str) -> DependencyCheck {
    let started = Instant::now();
    let result = client.get(url).timeout(CHECK_TIMEOUT).send().await;
    let latency = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match result {
        Ok(response) => DependencyCheck {
            host: host_of(url),
            checked: true,
            reachable: true,
            status: Some(response.status().as_u16()),
            latency_ms: Some(latency),
            message: None,
        },
        Err(error) => DependencyCheck {
            host: host_of(url),
            checked: true,
            reachable: false,
            status: None,
            latency_ms: None,
            message: Some(if error.is_timeout() {
                "No answer in time.".to_owned()
            } else {
                error.without_url().to_string()
            }),
        },
    }
}

fn not_checked(url: &str) -> DependencyCheck {
    DependencyCheck {
        host: host_of(url),
        checked: false,
        reachable: false,
        status: None,
        latency_ms: None,
        message: Some("Offline mode: no outside request is made.".to_owned()),
    }
}

impl Core {
    /// Checks GitHub and each installed provider's service. In offline mode nothing is
    /// sent, and every check says it was not made.
    pub async fn dependency_health(&self) -> Result<DependencyHealth> {
        let online = self.config.engines.lookup_latest;
        let check = |url: &'static str| async move {
            if online {
                check_url(&self.http, url).await
            } else {
                not_checked(url)
            }
        };
        let github = check(GITHUB).await;
        let mut providers = Vec::new();
        for status in self.engines.statuses(false).await? {
            let family = status
                .instance_of
                .clone()
                .unwrap_or_else(|| status.id.clone());
            let service = match provider_service(&family) {
                Some(url) if status.installed => Some(check(url).await),
                _ => None,
            };
            providers.push(ProviderHealth {
                engine: status.id,
                name: status.name,
                installed: status.installed,
                auth: status.auth,
                problem: status.problem,
                service,
            });
        }
        Ok(DependencyHealth {
            checked_at: now(),
            github,
            providers,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn answering(status_line: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = [0; 1024];
                let _ = socket.read(&mut buffer).await;
                let reply = format!("HTTP/1.1 {status_line}\r\ncontent-length: 0\r\n\r\n");
                let _ = socket.write_all(reply.as_bytes()).await;
            }
        });
        format!("http://{address}/")
    }

    #[tokio::test]
    async fn any_http_answer_is_reachable_even_an_error_status() {
        let url = answering("404 Not Found").await;
        let check = check_url(&reqwest::Client::new(), &url).await;
        assert!(check.reachable && check.checked);
        assert_eq!(check.status, Some(404));
        assert!(check.latency_ms.is_some() && check.message.is_none());
    }

    #[tokio::test]
    async fn a_host_that_does_not_answer_is_unreachable_with_a_reason() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        drop(listener);
        let check = check_url(&reqwest::Client::new(), &url).await;
        assert!(!check.reachable && check.checked);
        assert!(check.status.is_none() && check.message.is_some());
    }

    #[test]
    fn only_claude_and_codex_families_have_a_service_host() {
        assert_eq!(
            provider_service("claude"),
            Some("https://api.anthropic.com/")
        );
        assert_eq!(provider_service("codex"), Some("https://api.openai.com/"));
        assert_eq!(provider_service("my-acp"), None);
    }
}
