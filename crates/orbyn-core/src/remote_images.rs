//! Bounded remote raster images. DNS is checked once and pinned to the HTTP client;
//! redirects, environment proxies and caller credentials never reach this boundary.

use std::collections::VecDeque;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::{Client, Url, header};
use tokio::sync::Semaphore;

const MAX_BYTES: usize = 5 * 1024 * 1024;
const CACHE_BYTES: usize = 32 * 1024 * 1024;
const CACHE_ENTRIES: usize = 32;
const TTL: Duration = Duration::from_secs(60);
const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct RemoteImage {
    pub bytes: Arc<Vec<u8>>,
    pub content_type: &'static str,
}

struct Entry {
    url: String,
    at: Instant,
    image: RemoteImage,
}

pub struct ImageProxy {
    cache: Mutex<VecDeque<Entry>>,
    permits: Semaphore,
}

impl Default for ImageProxy {
    fn default() -> Self {
        Self {
            cache: Mutex::new(VecDeque::new()),
            permits: Semaphore::new(4),
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("Remote image is unavailable.")]
pub struct ImageUnavailable;

impl ImageProxy {
    pub async fn get(&self, raw: &str) -> Result<RemoteImage, ImageUnavailable> {
        self.get_with_fetch(raw, fetch).await
    }

    async fn get_with_fetch<F, Fut>(
        &self,
        raw: &str,
        fetch_image: F,
    ) -> Result<RemoteImage, ImageUnavailable>
    where
        F: FnOnce(Url) -> Fut,
        Fut: std::future::Future<Output = Result<RemoteImage, ImageUnavailable>>,
    {
        let url = image_url(raw)?;
        {
            let mut cache = self.cache.lock().map_err(|_| ImageUnavailable)?;
            cache.retain(|entry| entry.at.elapsed() < TTL);
            if let Some(entry) = cache.iter().find(|entry| entry.url == url.as_str()) {
                return Ok(entry.image.clone());
            }
        }
        // Queue waiting, DNS, TLS and the entire body share one budget. Dropping
        // this future cancels the waiter or releases its active fetch permit.
        let image = tokio::time::timeout(TIMEOUT, async {
            let _permit = self.permits.acquire().await.map_err(|_| ImageUnavailable)?;
            fetch_image(url.clone()).await
        })
        .await
        .map_err(|_| ImageUnavailable)??;
        self.remember(url, image.clone())?;
        Ok(image)
    }

    fn remember(&self, url: Url, image: RemoteImage) -> Result<(), ImageUnavailable> {
        let mut cache = self.cache.lock().map_err(|_| ImageUnavailable)?;
        cache.retain(|entry| entry.at.elapsed() < TTL && entry.url != url.as_str());
        while cache.len() >= CACHE_ENTRIES
            || cache
                .iter()
                .map(|entry| entry.image.bytes.len())
                .sum::<usize>()
                + image.bytes.len()
                > CACHE_BYTES
        {
            cache.pop_front();
        }
        cache.push_back(Entry {
            url: url.into(),
            at: Instant::now(),
            image: image.clone(),
        });
        Ok(())
    }
}

fn image_url(raw: &str) -> Result<Url, ImageUnavailable> {
    if raw.len() > 4096 {
        return Err(ImageUnavailable);
    }
    let mut url = Url::parse(raw).map_err(|_| ImageUnavailable)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || url.host_str().is_none()
    {
        return Err(ImageUnavailable);
    }
    url.set_fragment(None);
    Ok(url)
}

/// Conservative public-unicast allowlist, including refusal of transition and
/// mapped IPv6 ranges that can encode a private IPv4 destination.
fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(matches!(a, 0 | 10 | 127 | 224..=255)
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && (b == 168 || (b == 0 && matches!(c, 0 | 2)) || (b == 88 && c == 99)))
                || (a == 198 && ((18..=19).contains(&b) || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            (segments[0] & 0xe000) == 0x2000
                && !(segments[0] == 0x2001 && (segments[1] < 0x0200 || segments[1] == 0x0db8))
                && segments[0] != 0x2002
                && !(segments[0] == 0x3fff && segments[1] < 0x1000)
        }
    }
}

fn pinned_client(host: &str, addresses: &[SocketAddr]) -> Result<Client, ImageUnavailable> {
    if addresses.len() > 16
        || addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !public_address(address.ip()))
    {
        return Err(ImageUnavailable);
    }
    Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .referer(false)
        .resolve_to_addrs(host, addresses)
        .build()
        .map_err(|_| ImageUnavailable)
}

async fn fetch(url: Url) -> Result<RemoteImage, ImageUnavailable> {
    let host = url
        .host_str()
        .ok_or(ImageUnavailable)?
        .trim_matches(['[', ']']);
    let addresses: Vec<_> = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|_| ImageUnavailable)?
        .take(17)
        .collect();
    let client = pinned_client(host, &addresses)?;
    let response = client
        .get(url)
        .header(
            header::ACCEPT,
            "image/png,image/jpeg,image/gif,image/webp,image/x-icon",
        )
        .send()
        .await
        .map_err(|_| ImageUnavailable)?;
    read_image(response).await
}

async fn read_image(mut response: reqwest::Response) -> Result<RemoteImage, ImageUnavailable> {
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|size| size > MAX_BYTES as u64)
        || response.headers().contains_key(header::CONTENT_ENCODING)
    {
        return Err(ImageUnavailable);
    }
    let content_type = match response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
    {
        Some("image/png") => "image/png",
        Some("image/jpeg") => "image/jpeg",
        Some("image/gif") => "image/gif",
        Some("image/webp") => "image/webp",
        Some("image/x-icon" | "image/vnd.microsoft.icon") => "image/x-icon",
        _ => return Err(ImageUnavailable),
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ImageUnavailable)? {
        if chunk.len() > MAX_BYTES - bytes.len() {
            return Err(ImageUnavailable);
        }
        bytes.extend_from_slice(&chunk);
    }
    let signature_matches = match content_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "image/x-icon" => bytes.starts_with(b"\x00\x00\x01\x00"),
        _ => false,
    };
    if !signature_matches {
        return Err(ImageUnavailable);
    }
    Ok(RemoteImage {
        bytes: Arc::new(bytes),
        content_type,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn fixture(status: &str, headers: &str, body: Vec<u8>) -> reqwest::Response {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let reply = format!("HTTP/1.1 {status}\r\n{headers}\r\nConnection: close\r\n\r\n");
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
                assert!(request.len() <= 4096);
            }
            // Refusal may close the connection while the fixture is writing.
            if socket.write_all(reply.as_bytes()).await.is_ok() {
                let _ = socket.write_all(&body).await;
            }
        });
        Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn validates_upstream_status_type_signature_encoding_and_stream_limit() {
        let png = b"\x89PNG\r\n\x1a\n".to_vec();
        let image = read_image(fixture("200 OK", "Content-Type: image/png", png.clone()).await)
            .await
            .unwrap();
        assert_eq!(image.bytes.as_ref(), &png);
        for (status, headers, body) in [
            (
                "302 Found",
                "Location: https://127.0.0.1/image\r\nContent-Type: image/png",
                png.clone(),
            ),
            ("404 Not Found", "Content-Type: image/png", png.clone()),
            ("200 OK", "Content-Type: image/svg+xml", b"<svg/>".to_vec()),
            ("200 OK", "Content-Type: text/html", b"<html/>".to_vec()),
            ("200 OK", "Content-Type: image/png", b"<svg/>".to_vec()),
            (
                "200 OK",
                "Content-Type: image/png\r\nContent-Encoding: gzip",
                png.clone(),
            ),
            (
                "200 OK",
                "Content-Type: image/png\r\nContent-Length: 5242881",
                png.clone(),
            ),
            ("200 OK", "Content-Type: image/png", vec![0; MAX_BYTES + 1]),
        ] {
            assert!(
                read_image(fixture(status, headers, body).await)
                    .await
                    .is_err(),
                "{status} {headers}"
            );
        }
    }

    #[tokio::test]
    async fn cache_hit_does_not_fetch_and_private_destinations_are_refused() {
        let proxy = ImageProxy::default();
        let image = RemoteImage {
            bytes: Arc::new(vec![1, 2, 3]),
            content_type: "image/png",
        };
        proxy.cache.lock().unwrap().push_back(Entry {
            url: "https://example.com/a".into(),
            at: Instant::now(),
            image,
        });
        assert_eq!(
            proxy
                .get("https://example.com/a#fragment")
                .await
                .unwrap()
                .bytes
                .as_ref(),
            &[1, 2, 3]
        );
        assert!(proxy.get("https://127.0.0.1/a").await.is_err());
        assert!(proxy.get("https://[::1]/a").await.is_err());
        let _permits = proxy.permits.acquire_many(4).await.unwrap();
        assert!(proxy.get("https://example.com/uncached").await.is_err());
    }

    fn tiny_image() -> RemoteImage {
        RemoteImage {
            bytes: Arc::new(b"\x89PNG\r\n\x1a\n".to_vec()),
            content_type: "image/png",
        }
    }

    #[tokio::test(start_paused = true)]
    async fn eight_uncached_images_wait_for_four_fetch_slots() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let proxy = ImageProxy::default();
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let started = tokio::time::Instant::now();
        let results = futures_util::future::join_all((0..8).map(|index| {
            let proxy = &proxy;
            let active = &active;
            let peak = &peak;
            async move {
                proxy
                    .get_with_fetch(&format!("https://example.com/{index}"), |_| async {
                        let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(count, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(tiny_image())
                    })
                    .await
            }
        }))
        .await;
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 8);
        assert_eq!(peak.load(Ordering::SeqCst), 4);
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(started.elapsed(), Duration::from_secs(2));
        assert_eq!(proxy.permits.available_permits(), 4);
        assert_eq!(proxy.cache.lock().unwrap().len(), 8);
    }

    #[tokio::test(start_paused = true)]
    async fn cached_image_bypasses_a_saturated_fetch_queue() {
        let proxy = ImageProxy::default();
        let url = Url::parse("https://example.com/cached").unwrap();
        proxy.remember(url, tiny_image()).unwrap();
        let _held = proxy.permits.acquire_many(4).await.unwrap();
        let started = tokio::time::Instant::now();
        assert!(
            proxy
                .get_with_fetch("https://example.com/cached#fragment", |_| async {
                    panic!("a cache hit must not fetch")
                })
                .await
                .is_ok()
        );
        assert_eq!(started.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn queued_request_expires_without_starting_a_fetch() {
        let proxy = ImageProxy::default();
        let held = proxy.permits.acquire_many(4).await.unwrap();
        let started = tokio::time::Instant::now();
        let result = proxy
            .get_with_fetch("https://example.com/queued", |_| async {
                panic!("an expired queued request must not fetch")
            })
            .await;
        assert!(result.is_err());
        assert_eq!(started.elapsed(), TIMEOUT);
        assert!(proxy.cache.lock().unwrap().is_empty());
        drop(held);
        assert_eq!(proxy.permits.available_permits(), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn queue_wait_and_fetch_share_one_deadline() {
        let proxy = ImageProxy::default();
        let held = proxy.permits.acquire_many(4).await.unwrap();
        let started = tokio::time::Instant::now();
        let fetch_started = std::cell::Cell::new(false);
        let (_, result) = tokio::join!(
            async {
                tokio::time::sleep(Duration::from_secs(4)).await;
                drop(held);
            },
            proxy.get_with_fetch("https://example.com/slow", |_| async {
                fetch_started.set(true);
                tokio::time::sleep(Duration::from_secs(2)).await;
                Ok(tiny_image())
            })
        );
        assert!(fetch_started.get());
        assert!(result.is_err());
        assert_eq!(started.elapsed(), TIMEOUT);
        assert_eq!(proxy.permits.available_permits(), 4);
        assert!(proxy.cache.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_and_failure_release_slots() {
        let proxy = ImageProxy::default();
        let held = proxy.permits.acquire_many(4).await.unwrap();
        // Dropping a queued request must remove its semaphore waiter.
        assert!(
            tokio::time::timeout(
                Duration::from_secs(1),
                proxy.get_with_fetch("https://example.com/cancel-queued", |_| async {
                    panic!("a queued request cannot fetch")
                })
            )
            .await
            .is_err()
        );
        drop(held);
        assert_eq!(proxy.permits.available_permits(), 4);

        let fetch_started = std::cell::Cell::new(false);
        assert!(
            tokio::time::timeout(
                Duration::from_secs(1),
                proxy.get_with_fetch("https://example.com/cancel-active", |_| async {
                    fetch_started.set(true);
                    std::future::pending().await
                })
            )
            .await
            .is_err()
        );
        assert!(fetch_started.get());
        assert_eq!(proxy.permits.available_permits(), 4);
        assert!(
            proxy
                .get_with_fetch("https://example.com/failed", |_| async {
                    Err(ImageUnavailable)
                })
                .await
                .is_err()
        );
        assert_eq!(proxy.permits.available_permits(), 4);
        assert!(proxy.cache.lock().unwrap().is_empty());
        assert!(
            proxy
                .get_with_fetch("https://example.com/recovered", |_| async {
                    Ok(tiny_image())
                })
                .await
                .is_ok()
        );
        assert_eq!(proxy.permits.available_permits(), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn cache_bounds_and_expiry() {
        let proxy = ImageProxy::default();
        let image = RemoteImage {
            bytes: Arc::new(vec![0; MAX_BYTES]),
            content_type: "image/png",
        };
        for index in 0..40 {
            proxy
                .remember(
                    Url::parse(&format!("https://example.com/{index}")).unwrap(),
                    image.clone(),
                )
                .unwrap();
        }
        {
            let cache = proxy.cache.lock().unwrap();
            assert_eq!(cache.len(), CACHE_BYTES / MAX_BYTES);
            assert_eq!(cache.front().unwrap().url, "https://example.com/34");
        }
        let small = RemoteImage {
            bytes: Arc::new(vec![1]),
            content_type: "image/png",
        };
        for index in 0..40 {
            proxy
                .remember(
                    Url::parse(&format!("https://example.com/small/{index}")).unwrap(),
                    small.clone(),
                )
                .unwrap();
        }
        {
            let mut cache = proxy.cache.lock().unwrap();
            assert_eq!(cache.len(), CACHE_ENTRIES);
            assert_eq!(cache.front().unwrap().url, "https://example.com/small/8");
            for entry in cache.iter_mut() {
                entry.at = Instant::now() - TTL;
            }
        }
        let _permits = proxy.permits.acquire_many(4).await.unwrap();
        assert!(proxy.get("https://example.com/small/39").await.is_err());
        assert!(proxy.cache.lock().unwrap().is_empty());
    }

    #[test]
    fn refuses_nonpublic_and_transition_addresses() {
        for ip in [
            "0.0.0.0",
            "10.0.0.1",
            "127.0.0.1",
            "100.100.100.200",
            "169.254.169.254",
            "172.16.1.1",
            "192.168.0.1",
            "192.0.0.9",
            "192.0.2.1",
            "192.88.99.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "64:ff9b::7f00:1",
            "2002:7f00:1::",
            "2001::1",
            "2001:db8::1",
            "3fff::1",
        ] {
            assert!(!public_address(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
        ] {
            assert!(public_address(ip.parse().unwrap()), "{ip}");
        }
        assert!(pinned_client("example.com", &[]).is_err());
        assert!(
            pinned_client(
                "example.com",
                &[
                    "8.8.8.8:443".parse().unwrap(),
                    "127.0.0.1:443".parse().unwrap()
                ]
            )
            .is_err()
        );
    }

    #[test]
    fn url_boundary() {
        for url in [
            "http://example.com/a.png",
            "file:///a.png",
            "https://user@example.com/a",
            "https://user:pass@example.com/a",
            "https://example.com:444/a",
            "data:image/png,x",
        ] {
            assert!(image_url(url).is_err(), "{url}");
        }
        assert!(image_url(&format!("https://example.com/{}", "a".repeat(4096))).is_err());
        assert_eq!(
            image_url("https://example.com/a?q=1#x").unwrap().as_str(),
            "https://example.com/a?q=1"
        );
    }
}
