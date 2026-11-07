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

pub fn startup() -> Url {
    Url::parse(if cfg!(windows) {
        "http://orbyn-startup.localhost/index.html"
    } else {
        "orbyn-startup://localhost/index.html"
    })
    .expect("static startup URL")
}

/// The longest reason the startup document is given, in characters.
const REASON_LIMIT: usize = 160;

/// The one short line the startup document shows for why the service did not start.
/// It is the service's last words, so it loses every word that looks like a path or an
/// address, and its length is capped. Nothing else of a log goes to the page.
pub fn short_reason(text: &str) -> String {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default();
    let words: Vec<&str> = line
        .split_whitespace()
        .filter(|word| !word.contains(['/', '\\']))
        .collect();
    let mut reason: String = words.join(" ").chars().take(REASON_LIMIT).collect();
    if reason.chars().count() == REASON_LIMIT {
        reason.push('…');
    }
    reason
}

/// The startup document after the service stopped or did not start. `repeated` is the
/// service stopping again after its one automatic restart. The reason is shortened here,
/// so every failure goes through the same filter.
pub fn failed(reason: &str, repeated: bool) -> Url {
    let mut target = startup();
    target
        .query_pairs_mut()
        .append_pair("state", if repeated { "repeated" } else { "failed" });
    let reason = short_reason(reason);
    if !repeated && !reason.is_empty() {
        target.query_pairs_mut().append_pair("reason", &reason);
    }
    target
}

/// The startup document while the service starts again by itself after a crash. It
/// shows the state, without buttons.
pub fn restarting() -> Url {
    let mut target = startup();
    target.query_pairs_mut().append_pair("state", "restarting");
    target
}

/// The startup commands (retry, show log, quit) belong only to the separate, static
/// startup document.
pub fn is_startup(url: &Url) -> bool {
    let startup = startup();
    url.scheme() == startup.scheme()
        && url.host_str() == startup.host_str()
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/index.html"
}

/// The check every startup command makes first, on the address its window shows now.
pub fn require_startup(current: &Url) -> Result<(), String> {
    if is_startup(current) {
        Ok(())
    } else {
        Err("Only the startup document can do this.".into())
    }
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
    fn the_restarting_page_is_the_startup_document_and_carries_only_its_state() {
        let page = restarting();
        assert!(is_startup(&page));
        let keys: Vec<_> = page
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(keys, [("state".to_string(), "restarting".to_string())]);
    }

    #[test]
    fn a_failed_start_carries_a_short_reason_and_a_repeat_carries_none() {
        let page = failed("Port 5173 is already in use. (exit 1)", false);
        assert!(is_startup(&page));
        assert!(
            page.query_pairs()
                .any(|(key, value)| key == "state" && value == "failed")
        );
        assert!(page.query_pairs().any(
            |(key, value)| key == "reason" && value == "Port 5173 is already in use. (exit 1)"
        ));
        let again = failed("anything", true);
        assert!(is_startup(&again));
        assert!(
            again
                .query_pairs()
                .any(|(key, value)| key == "state" && value == "repeated")
        );
        assert!(!again.query_pairs().any(|(key, _)| key == "reason"));
        assert!(
            !failed("", false)
                .query_pairs()
                .any(|(key, _)| key == "reason")
        );
    }

    #[test]
    fn the_reason_is_one_short_line_without_paths_or_addresses() {
        assert_eq!(
            short_reason("Cannot read /Users/me/Library/Logs/orbynd.log now"),
            "Cannot read now"
        );
        assert_eq!(
            short_reason("open C:\\Users\\me\\orbynd.log failed"),
            "open failed"
        );
        assert_eq!(
            short_reason("listening on http://127.0.0.1:5173 failed"),
            "listening on failed"
        );
        assert_eq!(short_reason("\nfirst line\nsecond line"), "first line");
        assert_eq!(short_reason("/only/a/path"), "");
        let long = short_reason(&"word ".repeat(100));
        assert_eq!(long.chars().count(), REASON_LIMIT + 1);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn only_the_static_startup_origin_may_use_the_startup_commands() {
        assert!(require_startup(&startup()).is_ok());
        assert!(require_startup(&restarting()).is_ok());
        assert!(require_startup(&failed("It stopped.", false)).is_ok());
        let service = Url::parse("http://127.0.0.1:30001/?token=test").unwrap();
        for denied in [
            // The main window showing the product UI.
            application(&service),
            // A preview window, with and without its route.
            preview(&service, "thread-1", "tab_1").unwrap(),
            Url::parse("tauri://localhost/index.html#/preview/thread-1/tab_1").unwrap(),
            // A remote viewer, the service itself, and lookalike hosts and schemes.
            service.clone(),
            Url::parse("tauri://localhost/index.html").unwrap(),
            Url::parse("http://tauri.localhost/index.html").unwrap(),
            Url::parse("https://example.com/index.html").unwrap(),
            Url::parse("http://orbyn-startup.localhost.evil.test/index.html").unwrap(),
            Url::parse("orbyn-startup://localhost:8080/index.html").unwrap(),
            Url::parse("orbyn-startup://user@localhost/index.html").unwrap(),
            Url::parse("orbyn-startup://localhost/other.html").unwrap(),
            Url::parse("about:blank").unwrap(),
        ] {
            assert!(require_startup(&denied).is_err(), "{denied}");
        }
    }

    #[test]
    fn the_capability_file_gives_the_startup_commands_to_the_main_window_alone() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        // Preview windows are labelled `preview-…` and remote viewers are no window at all.
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert!(capability.get("remote").is_none());
        let mut granted: Vec<_> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap().to_string())
            .collect();
        granted.sort();
        assert_eq!(
            granted,
            [
                "allow-quit-core",
                "allow-restart-core",
                "allow-show-core-log"
            ]
        );
        // The commands are listed in the build script, so no other capability file or
        // plugin default can grant them silently.
        let build = include_str!("../build.rs");
        for command in ["restart_core", "show_core_log", "quit_core"] {
            assert!(build.contains(&format!("\"{command}\"")), "{command}");
        }
    }

    #[test]
    fn preview_keeps_the_bundled_origin_and_rejects_route_injection() {
        let service = Url::parse("http://127.0.0.1:30001/?token=test").unwrap();
        let page = preview(&service, "thread-1", "tab_1").unwrap();
        assert_eq!(page.fragment(), Some("/preview/thread-1/tab_1"));
        // The macOS tauri scheme has opaque URL origins, each with a distinct identity.
        let mut document = page.clone();
        document.set_fragment(None);
        assert_eq!(document, application(&service));
        assert!(
            page.query_pairs()
                .any(|(key, value)| key == "token" && value == "test")
        );
        assert!(preview(&service, "thread/other", "tab").is_none());
        assert!(preview(&service, "thread", "tab#other").is_none());
    }
}
