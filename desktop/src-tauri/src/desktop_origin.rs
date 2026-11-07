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

/// Characters that only steer how text is drawn: bidirectional overrides, isolates and marks.
fn is_direction(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' | '\u{061C}')
}

/// A word that could carry a path, an address, a credential or an opaque token.
fn is_sensitive_word(word: &str) -> bool {
    if word.contains(['/', '\\', '@', '=']) {
        return true;
    }
    // `host:port` and `127.0.0.1:5173`.
    let mut chars = word.chars().peekable();
    while let Some(c) = chars.next() {
        if c == ':' && chars.peek().is_some_and(char::is_ascii_digit) {
            return true;
        }
    }
    // Twenty or more hex or base64-like characters in a row.
    word.split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '_' | '-')))
        .any(|run| run.len() >= 20)
}

/// The one short line the startup document shows for why the service did not start.
/// It is the service's last words, so it keeps only the first non-empty line, drops
/// control and text-direction characters, drops each word that looks like a path, an
/// address (`host:port`), an `@` or `=` value, or a 20-character token, and is cut at
/// 160 characters with an ellipsis only when something was cut. Nothing else of a log
/// goes to the page.
pub fn short_reason(text: &str) -> String {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default();
    let clean: String = line
        .chars()
        .filter(|c| !c.is_control() && !is_direction(*c))
        .collect();
    let words: Vec<&str> = clean
        .split_whitespace()
        .filter(|word| !is_sensitive_word(word))
        .collect();
    let joined = words.join(" ");
    if joined.chars().count() <= REASON_LIMIT {
        return joined;
    }
    let mut reason: String = joined.chars().take(REASON_LIMIT).collect();
    reason.push('…');
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
    fn a_useful_reason_is_kept() {
        assert_eq!(
            short_reason("Port 5173 is already in use."),
            "Port 5173 is already in use."
        );
        assert_eq!(
            short_reason("Another service holds this folder. (exit 1)"),
            "Another service holds this folder. (exit 1)"
        );
        assert_eq!(short_reason("\nfirst line\nsecond line"), "first line");
    }

    #[test]
    fn words_that_look_like_paths_are_dropped() {
        assert_eq!(
            short_reason("Cannot read /Users/me/Library/Logs/orbynd.log now"),
            "Cannot read now"
        );
        assert_eq!(
            short_reason("open C:\\Users\\me\\orbynd.log failed"),
            "open failed"
        );
        assert_eq!(short_reason("/only/a/path"), "");
    }

    #[test]
    fn words_with_at_or_equals_are_dropped() {
        assert_eq!(short_reason("login me@example.com failed"), "login failed");
        assert_eq!(short_reason("token=abc failed"), "failed");
    }

    #[test]
    fn host_and_port_words_are_dropped() {
        assert_eq!(short_reason("bind 127.0.0.1:5173 failed"), "bind failed");
        assert_eq!(short_reason("bind localhost:5173 failed"), "bind failed");
        assert_eq!(
            short_reason("listening on http://127.0.0.1:5173 failed"),
            "listening on failed"
        );
    }

    #[test]
    fn a_long_hex_or_token_run_is_dropped() {
        assert_eq!(
            short_reason("key 0123456789abcdef0123456789abcdef stopped"),
            "key stopped"
        );
        assert_eq!(
            short_reason("key abcDEF123+_-abcDEF123456 stopped"),
            "key stopped"
        );
        assert_eq!(
            short_reason("id 0123456789abcdef012 stopped"),
            "id 0123456789abcdef012 stopped"
        );
    }

    #[test]
    fn control_and_direction_characters_are_dropped() {
        assert_eq!(
            short_reason("Port\u{7} 5173\u{1b}[31m busy"),
            "Port 5173[31m busy"
        );
        assert_eq!(
            short_reason("a\u{202E}b\u{2066}c\u{200F}d\u{061C}e"),
            "abcde"
        );
    }

    #[test]
    fn a_reason_is_cut_whole_characters_and_marked_only_when_cut() {
        let exact = "é".repeat(REASON_LIMIT);
        assert_eq!(short_reason(&exact), exact);
        let over = "é".repeat(REASON_LIMIT + 1);
        let cut = short_reason(&over);
        assert_eq!(cut.chars().count(), REASON_LIMIT + 1);
        assert_eq!(cut, format!("{}…", "é".repeat(REASON_LIMIT)));
        let emoji = short_reason(&"🙂".repeat(REASON_LIMIT + 5));
        assert!(emoji.ends_with("🙂…"));
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
        // No other capability file grants any of them.
        let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        for entry in std::fs::read_dir(folder).unwrap() {
            let path = entry.unwrap().path();
            if path.file_name().is_some_and(|name| name == "main.json") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            for permission in [
                "restart-core",
                "show-core-log",
                "quit-core",
                "restart_core",
                "show_core_log",
                "quit_core",
            ] {
                assert!(
                    !text.contains(permission),
                    "{} grants {permission}",
                    path.display()
                );
            }
        }
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
