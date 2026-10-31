//! Where the window may go. The window shows the local service and nothing else, so
//! a page can never reach the shell's own pages or sit on someone else's site inside
//! the app. Links out go to the system browser.

use std::sync::atomic::{AtomicU16, Ordering};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// The port the local service answers on, zero before it starts.
#[derive(Default)]
pub struct ServicePort(AtomicU16);

impl ServicePort {
    pub fn set(&self, port: u16) {
        self.0.store(port, Ordering::SeqCst);
    }

    pub fn get(&self) -> u16 {
        self.0.load(Ordering::SeqCst)
    }
}

/// True for the shell's loader, the running service and what a page makes itself.
pub fn stays_inside(url: &Url, port: u16) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "about" | "blob" | "data" => true,
        "http" => {
            url.host_str() == Some("tauri.localhost")
                || (url.host_str() == Some("127.0.0.1") && url.port() == Some(port) && port != 0)
        }
        _ => false,
    }
}

fn opens_outside(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

/// Hands a link to the system. Any other scheme is dropped, since a page must not be
/// able to start whatever program claims it.
pub fn open_outside(app: &AppHandle, url: &Url) {
    if opens_outside(url) {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

pub fn on_navigation(app: &AppHandle, url: &Url) -> bool {
    let port = app.state::<ServicePort>().get();
    let inside = stays_inside(url, port);
    if !inside {
        open_outside(app, url);
    }
    inside
}

/// The `orbyn://` links in a process's arguments.
#[cfg(any(target_os = "macos", test))]
pub fn links_in(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|arg| arg.starts_with("orbyn://"))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn only_this_service_and_the_loader_stay_inside() {
        assert!(stays_inside(&url("tauri://localhost/index.html"), 0));
        assert!(stays_inside(&url("http://tauri.localhost/index.html"), 0));
        assert!(stays_inside(&url("http://127.0.0.1:5000/?token=x"), 5000));
        assert!(stays_inside(&url("about:blank"), 5000));
        assert!(!stays_inside(&url("http://127.0.0.1:5001/"), 5000));
        assert!(!stays_inside(&url("http://127.0.0.1/"), 0));
        assert!(!stays_inside(&url("https://127.0.0.1:5000/"), 5000));
        assert!(!stays_inside(&url("https://example.com/"), 5000));
        assert!(!stays_inside(&url("file:///etc/passwd"), 5000));
    }

    #[test]
    fn only_web_and_mail_links_leave() {
        assert!(opens_outside(&url("https://example.com/")));
        assert!(opens_outside(&url("mailto:a@example.com")));
        assert!(!opens_outside(&url("file:///Applications/Calculator.app")));
        assert!(!opens_outside(&url("smb://host/share")));
        assert!(!opens_outside(&url("vscode://file/x")));
    }

    #[test]
    fn links_are_picked_out_of_arguments() {
        let args = [
            "app".to_owned(),
            "orbyn://usage".to_owned(),
            "--flag".to_owned(),
        ];
        assert_eq!(links_in(&args), ["orbyn://usage"]);
    }
}
