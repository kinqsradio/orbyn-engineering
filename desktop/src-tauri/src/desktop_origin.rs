//! Stable UI storage is separate from the replaceable loopback service.
use url::Url;

pub fn application(service: &Url) -> Url {
    let mut target = Url::parse(if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    })
    .expect("static asset URL");
    target.query_pairs_mut().append_pair(
        "service_origin",
        service.origin().ascii_serialization().as_str(),
    );
    if let Some((_, token)) = service.query_pairs().find(|(key, _)| key == "token") {
        target.query_pairs_mut().append_pair("token", &token);
    }
    target
}

/// A dedicated viewer for the existing preview, on the same bundled origin.
pub fn preview(service: &Url, thread_id: &str, tab_id: &str) -> Option<Url> {
    let valid = |id: &str| {
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    };
    if !valid(thread_id) || !valid(tab_id) {
        return None;
    }
    let mut target = application(service);
    target.set_fragment(Some(&format!("/preview/{thread_id}/{tab_id}")));
    Some(target)
}

pub fn startup(error: Option<&str>) -> Url {
    let mut target = Url::parse(if cfg!(windows) {
        "http://orbyn-startup.localhost/index.html"
    } else {
        "orbyn-startup://localhost/index.html"
    })
    .expect("static startup URL");
    if let Some(message) = error {
        target.query_pairs_mut().append_pair("error", message);
    }
    target
}

/// The retry command belongs only to the separate, static startup document.
pub fn is_startup(url: &Url) -> bool {
    url.scheme() == startup(None).scheme()
        && url.host_str() == startup(None).host_str()
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/index.html"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changing_service_ports_keeps_one_ui_origin_and_forwards_only_launch_fields() {
        let first =
            application(&Url::parse("http://127.0.0.1:30001/?token=one&ignored=x").unwrap());
        let second = application(&Url::parse("http://127.0.0.1:30002/?token=two").unwrap());
        assert_eq!(first.scheme(), second.scheme());
        assert_eq!(first.host_str(), second.host_str());
        assert_eq!(first.port(), second.port());
        assert_eq!(first.query_pairs().count(), 2);
        assert!(
            first
                .query_pairs()
                .any(|(key, value)| key == "service_origin" && value == "http://127.0.0.1:30001")
        );
        assert!(
            second
                .query_pairs()
                .any(|(key, value)| key == "token" && value == "two")
        );
        assert!(!is_startup(&first));
    }
    #[test]
    fn only_the_static_startup_origin_may_retry() {
        assert!(is_startup(&startup(Some("<untrusted service error>"))));
        for text in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "http://127.0.0.1:3000/index.html",
            "orbyn-startup://evil/index.html",
            "orbyn-startup://localhost/other.html",
        ] {
            assert!(!is_startup(&Url::parse(text).unwrap()));
        }
    }

    #[test]
    fn preview_keeps_the_bundled_origin_and_rejects_route_injection() {
        let service = Url::parse("http://127.0.0.1:30001/?token=test").unwrap();
        let page = preview(&service, "thread-1", "tab_1").unwrap();
        assert_eq!(page.origin(), application(&service).origin());
        assert_eq!(page.fragment(), Some("/preview/thread-1/tab_1"));
        assert!(
            page.query_pairs()
                .any(|(key, value)| key == "token" && value == "test")
        );
        assert!(preview(&service, "thread/other", "tab").is_none());
        assert!(preview(&service, "thread", "tab#other").is_none());
    }
}
